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
