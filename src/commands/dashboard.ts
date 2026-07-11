import open from 'open';
import { buildServer } from '../dashboard/server.js';
import { readSetupStatus, type SetupStatus } from '../dashboard/data/setup-status.js';

export type DashboardOptions = {
  port: number;
  open: boolean;
  days: number;
};

/**
 * First run lands on the onboarding wizard; every run after that lands on
 * the Overview. "First run" = none of the setup steps Tokentrail itself
 * installs exist yet. Partial setups (e.g. a user who skipped the menubar
 * on purpose) go to the Overview — the wizard stays reachable at /welcome.
 * swiftbarApp is deliberately ignored: it detects SwiftBar.app, which the
 * user installs, not us.
 */
export function pickOpenPath(status: SetupStatus): '/' | '/welcome' {
  const fresh = !status.menubarPlugin && !status.daemon && !status.skills && !status.hook;
  return fresh ? '/welcome' : '/';
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const app = buildServer({ defaultDays: opts.days });
  await app.listen({ port: opts.port, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${opts.port}`;
  const openUrl = url + pickOpenPath(readSetupStatus());
  console.log(`Tokentrail dashboard at ${openUrl}  (Ctrl-C to stop)`);
  if (opts.open) {
    open(openUrl).catch(() => { /* user can still copy URL */ });
  }
  // Keep the event loop alive on SIGINT
  process.on('SIGINT', () => {
    app.close().finally(() => process.exit(0));
  });
}
