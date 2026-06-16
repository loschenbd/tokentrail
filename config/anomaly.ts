// Anomaly detection thresholds. Tunable without touching detection logic.
// Multipliers are ratios over the relevant baseline (trailing median / prior
// 7-day total). Floors are absolute USD; nothing under the floor is flagged
// no matter the multiplier, so $4 → $9 doesn't become an "anomaly".

export const ANOMALY = {
  spikeDay: {
    multiplier: 2.0,    // day total ≥ 2× trailing 7-day median
    floorUsd: 20,       // and ≥ $20 absolute
    windowDays: 7,      // size of the trailing median window
  },
  burningFeature: {
    multiplier: 1.5,    // 7-day total ≥ 1.5× prior 7-day total
    floorUsd: 50,
  },
  hotSession: {
    multiplier: 3.0,    // session ≥ 3× trailing 30-day median session cost
    floorUsd: 25,
    windowDays: 30,
  },
} as const;

export type AnomalyKind = 'spike_day' | 'burning_feature' | 'hot_session';

// Used for tie-breaking when multiple anomalies match a rollup row and we
// need to pick one reason string for Notion's `Anomaly reason` column.
export const ANOMALY_KIND_PRIORITY: Record<AnomalyKind, number> = {
  spike_day: 3,
  burning_feature: 2,
  hot_session: 1,
};
