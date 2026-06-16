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
            tooltip.innerHTML =
              '<div class="chart-tooltip-date">' + fmtDate(x) + '</div>' +
              '<div class="chart-tooltip-value">' + fmtUsd(y) + '</div>';
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

  document.addEventListener('DOMContentLoaded', () => {
    renderTrend();
    setupRowExpanders();
  });
})();
