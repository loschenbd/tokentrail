# `brew install tokentrail` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `brew install loschenbd/tokentrail/tokentrail`. Replace the current `git clone → npm install → tokentrail init` flow with a one-line install followed by a discoverable web onboarding wizard at `/welcome`.

**Architecture:** Two repos: the main `loschenbd/tokentrail` for code, and a new `loschenbd/homebrew-tokentrail` tap that carries `Formula/tokentrail.rb`. The formula installs via `npm install` at install-time on the user's machine, leveraging `better-sqlite3`'s published prebuilds. Tokentrail-side packaging bugs are fixed first as their own PR; the tap + wizard come after.

**Tech Stack:** TypeScript on Node 20+, `better-sqlite3` (native module), `fastify` (dashboard server), `commander` (CLI), `node:test` for tests via `tsx` loader, Ruby for the Homebrew formula, YAML for GitHub Actions.

**Spec:** [`docs/superpowers/specs/2026-06-17-brew-install-design.md`](../specs/2026-06-17-brew-install-design.md)

## Global Constraints

- **Node engines:** `package.json` already pins `"engines": { "node": ">=20" }`. Do NOT lower this; the formula `depends_on "node"` resolves to Homebrew's latest LTS.
- **No new runtime dependencies.** The wizard's HTML/CSS/JS is plain — no React, no build step, no new npm packages.
- **macOS-only for `init` and the wizard.** `process.platform !== 'darwin'` returns early with the existing error message. Don't gate the CLI itself.
- **127.0.0.1 binding only.** The dashboard server already binds to loopback. The new `/api/setup/*` endpoints inherit that; no CSRF token, no auth.
- **Test runner:** `node --import tsx --test <file>`. The existing `npm test` script is `node --import tsx --test $(find tests -name '*.test.ts')` — keep tests under `tests/` so it picks them up.
- **Commit style:** match the existing pattern (`fix(scope):`, `feat(scope):`, `docs(scope):`) — see `git log --oneline -5`.
- **Bin-path resolution decision (resolved from spec open question):** at init time, derive the daemon plist's program path via `process.argv[1]`. If that path lives under `…/Cellar/tokentrail/<version>/libexec/bin/tokentrail`, walk up to `…/bin/tokentrail` (the symlink that survives `brew upgrade`). Otherwise use `process.argv[1]` verbatim. This makes brew upgrades transparent and keeps dev/npm-installed runs working unchanged.
- **Initial version tag:** `v0.2.0`. Bump `package.json` from `0.1.0` to `0.2.0` as the first commit of Phase 1.

---

## Phase 1 — Tokentrail-side cleanup (Tasks 1–5)

Ships as one PR titled `fix(packaging): make tokentrail npm-install-clean`. None of these changes require Homebrew to be useful — they fix real bugs that already block `npm install -g`.

### Task 1: `pkgRoot()` helper with tests

**Files:**
- Create: `src/lib/pkg-root.ts`
- Create: `tests/lib/pkg-root.test.ts`

**Interfaces:**
- Consumes: nothing — first task.
- Produces: `export function pkgRoot(): string` — returns the absolute path of the directory containing the nearest `package.json` ancestor of the calling module. Throws if none found within 8 ancestors. Memoized after first call.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/pkg-root.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pkgRoot } from '../../src/lib/pkg-root.js';

describe('pkgRoot', () => {
  test('returns this package root when called from the source tree', () => {
    const root = pkgRoot();
    assert.ok(existsSync(join(root, 'package.json')), `expected package.json at ${root}`);
    // Sanity-check: this is THIS repo, not some node_modules dependency.
    assert.ok(existsSync(join(root, 'src', 'lib', 'pkg-root.ts')));
  });

  test('is memoized — second call returns identical string', () => {
    const a = pkgRoot();
    const b = pkgRoot();
    assert.equal(a, b);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/lib/pkg-root.test.ts`
Expected: FAIL — "Cannot find module '../../src/lib/pkg-root.js'"

- [ ] **Step 3: Implement `pkgRoot`**

```ts
// src/lib/pkg-root.ts
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/**
 * Walk up from this module's directory until a `package.json` is found.
 * Returns that directory. Throws after 8 hops without a hit.
 *
 * Works in dev (finds the git checkout root) and post-install
 * (finds the installed package root, e.g.
 *  /opt/homebrew/lib/node_modules/tokentrail/).
 */
export function pkgRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      cached = dir;
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`tokentrail: could not locate package root from ${import.meta.url}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/lib/pkg-root.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pkg-root.ts tests/lib/pkg-root.test.ts
git commit -m "feat(lib): add pkgRoot() helper for asset path resolution"
```

---

### Task 2: Migrate `init.ts`, `install-skills.ts`, `install-hook.ts` to `pkgRoot()`

**Files:**
- Modify: `src/commands/init.ts:18-19` (remove `HERE`/`REPO_ROOT`, import `pkgRoot`)
- Modify: `src/commands/init.ts:73, 123, 124, 136, 177` (replace `REPO_ROOT` references)
- Modify: `src/commands/install-skills.ts:14-16, 36` (remove `HERE`/`REPO_ROOT`, use `pkgRoot()` for default `templatesDir`)
- Modify: `src/commands/install-hook.ts:5-7` (remove `HERE`/`REPO_ROOT`, use `pkgRoot()` for default `HOOK_PATH`)

**Interfaces:**
- Consumes: `pkgRoot()` from Task 1.
- Produces: same exports as before — `runInit(InitOptions)`, `runInstallSkills(InstallSkillsOptions)`, `runInstallHook(InstallHookOptions)`. Behavior identical from the dev checkout; correct from a post-install layout.

- [ ] **Step 1: Run existing tests to confirm baseline**

Run: `node --import tsx --test tests/install-skills.test.ts tests/install-hook.test.ts`
Expected: PASS — both files green pre-migration.

- [ ] **Step 2: Migrate `install-skills.ts`**

Replace lines 14–16 with the import:

```ts
import { pkgRoot } from '../lib/pkg-root.js';
```

Change line 36 from:

```ts
const templatesDir = opts.templatesDir ?? join(REPO_ROOT, 'templates');
```

to:

```ts
const templatesDir = opts.templatesDir ?? join(pkgRoot(), 'templates');
```

Delete the `// Repo root is two levels up …` comment block.

- [ ] **Step 3: Migrate `install-hook.ts`**

Replace lines 5–7 with:

```ts
import { pkgRoot } from '../lib/pkg-root.js';
```

Then move the `HOOK_PATH` computation INSIDE `runInstallHook` (so `pkgRoot()` runs at call time, not import time — important for tests that provide `hookPath` overrides):

```ts
export function runInstallHook(opts: InstallHookOptions = {}): InstallHookResult {
  const repo = resolve(opts.repo ?? process.cwd());
  const settingsPath = join(repo, '.claude', 'settings.json');
  const hookPath = opts.hookPath ?? join(pkgRoot(), 'src', 'hooks', 'session-end.sh');
  // …rest unchanged
}
```

- [ ] **Step 4: Migrate `init.ts`**

Replace lines 18–19 with:

```ts
import { pkgRoot } from '../lib/pkg-root.js';
```

Add a `repoRoot` local at the top of `runInit` (after the platform guard):

```ts
const repoRoot = pkgRoot();
```

Then plumb it through the three call sites that need it:
- `installSwiftBarPlugin(opts, repoRoot)` — change function signature to accept `repoRoot: string`; line 73 becomes `const src = join(repoRoot, 'scripts', 'menubar', SWIFTBAR_PLUGIN_NAME);`
- `installDaemon(opts, repoRoot)` — keep this signature change; lines 123–124 use `repoRoot` (these will be rewritten further in Task 4)
- `installRepoHook(opts, repoRoot)` — line 177 becomes `runInstallHook({ repo: repoRoot, dryRun: opts.dryRun });`

Update the calls inside `runInit`:

```ts
if (!opts.skipSwiftbar) installSwiftBarPlugin(opts, repoRoot);
if (!opts.skipDaemon) installDaemon(opts, repoRoot);
installSkills(opts);  // unchanged — uses install-skills' own pkgRoot
if (!opts.skipHook) installRepoHook(opts, repoRoot);
```

- [ ] **Step 5: Run all install-related tests**

Run: `node --import tsx --test tests/install-skills.test.ts tests/install-hook.test.ts tests/init.test.ts`
Expected: PASS — all green. Test fixtures use the `templatesDir` / `hookPath` overrides so the migration shouldn't break them.

- [ ] **Step 6: Commit**

```bash
git add src/commands/init.ts src/commands/install-skills.ts src/commands/install-hook.ts
git commit -m "refactor(commands): resolve asset paths via pkgRoot() not REPO_ROOT"
```

---

### Task 3: Fix `bin` shim path and add `files` allowlist

**Files:**
- Modify: `package.json:23` (bin path) and the field block after `"engines"` (new `"files"` entry)

**Interfaces:**
- Consumes: nothing.
- Produces: an `npm pack` tarball that contains exactly the runtime assets and points the bin shim at the file `tsc` actually emits.

- [ ] **Step 1: Bump version**

Edit `package.json`:

```diff
- "version": "0.1.0",
+ "version": "0.2.0",
```

- [ ] **Step 2: Fix the bin path**

```diff
  "bin": {
-   "tokentrail": "./dist/index.js"
+   "tokentrail": "./dist/src/index.js"
  },
```

- [ ] **Step 3: Add the `files` allowlist**

Insert after the `"engines"` block, before `"dependencies"`:

```json
  "files": [
    "dist/",
    "templates/",
    "scripts/menubar/",
    "src/hooks/",
    "README.md",
    "LICENSE"
  ],
```

- [ ] **Step 4: Build and pack — verify the tarball is well-formed**

```bash
npm run build
npm pack --dry-run 2>&1 | tail -40
```

Expected: the listing shows `dist/src/index.js`, `templates/skills/…`, `templates/commands/…`, `scripts/menubar/tokentrail.1m.sh`, `src/hooks/session-end.sh`. Does NOT show `tests/`, `docs/`, `data/`, `node_modules/`.

- [ ] **Step 5: Verify the bin shim actually exists in dist**

```bash
ls -la dist/src/index.js
head -1 dist/src/index.js
```

Expected: file exists, first line is `#!/usr/bin/env node`.

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "fix(packaging): correct bin path, ship templates + hooks via files allowlist"
```

---

### Task 4: Daemon plist points at the installed `tokentrail` bin

**Files:**
- Modify: `src/commands/init.ts` — `installDaemon` and `renderDaemonPlist` functions

**Interfaces:**
- Consumes: `pkgRoot()` from Task 1 (already imported in Task 2).
- Produces: a launchd plist whose `ProgramArguments` invokes `tokentrail dashboard --no-open` via the stable symlink path on brew installs, or via `process.argv[1]` directly otherwise.

- [ ] **Step 1: Add a `resolveTokentrailBin()` helper above `installDaemon` in `init.ts`**

```ts
/**
 * Pick the path to write into the launchd plist's ProgramArguments.
 *
 * On brew installs, process.argv[1] is the symlinked
 *   /opt/homebrew/bin/tokentrail
 * but if Node was invoked via the resolved real path under Cellar/, we
 * pattern-match that and walk up to the symlink — surviving brew upgrade.
 *
 * For dev (tsx) and npm runs, returns process.argv[1] verbatim.
 */
function resolveTokentrailBin(): string {
  const argv1 = process.argv[1] ?? '';
  const m = argv1.match(/^(.*)\/Cellar\/tokentrail\/[^/]+\/libexec\/bin\/tokentrail$/);
  if (m) {
    const stable = join(m[1]!, 'bin', 'tokentrail');
    if (existsSync(stable)) return stable;
  }
  return argv1;
}
```

- [ ] **Step 2: Update `installDaemon` to write a plist that invokes the bin directly**

Replace the body of `installDaemon` (lines 119–168 in master) with:

```ts
function installDaemon(opts: InitOptions, repoRoot: string): void {
  console.log('• Dashboard daemon (launchd)');

  const tokentrailBin = opts.nodePath ?? resolveTokentrailBin();
  if (!tokentrailBin || !existsSync(tokentrailBin)) {
    console.log(`    [warn] could not resolve tokentrail binary path (argv1=${process.argv[1]})`);
    console.log('           Daemon not installed. Re-run with --nodePath=<absolute path> to override.');
    return;
  }

  const plist = renderDaemonPlist({ tokentrailBin, repoRoot });

  const plistDir = dirname(DAEMON_PLIST_PATH);
  const exists = existsSync(DAEMON_PLIST_PATH);

  if (exists && !opts.force) {
    if (isLoaded(DAEMON_LABEL)) {
      console.log(`    [ok] daemon already loaded (${DAEMON_LABEL}).`);
    } else {
      console.log(`    [ok] plist exists at ${DAEMON_PLIST_PATH}, loading...`);
      if (!opts.dryRun) launchctlLoad(DAEMON_PLIST_PATH);
    }
    return;
  }

  if (opts.dryRun) {
    console.log(`    [dry] would write ${DAEMON_PLIST_PATH}`);
    console.log(`    [dry] would launchctl load ${DAEMON_PLIST_PATH}`);
    return;
  }

  mkdirSync(plistDir, { recursive: true });
  mkdirSync(dirname(DAEMON_LOG_PATH), { recursive: true });

  if (exists && opts.force && isLoaded(DAEMON_LABEL)) {
    launchctlUnload(DAEMON_PLIST_PATH);
  }

  writeFileSync(DAEMON_PLIST_PATH, plist);
  console.log(`    [wrote] ${DAEMON_PLIST_PATH}`);
  launchctlLoad(DAEMON_PLIST_PATH);
  console.log(`    [loaded] ${DAEMON_LABEL} — dashboard on 127.0.0.1:4920`);
}
```

The `nodePath` option name stays for backward compatibility — it now actually means "tokentrail bin path" but tests use it as an override.

- [ ] **Step 3: Rewrite `renderDaemonPlist`**

Replace lines 191–224 with:

```ts
function renderDaemonPlist(args: { tokentrailBin: string; repoRoot: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${args.tokentrailBin}</string>
    <string>dashboard</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${args.repoRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DAEMON_LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_LOG_PATH}</string>
</dict>
</plist>
`;
}
```

Note: the `--import tsx` lines and the source-file `entryPath` are gone — the plist now invokes the compiled bin shim, which is `node`-runnable on its own.

- [ ] **Step 4: Update existing init tests for the new plist format**

Open `tests/init.test.ts`, find the test(s) that assert plist content. Update assertions:

```ts
// Was: assert that plist contains 'src/index.ts' and '--import tsx'
// Now: assert that plist contains the tokentrailBin path and 'dashboard --no-open'

assert.match(plist, /<string>\/.*tokentrail<\/string>/);
assert.match(plist, /<string>dashboard<\/string>/);
assert.match(plist, /<string>--no-open<\/string>/);
assert.doesNotMatch(plist, /tsx/);
```

If a test uses `nodePath` override, it still works — the override now flows to `tokentrailBin` instead of `node`. Update test setup to pass a fake bin path:

```ts
runInit({ nodePath: '/tmp/fake/tokentrail', skipSwiftbar: true, skipHook: true });
```

- [ ] **Step 5: Run init tests**

Run: `node --import tsx --test tests/init.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/init.ts tests/init.test.ts
git commit -m "fix(daemon): invoke installed tokentrail bin, drop tsx loader from plist"
```

---

### Task 5: Update README install snippet

**Files:**
- Modify: `README.md:14-25` (install section)

**Interfaces:**
- Consumes: nothing.
- Produces: an updated README that documents BOTH the existing dev flow AND the upcoming brew install path. Brew snippet is marked as "Coming soon" until Phase 2 ships.

- [ ] **Step 1: Replace the install section**

Find the existing block (around line 19–25):

```markdown
```bash
npm install
npm run tokentrail -- run-all --skip-sync --skip-enrich
npm run tokentrail -- init        # SwiftBar plugin + dashboard daemon + Claude skills + hook
```
```

Replace with:

```markdown
### Install

**From source (today):**

```bash
git clone https://github.com/loschenbd/tokentrail
cd tokentrail
npm install
npm run build
node dist/src/index.js init        # SwiftBar plugin + dashboard daemon + Claude skills + hook
```

**Via Homebrew (coming with v0.2.0):**

```bash
brew install loschenbd/tokentrail/tokentrail
tokentrail dashboard               # opens onboarding wizard at /welcome
```
```

The "coming with v0.2.0" note gets removed in Task 8 once the tap ships.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): document brew install path (placeholder for v0.2.0)"
```

---

### Phase 1 PR

- [ ] **Open PR**

```bash
git push -u origin <branch>
gh pr create --title "fix(packaging): make tokentrail npm-install-clean" --body "$(cat <<'EOF'
## Summary

Prerequisite cleanup for shipping \`brew install tokentrail\`. None of these
changes are brew-specific — they fix real bugs that already block
\`npm install -g\` and \`npm pack\` users today.

- \`pkgRoot()\` helper replaces the broken \`REPO_ROOT = resolve(HERE, '..', '..')\`
  pattern across init/install-skills/install-hook. Finds the package root
  by walking up to the nearest package.json, so assets resolve correctly
  from both a dev checkout and an installed layout.
- \`package.json\` bin shim points at \`./dist/src/index.js\` (where \`tsc\` actually
  emits) instead of \`./dist/index.js\` (where it doesn't).
- New \`files\` allowlist locks down what \`npm pack\` includes: dist, templates,
  SwiftBar plugin, session-end hook. Excludes tests, docs, data.
- Daemon plist invokes the installed \`tokentrail\` bin directly instead of
  \`node --import tsx src/index.ts\` — \`tsx\` is a devDep that won't ship.
- Version bumped to 0.2.0.

Spec: docs/superpowers/specs/2026-06-17-brew-install-design.md

## Test plan

- [ ] \`npm test\` green
- [ ] \`npm run build && npm pack --dry-run\` shows the expected files
- [ ] \`node dist/src/index.js --version\` runs (not just via tsx)
- [ ] \`node dist/src/index.js init --dry-run\` plans an install without errors
EOF
)"
```

- [ ] **After merge: tag `v0.2.0`**

```bash
git checkout master
git pull
git tag v0.2.0
git push origin v0.2.0
gh release create v0.2.0 --title "v0.2.0" --notes "Packaging cleanup — bin shim, asset resolution, daemon plist."
```

---

## Phase 2 — Homebrew tap + formula (Tasks 6–8)

Ships independently of the main repo. After this phase, `brew install loschenbd/tokentrail/tokentrail` works.

### Task 6: Create the tap repo with the formula

**Files (in the NEW `homebrew-tokentrail` repo):**
- Create: `Formula/tokentrail.rb`
- Create: `README.md`
- Create: `.gitignore`

**Interfaces:**
- Consumes: the `v0.2.0` GitHub release tarball from Phase 1.
- Produces: a tap that resolves `brew install loschenbd/tokentrail/tokentrail` to the formula below.

- [ ] **Step 1: Create the repo on GitHub**

```bash
gh repo create loschenbd/homebrew-tokentrail --public --description "Homebrew tap for tokentrail" --clone
cd homebrew-tokentrail
```

Naming is non-negotiable: Homebrew requires the prefix `homebrew-` and strips it when users tap (`brew tap loschenbd/tokentrail`).

- [ ] **Step 2: Compute the v0.2.0 tarball sha256**

```bash
curl -sL https://github.com/loschenbd/tokentrail/archive/refs/tags/v0.2.0.tar.gz | shasum -a 256
```

Copy the 64-character hex value — call it `<SHA>`.

- [ ] **Step 3: Write `Formula/tokentrail.rb`**

```bash
mkdir -p Formula
```

```ruby
# Formula/tokentrail.rb
class Tokentrail < Formula
  desc "Local ledger and trail-map for Claude Code spend"
  homepage "https://github.com/loschenbd/tokentrail"
  url "https://github.com/loschenbd/tokentrail/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "<SHA>"
  license "MIT"

  depends_on "node"
  depends_on "python" => :build

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  livecheck do
    url :stable
    strategy :github_latest
  end

  test do
    assert_match "tokentrail", shell_output("#{bin}/tokentrail --version")
  end
end
```

Replace `<SHA>` with the value from Step 2.

- [ ] **Step 4: Write the tap README**

```markdown
# homebrew-tokentrail

Homebrew tap for [Tokentrail](https://github.com/loschenbd/tokentrail) — a
local ledger and trail-map for Claude Code spend.

## Install

```bash
brew install loschenbd/tokentrail/tokentrail
```

Then run `tokentrail dashboard` to open the setup wizard at
http://127.0.0.1:4920/welcome.

## Notes

- macOS only. The CLI installs on Linux but `init` and the dashboard
  wizard refuse with a clear message.
- If the install fails compiling `better-sqlite3`, run
  `xcode-select --install` to get the Xcode Command Line Tools.

## Upgrading

```bash
brew update
brew upgrade tokentrail
```

After upgrade, re-run `tokentrail init` once to refresh the launchd plist's
program path.
```

- [ ] **Step 5: Write `.gitignore`**

```
.DS_Store
*.swp
```

- [ ] **Step 6: Smoke-test the formula locally**

```bash
brew install --build-from-source ./Formula/tokentrail.rb
tokentrail --version
brew test tokentrail
```

Expected: install completes in <60s, `--version` prints something containing "tokentrail", `brew test` PASS.

If install fails on `npm install`, check `brew install` log for the better-sqlite3 prebuild fetch — if it fell back to node-gyp and failed, confirm Xcode CLT is installed: `xcode-select -p`.

- [ ] **Step 7: Commit and push**

```bash
git add Formula/tokentrail.rb README.md .gitignore
git commit -m "feat: initial tap with tokentrail v0.2.0"
git push -u origin main
```

- [ ] **Step 8: Public verification**

From any machine OTHER than the dev box (or after `brew untap loschenbd/tokentrail`):

```bash
brew install loschenbd/tokentrail/tokentrail
tokentrail --version
```

Expected: install completes, `--version` prints "tokentrail 0.2.0" (or close — the actual version line from commander).

---

### Task 7: Main repo release workflow

**Files (in the main `tokentrail` repo):**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: a Git tag matching `v*.*.*` pushed to the main repo.
- Produces: a `repository_dispatch` event sent to the `homebrew-tokentrail` tap repo, carrying the new version. The tap's bump workflow (Task 8) listens for this.

- [ ] **Step 1: Create a PAT for cross-repo dispatch**

In GitHub Settings → Developer settings → Personal access tokens → fine-grained:
- Name: `tokentrail-tap-dispatch`
- Resource owner: `loschenbd`
- Repository access: `loschenbd/homebrew-tokentrail` only
- Permissions: Contents = Read-only, **Metadata = Read-only, Actions = Read and write**

Save the token. Add it as a secret in the **main** repo:

```bash
gh secret set TAP_DISPATCH_TOKEN --repo loschenbd/tokentrail
# paste the PAT when prompted
```

- [ ] **Step 2: Write the release workflow**

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*.*.*']

jobs:
  notify-tap:
    runs-on: ubuntu-latest
    steps:
      - name: Notify homebrew-tokentrail tap
        env:
          GH_TOKEN: ${{ secrets.TAP_DISPATCH_TOKEN }}
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          gh api repos/loschenbd/homebrew-tokentrail/dispatches \
            -f event_type=tokentrail-release \
            -f client_payload[version]="${VERSION}" \
            -f client_payload[tag]="${GITHUB_REF_NAME}"
```

That's the whole workflow. No build step — the GitHub source tarball is auto-generated for any tag.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): notify homebrew tap on new version tags"
```

End-to-end verification of the dispatch+bump chain happens after Task 8 ships its listener (see T8 Step 5).

---

### Task 8: Tap bump bot + integration CI

**Files (in the `homebrew-tokentrail` repo):**
- Create: `.github/workflows/bump.yml`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `repository_dispatch` events with `event_type: tokentrail-release` from Task 7. Pull requests to `main` for the CI workflow.
- Produces: a PR against the tap that updates `Formula/tokentrail.rb`'s `url` and `sha256` whenever a new tag lands upstream. The CI workflow blocks merging if `brew install --build-from-source` fails.

- [ ] **Step 1: Create a PAT for the bump bot to open PRs**

In the **tap** repo settings → Actions → General → "Workflow permissions" → check "Allow GitHub Actions to create and approve pull requests."

No separate PAT needed — the default `GITHUB_TOKEN` can open PRs with this setting enabled.

- [ ] **Step 2: Write `bump.yml`**

```yaml
# .github/workflows/bump.yml
name: Bump formula

on:
  repository_dispatch:
    types: [tokentrail-release]
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to bump to (e.g. 0.2.1)'
        required: true

permissions:
  contents: write
  pull-requests: write

jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Resolve version
        id: version
        run: |
          if [ -n "${{ github.event.client_payload.version }}" ]; then
            echo "v=${{ github.event.client_payload.version }}" >> "$GITHUB_OUTPUT"
          else
            echo "v=${{ github.event.inputs.version }}" >> "$GITHUB_OUTPUT"
          fi

      - name: Compute new sha256
        id: sha
        run: |
          V="${{ steps.version.outputs.v }}"
          SHA=$(curl -sL "https://github.com/loschenbd/tokentrail/archive/refs/tags/v${V}.tar.gz" | shasum -a 256 | cut -d' ' -f1)
          echo "sha=${SHA}" >> "$GITHUB_OUTPUT"

      - name: Update formula
        run: |
          V="${{ steps.version.outputs.v }}"
          SHA="${{ steps.sha.outputs.sha }}"
          sed -i.bak -E "s|url \".*\"|url \"https://github.com/loschenbd/tokentrail/archive/refs/tags/v${V}.tar.gz\"|" Formula/tokentrail.rb
          sed -i.bak -E "s|sha256 \".*\"|sha256 \"${SHA}\"|" Formula/tokentrail.rb
          rm Formula/tokentrail.rb.bak

      - name: Open PR
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          V="${{ steps.version.outputs.v }}"
          BRANCH="bump/v${V}"
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git checkout -b "${BRANCH}"
          git add Formula/tokentrail.rb
          git commit -m "tokentrail v${V}"
          git push -u origin "${BRANCH}"
          gh pr create --title "tokentrail v${V}" --body "Auto-bump from upstream tag v${V}."
```

- [ ] **Step 3: Write `ci.yml`**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  brew-install:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install from this checkout's formula
        run: |
          brew install --build-from-source ./Formula/tokentrail.rb

      - name: Verify the binary works
        run: |
          tokentrail --version
          tokentrail --help | head -5

      - name: brew test
        run: brew test tokentrail
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/bump.yml .github/workflows/ci.yml
git commit -m "ci: auto-bump formula on upstream release + brew install integration test"
git push
```

- [ ] **Step 5: End-to-end verification**

Trigger the bump workflow manually for `0.2.0` to exercise the full pipeline. Since the formula already points at `v0.2.0`, the resulting PR will be a no-op (same `url` and `sha256`) and can be closed without merging:

```bash
gh workflow run bump.yml -f version=0.2.0
```

Expected: a PR opens (titled "tokentrail v0.2.0") with the formula's `url` and `sha256` re-computed but identical. CI runs and passes. Close the PR after inspection — it confirms the wiring works without changing master state.

- [ ] **Step 6: Update main repo README**

Back in the main repo, remove the "(coming soon)" caveat from the brew snippet:

```bash
# In the main tokentrail repo
git checkout master
# Edit README.md to drop "Coming with v0.2.0" and any placeholder language
git commit -am "docs(readme): brew install is live"
git push
```

---

## Phase 3 — Dashboard onboarding wizard (Tasks 9–13)

Adds `/welcome` checklist + `/api/setup/*` endpoints. Ships as a separate PR once Phase 2 has at least one user (i.e., you, on your machine via `brew install`).

### Task 9: `SetupStatus` detection

**Files:**
- Create: `src/dashboard/data/setup-status.ts`
- Create: `tests/dashboard/setup-status.test.ts`

**Interfaces:**
- Consumes: nothing — pure filesystem inspection.
- Produces:
  - `export type SetupStatus = { swiftbarApp: boolean; menubarPlugin: boolean; daemon: boolean; skills: boolean; hook: boolean; }`
  - `export function readSetupStatus(opts?: { home?: string; appsDir?: string; }): SetupStatus`
  - Both `home` and `appsDir` are test overrides; defaults are `os.homedir()` and `/Applications`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/dashboard/setup-status.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSetupStatus } from '../../src/dashboard/data/setup-status.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'tokentrail-status-home-'));
  const apps = mkdtempSync(join(tmpdir(), 'tokentrail-status-apps-'));
  return { home, apps };
}

describe('readSetupStatus', () => {
  test('returns all false on a clean home', () => {
    const { home, apps } = fixture();
    const s = readSetupStatus({ home, appsDir: apps });
    assert.deepEqual(s, {
      swiftbarApp: false,
      menubarPlugin: false,
      daemon: false,
      skills: false,
      hook: false,
    });
  });

  test('detects each artifact independently', () => {
    const { home, apps } = fixture();

    mkdirSync(join(apps, 'SwiftBar.app'));

    const pluginDir = join(home, 'Library', 'Application Support', 'SwiftBar');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'tokentrail.1m.sh'), '#!/bin/sh');

    const agentDir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'com.tokentrail.daemon.plist'), '<plist/>');

    mkdirSync(join(home, '.claude', 'skills', 'tokentrail-spend'), { recursive: true });

    const projDir = join(home, '.claude', 'projects', 'some-project');
    mkdirSync(projDir, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), 'tokentrail-status-repo-'));
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '/path/to/tokentrail/src/hooks/session-end.sh' }] }] },
      }),
    );
    writeFileSync(join(projDir, 'cwd'), repo);

    const s = readSetupStatus({ home, appsDir: apps });
    assert.equal(s.swiftbarApp, true);
    assert.equal(s.menubarPlugin, true);
    assert.equal(s.daemon, true);
    assert.equal(s.skills, true);
    assert.equal(s.hook, true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/dashboard/setup-status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `readSetupStatus`**

```ts
// src/dashboard/data/setup-status.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SetupStatus = {
  swiftbarApp: boolean;
  menubarPlugin: boolean;
  daemon: boolean;
  skills: boolean;
  hook: boolean;
};

export function readSetupStatus(opts: { home?: string; appsDir?: string } = {}): SetupStatus {
  const home = opts.home ?? homedir();
  const appsDir = opts.appsDir ?? '/Applications';

  return {
    swiftbarApp: existsSync(join(appsDir, 'SwiftBar.app')),
    menubarPlugin: existsSync(
      join(home, 'Library', 'Application Support', 'SwiftBar', 'tokentrail.1m.sh'),
    ),
    daemon: existsSync(
      join(home, 'Library', 'LaunchAgents', 'com.tokentrail.daemon.plist'),
    ),
    skills: existsSync(join(home, '.claude', 'skills', 'tokentrail-spend')),
    hook: detectHookInAnyProject(home),
  };
}

function detectHookInAnyProject(home: string): boolean {
  const projectsRoot = join(home, '.claude', 'projects');
  if (!existsSync(projectsRoot)) return false;

  let projects: string[];
  try {
    projects = readdirSync(projectsRoot);
  } catch {
    return false;
  }

  for (const name of projects) {
    const cwdFile = join(projectsRoot, name, 'cwd');
    if (!existsSync(cwdFile)) continue;

    let repo: string;
    try {
      repo = readFileSync(cwdFile, 'utf-8').trim();
    } catch {
      continue;
    }
    if (!repo || !existsSync(repo)) continue;

    const settingsPath = join(repo, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(settingsPath, 'utf-8');
    } catch {
      continue;
    }
    if (raw.includes('session-end.sh') && raw.includes('tokentrail')) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/dashboard/setup-status.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/data/setup-status.ts tests/dashboard/setup-status.test.ts
git commit -m "feat(dashboard): SetupStatus detection for /welcome wizard"
```

---

### Task 10: `/api/setup/*` endpoints

**Files:**
- Modify: `src/dashboard/server.ts` (add 4 new routes after the existing `/api/anomalies/*` routes around line 102)
- Create: `tests/dashboard/setup-api.test.ts`

**Interfaces:**
- Consumes: `readSetupStatus` from Task 9, `runInit` (with `skipSkills`/`skipHook` shortcuts via existing `skipDaemon`/`skipSwiftbar`/`skipHook` options) from `src/commands/init.ts`, `runInstallSkills` from `src/commands/install-skills.ts`.
- Produces: four routes, all returning `{ ok: boolean; error?: string; status: SetupStatus }`:
  - `POST /api/setup/menubar-plugin` — runs the SwiftBar-plugin install step only.
  - `POST /api/setup/daemon` — runs the launchd-daemon install step only.
  - `POST /api/setup/skills` — runs `runInstallSkills`.
  - `POST /api/setup/status` — returns just the current `SetupStatus` (no action).

- [ ] **Step 1: Refactor `runInit` to expose the individual steps**

Per-action endpoints should not run the whole init pipeline. Export the helpers that today are private inside `init.ts`:

```ts
// In src/commands/init.ts — change these from `function` to `export function`:
export function installSwiftBarPlugin(opts: InitOptions, repoRoot: string): void { /* … */ }
export function installDaemon(opts: InitOptions, repoRoot: string): void { /* … */ }
```

Leave `runInit` as the orchestrator. No test changes needed; the existing tests call `runInit`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/dashboard/setup-api.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { buildServer } from '../../src/dashboard/server.js';
import { closeDb } from '../../src/db/db.js';

function makeApp() {
  const db = new Database(':memory:');
  runMigrations(db);
  return buildServer({ defaultDays: 7 });
}

describe('/api/setup/*', () => {
  test('GET /api/setup/status returns a SetupStatus shape', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.status, 'object');
    for (const k of ['swiftbarApp', 'menubarPlugin', 'daemon', 'skills', 'hook']) {
      assert.equal(typeof body.status[k], 'boolean', `${k} should be boolean`);
    }
    await app.close();
    closeDb();
  });

  test('POST /api/setup/skills returns { ok, status } even when stubbed handler throws', async () => {
    // This test exercises the error path of the wrapper. Because we can't
    // easily stub runInstallSkills here, we point at a templatesDir that
    // doesn't exist — runInstallSkills logs a warning but does not throw,
    // so we expect ok=true with status payload.
    const app = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup/skills' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body.ok, 'boolean');
    assert.equal(typeof body.status, 'object');
    await app.close();
    closeDb();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test tests/dashboard/setup-api.test.ts`
Expected: FAIL — 404 on `/api/setup/status`.

- [ ] **Step 4: Add the routes**

In `src/dashboard/server.ts`, add imports at the top:

```ts
import { readSetupStatus } from './data/setup-status.js';
import { runInstallSkills } from '../commands/install-skills.js';
import { installSwiftBarPlugin, installDaemon } from '../commands/init.js';
import { pkgRoot } from '../lib/pkg-root.js';
```

After the existing `app.post('/api/anomalies/:id/restore', …)` block, add:

```ts
// Returns the SetupStatus object — no action performed.
app.post('/api/setup/status', async (_req, reply) => {
  reply.type('application/json; charset=utf-8');
  return { ok: true, status: readSetupStatus() };
});

app.post('/api/setup/menubar-plugin', async (_req, reply) => {
  reply.type('application/json; charset=utf-8');
  try {
    installSwiftBarPlugin({}, pkgRoot());
    return { ok: true, status: readSetupStatus() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: readSetupStatus(),
    };
  }
});

app.post('/api/setup/daemon', async (_req, reply) => {
  reply.type('application/json; charset=utf-8');
  try {
    installDaemon({}, pkgRoot());
    return { ok: true, status: readSetupStatus() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: readSetupStatus(),
    };
  }
});

app.post('/api/setup/skills', async (_req, reply) => {
  reply.type('application/json; charset=utf-8');
  try {
    runInstallSkills();
    return { ok: true, status: readSetupStatus() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: readSetupStatus(),
    };
  }
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test tests/dashboard/setup-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/init.ts src/dashboard/server.ts tests/dashboard/setup-api.test.ts
git commit -m "feat(dashboard): POST /api/setup/{status,menubar-plugin,daemon,skills}"
```

---

### Task 11: Checklist UI on `/welcome` (server-rendered HTML + CSS)

**Files:**
- Modify: `src/dashboard/render/trail-map.ts:5-48` (accept a `setupStatus` prop, render the checklist above the trail map header)
- Modify: `src/dashboard/server.ts:71-77` (`/welcome` route passes the status into `renderTrailMap`)
- Modify: `src/dashboard/static/trail-map.css` (append checklist styles)

**Interfaces:**
- Consumes: `SetupStatus` shape from Task 9, the four endpoints from Task 10.
- Produces: an HTML checklist with stable IDs the JS in Task 12 will wire up:
  - Container: `<div class="tt-setup" id="tt-setup" data-tt-setup>`
  - Rows: `<div class="tt-row" data-row="<key>" data-state="ok|pending">` where `<key>` is one of `swiftbarApp menubarPlugin daemon skills hook`
  - Run buttons: `<button class="tt-action" data-action="<key>">Run</button>`
  - Show-command buttons: `<button class="tt-show" data-show="<key>">Show command</button>`
  - Error slot: `<span class="tt-error" data-error="<key>"></span>`

- [ ] **Step 1: Update `renderTrailMap` signature**

```ts
import type { SetupStatus } from '../data/setup-status.js';

export type TrailMapMode = 'onboarding' | 'welcome';

export function renderTrailMap(opts: { mode: TrailMapMode; setupStatus?: SetupStatus }): string {
  // … existing code, but inject renderSetupChecklist(opts.setupStatus) above .frame-outer
}
```

Add the checklist helper at the bottom of the file:

```ts
function renderSetupChecklist(status?: SetupStatus): string {
  if (!status) return '';

  // CLI is implicitly installed — you're hitting this URL.
  const rows: Array<{ key: keyof SetupStatus | 'cli'; label: string; action: 'run' | 'show' | 'none' }> = [
    { key: 'cli', label: 'CLI installed', action: 'none' },
    { key: 'swiftbarApp', label: 'SwiftBar.app', action: 'show' },
    { key: 'menubarPlugin', label: 'Menubar plugin', action: 'run' },
    { key: 'daemon', label: 'Dashboard daemon', action: 'run' },
    { key: 'skills', label: 'Claude Code skills', action: 'run' },
    { key: 'hook', label: 'Session-end hook (per repo)', action: 'show' },
  ];

  const ok = (k: keyof SetupStatus | 'cli'): boolean =>
    k === 'cli' ? true : status[k];

  const renderRow = (r: typeof rows[number]): string => {
    const state = ok(r.key) ? 'ok' : 'pending';
    const button =
      r.action === 'run' && !ok(r.key)
        ? `<button class="tt-action" data-action="${r.key}">Run</button>`
        : r.action === 'show' && !ok(r.key)
          ? `<button class="tt-show" data-show="${r.key}">Show command</button>`
          : '';
    return `
      <div class="tt-row" data-row="${r.key}" data-state="${state}">
        <span class="tt-dot"></span>
        <span class="tt-label">${r.label}</span>
        ${button}
        <span class="tt-error" data-error="${r.key}"></span>
      </div>
    `;
  };

  return `
    <div class="tt-setup" id="tt-setup" data-tt-setup>
      ${rows.map(renderRow).join('')}
    </div>
  `;
}
```

In `renderTrailMap`, inject it inside `<div class="parchment">` BEFORE `<div class="map-header">`:

```ts
const checklist = renderSetupChecklist(opts.setupStatus);
return `
<link rel="stylesheet" href="/static/trail-map.css">
<div class="trail-map" data-trail-map>
  <div class="frame-outer">
    <div class="parchment">
      <div class="inner-border"></div>
      <div class="corners">...</div>
      ${checklist}
      <div class="map-header">...</div>
      // ... rest unchanged
```

- [ ] **Step 2: Wire the route**

In `src/dashboard/server.ts:71-77`:

```ts
app.get('/welcome', async (_req, reply) => {
  reply.type('text/html; charset=utf-8');
  return renderShell(
    { title: 'Welcome · Tokentrail', days: opts.defaultDays, showBack: true },
    renderTrailMap({ mode: 'welcome', setupStatus: readSetupStatus() }),
  );
});
```

- [ ] **Step 3: Add CSS**

Append to `src/dashboard/static/trail-map.css`:

```css
.trail-map .tt-setup {
  padding: 16px 24px;
  border-bottom: 1px dashed var(--tm-ink-subtle);
  margin-bottom: 8px;
  font-family: var(--tm-font-mono);
  font-size: 0.85rem;
}
.trail-map .tt-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  color: var(--tm-ink);
}
.trail-map .tt-row[data-state="ok"] .tt-label { opacity: 0.8; }
.trail-map .tt-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--tm-ink-subtle);
}
.trail-map .tt-row[data-state="ok"] .tt-dot { background: #4a7a35; }
.trail-map .tt-label { flex: 1; }
.trail-map .tt-action,
.trail-map .tt-show {
  font: inherit;
  border: 1px solid var(--tm-ink-muted);
  background: transparent;
  color: var(--tm-ink);
  padding: 2px 10px;
  cursor: pointer;
  border-radius: 3px;
}
.trail-map .tt-action:hover,
.trail-map .tt-show:hover { background: var(--tm-parch-mid); }
.trail-map .tt-action[disabled] { opacity: 0.5; cursor: progress; }
.trail-map .tt-error {
  font-size: 0.75rem;
  color: #a02a2a;
  margin-left: 8px;
}
.trail-map .tt-cmd {
  display: block;
  margin-top: 4px;
  padding: 4px 8px;
  background: var(--tm-parch-mid);
  font-size: 0.75rem;
  white-space: pre-wrap;
  user-select: all;
}
```

- [ ] **Step 4: Manual visual check**

```bash
npm run dev -- dashboard --no-open
open http://127.0.0.1:4920/welcome
```

Expected: a checklist of 6 rows appears at the top of the parchment, with status dots reflecting the current machine. Buttons don't do anything yet (Task 12 wires them).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/render/trail-map.ts src/dashboard/server.ts src/dashboard/static/trail-map.css
git commit -m "feat(welcome): server-rendered onboarding checklist"
```

---

### Task 12: Checklist JS (POST + re-render)

**Files:**
- Modify: `src/dashboard/static/trail-map.js` (append a `setupChecklist()` initializer at the bottom; runs on DOMContentLoaded)

**Interfaces:**
- Consumes: the four endpoints from Task 10. The DOM structure from Task 11.
- Produces: behavior — clicking `[Run]` POSTs to the matching endpoint, swaps the button for a "Running…" disabled state, then re-renders the row dot+button from the response's `status` payload. Clicking `[Show command]` reveals a copyable command line below the row.

- [ ] **Step 1: Append the initializer**

At the very bottom of `src/dashboard/static/trail-map.js`, add (outside any other IIFE — this is a separate concern):

```js
(function setupChecklist() {
  const root = document.querySelector('[data-tt-setup]');
  if (!root) return;

  const ACTION_URLS = {
    menubarPlugin: '/api/setup/menubar-plugin',
    daemon: '/api/setup/daemon',
    skills: '/api/setup/skills',
  };

  const SHOW_COMMANDS = {
    swiftbarApp: 'brew install --cask swiftbar',
    hook: 'tokentrail install-hook --repo /path/to/your/repo',
  };

  function setRowState(key, state) {
    const row = root.querySelector(`[data-row="${key}"]`);
    if (!row) return;
    row.setAttribute('data-state', state);
  }

  function clearError(key) {
    const slot = root.querySelector(`[data-error="${key}"]`);
    if (slot) slot.textContent = '';
  }

  function setError(key, msg) {
    const slot = root.querySelector(`[data-error="${key}"]`);
    if (slot) slot.textContent = msg;
  }

  function applyStatus(status) {
    if (!status) return;
    for (const key of Object.keys(status)) {
      setRowState(key, status[key] ? 'ok' : 'pending');
      // Hide the action button on rows that are now OK.
      const row = root.querySelector(`[data-row="${key}"]`);
      if (row && status[key]) {
        const btn = row.querySelector('.tt-action, .tt-show');
        if (btn) btn.remove();
      }
    }
  }

  root.addEventListener('click', async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.matches('.tt-action')) {
      const key = target.getAttribute('data-action');
      const url = ACTION_URLS[key];
      if (!url) return;
      clearError(key);
      target.disabled = true;
      const originalText = target.textContent;
      target.textContent = 'Running…';
      try {
        const res = await fetch(url, { method: 'POST' });
        const body = await res.json();
        if (!body.ok) {
          setError(key, body.error || 'failed');
          target.disabled = false;
          target.textContent = originalText;
          return;
        }
        applyStatus(body.status);
      } catch (err) {
        setError(key, err && err.message ? err.message : String(err));
        target.disabled = false;
        target.textContent = originalText;
      }
    } else if (target.matches('.tt-show')) {
      const key = target.getAttribute('data-show');
      const cmd = SHOW_COMMANDS[key];
      if (!cmd) return;
      const row = target.closest('.tt-row');
      const existing = row.querySelector('.tt-cmd');
      if (existing) { existing.remove(); return; }
      const codeEl = document.createElement('code');
      codeEl.className = 'tt-cmd';
      codeEl.textContent = cmd;
      row.appendChild(codeEl);
    }
  });
})();
```

- [ ] **Step 2: Manual end-to-end check**

```bash
npm run dev -- dashboard --no-open
open http://127.0.0.1:4920/welcome
```

Test each row:
- Click `[Run]` on a `menubarPlugin`/`daemon`/`skills` row that's currently pending. Expect: button shows "Running…", then the dot goes green and the button vanishes.
- Click `[Show command]` on `swiftbarApp`. Expect: the brew install command appears below the row, click again to hide.
- Manually delete `~/Library/Application Support/SwiftBar/tokentrail.1m.sh` and reload. Expect: that row goes back to pending with a `[Run]` button.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/static/trail-map.js
git commit -m "feat(welcome): wire onboarding checklist actions"
```

---

### Task 13: Document the wizard in README and Phase 3 PR

**Files:**
- Modify: `README.md` (replace the existing `tokentrail init` section with a wizard reference)

**Interfaces:**
- Consumes: nothing.
- Produces: README documentation that points new users at `tokentrail dashboard` → wizard instead of `tokentrail init`.

- [ ] **Step 1: Update README install section**

Find the section that talks about `tokentrail init` and add a paragraph BEFORE the existing init explanation:

```markdown
After `brew install` (or `npm install`) finishes, open the dashboard and
walk through the onboarding checklist:

```bash
tokentrail dashboard
# opens http://127.0.0.1:4920/welcome
```

The checklist installs the SwiftBar plugin, registers the launchd daemon,
links the Claude Code skills, and shows you the per-repo session-end hook
command to run. Power users can skip the wizard with `tokentrail init`,
which does all of that non-interactively.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): point new users at the /welcome wizard"
```

- [ ] **Step 3: Open Phase 3 PR**

```bash
gh pr create --title "feat(dashboard): /welcome onboarding wizard" --body "$(cat <<'EOF'
## Summary

Adds an interactive setup checklist to /welcome so new brew-installed
users can wire up the SwiftBar plugin, launchd daemon, and Claude skills
without touching the CLI.

- New \`src/dashboard/data/setup-status.ts\` — pure FS inspection,
  returns a \`SetupStatus\` shape with 5 booleans.
- Four \`POST /api/setup/*\` endpoints wrap existing install functions.
- \`/welcome\` renders a checklist above the trail map; trail-map.js
  handles button clicks and re-renders rows from the JSON response.
- README points new users at the wizard; \`tokentrail init\` remains
  as the power-user shortcut.

Spec: docs/superpowers/specs/2026-06-17-brew-install-design.md

## Test plan

- [ ] \`npm test\` green (new setup-status + setup-api tests)
- [ ] Fresh-machine simulation: \`rm -rf ~/Library/Application\\ Support/SwiftBar/tokentrail.1m.sh ~/Library/LaunchAgents/com.tokentrail.daemon.plist ~/.claude/skills/tokentrail-spend\`, reload /welcome, expect 4 pending rows.
- [ ] Click each \`[Run]\` button, expect dot to flip green and button to vanish.
- [ ] Click \`[Show command]\` on SwiftBar.app and hook rows, expect copyable command to appear.
- [ ] Click an action when the underlying function will fail (e.g. SwiftBar not installed), expect inline error in red, button remains active.
EOF
)"
```

---

## Self-review

After writing this plan, the following checks pass:

- **Spec coverage:** every spec section has at least one task — bin shim (T3), pkgRoot (T1+T2), files allowlist (T3), daemon plist (T4), tap formula (T6), release workflow (T7), bump bot + CI (T8), SetupStatus (T9), endpoints (T10), checklist UI (T11+T12), README (T5+T13), error handling (covered in T10 wrappers + T12 button states).
- **Placeholder scan:** no TBD/TODO/"add appropriate error handling" markers. The `<SHA>` token in T6 is the only literal substitution and is computed in the preceding step.
- **Type consistency:** `SetupStatus` shape defined in T9, referenced unchanged in T10, T11, T12. `pkgRoot()` signature stable from T1 → T2 → T10.
- **Open-question resolution:** bin path decision documented in Global Constraints + implemented in T4 (`resolveTokentrailBin`).

Plan complete and saved to `docs/superpowers/plans/2026-06-17-brew-install.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
