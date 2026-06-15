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

program.parseAsync(process.argv);
