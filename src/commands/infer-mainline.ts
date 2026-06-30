import { getDb } from '../db/db.js';
import { inferMainlineFeatures } from '../services/mainline-inference.js';

export type InferMainlineOptions = {
  dryRun?: boolean;
};

export async function runInferMainline(opts: InferMainlineOptions = {}): Promise<void> {
  const db = getDb();
  if (opts.dryRun) {
    console.log('Dry-run mode not yet implemented; aborting without writes.');
    return;
  }
  const t0 = Date.now();
  const summary = await inferMainlineFeatures(db);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `Infer-mainline: considered ${summary.sessionsConsidered}, relabeled ${summary.sessionsRelabeled} sessions (${summary.eventsRelabeled} events), LLM calls ${summary.llmCalls}. ${seconds}s.`
  );
}
