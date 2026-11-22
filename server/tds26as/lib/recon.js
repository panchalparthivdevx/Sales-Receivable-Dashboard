/**
 * The reconciliation for one entity and period: loads the entity's Books entries, active 26AS credits, client mapping, review decisions
 * and carry-forward register, runs lib/match.js and lays the review decisions over the system statuses.
 * Nothing here is shared between entities — every read is keyed by the entity id.
 */

'use strict';

const PER = require('./periods');
const ST = require('./statements');
const BM = require('./booksModel');
const CL = require('./clients');
const RV = require('./review');
const M = require('./match');
const { subsets } = require('./match');

function create({ sync, cfgNow }) {
  const memo = new Map();
  let stamp = 0;
  const bump = () => { stamp++; memo.clear(); };

  async function load(entity) {
    const k = `load|${entity.id}|${stamp}`;
    if (memo.has(k) && Date.now() - memo.get(k).at < 20000) return memo.get(k).v;
    const cfg = await cfgNow();
    const [rows, docs, credits, clientsDoc, review, cf, stmts, syncState] = await Promise.all([
      sync.ledgerRows(entity.id), sync.docs(entity.id), ST.activeCredits(entity.id), CL.load(entity.id), RV.load(entity.id), RV.loadCf(entity.id), ST.coverage(entity.id), sync.status(entity.id)]);
    const central = await sync.centralFor(entity, 'invoices_fy');
    const books = BM.build({ entity, rows, docs, centralInvoices: central ? central.data : [] });
    // section aliases apply at read time too, so a new alias needs no re-import
    for (const c of credits) { const fam = require('./config').sectionFamily(c.section_raw, cfg.settings.section_aliases); if (fam) c.section = fam; }
    const v = { entity, settings: cfg.settings, books, items: books.items, credits, clientsDoc, clients: CL.index(clientsDoc), review, cf, statements: stmts, sync: syncState,
      zohoMonths: new Set(Object.keys(syncState.listed || {})), docs };
    memo.set(k, { at: Date.now(), v });
    return v;
  }

  function consumed(cf, items, credits) {
    const zk = new Set(items.map(i => i.key)), ck = new Set(credits.map(c => c.key));
    const m = new Map();
    for (const it of cf.items) {
      if (it.status !== 'settled' || !it.settlement) continue;
      it.settlement.keys.forEach((key, i) => {
        if (!zk.has(key) && !ck.has(key)) return;
        m.set(key, { cf_id: it.id, origin_quarter: it.origin_quarter, balance: it.balance, diff: i === 0 ? it.settlement.diff : 0, client: it.client, origin_keys: [...it.keys.zoho, ...it.keys.credits] });
      });
    }
    return m;
  }

  function compute(d, period) {
    const res = M.reconcile({ entity: d.entity, period, items: d.items, credits: d.credits, clients: d.clients, links: d.review.links, cfConsumed: consumed(d.cf, d.items, d.credits),
      coverage: { zohoMonths: d.zohoMonths, statements: d.statements }, settings: d.settings });
    const dec = d.review.items;
    for (const u of res.units) {
      const ds = [...u.zoho, ...u.credits].map(k => dec[k]).filter(Boolean);
      const finals = [...new Set([...u.zoho, ...u.credits].map(k => (dec[k] && dec[k].final_status) || ''))];
      u.final_status = finals.length === 1 ? finals[0] : '';
      u.mixed_decisions = finals.length > 1;
      const latest = ds.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
      u.decision = latest ? { by: latest.by, at: latest.at, remarks: latest.remarks, refs: latest.refs, attachments: latest.attachments || [], non_deposit: latest.non_deposit || null, system_status: latest.system_status, cf_id: latest.cf_id || null,
        stale: latest.unit_id && latest.unit_id !== u.id } : null;
      u.effective = u.final_status || u.status;
      const cfi = d.cf.items.find(x => x.status !== 'cancelled' && (x.unit_id === u.id || [...x.keys.zoho, ...x.keys.credits].some(k => u.zoho.includes(k) || u.credits.includes(k))));
      if (cfi && !u.cf) u.cf_item = { id: cfi.id, status: cfi.status, balance: cfi.balance, target_quarter: cfi.target_quarter, settlement: cfi.settlement, closure: cfi.closure };
    }
    return res;
  }

  async function run(entity, period) {
    const d = await load(entity);
    const k = `run|${entity.id}|${period.from}|${period.to}|${stamp}`;
    if (memo.has(k) && Date.now() - memo.get(k).at < 20000) return { d, res: memo.get(k).v };
    const res = compute(d, period);
    memo.set(k, { at: Date.now(), v: res });
    return { d, res };
  }

  /** Carry-forward items still open → the first later quarter (from their target) where a credit / entry of the same client and amount is still unmatched */
  async function settlePass(entity) {
    let d = await load(entity);
    await RV.reopenMissing(entity.id, new Set([...d.items.map(i => i.key), ...d.credits.map(c => c.key)]));
    bump(); d = await load(entity);
    const tol = d.settings.rounding_tol_p;
    const open = d.cf.items.filter(x => x.status === 'open').sort((a, b) => a.at.localeCompare(b.at));
    if (!open.length) return [];
    const lastQ = [...d.credits.map(c => c.txn_date), ...d.items.map(i => i.date)].filter(Boolean).sort().pop();
    if (!lastQ) return [];
    const found = [], taken = new Set(), settled = new Set();
    const zBy = new Map(d.items.map(i => [i.key, i])), cBy = new Map(d.credits.map(c => [c.key, c]));
    const firstQ = open.map(x => x.target_quarter).sort()[0];
    // each quarter is reconciled ONCE per pass; the items whose target has been reached take what is still free there, oldest item first
    for (let q = firstQ; PER.cmpQ(q, PER.quarterOf(lastQ)) <= 0; q = PER.nextQuarter(q)) {
      const due = open.filter(it => !settled.has(it.id) && PER.cmpQ(it.target_quarter, q) <= 0);
      if (!due.length) continue;
      const p = PER.parseQ(q), period = PER.quarterRange(p.fy, p.q);
      const res = compute(d, period);
      for (const it of due) {
        const free = u => u.group === it.group && (['not_in_zoho', 'not_in_26as'].includes(u.status) || (u.status === 'need_check' && u.reason && ['timing', 'coverage_26as', 'coverage_zoho'].includes(u.reason.code)));
        let pick = null;
        if (it.side === 'zoho') {
          const pool = res.units.filter(u => free(u) && !u.zoho.length && u.credits.length === 1).map(u => cBy.get(u.credits[0])).filter(c => !taken.has(c.key));
          const one = pool.filter(c => Math.abs(c.deposited - it.balance) <= tol || Math.abs(c.deducted - it.balance) <= tol);
          if (one.length === 1) pick = [one[0]];
          else if (!one.length) { const sols = subsets(pool, c => c.deposited || c.deducted, [it.balance], tol, d.settings.max_subset); if (sols.length === 1) pick = sols[0]; }
          if (pick) { const dep = pick.reduce((a, c) => a + c.deposited, 0); found.push({ cf_id: it.id, keys: pick.map(c => c.key), quarter: q, amount: dep, diff: it.balance - dep, detail: `${pick.length} 26AS credit(s) dated ${pick.map(c => c.txn_date).join(', ')} (${pick[0].deductor})` }); }
        } else {
          const pool = res.units.filter(u => free(u) && !u.credits.length && u.zoho.length === 1).map(u => zBy.get(u.zoho[0])).filter(z => !taken.has(z.key) && z.amount > 0);
          const one = pool.filter(z => Math.abs(z.amount - it.balance) <= tol);
          if (one.length === 1) { pick = one; found.push({ cf_id: it.id, keys: [one[0].key], quarter: q, amount: one[0].amount, diff: one[0].amount - it.balance, detail: `Zoho ${one[0].type_label.toLowerCase()} ${one[0].number || ''} dated ${one[0].date}` }); }
        }
        if (pick) { pick.forEach(x => taken.add(x.key)); settled.add(it.id); }
      }
    }
    const done = await RV.settle(entity.id, found);
    bump();
    return done;
  }

  return { load, run, compute, settlePass, bump };
}

module.exports = { create };
