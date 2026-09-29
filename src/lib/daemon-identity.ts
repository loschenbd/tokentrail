import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingsDir } from './settings.js';

// The dashboard daemon binds 127.0.0.1, and loopback is shared by every
// macOS user on the machine. Two things keep one user's daemon from serving
// (or taking edits from) another user:
//
//   1. A per-user port. The first local account (uid 501) keeps the historic
//      4920; each other account gets its own offset. The menu-bar app
//      (scripts/menubar-native) computes the same number — keep them in sync.
//   2. A per-user token in the settings dir (mode 0600, so only that user can
//      read it). Mutating routes require it, as a header or as a cookie the
//      browser picks up from a one-time `?tt=` link.

export const BASE_PORT = 4920;
const FIRST_UID = 501;
// Network (AD/LDAP) accounts carry very large uids; wrap them into a fixed
// window so the port stays valid. A rare wrap-around collision is caught by
// the uid check in the menu-bar app and the daemon's EADDRINUSE message.
const PORT_SPAN = 1000;

export const TOKEN_FILE = 'daemon-token';
export const TOKEN_HEADER = 'x-tokentrail-token';
export const TOKEN_QUERY = 'tt';
export const UID_HEADER = 'x-tokentrail-uid';

export function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

export function defaultDashboardPort(uid: number | null = currentUid()): number {
  if (uid === null || uid < FIRST_UID) return BASE_PORT;
  return BASE_PORT + ((uid - FIRST_UID) % PORT_SPAN);
}

/** $TOKENTRAIL_PORT wins; otherwise the per-user default. */
export function dashboardPort(): number {
  const raw = process.env.TOKENTRAIL_PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : defaultDashboardPort();
}

export function dashboardBaseUrl(port: number = dashboardPort()): string {
  return `http://127.0.0.1:${port}`;
}

export function tokenPath(dir: string = settingsDir()): string {
  return join(dir, TOKEN_FILE);
}

export function readDaemonToken(dir: string = settingsDir()): string | null {
  try {
    const t = readFileSync(tokenPath(dir), 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Read the token, creating it (0600) on first run. */
export function ensureDaemonToken(dir: string = settingsDir()): string {
  const existing = readDaemonToken(dir);
  if (existing) return existing;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath(dir), token + '\n', { mode: 0o600 });
  chmodSync(tokenPath(dir), 0o600);
  return token;
}

export function tokensMatch(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Cookie name carries the port: cookies ignore ports, so two daemons on one host would otherwise overwrite each other. */
export function tokenCookieName(port: number): string {
  return `tt_auth_${port}`;
}
