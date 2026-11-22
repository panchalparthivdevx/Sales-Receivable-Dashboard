/**
 * Ledger postings → Zoho TDS entries ("items"), the Books side of the reconciliation.
 *
 * The CONTROL AMOUNT is the posting on the entity's TDS Receivable ledger(s): debit − credit, in paise. Documents only add detail
 * (customer, invoice, payment, base values) — they never add amounts, so one TDS amount is counted once even when an invoice, its payment
 * and a journal all mention it. Rules:
 *   - invoice / credit note: one entry per document and section (TDS deducted on the invoice itself; a credit note reverses it)
 *   - customer payment: one entry per posting (Zoho posts one row per invoice the payment covers; the row carries the invoice number)
 *   - journal: the lines on the mapped ledgers are netted per customer and section. A journal whose lines on mapped ledgers net to zero
 *     for a customer only moves TDS between the entity's own TDS ledgers (e.g. into a prior-year ledger) — listed as a transfer, not
 *     counted. The customer of a journal line without one comes from the journal's other lines (the receivable line), else from the
 *     invoice numbers in its notes; when neither identifies it the entry is UNALLOCATED and shown separately.
 *   - anything else (opening balance, bank entries …): one entry per posting
 */

'use strict';

const PER = require('./periods');
const { ledgerFy, sectionFamily } = require('./config');

const TYPE_LABEL = { invoice: 'Invoice', customer_payment: 'Customer payment', journal: 'Journal', creditnote: 'Credit note', credit_note: 'Credit note' };
const ZOHO_KIND = { invoice: 'invoices', customer_payment: 'paymentsreceived', journal: 'journals', creditnote: 'creditnotes', credit_note: 'creditnotes' };
const REF_RE = /[A-Z0-9]{1,8}(?:[/-][A-Z0-9]{1,8}){1,5}/gi;

function refsIn(text, invno) {
  const found = [], other = [];
  for (const m of String(text || '').toUpperCase().match(REF_RE) || []) {
    if (invno[m]) { if (!found.includes(m)) found.push(m); } else if (/\//.test(m) && /\d/.test(m) && !other.includes(m)) other.push(m);
  }
  return { found, other };
}

/**
 * entity: configured entity (ledgers with section), rows: stored ledger rows, docs: { invoices, payments, paylist, journals, invno },
 * centralInvoices: optional list rows (invoice_id, invoice_number, customer_id, date, total) for numbers not fetched in detail.
 */
function build({ entity, rows, docs, centralInvoices = [] }) {
  const ledgers = new Map(entity.ledgers.map(l => [l.account_id, l]));
  const mine = rows.filter(r => ledgers.has(r.acc));
  const invno = { ...(docs.invno || {}) };
  for (const i of centralInvoices) { const n = String(i.invoice_number || '').toUpperCase(); if (n && !invno[n]) invno[n] = { id: String(i.invoice_id), cust: String(i.customer_id || ''), date: String(i.date || ''), list: i }; }
  const custName = new Map();
  for (const r of mine) if (r.cust && r.payee) custName.set(r.cust, r.payee);
  for (const i of Object.values(docs.invoices || {})) if (i.cust && i.cust_name && !custName.has(i.cust)) custName.set(i.cust, i.cust_name);

  const invoiceView = id => {
    const d = (docs.invoices || {})[id];
    if (!d) return null;
    return { id: d.id, no: d.no, date: d.date, basic: d.sub_total, gst: d.tax_total, gross: d.sub_total !== null && d.tax_total !== null ? d.sub_total + d.tax_total : null, total: d.total,
      tds_on_invoice: d.tds, tds_percent: d.tds_percent, tds_names: d.tds_names, tan: d.tan, status: d.status };
  };
  const byNumber = no => { const x = invno[String(no || '').toUpperCase()]; return x ? (invoiceView(x.id) || { id: x.id, no: String(no).toUpperCase(), date: x.date, basic: null, gst: null, gross: null, total: x.list ? Math.round(Number(x.list.total) * 100) : null, partial: true }) : null; };

  // group postings
  const groups = new Map();
  const put = (key, base, r) => { const g = groups.get(key) || groups.set(key, { ...base, rows: [] }).get(key); g.rows.push(r); };
  for (const r of mine) {
    const sec = ledgers.get(r.acc).section || '';
    if (r.type === 'journal' && r.tid) put(`j:${r.tid}`, { kind: 'journal', tid: r.tid }, r);
    else if ((r.type === 'invoice' || r.type === 'creditnote' || r.type === 'credit_note') && r.tid) put(`${r.type === 'invoice' ? 'zi' : 'zc'}:${r.tid}:${sec}`, { kind: r.type, tid: r.tid, sec }, r);
    else put(`${r.type === 'customer_payment' ? 'zp' : 'zo'}:${r.id}`, { kind: r.type || 'other', tid: r.tid, sec }, r);
  }

  const items = [], transfers = [];
  const net = rs => rs.reduce((a, r) => a + r.dr - r.cr, 0);
  for (const [key, g] of groups) {
    if (g.kind === 'journal') {
      const j = (docs.journals || {})[g.tid];
      const lineCusts = j ? [...new Set(j.lines.filter(l => l.cust).map(l => l.cust))] : [];
      const notes = j ? `${j.notes} ${j.ref}` : g.rows.map(r => `${r.desc} ${r.ref}`).join(' ');
      const refs = refsIn(notes, invno);
      const refCusts = [...new Set(refs.found.map(n => invno[n].cust).filter(Boolean))];
      const derived = lineCusts.length === 1 ? { id: lineCusts[0], basis: 'journal_line' } : refCusts.length === 1 ? { id: refCusts[0], basis: 'invoice_reference' } : null;
      const per = new Map();
      for (const r of g.rows) {
        const c = r.cust ? { id: r.cust, basis: 'posting' } : derived;
        const ck = c ? c.id : '';
        (per.get(ck) || per.set(ck, { cust: c, rows: [] }).get(ck)).rows.push(r);
      }
      for (const [ck, p] of per) {
        const accs = new Set(p.rows.map(r => r.acc));
        if (net(p.rows) === 0 && p.rows.some(r => r.dr) && p.rows.some(r => r.cr)) {
          transfers.push({ journal_id: g.tid, number: p.rows[0].no, date: p.rows[0].date, customer_id: ck, customer_name: custName.get(ck) || p.rows[0].payee || '',
            legs: p.rows.map(r => ({ ledger: ledgers.get(r.acc).name, section: ledgers.get(r.acc).section, amount: r.dr - r.cr })), cross_section: new Set(p.rows.map(r => ledgers.get(r.acc).section)).size > 1, notes: j ? j.notes : p.rows[0].desc });
          continue;
        }
        const bySec = new Map();
        for (const r of p.rows) { const s = ledgers.get(r.acc).section || ''; (bySec.get(s) || bySec.set(s, []).get(s)).push(r); }
        for (const [sec, rs] of bySec) {
          const amount = net(rs);
          if (amount === 0) continue;
          const invs = refs.found.map(byNumber).filter(Boolean);
          items.push(makeItem({ key: `zj:${g.tid}:${ck || '-'}:${sec}`, kind: 'journal', rows: rs, sec, amount, cust: ck, custBasis: p.cust ? p.cust.basis : null, accs,
            journal: { id: g.tid, no: rs[0].no, date: (j && j.date) || rs[0].date, notes: (j ? j.notes : rs[0].desc) || '', ref: j ? j.ref : rs[0].ref, detail: !!j },
            invoices: invs, refs, base: baseFromInvoices(invs, 'reference') }));
        }
      }
      continue;
    }
    const amount = net(g.rows);
    if (amount === 0 && g.rows.length > 1) continue;                 // posted and reversed inside the same document
    const r0 = g.rows[0];
    if (g.kind === 'invoice') {
      const inv = invoiceView(g.tid) || byNumber(r0.no) || { id: g.tid, no: r0.no, date: '', basic: null, gst: null, gross: null, total: null, partial: true };
      items.push(makeItem({ key, kind: 'invoice', rows: g.rows, sec: g.sec, amount, cust: r0.cust || (inv && (docs.invoices[g.tid] || {}).cust) || '', custBasis: 'posting', invoices: [inv],
        base: inv.basic !== null && inv.basic !== undefined ? { basic: inv.basic, gst: inv.gst, gross: inv.gross, comparable: inv.basic, basis: 'invoice', note: 'TDS booked on the invoice: the whole basic value is the base' } : { basis: 'none', note: 'Invoice details not fetched yet' } }));
    } else if (g.kind === 'customer_payment') {
      const pay = findPayment(r0, docs);
      const entry = pay && pay.invoices.find(i => i.no.toUpperCase() === r0.no.toUpperCase());
      const inv = (entry && invoiceView(entry.id)) || byNumber(r0.no);
      let base = { basis: 'none', note: 'The payment\'s allocation to the invoice is not available' };
      if (inv && inv.basic !== null && inv.basic !== undefined) {
        if (entry && entry.applied > 0) {
          const whole = inv.gross || entry.total || 0;
          const frac = whole > 0 ? Math.min(1, (entry.applied + entry.withheld) / whole) : 1;
          base = { basic: inv.basic, gst: inv.gst, gross: inv.gross, comparable: Math.round(inv.basic * frac), basis: 'allocation', fraction: frac,
            note: frac < 0.999 ? `This payment settles ${(frac * 100).toFixed(1)} % of the invoice (applied + TDS), so the base is that share of the basic value` : 'This payment settles the whole invoice' };
        } else if (entry) base = { basic: inv.basic, gst: inv.gst, gross: inv.gross, comparable: inv.basic, basis: 'allocation', fraction: 1, note: 'TDS recorded on its own (no amount applied) — compared with the whole basic value' };
        else base = { basic: inv.basic, gst: inv.gst, gross: inv.gross, comparable: null, basis: 'invoice_only', note: 'The payment was not found, so the share of the invoice it covers is unknown' };
      }
      items.push(makeItem({ key, kind: 'customer_payment', rows: g.rows, sec: g.sec, amount, cust: r0.cust, custBasis: 'posting', invoices: inv ? [inv] : [],
        payment: pay ? { id: pay.id, no: pay.no, date: pay.date, amount: pay.amount, withheld: pay.withheld, applied: entry ? entry.applied : null, withheld_on_invoice: entry ? entry.withheld : null, detail: !!pay.invoices.length } : null, base }));
    } else {
      items.push(makeItem({ key, kind: g.kind, rows: g.rows, sec: g.sec, amount, cust: r0.cust, custBasis: r0.cust ? 'posting' : null, invoices: g.kind === 'creditnote' ? [] : [byNumber(r0.no)].filter(Boolean), base: { basis: 'none', note: g.kind === 'creditnote' ? 'Credit note: reverses TDS booked earlier' : 'No document base' } }));
    }
  }

  // TDS on the same invoice booked twice (on the invoice and again on a payment) — a Books error worth a look
  const byInv = new Map();
  for (const it of items) for (const inv of it.invoices) if (inv && inv.id) (byInv.get(inv.id) || byInv.set(inv.id, []).get(inv.id)).push(it);
  for (const list of byInv.values()) {
    const kinds = new Set(list.filter(x => x.amount > 0).map(x => x.type));
    if (kinds.has('invoice') && kinds.has('customer_payment')) for (const x of list) if (x.amount > 0) x.flags.push('tds_booked_twice');
  }

  function makeItem({ key, kind, rows: rs, sec, amount, cust, custBasis, invoices = [], payment = null, journal = null, refs = null, base }) {
    const r0 = rs[0];
    const flags = [];
    const fyLabels = [...new Set(rs.map(r => ledgerFy(ledgers.get(r.acc).name)).filter(Boolean))];
    if (fyLabels.length && fyLabels.some(f => f !== PER.fyOf(r0.date))) flags.push('ledger_fy_mismatch');
    const inv0 = invoices[0];
    if (inv0 && inv0.tds_names && inv0.tds_names.length && sec && !inv0.tds_names.map(n => sectionFamily(n)).includes(sec)) flags.push('section_differs_invoice');
    if (!cust) flags.push('unallocated');
    if (kind === 'customer_payment' && !payment) flags.push('payment_not_found');
    if (base && base.basis === 'none' && amount > 0) flags.push('no_base');
    if (refs && refs.other.length && !refs.found.length) flags.push('reference_not_found');
    if (amount < 0) flags.push('reversal');
    const invTans = [...new Set(invoices.map(i => i && i.tan).filter(Boolean))];
    return {
      key, type: kind, type_label: TYPE_LABEL[kind] || (r0.type_label || kind), date: r0.date, fy: PER.fyOf(r0.date), quarter: PER.quarterOf(r0.date),
      customer_id: cust || '', customer_name: cust ? (custName.get(cust) || r0.payee || '') : '', customer_basis: cust ? custBasis : null,
      section: sec, ledgers: [...new Set(rs.map(r => ledgers.get(r.acc).name))], amount, dr: rs.reduce((a, r) => a + r.dr, 0), cr: rs.reduce((a, r) => a + r.cr, 0),
      number: r0.no, invoices: invoices.filter(Boolean), payment, journal, refs: refs ? refs.found : [], refs_unresolved: refs ? refs.other : [],
      base: base || { basis: 'none' }, tan_hints: invTans, flags, rows: rs.map(r => r.id),
      zoho: { kind: ZOHO_KIND[kind] || null, id: kind === 'customer_payment' ? (payment ? payment.id : '') : r0.tid },
    };
  }

  items.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  return { items, transfers, rows: mine, ledger_total: mine.reduce((a, r) => a + r.dr - r.cr, 0), postings: mine.length };
}

function baseFromInvoices(invs, basis) {
  const full = invs.filter(i => i && i.basic !== null && i.basic !== undefined);
  if (!invs.length) return { basis: 'none', note: 'No invoice could be identified from the journal' };
  if (full.length !== invs.length) return { basis: 'none', note: 'Referenced invoice details are not fetched yet' };
  const sum = f => full.reduce((a, i) => a + (i[f] || 0), 0);
  return { basic: sum('basic'), gst: sum('gst'), gross: sum('gross'), comparable: sum('basic'), basis, note: `Base taken from the invoice(s) named in the journal: ${full.map(i => i.no).join(', ')}` };
}

function findPayment(row, docs) {
  const no = row.no.toUpperCase();
  const det = Object.values(docs.payments || {}).filter(p => p.cust === row.cust && p.date === row.date && p.invoices.some(i => i.no.toUpperCase() === no));
  const exact = det.filter(p => p.invoices.some(i => i.no.toUpperCase() === no && i.withheld === row.dr - row.cr));
  if (exact.length === 1) return exact[0];
  if (det.length === 1) return det[0];
  const list = Object.values(docs.paylist || {}).filter(p => { const nos = p.invoice_numbers.toUpperCase().split(',').map(s => s.trim()).filter(Boolean); return p.cust === row.cust && p.date === row.date && (nos.length ? nos.includes(no) : p.withheld === row.dr - row.cr); });
  if (list.length === 1) return { ...list[0], amount: null, invoices: [] };
  return null;
}

module.exports = { build, refsIn, TYPE_LABEL, ZOHO_KIND };
