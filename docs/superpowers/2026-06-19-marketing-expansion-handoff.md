# Marketing Page Expansion — Session Handoff

**Date:** 2026-06-19
**Trigger:** Need to restart Claude Code session to pick up the freshly-registered
Playwright MCP (`/opt/homebrew/bin/npx -y @playwright/mcp@latest`, user-scoped).

## State at handoff

- `master` HEAD: v0.2.2 (`c24879d`). Working tree clean.
- Marketing site live at <https://tokentrail.benjaminloschen.com> (Vercel,
  single-file static `marketing/index.html`).
- README has `Site: <https://tokentrail.benjaminloschen.com>` at line 11.
- `package.json` `homepage` → marketing site ✓.
- `marketing/index.html` ⌘C indicator removed ✓ (orphan `.install-copy`
  CSS rule remains; safe to leave or strip during expansion work).
- Playwright MCP registered user-wide with absolute `npx` path. First call
  after restart may take 5-30s (cold cache); retry if it times out.

## Pending greenlight (decide before kickoff)

These touch published/shared state — they're staged but not done.

1. **Formula homepage** in `homebrew-tokentrail/Formula/tokentrail.rb` line 3:
   currently `https://github.com/loschenbd/tokentrail` → should be
   `https://tokentrail.benjaminloschen.com`. Sister-repo edit, needs explicit
   greenlight.
2. **GitHub repo About URL** for `loschenbd/tokentrail` — currently empty.
   `gh repo edit loschenbd/tokentrail --homepage https://tokentrail.benjaminloschen.com`.

User-owned cleanup the other agent left (NOT for Claude):

- `gh pr close 1 --repo loschenbd/homebrew-tokentrail --comment "Superseded by #2 (v0.2.2)."`
- `gh api -X DELETE /repos/loschenbd/homebrew-tokentrail/git/refs/heads/bump/v0.2.1`
- `git push origin :v0.2.1` (optional — clean tag list)

## Work plan

### 1. Spin worktree

```bash
git worktree add .worktrees/marketing-expansion -b feat/marketing-expansion HEAD
cd .worktrees/marketing-expansion
npm install   # restores deps in the worktree
```

### 2. Boot dashboard

Real DB, free port (the existing daemon owns 4920):

```bash
npm run tokentrail -- dashboard --port 4925 --no-open
```

### 3. Capture screenshots via Playwright MCP

Drive the MCP to capture these routes at retina (2× device pixel ratio):

| Route | Caption purpose |
|---|---|
| `/welcome` | Onboarding wizard — checklist + trail-map side-by-side |
| `/` | Daily overview — trail map + stat grid + sparkline |
| `/worth-a-look` | Anomalies — surface the "spike_day" / "burning_feature" rows |
| `/feature/<top-feature-key>` | Feature detail — topic clusters + sessions list |

Save PNGs to `marketing/static/screenshots/` with descriptive names
(`welcome-wizard.png`, `daily-overview.png`, `worth-a-look.png`,
`feature-detail.png`). 2× retina, viewport ~1280×800 (capture the meaningful
content, not the full page chrome).

SwiftBar widget is a macOS overlay — Playwright can't capture it. Either skip
or take a manual `Cmd+Shift+5` shot and drop into the same folder.

### 4. Expand `marketing/index.html`

Current structure: hero (ASCII trail map) + install CTA + "Read the docs" link.
Keep all of that. Add ABOVE the install CTA:

1. **"What it does"** — 3 short sections (icon + headline + 1 sentence)
   - "Reads your local Claude Code logs" (privacy/local-first)
   - "Maps cost to branches, features, PRs" (attribution)
   - "Surfaces anomalies + syncs to Notion" (workflow)
2. **"Onboarding wizard"** — `welcome-wizard.png` + 2-line caption explaining
   the SwiftBar / daemon / skills / hook checklist.
3. **"Daily dashboard"** — `daily-overview.png` + caption on the trail-map /
   stat-grid view.

Add BELOW install CTA:

4. **"Spot what's burning"** — `worth-a-look.png` + 1-2 sentence anomaly pitch.
5. **"Feature deep-dive"** — `feature-detail.png` + topic clusters explanation.
6. **Notion sync** — short callout about optional Notion mirroring (no
   screenshot needed; link to README section).
7. **Footer** — GitHub link, brew install one-liner repeat (optional).

Match existing aesthetic (parchment/trail-map theme). Keep the single-file
static structure — no build step.

### 5. Commit + PR

```bash
git add marketing/ docs/
git commit -m "feat(marketing): expand landing page with screenshots + feature walkthrough"
gh pr create --title "feat(marketing): expand landing page with screenshots" --body "..."
```

## Resume commands

In the new session, after `/mcp` confirms Playwright is connected:

```bash
cd /Users/benjaminloschen/Projects/tokentrail
cat docs/superpowers/2026-06-19-marketing-expansion-handoff.md
# Then start at "Work plan → 1. Spin worktree"
```
