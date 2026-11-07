/**
 * Expense account (and GST tax) for each bill line, and bill-level settings (branch, TDS).
 *
 * Order for the account:
 *   1. A confirmed mapping (the team chose the account before for this company + vendor + category and
 *      a similar description, or for the vendor as a whole).
 *   2. The vendor's recent bills in the same organisation: a historical line with a similar description
 *      (and HSN/SAC) gives its account — never the vendor alone, since one vendor can bill different things.
 *   3. Otherwise the team chooses (the accounts used before are offered first).
 * GST tax is applied only when it is confirmed: a mapping, or the same tax used on this vendor's earlier
 * lines of the same account with the same rate and the same IGST / CGST+SGST split as this bill.
 */

'use strict';

const T = require('./text');

const pct = n => `${Math.round(n * 100)}%`;
const fmtRef = h => `bill ${h.bill_number || h.bill_id} dated ${h.date}`;

// ── Mappings ──────────────────────────────────────────────────────────────────

function mappingFor(line, { mappings, company, vendorId, categoryId, threshold }) {
  const pool = (mappings || []).filter(m => m.active !== false && m.company === company && m.vendor_id === vendorId
    && (!m.category_id || !categoryId || m.category_id === categoryId) && m.account_id);
  let best = null;
  for (const m of pool) {
    const s = m.description ? T.similarity(line.description, m.description) : 0;
    if (m.description && s >= threshold && (!best || s > best.s || best.vendorWide)) best = { m, s, vendorWide: false };
    if (!m.description && !best) best = { m, s: 0, vendorWide: true };
  }
  return best;
}

// ── History ───────────────────────────────────────────────────────────────────

/**
 * historyBills: compact Zoho bills (lines with account, tax, HSN/SAC) of this vendor, newest first.
 * → { account|null, alternatives[], status: 'matched'|'inconsistent'|'no_match'|'no_history', basis }
 */
function fromHistory(line, historyBills, threshold) {
  if (!historyBills.length) return { account: null, alternatives: [], status: 'no_history', basis: 'The vendor has no bills in Zoho in the history window' };
  const used = new Map();
  const hits = [];
  for (const h of historyBills) {
    for (const hl of h.lines || []) {
      if (!hl.account_id) continue;
      if (!used.has(hl.account_id)) used.set(hl.account_id, { id: hl.account_id, name: hl.account_name, count: 0 });
      used.get(hl.account_id).count++;
      let s = T.similarity(line.description, hl.description);
      if (line.hsn_sac && hl.hsn_or_sac && line.hsn_sac === String(hl.hsn_or_sac)) s = Math.min(1, s + 0.15);
      if (s >= threshold) hits.push({ s, h, hl });
    }
  }
  const alternatives = [...used.values()].sort((a, b) => b.count - a.count);
  if (!hits.length) {
    return { account: null, alternatives, status: 'no_match', basis: !line.description
      ? 'The line has no description to compare with earlier bills'
      : `No earlier line of this vendor is similar enough to "${line.description.slice(0, 60)}"` };
  }
  const groups = new Map();
  for (const x of hits) {
    const g = groups.get(x.hl.account_id) || { id: x.hl.account_id, name: x.hl.account_name, best: x, n: 0 };
    g.n++;
    if (x.s > g.best.s) g.best = x;
    groups.set(x.hl.account_id, g);
  }
  const ranked = [...groups.values()].sort((a, b) => b.best.s - a.best.s || b.n - a.n);
  const [top, next] = ranked;
  if (next && top.best.s - next.best.s < 0.25) {
    return { account: null, alternatives: ranked.map(g => ({ id: g.id, name: g.name, count: g.n })).concat(alternatives.filter(a => !groups.has(a.id))),
      status: 'inconsistent', basis: `Similar earlier lines were booked to different accounts: ${ranked.slice(0, 3).map(g => `${g.name} (${fmtRef(g.best.h)}, ${pct(g.best.s)})`).join('; ')}` };
  }
  const b = top.best;
  return {
    account: {
      id: top.id, name: top.name, source: 'history', confidence: b.s >= 0.75 ? 'high' : 'medium',
      basis: `Similar to "${String(b.hl.description).slice(0, 80)}" on ${fmtRef(b.h)} (${pct(b.s)} similar${top.n > 1 ? `, ${top.n} similar lines` : ''})`,
      ref: { bill_id: b.h.bill_id, bill_number: b.h.bill_number, date: b.h.date, similarity: Math.round(b.s * 100) / 100 },
    },
    alternatives, status: 'matched',
    basis: next ? `Less similar lines used ${next.name}` : '',
  };
}

// ── GST tax ───────────────────────────────────────────────────────────────────

const SLABS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
const nearestSlab = r => SLABS.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), 0);

/** The bill's GST: { kind: 'igst'|'intra'|'none', rate } for one line */
function billTax(line, fields) {
  const kind = fields.igst > 0 ? 'igst' : (fields.cgst > 0 || fields.sgst > 0) ? 'intra' : (fields.tax_total > 0 ? 'unknown' : 'none');
  let rate = line.tax_rate;
  if (rate == null && line.tax_amount != null && line.amount) rate = (line.tax_amount / line.amount) * 100;
  if (rate == null && fields.sub_total) rate = ((fields.tax_total || 0) / fields.sub_total) * 100;
  return { kind, rate: rate == null ? null : nearestSlab(rate) };
}

function taxKind(t) {
  if (!t) return 'none';
  if (t.specific === 'igst' || /igst/i.test(t.name)) return 'igst';
  return 'intra';
}

/**
 * → { tax: { id, name, source, basis } | null, needed: bool, issue: string|'' }
 *   needed=false: no GST on the line (nothing to apply).
 */
function suggestTax(line, accountId, { fields, taxes, mappings, company, vendorId, historyBills }) {
  const bt = billTax(line, fields);
  if (bt.kind === 'none' || bt.rate === 0) {
    return { tax: null, needed: false, issue: '', basis: 'No GST on the bill' };
  }
  const byId = new Map((taxes || []).map(t => [t.id, t]));
  const fits = t => t && Math.abs(t.percentage - bt.rate) < 0.01 && (bt.kind === 'unknown' || taxKind(t) === bt.kind);
  const want = `${bt.kind === 'igst' ? 'IGST' : bt.kind === 'intra' ? 'CGST+SGST' : 'GST'} ${bt.rate}%`;

  const m = (mappings || []).find(x => x.active !== false && x.company === company && x.vendor_id === vendorId && x.account_id === accountId && x.tax_id);
  if (m && fits(byId.get(m.tax_id))) {
    return { tax: { id: m.tax_id, name: byId.get(m.tax_id).name, source: 'mapping', basis: `Confirmed for this vendor and account by ${m.updated_by || m.created_by || 'the team'}` }, needed: true, issue: '' };
  }
  const used = new Map();
  let ref = null;
  for (const h of historyBills || []) {
    for (const hl of h.lines || []) {
      if (hl.account_id !== accountId || !hl.tax_id) continue;
      used.set(hl.tax_id, (used.get(hl.tax_id) || 0) + 1);
      if (!ref) ref = h;
    }
  }
  if (used.size === 1) {
    const [taxId] = used.keys();
    const t = byId.get(taxId);
    if (fits(t)) return { tax: { id: taxId, name: t.name, source: 'history', basis: `Same GST as this vendor's earlier lines on this account (${fmtRef(ref)})` }, needed: true, issue: '' };
    return { tax: null, needed: true, issue: `GST not confirmed: the bill shows ${want}, earlier bills of this account used ${t ? t.name : 'another tax'} — choose the Zoho tax` };
  }
  if (used.size > 1) return { tax: null, needed: true, issue: `GST not confirmed: earlier bills of this account used different taxes — choose the Zoho tax for ${want}` };
  return { tax: null, needed: true, issue: `GST not confirmed for this vendor and account — choose the Zoho tax for ${want}` };
}

// ── Bill-level settings ───────────────────────────────────────────────────────

/** Branch / TDS used on every recent bill of the vendor → applied with that basis; mixed → left for the team */
function billLevel(historyBills, listRows = []) {
  const out = {};
  const n = historyBills.length;
  if (!n) return out;
  const same = key => {
    const vals = new Set(historyBills.map(h => h[key] || ''));
    return vals.size === 1 ? [...vals][0] : null;
  };
  const br = same('branch_id');
  if (br) out.branch = { id: br, name: historyBills[0].branch_name, source: 'history', basis: `All ${n} recent bill(s) of this vendor use this branch` };
  const tds = same('tds_tax_id');
  if (tds) out.tds = { id: tds, name: historyBills[0].tds_tax_name || 'TDS', source: 'history', basis: `All ${n} recent bill(s) of this vendor deduct this TDS` };
  else if (same('tds_tax_id') === '' && listRows.some(r => r.tds_total > 0)) {
    out.tds_note = 'Earlier bills of this vendor show TDS, but the TDS section could not be read — the reviewer applies TDS in Zoho';
  } else if (!same('tds_tax_id') && historyBills.some(h => h.tds_tax_id)) {
    out.tds_note = 'Earlier bills of this vendor used different TDS sections — the reviewer applies TDS in Zoho';
  }
  return out;
}

module.exports = { mappingFor, fromHistory, suggestTax, billTax, billLevel, taxKind, nearestSlab };
