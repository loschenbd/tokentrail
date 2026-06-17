# Today view — design

## Purpose

Add a dedicated `/today` page to the web dashboard so the user can glance at
today's Claude Code spend without scanning the longer Overview window. The
SwiftBar menubar already consumes today's data via `/api/today`; the Today
page is the browser equivalent.

## Non-goals

- No hourly chart, session-by-session timeline, or new SQL beyond what's
  needed for hero deltas and a session count.
- No top-nav redesign. The shell has no tab strip today; we only add a
  link from the Overview to the new page.

## Architecture

Mirrors the existing data → render → route pattern used by Overview,
Feature, Project, and Worth-a-look.

```
GET /today
  └─ buildTodayVM(db)                  src/dashboard/data/today.ts
  └─ renderToday(vm)                   src/dashboard/render/today.ts
  └─ renderShell({ activeTab: 'today' }) src/dashboard/render/shell.ts
```

### Data: `buildTodayVM(db)`

Returns:

```ts
type TodayVM = {
  todayUsd: number;
  yesterdayUsd: number;
  deltaPct: number;            // signed; same convention as OverviewVM
  sessionsToday: number;
  topProjects: OverviewVM['topProjects'];   // sliced to top 5
  topFeatures: OverviewVM['topFeatures'];   // sliced to top 5
  anomalies: OverviewVM['anomalies'];       // today only
};
```

Implementation:

1. Call `buildOverview(db, { days: 1 })` and pull `totalUsd`, `topProjects`,
   `topFeatures`, `anomalies` from it.
2. Slice `topProjects` and `topFeatures` to 5.
3. Filter `anomalies` to `date = today` (the Overview already scopes them
   to the window, so for `days=1` they're already today-only — no filter
   needed, just reuse).
4. New query: yesterday's USD (`SUM(total_cost_usd) FROM feature_rollups
   WHERE date = date('now','-1 day','localtime')`).
5. New query: sessions today (`COUNT(*) FROM ingest_sessions WHERE
   date(started_at,'localtime') = date('now','localtime')` — adjust to
   the actual sessions table name; verify against `src/db/schema.ts`
   during implementation).
6. Compute `deltaPct` with the same `prior > 0 ? round(((t-p)/p)*100)
   : (t>0 ? 100 : 0)` rule as Overview.

### Render: `renderToday(vm)`

Two-column layout matching Overview:

- **Main column**
  - Card: "Today's burn paths" — top projects today, same row component
    as `renderTopProjects` (extract to a shared helper or duplicate
    inline; prefer extracting to `src/dashboard/render/_components.ts`
    only if it stays small).
  - Card: "Today's features" — top 5 features as a simple list with
    `$X` amounts.
- **Side column**
  - Hero card: `$X today` with ▲/▼ vs yesterday delta.
  - Card: "Sessions today" — `N sessions` muted.
  - Card: "Worth a look" — today's anomalies; footer link to
    `/worth-a-look` if any.

### Empty state

If `todayUsd === 0 && sessionsToday === 0`, render a single-column card:
"No trail today yet" with a one-liner pointing to the Overview.

### Route

```ts
app.get('/today', async (_req, reply) => {
  const vm = buildTodayVM(getDb());
  reply.type('text/html; charset=utf-8');
  return renderShell(
    { title: 'Today · Tokentrail', activeTab: 'today', days: opts.defaultDays, showBack: true },
    renderToday(vm)
  );
});
```

### Shell change

Extend `ShellOptions.activeTab` to include `'today'`. No visual change
since the shell doesn't render tabs.

### Discoverability link

On the Overview's "Trail so far" hero card, append a small link
`Today →` that routes to `/today`. Minimal CSS — use the existing
`muted` / `footer-link` styles.

## Testing

- Manual: `npm run tokentrail -- dashboard`, visit `/today`, verify:
  - Hero shows today's $ with delta vs yesterday.
  - Top projects/features and anomalies match Overview when set to a
    1-day window.
  - Empty state appears when there's no spend today (test by editing
    SQL temporarily or running on a fresh DB).
- No unit tests added — existing project has no unit tests for
  dashboard render functions.

## Risks

- Sessions table name uncertainty: confirm against `src/db/schema.ts`
  before writing the query. If sessions-today is awkward to derive,
  drop it from the side column rather than block the rest.
- `topProjects` and `topFeatures` from `buildOverview(..., { days: 1 })`
  already exist, so the page is mostly reuse. Low risk of regression.
