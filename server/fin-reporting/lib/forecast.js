/**
 * Financial Reporting — collection and payment forecasts (rupees).
 *
 * Collections  For every client, the days from invoice date to payment over the last 12 months (Zoho paid invoices:
 *              invoice date → last payment date) give the client's median days-to-pay; the client's usual invoice day,
 *              GST gross-up (invoice total ÷ sub-total) and TDS withheld (customer payments) come from the same history.
 *              Open invoices are expected on invoice date + the client's median days (already past → this month, flagged);
 *              future invoices come from the budget's revenue per client, invoiced on the client's usual day, collected
 *              after its median days. A client with no history uses the median of all clients (flagged).
 * Payments     Vendors' days from bill date to payment (Zoho vendor payments matched to bills) give a median per vendor;
 *              open bills are expected on bill date + that median. Future rent is paid on the payment-terms day of the
 *              month (Rent Recurring Module) at the landlord's billed amount after TDS; other budget expense heads after
 *              a lag per head (default: the median of all vendors) and a net-payment factor per head (default 1.00 — set
 *              it for GST / TDS); debt service from the debt schedule's due dates. Manual inflows / outflows are added.
 */

'use strict';

const S = require('./sources');

const DEFAULTS = { months: 12, headLags: { salary: 0, interest_loan: 0, bank_charges: 0 }, netFactors: {}, includeOpen: true, overdueCollections: 'aged', overdueDays: 60, overduePayments: 'current' };
const iso = t => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(d) + n * 86400000);
const dayIn = (m, d) => `${m}-${String(Math.min(d || 1, S.daysInMonth(m))).padStart(2, '0')}`;
const mode = xs => { const c = {}; let best = null; for (const x of xs) { c[x] = (c[x] || 0) + 1; if (best == null || c[x] > c[best]) best = x; } return best; };

async function clientPatterns(inv) {
  const today = S.todayIso();
  const since = addDays(today, -365);
  const pay = (await S.ops().readSynced('customer_payments_fy').catch(() => null))?.data || [];
  const by = new Map();
  for (const i of inv.invoices) {
    const c = by.get(i.customerId) || { id: i.customerId, name: i.customer, days: [], invDays: [], gst: [], open: 0 };
    if (i.paidOn && i.paidOn >= i.date && i.date >= since) c.days.push(S.days(i.date, i.paidOn));
    if (i.date >= since) c.invDays.push(+i.date.slice(8, 10));
    if (i.subKnown && i.sub > 0 && i.total > 0) c.gst.push(i.total / i.sub);
    if (i.balance > 0) c.open += i.balance;
    by.set(i.customerId, c);
  }
  const tds = {};
  for (const p of pay) { const t = tds[p.customer_id] || (tds[p.customer_id] = { amt: 0, wh: 0 }); t.amt += Number(p.amount) || 0; t.wh += Number(p.tax_amount_withheld) || 0; }
  const all = [...by.values()];
  const companyDays = S.median(all.flatMap(c => c.days));
  const companyGst = S.median(all.flatMap(c => c.gst)) || 1.18;
  const tAll = Object.values(tds).reduce((s, t) => ({ amt: s.amt + t.amt, wh: s.wh + t.wh }), { amt: 0, wh: 0 });
  const companyTds = tAll.amt + tAll.wh ? tAll.wh / (tAll.amt + tAll.wh) : 0;
  const patterns = new Map(all.map(c => {
    const t = tds[c.id];
    return [c.id, { id: c.id, name: c.name, payments: c.days.length, medianDays: c.days.length ? S.median(c.days) : null, p75: c.days.length >= 4 ? c.days.sort((a, b) => a - b)[Math.floor(c.days.length * 0.75)] : null,
      invoiceDay: mode(c.invDays) || 1, gstFactor: S.median(c.gst) || null, tdsShare: t && t.amt + t.wh ? t.wh / (t.amt + t.wh) : null, open: c.open }];
  }));
  return { patterns, company: { medianDays: companyDays, gstFactor: companyGst, tdsShare: companyTds } };
}

async function vendorPatterns() {
  const read = S.ops().readSynced;
  const [bf, bo, bov, vp] = await Promise.all(['bills_fy', 'bills_open', 'bills_overdue', 'vendor_payments_fy'].map(e => read(e).catch(() => null)));
  const bills = new Map();
  for (const src of [bf, bo, bov]) for (const b of src?.data || []) bills.set(b.bill_id, b);
  const byNo = new Map();
  for (const b of bills.values()) byNo.set(`${b.vendor_id}|${String(b.bill_number).trim().toLowerCase()}`, b);
  const days = {};
  for (const p of vp?.data || []) {
    for (const no of String(p.bill_numbers || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
      const b = byNo.get(`${p.vendor_id}|${no}`);
      if (!b || !b.date || p.date < b.date) continue;
      (days[p.vendor_id] = days[p.vendor_id] || { name: p.vendor_name, d: [] }).d.push(S.days(b.date, p.date));
    }
  }
  const company = S.median(Object.values(days).flatMap(v => v.d));
  const patterns = new Map(Object.entries(days).map(([id, v]) => [id, { id, name: v.name, payments: v.d.length, medianDays: S.median(v.d) }]));
  const open = [...bills.values()].filter(b => (Number(b.balance) || 0) > 0 && b.status !== 'void' && b.status !== 'draft');
  return { patterns, company: { medianDays: company }, open, window: { from: bf?.window_from || null } };
}

/** grid: a computed budget (rupees) or null; debtDoc: debt schedule; opening: { amount, asAt, source } */
async function build({ grid, debtDoc, settings = {}, manual = [], opening = null }) {
  const st = { ...DEFAULTS, ...settings, headLags: { ...DEFAULTS.headLags, ...(settings.headLags || {}) }, netFactors: { ...(settings.netFactors || {}) } };
  const today = S.todayIso();
  const startM = today.slice(0, 7);
  const months = S.monthsBetween(startM, S.addMonths(startM, (st.months || 12) - 1));
  const inv = await S.invoices();
  const cp = await clientPatterns(inv);
  const vp = await vendorPatterns();
  const rentBills = await S.rentBills().catch(() => []);
  let rentSkipped = 0;
  const flows = [];   // { dir: in|out, kind, label, date, amount, month, flags }
  const overdueIn = [], overdueOut = [];
  const put = f => { f.month = f.date.slice(0, 7) < startM ? startM : f.date.slice(0, 7); if (months.includes(f.month)) flows.push(f); else if (f.date.slice(0, 7) > months[months.length - 1]) f.beyond = true; };

  // ── collections: open invoices
  if (st.includeOpen) for (const i of inv.invoices.filter(x => x.balance > 0)) {
    const p = cp.patterns.get(i.customerId);
    const d = p?.medianDays ?? cp.company.medianDays ?? 30;
    const exp = addDays(i.date, Math.round(d));
    const t = p?.tdsShare ?? cp.company.tdsShare;
    // expected date passed: 'aged' (default) still expects it this month unless it is more than overdueDays late (then
    // doubtful: listed, not forecast); 'exclude' lists all of them; 'current' expects all of them this month
    const late = exp < today ? S.days(exp, today) : 0;
    if (exp < today && (st.overdueCollections === 'exclude' || (st.overdueCollections === 'aged' && late > (st.overdueDays ?? 60)))) { overdueIn.push({ party: i.customer, label: i.no, date: exp, amount: i.balance * (1 - t), invDate: i.date, daysLate: late }); continue; }
    put({ dir: 'in', kind: exp < today ? 'Overdue invoices (expected date passed)' : 'Open invoices', party: i.customer, partyId: i.customerId, label: i.no, date: exp, amount: i.balance * (1 - t), gross: i.balance,
      flags: [exp < today ? `expected ${exp} has passed (${late} days) — assumed this month` : null, p?.medianDays == null ? 'no payment history: median of all clients used' : null].filter(Boolean) });
  }
  // ── collections: future invoices from the budget. For the current month, what the client has already been invoiced
  // (in the open invoices above, or already collected) is taken off the budget so it is not counted twice.
  const invoicedNow = {};
  for (const i of inv.invoices) if (S.monthOf(i.date) === startM) invoicedNow[i.customerId] = (invoicedNow[i.customerId] || 0) + i.sub;
  if (grid) for (const r of grid.rows.filter(x => x.section === 'revenue')) {
    const p = r.meta.customerId ? cp.patterns.get(r.meta.customerId) : null;
    const d = p?.medianDays ?? cp.company.medianDays ?? 30;
    const gstF = p?.gstFactor ?? cp.company.gstFactor;
    const t = p?.tdsShare ?? cp.company.tdsShare;
    for (const m of grid.months) {
      let v = r.values[m] || 0;
      const done = m === startM && r.meta.customerId ? invoicedNow[r.meta.customerId] || 0 : 0;
      if (done) v = Math.max(0, v - done);
      if (!v || m < startM) continue;
      const invDate = dayIn(m, p?.invoiceDay || 1);
      put({ dir: 'in', kind: 'Budgeted revenue', party: r.label, partyId: r.meta.customerId, label: `${m} billing`, date: addDays(invDate, Math.round(d)), amount: v * gstF * (1 - t), gross: v * gstF,
        flags: [p?.medianDays == null ? 'no payment history: median of all clients used' : null, done ? `less ₹${Math.round(done)} already invoiced this month` : null].filter(Boolean) });
    }
  }
  // ── payments: open bills
  if (st.includeOpen) for (const b of vp.open) {
    const p = vp.patterns.get(b.vendor_id);
    const d = p?.medianDays ?? vp.company.medianDays ?? 30;
    const exp = addDays(b.date, Math.round(d));
    if (exp < today && st.overduePayments === 'exclude') { overdueOut.push({ party: b.vendor_name, label: b.bill_number, date: exp, amount: Number(b.balance) || 0 }); continue; }
    put({ dir: 'out', kind: exp < today ? 'Overdue bills (expected date passed)' : 'Open bills', party: b.vendor_name, partyId: b.vendor_id, label: b.bill_number, date: exp, amount: Number(b.balance) || 0, flags: [exp < today ? `expected ${exp} has passed — overdue` : null, !p ? 'no payment history: median of all vendors used' : null].filter(Boolean) });
  }
  // ── payments: budgeted rent and expenses
  if (grid) {
    const landlordFactor = {};
    for (const b of rentBills) if (b.sub) (landlordFactor[S.normName(b.vendor)] = landlordFactor[S.normName(b.vendor)] || []).push((b.total - b.tds) / b.sub);
    // rent already billed this month, by landlord (branch names differ between the Rent module and Zoho)
    const billedNow = {};
    for (const b of rentBills) if (b.month === startM) billedNow[S.normName(b.vendor)] = (billedNow[S.normName(b.vendor)] || 0) + b.sub;
    for (const r of grid.rows.filter(x => x.section === 'rent')) {
      const vendor = r.label.split(' — ')[0];
      const fs = landlordFactor[S.normName(vendor)];
      const factor = fs?.length ? S.median(fs) : 1 - (Number(r.meta.tdsPct) || 0) / 100;
      for (const m of grid.months) {
        let v = r.values[m] || 0;
        if (!v || m < startM) continue;
        if (m === startM && billedNow[S.normName(vendor)]) { const take = Math.min(v, billedNow[S.normName(vendor)]); billedNow[S.normName(vendor)] -= take; rentSkipped += take; v -= take; if (v < 1) continue; }
        put({ dir: 'out', kind: 'Rent', party: vendor, label: `${r.branch} ${m}`, date: dayIn(m, r.meta.terms || 10), amount: v * factor, flags: fs?.length ? [] : ['landlord not matched to Zoho rent bills: amount less TDS %, GST not added'] });
      }
    }
    for (const r of grid.rows.filter(x => x.section === 'expense')) {
      if (r.meta?.method === 'debt') continue;      // paid through the debt schedule below
      const lag = st.headLags[r.head] ?? vp.company.medianDays ?? 30;
      const f = st.netFactors[r.head] ?? 1;
      for (const m of grid.months) {
        const v = r.values[m] || 0;
        if (!v || m < startM) continue;
        put({ dir: 'out', kind: r.meta?.manual ? 'Manual budget lines' : 'Budgeted expenses', party: r.label, label: `${r.label} ${m}`, date: addDays(`${m}-15`, Math.round(lag)), amount: v * f, flags: [] });
      }
    }
  }
  // ── debt service
  const facName = id => debtDoc?.facilities?.find(f => f.id === id)?.facilityName || 'facility';
  for (const r of debtDoc?.schedule || []) {
    const amt = (Number(r.principal) || 0) + (Number(r.interest) || 0);
    if (!amt || r.dueDate < today) continue;
    put({ dir: 'out', kind: 'Debt service', party: facName(r.facilityId), label: `principal ${Math.round(r.principal || 0)} + interest ${Math.round(r.interest || 0)}`, date: r.dueDate, amount: amt, flags: [] });
  }
  // ── manual
  for (const x of manual) put({ dir: x.dir === 'in' ? 'in' : 'out', kind: 'Manual', party: x.label, label: x.note || '', date: `${x.month}-15`, amount: Number(x.amount) || 0, flags: [], manualId: x.id });

  // bills of the current month (other than rent) are among the open bills while the month's budget is counted in full
  const rentIds = new Set(rentBills.map(b => b.id));
  const billsNow = vp.open.filter(b => S.monthOf(b.date) === startM && !rentIds.has(b.bill_id)).reduce((t, b) => t + (Number(b.balance) || 0), 0);

  // monthly table
  let bal = opening?.amount ?? null;
  const table = months.map(m => {
    const fl = flows.filter(f => f.month === m);
    const ins = {}, outs = {};
    for (const f of fl) { const t = f.dir === 'in' ? ins : outs; t[f.kind] = (t[f.kind] || 0) + f.amount; }
    const tin = Object.values(ins).reduce((s, x) => s + x, 0), tout = Object.values(outs).reduce((s, x) => s + x, 0);
    const openBal = bal;
    if (bal != null) bal = bal + tin - tout;
    return { month: m, ins, outs, totalIn: tin, totalOut: tout, net: tin - tout, opening: openBal, closing: bal, gap: bal != null && bal < 0 };
  });
  const clientTable = [...cp.patterns.values()].filter(p => p.open > 0 || p.payments).sort((a, b) => b.open - a.open).slice(0, 400);
  const vendorTable = [...vp.patterns.values()].sort((a, b) => b.payments - a.payments).slice(0, 300);
  return { months, table, flows: flows.sort((a, b) => a.date.localeCompare(b.date)), clients: clientTable, vendors: vendorTable, company: { clients: cp.company, vendors: vp.company },
    settings: st, opening, budget: grid ? { id: grid.version.id, name: grid.version.name } : null, notes: { vendorHistoryFrom: vp.window.from, rentAlreadyBilled: rentSkipped, billsThisMonth: billsNow, overdueExcludedIn: overdueIn.reduce((s, f) => s + f.amount, 0), overdueExcludedOut: overdueOut.reduce((s, f) => s + f.amount, 0) }, overdue: { in: overdueIn.sort((a, b) => b.amount - a.amount).slice(0, 300), out: overdueOut.sort((a, b) => b.amount - a.amount).slice(0, 300) } };
}

module.exports = { build, clientPatterns, vendorPatterns, DEFAULTS };
