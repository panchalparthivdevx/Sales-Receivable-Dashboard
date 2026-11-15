/**
 * The obligation catalogue — one rule per row of the coverage catalogue in the specification (plus the separate PF / PT
 * items of its V2 section).
 *
 * EVERY version here is an UNVERIFIED DRAFT ("status: draft"). Live scheduling only uses versions a person has verified
 * against an official source (source URL, notification, retrieved date, verified by) and a second person has approved —
 * see lib/rules.js. Nothing in this file is a legal determination:
 *   • due: only where the catalogue gives a standard reference date. Rows that say "rule-based", "verify" or
 *     "state-specific" have due: null (no date) — the task is then "no due date", visible, never overdue.
 *   • law / provision / form / authority: a starting suggestion typed in at build time, to be checked by the verifier.
 *     For the Income-tax Act, 2025 (periods from 1 April 2026) provisions and forms are left blank on purpose: legacy
 *     section and form numbers are NOT assumed to carry over.
 *   • applicability: a draft test on recorded facts. A fact that is not recorded makes the answer "needs review",
 *     never "not applicable".
 *   • reference: the catalogue row exactly as given ("standard dates are starting references, not approved deadlines").
 */

'use strict';

// 2 (15 Nov 2026): equity vs debt listing (entity.listing_type); debt-listing (listed NCDs) obligations added
const CATALOGUE_VERSION = 2;

const CATEGORIES = [
  'GST', 'TDS/TCS', 'Income Tax', 'ROC/LLP', 'Provident Fund', 'ESIC', 'Professional Tax', 'Labour & Payroll',
  'SEBI/Exchange', 'FEMA/RBI', 'State & Licences', 'Notices & Litigation', 'Internal Controls',
];

const REG_TYPES = {
  GST_REGULAR: 'GST — regular', GST_COMPOSITION: 'GST — composition', GST_ISD: 'GST — Input Service Distributor',
  GST_TDS: 'GST — TDS deductor', GST_TCS: 'GST — TCS collector (e-commerce)', GST_NRTP: 'GST — non-resident taxable person',
  GST_OIDAR: 'GST — OIDAR', GST_CASUAL: 'GST — casual taxable person',
  TAN: 'TAN (income-tax deductor / collector)', PF: 'Provident Fund establishment', ESIC: 'ESIC employer code',
  PT_PTRC: 'Professional Tax — employer (PTRC / deduction)', PT_PTEC: 'Professional Tax — entity enrolment (PTEC)',
  LWF: 'Labour Welfare Fund', IEC: 'Import Export Code', SHOPS_EST: 'Shops & Establishment registration',
  CONTRACT_LABOUR: 'Contract labour registration / licence', FSSAI: 'FSSAI licence', TRADE_LICENCE: 'Trade licence',
  FIRE_NOC: 'Fire NOC', POLLUTION: 'Pollution consent', SEZ_UNIT: 'SEZ unit', OTHER_LICENCE: 'Other licence',
};

const ENTITY_TYPES = {
  PRIVATE: 'Private limited company', PUBLIC: 'Public limited company', OPC: 'One person company',
  SECTION8: 'Section 8 company', LLP: 'Limited liability partnership', FOREIGN: 'Foreign company (Indian office)', OTHER: 'Other',
};
/** 'company' or 'llp' (what PAN / ROC rules care about) */
const entityKind = t => (t === 'LLP' ? 'llp' : t === 'OTHER' ? 'other' : 'company');

const EVENT_TYPES = {
  AGM: 'Annual general meeting', BOARD_MEETING: 'Board meeting', GST_CANCELLATION: 'GST registration cancelled',
  NOTICE: 'Notice received', INSPECTION: 'Inspection', HEARING: 'Hearing', ORDER: 'Order received (appeal window)',
  MATERIAL_EVENT: 'Material event / UPSI (listed)', DEBT_SERVICING: 'Interest / principal due on listed NCDs', REMITTANCE: 'Foreign remittance', AUDITOR_APPOINTMENT: 'Auditor appointment',
  DIRECTOR_CHANGE: 'Director appointment / cessation', RESOLUTION: 'Special / board resolution to be filed', ALLOTMENT: 'Share allotment',
  CHARGE: 'Charge created / modified', SHARE_ALLOTMENT_FDI: 'Shares issued to a foreign investor', SHARE_TRANSFER_FDI: 'Shares transferred resident ↔ non-resident',
  LLP_FDI: 'LLP capital contribution / transfer with a foreign partner', REFUND_CLAIM: 'GST refund to be claimed', INSTRUMENT: 'Lease / instrument executed',
  CONTRACT_OBLIGATION: 'Contract / covenant obligation', BENEFICIAL_INTEREST: 'Significant beneficial ownership change', OTHER: 'Other event',
};

const DOC_TYPES = {
  working: 'Working / computation', reconciliation: 'Reconciliation', approval: 'Approval', source_data: 'Source data',
  filed_return: 'Filed return / form copy', acknowledgement: 'Acknowledgement', payment_proof: 'Challan / payment receipt',
  bank_advice: 'Bank payment advice', notice: 'Notice / order', reply: 'Reply / submission', certificate: 'Certificate / licence', other: 'Other',
};

const ACK_TYPES = {
  ARN: 'ARN (GST acknowledgement reference)', SRN: 'SRN (MCA service request)', TRRN: 'TRRN (EPFO)', CHALLAN: 'Challan number',
  ACK_NO: 'Acknowledgement number', TOKEN: 'Token / PRN', EXCHANGE_REF: 'Exchange filing reference', FIRMS_REF: 'FIRMS / RBI reference',
  REFERENCE: 'Reference',
};

const NATURE_EVIDENCE = {
  return:         { review: ['working'], close: ['filed_return', 'acknowledgement'], payment: [] },
  payment:        { review: ['working'], close: ['payment_proof'], payment: [] },
  return_payment: { review: ['working'], close: ['filed_return', 'acknowledgement'], payment: ['payment_proof'] },
  internal:       { review: [], close: ['reconciliation'], payment: [] },
  event:          { review: ['working'], close: ['filed_return', 'acknowledgement'], payment: [] },
  renewal:        { review: [], close: ['certificate'], payment: [] },
  notice:         { review: ['working'], close: ['reply', 'acknowledgement'], payment: [] },
  transaction:    { review: [], close: [], payment: [] },
};

// ── Builders ──────────────────────────────────────────────────────────────────
const F = (fact, op, value) => ({ fact, [op]: value });
const ALL = (...c) => ({ all: c });
const ANY = (...c) => ({ any: c });
const TRUE = { all: [] };
const CR = 10000000;                                                  // one crore rupees

const SRC = {
  it_cal: 'https://www.incometaxindia.gov.in/tax-calendar',
  it_ded: 'https://www.incometaxindia.gov.in/en/tax-deductor',
  it_pay: 'https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/tax-payments-faq?mobile-app=1',
  gst_2b: 'https://tutorial.gst.gov.in/userguide/returns/FAQ_gstr2b.htm',
  gst_book: 'https://www.nacin.gov.in/Documents/e-Books/Vadodara/GST%20BOOK.pdf',
  gst_rules: 'https://taxinformation.cbic.gov.in/content-page/explore-rules/1000468/1000001',
  mca: 'https://www.mca.gov.in/',
  sebi: 'https://www.sebi.gov.in/legal/master-circulars/jan-2026/master-circular-for-compliance-with-the-provisions-of-the-securities-and-exchange-board-of-india-listing-obligations-and-disclosure-requirements-regulations-2015-by-listed-entities_99432.html',
  rbi: 'https://www.rbi.org.in/scripts/FAQView.aspx?Id=95',
  epfo: 'https://www.epfindia.gov.in/',
  esic: 'https://www.esic.nic.in/attachments/files/faq.pdf',
};

function version(o) {
  return {
    version: 1, status: 'draft',
    law: '', provision: '', form: '', authority: '',
    source_url: '', notification_no: '', notification_date: '', retrieved_at: '',
    verified_by: '', verified_by_id: '', verified_at: '', verification_note: '',
    approved_by: '', approved_by_id: '', approved_at: '',
    effective_from: '2017-04-01', effective_to: null,
    applicability: null, due: null, internal_offset_days: -2, notes: '',
    prefilled: 'Typed in when the module was built — not checked against a source',
    ...o,
  };
}

function rule(o) {
  const nature = o.nature || 'return';
  return {
    priority: 'medium', team: o.category, months_in_quarter: null, installments: null,
    filing: { ack: 'REFERENCE', payment_ref: null }, reference_sources: [],
    evidence: NATURE_EVIDENCE[nature], ...o, nature,
    versions: o.versions.map((x, i) => version({ version: i + 1, ...x })),
    seed: { catalogue_version: CATALOGUE_VERSION },
  };
}

const IT61 = { law: 'Income-tax Act, 1961', effective_to: '2026-03-31' };
const IT25 = { law: 'Income-tax Act, 2025', provision: '', form: '', effective_from: '2026-04-01', notes: 'Income-tax Act, 2025 period: provision and form to be mapped from official sources — legacy numbers are not assumed.' };
const regScope = (...types) => ({ type: 'registration', reg_types: types });
const company = { type: 'entity', entity_kinds: ['company'] };
const llp = { type: 'entity', entity_kinds: ['llp'] };
const anyEntity = { type: 'entity', entity_kinds: ['company', 'llp', 'other'] };
const evScope = (...types) => ({ type: 'event', event_types: types });
// Listed shares and listed debt securities (NCDs) carry different obligations, so they are tested separately.
// An unlisted entity is "not applicable" (listed = false decides it); a listed one without its listing type = needs review.
const LISTING = { equity: ['equity', 'equity_and_debt'], debt: ['debt', 'equity_and_debt'] };
const listed = ALL(F('entity.listed', 'eq', true), F('entity.listing_type', 'in', LISTING.equity));
const debtListed = ALL(F('entity.listed', 'eq', true), F('entity.listing_type', 'in', LISTING.debt));
const NCS = 'SEBI (LODR) Regulations, 2015 — Chapter V (listed non-convertible securities)';
const NCS_NOTE = 'Debt-listing obligation typed in at build time: regulation reference, timeline and form to be verified against the current SEBI master circular for listed non-convertible securities.';
const nextMonth = day => ({ type: 'next_month_day', day, months_after: 1 });
const afterEnd = (month, day, overrides) => ({ type: 'next_date_after_period_end', month, day, ...(overrides ? { overrides } : {}) });
const ref = (key, due_text, status, trigger) => ({ key, due_text, status, trigger });

// QRMP GSTR-3B state groups — draft table, to be verified against the notification for the period
const QRMP_22 = ['CG', 'MP', 'GJ', 'MH', 'KA', 'GA', 'KL', 'TN', 'TS', 'AP', 'DN', 'PY', 'AN', 'LD'];
const QRMP_24 = ['HP', 'PB', 'UK', 'HR', 'RJ', 'UP', 'BR', 'SK', 'AR', 'NL', 'MN', 'MZ', 'TR', 'ML', 'AS', 'WB', 'JH', 'OD', 'JK', 'LA', 'CH', 'DL'];

const RULES = [
  // ── GST ─────────────────────────────────────────────────────────────────────
  rule({ id: 'GST-R1-M', category: 'GST', name: 'GSTR-1 (monthly)', nature: 'return', scope: regScope('GST_REGULAR'), frequency: 'monthly', priority: 'high',
    filing: { ack: 'ARN' }, reference: ref('GSTIN', '11th of next month', 'Standard reference', 'Regular monthly filers'), reference_sources: [SRC.gst_rules],
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 37; Rule 59', form: 'GSTR-1', authority: 'CBIC / GSTN', applicability: F('registration.frequency', 'eq', 'monthly'), due: nextMonth(11) }] }),
  rule({ id: 'GST-3B-M', category: 'GST', name: 'GSTR-3B (monthly)', nature: 'return_payment', scope: regScope('GST_REGULAR'), frequency: 'monthly', priority: 'high',
    filing: { ack: 'ARN', payment_ref: 'GST' }, reference: ref('GSTIN', '20th of next month', 'Standard reference', 'Regular monthly filers'), reference_sources: [SRC.gst_rules],
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 39(1); Rule 61', form: 'GSTR-3B', authority: 'CBIC / GSTN', applicability: F('registration.frequency', 'eq', 'monthly'), due: nextMonth(20) }] }),
  rule({ id: 'GST-R1-Q', category: 'GST', name: 'GSTR-1 (quarterly, QRMP)', nature: 'return', scope: regScope('GST_REGULAR'), frequency: 'quarterly', priority: 'high',
    filing: { ack: 'ARN' }, reference: ref('GSTIN', '13th following quarter', 'Verify applicability', 'QRMP election'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 37; Rule 59 (QRMP proviso)', form: 'GSTR-1', authority: 'CBIC / GSTN', applicability: F('registration.frequency', 'eq', 'quarterly'), due: nextMonth(13) }] }),
  rule({ id: 'GST-IFF', category: 'GST', name: 'Invoice Furnishing Facility (IFF, optional M1–M2)', nature: 'return', scope: regScope('GST_REGULAR'), frequency: 'monthly', months_in_quarter: [1, 2],
    filing: { ack: 'ARN' }, reference: ref('GSTIN', 'optional M1–M2', 'Verify applicability', 'QRMP election'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Rule 59(2) proviso', form: 'IFF', authority: 'CBIC / GSTN',
      applicability: ALL(F('registration.frequency', 'eq', 'quarterly'), F('registration.uses_iff', 'eq', true)), due: nextMonth(13),
      notes: 'Optional facility: applicable only where the registration has chosen to use IFF (record "uses IFF" on the registration).' }] }),
  rule({ id: 'GST-3B-Q', category: 'GST', name: 'GSTR-3B (quarterly, QRMP)', nature: 'return_payment', scope: regScope('GST_REGULAR'), frequency: 'quarterly', priority: 'high',
    filing: { ack: 'ARN', payment_ref: 'GST' }, reference: ref('GSTIN', '22nd/24th quarterly', 'Verify state', 'QRMP and state group'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 39(1) proviso; Rule 61', form: 'GSTR-3B', authority: 'CBIC / GSTN', applicability: F('registration.frequency', 'eq', 'quarterly'),
      due: { type: 'state_group', months_after: 1, days_by_state: { 22: QRMP_22, 24: QRMP_24 } },
      notes: 'The 22nd / 24th state-group table was typed in at build time — verify it against the notification for the period.' }] }),
  rule({ id: 'GST-PMT06', category: 'GST', name: 'PMT-06 monthly payment (QRMP, M1–M2)', nature: 'payment', scope: regScope('GST_REGULAR'), frequency: 'monthly', months_in_quarter: [1, 2],
    filing: { ack: 'CHALLAN', payment_ref: 'GST' }, reference: ref('GSTIN', '25th M1–M2', 'Verify state', 'QRMP and state group'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Rule 61A', form: 'PMT-06', authority: 'CBIC / GSTN', applicability: F('registration.frequency', 'eq', 'quarterly'), due: nextMonth(25) }] }),
  rule({ id: 'GST-R6', category: 'GST', name: 'GSTR-6 (Input Service Distributor)', nature: 'return', scope: regScope('GST_ISD'), frequency: 'monthly',
    filing: { ack: 'ARN' }, reference: ref('ISD registration', '13th of next month', 'Verify applicability', 'ISD / common input services'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 39(4); Rule 65', form: 'GSTR-6', authority: 'CBIC / GSTN', applicability: TRUE, due: nextMonth(13) }] }),
  rule({ id: 'GST-R7', category: 'GST', name: 'GSTR-7 (GST TDS deductor)', nature: 'return_payment', scope: regScope('GST_TDS'), frequency: 'monthly',
    filing: { ack: 'ARN', payment_ref: 'GST' }, reference: ref('Registration', '10th of next month', 'Verify applicability', 'GST deductor'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 39(3); Rule 66', form: 'GSTR-7', authority: 'CBIC / GSTN', applicability: TRUE, due: nextMonth(10) }] }),
  rule({ id: 'GST-R8', category: 'GST', name: 'GSTR-8 (e-commerce TCS collector)', nature: 'return_payment', scope: regScope('GST_TCS'), frequency: 'monthly',
    filing: { ack: 'ARN', payment_ref: 'GST' }, reference: ref('Registration', '10th of next month', 'Verify applicability', 'E-commerce collector'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 52; Rule 67', form: 'GSTR-8', authority: 'CBIC / GSTN', applicability: TRUE, due: nextMonth(10) }] }),
  rule({ id: 'GST-R9', category: 'GST', name: 'GSTR-9 annual return', nature: 'return', scope: regScope('GST_REGULAR'), frequency: 'annual', priority: 'high',
    filing: { ack: 'ARN' }, reference: ref('GSTIN', '31 December following FY', 'Standard reference', 'Year-specific exemption and turnover tests'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 44; Rule 80', form: 'GSTR-9', authority: 'CBIC / GSTN', applicability: null, due: afterEnd(12, 31),
      notes: 'Applicability depends on the year-specific turnover exemption — decide per GSTIN and year with the notification as evidence.' }] }),
  rule({ id: 'GST-R9C', category: 'GST', name: 'GSTR-9C reconciliation statement', nature: 'return', scope: regScope('GST_REGULAR'), frequency: 'annual',
    filing: { ack: 'ARN' }, reference: ref('GSTIN', '31 December following FY', 'Standard reference', 'Year-specific exemption and turnover tests'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 44; Rule 80(3)', form: 'GSTR-9C', authority: 'CBIC / GSTN', applicability: null, due: afterEnd(12, 31),
      notes: 'Turnover threshold is year-specific — decide per GSTIN and year.' }] }),
  rule({ id: 'GST-CMP08', category: 'GST', name: 'CMP-08 (composition, quarterly)', nature: 'return_payment', scope: regScope('GST_COMPOSITION'), frequency: 'quarterly',
    filing: { ack: 'ARN', payment_ref: 'GST' }, reference: ref('GSTIN', 'Rule-based; verify period', 'Needs review', 'Composition eligibility'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 10; Rule 62', form: 'CMP-08', authority: 'CBIC / GSTN', applicability: TRUE, due: null }] }),
  rule({ id: 'GST-R4', category: 'GST', name: 'GSTR-4 (composition, annual)', nature: 'return', scope: regScope('GST_COMPOSITION'), frequency: 'annual',
    filing: { ack: 'ARN' }, reference: ref('GSTIN', 'Rule-based; verify period', 'Needs review', 'Composition eligibility'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 39(2); Rule 62', form: 'GSTR-4', authority: 'CBIC / GSTN', applicability: TRUE, due: null }] }),
  rule({ id: 'GST-R5', category: 'GST', name: 'GSTR-5 / GSTR-5A (non-resident / OIDAR)', nature: 'return_payment', scope: regScope('GST_NRTP', 'GST_OIDAR'), frequency: 'monthly',
    filing: { ack: 'ARN', payment_ref: 'GST' }, reference: ref('GSTIN', 'Rule-based; verify current form', 'Needs review', 'Non-resident / OIDAR'),
    versions: [{ law: 'CGST / IGST Act, 2017', provision: '', form: 'GSTR-5 / GSTR-5A', authority: 'CBIC / GSTN', applicability: TRUE, due: null }] }),
  rule({ id: 'GST-R10', category: 'GST', name: 'GSTR-10 final return', nature: 'event', scope: evScope('GST_CANCELLATION'), frequency: 'event',
    filing: { ack: 'ARN' }, reference: ref('GSTIN', 'Event-based cancellation deadline', 'Needs review', 'Cancelled registration'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 45; Rule 81', form: 'GSTR-10', authority: 'CBIC / GSTN', applicability: TRUE, due: null }] }),
  rule({ id: 'GST-LUT', category: 'GST', name: 'LUT for exports / SEZ supplies', nature: 'return', scope: regScope('GST_REGULAR'), frequency: 'annual',
    filing: { ack: 'ARN' }, reference: ref('GSTIN', 'FY start', 'Needs review', 'Exports / SEZ supplies'),
    versions: [{ law: 'IGST Act, 2017; CGST Rules', provision: 'Section 16 IGST; Rule 96A', form: 'RFD-11', authority: 'CBIC / GSTN', applicability: F('entity.flags.has_exports', 'eq', true), due: null }] }),
  rule({ id: 'GST-RFD', category: 'GST', name: 'GST refund claim (RFD-01)', nature: 'event', scope: evScope('REFUND_CLAIM'), frequency: 'event',
    filing: { ack: 'ARN' }, reference: ref('GSTIN', 'Claim limitation', 'Needs review', 'Exports / SEZ supplies'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 54; Rule 89', form: 'RFD-01', authority: 'CBIC / GSTN', applicability: TRUE, due: null }] }),
  rule({ id: 'GST-2B-RECO', category: 'GST', name: 'GSTR-2B / IMS / ITC reconciliation (internal)', nature: 'internal', scope: regScope('GST_REGULAR'), frequency: 'monthly',
    reference: ref('GSTIN', 'Internal target before GSTR-3B', 'Internal control', 'Not a separate statutory return'), reference_sources: [SRC.gst_2b],
    versions: [{ law: 'Internal control', authority: 'Internal', applicability: F('registration.frequency', 'eq', 'monthly'), due: { type: 'linked', rule: 'GST-3B-M', days: -2 },
      notes: 'Internal target (2 days before GSTR-3B) — a company choice, not a statutory date. Change it here.' }] }),
  rule({ id: 'GST-RCM-REVIEW', category: 'GST', name: 'RCM / ISD / cross-charge review (internal)', nature: 'internal', scope: regScope('GST_REGULAR'), frequency: 'monthly',
    reference: ref('GSTIN', 'Linked to return period', 'Internal control', 'Inter-branch and common costs'),
    versions: [{ law: 'Internal control', authority: 'Internal', applicability: F('registration.frequency', 'eq', 'monthly'), due: { type: 'linked', rule: 'GST-3B-M', days: -2 } }] }),
  rule({ id: 'GST-ITC-180', category: 'GST', name: '180-day ITC / annual reversals review', nature: 'internal', scope: regScope('GST_REGULAR'), frequency: 'monthly',
    reference: ref('GSTIN', 'Invoice and rule-based', 'Needs review', 'Vendor payments / exempt supplies'),
    versions: [{ law: 'CGST Act, 2017', provision: 'Section 16(2) second proviso; Rules 37, 42, 43', authority: 'CBIC', applicability: null, due: { type: 'linked', rule: 'GST-3B-M', days: -2 } }] }),
  rule({ id: 'GST-EINV-EWB', category: 'GST', name: 'E-invoice / e-way bill compliance', nature: 'transaction', scope: regScope('GST_REGULAR'), frequency: 'transaction',
    reference: ref('GSTIN', 'Transaction-based', 'Needs review', 'Turnover, transaction and state tests'),
    versions: [{ law: 'CGST Rules, 2017', provision: 'Rule 48(4); Rule 138', authority: 'CBIC / NIC', applicability: null, due: null,
      notes: 'Transaction-based: no calendar task. Applicability is still decided and shown in coverage.' }] }),

  // ── TDS / TCS ───────────────────────────────────────────────────────────────
  rule({ id: 'TDS-DEP', category: 'TDS/TCS', name: 'TDS monthly deposit', nature: 'payment', scope: regScope('TAN'), frequency: 'monthly', priority: 'high',
    filing: { ack: 'CHALLAN', payment_ref: 'TDS' }, reference: ref('TAN', '7th next month; March special rule', 'Standard reference', 'Non-government regular deductions; tax-year regime mapping'),
    reference_sources: [SRC.it_ded, SRC.it_pay],
    versions: [
      { ...IT61, provision: 'Section 200; Rule 30', form: 'Challan ITNS 281', authority: 'CBDT', applicability: TRUE, due: { ...nextMonth(7), overrides: [{ period_end_month: 3, months_after: 1, day: 30 }] } },
      { ...IT25, authority: 'CBDT', applicability: TRUE, due: { ...nextMonth(7), overrides: [{ period_end_month: 3, months_after: 1, day: 30 }] } },
    ] }),
  rule({ id: 'TDS-STMT-SAL', category: 'TDS/TCS', name: 'TDS statement — salary (quarterly)', nature: 'return', scope: regScope('TAN'), frequency: 'quarterly',
    filing: { ack: 'TOKEN' }, reference: ref('TAN', 'Quarter and form-specific', 'Needs review', 'Map current forms and legacy periods'),
    versions: [
      { ...IT61, provision: 'Section 200(3); Rule 31A', form: '24Q', authority: 'CBDT', applicability: F('registration.deducts_salary', 'eq', true),
        due: { type: 'next_month_day', day: 31, months_after: 1, overrides: [{ quarter: 'Q4', months_after: 2, day: 31 }] }, notes: 'Legacy (1961 Act) quarter dates as in Compliance v1 — verify.' },
      { ...IT25, authority: 'CBDT', applicability: F('registration.deducts_salary', 'eq', true), due: null },
    ] }),
  rule({ id: 'TDS-STMT-NONSAL', category: 'TDS/TCS', name: 'TDS statement — non-salary residents (quarterly)', nature: 'return', scope: regScope('TAN'), frequency: 'quarterly',
    filing: { ack: 'TOKEN' }, reference: ref('TAN', 'Quarter and form-specific', 'Needs review', 'Map current forms and legacy periods'),
    versions: [
      { ...IT61, provision: 'Section 200(3); Rule 31A', form: '26Q', authority: 'CBDT', applicability: F('registration.deducts_non_salary', 'eq', true),
        due: { type: 'next_month_day', day: 31, months_after: 1, overrides: [{ quarter: 'Q4', months_after: 2, day: 31 }] }, notes: 'Legacy (1961 Act) quarter dates as in Compliance v1 — verify.' },
      { ...IT25, authority: 'CBDT', applicability: F('registration.deducts_non_salary', 'eq', true), due: null },
    ] }),
  rule({ id: 'TDS-STMT-NR', category: 'TDS/TCS', name: 'TDS statement — non-residents (quarterly)', nature: 'return', scope: regScope('TAN'), frequency: 'quarterly',
    filing: { ack: 'TOKEN' }, reference: ref('TAN', 'Quarter and form-specific', 'Needs review', 'Map current forms and legacy periods'),
    versions: [
      { ...IT61, provision: 'Section 200(3); Rule 31A', form: '27Q', authority: 'CBDT', applicability: F('registration.deducts_non_resident', 'eq', true), due: null },
      { ...IT25, authority: 'CBDT', applicability: F('registration.deducts_non_resident', 'eq', true), due: null },
    ] }),
  rule({ id: 'TCS-STMT', category: 'TDS/TCS', name: 'TCS statement (quarterly)', nature: 'return', scope: regScope('TAN'), frequency: 'quarterly',
    filing: { ack: 'TOKEN' }, reference: ref('TAN', 'Quarter and form-specific', 'Needs review', 'Map current forms and legacy periods'),
    versions: [
      { ...IT61, provision: 'Section 206C(3); Rule 31AA', form: '27EQ', authority: 'CBDT', applicability: F('registration.collects_tcs', 'eq', true), due: null },
      { ...IT25, authority: 'CBDT', applicability: F('registration.collects_tcs', 'eq', true), due: null },
    ] }),
  rule({ id: 'TDS-CERT', category: 'TDS/TCS', name: 'TDS / TCS certificates', nature: 'return', scope: regScope('TAN'), frequency: 'quarterly',
    filing: { ack: 'REFERENCE' }, evidence: { review: [], close: ['certificate'], payment: [] },
    reference: ref('TAN', 'Statement and certificate-specific', 'Needs review', 'Salary / non-salary / special deduction'),
    versions: [{ ...IT61, provision: 'Section 203; Rule 31', form: 'Form 16 / 16A / 27D', authority: 'CBDT', applicability: TRUE, due: null }, { ...IT25, authority: 'CBDT', applicability: TRUE, due: null }] }),

  // ── Income tax ──────────────────────────────────────────────────────────────
  rule({ id: 'IT-ADV', category: 'Income Tax', name: 'Advance tax instalment', nature: 'payment', scope: anyEntity, frequency: 'installments', installments: 4, priority: 'high',
    filing: { ack: 'CHALLAN', payment_ref: 'TDS' }, reference: ref('PAN', '15 Jun / Sep / Dec / Mar', 'Standard reference', 'Cumulative 15% / 45% / 75% / 100%; exceptions'), reference_sources: [SRC.it_cal],
    versions: [
      { ...IT61, provision: 'Sections 208–211', form: 'Challan ITNS 280', authority: 'CBDT', applicability: TRUE, due: { type: 'fy_dates', dates: ['06-15', '09-15', '12-15', '03-15'] }, notes: 'Cumulative 15% / 45% / 75% / 100% (catalogue). Exceptions to be reviewed per entity.' },
      { ...IT25, authority: 'CBDT', applicability: TRUE, due: { type: 'fy_dates', dates: ['06-15', '09-15', '12-15', '03-15'] } },
    ] }),
  rule({ id: 'IT-ITR', category: 'Income Tax', name: 'Income-tax return (original / revised)', nature: 'return_payment', scope: anyEntity, frequency: 'annual', priority: 'high',
    filing: { ack: 'ACK_NO', payment_ref: 'TDS' }, reference: ref('PAN', 'Audit / TP / taxpayer-specific', 'Needs review', 'FY, AY or tax year and applicable Act'),
    versions: [{ ...IT61, provision: 'Section 139', form: 'ITR-6 / ITR-5', authority: 'CBDT', applicability: TRUE, due: null }, { ...IT25, authority: 'CBDT', applicability: TRUE, due: null }] }),
  rule({ id: 'IT-TAR', category: 'Income Tax', name: 'Tax audit report', nature: 'return', scope: anyEntity, frequency: 'annual',
    filing: { ack: 'ACK_NO' }, reference: ref('PAN', 'Return-linked statutory deadline', 'Needs review', 'Audit and specified transaction thresholds'),
    versions: [{ ...IT61, provision: 'Section 44AB', form: '3CA / 3CB-3CD', authority: 'CBDT', applicability: F('entity.fy.tax_audit_required', 'eq', true), due: null }, { ...IT25, authority: 'CBDT', applicability: F('entity.fy.tax_audit_required', 'eq', true), due: null }] }),
  rule({ id: 'IT-TPR', category: 'Income Tax', name: 'Transfer pricing report', nature: 'return', scope: anyEntity, frequency: 'annual',
    filing: { ack: 'ACK_NO' }, reference: ref('PAN', 'Return-linked statutory deadline', 'Needs review', 'Audit and specified transaction thresholds'),
    versions: [{ ...IT61, provision: 'Section 92E', form: '3CEB', authority: 'CBDT', applicability: ANY(F('entity.flags.has_international_transactions', 'eq', true), F('entity.flags.has_specified_domestic_transactions', 'eq', true)), due: null },
      { ...IT25, authority: 'CBDT', applicability: ANY(F('entity.flags.has_international_transactions', 'eq', true), F('entity.flags.has_specified_domestic_transactions', 'eq', true)), due: null }] }),
  rule({ id: 'IT-SFT', category: 'Income Tax', name: 'SFT / reportable accounts', nature: 'return', scope: anyEntity, frequency: 'annual',
    filing: { ack: 'ACK_NO' }, reference: ref('PAN', 'Form and reporting-year-specific', 'Needs review', 'Reportable transactions'),
    versions: [{ ...IT61, provision: 'Section 285BA', form: 'Form 61A', authority: 'CBDT', applicability: F('entity.flags.has_reportable_sft', 'eq', true), due: null }, { ...IT25, authority: 'CBDT', applicability: F('entity.flags.has_reportable_sft', 'eq', true), due: null }] }),
  rule({ id: 'IT-REMIT', category: 'Income Tax', name: 'Foreign remittance declaration', nature: 'event', scope: evScope('REMITTANCE'), frequency: 'event',
    filing: { ack: 'ACK_NO' }, reference: ref('Transaction', 'Before remittance where required', 'Needs review', 'Form mapping and remittance conditions'),
    versions: [{ ...IT61, provision: 'Section 195(6); Rule 37BB', form: '15CA / 15CB', authority: 'CBDT', applicability: TRUE, due: { type: 'event_field', field: 'event_date' } }, { ...IT25, authority: 'CBDT', applicability: TRUE, due: { type: 'event_field', field: 'event_date' } }] }),
  rule({ id: 'IT-LDC', category: 'Income Tax', name: 'Lower deduction certificate / declarations', nature: 'renewal', scope: regScope('TAN'), frequency: 'annual',
    reference: ref('PAN / TAN', 'Validity or event-based', 'Needs review', 'Certificate and declaration eligibility'),
    versions: [{ ...IT61, provision: 'Section 197', form: 'Form 13', authority: 'CBDT', applicability: null, due: null }, { ...IT25, authority: 'CBDT', applicability: null, due: null }] }),
  rule({ id: 'IT-RECO', category: 'Income Tax', name: 'Tax credit reconciliation (AIS / 26AS / demands)', nature: 'internal', scope: anyEntity, frequency: 'quarterly',
    reference: ref('PAN', 'Internal target', 'Needs review', 'AIS, tax credits, demands and response date'),
    versions: [{ law: 'Internal control', authority: 'Internal', applicability: TRUE, due: { type: 'manual' } }] }),

  // ── ROC / LLP ───────────────────────────────────────────────────────────────
  rule({ id: 'ROC-AOC4', category: 'ROC/LLP', name: 'AOC-4 / XBRL / CFS (financial statements)', nature: 'return_payment', scope: company, frequency: 'annual', priority: 'high',
    filing: { ack: 'SRN' }, reference: ref('Company', 'AGM + 30 days, standard company rule', 'Needs review', 'Entity exceptions and current extensions'), reference_sources: [SRC.mca],
    versions: [{ law: 'Companies Act, 2013', provision: 'Section 137', form: 'AOC-4 / AOC-4 XBRL / AOC-4 CFS', authority: 'MCA', applicability: TRUE, due: { type: 'event_offset', event_type: 'AGM', days: 30 } }] }),
  rule({ id: 'ROC-MGT7', category: 'ROC/LLP', name: 'MGT-7 / MGT-7A annual return', nature: 'return_payment', scope: company, frequency: 'annual', priority: 'high',
    filing: { ack: 'SRN' }, reference: ref('Company', 'AGM + 60 days, standard rule', 'Needs review', 'Applicable annual return form'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Section 92', form: 'MGT-7 / MGT-7A', authority: 'MCA', applicability: TRUE, due: { type: 'event_offset', event_type: 'AGM', days: 60 } }] }),
  rule({ id: 'ROC-AGM', category: 'ROC/LLP', name: 'AGM / board / committee meetings', nature: 'internal', scope: company, frequency: 'annual',
    evidence: { review: [], close: ['approval'], payment: [] }, reference: ref('Company', 'Event and entity-specific', 'Needs review', 'Listed / private / public exceptions'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Sections 96, 173', authority: 'MCA', applicability: TRUE, due: null }] }),
  rule({ id: 'LLP-11', category: 'ROC/LLP', name: 'LLP Form 11 (annual return)', nature: 'return_payment', scope: llp, frequency: 'annual', priority: 'high',
    filing: { ack: 'SRN' }, reference: ref('LLP', '30 May standard', 'Needs review', 'Verify period-specific circulars'),
    versions: [{ law: 'LLP Act, 2008', provision: 'Section 35; Rule 25', form: 'Form 11', authority: 'MCA', applicability: TRUE, due: afterEnd(5, 30) }] }),
  rule({ id: 'LLP-8', category: 'ROC/LLP', name: 'LLP Form 8 (statement of account & solvency)', nature: 'return_payment', scope: llp, frequency: 'annual', priority: 'high',
    filing: { ack: 'SRN' }, reference: ref('LLP', '30 October standard', 'Needs review', 'Verify period-specific circulars'),
    versions: [{ law: 'LLP Act, 2008', provision: 'Section 34; Rule 24', form: 'Form 8', authority: 'MCA', applicability: TRUE, due: afterEnd(10, 30) }] }),
  rule({ id: 'ROC-MSME1', category: 'ROC/LLP', name: 'MSME-1 half-yearly return', nature: 'return', scope: company, frequency: 'half_yearly',
    filing: { ack: 'SRN' }, reference: ref('Company', '30 Apr / 31 Oct standard', 'Needs review', 'Specified companies; not automatic for LLPs'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Section 405; Specified Companies Order', form: 'MSME Form I', authority: 'MCA', applicability: F('entity.flags.has_msme_dues_over_45_days', 'eq', true),
      due: afterEnd(10, 31, [{ half: 'H2', month: 4, day: 30 }]) }] }),
  rule({ id: 'ROC-DPT3', category: 'ROC/LLP', name: 'DPT-3 (deposits / outstanding receipts)', nature: 'return', scope: company, frequency: 'annual',
    filing: { ack: 'SRN' }, reference: ref('Company', '30 June standard', 'Needs review', 'Receipts classification and extensions'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Rule 16 / 16A, Acceptance of Deposits Rules', form: 'DPT-3', authority: 'MCA', applicability: F('entity.flags.has_deposit_or_loan_receipts', 'eq', true), due: afterEnd(6, 30) }] }),
  rule({ id: 'ROC-DIR3KYC', category: 'ROC/LLP', name: 'DIR-3 KYC (per director)', nature: 'return', scope: { type: 'person', with: 'din' }, frequency: 'annual',
    filing: { ack: 'SRN' }, reference: ref('Individual', 'KYC rule', 'Needs review', 'Director-linked, avoid duplicate group tasks'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Rule 12A, Appointment and Qualification of Directors Rules', form: 'DIR-3 KYC', authority: 'MCA', applicability: TRUE, due: null }] }),
  rule({ id: 'ROC-DSC', category: 'ROC/LLP', name: 'DSC renewal (per signatory)', nature: 'renewal', scope: { type: 'person', with: 'dsc_expiry' }, frequency: 'renewal',
    reference: ref('Individual', 'Certificate expiry', 'Needs review', 'Director-linked, avoid duplicate group tasks'),
    versions: [{ law: 'Information Technology Act, 2000', authority: 'Certifying authority', applicability: TRUE, due: { type: 'expiry', days_before: 0 }, notes: 'Due on the recorded certificate expiry date (from the person record).' }] }),
  rule({ id: 'ROC-PAS6', category: 'ROC/LLP', name: 'PAS-6 / dematerialisation (unlisted public)', nature: 'return', scope: company, frequency: 'half_yearly',
    filing: { ack: 'SRN' }, reference: ref('Company', 'Half-year / applicable rules', 'Needs review', 'Unlisted company applicability'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Rule 9A, Prospectus and Allotment Rules', form: 'PAS-6', authority: 'MCA', applicability: ALL(F('entity.type', 'eq', 'PUBLIC'), F('entity.listed', 'eq', false)), due: null }] }),
  rule({ id: 'ROC-CSR', category: 'ROC/LLP', name: 'CSR obligation and reporting', nature: 'return', scope: company, frequency: 'annual',
    filing: { ack: 'SRN' }, reference: ref('Company', 'Threshold and filing-specific', 'Needs review', 'Net worth, turnover, profit and sector tests'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Section 135', form: 'CSR-2', authority: 'MCA',
      applicability: ANY(F('entity.prev_fy.net_worth', 'gte', 500 * CR), F('entity.prev_fy.turnover', 'gte', 1000 * CR), F('entity.prev_fy.net_profit', 'gte', 5 * CR)), due: null,
      notes: 'Draft thresholds (net worth ≥ ₹500 cr, turnover ≥ ₹1,000 cr or net profit ≥ ₹5 cr, preceding FY) — verify.' }] }),
  rule({ id: 'ROC-COSTAUDIT', category: 'ROC/LLP', name: 'Cost audit / cost records', nature: 'return', scope: company, frequency: 'annual',
    filing: { ack: 'SRN' }, reference: ref('Company', 'Threshold and filing-specific', 'Needs review', 'Net worth, turnover, profit and sector tests'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Section 148', form: 'CRA-2 / CRA-4', authority: 'MCA', applicability: F('entity.flags.cost_audit_sector', 'eq', true), due: null }] }),
  rule({ id: 'ROC-SECAUDIT', category: 'ROC/LLP', name: 'Secretarial audit', nature: 'return', scope: company, frequency: 'annual',
    reference: ref('Company', 'Threshold and filing-specific', 'Needs review', 'Net worth, turnover, profit and sector tests'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Section 204', form: 'MR-3', authority: 'MCA', applicability: ANY(listed, F('entity.flags.secretarial_audit_required', 'eq', true)), due: null }] }),
  ...[['ADT1', 'ADT-1 auditor appointment', 'AUDITOR_APPOINTMENT', 'Section 139'], ['DIR12', 'DIR-12 director change', 'DIRECTOR_CHANGE', 'Section 170'],
    ['MGT14', 'MGT-14 resolutions', 'RESOLUTION', 'Section 117'], ['PAS3', 'PAS-3 return of allotment', 'ALLOTMENT', 'Section 39(4) / 42'], ['CHG1', 'CHG-1 charge', 'CHARGE', 'Section 77']]
    .map(([id, name, ev, prov]) => rule({ id: `ROC-${id}`, category: 'ROC/LLP', name, nature: 'event', scope: evScope(ev), frequency: 'event', filing: { ack: 'SRN' },
      reference: ref('Company', 'Trigger-based statutory offsets', 'Needs review', 'Appointments, resolutions, allotments, charges'),
      versions: [{ law: 'Companies Act, 2013', provision: prov, form: name.split(' ')[0], authority: 'MCA', applicability: TRUE, due: null }] })),
  rule({ id: 'ROC-BEN-IEPF', category: 'ROC/LLP', name: 'Beneficial ownership / IEPF', nature: 'event', scope: evScope('BENEFICIAL_INTEREST'), frequency: 'event', filing: { ack: 'SRN' },
    reference: ref('Company', 'Event / annual obligation', 'Needs review', 'Beneficial interest and unpaid amounts'),
    versions: [{ law: 'Companies Act, 2013', provision: 'Sections 90, 125', form: 'BEN-2 / IEPF', authority: 'MCA', applicability: TRUE, due: null }] }),

  // ── Provident Fund (V2: ECR and payment are separate items) ─────────────────
  rule({ id: 'PF-ECR', category: 'Provident Fund', name: 'EPF ECR preparation and submission', nature: 'return', scope: regScope('PF'), frequency: 'monthly', priority: 'high',
    filing: { ack: 'TRRN' }, evidence: { review: ['working'], close: ['acknowledgement'], payment: [] },
    reference: ref('Establishment', '15th next month baseline', 'Needs review', 'Current scheme and notifications'), reference_sources: [SRC.epfo],
    versions: [{ law: 'EPF & MP Act, 1952; EPF Scheme, 1952', provision: 'Paragraph 38', form: 'ECR', authority: 'EPFO', applicability: TRUE, due: nextMonth(15),
      notes: 'Wage month = the task month. Labour Codes transition must be validated for the period.' }] }),
  rule({ id: 'PF-PAY', category: 'Provident Fund', name: 'EPF contribution payment', nature: 'payment', scope: regScope('PF'), frequency: 'monthly', priority: 'high',
    filing: { ack: 'TRRN', payment_ref: 'PF' }, evidence: { review: [], close: ['payment_proof'], payment: [] },
    reference: ref('Establishment', '15th next month baseline', 'Needs review', 'Current scheme and notifications'), reference_sources: [SRC.epfo],
    versions: [{ law: 'EPF & MP Act, 1952; EPF Scheme, 1952', provision: 'Paragraph 38', form: 'Challan (TRRN)', authority: 'EPFO', applicability: TRUE, due: nextMonth(15) }] }),
  rule({ id: 'PF-RECO', category: 'Provident Fund', name: 'PF member / wage reconciliation (internal)', nature: 'internal', scope: regScope('PF'), frequency: 'monthly',
    reference: ref('Establishment', 'Before ECR', 'Internal control', 'Payroll ↔ ECR ↔ challan'),
    versions: [{ law: 'Internal control', authority: 'Internal', applicability: TRUE, due: { type: 'linked', rule: 'PF-ECR', days: -2 } }] }),

  // ── ESIC ────────────────────────────────────────────────────────────────────
  rule({ id: 'ESI-PAY', category: 'ESIC', name: 'ESI contribution payment', nature: 'payment', scope: regScope('ESIC'), frequency: 'monthly', priority: 'high',
    filing: { ack: 'CHALLAN', payment_ref: 'ESIC' }, evidence: { review: ['working'], close: ['payment_proof'], payment: [] },
    reference: ref('Establishment', '15th next month', 'Standard reference', 'Covered establishment / employees'), reference_sources: [SRC.esic],
    versions: [{ law: 'ESI Act, 1948', provision: 'Regulation 31, ESI (General) Regulations', form: 'ESIC challan', authority: 'ESIC', applicability: TRUE, due: nextMonth(15) }] }),

  // ── Professional Tax (state-specific: never a nationwide date) ──────────────
  rule({ id: 'PT-PTRC-PAY', category: 'Professional Tax', name: 'PT employer deduction — payment (PTRC)', nature: 'payment', scope: regScope('PT_PTRC'), frequency: 'per_registration',
    filing: { ack: 'CHALLAN', payment_ref: 'PT' }, evidence: { review: ['working'], close: ['payment_proof'], payment: [] },
    reference: ref('State registration', 'State and enrolment-specific', 'Needs review', 'No single India-wide deadline'),
    versions: [{ law: 'State Professional Tax Act', authority: 'State tax department', applicability: TRUE,
      due: { type: 'by_state', states: { GJ: nextMonth(15) } },
      notes: 'Only a Gujarat draft (the "15th of the following month" starting value from Compliance v1) is recorded. Every other state is unscheduled and listed in the missing-rule queue until its rule is added and verified.' }] }),
  rule({ id: 'PT-PTRC-RET', category: 'Professional Tax', name: 'PT employer return (PTRC)', nature: 'return', scope: regScope('PT_PTRC'), frequency: 'per_registration',
    filing: { ack: 'ACK_NO' }, reference: ref('State registration', 'State and enrolment-specific', 'Needs review', 'No single India-wide deadline'),
    versions: [{ law: 'State Professional Tax Act', authority: 'State tax department', applicability: null, due: { type: 'by_state', states: {} },
      notes: 'Whether a separate return applies, and its periodicity, depends on the state and the registration.' }] }),
  rule({ id: 'PT-PTEC', category: 'Professional Tax', name: 'PT entity enrolment — payment (PTEC)', nature: 'payment', scope: regScope('PT_PTEC'), frequency: 'per_registration',
    filing: { ack: 'CHALLAN', payment_ref: 'PT' }, evidence: { review: [], close: ['payment_proof'], payment: [] },
    reference: ref('State registration', 'State and enrolment-specific', 'Needs review', 'Entity enrolment, not a payroll deduction'),
    versions: [{ law: 'State Professional Tax Act', authority: 'State tax department', applicability: TRUE, due: { type: 'by_state', states: {} } }] }),

  // ── Labour & payroll (other) ────────────────────────────────────────────────
  rule({ id: 'LWF', category: 'Labour & Payroll', name: 'Labour welfare fund contribution', nature: 'payment', scope: regScope('LWF'), frequency: 'per_registration',
    filing: { ack: 'CHALLAN' }, reference: ref('Establishment', 'State-specific', 'Needs review', 'Workforce / state coverage'),
    versions: [{ law: 'State Labour Welfare Fund Act', authority: 'State labour welfare board', applicability: TRUE, due: { type: 'by_state', states: {} } }] }),
  rule({ id: 'SHOPS-RENEWAL', category: 'Labour & Payroll', name: 'Shops & establishment registration renewal', nature: 'renewal', scope: regScope('SHOPS_EST'), frequency: 'renewal',
    reference: ref('Establishment', 'State / registration / event-specific', 'Needs review', 'Licences, returns, contractor evidence'),
    versions: [{ law: 'State Shops & Establishments Act', authority: 'State labour department', applicability: TRUE, due: { type: 'expiry', days_before: 0 } }] }),
  rule({ id: 'CLRA', category: 'Labour & Payroll', name: 'Contract labour registration / returns', nature: 'return', scope: { type: 'establishment' }, frequency: 'annual',
    reference: ref('Establishment', 'State / registration / event-specific', 'Needs review', 'Licences, returns, contractor evidence'),
    versions: [{ law: 'Contract Labour (R&A) Act, 1970 / OSH Code transition', authority: 'Labour department', applicability: F('establishment.engages_contract_labour', 'eq', true), due: null,
      notes: 'Labour Codes transition must be validated for the period.' }] }),
  rule({ id: 'POSH', category: 'Labour & Payroll', name: 'POSH annual report', nature: 'return', scope: { type: 'establishment' }, frequency: 'annual',
    reference: ref('Establishment', 'Rule and jurisdiction-specific', 'Needs review', 'HR-owned with accounts evidence'),
    versions: [{ law: 'Sexual Harassment of Women at Workplace Act, 2013', authority: 'District Officer', applicability: F('establishment.headcount', 'gte', 10), due: null }] }),
  rule({ id: 'HR-REGISTERS', category: 'Labour & Payroll', name: 'Bonus / gratuity / wage registers', nature: 'internal', scope: { type: 'establishment' }, frequency: 'annual',
    reference: ref('Establishment', 'Rule and jurisdiction-specific', 'Needs review', 'HR-owned with accounts evidence'),
    versions: [{ law: 'Payment of Bonus / Gratuity / Wages laws — Labour Codes transition', authority: 'Labour department', applicability: null, due: null }] }),

  // ── SEBI / exchange (listed entities only — separate applicability) ─────────
  rule({ id: 'SEBI-FR', category: 'SEBI/Exchange', name: 'Financial results', nature: 'return', scope: company, frequency: 'quarterly', priority: 'high',
    filing: { ack: 'EXCHANGE_REF' }, reference: ref('Listed company', '45 days quarter; 60 days FY baseline', 'Standard reference', 'Applicable listed entity framework'), reference_sources: [SRC.sebi],
    versions: [{ law: 'SEBI (LODR) Regulations, 2015', provision: 'Regulation 33', authority: 'SEBI / stock exchange', applicability: listed,
      due: { type: 'days_after_period_end', days: 45, overrides: [{ quarter: 'Q4', days: 60 }] } }] }),
  rule({ id: 'SEBI-CGR', category: 'SEBI/Exchange', name: 'Corporate governance report', nature: 'return', scope: company, frequency: 'quarterly', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Current regulation-specific', 'Needs review', 'Separate obligations and reporting windows'),
    versions: [{ law: 'SEBI (LODR) Regulations, 2015', provision: 'Regulation 27(2)', authority: 'SEBI / stock exchange', applicability: listed, due: null }] }),
  rule({ id: 'SEBI-SHP', category: 'SEBI/Exchange', name: 'Shareholding pattern', nature: 'return', scope: company, frequency: 'quarterly', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Current regulation-specific', 'Needs review', 'Separate obligations and reporting windows'),
    versions: [{ law: 'SEBI (LODR) Regulations, 2015', provision: 'Regulation 31', authority: 'SEBI / stock exchange', applicability: listed, due: null }] }),
  rule({ id: 'SEBI-RPT', category: 'SEBI/Exchange', name: 'Related party transactions disclosure', nature: 'return', scope: company, frequency: 'half_yearly', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Current regulation-specific', 'Needs review', 'Exchange and SEBI requirements'),
    versions: [{ law: 'SEBI (LODR) Regulations, 2015', provision: 'Regulation 23(9)', authority: 'SEBI / stock exchange', applicability: listed, due: null }] }),
  rule({ id: 'SEBI-AR', category: 'SEBI/Exchange', name: 'Annual report and secretarial compliance report', nature: 'return', scope: company, frequency: 'annual', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Current regulation-specific', 'Needs review', 'Exchange and SEBI requirements'),
    versions: [{ law: 'SEBI (LODR) Regulations, 2015', provision: 'Regulations 34, 24A', authority: 'SEBI / stock exchange', applicability: listed, due: null }] }),
  rule({ id: 'SEBI-PIT', category: 'SEBI/Exchange', name: 'PIT / SDD / trading window', nature: 'internal', scope: company, frequency: 'quarterly',
    reference: ref('Listed company', 'Event and quarter-based', 'Needs review', 'Designated persons and UPSI'),
    versions: [{ law: 'SEBI (PIT) Regulations, 2015', authority: 'SEBI', applicability: listed, due: null }] }),
  rule({ id: 'SEBI-REG30', category: 'SEBI/Exchange', name: 'Material event / UPSI disclosure', nature: 'event', scope: evScope('MATERIAL_EVENT'), frequency: 'event', priority: 'high', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Event-specific hours or days', 'Needs review', 'Reg 29 / 30; capture event time'),
    versions: [{ law: 'SEBI (LODR) Regulations, 2015', provision: 'Regulation 30', authority: 'SEBI / stock exchange', applicability: listed, due: null,
      notes: 'Record the event date AND time. The hours-based window is set per event category once verified (the engine supports hours).' }] }),
  rule({ id: 'SEBI-REG29', category: 'SEBI/Exchange', name: 'Prior intimation of board meeting', nature: 'event', scope: evScope('BOARD_MEETING'), frequency: 'event', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Event-specific hours or days', 'Needs review', 'Reg 29 / 30; capture event time'),
    versions: [{ law: 'SEBI (LODR) Regulations, 2015', provision: 'Regulation 29', authority: 'SEBI / stock exchange', applicability: listed, due: null }] }),
  rule({ id: 'SEBI-IGR', category: 'SEBI/Exchange', name: 'Investor grievances statement', nature: 'return', scope: company, frequency: 'quarterly', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Current filing framework', 'Needs review', 'Exchange and depository obligations'),
    versions: [{ law: 'SEBI (LODR) Regulations, 2015', provision: 'Regulation 13(3)', authority: 'SEBI / stock exchange', applicability: listed, due: null }] }),
  rule({ id: 'SEBI-RSCA', category: 'SEBI/Exchange', name: 'Reconciliation of share capital audit', nature: 'return', scope: company, frequency: 'quarterly', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Current filing framework', 'Needs review', 'Exchange and depository obligations'),
    versions: [{ law: 'SEBI (Depositories and Participants) Regulations, 2018', provision: 'Regulation 76', authority: 'SEBI / stock exchange', applicability: listed, due: null }] }),

  // ── SEBI — listed debt securities (NCDs): separate rules and applicability from equity listing ───
  rule({ id: 'SEBI-D-FR', category: 'SEBI/Exchange', name: 'Financial results — listed NCDs', nature: 'return', scope: company, frequency: 'quarterly', priority: 'high', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', '45 days quarter; 60 days FY baseline', 'Standard reference', 'Applicable listed entity framework'), reference_sources: [SRC.sebi],
    versions: [{ law: NCS, provision: 'Regulation 52', authority: 'SEBI / stock exchange', applicability: debtListed,
      due: { type: 'days_after_period_end', days: 45, overrides: [{ quarter: 'Q4', days: 60 }] }, notes: NCS_NOTE }] }),
  rule({ id: 'SEBI-D-UTIL', category: 'SEBI/Exchange', name: 'Utilisation of issue proceeds / deviation statement — listed NCDs', nature: 'return', scope: company, frequency: 'quarterly', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Current regulation-specific', 'Needs review', 'Listed non-convertible securities'),
    versions: [{ law: NCS, provision: 'Regulation 52(7) / 52(7A)', authority: 'SEBI / stock exchange', applicability: debtListed, due: null, notes: `${NCS_NOTE} Often filed with the financial results — confirm.` }] }),
  rule({ id: 'SEBI-D-SECCOVER', category: 'SEBI/Exchange', name: 'Security cover certificate — listed NCDs', nature: 'return', scope: company, frequency: 'quarterly', filing: { ack: 'EXCHANGE_REF' },
    evidence: { review: ['working'], close: ['certificate', 'acknowledgement'], payment: [] },
    reference: ref('Listed company', 'Current regulation-specific', 'Needs review', 'Secured listed non-convertible securities'),
    versions: [{ law: NCS, provision: 'Regulation 54', authority: 'SEBI / stock exchange / debenture trustee', applicability: ALL(debtListed, F('entity.flags.has_secured_listed_ncds', 'eq', true)), due: null, notes: NCS_NOTE }] }),
  rule({ id: 'SEBI-D-COVENANT', category: 'SEBI/Exchange', name: 'Covenant compliance / debenture trustee reporting — listed NCDs', nature: 'return', scope: company, frequency: 'quarterly',
    evidence: { review: ['working'], close: ['certificate'], payment: [] },
    reference: ref('Listed company', 'Current regulation-specific', 'Needs review', 'Listed non-convertible securities'),
    versions: [{ law: NCS, provision: 'Regulation 56', authority: 'Debenture trustee', applicability: debtListed, due: null, notes: NCS_NOTE }] }),
  rule({ id: 'SEBI-D-SERVICING', category: 'SEBI/Exchange', name: 'Interest / redemption payment intimation — listed NCDs', nature: 'event', scope: evScope('DEBT_SERVICING'), frequency: 'event', priority: 'high', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Event-specific hours or days', 'Needs review', 'Listed non-convertible securities'),
    versions: [{ law: NCS, provision: 'Regulation 57', authority: 'SEBI / stock exchange', applicability: debtListed, due: null, notes: NCS_NOTE }] }),
  rule({ id: 'SEBI-D-REG50', category: 'SEBI/Exchange', name: 'Prior intimation of board meeting — listed NCDs', nature: 'event', scope: evScope('BOARD_MEETING'), frequency: 'event', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Event-specific hours or days', 'Needs review', 'Listed non-convertible securities'),
    versions: [{ law: NCS, provision: 'Regulation 50', authority: 'SEBI / stock exchange', applicability: debtListed, due: null, notes: NCS_NOTE }] }),
  rule({ id: 'SEBI-D-REG51', category: 'SEBI/Exchange', name: 'Material event / price-sensitive information — listed NCDs', nature: 'event', scope: evScope('MATERIAL_EVENT'), frequency: 'event', priority: 'high', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Event-specific hours or days', 'Needs review', 'Listed non-convertible securities'),
    versions: [{ law: NCS, provision: 'Regulation 51', authority: 'SEBI / stock exchange', applicability: debtListed, due: null, notes: `${NCS_NOTE} Record the event date and time.` }] }),
  rule({ id: 'SEBI-D-AR', category: 'SEBI/Exchange', name: 'Annual report — listed NCDs', nature: 'return', scope: company, frequency: 'annual', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Current regulation-specific', 'Needs review', 'Listed non-convertible securities'),
    versions: [{ law: NCS, provision: 'Regulation 53', authority: 'SEBI / stock exchange / debenture trustee', applicability: debtListed, due: null, notes: NCS_NOTE }] }),
  rule({ id: 'SEBI-D-GOV', category: 'SEBI/Exchange', name: 'Corporate governance — high value debt listed entity', nature: 'return', scope: company, frequency: 'quarterly', filing: { ack: 'EXCHANGE_REF' },
    reference: ref('Listed company', 'Current regulation-specific', 'Needs review', 'High value debt listed entity threshold'),
    versions: [{ law: NCS, provision: 'Regulations 15–27 (as applicable to high value debt listed entities)', authority: 'SEBI / stock exchange',
      applicability: ALL(debtListed, F('entity.flags.high_value_debt_listed', 'eq', true)), due: null, notes: `${NCS_NOTE} Applies only above the outstanding listed-debt threshold — record "high value debt listed" on the entity.` }] }),

  // ── FEMA / RBI ──────────────────────────────────────────────────────────────
  rule({ id: 'FEMA-FLA', category: 'FEMA/RBI', name: 'FLA annual return', nature: 'return', scope: anyEntity, frequency: 'annual',
    filing: { ack: 'FIRMS_REF' }, reference: ref('Entity', '15 July', 'Standard reference', 'Outstanding FDI / ODI as at March end'), reference_sources: [SRC.rbi],
    versions: [{ law: 'FEMA, 1999', provision: 'Master Direction — Reporting under FEMA', form: 'FLA return', authority: 'RBI', applicability: ANY(F('entity.flags.has_fdi', 'eq', true), F('entity.flags.has_odi', 'eq', true)), due: afterEnd(7, 15) }] }),
  ...[['FCGPR', 'FC-GPR (shares to a foreign investor)', 'SHARE_ALLOTMENT_FDI'], ['FCTRS', 'FC-TRS (transfer resident ↔ non-resident)', 'SHARE_TRANSFER_FDI'], ['LLP', 'LLP (I) / LLP (II)', 'LLP_FDI']]
    .map(([id, name, ev]) => rule({ id: `FEMA-${id}`, category: 'FEMA/RBI', name, nature: 'event', scope: evScope(ev), frequency: 'event', filing: { ack: 'FIRMS_REF' },
      reference: ref('Transaction', 'Event-based', 'Needs review', 'Investment / transfer / LLP transactions'),
      versions: [{ law: 'FEMA, 1999', provision: 'Master Direction — Reporting under FEMA', form: name.split(' ')[0], authority: 'RBI / AD bank', applicability: TRUE, due: null }] })),
  rule({ id: 'FEMA-ODI-ECB', category: 'FEMA/RBI', name: 'ODI APR / ECB reporting', nature: 'return', scope: anyEntity, frequency: 'annual', filing: { ack: 'FIRMS_REF' },
    reference: ref('Entity / loan', 'Rule and transaction-specific', 'Needs review', 'Foreign investment / borrowing exposure'),
    versions: [{ law: 'FEMA, 1999', authority: 'RBI / AD bank', applicability: ANY(F('entity.flags.has_odi', 'eq', true), F('entity.flags.has_ecb', 'eq', true)), due: null }] }),

  // ── State / other ───────────────────────────────────────────────────────────
  rule({ id: 'ST-STAMP', category: 'State & Licences', name: 'Stamp duty / registration of instrument', nature: 'event', scope: evScope('INSTRUMENT'), frequency: 'event',
    reference: ref('Property / branch', 'State and instrument-specific', 'Needs review', 'Leases / instruments / municipal assessments'),
    versions: [{ law: 'State Stamp Act / Registration Act', authority: 'State', applicability: TRUE, due: null }] }),
  rule({ id: 'ST-PROPTAX', category: 'State & Licences', name: 'Property tax / municipal assessment', nature: 'payment', scope: { type: 'establishment' }, frequency: 'annual',
    reference: ref('Property / branch', 'State and instrument-specific', 'Needs review', 'Leases / instruments / municipal assessments'),
    versions: [{ law: 'Municipal law', authority: 'Local body', applicability: F('establishment.pays_property_tax', 'eq', true), due: null,
      notes: 'Landlord versus operator responsibility decides applicability.' }] }),
  ...[['FIRE', 'Fire NOC renewal', 'FIRE_NOC'], ['TRADE', 'Trade licence renewal', 'TRADE_LICENCE'], ['FSSAI', 'FSSAI licence renewal', 'FSSAI'],
    ['POLLUTION', 'Pollution consent renewal', 'POLLUTION'], ['LICENCE', 'Other licence renewal', 'OTHER_LICENCE']]
    .map(([id, name, reg]) => rule({ id: `ST-${id}`, category: 'State & Licences', name, nature: 'renewal', scope: regScope(reg), frequency: 'renewal',
      reference: ref('Location', 'Certificate expiry / local rules', 'Needs review', 'Landlord versus operator responsibility'),
      versions: [{ law: 'State / local law', authority: 'Licensing authority', applicability: TRUE, due: { type: 'expiry', days_before: 0 }, notes: 'Due on the recorded expiry date of the licence.' }] })),
  rule({ id: 'ST-IEC', category: 'State & Licences', name: 'IEC annual update', nature: 'return', scope: regScope('IEC'), frequency: 'annual',
    reference: ref('Registration', 'Transaction / annual / licence-specific', 'Needs review', 'Imports, exports and SEZ units'),
    versions: [{ law: 'Foreign Trade (D&R) Act, 1992', authority: 'DGFT', applicability: TRUE, due: null }] }),
  rule({ id: 'ST-SEZ', category: 'State & Licences', name: 'SEZ unit returns', nature: 'return', scope: regScope('SEZ_UNIT'), frequency: 'annual',
    reference: ref('Registration', 'Transaction / annual / licence-specific', 'Needs review', 'Imports, exports and SEZ units'),
    versions: [{ law: 'SEZ Act, 2005', authority: 'Development Commissioner', applicability: TRUE, due: null }] }),

  // ── Notices & litigation (exact deadline from the notice / order) ───────────
  rule({ id: 'NOTICE-REPLY', category: 'Notices & Litigation', name: 'Reply to notice / inspection', nature: 'notice', scope: evScope('NOTICE', 'INSPECTION'), frequency: 'event', priority: 'high',
    reference: ref('Case', 'Exact notice / order deadline', 'Needs review', 'All regulators, hearings and appeals'),
    versions: [{ law: 'As stated on the notice', authority: 'Issuing authority', applicability: TRUE, due: { type: 'event_field', field: 'response_due' },
      notes: 'Due = the reply date recorded from the notice itself.' }] }),
  rule({ id: 'NOTICE-HEARING', category: 'Notices & Litigation', name: 'Hearing attendance', nature: 'notice', scope: evScope('HEARING'), frequency: 'event', priority: 'high',
    reference: ref('Case', 'Exact notice / order deadline', 'Needs review', 'All regulators, hearings and appeals'),
    versions: [{ law: 'As stated on the notice', authority: 'Issuing authority', applicability: TRUE, due: { type: 'event_field', field: 'event_date' } }] }),
  rule({ id: 'NOTICE-APPEAL', category: 'Notices & Litigation', name: 'Appeal against order', nature: 'notice', scope: evScope('ORDER'), frequency: 'event', priority: 'high',
    reference: ref('Case', 'Exact notice / order deadline', 'Needs review', 'All regulators, hearings and appeals'),
    versions: [{ law: 'As applicable to the order', authority: 'Appellate authority', applicability: TRUE, due: { type: 'event_field', field: 'response_due' },
      notes: 'Record the appeal deadline (worked out from the order and the applicable law) on the order event.' }] }),

  // ── Internal controls (separate from the statutory completion score) ────────
  rule({ id: 'INT-MSME-AGEING', category: 'Internal Controls', name: 'MSME ageing / payment monitoring', nature: 'internal', scope: anyEntity, frequency: 'monthly',
    reference: ref('Entity', 'Daily; invoice-specific payment limits', 'Internal control', 'Separate statutory payment duty from MCA return'),
    versions: [{ law: 'Internal control (MSMED Act, 2006 s.15 context)', authority: 'Internal', applicability: TRUE, due: { type: 'next_month_day', day: 'last', months_after: 0 },
      notes: 'Internal default: month-end review. Daily monitoring itself happens in the MSME module.' }] }),
  rule({ id: 'INT-COVENANT', category: 'Internal Controls', name: 'Bank covenants / insurance / contract obligations', nature: 'internal', scope: evScope('CONTRACT_OBLIGATION'), frequency: 'event',
    reference: ref('Entity / contract', 'Contract-specific', 'Internal control', 'Separate from statutory completion score'),
    versions: [{ law: 'Contract', authority: 'Counterparty', applicability: TRUE, due: { type: 'event_field', field: 'response_due' } }] }),
];

module.exports = { CATALOGUE_VERSION, CATEGORIES, REG_TYPES, ENTITY_TYPES, EVENT_TYPES, DOC_TYPES, ACK_TYPES, NATURE_EVIDENCE, RULES, entityKind, QRMP_22, QRMP_24 };
