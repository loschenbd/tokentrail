#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';

// Single source of truth for the version. Drift between package.json and a
// hardcoded literal here once shipped a 0.2.1 tarball that reported 0.2.0
// and broke the Homebrew formula's test block.
//
// Walk upward instead of hardcoding ../../: that offset is only right for
// the compiled dist/src/ layout — from src/ it escapes the checkout and
// lands on <parent-of-repo>/package.json, breaking every tsx-from-source
// run (npm run dev, worktrees, the launchd daemon).
function findPackageJson(startDir: string): string {
  let dir = startDir;
  const { root } = parse(dir);
  while (dir !== root) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`package.json not found above ${startDir}`);
}
const pkg = JSON.parse(
  readFileSync(findPackageJson(dirname(fileURLToPath(import.meta.url))), 'utf8')
) as { version: string };

const program = new Command();

program
  .name('tokentrail')
  .description('A local ledger and trail-map for Claude Code spend.')
  .version(pkg.version);

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
  .command('merges')
  .description('Detect branches merged into trunk via git history (catches direct CLI merges and repos the GitHub token can\'t see).')
  .option('--backfill', 'Walk candidate (repo, branch) pairs and populate branch_merges.')
  .option('--force', 'Re-check every pair, including ones already in branch_merges.')
  .action(async (opts: { backfill?: boolean; force?: boolean }) => {
    const { backfillBranchMerges } = await import('./commands/merges.js');
    if (!opts.backfill) {
      console.error('Usage: tokentrail merges --backfill');
      process.exitCode = 1;
      return;
    }
    await backfillBranchMerges({ force: opts.force });
  });

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
  .option('--no-cluster', 'Skip the LLM-backed topic clustering step.')
  .action(async (opts: { cluster?: boolean }) => {
    const { runRollup } = await import('./commands/rollup.js');
    // The dashboard daemon spawns `rollup --no-cluster` as a short-lived
    // child (see freshen.ts) so the full-history rollup's native SQLite
    // scratch is freed on process exit instead of ratcheting the daemon.
    await runRollup({ cluster: opts.cluster !== false });
  });

program
  .command('cluster')
  .description('Re-cluster sessions into named topics per feature (LLM-driven).')
  .option('--force', 'Re-cluster every eligible feature, even if its session set is unchanged.')
  .action(async (opts: { force?: boolean }) => {
    const { getDb } = await import('./db/db.js');
    const { recomputeClusters } = await import('./services/clustering.js');
    const db = getDb();
    if (opts.force) {
      db.prepare('DELETE FROM feature_cluster_runs').run();
    }
    const r = await recomputeClusters(db);
    console.log(
      `Clusters: ${r.featuresClustered} feature${r.featuresClustered === 1 ? '' : 's'} re-clustered, ` +
        `${r.featuresSkipped} unchanged` +
        (r.featuresFailed > 0 ? `, ${r.featuresFailed} failed` : '') +
        ` across ${r.featuresConsidered} candidates (${r.llmCalls} LLM call${r.llmCalls === 1 ? '' : 's'}).`
    );
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
  .command('infer-mainline')
  .description('Infer per-feature attribution for work on mainline branches.')
  .option('--dry-run', 'Print what would change without writing.')
  .action(async (opts: { dryRun?: boolean }) => {
    const { runInferMainline } = await import('./commands/infer-mainline.js');
    await runInferMainline({ dryRun: opts.dryRun });
  });

const llm = program.command('llm').description('Configure the LLM backend for topic inference.');

llm.command('status').description('Show current LLM backend + model.').action(async () => {
  const { runLlmStatus } = await import('./commands/llm.js');
  await runLlmStatus();
});

llm.command('test').description('Send a one-token ping to the configured backend.').action(async () => {
  const { runLlmTest } = await import('./commands/llm.js');
  await runLlmTest();
});

llm.command('setup').description('Interactive backend setup.').action(async () => {
  const { runLlmSetup } = await import('./commands/llm.js');
  await runLlmSetup();
});

program
  .command('anomaly')
  .description('List, dismiss, or restore anomalies.')
  .argument('[action]', '"list" (default), "dismiss", or "restore".')
  .argument('[id]', 'Anomaly id when dismissing or restoring.')
  .action(async (action: string | undefined, id: string | undefined) => {
    const { dismissAnomaly, listAnomalies, restoreAnomaly } = await import('./commands/anomaly.js');
    if (!action || action === 'list') {
      listAnomalies();
      return;
    }
    if (action === 'dismiss' || action === 'restore') {
      if (!id) {
        console.error(`Usage: tokentrail anomaly ${action} <id>`);
        process.exitCode = 1;
        return;
      }
      const n = Number.parseInt(id, 10);
      if (action === 'dismiss') dismissAnomaly(n);
      else restoreAnomaly(n);
      return;
    }
    console.error(`Unknown anomaly action: ${action}`);
    process.exitCode = 1;
  });

program
  .command('dashboard')
  .description('Open the local Tokentrail dashboard in your browser.')
  .option('--port <n>', 'Port to bind (default 4920)', '4920')
  .option('--no-open', "Don't launch the browser automatically.")
  .option('--days <n>', 'Default time window in days (default 30)', '30')
  .action(async (opts: { port?: string; open?: boolean; days?: string }) => {
    const { runDashboard } = await import('./commands/dashboard.js');
    await runDashboard({
      port: Number.parseInt(opts.port ?? '4920', 10),
      open: opts.open !== false,
      days: Number.parseInt(opts.days ?? '30', 10),
    });
  });

program
  .command('run-all')
  .description('Walk the full trail: ingest → commits/prs backfill → enrich → infer-mainline → rollup → sync.')
  .option('--skip-sync', 'Stop before the Notion sync step.')
  .option('--skip-enrich', 'Skip the GitHub enrichment step.')
  .option('--skip-backfill', 'Skip the commits + prs backfills (faster, less coherent).')
  .action(async (opts: { skipSync?: boolean; skipEnrich?: boolean; skipBackfill?: boolean }) => {
    const { runAll } = await import('./commands/run-all.js');
    await runAll({
      skipSync: opts.skipSync ?? false,
      skipEnrich: opts.skipEnrich ?? false,
      skipBackfill: opts.skipBackfill ?? false,
    });
  });

program
  .command('attribute')
  .description('Show how attribution would bucket a given (repo, branch) — debug helper.')
  .requiredOption('--repo <slug>', 'Repo slug, e.g. "owner/name" (use "" for no repo).')
  .requiredOption('--branch <name>', 'Branch name, e.g. "feat/foo" or "main".')
  .option('--pr-title <title>', 'Simulate a PR title (overrides branch attribution).')
  .option('--pr-labels <list>', 'Comma-separated PR labels to simulate.')
  .action(async (opts: { repo: string; branch: string; prTitle?: string; prLabels?: string }) => {
    const { runAttribute } = await import('./commands/attribute.js');
    runAttribute(opts);
  });

program
  .command('init')
  .description('One-shot setup: SwiftBar plugin, launchd daemon, Claude skills + hook.')
  .option('--dry-run', 'Print every step without writing anything.')
  .option('--force', 'Replace existing symlinks, plists, and skills.')
  .option('--skip-swiftbar', 'Skip the SwiftBar plugin step.')
  .option('--skip-daemon', "Skip the launchd dashboard daemon step.")
  .option('--skip-hook', "Skip installing the session-end hook into this repo.")
  .option('--skip-app', 'Skip symlinking Tokentrail.app into ~/Applications/.')
  .option('--node-path <path>', 'Override the tokentrail binary path written into the launchd plist (rarely needed).')
  .action(
    async (opts: {
      dryRun?: boolean;
      force?: boolean;
      skipSwiftbar?: boolean;
      skipDaemon?: boolean;
      skipHook?: boolean;
      skipApp?: boolean;
      nodePath?: string;
    }) => {
      const { runInit } = await import('./commands/init.js');
      runInit(opts);
    }
  );

program
  .command('install-skills')
  .description("Symlink Tokentrail's Claude Code skill + slash commands into ~/.claude.")
  .option('--force', 'Replace any conflicting files at the destination.')
  .option('--dry-run', 'Print what would happen without writing anything.')
  .action(async (opts: { force?: boolean; dryRun?: boolean }) => {
    const { runInstallSkills } = await import('./commands/install-skills.js');
    runInstallSkills({ force: opts.force, dryRun: opts.dryRun });
  });

program
  .command('install-hook')
  .description("Patch a repo's .claude/settings.json to fire Tokentrail's session-end hook.")
  .option('--repo <path>', 'Repo to patch (default: current directory).')
  .option('--dry-run', 'Print the planned change without writing anything.')
  .action(async (opts: { repo?: string; dryRun?: boolean }) => {
    const { runInstallHook } = await import('./commands/install-hook.js');
    runInstallHook({ repo: opts.repo, dryRun: opts.dryRun });
  });

program.parseAsync(process.argv);
