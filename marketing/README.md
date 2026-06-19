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
its only external requests are to `./static/logo.png` and
`./static/favicon.svg`.

## Editing the trail visual

The CSS and the `BG` / `TRAIL` JavaScript arrays in `index.html`
duplicate the live dashboard's `src/dashboard/static/trail-map.css`
and `src/dashboard/static/trail-map.js`. When you change one, change
the other. The trail data is locked illustrative content — edits
should be rare.
