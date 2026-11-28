/**
 * Management Cash Flow — the calculations (pure: no Zoho, no storage; see tests/engine.test.js).
 *
 * A "part" is one category's share of one Zoho bill (a landlord bill with rent and an electricity recharge has two parts).
 * A "budget" is a finalised budget line or a commitment (vendor / landlord / client known) for a planned payment month.
 *
 * Rules (the user's brief, 28 Nov 2026):
 *   Outstanding before advance  = net payable − direct payments − credits applied          (each deduction once)
 *   Final bill outstanding      = outstanding before advance − advances applied to this bill
 *     a payment is an ADVANCE for a bill when it was paid before the bill's date; its cash counts on the day it was paid,
 *     applying it later only lowers the bill's balance (Zoho's apply_date) and is never a second outflow
 *   Initiated and pending       = initiation instructions not yet settled by a Zoho payment made on or after them
 *                                 (failed / cancelled ones never count), at most the final outstanding
 *   Still to initiate           = min(scheduled amount not yet paid, final outstanding) − initiated and pending
 *   Remaining monthly budget    = finalised budget − cash payments allocated to it (negative when exceeded, flagged)
 *   Awaiting bill               = the whole budget while no bill is linked; after that only if more bills are expected —
 *                                 otherwise the difference stays visible as "budget not billed (review)"
 *   Cash outflow of a month     = payments by their payment date (advances when paid)
 *   Month-end view              = everything as it stood on the month's last day; current view = as it stands today
 *                                 (a November bill paid on 3 December is outstanding at 30 November, "paid later" today,
 *                                 and its cash is December's)
 */

'use strict';

const M = require('./months');
const C = require('./classify');

const r2 = C.r2;
const EPS = 0.5;                                  // ₹ — amounts below this are treated as nil
const ROUNDING = 10;                              // ₹ — a bill with at most this left (Zoho rounding) counts as paid: not carried, nothing to initiate
const DEAD = new Set(['failed', 'cancelled']);
const sum = (a, f) => a.reduce((s, x) => s + (f ? f(x) : x), 0);
const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ── Model: parts, budgets, advances (independent of the month looked at) ─────────

/**
 * companyData: { company: {id,name,org_id}, bills: [compact], accCat: Map, plan, portal: Map(bill id → [requests]),
 *                payments: [synced vendor payment rows], customers: [customer index], categories }
 */
function buildModel(companyData) {
  const { company, bills = [], accCat, plan = {}, portal = new Map(), payments = [], customers = [], categories = {} } = companyData;
  const parts = [];
  const vendorShare = new Map();                  // vendor id → { category → net } (to place an unapplied advance)
  const appliedByPid = new Map();                 // payment id → [{ apply, amt }] across every bill read (any category)
  for (const b of bills) {
    for (const p of b.pays || []) {
      if (!appliedByPid.has(p.pid)) appliedByPid.set(p.pid, []);
      // a payment made before the bill reaches it on its apply date; one made on or after the bill's date settles it that day
      appliedByPid.get(p.pid).push({ apply: p.date && b.date && p.date < b.date ? (p.apply || p.date) : p.date, amt: p.amt });
    }
    for (const part of C.partsOf(b, accCat)) {
      if (!categories[part.category]) continue;
      const key = `${b.id}:${part.category}`;
      const meta = plan.parts?.[key] || {};
      const text = part.lines.map(l => l.d).join('\n');
      const natural = b.due && b.due >= b.date ? M.monthOf(b.due) : M.monthOf(b.date);
      const cl = part.category === 'brokerage' ? C.clientOf(text, customers) : { client: '', source: '', options: [] };
      const conn = part.category === 'electricity' ? C.connectionOf(b.vn, text) : { meter: '', connection: '' };
      const w = part.w;
      // a period in the wording far from the bill's own month is old template text ("Period: Aug-22" on a 2026 bill)
      const billMonth = M.monthOf(b.date);
      let period = C.periodOf(text);
      if (period && billMonth && Math.abs(M.monthDiff(billMonth, period.from.slice(0, 7))) > 3 && Math.abs(M.monthDiff(billMonth, period.to.slice(0, 7))) > 3) {
        period = { from: '', to: '', label: M.label(billMonth), source: `bill month — the bill text says ${period.label}` };
      }
      if (!period) period = { from: '', to: '', label: billMonth ? M.label(billMonth) : '—', source: 'bill month' };
      parts.push({
        key, company: company.id, company_name: company.name, category: part.category,
        bill_id: b.id, bill_no: b.no, bill_date: b.date, due: b.due, status: b.status, vendor_id: b.vid, vendor: b.vn, branch: b.br, ref: b.ref,
        url: `https://books.zoho.in/app/${company.org_id}#/bills/${b.id}`,
        basic: part.basic, gst: part.gst, gross: part.gross, tds: part.tds, net: part.net, w: r2(w * 10000) / 10000,
        zoho_balance: r2(b.bal * w), lines: part.lines.map(l => ({ desc: l.d, account: l.an, amount: l.amt, tax: r2(l.tax), tax_name: l.tn })),
        // eff: the day the payment reduced this bill — its own date, or (an advance) the day it was applied
        pays: (b.pays || []).map(p => {
          const advance = !!(p.date && b.date && p.date < b.date);
          return { pid: p.pid, no: p.no, date: p.date, apply: p.apply || p.date, eff: advance ? (p.apply || p.date) : p.date, amt: r2(p.amt * w), ref: p.ref, mode: p.mode, acct: p.acct,
            advance, slips: plan.slips?.[p.pid] || [] };
        }),
        creds: (b.creds || []).map(c => ({ no: c.no, date: c.date || b.date, amt: r2(c.amt * w) })),
        natural_month: natural,
        planned_override: meta.planned_month || '',
        manual_budget: Object.prototype.hasOwnProperty.call(meta, 'budget_id') ? meta.budget_id : undefined,
        client: meta.client || cl.client, client_source: meta.client ? 'team' : cl.source, client_options: cl.options,
        period,
        meter: meta.meter || conn.meter, connection: conn.connection,
        schedule: Array.isArray(meta.schedule) && meta.schedule.length ? meta.schedule : null,
        initiations: [
          ...(meta.initiations || []).map(i => ({ ...i, source: 'team' })),
          ...(portal.get(b.id) || []).map(rq => ({ ...rq, source: 'portal', amount: r2((Number(rq.amount) || 0) * (w < 1 ? w : 1)) })),
        ],
        remarks: meta.remarks || '',
      });
      const vs = vendorShare.get(b.vid) || {};
      vs[part.category] = (vs[part.category] || 0) + part.net;
      vendorShare.set(b.vid, vs);
    }
  }

  const budgets = (plan.budgets || []).filter(x => !x.deleted).map(x => ({
    ...x, company: company.id, company_name: company.name,
    amount: r2(x.amount), original_amount: r2(x.original_amount ?? x.amount),
    schedule: Array.isArray(x.schedule) && x.schedule.length ? x.schedule : null,
  }));

  // Payments to the categories' vendors with money not applied to any bill read here (advances), and the category they go to
  const vendorMasterCat = companyData.vendorMasterCategory || (() => null);
  const advances = [];
  for (const p of payments) {
    if (!p || p.status === 'void' || p.status === 'draft') continue;
    const vs = vendorShare.get(String(p.vendor_id));
    let category = vs ? Object.entries(vs).sort((a, b) => b[1] - a[1])[0][0] : vendorMasterCat(String(p.vendor_id));
    if (!category || !categories[category]) continue;
    const amount = r2(Number(p.bcy_amount ?? p.amount) || 0);
    const balanceNow = r2(Number(p.bcy_balance ?? p.balance) || 0);
    const known = appliedByPid.get(String(p.payment_id)) || [];
    const link = plan.advances?.[String(p.payment_id)] || {};
    if (balanceNow <= EPS && !known.some(k => k.apply > p.date)) continue;     // never an advance worth showing
    advances.push({
      pid: String(p.payment_id), company: company.id, company_name: company.name, category: link.category && categories[link.category] ? link.category : category,
      vendor_id: String(p.vendor_id), vendor: p.vendor_name || '', date: p.date, no: p.payment_number || '', ref: p.reference_number || '',
      amount, balance_now: balanceNow, applications: known, budget_id: link.budget_id || '', branch: p.branch_name || '',
      slips: plan.slips?.[String(p.payment_id)] || [],
    });
  }

  linkParts(parts, budgets);
  return { company, parts, budgets, advances };
}

/**
 * Bills to budget lines. A link the team chose stays (also "no budget"). Otherwise the best fitting budget line of the
 * same company and category: same vendor (+4), same client (+3), same branch (+2), same planned month (+2) or one month
 * away (+1). Rent and electricity bill every month, so their bills link only to a budget of the bill's own month (due
 * date month); a brokerage commitment naming the broker or the client reaches two months either way, because a broker's
 * bill often comes late. A commitment for one bill (a vendor or client, not expecting more bills) takes one bill. The
 * best fits are placed first, so a monthly budget takes its own month's bill, not an earlier one.
 */
function linkParts(parts, budgets) {
  const byId = new Map(budgets.map(b => [b.id, b]));
  const taken = new Map();
  for (const p of parts) {
    if (p.manual_budget !== undefined) {
      const b = p.manual_budget ? byId.get(p.manual_budget) : null;
      p.budget_id = b && b.category === p.category ? b.id : '';
      p.link = p.budget_id ? 'team' : (p.manual_budget === '' ? 'none' : 'missing');
      if (p.budget_id) taken.set(b.id, (taken.get(b.id) || 0) + 1);
    }
  }
  const pairs = [];
  for (const p of parts) {
    if (p.manual_budget !== undefined) continue;
    p.budget_id = ''; p.link = 'none';
    for (const b of budgets) {
      if (b.category !== p.category) continue;
      if (b.vendor_id && b.vendor_id !== p.vendor_id) continue;
      if (b.branch && normName(b.branch) !== normName(p.branch)) continue;
      const sameClient = !!(b.client && p.client && C.norm(b.client) === C.norm(p.client));
      if (p.category === 'brokerage' && b.client && p.client && !sameClient) continue;
      const gap = Math.abs(M.monthDiff(b.planned_month, p.planned_override || p.natural_month));
      const reach = p.category === 'brokerage' && (b.vendor_id || sameClient) ? 2 : 0;
      if (gap > reach) continue;
      const score = (b.vendor_id ? 4 : 0) + (sameClient ? 3 : 0) + (b.branch ? 2 : 0) + (gap === 0 ? 2 : gap === 1 ? 1 : 0);
      pairs.push({ p, b, score, gap });
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.gap - y.gap || String(x.p.bill_date).localeCompare(String(y.p.bill_date))
    || String(x.b.created_at || '').localeCompare(String(y.b.created_at || '')) || x.p.key.localeCompare(y.p.key));
  for (const { p, b } of pairs) {
    if (p.budget_id) continue;
    if ((b.vendor_id || b.client) && !b.expects_more_bills && (taken.get(b.id) || 0) >= 1) continue;
    p.budget_id = b.id; p.link = 'auto';
    taken.set(b.id, (taken.get(b.id) || 0) + 1);
  }
  for (const p of parts) {
    const b = p.budget_id ? byId.get(p.budget_id) : null;
    p.planned_month = p.planned_override || (b ? b.planned_month : p.natural_month);
    p.planned_source = p.planned_override ? 'team' : b ? 'budget' : (p.due && p.due >= p.bill_date ? 'due date' : 'bill date');
  }
}

// ── One part / one budget as it stood on a day ───────────────────────────────

/** Initiations settled first-in-first-out by payments made on or after them → { pending, settled, list } */
function settleInitiations(inits, pays, asOf) {
  const live = inits.filter(i => i.date && i.date <= asOf && !DEAD.has(i.status)).sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  const pool = pays.filter(p => p.date && p.date <= asOf).map(p => ({ date: p.date, left: p.amt })).sort((a, b) => a.date.localeCompare(b.date));
  const list = [];
  for (const i of live) {
    let need = r2(i.amount);
    let settled = 0;
    if (i.status === 'settled') { settled = need; need = 0; }
    for (const p of pool) {
      if (need <= 0) break;
      if (p.date < i.date || p.left <= 0) continue;
      const take = Math.min(p.left, need);
      p.left = r2(p.left - take); need = r2(need - take); settled = r2(settled + take);
    }
    list.push({ ...i, settled: r2(settled), pending: r2(need) });
  }
  return { pending: r2(sum(list, x => x.pending)), settled: r2(sum(list, x => x.settled)), list };
}

function partAt(p, asOf, refDay) {
  const received = !!p.bill_date && p.bill_date <= asOf;
  const pays = p.pays.filter(x => x.date && x.eff <= asOf);
  const direct = r2(sum(pays.filter(x => !x.advance), x => x.amt));
  const adv = r2(sum(pays.filter(x => x.advance), x => x.amt));
  const credits = r2(sum(p.creds.filter(c => c.date <= asOf), c => c.amt));
  const outBefore = r2(p.net - direct - credits);
  const finalOut = r2(outBefore - adv);
  const paid = r2(direct + adv);
  const ini = settleInitiations(p.initiations, pays, asOf);
  const pending = r2(Math.max(0, Math.min(ini.pending, Math.max(0, finalOut))));
  const sched = (p.schedule || [{ id: 'default', pay_on: p.due && p.due >= p.bill_date ? p.due : p.bill_date, amount: p.net, default: true }])
    .map(s => ({ ...s, amount: r2(s.amount) })).sort((a, b) => String(a.pay_on).localeCompare(String(b.pay_on)));
  const scheduled = r2(sum(sched, s => s.amount));
  const covered = r2(paid + credits);
  const schedUnpaid = r2(Math.max(0, scheduled - covered));
  const toInitiate = finalOut <= ROUNDING ? 0 : r2(Math.max(0, Math.min(schedUnpaid, Math.max(0, finalOut)) - pending));
  // the first instalment not covered by what is paid or initiated; overdue when its Pay On date has passed
  let cum = 0, next = null, overdue = null;
  for (const s of sched) {
    cum = r2(cum + s.amount);
    if (finalOut > ROUNDING && cum > covered + pending + EPS) {
      if (!next) next = s;
      if (s.pay_on && s.pay_on < refDay && !overdue) overdue = { ...s, days: M.daysBetween(s.pay_on, refDay), short: r2(Math.min(s.amount, cum - covered - pending)) };
    }
  }
  const hasInitData = p.initiations.length > 0;
  let state;
  if (!received) state = 'not_received';
  else if (finalOut <= ROUNDING) state = 'paid';
  else if (pending > EPS) state = 'initiated';
  else if (overdue && !hasInitData) state = 'unconfirmed';
  else if (paid > EPS) state = 'part_paid';
  else state = 'to_initiate';
  return {
    received, direct, adv, credits, paid, out_before: outBefore, final_out: finalOut, pending, to_initiate: toInitiate,
    scheduled, sched_unpaid: schedUnpaid, schedule: sched, next_pay_on: next?.pay_on || '', overdue, initiations: ini.list, state,
    balance_gap: received && asOf >= p.bill_date ? r2(finalOut - p.zoho_balance) : 0,
  };
}

/** Money of an advance payment not applied to any bill on a day (it was not paid yet → 0) */
function advanceUnappliedAt(a, asOf) {
  if (!a.date || a.date > asOf) return 0;
  return r2(a.balance_now + sum(a.applications.filter(x => x.apply > asOf), x => x.amt));
}

function budgetAt(b, linked, advances, asOf) {
  const rec = linked.filter(x => x.at.received);
  const billed = r2(sum(rec, x => x.part.net));
  const paidBills = r2(sum(rec, x => x.at.paid));
  const paidAdv = r2(sum(advances.filter(a => a.budget_id === b.id), a => advanceUnappliedAt(a, asOf)));
  const paid = r2(paidBills + paidAdv);
  const awaiting = rec.length === 0 ? b.amount : (b.expects_more_bills ? r2(Math.max(0, b.amount - billed)) : 0);
  const unbilled = rec.length && !b.expects_more_bills ? r2(Math.max(0, b.amount - billed)) : 0;
  const sched = (b.schedule || [{ id: 'default', pay_on: M.monthEnd(b.planned_month), amount: awaiting, default: true }]).map(s => ({ ...s, amount: r2(s.amount) }));
  return { billed, paid, paid_bills: paidBills, paid_advances: paidAdv, remaining: r2(b.amount - paid), excess: paid > b.amount + EPS, awaiting, unbilled, bills: rec.length, schedule: sched };
}

// ── The month view ─────────────────────────────────────────────────────────────

/**
 * models: [buildModel(...)], opts: { month, mode: 'current'|'month_end', today, categories: [keys], filter: { branch, vendor } }
 * → { as_of, rows: { parts, budgets, advances }, summary: { [category]: {...}, total }, actions, cash }
 */
function monthView(models, { month, mode = 'current', today = M.todayIST(), categories, filter = {} }) {
  const start = M.monthStart(month), end = M.monthEnd(month);
  const asOf = mode === 'month_end' ? (end < today ? end : today) : today;
  const refDay = asOf;
  const dayBefore = (() => { const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const cats = categories || [...new Set(models.flatMap(m => [...m.parts, ...m.budgets, ...m.advances].map(x => x.category)))];
  const fb = normName(filter.branch), fv = normName(filter.vendor);
  const keep = x => cats.includes(x.category) && (!fb || normName(x.branch) === fb) && (!fv || normName(x.vendor).includes(fv));

  const partRows = [], budgetRows = [], advRows = [], cash = [];
  for (const m of models) {
    const parts = m.parts.filter(keep);
    const atEnd = new Map(parts.map(p => [p.key, partAt(p, asOf, refDay)]));
    for (const p of parts) {
      const at = atEnd.get(p.key);
      if (!at.received) continue;
      const plannedHere = p.planned_month === month;
      let carried = false;
      if (!plannedHere) {
        if (!(p.planned_month < month && p.bill_date < start)) continue;
        const open = partAt(p, dayBefore, dayBefore);
        if (open.final_out <= ROUNDING) continue;
        carried = true;
      }
      const paidThisMonth = r2(sum(p.pays.filter(x => x.date >= start && x.date <= end && x.eff <= asOf), x => x.amt));
      const paidLater = mode === 'current' ? r2(sum(p.pays.filter(x => x.date > end && x.eff <= asOf), x => x.amt)) : 0;
      const openingOut = carried ? partAt(p, dayBefore, dayBefore).final_out : 0;
      const paidAgainstPlan = carried ? r2(sum(p.pays.filter(x => x.date >= start && x.eff <= asOf), x => x.amt)) : at.paid;
      partRows.push({ ...p, at, earlier_bill: p.bill_date < start, carried_from: carried ? p.planned_month : '', opening_out: openingOut,
        paid_this_month: paidThisMonth, paid_later: paidLater, paid_against_plan: paidAgainstPlan });
    }
    // cash by payment date, whatever month the bill was planned for. Money of an advance not yet applied on the day
    // looked at is counted once, as the advance (below), never also through the bill it reaches later.
    for (const p of parts) {
      for (const x of p.pays) {
        if (x.date >= start && x.date <= end && x.eff <= asOf) {
          cash.push({ category: p.category, company: m.company.id, date: x.date, vendor: p.vendor, branch: p.branch, bill_no: p.bill_no, bill_id: p.bill_id, part_key: p.key,
            payment_no: x.no, ref: x.ref, amount: x.amt, kind: x.advance ? 'advance_applied' : 'bill_payment', apply: x.apply });
        }
      }
    }
    const advs = m.advances.filter(keep);
    for (const a of advs) {
      const un = advanceUnappliedAt(a, asOf);
      if (a.date >= start && a.date <= end && a.date <= asOf && un > EPS) {
        cash.push({ category: a.category, company: m.company.id, date: a.date, vendor: a.vendor, branch: a.branch, bill_no: '', payment_no: a.no, ref: a.ref, amount: un, kind: 'advance_unapplied', pid: a.pid });
      }
      if (un > EPS) advRows.push({ ...a, unapplied: un });
    }
    for (const b of m.budgets.filter(keep)) {
      if (b.planned_month !== month) continue;
      const linked = m.parts.filter(p => p.budget_id === b.id).map(p => ({ part: p, at: atEnd.get(p.key) || partAt(p, asOf, refDay) }));
      budgetRows.push({ ...b, at: budgetAt(b, linked, m.advances, asOf), part_keys: linked.filter(x => x.at.received).map(x => x.part.key) });
    }
  }

  const summary = {};
  for (const c of [...cats, 'total']) {
    const inC = x => c === 'total' || x.category === c;
    const P = partRows.filter(inC), B = budgetRows.filter(inC);
    const planned = P.filter(x => !x.carried_from);
    summary[c] = {
      budget: r2(sum(B, b => b.amount)), budget_original: r2(sum(B, b => b.original_amount)),
      awaiting: r2(sum(B, b => b.at.awaiting)), unbilled: r2(sum(B, b => b.at.unbilled)),
      billed: r2(sum(planned, x => x.net)), opening: r2(sum(P.filter(x => x.carried_from), x => x.opening_out)),
      pending: r2(sum(P, x => x.at.pending)),
      paid_plan: r2(sum(P, x => x.paid_against_plan) + sum(B, b => b.at.paid_advances)),
      remaining: r2(sum(B, b => b.at.remaining)),
      final_out: r2(sum(P, x => Math.max(0, x.at.final_out))),
      to_initiate: r2(sum(P, x => x.at.to_initiate)),
      cash_out: r2(sum(cash.filter(inC), x => x.amount)),
      unlinked: r2(sum(planned.filter(x => !x.budget_id), x => x.net)),
      counts: { bills: P.length, budgets: B.length, awaiting: B.filter(b => b.at.awaiting > EPS).length, excess: B.filter(b => b.at.excess).length,
        overdue: planned.filter(x => x.at.overdue).length, overdue_opening: P.filter(x => x.carried_from && x.at.overdue).length, unlinked: planned.filter(x => !x.budget_id).length },
    };
  }

  const actions = {
    follow_up: [],
    // this month's bills first (earliest Pay On first), then opening dues (most recent first, so years-old open bills come last)
    initiate: partRows.filter(x => x.at.to_initiate > EPS).map(x => ({ key: x.key, category: x.category, company: x.company, vendor: x.vendor, branch: x.branch, bill_no: x.bill_no,
      bill_date: x.bill_date, carried_from: x.carried_from, amount: x.at.to_initiate, pay_on: x.at.overdue?.pay_on || x.at.next_pay_on, delay_days: x.at.overdue ? x.at.overdue.days : 0, state: x.at.state }))
      .sort((a, b) => (a.carried_from ? 1 : 0) - (b.carried_from ? 1 : 0)
        || (a.carried_from ? String(b.pay_on).localeCompare(String(a.pay_on)) : String(a.pay_on).localeCompare(String(b.pay_on)))),
    settlement: partRows.filter(x => x.at.pending > EPS).map(x => ({ key: x.key, category: x.category, company: x.company, vendor: x.vendor, branch: x.branch, bill_no: x.bill_no,
      amount: x.at.pending, initiations: x.at.initiations.filter(i => i.pending > EPS).map(i => ({ date: i.date, amount: i.pending, reference: i.reference || '', source: i.source, age_days: M.daysBetween(i.date, refDay) })) })),
  };
  // follow up: budgets of this month and earlier months of the year still waiting for their bill
  for (const m of models) {
    for (const b of m.budgets.filter(keep)) {
      if (b.planned_month > month || M.fyOf(b.planned_month) !== M.fyOf(month)) continue;
      const linked = m.parts.filter(p => p.budget_id === b.id).map(p => ({ part: p, at: partAt(p, asOf, refDay) }));
      const at = budgetAt(b, linked, m.advances, asOf);
      if (at.awaiting > EPS) actions.follow_up.push({ id: b.id, category: b.category, company: b.company, vendor: b.vendor_name || '', client: b.client || '', branch: b.branch || '',
        planned_month: b.planned_month, amount: at.awaiting, pay_on: at.schedule[0]?.pay_on || '', earlier: b.planned_month < month });
    }
  }
  actions.follow_up.sort((a, b) => a.planned_month.localeCompare(b.planned_month) || String(a.pay_on).localeCompare(String(b.pay_on)));

  return { month, mode, as_of: asOf, start, end, categories: cats, rows: { parts: partRows, budgets: budgetRows, advances: advRows }, summary, actions, cash };
}

// ── Financial-year grid (Rent: branch × landlord × month) ─────────────────────

/** → { months, rows: [{ branch, vendor, vendor_id, cells: { [month]: { budget, billed, paid, outstanding, cash, parts: [keys] } }, totals }] } */
function fyGrid(models, { fy, category, today = M.todayIST(), filter = {} }) {
  const months = M.fyMonths(fy);
  const inFy = m => months.includes(m);
  const fb = normName(filter.branch), fv = normName(filter.vendor);
  const rows = new Map();
  const rowOf = (company, branch, vendor, vendor_id) => {
    const k = `${company}|${normName(branch)}|${vendor_id || normName(vendor)}`;
    if (!rows.has(k)) rows.set(k, { key: k, company, branch: branch || '—', vendor: vendor || '—', vendor_id: vendor_id || '', cells: {}, basic: 0, gst: 0, gross: 0, tds: 0, net: 0, last_bill: null });
    return rows.get(k);
  };
  const cell = (row, m) => (row.cells[m] = row.cells[m] || { budget: 0, billed: 0, paid: 0, outstanding: 0, cash: 0, parts: [], budgets: [] });
  for (const mdl of models) {
    for (const p of mdl.parts) {
      if (p.category !== category) continue;
      if ((fb && normName(p.branch) !== fb) || (fv && !normName(p.vendor).includes(fv))) continue;
      const row = rowOf(mdl.company.id, p.branch, p.vendor, p.vendor_id);
      if (inFy(p.planned_month)) {
        const at = partAt(p, today, today);
        const c = cell(row, p.planned_month);
        c.billed = r2(c.billed + p.net); c.paid = r2(c.paid + at.paid); c.outstanding = r2(c.outstanding + Math.max(0, at.final_out)); c.parts.push(p.key);
        row.basic = r2(row.basic + p.basic); row.gst = r2(row.gst + p.gst); row.gross = r2(row.gross + p.gross); row.tds = r2(row.tds + p.tds); row.net = r2(row.net + p.net);
        if (!row.last_bill || p.bill_date > row.last_bill.date) row.last_bill = { date: p.bill_date, no: p.bill_no, key: p.key };
      }
      for (const x of p.pays) {
        const pm = M.monthOf(x.date);
        if (inFy(pm) && x.date <= today) { const c = cell(row, pm); c.cash = r2(c.cash + x.amt); if (!c.parts.includes(p.key)) c.parts.push(p.key); }
      }
    }
    for (const b of mdl.budgets) {
      if (b.category !== category || !inFy(b.planned_month)) continue;
      if ((fb && normName(b.branch) !== fb) || (fv && !normName(b.vendor_name).includes(fv))) continue;
      const row = rowOf(mdl.company.id, b.branch, b.vendor_name || (b.vendor_id ? '' : '(budget without a landlord)'), b.vendor_id);
      const c = cell(row, b.planned_month);
      c.budget = r2(c.budget + b.amount); c.budgets.push(b.id);
    }
  }
  const list = [...rows.values()].sort((a, b) => a.branch.localeCompare(b.branch) || a.vendor.localeCompare(b.vendor));
  const totals = {};
  for (const m of months) {
    totals[m] = { budget: 0, billed: 0, paid: 0, outstanding: 0, cash: 0 };
    for (const r of list) { const c = r.cells[m]; if (c) for (const k of Object.keys(totals[m])) totals[m][k] = r2(totals[m][k] + c[k]); }
  }
  return { fy, category, months, rows: list, totals };
}

module.exports = { buildModel, linkParts, partAt, budgetAt, settleInitiations, advanceUnappliedAt, monthView, fyGrid, EPS };
