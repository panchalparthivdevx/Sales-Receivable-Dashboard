/**
 * Which company the bill belongs to, which Zoho vendor issued it, and which bill category it is.
 * Each answer carries its basis (shown to the team) and whether it is sure enough to use unasked.
 */

'use strict';

const T = require('./text');
const A = require('./accounts');

// ── Company ───────────────────────────────────────────────────────────────────

const companyGstins = c => [...(c.gstins || []), ...(c.gstins_auto || [])];
const companyPans = c => [...(c.pans || []), ...companyGstins(c).map(T.panOf)];

/** → { id, basis, sure, unknownGstin } */
function detectCompany({ fields = {}, text = '', member, companies }) {
  const ofGstin = g => companies.find(c => companyGstins(c).includes(g) || companyPans(c).includes(T.panOf(g)));
  if (fields.buyer_gstin) {
    const c = ofGstin(fields.buyer_gstin);
    if (c) return { id: c.id, basis: `Billed-to GSTIN ${fields.buyer_gstin} belongs to ${c.name}`, sure: true };
  }
  for (const g of new Set(String(text).toUpperCase().match(T.GSTIN_RE) || [])) {
    if (g === fields.vendor_gstin) continue;
    const c = ofGstin(g);
    if (c) return { id: c.id, basis: `The bill shows ${c.name}'s GSTIN ${g}`, sure: true };
  }
  const hay = `${fields.buyer_name || ''}\n${String(text).slice(0, 4000)}`.toLowerCase();
  const named = companies.filter(c => (c.name_hints || []).some(h => h && hay.includes(h)));
  if (named.length === 1) return { id: named[0].id, basis: `The bill is addressed to ${named[0].name}`, sure: true };
  const known = companies.some(c => companyGstins(c).length || (c.pans || []).length);
  if (fields.buyer_gstin && known) {
    return { id: '', basis: `Billed-to GSTIN ${fields.buyer_gstin} is not one of the configured companies`, sure: false, unknownGstin: true };
  }
  const own = member?.companies || [];
  if (own.length === 1) {
    const c = companies.find(x => x.id === own[0]);
    return { id: own[0], basis: `Company not printed on the bill — taken from the receiving team member (${c?.name || own[0]})`, sure: false };
  }
  return { id: '', basis: 'The company could not be identified from the bill', sure: false };
}

// ── Vendor ────────────────────────────────────────────────────────────────────

/** Synced vendors_all rows → the fields matching needs */
function vendorIndex(rows) {
  return (rows || []).map(v => ({
    id: v.contact_id, name: v.contact_name || v.vendor_name || v.company_name || '',
    gstin: String(v.gst_no || '').toUpperCase(), pan: String(v.pan_no || '').toUpperCase() || T.panOf(String(v.gst_no || '').toUpperCase()),
    email: String(v.email || '').toLowerCase(), status: v.status || 'active',
    zoho_category: v.cf_vendor_category_formatted || v.cf_vendor_category || '',
    gst_treatment: v.gst_treatment || '',
  }));
}

/** → { id, name, match, confidence, basis, candidates[] } (id empty when the team must choose) */
function matchVendor({ fields = {}, fromEmail = '', vendors }) {
  const out = (v, match, confidence, basis, candidates = []) => ({
    id: v?.id || '', name: v?.name || '', match, confidence, basis, candidates: candidates.slice(0, 8).map(c => ({ id: c.id, name: c.name, gstin: c.gstin, status: c.status })),
  });
  const g = fields.vendor_gstin;
  if (g) {
    const exact = vendors.filter(v => v.gstin === g);
    const active = exact.filter(v => v.status !== 'inactive');
    if (active.length === 1) return out(active[0], 'gstin', 'high', `GSTIN ${g} matches Zoho vendor "${active[0].name}"`);
    if (active.length > 1) return out(null, 'gstin', 'low', `GSTIN ${g} is on ${active.length} Zoho vendors — choose one`, active);
    if (exact.length) return out(null, 'gstin', 'low', `GSTIN ${g} belongs to an inactive Zoho vendor "${exact[0].name}"`, exact);
    const pan = T.panOf(g);
    const samePan = vendors.filter(v => v.pan && v.pan === pan && v.status !== 'inactive');
    if (samePan.length) return out(null, 'pan', 'low', `No Zoho vendor has GSTIN ${g}; ${samePan.length} vendor(s) share its PAN ${pan} (another state's registration?)`, samePan);
  }
  const email = String(fromEmail).toLowerCase();
  const scored = vendors.filter(v => v.status !== 'inactive' && fields.vendor_name)
    .map(v => ({ v, s: T.nameSimilarity(fields.vendor_name, v.name) + (email && v.email === email ? 0.3 : 0) }))
    .filter(x => x.s >= 0.6).sort((a, b) => b.s - a.s);
  if (!g && scored.length && scored[0].s >= 0.9 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.2)) {
    return out(scored[0].v, 'name', 'medium', `No GSTIN on the bill — name "${fields.vendor_name}" matches Zoho vendor "${scored[0].v.name}"`);
  }
  if (scored.length) {
    return out(null, 'name', 'low', g ? `No Zoho vendor has GSTIN ${g} — similar names found` : `Vendor "${fields.vendor_name}" — similar Zoho vendors found`, scored.map(x => x.v));
  }
  if (!g && email) {
    const byEmail = vendors.filter(v => v.email === email && v.status !== 'inactive');
    if (byEmail.length) return out(null, 'email', 'low', `Sender ${email} is the email of ${byEmail.length} Zoho vendor(s)`, byEmail);
  }
  return out(null, 'none', 'none', g ? `No Zoho vendor has GSTIN ${g} — create the vendor in Zoho or choose one` : 'Vendor not found in Zoho — choose the vendor');
}

// ── Category ──────────────────────────────────────────────────────────────────

function countHits(hay, kw) {
  if (!kw) return 0;
  const re = new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s\\-]+')}($|[^a-z0-9])`, 'g');
  return (hay.match(re) || []).length;
}

/**
 * Scores each active category from (1) the bill's own description and lines, (2) the email,
 * (3) this vendor's earlier bills in this module and its Zoho vendor category, and (4) the receiving
 * team member's categories (a tie-breaker only — never enough on its own).
 * → { id, name, source, confidence, basis, scores[] } (id empty when not sure)
 */
function categorise({ bill, categories, member, vendorHistory = [], vendorZohoCategory = '', minScore = 3 }) {
  const active = categories.filter(c => c.active !== false);
  const billText = [bill.fields?.description, ...(bill.lines || []).map(l => l.description)].join('\n').toLowerCase();
  const mailText = [bill.source_ref?.subject, bill.source_ref?.attachment_name].join('\n').toLowerCase();
  const bodyText = String(bill.source_ref?.body_preview || '').toLowerCase();
  const zohoCat = String(vendorZohoCategory || '').toLowerCase();
  const weight = kw => (kw.includes(' ') ? 1.5 : 1);

  const scores = active.map(c => {
    let s = 0;
    const reasons = [];
    for (const kw of c.keywords || []) {
      const b = countHits(billText, kw), m = countHits(mailText, kw), e = countHits(bodyText, kw);
      const add = (Math.min(b, 3) * 2 + Math.min(m, 2) + Math.min(e, 2) * 0.5) * weight(kw);
      if (add) { s += add; reasons.push(`"${kw}" in ${[b && 'bill', m && 'email subject', e && 'email text'].filter(Boolean).join(' + ')}`); }
    }
    const prev = vendorHistory.filter(h => h.category_id === c.id).length;
    if (prev) { s += Math.min(prev, 3) * 1.5; reasons.push(`${prev} earlier bill(s) of this vendor booked as this category`); }
    if (zohoCat && ((c.vendor_category_aliases || []).some(a => zohoCat.includes(a)) || (c.keywords || []).some(k => k.length > 3 && zohoCat.includes(k)))) {
      s += 1.5; reasons.push(`Zoho vendor category "${vendorZohoCategory}"`);
    }
    if (s > 0 && member?.categories?.includes(c.id)) { s += 0.5; reasons.push('assigned to the receiving team member'); }
    return { id: c.id, name: c.name, score: Math.round(s * 10) / 10, reasons };
  }).sort((a, b) => b.score - a.score);

  const [top, second] = scores;
  if (!top || top.score === 0) {
    const mine = (member?.categories || []).filter(id => active.some(c => c.id === id));
    return { id: '', name: '', source: '', confidence: 'none', scores: scores.slice(0, 5),
      basis: mine.length ? 'Nothing on the bill points to a category — choose one (the receiving team member handles ' + mine.map(id => active.find(c => c.id === id).name).join(', ') + ')' : 'Nothing on the bill points to a category — choose one' };
  }
  const clear = top.score >= minScore && (!second || top.score >= second.score * 1.5);
  const basis = `${top.reasons.slice(0, 4).join('; ')}${second && second.score ? ` (next: ${second.name} ${second.score})` : ''}`;
  if (!clear) return { id: '', name: '', source: '', confidence: 'low', scores: scores.slice(0, 5), suggested: top.id, basis: `Not clear — ${top.name} scores ${top.score}: ${basis}` };
  const fromHistory = top.reasons.some(r => r.includes('earlier bill'));
  return { id: top.id, name: top.name, source: fromHistory && top.reasons.length === 1 ? 'history' : 'description', confidence: top.score >= minScore * 2 ? 'high' : 'medium', scores: scores.slice(0, 5), basis };
}

// ── Category from the vendor's similar bill already booked in Zoho ─────────────

// The Zoho bill's own category fields, in the order they are trusted: "Category", then "Vendor Category"
const ZOHO_CATEGORY_FIELDS = ['cf_category', 'cf_vendor_category'];
const normCat = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** A Zoho bill's category values → [{ api_name, customfield_id, label, value }] (filled ones only) */
function zohoCategoryValues(h) {
  return ZOHO_CATEGORY_FIELDS.map(k => (h.custom_fields || []).find(c => c.api_name === k))
    .filter(c => c && normCat(c.value))
    .map(c => ({ api_name: c.api_name, customfield_id: c.customfield_id || '', label: c.label || c.api_name, value: String(c.value).trim() }));
}

/** The bill category whose "Zoho categories" list names one of these values (Category first) → category | null */
function categoryOfZoho(values, categories) {
  for (const v of values) {
    const hits = categories.filter(c => c.active !== false && (c.vendor_category_aliases || []).some(a => normCat(a) === normCat(v.value)));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/**
 * The vendor's earlier Zoho bill most like this bill (same rule as the expense account: similar lines, not the
 * vendor alone) gives the category it was booked under in Zoho, translated to a bill category through each
 * category's "Zoho categories" list.
 * → { category|null, zoho: values of the similar bill, ref, maps_to, status, basis }
 *   status: 'matched' | 'unmapped' (Zoho category not linked to a bill category) | 'no_zoho_category'
 *           | 'inconsistent' (similar bills booked under different categories) | 'no_similar' | 'no_history'
 */
function categoryFromZohoBills({ bill, historyBills = [], categories = [], threshold = 0.5 }) {
  if (!historyBills.length) return { category: null, status: 'no_history', basis: '' };
  const sims = A.similarBills(bill, historyBills).filter(x => x.s >= threshold);
  if (!sims.length) return { category: null, status: 'no_similar', basis: `No earlier Zoho bill of this vendor is similar enough to take its category from` };
  for (const x of sims) { x.values = zohoCategoryValues(x.h); x.cat = categoryOfZoho(x.values, categories); }
  const top = sims.find(x => x.values.length);
  const label = x => x.values.map(v => `${v.label} "${v.value}"`).join(', ');
  const refOf = x => ({ bill_id: x.h.bill_id, bill_number: x.h.bill_number, date: x.h.date, similarity: Math.round(x.s * 100) / 100 });
  if (!top) return { category: null, status: 'no_zoho_category', basis: `The similar Zoho bill ${A.fmtRef(sims[0].h)} has no Category in Zoho` };
  const out = { zoho: top.values, ref: refOf(top), maps_to: top.cat?.id || '' };
  if (!top.cat) {
    return { ...out, category: null, status: 'unmapped',
      basis: `The similar Zoho bill ${A.fmtRef(top.h)} (${A.pct(top.s)} similar) is booked as ${label(top)} — no bill category lists it under "Zoho categories" (Categories & Fields)` };
  }
  const rival = sims.find(x => x.cat && x.cat.id !== top.cat.id && top.s - x.s < 0.25);
  if (rival) {
    return { ...out, category: null, status: 'inconsistent', suggested: top.cat.id,
      basis: `Similar Zoho bills of this vendor were booked under different categories: ${A.fmtRef(top.h)} as ${label(top)}; ${A.fmtRef(rival.h)} as ${label(rival)} — choose the category` };
  }
  return {
    ...out, status: 'matched',
    category: {
      id: top.cat.id, name: top.cat.name, source: 'zoho_bill', confidence: top.s >= 0.75 ? 'high' : 'medium',
      basis: `As booked in Zoho on the vendor's similar ${A.fmtRef(top.h)} (${A.pct(top.s)} similar): ${label(top)}`,
      ref: refOf(top),
    },
  };
}

module.exports = { detectCompany, vendorIndex, matchVendor, categorise, categoryFromZohoBills, zohoCategoryValues, categoryOfZoho, companyGstins, companyPans, ZOHO_CATEGORY_FIELDS };
