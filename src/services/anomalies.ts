import { ANOMALY, ANOMALY_KIND_PRIORITY, type AnomalyKind } from '../../config/anomaly.js';

export type DailyTotal = { date: string; total: number };
export type FeatureWeekly = { featureKey: string; priorWeek: number; thisWeek: number };
export type SessionRow = {
  sessionId: string;
  date: string;
  cost: number;
  branch: string | null;
  hasOverride: boolean;
};

export type AnomalyInput = {
  dailyTotals: DailyTotal[];           // chronological, one row per date
  featureWeekly: FeatureWeekly[];      // one row per active feature
  sessions: SessionRow[];              // 30-day window
  labeledWorkUnitBranches: Set<string>;
};

export type DetectedAnomaly = {
  kind: AnomalyKind;
  date: string;
  feature_key: string | null;
  session_id: string | null;
  amount: number;
  baseline: number;
  multiplier: number;
  reason: string;
};

export function detectAnomalies(input: AnomalyInput): DetectedAnomaly[] {
  const out: DetectedAnomaly[] = [];
  out.push(...detectSpikeDays(input.dailyTotals));
  out.push(...detectBurningFeatures(input.featureWeekly));
  out.push(...detectHotSessions(input.sessions, input.labeledWorkUnitBranches));
  return out;
}

function detectSpikeDays(daily: DailyTotal[]): DetectedAnomaly[] {
  const { multiplier: minMult, floorUsd, windowDays } = ANOMALY.spikeDay;
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const out: DetectedAnomaly[] = [];
  for (let i = windowDays; i < sorted.length; i++) {
    const day = sorted[i];
    if (day == null) continue;
    if (day.total < floorUsd) continue;
    const window = sorted.slice(i - windowDays, i).map((d) => d.total);
    const baseline = median(window);
    if (baseline <= 0) continue;
    const mult = day.total / baseline;
    if (mult < minMult) continue;
    out.push({
      kind: 'spike_day',
      date: day.date,
      feature_key: null,
      session_id: null,
      amount: day.total,
      baseline,
      multiplier: mult,
      reason: `$${Math.round(day.total)} — ${mult.toFixed(1)}× the prior week's typical day.`,
    });
  }
  return out;
}

function detectBurningFeatures(rows: FeatureWeekly[]): DetectedAnomaly[] {
  const { multiplier: minMult, floorUsd } = ANOMALY.burningFeature;
  const out: DetectedAnomaly[] = [];
  for (const r of rows) {
    if (r.thisWeek < floorUsd) continue;
    const mult = r.priorWeek === 0 ? Number.POSITIVE_INFINITY : r.thisWeek / r.priorWeek;
    if (mult < minMult) continue;
    out.push({
      kind: 'burning_feature',
      date: isoTodayUtc(),
      feature_key: r.featureKey,
      session_id: null,
      amount: r.thisWeek,
      baseline: r.priorWeek,
      multiplier: mult,
      reason: r.priorWeek === 0
        ? `${r.featureKey} — $${Math.round(r.thisWeek)} this week (new this period).`
        : `${r.featureKey} — $${Math.round(r.thisWeek)} this week, up from $${Math.round(r.priorWeek)}.`,
    });
  }
  return out;
}

function detectHotSessions(
  sessions: SessionRow[],
  labeledBranches: Set<string>
): DetectedAnomaly[] {
  const { multiplier: minMult, floorUsd } = ANOMALY.hotSession;
  const costs = sessions.map((s) => s.cost).filter((c) => c > 0);
  const baseline = median(costs);
  if (baseline <= 0) return [];
  const out: DetectedAnomaly[] = [];
  for (const s of sessions) {
    if (s.cost < floorUsd) continue;
    const mult = s.cost / baseline;
    if (mult < minMult) continue;
    // Suppression: skip if user has explicitly labeled this work.
    if (s.hasOverride) continue;
    if (s.branch && labeledBranches.has(s.branch)) continue;
    const idShort = s.sessionId.slice(0, 8);
    out.push({
      kind: 'hot_session',
      date: s.date,
      feature_key: null,
      session_id: s.sessionId,
      amount: s.cost,
      baseline,
      multiplier: mult,
      reason: `\`${idShort}…\` · $${Math.round(s.cost)} in one session.`,
    });
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1] ?? 0;
    const hi = sorted[mid] ?? 0;
    return (lo + hi) / 2;
  }
  return sorted[mid] ?? 0;
}

function isoTodayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Tie-breaker used by Notion sync to pick a single reason per rollup row.
export function chooseTopAnomaly(
  candidates: DetectedAnomaly[]
): DetectedAnomaly | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    if (b.multiplier !== a.multiplier) return b.multiplier - a.multiplier;
    return ANOMALY_KIND_PRIORITY[b.kind] - ANOMALY_KIND_PRIORITY[a.kind];
  });
  return sorted[0] ?? null;
}
