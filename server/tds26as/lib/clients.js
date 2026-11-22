/**
 * Client mapping, per entity: which Zoho customer(s) and which 26AS deductor TAN(s) are the same client.
 *
 * A client group holds one or more Zoho customers and one or more TANs (a client can deduct from several TANs, and the books can hold the
 * same client twice). Each customer and each TAN belongs to at most one group of the entity. Only approved groups are used for matching;
 * suggestions are shown for review:
 *   - "TAN on Zoho invoice"  the TAN the organisation records on the customer's invoices (DevX: cf_organization_tan_number) equals the
 *                            deductor's TAN in the statement
 *   - "similar name"         the deductor name and the customer name agree once legal suffixes and punctuation are ignored
 * A TAN can also be marked "no Zoho customer" (e.g. a deductor that never became a customer in the books) so its credits are reported as
 * "Not in Zoho Books" instead of waiting for a mapping.
 */

'use strict';

const store = require('./store');
const { TAN_RE, normTan, hashOf } = require('./util');

const key = entity => `clients_${entity}`;
const EMPTY = { groups: [], no_customer: {}, rejected: {} };
const load = async entity => ({ ...EMPTY, ...(await store.read(key(entity), EMPTY)) });

const STOP = new Set(['PRIVATE', 'PVT', 'LIMITED', 'LTD', 'LLP', 'THE', 'AND', 'CO', 'COMPANY', 'INDIA', 'OF', 'MS', 'M', 'S', 'INC', 'CORPORATION', 'CORP', 'P', 'L', 'OPC']);
const tokens = name => String(name || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
function similarity(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return 0;
  if (x.join('') === y.join('')) return 1;
  const sx = new Set(x), sy = new Set(y);
  const common = [...sx].filter(t => sy.has(t)).length;
  return (2 * common) / (sx.size + sy.size);
}

function index(doc) {
  const byCust = new Map(), byTan = new Map(), groups = new Map();
  for (const g of doc.groups || []) {
    groups.set(g.id, g);
    for (const c of g.customers) byCust.set(c.id, g.id);
    for (const t of g.tans) byTan.set(t.tan, g.id);
  }
  return { byCust, byTan, groups, noCustomer: new Set(Object.keys(doc.no_customer || {})) };
}

/** Suggestions for TANs of the statements that no group holds yet (and customers with Zoho entries) */
function suggestions(doc, items, credits) {
  const ix = index(doc);
  const customers = new Map();
  for (const z of items) if (z.customer_id) { const c = customers.get(z.customer_id) || customers.set(z.customer_id, { id: z.customer_id, name: z.customer_name, tans: new Set(), n: 0, amount: 0 }).get(z.customer_id); c.n++; c.amount += z.amount; z.tan_hints.forEach(t => c.tans.add(normTan(t))); }
  const deductors = new Map();
  for (const c of credits) { const d = deductors.get(c.tan) || deductors.set(c.tan, { tan: c.tan, name: c.deductor, n: 0, deducted: 0 }).get(c.tan); d.n++; d.deducted += c.deducted; }
  const out = [];
  for (const d of deductors.values()) {
    if (ix.byTan.has(d.tan) || ix.noCustomer.has(d.tan)) continue;
    const found = [];
    for (const c of customers.values()) {
      if ((doc.rejected || {})[`${c.id}|${d.tan}`]) continue;
      if (c.tans.has(d.tan)) found.push({ c, score: 1, basis: 'tan_field', detail: `Zoho records TAN ${d.tan} on this customer's invoices` });
      else { const sc = similarity(d.name, c.name); if (sc >= 0.75) found.push({ c, score: Math.round(sc * 100) / 100, basis: 'name', detail: `Names agree ${Math.round(sc * 100)} % once legal suffixes are ignored ("${d.name}" / "${c.name}")` }); }
    }
    found.sort((a, b) => b.score - a.score || (b.basis === 'tan_field') - (a.basis === 'tan_field'));
    for (const f of found.slice(0, 3)) out.push({ id: `s${hashOf(`${f.c.id}|${d.tan}`)}`, tan: d.tan, deductor: d.name, credits: d.n, deducted: d.deducted, customer_id: f.c.id, customer_name: f.c.name,
      zoho_entries: f.c.n, zoho_amount: f.c.amount, score: f.score, basis: f.basis, detail: f.detail, existing_group: ix.byCust.get(f.c.id) || null, competing: found.length > 1 });
  }
  const unmappedTans = [...deductors.values()].filter(d => !ix.byTan.has(d.tan) && !ix.noCustomer.has(d.tan));
  const unmappedCustomers = [...customers.values()].filter(c => !ix.byCust.has(c.id)).map(c => ({ id: c.id, name: c.name, entries: c.n, amount: c.amount, tans: [...c.tans] }));
  return { suggestions: out, unmapped_tans: unmappedTans, unmapped_customers: unmappedCustomers };
}

function validateGroups(groups) {
  const cust = new Map(), tan = new Map();
  for (const g of groups) {
    if (!g.name) throw Object.assign(new Error('A client group needs a name'), { status: 400 });
    if (!g.customers.length && !g.tans.length) throw Object.assign(new Error(`"${g.name}" has neither a customer nor a TAN`), { status: 400 });
    for (const c of g.customers) { if (cust.has(c.id)) throw Object.assign(new Error(`Zoho customer ${c.name || c.id} is in both "${cust.get(c.id)}" and "${g.name}"`), { status: 409 }); cust.set(c.id, g.name); }
    for (const t of g.tans) {
      if (!TAN_RE.test(t.tan)) throw Object.assign(new Error(`"${t.tan}" is not a valid TAN`), { status: 400 });
      if (tan.has(t.tan)) throw Object.assign(new Error(`TAN ${t.tan} is in both "${tan.get(t.tan)}" and "${g.name}"`), { status: 409 });
      tan.set(t.tan, g.name);
    }
  }
}

async function change(entity, by, fn) {
  return store.update(key(entity), EMPTY, doc => {
    const d = { ...EMPTY, ...doc };
    const before = JSON.stringify(d.groups);
    const out = fn(d);
    validateGroups(d.groups);
    d.history = [{ at: new Date().toISOString(), by, what: out && out.what ? out.what : 'changed', before_hash: hashOf(before) }, ...(d.history || [])].slice(0, 500);
    return { out, doc: d };
  });
}

/** Approve suggestions: the TAN joins the customer's group, or a new group named after the customer */
async function approve(entity, by, list) {
  return change(entity, by, d => {
    let n = 0;
    for (const s of list) {
      const tan = normTan(s.tan);
      if (d.groups.some(g => g.tans.some(t => t.tan === tan))) continue;
      const g = d.groups.find(x => x.customers.some(c => c.id === s.customer_id));
      if (g) g.tans.push({ tan, name: s.deductor || '', by, at: new Date().toISOString(), basis: s.basis || 'manual' });
      else d.groups.push({ id: `g${hashOf(`${s.customer_id}|${Date.now()}|${n}`)}`, name: s.customer_name || s.deductor || tan, customers: [{ id: s.customer_id, name: s.customer_name || '' }],
        tans: [{ tan, name: s.deductor || '', by, at: new Date().toISOString(), basis: s.basis || 'manual' }], by, at: new Date().toISOString() });
      n++;
    }
    return { what: `approved ${n} mapping(s)`, approved: n };
  });
}

/** Create or replace one group (manual edit) */
async function saveGroup(entity, by, g) {
  return change(entity, by, d => {
    const clean = { id: g.id && /^g[a-f0-9]{16}$/.test(g.id) ? g.id : `g${hashOf(`${g.name}|${Date.now()}`)}`, name: String(g.name || '').trim().slice(0, 120),
      customers: (g.customers || []).map(c => ({ id: String(c.id), name: String(c.name || '').slice(0, 160) })).filter(c => c.id),
      tans: (g.tans || []).map(t => ({ tan: normTan(t.tan), name: String(t.name || '').slice(0, 160), by, at: new Date().toISOString(), basis: t.basis || 'manual' })).filter(t => t.tan),
      by, at: new Date().toISOString(), note: String(g.note || '').slice(0, 500) };
    const i = d.groups.findIndex(x => x.id === clean.id);
    if (i >= 0) d.groups[i] = clean; else d.groups.push(clean);
    for (const t of clean.tans) delete d.no_customer[t.tan];
    return { what: `${i >= 0 ? 'updated' : 'created'} client "${clean.name}"`, group: clean };
  });
}
async function removeGroup(entity, by, id) { return change(entity, by, d => { const g = d.groups.find(x => x.id === id); d.groups = d.groups.filter(x => x.id !== id); return { what: `removed client "${g ? g.name : id}"` }; }); }
async function noCustomer(entity, by, tan, on, note = '') {
  return change(entity, by, d => { const t = normTan(tan); if (!TAN_RE.test(t)) throw Object.assign(new Error('Not a valid TAN'), { status: 400 }); if (on) d.no_customer[t] = { by, at: new Date().toISOString(), note: String(note).slice(0, 300) }; else delete d.no_customer[t]; return { what: `${on ? 'marked' : 'unmarked'} ${t} as having no Zoho customer` }; });
}
async function reject(entity, by, customerId, tan) { return change(entity, by, d => { d.rejected[`${customerId}|${normTan(tan)}`] = { by, at: new Date().toISOString() }; return { what: `rejected suggestion ${customerId} ↔ ${tan}` }; }); }

module.exports = { load, index, suggestions, approve, saveGroup, removeGroup, noCustomer, reject, similarity, tokens };
