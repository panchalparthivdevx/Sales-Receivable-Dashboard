'use strict';
// ─── Month-wise & Branch-wise Recurring Expense Report (bill-based) ──────────────────────────────
// Per expense head × branch × month: Basic amount, Bill amount (payable) and Outstanding amount,
// with the bills behind every figure (vendor, bill no., basic, GST, TDS, bill amount, paid date,
// paid amount, outstanding).
//
// Where the figures come from:
// • Which bills: every bill posted to one of the seven expense accounts in HEADS, read from Zoho's
//   ledger for that account (/chartofaccounts/transactions). This is the same per-account FY cache
//   the Branch P&L keeps (pl_fy_cache/<fy>/acct_<id>.json); it is refreshed here when older than
//   an hour. Basic = what the bill posted to that account (exactly what Zoho's P&L shows),
//   month = bill date, branch = the bill's branch.
// • Bill amount = Zoho's bill total (payable to the vendor, i.e. after TDS), Outstanding = the
//   bill's balance, Paid amount = bill amount − outstanding (payments + vendor credits applied).
//   These come from the synced bill list (bills_fy); the paid date from the synced vendor payments
//   that name the bill (vendor_payments_fy).
// • GST = bill total + TDS − basic. That is exact when the bill has no lines outside this head.
//   Bills where it cannot be exact (lines in other accounts or several heads, a paid amount with no
//   matching payment) are read once from Zoho's bill DETAIL — paced through the shared queue, kept
//   per bill, refetched only when the bill changes — and split line by line.
// • FY 2025-26 bills are not in the synced list, so each of them is read from its detail.
// • Journal entries and vendor credits posted to these accounts are not bills: they are left out
//   and only counted (`excluded`).

const path = require('path');

const HEADS = [
  { key: 'hk_material', label: 'Housekeeping Material Expense', account_id: '1714732000000071386' },
  { key: 'hk_service',  label: 'Housekeeping Service',          account_id: '1714732000000071402' },
  { key: 'internet',    label: 'Internet Connect. Charges',     account_id: '1714732000000071398' },
  { key: 'security',    label: 'Security Services',             account_id: '1714732000000071400' },
  { key: 'tc_machine',  label: 'Tea & Coffee Machine Maint.',   account_id: '1714732000000071280' },
  { key: 'tc_milk',     label: 'Tea, Coffee & Milk Expense',    account_id: '1714732000000071224' },
  { key: 'electricity', label: 'Electricity Expense',           account_id: '1714732000000071222' },
];

const GST_RATES = [0, 0.05, 0.12, 0.18, 0.28, 0.40];
const LEDGER_MAX_AGE_MS = { current: 60 * 60e3, past: 24 * 3600e3 };
const LEDGER_GAP_MS = 3000;            // /chartofaccounts/transactions has its own low per-minute limit (~80/min blocks for 1 h)
const PAST_DETAIL_RECHECK_MS = 7 * 24 * 3600e3;   // FY 2025-26 bills still open are re-read weekly

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const r2  = v => Math.round(num(v) * 100) / 100;

function isStdGst(basic, gst) {
  return basic > 0 && GST_RATES.some(r => Math.abs(gst - basic * r) <= Math.max(2, basic * 0.002));
}

// vendor_id|bill_number → payment dates (a payment's bill_numbers lists every bill it settles)
function buildPayIndex(payments) {
  const idx = new Map();
  for (const p of payments || []) {
    if (!p || !p.vendor_id || !p.date) continue;
    for (const raw of String(p.bill_numbers || '').split(',')) {
      const bn = raw.trim();
      if (!bn) continue;
      const k = `${p.vendor_id}|${bn}`;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(p.date);
    }
  }
  return idx;
}

// Latest payment naming this bill; payments dated on/after the bill win (bill numbers can repeat across years)
function paidDateFromIndex(idx, vendorId, billNumber, billDate) {
  const ds = idx.get(`${vendorId}|${billNumber}`);
  if (!ds || !ds.length) return null;
  const after = ds.filter(d => !billDate || d >= billDate);
  return [...(after.length ? after : ds)].sort().pop();
}

// Keep only what the report needs from a bill DETAIL: per-account [basic, GST, TDS] and the payments
function slimDetail(bill, lmt) {
  const acc = {};
  for (const li of bill.line_items || []) {
    if (!li.account_id) continue;
    const a = acc[li.account_id] || (acc[li.account_id] = [0, 0, 0]);
    a[0] += num(li.item_total);
    a[1] += (li.line_item_taxes || []).reduce((s, t) => s + num(t.tax_amount), 0);
    a[2] += num(li.tds_tax_amount);
  }
  for (const k of Object.keys(acc)) acc[k] = acc[k].map(r2);
  return {
    lmt: lmt || bill.last_modified_time || null, at: new Date().toISOString(),
    vid: bill.vendor_id || '', vn: bill.vendor_name || '', bn: bill.bill_number || '', d: bill.date || '',
    br: bill.branch_name || '', st: bill.status || '',
    total: r2(bill.total), bal: r2(bill.balance), tds: r2(bill.tds_amount),
    sub: r2(bill.sub_total), tax: r2(bill.tax_total), acc,
    pay: (bill.payments || []).filter(p => p && p.date).map(p => [p.date, r2(p.amount)]),
  };
}

function fyInfo(fyParam, today, currentFYTag) {
  if (fyParam === 'fy2526') {
    return { tag: '2025-26', label: 'FY 2025-26', start: '2025-04-01', end: '2026-03-31', lastMonth: '2026-03', current: false };
  }
  const tag = currentFYTag();                       // e.g. '2026-27'
  const y = parseInt(tag.slice(0, 4), 10);
  return { tag, label: `FY ${tag}`, start: `${y}-04-01`, end: `${y + 1}-03-31`, lastMonth: today.slice(0, 7), current: true };
}

function monthList(fy) {
  const out = [];
  let [y, m] = fy.start.slice(0, 7).split('-').map(Number);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > fy.lastMonth || key > fy.end.slice(0, 7)) break;
    const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    out.push({ key, label });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Pure computation (no Zoho, no files). Returns the report body plus `needDetail`: bills whose
 * figures cannot be exact without their detail ({ bill_id, lmt }).
 *   ledgers:  { [account_id]: ledger rows }       list: Map bill_id → bills-list row, or null
 *   details:  { [bill_id]: slimDetail }            payIdx: buildPayIndex(...)
 */
function computeReport({ heads = HEADS, months, ledgers, list, details, payIdx, now = Date.now(), current = true }) {
  const monthSet = new Set(months.map(m => m.key));
  const headByAcct = new Map(heads.map(h => [h.account_id, h]));
  const excluded = {};
  const perBill = new Map();     // bill_id → { date, heads: Map head_key → basic }

  for (const h of heads) {
    for (const t of ledgers[h.account_id] || []) {
      const date = t.transaction_date || '';
      if (!monthSet.has(date.slice(0, 7))) continue;
      const amt = num(t.debit_amount) - num(t.credit_amount);
      if (t.transaction_type !== 'bill' || !t.transaction_id) {
        const k = t.transaction_type || 'other';
        const e = excluded[k] || (excluded[k] = { count: 0, amount: 0 });
        e.count++; e.amount = r2(e.amount + amt);
        continue;
      }
      const b = perBill.get(t.transaction_id) || { date, heads: new Map() };
      b.heads.set(h.key, (b.heads.get(h.key) || 0) + amt);
      perBill.set(t.transaction_id, b);
    }
  }

  const rowMap = new Map();
  const getCell = (h, branch, mk) => {
    const rk = `${h.key}|||${branch}`;
    if (!rowMap.has(rk)) rowMap.set(rk, { head_key: h.key, head_label: h.label, branch, monthly: {} });
    const row = rowMap.get(rk);
    return row.monthly[mk] || (row.monthly[mk] = { basic: 0, bill: 0, outstanding: 0, bills: [] });
  };

  // A vendor + bill number used on more than one bill (e.g. the electricity board's "Nov-2026"):
  // a payment naming it cannot tell those bills apart, so their paid date comes from the detail
  const dupBillNo = new Set();
  if (list) {
    const seen = new Set();
    for (const b of list.values()) {
      const k = `${b.vendor_id}|${b.bill_number}`;
      if (seen.has(k)) dupBillNo.add(k); else seen.add(k);
    }
  }

  const needDetail = [];
  let estimated = 0, pendingBills = 0, pendingBasic = 0;

  for (const [billId, pb] of perBill) {
    const lb  = list ? list.get(billId) : null;
    const det = details[billId];
    if (det && det.gone) continue;
    const status = (lb?.status || det?.st || '').toLowerCase();
    if (status === 'void' || status === 'draft') continue;

    const headKeys = [...pb.heads.keys()];
    const sumBasic = headKeys.reduce((s, k) => s + pb.heads.get(k), 0);
    const mk = pb.date.slice(0, 7);

    // Bill-level figures: the synced list is the freshest; otherwise the stored detail
    const src = lb ? {
      vid: lb.vendor_id, vn: lb.vendor_name, bn: lb.bill_number, d: lb.date || pb.date, br: lb.branch_name,
      total: num(lb.total), bal: num(lb.balance), tds: num(lb.tds_total), lmt: lb.last_modified_time,
    } : det ? {
      vid: det.vid, vn: det.vn, bn: det.bn, d: det.d || pb.date, br: det.br,
      total: det.total, bal: det.bal, tds: det.tds, lmt: det.lmt,
    } : null;

    if (!src) {                                          // FY 2025-26 bill whose detail is not read yet
      needDetail.push({ bill_id: billId, lmt: null });
      pendingBills++; pendingBasic += sumBasic;
      continue;
    }

    const paidAmt  = src.total - src.bal;
    const dupNo    = dupBillNo.has(`${src.vid}|${src.bn}`);
    const payDate  = payIdx && !dupNo ? paidDateFromIndex(payIdx, src.vid, src.bn, src.d) : null;
    const gstAll   = src.total + src.tds - sumBasic;
    const exactFromList = !!lb && headKeys.length === 1 && isStdGst(sumBasic, gstAll) && (paidAmt <= 0.5 || !!payDate);

    let detFresh = false;
    if (det) {
      if (lb) detFresh = !!det.lmt && det.lmt === lb.last_modified_time;
      else detFresh = !(det.bal > 0.5 && now - Date.parse(det.at || 0) > PAST_DETAIL_RECHECK_MS);
    }
    const useDetail = det && !exactFromList;
    if (!exactFromList && !detFresh) needDetail.push({ bill_id: billId, lmt: src.lmt || null });
    const est = !exactFromList && !detFresh;
    if (est) estimated++;

    // Per-account shares from the detail lines (GST / TDS spread by basic when the lines carry none)
    let lineOf = null, netAll = 0;
    if (useDetail) {
      const rows = Object.values(det.acc || {});
      const sAmt = rows.reduce((s, a) => s + a[0], 0);
      const sTax = rows.reduce((s, a) => s + a[1], 0);
      const sTds = rows.reduce((s, a) => s + a[2], 0);
      const taxOf = a => (sTax > 0.5 || det.tax < 0.5) ? a[1] : det.tax * (sAmt ? a[0] / sAmt : 0);
      const tdsOf = a => (sTds > 0.5 || det.tds < 0.5) ? a[2] : det.tds * (sAmt ? a[0] / sAmt : 0);
      netAll = rows.reduce((s, a) => s + a[0] + taxOf(a) - tdsOf(a), 0);
      lineOf = acct => { const a = det.acc?.[acct] || [0, 0, 0]; return { amt: a[0], gst: taxOf(a), tds: tdsOf(a) }; };
    }
    const paidDate = useDetail && det.pay?.length ? det.pay.map(p => p[0]).sort().pop() : payDate;

    for (const hk of headKeys) {
      const h = heads.find(x => x.key === hk);
      const basic = pb.heads.get(hk);
      let gst, tds, share;
      if (lineOf) {
        const l = lineOf(h.account_id);
        gst = l.gst; tds = l.tds;
        share = netAll > 0.5 ? (l.amt + l.gst - l.tds) / netAll : 1 / headKeys.length;
      } else {
        share = sumBasic ? basic / sumBasic : 1 / headKeys.length;
        gst = Math.max(0, gstAll) * share;
        tds = src.tds * share;
      }
      const billAmt = src.total * share;
      const outAmt  = src.bal * share;
      const cell = getCell(h, src.br || 'Unassigned', mk);
      cell.basic += basic; cell.bill += billAmt; cell.outstanding += outAmt;
      cell.bills.push({
        account_name: h.label, branch_name: src.br || 'Unassigned', vendor_name: src.vn || '',
        bill_number: src.bn || '', date: src.d || pb.date,
        basic: r2(basic), gst: r2(gst), tds: r2(tds), bill_amount: r2(billAmt),
        paid_date: paidAmt > 0.5 ? (paidDate || null) : null,
        paid_amount: r2(billAmt - outAmt), outstanding: r2(outAmt),
        part: headKeys.length > 1 || share < 0.999 ? r2(share * 100) : null,
        est: est || undefined,
      });
    }
  }

  const headOrder = new Map(heads.map((h, i) => [h.key, i]));
  const rows = [...rowMap.values()].map(r => {
    for (const c of Object.values(r.monthly)) {
      c.basic = r2(c.basic); c.bill = r2(c.bill); c.outstanding = r2(c.outstanding);
      c.bills.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.vendor_name.localeCompare(b.vendor_name));
    }
    return r;
  }).sort((a, b) => (headOrder.get(a.head_key) - headOrder.get(b.head_key)) || a.branch.localeCompare(b.branch));

  return {
    months,
    heads: heads.map(h => ({ key: h.key, label: h.label })),
    rows,
    all_branches: ['All Branches', ...[...new Set(rows.map(r => r.branch))].sort()],
    details_pending: estimated,
    bills_pending: pendingBills,
    bills_pending_basic: r2(pendingBasic),
    excluded,
    needDetail,
    current,
  };
}

function create(deps) {
  const { db, syncEngine, zohoGet, pacedGet, readLedger, writeLedger, isLedgerBusy = () => false,
          onChange = () => {}, localDate, currentFYTag, isVercel = false } = deps;
  const STORE_KEY  = 'recur_bill_details';
  const STORE_FILE = path.join(__dirname, 'recur_bill_details.json');

  // ── Bill detail store + paced worker ──────────────────────────────────────────
  let storeP = null;
  const loadStore = () => (storeP = storeP || db.readJSON(STORE_KEY, STORE_FILE, null).then(v => v || {}));
  const saveStore = async () => db.writeJSON(STORE_KEY, STORE_FILE, await loadStore());
  const queue = new Map();
  let worker = null, detailBlockedUntil = 0;

  function queueDetails(items) {
    if (Date.now() < detailBlockedUntil) return null;
    for (const it of items) if (!queue.has(it.bill_id)) queue.set(it.bill_id, it);
    if (!queue.size) return worker;
    if (!worker) worker = drain().finally(() => { worker = null; });
    return worker;
  }

  async function drain() {
    const store = await loadStore();
    let unsaved = 0, blocked = false;
    try {
      while (queue.size && !blocked) {
        const batch = [...queue.values()].slice(0, 3);
        batch.forEach(b => queue.delete(b.bill_id));
        await Promise.all(batch.map(async b => {
          try {
            const bill = (await pacedGet(`/bills/${b.bill_id}`)).bill;
            if (bill) { store[b.bill_id] = slimDetail(bill, b.lmt); unsaved++; }
          } catch (e) {
            if (e.response?.status === 404) { store[b.bill_id] = { gone: true, lmt: b.lmt, at: new Date().toISOString() }; unsaved++; }
            else if (e.response?.status === 429 || /LIMIT/.test(e.message)) blocked = true;
            else console.warn(`[recurring] bill ${b.bill_id} detail failed:`, e.message);
          }
        }));
        if (unsaved >= 50) { await saveStore(); unsaved = 0; onChange(); }
      }
    } finally {
      // Throttled: stop and retry in 10 minutes (the next report load queues what is still missing)
      if (blocked) { queue.clear(); detailBlockedUntil = Date.now() + 10 * 60e3; }
      if (unsaved) await saveStore();
      onChange();
    }
  }

  // ── Ledger (per account, per FY) ──────────────────────────────────────────────
  const ledgerState = {};          // fy tag → { running, blockedUntil, error }
  let ledgerNext = 0;
  const ledgerSlot = async () => {
    const now = Date.now(), slot = Math.max(now, ledgerNext);
    ledgerNext = slot + LEDGER_GAP_MS;
    if (slot > now) await new Promise(r => setTimeout(r, slot - now));
  };

  function refreshLedgers(fy) {
    const st = ledgerState[fy.tag] || (ledgerState[fy.tag] = {});
    if (st.running) return st.running;
    if (Date.now() < (st.blockedUntil || 0) || isLedgerBusy(fy.tag)) return null;
    st.running = (async () => {
      for (const h of HEADS) {
        const rows = [];
        for (let page = 1; page <= 60; page++) {
          await ledgerSlot();
          const r = await zohoGet('/chartofaccounts/transactions', {
            account_id: h.account_id, date_start: fy.start, date_end: fy.end, per_page: 200, page,
          });
          const txns = r.transactions || r.account_transactions || [];
          for (const t of txns) { const d = t.transaction_date || ''; if (d >= fy.start && d <= fy.end) rows.push(t); }
          if (!txns.length || !r.page_context?.has_more_page) break;
        }
        await writeLedger(fy.tag, h.account_id, rows);
      }
      st.error = null;
    })().catch(e => {
      st.error = e.message;
      if (e.response?.status === 429 || /LIMIT|blocked/i.test(e.message)) st.blockedUntil = Date.now() + 65 * 60e3;
      console.error(`[recurring] ledger refresh ${fy.tag} failed:`, e.message);
    }).finally(() => { st.running = null; onChange(); });
    return st.running;
  }

  async function readLedgers(fy) {
    const ledgers = {};
    let oldest = null, missing = 0;
    for (const h of HEADS) {
      const doc = await readLedger(fy.tag, h.account_id);
      if (!doc || !Array.isArray(doc.transactions)) { missing++; continue; }
      ledgers[h.account_id] = doc.transactions;
      if (!oldest || doc.fetched_at < oldest) oldest = doc.fetched_at;
    }
    return { ledgers, oldest, missing };
  }

  async function report(fyParam) {
    const today = localDate(new Date());
    const fy = fyInfo(fyParam, today, currentFYTag);
    const months = monthList(fy);

    let L = await readLedgers(fy);
    const maxAge = fy.current ? LEDGER_MAX_AGE_MS.current : LEDGER_MAX_AGE_MS.past;
    if (L.missing) {
      // First use of this FY: read the ledgers before answering (about a minute)
      await refreshLedgers(fy);
      L = await readLedgers(fy);
    } else if (!L.oldest || Date.now() - Date.parse(L.oldest) > maxAge) {
      refreshLedgers(fy);              // in the background; this answer uses the stored ledgers
    }

    let list = null, payIdx = null;
    if (fy.current) {
      try {
        const bills = await syncEngine.readSyncedData('bills_fy');
        if (bills && Array.isArray(bills.data)) list = new Map(bills.data.map(b => [b.bill_id, b]));
      } catch (_) { /* no synced list: every bill is read from its detail */ }
      try {
        const pays = await syncEngine.readSyncedData('vendor_payments_fy');
        payIdx = buildPayIndex(pays?.data || []);
      } catch (_) { payIdx = new Map(); }
    }

    const details = await loadStore();
    let out = computeReport({ months, ledgers: L.ledgers, list, details, payIdx, current: fy.current });

    if (out.needDetail.length) {
      // A few changed bills are read before answering; a big backlog (first fill) fills in the background
      const w = queueDetails(out.needDetail);
      if (w && out.needDetail.length <= 30) {
        await w;
        out = computeReport({ months, ledgers: L.ledgers, list, details: await loadStore(), payIdx, current: fy.current });
      }
    }

    const st = ledgerState[fy.tag] || {};
    const { needDetail, ...body } = out;
    return {
      fy: fy.label,
      ...body,
      ledger: { fetched_at: L.oldest, missing: L.missing, refreshing: !!st.running, error: st.error || null },
      detail_queue: queue.size,
      on_vercel: isVercel || undefined,
    };
  }

  return { report, refreshLedgers: fyParam => refreshLedgers(fyInfo(fyParam, localDate(new Date()), currentFYTag)) };
}

module.exports = { create, computeReport, slimDetail, buildPayIndex, paidDateFromIndex, isStdGst, monthList, fyInfo, HEADS };
