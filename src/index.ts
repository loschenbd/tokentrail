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
  .command('commits')
  .description('Capture or show git commits authored during each session.')
  .argument('[session]', 'Optional session id prefix to show commits for.')
  .option('--backfill', 'Walk all sessions and populate session_commits.')
  .option('--force', 'With --backfill, re-scan sessions that already have commits cached.')
  .option('--author <email>', 'Override the default author filter (git config user.email). Empty disables.')
  .action(
    async (
      session: string | undefined,
      opts: { backfill?: boolean; force?: boolean; author?: string }
    ) => {
      const { backfillCommits, showCommits } = await import('./commands/commits.js');
      if (opts.backfill) {
        await backfillCommits({ force: opts.force, author: opts.author });
        return;
      }
      if (!session) {
        console.error('Usage: tokentrail commits --backfill');
        console.error('       tokentrail commits <session-id-prefix>');
        process.exitCode = 1;
        return;
      }
      await showCommits(session);
    }
  );

program
  .command('prs')
  .description('Capture or show GitHub PRs associated with each session.')
  .argument('[session]', 'Optional session id prefix to show PRs for.')
  .option('--backfill', 'Walk all sessions and populate session_prs.')
  .option('--force', 'With --backfill, re-scan sessions already covered.')
  .option('--delay <ms>', 'Sleep between GitHub requests (default 200)', '200')
  .action(
    async (
      session: string | undefined,
      opts: { backfill?: boolean; force?: boolean; delay?: string }
    ) => {
      const { backfillPrs, showPrs } = await import('./commands/prs.js');
      if (opts.backfill) {
        await backfillPrs({
          force: opts.force,
          delayMs: Number.parseInt(opts.delay ?? '200', 10),
        });
        return;
      }
      if (!session) {
        console.error('Usage: tokentrail prs --backfill');
        console.error('       tokentrail prs <session-id-prefix>');
        process.exitCode = 1;
        return;
      }
      await showPrs(session);
    }
  );

program
  .command('label')
  .description('Set, clear, or list per-session feature overrides.')
  .argument('[session]', 'Session id prefix (≥4 chars) or "list".')
  .argument('[feature_key]', 'Stable slug; required when setting a label.')
  .option('--name <name>', 'Human-readable feature name.')
  .option('--clear', 'Clear the label on this session.')
  .action(
    async (
      session: string | undefined,
      featureKey: string | undefined,
      opts: { name?: string; clear?: boolean }
    ) => {
      const { setLabel, clearLabel, listLabels } = await import(
        './commands/label.js'
      );
      if (!session || session === 'list') {
        await listLabels();
        return;
      }
      if (opts.clear) {
        await clearLabel({ sessionPrefix: session });
        return;
      }
      if (!featureKey) {
        console.error(
          'Usage: tokentrail label <session-id-prefix> <feature-key> [--name "Display"]'
        );
        console.error('       tokentrail label <session-id-prefix> --clear');
        console.error('       tokentrail label list');
        process.exitCode = 1;
        return;
      }
      await setLabel({
        sessionPrefix: session,
        featureKey,
        featureName: opts.name,
      });
    }
  );

program
  .command('sessions')
  .description('List sessions by cost so you can attribute them.')
  .option('--top <n>', 'How many sessions to show (default 20)', '20')
  .option('--outside-only', 'Show only sessions with no detected repo.')
  .option('--feature <key>', 'Filter to a specific feature key (substring).')
  .action(async (opts: { top?: string; outsideOnly?: boolean; feature?: string }) => {
    const { runSessions } = await import('./commands/sessions.js');
    await runSessions({
      top: Number.parseInt(opts.top ?? '20', 10),
      outsideOnly: opts.outsideOnly ?? false,
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
  .command('sync')
  .description('Sync the latest ledger entries to Notion.')
  .option('--days <n>', 'Only sync rollups in the last N days.')
  .option('--force', 'Re-push every rollup, even if unchanged.')
  .option('--rebuild-bodies', 'Also rewrite the Sessions/PRs/Commits page body — heavy.')
  .option('--delay <ms>', 'Sleep between Notion requests (default 350)', '350')
  .action(
    async (opts: {
      days?: string;
      force?: boolean;
      rebuildBodies?: boolean;
      delay?: string;
    }) => {
      const { runSync } = await import('./commands/sync.js');
      await runSync({
        days: opts.days ? Number.parseInt(opts.days, 10) : undefined,
        force: opts.force ?? false,
        rebuildBodies: opts.rebuildBodies ?? false,
        delayMs: Number.parseInt(opts.delay ?? '350', 10),
      });
    }
  );

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

program
  .command('run-all')
  .description('Walk the full trail: ingest → enrich → rollup → sync.')
  .option('--skip-sync', 'Stop before the Notion sync step.')
  .option('--skip-enrich', 'Skip the GitHub enrichment step.')
  .action(async (opts: { skipSync?: boolean; skipEnrich?: boolean }) => {
    const { runAll } = await import('./commands/run-all.js');
    await runAll({
      skipSync: opts.skipSync ?? false,
      skipEnrich: opts.skipEnrich ?? false,
    });
  });

program.parseAsync(process.argv);
