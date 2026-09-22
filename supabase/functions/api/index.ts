// ════════════════════════════════════════════════════════════════════
// Talent Operations Center — Supabase Edge Function "api"
// --------------------------------------------------------------------
// A faithful port of backend/Code.gs, backed by Postgres instead of a Google Sheet.
// It speaks the EXACT same JSON protocol as the Apps Script backend, so the front-end
// only had to change which URL (and headers) it calls — see assets/js/api.js / config.js.
//
// Auth (unchanged model): trainer actions need a signed, expiring token issued after
// TRAINER_USER/TRAINER_PASS match; supervisor actions are scoped server-side to that
// supervisor's own pharmacists. The database is private (RLS deny-all to the anon key);
// only this function touches it, using the service_role's direct DB connection.
//
// Secrets to set (Dashboard → Edge Functions → Manage secrets, or `supabase secrets set`):
//   TRAINER_USER   the trainer-page username
//   TRAINER_PASS   the trainer-page password
//   TOKEN_SECRET   any long random string (used to sign tokens). Optional — if unset,
//                  one is generated and stored in kv_cache on first use.
// SUPABASE_DB_URL is provided automatically by Supabase.
// ════════════════════════════════════════════════════════════════════
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const DB_URL = Deno.env.get("SUPABASE_DB_URL") || Deno.env.get("DB_URL") || "";
// One pooled client, reused across invocations. prepare:false keeps it compatible with poolers.
const sql = postgres(DB_URL, { prepare: false });

const CONFIG = {
  TOKEN_TTL_HOURS: 10,
  MAX_LOGIN_FAILS: 8,
  LOCKOUT_MINUTES: 10,
  DEFAULT_CAPACITY: 30,
};
const LEAVE_STATUSES = ["Sick Leave", "Annual Leave", "Resignation", "Promotion"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ─────────── helpers ─────────── */
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
const nowIso = () => new Date().toISOString();
const jb = (v: unknown) => (v == null ? null : sql.json(v as any)); // jsonb literal or null

/* ─────────── entry ─────────── */
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let out: unknown;
  try {
    const req = await request.json();
    out = await route(req);
  } catch (err) {
    out = { ok: false, error: String((err && (err as Error).message) || err) };
  }
  return json(out);
});

async function route(req: any) {
  const action = req.action;
  if (action === "login") return await login(req);
  if (action === "supervisors") return { ok: true, names: await supervisorNames() };
  if (action === "get" && req.key === "company-logo") {
    return { ok: true, data: { records: [], settings: { logo: (await settingsMap()).logo ?? null } } };
  }
  const ctx = await authenticate(req);
  switch (action) {
    case "me": return { ok: true, role: ctx.role, who: ctx.who || null };
    case "get": return { ok: true, data: await getKey(ctx, req.key) };
    case "getMany": return { ok: true, data: await getMany(ctx, req.keys) };
    case "patch": return await patchKey(ctx, req);
    // Calendar sync used to read the Google Sheet tab; with the Sheet retired, the trainer imports the
    // calendar from an Excel file in-app instead (that path is fully client-side). These degrade gracefully.
    case "calendarGrid": requireTrainer(ctx); return { ok: true, values: [] };
    case "syncCalendar": requireTrainer(ctx); return { ok: true, summary: { changed: false } };
    case "venues": requireTrainer(ctx); return { ok: true, venues: await venues() };
  }
  throw new Error("Unknown action");
}

/* ═════════ Auth ═════════ */
type Ctx = { role: "trainer" | "supervisor"; who?: string; user?: string };
function requireTrainer(ctx: Ctx) {
  if (ctx.role !== "trainer") throw new Error("Trainer login required.");
}
async function authenticate(req: any): Promise<Ctx> {
  if (req.token) {
    const p = await verifyToken(req.token);
    if (!p) throw new Error("Session expired — please sign in again.");
    return { role: "trainer", user: p.u };
  }
  if (req.supervisor) {
    const names = await supervisorNames();
    if (names.indexOf(String(req.supervisor)) === -1) throw new Error("Unknown supervisor.");
    return { role: "supervisor", who: String(req.supervisor) };
  }
  throw new Error("Not authorised.");
}

const encoder = new TextEncoder();
function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function safeEq(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function getSecret(): Promise<string> {
  const env = Deno.env.get("TOKEN_SECRET");
  if (env) return env;
  const hit = await kvGet("token_secret");
  if (hit) return hit;
  const gen = crypto.randomUUID() + crypto.randomUUID();
  await kvPut("token_secret", gen, 100 * 365 * 24 * 3600);
  return gen;
}
async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(await getSecret()),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return b64urlFromBytes(new Uint8Array(sig));
}
async function makeToken(user: string): Promise<string> {
  const exp = Date.now() + CONFIG.TOKEN_TTL_HOURS * 3600 * 1000;
  const payload = b64urlFromBytes(encoder.encode(JSON.stringify({ u: user, e: exp })));
  return payload + "." + (await sign(payload));
}
async function verifyToken(tok: unknown): Promise<{ u: string; e: number } | null> {
  if (!tok || typeof tok !== "string") return null;
  const parts = tok.split(".");
  if (parts.length !== 2) return null;
  if (!safeEq(await sign(parts[0]), parts[1])) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    if (!p || !p.e || Date.now() > p.e) return null;
    return p;
  } catch { return null; }
}

async function login(req: any) {
  const user = Deno.env.get("TRAINER_USER");
  const pass = Deno.env.get("TRAINER_PASS");
  if (!user || !pass) throw new Error("Trainer credentials are not configured on the server (Edge Function secrets).");
  const fails = Number((await kvGet("login_fails")) || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAILS) throw new Error("Too many failed attempts. Please try again in a few minutes.");
  const ok = safeEq(String(req.username || ""), user) && safeEq(String(req.password || ""), pass);
  if (!ok) {
    await kvPut("login_fails", String(fails + 1), CONFIG.LOCKOUT_MINUTES * 60);
    await new Promise((r) => setTimeout(r, 1000));
    throw new Error("Invalid username or password.");
  }
  await kvRemove("login_fails");
  return { ok: true, token: await makeToken(user), ttlHours: CONFIG.TOKEN_TTL_HOURS };
}

/* ═════════ kv_cache (replaces CacheService) ═════════ */
async function kvGet(key: string): Promise<string | null> {
  const rows = await sql`select value, expires_at from kv_cache where key = ${key}`;
  if (!rows.length) return null;
  if (rows[0].expires_at && new Date(rows[0].expires_at).getTime() < Date.now()) {
    await sql`delete from kv_cache where key = ${key}`;
    return null;
  }
  return rows[0].value;
}
async function kvPut(key: string, value: string, ttlSeconds: number) {
  const exp = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await sql`insert into kv_cache (key, value, expires_at) values (${key}, ${value}, ${exp})
            on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
}
async function kvRemove(key: string) {
  await sql`delete from kv_cache where key = ${key}`;
}

/* ═════════ Settings ═════════ */
async function settingsMap(): Promise<Record<string, any>> {
  const rows = await sql`select key, value from settings`;
  const out: Record<string, any> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function patchSettings(patch: Record<string, any>) {
  for (const k of Object.keys(patch)) {
    const v = patch[k] === undefined ? null : patch[k];
    await sql`insert into settings (key, value) values (${k}, ${jb(v)})
              on conflict (key) do update set value = excluded.value`;
  }
}

/* ═════════ Supervisors / Venues ═════════ */
async function supervisorNames(): Promise<string[]> {
  const rows = await sql`select distinct supervisor from pharmacists
                         where supervisor <> '' and supervisor <> '-' and supervisor <> '—'
                         order by supervisor`;
  return rows.map((r: any) => r.supervisor);
}
async function venues() {
  const rows = await sql`select city, venue from venues where city <> '' and venue <> '' order by city`;
  return rows.map((r: any) => ({ city: r.city, venue: r.venue }));
}

/* ═════════ Dates & attendance helpers (mirror Code.gs / common.js) ═════════ */
function parseIso(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}
function fmtDate(iso: string) {
  const p = parseIso(iso);
  if (!p) return String(iso || "");
  return p.d + " " + MONTHS[p.m] + " " + String(p.y).slice(-2);
}
function isSplit(day: any) { return !!(day && day.isOnline && day.onlineFormat === "split"); }
function dayLabel(day: any) {
  if (!day || !day.date) return "";
  if (!isSplit(day)) return fmtDate(day.date);
  const p = parseIso(day.date);
  if (!p) return fmtDate(day.date);
  const dt = new Date(Date.UTC(p.y, p.m, p.d + 1));
  const m2 = dt.getUTCMonth(), d2 = dt.getUTCDate(), yy = String(p.y).slice(-2);
  if (p.m === m2) return p.d + " - " + d2 + " " + MONTHS[p.m] + " " + yy;
  return p.d + " " + MONTHS[p.m] + " - " + d2 + " " + MONTHS[m2] + " " + yy;
}

/* ═════════ READ ═════════ */
async function getMany(ctx: Ctx, keys: string[]) {
  if (!keys || !keys.length) throw new Error("No keys requested.");
  if (keys.length > 12) throw new Error("Too many keys.");
  const out: Record<string, any> = {};
  for (const k of keys) out[k] = await getKey(ctx, k);
  return out;
}
async function getKey(ctx: Ctx, key: string) {
  switch (key) {
    case "master-pharmacists": return await getMaster(ctx);
    case "operations": return await getOps(ctx);
    case "training-config": return await getConfig(ctx);
    case "company-logo": return { records: [], settings: { logo: (await settingsMap()).logo ?? null } };
    case "pending-pharmacists":
    case "leave-requests":
    case "quota-approval-history":
    case "pharmacist-notifications": return await getTable(ctx, key);
  }
  throw new Error("Unknown data key.");
}

function masterOf(r: any) {
  const m: any = {
    id: r.id, district: r.district, areaManager: r.area_manager, city: r.city,
    supervisor: r.supervisor, pharmacyNo: r.pharmacy_no, employeeId: r.employee_id, email: r.email,
    displayName: r.display_name, phone: r.phone, scfhs: r.scfhs, note: r.note,
  };
  if (r.completion_pct !== null && r.completion_pct !== undefined && r.completion_pct !== "") m.completionPct = r.completion_pct;
  return m;
}
async function getMaster(ctx: Ctx) {
  const rows = await sql`select * from pharmacists where display_name <> '' order by created_at`;
  const recs: any[] = [];
  for (const r of rows) {
    let m: any = masterOf(r);
    if (ctx.role === "supervisor") {
      if (m.supervisor !== ctx.who) continue;
      m = { id: m.id, district: m.district, areaManager: m.areaManager, city: m.city, supervisor: m.supervisor, email: m.email, displayName: m.displayName, note: m.note, completionPct: m.completionPct };
      if (m.completionPct === undefined) delete m.completionPct;
    }
    recs.push({ id: m.id, v: m });
  }
  return { records: recs, settings: {} };
}
async function getOps(ctx: Ctx) {
  const rows = await sql`select id, supervisor, assignment, attendance from pharmacists
                         where assignment is not null or attendance is not null`;
  const recs: any[] = [];
  for (const r of rows) {
    const a = r.assignment, t = r.attendance;
    if (!a && !t) continue;
    if (ctx.role === "supervisor" && r.supervisor !== ctx.who) {
      if (a && a.type === "date") recs.push({ id: r.id, v: { a: { type: "date", dateId: a.dateId } } });
      continue;
    }
    recs.push({ id: r.id, v: { a, t } });
  }
  return { records: recs, settings: {} };
}
async function daysList() {
  const rows = await sql`select id, data from training_days`;
  return rows.map((r: any) => ({ id: r.id, v: r.data }));
}
async function daysMap() {
  const rows = await sql`select id, data from training_days`;
  const map: Record<string, any> = {};
  for (const r of rows) map[r.id] = r.data;
  return map;
}
async function getConfig(ctx: Ctx) {
  let days = await daysList();
  const st = await settingsMap();
  let settings: Record<string, any> = {};
  ["maxCapacity", "trainerNames", "coordinatorNames", "trainingNames", "completionCourse", "completionLastSynced"].forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(st, k) && st[k] !== null) settings[k] = st[k];
  });
  if (ctx.role === "supervisor") {
    settings = { maxCapacity: settings.maxCapacity };
    days = days.map((x: any) => {
      const d = x.v || {};
      const q: any = {};
      if (d.supervisorQuotas && Object.prototype.hasOwnProperty.call(d.supervisorQuotas, ctx.who!)) q[ctx.who!] = d.supervisorQuotas[ctx.who!];
      const copy: any = {};
      Object.keys(d).forEach((k) => { copy[k] = d[k]; });
      copy.supervisorQuotas = q;
      delete copy.zoomLink;
      return { id: x.id, v: copy };
    });
  }
  return { records: days, settings };
}

const APPROVAL_TYPE: Record<string, string> = {
  "pending-pharmacists": "New Pharmacist",
  "leave-requests": "Annual Leave",
  "quota-approval-history": "Over-Quota Decision",
};
function approvalFromRow(r: any) {
  const obj = (r.data && typeof r.data === "object") ? { ...r.data } : { id: r.id };
  obj.id = r.id;
  if (r.status) obj.status = r.status;
  obj.rejectionReason = r.reason || obj.rejectionReason || "";
  return obj;
}
function notifFromRow(r: any) {
  return { id: r.id, supervisor: r.supervisor, pharmacistName: r.pharmacist_name, result: r.result, reason: r.reason, decidedAt: r.decided_at, read: r.read, seenInHistory: r.seen_in_history };
}
async function getTable(ctx: Ctx, key: string) {
  let list: any[];
  if (key === "pharmacist-notifications") {
    const rows = await sql`select * from notifications`;
    list = rows.map(notifFromRow);
  } else {
    const type = APPROVAL_TYPE[key];
    const rows = await sql`select * from approvals where type = ${type}`;
    list = rows.map(approvalFromRow);
  }
  if (ctx.role === "supervisor") list = list.filter((x) => x.supervisor === ctx.who);
  return { records: list.map((v) => ({ id: v.id, v })), settings: {} };
}

/* ═════════ WRITE ═════════ */
async function patchKey(ctx: Ctx, req: any) {
  const key = req.key;
  const records = req.records || {};
  const settings = req.settings || {};
  switch (key) {
    case "operations": await patchOps(ctx, records); break;
    case "master-pharmacists": requireTrainer(ctx); await patchMaster(records); break;
    case "training-config": requireTrainer(ctx); await patchConfig(records, settings); break;
    case "company-logo": requireTrainer(ctx); await patchSettings({ logo: settings.logo === undefined ? null : settings.logo }); break;
    case "pending-pharmacists":
    case "leave-requests":
    case "pharmacist-notifications": await patchTableGuarded(ctx, key, records); break;
    case "quota-approval-history": requireTrainer(ctx); await patchApprovals(key, records); break;
    default: throw new Error("Unknown data key.");
  }
  return { ok: true };
}

/* ---------- master roster (trainer only) ---------- */
async function patchMaster(records: Record<string, any>) {
  const ids = Object.keys(records);
  if (!ids.length) return;
  const existing = new Set((await sql`select id from pharmacists where id in ${sql(ids)}`).map((r: any) => r.id));
  for (const id of ids) {
    const m = records[id];
    if (m === null) { await sql`delete from pharmacists where id = ${id}`; continue; }
    const completion = (m.completionPct === undefined || m.completionPct === null) ? null : String(m.completionPct);
    if (existing.has(id)) {
      // Update master fields only — never touch assignment/attendance. Note only when the caller sent one.
      await sql`update pharmacists set
        district = ${m.district || ""}, area_manager = ${m.areaManager || ""}, city = ${m.city || ""},
        supervisor = ${m.supervisor || ""}, pharmacy_no = ${m.pharmacyNo || ""}, employee_id = ${m.employeeId || ""},
        email = ${m.email || ""}, display_name = ${m.displayName || ""}, phone = ${m.phone || ""},
        scfhs = ${m.scfhs || ""}, completion_pct = ${completion}
        where id = ${id}`;
      if (m.note !== undefined) await sql`update pharmacists set note = ${m.note === null ? "" : String(m.note)} where id = ${id}`;
    } else {
      await sql`insert into pharmacists
        (id, district, area_manager, city, supervisor, pharmacy_no, employee_id, email, display_name, phone, scfhs, note, completion_pct)
        values (${id}, ${m.district || ""}, ${m.areaManager || ""}, ${m.city || ""}, ${m.supervisor || ""},
          ${m.pharmacyNo || ""}, ${m.employeeId || ""}, ${m.email || ""}, ${m.displayName || ""}, ${m.phone || ""},
          ${m.scfhs || ""}, ${m.note === undefined || m.note === null ? "" : String(m.note)}, ${completion})`;
    }
  }
}

/* ---------- assignments & attendance ---------- */
async function patchOps(ctx: Ctx, records: Record<string, any>) {
  const ids = Object.keys(records);
  if (!ids.length) return;
  const days = await daysMap();
  const st = await settingsMap();
  const defaultCap = Number(st.maxCapacity) || CONFIG.DEFAULT_CAPACITY;

  await sql.begin(async (tx: any) => {
    // Serialize all operations writes (like the old script lock) so seat counts stay correct under concurrency.
    await tx`select pg_advisory_xact_lock(911)`;
    const all = await tx`select id, supervisor, city, assignment, attendance from pharmacists`;
    const byId: Record<string, any> = {};
    const counts: Record<string, number> = {};
    const supCounts: Record<string, Record<string, number>> = {};
    for (const r of all) {
      byId[r.id] = r;
      const a = r.assignment;
      if (a && a.type === "date") {
        counts[a.dateId] = (counts[a.dateId] || 0) + 1;
        (supCounts[a.dateId] ||= {})[r.supervisor] = (supCounts[a.dateId]?.[r.supervisor] || 0) + 1;
      }
    }
    const bump = (a: any, sup: string, delta: number) => {
      if (a && a.type === "date") {
        counts[a.dateId] = (counts[a.dateId] || 0) + delta;
        (supCounts[a.dateId] ||= {})[sup] = (supCounts[a.dateId]?.[sup] || 0) + delta;
      }
    };

    const updates: { id: string; a: any; t: any }[] = [];
    for (const id of ids) {
      const row = byId[id];
      if (!row) continue;
      const rec = records[id] || {};
      const curA = row.assignment, curT = row.attendance;
      let a = Object.prototype.hasOwnProperty.call(rec, "a") ? rec.a : curA;
      const t = Object.prototype.hasOwnProperty.call(rec, "t") ? rec.t : curT;
      const sup = row.supervisor;

      if (ctx.role === "supervisor") {
        if (sup !== ctx.who) throw new Error("Not allowed: that pharmacist belongs to another supervisor.");
        if (Object.prototype.hasOwnProperty.call(rec, "t") && rec.t !== null) throw new Error("Only trainers can record attendance.");
        if (Object.prototype.hasOwnProperty.call(rec, "a")) {
          bump(curA, sup, -1);
          try {
            a = validateSupervisorAssignment(ctx, row, curA, rec.a, days, counts, supCounts, defaultCap);
          } catch (e) { bump(curA, sup, +1); throw e; }
          bump(a, sup, +1);
        }
      } else if (Object.prototype.hasOwnProperty.call(rec, "a")) {
        bump(curA, sup, -1);
        bump(a, sup, +1);
      }
      updates.push({ id, a, t });
    }

    for (const u of updates) {
      await tx`update pharmacists set assignment = ${jbTx(tx, u.a)}, attendance = ${jbTx(tx, u.t)} where id = ${u.id}`;
    }
  });
}
const jbTx = (tx: any, v: unknown) => (v == null ? null : tx.json(v as any));

function validateSupervisorAssignment(ctx: Ctx, row: any, oldA: any, newA: any, days: Record<string, any>, counts: Record<string, number>, supCounts: Record<string, Record<string, number>>, defaultCap: number) {
  if (newA === null) return null;
  if (!newA || typeof newA !== "object") throw new Error("Invalid assignment.");
  if (newA.type === "leave") {
    if (LEAVE_STATUSES.indexOf(newA.status) === -1) throw new Error("Invalid status.");
    return { type: "leave", status: newA.status, assignedBy: ctx.who, assignedAt: nowIso() };
  }
  if (newA.type !== "date") throw new Error("Invalid assignment type.");
  const day = days[newA.dateId];
  if (!day) throw new Error("That training day no longer exists.");
  const sameDay = oldA && oldA.type === "date" && oldA.dateId === newA.dateId;
  if (!sameDay) {
    if (day.active === false) throw new Error("That training day is not open.");
    if ((day.visibleSupervisors || []).indexOf(ctx.who) === -1) throw new Error("That training day is not available to you.");
    const pharmacistOnline = String(row.city).trim().toLowerCase() === "online";
    if (pharmacistOnline !== !!day.isOnline) throw new Error("Online pharmacists can only join online days (and vice versa).");
    if (day.deadline) {
      const dl = Date.parse(day.deadline);
      if (!isNaN(dl) && Date.now() > dl) throw new Error("The deadline for that training day has passed.");
    }
    const cap = day.capacity > 0 ? Number(day.capacity) : defaultCap;
    if ((counts[newA.dateId] || 0) >= cap) throw new Error("That training day is full (" + cap + ").");
  }
  const out: any = { type: "date", dateId: newA.dateId, assignedBy: ctx.who, assignedAt: sameDay && oldA.assignedAt ? oldA.assignedAt : nowIso(), overQuota: false, quotaApproved: true };
  if (day.isOnline && day.supervisorQuotas && Object.prototype.hasOwnProperty.call(day.supervisorQuotas, ctx.who!)) {
    if (sameDay && oldA.overQuota) {
      out.overQuota = true; out.quotaApproved = !!oldA.quotaApproved;
    } else {
      const quota = Number(day.supervisorQuotas[ctx.who!]);
      const mine = (supCounts[newA.dateId] && supCounts[newA.dateId][ctx.who!]) || 0;
      if (mine >= quota) { out.overQuota = true; out.quotaApproved = false; }
    }
  }
  return out;
}

/* ---------- training config: days + settings (trainer only) ---------- */
async function patchConfig(records: Record<string, any>, settings: Record<string, any>) {
  for (const id of Object.keys(records)) {
    const d = records[id];
    if (d === null) { await sql`delete from training_days where id = ${id}`; continue; }
    await sql`insert into training_days (id, data, updated_at) values (${id}, ${jb(d)}, now())
              on conflict (id) do update set data = excluded.data, updated_at = now()`;
  }
  if (Object.keys(settings).length) await patchSettings(settings);
}

/* ---------- approvals / notifications ---------- */
function approvalColumns(key: string, obj: any) {
  const base = { supervisor: obj.supervisor || "", pharmacist: obj.displayName || "", reason: obj.rejectionReason || "", data: obj };
  if (key === "pending-pharmacists") return { ...base, type: "New Pharmacist", status: obj.status || "Pending", submitted_at: obj.addedAt || "", decided_at: obj.decidedAt || "" };
  if (key === "leave-requests") return { ...base, type: "Annual Leave", status: obj.status || "Pending", submitted_at: obj.requestedAt || "", decided_at: obj.decidedAt || "" };
  // quota-approval-history
  return { ...base, type: "Over-Quota Decision", status: obj.status || "", submitted_at: "", decided_at: obj.decidedAt || "" };
}
async function patchApprovals(key: string, records: Record<string, any>) {
  for (const id of Object.keys(records)) {
    const v = records[id];
    if (v === null) { await sql`delete from approvals where id = ${id}`; continue; }
    const c = approvalColumns(key, v);
    await sql`insert into approvals (id, type, status, supervisor, pharmacist, submitted_at, decided_at, reason, data)
      values (${id}, ${c.type}, ${c.status}, ${c.supervisor}, ${c.pharmacist}, ${c.submitted_at}, ${c.decided_at}, ${c.reason}, ${jb(c.data)})
      on conflict (id) do update set type = excluded.type, status = excluded.status, supervisor = excluded.supervisor,
        pharmacist = excluded.pharmacist, submitted_at = excluded.submitted_at, decided_at = excluded.decided_at,
        reason = excluded.reason, data = excluded.data`;
  }
}
async function patchNotifications(records: Record<string, any>) {
  for (const id of Object.keys(records)) {
    const n = records[id];
    if (n === null) { await sql`delete from notifications where id = ${id}`; continue; }
    await sql`insert into notifications (id, supervisor, pharmacist_name, result, reason, decided_at, read, seen_in_history)
      values (${id}, ${n.supervisor || ""}, ${n.pharmacistName || ""}, ${n.result || ""}, ${n.reason || ""}, ${n.decidedAt || ""}, ${!!n.read}, ${!!n.seenInHistory})
      on conflict (id) do update set supervisor = excluded.supervisor, pharmacist_name = excluded.pharmacist_name,
        result = excluded.result, reason = excluded.reason, decided_at = excluded.decided_at,
        read = excluded.read, seen_in_history = excluded.seen_in_history`;
  }
}

async function patchTableGuarded(ctx: Ctx, key: string, records: Record<string, any>) {
  if (ctx.role === "trainer") {
    if (key === "pharmacist-notifications") return await patchNotifications(records);
    return await patchApprovals(key, records);
  }
  // supervisor: re-check every change (ownership / status), exactly like Code.gs
  const existing: Record<string, any> = {};
  if (key === "pharmacist-notifications") {
    (await sql`select * from notifications`).forEach((r: any) => { existing[r.id] = notifFromRow(r); });
  } else {
    const type = APPROVAL_TYPE[key];
    (await sql`select * from approvals where type = ${type}`).forEach((r: any) => { existing[r.id] = approvalFromRow(r); });
  }
  const safe: Record<string, any> = {};
  for (const id of Object.keys(records)) {
    const v = records[id], ex = existing[id];
    if (key === "pharmacist-notifications") {
      if (v === null) throw new Error("Not allowed.");
      if (!ex || ex.supervisor !== ctx.who) throw new Error("Not allowed.");
      safe[id] = { id, supervisor: ex.supervisor, pharmacistName: ex.pharmacistName, result: ex.result, reason: ex.reason, decidedAt: ex.decidedAt, read: !!v.read, seenInHistory: !!v.seenInHistory };
      continue;
    }
    if (v === null) {
      if (!ex || ex.supervisor !== ctx.who || ex.status !== "Pending") throw new Error("Only your own pending requests can be removed.");
      safe[id] = null;
      continue;
    }
    if (v.supervisor !== ctx.who) throw new Error("Requests can only be submitted for your own name.");
    if (ex && (ex.supervisor !== ctx.who || ex.status !== "Pending")) throw new Error("This request has already been decided.");
    if (v.status !== "Pending") throw new Error("New requests must start as Pending.");
    safe[id] = v;
  }
  if (key === "pharmacist-notifications") return await patchNotifications(safe);
  return await patchApprovals(key, safe);
}
