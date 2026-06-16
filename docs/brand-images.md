# Brand & image generation guide

This document is for agents (Claude Code, ChatGPT, nano-banana, etc.) asked to
produce on-brand images for Tokentrail — logos, README hero art, social cards,
blog headers, dashboard graphics, anything visual.

Read this in full before generating. The palette, voice, and "do not" list
matter more than any individual prompt.

## Brand identity

Tokentrail is a **trail-map and ledger for AI spend**. The voice is calm,
precise, and lightly fantasy-coded. The visual identity is the
**cartographer theme**: aged parchment, sepia ink, hand-drawn map cues.
Restrained, confident, clarity-first. Fantasy flavor belongs in microcopy
and small visual cues — never overpowering, never kitsch.

If you find yourself reaching for pirate skulls, treasure chests, dragons,
neon, glow effects, or saturated brand colors, you are off-brand. Pull back.

## Source of truth

The design tokens that drive the dashboard are in
`src/dashboard/tokens.ts`. **Always read that file first** — if you find a
conflict between this guide and `tokens.ts`, `tokens.ts` wins and this
guide is stale. Update this guide rather than diverging.

## Palette (exact)

| Role | Hex | Use |
|---|---|---|
| Parchment top | `#f8f3e7` | Background top of gradient |
| Parchment bottom | `#f0e5d0` | Background bottom of gradient |
| Ink | `#3d2f1f` | Primary structure, rims, text-equivalent strokes |
| Ink muted | `#6b563d` | Secondary structure |
| Ink subtle | `#8b6f47` | Tertiary structure, rules, map contour lines |
| Light sepia | `#c9b48d` | Coin/token faces, light fills, card borders |
| Accent green (sage olive) | `#5d7a3e` | Accent only — used sparingly. Trail blazes, highlights, hover states |

**Backgrounds are always a subtle vertical gradient from parchment-top to
parchment-bottom**, never a flat color, never white, never cream from
outside the palette.

**Accent green is the rarest color.** Use it like punctuation, not paint.
A logo can omit it entirely (as the current `docs/logo.png` does).

## Typography

| Role | Family |
|---|---|
| Display / serif | `Georgia, "Times New Roman", serif` |
| Body / UI sans | `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` |
| Code / mono | `ui-monospace, "SF Mono", Menlo, monospace` |

For any wordmark or image that includes the word "Tokentrail", default to
**Georgia** (or Georgia italic for an old-map-label feel). Never a
sans-serif tech wordmark. Never a script or display font.

## Visual style rules

**Always:**
- Flat vector aesthetic. Crisp edges. Geometric.
- Parchment-tone backgrounds (subtle gradient).
- Cartography motifs when they help: dashed trails, contour lines, compass
  hints, hand-drawn-map warmth. Used sparingly.
- One concept per image. Calm composition. Generous whitespace.

**Never:**
- Neon, saturated, or bright colors.
- Pure black (`#000`) or pure white (`#fff`).
- Teal, blue, magenta, purple, electric green — any color outside the palette.
- Drop shadows, glow effects, 3D bevels, realistic shading.
- Wood grain, tree-ring patterns, brushed metal, fabric, marble — anything
  that reads as physical texture beyond aged paper.
- Stock-illustration aesthetic, AI-generic "tech logo" look, gradient-heavy
  modern startup polish that ignores the palette.
- Pirate, fantasy, RPG, or treasure-map iconography (skulls, chests,
  scrolls-tied-with-ribbon, dragons, swords). The cartographer theme
  is restrained, not pirate-coded.

## The mark

`docs/logo.png` is the current canonical logo. It depicts a **pile of
spent tokens dispersing into an arcing trail of individual coins**. The
metaphor: tokens spent leaving a trail behind — the product's story in
one mark.

When creating supporting imagery (blog headers, social cards, dashboard
hero art), the trail-of-tokens motif is the visual anchor. Don't reinvent
the mark; extend it. A blog post header might be a longer, gentler trail
of coins across a wider canvas. A social card might pair the logo with
typography and ample parchment whitespace.

## Prompt template for nano-banana

Use this as the starting template when calling `generate_image`. Edit the
**Concept** and **Composition** sections per request; keep the **Style**
and **Palette** sections intact.

```
Minimalist flat vector image for Tokentrail — a CLI that traces AI token
spend across project branches like a trail on a hand-drawn map.

CONCEPT:
<one or two sentences describing what the image should depict>

COMPOSITION:
<numbered, specific layout instructions. Be precise about placement,
size, count, orientation. Vague prompts produce vague output.>

STYLE:
Clean flat vector with the warmth of aged parchment cartography. Crisp
edges. No gradients (except the background). No drop shadows. No 3D
bevels. No realistic textures. No noise. No wood grain. Confident
restrained polish, hand-drawn-map warmth. One concept per image.

EXACT PALETTE (use only these colors):
- Parchment background: vertical gradient from #f8f3e7 (top) to #f0e5d0 (bottom)
- Ink / structure / rims: #3d2f1f
- Ink muted / secondary: #6b563d
- Ink subtle / map contours: #8b6f47
- Light sepia / coin faces / fills: #c9b48d
- Accent green / trail blazes (use sparingly, can be omitted): #5d7a3e

TYPOGRAPHY (if any text):
Georgia serif. Never sans-serif. Never script.

CRITICAL — DO NOT INCLUDE:
- Neon, saturated, or out-of-palette colors
- Pure black or pure white
- Wood grain, tree rings, concentric rings inside discs
- Pirate, fantasy, RPG iconography (skulls, chests, dragons, swords)
- Drop shadows, 3D bevels, realistic shading, glow effects
- Generic-AI tech-logo aesthetic
```

Always use `imageSize: 1K` for iteration and `2K` only for finals. Always
use `thinkingConfig: { thinkingLevel: "HIGH" }` for compositions with
specific count, layout, or text requirements.

## Worked example

The current `docs/logo.png` was produced by `generate_image` with this
prompt (abbreviated; the actual call is in conversation history):

> Spend-pile-dispersing-into-trail concept. 5 overlapping coins in
> lower-left forming a pile, 5 individual coins arcing up to upper-right
> with growing spacing and shrinking size, suggesting a trail extending
> beyond the frame. Each coin: flat sepia face (#c9b48d) + single thin
> ink rim (#3d2f1f). No internal stamps, no concentric rings, no compass.
> Parchment background. No sage (kept restrained).

What worked:
- Explicit count (5 + 5) and layout (lower-left pile, upper-right trail).
- Repeating the coin spec inside each section so the model didn't drift.
- An explicit "DO NOT" list — the model previously kept inserting tree
  rings on the coin face when not told otherwise.
- Reserving sage for later; this mark intentionally omits the accent.

## Per-context sizing & cropping

| Context | Aspect | Notes |
|---|---|---|
| Repo logo / app icon | 1:1 | The canonical `docs/logo.png`. Should read at 32×32. |
| README hero | 3:1 to 4:1 | Wider crop, more parchment whitespace, optional Georgia wordmark to the right of the mark. |
| Social card (OG) | 1.91:1 | Logo + Georgia "Tokentrail" + tagline ("Trace AI token spend"). |
| Blog post header | 16:9 | Trail-of-tokens motif stretched across the canvas; very wide, gentle arc. |
| Favicon (16/32) | 1:1 | Simplify ruthlessly — reduce coin count, drop pile, keep 3 trail coins max. |

For very small renders (favicon), generate a dedicated simplified version
rather than scaling down the full mark — the pile compresses to a blob
and the trail loses readability past 32px.

## When in doubt

- Read `src/dashboard/tokens.ts` for the live palette.
- Look at the existing `docs/logo.png` for the established visual
  vocabulary.
- Pull back rather than push forward. Restrained beats clever.
- Show the user the generated image and ask before iterating beyond v3 —
  most concept misfires get caught on v2 review.
