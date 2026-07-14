# Tokentrail marketing page

Single-file landing page for tokentrail. No build step.

Live at <https://tokentrail.benjaminloschen.com>.

## Deploy (Vercel)

From this directory:

```bash
cd marketing/
vercel              # first time: creates project, links it
vercel --prod       # deploy to production
```

When prompted for the project's root directory, accept the default
(`./`). Custom domain (`tokentrail.benjaminloschen.com`) is configured
in the Vercel dashboard → Project → Settings → Domains. Vercel will
print the CNAME target to add at Namecheap.

`vercel.json` only configures cache headers for `/static/*`. The site
is otherwise a plain static drop — `index.html` is self-contained and
its only external requests are to `./static/logo.png`,
`./static/favicon.svg`, and Google Fonts (Spectral, M PLUS 1 Code,
PT Mono — the same faces the dashboard self-hosts).

## Editing the trail visual

The CSS and the `BG` / `TRAIL` JavaScript arrays in `index.html`
duplicate the live dashboard's `src/dashboard/static/trail-map.css`
and `src/dashboard/static/trail-map.js`. When you change one, change
the other. The trail data is locked illustrative content — edits
should be rare.

## Mobile breakpoint

The page targets `@media (max-width: 640px)` for phones. Inside the
single `@media` block at the bottom of the `<style>` element you'll
find: chrome padding tightens, the 4-column stats grid stacks 2×2,
the install CTA wraps without ellipsis, and the trail map switches
to a portrait dataset.

The mobile trail (`BG_MOBILE` + `TRAIL_MOBILE` in the IIFE) is
**marketing-only** — it does NOT need to be mirrored to
`src/dashboard/static/trail-map.js`. The desktop dataset
(`BG_DESKTOP` + `TRAIL_DESKTOP`) still mirrors the dashboard.

Mobile product screenshots are captured at ~390 px viewport against
the local dashboard (`tsx src/index.ts dashboard --port 9876`) and
saved as `<name>-mobile.png` alongside their desktop counterparts.
The `<picture>` blocks in `index.html` swap them in below 640 px.
