(function () {
  function renderTrend() {
    const node = document.getElementById('trend-chart');
    const dataNode = document.getElementById('trend-data');
    if (!node || !dataNode || typeof uPlot === 'undefined') return;
    let series;
    try { series = JSON.parse(dataNode.textContent || '[]'); } catch (e) { return; }
    if (!Array.isArray(series) || series.length === 0) {
      node.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No data in window.</div>';
      return;
    }
    const xs = series.map((d) => new Date(d.date + 'T00:00:00').getTime() / 1000);
    const ys = series.map((d) => d.total);
    const commitsArr = series.map((d) => d.commits || 0);
    const prsArr = series.map((d) => d.prs || 0);

    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.style.display = 'none';
    node.style.position = 'relative';
    node.appendChild(tooltip);

    function fmtDate(unixSec) {
      const d = new Date(unixSec * 1000);
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    }
    function fmtUsd(n) {
      return '$' + (typeof n === 'number' ? n.toFixed(2) : n);
    }

    const opts = {
      width: node.clientWidth,
      height: 280,
      legend: { show: false },
      cursor: {
        drag: { x: false, y: false },
        points: { size: 7 },
      },
      scales: { x: { time: true } },
      series: [
        {},
        {
          label: 'Daily $',
          stroke: '#8b6f47',
          fill: 'rgba(139,111,71,0.2)',
          width: 2,
          points: { show: true, size: 4 },
        },
      ],
      axes: [
        { stroke: '#6b563d', grid: { stroke: 'rgba(139,111,71,0.15)' } },
        { stroke: '#6b563d', grid: { stroke: 'rgba(139,111,71,0.15)' }, values: (_self, ticks) => ticks.map((t) => '$' + Math.round(t)) },
      ],
      hooks: {
        setCursor: [
          (self) => {
            const { idx } = self.cursor;
            if (idx == null || idx < 0 || idx >= xs.length) {
              tooltip.style.display = 'none';
              return;
            }
            const x = xs[idx];
            const y = ys[idx];
            const commits = commitsArr[idx] || 0;
            const prs = prsArr[idx] || 0;
            tooltip.innerHTML =
              '<div class="chart-tooltip-date">' + fmtDate(x) + '</div>' +
              '<div class="chart-tooltip-value">' + fmtUsd(y) + '</div>' +
              '<div class="chart-tooltip-meta">' +
                commits + ' ' + (commits === 1 ? 'commit' : 'commits') +
                ' · ' + prs + ' ' + (prs === 1 ? 'PR' : 'PRs') +
              '</div>';
            tooltip.style.display = 'block';
            const left = self.valToPos(x, 'x');
            const top = self.valToPos(y, 'y');
            // Clamp inside the chart so the tooltip never gets clipped.
            const rect = node.getBoundingClientRect();
            const tw = tooltip.offsetWidth;
            const th = tooltip.offsetHeight;
            let px = left + 12;
            let py = top - th - 8;
            if (px + tw > rect.width) px = left - tw - 12;
            if (py < 0) py = top + 12;
            tooltip.style.left = px + 'px';
            tooltip.style.top = py + 'px';
          },
        ],
      },
    };
    // eslint-disable-next-line no-undef, no-new
    new uPlot(opts, [xs, ys], node);

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
    const node = document.getElementById('branch-graph');
    const dataNode = document.getElementById('branch-graph-data');
    if (!node || !dataNode) return;
    let vm;
    try { vm = JSON.parse(dataNode.textContent || 'null'); } catch (e) { return; }
    if (!vm || !Array.isArray(vm.branches) || vm.branches.length === 0) return;

    const branches = vm.branches.slice();
    // Sort by firstEventAt ascending — earliest branches stack at the top.
    branches.sort(function (a, b) {
      return a.firstEventAt < b.firstEventAt ? -1 : a.firstEventAt > b.firstEventAt ? 1 : 0;
    });

    // Vertical layout: 0-24 date axis, 24-48 title row, 48 = trunk Y,
    // then 36px per lane.
    const TRUNK_Y = 48;
    const LANE_HEIGHT = 36;
    const W = node.clientWidth || 800;
    const H = TRUNK_Y + branches.length * LANE_HEIGHT + 16;
    const pad = { l: 40, r: 40 };

    const windowStartMs = new Date(vm.windowStart + 'T00:00:00').getTime();
    const windowEndMs = new Date(vm.windowEnd + 'T23:59:59').getTime();

    function xAt(iso) {
      const t = new Date(iso).getTime();
      const clamped = Math.max(windowStartMs, Math.min(windowEndMs, t));
      const span = windowEndMs - windowStartMs;
      if (span <= 0) return pad.l + (W - pad.l - pad.r) / 2;
      return pad.l + ((clamped - windowStartMs) / span) * (W - pad.l - pad.r);
    }

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', H);
    svg.setAttribute('class', 'branch-graph');

    // Date axis ticks (above the trunk line).
    const xTicks = niceTimeTicks(windowStartMs, windowEndMs, 6);
    for (let i = 0; i < xTicks.length; i++) {
      const tx = xAt(new Date(xTicks[i]).toISOString());
      const tickLabel = document.createElementNS(ns, 'text');
      tickLabel.setAttribute('x', tx);
      tickLabel.setAttribute('y', 18);
      tickLabel.setAttribute('class', 'branch-graph-axis-label');
      tickLabel.setAttribute('text-anchor', 'middle');
      tickLabel.textContent = fmtTickDate(xTicks[i]);
      svg.appendChild(tickLabel);

      const grid = document.createElementNS(ns, 'line');
      grid.setAttribute('x1', tx); grid.setAttribute('x2', tx);
      grid.setAttribute('y1', TRUNK_Y); grid.setAttribute('y2', H - 4);
      grid.setAttribute('class', 'branch-graph-grid');
      svg.appendChild(grid);
    }

    // Trunk line.
    const trunkLine = document.createElementNS(ns, 'line');
    trunkLine.setAttribute('x1', pad.l); trunkLine.setAttribute('x2', W - pad.r);
    trunkLine.setAttribute('y1', TRUNK_Y); trunkLine.setAttribute('y2', TRUNK_Y);
    trunkLine.setAttribute('class', 'branch-graph-trunk');
    svg.appendChild(trunkLine);

    // One row per branch.
    for (let i = 0; i < branches.length; i++) {
      const b = branches[i];
      const laneY = TRUNK_Y + (i + 1) * LANE_HEIGHT;
      const x1 = xAt(b.firstEventAt);
      const endIso = b.mergedAt || b.lastEventAt;
      const x2 = xAt(endIso);
      const span = Math.max(20, x2 - x1);
      const cp = Math.min(40, span * 0.25);  // bezier handle offset
      const flatInset = Math.min(20, span * 0.15);

      const d =
        'M ' + x1 + ',' + TRUNK_Y +
        ' C ' + (x1 + cp) + ',' + TRUNK_Y + ' ' + (x1 + cp) + ',' + laneY + ' ' + (x1 + flatInset) + ',' + laneY +
        ' L ' + (x2 - flatInset) + ',' + laneY +
        ' C ' + (x2 - cp) + ',' + laneY + ' ' + (x2 - cp) + ',' + TRUNK_Y + ' ' + x2 + ',' + TRUNK_Y;

      const arc = document.createElementNS(ns, 'path');
      arc.setAttribute('d', d);
      arc.setAttribute('class', 'branch-graph-arc ' + b.status);
      arc.setAttribute('data-branch', b.branch);
      svg.appendChild(arc);

      // Click handler — featureKey wins, then prUrl, else no-op.
      const target = b.featureKey
        ? '/feature/' + encodeURIComponent(b.featureKey)
        : (b.prUrl || null);
      if (target) {
        arc.style.cursor = 'pointer';
        arc.addEventListener('click', function () {
          if (b.featureKey) window.location.href = target;
          else window.open(target, '_blank', 'noopener');
        });
      } else {
        arc.style.cursor = 'default';
      }

      // Start marker. If the branch pre-dates the window (firstEventAt is
      // before windowStart), draw an inward « chevron at the clamped x1
      // instead of a closed circle — communicates "this branch existed
      // before the window starts."
      const preDates = new Date(b.firstEventAt).getTime() < windowStartMs;
      if (preDates) {
        const chevron = document.createElementNS(ns, 'text');
        chevron.setAttribute('x', x1 - 2);
        chevron.setAttribute('y', TRUNK_Y + 4);
        chevron.setAttribute('text-anchor', 'middle');
        chevron.setAttribute('class', 'branch-graph-axis-label');
        chevron.textContent = '«';
        svg.appendChild(chevron);
      } else {
        const startMarker = document.createElementNS(ns, 'circle');
        startMarker.setAttribute('cx', x1); startMarker.setAttribute('cy', TRUNK_Y);
        startMarker.setAttribute('r', 4);
        startMarker.setAttribute('class', 'branch-graph-marker ' + b.status);
        svg.appendChild(startMarker);
      }

      // End marker: closed circle if merged, open circle if open/stale.
      const endMarker = document.createElementNS(ns, 'circle');
      endMarker.setAttribute('cx', x2); endMarker.setAttribute('cy', TRUNK_Y);
      endMarker.setAttribute('r', 4);
      const endClass = b.status === 'merged'
        ? 'branch-graph-marker merged'
        : (b.status === 'open' ? 'branch-graph-marker open-end' : 'branch-graph-marker stale-end');
      endMarker.setAttribute('class', endClass);
      svg.appendChild(endMarker);

      // Label — placed at the lane midpoint, truncated if too long.
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', (x1 + x2) / 2);
      label.setAttribute('y', laneY + 4);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'branch-graph-label');
      const statusText = b.status === 'merged' && b.mergedAt
        ? 'merged ' + fmtTickDate(new Date(b.mergedAt).getTime())
        : b.status;
      const raw = b.branch + '  $' + Math.round(b.totalUsd) + ' · ' + b.sessionCount + ' ' + (b.sessionCount === 1 ? 'session' : 'sessions') + ' · ' + statusText;
      label.textContent = truncate(raw, 56);
      const tooltip = document.createElementNS(ns, 'title');
      tooltip.textContent = b.branch + ' — $' + b.totalUsd.toFixed(2) + ' · ' + b.sessionCount + ' sessions · ' + b.status;
      label.appendChild(tooltip);
      svg.appendChild(label);
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
