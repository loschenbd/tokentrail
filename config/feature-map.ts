// Manual overrides applied at the top of the attribution priority chain.
// Match on (repo, branch) — exact match required. Use this for cases where
// the branch name, PR label, and PR title all miss the human-readable feature.
//
// Example:
//   '<owner>/<repo>:feat/whatever-it-is': {
//     featureKey: 'better-onboarding',
//     featureName: 'Better onboarding flow',
//   },

export type FeatureOverride = {
  featureKey: string;
  featureName: string;
};

export const FEATURE_OVERRIDES: Record<string, FeatureOverride> = {};
