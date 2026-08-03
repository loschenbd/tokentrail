import type { FeatureDetailVM } from '../data/feature.js';
import { escapeHtml, jsonForScriptTag } from './shell.js';
import { colorFor, STRIPED_SENTINEL } from '../lib/feature-colors.js';

// Same lifecycle glyphs as the project page (◇ opened / ✓ closed / ☾ stale).
const FEATURE_STATUS: Record<FeatureDetailVM['status'], { glyph: string; label: string }> = {
  opened: { glyph: '◇', label: 'opened' },
  closed: { glyph: '✓', label: 'closed' },
  stale: { glyph: '☾', label: 'stale' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthDay(iso: string | null): string {
  if (!iso) return '';
  const d = iso.slice(0, 10).split('-');
  if (d.length !== 3) return '';
  const m = Number(d[1]) - 1;
  return `${MONTHS[m] ?? ''} ${Number(d[2])}`.trim();
}

export function renderFeature(vm: FeatureDetailVM): string {
  const color = colorFor(vm.featureKey);
  const swatch = color === STRIPED_SENTINEL
    ? '<span class="swatch swatch--striped" style="vertical-align:middle"></span>'
    : `<span class="swatch" style="background:${color};vertical-align:middle"></span>`;
  const st = FEATURE_STATUS[vm.status];

  return `
<div class="fp-page">

  ${renderHeader(vm, swatch, st)}

  <div class="fp-grid">
    <div class="fp-main">
      ${renderShipped(vm)}
      ${renderLedger(vm)}
    </div>
    <div class="fp-rail">
      ${renderActivity(vm)}
      ${renderTopics(vm)}
    </div>
  </div>
</div>
  `;
}

// ① Statement header — computed stats, honest efficiency chips, no fake delta.
function renderHeader(vm: FeatureDetailVM, swatch: string, st: { glyph: string; label: string }): string {
  const chips: string[] = [];
  const chip = (v: string, k: string, eff = false) =>
    `<span class="fp-chip${eff ? ' fp-chip-eff' : ''}"><b>${v}</b><span class="fp-chip-k">${k}</span></span>`;
  chips.push(chip(String(vm.mergedPrCount), vm.mergedPrCount === 1 ? 'PR shipped' : 'PRs shipped'));
  chips.push(chip(String(vm.commitCount), vm.commitCount === 1 ? 'commit' : 'commits'));
  if (vm.releaseCount > 0) chips.push(chip(String(vm.releaseCount), vm.releaseCount === 1 ? 'release' : 'releases'));
  chips.push(chip(String(vm.sessionCount), vm.sessionCount === 1 ? 'session' : 'sessions'));
  if (vm.costPerPr !== null) chips.push(chip(`~$${vm.costPerPr.toFixed(0)}`, '/ merged PR', true));
  if (vm.costPerCommit !== null) chips.push(chip(`~$${vm.costPerCommit.toFixed(0)}`, '/ commit', true));

  const delta = vm.deltaPct === null
    ? ''
    : `<span class="fp-delta ${vm.deltaPct >= 0 ? 'up' : 'down'}">${vm.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(vm.deltaPct)}% vs prior</span>`;

  return `
  <div class="card fp-header">
    <div class="fp-eyebrow">${escapeHtml(vm.featureKey)}${vm.branches.length === 0 ? '' : ' · ' + vm.branches.map((b) => escapeHtml(b)).join(', ')}</div>
    <div class="fp-name">${swatch}<span>${escapeHtml(vm.featureName)}</span><span class="fp-status fp-status-${vm.status}" aria-label="${st.label}" title="${st.label}">${st.glyph}</span></div>
    <div class="fp-total">$${vm.totalUsd.toFixed(0)}<span class="fp-est">estimated</span>${delta}</div>
    <div class="fp-chips">${chips.join('')}</div>
  </div>`;
}

// ② What shipped — merged PRs grouped under their release, newest first.
function renderShipped(vm: FeatureDetailVM): string {
  if (vm.releases.length === 0) {
    return `
  <div class="card">
    <div class="label">What shipped</div>
    <div class="muted">No commits or pull requests recorded in this window yet.</div>
  </div>`;
  }
  const range = shippedRange(vm);
  const groups = vm.releases.map((r) => {
    const tag = r.version
      ? `<span class="fp-rel-tag">${escapeHtml(r.version)}</span>`
      : `<span class="fp-rel-tag fp-rel-unreleased">Unreleased</span>`;
    const meta = [monthDay(r.date), r.changeCommitCount > 0 ? `${r.changeCommitCount} commit${r.changeCommitCount === 1 ? '' : 's'}` : '']
      .filter(Boolean)
      .join(' · ');
    const prs = r.prs
      .map((p) => {
        const inner = `<span class="fp-pr-num">#${p.prNumber}</span><span class="fp-pr-title">${escapeHtml(p.title)}</span><span class="fp-badge-merged">merged</span>`;
        return p.url
          ? `<a class="fp-pr-row" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${inner}</a>`
          : `<div class="fp-pr-row">${inner}</div>`;
      })
      .join('');
    const extra = r.prs.length === 0 && r.changeCommitCount > 0
      ? `<div class="fp-rel-extra">${r.changeCommitCount} change commit${r.changeCommitCount === 1 ? '' : 's'} (no PR)</div>`
      : '';
    return `
      <div class="fp-rel-group">
        <div class="fp-rel-head">${tag}<span class="fp-rel-line"></span><span class="fp-rel-meta">${escapeHtml(meta)}</span></div>
        ${prs}${extra}
      </div>`;
  });
  return `
  <div class="card">
    <div class="label">What shipped${range ? ` <span class="fp-zone-note">${escapeHtml(range)}</span>` : ''}</div>
    ${groups.join('')}
  </div>`;
}

function shippedRange(vm: FeatureDetailVM): string {
  const versions = vm.releases.map((r) => r.version).filter((v): v is string => !!v);
  if (versions.length === 0) return '';
  const first = versions[versions.length - 1];
  const last = versions[0];
  return first === last ? first! : `${first} → ${last}`;
}

// ③ Cost & activity — adaptive: client renders a full daily chart (≥5 active
// days) or an event strip (sparse). Data handed off as a JSON payload.
function renderActivity(vm: FeatureDetailVM): string {
  const payload = { activeDays: vm.activeDays, dailySeries: vm.dailySeries, events: vm.events };
  return `
  <div class="card">
    <div class="label">Cost &amp; activity</div>
    <div id="feature-activity" data-feature-activity style="width:100%"></div>
    <script type="application/json" id="feature-activity-data">${jsonForScriptTag(payload)}</script>
  </div>`;
}

// ④ Sessions ledger — trace-waterfall rows, collapsed, expand → commits + PRs.
function renderLedger(vm: FeatureDetailVM): string {
  if (vm.sessions.length === 0) {
    return `
  <div class="card">
    <div class="label">Sessions</div>
    <div class="muted">No sessions in window.</div>
  </div>`;
  }
  const denom = vm.totalUsd > 0 ? vm.totalUsd : 1;
  const rows = vm.sessions
    .map((s, i) => {
      const detailsId = `session-${i}-details`;
      const pct = Math.max(2, Math.min(100, (s.cost / denom) * 100));
      const meta = [monthDay(s.date), `${s.commits.length} commit${s.commits.length === 1 ? '' : 's'}`,
        `${s.prs.length} PR${s.prs.length === 1 ? '' : 's'}`, s.sessionId.slice(0, 8)]
        .filter(Boolean)
        .join(' · ');
      return `
        <div class="fp-ses-row" id="session-${escapeHtml(s.sessionId)}" data-expand-target="${detailsId}">
          <div class="fp-ses-main"><span class="fp-ses-caret">▶</span><span class="fp-ses-title">${escapeHtml((s.title ?? '(no title)').slice(0, 140))}</span></div>
          <div class="fp-ses-amt">$${s.cost.toFixed(0)}</div>
          <div class="fp-ses-bar-wrap"><div class="fp-ses-bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="fp-ses-meta">${escapeHtml(meta)}</span></div>
        </div>
        <div class="fp-ses-detail" id="${detailsId}">
          ${renderCommitsBlock(s.commits)}
          ${renderPrsBlock(s.prs)}
          ${s.commits.length === 0 && s.prs.length === 0 ? '<div class="muted">No commits or PRs linked to this session.</div>' : ''}
        </div>`;
    })
    .join('');
  const note = vm.sessions.length > 1
    ? `<div class="fp-rel-extra" style="padding-left:10px">Bar = share of the $${vm.totalUsd.toFixed(0)} feature total; session cost is its share of this feature.</div>`
    : '';
  return `
  <div class="card">
    <div class="label">Sessions <span class="fp-zone-note">ranked by cost</span></div>
    ${rows}
    ${note}
  </div>`;
}

// ⑤ Topics — part-to-whole, horizontal bars, capped at 5 rows + "Other".
function renderTopics(vm: FeatureDetailVM): string {
  if (vm.clusters.length === 0) return '';
  const denom = vm.totalUsd > 0 ? vm.totalUsd : 1;
  const sorted = [...vm.clusters].sort((a, b) => b.totalUsd - a.totalUsd);
  const CAP = 5;
  let shown = sorted;
  let other: { totalUsd: number; count: number } | null = null;
  if (sorted.length > CAP) {
    shown = sorted.slice(0, CAP - 1);
    const tail = sorted.slice(CAP - 1);
    other = { totalUsd: tail.reduce((s, c) => s + c.totalUsd, 0), count: tail.length };
  }
  const lead = shown[0]?.totalUsd ?? 1;
  const rows = shown.map((c) => topicRow(c.name, c.totalUsd, c.totalUsd / (lead || 1), c.totalUsd / denom));
  if (other) {
    rows.push(topicRow(`Other · ${other.count}`, other.totalUsd, other.totalUsd / (lead || 1), other.totalUsd / denom));
  }
  return `
  <div class="card">
    <div class="label">Topics</div>
    ${rows.join('')}
  </div>`;
}

function topicRow(name: string, usd: number, widthFrac: number, shareFrac: number): string {
  const w = Math.max(2, Math.min(100, widthFrac * 100));
  return `
    <div class="fp-topic-row">
      <span class="fp-topic-name">${escapeHtml(name)}</span>
      <span class="fp-topic-bar"><i style="width:${w.toFixed(1)}%"></i></span>
      <span class="fp-topic-meta">$${usd.toFixed(0)} · ${Math.round(shareFrac * 100)}%</span>
    </div>`;
}

function isGithubSlug(repo: string | null): repo is string {
  if (!repo) return false;
  if (repo.startsWith('local/')) return false;
  const parts = repo.split('/');
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0;
}

function renderCommitsBlock(commits: FeatureDetailVM['sessions'][number]['commits']): string {
  if (commits.length === 0) return '';
  return `<div class="fp-sub-label">Commits</div>` + commits
    .map((c) => {
      const shaShort = c.sha.slice(0, 8);
      const url = isGithubSlug(c.repo) ? `https://github.com/${c.repo}/commit/${c.sha}` : null;
      const sha = url
        ? `<a class="fp-sha" href="${escapeHtml(url)}" target="_blank" rel="noopener">${shaShort}</a>`
        : `<span class="fp-sha">${shaShort}</span>`;
      return `<div class="fp-commit-row">${sha} <span class="fp-commit-subject">${escapeHtml(c.subject)}</span></div>`;
    })
    .join('');
}

function renderPrsBlock(prs: FeatureDetailVM['sessions'][number]['prs']): string {
  if (prs.length === 0) return '';
  return `<div class="fp-sub-label">Pull Requests</div>` + prs
    .map(
      (p) => `<div class="fp-commit-row"><a class="fp-sha" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">#${p.prNumber}</a> <span class="fp-commit-subject">${escapeHtml(p.title)}</span> <span class="muted">[${escapeHtml(p.state)}]</span></div>`
    )
    .join('');
}
