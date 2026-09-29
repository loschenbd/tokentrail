import open from 'open';
import { buildServer } from '../dashboard/server.js';
import { readSetupStatus, type SetupStatus } from '../dashboard/data/setup-status.js';
import {
  TOKEN_QUERY,
  currentUid,
  dashboardBaseUrl,
  ensureDaemonToken,
} from '../lib/daemon-identity.js';

export type DashboardOptions = {
  port: number;
  open: boolean;
  days: number;
};

/**
 * First run lands on the onboarding wizard; every run after that lands on
 * the Overview. "First run" = none of the setup steps Tokentrail itself
 * installs exist yet. Partial setups (e.g. a user who skipped the menu-bar
 * app on purpose) go to the Overview — the wizard stays reachable at /welcome.
 */
export function pickOpenPath(status: SetupStatus): '/' | '/welcome' {
  const fresh = !status.menubarApp && !status.daemon && !status.skills && !status.hook;
  return fresh ? '/welcome' : '/';
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const authToken = ensureDaemonToken();
  const app = buildServer({ defaultDays: opts.days, authToken, port: opts.port });
  try {
    await app.listen({ port: opts.port, host: '127.0.0.1' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    const holder = await describePortHolder(opts.port);
    if (holder.kind === 'self') {
      // Usually the launchd daemon: open it rather than fail, so this command
      // stays the way to hand a browser its edit session.
      console.log(holder.message);
      if (opts.open) await open(`${dashboardBaseUrl(opts.port)}/?${TOKEN_QUERY}=${authToken}`).catch(() => {});
      await app.close();
      return;
    }
    console.error(holder.message);
    process.exit(1);
  }
  const url = dashboardBaseUrl(opts.port);
  const openUrl = url + pickOpenPath(readSetupStatus());
  console.log(`Tokentrail dashboard at ${openUrl}  (Ctrl-C to stop)`);
  if (opts.open) {
    // The one-time ?tt= link hands this browser the cookie that unlocks edits.
    open(`${openUrl}?${TOKEN_QUERY}=${authToken}`).catch(() => { /* user can still copy URL */ });
  }
  // Keep the event loop alive on SIGINT
  process.on('SIGINT', () => {
    app.close().finally(() => process.exit(0));
  });
}

export type PortHolder = { kind: 'self' | 'other-user' | 'unknown'; message: string };

/** Explain who holds the port — this user's own daemon, another macOS user's, or something else. */
export async function describePortHolder(port: number): Promise<PortHolder> {
  const base = `Port ${port} is already in use.`;
  const who = await fetchWhoami(port);
  if (!who || who.app !== 'tokentrail') {
    return { kind: 'unknown', message: `${base} Another program holds it; set TOKENTRAIL_PORT to pick a different port.` };
  }
  if (who.uid === currentUid()) {
    return { kind: 'self', message: `Your Tokentrail dashboard is already running at ${dashboardBaseUrl(port)}.` };
  }
  const owner = typeof who.user === 'string' ? `${who.user} (uid ${String(who.uid)})` : `uid ${String(who.uid)}`;
  return {
    kind: 'other-user',
    message: `${base} It belongs to another macOS user's Tokentrail: ${owner}. Set TOKENTRAIL_PORT to pick a different port.`,
  };
}

type Whoami = { app?: unknown; uid?: unknown; user?: unknown };

async function fetchWhoami(port: number): Promise<Whoami | null> {
  try {
    const res = await fetch(`${dashboardBaseUrl(port)}/api/whoami`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as Whoami) : null;
  } catch {
    return null; // not a Tokentrail server, or not answering
  }
}
