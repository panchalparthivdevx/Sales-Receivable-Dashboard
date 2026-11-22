/**
 * Financial Reporting — the Zoho Books ledger the provisional statements are built from (read only; nothing is written to Zoho).
 *
 * What is kept (store keys, rupees, debit positive):
 *   gl_state            chart of accounts, which months / trial balances are held and when, change-feed checkpoints,
 *                       last successful run, the accounting cut-off date
 *   gl_month_YYYY-MM    every account's debit and credit total for that month (Zoho's general ledger report; the current
 *                       month runs to the cut-off date)
 *   gl_tb_YYYY-MM-DD    Zoho's trial balance as at a date (opening balances, and the check of the figures built from months)
 *   gl_index            Zoho record id → date, amount, status for journals, invoices, bills, credit notes, vendor credits,
 *                       payments and expenses — so an edit that moves a record to another month updates BOTH months
 *   gl_runs             the run log Sync Monitor shows (records added / changed, affected periods, failures)
 *   gl_pending          a run that was cut short (time limit, Zoho error): the next run resumes it; nothing is committed before
 *
 * Runs:
 *   initial   chart of accounts, trial balances at 31 Mar 2025 / 31 Mar 2026 / today, every month from April 2025, the record index
 *   hourly    records added or modified since the checkpoint (Zoho's last_modified_time — a back-dated posting or an edit to an old
 *             document shows up here), then the months they touch (old date and new date), the open months (after the latest final
 *             workbook), and the trial balance at the cut-off date as a check
 *   daily     the first run of each India day also re-reads every month held and the chart of accounts: a deletion never appears
 *             in a "modified since" list, so the full month refresh is what removes it
 * Duplicates are impossible by construction: a month is replaced as a whole, records are keyed by Zoho id. The checkpoint moves
 * only after the whole run is saved; a run cut short resumes from its saved queue and re-reads the same window.
 */

'use strict';

const P = require('./periods');

const IST = 5.5 * 3600e3;
const pad = n => String(n).padStart(2, '0');
const todayIst = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(0, 10);
const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const addMonths = (ym, k) => { let [y, m] = ym.split('-').map(Number); m += k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${pad(m)}`; };
const monthsBetween = (a, b) => { const out = []; for (let m = a; m <= b && out.length < 240; m = addMonths(m, 1)) out.push(m); return out; };
const lmtMs = s => { if (!s) return 0; const t = Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')); return Number.isNaN(t) ? 0 : t; };
const lmtParam = ms => `${new Date(ms).toISOString().slice(0, 19)}+0000`;
const fyStartOf = d => { const [y, m] = d.split('-').map(Number); return `${m >= 4 ? y : y - 1}-04-01`; };
const dayBefore = d => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const r2 = v => Math.round(v * 100) / 100;

const WINDOW_FROM = '2025-04';                // comparatives: FY 2025-26 onwards (Q3 FY26, FY26, opening balances 31 Mar 2025)
const MARGIN_MS = 5 * 60 * 1000;              // re-read 5 minutes before the checkpoint (clock differences, in-flight edits)
const LOCK_MS = 25 * 60 * 1000;
const RUN_LOG = 120;

// documents that post to the ledger and have a list Zoho can filter or sort by modification time
const KINDS = {
  journals:         { path: '/journals',         key: 'journals',         id: 'journal_id',       no: 'entry_number',     date: 'journal_date', amount: 'total',  label: 'Journals',          by: 'sort' },
  invoices:         { path: '/invoices',         key: 'invoices',         id: 'invoice_id',       no: 'invoice_number',   date: 'date',         amount: 'total',  label: 'Invoices',          by: 'sort', cache: 'invoices_fy' },
  creditnotes:      { path: '/creditnotes',      key: 'creditnotes',      id: 'creditnote_id',    no: 'creditnote_number', date: 'date',        amount: 'total',  label: 'Credit notes',      by: 'sort', cache: 'credit_notes_fy' },
  bills:            { path: '/bills',            key: 'bills',            id: 'bill_id',          no: 'bill_number',      date: 'date',         amount: 'total',  label: 'Bills',             by: 'sort', cache: 'bills_fy' },
  vendorcredits:    { path: '/vendorcredits',    key: 'vendorcredits',    id: 'vendor_credit_id', no: 'vendor_credit_number', date: 'date',     amount: 'total',  label: 'Vendor credits',    by: 'sort', cache: 'vendor_credits_all' },
  customerpayments: { path: '/customerpayments', key: 'customerpayments', id: 'payment_id',       no: 'payment_number',   date: 'date',         amount: 'amount', label: 'Customer payments', by: 'sort', cache: 'customer_payments_fy' },
  vendorpayments:   { path: '/vendorpayments',   key: 'vendorpayments',   id: 'payment_id',       no: 'payment_number',   date: 'date',         amount: 'amount', label: 'Vendor payments',   by: 'sort', cache: 'vendor_payments_fy' },
  // Zoho refuses sort_column=last_modified_time on /expenses but honours the last_modified_time filter (see gstr2b/lib/booksSync.js)
  expenses:         { path: '/expenses',         key: 'expenses',         id: 'expense_id',       no: 'reference_number', date: 'date',         amount: 'total',  label: 'Expenses',          by: 'filter' },
};

/** The reporting periods a month belongs to (quarter, half year, nine months, year) and the balance-sheet dates it moves */
function periodsOfMonth(ym) {
  const end = monthEnd(ym);
  const fy = P.fyOf(end);
  const m = +ym.slice(5, 7);
  const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
  const out = [`FY${fy}-Q${q}`, `FY${fy}-${q <= 2 ? 'H1' : 'H2'}`, `FY${fy}-FY`];
  if (q <= 3) out.push(`FY${fy}-9M`);
  return out;
}

function createGL({ store, zget, readSynced = null, now = () => Date.now(), log = () => {}, gapMs = 350 }) {
  let calls = 0;
  let lastCall = 0;
  async function z(pathname, params) {
    const wait = lastCall + gapMs - now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = now();
    calls++;
    return zget(pathname, params);
  }

  const emptyState = () => ({ v: 1, windowFrom: WINDOW_FROM, accounts: {}, coaAt: null, months: {}, tb: {}, feed: {}, cutoff: null, initial: null, lastSuccess: null, lastRun: null, lastDaily: null });
  const readState = () => store.read('gl_state', emptyState());

  // ── Zoho reads ──
  async function fetchCoa() {
    const out = [];
    for (let page = 1; page <= 60; page++) {
      const d = await z('/chartofaccounts', { filter_by: 'AccountType.All', sort_column: 'account_name', per_page: 200, page });
      out.push(...(d.chartofaccounts || []));
      if (!d.page_context?.has_more_page) return out;
    }
    throw new Error('The chart of accounts has more than 60 pages — stopped rather than keep a partial list.');
  }
  async function fetchMonth(ym, cutoff) {
    const from = `${ym}-01`;
    const to = monthEnd(ym) < cutoff ? monthEnd(ym) : cutoff;
    const d = await z('/reports/generalledger', { from_date: from, to_date: to });
    const rows = d.generalledger;
    if (!Array.isArray(rows)) throw new Error(`Zoho's general ledger report for ${ym} came back without accounts.`);
    const acc = {};
    for (const a of rows) {
      const dr = Number(a.debit_total) || 0, cr = Number(a.credit_total) || 0;
      if (a.account_id && (dr || cr)) acc[a.account_id] = [r2(dr), r2(cr)];
    }
    return { month: ym, from, to, at: new Date(now()).toISOString(), acc, names: Object.fromEntries(rows.filter(a => a.account_id && acc[a.account_id]).map(a => [a.account_id, a.name])) };
  }
  async function fetchTb(asOf) {
    // filter_by=TransactionDate.CustomDate with to_date only = balances AS AT that date; without the filter Zoho ignores the dates
    // and answers as at today (seen live 22 Nov 2026); with from_date as well it answers for that period
    const d = await z('/reports/trialbalance', { filter_by: 'TransactionDate.CustomDate', to_date: asOf });
    const groups = d.trialbalance?.[0]?.account_transactions;
    if (!Array.isArray(groups)) throw new Error(`Zoho's trial balance at ${asOf} came back without accounts.`);
    const acc = {}, types = {}, names = {};
    let re = 0, totDr = Number(d.trialbalance[0].net_debit_total) || 0, totCr = Number(d.trialbalance[0].net_credit_total) || 0;
    for (const g of groups) {
      for (const a of g.account_transactions || []) {
        const net = (Number(a.net_debit_total) || 0) - (Number(a.net_credit_total) || 0);
        if (!a.account_id) { if (/retained earnings/i.test(a.name || '')) re += net; continue; }
        acc[a.account_id] = r2(net); types[a.account_id] = g.account_type; names[a.account_id] = a.name;
      }
    }
    return { asOf, at: new Date(now()).toISOString(), acc, types, names, re: r2(re), totals: { dr: r2(totDr), cr: r2(totCr) } };
  }
  /** records modified since `sinceMs`, newest first, until older than that; complete=false if the page cap was hit */
  async function fetchModified(kind, sinceMs) {
    const K = KINDS[kind];
    const rows = [];
    const params = K.by === 'sort' ? { sort_column: 'last_modified_time', sort_order: 'D' } : { last_modified_time: lmtParam(sinceMs) };
    for (let page = 1; page <= 40; page++) {
      const d = await z(K.path, { ...params, per_page: 200, page });
      const list = d[K.key] || [];
      let older = false;
      for (const r of list) { if (lmtMs(r.last_modified_time) < sinceMs) { older = true; if (K.by === 'sort') break; continue; } rows.push(r); }
      if (older && K.by === 'sort') return { rows, complete: true };
      if (!d.page_context?.has_more_page) return { rows, complete: true };
    }
    return { rows, complete: false };
  }
  async function listAllJournals(fromDate, toDate) {
    const rows = [];
    for (let page = 1; page <= 120; page++) {
      const d = await z('/journals', { date_start: fromDate, date_end: toDate, per_page: 200, page });
      rows.push(...(d.journals || []));
      if (!d.page_context?.has_more_page) return { rows, complete: true };
    }
    return { rows, complete: false };
  }

  const rec = (K, r) => [String(r[K.date] || '').slice(0, 10), Number(r[K.amount]) || 0, r.status || '', lmtMs(r.last_modified_time), r[K.no] || ''];

  // ── a run ──
  function plan(mode, st, today, openFrom) {
    const months = monthsBetween(st.windowFrom || WINDOW_FROM, today.slice(0, 7));
    if (mode === 'initial') {
      return ['coa', `tb:${dayBefore(fyStartOf(`${(st.windowFrom || WINDOW_FROM)}-01`))}`, `tb:${dayBefore(fyStartOf(today))}`,
        ...months.map(m => `month:${m}`), 'seed:cache', 'seed:journals', `tb:${today}`, 'feed:init'];
    }
    const steps = Object.keys(KINDS).map(k => `feed:${k}`);
    const daily = mode === 'daily' || mode === 'full';
    const open = months.filter(m => m >= (openFrom || today.slice(0, 7)));
    for (const m of daily ? months : open) steps.push(`month:${m}`);
    if (daily) steps.push('coa', `tb:${dayBefore(fyStartOf(`${(st.windowFrom || WINDOW_FROM)}-01`))}`, `tb:${dayBefore(fyStartOf(today))}`);
    steps.push(`tb:${today}`);
    return steps;
  }

  /**
   * run({ mode: 'initial'|'hourly'|'daily'|'full', openFrom: 'YYYY-MM' (first month after the latest final workbook), budgetMs, trigger, by })
   * Resumes a pending run first. Returns the run record (status ok | partial | failed | busy | skipped).
   */
  async function run(opts = {}) {
    const started = now();
    const budgetMs = opts.budgetMs || 10 * 60 * 1000;
    const lock = await store.read('gl_lock', null);
    if (lock && started - lock.at < LOCK_MS && !opts.force) return { status: 'busy', message: `A Zoho ledger sync started at ${new Date(lock.at).toISOString()} is still running.` };
    const runId = `r${started}`;
    await store.write('gl_lock', { runId, at: started });
    calls = 0;
    let st = await readState();
    const today = opts.today || todayIst(started);
    let pending = await store.read('gl_pending', null);
    let mode = opts.mode || 'hourly';
    if (!st.initial?.doneAt && mode !== 'initial' && !pending) { await store.remove('gl_lock'); return { status: 'skipped', message: 'Run the initial Zoho ledger sync first (Account Mapping → Zoho ledger sync → Run initial sync).' }; }
    if (mode === 'hourly' && st.lastDaily !== today) mode = 'daily';
    if (!pending || pending.mode === undefined) {
      pending = { runId, mode, trigger: opts.trigger || 'manual', by: opts.by || null, startedAt: started, today, queue: plan(mode, st, today, opts.openFrom), done: [], staged: { months: {}, tb: {} },
        feed: {}, records: { added: 0, changed: 0, voided: 0, items: [] }, monthsTouched: [], coa: null, index: {}, errors: [] };
    } else {
      pending.resumedAt = pending.resumedAt || [];
      pending.resumedAt.push(started);
      mode = pending.mode;
    }
    const runRec = { id: pending.runId, mode: pending.mode, trigger: pending.trigger, by: pending.by, startedAt: new Date(pending.startedAt).toISOString() };
    const index = await store.read('gl_index', {});
    for (const [k, v] of Object.entries(pending.index || {})) index[k] = { ...(index[k] || {}), ...v };
    const touched = new Set(pending.monthsTouched || []);
    const window0 = st.windowFrom || WINDOW_FROM;
    const cutoff = pending.today;
    let failed = null;
    try {
      while (pending.queue.length) {
        if (now() - started > budgetMs) break;
        const step = pending.queue[0];
        const cut = step.indexOf(':');
        const [kind, arg] = cut < 0 ? [step, ''] : [step.slice(0, cut), step.slice(cut + 1)];
        if (kind === 'coa') {
          pending.coa = (await fetchCoa()).map(a => ({ id: a.account_id, n: a.account_name, t: a.account_type, p: a.parent_account_id || null, pn: a.parent_account_name || null, code: a.account_code || '', act: a.is_active !== false, created: a.created_time || null }));
        } else if (kind === 'tb') {
          pending.staged.tb[arg] = await fetchTb(arg);
        } else if (kind === 'month') {
          pending.staged.months[arg] = await fetchMonth(arg, cutoff);
        } else if (kind === 'seed') {
          if (arg === 'cache' && readSynced) {
            for (const [k, K] of Object.entries(KINDS)) {
              if (!K.cache) continue;
              const d = await readSynced(K.cache).catch(() => null);
              const part = pending.index[k] = pending.index[k] || {};
              for (const r of d?.data || []) if (r[K.id] && String(r[K.date] || '') >= `${window0}-01`) part[r[K.id]] = rec(K, r);
            }
          } else if (arg === 'journals') {
            const { rows } = await listAllJournals(`${window0}-01`, monthEnd(today.slice(0, 7)));
            const part = pending.index.journals = pending.index.journals || {};
            for (const r of rows) part[r.journal_id] = rec(KINDS.journals, r);
          }
        } else if (kind === 'feed') {
          if (arg === 'init') { for (const k of Object.keys(KINDS)) pending.feed[k] = { complete: true, at: pending.startedAt }; }
          else {
            const K = KINDS[arg];
            const since = (st.feed[arg]?.hwm ? Date.parse(st.feed[arg].hwm) : pending.startedAt) - MARGIN_MS;
            const { rows, complete } = await fetchModified(arg, since);
            const part = pending.index[arg] = pending.index[arg] || {};
            for (const r of rows) {
              const id = r[K.id];
              if (!id) continue;
              const prev = part[id] || index[arg]?.[id];
              const next = rec(K, r);
              if (prev && prev[3] === next[3] && prev[0] === next[0] && prev[1] === next[1] && prev[2] === next[2]) continue;   // already applied (overlap window)
              // added = created since the checkpoint; anything else is a change (an edit, a payment, a back-dated posting)
              const created = lmtMs(r.created_time);
              const isNew = created ? created >= since : !prev;
              const voided = /void/i.test(next[2]) && !/void/i.test(prev?.[2] || '');
              const change = voided ? 'voided' : isNew ? 'added' : 'changed';
              pending.records[change]++;
              for (const d of [next[0], prev?.[0]]) if (d && d.slice(0, 7) >= window0 && d <= cutoff) touched.add(d.slice(0, 7));
              if (pending.records.items.length < 200) pending.records.items.push({ kind: arg, id, no: next[4], date: next[0], oldDate: prev && prev[0] !== next[0] ? prev[0] : undefined, amount: next[1], oldAmount: prev && prev[1] !== next[1] ? prev[1] : undefined, status: next[2], change, firstSeen: !prev || undefined, lmt: r.last_modified_time });
              part[id] = next;
            }
            pending.feed[arg] = { complete, rows: rows.length, at: pending.startedAt };
            // the months a changed record touches are read again in this run (old date and new date)
            for (const m of [...touched].sort()) {
              if (pending.queue.includes(`month:${m}`) || pending.done.includes(`month:${m}`)) continue;
              const at = pending.queue.findIndex(s => s.startsWith('tb:') || s === 'coa');
              pending.queue.splice(at >= 0 ? at : pending.queue.length, 0, `month:${m}`);
            }
          }
        }
        pending.queue.shift();
        pending.done.push(step);
        pending.monthsTouched = [...touched];
        await store.write('gl_pending', pending);
      }
    } catch (e) {
      failed = e;
      pending.errors.push({ at: new Date(now()).toISOString(), step: pending.queue[0], error: e.response?.data?.message || e.message, code: e.response?.data?.code || e.response?.status || null });
      await store.write('gl_pending', pending);
    }

    if (failed || pending.queue.length) {
      runRec.status = failed ? 'failed' : 'partial';
      runRec.error = failed ? (failed.response?.data?.message || failed.message) : `Stopped at the time limit with ${pending.queue.length} step(s) left — the next run continues.`;
      runRec.calls = calls; runRec.endedAt = new Date(now()).toISOString(); runRec.left = pending.queue.length;
      try {
        await logRun(runRec);
        st = await readState();
        await store.write('gl_state', { ...st, lastRun: runRec });
      } finally { await store.remove('gl_lock'); }
      return runRec;
    }
    try { return await commit(pending, runRec, index, cutoff); } finally { await store.remove('gl_lock'); }
  }

  async function commit(pending, runRec, index, cutoff) {
    let st;
    // ── commit: months, trial balances, index, then the checkpoint ──
    const changes = { months: [], accounts: 0 };
    for (const [m, snap] of Object.entries(pending.staged.months)) {
      const old = await store.read(`gl_month_${m}`, null);
      const deltas = [];
      const ids = new Set([...Object.keys(snap.acc), ...Object.keys(old?.acc || {})]);
      for (const id of ids) {
        const a = snap.acc[id] || [0, 0], b = old?.acc?.[id] || [0, 0];
        const d = r2((a[0] - a[1]) - (b[0] - b[1]));
        if (old && (Math.abs(d) >= 0.01 || Math.abs(a[0] - b[0]) >= 0.01)) deltas.push({ id, name: snap.names[id] || old?.names?.[id] || id, net: d, was: r2(b[0] - b[1]), now: r2(a[0] - a[1]) });
      }
      if (deltas.length) changes.months.push({ month: m, accounts: deltas.length, top: deltas.sort((x, y) => Math.abs(y.net) - Math.abs(x.net) || Math.abs(y.now) - Math.abs(x.now)).slice(0, 25) });
      changes.accounts += deltas.length;
      await store.write(`gl_month_${m}`, snap);
    }
    for (const [d, snap] of Object.entries(pending.staged.tb)) await store.write(`gl_tb_${d}`, snap);
    for (const [k, part] of Object.entries(pending.index)) index[k] = { ...(index[k] || {}), ...part };
    await store.write('gl_index', index);

    st = await readState();
    const newAccounts = [];
    if (pending.coa) {
      const at = new Date(now()).toISOString();
      const acc = {};
      for (const a of pending.coa) {
        const old = st.accounts[a.id];
        acc[a.id] = { ...a, first: old?.first || (st.coaAt ? at : (a.created || at)) };
        if (!old && st.coaAt) newAccounts.push({ id: a.id, name: a.n, type: a.t, parent: a.pn });
      }
      // an account Zoho no longer lists is kept (marked gone) so history still reads
      for (const [id, a] of Object.entries(st.accounts)) if (!acc[id]) acc[id] = { ...a, gone: true };
      st.accounts = acc;
      st.coaAt = at;
    }
    // accounts seen in a ledger month but not (yet) in the chart of accounts
    for (const snap of Object.values(pending.staged.months)) for (const [id, name] of Object.entries(snap.names)) if (!st.accounts[id]) { st.accounts[id] = { id, n: name, t: null, first: new Date(now()).toISOString(), fromLedger: true }; newAccounts.push({ id, name, type: null }); }
    for (const [m, snap] of Object.entries(pending.staged.months)) st.months[m] = { at: snap.at, to: snap.to, n: Object.keys(snap.acc).length };
    for (const [d, snap] of Object.entries(pending.staged.tb)) st.tb[d] = { at: snap.at, re: snap.re };
    for (const [k, f] of Object.entries(pending.feed)) if (f.complete) st.feed[k] = { hwm: new Date(f.at).toISOString(), rows: f.rows || 0 };
    const monthsDone = Object.keys(pending.staged.months);
    if (monthsDone.includes(cutoff.slice(0, 7))) st.cutoff = cutoff;
    if (pending.mode === 'initial') st.initial = { startedAt: new Date(pending.startedAt).toISOString(), doneAt: new Date(now()).toISOString() };
    if (pending.mode === 'daily' || pending.mode === 'initial' || pending.mode === 'full') st.lastDaily = pending.today;
    const affected = [...new Set(changes.months.flatMap(x => periodsOfMonth(x.month)))].sort(P.cmp);
    Object.assign(runRec, {
      status: 'ok', endedAt: new Date(now()).toISOString(), calls, cutoff: st.cutoff,
      records: { added: pending.records.added, changed: pending.records.changed, voided: pending.records.voided, items: pending.records.items.slice(0, 60) },
      feeds: Object.fromEntries(Object.entries(pending.feed).map(([k, f]) => [k, { rows: f.rows || 0, complete: f.complete }])),
      monthsRead: monthsDone.sort(), monthsChanged: changes.months.map(x => ({ month: x.month, accounts: x.accounts, top: x.top.slice(0, 8) })), affectedPeriods: affected,
      newAccounts: newAccounts.slice(0, 50), newAccountCount: newAccounts.length, resumed: (pending.resumedAt || []).length, errorsBefore: pending.errors,
    });
    st.lastSuccess = { at: runRec.endedAt, runId: runRec.id, mode: runRec.mode };
    st.lastRun = { ...runRec, records: { ...runRec.records, items: undefined } };
    await store.write('gl_state', st);
    // the check needs the state just written (months held)
    if (pending.staged.tb[cutoff]) {
      runRec.tbCheck = await tbCheck(cutoff, st);
      st.lastRun.tbCheck = runRec.tbCheck;
      await store.write('gl_state', st);
    }
    await logRun(runRec);
    await store.remove('gl_pending');
    log(`[fin-gl] ${runRec.mode} ok: ${calls} Zoho calls, ${runRec.records.added} added / ${runRec.records.changed} changed / ${runRec.records.voided} voided, months read ${monthsDone.length}, changed ${changes.months.length}`);
    return runRec;
  }

  async function logRun(r) {
    await store.update('gl_runs', { items: [] }, d => { d.items.unshift(r); d.items = d.items.slice(0, RUN_LOG); });
  }

  // ── reading the ledger ──
  const monthCache = new Map();
  async function month(ym) {
    const st = await readState();
    const key = `${ym}|${st.months[ym]?.at || ''}`;
    if (monthCache.has(key)) return monthCache.get(key);
    const m = await store.read(`gl_month_${ym}`, null);
    monthCache.set(key, m);
    if (monthCache.size > 80) monthCache.delete(monthCache.keys().next().value);
    return m;
  }
  const tbCache = new Map();
  async function tb(d) {
    const st = await readState();
    const key = `${d}|${st.tb[d]?.at || ''}`;
    if (tbCache.has(key)) return tbCache.get(key);
    const t = await store.read(`gl_tb_${d}`, null);
    tbCache.set(key, t);
    if (tbCache.size > 20) tbCache.delete(tbCache.keys().next().value);
    return t;
  }

  /**
   * A dataset the statements read: balances at any date and movements over any range, by account (rupees, debit positive).
   *   balance(id, date)       closing balance (balance-sheet accounts: opening trial balance + months; income/expense: since 1 April)
   *   movement(id, from, to)  net movement and debit / credit totals over whole months (the current month to the cut-off date)
   * Only dates covered by the months held can be asked for; anything else returns null (shown as "not available").
   */
  async function dataset() {
    const st = await readState();
    const months = {};
    for (const m of Object.keys(st.months).sort()) months[m] = await month(m);
    const tbs = {};
    for (const d of Object.keys(st.tb)) tbs[d] = await tb(d);
    const typeOf = id => st.accounts[id]?.t || Object.values(tbs).map(t => t?.types?.[id]).find(Boolean) || null;
    const isPL = id => /^(income|other_income|expense|cost_of_goods_sold|other_expense)$/.test(typeOf(id) || '');
    const sumMonths = (fromYm, toYm) => {
      const out = new Map();
      for (const [m, snap] of Object.entries(months)) {
        if (!snap || m < fromYm || m > toYm) continue;
        for (const [id, [dr, cr]] of Object.entries(snap.acc)) { const o = out.get(id) || [0, 0]; o[0] += dr; o[1] += cr; out.set(id, o); }
      }
      return out;
    };
    const covered = (fromYm, toYm) => monthsBetween(fromYm, toYm).every(m => months[m]);
    return {
      state: st, months, tbs, typeOf, isPL, covered, cutoff: st.cutoff,
      /** { id: [dr, cr] } summed over months fromYm..toYm, or null when a month is missing */
      range(fromYm, toYm) { return covered(fromYm, toYm) ? sumMonths(fromYm, toYm) : null; },
      /** opening trial balance for the financial year that contains `date` (31 March before it) */
      opening(date) { return tbs[dayBefore(fyStartOf(date))] || null; },
    };
  }

  /** The figures built from months against Zoho's own trial balance at the cut-off date (every account) */
  async function tbCheck(asOf, st0) {
    const st = st0 || await readState();
    const t = await store.read(`gl_tb_${asOf}`, null) || (await (async () => null)());
    const ds = await dataset();
    const open = ds.opening(asOf);
    if (!t || !open) return { asOf, ok: null, note: 'Opening or closing trial balance not held yet.' };
    const fyFrom = fyStartOf(asOf).slice(0, 7);
    const mv = ds.range(fyFrom, asOf.slice(0, 7));
    if (!mv) return { asOf, ok: null, note: 'Some months of this financial year are not held yet.' };
    const ids = new Set([...Object.keys(t.acc), ...mv.keys(), ...Object.keys(open.acc)]);
    const diffs = [];
    for (const id of ids) {
      const m = mv.get(id) || [0, 0];
      const pl = ds.isPL(id) || (t.types[id] && /income|expense|cost_of_goods/.test(t.types[id]));
      const built = (pl ? 0 : (open.acc[id] || 0)) + m[0] - m[1];
      const zoho = t.acc[id] || 0;
      if (Math.abs(built - zoho) >= 1) diffs.push({ id, name: t.names[id] || st.accounts[id]?.n || id, built: r2(built), zoho: r2(zoho), diff: r2(built - zoho) });
    }
    diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    return { asOf, ok: diffs.length === 0, accounts: ids.size, differences: diffs.length, top: diffs.slice(0, 20), zohoTotals: t.totals };
  }

  async function status() {
    const st = await readState();
    const runs = (await store.read('gl_runs', { items: [] })).items;
    const pending = await store.read('gl_pending', null);
    const lock = await store.read('gl_lock', null);
    return {
      initialDone: !!st.initial?.doneAt, initial: st.initial, cutoff: st.cutoff, lastSuccess: st.lastSuccess, lastRun: st.lastRun,
      monthsHeld: Object.keys(st.months).sort(), tbHeld: Object.keys(st.tb).sort(), accounts: Object.keys(st.accounts).length, coaAt: st.coaAt,
      feeds: Object.fromEntries(Object.entries(KINDS).map(([k, K]) => [k, { label: K.label, hwm: st.feed[k]?.hwm || null }])),
      pending: pending ? { mode: pending.mode, left: pending.queue.length, done: pending.done.length, errors: pending.errors.slice(-3), startedAt: new Date(pending.startedAt).toISOString() } : null,
      running: !!(lock && now() - lock.at < LOCK_MS), runs: runs.slice(0, 30), indexSize: null,
    };
  }

  return { run, status, dataset, tbCheck, readState, KINDS, periodsOfMonth, get calls() { return calls; } };
}

module.exports = { createGL, KINDS, periodsOfMonth, todayIst, monthEnd, addMonths, monthsBetween, fyStartOf, dayBefore, lmtMs, WINDOW_FROM };
