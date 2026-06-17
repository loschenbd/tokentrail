# Phase 2 — Tap setup checklist

Step-by-step for executing Phase 2 (`docs/superpowers/plans/2026-06-17-brew-install.md`)
once Phase 1 has merged and v0.2.0 is tagged. Files in this directory are
copy-paste ready into the new tap repo.

## Prerequisites

- [ ] Phase 1 PR merged to `master`.
- [ ] v0.2.0 tagged: `git tag v0.2.0 && git push origin v0.2.0`.
- [ ] (At tag-push time, `.github/workflows/release.yml` will fire. If
      `TAP_DISPATCH_TOKEN` is not yet configured, it logs a warning and
      no-ops — expected.)

## 1. Create the tap repo

```bash
gh repo create loschenbd/homebrew-tokentrail \
  --public \
  --description "Homebrew tap for tokentrail" \
  --clone
cd homebrew-tokentrail
```

The `homebrew-` prefix is required by Homebrew — it's stripped when users
type `brew tap loschenbd/tokentrail`.

## 2. Compute the real sha256

```bash
curl -sL https://github.com/loschenbd/tokentrail/archive/refs/tags/v0.2.0.tar.gz | shasum -a 256
```

Copy the 64-char hex value.

## 3. Populate from the staged drafts

```bash
# From the new homebrew-tokentrail checkout:
TAP_DRAFTS=/path/to/tokentrail/docs/superpowers/phase2-tap

mkdir -p Formula .github/workflows
cp "$TAP_DRAFTS/Formula/tokentrail.rb"     Formula/tokentrail.rb
cp "$TAP_DRAFTS/README.md"                  README.md
cp "$TAP_DRAFTS/.gitignore"                 .gitignore
cp "$TAP_DRAFTS/.github/workflows/bump.yml" .github/workflows/bump.yml
cp "$TAP_DRAFTS/.github/workflows/ci.yml"   .github/workflows/ci.yml
```

Then replace the SHA placeholder in `Formula/tokentrail.rb`:

```bash
sed -i.bak "s/REPLACE_WITH_REAL_SHA256_AFTER_TAGGING_V020/<paste your sha256>/" Formula/tokentrail.rb
rm Formula/tokentrail.rb.bak
```

## 4. Smoke-test locally before pushing

```bash
brew install --build-from-source ./Formula/tokentrail.rb
tokentrail --version    # should print "tokentrail 0.2.0"
brew test tokentrail    # asserts --version output contains "tokentrail"
```

If `npm install` falls back to compiling `better-sqlite3` from source and
fails, confirm Xcode CLT: `xcode-select -p`.

## 5. Enable Actions → PR permissions in the tap repo

In the tap repo's GitHub Settings → Actions → General → "Workflow permissions":
- Check "Allow GitHub Actions to create and approve pull requests."

This lets `bump.yml` open auto-bump PRs without a separate PAT.

## 6. Commit and push the tap

```bash
git add Formula README.md .gitignore .github
git commit -m "feat: initial tap with tokentrail v0.2.0"
git push -u origin main
```

## 7. Create the PAT for cross-repo dispatch (main repo → tap)

GitHub Settings → Developer settings → Personal access tokens → Fine-grained:

- Name: `tokentrail-tap-dispatch`
- Resource owner: `loschenbd`
- Repository access: `loschenbd/homebrew-tokentrail` only
- Permissions:
  - Contents: Read-only
  - Metadata: Read-only
  - Actions: Read and write

Save the token. Add it as a secret in the **main** repo:

```bash
gh secret set TAP_DISPATCH_TOKEN --repo loschenbd/tokentrail
# paste the PAT when prompted
```

## 8. End-to-end pipeline verification

From the tap repo, manually trigger the bump workflow against v0.2.0 — the
resulting PR should be a no-op (same url + sha256) but exercises every
moving piece:

```bash
gh workflow run bump.yml -f version=0.2.0 --repo loschenbd/homebrew-tokentrail
```

Expected:
- A PR titled `tokentrail v0.2.0` opens on the tap repo.
- The diff is empty (or only whitespace) — url + sha256 unchanged.
- CI (`ci.yml`) runs on the PR, brew installs from the formula, runs
  `--version` and `brew test`, all green.
- Close the PR without merging. Wiring confirmed.

## 9. Public smoke test (from a clean machine or after `brew untap`)

```bash
brew untap loschenbd/tokentrail  # if previously tapped
brew install loschenbd/tokentrail/tokentrail
tokentrail --version             # prints "tokentrail 0.2.0"
tokentrail init                  # walks SwiftBar + daemon + skills + hook setup
open http://127.0.0.1:4920       # dashboard daemon is up
```

## 10. Drop the "(once the tap ships)" caveat in main repo README

```bash
# Back in the main tokentrail repo, on master:
# Edit README.md to remove the "(once the tap ships)" parenthetical from
# the "Via Homebrew" section.
git commit -am "docs(readme): brew install is live"
git push
```

## Future releases

For v0.2.1 and beyond:

```bash
# In the main repo, after merging changes to master:
git tag v0.2.1
git push origin v0.2.1
```

The chain runs itself:
1. `release.yml` fires on tag push → dispatches to tap.
2. `bump.yml` on tap repo receives dispatch → computes new sha256 → opens
   bump PR.
3. `ci.yml` runs on the bump PR → brew install integration test.
4. Review the auto-PR → merge.
5. Users run `brew upgrade tokentrail` and re-run `tokentrail init` to
   refresh the launchd plist's program path.
