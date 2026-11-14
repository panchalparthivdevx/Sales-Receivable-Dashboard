/**
 * Financial Reporting — budget builder (monthly, rupees internally; the API returns ₹ lakh).
 *
 * Revenue   per client: the client's monthly billing in Zoho (invoice sub-totals, before GST) in the base month — or the
 *           average of the last 3 months — carried forward month by month UNTIL THE CLIENT'S END DATE (client contracts:
 *           your list; agreement-module dates prefill it). The end month is counted by days. A contract can also give the
 *           monthly amount, an escalation % and the escalation date. Clients without an end date: continue to the budget end
 *           (flagged) or stop — a setting.
 * Rent      per branch × landlord × office from the Rent Recurring Module workbook: the agreed amount of the module covering
 *           the month; after the last module, the last amount with its increment % at each anniversary; nothing after the
 *           agreement end date (or the end date you set, which overrides the workbook). Rent in Zoho for a branch the
 *           workbook does not cover is carried at its base-month amount and flagged.
 * Expenses  every other Branch P&L expense head from its last 12 months in Zoho (posted account transactions):
 *           12-month linear trend by default, or 12-month average / 3-month average / last month / nil, per head.
 *           Finance cost can come from the debt schedule instead.
 * Manual    lines you add (head, branch, months, monthly amount) and overrides of any cell. Overrides always win.
 * Nothing is pro-rated from quarterly statements and nothing is invented: every cell says where it came from.
 */

'use strict';

const S = require('./sources');

const RENT_HEADS = new Set(['off_rent']);
const SKIP_HEADS = new Set(['revenue', 'prior_period']);
// Branch P&L heads → statement lines (for budget vs actual against the published results)
const HEAD_TO_LINE = { revenue: 'pl.rev', other_income: 'pl.oth_inc', off_rent: 'm.lease', off_maint: 'pl.exp_ops', off_furniture_rent: 'pl.exp_ops', hk_material: 'pl.exp_ops', hk_services: 'pl.exp_ops', security: 'pl.exp_ops',
  electricity: 'pl.exp_ops', cogs: 'pl.exp_ops', tea_coffee: 'pl.exp_ops', salary: 'pl.exp_emp', interest_loan: 'pl.exp_fin', bank_charges: 'pl.exp_fin', depreciation: 'pl.exp_dep' };
const lineOfHead = h => HEAD_TO_LINE[h] || 'pl.exp_oth';
const METHODS = ['trend', 'avg12', 'avg3', 'last', 'zero', 'debt'];

const DEFAULT_SETTINGS = () => {
  const base = S.lastCompleteMonth();
  const cur = S.addMonths(base, 1);
  const [y, m] = cur.split('-').map(Number);
  const fyEnd = m >= 4 ? y + 2 : y + 1;          // end of the next financial year
  return { from: cur, to: `${fyEnd}-03`, baseMonth: base, revenueBasis: 'last', noEndDate: 'continue', trendCap: 0.5, excludeCategories: [], defaultMethod: 'trend', headMethods: {}, financeFromDebt: true };
};

function escalate(amount, month, esc) {
  if (!esc?.pct || !esc.from) return amount;
  const first = esc.from.slice(0, 7);
  if (month < first) return amount;
  const [y1, m1] = first.split('-').map(Number), [y2, m2] = month.split('-').map(Number);
  const k = Math.floor(((y2 - y1) * 12 + (m2 - m1)) / 12) + 1;
  return amount * Math.pow(1 + esc.pct, k);
}
/** Next escalation strictly after the base month (a past escalation is already in the billing) */
function nextEsc(esc, baseMonth) {
  if (!esc?.pct || !esc.from) return null;
  let f = esc.from.slice(0, 7);
  while (f <= baseMonth) f = S.addMonths(f, 12);
  return { pct: esc.pct, from: f };
}
function endFraction(month, endDate) {
  if (!endDate) return 1;
  const em = endDate.slice(0, 7);
  if (month < em) return 1;
  if (month > em) return 0;
  return Math.min(1, +endDate.slice(8, 10) / S.daysInMonth(month));
}
function startFraction(month, startDate) {
  if (!startDate) return 1;
  const sm = startDate.slice(0, 7);
  if (month > sm) return 1;
  if (month < sm) return 0;
  const d = +startDate.slice(8, 10), dim = S.daysInMonth(month);
  return (dim - d + 1) / dim;
}

// ── revenue ──────────────────────────────────────────────────────────────────
function revenueRows(inv, contracts, st, months) {
  const base = st.baseMonth;
  const histMonths = S.monthsBetween(S.addMonths(base, -11), base);
  const excl = new Set(st.excludeCategories || []);
  const byCust = new Map();
  for (const i of inv.invoices) {
    const m = S.monthOf(i.date);
    if (!m || m > base || m < histMonths[0] || excl.has(i.category)) continue;
    const c = byCust.get(i.customerId) || { id: i.customerId, name: i.customer, branch: i.branch, lastDate: '', hist: {}, cats: {} };
    c.hist[m] = (c.hist[m] || 0) + i.sub;
    c.cats[i.category] = (c.cats[i.category] || 0) + i.sub;
    if (i.date >= c.lastDate) { c.lastDate = i.date; c.branch = i.branch || c.branch; c.name = i.customer; }
    byCust.set(i.customerId, c);
  }
  // contracts matched by Zoho customer id, else by name
  const byNorm = new Map([...byCust.values()].map(c => [S.normName(c.name), c]));
  const used = new Set();
  const rows = [];
  const flags = { noEndDate: 0, contractUnmatched: [], ended: 0, oneOff: 0, oneOffAmount: 0 };
  const contractOf = c => contracts.find(k => k.customerId && k.customerId === c.id) || contracts.find(k => !k.customerId && S.normName(k.client) === S.normName(c.name));
  const build = (c, k) => {
    const last = c ? (c.hist[base] || 0) : 0;
    const avg3 = c ? [0, 1, 2].reduce((s, i) => s + (c.hist[S.addMonths(base, -i)] || 0), 0) / 3 : 0;
    const runRate = k?.monthlyRevenue != null && k.monthlyRevenue !== '' ? Number(k.monthlyRevenue) : (st.revenueBasis === 'avg3' ? avg3 : last);
    const basis = k?.monthlyRevenue != null && k.monthlyRevenue !== '' ? 'contract amount' : st.revenueBasis === 'avg3' ? 'average of the last 3 months' : `billing in ${base}`;
    const endDate = k?.endDate || null;
    const esc = nextEsc(k?.escalationPct ? { pct: Number(k.escalationPct) > 1 ? Number(k.escalationPct) / 100 : Number(k.escalationPct), from: k.escalationDate || null } : null, base);
    const values = {};
    const flagsRow = [];
    if (!endDate) { if (st.noEndDate === 'stop') flagsRow.push('No end date — not projected (setting)'); else flagsRow.push('No end date — projected to the budget end'); }
    if (endDate && endDate.slice(0, 7) < months[0]) flagsRow.push(`Ended ${endDate}`);
    // a base month far above the client's usual month may be a one-off invoice that should not be repeated
    if (c && last > 0 && basis === `billing in ${base}`) {
      const prior = histMonths.slice(0, -1).map(x => c.hist[x] || 0).filter(v => v > 0);
      const med = S.median(prior);
      if (!prior.length) flagsRow.push('Billed only in the base month — check that it recurs');
      else if (last > 2 * med) flagsRow.push(`Base-month billing is ${(last / med).toFixed(1)}× the client's usual month — check for a one-off`);
    }
    for (const m of months) {
      if (!runRate) { values[m] = 0; continue; }
      if (!endDate && st.noEndDate === 'stop') { values[m] = 0; continue; }
      const f = endFraction(m, endDate) * startFraction(m, k?.startDate && (!c || k.startDate.slice(0, 7) > base) ? k.startDate : null);
      values[m] = f ? escalate(runRate, m, esc) * f : 0;
    }
    return { id: `rev:${c ? c.id : `k_${k.id}`}`, section: 'revenue', head: 'revenue', label: c ? c.name : k.client, branch: (k?.branch) || c?.branch || '', values,
      meta: { customerId: c?.id || k?.customerId || null, runRate, basis, endDate, escalation: esc, hist: c ? histMonths.map(m => c.hist[m] || 0) : [], histMonths, contract: k ? k.id : null, source: k?.source || null, flags: flagsRow, lastInvoice: c?.lastDate || null } };
  };
  for (const c of byCust.values()) {
    const k = contractOf(c);
    if (k) used.add(k.id);
    const row = build(c, k);
    if (row.meta.runRate || Object.values(row.values).some(Boolean)) { rows.push(row); if (!row.meta.endDate) flags.noEndDate++; else if (row.meta.endDate.slice(0, 7) < months[0]) flags.ended++; if (row.meta.flags.some(x => /one-off|only in the base month/.test(x))) { flags.oneOff++; flags.oneOffAmount += row.meta.runRate; } }
  }
  for (const k of contracts) {
    if (used.has(k.id)) continue;
    if (k.monthlyRevenue != null && k.monthlyRevenue !== '') rows.push(build(null, k));   // a new client with no billing yet
    else flags.contractUnmatched.push(k.client);
  }
  void byNorm;
  rows.sort((a, b) => (b.meta.runRate || 0) - (a.meta.runRate || 0));
  return { rows, flags, histMonths };
}

// ── rent ─────────────────────────────────────────────────────────────────────
function rentRows(rent, overrides, months, base, bills) {
  const groups = new Map();
  for (const l of rent.lines) {
    const k = `${l.branch}|${l.vendor}|${l.office}`;
    if (!groups.has(k)) groups.set(k, { key: k, branch: l.branch, vendor: l.vendor, office: l.office, lines: [] });
    groups.get(k).lines.push(l);
  }
  const ovOf = g => overrides.find(o => o.key === g.key) || overrides.find(o => o.key === `${g.branch}|*`);
  const rows = [];
  const covered = new Set();
  for (const g of groups.values()) {
    const ls = g.lines.filter(l => l.modStart && l.modEnd).sort((a, b) => a.modStart.localeCompare(b.modStart));
    if (!ls.length) continue;
    const agrStart = ls.map(l => l.agrStart).filter(Boolean).sort()[0] || ls[0].modStart;
    const wbEnd = ls.map(l => l.agrEnd).filter(Boolean).sort().pop() || ls[ls.length - 1].modEnd;
    const ov = ovOf(g);
    const endDate = ov?.endDate || wbEnd;
    const last = ls[ls.length - 1];
    const values = {};
    for (const m of months) {
      if (m < agrStart.slice(0, 7)) { values[m] = 0; continue; }
      let amt = null;
      const cover = ls.filter(l => l.modStart.slice(0, 7) <= m && m <= l.modEnd.slice(0, 7)).pop();
      if (ov?.monthlyRent) amt = Number(ov.monthlyRent);
      else if (cover) amt = cover.amount;
      else if (m > last.modEnd.slice(0, 7)) {
        // after the last module: increment % at the increment date, then every 12 months. An increment on or before
        // the module's start is already in the module amount.
        const pct = last.incPct || 0;
        let incAt = (last.incOn || S.addMonths(last.modEnd.slice(0, 7), 1) + '-01').slice(0, 7);
        while (incAt <= last.modStart.slice(0, 7)) incAt = S.addMonths(incAt, 12);
        amt = last.amount;
        while (incAt <= m) { amt *= 1 + pct; incAt = S.addMonths(incAt, 12); }
      } else amt = 0;
      values[m] = amt * endFraction(m, endDate);
    }
    if (base) covered.add(`${S.normName(g.branch)}`);
    rows.push({ id: `rent:${g.key}`, section: 'rent', head: 'off_rent', label: `${g.vendor}${g.office ? ` — ${g.office}` : ''}`, branch: g.branch, values,
      meta: { endDate, workbookEnd: wbEnd, endOverride: ov?.endDate || null, agrStart, lastModule: { from: last.modStart, to: last.modEnd, amount: last.amount }, incPct: last.incPct, incOn: last.incOn, terms: last.terms, tdsPct: last.tdsPct, carpet: last.carpet, sba: last.sba, key: g.key, source: ov ? `override: ${ov.source || ''}` : 'Rent Recurring Module' } });
  }
  // rent billed in Zoho in the base month for a branch the workbook does not cover
  const extra = [];
  const wbBranches = new Set([...groups.values()].map(g => S.normName(g.branch)));
  const baseBills = bills.filter(b => b.month === base);
  const byBranch = {};
  for (const b of baseBills) (byBranch[b.branch] = byBranch[b.branch] || []).push(b);
  for (const [br, list] of Object.entries(byBranch)) {
    if (!br || wbBranches.has(S.normName(br))) continue;
    const amt = list.reduce((s, b) => s + b.sub, 0);
    const ov = overrides.find(o => o.key === `${br}|*`);
    const values = {};
    for (const m of months) values[m] = (ov?.monthlyRent ? Number(ov.monthlyRent) : amt) * endFraction(m, ov?.endDate || null);
    extra.push({ id: `rent:zoho|${br}`, section: 'rent', head: 'off_rent', label: `${br} — Zoho rent bills (not in the Rent module)`, branch: br, values,
      meta: { endDate: ov?.endDate || null, basis: `rent billed in ${base}`, flags: ['Not in the Rent Recurring Module — carried at the base-month amount; give an end date'], key: `${br}|*`, source: 'Zoho rent bills' } });
  }
  return { rows: [...rows.sort((a, b) => a.branch.localeCompare(b.branch) || a.label.localeCompare(b.label)), ...extra], file: rent.file };
}

// ── other expense heads ──────────────────────────────────────────────────────
function project(hist, method, k, cap) {
  const ys = hist.map(h => h.v);
  const n = ys.length;
  if (!n) return 0;
  if (method === 'zero') return 0;
  if (method === 'last') return ys[n - 1];
  if (method === 'avg3') return ys.slice(-3).reduce((s, x) => s + x, 0) / Math.min(3, n);
  if (method === 'avg12') return ys.reduce((s, x) => s + x, 0) / n;
  // linear trend over the available months; k = months after the last history month
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const b = sxx ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx : 0;
  let v = my + b * (n - 1 + k - mx);
  // the trend line is kept within ±cap of the history average, so a short or lumpy history cannot run away
  if (cap > 0 && my > 0) v = Math.min(my * (1 + cap), Math.max(my * (1 - cap), v));
  return Math.max(0, v);
}
function expenseRows(pl, st, months, debtInterest) {
  const base = st.baseMonth;
  const histMonths = S.monthsBetween(S.addMonths(base, -11), base);
  const rows = [];
  for (const h of pl.heads) {
    if (SKIP_HEADS.has(h.id) || RENT_HEADS.has(h.id)) continue;
    const series = pl.byHead[h.id] || {};
    const hist = histMonths.filter(m => series[m] != null).map(m => ({ m, v: series[m] }));
    const allHist = histMonths.map(m => series[m] || 0);
    let method = st.headMethods?.[h.id] || (h.id === 'interest_loan' && st.financeFromDebt && debtInterest ? 'debt' : st.defaultMethod || 'trend');
    if (method === 'debt' && !debtInterest) method = st.defaultMethod || 'trend';
    const values = {};
    let capped = false;
    const covered = histMonths.filter(m => series[m] != null).length;
    months.forEach(m => {
      if (method === 'debt') { values[m] = debtInterest[m] || 0; return; }
      const k = Math.max(1, (+m.slice(0, 4) - +base.slice(0, 4)) * 12 + (+m.slice(5, 7) - +base.slice(5, 7)));
      const full = histMonths.map(mm => ({ m: mm, v: series[mm] || 0 }));
      const cap = st.trendCap == null ? 0.5 : Number(st.trendCap);
      values[m] = project(full, method, k, cap);
      if (method === 'trend' && cap > 0 && Math.abs(values[m] - project(full, method, k, 0)) > 0.5) capped = true;
    });
    if (!allHist.some(Boolean) && method !== 'debt') continue;
    rows.push({ id: `exp:${h.id}`, section: h.income ? 'other_income' : 'expense', head: h.id, label: h.label, branch: '', values,
      meta: { method, hist: allHist, histMonths, monthsWithData: covered, line: lineOfHead(h.id), flags: [covered < 12 && method !== 'debt' ? `Only ${covered} of 12 history months in the Zoho cache` : null, capped ? `Trend limited to ±${Math.round((st.trendCap == null ? 0.5 : st.trendCap) * 100)}% of the 12-month average` : null].filter(Boolean) } });
  }
  return rows;
}

function manualRows(lines, months) {
  return lines.map(l => {
    const values = {};
    const amt = Number(l.monthly) || 0;
    const g = Number(l.growthPct) || 0;
    months.forEach(m => {
      if ((l.from && m < l.from) || (l.to && m > l.to)) { values[m] = 0; return; }
      const k = l.from ? (+m.slice(0, 4) - +l.from.slice(0, 4)) * 12 + (+m.slice(5, 7) - +l.from.slice(5, 7)) : 0;
      values[m] = amt * Math.pow(1 + g / 100, Math.floor(k / 12));
    });
    const section = l.section === 'revenue' ? 'revenue' : l.section === 'other_income' ? 'other_income' : 'expense';
    return { id: `man:${l.id}`, section, head: l.head || (section === 'revenue' ? 'revenue' : 'manual'), label: `${l.label}${l.branch ? ` (${l.branch})` : ''}`, branch: l.branch || '', values,
      meta: { manual: true, monthly: amt, from: l.from, to: l.to, growthPct: g, note: l.note, by: l.by, at: l.at, line: l.line || (section === 'revenue' ? 'pl.rev' : section === 'other_income' ? 'pl.oth_inc' : lineOfHead(l.head)) } };
  });
}

/** Build the whole budget for a version. Returns rupees. */
async function compute(version, docs) {
  const st = { ...DEFAULT_SETTINGS(), ...(version.settings || {}) };
  const months = S.monthsBetween(st.from, st.to);
  const [inv, rent, bills, pl] = await Promise.all([
    S.invoices(), S.rentWorkbook().catch(e => ({ file: null, lines: [], error: e.message })), S.rentBills().catch(() => []),
    S.plHeadMonthly(S.addMonths(st.baseMonth, -11), st.baseMonth).catch(e => ({ heads: [], byHead: {}, coverage: {}, error: e.message })),
  ]);
  const debtInterest = docs.debtInterest || null;
  const rev = revenueRows(inv, docs.contracts || [], st, months);
  const rentR = rentRows(rent, docs.rentOverrides || [], months, st.baseMonth, bills);
  const exp = expenseRows(pl, st, months, debtInterest);
  const man = manualRows((docs.manual || []).filter(l => !l.versionId || l.versionId === version.id), months);
  let rows = [...rev.rows, ...rentR.rows, ...exp, ...man];
  // cell overrides
  const ov = docs.overrides || {};
  for (const r of rows) for (const m of months) { const o = ov[`${r.id}|${m}`]; if (o) { r.overridden = r.overridden || {}; r.overridden[m] = { was: r.values[m], by: o.by, at: o.at, note: o.note }; r.values[m] = Number(o.v) || 0; } }
  rows.forEach(r => { r.total = months.reduce((s, m) => s + (r.values[m] || 0), 0); });
  rows = rows.filter(r => r.total || r.section !== 'revenue' || r.meta.manual);
  const sum = (sec, m) => rows.filter(r => r.section === sec).reduce((s, r) => s + (r.values[m] || 0), 0);
  const totals = {};
  for (const m of months) {
    const revenue = sum('revenue', m), other = sum('other_income', m), rentT = sum('rent', m), expense = sum('expense', m);
    const fin = rows.filter(r => r.section === 'expense' && (r.meta?.line === 'pl.exp_fin')).reduce((s, r) => s + (r.values[m] || 0), 0);
    const dep = rows.filter(r => r.section === 'expense' && (r.meta?.line === 'pl.exp_dep')).reduce((s, r) => s + (r.values[m] || 0), 0);
    totals[m] = { revenue, otherIncome: other, rent: rentT, expenses: expense, totalExpenses: rentT + expense, ebitda: revenue + other - rentT - expense + fin + dep, result: revenue + other - rentT - expense };
  }
  return {
    version: { id: version.id, name: version.name, frozen: !!version.frozen }, settings: st, months, rows, totals,
    sources: { invoices: { syncedAt: inv.syncedAt, gstFallback: inv.gstFallback, count: inv.invoices.length, selfExcluded: inv.selfExcluded, selfAmount: inv.selfAmount }, rentFile: rentR.file, rentError: rent.error || null, plCoverage: pl.coverage, plError: pl.error || null,
      categories: [...new Set(inv.invoices.map(i => i.category))].sort() },
    flags: { ...rev.flags, revHistMonths: rev.histMonths },
  };
}

/** Sum of budget months by statement line for a statement period (must be fully covered) */
function byStatementLine(grid, start, end) {
  const ms = grid.months.filter(m => m >= start.slice(0, 7) && m <= end.slice(0, 7));
  const want = S.monthsBetween(start.slice(0, 7), end.slice(0, 7));
  const covered = want.every(m => grid.months.includes(m));
  const out = {};
  for (const r of grid.rows) {
    const line = r.section === 'revenue' ? 'pl.rev' : r.section === 'other_income' ? 'pl.oth_inc' : r.section === 'rent' ? 'm.lease' : (r.meta?.line || 'pl.exp_oth');
    out[line] = (out[line] || 0) + ms.reduce((s, m) => s + (r.values[m] || 0), 0);
  }
  out['pl.tot_inc'] = (out['pl.rev'] || 0) + (out['pl.oth_inc'] || 0);
  out['m.ebitda'] = ms.reduce((s, m) => s + grid.totals[m].ebitda, 0);
  return { values: out, covered, months: ms, missingMonths: want.filter(m => !grid.months.includes(m)) };
}

module.exports = { compute, byStatementLine, DEFAULT_SETTINGS, METHODS, HEAD_TO_LINE, lineOfHead, project, escalate, nextEsc, endFraction };
