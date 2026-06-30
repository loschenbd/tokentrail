import { runIngest } from './ingest.js';
import { runEnrich } from './enrich.js';
import { runRollup } from './rollup.js';
import { runSync } from './sync.js';

export type RunAllOptions = {
  skipSync?: boolean;
  skipEnrich?: boolean;
};

export async function runAll(opts: RunAllOptions = {}): Promise<void> {
  const t0 = Date.now();
  console.log('Tokentrail — following the full trail.\n');

  console.log('→ ingest');
  await runIngest();

  if (!opts.skipEnrich) {
    console.log('\n→ enrich');
    await runEnrich();
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
