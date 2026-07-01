(function () {
  function renderTrend() {
    const node = document.getElementById('trend-chart');
    const dataNode = document.getElementById('trend-data');
    if (!node || !dataNode || typeof uPlot === 'undefined') return;
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

    // Client-side colour picker for features shown in tooltip bottom block.
    // Mirrors src/dashboard/lib/feature-colors.ts — kept inline for synchronous rendering.
    const PALETTE_INLINE = ['#0072B2','#E69F00','#009E73','#CC79A7','#56B4E9','#D55E00','#F0E442','#000000'];
    function colorForFeature(k) {
      let h = 5381;
      for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0;
      h = Math.imul(h ^ (h >>> 15), 0x9E3779B1);
      return PALETTE_INLINE[Math.abs(h >>> 0) % PALETTE_INLINE.length];
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
          const color = proj ? proj.color : '#9CA3AF';
          const name = proj ? proj.name : key;
          return `<div class="chart-tooltip-row"><span class="swatch" style="background:${esc(color)}"></span>${esc(name)}<span class="amt">${fmtUsd(usd)}</span></div>`;
        }).join('');

      let bottom = '';
      if (activeProjectKey && activeProjectKey !== '__other__') {
        const active = stackOrder.find((p) => p.key === activeProjectKey);
        const feats = (day.featureBands && day.featureBands[activeProjectKey]) || {};
        const entries = Object.entries(feats)
          .filter(([, usd]) => usd > 0)
          .sort((a, b) => b[1] - a[1]);
        if (entries.length > 0) {
          const shown = entries.slice(0, 3);
          const more = entries.length - shown.length;
          const rows = shown.map(([key, usd]) => {
            if (key === '__unattributed__') {
              return `<div class="chart-tooltip-row chart-tooltip-row--unatt"><span class="swatch swatch--striped"></span>unattributed<span class="amt">${fmtUsd(usd)}</span></div>`;
            }
            return `<a class="chart-tooltip-row chart-tooltip-link" href="/feature/${encodeURIComponent(key)}"><span class="swatch" style="background:${esc(colorForFeature(key))}"></span>${esc(key)}<span class="amt">${fmtUsd(usd)}</span></a>`;
          }).join('');
          bottom = `<div class="chart-tooltip-subhead">Inside ${esc(active ? active.name : activeProjectKey)}:</div>${rows}${more > 0 ? `<div class="chart-tooltip-more">+ ${more} more</div>` : ''}`;
        }
      }
      return `<div class="chart-tooltip-header">${esc(fmtDate(xs[idx]))}</div><div class="chart-tooltip-rows">${perProject}</div>${bottom}`;
    }

    // uPlot series + bands wiring.
    // series[0] is the x-axis pseudo-series. Real series start at 1.
    // Trend chart uses solid hex fills only (no stripes — makeStripePattern lives on in Task 5/6).
    const series = [{}].concat(stackOrder.map((proj) => ({
      label: proj.name,
      stroke: proj.color,
      fill: hexToRgba(proj.color, 0.92),
      width: 1,
      points: { show: false },
    })));
    // Bands: each band fills between series idx and idx-1 (stacked area).
    const bands = [];
    for (let i = 1; i < stackOrder.length; i++) {
      bands.push({ series: [i + 1, i] });
    }

    const data = [xs].concat(seriesYs);

    // Declare setActiveKey before opts so it can be safely called from hooks.
    let chartCanvas;
    function setActiveKey(key) {
      if (!chartCanvas) return;
      chartCanvas.classList.toggle('chart-dimmed', !!key);
      if (legend) {
        legend.querySelectorAll('.trend-legend-row').forEach((li) => {
          li.classList.toggle('active', li.getAttribute('data-project-key') === key);
          li.classList.toggle('inactive', !!key && li.getAttribute('data-project-key') !== key);
        });
      }
    }

    const opts = {
      width: node.clientWidth,
      height: 280,
      legend: { show: false },     // we render our own
      cursor: { drag: { x: false, y: false }, points: { size: 5 } },
      scales: { x: { time: true } },
      series: series,
      bands: bands,
      axes: [
        { stroke: '#6b563d', grid: { stroke: 'rgba(139,111,71,0.15)' } },
        { stroke: '#6b563d', grid: { stroke: 'rgba(139,111,71,0.15)' }, values: (_s, ticks) => ticks.map((t) => '$' + Math.round(t)) },
      ],
      hooks: {
        setCursor: [
          (self) => {
            const idx = self.cursor.idx;
            if (idx == null || idx < 0 || idx >= days.length) {
              tooltip.style.display = 'none';
              return;
            }
            // Determine which project band the cursor is over and highlight it.
            const yVal = self.posToVal(self.cursor.top, 'y');
            const band = hitBand(yVal, idx);
            const activeProjectKey = band ? band.key : null;
            setActiveKey(activeProjectKey);

            tooltip.innerHTML = renderTooltip(idx, activeProjectKey);
            tooltip.style.display = 'block';

            const total = days[idx].total || 0;
            const left = self.valToPos(xs[idx], 'x');
            const top = total === 0
              ? (self.cursor.top != null ? self.cursor.top : 0)
              : self.valToPos(seriesYs[seriesYs.length - 1][idx], 'y');
            const rect = node.getBoundingClientRect();
            const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
            let px = left + 12, py = top - th - 8;
            if (px + tw > rect.width) px = left - tw - 12;
            if (py < 0) py = top + 12;
            tooltip.style.left = px + 'px';
            tooltip.style.top = py + 'px';
          },
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
        li.addEventListener('mouseenter', () => setActiveKey(key));
        li.addEventListener('mouseleave', () => setActiveKey(null));
        if (clickable && key) {
          li.addEventListener('click', () => {
            window.location.href = '/project/' + encodeURIComponent(key);
          });
        }
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

  function renderBranchGraph() {
    // Swimlane Gantt: one row per branch, head/tail beziers to a horizontal
    // trunk. X auto-zooms to the data range; labels live in a right gutter.
    const node = document.getElementById('branch-graph');
    const dataNode = document.getElementById('branch-graph-data');
    if (!node || !dataNode) return;
    let vm;
    try { vm = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
    if (!vm || !Array.isArray(vm.branches) || vm.branches.length === 0) return;

    const branches = vm.branches.slice().sort(function (a, b) {
      return a.firstEventAt < b.firstEventAt ? -1 : a.firstEventAt > b.firstEventAt ? 1 : 0;
    });
    const N = branches.length;

    // Auto-zoom X to the actual data range (with a small inset on each side
    // for the diverge/return bezier handles to live).
    let minMs = Infinity, maxMs = -Infinity;
    for (const b of branches) {
      const s = new Date(b.firstEventAt).getTime();
      const e = new Date(b.mergedAt || b.lastEventAt).getTime();
      if (s < minMs) minMs = s;
      if (e > maxMs) maxMs = e;
    }
    if (!isFinite(minMs)) return;
    if (maxMs <= minMs) maxMs = minMs + 86400000;
    // Pad both ends by 5% so endpoints aren't pressed against the edges.
    const dataSpan = maxMs - minMs;
    minMs -= dataSpan * 0.05;
    maxMs += dataSpan * 0.05;

    // Geometry.
    const ROW_H = 36;
    const TRUNK_Y = 36;             // y of the horizontal trunk line
    const HEAD_PAD = 28;            // y above trunk for date-axis ticks
    const FOOT_PAD = 20;
    const GUTTER_W = 340;           // right-side label gutter
    const PAD_L = 32;
    const PAD_R = 24;
    const W = node.clientWidth || 960;
    const chartR = W - PAD_R - GUTTER_W;
    const innerW = chartR - PAD_L;
    const labelX = chartR + 16;
    const H = HEAD_PAD + (N + 1) * ROW_H + FOOT_PAD;

    function xAt(iso) {
      const t = new Date(iso).getTime();
      const clamped = Math.max(minMs, Math.min(maxMs, t));
      return PAD_L + ((clamped - minMs) / (maxMs - minMs)) * innerW;
    }
    function rowY(i) { return TRUNK_Y + (i + 1) * ROW_H; }

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', H);
    svg.setAttribute('class', 'branch-graph');

    // Date ticks (above the trunk).
    const xTicks = niceTimeTicks(minMs, maxMs, 5);
    for (const t of xTicks) {
      const tx = xAt(new Date(t).toISOString());
      const tk = document.createElementNS(ns, 'text');
      tk.setAttribute('x', tx); tk.setAttribute('y', 14);
      tk.setAttribute('text-anchor', 'middle');
      tk.setAttribute('class', 'branch-graph-axis-label');
      tk.textContent = fmtTickDate(t);
      svg.appendChild(tk);
      const grid = document.createElementNS(ns, 'line');
      grid.setAttribute('x1', tx); grid.setAttribute('x2', tx);
      grid.setAttribute('y1', TRUNK_Y); grid.setAttribute('y2', H - FOOT_PAD);
      grid.setAttribute('class', 'branch-graph-grid');
      svg.appendChild(grid);
    }

    // Trunk line.
    const trunkLine = document.createElementNS(ns, 'line');
    trunkLine.setAttribute('x1', PAD_L); trunkLine.setAttribute('x2', chartR);
    trunkLine.setAttribute('y1', TRUNK_Y); trunkLine.setAttribute('y2', TRUNK_Y);
    trunkLine.setAttribute('class', 'branch-graph-trunk');
    svg.appendChild(trunkLine);

    const trunkLabel = document.createElementNS(ns, 'text');
    trunkLabel.setAttribute('x', PAD_L); trunkLabel.setAttribute('y', TRUNK_Y - 8);
    trunkLabel.setAttribute('class', 'branch-graph-axis-label');
    trunkLabel.textContent = vm.trunk;
    svg.appendChild(trunkLabel);

    // ARC describes the horizontal extent of each diverge/return bezier.
    // Minimum so even single-day branches show as recognizable arcs even
    // when xEnd === xStart on the calendar.
    const ARC = 18;
    for (let i = 0; i < N; i++) {
      const b = branches[i];
      const y = rowY(i);
      let xStart = xAt(b.firstEventAt);
      const endIso = b.mergedAt || b.lastEventAt;
      let xEnd = xAt(endIso);
      // Guarantee a visible bar: each row's lifecycle bar is at least
      // 2 × ARC wide. Extend toward the right if the natural xEnd is
      // too close (preserves the visual diverge X on the trunk).
      const minBarEnd = xStart + ARC * 3;
      if (xEnd < minBarEnd) xEnd = minBarEnd;
      // Don't run into the gutter.
      xEnd = Math.min(xEnd, chartR);
      const barStartX = xStart + ARC;
      const barEndX = Math.max(barStartX + 8, xEnd - (b.status === 'merged' ? ARC : 0));

      // Head arc: trunk down to (barStartX, y).
      const headPath = 'M ' + xStart + ',' + TRUNK_Y +
        ' C ' + (xStart + ARC * 0.5) + ',' + TRUNK_Y +
        ' '  + (xStart + ARC * 0.5) + ',' + y +
        ' '  + barStartX + ',' + y;
      // Lane bar.
      const barPath = 'M ' + barStartX + ',' + y + ' L ' + barEndX + ',' + y;
      // Tail arc (only when merged): (barEndX, y) back up to trunk at xEnd.
      const tailPath = b.status === 'merged'
        ? 'M ' + barEndX + ',' + y +
          ' C ' + (xEnd - ARC * 0.5) + ',' + y +
          ' '  + (xEnd - ARC * 0.5) + ',' + TRUNK_Y +
          ' '  + xEnd + ',' + TRUNK_Y
        : null;

      function appendArc(d) {
        const arc = document.createElementNS(ns, 'path');
        arc.setAttribute('d', d);
        arc.setAttribute('class', 'branch-graph-arc ' + b.status);
        arc.setAttribute('data-branch', b.branch);
        return arc;
      }
      const headArc = appendArc(headPath);
      const barArc = appendArc(barPath);
      svg.appendChild(headArc);
      svg.appendChild(barArc);
      if (tailPath) svg.appendChild(appendArc(tailPath));

      // Diverge marker on trunk.
      const startMarker = document.createElementNS(ns, 'circle');
      startMarker.setAttribute('cx', xStart); startMarker.setAttribute('cy', TRUNK_Y);
      startMarker.setAttribute('r', 4);
      startMarker.setAttribute('class', 'branch-graph-marker ' + b.status);
      svg.appendChild(startMarker);

      // End marker.
      const endMarker = document.createElementNS(ns, 'circle');
      endMarker.setAttribute('r', 4);
      if (b.status === 'merged') {
        endMarker.setAttribute('cx', xEnd);
        endMarker.setAttribute('cy', TRUNK_Y);
        endMarker.setAttribute('class', 'branch-graph-marker merged');
      } else {
        endMarker.setAttribute('cx', barEndX);
        endMarker.setAttribute('cy', y);
        const cls = b.status === 'open' ? 'open-end' : 'stale-end';
        endMarker.setAttribute('class', 'branch-graph-marker ' + cls);
      }
      svg.appendChild(endMarker);

      // Label in the fixed right gutter. No collision possible — each
      // branch has its own row.
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', labelX);
      label.setAttribute('y', y + 4);
      label.setAttribute('text-anchor', 'start');
      label.setAttribute('class', 'branch-graph-label');
      const startDate = fmtTickDate(new Date(b.firstEventAt).getTime());
      const endLabel = b.status === 'merged' && b.mergedAt
        ? '→ merged ' + fmtTickDate(new Date(b.mergedAt).getTime())
        : (b.status === 'stale'
            ? '→ stale since ' + fmtTickDate(new Date(b.lastEventAt).getTime())
            : '→ active');
      const raw = b.branch + '  ·  $' + Math.round(b.totalUsd) +
        '  ·  ' + b.sessionCount + ' sess  ·  ' + startDate + ' ' + endLabel;
      label.textContent = truncate(raw, 64);
      const tooltip = document.createElementNS(ns, 'title');
      tooltip.textContent = b.branch + ' — $' + b.totalUsd.toFixed(2) + ' · ' +
        b.sessionCount + ' sessions · ' + b.status +
        ' · started ' + startDate +
        (b.mergedAt ? ' · merged ' + fmtTickDate(new Date(b.mergedAt).getTime()) : '');
      label.appendChild(tooltip);
      svg.appendChild(label);

      // Click handler — featureKey wins, then prUrl.
      const target = b.featureKey
        ? '/feature/' + encodeURIComponent(b.featureKey)
        : (b.prUrl || null);
      if (target) {
        [headArc, barArc, label, startMarker, endMarker].forEach(function (el) {
          el.style.cursor = 'pointer';
          el.addEventListener('click', function () {
            if (b.featureKey) window.location.href = target;
            else window.open(target, '_blank', 'noopener');
          });
        });
      }
    }

    node.innerHTML = '';
    node.appendChild(svg);
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
        kept.push({ key: '__other_features__', name: 'other features', color: '#9CA3AF', totalUsd: otherUsd, pct: (otherUsd / total) * 100 });
      }

      container.innerHTML = kept.map((f) => {
        const striped = f.color === '__striped__' ? ' subbar-segment--striped' : '';
        const bg = f.color === '__striped__' ? '' : `background:${escapeAttr(f.color)};`;
        const title = escapeAttr(`${f.name}: $${f.totalUsd.toFixed(0)}`);
        return `<div class="subbar-segment${striped}" style="${bg}width:${f.pct.toFixed(2)}%" title="${title}"></div>`;
      }).join('');
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

  function truncate(s, n) {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
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

  function renderUnattributedCard() {
    const card = document.getElementById('unattributed-card');
    const dataNode = document.getElementById('trend-data');
    if (!card || !dataNode) return;
    let payload;
    try { payload = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
    const u = payload && payload.unattributed;
    if (!u) return;

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
      <button class="unatt-cta" type="button" data-clipboard="tokentrail infer-mainline">Run <code>tokentrail infer-mainline</code> →</button>
    `;

    const btn = card.querySelector('.unatt-cta');
    const original = btn.innerHTML;
    let restoreTimer = null;
    btn.addEventListener('click', async (e) => {
      const text = e.currentTarget.getAttribute('data-clipboard') || '';
      try {
        await navigator.clipboard.writeText(text);
        e.currentTarget.textContent = 'Copied ✓';
        clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => { e.currentTarget.innerHTML = original; }, 1500);
      } catch (err) {
        // Fallback: no-op; label doesn't flip. Not worth a toast for a copy failure on localhost.
      }
    });
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
      <polyline points="${pts}" fill="none" stroke="#6B7280" stroke-width="1.5" />
    </svg>`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderTrend();
    renderTrailElevation();
    renderBranchGraph();
    renderBurnPathsSubBars();
    renderUnattributedCard();
    setupRowExpanders();
    setupClusterJumps();
  });

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
