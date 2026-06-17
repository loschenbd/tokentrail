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
