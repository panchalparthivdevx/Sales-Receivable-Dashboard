/**
 * The reconciliation engine: Zoho TDS entries (lib/booksModel) × Form 26AS credits (lib/statements) for one entity and period.
 *
 *   TDS difference = Zoho TDS receivable − 26AS tax deposited   (positive: the books show more TDS than the statement credits)
 *
 * Sequence (each source amount is used once; the ₹2 tolerance is applied once per match or group, never per row):
 *   0  reviewer links           pairs / groups a reviewer confirmed (both sides inside the period)
 *   1  identify the client      the deductor TAN: a Zoho entry belongs to the client of the TAN on its invoice, so several Zoho customers
 *                               with one TAN are one client; reviewer groups cover the rest (lib/clients.index)
 *   2  transaction-wise         same client, TDS equal within ₹2 to the 26AS tax deducted or deposited. Where several entries qualify,
 *                               section, taxable base (26AS amount paid vs the Books base), exact amount and dates decide. As many
 *                               entries as credits all of one amount (a monthly fee) are paired in date order (flag
 *                               equal_amounts_date_order); otherwise, when they cannot, the entries go to review ("Need to Check — ambiguous")
 *   3  client totals            what is still open per client: one 26AS entry = several Books entries (or the reverse) by a unique
 *                               subset, then the remaining totals; method "Client total", invoice attribution left open
 *   4  investigate              credits / bookings of the same client OUTSIDE the period (a later or earlier statement, a later Books
 *                               month) → "Need to Check — timing" with both periods shown and the other-period amount kept out of this
 *                               period's totals; leftovers of one client paired on evidence → "Not Matched"; the rest are one-sided —
 *                               but only "Not in 26AS" / "Not in Zoho Books" when the other source covers that date, otherwise
 *                               "Need to Check — coverage gap"
 * Carry-forward settlements (lib/review) consume their credits before step 0 and show as "Carry-forward settlement". When the carried
 * item and its settlement both lie in the period, they form one unit instead (method cf_inside, the system status of the pair).
 */

'use strict';

const PER = require('./periods');
const { fmtR, pct, daysBetween, hashOf } = require('./util');

const STATUS = { matched: 'Matched', rounding: 'Matched Rounding Diff.', not_matched: 'Not Matched', not_in_26as: 'Not in 26AS', not_in_zoho: 'Not in Zoho Books', need_check: 'Need to Check', carry_forward: 'Carry Forward' };
const METHOD = { transaction: 'Transaction', client_total: 'Client total', manual: 'Reviewer link', difference: 'Transaction (difference)', cf_settlement: 'Carry-forward settlement', cf_inside: 'Carried forward, settled in period', single: '—' };
const STATUS_ORDER = ['not_matched', 'not_in_26as', 'not_in_zoho', 'need_check', 'carry_forward', 'rounding', 'matched'];

const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
const statusOf = (diff, tol) => (diff === 0 ? 'matched' : Math.abs(diff) <= tol ? 'rounding' : 'not_matched');

function baseAgrees(bases, paid, s) {
  if (paid === null || paid === undefined) return false;
  return bases.filter(b => b !== null && b !== undefined && b > 0).some(b => Math.abs(paid - b) <= Math.max(s.rounding_tol_p, Math.round((b * s.base_tol_bp) / 10000)));
}
const zBases = z => [z.base && z.base.comparable, z.base && z.base.basic, z.base && z.base.gross];
const zDates = z => [z.date, ...(z.invoices || []).map(i => i.date), z.payment && z.payment.date].filter(Boolean);
const dist = (z, c) => Math.min(...zDates(z).map(d => Math.abs(daysBetween(d, c.txn_date))));
const secRel = (z, c) => (!z.section || !c.section ? 'unknown' : z.section === c.section ? 'same' : 'differs');
const amtFits = (z, c, tol) => Math.abs(z.amount - c.deducted) <= tol || Math.abs(z.amount - c.deposited) <= tol;
const exactFits = (z, c) => z.amount === c.deducted || z.amount === c.deposited;

/** Among equal-amount candidates, keep the ones the evidence supports; more than one left = ambiguous */
function narrow(cands, scoreFns) {
  let L = cands;
  for (const f of scoreFns) {
    if (L.length <= 1) return L;
    const ok = L.filter(f);
    if (ok.length && ok.length < L.length) L = ok;
  }
  return L;
}
/** Dates decide between equal candidates only when clearly so: one on the very date while every other is more than date_close_days
 *  away, or one at least date_gap_days closer than the next. Otherwise both stay plausible and go to review. */
function byDate(L, distFn, s) {
  if (L.length <= 1) return L;
  const sorted = L.map(x => [x, distFn(x)]).sort((a, b) => a[1] - b[1]);
  if (sorted[0][1] === 0 && sorted[1][1] > s.date_close_days) return [sorted[0][0]];
  if (sorted[1][1] - sorted[0][1] >= s.date_gap_days) return [sorted[0][0]];
  return L;
}

/** As many Zoho entries as 26AS credits, all of the same amount: the k-th entry by Zoho date with the k-th credit by transaction date.
 *  null when the sections could tell entries and credits apart but the date order pairs differing sections — then the reviewer decides.
 *  (When every entry differs from every credit in section, e.g. a 194C ledger against 194J credits, the pairs are made and flagged
 *  section_mismatch, as a single pair would be.) */
function dateOrderPairs(zs, cs) {
  const cmp = (a, b) => String(a || '').localeCompare(String(b || ''));
  const Zs = zs.slice().sort((a, b) => cmp(a.date, b.date) || cmp(a.number, b.number) || cmp(a.key, b.key));
  const Cs = cs.slice().sort((a, b) => cmp(a.txn_date, b.txn_date) || cmp(a.key, b.key));
  const pairs = Zs.map((z, i) => [z, Cs[i]]);
  const sectionsTell = Zs.some(z => Cs.some(c => secRel(z, c) === 'same'));
  return sectionsTell && pairs.some(([z, c]) => secRel(z, c) === 'differs') ? null : pairs;
}

/** Subsets of `pool` (amount accessor `val`) whose total is within tol of one of `targets`; stops after 2 solutions */
function subsets(pool, val, targets, tol, maxSize) {
  const list = pool.filter(x => val(x) > 0).sort((a, b) => val(b) - val(a)).slice(0, 16);
  const hi = Math.max(...targets) + tol;
  const out = [];
  const pick = [];
  (function dfs(i, total) {
    if (out.length >= 2) return;
    if (pick.length >= 2 && targets.some(t => Math.abs(total - t) <= tol)) out.push(pick.slice());
    if (pick.length >= maxSize) return;
    for (let k = i; k < list.length; k++) {
      const v = val(list[k]);
      if (total + v > hi) continue;
      pick.push(list[k]); dfs(k + 1, total + v); pick.pop();
      if (out.length >= 2) return;
    }
  })(0, 0);
  return out;
}

/**
 * ctx: { entity, period: {from,to}, items (all Zoho entries of the entity), credits (all active credits), clients (lib/clients index),
 *        links (reviewer links), cfConsumed: Map(key → settlement), coverage: { zohoMonths: Set('YYYY-MM'), statements: [{fy, statement_date}] }, settings }
 */
function reconcile(ctx) {
  const s = ctx.settings, tol = s.rounding_tol_p;
  const { from, to } = ctx.period;
  const inP = d => !!d && d >= from && d <= to;
  const Z = ctx.items.filter(i => inP(i.date));
  const C = ctx.credits.filter(c => inP(c.txn_date));
  const zBy = new Map(ctx.items.map(i => [i.key, i])), cBy = new Map(ctx.credits.map(c => [c.key, c]));
  const used = new Set();
  const units = [];
  // the client of an entry comes from the TAN on its invoice (lib/clients.index); a plain group index (no entry()) maps by customer
  // (a journal without a customer can still have a client: the deductor found from its Reference number / Notes — lib/clients)
  const groupOfZ = z => (ctx.clients.entry ? ctx.clients.entry(z).group : z.customer_id ? ctx.clients.byCust.get(z.customer_id) || null : null);
  const groupOfC = c => ctx.clients.byTan.get(c.tan) || null;
  const gName = g => (g ? (ctx.clients.groups.get(g) || {}).name || g : '');

  const cov26 = date => {
    const q = PER.quarterOf(date), p = PER.parseQ(q);
    const st = ctx.coverage.statements.find(x => x.fy === p.fy);
    if (!st) return { state: 'missing', text: `No Form 26AS for FY ${p.fy} is uploaded` };
    const due = PER.filingDue(p.fy, p.q);
    if (st.statement_date < due) return { state: 'early', text: `The FY ${p.fy} statement is dated ${st.statement_date}, before ${due} — the date by which deductors file their ${PER.qLabel(q)} TDS statements` };
    return { state: 'complete', text: `FY ${p.fy} statement dated ${st.statement_date}` };
  };
  const covZ = date => (ctx.coverage.zohoMonths.has(date.slice(0, 7)) ? { state: 'complete' } : { state: 'missing', text: `Zoho ledger postings for ${date.slice(0, 7)} have not been synced` });

  function addUnit(u) {
    const zs = u.zoho.map(k => zBy.get(k)), cs = u.credits.map(k => cBy.get(k));
    for (const k of [...u.zoho, ...u.credits]) used.add(k);
    const z_amount = sum(zs, z => z.amount), deducted = sum(cs, c => c.deducted), deposited = sum(cs, c => c.deposited), paid = sum(cs, c => c.amount_paid);
    const two = zs.length > 0 && cs.length > 0;
    const diff = two ? z_amount - deposited : zs.length ? z_amount : -deposited;
    const matched = two ? (z_amount > 0 && deposited > 0 ? Math.min(z_amount, deposited) : 0) : 0;
    const unit = {
      id: `u${hashOf([...u.zoho, '|', ...u.credits].join(','))}`, method: u.method, step: u.step, group: u.group || null, client: gName(u.group) || (zs[0] && zs[0].customer_name) || (cs[0] && cs[0].deductor) || '',
      zoho: u.zoho, credits: u.credits, z_amount, deducted, deposited, paid, diff, status: u.status, reason: u.reason || null, evidence: u.evidence || [], flags: u.flags || [],
      matched_amount: ['matched', 'rounding'].includes(u.status) ? deposited : matched, open_zoho: ['matched', 'rounding'].includes(u.status) ? 0 : two ? z_amount - matched : zs.length ? z_amount : 0,
      open_26as: ['matched', 'rounding'].includes(u.status) ? 0 : two ? deposited - matched : cs.length ? deposited : 0, cf: u.cf || null,
      tans: [...new Set(cs.map(c => c.tan))], sections: [...new Set([...zs.map(z => z.section), ...cs.map(c => c.section)].filter(Boolean))],
      date: [...zs.map(z => z.date), ...cs.map(c => c.txn_date)].sort()[0] || '',
    };
    if (two && cs.some(c => c.deducted - c.deposited > tol)) unit.flags.push('deducted_exceeds_deposited');
    if (two && zs.some(z => cs.some(c => secRel(z, c) === 'differs'))) unit.flags.push('section_mismatch');
    if (!unit.reason && unit.status !== 'matched') unit.reason = explain(unit, zs, cs, s);
    units.push(unit);
    return unit;
  }

  // a carried-forward item whose origin AND settlement both lie in the period being viewed (e.g. a 26AS credit of 30 Sep carried to Q3
  // and settled by the Zoho booking of 7 Oct, viewed for Apr–Oct): one unit, as the two would have matched without the carry forward
  const byCf = new Map();
  for (const [key, st] of ctx.cfConsumed || []) (byCf.get(st.cf_id) || byCf.set(st.cf_id, { st, keys: [] }).get(st.cf_id)).keys.push(key);
  for (const { st, keys } of byCf.values()) {
    const all = [...(st.origin_keys || []), ...keys];
    const inside = k => { const z = zBy.get(k), c = cBy.get(k); return !used.has(k) && (z ? inP(z.date) : c ? inP(c.txn_date) : false); };
    if (!(st.origin_keys || []).length || !all.every(inside)) continue;
    const zk = all.filter(k => zBy.has(k)), ck = all.filter(k => cBy.has(k));
    const zz = zk.map(k => zBy.get(k)), cc = ck.map(k => cBy.get(k));
    const later = keys.map(k => zBy.get(k) || cBy.get(k)).map(x => (x.txn_date ? `the 26AS credit of ${x.txn_date}` : `Zoho ${x.type_label.toLowerCase()} ${x.number || ''} of ${x.date}`)).join(', ');
    addUnit({ method: 'cf_inside', step: 0, group: zz.length ? groupOfZ(zz[0]) : groupOfC(cc[0]), zoho: zk, credits: ck, status: statusOf(sum(zz, z => z.amount) - sum(cc, c => c.deposited), tol),
      reason: { code: 'cf_inside', text: `Carried forward from ${PER.qLabel(st.origin_quarter)} and settled by ${later} — both lie in this period, so they are shown together` } });
  }

  // carry-forward settlements: credits / entries that close a balance carried from an earlier period
  for (const [key, st] of ctx.cfConsumed || []) {
    const isC = cBy.has(key);
    const x = isC ? cBy.get(key) : zBy.get(key);
    if (!x || used.has(key) || !inP(isC ? x.txn_date : x.date)) continue;
    const diffCf = st.diff || 0;
    addUnit({ method: 'cf_settlement', step: 0, group: isC ? groupOfC(x) : groupOfZ(x), zoho: isC ? [] : [key], credits: isC ? [key] : [], status: statusOf(diffCf, tol),
      reason: { code: 'cf_settlement', text: `Settles the ${fmtR(st.balance)} carried forward from ${PER.qLabel(st.origin_quarter)} (${st.client || ''})${diffCf ? `; difference ${fmtR(diffCf)}` : ''}` }, cf: { id: st.cf_id, origin_quarter: st.origin_quarter, balance: st.balance } });
  }

  // 0. reviewer links (only when every member lies in the period)
  for (const l of ctx.links || []) {
    const zs = l.zoho.filter(k => zBy.has(k)), cs = l.credits.filter(k => cBy.has(k));
    if (!zs.length || !cs.length || zs.length !== l.zoho.length || cs.length !== l.credits.length) continue;
    if ([...zs, ...cs].some(k => used.has(k))) continue;
    if (!zs.every(k => inP(zBy.get(k).date)) || !cs.every(k => inP(cBy.get(k).txn_date))) continue;
    const zz = zs.map(k => zBy.get(k)), cc = cs.map(k => cBy.get(k));
    addUnit({ method: 'manual', step: 0, group: groupOfZ(zz[0]) || groupOfC(cc[0]), zoho: zs, credits: cs, status: statusOf(sum(zz, z => z.amount) - sum(cc, c => c.deposited), tol), flags: [`linked by ${l.by}`] });
  }

  // 1. identify the client
  const groups = new Map();
  const slot = g => groups.get(g) || groups.set(g, { z: [], c: [] }).get(g);
  for (const z of Z) {
    if (used.has(z.key)) continue;
    if (!z.customer_id && !groupOfZ(z)) {
      const info = ctx.clients.entry ? ctx.clients.entry(z) : {};
      const refs = z.refs_unresolved && z.refs_unresolved.length ? ` (its references ${z.refs_unresolved.join(', ')} are not Zoho invoices)` : '';
      const text = z.type !== 'journal' ? `Unallocated: the ${z.type_label.toLowerCase()} ${z.number || ''} has no customer${refs}`
        : info.basis === 'journal_ambiguous' ? `Unallocated: the journal ${z.number || ''} has no customer, and its Reference number / Notes fit several deductors (${info.candidates.map(c => `${c.name || '?'} ${c.tan}`).join('; ')}) — choose the deductor in the item`
        : `Unallocated: the journal ${z.number || ''} has no customer, and its Reference number / Notes name no Zoho invoice, TAN or Form 26AS deductor${refs} — choose the deductor in the item`;
      addUnit({ method: 'single', step: 1, zoho: [z.key], credits: [], status: 'need_check', reason: { code: 'unallocated', text, figures: { amount: z.amount } } });
      continue;
    }
    const g = groupOfZ(z);
    if (!g) {
      const info = ctx.clients.entry ? ctx.clients.entry(z) : { basis: '', tans: [] };
      const why = info.basis === 'several_tans' ? `its invoices record several TANs (${info.tans.join(', ')}), so the TAN does not tell which deductor it is`
        : info.basis === 'no_tan' ? 'no TAN is recorded on its invoices in Zoho'
        : info.basis === 'tan_excluded' ? `the TAN on its invoice (${info.tans.join(', ')}) is ruled out for it in Client mapping ("not the same client" or "no Zoho customer")`
        : `not mapped to a deductor TAN yet${z.tan_hints.length ? ` (Zoho records TAN ${z.tan_hints.join(', ')} on the invoice)` : ''}`;
      addUnit({ method: 'single', step: 1, zoho: [z.key], credits: [], status: 'need_check', reason: { code: 'customer_unmapped', text: `${z.customer_name || 'This customer'}: ${why} — put it in a client in Client mapping`, figures: { amount: z.amount } } });
      continue;
    }
    slot(g).z.push(z);
  }
  for (const c of C) {
    if (used.has(c.key)) continue;
    const g = groupOfC(c);
    if (!g) {
      const nc = ctx.clients.noCustomer && ctx.clients.noCustomer.has(c.tan);
      const zc = covZ(c.txn_date);
      if (nc && zc.state === 'complete') addUnit({ method: 'single', step: 1, zoho: [], credits: [c.key], status: 'not_in_zoho', reason: { code: 'no_customer', text: `${c.deductor} (${c.tan}) is marked as having no Zoho customer: ${fmtR(c.deposited)} credited, nothing booked` } });
      else addUnit({ method: 'single', step: 1, zoho: [], credits: [c.key], status: 'need_check', reason: nc ? { code: 'coverage_zoho', text: zc.text } : { code: 'deductor_unmapped', text: `Deductor ${c.deductor} (${c.tan}) is not mapped to a Zoho customer yet — map it in Client mapping` } });
      continue;
    }
    slot(g).c.push(c);
  }

  const ambiguous = [];
  for (const [g, b] of groups) {
    // 2. transaction-wise
    let zs = b.z.filter(z => !used.has(z.key)), cs = b.c.filter(c => !used.has(c.key));
    const pairOk = (z, c) => z.amount > 0 && amtFits(z, c, tol);
    const comps = components(zs.filter(z => z.amount > 0), cs, pairOk);
    for (const comp of comps) {
      const takenZ = new Set(), takenC = new Set();
      const zFns = c => [z => exactFits(z, c), z => secRel(z, c) === 'same', z => baseAgrees(zBases(z), c.amount_paid, s)];
      const cFns = z => [c => exactFits(z, c), c => secRel(z, c) === 'same', c => baseAgrees(zBases(z), c.amount_paid, s)];
      for (let progress = true; progress;) {
        progress = false;
        for (const c of comp.c) {
          if (takenC.has(c.key)) continue;
          const candZ = byDate(narrow(comp.z.filter(z => !takenZ.has(z.key) && pairOk(z, c)), zFns(c)), z => dist(z, c), s);
          if (candZ.length !== 1) continue;
          const z = candZ[0];
          const back = byDate(narrow(comp.c.filter(x => !takenC.has(x.key) && pairOk(z, x)), cFns(z)), x => dist(z, x), s);
          if (back.length !== 1 || back[0].key !== c.key) continue;
          takenZ.add(z.key); takenC.add(c.key); progress = true;
          addUnit({ method: 'transaction', step: 2, group: g, zoho: [z.key], credits: [c.key], status: statusOf(z.amount - c.deposited, tol) });
        }
      }
      const lz = comp.z.filter(z => !takenZ.has(z.key)), lc = comp.c.filter(c => !takenC.has(c.key));
      if (lz.length && lc.length) {
        const amts = [...lz.map(z => z.amount), ...lc.map(c => c.deducted)];
        const sameAmounts = Math.max(...amts) - Math.min(...amts) <= tol;
        // the same amount several times, as many entries as credits (a monthly fee): the pairing changes no difference, only which
        // invoice faces which credit — paired in date order instead of being left to the client totals or sent to other quarters
        const pairs = sameAmounts && lz.length === lc.length ? dateOrderPairs(lz, lc) : null;
        if (pairs) for (const [z, c] of pairs) addUnit({ method: 'transaction', step: 2, group: g, zoho: [z.key], credits: [c.key], status: statusOf(z.amount - c.deposited, tol), flags: ['equal_amounts_date_order'] });
        else ambiguous.push({ g, z: lz.map(z => z.key), c: lc.map(c => c.key) });
      }
    }

    // 3. client totals
    zs = b.z.filter(z => !used.has(z.key)); cs = b.c.filter(c => !used.has(c.key));
    const amb = new Set(ambiguous.filter(a => a.g === g).flatMap(a => [...a.z, ...a.c]));
    for (const c of cs.slice().sort((a, b2) => b2.deposited - a.deposited)) {
      if (used.has(c.key) || amb.has(c.key)) continue;
      const pool = zs.filter(z => !used.has(z.key) && !amb.has(z.key) && z.amount > 0);
      const sols = subsets(pool, z => z.amount, [c.deposited, c.deducted], tol, s.max_subset);
      if (sols.length === 1) addUnit({ method: 'client_total', step: 3, group: g, zoho: sols[0].map(z => z.key), credits: [c.key], status: statusOf(sum(sols[0], z => z.amount) - c.deposited, tol), flags: ['one_credit_many_entries'] });
    }
    for (const z of zs.slice().sort((a, b2) => b2.amount - a.amount)) {
      if (used.has(z.key) || amb.has(z.key) || z.amount <= 0) continue;
      const pool = cs.filter(c => !used.has(c.key) && !amb.has(c.key));
      const sols = subsets(pool, c => c.deposited || c.deducted, [z.amount], tol, s.max_subset);
      if (sols.length === 1) addUnit({ method: 'client_total', step: 3, group: g, zoho: [z.key], credits: sols[0].map(c => c.key), status: statusOf(z.amount - sum(sols[0], c => c.deposited), tol), flags: ['one_entry_many_credits'] });
    }
    zs = b.z.filter(z => !used.has(z.key)); cs = b.c.filter(c => !used.has(c.key));
    if (zs.length && cs.length) {
      const tz = sum(zs, z => z.amount), tdep = sum(cs, c => c.deposited), tded = sum(cs, c => c.deducted);
      if (Math.abs(tz - tdep) <= tol) addUnit({ method: 'client_total', step: 3, group: g, zoho: zs.map(z => z.key), credits: cs.map(c => c.key), status: statusOf(tz - tdep, tol), flags: ['remaining_totals'] });
      else if (Math.abs(tz - tded) <= tol && tded - tdep > tol) addUnit({ method: 'client_total', step: 3, group: g, zoho: zs.map(z => z.key), credits: cs.map(c => c.key), status: 'not_matched', flags: ['remaining_totals'] });
    }

    // 4. investigate what is still open
    zs = b.z.filter(z => !used.has(z.key)); cs = b.c.filter(c => !used.has(c.key));
    // a credit / entry that settled a carried-forward balance is evidence only for the item it settled (so the original period keeps its picture)
    const free = (key, own) => { const st = ctx.cfConsumed && ctx.cfConsumed.get(key); return !st || (st.origin_keys || []).includes(own); };
    for (const z of zs) {
      if (z.amount <= 0 || amb.has(z.key)) continue;
      const ev = ctx.credits.filter(c => !inP(c.txn_date) && groupOfC(c) === g && free(c.key, z.key) && amtFits(z, c, tol) && Math.abs(daysBetween(z.date, c.txn_date)) <= s.timing_days)
        .sort((a, b2) => Math.abs(daysBetween(z.date, a.txn_date)) - Math.abs(daysBetween(z.date, b2.txn_date))).slice(0, 3);
      // the other period may have its own booking of this amount for the client — then the credit may belong there (said, not decided)
      const ownThere = c => ctx.items.some(o => o.key !== z.key && groupOfZ(o) === g && o.amount > 0 && PER.quarterOf(o.date) === PER.quarterOf(c.txn_date) && amtFits(o, c, tol));
      if (ev.length) addUnit({ method: 'single', step: 4, group: g, zoho: [z.key], credits: [], status: 'need_check', evidence: ev.map(c => ({ kind: c.txn_date > to ? 'later_credit' : 'earlier_credit', credit: c.key, quarter: PER.quarterOf(c.txn_date), txn_date: c.txn_date, deducted: c.deducted, deposited: c.deposited, tan: c.tan, statement: c.stmt, maybe_matched_there: ownThere(c) })),
        reason: { code: 'timing', text: `Timing difference: booked in Zoho on ${z.date} (${PER.qLabel(z.quarter)}); a ${fmtR(ev[0].deducted)} credit dated ${ev[0].txn_date} appears in ${PER.qLabel(PER.quarterOf(ev[0].txn_date))} — not counted in this period's matched totals${ownThere(ev[0]) ? '. That quarter also has a Zoho booking of this amount for the client, so the credit may belong to it — check before relying on it' : ''}` } });
    }
    for (const c of cs) {
      if (used.has(c.key) || amb.has(c.key)) continue;
      const ev = ctx.items.filter(z => !inP(z.date) && z.amount > 0 && groupOfZ(z) === g && free(z.key, c.key) && amtFits(z, c, tol) && Math.abs(daysBetween(z.date, c.txn_date)) <= s.timing_days)
        .sort((a, b2) => Math.abs(daysBetween(a.date, c.txn_date)) - Math.abs(daysBetween(b2.date, c.txn_date))).slice(0, 3);
      if (ev.length) addUnit({ method: 'single', step: 4, group: g, zoho: [], credits: [c.key], status: 'need_check', evidence: ev.map(z => ({ kind: z.date > to ? 'later_booking' : 'earlier_booking', zoho: z.key, quarter: z.quarter, date: z.date, amount: z.amount, number: z.number })),
        reason: { code: 'timing', text: `Timing difference: 26AS credit dated ${c.txn_date}; the matching Zoho entry ${ev[0].number || ''} of ${fmtR(ev[0].amount)} is booked on ${ev[0].date} (${PER.qLabel(ev[0].quarter)})` } });
    }
    // leftovers paired on evidence → Not Matched
    zs = b.z.filter(z => !used.has(z.key) && !amb.has(z.key) && z.amount > 0); cs = b.c.filter(c => !used.has(c.key) && !amb.has(c.key));
    const nearOk = (z, c) => Math.abs(z.amount - c.deducted) <= (Math.max(z.amount, c.deducted) * s.near_pct) / 100 && dist(z, c) <= s.near_days;
    const strong = (z, c) => secRel(z, c) !== 'differs' && baseAgrees(zBases(z), c.amount_paid, s);
    const onlyPair = zs.length === 1 && cs.length === 1 && secRel(zs[0], cs[0]) !== 'differs';
    for (const c of cs) {
      if (used.has(c.key)) continue;
      const pool = zs.filter(z => !used.has(z.key));
      let pick = pool.filter(z => strong(z, c));
      if (pick.length !== 1) pick = onlyPair ? pool : pool.filter(z => secRel(z, c) !== 'differs' && nearOk(z, c));
      if (pick.length !== 1) continue;
      const z = pick[0];
      const rev = cs.filter(x => !used.has(x.key) && (strong(z, x) || (secRel(z, x) !== 'differs' && nearOk(z, x))));
      if (!onlyPair && rev.length > 1 && !(rev.filter(x => strong(z, x)).length === 1 && strong(z, c))) continue;
      addUnit({ method: 'difference', step: 4, group: g, zoho: [z.key], credits: [c.key], status: statusOf(z.amount - c.deposited, tol) });
    }
  }

  // ambiguous candidates that were not settled by the client totals
  for (const a of ambiguous) {
    const zk = a.z.filter(k => !used.has(k)), ck = a.c.filter(k => !used.has(k));
    if (!zk.length && !ck.length) continue;
    const zz = zk.map(k => zBy.get(k));
    addUnit({ method: 'single', step: 2, group: a.g, zoho: zk, credits: ck, status: 'need_check', evidence: zz.map(z => ({ kind: 'candidate', zoho: z.key, number: z.number, date: z.date, amount: z.amount })),
      reason: { code: 'ambiguous', text: `Ambiguous: ${zk.length} Zoho entr${zk.length === 1 ? 'y' : 'ies'} (${zz.map(z => `${z.number || z.type_label} ${fmtR(z.amount)} on ${z.date}`).join('; ')}) and ${ck.length} 26AS credit(s) of the same amount — dates, section and base do not show which invoice the credit belongs to` } });
  }

  // one-sided leftovers
  for (const [g, b] of groups) {
    for (const z of b.z) {
      if (used.has(z.key)) continue;
      if (z.amount < 0) { addUnit({ method: 'single', step: 4, group: g, zoho: [z.key], credits: [], status: 'need_check', reason: { code: 'reversal', text: `TDS reversed in Zoho (${z.type_label.toLowerCase()} ${z.number || ''}, ${fmtR(z.amount)}) without a matching 26AS change — check whether the client also revised its TDS statement` } }); continue; }
      const cv = cov26(z.date);
      const gg = ctx.clients.groups.get(g);
      const unseen = gg && gg.auto && !gg.in_statement ? gg.tans[0].tan : null;
      if (cv.state === 'complete') addUnit({ method: 'single', step: 4, group: g, zoho: [z.key], credits: [], status: 'not_in_26as',
        reason: unseen ? { code: 'tan_not_in_26as', text: `No uploaded Form 26AS has any credit from TAN ${unseen}, the TAN recorded on the Zoho invoice — check the TAN on the invoice; if it is right, the client has not reported this TDS`, figures: { zoho: z.amount } } : undefined });
      else addUnit({ method: 'single', step: 4, group: g, zoho: [z.key], credits: [], status: 'need_check', reason: { code: 'coverage_26as', text: `Coverage gap: ${cv.text}` } });
    }
    for (const c of b.c) {
      if (used.has(c.key)) continue;
      if (c.deposited < 0 || c.deducted < 0) { addUnit({ method: 'single', step: 4, group: g, zoho: [], credits: [c.key], status: 'need_check', reason: { code: 'reversal_26as', text: `26AS shows a reversal by ${c.deductor} (${fmtR(c.deposited)}, ${c.txn_date}${c.remarks ? `, remark ${c.remarks}` : ''}) with no matching earlier credit in the statement and no Zoho reversal — check the deductor's revised TDS statement` } }); continue; }
      const cv = covZ(c.txn_date);
      if (cv.state === 'complete') addUnit({ method: 'single', step: 4, group: g, zoho: [], credits: [c.key], status: 'not_in_zoho' });
      else addUnit({ method: 'single', step: 4, group: g, zoho: [], credits: [c.key], status: 'need_check', reason: { code: 'coverage_zoho', text: `Coverage gap: ${cv.text}` } });
    }
  }
  return { units, period: ctx.period, zoho_in_period: Z.map(z => z.key), credits_in_period: C.map(c => c.key) };
}

function components(zs, cs, ok) {
  const out = [], seenZ = new Set(), seenC = new Set();
  for (const z0 of zs) {
    if (seenZ.has(z0.key)) continue;
    const comp = { z: [], c: [] };
    const queue = [['z', z0]];
    seenZ.add(z0.key);
    while (queue.length) {
      const [side, x] = queue.shift();
      if (side === 'z') { comp.z.push(x); for (const c of cs) if (!seenC.has(c.key) && ok(x, c)) { seenC.add(c.key); queue.push(['c', c]); } }
      else { comp.c.push(x); for (const z of zs) if (!seenZ.has(z.key) && ok(z, x)) { seenZ.add(z.key); queue.push(['z', z]); } }
    }
    if (comp.c.length) out.push(comp);
  }
  return out;
}

/**
 * Likely reason for an exception, with the figures behind it. Responsibility is named only where the record itself establishes it:
 * a 26AS row whose tax deducted exceeds the tax deposited shows the deductor has not deposited (booking status O / U).
 */
function explain(u, zs, cs, s) {
  const tol = s.rounding_tol_p;
  const f = { zoho: u.z_amount, deducted: u.deducted, deposited: u.deposited, paid: u.paid };
  const base = zs.every(z => z.base && z.base.comparable !== null && z.base.comparable !== undefined) && zs.length ? zs.reduce((a, z) => a + z.base.comparable, 0) : null;
  const gross = zs.every(z => z.base && z.base.gross) && zs.length ? zs.reduce((a, z) => a + z.base.gross, 0) : null;
  f.base = base; f.gross = gross;
  f.rate_zoho = base ? pct(u.z_amount, base) : null; f.rate_26as = u.paid ? pct(u.deducted, u.paid) : null;
  if (u.status === 'rounding') return { code: 'rounding', text: `Rounding: ${fmtR(u.diff)} (within the ₹${tol / 100} tolerance)`, figures: f };
  if (!zs.length && cs.length) {
    if (u.status === 'not_in_zoho') return { code: 'not_in_zoho', text: `26AS shows ${fmtR(u.deposited)} deposited (deducted ${fmtR(u.deducted)}, amount paid ${fmtR(u.paid)}) by ${cs[0].deductor}; no Zoho TDS receivable entry for this client in the period`, figures: f };
    return null;
  }
  if (zs.length && !cs.length) {
    if (u.status === 'not_in_26as') return { code: 'not_in_26as', text: `Zoho books ${fmtR(u.z_amount)} TDS; the uploaded statement has no credit for this client's TAN(s) in the period that this entry could match`, figures: f };
    return null;
  }
  if (u.deducted - u.deposited > tol) {
    return { code: 'deducted_exceeds_deposited', text: `Tax deducted exceeds amount shown as deposited: deducted ${fmtR(u.deducted)}, deposited ${fmtR(u.deposited)} (gap ${fmtR(u.deducted - u.deposited)}; booking status ${[...new Set(cs.map(c => c.status))].join('/') || '—'})${Math.abs(u.z_amount - u.deducted) <= tol ? '; Zoho agrees with the amount deducted' : ''}`,
      figures: f, responsibility: 'Deductor — the statement shows the tax deducted was not fully deposited / matched' };
  }
  const bases = zs.flatMap(zBases);
  const basesAgree = baseAgrees(bases, u.paid, s);
  if (base === null && gross === null) return { code: 'insufficient', text: `Insufficient evidence: Zoho ${fmtR(u.z_amount)} vs 26AS ${fmtR(u.deposited)} (difference ${fmtR(u.diff)}); the Books base value is not available to tell whether the rate or the base differs`, figures: f };
  if (gross && baseAgrees([gross], u.paid, s) && !baseAgrees([base], u.paid, s)) return { code: 'base_gross', text: `Different taxable base: the client's amount paid ${fmtR(u.paid)} equals the gross invoice value incl. GST (${fmtR(gross)}), Zoho's base is ${fmtR(base)} — deducted at ${f.rate_26as}% on the gross value`, figures: f };
  if (basesAgree) {
    if (u.deducted < u.z_amount) return { code: 'short_deduction', text: `Possible short deduction by client: both bases ${fmtR(u.paid)}; client deducted ${fmtR(u.deducted)} (${f.rate_26as}%), Zoho books ${fmtR(u.z_amount)} (${f.rate_zoho}%)`, figures: f };
    return { code: 'short_booking', text: `Possible short booking in Zoho: client deducted ${fmtR(u.deducted)} (${f.rate_26as}%) on ${fmtR(u.paid)}; Zoho books ${fmtR(u.z_amount)} (${f.rate_zoho}%)`, figures: f };
  }
  if (f.rate_zoho !== null && f.rate_26as !== null && Math.abs(f.rate_zoho - f.rate_26as) <= 0.05) {
    const part = base && u.paid < base;
    return { code: part ? 'partial_base' : 'different_base', text: `${part ? '26AS covers part of the invoice value' : 'Different taxable base'}: 26AS amount paid ${fmtR(u.paid)} vs Zoho base ${fmtR(base)} at the same rate (${f.rate_26as}%)${part ? ' — check for a part payment, advance or credit note' : ''}`, figures: f };
  }
  return { code: 'amount_differs', text: `TDS differs: Zoho ${fmtR(u.z_amount)} on ${fmtR(base)} (${f.rate_zoho}%), 26AS deducted ${fmtR(u.deducted)} on ${fmtR(u.paid)} (${f.rate_26as}%)`, figures: f };
}

module.exports = { reconcile, explain, subsets, STATUS, METHOD, STATUS_ORDER, statusOf, baseAgrees };
