import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { getDb } from '../db/db.js';
import { buildOverview } from './data/overview.js';
import { materializeScopedRollup, presentScopes, isSourceScope, type SourceScope } from './data/scoped-rollup.js';
import { renderOverview } from './render/overview.js';
import { renderShell } from './render/shell.js';
import { tokensCss } from './tokens.js';
import { buildFeatureDetail } from './data/feature.js';
import { renderFeature } from './render/feature.js';
import { buildProjectDetail } from './data/project.js';
import { renderProject } from './render/project.js';
import { buildWorthALook } from './data/worth-a-look.js';
import { renderWorthALook } from './render/worth-a-look.js';
import { buildToday } from './data/api.js';
import { buildTodayVM } from './data/today.js';
import { renderToday } from './render/today.js';
import { renderTrailMap } from './render/trail-map.js';
import { freshenIfStale } from './freshen.js';
import { readSetupStatus } from './data/setup-status.js';
import { runInstallSkills } from '../commands/install-skills.js';
import { installMenubarApp, installDaemon } from '../commands/init.js';
import { pkgRoot } from '../lib/pkg-root.js';
import { buildSettingsVM } from './data/settings.js';
import { renderSettings } from './render/settings.js';
import { readSettings, writeSettings, type Settings } from '../lib/settings.js';
import { hiddenProjectPatterns } from './lib/hidden-projects.js';
import { getLLMClient } from '../lib/llm.js';
import { saveBudgetConfig, type BudgetPatch, type SourceBudgets } from '../lib/config.js';

const STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'static');

export type ServerOptions = { defaultDays: number };

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/', async (req, reply) => {
    const days = parseDays(req.query, opts.defaultDays);
    const db = getDb();
    const scopes = presentScopes(db);
    // Requested harness scope, falling back to 'all' if absent/unknown or the
    // source has no data (e.g. a stale ?source=cursor link after Cursor data
    // ages out). materializeScopedRollup returns the real feature_rollups for
    // 'all' and a per-source temp table otherwise.
    const requested = parseSource(req.query);
    const scope: SourceScope = requested && scopes.includes(requested) ? requested : 'all';
    const rollupTable = materializeScopedRollup(db, scope);
    const vm = buildOverview({ db, days, hidden: hiddenProjectPatterns(), rollupTable });
    const body = renderOverview(vm);
    reply.type('text/html; charset=utf-8');
    return renderShell(
      { title: 'Tokentrail · Overview', activeTab: 'overview', days, scope, scopes },
      body
    );
  });

  app.get<{ Params: { key: string } }>('/feature/:key', async (req, reply) => {
    const days = parseDays(req.query, opts.defaultDays);
    const vm = buildFeatureDetail(getDb(), { featureKey: req.params.key, days });
    if (!vm) {
      reply.code(404).type('text/html; charset=utf-8');
      return renderShell({ title: 'Feature not found', days, showBack: true }, '<div class="card"><div class="hero">Not found</div></div>');
    }
    const body = renderFeature(vm);
    reply.type('text/html; charset=utf-8');
    return renderShell({ title: `${vm.featureName} · Tokentrail`, activeTab: 'feature', days, showBack: true }, body);
  });

  app.get<{ Params: { key: string } }>('/project/:key', async (req, reply) => {
    const days = parseDays(req.query, opts.defaultDays);
    const vm = buildProjectDetail(getDb(), { projectKey: req.params.key, days });
    if (!vm) {
      reply.code(404).type('text/html; charset=utf-8');
      return renderShell({ title: 'Project not found', days, showBack: true }, '<div class="card"><div class="hero">Not found</div></div>');
    }
    const body = renderProject(vm);
    reply.type('text/html; charset=utf-8');
    return renderShell({ title: `${vm.projectName} · Tokentrail`, activeTab: 'project', days, showBack: true }, body);
  });

  app.get('/today', async (_req, reply) => {
    freshenIfStale();
    const vm = buildTodayVM(getDb(), { hidden: hiddenProjectPatterns() });
    reply.type('text/html; charset=utf-8');
    return renderShell(
      { title: 'Today · Tokentrail', activeTab: 'today', days: opts.defaultDays, showBack: true },
      renderToday(vm)
    );
  });

  app.get('/welcome', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderShell(
      { title: 'Welcome · Tokentrail', days: opts.defaultDays, showBack: true },
      renderTrailMap({ mode: 'welcome', setupStatus: readSetupStatus() }),
    );
  });

  app.get('/worth-a-look', async (req, reply) => {
    const showDismissed = parseShowDismissed(req.query);
    const vm = buildWorthALook(getDb(), { showDismissed, hidden: hiddenProjectPatterns() });
    reply.type('text/html; charset=utf-8');
    return renderShell(
      { title: 'Worth a look · Tokentrail', activeTab: 'worth-a-look', days: opts.defaultDays, showBack: true, showDismissed },
      renderWorthALook(vm)
    );
  });

  app.get('/api/today', async (_req, reply) => {
    freshenIfStale();
    const payload = buildToday(getDb(), { hidden: hiddenProjectPatterns() });
    reply.type('application/json; charset=utf-8');
    return payload;
  });

  app.post<{ Params: { id: string } }>('/api/anomalies/:id/dismiss', async (req, reply) => {
    return setAnomalyDismissed(req.params.id, true, reply);
  });

  app.post<{ Params: { id: string } }>('/api/anomalies/:id/restore', async (req, reply) => {
    return setAnomalyDismissed(req.params.id, false, reply);
  });

  // Returns the SetupStatus object — no action performed.
  app.post('/api/setup/status', async (_req, reply) => {
    reply.type('application/json; charset=utf-8');
    return { ok: true, status: readSetupStatus() };
  });

  app.post('/api/setup/menubar-app', async (_req, reply) => {
    reply.type('application/json; charset=utf-8');
    try {
      installMenubarApp({}, pkgRoot());
      return { ok: true, status: readSetupStatus() };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: readSetupStatus(),
      };
    }
  });

  app.post('/api/setup/daemon', async (_req, reply) => {
    reply.type('application/json; charset=utf-8');
    try {
      installDaemon({}, pkgRoot());
      return { ok: true, status: readSetupStatus() };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: readSetupStatus(),
      };
    }
  });

  app.post('/api/setup/skills', async (_req, reply) => {
    reply.type('application/json; charset=utf-8');
    try {
      runInstallSkills();
      return { ok: true, status: readSetupStatus() };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: readSetupStatus(),
      };
    }
  });

  app.get('/settings', async (_req, reply) => {
    const vm = buildSettingsVM(getDb());
    const body = renderSettings(vm);
    reply.type('text/html; charset=utf-8');
    return renderShell({ title: 'Tokentrail · Settings', activeTab: 'settings', days: opts.defaultDays }, body);
  });

  app.get('/api/settings', async () => buildSettingsVM(getDb()));

  // Partial update: a body may carry `llm`, `hiddenProjects`, or both.
  // Whatever it omits is preserved from the file, so the LLM form and the
  // hidden-projects controls can save independently.
  app.post('/api/settings', async (req, reply) => {
    const body = req.body as Partial<Settings>;
    const current = readSettings();

    let llm = current.llm;
    if (body?.llm !== undefined) {
      const backend = body.llm?.backend;
      if (!backend || !['ollama', 'openrouter', 'none', 'auto'].includes(backend)) {
        reply.code(400);
        return { error: 'invalid backend' };
      }
      llm = {
        backend,
        openrouter: {
          apiKey: body.llm?.openrouter?.apiKey === '__KEEP__'
            ? current.llm.openrouter.apiKey
            : (body.llm?.openrouter?.apiKey ?? null),
          model: body.llm?.openrouter?.model ?? current.llm.openrouter.model,
        },
        ollama: {
          baseUrl: body.llm?.ollama?.baseUrl ?? current.llm.ollama.baseUrl,
          model: body.llm?.ollama?.model ?? current.llm.ollama.model,
        },
      };
    }

    let hiddenProjects = current.hiddenProjects;
    if (body?.hiddenProjects !== undefined) {
      if (!Array.isArray(body.hiddenProjects)) {
        reply.code(400);
        return { error: 'hiddenProjects must be an array of strings' };
      }
      hiddenProjects = body.hiddenProjects
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim());
    }

    if (body?.llm === undefined && body?.hiddenProjects === undefined) {
      reply.code(400);
      return { error: 'empty settings update' };
    }

    writeSettings({ llm, hiddenProjects });
    return { ok: true };
  });

  // Budget config lives in the Tokentrail config file, not settings.json —
  // kept as a separate endpoint so the two forms save independently.
  app.post('/api/budget', async (req, reply) => {
    const body = req.body as {
      monthlyBudgetUsd?: unknown; budgetCycleStartDay?: unknown;
      sourceBudgets?: { claude?: unknown; copilot?: unknown; cursor?: unknown };
    };
    // Maps blank/whitespace/null/undefined/0 -> null (no cap), matching the
    // config's canonical meaning (lib/config.ts positiveOrNull collapses
    // 0 -> null on load, so persisting 0 as a literal would silently
    // "reset" on the next read). Negative/NaN -> undefined (invalid -> 400).
    const posOrNull = (v: unknown): number | null | undefined => {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return undefined; // undefined = invalid
      if (n === 0) return null; // 0 means "no cap", same as blank
      return n;
    };
    const patch: BudgetPatch = {};
    if ('monthlyBudgetUsd' in body) {
      const m = posOrNull(body.monthlyBudgetUsd);
      if (m === undefined) { reply.code(400); return { error: 'monthlyBudgetUsd must be >= 0 or blank' }; }
      patch.monthlyBudgetUsd = m;
    }
    if ('budgetCycleStartDay' in body && body.budgetCycleStartDay != null) {
      const d = Number(body.budgetCycleStartDay);
      if (!Number.isInteger(d) || d < 1 || d > 28) { reply.code(400); return { error: 'budgetCycleStartDay must be 1-28' }; }
      patch.budgetCycleStartDay = d;
    }
    if (body.sourceBudgets) {
      const sb: Partial<SourceBudgets> = {};
      for (const k of ['claude', 'copilot', 'cursor'] as const) {
        if (k in body.sourceBudgets) {
          const v = posOrNull((body.sourceBudgets as Record<string, unknown>)[k]);
          if (v === undefined) { reply.code(400); return { error: `${k} cap must be >= 0 or blank` }; }
          sb[k] = v;
        }
      }
      patch.sourceBudgets = sb;
    }
    try {
      const { path } = saveBudgetConfig(patch);
      return { ok: true, path };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/api/infer-mainline/stream', async (_req, reply) => {
    const { inferMainlineFeatures } = await import('../services/mainline-inference.js');
    const { runRollup } = await import('../commands/rollup.js');
    const { getLLMClient } = await import('../lib/llm.js');
    const { getDb } = await import('../db/db.js');

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const db = getDb();
      const stuckCleared = db
        .prepare(
          `DELETE FROM mainline_inference_runs
           WHERE session_id IN (
             SELECT DISTINCT session_id FROM usage_events
             WHERE inferred_feature_key = 'uncategorized-mainline'
           )`
        )
        .run().changes;
      send('start', { retriedSessions: stuckCleared });

      const summary = await inferMainlineFeatures(db, {
        getLLMClient,
        onProgress: (p) => send('progress', p),
      });
      send('rollup', {});
      await runRollup();
      send('done', { summary, retriedSessions: stuckCleared });
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    } finally {
      reply.raw.end();
    }
  });

  app.get('/api/ollama/models', async (req) => {
    const q = req.query as { baseUrl?: string };
    const baseUrl = q.baseUrl || readSettings().llm.ollama.baseUrl;
    // Ollama's model list lives at /api/tags on the root host — not on the
    // OpenAI-compat /v1 subpath. Strip a trailing /v1 if the user configured
    // the OpenAI-compat base URL (which is what Save writes by default).
    const tagsUrl = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/api/tags';
    try {
      const r = await fetch(tagsUrl);
      if (!r.ok) return { ok: false, error: `tags ${r.status}` };
      const data = (await r.json()) as { models?: Array<{ name: string }> };
      return { ok: true, models: (data.models ?? []).map((m) => m.name).sort() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/settings/test', async (req) => {
    const { backend, model } = req.body as { backend: string; model?: string };
    const c = getLLMClient({ backend: backend as any, model });
    if (!c) return { ok: false, error: 'backend not configured' };
    const t0 = Date.now();
    try {
      await c.client.chat.completions.create({
        model: c.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Static asset serving — small bespoke handler instead of @fastify/static
  // to keep dep count low. Only allows files whose basename matches a
  // whitelist (no path traversal).
  const STATIC_ALLOW = new Set([
    'dashboard.css',
    'dashboard.js',
    'uPlot.iife.min.js',
    'uPlot.min.css',
    'logo.png',
    'favicon.svg',
    'trail-map.css',
    'trail-map.js',
    'settings.js',
    'fonts.css',
  ]);

  app.get('/static/fonts/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    // Same no-traversal rule as /static/:name — a single flat basename.
    if (!/^[a-z0-9-]+\.woff2$/.test(name)) return reply.code(404).send('not found');
    try {
      const data = await readFile(join(STATIC_DIR, 'fonts', name));
      reply.type('font/woff2');
      reply.header('cache-control', 'public, max-age=86400');
      return data;
    } catch {
      return reply.code(404).send('not found');
    }
  });

  app.get('/static/tokens.css', async (_req, reply) => {
    reply.type('text/css; charset=utf-8');
    return tokensCss();
  });

  app.get('/static/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!STATIC_ALLOW.has(name)) return reply.code(404).send('not found');
    const data = await readFile(join(STATIC_DIR, name));
    if (name.endsWith('.css')) reply.type('text/css; charset=utf-8');
    else if (name.endsWith('.js')) reply.type('application/javascript; charset=utf-8');
    else if (name.endsWith('.png')) reply.type('image/png');
    else if (name.endsWith('.svg')) reply.type('image/svg+xml');
    return data;
  });

  return app;
}

function parseDays(query: unknown, fallback: number): number {
  if (typeof query !== 'object' || query === null) return fallback;
  const raw = (query as Record<string, unknown>).days;
  if (typeof raw !== 'string') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 730) return fallback;
  return n;
}

function parseSource(query: unknown): SourceScope | null {
  if (typeof query !== 'object' || query === null) return null;
  const raw = (query as Record<string, unknown>).source;
  return isSourceScope(raw) ? raw : null;
}

function parseShowDismissed(query: unknown): boolean {
  if (typeof query !== 'object' || query === null) return false;
  const raw = (query as Record<string, unknown>).showDismissed;
  return raw === '1' || raw === 'true' || raw === 'on';
}

function setAnomalyDismissed(rawId: string, dismiss: boolean, reply: FastifyReply): FastifyReply {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0 || String(id) !== rawId) {
    return reply.code(400).send({ error: 'invalid id' });
  }
  const db = getDb();
  // Race-free: the guarded UPDATE is the source of truth. If it changes 0 rows,
  // either the row doesn't exist OR it's already in the requested state — a
  // follow-up SELECT disambiguates so the response code is correct under
  // concurrent double-clicks.
  const updateSql = dismiss
    ? `UPDATE anomalies SET dismissed_at = datetime('now') WHERE id = ? AND dismissed_at IS NULL`
    : `UPDATE anomalies SET dismissed_at = NULL WHERE id = ? AND dismissed_at IS NOT NULL`;
  const info = db.prepare(updateSql).run(id);
  if (info.changes === 1) {
    return reply.code(204).send();
  }
  const row = db.prepare('SELECT 1 FROM anomalies WHERE id = ?').get(id);
  if (!row) {
    return reply.code(404).send({ error: 'not found' });
  }
  return reply.code(409).send({ error: dismiss ? 'already dismissed' : 'already active' });
}
