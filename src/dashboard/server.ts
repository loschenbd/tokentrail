import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { getDb } from '../db/db.js';
import { buildOverview } from './data/overview.js';
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
import { installSwiftBarPlugin, installDaemon } from '../commands/init.js';
import { pkgRoot } from '../lib/pkg-root.js';

const STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'static');

export type ServerOptions = { defaultDays: number };

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/', async (req, reply) => {
    const days = parseDays(req.query, opts.defaultDays);
    const vm = buildOverview(getDb(), { days });
    const body = renderOverview(vm);
    reply.type('text/html; charset=utf-8');
    return renderShell({ title: 'Tokentrail · Overview', activeTab: 'overview', days }, body);
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
    const vm = buildTodayVM(getDb());
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
      renderTrailMap({ mode: 'welcome' })
    );
  });

  app.get('/worth-a-look', async (req, reply) => {
    const showDismissed = parseShowDismissed(req.query);
    const vm = buildWorthALook(getDb(), { showDismissed });
    reply.type('text/html; charset=utf-8');
    return renderShell(
      { title: 'Worth a look · Tokentrail', activeTab: 'worth-a-look', days: opts.defaultDays, showBack: true, showDismissed },
      renderWorthALook(vm)
    );
  });

  app.get('/api/today', async (_req, reply) => {
    freshenIfStale();
    const payload = buildToday(getDb());
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

  app.post('/api/setup/menubar-plugin', async (_req, reply) => {
    reply.type('application/json; charset=utf-8');
    try {
      installSwiftBarPlugin({}, pkgRoot());
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
  ]);

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
