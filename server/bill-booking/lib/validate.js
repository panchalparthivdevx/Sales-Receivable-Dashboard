/**
 * What still stops a bill from becoming a Zoho draft, and its processing status.
 * Issues: { code, severity: 'block' | 'warn', message, field?, line?, ackable? }
 *   block — must be resolved (or, where ackable, confirmed by the team) before a draft is created.
 *   warn  — shown to the reviewer, does not stop the draft.
 */

'use strict';

const T = require('./text');
const { BILL_TYPES, DOC_TYPE_LABEL } = require('./extract');

const STICKY = new Set(['draft_created', 'reviewed']);
const money = n => (n == null ? '—' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Category-specific field value and its check → { value, source, error } */
function fieldValue(def, bill, auto = {}) {
  const manual = bill.cat_fields?.[def.id];
  let value = manual && manual.source === 'manual' ? manual.value : undefined;
  let source = value !== undefined ? 'manual' : '';
  if (value === undefined && auto[def.id] !== undefined && auto[def.id] !== '') { value = auto[def.id].value; source = auto[def.id].source; }
  if ((value === undefined || value === '') && def.default !== '') { value = def.default; source = 'default'; }
  if (value === undefined) value = '';
  const empty = value === '' || value == null || (typeof value === 'object' && !value.id);
  if (empty) return { value: '', source: '', error: def.mandatory ? `${def.label} is required` : '' };
  const v = def.validation || {};
  if (def.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { value, source, error: `${def.label} must be a number` };
    if (v.min != null && n < v.min) return { value, source, error: v.message || `${def.label} must be at least ${v.min}` };
    if (v.max != null && n > v.max) return { value, source, error: v.message || `${def.label} must be at most ${v.max}` };
  }
  if (def.type === 'date' && !T.parseDate(value)) return { value, source, error: `${def.label} must be a date` };
  if (def.type === 'dropdown' && !def.options.includes(String(value))) return { value, source, error: `${def.label}: "${value}" is not one of the allowed options` };
  if (v.regex && typeof value !== 'object' && !new RegExp(v.regex).test(String(value))) return { value, source, error: v.message || `${def.label} is not in the expected format` };
  return { value, source, error: '' };
}

function issues(bill, { category, acks = [] } = {}) {
  const out = [];
  const add = (code, severity, message, extra = {}) => out.push({ code, severity, message, ...extra, acked: acks.includes(extra.key || code) });
  const f = bill.fields || {};
  const ex = bill.extraction || {};

  if (ex.unreadable) add('unreadable', 'block', 'The document could not be read — check the attachment, enter the details by hand or mark it as not a bill');
  for (const w of ex.warnings || []) add('extraction_note', 'warn', w);
  if (ex.notes) add('extraction_note', 'warn', `Reader: ${ex.notes}`);
  if (ex.confidence === 'low' && !ex.unreadable) add('low_confidence', 'warn', 'The reader was not confident about these details — check them against the bill');
  // The built-in text reader is reliable for GSTINs and dates, not for every layout's amounts/numbers:
  // one person confirms its reading before a draft is made (bills read by Claude skip this)
  if (ex.engine === 'text' && !ex.unreadable) add('confirm_reading', 'block', 'Read by the built-in reader — check the invoice number, date and amounts against the bill, then confirm', { ackable: true });
  if (bill.doc_type?.value === 'debit_note') add('debit_note', 'block', 'This is a debit note — confirm it should be booked as a bill', { ackable: true });
  if (bill.doc_type?.value === 'other' && !ex.unreadable && !bill.not_bill?.overridden) {
    add('doc_type_unclear', 'block', `Could not tell whether this is a bill (${bill.doc_type.basis || 'no bill heading'}) — confirm it is a bill or mark it as not a bill`, { ackable: true });
  }

  if (!bill.company) add('company_missing', 'block', bill.company_basis || 'Choose the company', { field: 'company' });
  else if (bill.company_sure === false) add('company_assumed', 'warn', bill.company_basis);

  if (!bill.vendor?.id) add('vendor_missing', 'block', bill.vendor?.basis || 'Choose the Zoho vendor', { field: 'vendor' });
  else if (bill.vendor.match === 'name') add('vendor_by_name', 'warn', bill.vendor.basis);

  if (!f.invoice_number) add('invoice_number_missing', 'block', 'Invoice number not found', { field: 'invoice_number' });
  if (!f.invoice_date) add('invoice_date_missing', 'block', 'Invoice date not found', { field: 'invoice_date' });
  else if (f.invoice_date > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) add('invoice_date_future', 'block', `Invoice date ${f.invoice_date} is in the future`, { field: 'invoice_date' });
  if (f.due_date && f.invoice_date && f.due_date < f.invoice_date) add('due_before_invoice', 'warn', 'The due date is before the invoice date');

  if (!(f.total > 0)) add('total_missing', 'block', 'Invoice total not found', { field: 'total' });
  if (!(f.sub_total > 0)) add('sub_total_missing', 'block', 'Taxable value (amount before GST) not found', { field: 'sub_total' });
  if (f.total > 0 && f.sub_total > 0) {
    const calc = T.round2(f.sub_total + (f.tax_total || 0) + (f.round_off || 0));
    if (Math.abs(calc - f.total) > 1) {
      add('amounts_inconsistent', 'block', `Amounts do not add up: taxable ${money(f.sub_total)} + GST ${money(f.tax_total)}${f.round_off ? ` + round-off ${money(f.round_off)}` : ''} = ${money(calc)}, but the total is ${money(f.total)}`, { field: 'total' });
    }
  }
  const gst = T.round2((f.cgst || 0) + (f.sgst || 0) + (f.igst || 0) + (f.cess || 0));
  if (gst > 0 && f.tax_total != null && Math.abs(gst - f.tax_total) > 1) add('gst_split', 'warn', `CGST + SGST + IGST + cess (${money(gst)}) differ from the GST total (${money(f.tax_total)})`);
  if (f.currency && f.currency !== 'INR' && !(f.exchange_rate > 0)) add('exchange_rate', 'block', `Bill in ${f.currency} — enter the exchange rate`, { field: 'exchange_rate' });
  if (f.reverse_charge) add('reverse_charge', 'block', 'The bill says reverse charge applies — confirm the GST treatment before drafting', { ackable: true });

  const lines = bill.lines || [];
  if (!lines.length) add('lines_missing', 'block', 'No bill lines — add at least one line with its amount', { field: 'lines' });
  const lineSum = T.round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  if (lines.length && f.sub_total > 0 && Math.abs(lineSum - f.sub_total) > 1) {
    add('lines_mismatch', 'block', `Lines add up to ${money(lineSum)}, but the taxable value is ${money(f.sub_total)}`, { field: 'lines' });
  }
  lines.forEach((l, i) => {
    const n = lines.length > 1 ? `Line ${i + 1}: ` : '';
    if (!(Number(l.amount) > 0)) add('line_amount', 'block', `${n}amount missing`, { line: i });
    if (!l.account?.id) add('account_missing', 'block', `${n}${l.account_issue || 'choose the expense account'}`, { line: i });
    if (l.tax_needed && !l.tax?.id) add('tax_unconfirmed', 'block', `${n}${l.tax_issue || 'choose the Zoho tax'}`, { line: i });
  });

  if (!bill.category?.id) add('category_missing', 'block', bill.category?.basis || 'Choose the bill category', { field: 'category' });
  for (const [id, r] of Object.entries(bill.cat_field_state || {})) {
    if (r.error) add('field', 'block', r.error, { field: `cat:${id}` });
  }
  for (const w of bill.bill_level_notes || []) add('bill_level', 'warn', w);

  const d = bill.duplicate;
  if (d && (d.certainty === 'possible' || d.certainty === 'revised')) add('duplicate_check', 'block', `${d.reason} — confirm it is not a duplicate`, { field: 'duplicate' });
  if (bill.zoho?.deleted_at) add('zoho_deleted', 'block', `The Zoho draft was deleted on ${bill.zoho.deleted_at.slice(0, 10)} — confirm before creating it again`, { ackable: true });
  if (bill.zoho?.error) add('zoho_error', 'block', bill.zoho.error);
  return out;
}

/** Status from the bill's state (Draft Created / Reviewed only change through Zoho) */
function status(bill) {
  if (STICKY.has(bill.status)) return bill.status;
  if (bill.processing_error || bill.zoho?.error) return 'failed';
  if (!bill.extraction) return 'received';
  if (bill.not_bill && !bill.not_bill.overridden) return 'not_bill';
  const d = bill.duplicate;
  if (d && ['exact', 'likely', 'zoho'].includes(d.certainty)) return 'duplicate';
  if (!bill.evaluated_at) return 'extracted';
  const blocking = (bill.issues || []).filter(i => i.severity === 'block' && !i.acked);
  return blocking.length ? 'needs_input' : 'ready';
}

/** Is the document a bill? → null (yes) or { reason } */
function notBill(bill) {
  const t = bill.doc_type?.value;
  // 'other' (no heading found) and unreadable scans stay with the team — never skipped as "not a bill"
  if (!t || BILL_TYPES.has(t) || t === 'other' || bill.extraction?.unreadable) return null;
  return { reason: `${DOC_TYPE_LABEL[t] || t}: ${bill.doc_type.basis || ''}`.trim() };
}

module.exports = { issues, status, fieldValue, notBill, STICKY };
