# Tokentrail — native menu-bar app (prototype)

A SwiftUI `MenuBarExtra` client for the Tokentrail dashboard. Polls
`GET /api/today` on `127.0.0.1:4920` every 60s and renders today's spend, a
native **Swift Charts** stacked-area trend, anomalies, and top projects — in
one persistent process, with no SwiftBar dependency and no per-poll Node spawn.

## Why this exists

The shipped menu-bar widget is a SwiftBar plugin (`scripts/menubar/`) that
spawns an ~85 MB Node process every 60s and hand-encodes its chart as a PNG.
This app replaces that with a native process (~70 MB flat) and real Swift
Charts (interactive, animated, theme-aware). See the session notes for the
full trade-off analysis; the short version: native was chosen for the charts,
not for memory.

## Build & run

```sh
./build.sh            # compile + bundle dist/Tokentrail.app
./build.sh run        # build, then launch into the menu bar
./build.sh preview    # build, render the panel to dist/preview.png (headless)
```

Requires the Xcode toolchain (Swift 6+) and macOS 13+ (`MenuBarExtra`).
The app is `LSUIElement` (no Dock icon) and ad-hoc signed for local use.

## Status

Prototype. Working: live polling, stacked-area chart with server-resolved
project colors, hot-day flame in the menu-bar title, live dot, offline state.
Not yet done before it could retire the SwiftBar plugin: per-series chart
hover isolation, distribution/signing, and wiring into `make install`.
