/**
 * Client mapping, per entity: which Zoho customer(s) and which 26AS deductor TAN(s) are the same client.
 *
 * THE TAN DECIDES THE CLIENT (23 Nov 2026). Form 26AS lists a client once, under its TAN; the books may hold the same client as several
 * customers (one per branch, names slightly different) that all record that TAN on their invoices (DevX: cf_organization_tan_number).
 * So every Zoho entry gets its client from the TAN, without a reviewer mapping each customer:
 *   1  the TAN on the entry's own invoice, when a client group holds it or an uploaded statement has credits from it
 *   2  else the customer's client group (approved by a reviewer)
 *   3  else the one known TAN the customer records on its other invoices (entries without an invoice TAN: credit notes, some journals)
 *   4  else that TAN although no statement has it yet — a client of its own, whose entries become "Not in 26AS" once a statement covers
 *      the date (often a wrong TAN on the invoice; the corrections report says so)
 *   otherwise the entry is "not mapped" (no TAN on the customer's invoices, or several).
 * A TAN no group holds is an automatic client `tan:<TAN>`, named after the deductor in the statement.
 *
 * Client groups (approved by a reviewer) stay for what the TAN cannot tell: a client that deducts from several TANs, or customers whose
 * invoices carry no TAN. A group holds Zoho customers and TANs; each customer and each TAN belongs to at most one group. Suggestions for
 * statement TANs that no Zoho invoice records ("similar name": deductor and customer names agree once legal suffixes and punctuation are
 * ignored) wait for a reviewer. Reviewer decisions come first: a TAN in a group belongs to that group, a rejected customer ↔ TAN pair is
 * never used, and a TAN marked "no Zoho customer" (a deductor that never became a customer) gets no automatic client — its credits are
 * reported as "Not in Zoho Books" instead of waiting for a mapping.
 *
 * JOURNALS WITHOUT A CUSTOMER (25 Nov 2026): TDS booked by journal for a bank's fixed deposit, interest on a loan given, or a client the
 * journal does not name as a customer. Their client is found, in this order, from (1) the deductor a reviewer chose for the journal,
 * (2) the TAN on the invoice(s) its Reference number / Notes name, (3) a TAN written there, (4) the name of a Form 26AS deductor (or of
 * a client group, or of a Zoho customer with one known TAN) written there — all the name's words, the name as a phrase ("Bank of
 * India"), or its initials ("SBI"); when no name fits fully, one distinctive word that only one name has ("Kotak"). Equally good
 * fits for different clients identify nothing (the candidates are listed). A TAN marked "no Zoho customer" (a bank) is used too: the
 * mark says no customer exists, and a journal is exactly how such TDS is booked.
 */

'use strict';

const store = require('./store');
const { TAN_RE, normTan, hashOf } = require('./util');

const key = entity => `clients_${entity}`;
const EMPTY = { groups: [], no_customer: {}, rejected: {}, journal_tans: {} };
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

// words that say nothing about WHO deducted: a name made only of them must be written in full
const GENERIC = new Set(['BANK', 'SERVICES', 'SERVICE', 'SOLUTIONS', 'SOLUTION', 'TECHNOLOGIES', 'TECHNOLOGY', 'TECH', 'SYSTEMS', 'SOFTWARE', 'CONSULTING', 'CONSULTANCY',
  'CONSULTANTS', 'ENTERPRISES', 'ENTERPRISE', 'INDUSTRIES', 'GLOBAL', 'INTERNATIONAL', 'GROUP', 'HOLDINGS', 'VENTURES', 'TRADING', 'TRADERS', 'FINANCE', 'FINANCIAL',
  'CAPITAL', 'INVESTMENTS', 'INVESTMENT', 'MANAGEMENT', 'ASSET', 'ASSETS', 'INFRA', 'INFRASTRUCTURE', 'ENGINEERING', 'ENGINEERS', 'PROJECTS', 'DEVELOPERS', 'REALTY',
  'CONSTRUCTION', 'CONSTRUCTIONS', 'HEALTHCARE', 'PHARMA', 'LABS', 'DIGITAL', 'MEDIA', 'NETWORKS', 'LOGISTICS', 'BRANCH', 'OFFICE', 'INTEREST', 'LOAN', 'DEPOSIT',
  'FIXED', 'INCOME', 'RECEIVABLE', 'INVOICE', 'ASSOCIATES', 'PARTNERS', 'BUSINESS', 'MARKETING', 'EDUCATION', 'FOUNDATION', 'TRUST', 'SOCIETY', 'INSURANCE', 'LIFE',
  'GENERAL', 'OPERATIVE', 'COOPERATIVE', 'NATIONAL', 'STATE', 'CENTRAL', 'UNITED', 'INDIAN', 'ASIA', 'WORLD', 'DATA', 'CLOUD', 'INFO', 'INFOTECH', 'ENERGY', 'POWER',
  'EXPORTS', 'IMPORTS', 'OVERSEAS', 'CORPORATE', 'SALES', 'RETAIL', 'MUMBAI', 'DELHI', 'AHMEDABAD', 'GUJARAT', 'BANGALORE', 'BENGALURU', 'PUNE', 'HYDERABAD', 'CHENNAI',
  'KOLKATA', 'NOIDA', 'GURGAON', 'GURUGRAM', 'JAIPUR', 'INDORE', 'BOOKED', 'AGAINST', 'BEING', 'RECEIVED', 'DEDUCTED', 'PAYMENT', 'QUARTER', 'PERIOD']);
// narration words that are never a deductor's initials ("TDS on FD interest")
const NARRATION = new Set(['TDS', 'GST', 'INV', 'FD', 'FDR', 'FDS', 'AY', 'FY', 'QTR', 'REF', 'AMT', 'INT', 'JV', 'JR', 'RS', 'INR', 'DT', 'NO', 'PER', 'ACC', 'TAN', 'PAN', 'THE', 'AND', 'FOR']);
const LEGAL = new Set(['PRIVATE', 'PVT', 'LIMITED', 'LTD', 'LLP', 'THE', 'MS', 'M', 'S', 'P', 'L', 'OPC', 'INC', 'CO', 'COMPANY']);
const words = s => String(s || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

/** cands: [{ tan, key (the client it means), name }] → text → { tan, key, name, words, basis } | { candidates } | null (see the header) */
function nameFinder(cands) {
  const prep = cands.map(c => {
    const w = words(c.name).filter(x => !LEGAL.has(x));
    const tok = tokens(c.name).filter(t => t.length >= 2);
    const acr = [...new Set([w.map(x => x[0]).join(''), w.filter(x => x !== 'OF' && x !== 'AND').map(x => x[0]).join('')])].filter(a => a.length >= 3 && !NARRATION.has(a));
    return { ...c, w, tok, acr };
  }).filter(c => c.w.length && c.tok.length);
  const uses = new Map();                              // word → the clients whose names have it
  for (const c of prep) for (const t of new Set(c.tok)) (uses.get(t) || uses.set(t, new Set()).get(t)).add(c.key);
  const telling = t => t.length >= 4 && !GENERIC.has(t) && !NARRATION.has(t);
  return text => {
    const tw = words(text), set = new Set(tw), line = ` ${tw.join(' ')} `;
    const best = new Map(), weak = new Map(), loose = new Map();
    const put = (m, c, score, ws, basis) => { const b = m.get(c.key); if (!b || score > b.score) m.set(c.key, { tan: c.tan, key: c.key, name: c.name, score, words: ws, basis }); };
    for (const c of prep) {
      if (c.w.length >= 2 && line.includes(` ${c.w.join(' ')} `)) put(best, c, c.w.length + 0.5, [c.w.join(' ')], 'journal_name');
      else if (c.tok.every(t => set.has(t)) && (c.tok.length >= 2 || !GENERIC.has(c.tok[0])) && c.tok.some(t => t.length >= 3)) put(best, c, c.tok.length, c.tok, 'journal_name');
      else { const a = c.acr.find(x => set.has(x)); if (a) put(best, c, 1.5, [a], 'journal_initials'); }
      const hit = c.tok.filter(t => telling(t) && set.has(t));
      if (hit.length) { put(loose, c, hit.length, hit, 'journal_word'); const own = hit.filter(t => uses.get(t).size === 1); if (own.length) put(weak, c, own.length, own, 'journal_word'); }
    }
    const pick = m => { const all = [...m.values()]; const top = Math.max(...all.map(x => x.score)); return all.filter(x => x.score === top); };
    if (best.size) { const top = pick(best); return top.length === 1 ? top[0] : { candidates: top }; }
    if (weak.size === 1) return [...weak.values()][0];
    const many = [...(weak.size ? weak : loose).values()];
    return many.length > 1 && many.length <= 8 ? { candidates: many } : null;
  };
}

const AUTO = 'tan:';
const isAuto = id => String(id || '').startsWith(AUTO);

/**
 * The effective mapping used by matching. items: all Zoho entries of the entity; credits: all active 26AS credits; invoices: the invoices
 * fetched in detail ({ id: { cust, cust_name, tan } }) — a customer's TANs are learned from them and from its entries' invoices.
 * Returns byTan (TAN → client), byEntry (entry key → client), entryInfo / entry(z) (how the client was found), byCust (approved groups
 * only), groups (approved + automatic; tan_customers = the customers the TAN rule placed in a group beyond its own list), noCustomer.
 */
function index(doc, { items = [], credits = [], invoices = {} } = {}) {
  const rejected = doc.rejected || {};
  const noCustomer = new Set(Object.keys(doc.no_customer || {}));
  const byCust = new Map(), byTan = new Map(), groups = new Map();
  for (const g of doc.groups || []) {
    groups.set(g.id, { ...g, auto: false, tan_customers: [] });
    for (const c of g.customers) byCust.set(c.id, g.id);
    for (const t of g.tans) byTan.set(t.tan, g.id);
  }
  const deductor = new Map();
  for (const c of credits) { const m = deductor.get(c.tan) || deductor.set(c.tan, new Map()).get(c.tan); m.set(c.deductor, (m.get(c.deductor) || 0) + 1); }
  // fixed before any automatic client is made, so the result does not depend on the order of the entries
  const knownSet = new Set([...byTan.keys(), ...deductor.keys()]);
  const known = t => knownSet.has(t);
  const custName = new Map(), custTans = new Map();
  const learn = (cust, name, tan) => {
    if (!cust) return;
    if (name && !custName.has(cust)) custName.set(cust, name);
    const t = normTan(tan);
    if (TAN_RE.test(t)) (custTans.get(cust) || custTans.set(cust, new Set()).get(cust)).add(t);
  };
  for (const i of Object.values(invoices || {})) learn(i.cust, i.cust_name, i.tan);
  for (const z of items) { learn(z.customer_id, z.customer_name, ''); for (const t of z.tan_hints || []) learn(z.customer_id, '', t); }

  const usable = (cust, t) => TAN_RE.test(t) && !rejected[`${cust}|${t}`] && (byTan.has(t) || !noCustomer.has(t));
  const groupOfTan = (t, cust) => {
    if (!byTan.has(t)) {
      const names = deductor.get(t);
      const name = names ? [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0] : custName.get(cust) || t;
      groups.set(AUTO + t, { id: AUTO + t, name, auto: true, in_statement: !!names, customers: [], tans: [{ tan: t, name, basis: 'auto' }], tan_customers: [] });
      byTan.set(t, AUTO + t);
    }
    return byTan.get(t);
  };
  const place = (gid, cust) => {
    const g = groups.get(gid);
    if (cust && !g.customers.some(c => c.id === cust) && !g.tan_customers.some(c => c.id === cust)) g.tan_customers.push({ id: cust, name: custName.get(cust) || '' });
  };

  // journals without a customer: the deductor from the reviewer's choice, the invoice TAN, a TAN or a name in the Reference number / Notes
  let finder = null;
  const keyOfTan = t => byTan.get(t) || AUTO + t;
  const nameFind = text => {
    if (!finder) {
      const cands = [];
      for (const [t, names] of deductor) for (const n of names.keys()) cands.push({ tan: t, key: keyOfTan(t), name: n });
      for (const g of doc.groups || []) if (g.tans.length) cands.push({ tan: g.tans[0].tan, key: g.id, name: g.name });
      for (const [cust, tans] of custTans) { const k = [...tans].filter(t => known(t) && !rejected[`${cust}|${t}`]); if (k.length === 1 && custName.get(cust)) cands.push({ tan: k[0], key: keyOfTan(k[0]), name: custName.get(cust) }); }
      finder = nameFinder(cands);
    }
    return finder(text);
  };
  const nameOfTan = t => { const names = deductor.get(t); return names ? [...names.entries()].sort((a, b) => b[1] - a[1])[0][0] : ''; };
  function journalClient(z) {
    const j = z.journal || {};
    const man = j.id && (doc.journal_tans || {})[j.id];
    if (man && TAN_RE.test(man.tan)) return { group: groupOfTan(man.tan, ''), basis: 'journal_manual', tans: [man.tan], name: nameOfTan(man.tan) || man.name || '', by: man.by, at: man.at, note: man.note || '' };
    const hints = [...new Set((z.tan_hints || []).map(normTan))].filter(t => TAN_RE.test(t));
    if (hints.length === 1) return { group: groupOfTan(hints[0], ''), basis: 'journal_invoice_tan', tans: hints, name: nameOfTan(hints[0]), words: (z.refs || []).slice(0, 5) };
    const text = `${j.ref || ''} ${j.notes || ''}`;
    const inText = [...new Set(words(text).filter(w => TAN_RE.test(w)))];
    const tan = inText.length === 1 ? inText[0] : inText.filter(known).length === 1 ? inText.filter(known)[0] : null;
    if (tan) return { group: groupOfTan(tan, ''), basis: 'journal_tan', tans: [tan], name: nameOfTan(tan), words: [tan] };
    if (inText.length > 1) return { group: null, basis: 'journal_ambiguous', tans: [], candidates: inText.map(t => ({ tan: t, name: nameOfTan(t) })) };
    const f = nameFind(text);
    if (f && f.tan) return { group: groupOfTan(f.tan, ''), basis: f.basis, tans: [f.tan], name: nameOfTan(f.tan) || f.name, matched_name: f.name, words: f.words };
    if (f && f.candidates) return { group: null, basis: 'journal_ambiguous', tans: [], candidates: f.candidates.map(c => ({ tan: c.tan, name: nameOfTan(c.tan) || c.name, words: c.words })) };
    return null;
  }

  /** client of one entry: { group, basis, tans (the TANs it rests on), alt (known TANs of the customer, for a TAN no statement has) } */
  const memo = new Map();
  function entry(z) {
    if (memo.has(z.key)) return memo.get(z.key);
    const cust = z.customer_id;
    let out = { group: null, basis: cust ? 'no_tan' : 'no_customer', tans: [] };
    if (!cust && z.type === 'journal') out = journalClient(z) || out;
    if (cust) {
      const raw = [...new Set((z.tan_hints || []).map(normTan))].filter(t => TAN_RE.test(t));
      const own = raw.filter(t => usable(cust, t));
      const learned = [...(custTans.get(cust) || [])].filter(t => usable(cust, t));
      const ownKnown = own.filter(known), learnedKnown = learned.filter(known);
      const ownGroups = new Set(ownKnown.map(t => byTan.get(t) || AUTO + t));
      if (ownGroups.size === 1) out = { group: groupOfTan(ownKnown[0], cust), basis: 'invoice_tan', tans: ownKnown };
      else if (byCust.has(cust)) out = { group: byCust.get(cust), basis: 'customer_group', tans: own };
      else if (!own.length && learnedKnown.length === 1) out = { group: groupOfTan(learnedKnown[0], cust), basis: 'customer_tan', tans: learnedKnown };
      else if (own.length === 1 && !ownKnown.length) out = { group: groupOfTan(own[0], cust), basis: 'invoice_tan_unseen', tans: own, alt: learnedKnown };
      else if (!own.length && learned.length === 1) out = { group: groupOfTan(learned[0], cust), basis: 'customer_tan_unseen', tans: learned };
      else if (raw.length && !own.length && !learned.length) out = { group: null, basis: 'tan_excluded', tans: raw };
      else out = { group: null, basis: own.length || learned.length ? 'several_tans' : 'no_tan', tans: own.length > 1 ? own : learned };
      if (out.group) place(out.group, cust);
    }
    memo.set(z.key, out);
    return out;
  }
  const byEntry = new Map(), entryInfo = new Map();
  for (const z of items) { const e = entry(z); entryInfo.set(z.key, e); if (e.group) byEntry.set(z.key, e.group); }
  // every TAN a customer records is a client, so the deductor's credits are reported against it even when nothing is booked
  for (const [cust, tans] of custTans) {
    for (const t of tans) {
      if (!usable(cust, t)) continue;
      if (!byCust.has(cust)) place(groupOfTan(t, cust), cust);
      else if (known(t) && byTan.get(t) !== byCust.get(cust)) place(groupOfTan(t, cust), cust);
    }
  }
  return { byCust, byTan, byEntry, entryInfo, entry, groups, noCustomer, custTans, isAuto };
}

/**
 * What the TAN rule leaves open: statement TANs that no Zoho invoice records (suggested to customers with a similar name, for review),
 * and customers with TDS entries that got no client (no TAN on their invoices, or several). ix: the effective index (lib/clients.index).
 */
function suggestions(doc, items, credits, ix = index(doc, { items, credits })) {
  const customers = new Map();
  for (const z of items) {
    if (!z.customer_id) continue;
    const c = customers.get(z.customer_id) || customers.set(z.customer_id, { id: z.customer_id, name: z.customer_name, tans: new Set(), n: 0, amount: 0, open_n: 0, open_amount: 0, basis: '' }).get(z.customer_id);
    c.n++; c.amount += z.amount;
    const e = ix.entry(z);
    if (!e.group) { c.open_n++; c.open_amount += z.amount; c.basis = e.basis; e.tans.forEach(t => c.tans.add(t)); }
  }
  const deductors = new Map();
  for (const c of credits) { const d = deductors.get(c.tan) || deductors.set(c.tan, { tan: c.tan, name: c.deductor, n: 0, deducted: 0 }).get(c.tan); d.n++; d.deducted += c.deducted; }
  // the client a customer's entries already have, and the TANs (no group holds) that client rests on — joined when a suggestion is approved
  const clientOf = cust => ix.byCust.get(cust) || [...(ix.custTans.get(cust) || [])].map(t => ix.byTan.get(t)).find(Boolean) || null;
  const autoTans = cust => [...(ix.custTans.get(cust) || [])].filter(t => ix.isAuto(ix.byTan.get(t)) && !(doc.rejected || {})[`${cust}|${t}`]);
  const out = [];
  for (const d of deductors.values()) {
    if (ix.byTan.has(d.tan) || ix.noCustomer.has(d.tan)) continue;
    const found = [];
    for (const c of customers.values()) {
      if ((doc.rejected || {})[`${c.id}|${d.tan}`]) continue;
      const sc = similarity(d.name, c.name);
      if (sc >= 0.75) found.push({ c, score: Math.round(sc * 100) / 100, basis: 'name', detail: `No Zoho invoice records TAN ${d.tan}; the names agree ${Math.round(sc * 100)} % once legal suffixes are ignored ("${d.name}" / "${c.name}")` });
    }
    found.sort((a, b) => b.score - a.score || String(a.c.name).localeCompare(String(b.c.name)));
    for (const f of found.slice(0, 3)) {
      const g = clientOf(f.c.id);
      out.push({ id: `s${hashOf(`${f.c.id}|${d.tan}`)}`, tan: d.tan, deductor: d.name, credits: d.n, deducted: d.deducted, customer_id: f.c.id, customer_name: f.c.name,
        zoho_entries: f.c.n, zoho_amount: f.c.amount, score: f.score, basis: f.basis, detail: f.detail, existing_group: g, existing_name: g ? (ix.groups.get(g) || {}).name || '' : '',
        customer_tans: ix.byCust.has(f.c.id) ? [] : autoTans(f.c.id), competing: found.length > 1 });
    }
  }
  const unmappedTans = [...deductors.values()].filter(d => !ix.byTan.has(d.tan) && !ix.noCustomer.has(d.tan));
  const unmappedCustomers = [...customers.values()].filter(c => c.open_n > 0)
    .map(c => ({ id: c.id, name: c.name, entries: c.open_n, amount: c.open_amount, tans: [...c.tans], why: c.basis === 'several_tans' ? `its invoices record several TANs (${[...c.tans].join(', ')})` : c.basis === 'tan_excluded' ? `the TAN on its invoices (${[...c.tans].join(', ')}) is ruled out below` : 'no TAN is recorded on its invoices' }));
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

/** Approve suggestions: the TAN joins the customer's group, or a new group named after the customer — which also takes the TANs the
 *  customer's entries were matched on automatically (customer_tans), so the client is not split between two TANs */
async function approve(entity, by, list) {
  return change(entity, by, d => {
    let n = 0;
    const held = t => d.groups.some(g => g.tans.some(x => x.tan === t));
    for (const s of list) {
      const tan = normTan(s.tan);
      if (!TAN_RE.test(tan) || held(tan)) continue;
      const at = new Date().toISOString();
      const g = d.groups.find(x => x.customers.some(c => c.id === s.customer_id));
      if (g) g.tans.push({ tan, name: s.deductor || '', by, at, basis: s.basis || 'manual' });
      else {
        const extra = [...new Set((s.customer_tans || []).map(normTan))].filter(t => TAN_RE.test(t) && t !== tan && !held(t) && !d.no_customer[t]).map(t => ({ tan: t, name: '', by, at, basis: 'tan_field' }));
        d.groups.push({ id: `g${hashOf(`${s.customer_id}|${Date.now()}|${n}`)}`, name: s.customer_name || s.deductor || tan, customers: [{ id: s.customer_id, name: s.customer_name || '' }],
          tans: [{ tan, name: s.deductor || '', by, at, basis: s.basis || 'manual' }, ...extra], by, at });
      }
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
/** A customer ↔ TAN pair that is NOT the same client (a suggestion, or a TAN on the customer's invoices the TAN rule must not use);
 *  on = false undoes it */
/** The deductor of a journal without a customer (a bank, a borrower …), chosen by a reviewer; an empty TAN goes back to the automatic rule */
async function journalDeductor(entity, by, journalId, tan, { note = '', number = '', name = '' } = {}) {
  return change(entity, by, d => {
    const jid = String(journalId || '');
    if (!jid) throw Object.assign(new Error('Which journal?'), { status: 400 });
    d.journal_tans = d.journal_tans || {};
    const t = normTan(tan);
    if (!t) { delete d.journal_tans[jid]; return { what: `journal ${number || jid}: deductor back to the automatic rule` }; }
    if (!TAN_RE.test(t)) throw Object.assign(new Error('Not a valid TAN'), { status: 400 });
    d.journal_tans[jid] = { tan: t, name: String(name || '').slice(0, 160), number: String(number || '').slice(0, 60), by, at: new Date().toISOString(), note: String(note || '').slice(0, 300) };
    return { what: `journal ${number || jid}: deductor ${name ? `${name} ` : ''}(${t})` };
  });
}

async function reject(entity, by, customerId, tan, on = true, name = '') {
  return change(entity, by, d => {
    const k = `${customerId}|${normTan(tan)}`;
    if (on) d.rejected[k] = { by, at: new Date().toISOString(), name: String(name || '').slice(0, 160) }; else delete d.rejected[k];
    return { what: `${on ? 'rejected' : 'restored'} ${name || customerId} ↔ ${normTan(tan)}` };
  });
}

module.exports = { load, index, suggestions, approve, saveGroup, removeGroup, noCustomer, reject, journalDeductor, similarity, tokens, isAuto, nameFinder };
