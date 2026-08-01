import { runIngest } from './ingest.js';
import { runEnrich } from './enrich.js';
import { runRollup } from './rollup.js';
import { runSync } from './sync.js';

export type RunAllOptions = {
  skipSync?: boolean;
  skipEnrich?: boolean;
  skipBackfill?: boolean;
};

export async function runAll(opts: RunAllOptions = {}): Promise<void> {
  const t0 = Date.now();
  console.log('Tokentrail — following the full trail.\n');

  console.log('→ ingest');
  await runIngest();

  if (!opts.skipBackfill) {
    console.log('\n→ commits --backfill');
    const { backfillCommits } = await import('./commits.js');
    await backfillCommits();

    console.log('\n→ prs --backfill');
    const { backfillPrs } = await import('./prs.js');
    await backfillPrs();
  }

  if (!opts.skipEnrich) {
    console.log('\n→ enrich');
    await runEnrich();
  }

  try {
    console.log('\n→ cursor');
    const { runCursor } = await import('./cursor.js');
    await runCursor({});
  } catch (err) {
    console.warn(`Cursor stage failed (non-fatal): ${(err as Error).message}`);
  }

  try {
    console.log('\n→ copilot');
    const { runCopilot } = await import('./copilot.js');
    await runCopilot();
  } catch (err) {
    console.warn(`Copilot stage failed (non-fatal): ${(err as Error).message}`);
  }

  console.log('\n→ infer-mainline');
  const { runInferMainline } = await import('./infer-mainline.js');
  await runInferMainline();

  console.log('\n→ rollup');
  await runRollup();

  if (!opts.skipSync) {
    console.log('\n→ sync');
    await runSync();
  }

  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nTrail walked in ${seconds}s.`);
}
