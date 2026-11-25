/**
 * Review decisions, reviewer links, client owners and the carry-forward register — per entity.
 *
 *   review_<entity>  { items: { <entry or credit key>: decision }, links: [...], clients: { <group id>: { owner, remarks, … } } }
 *   cf_<entity>      { items: [ carry-forward item ] }
 *
 * A decision keeps the system status it was taken against, who took it and when, and every change in `history` (never overwritten).
 * "Confirmed non-deposit" can only be recorded with evidence (a description and at least one reference or attachment).
 *
 * A whole-client decision (Client totals tab) writes the same per-entry decision for every item of the client(s) — see decideClients.
 *
 * Carry Forward: a reviewer approves an open amount for tracking into a later quarter / financial year (origin entries, balance, target
 * period and reason are captured). When a credit (or a later Books entry) of the same client and amount appears from the target period
 * on, the reconciliation links it to the item and closes the balance — once: a settled item and its credit cannot be used again. A
 * reviewer can also close an item with a reason (e.g. written off). The original period's decision and history stay as they were.
 */

'use strict';

const store = require('./store');
const PER = require('./periods');
const { STATUS } = require('./match');
const { hashOf, uid } = require('./util');

const rKey = e => `review_${e}`, cfKey = e => `cf_${e}`;
const EMPTY = { items: {}, links: [], clients: {} };
const load = async e => ({ ...EMPTY, ...(await store.read(rKey(e), EMPTY)) });
const loadCf = async e => ({ items: [], ...(await store.read(cfKey(e), { items: [] })) });

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const cleanRefs = refs => (Array.isArray(refs) ? refs : String(refs || '').split('\n')).map(r => String(r).trim()).filter(Boolean).slice(0, 20).map(r => r.slice(0, 300));

/** A target period as typed: "2026-27-Q1" or "2026-27" (= its first quarter) */
function targetQuarter(t) {
  if (PER.parseQ(t)) return t;
  if (PER.isFy(t)) return `${t}-Q1`;
  return null;
}

/**
 * Decision on a unit's entries. unit = the unit as computed now ({ id, status, zoho, credits, open_zoho, open_26as, group, client, date }).
 * body: { final_status, remarks, refs, attachments, carry_forward: { target, reason }, non_deposit: { evidence } }
 */
async function decide(entity, by, unit, body, period) {
  const fs = body.final_status === '' || body.final_status === null || body.final_status === undefined ? '' : String(body.final_status);
  if (fs && !STATUS[fs]) throw bad(`Unknown status "${fs}"`);
  const remarks = String(body.remarks ?? '').slice(0, 2000);
  const refs = cleanRefs(body.refs);
  const attachments = (body.attachments || []).filter(a => a && /^[a-f0-9]{64}$/.test(a.sha256)).map(a => ({ sha256: a.sha256, name: String(a.name || '').slice(0, 200), size: Number(a.size) || 0, by: a.by || by, at: a.at || new Date().toISOString() }));
  const keys = [...unit.zoho, ...unit.credits];
  if (!keys.length) throw bad('Nothing to review');
  let cfItem = null;
  if (fs === 'carry_forward') {
    const cf = body.carry_forward || {};
    const origin = PER.quarterOf(unit.date || period.from);
    const target = targetQuarter(String(cf.target || ''));
    if (!target) throw bad('Choose the quarter or financial year to carry the amount forward to');
    if (PER.cmpQ(target, origin) <= 0) throw bad(`The target period must be after ${PER.qLabel(origin)}`);
    if (!String(cf.reason || '').trim()) throw bad('Give the reason for carrying the amount forward');
    const side = unit.open_zoho > 0 ? 'zoho' : unit.open_26as > 0 ? '26as' : null;
    if (!side) throw bad('This item has no open balance to carry forward');
    cfItem = { id: uid('cf'), side, origin_quarter: origin, period: { from: period.from, to: period.to }, unit_id: unit.id, keys: { zoho: unit.zoho, credits: unit.credits }, group: unit.group, client: unit.client,
      balance: side === 'zoho' ? unit.open_zoho : unit.open_26as, target_quarter: target, reason: String(cf.reason).trim().slice(0, 1000), by, at: new Date().toISOString(), status: 'open', settlement: null, closure: null, history: [] };
  }
  let nonDeposit = null;
  if (body.non_deposit) {
    const ev = String(body.non_deposit.evidence || '').trim();
    if (!ev || (!refs.length && !attachments.length)) throw bad('Confirmed non-deposit needs the evidence described and at least one reference or attachment (e.g. the client\'s written confirmation)');
    nonDeposit = { evidence: ev.slice(0, 2000), by, at: new Date().toISOString() };
  }
  const out = await store.update(rKey(entity), EMPTY, doc => {
    const d = { ...EMPTY, ...doc };
    for (const k of keys) {
      const prev = d.items[k] || { history: [] };
      const next = { ...prev, final_status: fs, remarks, refs, attachments: [...(prev.attachments || []).filter(a => !attachments.some(b => b.sha256 === a.sha256)), ...attachments],
        non_deposit: body.non_deposit === undefined ? prev.non_deposit || null : nonDeposit, system_status: unit.status, unit_id: unit.id, unit_keys: keys, by, at: new Date().toISOString(), cf_id: cfItem ? cfItem.id : (fs === 'carry_forward' ? prev.cf_id : null) };
      next.history = [...(prev.history || []), { at: next.at, by, system_status: unit.status, final_status: fs, remarks, refs, non_deposit: !!next.non_deposit, cf: cfItem ? `${cfItem.balance} → ${cfItem.target_quarter}` : undefined }].slice(-100);
      d.items[k] = next;
    }
    return { out: { saved: keys.length }, doc: d };
  });
  // carry-forward register: a new item replaces an OPEN one of the same unit; leaving Carry Forward cancels an open one
  await store.update(cfKey(entity), { items: [] }, doc => {
    for (const it of doc.items) {
      if (it.status !== 'open') continue;
      const sameUnit = it.unit_id === unit.id || it.keys.zoho.concat(it.keys.credits).some(k => keys.includes(k));
      if (sameUnit && (cfItem || fs !== 'carry_forward')) { it.status = 'cancelled'; it.history.push({ at: new Date().toISOString(), by, what: cfItem ? 'replaced by a new carry-forward' : `final status changed to ${STATUS[fs] || 'system status'}` }); }
    }
    if (cfItem) doc.items.push(cfItem);
  });
  return { ...out, carry_forward: cfItem };
}

/**
 * Whole-client decision (24 Nov 2026, Client totals tab): one final status + remarks for every item of one or more clients in a period.
 * Each entry / credit gets the same decision record as a single review (history kept, marked whole_client). Items a reviewer carried
 * forward are left as they are (their carry-forward item stays open); "Confirmed non-deposit" marks are kept. Per client a record of the
 * decision with the period and its totals is kept in client_decisions (last 50).
 * clients: [{ id, client, zoho, deposited, diff, units: [unit as computed now] }]   body: { final_status, remarks, refs, attachments }
 */
async function decideClients(entity, by, clients, body, period) {
  const fs = body.final_status === '' || body.final_status === null || body.final_status === undefined ? '' : String(body.final_status);
  if (fs && !STATUS[fs]) throw bad(`Unknown status "${fs}"`);
  if (fs === 'carry_forward') throw bad('Carry Forward is set item by item (it needs the open balance and the quarter to carry it to)');
  const remarks = String(body.remarks ?? '').trim().slice(0, 2000);
  if (fs && !remarks) throw bad('Write the remarks for this decision — they are kept with every item of the client');
  const refs = cleanRefs(body.refs);
  const attachments = (body.attachments || []).filter(a => a && /^[a-f0-9]{64}$/.test(a.sha256)).map(a => ({ sha256: a.sha256, name: String(a.name || '').slice(0, 200), size: Number(a.size) || 0, by: a.by || by, at: a.at || new Date().toISOString() }));
  if (!clients.length) throw bad('Choose at least one client');
  const at = new Date().toISOString();
  const tally = { clients: clients.length, units: 0, keys: 0, skipped_carry_forward: 0 };
  await store.update(rKey(entity), EMPTY, doc => {
    const d = { ...EMPTY, ...doc };
    d.client_decisions = { ...(d.client_decisions || {}) };
    for (const cl of clients) {
      let n = 0;
      for (const u of cl.units) {
        if (u.final_status === 'carry_forward') { tally.skipped_carry_forward += 1; continue; }
        const keys = [...u.zoho, ...u.credits];
        for (const k of keys) {
          const prev = d.items[k] || { history: [] };
          const next = { ...prev, final_status: fs, remarks, refs, attachments: [...(prev.attachments || []).filter(a => !attachments.some(b => b.sha256 === a.sha256)), ...attachments],
            non_deposit: prev.non_deposit || null, system_status: u.status, unit_id: u.id, unit_keys: keys, by, at, cf_id: null, whole_client: cl.id };
          next.history = [...(prev.history || []), { at, by, system_status: u.status, final_status: fs, remarks, refs, non_deposit: !!next.non_deposit, whole_client: true }].slice(-100);
          d.items[k] = next;
          tally.keys += 1;
        }
        n += 1;
      }
      tally.units += n;
      const rec = { at, by, final_status: fs, remarks, refs, period: { from: period.from, to: period.to, label: period.label || '' }, items: n, zoho: cl.zoho, deposited: cl.deposited, diff: cl.diff, client: cl.client };
      d.client_decisions[cl.id] = [...(d.client_decisions[cl.id] || []), rec].slice(-50);
    }
    return { out: null, doc: d };
  });
  return tally;
}

/**
 * Several timing differences carried forward at once (25 Nov 2026, Carry forward tab). picks: [{ unit (as computed now), target }].
 * Each item gets the same record as a single "Carry Forward" review (decision on every entry / credit, a carry-forward item with origin,
 * balance, target and reason); an open carry-forward item of the same unit is replaced. Written in one update of each store.
 */
async function carryForwardMany(entity, by, picks, body, period) {
  const reason = String(body.reason || '').trim().slice(0, 1000);
  if (!reason) throw bad('Give the reason for carrying the amounts forward');
  if (!picks.length) throw bad('Choose at least one item');
  const remarks = String(body.remarks ?? '').trim().slice(0, 2000) || reason;
  const refs = cleanRefs(body.refs);
  const at = new Date().toISOString();
  const made = picks.map(({ unit, target }) => {
    const origin = PER.quarterOf(unit.date || period.from);
    const tq = targetQuarter(String(target || ''));
    if (!tq || PER.cmpQ(tq, origin) <= 0) throw bad(`${unit.client}: the target period must be after ${PER.qLabel(origin)}`);
    const side = unit.open_zoho > 0 ? 'zoho' : unit.open_26as > 0 ? '26as' : null;
    if (!side) throw bad(`${unit.client}: this item has no open balance to carry forward`);
    return { unit, cf: { id: uid('cf'), side, origin_quarter: origin, period: { from: period.from, to: period.to }, unit_id: unit.id, keys: { zoho: unit.zoho, credits: unit.credits }, group: unit.group, client: unit.client,
      balance: side === 'zoho' ? unit.open_zoho : unit.open_26as, target_quarter: tq, reason, by, at, status: 'open', settlement: null, closure: null, history: [], bulk: true } };
  });
  await store.update(rKey(entity), EMPTY, doc => {
    const d = { ...EMPTY, ...doc };
    for (const { unit, cf } of made) {
      const keys = [...unit.zoho, ...unit.credits];
      for (const k of keys) {
        const prev = d.items[k] || { history: [] };
        const next = { ...prev, final_status: 'carry_forward', remarks, refs, attachments: prev.attachments || [], non_deposit: prev.non_deposit || null, system_status: unit.status, unit_id: unit.id, unit_keys: keys, by, at, cf_id: cf.id };
        next.history = [...(prev.history || []), { at, by, system_status: unit.status, final_status: 'carry_forward', remarks, refs, non_deposit: !!next.non_deposit, cf: `${cf.balance} → ${cf.target_quarter}`, bulk_cf: true }].slice(-100);
        d.items[k] = next;
      }
    }
    return { out: null, doc: d };
  });
  await store.update(cfKey(entity), { items: [] }, doc => {
    for (const { unit } of made) {
      const keys = [...unit.zoho, ...unit.credits];
      for (const it of doc.items) {
        if (it.status !== 'open' || !(it.unit_id === unit.id || it.keys.zoho.concat(it.keys.credits).some(k => keys.includes(k)))) continue;
        it.status = 'cancelled'; it.history.push({ at, by, what: 'replaced by a new carry-forward' });
      }
    }
    doc.items.push(...made.map(x => x.cf));
  });
  return { saved: made.length, items: made.map(x => x.cf) };
}

async function link(entity, by, zoho, credits, note) {
  if (!zoho.length || !credits.length) throw bad('Choose at least one Zoho entry and one 26AS credit');
  return store.update(rKey(entity), EMPTY, doc => {
    const d = { ...EMPTY, ...doc };
    const all = new Set([...zoho, ...credits]);
    if (d.links.some(l => [...l.zoho, ...l.credits].some(k => all.has(k)))) throw bad('One of these is already in another reviewer link — unlink it first', 409);
    const l = { id: `l${hashOf([...zoho, ...credits].join(','))}`, zoho, credits, by, at: new Date().toISOString(), note: String(note || '').slice(0, 500) };
    d.links.push(l);
    return { out: l, doc: d };
  });
}
async function unlink(entity, by, id) {
  return store.update(rKey(entity), EMPTY, doc => { const d = { ...EMPTY, ...doc }; const n = d.links.length; d.links = d.links.filter(l => l.id !== id); if (n === d.links.length) throw bad('Link not found', 404); return { out: { removed: 1 }, doc: d }; });
}

async function setClient(entity, by, groupId, { owner_id, owner, remarks }) {
  return store.update(rKey(entity), EMPTY, doc => {
    const d = { ...EMPTY, ...doc };
    const prev = d.clients[groupId] || { history: [] };
    const next = { owner_id: owner_id === undefined ? prev.owner_id || '' : String(owner_id || ''), owner: owner === undefined ? prev.owner || '' : String(owner || '').slice(0, 120),
      remarks: remarks === undefined ? prev.remarks || '' : String(remarks || '').slice(0, 2000), by, at: new Date().toISOString() };
    next.history = [...(prev.history || []), { at: next.at, by, owner: next.owner, remarks: next.remarks }].slice(-100);
    d.clients[groupId] = next;
    return { out: next, doc: d };
  });
}

async function closeCf(entity, by, id, { reason, evidence, quarter }) {
  if (!String(reason || '').trim()) throw bad('Give the reason for closing the carried-forward balance');
  return store.update(cfKey(entity), { items: [] }, doc => {
    const it = doc.items.find(x => x.id === id);
    if (!it) throw bad('Carry-forward item not found', 404);
    if (it.status !== 'open') throw bad(`This item is already ${it.status}`, 409);
    const q = quarter && PER.parseQ(quarter) ? quarter : PER.quarterOf(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10));
    it.status = 'closed';
    it.closure = { by, at: new Date().toISOString(), reason: String(reason).trim().slice(0, 1000), evidence: cleanRefs(evidence), quarter: q };
    it.history.push({ at: it.closure.at, by, what: `closed by reviewer in ${PER.qLabel(q)}: ${it.closure.reason}` });
    return { out: it, doc };
  });
}

/** Persist automatic settlements found by the reconciliation (each item settled once; its credits / entries then belong to it) */
async function settle(entity, found) {
  if (!found.length) return [];
  return store.update(cfKey(entity), { items: [] }, doc => {
    const done = [];
    const taken = new Set(doc.items.filter(x => x.status === 'settled' && x.settlement).flatMap(x => x.settlement.keys));
    for (const f of found) {
      const it = doc.items.find(x => x.id === f.cf_id);
      if (!it || it.status !== 'open' || f.keys.some(k => taken.has(k))) continue;
      it.status = 'settled';
      it.settlement = { keys: f.keys, quarter: f.quarter, amount: f.amount, diff: f.diff, at: new Date().toISOString(), auto: true, detail: f.detail };
      it.history.push({ at: it.settlement.at, by: 'reconciliation', what: `settled in ${PER.qLabel(f.quarter)} by ${f.detail}` });
      f.keys.forEach(k => taken.add(k));
      done.push(it);
    }
    return { out: done, doc };
  });
}
/** A settlement whose credit / entry no longer exists (a revised statement removed it) is reopened, with the reason kept */
async function reopenMissing(entity, existingKeys) {
  const gone = it => it.status === 'settled' && it.settlement && !it.settlement.keys.every(k => existingKeys.has(k));
  if (!(await loadCf(entity)).items.some(gone)) return [];
  return store.update(cfKey(entity), { items: [] }, doc => {
    const out = [];
    for (const it of doc.items) {
      if (!gone(it)) continue;
      it.history.push({ at: new Date().toISOString(), by: 'reconciliation', what: `reopened: the ${it.side === 'zoho' ? '26AS credit' : 'Zoho entry'} that settled it is no longer in the data (revised statement or Zoho change)` });
      it.status = 'open'; it.settlement = null; out.push(it.id);
    }
    return { out, doc };
  });
}

module.exports = { load, loadCf, decide, decideClients, carryForwardMany, link, unlink, setClient, closeCf, settle, reopenMissing, targetQuarter };
