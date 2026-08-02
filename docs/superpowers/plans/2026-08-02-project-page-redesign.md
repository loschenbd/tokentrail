# Project Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `/project/:key` — promote the hero delta, give features magnitude bars + a folded tail, de-wall the git-graph summary, trim the velocity chart, and move to an asymmetric 2-column desktop layout — without touching data, queries, or routes.

**Architecture:** Pure presentation. All markup changes live in `src/dashboard/render/project.ts` and `src/dashboard/render/velocity.ts`; styling in `src/dashboard/static/dashboard.css`; one small JS handler in `src/dashboard/static/dashboard.js` for the features tail toggle. The view-model (`src/dashboard/data/project.ts`) is unchanged — every field the new markup needs already exists on `ProjectDetailVM`.

**Tech Stack:** TypeScript template-string renderers, hand-written CSS driven by `tokens.ts` custom properties, vanilla DOM JS, `node:test` + `assert/strict`.

## Global Constraints

- **No data-layer change.** Do not edit `src/dashboard/data/project.ts`, queries, attribution, or routes. Consume existing `ProjectDetailVM` fields only.
- **Design system is authoritative.** Every color is a `var(--color-*)` from `tokens.ts`; every font is `var(--font-serif|sans|mono)`. No raw hex in CSS or markup. Both light and dark themes must read correctly (tokens handle this automatically when you use the vars).
- **Naming voice = Spectral, mixed-case.** Section/stat labels use `var(--font-serif)`, `letter-spacing:0`, no `text-transform`.
- **Semantic delta color:** down = `var(--color-warm-deep)`, up = `var(--color-accent)`. These are separate from the project accent hue.
- **Progressive enhancement:** the features tail must be readable with JS disabled (render it visible, not `hidden`, is unacceptable — instead the toggle degrades to showing the tail; see Task 3).
- **Keep the real branch-divergence graph.** Do not replace `#branch-graph` / its `dashboard.js` renderer with a schematic. Only `renderBranchSummary`'s markup changes.
- **Feature bars:** width basis = share of the leader feature; the numeric label basis = share of project total. These denominators differ intentionally.
- Run `npm test` after every task; each task keeps the suite green.

---

## File Structure

- `src/dashboard/render/project.ts` — Modify: `renderHero`, `renderFeatures`, `renderBranchSummary`, `renderProject`. Add: `renderDeltaCell`. (`renderVelocity`, `renderActiveWork`, `renderWorthReconciling` markup unchanged except wrapper.)
- `src/dashboard/render/velocity.ts` — Modify: `renderVelocityChart` (trim leading zero days, add y-gridlines).
- `src/dashboard/static/dashboard.css` — Replace `.pfeat-*` and `.bsum-*` blocks; add `.pp-*` (statstrip, layout) blocks; add `.pfeat-track/.pfeat-fill/.pfeat-tail*` blocks.
- `src/dashboard/static/dashboard.js` — Add features-tail toggle initializer.
- `tests/project-render.test.ts` — Update assertions per task; add folded-tail test.

---

### Task 1: Hero strip

Promote the delta to a sized, color-coded stat and lay the metadata as a horizontal strip.

**Files:**
- Modify: `src/dashboard/render/project.ts:23-38` (`renderHero`), add `renderDeltaCell` (replaces the role of `renderDeltaLine`; keep `renderDeltaLine` deletion for this task since nothing else calls it — verify with a grep)
- Modify: `src/dashboard/static/dashboard.css` (add `.pp-statstrip` / `.pp-stat*` after line 160)
- Test: `tests/project-render.test.ts:58-77`

**Interfaces:**
- Consumes: `vm.projectKey`, `vm.projectName`, `vm.totalUsd`, `vm.priorUsd`, `vm.deltaPct`, `vm.sessionCount`, `vm.featureCount`, `vm.dailySeries.length`, `vm.features[0]`.
- Produces: hero `<section data-section="hero">` containing `.pp-statstrip`.

- [ ] **Step 1: Update the hero tests to the new markup**

Replace the two affected tests in `tests/project-render.test.ts`:

```ts
  test('hero shows repo label, name, total, delta, session/feature counts, most-active feature', () => {
    const html = renderProject(baseVm());
    assert.match(html, /repo:loschenbd\/archi/);
    assert.match(html, />archi</);
    assert.match(html, /\$2,?203/);
    assert.match(html, /▲649%/);
    assert.match(html, /vs prior 30d/);
    assert.match(html, />17</);            // sessions value cell
    assert.match(html, /Sessions/);
    assert.match(html, />18</);            // features value cell
    assert.match(html, /Local RAG \+ chatbot/);
  });

  test('hero shows "new project" delta cell when priorUsd is 0', () => {
    const html = renderProject(baseVm({ priorUsd: 0, deltaPct: 100 }));
    assert.match(html, /new project/);
  });
```

- [ ] **Step 2: Run the hero tests to verify they fail**

Run: `npx tsx --test tests/project-render.test.ts` (or `npm test`)
Expected: FAIL — new markup not present yet.

- [ ] **Step 3: Rewrite `renderHero` and add `renderDeltaCell`**

Replace `renderHero` (lines 23-38) and `renderDeltaLine` (lines 46-55) with:

```ts
function renderHero(vm: ProjectDetailVM): string {
  const label = renderRepoLabel(vm.projectKey);
  const win = vm.dailySeries.length;
  const mostActive = vm.features.length > 0
    ? `<div class="pp-stat pp-stat-active"><div class="pp-stat-k">Most active</div><div class="pp-stat-v"><a href="/feature/${encodeURIComponent(vm.features[0]!.featureKey)}">${escapeHtml(vm.features[0]!.featureName || vm.features[0]!.featureKey)}</a> · $${vm.features[0]!.totalUsd.toFixed(0)}</div></div>`
    : '';
  return `
    <section class="card project-hero" data-section="hero">
      <div class="label">${label}</div>
      <div class="hero">${escapeHtml(vm.projectName)}</div>
      <div class="pp-statstrip">
        <div class="pp-stat"><div class="pp-stat-k">Total · ${win}d</div><div class="pp-stat-v pp-stat-total">$${formatUsdCommas(vm.totalUsd)}</div></div>
        ${renderDeltaCell(vm)}
        <div class="pp-stat"><div class="pp-stat-k">Sessions</div><div class="pp-stat-v">${vm.sessionCount}</div></div>
        <div class="pp-stat"><div class="pp-stat-k">Features</div><div class="pp-stat-v">${vm.featureCount}</div></div>
        ${mostActive}
      </div>
    </section>`;
}

function renderDeltaCell(vm: ProjectDetailVM): string {
  const win = vm.dailySeries.length;
  if (vm.priorUsd === 0 && vm.totalUsd > 0) {
    return `<div class="pp-stat pp-stat-delta"><div class="pp-stat-k">vs prior ${win}d</div><div class="pp-stat-v up">new project</div></div>`;
  }
  const arrow = vm.deltaPct >= 0 ? '▲' : '▼';
  const cls = vm.deltaPct >= 0 ? 'up' : 'down';
  const diff = vm.totalUsd - vm.priorUsd;
  const diffStr = `${diff >= 0 ? '+' : '−'}$${formatUsdCommas(Math.abs(diff))}`;
  return `<div class="pp-stat pp-stat-delta"><div class="pp-stat-k">vs prior ${win}d</div><div class="pp-stat-v ${cls}">${arrow}${Math.abs(vm.deltaPct)}% <span class="pp-delta-diff">${diffStr}</span></div></div>`;
}
```

Note: `−` in `diffStr` is U+2212 (matches the mockup). `renderDeltaLine` is removed — confirm no other caller with `grep -n renderDeltaLine src`.

- [ ] **Step 4: Add hero-strip CSS**

Append after line 160 in `dashboard.css`:

```css
/* --- project detail: hero strip --- */
.project-page .project-hero .hero { margin-bottom: var(--space-m); }
.project-page .pp-statstrip {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  border-top: 1px solid var(--color-border);
}
.project-page .pp-stat {
  padding: var(--space-m) var(--space-l) var(--space-m) 0;
  margin-right: var(--space-l);
  border-right: 1px solid var(--color-border);
}
.project-page .pp-stat:last-child { border-right: 0; margin-right: 0; }
.project-page .pp-stat-active { border-right: 0; }
.project-page .pp-stat-k {
  font-family: var(--font-serif);
  font-size: var(--size-small);
  color: var(--color-ink-subtle);
  margin-bottom: 3px;
}
.project-page .pp-stat-v {
  font-family: var(--font-serif);
  font-size: 22px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.project-page .pp-stat-v.up { color: var(--color-accent); }
.project-page .pp-stat-v.down { color: var(--color-warm-deep); }
.project-page .pp-delta-diff {
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--color-ink-muted);
}
.project-page .pp-stat-active .pp-stat-v {
  font-family: var(--font-sans);
  font-size: 15px;
}
.project-page .pp-stat-active .pp-stat-v a {
  color: var(--color-accent);
  text-decoration: none;
  border-bottom: 1px solid var(--color-accent);
}
```

- [ ] **Step 5: Run the hero tests to verify they pass**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: PASS (hero tests green; note the section-order test still passes — order unchanged this task).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/render/project.ts src/dashboard/static/dashboard.css tests/project-render.test.ts
git commit -m "feat(project): hero strip — promote delta, horizontal stat cells"
```

---

### Task 2: Velocity — trim leading zeros + y-gridlines

**Files:**
- Modify: `src/dashboard/render/velocity.ts:3-50` (`renderVelocityChart`)
- Test: `tests/project-render.test.ts:89-100` (existing svg test still asserts `<svg>`/`<rect>` — keep passing; add a gridline assertion)

**Interfaces:**
- Consumes: `opts.days` (array of `{date,total}`), `opts.peakDate`, `opts.color`.
- Produces: SVG with leading zero-days trimmed and 3 horizontal `<line>` gridlines + `$`-labels.

- [ ] **Step 1: Add a gridline assertion to the existing svg test**

In `tests/project-render.test.ts`, extend the `velocity section embeds an svg bar chart` test:

```ts
  test('velocity section embeds an svg bar chart with y-gridlines', () => {
    const vm = baseVm({
      dailySeries: [
        { date: '2026-06-14', total: 0, commits: 0, prs: 0 },
        { date: '2026-06-15', total: 412, commits: 0, prs: 0 },
        { date: '2026-06-16', total: 50, commits: 0, prs: 0 },
      ],
    });
    const seg = extractSection(renderProject(vm), 'velocity');
    assert.match(seg, /<svg\b[^>]*viewBox/);
    assert.match(seg, /<rect\b/);
    assert.match(seg, /stroke-dasharray/);   // gridlines present
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: FAIL on `stroke-dasharray`.

- [ ] **Step 3: Trim leading zeros + draw gridlines in `renderVelocityChart`**

In `velocity.ts`, immediately after the `if (opts.days.length === 0)` guard (line 21), insert the trim, then base all subsequent geometry on `days` instead of `opts.days`:

```ts
  // Trim leading zero-spend days so the chart doesn't open with a dead gap.
  let firstSpend = 0;
  while (firstSpend < opts.days.length - 1 && opts.days[firstSpend]!.total <= 0) firstSpend++;
  const days = opts.days.slice(firstSpend);
```

Then replace every remaining `opts.days` reference in the function body with `days` (the `max`, `slot`, the bar loop bound `i < days.length`, `days[i]`, and the label section `days.length` / `days[i]`). Leave `opts.color` / `opts.peakDate` / `opts.width` / `opts.height` as-is.

Add gridlines just before the `return`, and include them ahead of the bars so bars paint on top:

```ts
  const gridEls: string[] = [];
  for (const lvl of [max, (max * 2) / 3, max / 3]) {
    const gy = padTop + (drawH - (lvl / max) * drawH);
    gridEls.push(`<line x1="${padLeft}" x2="${(w - padRight).toFixed(1)}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" style="stroke:var(--color-chart-grid)" stroke-dasharray="2 3" />`);
    gridEls.push(`<text x="${padLeft}" y="${(gy - 2).toFixed(1)}" font-size="9" style="fill:var(--color-chart-axis)" text-anchor="start">$${Math.round(lvl)}</text>`);
  }

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${gridEls.join('')}${bars.join('')}${labels.join('')}</svg>`;
```

- [ ] **Step 4: Run velocity tests to verify pass**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: PASS (svg + gridline + existing peak/week tests all green; the peak-day series `[0,412,50]` trims to `[412,50]`, peak `2026-06-15` still renders).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/render/velocity.ts tests/project-render.test.ts
git commit -m "feat(project): velocity — trim leading dead days, add y-gridlines"
```

---

### Task 3: Features — magnitude bars + folded tail

**Files:**
- Modify: `src/dashboard/render/project.ts:215-250` (`renderFeatures`)
- Modify: `src/dashboard/static/dashboard.css:729-770` (replace `.pfeat-*` block)
- Modify: `src/dashboard/static/dashboard.js` (add tail-toggle initializer — place near other DOMContentLoaded/init code)
- Test: `tests/project-render.test.ts:126-172`

**Interfaces:**
- Consumes: `vm.features[]` (`totalUsd`, `featureKey`, `featureName`, `sessionCount`, `lastActive`), `vm.totalUsd`, `color` (via `shadeForFeature`).
- Produces: `.pfeat-row` rows with `.pfeat-track`/`.pfeat-fill`; a `[data-pfeat-tail]` toggle + `.pfeat-tail` block. No per-row `<svg>`.

- [ ] **Step 1: Replace the sparkline-per-row test and add a folded-tail test**

In `tests/project-render.test.ts`, replace the `sparkline svg is embedded per row` test with:

```ts
  test('share bar embedded per row, no per-row sparkline svg', () => {
    const seg = extractSection(renderProject(fullVm()), 'features');
    assert.equal((seg.match(/pfeat-fill/g) ?? []).length, 2);
    assert.doesNotMatch(seg, /<svg\b/);
  });

  test('long tail folds behind a toggle naming count + summed dollars', () => {
    const many = [
      { featureKey: 'a', featureName: 'Alpha', totalUsd: 262, sessionCount: 2, lastActive: '2026-06-27', daily: [] },
      { featureKey: 'b', featureName: 'Bravo', totalUsd: 149, sessionCount: 3, lastActive: '2026-06-23', daily: [] },
      { featureKey: 'c', featureName: 'Charlie', totalUsd: 129, sessionCount: 1, lastActive: '2026-06-25', daily: [] },
      { featureKey: 'd', featureName: 'Delta', totalUsd: 80, sessionCount: 1, lastActive: '2026-06-22', daily: [] },
      { featureKey: 'e', featureName: 'Echo', totalUsd: 42, sessionCount: 1, lastActive: '2026-06-21', daily: [] },
      { featureKey: 'f', featureName: 'Foxtrot', totalUsd: 4, sessionCount: 1, lastActive: '2026-06-20', daily: [] },
      { featureKey: 'g', featureName: 'Golf', totalUsd: 3, sessionCount: 1, lastActive: '2026-06-19', daily: [] },
      { featureKey: 'h', featureName: 'Hotel', totalUsd: 1, sessionCount: 1, lastActive: '2026-06-18', daily: [] },
    ];
    const seg = extractSection(renderProject(baseVm({ totalUsd: 670, features: many })), 'features');
    // 5 features >= $10 stay visible; 3 (<$10) fold.
    assert.match(seg, /data-pfeat-tail/);
    assert.match(seg, /\+ 3 more under \$10 · \$8 total/);
    assert.match(seg, /class="pfeat-tail" hidden/);
    assert.match(seg, /Foxtrot/);   // tail row still in DOM (just hidden)
  });
```

Keep the existing `each row shows rank, name, sessions, lastActive, amount, share` test — it still holds ($765/77%, $235/24%).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: FAIL — `pfeat-fill` / `data-pfeat-tail` not present.

- [ ] **Step 3: Rewrite `renderFeatures`**

Replace `renderFeatures` (lines 215-250) with:

```ts
function renderFeatures(vm: ProjectDetailVM, color: string): string {
  if (vm.features.length === 0) {
    return `
    <section class="card" data-section="features">
      <div class="label">Features</div>
      <div class="muted">No features in window.</div>
    </section>`;
  }
  const denom = vm.totalUsd > 0 ? vm.totalUsd : 1;
  const leader = vm.features[0]!.totalUsd || 1;
  const THRESHOLD = 10;

  // Fold: rows >= $10 stay expanded; if that leaves < 5 visible, fall back to
  // the top 8 so the block never collapses to almost nothing.
  let visibleCount = vm.features.filter((f) => f.totalUsd >= THRESHOLD).length;
  if (visibleCount < 5) visibleCount = Math.min(8, vm.features.length);
  const head = vm.features.slice(0, visibleCount);
  const tail = vm.features.slice(visibleCount);

  const row = (f: ProjectDetailVM['features'][number], i: number): string => {
    const share = Math.round((f.totalUsd / denom) * 100);
    const barPct = Math.max((f.totalUsd / leader) * 100, 1.5);
    const shade = shadeForFeature(color, f.featureKey);
    const rawName = f.featureName || f.featureKey;
    const displayName = rawName.length > 40 ? rawName.slice(0, 39) + '…' : rawName;
    return `
      <a class="pfeat-row" href="/feature/${encodeURIComponent(f.featureKey)}" title="${escapeHtml(rawName)}">
        <span class="pfeat-rank">${i + 1}</span>
        <span class="pfeat-name">${escapeHtml(displayName)}</span>
        <span class="pfeat-meta"><span class="pfeat-sess">${f.sessionCount} sess</span> · <span class="pfeat-last">last ${formatMonDay(f.lastActive)}</span></span>
        <span class="pfeat-barline">
          <span class="pfeat-track"><span class="pfeat-fill" style="width:${barPct.toFixed(1)}%;background:${escapeHtml(shade)}"></span></span>
          <span class="pfeat-amt"><b>$${formatUsdCommas(f.totalUsd)}</b> · ${share}%</span>
        </span>
      </a>`;
  };

  const headRows = head.map((f, i) => row(f, i)).join('');
  let tailBlock = '';
  if (tail.length > 0) {
    const tailSum = tail.reduce((s, f) => s + f.totalUsd, 0);
    const allBelow = tail.every((f) => f.totalUsd < THRESHOLD);
    const label = allBelow
      ? `+ ${tail.length} more under $${THRESHOLD} · $${formatUsdCommas(tailSum)} total`
      : `+ ${tail.length} more · $${formatUsdCommas(tailSum)} total`;
    const tailRows = tail.map((f, i) => row(f, visibleCount + i)).join('');
    tailBlock = `
      <button class="pfeat-tail-toggle" type="button" data-pfeat-tail aria-expanded="false">
        <span class="pfeat-tail-label">${label}</span><span class="pfeat-tail-caret">›</span>
      </button>
      <div class="pfeat-tail" hidden>${tailRows}</div>`;
  }

  return `
    <section class="card" data-section="features">
      <div class="label">Features · ${vm.features.length}</div>
      <div class="pfeat-list">${headRows}</div>
      ${tailBlock}
    </section>`;
}
```

Note: `renderSparkline` import stays — still used by `renderUnattSubblock`. Only the per-feature call is gone.

- [ ] **Step 4: Replace the `.pfeat-*` CSS block**

Replace lines 729-770 in `dashboard.css` with:

```css
/* --- project detail: features list --- */
.project-page .pfeat-list { display: flex; flex-direction: column; gap: 2px; }
.project-page .pfeat-row {
  display: grid;
  grid-template-columns: 22px 1fr;
  grid-template-areas:
    "rank name"
    ".    meta"
    ".    bar";
  gap: 2px 8px;
  padding: 9px 6px;
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
}
.project-page .pfeat-row:hover { background: var(--color-hover-bg); }
.project-page .pfeat-rank {
  grid-area: rank;
  color: var(--color-ink-subtle);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  text-align: right;
  padding-top: 2px;
}
.project-page .pfeat-name { grid-area: name; font-weight: 600; color: var(--color-ink); font-size: 13.5px; }
.project-page .pfeat-meta { grid-area: meta; color: var(--color-ink-subtle); font-size: 11px; }
.project-page .pfeat-barline {
  grid-area: bar;
  display: flex;
  align-items: center;
  gap: var(--space-s);
  margin-top: 4px;
}
.project-page .pfeat-track {
  flex: 1;
  height: 7px;
  border-radius: 4px;
  background: var(--color-fill-track);
  overflow: hidden;
}
.project-page .pfeat-fill { display: block; height: 100%; border-radius: 4px; }
.project-page .pfeat-amt {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--color-ink-muted);
  white-space: nowrap;
  min-width: 74px;
  text-align: right;
}
.project-page .pfeat-amt b { color: var(--color-ink); font-weight: 600; }
.project-page .pfeat-tail-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: none;
  border: 0;
  border-top: 1px solid var(--color-hairline);
  margin-top: 6px;
  padding: 12px 6px 2px;
  color: var(--color-ink-muted);
  font-family: var(--font-sans);
  font-size: 12.5px;
  cursor: pointer;
}
.project-page .pfeat-tail-toggle:hover { color: var(--color-ink); }
.project-page .pfeat-tail[hidden] { display: none; }
```

- [ ] **Step 5: Add the tail-toggle JS**

Append to `src/dashboard/static/dashboard.js` (top-level, alongside the other init code that runs on load — do NOT nest inside `renderBranchGraph`):

```js
  // Features long-tail expand/collapse on the project page.
  document.querySelectorAll('[data-pfeat-tail]').forEach(function (btn) {
    var collapsedLabel = btn.querySelector('.pfeat-tail-label').textContent;
    btn.addEventListener('click', function () {
      var tail = btn.nextElementSibling;
      if (!tail) return;
      var willOpen = tail.hasAttribute('hidden');
      tail.toggleAttribute('hidden');
      btn.setAttribute('aria-expanded', String(willOpen));
      btn.querySelector('.pfeat-tail-label').textContent = willOpen ? 'Collapse long tail' : collapsedLabel;
      btn.querySelector('.pfeat-tail-caret').textContent = willOpen ? '⌄' : '›';
    });
  });
```

Verify placement: it must run at initial load like the sibling initializers (e.g. the same scope that calls `renderBranchGraph()`). Grep for `renderBranchGraph()` invocation and add this beside it.

- [ ] **Step 6: Run features tests to verify pass**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/render/project.ts src/dashboard/static/dashboard.css src/dashboard/static/dashboard.js tests/project-render.test.ts
git commit -m "feat(project): features — magnitude bars + folded long tail, drop per-row sparkline"
```

---

### Task 4: Active work — de-wall the branch summary

Turn the slash-joined Open/Merged/Stale runs into aligned bucket columns with right-aligned dollars. Leave the SVG graph + its JS untouched.

**Files:**
- Modify: `src/dashboard/render/project.ts:131-148` (`renderBranchSummary`)
- Modify: `src/dashboard/static/dashboard.css:779-797` (replace `.branch-summary` / `.bsum-*`)
- Test: `tests/project-render.test.ts:189-197`

**Interfaces:**
- Consumes: `bg.branches[]` (`branch`, `status`, `totalUsd`).
- Produces: `.branch-summary` grid of `.bsum-col` (Open/Merged/Stale), each `.bsum-item` = branch name + right-aligned `$`.

- [ ] **Step 1: Update the branch-summary test to the new markup**

Replace the `branch summary shows open / merged / stale counts with names` test:

```ts
  test('branch summary shows open / merged / stale buckets with names + aligned $', () => {
    const seg = extractSection(renderProject(baseVm({ branchGraph })), 'active-work');
    assert.match(seg, /Open/);
    assert.match(seg, /worktree-local-semantic-search/);
    assert.match(seg, /Merged/);
    assert.match(seg, /onboarding-wizard/);
    assert.match(seg, /Stale/);
    assert.match(seg, /coherence-pass/);
    assert.match(seg, /bsum-usd/);   // dollar cell present
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: FAIL on `bsum-usd`.

- [ ] **Step 3: Rewrite `renderBranchSummary`**

Replace lines 131-148 with:

```ts
function renderBranchSummary(bg: NonNullable<ProjectDetailVM['branchGraph']>): string {
  const branches: BranchLifecycle[] = bg.branches ?? [];
  const bucket = (status: BranchLifecycle['status']) => branches.filter((b) => b.status === status);
  const col = (label: string, status: BranchLifecycle['status']) => {
    const items = bucket(status);
    if (items.length === 0) return '';
    const rows = items.map((b) => {
      const zero = b.totalUsd > 0 ? '' : ' zero';
      return `<div class="bsum-item"><span class="bsum-branch">${escapeHtml(b.branch)}</span><span class="bsum-usd${zero}">$${b.totalUsd.toFixed(0)}</span></div>`;
    }).join('');
    return `<div class="bsum-col"><div class="bsum-col-head">${label} <span class="bsum-count">${items.length}</span></div><div class="bsum-items">${rows}</div></div>`;
  };
  return `<div class="branch-summary">
    ${col('Open',   'open')}
    ${col('Merged', 'merged')}
    ${col('Stale',  'stale')}
  </div>`;
}
```

- [ ] **Step 4: Replace the `.bsum-*` CSS**

Replace lines 779-797 in `dashboard.css` with:

```css
.project-page .branch-summary {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-l);
}
.project-page .bsum-col-head {
  font-family: var(--font-serif);
  font-size: var(--size-small);
  color: var(--color-ink);
  margin-bottom: 6px;
}
.project-page .bsum-count { color: var(--color-ink-subtle); }
.project-page .bsum-items { display: flex; flex-direction: column; }
.project-page .bsum-item {
  display: flex;
  justify-content: space-between;
  gap: var(--space-s);
  padding: 4px 0;
  border-bottom: 1px solid var(--color-hairline);
  font-size: 12.5px;
}
.project-page .bsum-item:last-child { border-bottom: 0; }
.project-page .bsum-branch {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--color-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.project-page .bsum-usd {
  font-variant-numeric: tabular-nums;
  color: var(--color-ink);
  white-space: nowrap;
}
.project-page .bsum-usd.zero { color: var(--color-ink-subtle); }
```

- [ ] **Step 5: Run active-work tests to verify pass**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: PASS (branch-summary + graph-mount + commits + empty-state tests all green).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/render/project.ts src/dashboard/static/dashboard.css tests/project-render.test.ts
git commit -m "feat(project): active work — aligned branch buckets replace slash-walls"
```

---

### Task 5: 2-column layout + mobile reorder

Wrap the blocks in an asymmetric grid (velocity + active-work in the wide main column; worth-reconciling then features in the rail), flatten to one column with an explicit reading order on mobile.

**Files:**
- Modify: `src/dashboard/render/project.ts:8-21` (`renderProject`)
- Modify: `src/dashboard/static/dashboard.css` (add `.pp-page`/`.pp-layout`/`.pp-main`/`.pp-rail` near line 314; the old `.single-col` rule can stay for other pages)
- Test: `tests/project-render.test.ts:43-56` (section-order changes)

**Interfaces:**
- Consumes: the five block renderers.
- Produces: `.project-page.pp-page` → hero, then `.pp-layout` (`.pp-main`: velocity, active-work; `.pp-rail`: worth-reconciling, features).

- [ ] **Step 1: Update the section-order test to the new document order**

Replace the skeleton test:

```ts
  test('renders sections in order: hero, velocity, active-work, worth-reconciling, features', () => {
    const html = renderProject(baseVm({
      anomalies: [{ id: 1, kind: 'spike_day', date: '2026-06-15', featureKey: 'f', sessionId: null, amount: 100, reason: 'test', cause: null }],
    }));
    const order = ['hero', 'velocity', 'active-work', 'worth-reconciling', 'features'];
    let last = -1;
    for (const s of order) {
      const idx = html.indexOf(`data-section="${s}"`);
      assert.ok(idx > last, `section ${s} should appear in order (found idx=${idx}, last=${last})`);
      last = idx;
    }
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/project-render.test.ts`
Expected: FAIL — current order still puts features before active-work.

- [ ] **Step 3: Rewrite `renderProject`**

Replace lines 8-21 with:

```ts
export function renderProject(vm: ProjectDetailVM): string {
  // Canonical color from the VM — never re-resolve locally, or this page
  // could disagree with the overview/menubar when hue rotation kicks in.
  const color = vm.color;
  return `
<div class="project-page pp-page" data-project-key="${escapeHtml(vm.projectKey)}" data-project-color="${escapeHtml(color)}">
  ${renderHero(vm)}
  <div class="pp-layout">
    <div class="pp-main">
      ${renderVelocity(vm, color)}
      ${renderActiveWork(vm)}
    </div>
    <div class="pp-rail">
      ${renderWorthReconciling(vm)}
      ${renderFeatures(vm, color)}
    </div>
  </div>
</div>
  `;
}
```

- [ ] **Step 4: Add layout CSS**

Insert before line 314 (`.single-col { ... }`) in `dashboard.css`:

```css
/* --- project detail: page layout (asymmetric 2-col → 1-col) --- */
.pp-page { max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-l); }
.pp-layout { display: grid; grid-template-columns: 1.5fr 1fr; gap: var(--space-l); align-items: start; }
.pp-main, .pp-rail { display: flex; flex-direction: column; gap: var(--space-l); min-width: 0; }
@media (max-width: 900px) {
  .pp-layout { display: flex; flex-direction: column; gap: var(--space-l); }
  .pp-main, .pp-rail { display: contents; }
  .pp-page section[data-section="worth-reconciling"] { order: 1; }
  .pp-page section[data-section="velocity"] { order: 2; }
  .pp-page section[data-section="features"] { order: 3; }
  .pp-page section[data-section="active-work"] { order: 4; }
}
```

(`min-width: 0` on the columns is load-bearing — without it the branch-graph SVG and velocity chart can force the grid track wider than its share and break the 2-col split.)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all `project-render` tests plus the rest of the suite.

- [ ] **Step 6: Visual verification (both themes, both widths)**

Start a dev server against the real DB and capture screenshots:

```bash
npx tsx src/index.ts dashboard --port 4933 &
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL="http://127.0.0.1:4933/project/repo%3Aloschenbd%2Ftokentrail"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1400,3600 --virtual-time-budget=9000 --screenshot=/tmp/pp-desktop-light.png "$URL"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=430,5200 --virtual-time-budget=9000 --screenshot=/tmp/pp-mobile.png "$URL"
```

Verify: 2-col on desktop with balanced columns; delta cell red on the down case; features bars scale to the leader with the tail folded (and it expands on click in a real browser); branch buckets aligned; velocity has no dead left gap and shows gridlines. Check dark theme by appending `?` and toggling via Settings, or capture with `data-theme="dark"` forced. Fix any overflow (body must not scroll sideways at 390px).

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/render/project.ts src/dashboard/static/dashboard.css tests/project-render.test.ts
git commit -m "feat(project): asymmetric 2-col layout with mobile reading order"
```

---

## Self-Review

- **Spec coverage:** hero delta promotion (T1) ✓, velocity trim + gridlines (T2) ✓, features magnitude bars + folded tail (T3) ✓, active-work de-wall keeping the graph (T4) ✓, 2-col + mobile order + health-first rail (T5) ✓. Merged bucket preserved (T4). Unattributed both-states untouched (renderWorthReconciling not modified). Bar-basis-vs-label-basis honored (T3 `leader` vs `denom`).
- **Placeholder scan:** none — every step carries real code and concrete values ($10 threshold, top-8 fallback, 1180px, 1.5fr/1fr, 900px breakpoint).
- **Type consistency:** `renderDeltaCell`/`renderHero`/`renderFeatures`/`renderBranchSummary` all consume existing `ProjectDetailVM` fields; `row()` param typed as `ProjectDetailVM['features'][number]`; `BranchLifecycle` already imported at top of `project.ts`.
- **Post-merge:** dashboard-only release (no menubar bundle). Re-capture `feature-detail` marketing screenshots afterward (this is that page). Follow the tokentrail-release-flow.
