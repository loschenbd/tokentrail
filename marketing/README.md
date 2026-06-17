# Tokentrail marketing page

Single-file landing page for tokentrail. No build step.

## Deploy

Drop `marketing/` into Vercel, Netlify, GitHub Pages, or any static
host. `index.html` is self-contained — its only external requests are
to `./static/logo.png` and `./static/favicon.svg`.

## Editing the trail visual

The CSS and the `BG` / `TRAIL` JavaScript arrays in `index.html`
duplicate the live dashboard's `src/dashboard/static/trail-map.css`
and `src/dashboard/static/trail-map.js`. When you change one, change
the other. The trail data is locked illustrative content — edits
should be rare.
