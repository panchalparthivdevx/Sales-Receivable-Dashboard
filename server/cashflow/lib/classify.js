/**
 * Which Zoho bills belong to which category, and what a bill holds for the cash flow.
 *
 *   accountCategories(coa, categories)   account id → category, through Zoho's account tree (an account under
 *                                        "Office Rent" is rent, at any depth)
 *   isCandidate(row, …)                  worth reading in detail? (from the synced list row only — no Zoho call)
 *   compactBill(raw)                     the Zoho bill detail, kept small (lines, payments with their cash and
 *                                        apply dates, credits applied, TDS)
 *   partsOf(bill, accCat)                one part per category on the bill, with its share of the bill
 *   clientOf / periodOf / connectionOf   read from the bill's own wording
 */

'use strict';

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const lc = s => String(s || '').trim().toLowerCase();

/** coa: [{ id, name, parent }] → Map(account id → category key) */
function accountCategories(coa, categories) {
  const kids = new Map();
  const byName = new Map();
  for (const a of coa || []) {
    const p = lc(a.parent);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(a);
    const n = lc(a.name);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(a);
  }
  const out = new Map();
  for (const [cat, def] of Object.entries(categories || {})) {
    const seen = new Set();
    const walk = a => {
      if (seen.has(a.id)) return;
      seen.add(a.id);
      if (!out.has(a.id)) out.set(a.id, cat);
      for (const k of kids.get(lc(a.name)) || []) walk(k);
    };
    for (const root of def.account_roots || []) for (const a of byName.get(lc(root)) || []) walk(a);
  }
  return out;
}

/**
 * A synced bill list row worth reading in detail for any category.
 * vendorMaster: Map(vendor id → master category, lower case); learned: Set of vendor ids that had a category bill before.
 */
function isCandidate(row, { categories, vendorMaster, learned }) {
  if (!row || row.status === 'void' || row.status === 'draft') return false;
  if (learned && learned.has(row.vendor_id)) return true;
  const billCat = lc(row.cf_vendor_category_formatted || row.cf_vendor_category);
  const master = vendorMaster ? lc(vendorMaster.get(row.vendor_id)) : '';
  const name = lc(row.vendor_name);
  for (const def of Object.values(categories || {})) {
    if (billCat && (def.bill_vendor_categories || []).some(c => billCat === c || billCat.startsWith(c))) return true;
    if (master && (def.vendor_master_categories || []).includes(master)) return true;
    if (name && (def.name_hints || []).some(h => name.includes(h))) return true;
  }
  return false;
}

/** Signature of a list row: a change in any of these means the detail must be read again */
const rowSig = row => `${row.last_modified_time || ''}|${r2(row.balance)}|${row.status || ''}|${r2(row.total)}`;

function lineTax(l) {
  if (Array.isArray(l.line_item_taxes) && l.line_item_taxes.length) return l.line_item_taxes.reduce((s, t) => s + (Number(t.tax_amount) || 0), 0);
  const amt = Number(l.item_total ?? (Number(l.rate) || 0) * (Number(l.quantity) || 0)) || 0;
  return amt * (Number(l.tax_percentage) || 0) / 100;
}

/** The Zoho bill detail → what the cash flow needs (amounts in rupees) */
function compactBill(raw) {
  const fx = raw.currency_code && raw.currency_code !== 'INR' && Number(raw.exchange_rate) > 0 ? Number(raw.exchange_rate) : 1;
  const m = n => r2((Number(n) || 0) * fx);
  return {
    id: String(raw.bill_id), no: raw.bill_number || '', date: raw.date || '', due: raw.due_date || '', status: raw.status || '',
    lmt: raw.last_modified_time || '', vid: String(raw.vendor_id || ''), vn: raw.vendor_name || '',
    br: raw.branch_name || raw.location_name || '', ref: raw.reference_number || '', cur: raw.currency_code || 'INR',
    sub: m(raw.sub_total), tax: m(raw.tax_total), tds: m(raw.tds_amount ?? raw.tds_total), total: m(raw.total), bal: m(raw.balance), adj: m(raw.adjustment),
    lines: (raw.line_items || []).map(l => ({
      acc: String(l.account_id || ''), an: l.account_name || '', d: String(l.description || l.name || '').slice(0, 400),
      amt: m(l.item_total ?? (Number(l.rate) || 0) * (Number(l.quantity) || 0)), tax: m(lineTax(l)), tn: l.tax_name || '', tds: m(l.tds_tax_amount),
    })),
    pays: (raw.payments || []).map(p => ({
      pid: String(p.payment_id || ''), no: p.payment_number || '', date: p.date || '', apply: p.apply_date || p.date || '',
      amt: m(p.amount), ref: p.reference_number || '', mode: p.payment_mode || '', acct: p.paid_through_account_name || '',
    })),
    creds: (raw.vendor_credits || []).map(c => ({
      id: String(c.vendor_credit_id || c.credit_id || ''), no: c.vendor_credit_number || c.credit_number || '',
      date: c.date || c.applied_date || c.vendor_credit_date || '', amt: m(c.amount ?? c.amount_applied ?? c.applied_amount),
    })),
  };
}

/**
 * One part per category on the bill. A part carries its share `w` of the bill (its lines' value with GST over all lines'),
 * which also splits the payments, credits and Zoho's balance; net payable = the bill's total (after TDS) × w.
 */
function partsOf(bill, accCat) {
  const by = new Map();
  let allBasic = 0, allGross = 0, lineTds = 0;
  for (const l of bill.lines || []) {
    allBasic += l.amt; allGross += l.amt + l.tax; lineTds += l.tds || 0;
    const c = accCat.get(l.acc);
    if (!c) continue;
    if (!by.has(c)) by.set(c, { basic: 0, gst: 0, tds: 0, lines: [] });
    const p = by.get(c);
    p.basic += l.amt; p.gst += l.tax; p.tds += l.tds || 0;
    p.lines.push(l);
  }
  const out = [];
  for (const [category, p] of by) {
    const w = allGross > 0 ? (p.basic + p.gst) / allGross : (allBasic > 0 ? p.basic / allBasic : 1);
    const tds = lineTds > 0 ? p.tds : (allBasic > 0 ? bill.tds * p.basic / allBasic : 0);
    out.push({ category, w, basic: r2(p.basic), gst: r2(p.gst), gross: r2(p.basic + p.gst), tds: r2(tds), net: r2(bill.total * w), lines: p.lines });
  }
  // the shares of one bill add up to its total exactly: the rounding difference goes to the largest part
  if (out.length > 1 && Math.abs(out.reduce((s, p) => s + p.w, 0) - 1) < 1e-9) {
    const diff = r2(bill.total - out.reduce((s, p) => s + p.net, 0));
    if (diff) out.sort((a, b) => b.net - a.net)[0].net = r2(out[0].net + diff);
  }
  return out;
}

// ── Wording on the bill ────────────────────────────────────────────────────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = n => String(n).padStart(2, '0');
const year4 = y => { const n = Number(y); return n < 100 ? 2000 + n : n; };
function dateOf(d, mo, y) {
  const m = /^\d+$/.test(String(mo)) ? Number(mo) : MONTHS[lc(mo)];
  const day = Number(d), yy = year4(y);
  if (!m || m > 12 || !day || day > 31 || yy < 2000 || yy > 2100) return null;
  return `${yy}-${pad(m)}-${pad(day)}`;
}
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE = `(\\d{1,2})[\\s./-]*(\\d{1,2}|${MON})[\\s.,/-]*(\\d{2,4})`;
const RANGE_RE = new RegExp(`${DATE}\\s*(?:to|till|until|upto|up to|-|–|—)\\s*${DATE}`, 'i');
const MONTH_YEAR_RE = new RegExp(`\\b${MON}[\\s'’.,/-]*(\\d{4}|\\d{2})\\b`, 'gi');

/** A service / billing period in the text: { from, to, label, source } (a month name, or a date range) | null */
function periodOf(text) {
  const t = String(text || '');
  const r = t.match(RANGE_RE);
  if (r) {
    const from = dateOf(r[1], r[2], r[4]);
    const to = dateOf(r[5], r[6], r[8]);
    if (from && to && from <= to) return { from, to, label: `${from.slice(8)}/${from.slice(5, 7)}/${from.slice(2, 4)} – ${to.slice(8)}/${to.slice(5, 7)}/${to.slice(2, 4)}`, source: 'bill text' };
  }
  const months = [];
  let m;
  MONTH_YEAR_RE.lastIndex = 0;
  while ((m = MONTH_YEAR_RE.exec(t))) {
    const mo = MONTHS[lc(m[1]).replace(/[^a-z]/g, '')] || MONTHS[lc(m[1]).slice(0, 3)];
    const y = year4(m[2]);
    if (mo && y >= 2000 && y <= 2100) months.push(`${y}-${pad(mo)}`);
  }
  if (months.length) {
    const s = [...new Set(months)].sort();
    const lab = x => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(x.slice(5)) - 1]}-${x.slice(2, 4)}`;
    return { from: `${s[0]}-01`, to: `${s[s.length - 1]}-28`, label: s.length === 1 ? lab(s[0]) : `${lab(s[0])} to ${lab(s[s.length - 1])}`, source: 'bill text' };
  }
  return null;
}

// the keyword is a whole word ("CA No 123", not the "ca" in "Capital One") and a number follows (letters alone are not a meter)
const NUM_RE = /\b(?:consumer|service|meter|account|ca|connection|k\s*no)\b\.?\s*(?:no\.?|number|#|id)?\s*[:\-–]?\s*([A-Z0-9/-]*\d[A-Z0-9/-]{2,})/i;
/** Electricity connection: the consumer / meter number in the text, else the part of the vendor name after the provider */
function connectionOf(vendorName, text) {
  const n = String(text || '').match(NUM_RE);
  const vn = String(vendorName || '');
  const dash = vn.match(/(?:\s[-–_]\s?|-\s|\s-)(.*\d.*)$/);
  const tail = dash ? dash[1].trim() : (vn.match(/\b([A-Z]?-?\d[\w\s,&()-]*)$/i)?.[1] || '').trim();
  return { meter: n ? n[1] : '', connection: tail || '' };
}

const STOP = /\b(private|pvt|ltd|limited|llp|inc|co|company|the|india|and|&)\b/g;
const norm = s => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(STOP, ' ').replace(/\s+/g, ' ').trim()} `;

/** Customers once per request: [{ name, n (normalised) }] */
function customerIndex(names) {
  const seen = new Set();
  const out = [];
  for (const name of names || []) {
    const n = norm(name);
    if (n.trim().length < 4 || seen.has(n)) continue;
    seen.add(n);
    out.push({ name, n });
  }
  return out.sort((a, b) => b.n.length - a.n.length);
}

/**
 * The client a brokerage bill is for, from the bill's wording: an explicit "Client: …", or one of our customers named in it.
 * → { client, source: 'bill text'|'', options: [names when several fit] }
 */
function clientOf(text, customers) {
  const t = String(text || '');
  const nt = norm(t);
  const hits = [];
  for (const c of customers || []) {
    if (nt.includes(c.n) && !hits.some(h => h.n.includes(c.n))) hits.push(c);
  }
  if (hits.length === 1) return { client: hits[0].name, source: 'bill text', options: [] };
  if (hits.length > 1) return { client: '', source: '', options: hits.slice(0, 6).map(h => h.name) };
  const ex = t.match(/\b(?:client|customer|tenant|for)\s*(?:name)?\s*[:\-–]\s*([A-Za-z0-9&.' ()-]{3,80})/i);
  if (ex) return { client: ex[1].replace(/[,.;\s]+$/, '').trim(), source: 'bill text', options: [] };
  // not one of our customers by name: a suggestion from the wording ("… for Groww at DevX", "Charges-AM incred.com SAC") — to check
  const GENERIC = /^(the|a|an|month|office|period|rent|brokerage|charges?|leasing|lease|services?|seats?|space|cabin|closing)\b/i;
  const am = t.match(/-\s*AM\s+(.{2,60}?)\s+SAC\b/i);
  if (am && !GENERIC.test(am[1].trim())) return { client: am[1].trim(), source: 'bill text (suggested)', options: [] };
  const re = /\bfor\s+(?:m\/s\.?\s*)?([A-Za-z0-9][\w&.'-]*(?:\s+[A-Za-z0-9][\w&.'-]*){0,4}?)\s*(?=\bat\b|\bin\b|@|,|\.\s|\n|$)/gi;
  let m;
  while ((m = re.exec(t))) {
    const s = m[1].trim();
    if (s.length >= 3 && !GENERIC.test(s) && !/\d{3,}/.test(s)) return { client: s, source: 'bill text (suggested)', options: [] };
  }
  return { client: '', source: '', options: [] };
}

module.exports = { accountCategories, isCandidate, rowSig, compactBill, partsOf, periodOf, connectionOf, clientOf, customerIndex, norm, r2 };
