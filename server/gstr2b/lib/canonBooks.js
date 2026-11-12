/**
 * Zoho Books → canonical Books document.
 *
 * Built on the field shapes verified against the live DevX and Neddle organisations (11 Nov 2026):
 *   - recipient GSTIN  = the branch's `tax_reg_no` (/branches); bills carry only branch_id / location_id
 *   - supplier GSTIN   = the bill's own `gst_no` (copied from the vendor when the bill was made)
 *   - tax components   = `taxes[]` entries named "IGST18 (18%)", "CGST9 (9%)", "SGST9 (9%)" (also line_item_taxes[])
 *   - reverse charge   = `is_reverse_charge_applied`; its tax sits on the lines (reverse_charge_tax_amount), not in taxes[]
 *   - taxable value    = `sub_total` (less any bill-level discount); `total` is NET OF TDS and is never used as invoice value
 *   - supplier invoice date = a custom field (DevX: cf_vendor_bill_date); Zoho's `date` is the posting date
 *   - place of supply  = destination_of_supply, a 2-letter state code
 * The original Zoho numbers are kept (amounts in paise as read); normalised copies sit next to them.
 */

'use strict';

const { toPaise, p0, zeroAmounts } = require('./money');
const N = require('./normalize');
const { hashOf } = require('./util');

const EXCLUSIONS = {
  void: 'Void in Zoho',
  draft: 'Draft in Zoho (not posted)',
  deleted: 'Deleted in Zoho',
  opening_balance: 'Opening-balance bill — no GST detail',
  no_supplier_gstin: 'No supplier GSTIN (unregistered, consumer or overseas supplier) — cannot appear in GSTR-2B',
  composition_supplier: 'Supplier is under the composition scheme — no ITC, not in GSTR-2B',
  recipient_unmapped: 'The document\'s branch has no GSTIN in Zoho — cannot be placed in a GSTIN reconciliation',
  gstin_off: 'The document\'s GSTIN is switched off (Settings → Companies & GSTINs) — its amounts are read from Zoho once the GSTIN is switched on',
  outside_period: 'Dated before the first month synced — its amounts are read when a period that includes it is synced',
  foreign_currency: 'Not in INR — GSTR-2B documents are in INR',
  no_gst: 'No GST on the document',
  incomplete: 'Incomplete data — see the data-quality notes',
};
const GSTIN_TREATMENTS_OK = new Set(['business_gst', 'business_sez', 'sez_developer', '']);

const classifyTax = name => {
  const n = String(name || '').trim().toUpperCase();
  if (/^IGST/.test(n)) return 'igst';
  if (/^CGST/.test(n)) return 'cgst';
  if (/^(SGST|UTGST)/.test(n)) return 'sgst';
  if (/CESS/.test(n)) return 'cess';
  return null;
};
const zohoUrl = (org, kind, id) => `https://books.zoho.in/app/${org}#/${kind}/${id}`;
const ymdOf = v => N.parseDate(v);

/** The supplier's invoice date from the configured custom field (list row, then detail), else null */
function customDate(src, field) {
  if (!field || !src) return null;
  const direct = src[`${field}_unformatted`] ?? src[field];
  if (direct) { const d = ymdOf(direct); if (d) return d; }
  const hash = src.custom_field_hash;
  if (hash) { const d = ymdOf(hash[`${field}_unformatted`] ?? hash[field]); if (d) return d; }
  for (const c of src.custom_fields || []) if ((c.api_name === field || c.customfield_id === field) && c.value) { const d = ymdOf(c.value); if (d) return d; }
  return null;
}

function recipientOf(ctx, branchId, branchName) {
  const b = ctx.branches && ctx.branches.get(String(branchId || ''));
  const info = b && b.gstin ? N.gstinInfo(b.gstin) : null;
  return { branch_id: String(branchId || ''), branch_name: (b && b.name) || branchName || '', gstin: info ? info.gstin : '', state: info ? info.state : null, gstin_known: !!info };
}

function supplierOf(ctx, vendorId, name, gstinRaw, treatment) {
  const info = N.gstinInfo(gstinRaw);
  const master = ctx.vendors && ctx.vendors.get(String(vendorId || ''));
  const masterInfo = master && master.gstin ? N.gstinInfo(master.gstin) : null;
  return {
    vendor_id: String(vendorId || ''), name: name || (master && master.name) || '', gstin: info.gstin, gstin_valid: info.present ? info.valid : null,
    pan: info.pan || (master && master.pan) || null, state: info.state, treatment: treatment || '',
    master_gstin: masterInfo ? masterInfo.gstin : '',
  };
}

// ── List rows (cheap): identity + scope decision, no amounts ──────────────────
/** Why a list row can never be matched against GSTR-2B (null = in scope; detail is needed for its amounts) */
function listExclusion(row, ctx, kind) {
  if (row.status === 'void') return 'void';
  if (row.status === 'draft') return 'draft';
  if (kind === 'bill' && (row.is_opening_balance === true || row.is_opening_balance === 'true')) return 'opening_balance';
  if (row.currency_code && row.currency_code !== 'INR') return 'foreign_currency';
  if (kind === 'expense') {
    if (!(Math.round((Number(row.total) - Number(row.total_without_tax)) * 100) > 0)) return 'no_gst';
    return null;                                          // the supplier GSTIN is only on the expense detail
  }
  if (kind === 'vendor_credit') return null;              // vendor-credit LIST rows carry no GSTIN either — the detail decides
  return supplierExclusion(row.gst_no, row.gst_treatment);
}

/** A supplier that cannot appear in GSTR-2B: no GSTIN, a composition dealer, or a treatment without ITC */
function supplierExclusion(gstinRaw, treatment) {
  if (!N.GSTIN_LIKE.test(N.normGstin(gstinRaw))) return 'no_supplier_gstin';
  if (treatment === 'business_registered_composition') return 'composition_supplier';
  if (!GSTIN_TREATMENTS_OK.has(treatment || '')) return 'no_supplier_gstin';
  return null;
}

/**
 * Scope: a document that COULD be matched but whose amounts are not worth a Zoho call yet (one call per document is what a sync costs).
 * 'gstin_off'      its recipient GSTIN is switched off, so nothing is reconciled for it (ctx.activeGstins is null when no GSTIN is set up)
 * 'outside_period' it is dated before the first month synced (a vendor credit list, or a changed old bill, reaches back years)
 * Both are read later, when the GSTIN is switched on or an earlier period is synced.
 */
function scopeExclusion(recipientGstin, postingDate, ctx) {
  if (recipientGstin && ctx.activeGstins && !ctx.activeGstins.has(recipientGstin)) return 'gstin_off';
  if (ctx.periodFrom && postingDate && postingDate < ctx.periodFrom) return 'outside_period';
  return null;
}

/** Light document from a bill / vendor-credit / expense LIST row */
function fromList(row, ctx, kind) {
  const co = ctx.company;
  const id = kind === 'bill' ? row.bill_id : kind === 'vendor_credit' ? row.vendor_credit_id : row.expense_id;
  const reason = listExclusion(row, ctx, kind);
  const posting = ymdOf(row.date);
  const invDate = kind === 'bill' ? customDate(row, co.invoice_date_field) : kind === 'vendor_credit' ? customDate(row, co.credit_date_field) : null;
  const recipient = recipientOf(ctx, row.branch_id, row.branch_name);
  const number = kind === 'bill' ? row.bill_number : kind === 'vendor_credit' ? (co.credit_number_field === 'reference_number' ? row.reference_number : row.vendor_credit_number) : row.reference_number;
  const doc = {
    id: `zb:${co.org_id}:${kind}:${id}`, company: co.id, org_id: co.org_id, kind, zoho_id: String(id),
    zoho_url: zohoUrl(co.org_id, kind === 'bill' ? 'bills' : kind === 'vendor_credit' ? 'vendorcredits' : 'expenses', id),
    doc_type: kind === 'vendor_credit' ? 'CRN' : 'INV',
    recipient_gstin: recipient.gstin, recipient,
    supplier: supplierOf(ctx, row.vendor_id, row.vendor_name, row.gst_no, row.gst_treatment),
    doc_no: String(number ?? '').trim(), doc_no_norm: N.normDocNo(number), doc_no_core: N.docNoCore(number),
    doc_date: invDate || posting, date_assumed: !invDate, posting_date: posting, accounting_period: N.periodOfDate(posting),
    status: row.status || '', currency: row.currency_code || 'INR',
    amounts: null, detail_pending: false, excluded: null,
    source: { lmt: row.last_modified_time || '', created: row.created_time || '', list_at: new Date().toISOString(), detail_at: null },
    deleted: false,
  };
  if (reason) { doc.excluded = reason; doc.excluded_text = EXCLUSIONS[reason]; }
  else if (!recipient.gstin) { doc.excluded = 'recipient_unmapped'; doc.excluded_text = EXCLUSIONS.recipient_unmapped; }
  else {
    const scope = scopeExclusion(recipient.gstin, posting, ctx);
    if (scope) { doc.excluded = scope; doc.excluded_text = EXCLUSIONS[scope]; } else doc.detail_pending = true;
  }
  doc.hash = hashOf([doc.id, doc.excluded, doc.status, doc.source.lmt]);
  return doc;
}

// ── Detail (full) ─────────────────────────────────────────────────────────────
/** Tax components and rates from the document and its lines; checks are recorded, never silently fixed */
function taxFrom(d, lines, dq) {
  const comp = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  let other = 0;
  const fromDoc = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const t of d.taxes || []) {
    const k = classifyTax(t.tax_name), a = p0(t.tax_amount);
    if (k) fromDoc[k] += a; else if (a) { other += a; dq.push(`unknown_tax:${String(t.tax_name).slice(0, 30)}`); }
  }
  const fromLines = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  let linesHaveTaxes = false;
  for (const l of lines) for (const t of l.line_item_taxes || []) { linesHaveTaxes = true; const k = classifyTax(t.tax_name); if (k) fromLines[k] += p0(t.tax_amount); }
  const docHas = Object.values(fromDoc).some(Boolean);
  const src = docHas ? fromDoc : (linesHaveTaxes ? fromLines : fromDoc);
  for (const k of Object.keys(comp)) comp[k] = src[k];
  if (docHas && linesHaveTaxes && Object.keys(comp).some(k => Math.abs(fromDoc[k] - fromLines[k]) > 100)) dq.push('taxes_vs_lines');
  return { comp, other };
}

function linesOf(d) {
  return (d.line_items || []).map(l => {
    const t = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    for (const x of l.line_item_taxes || []) { const k = classifyTax(x.tax_name); if (k) t[k] += p0(x.tax_amount); }
    return {
      account_id: l.account_id || '', account: l.account_name || '', hsn: l.hsn_or_sac || '', rate: l.tax_percentage ?? null, tax_name: l.tax_name || '',
      taxable: p0(l.item_total), ...t, itc_eligibility: l.itc_eligibility || '', rcm_tax: p0(l.reverse_charge_tax_amount), rcm_name: l.reverse_charge_tax_name || l.tax_name || '',
      project_id: l.project_id || '', project: l.project_name || '',
    };
  });
}

/** Full document from the detail response (`detail` = the `bill` / `vendor_credit` / `expense` object) */
function fromDetail(detail, listRow, ctx, kind) {
  const co = ctx.company;
  const base = fromList({ ...(listRow || {}), ...pickListFields(detail, kind) }, ctx, kind);
  const dq = [];
  const lines = linesOf(detail);
  const { comp, other } = taxFrom(detail, lines, dq);
  let taxable = p0(detail.sub_total);
  const discount = p0(detail.discount_total);
  if (kind !== 'expense' && discount) { if (detail.is_discount_before_tax === false) dq.push('bill_discount_after_tax'); else { taxable -= discount; dq.push('bill_level_discount'); } }
  if (kind === 'expense' && !detail.sub_total) taxable = p0(detail.amount) || p0(detail.total) - Object.values(comp).reduce((a, b) => a + b, 0);
  if (lines.length && kind !== 'expense' && !detail.is_inclusive_tax && Math.abs(lines.reduce((s, l) => s + l.taxable, 0) - p0(detail.sub_total)) > 100) dq.push('subtotal_vs_lines');
  if (detail.is_inclusive_tax) dq.push('tax_inclusive_document');
  const adjustment = p0(detail.adjustment);
  const rcm = !!detail.is_reverse_charge_applied;
  const rcmTax = lines.reduce((s, l) => s + l.rcm_tax, 0);
  // Tax as INVOICED by the supplier. Under reverse charge Zoho keeps the recipient's tax on the lines, not in taxes[]; GSTR-2B
  // lists registered-supplier RCM invoices WITH their tax, so the components are derived from the RCM line tax (flagged), while
  // the invoice value stays free of tax the supplier never charged.
  const charged = comp.igst + comp.cgst + comp.sgst + comp.cess + other;
  if (rcm && charged === 0 && rcmTax > 0) {
    for (const l of lines) {
      if (!l.rcm_tax) continue;
      if (/^IGST/i.test(l.rcm_name)) comp.igst += l.rcm_tax;
      else { const half = Math.round(l.rcm_tax / 2); comp.cgst += half; comp.sgst += l.rcm_tax - half; }
    }
    dq.push('rcm_components_derived');
  }
  const amounts = { ...zeroAmounts(), taxable, ...comp };
  const taxTotal = comp.igst + comp.cgst + comp.sgst + comp.cess + other;
  const tds = p0(detail.tds_amount) || p0(detail.tds_total);
  const total = p0(detail.total);
  // control: sub_total − discount + tax charged + adjustment − TDS = Zoho total (bills and credits)
  if (kind !== 'expense') {
    const calc = taxable + charged + adjustment - tds;
    if (Math.abs(calc - total) > 100 && !detail.is_inclusive_tax) dq.push('arith_check_failed');
  }
  const pos = N.stateNum(detail.destination_of_supply), srcState = N.stateNum(detail.source_of_supply);
  if (pos && srcState && !rcm && taxTotal > 0) {
    const intra = pos === srcState;
    if (intra && comp.igst > 0) dq.push('igst_on_intra_state');
    if (!intra && (comp.cgst > 0 || comp.sgst > 0)) dq.push('cgst_sgst_on_inter_state');
  }
  const projects = [...new Map(lines.filter(l => l.project_id).map(l => [l.project_id, { id: l.project_id, name: l.project }])).values()];
  const payments = (detail.payments || []).map(p => ({ id: p.payment_id || p.bill_payment_id || '', date: ymdOf(p.date), amount: p0(p.amount), status: p.status || '' }));
  const doc = {
    ...base,
    amounts, other_tax: other, tax_total: taxTotal,
    invoice_value: taxable + charged + adjustment,
    adjustment, discount, rcm, rcm_tax: rcmTax,
    pos, source_state: srcState, place_of_supply_raw: detail.destination_of_supply || '',
    lines, projects, itc_eligibility: [...new Set(lines.map(l => l.itc_eligibility).filter(Boolean))],
    zoho_total_net: total, tds_amount: tds, vendor_credits_applied: p0(detail.vendor_credits_applied), balance: p0(detail.balance), payments,
    gst_return: detail.gst_return_details && (detail.gst_return_details.return_period || detail.gst_return_details.status) ? { period: detail.gst_return_details.return_period || '', status: detail.gst_return_details.status || '' } : null,
    linked_bill: kind === 'vendor_credit' ? { bill_id: detail.bill_id || ((detail.bills_credited || [])[0] || {}).bill_id || '', bill_number: detail.bill_number || ((detail.bills_credited || [])[0] || {}).bill_number || '' } : null,
    reason: kind === 'vendor_credit' ? (detail.reason_for_debit_note || '') : '',
    data_quality: dq,
    detail_pending: false,
  };
  // the detail's GSTIN / branch are authoritative (a list row may be older)
  doc.supplier = supplierOf(ctx, detail.vendor_id || base.supplier.vendor_id, detail.vendor_name || base.supplier.name, detail.gst_no ?? '', detail.gst_treatment || base.supplier.treatment);
  const recipient = recipientOf(ctx, detail.branch_id || base.recipient.branch_id, detail.branch_name);
  doc.recipient = recipient; doc.recipient_gstin = recipient.gstin;
  // invoice / note date from the custom field in the detail if the list row did not carry it
  const inv = kind === 'bill' ? customDate(detail, co.invoice_date_field) : kind === 'vendor_credit' ? customDate(detail, co.credit_date_field) : null;
  if (inv) { doc.doc_date = inv; doc.date_assumed = false; }
  if (kind === 'expense') { doc.date_assumed = true; doc.doc_date = ymdOf(detail.date) || doc.doc_date; if (!doc.doc_no) dq.push('no_document_number'); }
  doc.doc_type = kind === 'vendor_credit' ? 'CRN' : 'INV';
  doc.excluded = null; doc.excluded_text = '';
  if (doc.status === 'void') doc.excluded = 'void';
  else if (doc.status === 'draft') doc.excluded = 'draft';
  else if (supplierExclusion(doc.supplier.gstin, doc.supplier.treatment)) doc.excluded = supplierExclusion(doc.supplier.gstin, doc.supplier.treatment);
  else if (!doc.recipient_gstin) doc.excluded = 'recipient_unmapped';
  else if (kind === 'expense' && taxTotal === 0) doc.excluded = 'no_gst';
  else if (kind === 'vendor_credit' && taxTotal === 0 && taxable === 0) doc.excluded = 'no_gst';
  else if (!doc.doc_no || !doc.doc_date) doc.excluded = 'incomplete';
  if (doc.excluded) doc.excluded_text = EXCLUSIONS[doc.excluded];
  doc.incomplete = doc.excluded === 'incomplete';
  doc.source = { ...base.source, lmt: detail.last_modified_time || base.source.lmt, detail_at: new Date().toISOString() };
  doc.hash = hashOf([doc.id, doc.excluded, doc.status, doc.doc_no, doc.doc_date, doc.supplier.gstin, doc.recipient_gstin, doc.amounts, doc.rcm, doc.doc_type, doc.invoice_value]);
  return doc;
}

/** The few list-shaped fields a detail response also carries (so fromList can run on a detail alone) */
function pickListFields(d, kind) {
  const o = { status: d.status, date: d.date, vendor_id: d.vendor_id, vendor_name: d.vendor_name, gst_no: d.gst_no, gst_treatment: d.gst_treatment,
    branch_id: d.branch_id, branch_name: d.branch_name, currency_code: d.currency_code, last_modified_time: d.last_modified_time, created_time: d.created_time,
    reference_number: d.reference_number, custom_field_hash: d.custom_field_hash, custom_fields: d.custom_fields };
  if (kind === 'bill') Object.assign(o, { bill_id: d.bill_id, bill_number: d.bill_number, is_opening_balance: d.is_opening_balance });
  if (kind === 'vendor_credit') Object.assign(o, { vendor_credit_id: d.vendor_credit_id, vendor_credit_number: d.vendor_credit_number });
  if (kind === 'expense') Object.assign(o, { expense_id: d.expense_id, total: d.total, total_without_tax: d.sub_total ?? (d.total != null && d.tax_amount != null ? d.total - d.tax_amount : d.total), vendor_name: d.vendor_name || d.merchant_name });
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

module.exports = { EXCLUSIONS, classifyTax, fromList, fromDetail, listExclusion, supplierExclusion, scopeExclusion, customDate, zohoUrl };
