/**
 * Zoho Books → this module (READ-ONLY: the client used has GET only — server/gstr2b/lib/zohoRead.js).
 *
 * Control amount = the postings of the entity's TDS Receivable ledger(s): GET /chartofaccounts/transactions?account_id=…&date.start/end,
 * listed month by month (a month with more than one page is split into smaller date windows, because Zoho pages this report by date and
 * date-sorted paging can skip rows). A month's listing replaces what was stored for it, so a posting deleted or changed in Zoho is picked
 * up by the next sync. Fields verified live on 22 Nov 2026 (DevX): categorized_transaction_id, transaction_type (invoice /
 * customer_payment / journal / creditnote …), transaction_id (EMPTY for customer_payment rows), transaction_date, customer_id, payee,
 * description, entry_number (the invoice number on invoice and customer-payment rows), reference_number, debit_amount, credit_amount.
 *
 * Details, fetched only when new or changed ("incremental"):
 *   invoices    GET /invoices/{id}: sub_total (basic), tax_total (GST), total (net of TDS), tds_amount, tds_percent, tds_summary[].tds_name,
 *               and the client's TAN when the organisation keeps it in a custom field (DevX: cf_organization_tan_number)
 *   payments    GET /customerpayments/{id}: invoices[].tax_amount_withheld / amount_applied — the allocation of the TDS to invoices
 *   journals    GET /journals/{id}: line_items[].customer_id (the TDS line often has none; the receivable line does), notes, reference
 * The dashboard's central sync data (customer payments, invoices of the current year) is used where it exists, so fewer calls are made.
 */

'use strict';

const store = require('./store');
const PER = require('./periods');
const { toPaise, todayIST, sleep } = require('./util');

const trimRow = (t, acc) => ({
  id: String(t.categorized_transaction_id || `${t.transaction_id}|${t.transaction_date}|${t.debit_amount}|${t.credit_amount}|${t.entry_number}`),
  acc: String(t.account_id || acc), type: String(t.transaction_type || ''), type_label: String(t.transaction_type_formatted || t.transaction_type || ''),
  tid: String(t.transaction_id || ''), date: String(t.transaction_date || '').slice(0, 10), cust: String(t.customer_id || ''), payee: String(t.payee || ''),
  desc: String(t.description || '').slice(0, 500), no: String(t.entry_number || ''), ref: String(t.reference_number || '').slice(0, 200),
  dr: toPaise(t.debit_amount) || 0, cr: toPaise(t.credit_amount) || 0, off: String(t.offset_account_name || ''),
});
const trimInvoice = (inv, tanField) => ({
  id: String(inv.invoice_id), no: String(inv.invoice_number || ''), date: String(inv.date || ''), cust: String(inv.customer_id || ''), cust_name: String(inv.customer_name || ''),
  status: String(inv.status || ''), sub_total: toPaise(inv.sub_total), tax_total: toPaise(inv.tax_total), total: toPaise(inv.total), tds: toPaise(inv.tds_amount) || 0,
  tds_percent: inv.tds_percent === undefined || inv.tds_percent === '' ? null : Number(inv.tds_percent), tds_section: String(inv.tds_section || ''),
  tds_names: (inv.tds_summary || []).map(s => String(s.tds_name || '')).filter(Boolean), tan: String((tanField && inv[tanField]) || '').toUpperCase().trim(),
  lmt: String(inv.last_modified_time || ''), branch: String(inv.branch_name || ''), at: new Date().toISOString(),
});
const trimPayment = p => ({
  id: String(p.payment_id), no: String(p.payment_number || ''), date: String(p.date || ''), cust: String(p.customer_id || ''), cust_name: String(p.customer_name || ''),
  amount: toPaise(p.amount) || 0, withheld: toPaise(p.tax_amount_withheld) || 0, tax_account_id: String(p.tax_account_id || ''), ref: String(p.reference_number || '').slice(0, 200),
  invoices: (p.invoices || []).map(i => ({ id: String(i.invoice_id || ''), no: String(i.invoice_number || ''), date: String(i.date || ''), applied: toPaise(i.amount_applied) || 0, withheld: toPaise(i.tax_amount_withheld) || 0, total: toPaise(i.total) })),
  lmt: String(p.last_modified_time || p.updated_time || ''), at: new Date().toISOString(),
});
const trimPayList = p => ({ id: String(p.payment_id), no: String(p.payment_number || ''), date: String(p.date || ''), cust: String(p.customer_id || ''), withheld: toPaise(p.tax_amount_withheld) || 0,
  tax_account_id: String(p.tax_account_id || ''), invoice_numbers: String(p.invoice_numbers || ''), lmt: String(p.last_modified_time || '') });
const trimJournal = j => ({
  id: String(j.journal_id), no: String(j.entry_number || ''), date: String(j.journal_date || ''), notes: String(j.notes || '').slice(0, 1000), ref: String(j.reference_number || '').slice(0, 300),
  lines: (j.line_items || []).map(l => ({ acc: String(l.account_id || ''), acc_name: String(l.account_name || ''), cust: String(l.customer_id || ''), cust_name: String(l.customer_name || ''), dc: l.debit_or_credit, amount: toPaise(l.amount) || 0 })),
  lmt: String(j.last_modified_time || ''), at: new Date().toISOString(),
});

const ledgerKey = (entity, fy) => `ledger_${entity}_${fy.replace('-', '_')}`;
const docsKey = entity => `docs_${entity}`;
const syncKey = entity => `sync_${entity}`;
const EMPTY_DOCS = { invoices: {}, payments: {}, paylist: {}, journals: {}, invno: {} };

function create({ zr, cfgNow, readSynced = async () => null, log = console }) {
  const running = new Map();                                   // entity → { cancel }
  let lastCall = 0, lastLedgerCall = 0;            // two pacers: ordinary API calls, and the slower account-transactions report

  async function centralFor(entity, name) {
    try { const d = await readSynced(entity.org_id, name); return d && Array.isArray(d.data) ? d : null; } catch (_) { return null; }
  }

  async function status(entityId) {
    const st = await store.read(syncKey(entityId), {});
    return { ...st, running: running.has(entityId) || !!(st.run && st.run.lock_until && Date.parse(st.run.lock_until) > Date.now()) };
  }

  /** Every stored ledger row of the entity (all financial years) */
  async function ledgerRows(entityId) {
    const keys = (await store.list(`ledger_${entityId}_`)).sort();
    const out = [];
    for (const k of keys) { const d = await store.read(k, { rows: {} }); out.push(...Object.values(d.rows)); }
    return out;
  }
  const docs = async entityId => ({ ...EMPTY_DOCS, ...(await store.read(docsKey(entityId), EMPTY_DOCS)) });

  /**
   * One step of a sync. The first call (from/to given) starts a run; later calls continue it until `more` is false.
   * mode: 'changes' = list the ledgers again for the period, fetch details only for new / changed documents; 'full' = details again too.
   */
  async function step({ entity, from, to, mode = 'changes', by = 'unknown', maxMs = 150000 }) {
    const t0 = Date.now();
    const cfg = await cfgNow();
    const limits = cfg.sync;
    const gap = Math.ceil(60000 / Math.max(10, limits.rate_per_min));
    const ledgerGap = Math.ceil(60000 / Math.max(5, limits.ledger_rate_per_min || 25));
    if (running.has(entity.id)) return { busy: true, message: 'A sync step for this entity is already running' };
    let st = await store.read(syncKey(entity.id), {});
    // online every request may land on another server instance, which cannot see `running`: the stored lock tells it a step is under way
    if (st.run && st.run.lock_until && Date.parse(st.run.lock_until) > Date.now()) {
      return { busy: true, message: `A sync step for this entity is already running (started by ${st.run.by || 'someone'}) — wait until ${new Date(Date.parse(st.run.lock_until) + 330 * 60000).toISOString().slice(11, 16)} (India time) and try again` };
    }
    if (st.blocked_until && Date.parse(st.blocked_until) > Date.now()) {
      return { more: false, error: `Zoho has paused its ledger report for this login until ${new Date(Date.parse(st.blocked_until) + 330 * 60000).toISOString().slice(11, 16)} (India time) — try again after that; nothing was lost`, blocked_until: st.blocked_until };
    }
    const ctl = { cancel: false };
    running.set(entity.id, ctl);
    const calls = { n: 0 };
    const day = todayIST();
    const save = async () => { await store.write(syncKey(entity.id), st); };
    try {
      if (!entity.ledgers.length) throw new Error('No TDS Receivable ledger is set up for this entity (Settings → Entities)');
      if (from && to) {
        if (from > to) throw new Error('"From" is after "to"');
        st.run = { id: `r${Date.now().toString(36)}`, by, mode, from, to, started_at: new Date().toISOString(), months_todo: PER.monthsBetween(from, to), months_done: [], details: null, calls: 0, phase: 'ledgers', errors: [] };
      }
      if (!st.run) return { more: false, message: 'No sync is in progress — choose a period and start one' };
      st.run.lock_until = new Date(Date.now() + maxMs + 60000).toISOString();
      if (!st.calls_day || st.calls_day.day !== day) st.calls_day = { day, n: 0 };
      await save();
      const pace = report => async () => {
        if (ctl.cancel) throw Object.assign(new Error('Stopped'), { stopped: true });
        if (st.calls_day.n >= limits.daily_budget) throw Object.assign(new Error(`This module's daily allowance of ${limits.daily_budget} Zoho calls is used up — the sync continues tomorrow (India time)`), { limit: true });
        const g = report ? ledgerGap : gap;
        const target = Math.max(Date.now(), (report ? lastLedgerCall : lastCall) + g);
        if (report) lastLedgerCall = target; else lastCall = target;
        // timers can fire a few ms early against the wall clock (Node measures them from a cached loop time): wait out any remainder
        while (Date.now() < target) await sleep(target - Date.now());
        st.calls_day.n++; calls.n++; st.run.calls++;
      };
      const get = (path, params) => zr.get(entity.org_id, path, params, { before: pace(path === '/chartofaccounts/transactions') });
      const timeLeft = () => maxMs - (Date.now() - t0);

      // 1. ledger postings, by windows of up to three months inside one quarter (a busy window is split further), all mapped ledgers
      while (st.run.phase === 'ledgers' && st.run.months_todo.length) {
        if (timeLeft() < 20000 + entity.ledgers.length * ledgerGap) { await save(); return result(true); }
        const months = [st.run.months_todo[0]];
        for (const m of st.run.months_todo.slice(1, 3)) if (PER.quarterOf(`${m}-01`) === PER.quarterOf(`${months[0]}-01`)) months.push(m); else break;
        const mFrom = `${months[0]}-01`, mTo = PER.monthEnd(months[months.length - 1]);
        const fresh = {};
        for (const l of entity.ledgers) fresh[l.account_id] = await listWindow(get, l.account_id, mFrom, mTo);
        const fy = PER.fyOf(mFrom);
        await store.update(ledgerKey(entity.id, fy), { rows: {}, months: {} }, d => {
          for (const [id, r] of Object.entries(d.rows)) if (r.date >= mFrom && r.date <= mTo && fresh[r.acc] !== undefined) delete d.rows[id];
          for (const [acc, rows] of Object.entries(fresh)) for (const r of rows) d.rows[r.id] = { ...r, acc: r.acc || acc };
          for (const ym of months) d.months[ym] = { at: new Date().toISOString(), counts: Object.fromEntries(Object.entries(fresh).map(([a, r]) => [a, r.filter(x => x.date.startsWith(ym)).length])) };
        });
        // customer payments of this month, when the central sync does not hold them (needed to find the payment behind a customer-payment posting)
        if (Object.values(fresh).some(rows => rows.some(r => r.type === 'customer_payment'))) {
          const central = await centralFor(entity, 'customer_payments_fy');
          const covered = central && central.window_from && central.window_from <= mFrom && (!central.window_to || central.window_to >= mTo);
          if (!covered) {
            const list = await listAll(get, '/customerpayments', 'customerpayments', { date_start: mFrom, date_end: mTo });
            await store.update(docsKey(entity.id), EMPTY_DOCS, d => { d.paylist = d.paylist || {}; for (const p of list) if (toPaise(p.tax_amount_withheld) > 0) d.paylist[String(p.payment_id)] = trimPayList(p); });
          }
        }
        st.run.months_todo.splice(0, months.length); st.run.months_done.push(...months);
        st.listed = { ...(st.listed || {}), ...Object.fromEntries(months.map(ym => [ym, new Date().toISOString()])) };
        await save();
      }
      if (st.run.phase === 'ledgers') { st.run.phase = 'details'; st.run.details = await detailQueue(entity, st.run); await save(); }

      // 2. details of new / changed documents
      const q = st.run.details;
      const take = async (kind, path, key, trim, saveFn) => {
        while (q[kind].length) {
          if (timeLeft() < 8000) return false;
          const batch = q[kind].splice(0, Math.max(1, limits.concurrency));
          const got = await Promise.all(batch.map(async id => {
            try { const d = await get(`${path}/${id}`, {}); return d && d[key] ? trim(d[key]) : null; }
            catch (e) { if (e.stopped || e.limit) { q[kind].unshift(id); throw e; } if (zr.isGone(e)) return { id, gone: true }; st.run.errors.push(`${kind} ${id}: ${zr.errText(e)}`.slice(0, 300)); return null; }
          }));
          await saveFn(got.filter(Boolean));
          await save();
        }
        return true;
      };
      const putDocs = field => async list => store.update(docsKey(entity.id), EMPTY_DOCS, d => {
        d[field] = d[field] || {};
        for (const x of list) { if (x.gone) delete d[field][x.id]; else d[field][x.id] = x; if (field === 'invoices' && !x.gone && x.no) d.invno[x.no.toUpperCase()] = { id: x.id, cust: x.cust, date: x.date }; }
      });
      if (!(await take('invoices', '/invoices', 'invoice', inv => trimInvoice(inv, entity.tan_field), putDocs('invoices')))) return result(true);
      if (!(await take('payments', '/customerpayments', 'payment', trimPayment, putDocs('payments')))) return result(true);
      // invoices that a payment points to and that are not stored yet
      if (!q.invoices.length && !q._paid_checked) {
        const d = await docs(entity.id);
        const want = new Set();
        for (const p of Object.values(d.payments)) for (const i of p.invoices) if (i.id && !d.invoices[i.id]) want.add(i.id);
        q.invoices.push(...want); q._paid_checked = true; await save();
        if (!(await take('invoices', '/invoices', 'invoice', inv => trimInvoice(inv, entity.tan_field), putDocs('invoices')))) return result(true);
      }
      if (!(await take('journals', '/journals', 'journal', trimJournal, putDocs('journals')))) return result(true);

      st.last_ok_at = new Date().toISOString();
      st.last_period = { from: st.run.from, to: st.run.to, mode: st.run.mode };
      st.history = [{ id: st.run.id, by: st.run.by, mode: st.run.mode, from: st.run.from, to: st.run.to, started_at: st.run.started_at, ended_at: st.last_ok_at, calls: st.run.calls, months: st.run.months_done.length, errors: st.run.errors.length }, ...(st.history || [])].slice(0, 20);
      st.last_error = st.run.errors.length ? `${st.run.errors.length} document(s) could not be read: ${st.run.errors.slice(0, 3).join('; ')}` : null;
      st.run = null;
      await save();
      return result(false);
    } catch (e) {
      if (st.run) st.run.lock_until = null;
      st.last_error = e.stopped ? 'Stopped by a user' : e.limit ? e.message : zr.errText ? zr.errText(e) : e.message;
      // Zoho's per-minute block (code 43, "wait 60 minutes"): remember until when, so nothing asks again before then
      const mins = e && e.name === 'ZohoLimit' && /wait (\d+) minute/i.exec(e.message);
      if (mins) st.blocked_until = new Date(Date.now() + Number(mins[1]) * 60000 + 60000).toISOString();
      if (e.stopped && st.run) st.run = null;
      await save();
      if (!e.stopped && !e.limit) log.error(`[tds26as] sync of ${entity.id}: ${st.last_error}`);
      return { more: false, error: st.last_error, calls: calls.n, stopped: !!e.stopped, limit: !!e.limit };
    } finally {
      running.delete(entity.id);
      if (st.run) { st.run.lock_until = null; await store.write(syncKey(entity.id), st).catch(() => {}); }
    }

    function result(more) {
      const r = st.run;
      return { more, calls: calls.n, phase: r ? r.phase : 'done', months_left: r ? r.months_todo.length : 0, months_done: r ? r.months_done.length : 0,
        details_left: r && r.details ? r.details.invoices.length + r.details.payments.length + r.details.journals.length : 0, last_ok_at: st.last_ok_at || null, error: st.last_error || null };
    }
  }

  /**
   * Ledger rows for one account and date window; a window that needs more than one page is split (date-sorted paging can skip rows).
   * The range goes in date_start / date_end: verified live on 22 Nov 2026, this report IGNORES date.start / date.end (and from_date /
   * to_date) and then returns the account's whole history — answers are therefore checked, and a window that comes back with postings
   * outside its dates stops the sync instead of being split again and again.
   */
  async function listWindow(get, acc, from, to, depth = 0) {
    const ask = page => get('/chartofaccounts/transactions', { account_id: acc, date_start: from, date_end: to, per_page: 200, page });
    const inWindow = list => {
      const out = list.filter(t => { const d = String(t.transaction_date || '').slice(0, 10); return d >= from && d <= to; });
      if (out.length !== list.length) throw new Error(`Zoho returned ledger postings outside ${from} … ${to} (the date filter was not applied) — the sync stopped instead of reading the whole ledger`);
      return out;
    };
    const first = await ask(1);
    const rows = inWindow(first.transactions || first.account_transactions || []);
    if (!(first.page_context && first.page_context.has_more_page)) return dedupe(rows.map(t => trimRow(t, acc)));
    if (from < to && depth < 6) {
      const mid = new Date((Date.parse(`${from}T00:00:00Z`) + Date.parse(`${to}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
      const next = new Date(Date.parse(`${mid}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      return dedupe([...(await listWindow(get, acc, from, mid, depth + 1)), ...(await listWindow(get, acc, next, to, depth + 1))]);
    }
    const all = rows.slice();                                   // one day with more than 200 postings: page through it
    for (let page = 2; page <= 50; page++) {
      const d = await ask(page);
      all.push(...inWindow(d.transactions || []));
      if (!(d.page_context && d.page_context.has_more_page)) break;
    }
    return dedupe(all.map(t => trimRow(t, acc)));
  }
  const dedupe = rows => { const m = new Map(); for (const r of rows) m.set(r.id, r); return [...m.values()]; };

  async function listAll(get, path, key, params) {
    const out = [];
    for (let page = 1; page <= 60; page++) {
      const d = await get(path, { ...params, page, per_page: 200, sort_column: 'created_time' });
      out.push(...(d[key] || []));
      if (!(d.page_context && d.page_context.has_more_page)) return out;
    }
    throw new Error(`${path} returned more than 60 pages — stopped instead of reading a partial list`);
  }

  /** Which details to fetch after the ledgers of a run are listed */
  async function detailQueue(entity, run) {
    const d = await docs(entity.id);
    const rows = (await ledgerRows(entity.id)).filter(r => r.date >= run.from && r.date <= run.to);
    const full = run.mode === 'full';
    const centralInv = await centralFor(entity, 'invoices_fy');
    const lmt = new Map((centralInv ? centralInv.data : []).map(i => [String(i.invoice_id), String(i.last_modified_time || '')]));
    const invoices = new Set(), payments = new Set(), journals = new Set();
    for (const r of rows) {
      if (r.type === 'invoice' && r.tid) { const have = d.invoices[r.tid]; if (full || !have || (lmt.get(r.tid) && lmt.get(r.tid) > have.lmt)) invoices.add(r.tid); }
      if (r.type === 'journal' && r.tid && (full || !d.journals[r.tid])) journals.add(r.tid);
    }
    // the payment behind each customer-payment posting: same customer and date, the invoice number in its invoice list
    const centralPay = await centralFor(entity, 'customer_payments_fy');
    const pays = [...Object.values(d.paylist || {}), ...((centralPay ? centralPay.data : []).filter(p => toPaise(p.tax_amount_withheld) > 0).map(trimPayList))];
    for (const r of rows.filter(x => x.type === 'customer_payment')) {
      const nos = p => p.invoice_numbers.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const cands = pays.filter(p => p.cust === r.cust && p.date === r.date && (nos(p).length ? !r.no || nos(p).includes(r.no.toUpperCase()) : p.withheld === r.dr - r.cr));
      for (const p of cands) { const have = d.payments[p.id]; if (full || !have || (p.lmt && p.lmt > have.lmt)) payments.add(p.id); }
      const inv = d.invno[r.no.toUpperCase()];
      if (!inv && r.no) { const c = (centralInv ? centralInv.data : []).find(i => String(i.invoice_number).toUpperCase() === r.no.toUpperCase()); if (c && !d.invoices[c.invoice_id]) invoices.add(String(c.invoice_id)); }
    }
    return { invoices: [...invoices], payments: [...payments], journals: [...journals] };
  }

  async function cancel(entityId) {
    const c = running.get(entityId);
    if (c) c.cancel = true;
    await store.update(syncKey(entityId), {}, st => { st.run = null; st.last_error = 'Stopped by a user'; });
    return { stopped: true };
  }

  /** The months of [from, to] whose ledgers were listed, and when (coverage of the Books side) */
  async function coverage(entityId, from, to) {
    const st = await store.read(syncKey(entityId), {});
    const months = PER.monthsBetween(from, to).map(ym => ({ month: ym, listed_at: (st.listed || {})[ym] || null }));
    return { last_ok_at: st.last_ok_at || null, months, missing: months.filter(m => !m.listed_at).map(m => m.month), running: !!st.run, last_error: st.last_error || null };
  }

  return { step, status, cancel, ledgerRows, docs, coverage, centralFor };
}

module.exports = { create, trimRow, trimInvoice, trimPayment, trimJournal, trimPayList, ledgerKey, docsKey, syncKey, EMPTY_DOCS };
