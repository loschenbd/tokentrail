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
  .command('report')
  .description('Follow token usage across recent work.')
  .option('--days <n>', 'Number of days to include (default 30)', '30')
  .option('--repo <slug>', 'Filter to a specific repo (substring match).')
  .option('--feature <key>', 'Filter to a specific feature (substring match).')
  .action(async (opts: { days?: string; repo?: string; feature?: string }) => {
    const { runReport } = await import('./commands/report.js');
    await runReport({
      days: Number.parseInt(opts.days ?? '30', 10),
      repo: opts.repo,
      feature: opts.feature,
    });
  });

program
  .command('trail')
  .description('Alias for `report`.')
  .option('--days <n>', 'Number of days to include (default 30)', '30')
  .option('--repo <slug>', 'Filter to a specific repo (substring match).')
  .option('--feature <key>', 'Filter to a specific feature (substring match).')
  .action(async (opts: { days?: string; repo?: string; feature?: string }) => {
    const { runReport } = await import('./commands/report.js');
    await runReport({
      days: Number.parseInt(opts.days ?? '30', 10),
      repo: opts.repo,
      feature: opts.feature,
    });
  });

program
  .command('rollup')
  .description('Aggregate events into daily feature rollups.')
  .action(async () => {
    const { runRollup } = await import('./commands/rollup.js');
    await runRollup();
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
