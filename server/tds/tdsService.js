'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// TDS Payable — Business Logic Service  (Phase 1: One-Month Calculation)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Pure functions — no side effects, no network calls, no Express dependency.
// All functions receive raw Zoho data as arguments and return plain objects.
//
// Designed for future extension:  quarter / FY / multi-company / multi-month
// without rewriting the core logic.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Section catalogue ────────────────────────────────────────────────────────
const SECTION_META = {
  '192':     { label: 'Salary',                    rate: 'Slab'     },
  '194A':    { label: 'Interest',                  rate: '10%'      },
  '194B':    { label: 'Lottery / Games',           rate: '30%'      },
  '194C':    { label: 'Contractors',               rate: '1% / 2%'  },
  '194D':    { label: 'Insurance Commission',      rate: '5%'       },
  '194G':    { label: 'Commission on Lottery',     rate: '5%'       },
  '194H':    { label: 'Commission / Brokerage',    rate: '5%'       },
  '194I':    { label: 'Rent',                      rate: '2% / 10%' },
  '194I(a)': { label: 'Rent – Plant & Machinery',  rate: '2%'       },
  '194I(b)': { label: 'Rent – Land & Building',    rate: '10%'      },
  '194IA':   { label: 'Rent – Immovable Property', rate: '1%'       },
  '194J':    { label: 'Professional / Technical',  rate: '2% / 10%' },
  '194JA':   { label: 'Technical Services',        rate: '2%'       },
  '194JB':   { label: 'Professional Services',     rate: '10%'      },
  '194K':    { label: 'Dividends from MF',         rate: '10%'      },
  '194LA':   { label: 'Compensation – Land',       rate: '10%'      },
  '194Q':    { label: 'Purchase of Goods',         rate: '0.1%'     },
  '195':     { label: 'Non-Resident Payments',     rate: 'DTAA'     },
};

// Sub-section → display parent mapping
const SECTION_PARENT = {
  '194JA': '194J',
  '194JB': '194J',
  '194IA': '194I(a)',
  '194IB': '194I(b)',
  '194IC': '194I',
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

function parseYM(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { year: y, month: m };
}

function monthStart(ym) {
  return `${ym}-01`;
}

function monthEnd(ym) {
  const { year, month } = parseYM(ym);
  const last = new Date(year, month, 0); // day-0 trick gives last day of month
  return `${year}-${String(month).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

/**
 * TDS deposit due date for a given month:
 *   - March TDS  →  30 April (special rule)
 *   - All others →  7th of the following month
 */
function tdsDueDate(ym) {
  const { year, month } = parseYM(ym);
  if (month === 3) return `${year}-04-30`;
  const nm = month === 12 ? 1 : month + 1;
  const ny = month === 12 ? year + 1 : year;
  return `${ny}-${String(nm).padStart(2, '0')}-07`;
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(dateStr) - today) / 86_400_000);
}

function dueDateLabel(days) {
  if (days < 0)  return `${Math.abs(days)} day(s) overdue`;
  if (days === 0) return 'Due today';
  return `${days} day(s) remaining`;
}

// ─── Section normalisation ────────────────────────────────────────────────────

function normaliseSection(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/\s+/g, '').replace(/^(U\/S|SEC(TION)?\.?)/i, '').toUpperCase();
  if (!s) return null;

  // 1. Exact catalogue match
  if (SECTION_META[s]) return s;
  if (SECTION_PARENT[s]) return s;

  // 2. Zoho sometimes returns section name + description glued together
  //    e.g. "194JTECHNICALSERVICES" → try progressively shorter prefixes
  //    to find a known catalogue entry. Try longest known prefix first.
  const numsMatch = s.match(/^(\d{1,3})/);
  if (numsMatch) {
    const digits = numsMatch[1];
    const rest   = s.slice(digits.length);           // e.g. "JTECHNICALSERVICES"
    // Try 2-letter suffix, then 1-letter, then 0
    for (let len = 2; len >= 0; len--) {
      const candidate = digits + rest.slice(0, len);  // e.g. "194JT", "194J", "194"
      if (SECTION_META[candidate] || SECTION_PARENT[candidate]) return candidate;
    }
    // Also try with parenthetical like (A), (B)
    const parenMatch = rest.match(/^[A-Z]{0,2}(\([A-Z0-9]+\))/);
    if (parenMatch) {
      const candidate = digits + parenMatch[0];
      if (SECTION_META[candidate] || SECTION_PARENT[candidate]) return candidate;
    }
    // Fall back to digits + up to 2 letters (best guess)
    return digits + rest.slice(0, Math.min(rest.length, 2));
  }

  return s.replace(/[^0-9A-Z()\-.]/g, '') || null;
}

function sectionFromTaxName(name) {
  const m = String(name || '').match(/1[94]\d[A-Z0-9()\-]*/i);
  return m ? m[0].toUpperCase() : null;
}

// ─── Custom field lookup ──────────────────────────────────────────────────────

/**
 * Find a field in a Zoho custom_fields array.
 * matcher: string (included in api_name / label) or RegExp
 */
function cfFind(fields, matcher) {
  if (!Array.isArray(fields)) return null;
  for (const cf of fields) {
    const key = (cf.api_name || cf.label || cf.customfield_id || '').toLowerCase();
    if (matcher instanceof RegExp ? matcher.test(key) : key.includes(matcher)) return cf;
  }
  return null;
}

function cfNum(cf) {
  return cf ? (parseFloat(String(cf.value || '').replace(/[₹,\s]/g, '')) || 0) : 0;
}

// ─── TDS extraction from a single bill ───────────────────────────────────────

/**
 * Extract TDS information from one Zoho bill.
 *
 * Returns { amount, section, rate, source, details[] } or null.
 *
 * Detection priority
 * 1. Zoho built-in withholding tax  →  withholding_tax_total / withholding_tax_details
 * 2. Bill-level custom fields       →  cf_tds_section, cf_tds_amount, cf_tds_rate
 * 3. Line-item custom fields        →  item_custom_fields on each line_item
 */
function extractTDSFromBill(bill) {
  // ── 0a. Zoho tds_summary array (Zoho India TDS feature, returned as array) ──
  //     bill.tds_summary = [{ tds_name, tds_percentage, tds_amount, tds_tax_id }]
  const tsSrc = bill.tds_summary;
  const ts    = Array.isArray(tsSrc) ? tsSrc[0] : tsSrc;
  if (ts && Number(ts.tds_amount) > 0) {
    return {
      amount:  Number(ts.tds_amount),
      section: normaliseSection(ts.tds_name),
      rate:    ts.tds_percentage != null ? Number(ts.tds_percentage) : null,
      source:  'tds_summary',
      details: [],
    };
  }

  // ── 0b. Zoho top-level TDS fields (detail API) ───────────────────────────
  //     bill.tds_amount / bill.tds_percent / bill.tds_section / bill.tds_tax_name
  const tdsBillAmt = Number(bill.tds_amount || 0);
  if (tdsBillAmt > 0) {
    const sec = bill.tds_section || bill.tds_tax_name;
    return {
      amount:  tdsBillAmt,
      section: sec ? normaliseSection(sec) : null,
      rate:    bill.tds_percent != null ? Number(bill.tds_percent) : null,
      source:  'tds_fields',
      details: [],
    };
  }

  // ── 0c. Zoho tds_total (list API field) ──────────────────────────────────
  const tdsTotalAmt = Number(bill.tds_total || 0);
  if (tdsTotalAmt > 0) {
    return {
      amount:  tdsTotalAmt,
      section: null,   // section not available in list API
      rate:    null,
      source:  'tds_total_only',
      details: [],
    };
  }

  // ── 1. Zoho built-in withholding tax ────────────────────────────────────
  const wtTotal = bill.withholding_tax_total;
  if (wtTotal != null && Number(wtTotal) > 0) {
    const details = Array.isArray(bill.withholding_tax_details)
      ? bill.withholding_tax_details : [];
    return {
      amount:  Number(wtTotal),
      section: details.length > 0
        ? normaliseSection(details[0].section_code || sectionFromTaxName(details[0].withholding_tax_name))
        : null,
      rate:    details.length > 0 ? (details[0].withholding_tax_percent || null) : null,
      source:  'withholding_tax',
      details: details.map(d => ({
        amount:  Number(d.withholding_tax_amount || 0),
        section: normaliseSection(d.section_code || sectionFromTaxName(d.withholding_tax_name)),
        rate:    d.withholding_tax_percent || null,
      })),
    };
  }

  // ── 2. Bill-level custom fields ──────────────────────────────────────────
  const bCFs = bill.custom_fields || [];

  // "Applicable" flag — if present and explicitly "No", bill is exempt
  const cfApplicable = cfFind(bCFs, /tds.*(applicable|apply)/i) || cfFind(bCFs, 'cf_tds_applicable');
  if (cfApplicable) {
    const v = String(cfApplicable.value || '').trim().toLowerCase();
    if (v === 'no' || v === 'false' || v === '0' || v === 'n') return null;
  }

  const cfSection = cfFind(bCFs, /tds.*(section|sec|code)/i)
                 || cfFind(bCFs, 'cf_tds_section')
                 || cfFind(bCFs, 'cf_section');

  const cfAmount  = cfFind(bCFs, /tds.*(amount|amt|value)/i)
                 || cfFind(bCFs, 'cf_tds_amount')
                 || cfFind(bCFs, 'cf_tds');

  const cfRate    = cfFind(bCFs, /tds.*(rate|percent)/i)
                 || cfFind(bCFs, 'cf_tds_rate');

  const amount = cfNum(cfAmount);
  if (amount > 0) {
    return {
      amount,
      section: cfSection ? normaliseSection(cfSection.value) : null,
      rate:    cfRate ? parseFloat(cfRate.value) : null,
      source:  'custom_fields',
      details: [],
    };
  }

  // Section is known but amount is missing — flag it
  if (cfSection && cfSection.value) {
    return {
      amount:  0,
      section: normaliseSection(cfSection.value),
      rate:    null,
      source:  'section_only',
      details: [],
    };
  }

  // ── 3. Line-item custom fields ───────────────────────────────────────────
  const lineItems = Array.isArray(bill.line_items) ? bill.line_items : [];
  let liTotal = 0; let liSection = null; let liRate = null;
  for (const li of lineItems) {
    const liCFs = li.item_custom_fields || [];
    liTotal  += cfNum(cfFind(liCFs, /tds.*(amount|amt)/i) || cfFind(liCFs, 'cf_tds_amount'));
    if (!liSection) {
      const s = cfFind(liCFs, /tds.*(section|code)/i) || cfFind(liCFs, 'cf_tds_section');
      if (s) liSection = normaliseSection(s.value);
    }
    if (!liRate) {
      const r = cfFind(liCFs, /tds.*(rate|percent)/i) || cfFind(liCFs, 'cf_tds_rate');
      if (r) liRate = parseFloat(r.value);
    }
  }
  if (liTotal > 0) {
    return { amount: liTotal, section: liSection, rate: liRate, source: 'line_item_cf', details: [] };
  }

  return null; // No TDS data found → bill not TDS-applicable
}

// ─── Backdated entry detection ────────────────────────────────────────────────

/**
 * A bill is "backdated" when its accounting date (bill.date) is within the
 * selected month but it was ENTERED in Zoho (created_time) AFTER the TDS
 * due date for that month.
 *
 * These entries' TDS was missed in the on-time deposit and must roll into
 * the next payment cycle.
 */
function detectBackdatedEntries(bills, month) {
  const start   = monthStart(month);
  const end     = monthEnd(month);
  const dueDate = tdsDueDate(month);

  return bills
    .filter(b => b.date && b.date >= start && b.date <= end && b.created_time)
    .reduce((acc, b) => {
      const createdDate = String(b.created_time).substring(0, 10);
      if (createdDate <= dueDate) return acc;
      const tds = extractTDSFromBill(b);
      if (!tds || tds.amount <= 0) return acc;
      acc.push({
        bill_number:    b.bill_number,
        vendor_name:    b.vendor_name,
        bill_date:      b.date,
        entered_on:     createdDate,
        tds_due_date:   dueDate,
        section:        tds.section,
        tds_amount:     tds.amount,
        days_after_due: Math.round((new Date(createdDate) - new Date(dueDate)) / 86_400_000),
        recommendation: 'Include in next TDS payment cycle',
      });
      return acc;
    }, []);
}

// ─── TDS payment identification ───────────────────────────────────────────────

/**
 * Identify vendor payments that represent TDS deposits to the government.
 *
 * Matches payments where vendor_name, reference_number, or notes contain
 * keywords: "income tax", "itns", "tds", "challan 281", etc.
 *
 * Includes payments dated within the month AND up to the 7th of the next
 * month (to capture on-time deposits that happen just after month-end).
 */
function extractTDSPayments(vendorPayments, month) {
  const start   = monthStart(month);
  const { year, month: m } = parseYM(month);
  const nm      = m === 12 ? 1 : m + 1;
  const ny      = m === 12 ? year + 1 : year;
  const lateEnd = `${ny}-${String(nm).padStart(2, '0')}-15`; // up to 15th next month

  const isTDSPayment = p => {
    const text = [p.vendor_name, p.reference_number, p.notes, p.description].join(' ').toLowerCase();
    return /income\s*tax|itns|tds\s|tax\s*deduct|challan.*281|281.*challan/.test(text)
      && !/advance\s*tax|self.assess|itr|income\s*tax\s*return/i.test(text);
  };

  return vendorPayments
    .filter(p => p.date && p.date >= start && p.date <= lateEnd && isTDSPayment(p))
    .map(p => ({
      payment_id:       p.payment_id || p.vendorpayment_id || null,
      date:             p.date,
      vendor_name:      p.vendor_name,
      amount:           Number(p.amount || 0),
      reference_number: p.reference_number || '',
      notes:            p.notes || '',
      is_late:          p.date > tdsDueDate(month),
    }));
}

// ─── Payment status ───────────────────────────────────────────────────────────

function classifyPaymentStatus(payable, paid) {
  if (payable === 0 && paid === 0) return 'no_liability';
  if (paid === 0)                  return 'pending';
  if (paid >= payable * 1.001)     return 'overpaid';
  if (paid >= payable * 0.999)     return 'fully_paid';
  return 'partially_paid';
}

const STATUS_LABELS = {
  fully_paid:     'Fully Paid',
  partially_paid: 'Partially Paid',
  pending:        'Pending',
  overpaid:       'Overpaid',
  no_liability:   'No Liability',
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

// ─── Section-wise aggregation ─────────────────────────────────────────────────

function buildSectionBreakdown(entries) {
  const map = {};
  for (const e of entries) {
    const sec = e.section || 'Unknown';
    if (!map[sec]) {
      const meta = SECTION_META[sec] || SECTION_META[SECTION_PARENT[sec]] || {};
      map[sec] = { section: sec, label: meta.label || 'Other', rate_ref: meta.rate || '—', payable: 0, txn_count: 0, vendor_set: new Set(), bills: [] };
    }
    const row = map[sec];
    row.payable   += e.tds_amount;
    row.txn_count += 1;
    if (e.vendor_name) row.vendor_set.add(e.vendor_name);
    row.bills.push({
      bill_number:  e.bill_number,
      vendor_name:  e.vendor_name,
      vendor_pan:   e.vendor_pan || null,
      bill_date:    e.bill_date,
      gross_amount: e.gross_amount,
      tds_amount:   e.tds_amount,
      tds_rate:     e.tds_rate,
      is_backdated: e.is_backdated,
    });
  }

  return Object.values(map)
    .map(s => ({ ...s, vendors: [...s.vendor_set], vendor_set: undefined }))
    .sort((a, b) => b.payable - a.payable);
}

// ─── Main monthly report ──────────────────────────────────────────────────────

/**
 * Compute the complete TDS Payable report for one month.
 *
 * @param {object[]} bills           Raw Zoho bill objects (all statuses)
 * @param {object[]} vendorPayments  Raw Zoho vendor payment objects
 * @param {string}   month           "YYYY-MM"
 * @returns {object}                 Full report — see schema in comment below
 */
function computeMonthlyReport(bills, vendorPayments, month) {
  const start    = monthStart(month);
  const end      = monthEnd(month);
  const dueDate  = tdsDueDate(month);
  const days     = daysUntil(dueDate);

  // Restrict to bills dated within the selected month
  const monthBills = bills.filter(b => b.date && b.date >= start && b.date <= end);

  // Pre-compute backdated set (bill_number → true)
  const backdatedSet = new Set(
    detectBackdatedEntries(bills, month).map(e => e.bill_number)
  );

  // Extract TDS from each bill
  const entries      = [];
  const sectionOnly  = [];   // section found but amount missing

  for (const bill of monthBills) {
    const tds = extractTDSFromBill(bill);
    if (!tds) continue;

    if (tds.source === 'section_only') {
      sectionOnly.push({ bill_number: bill.bill_number, vendor_name: bill.vendor_name, section: tds.section, issue: 'TDS section identified but amount not present' });
      continue;
    }

    const subTotal = bill.sub_total != null
      ? Number(bill.sub_total)
      : Math.round(((Number(bill.total) || 0) / 1.18) * 100) / 100;

    entries.push({
      bill_number:  bill.bill_number,
      vendor_name:  bill.vendor_name,
      vendor_pan:   bill.cf_pan || bill.pan_no || null,
      bill_date:    bill.date,
      bill_status:  bill.status,
      gross_amount: subTotal,
      tds_amount:   tds.amount,
      tds_rate:     tds.rate,
      section:      tds.section,
      source:       tds.source,
      is_backdated: backdatedSet.has(bill.bill_number),
    });
  }

  // Totals
  const totalPayable = round2(entries.reduce((s, e) => s + e.tds_amount, 0));

  // Identify TDS payment records
  const tdsPayments = extractTDSPayments(vendorPayments, month);
  const totalPaid   = round2(tdsPayments.reduce((s, p) => s + p.amount, 0));
  const pending     = round2(Math.max(0, totalPayable - totalPaid));
  const excess      = round2(Math.max(0, totalPaid - totalPayable));

  const overallStatus = classifyPaymentStatus(totalPayable, totalPaid);

  // Section breakdown with pro-rata paid allocation
  // (Phase 1: challan-level section split not available; will be exact in Phase 2)
  const sections = buildSectionBreakdown(entries).map(s => {
    const sectionPaid = totalPayable > 0
      ? round2((s.payable / totalPayable) * totalPaid)
      : 0;
    const diff   = round2(s.payable - sectionPaid);
    const status = classifyPaymentStatus(s.payable, sectionPaid);
    return {
      section:      s.section,
      label:        s.label,
      rate_ref:     s.rate_ref,
      payable:      round2(s.payable),
      paid:         sectionPaid,
      difference:   diff,
      txn_count:    s.txn_count,
      vendor_count: s.vendors.length,
      vendors:      s.vendors,
      bills:        s.bills,
      status,
      status_label: statusLabel(status),
    };
  });

  // Backdated entries (full detail)
  const backdatedEntries = detectBackdatedEntries(bills, month);

  // Short / excess per section
  const shortPayments = sections
    .filter(s => s.difference > 0.01 && s.payable > 0)
    .map(s => ({ section: s.section, label: s.label, payable: s.payable, paid: s.paid, difference: s.difference, reason: 'Partial deposit detected' }));

  const excessPayments = sections
    .filter(s => s.status === 'overpaid')
    .map(s => ({ section: s.section, label: s.label, payable: s.payable, paid: s.paid, excess: s.paid - s.payable, note: 'Adjust against next period' }));

  // Detection transparency
  const srcCount = {};
  for (const e of entries) srcCount[e.source] = (srcCount[e.source] || 0) + 1;

  return {
    // Period metadata
    month,
    period:       `${start} to ${end}`,
    due_date:     dueDate,
    days_to_due:  days,
    due_label:    dueDateLabel(days),
    is_overdue:   days < 0,
    generated_at: new Date().toISOString(),

    // KPI summary
    summary: {
      total_payable:   totalPayable,
      total_paid:      totalPaid,
      pending,
      excess,
      payment_status:  overallStatus,
      status_label:    statusLabel(overallStatus),
      active_sections: sections.length,
      total_bills:     entries.length,
      total_vendors:   new Set(entries.map(e => e.vendor_name)).size,
    },

    // Section-wise breakdown
    sections,

    // Alerts
    alerts: {
      backdated_entries: backdatedEntries,
      short_payments:    shortPayments,
      excess_payments:   excessPayments,
      data_gaps:         sectionOnly,
    },

    // Actual TDS deposit records found
    tds_payments: tdsPayments,

    // Diagnostics (helpful for debugging what Zoho data was found)
    detection: {
      source_breakdown:   srcCount,
      bills_in_month:     monthBills.length,
      bills_with_tds:     entries.length,
      bills_no_tds_data:  sectionOnly.length,
      tds_paid_source:    tdsPayments.length > 0
        ? 'vendor_payments'
        : 'not_found — TDS deposit records not matched; paid shown as ₹0',
      paid_allocation_method: 'pro_rata',
      note: 'Section-wise paid allocation is pro-rata in Phase 1. Exact section split requires challan mapping (Phase 2).',
    },
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function round2(n) { return Math.round(n * 100) / 100; }

/** Condense a full report into a one-line mini summary (for FY rollup later) */
function monthMiniSummary(report) {
  return {
    month:         report.month,
    total_payable: report.summary.total_payable,
    total_paid:    report.summary.total_paid,
    pending:       report.summary.pending,
    status:        report.summary.payment_status,
  };
}

module.exports = {
  computeMonthlyReport,
  extractTDSFromBill,
  detectBackdatedEntries,
  classifyPaymentStatus,
  statusLabel,
  extractTDSPayments,
  buildSectionBreakdown,
  tdsDueDate,
  monthStart,
  monthEnd,
  monthMiniSummary,
  SECTION_META,
  SECTION_PARENT,
};
