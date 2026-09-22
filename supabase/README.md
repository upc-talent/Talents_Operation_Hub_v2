# Supabase backend — setup & migration runbook

This moves the live data off Google Apps Script (a ~1 s round‑trip per action) onto Supabase
(Postgres + an Edge Function, ~100 ms), **without changing any feature**. The front‑end already
talks to the backend through one thin layer (`assets/js/api.js`), so only the transport changed —
it now speaks the same JSON protocol to the Edge Function instead of Apps Script.

Nothing here affects live users until the final cut‑over step: until then the app keeps using
Apps Script, and you test Supabase with `?backend=supabase`.

```
supabase/schema.sql            ← run once in the SQL editor (creates tables + locks them down)
supabase/functions/api/        ← the Edge Function (a TypeScript port of backend/Code.gs)
dev/migrate.html               ← one‑time data copy: Apps Script → Supabase
```

---

## Step 1 — Create the tables

Supabase dashboard → **SQL Editor** → paste all of [`schema.sql`](schema.sql) → **Run**.
It creates the tables and enables Row‑Level Security with **no policies**, so the public (anon) key
can touch nothing — only the Edge Function (service_role) can. Safe to re‑run.

## Step 2 — Set the Edge Function secrets

Dashboard → **Edge Functions → Secrets** (or `supabase secrets set NAME=value`). Add:

| Secret | Value |
|---|---|
| `TRAINER_USER` | the trainer‑page username (same one you use today) |
| `TRAINER_PASS` | the trainer‑page password |
| `TOKEN_SECRET` | any long random string (e.g. paste a UUID or two). Optional — if you skip it, the function generates and stores one automatically. |

`SUPABASE_DB_URL`, `SUPABASE_URL`, etc. are provided by Supabase automatically — don't add those.

## Step 3 — Deploy the Edge Function

**Option A — Supabase CLI (recommended):**
```bash
supabase login
supabase link --project-ref aoqgabdsayaqgqroscdw
supabase functions deploy api
```

**Option B — Dashboard:** Edge Functions → **Create function** → name it exactly `api` →
paste the contents of [`functions/api/index.ts`](functions/api/index.ts) → **Deploy**.

Quick check — this should return `{"ok":true,...}` (replace ANON with your anon key):
```bash
curl -s -X POST "https://aoqgabdsayaqgqroscdw.supabase.co/functions/v1/api" \
  -H "Authorization: Bearer ANON" -H "apikey: ANON" -H "Content-Type: application/json" \
  -d '{"action":"supervisors"}'
```
(It'll return an empty `names` list until Step 4 loads data.)

## Step 4 — Copy your existing data across (one time)

Open **`dev/migrate.html`** (serve the folder, e.g. `dev/serve.ps1`, then browse to
`http://localhost:5173/dev/migrate.html`). It:

1. reads everything from the **current Apps Script** backend (you sign in with the trainer login), then
2. writes it into **Supabase** in the right order (pharmacists first, then assignments/attendance,
   approvals, notifications, settings, logo).

It reuses the app's own client, so the data lands in exactly the shape the app expects.
*(Venues are optional recommendations — if you want them, re‑add them in the app or insert them into the
`venues` table; they aren't required for anything to work.)*

## Step 5 — Test on Supabase (no impact on live users)

Open the app with `?backend=supabase`, e.g.
`…/trainer.html?backend=supabase` and `…/supervisor.html?backend=supabase`.
Sign in and exercise: load, assign, mark attendance (regular + split online), approvals, filters, sorts,
exports. Compare against the current app. `?backend=gas` switches back instantly.

## Step 6 — Cut over

When you're happy, in [`assets/js/config.js`](../assets/js/config.js) change the default:
```js
API_KIND: 'supabase',
API_URL:  'https://aoqgabdsayaqgqroscdw.supabase.co/functions/v1/api',
```
(or keep `API_KIND:'gas'` and simply tell people to use `?backend=supabase`).
Publish the static files. Keep the Apps Script deployment as a fallback for a while.

---

### Notes / intentional differences
- **Calendar sync from the Google Sheet is retired** (there's no Sheet to read). Manage days in the app,
  or use **Trainer → Calendar → “import from an Excel file”** (fully client‑side, already built).
- **Free‑tier pause:** a free Supabase project sleeps after 7 days of inactivity (one‑click resume). If you
  have quiet weeks, add a weekly keep‑alive ping or a `pg_cron` job.
- **Concurrency safety:** the operations write runs in a transaction holding a Postgres advisory lock, so two
  people can't both grab the last seat — same guarantee the old script lock gave, but far faster.
