/**
 * Views over one reconciliation result: dashboard figures, the bridge, the client-wise follow-up report, the transaction-wise list,
 * the Zoho correction report and the carry-forward movement. Every figure is a sum over units, so any figure can be drilled down to the
 * entries behind it and the export shows the same numbers as the screen.
 */

'use strict';

const PER = require('./periods');
const { STATUS, METHOD, STATUS_ORDER } = require('./match');
const { fmtR, daysBetween } = require('./util');

const DONE = new Set(['matched', 'rounding']);
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
const zohoUrl = (org, kind, id) => (org && kind && id ? `https://books.zoho.in/app/${org}#/${kind}/${id}` : null);

const DEFINITIONS = {
  zoho: 'Zoho TDS receivable: debit − credit posted to the entity\'s TDS Receivable ledger(s) in the period (by posting date). Transfers between those ledgers net to zero.',
  deducted: '26AS tax deducted: PART-I "Tax Deducted" of the active statement(s), by transaction date.',
  deposited: '26AS tax deposited: PART-I "TDS Deposited" — the credit the statement reflects.',
  matched: 'Matched credit: 26AS tax deposited inside units whose (final) status is Matched or Matched Rounding Diff.',
  rounding: 'Rounding difference: Zoho − 26AS deposited of the Matched Rounding Diff. units (each within ₹2).',
  open_zoho: 'Open on the Zoho side: booked TDS not (fully) reflected — Not Matched balances, Not in 26AS, Need to Check.',
  open_26as: 'Open on the 26AS side: deposited credit with no (full) Zoho booking — Not Matched balances, Not in Zoho Books, Need to Check.',
  cf: 'Carry-forward balance: open items a reviewer carried to a later period (origin up to the end of the selected period).',
  follow_up: 'Amount requiring follow-up = credit missing from the uploaded 26AS + deducted amount not deposited + other short credit + confirmed non-deposit, all from OPEN entries of the client. An excess credit of the same client is shown separately and never reduces it.',
};

function maps(d) { return { zBy: new Map(d.items.map(i => [i.key, i])), cBy: new Map(d.credits.map(c => [c.key, c])) }; }

function zBrief(z, org) {
  const inv = z.invoices[0] || null;
  return { key: z.key, type: z.type, type_label: z.type_label, number: z.number, date: z.date, quarter: z.quarter, customer_id: z.customer_id, customer: z.customer_name, customer_basis: z.customer_basis,
    section: z.section, ledgers: z.ledgers, amount: z.amount, invoices: z.invoices.map(i => ({ id: i.id, no: i.no, date: i.date, basic: i.basic, gst: i.gst, gross: i.gross, total: i.total, tds_percent: i.tds_percent, tan: i.tan, url: zohoUrl(org, 'invoices', i.id) })),
    invoice_no: inv ? inv.no : '', invoice_date: inv ? inv.date : '', payment: z.payment ? { ...z.payment, url: zohoUrl(org, 'paymentsreceived', z.payment.id) } : null, journal: z.journal, base: z.base, tan_hints: z.tan_hints,
    flags: z.flags, url: zohoUrl(org, z.zoho.kind, z.zoho.id), refs: z.refs, refs_unresolved: z.refs_unresolved };
}
const cBrief = c => ({ key: c.key, deductor: c.deductor, tan: c.tan, section: c.section, section_raw: c.section_raw, txn_date: c.txn_date, quarter: c.txn_date ? PER.quarterOf(c.txn_date) : '', booking_date: c.booking_date,
  status: c.status, remarks: c.remarks, amount_paid: c.amount_paid, deducted: c.deducted, deposited: c.deposited, src: c.src, stmt: c.stmt, fy: c.fy });

function unitView(u, d, mp, org) {
  const zs = u.zoho.map(k => mp.zBy.get(k)).filter(Boolean), cs = u.credits.map(k => mp.cBy.get(k)).filter(Boolean);
  return { ...u, method_label: METHOD[u.method] || u.method, status_label: STATUS[u.status], final_label: u.final_status ? STATUS[u.final_status] : '', effective_label: STATUS[u.effective],
    zoho_lines: zs.map(z => zBrief(z, org)), credit_lines: cs.map(cBrief) };
}

/** The comparison table for one unit (Zoho | 26AS | calculated) */
function comparison(u, mp) {
  const zs = u.zoho.map(k => mp.zBy.get(k)).filter(Boolean), cs = u.credits.map(k => mp.cBy.get(k)).filter(Boolean);
  const all = (arr, f) => (arr.length && arr.every(x => f(x) !== null && f(x) !== undefined) ? sum(arr, f) : null);
  const basic = all(zs, z => z.base.basic), gst = all(zs, z => z.base.gst), gross = all(zs, z => z.base.gross), comparable = all(zs, z => z.base.comparable);
  const paid = cs.length ? sum(cs, c => c.amount_paid) : null;
  const zq = [...new Set(zs.map(z => z.quarter))], cq = [...new Set(cs.map(c => (c.txn_date ? PER.quarterOf(c.txn_date) : '')).filter(Boolean))];
  const rate = (t, b) => (b ? Math.round((t / b) * 10000) / 100 : null);
  const zDates = zs.map(z => z.date).sort(), cDates = cs.map(c => c.txn_date).filter(Boolean).sort();
  return {
    zoho: { basic, gst, gross, comparable, base_notes: [...new Set(zs.map(z => z.base.note).filter(Boolean))], tds: zs.length ? u.z_amount : null,
      invoice_dates: [...new Set(zs.flatMap(z => z.invoices.map(i => i.date)).filter(Boolean))], payment_dates: [...new Set(zs.map(z => z.payment && z.payment.date).filter(Boolean))], posting_dates: [...new Set(zDates)],
      documents: zs.map(z => `${z.type_label} ${z.number || ''}`.trim()), sections: [...new Set(zs.map(z => z.section).filter(Boolean))] },
    f26: { paid, deducted: cs.length ? u.deducted : null, deposited: cs.length ? u.deposited : null, txn_dates: [...new Set(cDates)], booking_dates: [...new Set(cs.map(c => c.booking_date).filter(Boolean))],
      sections: [...new Set(cs.map(c => c.section_raw).filter(Boolean))], booking_status: [...new Set(cs.map(c => c.status).filter(Boolean))] },
    calc: { base_diff: paid !== null && comparable !== null ? paid - comparable : null, base_diff_gross: paid !== null && gross !== null ? paid - gross : null, tds_diff: zs.length && cs.length ? u.z_amount - u.deposited : null,
      deducted_vs_deposited: cs.length ? u.deducted - u.deposited : null, rate_zoho: comparable ? rate(u.z_amount, comparable) : null, rate_26as: paid ? rate(u.deducted, paid) : null,
      period_zoho: zq.map(PER.qLabel).join(', '), period_26as: cq.map(PER.qLabel).join(', '), period_differs: zq.length && cq.length ? zq.join() !== cq.join() : false,
      days_between: zDates.length && cDates.length ? daysBetween(zDates[0], cDates[0]) : null },
    checks: [
      u.reason && u.reason.code === 'ambiguous' ? 'The candidate entries are summed here, but only one of them can belong to the credit — choose it below, or leave the item for review' : null,
      zs.some(z => z.type === 'customer_payment' && z.base.fraction !== undefined && z.base.fraction < 0.999) ? 'Partial payment: the base is the share of the invoice the payment settles' : null,
      zs.some(z => z.base.basis === 'invoice_only') ? 'The payment\'s allocation to the invoice is not available — base shown for the whole invoice; review before relying on the base difference' : null,
      zs.some(z => z.amount < 0) ? 'Includes a TDS reversal (credit note or journal)' : null,
      zs.length > 1 ? `${zs.length} Zoho entries are covered together` : null, cs.length > 1 ? `${cs.length} 26AS credits are covered together` : null,
      zs.some(z => z.flags.includes('tds_booked_twice')) ? 'TDS on this invoice is booked both on the invoice and on a payment' : null,
    ].filter(Boolean),
  };
}

function filterUnits(units, f, d) {
  const q = String(f.search || '').trim().toLowerCase();             // (not "q": that is the quarter in every request)
  const mp = maps(d);
  return units.filter(u => {
    if (f.status && !String(f.status).split(',').includes(u.effective)) return false;
    if (f.system_status && !String(f.system_status).split(',').includes(u.status)) return false;
    if (f.method && !String(f.method).split(',').includes(u.method)) return false;
    if (f.group && u.group !== f.group && !(f.group === '__none__' && !u.group)) return false;
    if (f.tan && !u.tans.includes(String(f.tan).toUpperCase()) && !u.zoho.some(k => (mp.zBy.get(k) || { tan_hints: [] }).tan_hints.includes(String(f.tan).toUpperCase()))) return false;
    if (f.section && !u.sections.includes(String(f.section).toUpperCase())) return false;
    if (f.reason && !(u.reason && u.reason.code === f.reason)) return false;
    if (f.open === '1' && !(u.open_zoho || u.open_26as) ) return false;
    if (f.side === 'zoho' && !u.zoho.length) return false;
    if (f.side === '26as' && !u.credits.length) return false;
    if (f.ids && !String(f.ids).split(',').includes(u.id)) return false;
    if (q) {
      const hay = [u.client, ...u.tans, ...u.zoho.map(k => { const z = mp.zBy.get(k); return z ? `${z.number} ${z.customer_name} ${z.invoices.map(i => i.no).join(' ')}` : ''; }), ...u.credits.map(k => { const c = mp.cBy.get(k); return c ? `${c.deductor} ${c.tan}` : ''; })].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function sortUnits(units) {
  const o = s => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? 99 : i; };
  return units.sort((a, b) => o(a.effective) - o(b.effective) || String(a.client).localeCompare(String(b.client)) || String(a.date).localeCompare(String(b.date)));
}

function dashboard(d, res, period) {
  const mp = maps(d);
  const U = res.units;
  const Z = res.zoho_in_period.map(k => mp.zBy.get(k)), C = res.credits_in_period.map(k => mp.cBy.get(k));
  const eff = s => U.filter(u => u.effective === s);
  const totals = {
    zoho: sum(Z, z => z.amount), zoho_entries: Z.length, deducted: sum(C, c => c.deducted), deposited: sum(C, c => c.deposited), credits: C.length, amount_paid: sum(C, c => c.amount_paid),
    matched: sum(U.filter(u => DONE.has(u.effective)), u => u.deposited), matched_units: U.filter(u => DONE.has(u.effective)).length,
    rounding: sum(eff('rounding'), u => u.diff), rounding_units: eff('rounding').length,
    open_zoho: sum(U.filter(u => !DONE.has(u.effective) && u.effective !== 'carry_forward'), u => u.open_zoho),
    open_26as: sum(U.filter(u => !DONE.has(u.effective) && u.effective !== 'carry_forward'), u => u.open_26as),
    cf_open: sum(d.cf.items.filter(x => x.status === 'open' && PER.cmpQ(x.origin_quarter, PER.quarterOf(period.to)) <= 0), x => x.balance),
    cf_open_items: d.cf.items.filter(x => x.status === 'open' && PER.cmpQ(x.origin_quarter, PER.quarterOf(period.to)) <= 0).length,
    unallocated: sum(U.filter(u => u.reason && u.reason.code === 'unallocated'), u => u.z_amount),
  };
  // ledger control: the same period summed straight from the stored postings of the mapped ledgers (must equal the Zoho total)
  const inP = x => x >= period.from && x <= period.to;
  const lr = d.books.rows.filter(r => inP(r.date));
  totals.ledger_control = sum(lr, r => r.dr - r.cr);
  totals.ledger_postings = lr.length;
  totals.transfers = d.books.transfers.filter(t => inP(t.date)).length;
  const byStatus = Object.keys(STATUS).map(s => ({ status: s, label: STATUS[s], units: eff(s).length, zoho: sum(eff(s), u => u.z_amount), deposited: sum(eff(s), u => u.deposited), diff: sum(eff(s), u => u.diff) }));
  const byMethod = Object.keys(METHOD).map(m => ({ method: m, label: METHOD[m], units: U.filter(u => u.method === m).length })).filter(x => x.units);
  return { totals, by_status: byStatus, by_method: byMethod, bridge: bridge(d, res, totals), definitions: DEFINITIONS, transfers: d.books.transfers.filter(t => t.date >= period.from && t.date <= period.to) };
}

/** Zoho TDS receivable → 26AS tax deposited, one line per status; the last line must be zero */
function bridge(d, res, totals) {
  const U = res.units;
  const line = (id, label, list, effect) => ({ id, label, units: list.length, zoho: sum(list, u => u.z_amount), deposited: sum(list, u => u.deposited), effect: effect === undefined ? sum(list, u => u.z_amount - u.deposited) : effect, filter: { ids: list.map(u => u.id).join(',') } });
  const cfS = U.filter(u => u.method === 'cf_settlement');
  const rest = U.filter(u => u.method !== 'cf_settlement');
  const by = s => rest.filter(u => u.effective === s);
  const lines = [
    line('matched', 'Matched (exact)', by('matched')),
    line('rounding', 'Matched Rounding Diff. — rounding retained', by('rounding')),
    line('not_matched', 'Not Matched — signed difference', by('not_matched')),
    line('not_in_26as', 'Not in 26AS — booked in Zoho only', by('not_in_26as')),
    line('not_in_zoho', 'Not in Zoho Books — credited in 26AS only', by('not_in_zoho')),
    line('need_check', 'Need to Check (timing, ambiguous, unmapped, unallocated, coverage gaps)', by('need_check')),
    line('carry_forward', 'Carry Forward (approved by a reviewer)', by('carry_forward')),
    line('cf_settlement', '26AS credits settling balances carried forward from earlier periods', cfS),
  ];
  const effect = sum(lines, l => l.effect);
  return { start: { label: 'Zoho TDS receivable (ledger postings in the period)', amount: totals.zoho }, lines, end: { label: '26AS tax deposited (credits dated in the period)', amount: totals.deposited },
    difference: totals.zoho - effect - totals.deposited, deducted_gap: totals.deducted - totals.deposited };
}

/** Client-wise TDS deposit and follow-up — one row per client group, plus rows for what is not mapped, so the totals tie to both sources */
function followUp(d, res, period, people = []) {
  const mp = maps(d);
  const rows = new Map();
  const rowFor = (id, label, kind, tans) => rows.get(id) || rows.set(id, { id, client: label, kind, tans: new Set(tans || []), zoho: 0, deducted: 0, deposited: 0, missing: 0, ded_gt_dep: 0, short_credit: 0, non_deposit: 0, subsequent: 0, review_first: 0, excess_credit: 0, follow_up: 0, oldest_open: '', units: [], open_units: [] }).get(id);
  for (const u of res.units) {
    let r;
    if (u.group) { const g = d.clients.groups.get(u.group); r = rowFor(u.group, g ? g.name : u.client, 'client', g ? g.tans.map(t => t.tan) : u.tans); }
    else if (u.reason && u.reason.code === 'unallocated') r = rowFor('__unallocated', 'Unallocated Zoho postings (no customer)', 'unallocated');
    else if (u.zoho.length && !u.credits.length) { const z = mp.zBy.get(u.zoho[0]); r = rowFor(`cust:${z.customer_id}`, `${z.customer_name || z.customer_id} — customer not mapped`, 'unmapped_customer', z.tan_hints); }
    else if (u.credits.length) { const c = mp.cBy.get(u.credits[0]); r = rowFor(`tan:${c.tan}`, `${c.deductor} (${c.tan}) — deductor ${d.clients.noCustomer.has(c.tan) ? 'with no Zoho customer' : 'not mapped'}`, 'unmapped_tan', [c.tan]); }
    else continue;
    r.zoho += u.method === 'cf_settlement' ? 0 : u.z_amount;
    r.deducted += u.deducted; r.deposited += u.deposited;
    r.units.push(u.id);
    const e = u.effective;
    if (DONE.has(e) || e === 'carry_forward') continue;
    const open = u.open_zoho;
    let fu = 0;
    if (u.decision && u.decision.non_deposit) { r.non_deposit += open; fu = open; }
    else if (e === 'not_in_26as') { r.missing += open; fu = open; }
    else if (e === 'not_matched' && u.reason && u.reason.code === 'deducted_exceeds_deposited') { const gap = Math.min(open, Math.max(0, u.deducted - u.deposited)); r.ded_gt_dep += gap; r.short_credit += Math.max(0, open - gap); fu = open; }
    else if (e === 'not_matched') { r.short_credit += Math.max(0, u.diff); fu = Math.max(0, u.diff); }
    else if (e === 'need_check' && u.reason && u.reason.code === 'timing' && u.evidence.some(x => x.kind === 'later_credit')) r.subsequent += open;
    else if (e === 'need_check') r.review_first += open;
    r.excess_credit += u.open_26as > 0 && (e === 'not_in_zoho' || e === 'not_matched' || e === 'need_check') ? u.open_26as : 0;
    r.follow_up += fu;
    // an item open on either side counts as open (a 26AS credit with nothing booked is open too, though it adds nothing to the follow-up amount)
    if (fu > 0 || open > 0 || u.open_26as > 0) { r.open_units.push(u.id); if (!r.oldest_open || u.date < r.oldest_open) r.oldest_open = u.date; }
  }
  const out = [...rows.values()].map(r => {
    const meta = (d.review.clients || {})[r.id] || {};
    const owner = meta.owner_id ? (people.find(p => p.id === String(meta.owner_id)) || {}).name || meta.owner : meta.owner || '';
    return { ...r, tans: [...r.tans], owner, owner_id: meta.owner_id || '', remarks: meta.remarks || '', remarks_at: meta.at || '', remarks_by: meta.by || '', period: period.label || `${period.from} to ${period.to}`,
      age_days: r.oldest_open ? daysBetween(r.oldest_open, new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)) : null };
  }).sort((a, b) => b.follow_up - a.follow_up || b.zoho - a.zoho || a.client.localeCompare(b.client));
  const tot = f => sum(out, r => r[f]);
  return { rows: out, totals: { zoho: tot('zoho'), deducted: tot('deducted'), deposited: tot('deposited'), missing: tot('missing'), ded_gt_dep: tot('ded_gt_dep'), short_credit: tot('short_credit'), non_deposit: tot('non_deposit'),
    subsequent: tot('subsequent'), review_first: tot('review_first'), excess_credit: tot('excess_credit'), follow_up: tot('follow_up') }, definitions: DEFINITIONS };
}

/** Potential corrections in Zoho Books — never made by this module (read-only), listed with links to the Zoho records */
function corrections(d, res, org) {
  const mp = maps(d);
  const out = [];
  const add = (kind, label, u, z, c, detail, amount) => out.push({ kind, label, unit: u ? u.id : null, client: u ? u.client : (z ? z.customer_name : c ? c.deductor : ''), zoho: z ? zBrief(z, org) : null, credit: c ? cBrief(c) : null, detail, amount, status: u ? u.effective : '' });
  const invByCust = new Map();
  for (const i of Object.values(d.docs.invoices || {})) (invByCust.get(i.cust) || invByCust.set(i.cust, []).get(i.cust)).push(i);
  const tdsInv = new Set(d.items.flatMap(z => z.invoices.map(i => i.id)));
  for (const u of res.units) {
    const zs = u.zoho.map(k => mp.zBy.get(k)).filter(Boolean), cs = u.credits.map(k => mp.cBy.get(k)).filter(Boolean);
    if (u.effective === 'not_in_zoho' || (u.effective === 'need_check' && u.reason && u.reason.code === 'deductor_unmapped')) {
      for (const c of cs) {
        const g = u.group ? d.clients.groups.get(u.group) : null;
        const cands = g ? g.customers.flatMap(cu => invByCust.get(cu.id) || []).filter(i => !tdsInv.has(i.id) && i.date && Math.abs(daysBetween(i.date, c.txn_date)) <= 90 && c.amount_paid && [i.sub_total, i.sub_total + (i.tax_total || 0)].some(b => b && Math.abs(b - c.amount_paid) <= Math.max(200, b * 0.005))) : [];
        add('credit_missing', '26AS credit missing from Zoho', u, null, c, `${fmtR(c.deposited)} deposited by ${c.deductor} (${c.tan}) on ${c.txn_date}, section ${c.section_raw || '—'}${cands.length ? ` — invoice ${cands.map(i => i.no).join(', ')} has this base and no TDS booked` : u.group ? '' : ' — deductor not mapped to a customer yet'}`, c.deposited);
        if (cands.length) out[out.length - 1].candidate_invoices = cands.map(i => ({ no: i.no, date: i.date, basic: i.sub_total, url: zohoUrl(org, 'invoices', i.id) }));
      }
    }
    if (u.effective === 'not_matched' && u.reason && ['short_booking', 'amount_differs', 'base_gross'].includes(u.reason.code)) add('tds_amount', 'Potential error in the TDS amount booked', u, zs[0], cs[0], u.reason.text, u.diff);
    if (u.flags.includes('section_mismatch')) add('ledger_allocation', 'Section differs (Zoho ledger vs 26AS)', u, zs[0], cs[0], `Zoho ledger section ${[...new Set(zs.map(z => z.section))].join('/')} vs 26AS section ${[...new Set(cs.map(c => c.section_raw))].join('/')}`, u.z_amount);
    for (const z of zs) {
      const credTans = new Set(cs.map(c => c.tan));
      if (cs.length && z.tan_hints.length && !z.tan_hints.some(t => credTans.has(t))) add('customer_mapping', 'TAN on the Zoho invoice differs from the deductor', u, z, cs[0], `Zoho invoice TAN ${z.tan_hints.join(', ')}; credit from ${[...credTans].join(', ')}`, z.amount);
      if (!u.group && z.customer_id && z.tan_hints.some(t => d.clients.byTan.has(t))) add('customer_mapping', 'Customer may be booked under the wrong Zoho customer', u, z, null, `Zoho records TAN ${z.tan_hints.join(', ')} on the invoice, which belongs to client "${(d.clients.groups.get(d.clients.byTan.get(z.tan_hints.find(t => d.clients.byTan.has(t)))) || {}).name}"`, z.amount);
      if (z.flags.includes('tds_booked_twice')) add('tds_amount', 'TDS booked twice (invoice and payment)', u, z, null, `TDS on invoice ${z.invoices.map(i => i.no).join(', ')} is booked on the invoice and again on a payment`, z.amount);
      if (z.flags.includes('ledger_fy_mismatch')) add('ledger_allocation', 'Posted to another financial year\'s TDS ledger', u, z, null, `${z.ledgers.join(', ')} used for an entry dated ${z.date} (FY ${z.fy})`, z.amount);
      if (z.flags.includes('section_differs_invoice')) add('ledger_allocation', 'Ledger section differs from the invoice\'s TDS section', u, z, null, `Ledger section ${z.section}; invoice TDS ${z.invoices.flatMap(i => i.tds_names || []).join(', ')}`, z.amount);
      if (u.reason && u.reason.code === 'unallocated') add('unallocated', 'Journal without a customer (unallocated)', u, z, null, u.reason.text, z.amount);
    }
  }
  const KIND = { credit_missing: '26AS credits missing from Zoho', tds_amount: 'TDS amount booked', customer_mapping: 'Customer mapping', ledger_allocation: 'Ledger allocation', unallocated: 'Unallocated journals' };
  return { rows: out, kinds: KIND, counts: Object.fromEntries(Object.keys(KIND).map(k => [k, out.filter(r => r.kind === k).length])) };
}

/** Carry-forward movement per quarter (or financial year) over [from, to] */
function carryForward(d, from, to, by = 'quarter') {
  const items = d.cf.items.filter(x => x.status !== 'cancelled');
  const qs = PER.quartersBetween(from, to);
  const buckets = by === 'fy' ? [...new Set(qs.map(q => PER.parseQ(q).fy))].map(fy => ({ id: fy, label: `FY ${fy}`, first: `${fy}-Q1`, last: `${fy}-Q4` })) : qs.map(q => ({ id: q, label: PER.qLabel(q), first: q, last: q }));
  const endQ = it => (it.status === 'settled' ? it.settlement.quarter : it.status === 'closed' ? it.closure.quarter : null);
  const rows = buckets.map(b => {
    const before = q => PER.cmpQ(q, b.first) < 0, inside = q => q && PER.cmpQ(q, b.first) >= 0 && PER.cmpQ(q, b.last) <= 0;
    const opening = items.filter(it => before(it.origin_quarter) && (!endQ(it) || !before(endQ(it))));
    const additions = items.filter(it => inside(it.origin_quarter));
    const settled = items.filter(it => it.status === 'settled' && inside(it.settlement.quarter));
    const closed = items.filter(it => it.status === 'closed' && inside(it.closure.quarter));
    const o = sum(opening, x => x.balance), a = sum(additions, x => x.balance), s = sum(settled, x => x.balance), c = sum(closed, x => x.balance);
    const closingItems = items.filter(it => PER.cmpQ(it.origin_quarter, b.last) <= 0 && (!endQ(it) || PER.cmpQ(endQ(it), b.last) > 0));
    return { id: b.id, label: b.label, opening: o, additions: a, settled: s, closed: c, closing: o + a - s - c, closing_check: sum(closingItems, x => x.balance),
      items: { opening: opening.map(x => x.id), additions: additions.map(x => x.id), settled: settled.map(x => x.id), closed: closed.map(x => x.id), closing: closingItems.map(x => x.id) } };
  });
  return { by, rows, items: items.map(x => ({ ...x, origin_label: PER.qLabel(x.origin_quarter), target_label: PER.qLabel(x.target_quarter), settled_label: x.settlement ? PER.qLabel(x.settlement.quarter) : '', closed_label: x.closure ? PER.qLabel(x.closure.quarter) : '' })) };
}

module.exports = { dashboard, bridge, followUp, corrections, carryForward, unitView, comparison, filterUnits, sortUnits, maps, zBrief, cBrief, DEFINITIONS, zohoUrl };
