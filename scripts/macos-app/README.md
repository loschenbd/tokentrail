# Tokentrail.app — macOS launcher

A thin `.app` bundle that opens the Tokentrail dashboard in your
browser with one click from Spotlight, Dock, or LaunchPad. It is NOT
a native window — clicking it spawns the local dashboard server
(`tokentrail dashboard`) if not already running, then opens
`http://127.0.0.1:4920/` in your default browser.

## Build & install

```bash
cd scripts/macos-app
make app                        # produces dist/Tokentrail.app
make install                    # copies to /Applications/
```

The icon is generated from `docs/logo.png` via `sips` + `iconutil`
(both bundled with macOS — no extra tooling required). The bundle
version string is read from `package.json`.

## First-launch (Gatekeeper)

The bundle is unsigned. Running it for the first time may show a
"cannot verify developer" warning. Bypass by right-clicking the app
in Finder and choosing **Open** — macOS then remembers your approval.

## Behavior

| State                                  | What clicking the icon does                                |
|----------------------------------------|------------------------------------------------------------|
| Dashboard daemon already running       | Opens `http://127.0.0.1:4920/` in browser, app exits       |
| Daemon not running, `tokentrail` on PATH | Spawns `tokentrail dashboard --no-open` detached, polls for ~4 s, opens browser when ready |
| `tokentrail` not installed             | Shows alert: "Install with: brew install loschenbd/tokentrail/tokentrail" |

The launcher additionally starts **SwiftBar** (so the `tokentrail.1m.sh`
menubar plugin under `scripts/menubar/` becomes visible) if SwiftBar is
installed at `/Applications/SwiftBar.app` and isn't already running.
SwiftBar is optional — if it's not installed, the launcher silently
skips that step.

Logs from the spawned dashboard go to `/tmp/tokentrail-dashboard.log`.

## Notes

- Apps launched from Finder/Spotlight inherit a minimal `PATH`; the
  launcher prepends `/opt/homebrew/bin`, `/usr/local/bin`, and
  `~/.local/bin` so `tokentrail` resolves on both Apple Silicon and
  Intel Macs.
- The bundle is a launcher only. For a native window with its own
  Dock presence, look at Tauri / Electron — out of scope here.
