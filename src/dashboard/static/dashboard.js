(function () {
  // Resolve a themed CSS custom property to its current value, with a fallback
  // for the rare case the stylesheet hasn't applied yet. Read live (not cached)
  // so a theme toggle picks up the new value on re-render.
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // Is the dark theme currently effective? Mirrors the tokens' resolution:
  // explicit data-theme wins, else the OS preference.
  function isDark() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // Lift a project/feature hue for dark mode — raise HSL lightness (and a
  // touch of saturation) so the cream-tuned Midori hues become luminous on
  // the dark ground, matching how benjaminloschen.com lifts its Midori
  // palette in .dark. Non-#rrggbb inputs (stripes, rgba fallbacks) pass
  // through untouched. Used for BOTH the chart canvas (via renderTrend) and
  // the DOM swatches (via liftDomBands) so a band and its legend swatch match.
  function liftForDark(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return hex;
    let r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    const L = Math.min(0.74, l + 0.24);        // the ~+0.23 lift the site uses
    const S = Math.min(0.5, s * 1.05);
    const c = (1 - Math.abs(2 * L - 1)) * S;
    const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
    const mm = L - c / 2;
    let rr = 0, gg = 0, bb = 0; const hh = h * 6;
    if (hh < 1) { rr = c; gg = x; } else if (hh < 2) { rr = x; gg = c; }
    else if (hh < 3) { gg = c; bb = x; } else if (hh < 4) { gg = x; bb = c; }
    else if (hh < 5) { rr = x; bb = c; } else { rr = c; bb = x; }
    const to = (v) => Math.round((v + mm) * 255).toString(16).padStart(2, '0');
    return `#${to(rr)}${to(gg)}${to(bb)}`;
  }

  // Recolor every server/JS-rendered band swatch + burn-path sub-bar segment
  // for the current theme. Idempotent: the untouched base color is stashed in
  // data-base on first pass, so toggling back to light restores it exactly.
  // The chart tooltip is skipped — renderTrend already source-lifts those.
  function liftDomBands() {
    const dark = isDark();
    document.querySelectorAll('.swatch, .subbar-segment').forEach((el) => {
      if (el.closest('.chart-tooltip')) return;         // handled by renderTrend
      let base = el.getAttribute('data-base');
      if (base == null) {
        base = el.style.backgroundColor || '';
        el.setAttribute('data-base', base);
      }
      if (!base) return;                                // striped/empty segment
      el.style.backgroundColor = dark ? liftForDark(rgbToHex(base)) : base;
    });
    // Sub-bar hover tips read data-swatch — keep it in step with the segment.
    document.querySelectorAll('.subbar-segment[data-swatch]').forEach((el) => {
      let base = el.getAttribute('data-swatch-base');
      if (base == null) { base = el.getAttribute('data-swatch') || ''; el.setAttribute('data-swatch-base', base); }
      if (!base) return;
      el.setAttribute('data-swatch', dark ? liftForDark(rgbToHex(base)) : base);
    });
  }

  // Browsers report inline background-color back as "rgb(r, g, b)"; liftForDark
  // wants #rrggbb. Hex passes straight through.
  function rgbToHex(c) {
    if (!c) return c;
    if (c[0] === '#') return c;
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c);
    if (!m) return c;
    const to = (n) => Number(n).toString(16).padStart(2, '0');
    return `#${to(m[1])}${to(m[2])}${to(m[3])}`;
  }

  function renderTrend() {
    const node = document.getElementById('trend-chart');
    const dataNode = document.getElementById('trend-data');
    if (!node || !dataNode || typeof uPlot === 'undefined') return;
    // Re-entrant: a theme toggle calls renderTrend again to recolor axes/grid.
    // Tear down the prior uPlot (it owns appended canvas + a resize listener)
    // before rebuilding, or they'd stack.
    if (node.__uplot) { try { node.__uplot.destroy(); } catch (e) { /* noop */ } node.__uplot = null; }
    node.innerHTML = '';
    let payload;
    try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
    if (!payload || !Array.isArray(payload.days) || payload.days.length === 0) {
      node.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No data in window.</div>';
      return;
    }
    const days = payload.days;
    // Read project-first payload (Task 3). Ignore any legacy `features` key.
    const projects = payload.projects || [];
    if (projects.length === 0) {
      node.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No data in window.</div>';
      return;
    }

    // In dark mode, lift every band hue at the source — the canvas bands,
    // the tooltip swatches, and the feature shades (colorForFeatureInProject
    // reads projectColors) all flow from these two, so lifting here keeps the
    // whole chart consistent with the DOM swatches that liftDomBands lifts by
    // the same function. Re-runs on toggle (renderTrend is re-entrant).
    const dark = isDark();
    const lift = (c) => (dark ? liftForDark(c) : c);

    // Client-side twins of src/dashboard/lib/feature-colors.ts. Feature dots in
    // the tooltip are within-hue shades of the SERVER-RESOLVED project color
    // (payload.projectColors) so tooltip colors match the burn-paths sub-bar.
    const rawProjectColors = (payload && payload.projectColors) || {};
    const projectColors = {};
    for (const k in rawProjectColors) projectColors[k] = lift(rawProjectColors[k]);
    for (const p of projects) p.color = lift(p.color);
    function hashFeat(k) {
      let h = 0;
      for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0;
      h = Math.imul(h ^ (h >>> 15), 0x9E3779B1);
      return Math.abs(h >>> 0);
    }
    function hexToHsl(hex) {
      const h = hex.replace('#', '');
      const r = parseInt(h.slice(0, 2), 16) / 255;
      const g = parseInt(h.slice(2, 4), 16) / 255;
      const b = parseInt(h.slice(4, 6), 16) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const l = (mx + mn) / 2;
      let s = 0, hh = 0;
      if (mx !== mn) {
        const d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r) hh = (g - b) / d + (g < b ? 6 : 0);
        else if (mx === g) hh = (b - r) / d + 2;
        else hh = (r - g) / d + 4;
        hh *= 60;
      }
      return [hh, s * 100, l * 100];
    }
    function hslToHex(h, s, l) {
      const S = s / 100, L = l / 100;
      const c = (1 - Math.abs(2 * L - 1)) * S;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = L - c / 2;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; }
      else if (h < 120) { r = x; g = c; }
      else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; }
      else if (h < 300) { r = x; b = c; }
      else { r = c; b = x; }
      const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
      return `#${to(r)}${to(g)}${to(b)}`;
    }
    function colorForFeatureInProject(projectKey, featureKey) {
      const base = projectColors[projectKey] || cssVar('--color-swatch-fallback','#a8a29a');
      const [h, s, l] = hexToHsl(base);
      const shifts = [-18, -9, 0, 9, 18];
      const shift = shifts[hashFeat(featureKey) % shifts.length];
      const nl = Math.max(22, Math.min(78, l + shift));
      return hslToHex(h, s, nl);
    }

    // Stack order: bottom first (lowest stackPosition = largest project = bottom of stack).
    const stackOrder = projects.slice().sort((a, b) => a.stackPosition - b.stackPosition);
    const xs = days.map((d) => new Date(d.date + 'T00:00:00').getTime() / 1000);

    // Per-series cumulative ys (each series carries the running sum up to its band, inclusive).
    const seriesYs = stackOrder.map((proj, idx) => {
      return days.map((d) => {
        let sum = 0;
        for (let i = 0; i <= idx; i++) sum += d.bands[stackOrder[i].key] || 0;
        return sum;
      });
    });

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.style.display = 'none';
    node.style.position = 'relative';
    node.appendChild(tooltip);

    function fmtDate(unixSec) {
      return new Date(unixSec * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    }
    function hexToRgba(hex, alpha) {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      if (!m) return hex;
      return `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${alpha})`;
    }

    // Helper: determine which project band (if any) the y-value falls into at a given x-index.
    function hitBand(yVal, idx) {
      for (let i = 0; i < stackOrder.length; i++) {
        const bandTop = seriesYs[i][idx];
        const bandBot = i === 0 ? 0 : seriesYs[i - 1][idx];
        if (yVal >= bandBot && yVal <= bandTop) return stackOrder[i];
      }
      return null;
    }

    // Build tooltip HTML.
    // Top block: per-project $ totals for the hovered day, sorted $ desc.
    // Bottom block (only when activeProjectKey is a real project): up to 3 feature rows
    //   for that project on that day, with clickable <a> links.
    function renderTooltip(idx, activeProjectKey) {
      const day = days[idx];
      if (!day || day.total === 0) {
        return `<div class="chart-tooltip-header">${esc(fmtDate(xs[idx]))}</div>`;
      }
      const perProject = Object.entries(day.bands)
        .filter(([, usd]) => usd > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([key, usd]) => {
          const proj = stackOrder.find((p) => p.key === key);
          const color = proj ? proj.color : cssVar('--color-swatch-fallback','#a8a29a');
          const name = proj ? proj.name : key;
          const activeCls = key === activeProjectKey ? ' chart-tooltip-row--active' : '';
          return `<div class="chart-tooltip-row${activeCls}"><span class="swatch" style="background:${esc(color)}"></span>${esc(name)}<span class="amt">${fmtUsd(usd)}</span></div>`;
        }).join('');

      // Bottom block skips when the active project has ≤1 feature — that case
      // would just duplicate the top row's total, adding no information.
      let bottom = '';
      if (activeProjectKey && activeProjectKey !== '__other__') {
        const active = stackOrder.find((p) => p.key === activeProjectKey);
        const feats = (day.featureBands && day.featureBands[activeProjectKey]) || {};
        const entries = Object.entries(feats)
          .filter(([, usd]) => usd > 0)
          .sort((a, b) => b[1] - a[1]);
        if (entries.length > 1) {
          const shown = entries.slice(0, 3);
          const more = entries.length - shown.length;
          const rows = shown.map(([key, usd]) => {
            if (key === '__unattributed__') {
              return `<div class="chart-tooltip-row chart-tooltip-row--unatt"><span class="swatch swatch--striped"></span>unattributed<span class="amt">${fmtUsd(usd)}</span></div>`;
            }
            return `<a class="chart-tooltip-row chart-tooltip-link" href="/feature/${encodeURIComponent(key)}"><span class="swatch" style="background:${esc(colorForFeatureInProject(activeProjectKey, key))}"></span>${esc(key)}<span class="amt">${fmtUsd(usd)}</span></a>`;
          }).join('');
          const label = active ? `${active.name}'s features` : `${activeProjectKey}'s features`;
          bottom = `<div class="chart-tooltip-subhead">${esc(label)}</div>${rows}${more > 0 ? `<div class="chart-tooltip-more">+ ${more} more</div>` : ''}`;
        }
      }
      return `<div class="chart-tooltip-header">${esc(fmtDate(xs[idx]))}</div><div class="chart-tooltip-label">Projects</div><div class="chart-tooltip-rows">${perProject}</div>${bottom}`;
    }

    // uPlot series + bands wiring.
    // series[0] is the x-axis pseudo-series. Real series start at 1.
    // Trend chart uses solid hex fills only (no stripes — makeStripePattern lives on in Task 5/6).
    // stroke/fill are FUNCTIONS so hover isolation re-resolves them per
    // draw: when a project is active (legend hover or cursor inside its
    // band), every other band ghosts to low opacity in place.
    let activeKey = null;
    const colorByKey = {};
    stackOrder.forEach((proj) => { colorByKey[proj.key] = proj.color; });
    // Fills/strokes are FUNCTIONS of activeKey. uPlot re-resolves them via its
    // internal cacheStrokeFill on setData/setSize (e.g. a mobile-layout resize),
    // so those paths recompute the focus effect correctly instead of reverting
    // to a static default. Plain redraw() does NOT re-run them — the drawClear
    // hook (applyFocusFills) covers that path. Between the two, no uPlot redraw
    // can clobber the effect. When a project is focused, EVERY stacked band
    // ghosts to ~12% (the focused project is redrawn on the overlay below).
    const series = [{}].concat(stackOrder.map((proj) => ({
      label: proj.name,
      stroke: () => (activeKey ? hexToRgba(proj.color, 0.15) : proj.color),
      fill: () => (activeKey ? hexToRgba(proj.color, 0.12) : hexToRgba(proj.color, 0.92)),
      width: 1,
      points: { show: false },
    })));
    // Focus overlay: the active project's own daily $ (un-stacked, from zero),
    // drawn last so it sits on top of the ghosted stack; transparent until a
    // project is focused.
    series.push({
      label: '__focus__',
      stroke: () => (activeKey ? hexToRgba(colorByKey[activeKey] || '#888888', 0.95) : 'rgba(0,0,0,0)'),
      fill: () => (activeKey ? hexToRgba(colorByKey[activeKey] || '#888888', 0.85) : 'rgba(0,0,0,0)'),
      width: 1.5,
      points: { show: false },
    });
    // Bands: each band fills between series idx and idx-1 (stacked area). The
    // overlay series is intentionally outside every band so uPlot fills it to
    // the zero baseline.
    const bands = [];
    for (let i = 1; i < stackOrder.length; i++) {
      bands.push({ series: [i + 1, i] });
    }

    // The overlay column: the focused project's raw daily values, or nulls
    // (uPlot draws nothing) when nothing is focused.
    const focusYs = () => (activeKey ? days.map((d) => d.bands[activeKey] || 0) : days.map(() => null));
    const data = [xs].concat(seriesYs, [focusYs()]);

    // Re-resolve every series' cached _fill/_stroke by re-invoking its
    // fill/stroke FUNCTION (which reads activeKey). Runs from the uPlot
    // `drawClear` hook on every draw, so plain redraw() — which otherwise
    // reuses the stale cached value — re-derives the focus effect. Paired with
    // the fill functions (which uPlot re-resolves on resize/setData), this
    // makes the effect robust to every redraw path. (Writing _fill once in
    // setActiveKey was fragile: hover masked it via continuous re-assertion on
    // every mouse move, but a single touch tap had none and a later resize
    // reverted it.)
    function applyFocusFills(u) {
      for (let i = 1; i < u.series.length; i++) {
        const s = u.series[i];
        if (typeof s.fill === 'function') s._fill = s.fill(u, i);
        if (typeof s.stroke === 'function') s._stroke = s.stroke(u, i);
      }
    }

    // Declare setActiveKey before opts so it can be safely called from hooks.
    let chartCanvas;
    function setActiveKey(key) {
      if (!chartCanvas) return;
      if (key !== activeKey) {
        activeKey = key;
        const u = node.__uplot;
        if (u) {
          // Swap the overlay column in place (the focused project's daily $,
          // un-stacked from the baseline) and repaint. Fills are re-derived by
          // the drawClear hook, so we only own the data + the redraw here.
          // Rebuild paths but DON'T recompute scales: the stack total always
          // sets y-max and the overlay can never exceed it.
          u.data[stackOrder.length + 1] = focusYs();
          u.redraw(true, false);
        }
      }
      if (legend) {
        legend.querySelectorAll('.trend-legend-row').forEach((li) => {
          li.classList.toggle('active', li.getAttribute('data-project-key') === key);
          li.classList.toggle('inactive', !!key && li.getAttribute('data-project-key') !== key);
        });
      }
    }

    // Hover vs touch: cursor-driven focus (below, in setCursor) and legend
    // hover are desktop affordances. On touch there is no persistent cursor,
    // so a phantom setCursor firing after a legend tap would clobber the
    // tap-driven focus — hence gate cursor focus on canHover.
    const canHover = window.matchMedia('(hover: hover)').matches;

    const opts = {
      width: node.clientWidth,
      height: 280,
      legend: { show: false },     // we render our own
      cursor: { drag: { x: false, y: false }, points: { size: 5 } },
      scales: { x: { time: true } },
      series: series,
      bands: bands,
      axes: (() => {
        // Themed at build time (and rebuilt on toggle via renderTrend re-entry).
        const axisStroke = cssVar('--color-chart-axis', '#524d46');
        const gridStroke = cssVar('--color-chart-grid', 'rgba(60,58,54,0.09)');
        return [
          { stroke: axisStroke, grid: { stroke: gridStroke } },
          { stroke: axisStroke, grid: { stroke: gridStroke }, values: (_s, ticks) => ticks.map((t) => '$' + Math.round(t)) },
        ];
      })(),
      hooks: {
        // Re-derive focus fills from activeKey before every draw, so no
        // internal uPlot redraw can revert the ghost/overlay effect.
        drawClear: [(u) => applyFocusFills(u)],
        setCursor: [
          (() => {
            // Track prior state so we only re-render on real changes. Every
            // mouse move fires setCursor, but tooltip content only depends
            // on (idx, activeProjectKey) — re-rendering on every rAF makes
            // the tooltip flicker/rewrite while the user tries to reach a
            // drill-down link, and the link disappears out from under them.
            let lastIdx = null;
            let lastKey = null;
            return (self) => {
              const idx = self.cursor.idx;
              if (idx == null || idx < 0 || idx >= days.length) {
                // Don't hide the tooltip — cursor.idx = null also fires when
                // the mouse crosses onto a .chart-tooltip-link (pointer-events:
                // auto). Hiding here kills the link before the click lands.
                // node.mouseleave owns actual dismissal.
                return;
              }
              const yVal = self.posToVal(self.cursor.top, 'y');
              const band = hitBand(yVal, idx);
              const activeProjectKey = band ? band.key : null;
              // Only let the chart cursor drive focus on hover devices. On
              // touch, focus is owned by legend taps; a phantom cursor update
              // here (fired after the tap's redraw) would otherwise reset it.
              if (canHover) setActiveKey(activeProjectKey);

              // Skip re-render if content unchanged — keeps drill-down link
              // positions stable so the user can reach them.
              if (idx === lastIdx && activeProjectKey === lastKey) return;
              lastIdx = idx; lastKey = activeProjectKey;

              tooltip.innerHTML = renderTooltip(idx, activeProjectKey);
              tooltip.style.display = 'block';

              // Position tooltip pinned to the TOP of the plot area, offset
              // horizontally to the current x. It never moves in y, so it
              // never overlaps the cursor and the drill-down link never
              // steals mouseleave events from u-over as the user reaches it.
              const left = self.valToPos(xs[idx], 'x');
              const rect = node.getBoundingClientRect();
              const tw = tooltip.offsetWidth;
              let px = left + 12;
              if (px + tw > rect.width) px = left - tw - 12;
              // Clamp inside the chart node: near the left edge the flip
              // above goes negative and a wide tooltip flows out of view.
              px = Math.max(8, Math.min(px, rect.width - tw - 8));
              tooltip.style.left = px + 'px';
              tooltip.style.top = '8px';
            };
          })(),
        ],
      },
    };
    // eslint-disable-next-line no-undef
    const u = new uPlot(opts, data, node);
    node.__uplot = u;

    const legend = document.getElementById('trend-legend');
    chartCanvas = node.querySelector('canvas');

    if (legend) {
      legend.querySelectorAll('.trend-legend-row').forEach((li) => {
        const key = li.getAttribute('data-project-key');
        const clickable = li.getAttribute('data-clickable') === '1';
        const expandable = li.getAttribute('data-expandable') === '1';
        // Desktop: hover focuses (brings the project to the front). On touch,
        // hover events are unreliable, so focus is driven by tap below.
        li.addEventListener('mouseenter', () => { if (canHover) setActiveKey(key); });
        li.addEventListener('mouseleave', () => { if (canHover) setActiveKey(null); });
        if (canHover) {
          // Desktop click navigates (the nav chevron is hidden on desktop).
          if (clickable && key) {
            li.addEventListener('click', (e) => {
              if (e.target.closest('.legend-nav')) return;
              window.location.href = '/project/' + encodeURIComponent(key);
            });
          }
        } else if (key && !expandable) {
          // Touch: tapping a project row toggles its focus; tapping it again
          // (or another row) clears/switches. The chevron (.legend-nav) still
          // navigates to the project page.
          li.addEventListener('click', (e) => {
            if (e.target.closest('.legend-nav')) return;
            setActiveKey(activeKey === key ? null : key);
          });
        }
      });
      // Expandable Other row: toggle the tail-project sub-list.
      const otherRow = legend.querySelector('[data-expandable="1"]');
      if (otherRow) {
        function toggleOther() {
          const expanded = legend.classList.toggle('other-expanded');
          otherRow.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          const chevron = otherRow.querySelector('.chevron');
          if (chevron) chevron.textContent = expanded ? '▾' : '▸';
        }
        otherRow.addEventListener('click', toggleOther);
        otherRow.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOther(); }
        });
      }
      // Sub-rows navigate to their project page. No band highlight on hover:
      // the Other band is an aggregate — there is nothing to isolate.
      legend.querySelectorAll('.trend-legend-subrow').forEach((li) => {
        const key = li.getAttribute('data-project-key');
        if (!key) return;
        li.addEventListener('click', () => {
          window.location.href = '/project/' + encodeURIComponent(key);
        });
      });
    }

    // Chart click: derive the active project band from cursor position and navigate.
    node.addEventListener('click', () => {
      const cu = node.__uplot;
      if (!cu) return;
      const clickIdx = cu.cursor.idx;
      if (clickIdx == null) return;
      const yVal = cu.posToVal(cu.cursor.top, 'y');
      const active = hitBand(yVal, clickIdx);
      if (active && active.clickable !== false && active.key !== '__other__') {
        window.location.href = '/project/' + encodeURIComponent(active.key);
      }
    });

    // Mouseleave guard: skip tooltip dismissal if the cursor entered the legend OR the tooltip itself.
    // Symmetric listener on the tooltip lets the user click the feature <a> links inside it.
    node.addEventListener('mouseleave', () => {
      if (legend && legend.matches(':hover')) return;
      if (tooltip && tooltip.matches(':hover')) return;
      setActiveKey(null);
      tooltip.style.display = 'none';
    });
    tooltip.addEventListener('mouseleave', () => {
      if (legend && legend.matches(':hover')) return;
      if (node && node.matches(':hover')) return;
      setActiveKey(null);
      tooltip.style.display = 'none';
    });
  }

  function renderTrailElevation() {
    const node = document.getElementById('trail-elevation');
    const dataNode = document.getElementById('trail-elevation-data');
    if (!node || !dataNode) return;
    let sessions;
    try { sessions = JSON.parse(dataNode.textContent || '[]'); } catch (e) { return; }
    if (!Array.isArray(sessions) || sessions.length === 0) {
      node.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No sessions yet — start a Claude Code session in this feature\'s branch to begin the trail.</div>';
      return;
    }

    // Build cumulative trail points: { t (unix ms), cum, session }
    const pts = [];
    let acc = 0;
    for (const s of sessions) {
      acc += s.cost;
      pts.push({ t: new Date(s.date + 'T12:00:00').getTime(), cum: acc, session: s });
    }
    // Anchor the curve at zero on the day before the first session so the
    // trail starts at the trailhead instead of mid-climb.
    const firstT = pts[0].t - 86400000;
    // End the curve at "now" so the trail extends to today as a flat
    // plateau (the trail doesn't dip after the last session).
    const lastT = Math.max(pts[pts.length - 1].t, Date.now());

    const W = node.clientWidth || 800;
    const H = 240;
    const pad = { l: 50, r: 20, t: 20, b: 30 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;

    const xMin = firstT;
    const xMax = lastT + 86400000;
    const yMax = Math.max(acc, 1) * 1.1;

    function xPos(t) {
      if (xMax === xMin) return pad.l + innerW / 2;
      return pad.l + ((t - xMin) / (xMax - xMin)) * innerW;
    }
    function yPos(v) {
      return pad.t + innerH - (v / yMax) * innerH;
    }

    // Build the area polygon and the trail line.
    // Trail steps: start at (firstT, 0), then for each session step UP to
    // the cumulative value at that session's t (vertical), then continue
    // FLAT to the next session's t. This gives the "elevation profile"
    // look — each session is a rise, days between sessions are flat.
    const trailPoints = [{ t: firstT, v: 0 }];
    let prevCum = 0;
    for (const p of pts) {
      trailPoints.push({ t: p.t, v: prevCum });   // flat up to the rise
      trailPoints.push({ t: p.t, v: p.cum });     // the rise
      prevCum = p.cum;
    }
    trailPoints.push({ t: lastT + 86400000, v: prevCum });

    const lineD = trailPoints.map((p, i) => (i === 0 ? 'M' : 'L') + xPos(p.t).toFixed(1) + ' ' + yPos(p.v).toFixed(1)).join(' ');
    const areaD = lineD +
      ' L' + xPos(trailPoints[trailPoints.length - 1].t).toFixed(1) + ' ' + yPos(0).toFixed(1) +
      ' L' + xPos(trailPoints[0].t).toFixed(1) + ' ' + yPos(0).toFixed(1) + ' Z';

    // Build axis ticks: a few horizontal $ gridlines + the date axis.
    const yTicks = niceTicks(0, yMax, 4);
    const xTicks = niceTimeTicks(xMin, xMax, 6);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', H);
    svg.setAttribute('class', 'trail-elevation');

    // Y gridlines + labels
    for (const v of yTicks) {
      const y = yPos(v);
      const grid = document.createElementNS(ns, 'line');
      grid.setAttribute('x1', pad.l); grid.setAttribute('x2', W - pad.r);
      grid.setAttribute('y1', y); grid.setAttribute('y2', y);
      grid.setAttribute('class', 'trail-grid');
      svg.appendChild(grid);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', pad.l - 8); label.setAttribute('y', y + 4);
      label.setAttribute('class', 'trail-axis-label');
      label.setAttribute('text-anchor', 'end');
      label.textContent = '$' + Math.round(v);
      svg.appendChild(label);
    }
    // X labels
    for (const t of xTicks) {
      const x = xPos(t);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', x); label.setAttribute('y', H - 10);
      label.setAttribute('class', 'trail-axis-label');
      label.setAttribute('text-anchor', 'middle');
      label.textContent = fmtTickDate(t);
      svg.appendChild(label);
    }

    // Area
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', areaD);
    area.setAttribute('class', 'trail-area');
    svg.appendChild(area);

    // Line
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', lineD);
    line.setAttribute('class', 'trail-line');
    svg.appendChild(line);

    // Mile markers — one per session, at (t, cum)
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.style.display = 'none';
    node.style.position = 'relative';
    node.appendChild(tooltip);

    for (const p of pts) {
      const cx = xPos(p.t);
      const cy = yPos(p.cum);
      const marker = document.createElementNS(ns, 'circle');
      marker.setAttribute('cx', cx); marker.setAttribute('cy', cy);
      marker.setAttribute('r', 5);
      marker.setAttribute('class', 'trail-marker');
      marker.setAttribute('data-session-id', p.session.sessionId);
      marker.addEventListener('mouseenter', () => {
        tooltip.innerHTML =
          '<div class="chart-tooltip-date">' + fmtFullDate(p.t) + '</div>' +
          '<div class="chart-tooltip-value">$' + p.session.cost.toFixed(2) + ' this session</div>' +
          '<div class="chart-tooltip-meta">$' + p.cum.toFixed(2) + ' on the trail</div>';
        tooltip.style.display = 'block';
        const rect = node.getBoundingClientRect();
        const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
        let px = cx + 12, py = cy - th - 8;
        if (px + tw > rect.width) px = cx - tw - 12;
        // Same clamp as the trend tooltip — the flip can push a wide
        // tooltip past the node's left edge for markers near x=0.
        px = Math.max(8, Math.min(px, rect.width - tw - 8));
        if (py < 0) py = cy + 12;
        tooltip.style.left = px + 'px'; tooltip.style.top = py + 'px';
      });
      marker.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
      marker.addEventListener('click', () => {
        const row = document.getElementById(p.session.sessionId);
        if (!row) return;
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('flash');
        setTimeout(() => row.classList.remove('flash'), 1200);
      });
      svg.appendChild(marker);
    }

    node.innerHTML = '';
    node.appendChild(svg);
    node.appendChild(tooltip);
  }

  function renderBurnPathsSubBars() {
    const dataNode = document.getElementById('burn-paths-data');
    if (!dataNode) return;
    let payload;
    try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
    if (!Array.isArray(payload)) return;

    payload.forEach((entry) => {
      const container = document.querySelector(`.subbar[data-project-key="${cssEscape(entry.projectKey)}"]`);
      if (!container) return;
      const total = entry.features.reduce((s, f) => s + f.totalUsd, 0);
      if (total <= 0) return;

      // Enforce minimum visible segment width (2px). Small segments aggregate into a
      // trailing "other-features" neutral bucket to preserve legibility.
      const minPct = 2 / (container.clientWidth || 480) * 100;
      const kept = [];
      let otherUsd = 0;
      entry.features.forEach((f) => {
        const pct = (f.totalUsd / total) * 100;
        if (pct >= minPct) kept.push({ ...f, pct });
        else otherUsd += f.totalUsd;
      });
      if (otherUsd > 0) {
        kept.push({ key: '__other_features__', name: 'other features', color: cssVar('--color-swatch-fallback','#a8a29a'), totalUsd: otherUsd, pct: (otherUsd / total) * 100 });
      }

      container.innerHTML = kept.map((f) => {
        const striped = f.color === '__striped__' ? ' subbar-segment--striped' : '';
        const bg = f.color === '__striped__' ? '' : `background:${escapeAttr(f.color)};`;
        const swatch = f.color === '__striped__' ? cssVar('--color-stripe-fg', '#78716a') : f.color;
        return `<div class="subbar-segment${striped}" style="${bg}width:${f.pct.toFixed(2)}%" data-feature-name="${escapeAttr(f.name)}" data-usd="${f.totalUsd.toFixed(0)}" data-swatch="${escapeAttr(swatch)}"></div>`;
      }).join('');
      container.querySelectorAll('.subbar-segment').forEach(attachSubbarSegmentTip);
    });
  }

  // One shared tooltip for all subbar segments, appended to <body> so the
  // subbar's overflow:hidden can't clip it. It sits directly above the
  // hovered segment, so it must be pointer-events:none (set in CSS) or it
  // would intercept the very hover that opened it.
  let subbarTip = null;
  function ensureSubbarTip() {
    if (!subbarTip) {
      subbarTip = document.createElement('div');
      subbarTip.className = 'chart-tooltip subbar-tooltip';
      subbarTip.style.display = 'none';
      document.body.appendChild(subbarTip);
    }
    return subbarTip;
  }

  // Position a body-appended fixed tip near its target rect: centered
  // horizontally (viewport-clamped), above the target — flipped below it
  // when the viewport top would clip the tip. Measure after display:flex.
  function positionChartTip(tip, rect) {
    const x = Math.max(8, Math.min(
      rect.left + rect.width / 2 - tip.offsetWidth / 2,
      window.innerWidth - tip.offsetWidth - 8,
    ));
    const above = rect.top - tip.offsetHeight - 6;
    tip.style.left = x + 'px';
    tip.style.top = (above >= 8 ? above : rect.bottom + 6) + 'px';
  }

  function attachSubbarSegmentTip(seg) {
    seg.addEventListener('mouseenter', () => {
      const tip = ensureSubbarTip();
      tip.innerHTML = `<span class="swatch" style="background:${escapeAttr(seg.dataset.swatch || cssVar('--color-swatch-fallback','#a8a29a'))}"></span>` +
        `<span class="name">${esc(seg.dataset.featureName || '')}</span>` +
        `<span class="amt">$${esc(seg.dataset.usd || '0')}</span>`;
      // Display before measuring — offsetWidth is 0 while display:none.
      // 'flex', not 'block': the inline style overrides the stylesheet's
      // display:flex, and block layout drops the swatch/name/amt gap.
      tip.style.display = 'flex';
      positionChartTip(tip, seg.getBoundingClientRect());
    });
    seg.addEventListener('mouseleave', () => {
      if (subbarTip) subbarTip.style.display = 'none';
    });
  }

  // Hour-bar tooltips (Today page). Payload: [{hour, usd, projects:[{name,usd,color}]}].
  // Same conventions as the subbar tip: shared body-level singleton,
  // pointer-events:none via .chart-tooltip, display-before-measure,
  // viewport-clamped. Zero-spend hours are absent from the payload and
  // get no listeners.
  let hourTip = null;
  function ensureHourTip() {
    if (!hourTip) {
      hourTip = document.createElement('div');
      hourTip.className = 'chart-tooltip hour-tooltip';
      hourTip.style.display = 'none';
      document.body.appendChild(hourTip);
    }
    return hourTip;
  }

  function renderHourBarTips() {
    const dataNode = document.getElementById('hour-burn-data');
    if (!dataNode) return;
    let payload;
    try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
    if (!Array.isArray(payload)) return;
    const byHour = new Map(payload.map((h) => [h.hour, h]));
    const MAX_ROWS = 6;

    document.querySelectorAll('.hour-bar[data-hour]').forEach((bar) => {
      const entry = byHour.get(Number(bar.dataset.hour));
      if (!entry || !(entry.usd > 0)) return;
      bar.addEventListener('mouseenter', () => {
        const tip = ensureHourTip();
        const hh = String(entry.hour).padStart(2, '0');
        const next = String((entry.hour + 1) % 24).padStart(2, '0');
        const projects = Array.isArray(entry.projects) ? entry.projects : [];
        const rows = projects.slice(0, MAX_ROWS).map((p) => {
          const usd = Number(p.usd) || 0;
          return `<div class="hour-tip-row">` +
            `<span class="swatch" style="background:${escapeAttr(p.color || cssVar('--color-swatch-fallback','#a8a29a'))}"></span>` +
            `<span class="name">${esc(p.name || '')}</span>` +
            `<span class="amt">$${usd < 1 ? usd.toFixed(2) : usd.toFixed(0)}</span>` +
            `</div>`;
        });
        if (projects.length > MAX_ROWS) {
          rows.push(`<div class="hour-tip-row hour-tip-more">+${projects.length - MAX_ROWS} more</div>`);
        }
        tip.innerHTML =
          `<div class="hour-tip-head">${hh}:00–${next}:00 · $${entry.usd.toFixed(2)}</div>` + rows.join('');
        // Display before measuring — offsetWidth is 0 while display:none.
        tip.style.display = 'flex';
        positionChartTip(tip, bar.getBoundingClientRect());
      });
      bar.addEventListener('mouseleave', () => {
        if (hourTip) hourTip.style.display = 'none';
      });
    });
  }

  function fmtUsd(n) {
    return '$' + (typeof n === 'number' ? n.toFixed(2) : n);
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  }

  function niceTicks(min, max, n) {
    const range = max - min;
    const step = Math.pow(10, Math.floor(Math.log10(range / n)));
    const err = (n / range) * step;
    const mult = err <= 0.15 ? 10 : err <= 0.35 ? 5 : err <= 0.75 ? 2 : 1;
    const niceStep = mult * step;
    const ticks = [];
    for (let v = Math.ceil(min / niceStep) * niceStep; v <= max; v += niceStep) ticks.push(v);
    return ticks;
  }

  function niceTimeTicks(minMs, maxMs, n) {
    const span = maxMs - minMs;
    const dayMs = 86400000;
    // pick a stride in days
    const candidates = [1, 2, 5, 7, 14, 30, 60, 90, 180, 365];
    const stride = candidates.find((d) => span / (d * dayMs) <= n) || 365;
    const ticks = [];
    const startDay = Math.ceil(minMs / dayMs) * dayMs;
    for (let t = startDay; t <= maxMs; t += stride * dayMs) ticks.push(t);
    return ticks;
  }

  function fmtTickDate(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function fmtFullDate(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function setupRowExpanders() {
    document.querySelectorAll('[data-expand-target]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if ((e.target instanceof HTMLAnchorElement)) return;
        const targetId = row.getAttribute('data-expand-target');
        if (!targetId) return;
        const target = document.getElementById(targetId);
        if (target) target.classList.toggle('open');
      });
    });
  }

  function setupClusterJumps() {
    document.querySelectorAll('[data-cluster-sessions]').forEach((row) => {
      row.addEventListener('click', () => {
        const ids = (row.getAttribute('data-cluster-sessions') || '').trim().split(/\s+/);
        if (!ids.length) return;
        const first = document.getElementById(ids[0]);
        if (!first) return;
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        first.classList.add('flash');
        setTimeout(() => first.classList.remove('flash'), 1200);
      });
      row.style.cursor = 'pointer';
    });
  }

  function wireInferMainlineCta(btn, status) {
    if (!btn || !status) return;
    const original = btn.innerHTML;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Running…';
      status.hidden = false;
      status.innerHTML = 'Starting…';
      const evt = new EventSource('/api/infer-mainline/stream');
      let lastCurrent = 0;
      let lastTotal = 0;
      evt.addEventListener('start', (e) => {
        const d = JSON.parse(e.data);
        status.innerHTML = `Retrying ${d.retriedSessions || 0} stuck sessions…`;
      });
      evt.addEventListener('progress', (e) => {
        const p = JSON.parse(e.data);
        lastCurrent = p.current; lastTotal = p.total;
        const t = (p.title || '(untitled)').slice(0, 60);
        const verb = p.action === 'skip' ? 'skipping' : p.action === 'llm' ? 'LLM' : 'rules';
        status.innerHTML = `Session <b>${p.current}/${p.total}</b> · ${verb}<br><span class="muted">${t}</span>`;
      });
      evt.addEventListener('rollup', () => { status.innerHTML = `Re-rolling up ${lastTotal || ''} sessions…`; });
      evt.addEventListener('done', (e) => {
        const d = JSON.parse(e.data);
        const s = d.summary || {};
        status.innerHTML = `Retried ${d.retriedSessions || 0}, relabeled ${s.sessionsRelabeled || 0} sessions (${s.eventsRelabeled || 0} events). Reloading…`;
        evt.close();
        setTimeout(() => location.reload(), 800);
      });
      evt.addEventListener('error', (e) => {
        try {
          const d = e.data ? JSON.parse(e.data) : null;
          if (d && d.message) status.textContent = 'Error: ' + d.message;
          else if (lastCurrent > 0) status.textContent = `Connection dropped at session ${lastCurrent}/${lastTotal}. Reload and try again.`;
        } catch { /* ignore */ }
        evt.close();
        btn.disabled = false;
        btn.innerHTML = original;
      });
    });
  }

  function renderUnattributedCard() {
    const card = document.getElementById('unattributed-card');
    const dataNode = document.getElementById('trend-data');
    if (!card || !dataNode) return;
    let payload;
    try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
    const u = payload && payload.unattributed;
    if (!u) {
      card.innerHTML = `
        <div class="label">Unattributed</div>
        <div class="unatt-hero-empty">$0 <span class="muted">· all sessions attributed</span></div>
        <div class="muted unatt-empty-note">Every session in this window is tied to a project. Nothing to reconcile.</div>
      `;
      return;
    }

    const spark = drawSparkline(u.sparkline);
    const projRows = u.topProjects.map((p) => {
      const pct = p.projectTotalUsd > 0 ? (p.unattributedUsd / p.projectTotalUsd) * 100 : 0;
      return `<div class="unatt-project">
        <div class="unatt-project-head">
          <span class="swatch" style="background:${escapeAttr(p.color)}"></span>
          <span class="name">${esc(p.name)}</span>
          <span class="amt">${fmtUsd(p.unattributedUsd)}</span>
        </div>
        <div class="unatt-project-bar"><div style="width:${pct.toFixed(1)}%"></div></div>
      </div>`;
    }).join('');

    card.innerHTML = `
      <div class="label">Unattributed</div>
      <div class="unatt-hero">${fmtUsd(u.totalUsd)} <span class="muted">· ${u.pctOfTrail.toFixed(0)}% of trail</span></div>
      <div class="unatt-sparkline">${spark}</div>
      <div class="unatt-projects">${projRows}</div>
      <button class="unatt-cta" type="button">Run <code>tokentrail infer-mainline</code> →</button>
      <div class="unatt-cta-status" role="status" aria-live="polite" hidden></div>
    `;

    const btn = card.querySelector('.unatt-cta');
    const status = card.querySelector('.unatt-cta-status');
    wireInferMainlineCta(btn, status);
  }

  function drawSparkline(points) {
    if (!points || points.length === 0) return '';
    const w = 220, h = 40, pad = 2;
    const max = Math.max(1, ...points.map((p) => p.usd));
    const stepX = (w - pad * 2) / Math.max(1, points.length - 1);
    const pts = points.map((p, i) => {
      const x = pad + i * stepX;
      const y = h - pad - (p.usd / max) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="${cssVar('--color-stripe-fg', '#78716a')}" stroke-width="1.5" />
    </svg>`;
  }

  function wireProjectUnattCta() {
    const btn = document.querySelector('.project-page [data-project-cta]');
    if (!btn) return;
    const parent = btn.parentElement;
    const status = parent ? parent.querySelector('.unatt-cta-status') : null;
    wireInferMainlineCta(btn, status);
  }

  // Let the theme toggle recolor the uPlot axes/grid (which are baked at build
  // time) by rebuilding the chart after a theme flip.
  window.__ttRerenderChart = renderTrend;

  document.addEventListener('DOMContentLoaded', () => {
    renderTrend();
    renderTrailElevation();

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

    renderBurnPathsSubBars();
    renderHourBarTips();
    renderUnattributedCard();
    setupRowExpanders();
    setupClusterJumps();
    wireProjectUnattCta();
    liftDomBands();   // after all swatch/sub-bar rendering; lifts hues on dark
  });

  // Theme preference. Stored in localStorage as 'system' | 'light' | 'dark'.
  // The inline <head> script applies light/dark before first paint; 'system'
  // (or absent) leaves no data-theme so the CSS follows prefers-color-scheme.
  // The control lives on the Settings page (Appearance) — there is no header
  // toggle. applyTheme also rebuilds the uPlot chart, which bakes its colors.
  function applyTheme(pref) {
    const root = document.documentElement;
    if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref);
    else root.removeAttribute('data-theme');   // 'system' → follow the OS
    try { localStorage.setItem('tt-theme', pref); } catch (err) { /* private mode */ }
    if (window.__ttRerenderChart) window.__ttRerenderChart();
    liftDomBands();   // recolor server/JS band swatches + sub-bars for the new theme
  }

  // Wire the Settings appearance radios (present only on /settings): reflect the
  // stored preference and apply changes live.
  (function wireThemeControl() {
    const radios = document.querySelectorAll('input[name="theme-pref"]');
    if (!radios.length) return;
    let stored = 'system';
    try { stored = localStorage.getItem('tt-theme') || 'system'; } catch (e) { /* ignore */ }
    if (stored !== 'light' && stored !== 'dark') stored = 'system';
    radios.forEach((r) => {
      r.checked = r.value === stored;
      r.addEventListener('change', () => { if (r.checked) applyTheme(r.value); });
    });
  })();

  // In 'system' mode a live OS light/dark flip recolors the CSS on its own, but
  // the uPlot canvas bakes its colors — so rebuild it when the OS theme changes.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      let pref = 'system';
      try { pref = localStorage.getItem('tt-theme') || 'system'; } catch (e) { /* ignore */ }
      if (pref !== 'light' && pref !== 'dark') {
        if (window.__ttRerenderChart) window.__ttRerenderChart();
        liftDomBands();
      }
    });
  } catch (e) { /* older Safari lacks addEventListener on MediaQueryList */ }

  // Anomaly dismiss/restore actions. Delegated handler so we don't need
  // to re-bind after server-rendered re-renders.
  document.addEventListener('click', async function (e) {
    const btn = e.target.closest('.anomaly-action');
    if (!btn) return;
    const row = btn.closest('.anomaly-row');
    if (!row) return;
    const id = row.dataset.anomalyId;
    const action = btn.dataset.action;
    if (!id || (action !== 'dismiss' && action !== 'restore')) return;

    btn.disabled = true;
    try {
      const res = await fetch('/api/anomalies/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
      // 204: state flipped. 409: another tab already flipped it — treat as
      // success so the visual state catches up rather than nagging the user.
      if (!res.ok && res.status !== 409) throw new Error('HTTP ' + res.status);

      // Flip the row's visual state.
      row.classList.toggle('dismissed');
      const newAction = action === 'dismiss' ? 'restore' : 'dismiss';
      btn.textContent = newAction;
      btn.dataset.action = newAction;
      btn.disabled = false;

      // If we're not showing dismissed rows and we just dismissed one,
      // collapse it out of view.
      const showDismissed = document.body.dataset.showDismissed === '1';
      if (!showDismissed && action === 'dismiss') {
        row.style.transition = 'opacity 200ms';
        row.style.opacity = '0';
        setTimeout(function () { row.remove(); }, 200);
      }
    } catch (err) {
      btn.disabled = false;
      // Inline ephemeral error message next to the button. Guard against a
      // detached button (e.g. the row was removed between click and rejection).
      const parent = btn.parentElement;
      if (parent) {
        const errSpan = document.createElement('span');
        errSpan.className = 'anomaly-error';
        errSpan.textContent = ' (failed — try again)';
        parent.appendChild(errSpan);
        setTimeout(function () { errSpan.remove(); }, 4000);
      }
    }
  });
})();
