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
    const features = payload.features || [];
    if (features.length === 0) {
      node.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No data in window.</div>';
      return;
    }

    // Stack order: bottom first (lowest stackPosition).
    const stackOrder = features.slice().sort((a, b) => a.stackPosition - b.stackPosition);
    const xs = days.map((d) => new Date(d.date + 'T00:00:00').getTime() / 1000);

    // Per-series cumulative ys (each series carries the running sum up to its band, inclusive).
    const seriesYs = stackOrder.map((feat, idx) => {
      return days.map((d) => {
        let sum = 0;
        for (let i = 0; i <= idx; i++) {
          sum += d.bands[stackOrder[i].key] || 0;
        }
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
    function fmtUsd(n) {
      return '$' + (typeof n === 'number' ? n.toFixed(2) : n);
    }
    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Striped fill: a tiny canvas pattern, created lazily so it's bound to the
    // chart's own canvas context (uPlot will call the fill function per draw).
    function makeStripePattern(ctx) {
      const p = document.createElement('canvas');
      p.width = 8; p.height = 8;
      const c = p.getContext('2d');
      c.fillStyle = '#6B7280';
      c.fillRect(0, 0, 8, 8);
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(-2, 10); c.lineTo(10, -2); c.stroke();
      c.beginPath(); c.moveTo(0, 14); c.lineTo(14, 0); c.stroke();
      return ctx.createPattern(p, 'repeat');
    }
    // For striped series, return a fill function that builds the pattern lazily.
    function fillFor(color) {
      if (color === '__striped__') {
        return (u) => {
          const ctx = u.ctx;
          if (!ctx._stripePattern) ctx._stripePattern = makeStripePattern(ctx);
          return ctx._stripePattern;
        };
      }
      // Slight transparency so band borders read; opaque inner color preserves identity.
      return hexToRgba(color, 0.92);
    }
    function hexToRgba(hex, alpha) {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      if (!m) return hex;
      return `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${alpha})`;
    }

    // uPlot series + bands wiring.
    // series[0] is the x-axis pseudo-series. Real series start at 1.
    const series = [{}].concat(stackOrder.map((feat) => ({
      label: feat.name,
      stroke: feat.color === '__striped__' ? '#4B5563' : feat.color,
      fill: fillFor(feat.color),
      width: 1,
      points: { show: false },
    })));
    // Bands: each band fills between series idx-1 and idx (idx = 2..N for stacked).
    // Band: { series: [topIdx, bottomIdx], fill }
    const bands = [];
    for (let i = 1; i < stackOrder.length; i++) {
      bands.push({ series: [i + 1, i] });
    }

    const data = [xs].concat(seriesYs);

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
            const d = days[idx];
            // Per-day breakdown sorted by $ desc, non-zero only.
            const rows = stackOrder
              .map((f) => ({ key: f.key, name: f.name, color: f.color, usd: d.bands[f.key] || 0 }))
              .filter((r) => r.usd > 0)
              .sort((a, b) => b.usd - a.usd);
            const total = d.total || 0;
            const denom = total > 0 ? total : 1;
            let body = '<div class="chart-tooltip-date">' + fmtDate(xs[idx]) + '</div>' +
              '<div class="chart-tooltip-value">' + fmtUsd(total) + '</div>';
            if (total === 0) {
              body += '<div class="chart-tooltip-meta">no activity</div>';
            } else {
              body += '<div class="chart-tooltip-rows">';
              for (const r of rows) {
                const pct = Math.round((r.usd / denom) * 100);
                const swatch = r.color === '__striped__'
                  ? '<span class="tooltip-swatch swatch--striped"></span>'
                  : '<span class="tooltip-swatch" style="background:' + esc(r.color) + '"></span>';
                body += '<div class="chart-tooltip-row">' + swatch +
                  '<span class="name">' + esc(r.name) + '</span>' +
                  '<span class="amt">' + fmtUsd(r.usd) + ' <span class="muted">(' + pct + '%)</span></span></div>';
              }
              body += '</div>';
            }
            body += '<div class="chart-tooltip-meta">' +
              (d.commits || 0) + ' ' + ((d.commits || 0) === 1 ? 'commit' : 'commits') +
              ' · ' + (d.prs || 0) + ' ' + ((d.prs || 0) === 1 ? 'PR' : 'PRs') +
              '</div>';
            tooltip.innerHTML = body;
            tooltip.style.display = 'block';

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

    node.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
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

  document.addEventListener('DOMContentLoaded', () => {
    renderTrend();
    renderTrailElevation();
    renderBranchGraph();
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
