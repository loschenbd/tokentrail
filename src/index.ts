#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';

const program = new Command();

program
  .name('tokentrail')
  .description('A local ledger and trail-map for Claude Code spend.')
  .version('0.1.0');

program
  .command('ingest')
  .description('Load new usage events into the local ledger.')
  .action(async () => {
    const { runIngest } = await import('./commands/ingest.js');
    await runIngest();
  });

program
  .command('enrich')
  .description('Pull PR metadata from GitHub for branches we have seen.')
  .option('--force', 'Re-enrich rows that have already been enriched.')
  .option('--delay <ms>', 'Sleep between GitHub requests (default 250)', '250')
  .action(async (opts: { force?: boolean; delay?: string }) => {
    const { runEnrich } = await import('./commands/enrich.js');
    await runEnrich({
      force: opts.force ?? false,
      delayMs: Number.parseInt(opts.delay ?? '250', 10),
    });
  });

program.parseAsync(process.argv);
