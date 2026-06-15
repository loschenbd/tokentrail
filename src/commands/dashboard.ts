import open from 'open';
import { buildServer } from '../dashboard/server.js';

export type DashboardOptions = {
  port: number;
  open: boolean;
  days: number;
};

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const app = buildServer({ defaultDays: opts.days });
  await app.listen({ port: opts.port, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${opts.port}`;
  console.log(`Tokentrail dashboard at ${url}  (Ctrl-C to stop)`);
  if (opts.open) {
    open(url).catch(() => { /* user can still copy URL */ });
  }
  // Keep the event loop alive on SIGINT
  process.on('SIGINT', () => {
    app.close().finally(() => process.exit(0));
  });
}
