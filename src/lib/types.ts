// Shared types used across the ledger.

export type UsageEvent = {
  id: string;
  sessionId: string;
  timestamp: string;
  repo: string | null;
  branch: string | null;
  commitSha: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  source: 'jsonl' | 'hook';
};

export type WorkUnit = {
  id: string;
  repo: string;
  branch: string;
  prNumber: number | null;
  prTitle: string | null;
  prLabels: string | null;
  githubIssue: number | null;
  featureKey: string;
  featureName: string;
  notionPageId: string | null;
  status: 'active' | 'merged' | 'closed' | 'untracked';
  firstSeenAt: string;
  lastSeenAt: string;
  githubEnrichedAt: string | null;
};

export type FeatureRollup = {
  id: string;
  date: string;
  featureKey: string;
  featureName: string;
  repo: string | null;
  branches: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  sessionsCount: number;
  notionPageId: string | null;
  syncedToNotionAt: string | null;
};

export type RepoContext = {
  repo: string | null;
  branch: string | null;
  commitSha: string | null;
};
