import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
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

  app.get('/worth-a-look', async (_req, reply) => {
    const vm = buildWorthALook(getDb());
    reply.type('text/html; charset=utf-8');
    return renderShell({ title: 'Worth a look · Tokentrail', activeTab: 'worth-a-look', days: opts.defaultDays, showBack: true }, renderWorthALook(vm));
  });

  app.get('/api/today', async (_req, reply) => {
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

function setAnomalyDismissed(rawId: string, dismiss: boolean, reply: import('fastify').FastifyReply): unknown {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0 || String(id) !== rawId) {
    return reply.code(400).send({ error: 'invalid id' });
  }
  const db = getDb();
  const row = db.prepare('SELECT dismissed_at FROM anomalies WHERE id = ?').get(id) as { dismissed_at: string | null } | undefined;
  if (!row) {
    return reply.code(404).send({ error: 'not found' });
  }
  const isCurrentlyDismissed = row.dismissed_at !== null;
  if (dismiss && isCurrentlyDismissed) {
    return reply.code(409).send({ error: 'already dismissed' });
  }
  if (!dismiss && !isCurrentlyDismissed) {
    return reply.code(409).send({ error: 'already active' });
  }
  if (dismiss) {
    db.prepare(`UPDATE anomalies SET dismissed_at = datetime('now') WHERE id = ? AND dismissed_at IS NULL`).run(id);
  } else {
    db.prepare(`UPDATE anomalies SET dismissed_at = NULL WHERE id = ? AND dismissed_at IS NOT NULL`).run(id);
  }
  return reply.code(204).send();
}
