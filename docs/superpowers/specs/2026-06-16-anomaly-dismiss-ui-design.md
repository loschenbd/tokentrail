# Anomaly dismiss/restore in the dashboard — design

**Date:** 2026-06-16
**Status:** Spec, awaiting plan
**Scope:** Add UI affordances to dismiss and restore anomalies on `/worth-a-look`. Ship the matching `tokentrail anomaly restore <id>` CLI command. Update README.

## Goal

Today, dismissing an anomaly requires the CLI:

```bash
tokentrail anomaly dismiss 145
```

There is no UI surface for dismissal anywhere in the dashboard, and there is no `restore` command at all — undoing a dismissal requires a manual `UPDATE anomalies SET dismissed_at = NULL WHERE id = N` against SQLite.

This spec adds:

1. Inline dismiss/restore actions on `/worth-a-look` (the existing full anomaly listing).
2. A `tokentrail anomaly restore <id>` CLI command, mirroring `dismiss`.
3. Two new dashboard endpoints to back the UI actions.

## Non-goals

- Dismiss buttons on other pages where anomalies render (overview sidebar, `/today`, `/project/:key`). Those pages remain preview-only and continue to link to `/worth-a-look` for triage.
- Confirmation prompts. Dismissal is reversible (via restore) and low-stakes; a prompt would slow down rapid triage.
- CSRF tokens, auth, or per-action rate limiting. The server binds to `127.0.0.1` only and is a single-user local tool.
- A toast/snackbar undo on dismiss. The "Show dismissed" toggle provides the undo path.
- Browser-test harness (Playwright etc.). The click handler is small enough to verify manually.

## Data model

No schema changes. The `anomalies.dismissed_at` column already exists and is the single source of truth: `NULL` means active, a timestamp means dismissed.

## CLI: `tokentrail anomaly restore <id>`

A new exported function in `src/commands/anomaly.ts`:

```ts
export function restoreAnomaly(id: number): void {
  const db = getDb();
  const result = db
    .prepare(`UPDATE anomalies SET dismissed_at = NULL WHERE id = ? AND dismissed_at IS NOT NULL`)
    .run(id);
  if (result.changes === 0) {
    console.error(`No dismissed anomaly with id ${id}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Restored anomaly ${id}.`);
}
```

Wired into `src/index.ts` as a new branch of the existing `anomaly` command:

```
tokentrail anomaly [list|dismiss|restore] [id]
```

Help text (printed when the action is missing or unknown) lists `restore` alongside `dismiss`.

## Dashboard endpoints

Two new endpoints registered in `src/dashboard/server.ts`:

```
POST /api/anomalies/:id/dismiss
POST /api/anomalies/:id/restore
```

**Response codes:**

| Outcome                             | Status |
|-------------------------------------|--------|
| Success (state flipped)             | 204    |
| Unknown id                          | 404    |
| Already in the requested state      | 409    |
| Malformed id (non-numeric)          | 400    |

Both endpoints share a tiny helper that:
1. Parses `:id` as a positive integer.
2. Looks up the row's current `dismissed_at`.
3. Runs the appropriate UPDATE (guarded by `WHERE dismissed_at IS [NOT] NULL` so concurrent requests don't double-flip).
4. Returns the right status.

These endpoints reuse `getDb()` exactly like the existing `/api/today` handler. No CSRF, no body parsing.

## UI: `/worth-a-look`

### Header

A new header row above the anomaly list:

```
Worth a look                            ☐ Show dismissed (N)
```

The toggle is a plain `<label>` wrapping a checkbox that submits a `GET` form with `?showDismissed=1` (or omits the param when unchecked). No JS is required to drive the toggle itself — the page reloads with the new query param. `(N)` is the count of dismissed anomalies.

### Row markup

Each active anomaly row gets:

```html
<div class="anomaly-row" data-anomaly-id="142">
  <span class="anomaly-date">2026-06-02</span>
  <span class="anomaly-reason">$708 — 6.7× the prior week's typical day.</span>
  <button class="anomaly-action" data-action="dismiss">dismiss</button>
</div>
```

Each dismissed row (shown only when `showDismissed=1`) gets:

```html
<div class="anomaly-row dismissed" data-anomaly-id="138">
  <span class="anomaly-date">2026-05-28</span>
  <span class="anomaly-reason">$298 — 3.5× the prior week's typical day.</span>
  <button class="anomaly-action" data-action="restore">restore</button>
</div>
```

CSS: `.dismissed` rows render with the existing muted text color (reuse whichever CSS variable `tokens.ts` exposes — likely `--text-muted` or `--muted`) and a subtle strikethrough on `.anomaly-reason`. The `.anomaly-action` button is a small text button styled like the existing footer links — no icon for clarity.

### Click handler (in `src/dashboard/static/dashboard.js`)

A single delegated listener on `document` watching for clicks on `.anomaly-action`:

```js
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.anomaly-action');
  if (!btn) return;
  const row = btn.closest('.anomaly-row');
  if (!row) return;
  const id = row.dataset.anomalyId;
  const action = btn.dataset.action; // 'dismiss' or 'restore'
  if (!id || !action) return;

  btn.disabled = true;
  try {
    const res = await fetch(`/api/anomalies/${id}/${action}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Flip the row's visual state and swap the button.
    row.classList.toggle('dismissed');
    btn.textContent = action === 'dismiss' ? 'restore' : 'dismiss';
    btn.dataset.action = action === 'dismiss' ? 'restore' : 'dismiss';
    // If the toggle is off, collapse the row out of view.
    if (!document.body.dataset.showDismissed && action === 'dismiss') {
      row.style.transition = 'opacity 200ms';
      row.style.opacity = '0';
      setTimeout(() => row.remove(), 200);
    }
  } catch (err) {
    btn.disabled = false;
    const errSpan = document.createElement('span');
    errSpan.className = 'anomaly-error';
    errSpan.textContent = ' (failed — try again)';
    btn.parentElement.appendChild(errSpan);
    setTimeout(() => errSpan.remove(), 4000);
  }
});
```

`<body data-show-dismissed="1">` is set when the toggle is on (server-rendered into the shell), so the click handler knows whether to collapse the row after a dismiss.

### Empty states

| Active count | `showDismissed` | Body                                                             |
|--------------|-----------------|------------------------------------------------------------------|
| 0            | off             | "Trail is calm — no active anomalies."                          |
| 0            | on              | Same headline, followed by the dismissed list                    |
| 0 + 0        | on              | "Trail is calm — no anomalies recorded."                        |
| > 0          | either          | The list                                                         |

## Data layer

`buildWorthALook(db)` in `src/dashboard/data/worth-a-look.ts` already SELECTs `id`. Extend it to:

1. Accept a `{ showDismissed: boolean }` option.
2. When `showDismissed === false`: same query as today (active only).
3. When `showDismissed === true`: SELECT both active and dismissed, with a `dismissed: boolean` field on each row, ORDER BY `dismissed ASC, date DESC, multiplier DESC` so active rows stay on top.
4. Always returns the `dismissedCount` for the header toggle label, computed via a second small `COUNT(*)` query.

VM shape becomes:

```ts
export type WorthALookVM = {
  showDismissed: boolean;
  dismissedCount: number;
  items: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
    multiplier: number;
    dismissed: boolean;
  }>;
};
```

## README updates

1. Remove the line in the Dashboard section that says the dashboard is read-only. (Currently around line 303: "The dashboard is read-only. Labeling, anomaly dismissal, and sync stay on the CLI.")
2. Replace it with: "Anomalies on `/worth-a-look` can be dismissed and restored inline. The same actions are available via `tokentrail anomaly dismiss <id>` and `tokentrail anomaly restore <id>`."
3. Update the Commands table to show `tokentrail anomaly [list|dismiss|restore]`.

## Testing

### New / extended tests

| File                                        | What it covers                                                                                              |
|---------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `tests/dashboard-anomaly-actions.test.ts`   | New. POST /api/anomalies/:id/dismiss: 204 happy, 404 unknown, 409 already-dismissed, 400 malformed id.       |
|                                             | POST /api/anomalies/:id/restore: same matrix in reverse.                                                     |
|                                             | Verifies `dismissed_at` is set/cleared correctly in the DB.                                                  |
| `tests/anomaly-cli.test.ts` (new)           | `restoreAnomaly()`: happy path, unknown id, already-active id (exit code 1 + error message).                  |
| `tests/worth-a-look-data.test.ts` (new)     | `buildWorthALook({ showDismissed: false })` returns active only; `({ showDismissed: true })` returns both;    |
|                                             | `dismissedCount` matches reality; ordering puts active rows first.                                            |

No render tests; the existing dashboard render tests are visual snapshot-style and adding the markup is straightforward.

### Manual test (not automated)

1. `tokentrail dashboard --no-open`, open `/worth-a-look`.
2. Click `dismiss` on a row → row fades out, badge in menu bar decrements within one refresh.
3. Check `Show dismissed (N)` → dismissed row appears muted with `restore` button.
4. Click `restore` → row un-mutes, button flips back to `dismiss`.
5. Reload page → state persisted, no drift.

## Risk / open questions

- **`<body data-show-dismissed>` plumbing:** the data attribute needs to be set on `<body>` from `renderShell` when the URL has the query param. Small but easy to forget — flag in the implementation plan.
- **Concurrent requests:** if the user double-clicks the dismiss button, the `WHERE dismissed_at IS NULL` guard prevents a double-flip. The second request gets a 409, which the handler shows as a transient "failed" message and the user can ignore.
- **No keyboard shortcut for dismiss.** Not in scope; could be added later if triage volume warrants it.

## Out of scope (named for clarity)

- Bulk-dismiss UI ("dismiss all hot_session"). The bulk-dismiss pattern shown in the bash-loop skill stays as a CLI recipe.
- Filtering by kind on `/worth-a-look`. Currently the page shows all kinds; if the active list gets long, filtering becomes worth doing — but not as part of this spec.
- Surfacing dismissal in the Notion sync. The existing sync code already handles `dismissed_at` correctly; no changes needed.
