# `brew install tokentrail` — design

**Date:** 2026-06-17
**Status:** Spec, awaiting plan
**Scope:** Make Tokentrail installable via `brew install loschenbd/tokentrail/tokentrail`. Ship a Homebrew tap, fix the latent packaging bugs that make today's `npm install -g` broken, and replace the CLI-only `tokentrail init` with a discoverable web onboarding wizard at `/welcome`.

## Goal

Today, installing Tokentrail looks like:

```bash
git clone https://github.com/loschenbd/tokentrail
cd tokentrail
npm install
npm run tokentrail -- run-all --skip-sync --skip-enrich
npm run tokentrail -- init
```

That is fine for the author and the first three users. It is not fine for "I read about Tokentrail and want to try it." This spec replaces those five steps with:

```bash
brew install loschenbd/tokentrail/tokentrail
tokentrail dashboard
# → browser opens to /welcome, which walks the rest of setup
```

Along the way it fixes packaging bugs (broken bin shim, assets resolved from the repo checkout instead of the installed package, daemon launched via a devDep loader) that already block `npm install -g` today and would block any brew install.

## Non-goals

- **Submission to homebrew-core.** Notability bar (~225 stars for self-submitted software) is not realistic yet, and core forbids "tools with self-upgrade capabilities" — `tokentrail init` writing launchd plists would trip "heavy install" rules. Deferred until usage warrants it.
- **Single static binary** (`pkg`, `bun build --compile`, Node SEA). All three are dead ends today with `better-sqlite3`: `pkg` is archived, Bun can't load `better-sqlite3` via `--compile`, and Node SEA can't embed native modules. Revisit if the DB layer is ever rewritten onto `bun:sqlite` or `node:sqlite`.
- **Pre-built bottles per architecture.** Possible via `Homebrew/actions/setup-homebrew` + `brew test-bot`, but `better-sqlite3`'s published prebuilds make a stock `npm install` finish in ~10s — bottling buys little for the CI cost.
- **Cross-platform install.** Tokentrail's `init` is macOS-only (SwiftBar, launchd). The formula will be macOS-only via `depends_on macos: ...` or simply not advertised on Linux. Linux brew users can still `brew install` and use the CLI, but `init`/dashboard onboarding will refuse with a message.
- **First-launch CLI prompt.** Considered. Web onboarding is more discoverable, matches the existing `/welcome` route, and avoids prompt fatigue. The CLI `tokentrail init` remains as the non-interactive power-user shortcut.
- **Auto-uninstall cleanup.** `brew uninstall tokentrail` removes the binary and `libexec/`, but the launchd plist, SwiftBar plugin symlink, skills, and hook stay where init put them. Documented in caveats; a separate `tokentrail uninstall` command can be added later.

## Architecture

Two repos, separated by audience:

| Repo | Purpose | Contents |
|---|---|---|
| `loschenbd/tokentrail` (existing) | The product | CLI source, dashboard, templates, scripts. Tagged GitHub releases trigger formula bumps. |
| `loschenbd/homebrew-tokentrail` (new) | The tap | `Formula/tokentrail.rb` + one GitHub Action that bumps the formula's `url`+`sha256` when the main repo tags a release. |

End-user flow:

```
$ brew install loschenbd/tokentrail/tokentrail
$ tokentrail dashboard
  → opens http://localhost:4920/welcome
  → /welcome shows trail map + onboarding checklist
  → user clicks through SwiftBar / daemon / skills / hook setup
```

## Tap repo: `homebrew-tokentrail`

Single-file content. `Formula/tokentrail.rb`:

```ruby
class Tokentrail < Formula
  desc "Local ledger and trail-map for Claude Code spend"
  homepage "https://github.com/loschenbd/tokentrail"
  url "https://github.com/loschenbd/tokentrail/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "<filled by release workflow>"
  license "MIT"

  depends_on "node"
  depends_on "python" => :build   # node-gyp fallback if better-sqlite3 prebuild misses

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

Notes:

- `std_npm_args` is the maintained helper (`Language::Node.std_npm_install_args` is the older, still-tolerated form).
- `npm install` happens at install-time on the user's machine. better-sqlite3's `prebuild-install` fetches a `(node ABI × arch × platform)` prebuild from WiseLibs' GitHub releases — fast path. Falls back to source build via node-gyp if no match.
- **Landmine flagged by Homebrew issue #176257**: native modules can pick up the wrong `node` from `PATH` instead of the formula's `node`, breaking ABI. If this bites, switch to invoking Homebrew's node explicitly in the shebang via a wrapper script in `libexec/bin/`.
- `livecheck` makes `brew livecheck tokentrail` show pending versions and lets a bump bot stay reliable.

## Main repo cleanup (prerequisite)

Four fixes to land BEFORE the first formula tag — none of them are "for brew" specifically; they are real bugs that already block `npm install -g`. Each is small and independently testable.

### 1. Bin shim points at a path that doesn't exist

`package.json`:

```diff
- "bin": { "tokentrail": "./dist/index.js" }
+ "bin": { "tokentrail": "./dist/src/index.js" }
```

Root cause: `tsconfig.json` has `rootDir: "."` and `include: ["src/**/*", ...]`, so `tsc` emits `src/index.ts` to `dist/src/index.js`, not `dist/index.js`. The deleted `mascot-ascii-trail` branch had this exact fix; it never made master.

Alternative (deferred): flip `rootDir` to `src/` and re-home `config/` and `tests/` outside the include. Cleaner output tree, more diff. Not worth it for v0.2.0.

### 2. `REPO_ROOT` walks the wrong way

`init.ts`, `install-skills.ts`, and `install-hook.ts` each do:

```ts
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
```

From compiled `dist/src/commands/init.js`, that resolves to `dist/` — not the package root — so every `join(REPO_ROOT, 'templates', ...)`, `join(REPO_ROOT, 'scripts', 'menubar', ...)`, and `join(REPO_ROOT, 'src', 'hooks', ...)` lookup fails the moment the code runs outside the git checkout.

Fix: add `src/lib/pkg-root.ts`:

```ts
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function pkgRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) { cached = dir; return dir; }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('tokentrail: could not locate package root from ' + import.meta.url);
}
```

Replace each `REPO_ROOT` call site with `pkgRoot()`. Same behavior in dev (still finds the git checkout's root), correct behavior post-install (finds `<HOMEBREW_PREFIX>/lib/node_modules/tokentrail/`).

### 3. Non-JS assets aren't shipped

`package.json` has no `"files"` field, so `npm pack` includes everything except `node_modules`. That's accidentally fine for the current local-checkout flow but leaks dev cruft into the published tarball. Lock it down explicitly:

```json
"files": [
  "dist/",
  "templates/",
  "scripts/menubar/",
  "src/hooks/",
  "README.md",
  "LICENSE"
]
```

`templates/` covers skills and slash commands. `scripts/menubar/` carries the SwiftBar plugin. `src/hooks/` carries `session-end.sh`. Everything else (`tests/`, `docs/`, `config/`) stays out of the tarball.

### 4. Daemon plist points at source files + a devDep loader

`installDaemon` writes a plist whose `ProgramArguments` is:

```
node --import tsx <REPO_ROOT>/src/index.ts dashboard --no-open
```

That works for the author (whose `tsx` is a devDep already installed) and fails for everyone else. Fix: write the plist to invoke the installed `tokentrail` bin directly, with no Node ABI assumptions:

```xml
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/tokentrail</string>
  <string>dashboard</string>
  <string>--no-open</string>
</array>
```

Resolve the bin path at init time: `process.argv[1]` (the CLI's own path), or `process.execPath` for the node binary if we want to be more explicit. Hardcoded `/opt/homebrew/bin/tokentrail` works only on arm64; reading it from `process.argv[1]` works on both architectures and post-`brew unlink`/`relink`.

Side benefit: this also fixes a latent bug where the daemon today pins to whichever Node ABI was on PATH at first `init` — silently breaks if the user upgrades Node.

## Dashboard onboarding wizard

The dashboard's `/welcome` route already exists and renders the animated trail map. This spec adds a checklist component beside it, plus four `POST /api/setup/*` endpoints that wrap the existing install functions.

### Detection (server-side, runs once per `/welcome` render)

```ts
type SetupStatus = {
  swiftbarApp: boolean;       // /Applications/SwiftBar.app exists
  menubarPlugin: boolean;     // ~/Library/Application Support/SwiftBar/tokentrail.1m.sh exists
  daemon: boolean;            // ~/Library/LaunchAgents/com.tokentrail.daemon.plist exists
  skills: boolean;            // ~/.claude/skills/tokentrail-spend exists
  hook: boolean;              // any ~/.claude/projects/*/cwd repo has the hook wired
};
```

`hook` is best-effort: enumerate `~/.claude/projects/*` for `cwd` files, check the first that resolves to an existing repo for a `.claude/settings.json` containing Tokentrail's hook path. "Found in at least one" → `true`.

### UI

A vertical list of rows above the trail map. Each row:

```
[●] CLI installed                                   (always green — you're here)
[○] SwiftBar.app                                    [Show command]
[○] Menubar plugin                                  [Run]
[○] Dashboard daemon                                [Run]
[○] Claude Code skills                              [Run]
[○] Session-end hook (per repo)                     [Show command]
```

- `[Show command]` reveals a copyable command line — used for SwiftBar.app (no web-driven install) and for the per-repo hook (which needs a `--repo` argument).
- `[Run]` POSTs to the corresponding `/api/setup/*` endpoint and reports success/failure inline.
- Status dots refresh after each action.

When all rows are green, the checklist collapses to a one-line "Setup complete" with a "Re-check" button.

### Endpoints

```
POST /api/setup/menubar-plugin   → calls installSwiftBarPlugin from commands/init.ts
POST /api/setup/daemon           → calls installDaemon from commands/init.ts
POST /api/setup/skills           → calls runInstallSkills from commands/install-skills.ts
POST /api/setup/status           → returns the SetupStatus object (for re-checks)
```

Each endpoint is a thin wrapper over the existing function. Failures are captured (try/catch around the function call) and returned as `{ ok: false, error: string }`. The same-origin guard already in place on the dashboard server (binds to `127.0.0.1`) is sufficient — no CSRF token added.

`POST /api/setup/hook` is **not** added: the hook is per-repo and requires a path argument, which is awkward to enter via a web form. The UI shows the `tokentrail install-hook --repo /path/to/repo` command for the user to copy.

## Release & formula workflow

**Version bump on main repo:**
1. Bump `package.json` version → commit → tag `v<X.Y.Z>` → push tag.
2. GitHub release workflow on the main repo: build the dist, run tests, attach `tokentrail-v<X.Y.Z>.tar.gz` to the release. Trigger a `repository_dispatch` event on the tap repo with the new version.

**Tap repo bump workflow:**
3. Tap repo's GitHub Action receives the dispatch, downloads the new release tarball, computes its sha256, opens a PR against the tap repo updating `Formula/tokentrail.rb`'s `url` and `sha256`.
4. Merge the PR. `brew update` on user machines picks up the new formula; `brew upgrade tokentrail` installs it.

The bump workflow is small (~30 lines of YAML) — borrow Simon Willison's [`auto-formulas-github-actions` recipe](https://til.simonwillison.net/homebrew/auto-formulas-github-actions).

No homebrew-core autobump because that only services core/cask. The `livecheck` block in the formula still earns its keep: `brew livecheck tokentrail` shows pending versions, and the bump bot uses it.

## Error handling

Three new failure surfaces:

1. **`brew install` fails during `npm install`** — better-sqlite3 prebuild missing AND user has no Xcode CLT. The formula's `depends_on "python" => :build` covers Python; if CLT isn't installed, `node-gyp` errors with a clear message ("xcode-select --install"). Document this in the tap repo's README.
2. **`/api/setup/*` endpoint fails** — wrap each handler in try/catch; return `{ ok: false, error }`; the UI displays the error text inline next to the row. The row stays red, action button remains active for retry.
3. **`pkgRoot()` can't locate package.json** — throws an explicit error referencing `import.meta.url`. Happens only if someone unzips the package weirdly; loud failure is better than silent broken state.

## Testing

- **Unit (existing, updated):** `tests/init.test.ts`, `tests/install-skills.test.ts`, `tests/install-hook.test.ts` already pass; update mocks/fixtures for the `pkgRoot()` refactor (they currently set `REPO_ROOT` via an env override; switch to `templatesDir` / `nodePath` overrides that already exist).
- **Unit (new):** `tests/lib/pkg-root.test.ts` — verify it walks up from a known temp dir layout, throws clearly when no `package.json` is reachable.
- **Unit (new):** `tests/dashboard/setup-api.test.ts` — each `/api/setup/*` endpoint with the underlying function stubbed to success and failure.
- **Formula `test do`:** `tokentrail --version` returns a string containing "tokentrail". Runs on `brew test tokentrail`.
- **Integration (CI):** new GitHub Action job on `macos-latest` runner — `brew tap loschenbd/tokentrail && brew install --build-from-source loschenbd/tokentrail/tokentrail && tokentrail dashboard --help`. Catches packaging regressions before tag.
- **Manual smoke (pre-release):** `brew install --build-from-source ./Formula/tokentrail.rb` on the author's Mac, run through the `/welcome` checklist end-to-end.

## Open questions

- **Bin path resolution at init-time** — `process.argv[1]` is the CLI's own entry-point path. For a brew install this resolves to `/opt/homebrew/Cellar/tokentrail/<ver>/libexec/bin/tokentrail`. We want the symlinked `/opt/homebrew/bin/tokentrail` instead (survives `brew upgrade`). The plan stage should pick: `process.argv[1]` + `realpath -F` upward, or `which tokentrail` shell-out, or a documented env var. Plain `process.argv[1]` is simplest if we accept that `brew upgrade` will require one `tokentrail init` re-run to repoint the plist.
- **Initial version tag.** The main repo is at `0.1.0` per `package.json`. The cleanup work justifies a `0.2.0` bump as the first brew-tagged version; this spec assumes that.
- **Tap README badge/snippet.** Nice to advertise the install path on the main repo's README, but the exact wording / where in the README is a minor doc detail to settle during implementation.
