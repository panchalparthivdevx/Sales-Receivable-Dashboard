/**
 * Duplicate checks. A bill is compared with every other bill collected here (any mailbox, email or
 * ERP upload) and with the bills already in Zoho:
 *   exact     same file (SHA-256)                                    → Duplicate
 *   likely    same company + vendor + invoice number                 → Duplicate
 *   zoho      same vendor + invoice number already booked in Zoho    → Duplicate (linked to the Zoho bill)
 *   possible  same vendor + invoice date + total, different number   → Needs Input (the team confirms)
 *   revised   same vendor + invoice number, different total          → Needs Input
 * The earliest bill received is the original; the team can dismiss a match ("not a duplicate").
 */

'use strict';

const T = require('./text');

const vendorKey = b => b.vendor?.id || b.fields?.vendor_gstin || T.normName(b.fields?.vendor_name);
const IGNORE = new Set(['not_bill', 'failed']);

function check(bill, others, zohoBills = []) {
  const dismissed = new Set(bill.duplicate?.dismissed || []);
  const f = bill.fields || {};
  const inv = T.normInvoice(f.invoice_number);
  const vk = vendorKey(bill);
  const older = others.filter(o => o.id !== bill.id && !IGNORE.has(o.status) && o.status !== 'duplicate'
    && !dismissed.has(o.id) && (o.created_at < bill.created_at || (o.created_at === bill.created_at && o.id < bill.id)));

  const same = bill.file?.sha256 && older.find(o => o.file?.sha256 === bill.file.sha256);
  if (same) return { certainty: 'exact', of: same.id, reason: `Same file as ${same.id} (${describe(same)})` };

  if (inv && vk) {
    const n = older.filter(o => (o.company || '') === (bill.company || '') && vendorKey(o) === vk && T.normInvoice(o.fields?.invoice_number) === inv);
    const sameTotal = n.find(o => !(f.total > 0) || !(o.fields?.total > 0) || Math.abs(o.fields.total - f.total) <= 1);
    if (sameTotal) return { certainty: 'likely', of: sameTotal.id, reason: `Same vendor and invoice number as ${sameTotal.id} (${describe(sameTotal)})` };
    if (n.length) return { certainty: 'revised', of: n[0].id, reason: `Same vendor and invoice number as ${n[0].id}, but a different total (${n[0].fields.total} vs ${f.total}) — a revised bill?` };
  }

  if (inv && bill.vendor?.id) {
    const own = new Set(others.map(o => o.zoho?.bill_id).filter(Boolean));   // drafts this module created
    const z = zohoBills.filter(z => !dismissed.has(`zoho:${z.bill_id}`) && !own.has(z.bill_id) && z.bill_id !== bill.zoho?.bill_id
      && z.vendor_id === bill.vendor.id && T.normInvoice(z.bill_number) === inv && z.status !== 'void');
    if (z.length) return { certainty: 'zoho', of: null, zoho_bill_id: z[0].bill_id, reason: `Already in Zoho: bill ${z[0].bill_number} dated ${z[0].date} (${z[0].status})` };
  }

  if (vk && f.invoice_date && f.total > 0) {
    const p = older.find(o => (o.company || '') === (bill.company || '') && vendorKey(o) === vk
      && o.fields?.invoice_date === f.invoice_date && Math.abs((o.fields?.total || 0) - f.total) <= 1);
    if (p) return { certainty: 'possible', of: p.id, reason: `Same vendor, date and total as ${p.id} (${describe(p)}) but invoice number ${f.invoice_number || '(none)'} vs ${p.fields?.invoice_number || '(none)'}` };
  }
  return null;
}

function describe(b) {
  const src = b.source === 'email' ? `email to ${b.source_ref?.mailbox || 'a team mailbox'}` : 'ERP upload';
  return `${src}, ${b.status === 'draft_created' || b.status === 'reviewed' ? 'already drafted in Zoho' : b.status}`;
}

module.exports = { check, vendorKey };
