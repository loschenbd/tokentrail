# Active Work Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SVG swimlane/railroad branch graph in the "Active work · last 30d" panel with a ranked branch table — one row per branch, spend as a bar, a 30-day activity-window track for lifecycle, and dot-hue + ghosting for status. Pure presentation over existing `BranchGraphVM` data.

**Architecture:** Markup in `src/dashboard/render/project.ts`, styling in `src/dashboard/static/dashboard.css`, and removal of dead branch-graph JS in `src/dashboard/static/dashboard.js`. The fold toggle is generalized to a shared `[data-tail-toggle]` handler reused by both the Features tail and the new branch tail. No view-model/query/route change.

**Tech Stack:** TypeScript template-string renderers, hand-written CSS with `tokens.ts` custom properties, vanilla DOM JS, `node:test`.

## Global Constraints

- **No data-layer change.** Do not edit `src/dashboard/data/project.ts` or `branches.ts`, queries, or routes. Consume existing `BranchLifecycle` (`branch`, `firstEventAt`, `lastEventAt`, `mergedAt`, `status`, `totalUsd`, `sessionCount`) and `BranchGraphVM` (`windowStart`, `windowEnd`, `days`, `totalUsd`) fields only.
- **Encoding discipline (from the research):** spend → bar length off a zero baseline only (never area/color); status → dot hue (never cost); stale reinforced by row opacity, not by color saturation alone.
- Every CSS color a `var(--color-*)` token; both light and dark themes correct. Branch names in `var(--font-mono)`; card/section labels in the Spectral naming voice (`var(--font-serif)`).
- Progressive enhancement: folded tails are `hidden` by default and revealed by JS; with JS off they stay collapsed.
- Do NOT remove the shared JS helpers `niceTimeTicks`, `fmtTickDate`, `truncate` — `renderTrailElevation` uses them. Only `renderBranchGraph` and its invocation are removed.
- Run `npm test` after every task; each task keeps the suite green.

---

## File Structure

- `src/dashboard/render/project.ts` — Rewrite `renderActiveWork`; replace `renderBranchSummary` with `renderBranchTable`; migrate `renderFeatures`' tail markup to the shared toggle contract; drop the `jsonForScriptTag` import if unused after the mount is gone.
- `src/dashboard/static/dashboard.js` — Replace the `[data-pfeat-tail]` handler with a generic `[data-tail-toggle]` handler; delete `renderBranchGraph` (~lines 671–872) and its call (~line 1203).
- `src/dashboard/static/dashboard.css` — Rename the Features tail classes to the shared `.tail-toggle`/`.tail-body`; add `.bwork-*` branch-table styles; remove dead `.bsum-*` and `.branch-graph*` rules.
- `tests/project-render.test.ts` — Update Features tail assertions to the shared contract; rewrite the active-work assertions.

---

### Task 1: Generalize the fold toggle; migrate Features to it

Introduce one shared `[data-tail-toggle]` handler + markup contract and move the Features tail onto it, so Task 2's branch tail reuses it instead of copy-pasting.

**Files:**
- Modify: `src/dashboard/render/project.ts` (`renderFeatures` tail markup — locate by content: the `data-pfeat-tail` button + `pfeat-tail` div)
- Modify: `src/dashboard/static/dashboard.js` (the `[data-pfeat-tail]` handler — locate by content)
- Modify: `src/dashboard/static/dashboard.css` (`.pfeat-tail-toggle`, `.pfeat-tail[hidden]` rules — locate by content)
- Test: `tests/project-render.test.ts` (the folded-tail test)

**Shared contract:** a `<button class="tail-toggle" data-tail-toggle aria-expanded="false">` containing `<span class="tail-toggle-label">…</span><span class="tail-toggle-caret">›</span>`, immediately followed by a sibling `<div class="tail-body" hidden>…</div>`.

- [ ] **Step 1: Update the Features folded-tail test to the shared contract**

In `tests/project-render.test.ts`, in the `long tail folds behind a toggle…` test, change the two markup assertions:

```ts
    assert.match(seg, /data-tail-toggle/);
    assert.match(seg, /\+ 3 more under \$10 · \$8 total/);
    assert.match(seg, /class="tail-body" hidden/);
    assert.match(seg, /Foxtrot/);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: FAIL — `data-tail-toggle` / `tail-body` not present yet.

- [ ] **Step 3: Migrate the Features tail markup**

In `renderFeatures`, change the tail block so it emits the shared contract (rename only — logic identical):

```ts
    tailBlock = `
      <button class="tail-toggle" type="button" data-tail-toggle aria-expanded="false">
        <span class="tail-toggle-label">${label}</span><span class="tail-toggle-caret">›</span>
      </button>
      <div class="tail-body" hidden>${tailRows}</div>`;
```

- [ ] **Step 4: Replace the JS handler with the generic one**

In `dashboard.js`, replace the `[data-pfeat-tail]` handler block with:

```js
  // Generic expand/collapse for any folded tail (features list, branch table).
  document.querySelectorAll('[data-tail-toggle]').forEach(function (btn) {
    var body = btn.nextElementSibling;
    if (!body) return;
    var label = btn.querySelector('.tail-toggle-label');
    var caret = btn.querySelector('.tail-toggle-caret');
    var collapsedLabel = label ? label.textContent : '';
    btn.addEventListener('click', function () {
      var willOpen = body.hasAttribute('hidden');
      body.toggleAttribute('hidden');
      btn.setAttribute('aria-expanded', String(willOpen));
      if (label) label.textContent = willOpen ? 'Collapse' : collapsedLabel;
      if (caret) caret.textContent = willOpen ? '⌄' : '›';
    });
  });
```

Keep its placement (top-level, in the same `DOMContentLoaded` scope beside `renderBranchGraph()`).

- [ ] **Step 5: Rename the Features tail CSS to the shared classes**

In `dashboard.css`, rename the selectors (styles unchanged): `.project-page .pfeat-tail-toggle` → `.project-page .tail-toggle`, and `.project-page .pfeat-tail[hidden]` → `.project-page .tail-body[hidden]`. (The `.tail-toggle` button styling should live under `.project-page` so both consumers inherit it.)

- [ ] **Step 6: Run tests**

Run: `npx tsx --test tests/project-render.test.ts` then `npm test`
Expected: PASS (462 total).

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/render/project.ts src/dashboard/static/dashboard.js src/dashboard/static/dashboard.css tests/project-render.test.ts
git commit -m "refactor(project): generalize folded-tail toggle to shared [data-tail-toggle]"
```

---

### Task 2: Rebuild `renderActiveWork` as the ranked branch table

**Files:**
- Modify: `src/dashboard/render/project.ts` — rewrite `renderActiveWork`; replace `renderBranchSummary` with `renderBranchTable`; drop the graph mount + JSON payload; drop `jsonForScriptTag` import if now unused.
- Modify: `src/dashboard/static/dashboard.css` — add `.bwork-*` rules; remove dead `.bsum-*` and `.branch-graph*` rules.
- Test: `tests/project-render.test.ts` (active-work describe block)

**Interfaces:**
- Consumes: `vm.branchGraph` (`windowStart`, `windowEnd`, `days`, `totalUsd`, `branches[]`), `vm.recentCommits`, `vm.projectName`. `BranchLifecycle` is already imported.
- Produces: `.bwork` table inside `<section data-section="active-work">`, using the shared `[data-tail-toggle]`/`.tail-body` contract from Task 1.

- [ ] **Step 1: Rewrite the active-work tests**

Replace the `renderProject active-work section` describe block's body with:

```ts
  test('branch table renders a row per branch with name, spend fill, activity segment, sessions', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.match(seg, /worktree-local-semantic-search/);
    assert.match(seg, /bwork-fill/);       // spend bar
    assert.match(seg, /bwork-seg/);         // activity-window segment
    assert.match(seg, /bwork-row bwork-open/);
  });

  test('merged branch carries a ✓; stale branch carries the stale class', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.match(seg, /bwork-row bwork-merged/);
    assert.match(seg, /bwork-tick/);
    assert.match(seg, /bwork-row bwork-stale/);
  });

  test('activity segment left/width stay within 0–100%', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    const styles = [...seg.matchAll(/style="left:([\d.]+)%;width:([\d.]+)%"/g)];
    assert.ok(styles.length >= 1, 'expected at least one segment');
    for (const m of styles) {
      const left = Number(m[1]); const width = Number(m[2]);
      assert.ok(left >= 0 && left <= 100, `left ${left} in range`);
      assert.ok(width >= 0 && width <= 100, `width ${width} in range`);
      assert.ok(left + width <= 100.5, `left+width ${left + width} within bounds`);
    }
  });

  test('the SVG branch-graph mount and JSON payload are gone', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.doesNotMatch(seg, /id="branch-graph"/);
    assert.doesNotMatch(seg, /branch-graph-data/);
  });

  test('recent commits still render inline', () => {
    const seg = extractSection(renderProject(baseVm({
      branchGraph,
      recentCommits: [
        { sha: 'a2c6cad1000000', subject: 'fix: nodes grow by radius', repo: 'loschenbd/archi', authoredAt: '2026-06-09T00:00:00Z' },
      ],
    })), 'active-work');
    assert.match(seg, /a2c6cad1/);
    assert.match(seg, /fix: nodes grow by radius/);
  });

  test('empty state: no branches AND no commits → gentle placeholder', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph: null, recentCommits: [] })), 'active-work');
    assert.match(seg, /No branches touched archi in this window/);
  });
```

The existing test-file `branchGraph` fixture has `windowStart: '2026-06-01'`, `windowEnd: '2026-06-30'`, and three branches (onboarding-wizard = merged, coherence-pass = stale, worktree-local-semantic-search = open) with `firstEventAt`/`lastEventAt` inside the window — it already exercises all three statuses and the segment math.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: FAIL — `bwork-*` markup absent.

- [ ] **Step 3: Rewrite `renderActiveWork` and add `renderBranchTable`**

Replace `renderActiveWork` and `renderBranchSummary` (and its helper `col`/`rowFor` remnant) with:

```ts
function renderActiveWork(vm: ProjectDetailVM): string {
  const bg = vm.branchGraph;
  const hasBranches = !!(bg && bg.branches && bg.branches.length > 0);
  const hasCommits = vm.recentCommits.length > 0;
  if (!hasBranches && !hasCommits) {
    return `
    <section class="card" data-section="active-work">
      <div class="label">Active work · last 30d</div>
      <div class="muted">No branches touched ${escapeHtml(vm.projectName)} in this window.</div>
    </section>`;
  }
  const totalBranchUsd = hasBranches ? bg!.totalUsd : 0;
  const table = hasBranches ? renderBranchTable(bg!) : '';
  const commits = hasCommits
    ? `<div class="commits-inline">
         <div class="label subheader">Recent commits</div>
         ${vm.recentCommits.map((c) => {
           const shaShort = c.sha.slice(0, 8);
           const url = c.repo ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
           const sha = url
             ? `<a class="sha" href="${escapeHtml(url)}" target="_blank" rel="noopener">${shaShort}</a>`
             : `<span class="sha">${shaShort}</span>`;
           return `<div class="commit-row">${sha} <span class="subject">${escapeHtml(c.subject)}</span></div>`;
         }).join('')}
       </div>`
    : '';
  return `
    <section class="card" data-section="active-work">
      <div class="label">Active work · last ${bg?.days ?? 30}d <span class="amt-tag">$${totalBranchUsd.toFixed(0)}</span></div>
      ${table}
      ${commits}
    </section>`;
}

function renderBranchTable(bg: NonNullable<ProjectDetailVM['branchGraph']>): string {
  const branches = (bg.branches ?? []).slice().sort((a, b) => b.totalUsd - a.totalUsd);
  const startMs = new Date(bg.windowStart).getTime();
  const endMs = new Date(bg.windowEnd).getTime();
  const span = Math.max(1, endMs - startMs);
  const leader = branches[0]?.totalUsd || 1;
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

  const row = (b: BranchLifecycle): string => {
    const firstMs = new Date(b.firstEventAt).getTime();
    const lastMs = new Date(b.mergedAt || b.lastEventAt).getTime();
    const left = clamp01((firstMs - startMs) / span) * 100;
    const rawWidth = clamp01((lastMs - firstMs) / span) * 100;
    const width = Math.min(Math.max(rawWidth, 4), 100 - left);
    const barPct = Math.max((b.totalUsd / leader) * 100, 1.2);
    const tick = b.status === 'merged' ? '<span class="bwork-tick">✓</span>' : '';
    return `
      <div class="bwork-row bwork-${b.status}">
        <span class="bwork-dot"></span>
        <span class="bwork-name">${escapeHtml(b.branch)}${tick}</span>
        <span class="bwork-track"><span class="bwork-seg" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span></span>
        <span class="bwork-spend"><span class="bwork-bar"><span class="bwork-fill" style="width:${barPct.toFixed(1)}%"></span></span><span class="bwork-amt">$${b.totalUsd.toFixed(0)}</span></span>
        <span class="bwork-sess">${b.sessionCount}</span>
      </div>`;
  };

  const HEAD = 10;
  const headRows = branches.slice(0, HEAD).map(row).join('');
  const tail = branches.slice(HEAD);
  let tailBlock = '';
  if (tail.length > 0) {
    const tailSum = tail.reduce((s, b) => s + b.totalUsd, 0);
    tailBlock = `
      <button class="tail-toggle" type="button" data-tail-toggle aria-expanded="false">
        <span class="tail-toggle-label">+ ${tail.length} more · $${tailSum.toFixed(0)} total</span><span class="tail-toggle-caret">›</span>
      </button>
      <div class="tail-body" hidden>${tail.map(row).join('')}</div>`;
  }
  return `
    <div class="bwork">
      <div class="bwork-head">
        <span></span><span></span>
        <span class="bwork-axis"><span>${formatMonDay(bg.windowStart)}</span><span>${formatMonDay(bg.windowEnd)}</span></span>
        <span class="bwork-hlabel">spend</span>
        <span class="bwork-hlabel">sess</span>
      </div>
      ${headRows}
      ${tailBlock}
    </div>`;
}
```

Then: remove the now-unused `jsonForScriptTag` import from the top of `project.ts` **iff** `grep -n jsonForScriptTag src/dashboard/render/project.ts` shows no remaining use. (`escapeHtml` and `BranchLifecycle` stay.) Also drop the `chart-card` class from the section (now `class="card"`).

- [ ] **Step 4: Add `.bwork-*` CSS; remove dead `.bsum-*` / `.branch-graph*` rules**

Add (near the old active-work CSS block):

```css
/* --- project detail: active work branch table --- */
.project-page .bwork { display: flex; flex-direction: column; gap: 2px; margin-top: 10px; }
.project-page .bwork-head,
.project-page .bwork-row {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) 120px 150px 40px;
  gap: 10px;
  align-items: center;
}
.project-page .bwork-head {
  padding: 0 6px 6px;
  border-bottom: 1px solid var(--color-hairline);
  margin-bottom: 2px;
}
.project-page .bwork-axis { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--color-ink-subtle); font-variant-numeric: tabular-nums; }
.project-page .bwork-hlabel { font-family: var(--font-serif); font-size: 10px; color: var(--color-ink-subtle); text-align: right; }
.project-page .bwork-row { padding: 8px 6px; border-radius: 8px; }
.project-page .bwork-row:hover { background: var(--color-hover-bg); }
.project-page .bwork-stale { opacity: 0.55; }
.project-page .bwork-dot { width: 9px; height: 9px; border-radius: 50%; justify-self: center; }
.project-page .bwork-open .bwork-dot { background: var(--color-accent); }
.project-page .bwork-merged .bwork-dot { background: var(--color-accent); box-shadow: 0 0 0 2px var(--color-card-bg), 0 0 0 3px var(--color-accent); }
.project-page .bwork-stale .bwork-dot { background: transparent; border: 1.5px solid var(--color-ink-subtle); }
.project-page .bwork-name { font-family: var(--font-mono); font-size: 12px; color: var(--color-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-page .bwork-stale .bwork-name { color: var(--color-ink-muted); }
.project-page .bwork-tick { color: var(--color-accent); font-weight: 700; margin-left: 4px; }
.project-page .bwork-track { position: relative; height: 14px; background: var(--color-fill-track); border-radius: 3px; }
.project-page .bwork-seg { position: absolute; top: 3px; height: 8px; border-radius: 4px; background: var(--color-accent); }
.project-page .bwork-stale .bwork-seg { background: repeating-linear-gradient(90deg, var(--color-ink-subtle) 0 3px, transparent 3px 6px); }
.project-page .bwork-spend { display: flex; align-items: center; gap: 8px; }
.project-page .bwork-bar { flex: 1; height: 8px; background: var(--color-fill-track); border-radius: 4px; overflow: hidden; }
.project-page .bwork-fill { display: block; height: 100%; background: var(--color-accent); border-radius: 4px; }
.project-page .bwork-stale .bwork-fill { background: var(--color-ink-subtle); }
.project-page .bwork-amt { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--color-ink); min-width: 40px; text-align: right; }
.project-page .bwork-sess { font-size: 11px; color: var(--color-ink-subtle); font-variant-numeric: tabular-nums; text-align: right; }
```

Then `grep -nE '\.bsum-|\.branch-graph' src/dashboard/static/dashboard.css` and delete every matched rule block (the old bucket-summary styles and the SVG-graph styles — `.branch-graph`, `.branch-graph-axis-label`, `.branch-graph-trunk`, `.branch-graph-arc`, `.branch-graph-marker`, `.branch-graph-label`, `.branch-graph-grid`). Leave `.commits-inline` / `.amt-tag` intact.

- [ ] **Step 5: Run tests**

Run: `npx tsx --test tests/project-render.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/render/project.ts src/dashboard/static/dashboard.css tests/project-render.test.ts
git commit -m "feat(project): active work — ranked branch table replaces the railroad graph"
```

---

### Task 3: Remove the dead branch-graph JS; visual gate

**Files:**
- Modify: `src/dashboard/static/dashboard.js` — delete `renderBranchGraph` and its invocation.

- [ ] **Step 1: Delete `renderBranchGraph` and its call**

In `dashboard.js`: delete the entire `function renderBranchGraph() { … }` (locate by content — it starts at `function renderBranchGraph()` and ends just before `function renderBurnPathsSubBars()`), and delete the `renderBranchGraph();` invocation line in the `DOMContentLoaded` block. **Do NOT** touch `niceTimeTicks`, `fmtTickDate`, `truncate` (used by `renderTrailElevation`) — confirm with `grep -n 'niceTimeTicks\|fmtTickDate\|truncate' src/dashboard/static/dashboard.js` that each still has a non-`renderBranchGraph` caller before finishing.

- [ ] **Step 2: Confirm no dangling references**

Run: `grep -n 'renderBranchGraph\|branch-graph' src/dashboard/static/dashboard.js` — expect no matches. `grep -rn 'branch-graph' src/dashboard` — expect no matches (mount already removed in Task 2).

- [ ] **Step 3: Full suite + typecheck**

Run: `npm test` (expect 462 pass) and `npx tsc --noEmit` (expect clean).

- [ ] **Step 4: Visual gate (both themes, both widths)**

```bash
npx tsx src/index.ts dashboard --port 4934 &
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL="http://127.0.0.1:4934/project/repo%3Aloschenbd%2Ftokentrail"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1400,2600 --virtual-time-budget=9000 --screenshot=/tmp/aw-desktop.png "$URL"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=430,4200 --virtual-time-budget=9000 --screenshot=/tmp/aw-mobile.png "$URL"
```

Read both. Verify: one row per branch sorted by spend; spend bars scaled to the leader; activity segments positioned within the window (recent work right, stale work left/dashed); merged rows show ✓; stale rows ghosted; the tail folds and expands (in a real browser); no railroad graph; no horizontal overflow at 430px; dark theme correct (force via Settings or `data-theme="dark"`). Kill the dev server after.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/static/dashboard.js
git commit -m "chore(dashboard): remove dead branch-graph SVG renderer"
```

---

## Self-Review

- **Spec coverage:** railroad removed (T2 markup + T3 JS) ✓; spend→bar (T2) ✓; activity-window track for lifecycle (T2, server-computed, clamped 0–100%) ✓; status dot-hue + ghosting, merged ✓ (T2) ✓; topology demoted to ✓ marker (T2) ✓; sort by spend desc, stale ghosted in place (T2) ✓; fold via shared toggle (T1 + T2) ✓; recent commits kept (T2) ✓.
- **Placeholder scan:** none — full code and concrete values (HEAD=10, min seg width 4%, min bar 1.2%, grid columns) throughout.
- **Type consistency:** `renderBranchTable(bg: NonNullable<ProjectDetailVM['branchGraph']>)`; `row(b: BranchLifecycle)`; `BranchLifecycle` already imported; shared toggle contract (`data-tail-toggle` / `.tail-toggle-label` / `.tail-toggle-caret` / `.tail-body`) identical across Features (T1) and branch table (T2).
- **Segment bounds:** `width = min(max(raw, 4), 100 − left)` guarantees `left + width ≤ 100`, satisfying the range test.
- **Post-merge:** dashboard-only release; re-capture `feature-detail` marketing screenshots (this panel is on that page). Follow tokentrail-release-flow.
