(function() {
  const root = document.querySelector('[data-trail-map]');
  if (!root) return;

  // ═══════════════════════════════════════════════════════════════════
  //  GEOGRAPHY: 78 × 22  (lifted from user-supplied HTML — do not edit)
  // ═══════════════════════════════════════════════════════════════════
  const BG = [
    "♣♣♣ ♣♣♣  ♣♣♣   ♣♣  ▲  ▲ ▲                        ▲  ▲ ▲  ▲▲   ▲▲▲  ▲ ▲▲",
    "♣♣♣♣♣♣♣ ♣♣♣♣  ♣♣♣  ▲▲  ▲▲         · · ·           ▲▲ ▲▲▲  ▲▲   ▲▲▲▲ ▲▲▲",
    " ♣♣♣♣♣♣ ♣♣♣♣  ♣♣   ▲▲▲  ▲         · · · ·          ▲▲▲ ▲▲   ▲    ▲▲▲▲ ▲▲",
    "  ♣♣♣♣♣  ♣♣♣  ♣♣    ▲▲            · · · ·                              ▲  ",
    "   ♣♣♣♣  ♣♣♣  ♣      ▲            · · · ·                                 ",
    "    ♣♣♣   ♣♣          ▲           · · · · ·         ≈ ≈ ≈ ≈               ",
    "     ♣♣   ♣            ·          · · · · ·        ≈ ≈ ≈ ≈ ≈ ≈            ",
    "      ♣               · ·        · · · · · ·      ≈ ≈ ≈   ≈ ≈ ≈ ≈",
    "                      · · ·     · · · · · · ·   ≈ ≈ ≈       ≈ ≈ ≈ ≈",
    "   ♣ ♣                · · · ·  · · · · · ·     ≈ ≈ ≈ ≈         ≈ ≈ ≈",
    "  ♣♣ ♣♣               · · · · · · · · ·       ≈ ≈ ≈ ≈ ≈          ≈ ≈ ≈",
    "   ♣♣ ♣                · · · · · · · ·       ≈ ≈ ≈ ≈ ≈ ≈            ≈",
    "    ♣♣                  · · · · · · ·       ≈ ≈ ≈ ≈ ≈ ≈ ≈",
    "     ♣                   · · · · · ·       ≈ ≈ ≈ ≈ ≈",
    "                          · · · · ·       ≈ ≈ ≈ ≈ ≈                       ",
    "  ∿ ∿ ∿ ∿                  · · · ·       ≈ ≈ ≈                  ~ ~ ~ ~   ",
    " ∿ ∿ ∿ ∿ ∿ ∿               · · ·                              ~ ~ ~ ~ ~ ~ ",
    "  ∿ ∿ ∿ ∿ ∿ ∿               · ·                              ~ ~ ~ ~ ~ ~  ",
    "   ∿ ∿ ∿ ∿ ∿                 ·             ▲ ▲             ~ ~ ~ ~ ~ ~    ",
    "    ∿ ∿ ∿ ∿                              ▲ ▲ ▲ ▲         ~ ~ ~ ~ ~ ~      ",
    "     ∿ ∿ ∿                             ▲ ▲ ▲ ▲ ▲ ▲     ~ ~ ~ ~ ~         ",
    "      ∿ ∿                            ▲ ▲ ▲ ▲ ▲ ▲ ▲ ▲ ~ ~ ~ ~             ",
  ];

  // ── TRAIL (lifted from user-supplied HTML — do not edit) ─────────────
  const TRAIL = [
    {type:'label', r:11, c:0, text:'project*'},
    {type:'path',  r:11, c:8, ch:'─'},
    {type:'path',  r:11, c:9, ch:'─'},
    {type:'coin',  r:11, c:10},
    {type:'cost',  r:10, c:8,  text:'$12'},
    {type:'path',  r:11, c:11, ch:'─'},
    {type:'path',  r:11, c:12, ch:'─'},
    {type:'path',  r:11, c:13, ch:'─'},
    {type:'branch',r:11, c:14, ch:'┬'},
    {type:'label', r:4,  c:27, text:'swiftbar'},
    {type:'path',  r:10, c:14, ch:'│'},
    {type:'path',  r:9,  c:14, ch:'│'},
    {type:'path',  r:8,  c:13, ch:'╱'},
    {type:'path',  r:7,  c:14, ch:'─'},
    {type:'coin',  r:7,  c:15},
    {type:'path',  r:6,  c:18, ch:'─'},
    {type:'coin',  r:6,  c:19},
    {type:'cost',  r:5,  c:17, text:'$47'},
    {type:'path',  r:5,  c:22, ch:'╲'},
    {type:'merge', r:4,  c:23, pr:'#1'},
    {type:'path',  r:11, c:14, ch:'─'},
    {type:'path',  r:11, c:15, ch:'─'},
    {type:'coin',  r:11, c:16},
    {type:'cost',  r:12, c:14, text:'$35'},
    {type:'path',  r:11, c:19, ch:'─'},
    {type:'path',  r:11, c:20, ch:'─'},
    {type:'branch',r:11, c:21, ch:'┼'},
    {type:'label', r:9,  c:15, text:'swiftbar-projects'},
    {type:'path',  r:12, c:21, ch:'│'},
    {type:'path',  r:13, c:21, ch:'╲'},
    {type:'path',  r:14, c:22, ch:'─'},
    {type:'coin',  r:14, c:23},
    {type:'path',  r:14, c:26, ch:'─'},
    {type:'coin',  r:14, c:27},
    {type:'cost',  r:13, c:25, text:'$32'},
    {type:'path',  r:15, c:28, ch:'╲'},
    {type:'path',  r:16, c:29, ch:'─'},
    {type:'coin',  r:16, c:30},
    {type:'cost',  r:15, c:29, text:'$18'},
    {type:'path',  r:16, c:33, ch:'─'},
    {type:'merge', r:17, c:34, pr:'#2,3'},
    {type:'path',  r:11, c:22, ch:'─'},
    {type:'path',  r:11, c:23, ch:'─'},
    {type:'coin',  r:11, c:24},
    {type:'path',  r:11, c:27, ch:'─'},
    {type:'path',  r:11, c:28, ch:'─'},
    {type:'coin',  r:11, c:29},
    {type:'path',  r:11, c:32, ch:'─'},
    {type:'path',  r:11, c:33, ch:'─'},
    {type:'branch',r:11, c:34, ch:'┬'},
    {type:'label', r:10, c:35, text:'mainline-stale'},
    {type:'path',  r:10, c:34, ch:'│'},
    {type:'path',  r:9,  c:34, ch:'╱'},
    {type:'path',  r:8,  c:35, ch:'─'},
    {type:'coin',  r:8,  c:36},
    {type:'cost',  r:7,  c:35, text:'$24'},
    {type:'path',  r:7,  c:39, ch:'╲'},
    {type:'merge', r:6,  c:40, pr:'#4'},
    {type:'path',  r:11, c:35, ch:'─'},
    {type:'path',  r:11, c:36, ch:'─'},
    {type:'coin',  r:11, c:37},
    {type:'cost',  r:12, c:36, text:'$14'},
    {type:'path',  r:11, c:40, ch:'─'},
    {type:'path',  r:11, c:41, ch:'─'},
    {type:'coin',  r:11, c:42},
    {type:'path',  r:11, c:45, ch:'─'},
    {type:'path',  r:11, c:46, ch:'─'},
    {type:'branch',r:11, c:47, ch:'┼'},
    {type:'label', r:9,  c:35, text:'claude-integrations'},
    {type:'path',  r:12, c:47, ch:'│'},
    {type:'path',  r:13, c:47, ch:'╲'},
    {type:'path',  r:14, c:48, ch:'─'},
    {type:'coin',  r:14, c:49},
    {type:'path',  r:14, c:52, ch:'─'},
    {type:'coin',  r:14, c:53},
    {type:'cost',  r:13, c:51, text:'$83'},
    {type:'anom',  r:13, c:55, text:'!'},
    {type:'label', r:13, c:56, text:'hot_session'},
    {type:'path',  r:15, c:54, ch:'╲'},
    {type:'path',  r:16, c:55, ch:'─'},
    {type:'coin',  r:16, c:56},
    {type:'cost',  r:15, c:55, text:'$61'},
    {type:'path',  r:16, c:59, ch:'─'},
    {type:'merge', r:17, c:60, pr:'#6,7'},
    {type:'path',  r:11, c:48, ch:'─'},
    {type:'path',  r:11, c:49, ch:'─'},
    {type:'coin',  r:11, c:50},
    {type:'path',  r:11, c:53, ch:'─'},
    {type:'path',  r:11, c:54, ch:'─'},
    {type:'coin',  r:11, c:55},
    {type:'path',  r:11, c:58, ch:'─'},
    {type:'path',  r:11, c:59, ch:'─'},
    {type:'branch',r:11, c:60, ch:'┬'},
    {type:'label', r:12, c:61, text:'anomalies-cmd'},
    {type:'path',  r:10, c:60, ch:'│'},
    {type:'path',  r:9,  c:60, ch:'╱'},
    {type:'path',  r:8,  c:61, ch:'─'},
    {type:'coin',  r:8,  c:62},
    {type:'path',  r:7,  c:65, ch:'╲'},
    {type:'path',  r:6,  c:66, ch:'─'},
    {type:'coin',  r:6,  c:67},
    {type:'cost',  r:5,  c:66, text:'$29'},
    {type:'path',  r:5,  c:70, ch:'─'},
    {type:'coin',  r:5,  c:71},
    {type:'cost',  r:4,  c:70, text:'$74'},
    {type:'anom',  r:4,  c:68, text:'!'},
    {type:'label', r:2,  c:67, text:'spike_day'},
    {type:'path',  r:4,  c:74, ch:'╲'},
    {type:'merge', r:3,  c:75, pr:'#9,11'},
    {type:'path',  r:11, c:61, ch:'─'},
    {type:'path',  r:11, c:62, ch:'─'},
    {type:'coin',  r:11, c:63},
    {type:'path',  r:11, c:66, ch:'─'},
    {type:'path',  r:11, c:67, ch:'─'},
    {type:'coin',  r:11, c:68},
    {type:'path',  r:11, c:71, ch:'─'},
    {type:'path',  r:11, c:72, ch:'─'},
    {type:'path',  r:11, c:73, ch:'─'},
    {type:'cost',  r:10, c:68, text:'total:$429'},
    {type:'trophy', r:9,  c:74, text:'⚑'},
    {type:'trophy', r:10, c:74, text:'|'},
    {type:'trophy', r:11, c:74, text:'|'},
    {type:'label',  r:13, c:73, text:'v1.0✓'},
  ];

  // ─── BUILD FRAME ──────────────────────────────────────────────────────
  function baseGrid() {
    return BG.map(l => l.padEnd(80, ' ').split(''));
  }
  function buildFrame(visible, flash) {
    const grid = baseGrid();
    let mergedCount = 0, anomCount = 0;
    for (let i = 0; i < visible && i < TRAIL.length; i++) {
      const s = TRAIL[i];
      const f = flash ? 'F' : 'N';
      if (s.type === 'coin') {
        if (s.c > 0)    grid[s.r][s.c-1] = `\x01CL${f}\x01`;
        grid[s.r][s.c]  = `\x01CM${f}\x01`;
        if (s.c+1 < 80) grid[s.r][s.c+1] = `\x01CR${f}\x01`;
      } else if (s.type === 'path') {
        grid[s.r][s.c] = `\x01PA${s.ch}\x01`;
      } else if (s.type === 'branch') {
        grid[s.r][s.c] = `\x01BR${s.ch}\x01`;
      } else if (s.type === 'label') {
        for (let ci = 0; ci < s.text.length && s.c+ci < 80; ci++)
          grid[s.r][s.c+ci] = `\x01LA${s.text[ci]}\x01`;
      } else if (s.type === 'cost') {
        for (let ci = 0; ci < s.text.length && s.c+ci < 80; ci++)
          grid[s.r][s.c+ci] = `\x01CO${s.text[ci]}\x01`;
      } else if (s.type === 'anom') {
        grid[s.r][s.c] = `\x01AN${s.text}\x01`;
        anomCount++;
      } else if (s.type === 'trophy') {
        const glyph = flash ? 'TF' : 'TN';
        for (let ci = 0; ci < s.text.length && s.c+ci < 80; ci++)
          grid[s.r][s.c+ci] = `\x01${glyph}${s.text[ci]}\x01`;
      } else if (s.type === 'merge') {
        grid[s.r][s.c] = `\x01ME${f}X\x01`;
        const pr = s.pr || '';
        for (let ci = 0; ci < pr.length && s.c+2+ci < 80; ci++)
          grid[s.r][s.c+2+ci] = `\x01LA${pr[ci]}\x01`;
        mergedCount++;
      }
    }
    const lines = grid.map(row => {
      let line = row.join('')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      line = line.replace(/▲/g, '<span class="mtn">▲</span>');
      line = line.replace(/♣/g, '<span class="tree">♣</span>');
      line = line.replace(/≈/g, '<span class="water">≈</span>');
      line = line.replace(/·/g, '<span class="plain">·</span>');
      line = line.replace(/∿/g, '<span class="marsh">∿</span>');
      line = line.replace(/~/g, '<span class="sand">~</span>');
      line = line.replace(/\x01CL(.)\x01/g, (_, f) =>
        `<span class="${f==='F'?'spark-rim':'tok-rim'}">(</span>`);
      line = line.replace(/\x01CM(.)\x01/g, (_, f) =>
        `<span class="${f==='F'?'spark-face':'tok-face'}">⊙</span>`);
      line = line.replace(/\x01CR(.)\x01/g, (_, f) =>
        `<span class="${f==='F'?'spark-rim':'tok-rim'}">)</span>`);
      line = line.replace(/\x01PA(.)\x01/g, (_, ch) => `<span class="path">${ch}</span>`);
      line = line.replace(/\x01BR(.)\x01/g, (_, ch) => `<span class="branch">${ch}</span>`);
      line = line.replace(/\x01LA(.)\x01/g, (_, ch) => `<span class="tm-label">${ch}</span>`);
      line = line.replace(/\x01CO(.)\x01/g, (_, ch) => `<span class="cost-tag">${ch}</span>`);
      line = line.replace(/\x01AN(.)\x01/g, (_, ch) => `<span class="anom">${ch}</span>`);
      line = line.replace(/\x01TF(.)\x01/g, (_, ch) => `<span class="trophy-flash">${ch}</span>`);
      line = line.replace(/\x01TN(.)\x01/g, (_, ch) => `<span class="trophy">${ch}</span>`);
      line = line.replace(/\x01ME(.)(.)\x01/g, (_, f, ch) => {
        if (ch === ' ') return ' ';
        if (ch === 'X') return `<span class="merged" style="font-size:1.4em;line-height:1;vertical-align:middle">X</span>`;
        return `<span class="merged">${ch}</span>`;
      });
      return line;
    });
    return { html: lines.join('\n'), mergedCount, anomCount };
  }

  // ─── DOM hooks (scoped to root) ──────────────────────────────────────
  const el = root.querySelector('#ascii');
  const prsEl = root.querySelector('#prs');
  const anomEl = root.querySelector('#anom-count');
  const anomSubEl = root.querySelector('#anom-sub');
  const costTodayEl = root.querySelector('#cost-today');
  const costSubEl = root.querySelector('#cost-sub');
  const sessCountEl = root.querySelector('#sess-count');

  // ─── Clipboard CTA (onboarding only) ─────────────────────────────────
  root.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const text = btn.getAttribute('data-copy') || '';
      try { await navigator.clipboard.writeText(text); } catch (_) { /* no-op */ }
      const original = btn.textContent;
      btn.classList.add('btn-copied');
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('btn-copied');
        btn.textContent = original;
      }, 1200);
    });
  });

  // ─── ANIMATION ────────────────────────────────────────────────────────
  let step = 0, phase = 'reveal';
  const STEP_MS = 100, HOLD_MS = 2400, FLASH_MS = 220, RESET_MS = 1100;
  function tick() {
    let delay;
    if (phase === 'reveal') {
      const { html, mergedCount, anomCount } = buildFrame(step, false);
      el.innerHTML = html;
      prsEl.textContent = mergedCount;
      anomEl.textContent = anomCount || '—';
      anomSubEl.textContent = anomCount === 2 ? '1 hot_session · 1 spike_day' : anomCount === 1 ? '1 active' : 'none detected';
      step++;
      if (step > TRAIL.length) { phase = 'hold'; delay = HOLD_MS; }
      else delay = STEP_MS;
    } else if (phase === 'hold') {
      const { html, mergedCount, anomCount } = buildFrame(TRAIL.length, true);
      el.innerHTML = html; prsEl.textContent = mergedCount;
      anomEl.textContent = anomCount;
      phase = 'flash'; delay = FLASH_MS;
    } else if (phase === 'flash') {
      const { html, mergedCount } = buildFrame(TRAIL.length, false);
      el.innerHTML = html; prsEl.textContent = mergedCount;
      phase = 'flash2'; delay = FLASH_MS;
    } else if (phase === 'flash2') {
      const { html, mergedCount } = buildFrame(TRAIL.length, true);
      el.innerHTML = html; prsEl.textContent = mergedCount;
      phase = 'reset'; delay = FLASH_MS;
    } else {
      const { html } = buildFrame(0, false);
      el.innerHTML = html; prsEl.textContent = 0;
      anomEl.textContent = '—'; anomSubEl.textContent = 'active';
      step = 0; phase = 'reveal'; delay = RESET_MS;
    }
    setTimeout(tick, delay);
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    const { html, mergedCount, anomCount } = buildFrame(TRAIL.length, false);
    el.innerHTML = html;
    prsEl.textContent = mergedCount;
    anomEl.textContent = anomCount;
  } else {
    tick();
  }

  // ─── STATS animation ──────────────────────────────────────────────────
  let costToday = 0, sessToday = 4;
  costTodayEl.textContent = '—';
  sessCountEl.textContent = sessToday;
  function tickStats() {
    costToday = Math.min(74.30, costToday + (Math.random() * 0.25 + 0.08));
    if (Math.random() < 0.012) sessToday++;
    costTodayEl.textContent = '$' + costToday.toFixed(2);
    costSubEl.textContent = 'of $429 total · all time';
    sessCountEl.textContent = sessToday;
  }
  if (!reduced) setTimeout(() => setInterval(tickStats, 700), 500);
})();
