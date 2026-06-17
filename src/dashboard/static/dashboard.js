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
    setupRowExpanders();
    setupClusterJumps();
  });
})();

(function () {
  const pre = document.getElementById('mascot');
  const dataNode = document.getElementById('mascot-frames');
  if (!pre || !dataNode) return;
  let bundle;
  try { bundle = JSON.parse(dataNode.textContent || ''); } catch (e) { return; }
  if (!bundle || !Array.isArray(bundle.frames) || bundle.frames.length === 0) return;

  function render(idx) {
    const f = bundle.frames[idx] || bundle.frames[bundle.centerIndex];
    pre.textContent = f.grid.map(function (row) { return row.join(''); }).join('\n');
  }
  render(bundle.centerIndex);

  function driftIndex(t) {
    const ix = Math.sin(t) > 0 ? 3 : 1;
    const iy = Math.cos(t * 0.7) > 0 ? 0 : 2;
    return iy * 5 + ix;
  }

  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    let t = 0;
    setInterval(function () { t += 0.03; render(driftIndex(t)); }, 80);
    return;
  }

  let lastIdx = bundle.centerIndex;
  let idleTimer = setTimeout(startDrift, 2000);
  let driftHandle = null;
  let lastMove = 0;

  function indexFromCursor(e) {
    const rect = pre.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / 320));
    const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / 240));
    const ix = Math.round((dx + 1) * 2);
    const iy = Math.round(dy + 1);
    return iy * 5 + ix;
  }

  function startDrift() {
    if (driftHandle) return;
    let t = 0;
    driftHandle = setInterval(function () { t += 0.03; render(driftIndex(t)); }, 80);
  }

  const HOVER_MARGIN = 200; // px around the mascot before we stop tracking

  window.addEventListener('mousemove', function (e) {
    const now = performance.now();
    if (now - lastMove < 30) return;
    lastMove = now;
    const rect = pre.getBoundingClientRect();
    const inRange =
      e.clientX >= rect.left - HOVER_MARGIN &&
      e.clientX <= rect.right + HOVER_MARGIN &&
      e.clientY >= rect.top - HOVER_MARGIN &&
      e.clientY <= rect.bottom + HOVER_MARGIN;
    if (!inRange) {
      if (!driftHandle) startDrift();
      return;
    }
    if (driftHandle) { clearInterval(driftHandle); driftHandle = null; }
    const idx = indexFromCursor(e);
    if (idx !== lastIdx) { lastIdx = idx; render(idx); }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(startDrift, 2000);
  });
})();
