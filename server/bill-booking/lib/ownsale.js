/**
 * Our own sales invoices — Dev Accelerator, Neddle … invoicing a customer — reach the finance mailboxes too:
 * payment reminders from Accounts Receivable, invoices forwarded by the team. They are not vendor bills, so
 * they are never collected or booked.
 *
 * An invoice counts as our own when one of these holds:
 *   1. Its number (as read from the document, or the attachment's file name, e.g. "IN26-27GJ2632.pdf") is one
 *      of our companies' sales invoices in Zoho (central sync, invoices_fy), and the date or total does not
 *      contradict it.
 *      A number not synced yet (raised today) counts when it follows one of our distinctive numbering series.
 *   2. The seller block — everything printed before the "Bill To / Buyer / Recipient …" heading — carries only
 *      our company's GSTIN (no other party's), with our name printed just above it.
 *   3. The reader found our company's GSTIN as the supplier.
 * An invoice from one of our companies to another of our companies is a real purchase bill for the buyer, so
 * it is never treated as our own sales invoice.
 */

'use strict';

const T = require('./text');
const M = require('./match');

const MIN_NUMBER_LEN = 6;   // shorter numbers ("2641") could belong to anyone
const BUYER_HEADING = /\b(BILL(?:ED)?\s*TO|BUYER|RECIPIENT|INVOICE\s*TO|SHIP(?:PED)?\s*TO|CONSIGNEE|DETAILS\s+OF\s+RECEIVER|SOLD\s*TO|CUSTOMER\s*(?:NAME|DETAILS))\b/;

const fileBase = name => String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');

/**
 * Our companies' sales invoices: [{ company, rows }] (synced invoices_fy) → Map(normalised number → invoice).
 * map.series: our invoice numbering series (e.g. "IN/26-27/GJ/…" → IN2627GJ), so an invoice raised after the last
 * sync (not in the synced list yet) is still recognised. A series counts only when it is distinctive — letters and
 * digits in the prefix, like the financial year — and used at least SERIES_MIN times (never "INV-…").
 */
const SERIES_MIN = 20;
const seriesOf = n => { const m = String(n).match(/^(.*\D)(\d{3,})$/); return m && m[1].length >= 6 && /[A-Z]/.test(m[1]) && /\d/.test(m[1]) ? m[1] : null; };
function salesIndex(perCompany) {
  const map = new Map();
  const count = new Map();
  for (const { company, rows } of perCompany || []) {
    for (const r of rows || []) {
      const n = T.normInvoice(r.invoice_number);
      if (n.length < MIN_NUMBER_LEN || map.has(n)) continue;
      map.set(n, { company, number: r.invoice_number, date: r.date || '', total: Number(r.total) || null, customer: r.customer_name || '', customer_gstin: String(r.gst_no || '').toUpperCase() });
      const s = seriesOf(n);
      if (s) {
        const c = count.get(s) || { company, n: 0, sample: r.invoice_number };
        if (c.company === company) c.n++; else c.mixed = true;
        count.set(s, c);
      }
    }
  }
  map.series = new Map([...count].filter(([, c]) => c.n >= SERIES_MIN && !c.mixed)
    .map(([s, c]) => [s, { company: c.company, sample: String(c.sample).replace(/\d+$/, '…') }]));
  return map;
}

/** A number that is not in the synced list but follows one of our numbering series → { company, sample } | null */
function inSeries(sales, n) {
  if (!sales?.series?.size || n.length < MIN_NUMBER_LEN || sales.has(n)) return null;
  const s = seriesOf(n);
  return s ? sales.series.get(s) || null : null;
}

function companyOf(companies, gstin) {
  if (!T.isGstin(gstin)) return null;
  return companies.find(c => M.companyGstins(c).includes(gstin) || M.companyPans(c).includes(T.panOf(gstin))) || null;
}

/** The customer of one of our sales invoices is another of our companies (by GSTIN or name)? */
function customerIsOurs(companies, issuerId, inv) {
  const c = companyOf(companies, inv.customer_gstin);
  if (c) return c.id !== issuerId;
  const name = String(inv.customer || '').toLowerCase();
  return companies.some(x => x.id !== issuerId && (x.name_hints || []).some(h => h && name.includes(h)));
}

/** An attachment whose file name is one of our sales invoice numbers → { company, number, customer, reason } | null */
function byFileName({ fileName, companies, sales }) {
  const n = T.normInvoice(fileBase(fileName));
  const inv = n.length >= MIN_NUMBER_LEN ? sales?.get(n) : null;
  if (!inv) {
    const s = inSeries(sales, n);
    if (!s) return null;
    const co = companies.find(c => c.id === s.company);
    return { company: s.company, number: fileBase(fileName), basis: 'zoho_series',
      reason: `Our own sales invoice ${fileBase(fileName)} — it follows ${co?.name || s.company}'s invoice numbering (${s.sample}) — not a vendor bill` };
  }
  if (customerIsOurs(companies, inv.company, inv)) return null;
  const co = companies.find(c => c.id === inv.company);
  return { company: inv.company, number: inv.number, customer: inv.customer, basis: 'zoho_number',
    reason: `Our own sales invoice ${inv.number} (${co?.name || inv.company} to ${inv.customer || 'a customer'}${inv.date ? `, dated ${inv.date}` : ''}) — not a vendor bill` };
}

/**
 * A read document → { company, reason, basis } when it is one of our own sales invoices, else null.
 * fields: what the reader found; text: the document text; companies: configured companies with their GSTINs.
 */
function check({ fields = {}, text = '', fileName = '', companies = [], sales = null }) {
  const buyerCo = companyOf(companies, fields.buyer_gstin);
  const intercompany = issuerId => buyerCo && buyerCo.id !== issuerId;

  // 1. The number is one of our sales invoices in Zoho
  if (sales?.size) {
    for (const cand of [fields.invoice_number, fileBase(fileName)]) {
      const n = T.normInvoice(cand);
      const inv = n.length >= MIN_NUMBER_LEN ? sales.get(n) : null;
      if (!inv || intercompany(inv.company) || customerIsOurs(companies, inv.company, inv)) continue;
      const dateOff = fields.invoice_date && inv.date && fields.invoice_date !== inv.date;
      const totalOff = fields.total > 0 && inv.total > 0 && Math.abs(fields.total - inv.total) > 1;
      if (dateOff && totalOff) continue;   // same number, but a different document
      const co = companies.find(c => c.id === inv.company);
      return { company: inv.company, basis: 'zoho_number',
        reason: `Our own sales invoice: ${inv.number} is ${co?.name || inv.company}'s invoice to ${inv.customer || 'a customer'} in Zoho${inv.date ? ` (dated ${inv.date})` : ''} — not a vendor bill` };
    }
    // raised after the last sync: not in the list yet, but it follows our numbering
    for (const cand of [fields.invoice_number, fileBase(fileName)]) {
      const s = inSeries(sales, T.normInvoice(cand));
      if (!s || intercompany(s.company)) continue;
      const co = companies.find(c => c.id === s.company);
      return { company: s.company, basis: 'zoho_series',
        reason: `Our own sales invoice: ${cand} follows ${co?.name || s.company}'s invoice numbering (${s.sample}) — not a vendor bill` };
    }
  }

  // 2. The seller block is ours
  const up = String(text || '').toUpperCase();
  const at = up.search(BUYER_HEADING);
  if (at > 0) {
    const before = up.slice(0, at), after = up.slice(at);
    const gBefore = [...new Set(before.match(T.GSTIN_RE) || [])];
    const owners = gBefore.map(g => companyOf(companies, g));
    const co = owners[0];
    if (co && owners.every(o => o && o.id === co.id)) {
      // our name printed just above our GSTIN (the letterhead). Zoho's PDFs put the totals first in the text, so the
      // letterhead is not necessarily at the start of the text — it is right before the GSTIN.
      const gAt = before.indexOf(gBefore[0]);
      const letterhead = String(text).slice(Math.max(0, gAt - 600), gAt).toLowerCase();
      const named = (co.name_hints || []).some(h => h && letterhead.includes(h));
      const gAfter = [...new Set(after.match(T.GSTIN_RE) || [])];
      const otherOurs = gAfter.map(g => companyOf(companies, g)).find(o => o && o.id !== co.id);
      if (named && !otherOurs && !intercompany(co.id)) {
        const customer = gAfter.find(g => !companyOf(companies, g));
        return { company: co.id, basis: 'seller_block',
          reason: `Our own sales invoice: issued by ${co.name} (GSTIN ${gBefore[0]})${customer ? ` to GSTIN ${customer}` : ''} — not a vendor bill` };
      }
    }
  }

  // 3. The reader names our company as the supplier
  const sup = companyOf(companies, fields.vendor_gstin);
  if (sup && !intercompany(sup.id)) {
    return { company: sup.id, basis: 'supplier_gstin',
      reason: `Our own sales invoice: the supplier GSTIN ${fields.vendor_gstin} is ${sup.name}'s — not a vendor bill` };
  }
  return null;
}

module.exports = { check, byFileName, salesIndex, BUYER_HEADING };
