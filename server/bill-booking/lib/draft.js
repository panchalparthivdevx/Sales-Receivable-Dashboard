/**
 * The Zoho Books bill created as a DRAFT from a validated bill. Only what is confirmed goes in:
 * vendor, invoice number/dates, lines with their accounts, GST taxes chosen per the rules in
 * accounts.js, branch/TDS from consistent history or the team, and the category fields the user
 * mapped to Zoho fields. `is_draft: true` keeps it out of the books until the team opens it in Zoho.
 */

'use strict';

const T = require('./text');

function lineQtyRate(l) {
  const q = Number(l.quantity), r = Number(l.rate), a = Number(l.amount);
  if (q > 0 && r > 0 && Math.abs(T.round2(q * r) - a) < 0.01) return { quantity: q, rate: r };
  return { quantity: 1, rate: T.round2(a) };
}

const fieldOut = (def, value) => {
  if (value && typeof value === 'object') return def.zoho.target === 'bill_custom_field' ? value.name : value.id;
  if (def.type === 'number') return Number(value);
  if (def.type === 'date') return T.parseDate(value);
  return String(value);
};

/**
 * bill: validated record; category: its category definition; customFieldIds: api_name → customfield_id
 * (from this organisation's bills); note: text for the bill's notes.
 */
function buildPayload(bill, { category, customFieldIds = {}, note = '' } = {}) {
  const f = bill.fields;
  const p = {
    vendor_id: bill.vendor.id,
    bill_number: f.invoice_number,
    date: f.invoice_date,
    is_draft: true,
    line_items: bill.lines.map((l, i) => {
      const li = {
        account_id: l.account.id,
        description: String(l.description || f.description || '').slice(0, 2000),
        ...lineQtyRate(l),
        item_order: i + 1,
      };
      if (l.tax?.id) li.tax_id = l.tax.id;
      if (l.hsn_sac) li.hsn_or_sac = l.hsn_sac;
      return li;
    }),
  };
  if (f.due_date) p.due_date = f.due_date;
  if (f.currency && f.currency !== 'INR' && f.exchange_rate > 0) p.exchange_rate = Number(f.exchange_rate);
  if (f.round_off) { p.adjustment = T.round2(f.round_off); p.adjustment_description = 'Round off (as per bill)'; }
  if (bill.bill_level?.branch?.id) p.branch_id = bill.bill_level.branch.id;
  if (bill.bill_level?.tds?.id) p.tds_tax_id = bill.bill_level.tds.id;
  if (note) p.notes = note.slice(0, 1000);

  const custom = [];
  for (const def of category?.fields || []) {
    if (!def.zoho || def.zoho.target === 'none') continue;
    const st = bill.cat_field_state?.[def.id];
    if (!st || st.value === '' || st.value == null) continue;
    const v = fieldOut(def, st.value);
    if (def.zoho.target === 'bill_field') p[def.zoho.key] = v;
    else if (def.zoho.target === 'line_field') p.line_items.forEach(li => { li[def.zoho.key] = v; });
    else if (def.zoho.target === 'bill_custom_field') {
      const id = customFieldIds[def.zoho.key];
      custom.push(id ? { customfield_id: id, value: v } : { api_name: def.zoho.key, value: v });
    }
  }
  if (custom.length) p.custom_fields = custom;
  return p;
}

/** Plain-language explanation for the reviewer, added as a comment on the Zoho draft */
function reviewComment(bill) {
  const parts = [`Prepared from ${bill.source === 'email' ? `an email to ${bill.source_ref?.mailbox}` : 'an ERP upload'} (${bill.id}).`];
  if (bill.category?.name) parts.push(`Category: ${bill.category.name} — ${bill.category.source === 'manual' ? `chosen by ${bill.category.by || 'the team'}` : bill.category.basis}.`);
  bill.lines.forEach((l, i) => {
    parts.push(`Line ${i + 1} account ${l.account?.name}: ${l.account?.source === 'manual' ? `chosen by ${l.account.by || 'the team'}` : l.account?.basis}.`);
    if (l.tax?.id) parts.push(`Line ${i + 1} tax ${l.tax.name}: ${l.tax.source === 'manual' ? `chosen by ${l.tax.by || 'the team'}` : l.tax.basis}.`);
  });
  const warns = (bill.issues || []).filter(x => x.severity === 'warn').map(x => x.message);
  if (warns.length) parts.push(`Check: ${warns.slice(0, 5).join(' | ')}`);
  return parts.join('\n').slice(0, 2000);
}

module.exports = { buildPayload, reviewComment, lineQtyRate };
