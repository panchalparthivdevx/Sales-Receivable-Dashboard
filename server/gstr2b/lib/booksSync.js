/**
 * Zoho Books → GSTR-2B Reco sync (read-only).
 *
 * Modes
 *   period       first sync / selectable history: lists every document posted in [from, to] month by month, then fetches the
 *                detail of each in-scope one (the list has no GST amounts). Safe to repeat: upserts are idempotent.
 *   incremental  change feed: documents modified since the last high-water mark (15-minute overlap), then details. This is what
 *                the scheduler runs every 15 minutes; it never lists the history again.
 *   recheck      re-lists the synced months, removes what Zoho no longer has (a deleted document never shows up in a
 *                "modified since" list, so only an ID comparison finds it — each candidate is confirmed by a GET first), compares
 *                every stored total with Zoho's list (the "checked against Zoho" report) and retries documents that failed.
 *
 * Resumable by design, at two levels:
 *   - a listing pass (period / recheck) remembers which months it has listed (state.pass + state.windows), so a pass that was cut
 *     short — a time slice online, the daily budget, a crash — continues with the next month and lists nothing twice;
 *   - the detail queue IS the stored documents that still say detail_pending, so amounts are fetched exactly once however often
 *     a run is interrupted.
 * Speed: calls take turns in a calls-per-minute queue shared by a few workers, so the rate set in Settings is kept whatever Zoho's
 * answer times are. A run also stops for the day at this module's own budget or when Zoho reports that the organisation's own
 * allowance has fallen to the reserve kept for the other integrations (see config sync.*).
 */

'use strict';

const store = require('./store');
const books = require('./booksStore');
const C = require('./canonBooks');
const N = require('./normalize');
const { ZohoLimit } = require('./zohoRead');
const { uid, nowIso, sleep } = require('./util');
const { p0 } = require('./money');

const KINDS = {
  bill:          { path: '/bills',         key: 'bills',          detail: id => `/bills/${id}`,         dkey: 'bill',          label: 'bills' },
  vendor_credit: { path: '/vendorcredits', key: 'vendor_credits', detail: id => `/vendorcredits/${id}`, dkey: 'vendor_credit', label: 'vendor credits' },
  expense:       { path: '/expenses',      key: 'expenses',       detail: id => `/expenses/${id}`,      dkey: 'expense',       label: 'GST-bearing expenses' },
};
const MARGIN_MS = 15 * 60000;                                      // the change feed re-reads this much before its checkpoint (documents are keyed by id, so the overlap can never duplicate one)
const PASS_RESUME_MS = 12 * 3600 * 1000;                           // a listing pass left unfinished for longer than this starts again from the top
const FLUSH_DOCS = 50, FLUSH_MS = 15000;                           // amounts are saved in batches: after this many documents or this long, whichever comes first

class Stop extends Error { constructor(kind, msg) { super(msg); this.stop = kind; } }   // budget | reserve | time | cancel

const monthsBetween = (from, to) => {                               // ["2026-11", "2026-10", …] newest first
  const out = [];
  let y = +to.slice(0, 4), m = +to.slice(5, 7);
  const fy = +from.slice(0, 4), fm = +from.slice(5, 7);
  while (y > fy || (y === fy && m >= fm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (--m === 0) { m = 12; y--; } }
  return out;
};
/** Zoho timestamps look like 2026-11-12T17:07:57+0530 (milliseconds since the epoch; 0 when empty or unreadable) */
const lmtMs = s => { if (!s) return 0; const t = Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')); return Number.isNaN(t) ? 0 : t; };
/** The form Zoho accepts for the "modified since" filter: ISO 8601 with an offset (it refuses "YYYY-MM-DD HH:MM:SS") */
const lmtParam = ms => `${new Date(ms).toISOString().slice(0, 19)}+0000`;
/** The first month of Books documents synced so far: the earliest period asked for (older stored states: the earliest month listed) */
const syncedFrom = st => st.synced_from || Object.keys(st.windows || {}).map(k => k.split(':')[1]).filter(Boolean).sort()[0] || null;
const lastDay = ym => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)); return `${ym}-${String(d.getUTCDate()).padStart(2, '0')}`; };

/** What a list row changes on a stored document: a void applies at once; an edit marks the old details stale */
function mergeList(old, light) {
  if (!old) return light;
  if (light.excluded && light.excluded !== 'recipient_unmapped') {
    return { ...old, status: light.status, excluded: light.excluded, excluded_text: light.excluded_text, detail_pending: false, stale: false, hash: light.hash, source: { ...old.source, lmt: light.source.lmt, list_at: light.source.list_at } };
  }
  const changed = (old.source.lmt || '') !== (light.source.lmt || '');
  if (old.amounts && !changed && !old.excluded) return { ...old, status: light.status, source: { ...old.source, list_at: light.source.list_at } };
  if (old.amounts) return { ...old, status: light.status, detail_pending: true, stale: true, source: { ...old.source, lmt_listed: light.source.lmt, list_at: light.source.list_at } };
  return { ...light, detail_fail: old.detail_fail || 0 };
}

/**
 * The calls-per-minute queue. Each call takes a turn; turns are 60 / rate seconds apart however many workers are waiting, so the
 * rate holds whether Zoho answers in 0.2 s or 2 s. When Zoho answers "too many requests" nobody takes a turn until the wait it
 * asked for is over.
 */
function limiter(ratePerMin, sleepFn = sleep) {
  const gap = 60000 / Math.max(1, Number(ratePerMin) || 1);
  let next = 0, hold = 0;
  return {
    gap,
    async turn() { const now = Date.now(); const at = Math.max(now, next, hold); next = at + gap; if (at - now >= 1) await sleepFn(at - now); },
    holdFor(ms) { hold = Math.max(hold, Date.now() + ms); },
  };
}

/**
 * useLease (online only): a run also writes a short lease into the stored state, so a second click, tab, user or scheduler call
 * that lands on ANOTHER serverless instance sees "already running" — the in-memory map below only knows its own process. The lease
 * expires by itself (the step's deadline plus a grace for saving), so a run the platform killed never blocks the next one.
 * On the office PC the process itself is the authority and a stale lease must never block a sync after a restart.
 */
const LEASE_GRACE_MS = 90000;
const leaseHeld = st => !!(st.lease && Date.parse(st.lease.until) > Date.now());

// zoho_count = Zoho's own count for the same months (uncounted = listings for which it gave none); zoho_rows = the different documents its list returned
const emptyCheck = () => ({ zoho_count: 0, uncounted: 0, zoho_rows: 0, zoho_total_p: 0, stored: 0, not_kept: 0, kept_out: 0, waiting: 0, agree: 0, agree_total_p: 0, differ: 0, differ_p: 0, taxable_p: 0, tax_p: 0, differ_docs: [] });
const idOf = r => String(r.bill_id || r.vendor_credit_id || r.expense_id);
const addCheck = (a, b) => { for (const k of Object.keys(b)) { if (k === 'differ_docs') a.differ_docs = [...a.differ_docs, ...b.differ_docs].slice(0, 20); else a[k] = (a[k] || 0) + b[k]; } return a; };

function create({ zr, cfgNow, readSynced = async () => null, audit = { log: async () => {} }, log = console, sleepFn = sleep, useLease = false }) {
  const running = new Map();                                        // company id → { run_id, cancel, started_at }
  const stateKey = co => `sync_${co}`;
  const EMPTY = () => ({ branches: {}, branches_at: null, hwm: {}, windows: {}, budget: { day: '', used: 0 }, runs: [], last_ok_at: null, last_error: null, lease: null,
    pass: null, initial: null, counts: null, live: null, recon_due: false, zoho: null, verify: null, last_checked_at: null });

  /** A state written before the first-sync record existed: describe that first sync from what it left behind (the months listed, the change-feed start) */
  function adopt(st) {
    if (st.initial || !Object.keys(st.hwm || {}).length) return st;
    const months = Object.keys(st.windows || {}).filter(k => k.startsWith('bill:')).map(k => k.slice(5)).sort();
    const from = syncedFrom(st), to = months[months.length - 1] || null;
    const whole = !!from && !!to && monthsBetween(from, to).every(m => st.windows[`bill:${m}`] && st.windows[`expense:${m}`]);
    const stamps = Object.values(st.windows || {}).map(w => w.at).filter(Boolean).sort();
    st.initial = { from, to, started_at: Object.values(st.hwm).sort()[0], by: '', listed_at: whole ? stamps[stamps.length - 1] : null, completed_at: null };
    return st;
  }
  const loadState = async co => adopt({ ...EMPTY(), ...((await store.read(stateKey(co), null)) || {}) });
  const saveState = (co, st) => store.write(stateKey(co), st);

  async function buildCtx(co, st) {
    const list = await zr.listBranches(co.org_id);
    st.branches = Object.fromEntries(list.map(b => [b.id, b])); st.branches_at = nowIso();
    const vendors = new Map();
    try { const v = await readSynced(co.id, 'vendors_all'); for (const x of (v && v.data) || []) vendors.set(String(x.contact_id), { gstin: x.gst_no, pan: x.pan_no, name: x.contact_name }); } catch (_) { /* optional enrichment */ }
    // Only GSTINs that are switched on are worth a Zoho call per document (nothing is reconciled for the others); null = none set up yet
    const regs = co.registrations || [];
    const activeGstins = regs.length ? new Set(regs.filter(r => r.active !== false).map(r => N.normGstin(r.gstin))) : null;
    return { company: co, branches: new Map(list.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors, activeGstins, periodFrom: null };
  }

  /** The Zoho call options for one run: its turn in the calls-per-minute queue, the per-day limits, the time slice and cancel — checked before every call */
  function guard(co, st, cfg, run, deadline, lim) {
    const alive = () => {
      if (run.cancel) throw new Stop('cancel', 'Stopped by a user');
      if (Date.now() > deadline) throw new Stop('time', 'This step used its time; the sync continues with the next step');
    };
    return {
      onThrottle: secs => lim.holdFor(secs * 1000),
      before: async () => {
        alive();
        const today = N.todayIST();
        if (st.budget.day !== today) st.budget = { day: today, used: 0 };
        if (st.budget.used >= cfg.sync.daily_budget) throw new Stop('budget', `This module's own Zoho budget for today (${cfg.sync.daily_budget} calls) is used — it continues after midnight (India time), or raise the budget in Settings`);
        // Zoho's own count for the whole organisation (every integration): never take it below the reserve
        const u = zr.usage ? zr.usage(co.org_id) : null;
        if (u && u.day_remaining !== null && u.day_reset_at && Date.parse(u.day_reset_at) > Date.now() && u.day_remaining <= (cfg.sync.zoho_reserve || 0)) {
          throw new Stop('reserve', `Zoho reports ${u.day_remaining} of the organisation's ${u.day_limit} calls left for today, and this module keeps ${cfg.sync.zoho_reserve} free for the other integrations — it continues after midnight (India time)`);
        }
        await lim.turn();
        alive();
        st.budget.used++; run.calls++;
      },
    };
  }

  /**
   * How the documents Zoho lists compare with what is stored, for the "checked against Zoho" report: every listed document is
   * either not kept (an expense without GST), kept out of matching (with its reason), still waiting for its amounts, or has its
   * amounts — and then Zoho's list total must equal the total stored from the document itself.
   */
  async function compare(co, kind, listed, range, count) {
    const c = emptyCheck();
    if (count === null || count === undefined) c.uncounted = 1; else c.zoho_count = count;
    const have = new Map((await books.all(co.id, range)).filter(d => d.kind === kind && !d.deleted).map(d => [d.zoho_id, d]));
    for (const [id, total] of listed) {
      c.zoho_rows++; c.zoho_total_p += total;
      const d = have.get(id);
      if (!d) { c.not_kept++; continue; }
      c.stored++;
      if (d.excluded) { c.kept_out++; continue; }
      if (d.detail_pending || !d.amounts) { c.waiting++; continue; }
      c.taxable_p += d.amounts.taxable || 0; c.tax_p += d.tax_total || 0;
      if ((d.zoho_total_net ?? null) === total) { c.agree++; c.agree_total_p += total; }
      else { c.differ++; c.differ_p += (d.zoho_total_net || 0) - total; if (c.differ_docs.length < 20) c.differ_docs.push({ kind, doc_no: d.doc_no || d.zoho_id, date: d.posting_date || '', zoho_p: total, stored_p: d.zoho_total_net ?? null }); }
    }
    return c;
  }

  /** Zoho's own count for a list filter: asked with response_option=2 a list answers with the count alone (seen live, 13 Nov 2026). null when it gives none. */
  async function countOf(co, kind, params, g) {
    try {
      const d = await zr.get(co.org_id, KINDS[kind].path, { ...params, response_option: 2 }, g);
      const n = d && d.page_context ? Number(d.page_context.total) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch (e) { if (e instanceof Stop || e instanceof ZohoLimit) throw e; return null; }
  }

  /**
   * Every document of a list — completely. Zoho pages a sorted list, and when many rows sort alike (a hundred documents of one date)
   * a page boundary can fall inside them: one document then comes back twice and another not at all. Seen live on 13 Nov 2026 — the
   * vendor-credit list sorted by date returned 522 rows but only 519 different documents, every time, while Zoho's own count said 522.
   * So: the list is sorted by created time (unlike a date, practically unique — the same check found all 522), rows are keyed by Zoho
   * id, and whenever more than one page was read (or `always`) Zoho's own count is asked for; while documents are missing the list is
   * read again in the opposite order. `onRows(rows)` gets each document once. → { listed: Map(id → list total in paise), count, complete }
   */
  async function listAll(co, kind, params, g, onRows, summary, { always = false } = {}) {
    const K = KINDS[kind];
    const listed = new Map();
    let count = null, pages = 0;
    for (let reading = 0; reading < 3; reading++) {
      await zr.list(co.org_id, K.path, K.key, { ...params, sort_column: 'created_time', sort_order: reading % 2 ? 'D' : 'A' }, {
        ...g, onPage: async page => {
          pages++;
          const fresh = [];
          for (const r of page) { const id = idOf(r); if (!listed.has(id)) fresh.push(r); listed.set(id, p0(r.total)); }
          if (fresh.length) await onRows(fresh);
          return true;                                                           // read every page
        },
      });
      if (!always && pages <= 1) break;                                          // a single page has no boundary to lose a document at
      count = await countOf(co, kind, params, g);
      if (count === null || listed.size >= count) break;
    }
    const complete = count === null || listed.size >= count;
    if (!complete) summary.warnings.push(`Zoho counts ${count} ${K.label}${params.date_start ? ` dated ${params.date_start.slice(0, 7)}` : ''} but its list returned only ${listed.size} different ones in three readings — the missing ones are looked for again at the next check.`);
    return { listed, count, complete };
  }

  async function listWindow(co, ctx, kind, month, g, summary, { recheck = false } = {}) {
    let kept = 0;
    const r = await listAll(co, kind, { date_start: `${month}-01`, date_end: lastDay(month) }, g, async rows => {
      const docs = [];
      for (const row of rows) {
        if (kind === 'expense' && C.listExclusion(row, ctx, kind)) continue;        // only GST-bearing expenses are kept
        docs.push(C.fromList(row, ctx, kind)); kept++;
      }
      const s = await books.upsertMany(co.id, docs, mergeList);
      summary.lists[kind].added += s.added; summary.lists[kind].changed += s.changed;
    }, summary, { always: recheck });
    summary.lists[kind].rows += r.listed.size;
    let check = null;
    if (recheck) {
      if (r.complete) await removeMissing(co, ctx, kind, month, new Set(r.listed.keys()), g, summary);     // an incomplete list proves nothing about what is gone
      check = await compare(co, kind, r.listed, { fromYm: month, toYm: month }, r.count);
    }
    return { rows: r.listed.size, kept, check, count: r.count, complete: r.complete };
  }

  /** Documents we hold for `month` that the list no longer returns: confirm each by a GET, then mark deleted */
  async function removeMissing(co, ctx, kind, month, listed, g, summary) {
    const local = (await books.all(co.id, { fromYm: month, toYm: month })).filter(d => d.kind === kind && !d.deleted && !listed.has(d.zoho_id));
    if (!local.length) return;
    if (local.length > 300) { summary.warnings.push(`${local.length} ${KINDS[kind].label} of ${month} are missing from Zoho's list — more than 300, so nothing was removed (the list looks incomplete).`); return; }
    const K = KINDS[kind], gone = [];
    for (const d of local) {
      try { await zr.get(co.org_id, K.detail(d.zoho_id), {}, g); summary.warnings.push(`${d.kind} ${d.doc_no || d.zoho_id} was not in Zoho's list for ${month} but still exists — kept.`); }
      catch (e) { if (zr.isGone(e)) gone.push({ ...d, deleted: true, deleted_at: nowIso(), excluded: 'deleted', excluded_text: C.EXCLUSIONS.deleted, detail_pending: false, stale: false, hash: `deleted:${d.id}` }); else throw e; }
    }
    if (gone.length) { await books.upsertMany(co.id, gone); summary.details.deleted += gone.length; }
  }

  /**
   * Documents modified since the high-water mark (minus the overlap), asked of Zoho with its own "modified since" filter.
   * The list is FILTERED by last_modified_time, not SORTED by it: Zoho accepts sort_column=last_modified_time for bills and vendor
   * credits but refuses it for expenses ("Invalid value passed for sort_column", code 2 — seen live on 12 Nov 2026, and the first
   * "Sync changes now" after a first sync failed on it), whereas the filter works on all three lists (verified live the same day).
   * The mark moves only after every page has been saved AND the list was complete, to the moment this run started — so a document
   * edited while the run was going is read again by the next one, and a run that is cut short repeats its window instead of skipping it.
   */
  async function feed(co, ctx, kind, st, g, summary, runStart) {
    const hwm = st.hwm[kind];
    if (!hwm) { summary.warnings.push(`No initial sync yet for ${KINDS[kind].label} — run "Sync a period" first.`); return false; }
    const cutoff = lmtMs(hwm) - MARGIN_MS;
    const r = await listAll(co, kind, { last_modified_time: lmtParam(cutoff) }, { ...g, maxPages: 60 }, async rows => {
      const docs = [];
      for (const row of rows) {
        if (lmtMs(row.last_modified_time) < cutoff) continue;                      // Zoho's filter already says so; kept as a safety net
        if (kind === 'expense' && C.listExclusion(row, ctx, kind)) continue;
        docs.push(C.fromList(row, ctx, kind));
      }
      const s = await books.upsertMany(co.id, docs, mergeList);
      summary.lists[kind].added += s.added; summary.lists[kind].changed += s.changed;
    }, summary);
    summary.lists[kind].rows += r.listed.size;
    if (r.complete) st.hwm[kind] = runStart;                                      // otherwise the next change check reads the same window again
    return true;
  }

  /** The amounts of every document that is waiting for them, a few calls at a time, saved in batches */
  async function fetchDetails(co, ctx, g, summary, st, cfg) {
    // The GSTINs switched on and the months synced decide which documents are worth a call: apply them to what is stored (no Zoho call)
    // whenever either changed since the last run
    const sig = `${ctx.activeGstins ? [...ctx.activeGstins].sort().join(',') : '*'}|${ctx.periodFrom || ''}`;
    if (st.scope_sig !== sig) {
      summary.scope = await books.applyScope(co.id, C.EXCLUSIONS, (gstin, date) => C.scopeExclusion(gstin, date, ctx));
      st.scope_sig = sig;
    }
    const pending = (await books.pendingDetails(co.id)).filter(d => (d.detail_fail || 0) < books.FAIL_LIMIT);
    summary.details.queued = pending.length;
    let buf = [], next = 0, halt = null, flushedAt = Date.now(), saving = Promise.resolve();
    const flush = () => {
      saving = saving.then(async () => {
        if (!buf.length) return;
        const b = buf; buf = [];
        await books.upsertMany(co.id, b, (o, n) => n);
        flushedAt = Date.now();
        st.live = { run_id: summary.run_id, mode: summary.mode, by: summary.by, started_at: summary.started_at, at: nowIso(), queued: summary.details.queued, fetched: summary.details.fetched, failed: summary.details.failed, deleted: summary.details.deleted };
        await saveState(co.id, st);
      });
      return saving;
    };
    const one = async d => {
      const K = KINDS[d.kind];
      try {
        const data = await zr.get(co.org_id, K.detail(d.zoho_id), {}, g);
        const raw = data[K.dkey];
        if (!raw) throw new Error(`Zoho returned no ${K.dkey}`);
        buf.push(C.fromDetail(raw, null, ctx, d.kind));
        summary.details.fetched++;
      } catch (e) {
        if (e instanceof Stop || e instanceof ZohoLimit) throw e;
        if (zr.isGone(e)) { buf.push({ ...d, deleted: true, deleted_at: nowIso(), excluded: 'deleted', excluded_text: C.EXCLUSIONS.deleted, detail_pending: false, stale: false, hash: `deleted:${d.id}` }); summary.details.deleted++; }
        else { summary.details.failed++; buf.push({ ...d, detail_fail: (d.detail_fail || 0) + 1, detail_error: zr.errText(e).slice(0, 200) }); log.error && log.error(`[gstr2b:${co.id}] detail ${d.kind} ${d.zoho_id}: ${zr.errText(e)}`); }
      }
    };
    const worker = async () => {
      while (!halt && next < pending.length) {
        const d = pending[next++];
        try {
          await one(d);
          if (buf.length >= FLUSH_DOCS || Date.now() - flushedAt > FLUSH_MS) await flush();
        } catch (e) { halt = halt || e; }
      }
    };
    const workers = Math.max(1, Math.min(8, Math.round(Number(cfg.sync.concurrency) || 1)));
    try { await Promise.all(Array.from({ length: workers }, worker)); }
    finally { try { await flush(); } catch (e) { halt = halt || e; } }
    if (halt) throw halt;
  }

  /**
   * @param {object} o { company, mode: 'period'|'incremental'|'recheck', from: 'YYYY-MM', to: 'YYYY-MM', by, maxMs, kinds,
   *                     auto: started by the scheduler or by a page that was opened (a run that finds nothing is then not recorded) }
   * @returns the run summary (never throws for Zoho limits / budget / time — those end the run as "partial" or "paused")
   */
  async function run(o) {
    // The place is taken at once, before anything is awaited: two requests arriving in the same instant cannot both start
    const held = running.get(o.company);
    const runInfo = { run_id: uid('run_'), cancel: false, started_at: nowIso(), calls: 0 };
    if (!held) running.set(o.company, runInfo);
    const mode = o.mode || 'incremental';
    let cfg, co, st, deadline;
    try {
      cfg = await cfgNow();
      co = cfg.companies.find(c => c.id === o.company);
      if (!co) throw new Error(`Unknown company "${o.company}"`);
      if (co.demo) throw new Error('The demo company has no Zoho organisation — it cannot be synced');
      if (!co.active) throw new Error(`${co.name} is switched off in Settings`);
      if (held) return { busy: true, message: `A sync of ${co.name} is already running`, run_id: held.run_id };
      deadline = Date.now() + (o.maxMs || cfg.sync.slice_seconds * 1000);
      st = await loadState(co.id);
      if (useLease && leaseHeld(st)) {
        running.delete(co.id);
        return { busy: true, message: `A sync of ${co.name} is already running (started by ${st.lease.by}) — it ends within a few minutes`, run_id: st.lease.run_id };
      }
      if (useLease) { st.lease = { run_id: runInfo.run_id, by: o.by || 'system', at: runInfo.started_at, until: new Date(deadline + LEASE_GRACE_MS).toISOString() }; await saveState(co.id, st); }
    } catch (e) { if (!held) running.delete(o.company); throw e; }
    const summary = {
      run_id: runInfo.run_id, company: co.id, mode, by: o.by || 'system', started_at: runInfo.started_at, finished_at: null, status: 'running',
      from: o.from || null, to: o.to || null,
      lists: Object.fromEntries(Object.keys(KINDS).map(k => [k, { rows: 0, added: 0, changed: 0 }])),
      details: { queued: 0, fetched: 0, failed: 0, deleted: 0 }, windows_listed: 0, windows_skipped: 0, scope: null, retried: 0, warnings: [], calls: 0, error: null, message: '',
    };
    if (st.budget.day !== N.todayIST()) st.budget = { day: N.todayIST(), used: 0 };      // new India-time day → fresh budget
    let quiet = false;
    const lim = limiter(cfg.sync.rate_per_min, sleepFn);
    const g = guard(co, st, cfg, runInfo, deadline, lim);
    const kinds = o.kinds || Object.keys(KINDS);
    try {
      const ctx = await buildCtx(co, st);
      st.budget.used += 1; runInfo.calls += 1;                                  // the branches call
      if (mode === 'period' || mode === 'recheck') {
        const today = N.todayIST();
        // a re-check without months re-reads the months already synced (not two financial years the user never asked for)
        const from = o.from || (mode === 'recheck' && syncedFrom(st)) || `${N.fyStart(today) - 1}-04`, to = o.to || today.slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) throw new Error('Choose a period like 2025-04 to 2026-11');
        summary.from = from; summary.to = to;
        const first = syncedFrom(st);
        st.synced_from = !first || from < first ? from : first;                   // the first month ever synced: older documents wait until a period reaching them is synced
        ctx.periodFrom = `${st.synced_from}-01`;
        // The change feed starts from the FIRST listing (set before listing, so a document edited while a long, multi-step
        // first sync is still going is caught by the next change feed); a later period run never moves it.
        for (const kind of kinds) if (!st.hwm[kind]) st.hwm[kind] = runInfo.started_at;
        // The same request again while its work is unfinished CONTINUES it: the months already listed in this pass are not listed again
        // (online a first sync is many short steps, each asking for the same period — and a step must spend its calls on amounts, not on
        // listing). A period whose work is finished, a different period or a pass left for half a day starts a new pass.
        const same = !!st.pass && st.pass.mode === mode && st.pass.from === from && st.pass.to === to && Date.now() - Date.parse(st.pass.started_at) < PASS_RESUME_MS;
        const unfinished = same && (!st.pass.listed_at || (mode === 'period' && !(st.initial && st.initial.completed_at)));
        if (o.force || !unfinished) {
          st.pass = { mode, from, to, by: summary.by, started_at: runInfo.started_at, listed_at: null, credits_at: null, check: {} };
          if (mode === 'period') st.initial = { from: st.synced_from, to, started_at: runInfo.started_at, by: summary.by, listed_at: null, completed_at: null };
          if (mode === 'recheck') summary.retried = await books.resetFailures(co.id);          // documents set aside after repeated failures get their attempts back
        }
        const pass = st.pass;
        pass.check = pass.check || {};
        let removedSeen = 0;
        const noteRemoved = () => { pass.deleted = (pass.deleted || 0) + summary.details.deleted - removedSeen; removedSeen = summary.details.deleted; };
        for (const month of monthsBetween(from, to)) {
          for (const kind of kinds) {
            if (kind === 'vendor_credit') continue;                               // credits are few: one full list below, not per month
            const w = st.windows[`${kind}:${month}`];
            if (w && w.at >= pass.started_at) { summary.windows_skipped++; continue; }             // listed earlier in this same pass
            const r = await listWindow(co, ctx, kind, month, g, summary, { recheck: mode === 'recheck' });
            st.windows[`${kind}:${month}`] = { at: nowIso(), rows: r.rows, kept: r.kept, count: r.count, complete: r.complete };
            if (r.check) pass.check[kind] = addCheck(pass.check[kind] || emptyCheck(), r.check);
            summary.windows_listed++; noteRemoved();
          }
          await saveState(co.id, st);
        }
        if (kinds.includes('vendor_credit') && !pass.credits_at) {
          const check = await listAllCredits(co, ctx, g, summary, mode === 'recheck');
          if (check) pass.check.vendor_credit = check;
          pass.credits_at = nowIso(); summary.windows_listed++; noteRemoved();
        }
        if (!pass.listed_at) {
          pass.listed_at = nowIso();
          st.last_checked_at = pass.listed_at;
          if (mode === 'recheck') st.verify = verifyReport(pass);                   // how every listed document compares with what is stored
        }
        if (mode === 'period' && st.initial && !st.initial.listed_at) st.initial.listed_at = pass.listed_at;
        await saveState(co.id, st);
      } else {
        const sf = syncedFrom(st);
        ctx.periodFrom = sf ? `${sf}-01` : null;
        let fed = 0;
        for (const kind of kinds) if (await feed(co, ctx, kind, st, g, summary, runInfo.started_at)) fed++;
        if (!fed) {                                                               // no first sync yet: nothing was read, so this is not a successful sync
          summary.status = 'needs_first_sync';
          summary.message = 'There is no first sync yet — start with "Start the first sync…" (Sync a period) and choose the months to bring in.';
        } else { st.last_checked_at = nowIso(); await saveState(co.id, st); }
      }
      if (summary.status !== 'needs_first_sync') {
        await fetchDetails(co, ctx, g, summary, st, cfg);
        summary.status = 'completed';
        st.last_ok_at = nowIso();
      }
    } catch (e) {
      if (e instanceof Stop) { summary.status = e.stop === 'cancel' ? 'cancelled' : e.stop === 'budget' ? 'paused_budget' : e.stop === 'reserve' ? 'paused_limit' : 'partial'; summary.message = e.message; }
      else if (e instanceof ZohoLimit) { summary.status = 'paused_limit'; summary.message = e.message; }
      else { summary.status = 'failed'; summary.error = zr.errText(e); log.error && log.error(`[gstr2b:${co.id}] sync failed: ${summary.error}`); }
    } finally {
      summary.finished_at = nowIso();
      summary.calls = runInfo.calls;                                            // counted by the run itself: the day's budget counter starts again at midnight, in the middle of a night run
      const listChanges = Object.values(summary.lists).reduce((a, l) => a + l.added + l.changed, 0);
      const touched = summary.details.fetched + summary.details.deleted + listChanges + (summary.scope ? summary.scope.parked + summary.scope.revived : 0);
      summary.progress = touched + summary.windows_listed + summary.details.failed;        // 0 = the step got nowhere (the caller should not ask again at once)
      // An error is shown for as long as it is the latest outcome: any later run that got through clears it
      st.last_error = summary.status === 'failed' ? { at: summary.finished_at, message: summary.error, mode } : null;
      if (touched) st.recon_due = true;                                         // documents changed: a reconciliation is owed (cleared by reconciled())
      summary.recon_due = !!st.recon_due;
      if (zr.usage) { const u = zr.usage(co.org_id); if (u) st.zoho = u; }
      // Where the store stands now: the first sync is complete only when every document that can be matched has its amounts
      // (documents that failed repeatedly are counted and listed — never silently treated as done).
      try {
        const s = await books.stats(co.id);
        st.counts = { at: summary.finished_at, total: s.total, in_scope: s.in_scope, detailed: s.detailed, pending: s.pending, failing: s.failing };
        if (st.initial && st.initial.listed_at && !st.initial.completed_at && summary.status === 'completed' && s.pending - s.failing === 0) {
          st.initial.completed_at = summary.finished_at;
          st.initial.result = { in_scope: s.in_scope, detailed: s.detailed, failing: s.failing };
        }
      } catch (e) { log.error && log.error(`[gstr2b:${co.id}] could not count the store: ${e.message}`); }
      // A run started by the scheduler (or by opening the page) that found nothing to do is not worth a line in the history or the audit
      // trail: a run every 15 minutes would bury everything else. The page still shows when the last automatic run happened (last_auto).
      quiet = !!o.auto && summary.status === 'completed' && !summary.warnings.length && touched === 0 && summary.details.failed === 0 && !summary.retried;
      summary.quiet = quiet;
      if (summary.by === 'schedule') st.last_auto = { at: summary.finished_at, status: summary.status, mode, calls: summary.calls, quiet, fetched: summary.details.fetched, changed: listChanges };
      if (!quiet) st.runs = [summary, ...st.runs].slice(0, 30);
      st.lease = null; st.live = null;
      try { await saveState(co.id, st); } catch (e) { log.error && log.error(`[gstr2b:${co.id}] could not save sync state: ${e.message}`); }
      running.delete(co.id);
    }
    if (!quiet) await audit.log({ by: summary.by, action: `sync.${mode}`, company: co.id, detail: `${summary.status}: ${summary.details.fetched} detail(s), ${Object.values(summary.lists).reduce((a, l) => a + l.added + l.changed, 0)} list change(s), ${summary.calls} Zoho call(s)${summary.windows_skipped ? `, ${summary.windows_skipped} month listing(s) already done in this pass` : ''}${summary.message ? ` — ${summary.message}` : ''}` });
    return summary;
  }

  /** The "checked against Zoho" report of a re-check pass that has listed everything */
  function verifyReport(pass) {
    const kinds = {}; const total = emptyCheck();
    for (const k of Object.keys(KINDS)) { kinds[k] = pass.check[k] || emptyCheck(); addCheck(total, kinds[k]); }
    delete total.differ_docs;
    // Zoho's own count is shown only where it was given for every listing of the kind. counts_ok: the lists returned exactly as many
    // different documents as Zoho counts (a document added while the check ran can make them differ by a few until the next check).
    for (const c of [...Object.values(kinds), total]) { if (c.uncounted) c.zoho_count = null; delete c.uncounted; }
    return { at: nowIso(), by: pass.by, from: pass.from, to: pass.to, kinds, total, deleted: pass.deleted || 0, ok: total.differ === 0,
      counts_ok: Object.values(kinds).every(c => c.zoho_count === null || c.zoho_count === c.zoho_rows),
      differ_docs: Object.values(kinds).flatMap(c => c.differ_docs || []).slice(0, 20) };
  }

  async function listAllCredits(co, ctx, g, summary, recheck) {
    const r = await listAll(co, 'vendor_credit', {}, g, async rows => {
      const s = await books.upsertMany(co.id, rows.map(row => C.fromList(row, ctx, 'vendor_credit')), mergeList);
      summary.lists.vendor_credit.added += s.added; summary.lists.vendor_credit.changed += s.changed;
    }, summary, { always: recheck });
    summary.lists.vendor_credit.rows += r.listed.size;
    if (!recheck) return null;
    if (r.complete) {                                                           // an incomplete list proves nothing about what is gone
      const local = (await books.all(co.id)).filter(d => d.kind === 'vendor_credit' && !d.deleted && !r.listed.has(d.zoho_id));
      const gone = [];
      for (const d of local.slice(0, 300)) {
        try { await zr.get(co.org_id, KINDS.vendor_credit.detail(d.zoho_id), {}, g); summary.warnings.push(`vendor credit ${d.doc_no || d.zoho_id} was not in Zoho's list but still exists — kept.`); }
        catch (e) { if (zr.isGone(e)) gone.push({ ...d, deleted: true, deleted_at: nowIso(), excluded: 'deleted', excluded_text: C.EXCLUSIONS.deleted, detail_pending: false, hash: `deleted:${d.id}` }); else throw e; }
      }
      if (gone.length) { await books.upsertMany(co.id, gone); summary.details.deleted += gone.length; }
    }
    return compare(co, 'vendor_credit', r.listed, {}, r.count);
  }

  /** Re-read one document from Zoho now (the workbench "refresh from Zoho" action) */
  async function refreshOne(companyId, docId, by = 'user') {
    const cfg = await cfgNow();
    const co = cfg.companies.find(c => c.id === companyId);
    if (!co || co.demo) throw new Error('This company cannot be refreshed from Zoho');
    const doc = await books.get(co.id, docId);
    if (!doc) throw new Error('Document not found');
    const st = await loadState(co.id);
    const ctx = await buildCtx(co, st);
    const K = KINDS[doc.kind];
    let full;
    try { full = C.fromDetail((await zr.get(co.org_id, K.detail(doc.zoho_id), {}, { paceMs: 300 }))[K.dkey], null, ctx, doc.kind); }
    catch (e) {
      if (!zr.isGone(e)) throw e;
      full = { ...doc, deleted: true, deleted_at: nowIso(), excluded: 'deleted', excluded_text: C.EXCLUSIONS.deleted, detail_pending: false, hash: `deleted:${doc.id}` };
    }
    await books.upsertMany(co.id, [full]);
    // Only the branch list is ours to save: a sync may be running, and writing back the whole (older) state would undo its progress
    const fresh = await loadState(co.id);
    fresh.branches = st.branches; fresh.branches_at = st.branches_at;
    await saveState(co.id, fresh);
    await audit.log({ by, action: 'sync.refresh_one', company: co.id, ref: docId, detail: full.deleted ? 'deleted in Zoho' : 'refreshed' });
    return full;
  }

  /**
   * What a caller that keeps the data fresh (the scheduler, an opened page) should do next for a company — no Zoho call, one small read.
   * { run: false, reason } or { run: true, mode, from, to, why }.
   */
  async function due(companyId, { minAgeMs = 0 } = {}) {
    const st = await loadState(companyId);
    if (running.has(companyId) || (useLease && leaseHeld(st))) return { run: false, reason: 'running' };
    if (!Object.keys(st.hwm || {}).length) return { run: false, reason: 'needs_first_sync' };
    const p = st.pass;
    if (p && !p.listed_at && Date.now() - Date.parse(p.started_at) < PASS_RESUME_MS) return { run: true, mode: p.mode, from: p.from, to: p.to, why: 'an unfinished listing' };
    if (st.initial && !st.initial.listed_at && st.initial.from && st.initial.to) return { run: true, mode: 'period', from: st.initial.from, to: st.initial.to, why: 'the first sync has not listed every month yet' };
    const waiting = st.counts ? st.counts.pending - st.counts.failing : 0;
    // a finished first sync that has not been compared with Zoho yet: the next automatic run may do that (a re-check) instead of a plain change check
    const verify_due = !!(st.initial && st.initial.completed_at && (!st.verify || st.verify.at < st.initial.completed_at)) && waiting <= 0;
    if (waiting > 0) return { run: true, mode: 'incremental', why: `${waiting} document(s) waiting for amounts`, verify_due };
    if (!st.last_checked_at || Date.now() - Date.parse(st.last_checked_at) >= minAgeMs) return { run: true, mode: 'incremental', why: 'time for a change check', verify_due };
    return { run: false, reason: 'fresh' };
  }

  /** The reconciliation that follows a sync has run: nothing is owed any more (see recon_due) */
  const reconciled = companyId => store.update(stateKey(companyId), null, s => { if (!s || !s.recon_due) return store.update.SKIP; s.recon_due = false; });

  async function status(companyId) {
    const cfg = await cfgNow();
    const co = cfg.companies.find(c => c.id === companyId);
    if (!co) throw new Error('Unknown company');
    const st = await loadState(co.id);
    const stats = await books.stats(co.id);
    const today = N.todayIST();
    const used = st.budget.day === today ? st.budget.used : 0;
    const ri = running.get(co.id);
    const leased = useLease && leaseHeld(st);                                 // a run on another instance counts as running
    const isRunning = !!ri || leased;
    const waiting = stats.pending - stats.failing;
    const ini = st.initial;
    const lastRun = st.runs[0] || null;
    // First sync: complete only when every month has been listed AND every document that can be matched has its amounts
    const initial = !ini
      ? { status: 'not_started', discovered: 0, fetched: 0, pending: 0, failed: 0, percent: null }
      : {
        status: ini.completed_at ? (stats.failing ? 'completed_with_errors' : 'completed') : (!isRunning && lastRun && lastRun.status === 'failed') ? 'failed' : 'in_progress',
        phase: ini.completed_at ? 'done' : ini.listed_at ? 'amounts' : 'listing',
        from: ini.from, to: ini.to, started_at: ini.started_at, by: ini.by || '', listed_at: ini.listed_at, completed_at: ini.completed_at,
        discovered: stats.in_scope, fetched: stats.detailed, pending: waiting, failed: stats.failing,
        percent: ini.listed_at && stats.in_scope ? Math.floor((stats.detailed / stats.in_scope) * 1000) / 10 : null,
      };
    const z = st.zoho;
    const zohoToday = z && z.day_reset_at && Date.parse(z.day_reset_at) > Date.now();          // a reading from before Zoho's midnight reset says nothing about today
    // An error is shown only while it is the latest outcome. (The previous version kept an old error in the state after later runs had
    // got through — such a leftover is not shown either.)
    const lastError = st.last_error && (!lastRun || lastRun.status === 'failed' || String(lastRun.finished_at || '') <= String(st.last_error.at)) ? st.last_error : null;
    return {
      company: co.id, running: isRunning, run_id: ri ? ri.run_id : leased ? st.lease.run_id : null, live: isRunning ? st.live : null,
      last_ok_at: st.last_ok_at, last_error: lastError, last_checked_at: st.last_checked_at,
      hwm: st.hwm, runs: st.runs.slice(0, 12), auto_last: st.last_auto || null, initial, stats, failing_documents: stats.failing, verify: st.verify || null, recon_due: !!st.recon_due,
      budget: { day: today, used, limit: cfg.sync.daily_budget, remaining: Math.max(0, cfg.sync.daily_budget - used) },
      zoho: z ? { day_limit: z.day_limit, day_remaining: zohoToday ? z.day_remaining : null, day_reset_at: zohoToday ? z.day_reset_at : null, minute_limit: z.minute_limit, concurrency_limit: z.concurrency_limit, at: z.at, reserve: cfg.sync.zoho_reserve } : null,
      speed: { rate_per_min: cfg.sync.rate_per_min, concurrency: cfg.sync.concurrency, eta_minutes: waiting > 0 ? Math.ceil(waiting / Math.max(1, cfg.sync.rate_per_min)) : 0 },
      branches: Object.values(st.branches || {}).length, branches_at: st.branches_at,
      // what the sync reads amounts for: the GSTINs switched on, and the months from the first one synced
      scope: { gstins_total: (co.registrations || []).length, gstins_on: (co.registrations || []).filter(r => r.active !== false).map(r => ({ gstin: r.gstin, label: r.label || '' })), from: syncedFrom(st) },
      windows: st.windows, credentials: zr.identity(),
    };
  }

  const cancel = companyId => { const r = running.get(companyId); if (r) { r.cancel = true; return true; } return false; };
  const isRunning = companyId => running.has(companyId);
  /** Give the documents that failed repeatedly another three attempts (the "Try again" button) */
  const retryFailed = companyId => books.resetFailures(companyId);

  return { run, status, cancel, isRunning, refreshOne, loadState, due, reconciled, retryFailed, KINDS };
}

module.exports = { create, mergeList, monthsBetween, limiter, KINDS };
