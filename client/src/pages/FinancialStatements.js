import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../utils/api';

// ─── Period definitions (5 periods, configurable) ─────────────────────────────
const PERIODS_DEFAULT = [
  { key: 'c0', label: '30/09/2026', colType: 'Quarter Ended', auditStatus: 'Unaudited', from: '2026-07-01', to: '2026-09-30' },
  { key: 'c1', label: '30/06/2026', colType: 'Quarter Ended', auditStatus: 'Unaudited', from: '2026-04-01', to: '2026-06-30' },
  { key: 'c2', label: '31/03/2026', colType: 'Quarter Ended', auditStatus: 'Audited',   from: '2026-01-01', to: '2026-03-31' },
  { key: 'c3', label: '30/06/2025', colType: 'Quarter Ended', auditStatus: 'Unaudited', from: '2025-04-01', to: '2025-06-30' },
  { key: 'c4', label: '31/03/2026', colType: 'Year Ended',    auditStatus: 'Audited',   from: '2025-04-01', to: '2026-03-31' },
  { key: 'c5', label: '31/03/2025', colType: 'Year Ended',    auditStatus: 'Audited',   from: '2024-04-01', to: '2025-03-31' },
];
const PL_COL_KEYS   = ['c0', 'c1', 'c2', 'c3', 'c4']; // P&L main table columns
const NOTE_COL_KEYS = ['c0', 'c1', 'c4', 'c5'];        // Notes to Accounts columns

const BS_COL_KEYS = ['c4', 'c5'];
const BS_PERIODS  = [
  { key: 'c4', label: '31/03/2026', colType: 'As at', auditStatus: 'Audited' },
  { key: 'c5', label: '31/03/2025', colType: 'As at', auditStatus: 'Audited' },
];

// ─── P&L Line definitions ─────────────────────────────────────────────────────
// type: 'row'|'header'|'spacer'|'subheader'
// inputType: 'note_total'|'manual'|'computed'
const PL_LINES = [
  { id: 'I',        roman: 'I',    label: 'Revenue from operations',                                       noteNum: 27, inputType: 'note_total' },
  { id: 'II',       roman: 'II',   label: 'Other Income',                                                  noteNum: 28, inputType: 'note_total' },
  { id: 'III',      roman: 'III',  label: 'Total Income (I+II)',                        bold: true,         formula: (v) => n(v.I) + n(v.II) },
  { type: 'spacer' },
  { id: 'IVhdr',   type: 'header', roman: 'IV', label: 'Expenses' },
  { id: 'IVa',     roman: '',     label: '(a)  Operating Expenses',                 indent: 1, noteNum: 29, inputType: 'note_total' },
  { id: 'IVb',     roman: '',     label: '(b)  Employee Benefits Expenses',         indent: 1, noteNum: 30, inputType: 'note_total' },
  { id: 'IVc',     roman: '',     label: '(c)   Finance Costs',                     indent: 1, noteNum: 31, inputType: 'note_total' },
  { id: 'IVd',     roman: '',     label: '(d)  Depreciation and amortization expenses', indent: 1, noteNum: 32, inputType: 'note_total' },
  { id: 'IVe',     roman: '',     label: '(e)  Other expenses',                     indent: 1, noteNum: 33, inputType: 'note_total' },
  { id: 'IVtot',   roman: '',     label: 'Total expenses (IV)',                      bold: true, formula: (v) => n(v.IVa)+n(v.IVb)+n(v.IVc)+n(v.IVd)+n(v.IVe) },
  { id: 'V',       roman: 'V',    label: 'Profit before exceptional items and tax (III-IV)', bold: true, formula: (v) => n(v.III) - n(v.IVtot) },
  { id: 'VI',      roman: 'VI',   label: 'Exceptional Items',                                              inputType: 'manual' },
  { id: 'VII',     roman: 'VII',  label: 'Profit Before Tax (V - VI)',               bold: true,           formula: (v) => n(v.V) - n(v.VI) },
  { id: 'VIIIhdr', type: 'header', roman: 'VIII', label: 'Tax expense :' },
  { id: 'VIIIa',  roman: '',     label: 'a) Current Tax',                            indent: 1,            inputType: 'manual' },
  { id: 'VIIIb',  roman: '',     label: 'b) Deferred Tax Liability / (Assets)',      indent: 1,            inputType: 'manual' },
  { id: 'VIIIc',  roman: '',     label: 'c) Adjustment of tax for Earlier Years',   indent: 1,            inputType: 'manual' },
  { id: 'VIIItot',roman: '',     label: 'Total Tax Expenses (VIII)',                 bold: true,           formula: (v) => n(v.VIIIa)+n(v.VIIIb)+n(v.VIIIc) },
  { id: 'IX',     roman: 'IX',   label: 'Profit for the period/year (VII-VIII)',     bold: true,           formula: (v) => n(v.VII) - n(v.VIIItot) },
  { type: 'spacer' },
  { id: 'OCIhdr', type: 'subheader', label: 'Other Comprehensive Income (net of taxes)' },
  { id: 'OCIa',   roman: '',     label: 'Items that will not be reclassified to profit or loss',      indent: 1, inputType: 'manual' },
  { id: 'OCIb',   roman: '',     label: 'Income tax relating to items that will not be reclassified', indent: 1, inputType: 'manual' },
  { id: 'X',      roman: 'X',   label: 'Total Other comprehensive income/(loss) for the period / year', bold: true, formula: (v) => n(v.OCIa)+n(v.OCIb) },
  { id: 'XI',     roman: 'XI',  label: 'Total comprehensive income for the period / year (IX + X)',   bold: true, formula: (v) => n(v.IX)+n(v.X) },
  { id: 'XII',    roman: 'XII', label: 'Paid up equity share capital (face value of Rs. 2 per share)', inputType: 'manual' },
  { id: 'XIII',   roman: 'XIII',label: 'Other equity excluding Revaluation Reserve',                   inputType: 'manual' },
  { id: 'XIVhdr', type: 'header', roman: 'XIV', label: 'Earnings per share (of Rs. 2/- each) (not annualised):' },
  { id: 'XIVb',  roman: '',     label: 'Basic',   indent: 1, inputType: 'manual' },
  { id: 'XIVd',  roman: '',     label: 'Diluted', indent: 1, inputType: 'manual' },
];

// ─── Notes to Accounts definitions ───────────────────────────────────────────
const NOTES_DEF = [
  { num: 27, title: 'Revenue from operations', plKey: 'I', items: [
    { id: 'n1_managed',   label: 'Managed Office Space Services' },
    { id: 'n1_coworking', label: 'Coworking Space Services' },
    { id: 'n1_payroll',   label: 'Payroll Management Service' },
    { id: 'n1_facility',  label: 'Facility Management Charges' },
    { id: 'n1_design',    label: 'Design and Execution Charges' },
    { id: 'n1_it',        label: 'IT Support Services' },
  ]},
  { num: 28, title: 'Other Income', plKey: 'II', items: [
    { id: 'n2_int_loan',   label: 'Interest Income on Unsecured Loan' },
    { id: 'n2_int_fd',     label: 'Interest Income on Fixed Deposit' },
    { id: 'n2_other_int',  label: 'Other Interest Income' },
    { id: 'n2_int_sd',     label: 'Interest Income on unwinding of Security Deposit' },
    { id: 'n2_int_it',     label: 'Interest on IT Refund' },
    { id: 'n2_needle',     label: 'Shares From Neddle & Thread Designs LLP' },
    { id: 'n2_swadesh',    label: 'Share from Swadesh Venture Fund LLP' },
    { id: 'n2_fractoprop', label: 'Shares From Fractoprop LLP' },
    { id: 'n2_lasolas',    label: 'Shares From Las Olas Ventures LLP' },
    { id: 'n2_finclave',   label: 'Share from Finclave Accel LLP' },
    { id: 'n2_profit_ppe', label: 'Profit on Sales of property, plant & equipment' },
    { id: 'n2_profit_inv', label: 'Profit on Sale of Investments' },
    { id: 'n2_forex',      label: 'Foreign Exchange Gain or Loss' },
    { id: 'n2_fairval',    label: 'Gain on fair valuation of Investment' },
    { id: 'n2_writeback',  label: 'Liabilities no longer required written back' },
    { id: 'n2_commission', label: 'Commission Income' },
  ]},
  { num: 29, title: 'Operating Expenses', plKey: 'IVa', items: [
    { id: 'n3_rent',        label: 'Rent Expense' },
    { id: 'n3_cogs',        label: 'Cost of Goods Sold' },
    { id: 'n3_electricity', label: 'Electricity Expense' },
    { id: 'n3_hk',          label: 'Housekeeping, security and support services' },
    { id: 'n3_property',    label: 'Property Maintenance Charges' },
  ]},
  { num: 30, title: 'Employee Benefits Expenses', plKey: 'IVb', items: [
    { id: 'n4_salary',   label: 'Salary Expense' },
    { id: 'n4_pf',       label: 'Contribution to Provident & other Funds' },
    { id: 'n4_gratuity', label: 'Gratuity Expense' },
    { id: 'n4_welfare',  label: 'Staff Welfare Expense' },
  ]},
  { num: 31, title: 'Finance Costs', plKey: 'IVc', items: [
    { id: 'n5_int_borrow',   label: 'Interest on Borrowing' },
    { id: 'n5_other_borrow', label: 'Other borrowing charges' },
    { id: 'n5_bank',         label: 'Bank Charges' },
    { id: 'n5_msme',         label: 'MSME Interest' },
    { id: 'n5_lease',        label: 'Interest on Lease Liability' },
    { id: 'n5_other_int',    label: 'Other Interest Charges' },
  ]},
  { num: 32, title: 'Depreciation and amortization expenses', plKey: 'IVd', items: [
    { id: 'n6_ppe',       label: '  - Property, plant and equipment', subhead: 'Depreciation on:' },
    { id: 'n6_rou',       label: '  - Right-of-use assets' },
    { id: 'n6_intangible',label: '     - Intangible assets',          subhead: 'Amortisation on:' },
  ]},
  { num: 33, title: 'Other expenses', plKey: 'IVe', items: [
    { id: 'n7_insurance',    label: 'Insurance Expense' },
    { id: 'n7_marketing',    label: 'Marketing & Distribution Expense' },
    { id: 'n7_brokerage',    label: 'Brokerage Charges' },
    { id: 'n7_office',       label: 'Office Expenses' },
    { id: 'n7_postage',      label: 'Postage & Telephone Expense' },
    { id: 'n7_printing',     label: 'Printing & Stationery Expense' },
    { id: 'n7_legal',        label: 'Legal & Professional Charges' },
    { id: 'n7_rates',        label: 'Rates & Taxes' },
    { id: 'n7_auditor',      label: 'Auditor Remuneration' },
    { id: 'n7_forex',        label: 'Foreign Exchange Loss (Net)' },
    { id: 'n7_sundry',       label: 'Sundry Balances written off' },
    { id: 'n7_ecl',          label: 'Expected Credit Loss' },
    { id: 'n7_repairs',      label: 'Repairs and Maintenance Expense' },
    { id: 'n7_subscription', label: 'Subscription and Membership Expense' },
    { id: 'n7_stamp',        label: 'Stamp Duty' },
    { id: 'n7_travelling',   label: 'Travelling Charges' },
    { id: 'n7_director',     label: "Director's Sitting Fees" },
    { id: 'n7_donation',     label: 'Donation Expense' },
    { id: 'n7_fairval',      label: 'Gain on fair valuation of Investment' },
    { id: 'n7_swadesh',      label: 'Shares From Swadesh Venture Fund LLP' },
    { id: 'n7_lasolas',      label: 'Shares From Las Olas Ventures LLP' },
    { id: 'n7_needle',       label: 'Shares From Neddle & Thread Designs LLP' },
    { id: 'n7_general',      label: 'General Charges' },
  ]},
  { num: '33.1', title: 'Auditor Remuneration & others', items: [
    { id: 'n33_audit_fee',  label: 'Audit fee' },
    { id: 'n33_ipo',        label: 'IPO related services' },
    { id: 'n33_other_adj',  label: 'Other adjustments*' },
  ], footnote: '* Rs. 7.5 Lakhs paid to auditors in relation to their services related to IPO is forming part of share issue expenses and adjusted from securities premium.' },
  { num: 34, title: 'Earning Per Share', noTotal: true, items: [
    { id: 'n34_profit',         label: 'Profit for the year' },
    { id: 'n34_div_pref',       label: 'Less: Dividend on Preference Shares' },
    { id: 'n34_net_profit',     label: 'Net Profit attributable to Equity Shareholders' },
    { id: 'n34_wtd_avg_shares', label: 'Weighted Average number of Equity Shares (Nos.)', unit: 'nos' },
    { id: 'n34_shares_basic',   label: 'Number of Equity Shares for Basic EPS (Nos.)', unit: 'nos' },
    { id: 'n34_shares_diluted', label: 'Number of Equity Shares for Diluted EPS (Nos.)', unit: 'nos' },
    { id: 'n34_nominal_val',    label: 'Nominal Value Per Share (Rs.)', unit: 'rs2' },
    { id: 'n34_basic_eps',      label: 'Basic Earning Per Share (Rs.)', unit: 'rs4' },
    { id: 'n34_diluted_eps',    label: 'Diluted Earning Per Share (Rs.)', unit: 'rs4' },
  ] },
  { num: 35, title: 'Corporate Social Responsibility (CSR)', textOnly: true, items: [],
    text: 'The Company has earned a net profit during the immediately preceding financial year. However, the Company does not meet any of the thresholds prescribed under Section 135(1) of the Companies Act, 2013. Accordingly, the provisions relating to Corporate Social Responsibility (CSR) under Section 135 of the Act are not applicable to the Company and, consequently, there was no amount required to be spent by the Company on CSR activities during the current financial year.' },
];

// ─── Balance Sheet Note definitions ──────────────────────────────────────────
const BS_NOTES_DEF = [
  { num: 4, title: 'Non-Current Investments', items: [
    { id: 'bs4_icici_mf',        label: 'ICICI Prudential Mutual Fund',              subhead: 'FVTPL — Mutual Funds (Quoted):' },
    { id: 'bs4_saas',            label: 'Saasjoy Solutions Pvt Ltd',                  subhead: 'Equity — Subsidiary (at cost):' },
    { id: 'bs4_eezily',          label: 'Eezily Network Pvt Ltd',                     subhead: 'Equity — Associate (at cost):' },
    { id: 'bs4_janak',           label: 'Janak Urja Pvt Ltd' },
    { id: 'bs4_redicine',        label: 'Redicine Medsol Pvt Ltd',                    subhead: 'Equity — Others (FVTPL):' },
    { id: 'bs4_redicine_prov',   label: 'Less: Provision for Diminution' },
    { id: 'bs4_indiesemic',      label: 'Indiesemic Pvt Ltd' },
    { id: 'bs4_natureovedic',    label: 'Natureovedic Consumers Pvt Ltd' },
    { id: 'bs4_scaleax',         label: 'Scaleax Advisory Pvt Ltd' },
    { id: 'bs4_intents',         label: 'Intents Mobi Pvt Ltd (CCD)',                 subhead: 'Compulsorily Convertible Debentures (at cost):' },
    { id: 'bs4_growfitter',      label: 'Growfitter Pvt Ltd (CCPS)',                  subhead: 'Compulsorily Convertible Preference Shares (FVTPL):' },
    { id: 'bs4_growfitter_prov', label: 'Less: Provision for Diminution' },
    { id: 'bs4_needle_llp',      label: 'Needle & Thread Design LLP (Subsidiary)',    subhead: 'Investment in LLP Firms:' },
    { id: 'bs4_finclave_llp',    label: 'Finclave Accel LLP (Associate)' },
    { id: 'bs4_swadesh_llp',     label: 'Swadesh Venture Fund LLP (Associate)' },
    { id: 'bs4_lasolas_llp',     label: 'Las Olas Ventures LLP' },
    { id: 'bs4_fractoprop_llp',  label: 'Fractoprop LLP' },
  ], footnote: '4.1 Company incorporated Eezily Network Pvt Ltd on November 6, 2025.  4.2 Provision for diminution: ₹13.09L in Redicine Medsol and ₹21.47L in Growfitter Pvt Ltd.  4.3 Company sold its stake in Fractoprop LLP (May 2025) and diluted its stake in Scaleax Advisory Pvt Ltd (February 2026).' },
  { num: 5, title: 'Loans (Non-current)', items: [
    { id: 'bs5_rp_loans',  label: 'Loans to Related Parties', subhead: 'Unsecured, Considered Good:' },
    { id: 'bs5_emp_loans', label: 'Loans to Employees' },
  ] },
  { num: 6, title: 'Other Financial Assets (Non-current)', items: [
    { id: 'bs6_fd',          label: 'Bank Deposits (>12 months maturity)' },
    { id: 'bs6_sd_good',     label: 'Security Deposit — Considered Good', subhead: 'Security Deposits:' },
    { id: 'bs6_sd_impaired', label: 'Security Deposit — Credit Impaired' },
    { id: 'bs6_sd_ecl',      label: 'Less: Allowance for Credit Loss' },
  ] },
  { num: 7, title: 'Deferred Tax Assets (Net)', items: [
    { id: 'bs7_ppe',   label: 'Depreciation differences — Property, Plant & Equipment' },
    { id: 'bs7_other', label: 'Other timing differences' },
  ] },
  { num: 8, title: 'Other Non-current Assets', items: [
    { id: 'bs8_cap_adv', label: 'Capital Advances', subhead: 'Unsecured, Considered Good:' },
    { id: 'bs8_prepaid', label: 'Prepaid Lease Rent' },
  ] },
  { num: 9, title: 'Investments (Current)', items: [
    { id: 'bs9_icici_mf', label: 'ICICI Prudential Mutual Fund (FVTPL)', subhead: 'Mutual Funds — Quoted:' },
  ] },
  { num: 10, title: 'Trade Receivables (Current)', items: [
    { id: 'bs10_tr',       label: 'Trade Receivables', subhead: 'Unsecured:' },
    { id: 'bs10_impaired', label: 'Credit Impaired' },
    { id: 'bs10_ecl',      label: 'Less: Allowance for Credit Loss' },
  ] },
  { num: 11, title: 'Cash and Cash Equivalents', items: [
    { id: 'bs11_curr_acct', label: 'Balances in current account', subhead: 'Balances with banks:' },
    { id: 'bs11_escrow',    label: 'Balances in escrow account' },
    { id: 'bs11_cash',      label: 'Cash on hand' },
    { id: 'bs11_cheques',   label: 'Cheques on hand' },
  ], footnote: 'The escrow balance primarily includes restricted bank balances received from specified customers for repayments of monthly instalments of specified bank loans.' },
  { num: 12, title: 'Other Bank Balances', items: [
    { id: 'bs12_fd', label: 'Bank Deposits (>3 months, <12 months maturity)' },
  ], footnote: 'Includes deposits of ₹3,419.89 lakhs placed under lien as security for term loan.' },
  { num: 13, title: 'Loans (Current)', items: [
    { id: 'bs13_rp',     label: 'Loans to Related Parties', subhead: 'Unsecured, Considered Good:' },
    { id: 'bs13_others', label: 'Loans to Others' },
    { id: 'bs13_emp',    label: 'Loans to Employees' },
  ] },
  { num: 14, title: 'Other Financial Assets (Current)', items: [
    { id: 'bs14_int_fd', label: 'Interest accrued on bank deposits' },
  ] },
  { num: 15, title: 'Current Tax Assets (Net)', items: [
    { id: 'bs15_adv_tax', label: 'Advance Tax & TDS Receivable (net of provision)' },
  ] },
  { num: 16, title: 'Other Current Assets', items: [
    { id: 'bs16_adv_sup',    label: 'Advance to Suppliers',             subhead: 'Unsecured, Considered Good:' },
    { id: 'bs16_adv_emp',    label: 'Advance to Employees for Expense' },
    { id: 'bs16_prepaid',    label: 'Pre-Paid Expenses',                subhead: 'Others:' },
    { id: 'bs16_govt',       label: 'Balances with Government Authority' },
    { id: 'bs16_other_recv', label: 'Other Receivables' },
  ] },
  { num: 17, title: 'Share Capital', noTotal: true, items: [
    { id: 'bs17_eq_nos',   label: 'Equity Shares of Rs. 2 each — Nos.',        unit: 'nos', subhead: 'Subscribed and Fully Paid Up:' },
    { id: 'bs17_eq_amt',   label: 'Equity Shares of Rs. 2 each — Amount' },
    { id: 'bs17_pref_nos', label: 'Preference Shares of Rs. 10 each — Nos.',   unit: 'nos' },
    { id: 'bs17_pref_amt', label: 'Preference Shares of Rs. 10 each — Amount' },
  ] },
  { num: 18, title: 'Other Equity', items: [
    { id: 'bs18_sec_prem', label: 'Securities Premium Reserve' },
    { id: 'bs18_retained', label: 'Retained Earnings (Surplus / Deficit)' },
  ] },
  { num: 19, title: 'Borrowings (Non-current)', items: [
    { id: 'bs19_ncd',       label: 'Non-Convertible Debentures',           subhead: 'Secured Loans:' },
    { id: 'bs19_term_bank', label: 'Term Loan from Banks' },
    { id: 'bs19_term_fi',   label: 'Term Loan from Financial Institutions' },
    { id: 'bs19_rp_unsec',  label: 'Loans from Related Parties',           subhead: 'Unsecured Loans:' },
    { id: 'bs19_icd',       label: 'Inter Corporate Deposits' },
    { id: 'bs19_fi_unsec',  label: 'Loans from Financial Institutions' },
  ] },
  { num: 20, title: 'Other Financial Liabilities (Non-current)', items: [
    { id: 'bs20_rent_dep', label: 'Rent Deposits received' },
  ] },
  { num: 21, title: 'Provisions (Non-current)', items: [
    { id: 'bs21_gratuity', label: 'Provision for Gratuity' },
  ] },
  { num: 22, title: 'Borrowings (Current)', items: [
    { id: 'bs22_cc',         label: 'Cash Credit from Banks',                subhead: 'Secured — Working Capital:' },
    { id: 'bs22_ncd',        label: 'Non-Convertible Debentures',            subhead: 'Secured — Term Loans:' },
    { id: 'bs22_term_bank',  label: 'Term Loan from Banks' },
    { id: 'bs22_term_fi',    label: 'Term Loan from Financial Institutions' },
    { id: 'bs22_icd',        label: 'Inter Corporate Deposits',              subhead: 'Unsecured Loans:' },
    { id: 'bs22_rp',         label: 'Loans from Related Parties' },
    { id: 'bs22_icd_others', label: 'Inter Corporate Deposits (Others)' },
    { id: 'bs22_fi_others',  label: 'Loans from Financial Institutions (Others)' },
  ] },
  { num: 23, title: 'Trade Payables', items: [
    { id: 'bs23_msme',   label: 'Dues to Micro and Small Enterprises' },
    { id: 'bs23_others', label: 'Dues to enterprises other than MSME' },
  ] },
  { num: 24, title: 'Other Financial Liabilities (Current)', items: [
    { id: 'bs24_int', label: 'Interest accrued but not due on borrowings' },
  ] },
  { num: 25, title: 'Other Current Liabilities', items: [
    { id: 'bs25_stat',     label: 'Statutory Dues Payable' },
    { id: 'bs25_adv_cust', label: 'Advance from Customers' },
    { id: 'bs25_emp',      label: 'Dues to Employees' },
    { id: 'bs25_def_rev',  label: 'Deferred Revenue' },
  ] },
  { num: 26, title: 'Provisions (Current)', items: [
    { id: 'bs26_gratuity', label: 'Provision for Gratuity' },
    { id: 'bs26_exp',      label: 'Provision for Expenses' },
  ] },
];

// ─── Trial Balance Groupings: note item ID → TB grouping string(s) ─────────────
// 'c4' uses sheet M26, 'c5' uses sheet M25
const TB_ITEM_GROUPINGS = {
  // ── Note 27 – Revenue from operations ────────────────────────────────────
  n1_coworking:      ['Coworking Space Services'],
  n1_payroll:        ['Payroll Management Service'],
  n1_facility:       ['Facility Management Charges'],
  n1_design:         ['Design and Execution Charges'],
  // ── Note 28 – Other Income ────────────────────────────────────────────────
  n2_int_loan:       ['Interest Income on Unsecured Loan'],
  n2_int_fd:         ['Interest Income on Fixed Deposit'],
  n2_other_int:      ['Other Interest Income'],
  n2_int_sd:         ['Interest Income on unwinding of Security Deposit'],
  n2_int_it:         ['Interest on IT Refund'],
  n2_needle:         ['Shares From Neddle & Thread Designs LLP'],
  n2_swadesh:        ['Share from Swadesh Venture Fund LLP', 'Shares From Swadesh Venture Fund LLP'],
  n2_fractoprop:     ['Shares From Fractoprop LLP'],
  n2_lasolas:        ['Shares From Las Olas Ventures LLP'],
  n2_finclave:       ['Share from Finclave Accel LLP', 'Shares From Finclave Accel LLP'],
  n2_profit_ppe:     ['Profit on Sales of property, plant & equipment'],
  n2_profit_inv:     ['Profit on Sale of Investments'],
  n2_forex:          ['Foreign Exchange Loss (Net)', 'Foreign Exchange Gain or Loss'],
  n2_fairval:        ['Gain on fair valuation of Investment'],
  n2_writeback:      ['Liabilities no longer required written back'],
  n2_commission:     ['Commission Income'],
  // ── Note 29 – Operating Expenses ─────────────────────────────────────────
  n3_rent:           ['Rent Expense'],
  n3_cogs:           ['Cost of Goods Sold'],
  n3_electricity:    ['Electricity Expense'],
  n3_hk:             ['Housekeeping, security and support services'],
  n3_property:       ['Property Maintenance Charges'],
  // ── Note 31 – Finance Costs ───────────────────────────────────────────────
  n5_int_borrow:     ['Interest on Borrowing'],
  n5_other_borrow:   ['Other borrowing charges'],
  n5_bank:           ['Bank Charges'],
  n5_msme:           ['MSME Interest'],
  n5_lease:          ['Interest on Lease Liability'],
  n5_other_int:      ['Other Interest Charges'],
  // ── Note 32 – Depreciation ────────────────────────────────────────────────
  n6_ppe:            ['FA'],
  n6_rou:            ['ROU'],
  n6_intangible:     ['Manual', 'manual'],
  // ── Note 33 – Other Expenses ─────────────────────────────────────────────
  n7_insurance:      ['Insurance Expense'],
  n7_marketing:      ['Marketing & Distribution Expense'],
  n7_brokerage:      ['Brokerage Charges'],
  n7_office:         ['Office Expenses'],
  n7_postage:        ['Postage & Telephone Expense'],
  n7_printing:       ['Printing & Stationery Expense'],
  n7_legal:          ['Legal & Professional Charges'],
  n7_rates:          ['Rates & Taxes'],
  n7_auditor:        ['Auditor Remuneration'],
  n7_forex:          ['Foreign Exchange Loss (Net)', 'Foreign Exchange Gain or Loss'],
  n7_sundry:         ['Sundry Balances written off'],
  n7_ecl:            ['Expected Credit loss'],
  n7_repairs:        ['Repairs and Maintenance Expense'],
  n7_subscription:   ['Subscription and Membership Expense'],
  n7_stamp:          ['Stamp Duty'],
  n7_travelling:     ['Travelling Charges'],
  n7_director:       ["Director's Sitting Fees"],
  n7_donation:       ['Donation Expense'],
  n7_fairval:        ['Gain on fair valuation of Investment', 'Loss on fair valuation of Investment'],
  n7_swadesh:        ['Share from Swadesh Venture Fund LLP', 'Shares From Swadesh Venture Fund LLP'],
  n7_lasolas:        ['Shares From Las Olas Ventures LLP'],
  n7_needle:         ['Shares From Neddle & Thread Designs LLP'],
  n7_general:        ['General Charges'],
  // ── Note 33.1 – Auditor Remuneration ─────────────────────────────────────
  n33_audit_fee:     ['Auditor Remuneration'],
  // ── BS Note 4 – Non-Current Investments ──────────────────────────────────
  bs4_icici_mf:        ['ICICI Prudential Mutual Fund'],
  bs4_saas:            ['Saasjoy Solutions Private Limited'],
  bs4_eezily:          ['Eezily Network Private Limited (refer note 4.1)'],
  bs4_janak:           ['Janak Urja Pvt. Ltd'],
  bs4_redicine:        ['Redicine Medsol Private Limited (refer note 4.2)'],
  bs4_indiesemic:      ['Indiesemic Private Limited'],
  bs4_natureovedic:    ['Natureovedic Consumers Private Limited'],
  bs4_scaleax:         ['Scaleax Advisory Private Limited (refer note 4.1)'],
  bs4_intents:         ['Intents Mobi Private Limited'],
  bs4_growfitter:      ['Growfitter Private Limited (refer note 4.2)'],
  bs4_needle_llp:      ['Neddle & Thread Design LLP'],
  bs4_finclave_llp:    ['Finclave Accel LLP'],
  bs4_swadesh_llp:     ['Swadesh Venture Fund LLP'],
  bs4_lasolas_llp:     ['Las Olas Ventures LLP'],
  bs4_fractoprop_llp:  ['Fractoprop LLP (refer note 4.3)'],
  // ── BS Note 5 – Loans NC ──────────────────────────────────────────────────
  bs5_rp_loans:        ['Loans to Related parties*'],
  bs5_emp_loans:       ['Loans to Employees'],
  // ── BS Note 6 – Other Financial Assets NC ────────────────────────────────
  bs6_fd:              ['Fixed Deposit'],
  bs6_sd_good:         ['Considered Good'],
  // ── BS Note 7 – Deferred Tax Assets ──────────────────────────────────────
  bs7_ppe:             ['Total*DTA'],
  bs7_other:           ['Total*DTA'],
  // ── BS Note 8 – Other NC Assets ──────────────────────────────────────────
  bs8_prepaid:         ['Prepaid Lease Rent'],
  // ── BS Note 9 – Current Investments ──────────────────────────────────────
  bs9_icici_mf:        ['ICICI Prudential Mutual Fund'],
  // ── BS Note 10 – Trade Receivables ───────────────────────────────────────
  bs10_tr:             ['Trade Receivables'],
  bs10_impaired:       ['Trade Receivables'],
  bs10_ecl:            ['Less : Allowance for Credit Loss'],
  // ── BS Note 11 – Cash & Equivalents ──────────────────────────────────────
  bs11_curr_acct:      ['- in current account'],
  bs11_escrow:         ['- in escrow account (refer note 11.1)'],
  bs11_cash:           ['Cash on hand'],
  bs11_cheques:        ['Cheques on hand'],
  // ── BS Note 12 – Other Bank Balances ─────────────────────────────────────
  bs12_fd:             ['Considered Good'],
  // ── BS Note 13 – Loans Current ───────────────────────────────────────────
  bs13_rp:             ['Loans to Related parties*'],
  bs13_others:         ['Loans to Others'],
  bs13_emp:            ['Loans to Employees'],
  // ── BS Note 14 – Other Financial Assets Current ───────────────────────────
  bs14_int_fd:         ['Interest accrued on bank deposit'],
  // ── BS Note 15 – Current Tax Assets ──────────────────────────────────────
  bs15_adv_tax:        ['Advance Tax & TDS Receivable (net of current tax provision)'],
  // ── BS Note 16 – Other Current Assets ────────────────────────────────────
  bs16_adv_sup:        ['Advance to Suppliers', 'Advance Payment to Employees'],
  bs16_adv_emp:        ['Advance to Employees for expense'],
  bs16_prepaid:        ['Pre-Paid Expenses'],
  bs16_govt:           ['Balances with Government Authority'],
  bs16_other_recv:     ['Other Receivables'],
  // ── BS Note 17 – Share Capital ────────────────────────────────────────────
  bs17_eq_nos:         ['Equity'],
  bs17_eq_amt:         ['Equity'],
  bs17_pref_nos:       ['Equity'],
  bs17_pref_amt:       ['Equity'],
  // ── BS Note 18 – Other Equity ─────────────────────────────────────────────
  bs18_sec_prem:       ['Balance at the end of the Year'],
  bs18_retained:       ['R/E'],
  // ── BS Note 19 – Borrowings NC ───────────────────────────────────────────
  bs19_ncd:            ['-Non Convertible Debentures (NCD)'],
  bs19_term_bank:      ['-  From Bank'],
  bs19_term_fi:        ['-  From Financial Instituition'],
  bs19_rp_unsec:       ['(a) From Related Parties'],
  bs19_icd:            ['Inter corporate Deposits'],
  bs19_fi_unsec:       ['From Non Banking Financial Institutions'],
  // ── BS Note 20 – Other Financial Liabilities NC ──────────────────────────
  bs20_rent_dep:       ['Rent Deposit'],
  // ── BS Note 21 – Provisions NC ───────────────────────────────────────────
  bs21_gratuity:       ['Provision for Gratuity'],
  // ── BS Note 22 – Borrowings Current ──────────────────────────────────────
  bs22_cc:             ['(a) Cash Credit facility from Banks'],
  bs22_ncd:            ['-Non Convertible Debentures (NCD)'],
  bs22_term_bank:      ['-  From Bank'],
  bs22_term_fi:        ['-  From Financial Instituition'],
  bs22_icd:            ['Inter corporate Deposits'],
  bs22_rp:             ['(a) From Related Parties'],
  bs22_icd_others:     ['Inter corporate Deposits'],
  bs22_fi_others:      ['From Non Banking Financial Institutions'],
  // ── BS Note 23 – Trade Payables ──────────────────────────────────────────
  bs23_others:         ['Dues of other than micro enterprises and small enterprises'],
  // ── BS Note 24 – Other Financial Liabilities Current ─────────────────────
  bs24_int:            ['Interest accrued but not due on borrowings'],
  // ── BS Note 25 – Other Current Liabilities ───────────────────────────────
  bs25_stat:           ['Statutory Dues'],
  bs25_adv_cust:       ['Advance from customer'],
  bs25_emp:            ['Dues to employees'],
  bs25_def_rev:        ['Deferred Revenue'],
  // ── BS Note 26 – Provisions Current ──────────────────────────────────────
  bs26_gratuity:       ['Provision for Gratuity'],
  bs26_exp:            ['Provision for Expenses'],
  // ── P&L Employee Benefits (Note 4 in notes but mapped separately) ─────────
  n4_salary:           ['Salary Expense'],
  n4_pf:               ['Contribution to Provident & other Funds'],
  n4_gratuity:         ['Gratuity Expense'],
  n4_welfare:          ['Staff Welfare Expense'],
  n4_oci_gratuity:     ['Gratuity Expense OCI'],
  // ── BS Main Lines — FA schedule / Lease (no sub-note, use TB directly) ────
  bs_ppe:              ['FA'],
  bs_cwip:             ['CWIP'],
  bs_rou:              ['ROU'],
  bs_intangible:       ['Manual', 'manual'],
  bs_intang_dev:       ['Manual', 'manual'],
  bs_nc_lease:         ['Lease liab'],
  bs_c_lease:          ['Lease liab'],
};

// Period key → TB sheet
const TB_PERIOD_SHEET = { c4: 'M26', c5: 'M25' };

// ── BS Main Line → Note number (in BS_NOTES_DEF) ─────────────────────────────
const BS_LINE_NOTE_MAP = {
  bs_nc_invest:    4,  bs_nc_loans:    5,  bs_nc_ofa:      6,
  bs_dta:          7,  bs_nc_other:    8,  bs_c_invest:    9,
  bs_tr:          10,  bs_cash:       11,  bs_obank:      12,
  bs_c_loans:     13,  bs_c_ofa:      14,  bs_cta:        15,
  bs_c_other:     16,  bs_share_cap:  17,  bs_other_equity:18,
  bs_nc_borrow:   19,  bs_nc_ofl:     20,  bs_nc_prov:    21,
  bs_c_borrow:    22,  bs_tp_msme:    23,  bs_tp_others:  23,
  bs_c_ofl:       24,  bs_c_other_liab:25, bs_c_prov:     26,
};

// Build a flat list of all mappable item ids
const ALL_MAPPABLE_IDS = [
  ...NOTES_DEF.flatMap(n => n.items.map(i => i.id)),
  'VI', 'VIIIa', 'VIIIb', 'VIIIc', 'OCIa', 'OCIb', 'XII', 'XIII', 'XIVb', 'XIVd',
];

// Expense-type item IDs: Zoho returns (credit − debit) which is negative for expenses.
// We negate them so they are stored/displayed as positive costs in the statement.
const EXPENSE_ITEM_IDS = new Set([
  ...NOTES_DEF.filter(nd => nd.num >= 29 && nd.num <= 33).flatMap(nd => nd.items.map(i => i.id)),
  'VIIIa', 'VIIIb', 'VIIIc',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function n(x) { return parseFloat(x) || 0; }

function fmtPL(val) {
  if (val === null || val === undefined || val === '') return '';
  const num = parseFloat(val);
  if (isNaN(num)) return '';
  const abs = Math.abs(num);
  const str = abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num < 0 ? `(${str})` : str;
}

function fmtNoteVal(val, unit) {
  if (val === null || val === undefined || val === '') return '';
  const num = parseFloat(val);
  if (isNaN(num)) return '';
  if (unit === 'nos') return Math.round(num).toLocaleString('en-IN');
  if (unit === 'rs2') return num.toFixed(2);
  if (unit === 'rs4') return num.toFixed(4);
  return fmtPL(num);
}

function computeAll(raw) {
  const v = { ...raw };
  // Note totals → feed into P&L note_total rows
  NOTES_DEF.forEach(nd => {
    const hasAny = nd.items.some(it => v[it.id] != null && v[it.id] !== '');
    if (hasAny) {
      const total = nd.items.reduce((s, it) => s + n(v[it.id]), 0);
      v[nd.plKey] = total;
    }
  });
  // Computed P&L rows
  PL_LINES.forEach(row => {
    if (row.formula && row.id) v[row.id] = row.formula(v);
  });
  return v;
}

const S = {
  page: { padding: '24px 28px', background: '#F9F9F9', minHeight: '100vh', color: '#18191B', fontFamily: "'Figtree', system-ui, sans-serif" },
  h1:   { fontSize: '1.3rem', fontWeight: 700, color: '#18191B', margin: 0 },
  tabs: { display: 'flex', gap: 4, background: '#F9F9F9', borderRadius: 8, padding: 4, marginBottom: 20, width: 'fit-content' },
  tab:  (active) => ({ padding: '7px 18px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
    background: active ? '#1C4942' : 'transparent', color: active ? '#fff' : '#9BA8B0', transition: 'all 0.15s' }),
  card: { background: '#FFFFFF', borderRadius: 10, padding: 20, marginBottom: 20, overflow: 'auto' },
  btn:  (variant='primary', sm) => ({
    padding: sm ? '5px 12px' : '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
    fontSize: sm ? '0.75rem' : '0.82rem', fontWeight: 600, transition: 'all 0.15s',
    background: variant === 'primary' ? '#1C4942' : variant === 'success' ? '#15803D' : variant === 'danger' ? '#DC2626' : '#DFE7E3',
    color: variant === 'secondary' ? '#18191B' : '#fff',
  }),
  input: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 4, color: '#18191B', padding: '3px 6px', fontSize: '0.8rem', width: '100%', textAlign: 'right' },
};

// ─── Period Config Modal ───────────────────────────────────────────────────────
function PeriodModal({ periods, onSave, onClose }) {
  const [local, setLocal] = useState(periods.map(p => ({ ...p })));
  const upd = (i, field, val) => setLocal(prev => prev.map((p, idx) => idx === i ? { ...p, [field]: val } : p));
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: '#FFFFFF', borderRadius: 12, padding: 24, width: 680, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontWeight: 700, color: '#18191B' }}>Configure Periods</span>
          <button onClick={onClose} style={{ ...S.btn('secondary', true) }}>Close</button>
        </div>
        <div style={{ fontSize: '0.75rem', color: '#5D6C7B', marginBottom: 12 }}>
          P&L Statement uses periods 1–4. Notes to Accounts uses periods 1, 4, 5.
        </div>
        {local.map((p, i) => (
          <div key={p.key} style={{ background: '#F9F9F9', borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ background: '#1C4942', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: '0.7rem', fontWeight: 700 }}>Period {i + 1}</span>
              <select value={p.colType} onChange={e => upd(i, 'colType', e.target.value)} style={{ ...S.input, width: 140 }}>
                <option>Quarter Ended</option>
                <option>Year Ended</option>
              </select>
              <select value={p.auditStatus} onChange={e => upd(i, 'auditStatus', e.target.value)} style={{ ...S.input, width: 100 }}>
                <option>Unaudited</option>
                <option>Audited</option>
              </select>
              <input value={p.label} onChange={e => upd(i, 'label', e.target.value)} placeholder="Label (e.g. 30/06/2026)" style={{ ...S.input, width: 110, textAlign: 'left' }} />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: '#5D6C7B', fontSize: '0.75rem', width: 36 }}>From</span>
              <input type="date" value={p.from} onChange={e => upd(i, 'from', e.target.value)} style={{ ...S.input, width: 140, textAlign: 'left' }} />
              <span style={{ color: '#5D6C7B', fontSize: '0.75rem', width: 16 }}>To</span>
              <input type="date" value={p.to} onChange={e => upd(i, 'to', e.target.value)} style={{ ...S.input, width: 140, textAlign: 'left' }} />
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={S.btn('secondary')}>Cancel</button>
          <button onClick={() => onSave(local)} style={S.btn('primary')}>Save Periods</button>
        </div>
      </div>
    </div>
  );
}

// ─── Mapping Modal ────────────────────────────────────────────────────────────
function MappingModal({ itemId, itemLabel, coa, currentIds, onSave, onClose }) {
  const [selected, setSelected] = useState(new Set(currentIds || []));
  const [search, setSearch]     = useState('');
  const filtered = coa.filter(a =>
    (a.account_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (a.account_code || '').toLowerCase().includes(search.toLowerCase()) ||
    (a.account_type || '').toLowerCase().includes(search.toLowerCase())
  );
  const toggle = (id) => setSelected(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: '#FFFFFF', borderRadius: 12, padding: 24, width: 680, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: '#18191B', fontSize: '0.95rem', marginBottom: 4 }}>Map Accounts — {itemLabel}</div>
          <div style={{ fontSize: '0.75rem', color: '#5D6C7B' }}>Select one or more Zoho chart of accounts to sum for this line item.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search accounts…"
            style={{ flex: 1, ...S.input, textAlign: 'left', padding: '6px 10px' }} />
          <span style={{ color: '#5D6C7B', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{selected.size} selected</span>
          {selected.size > 0 && <button onClick={() => setSelected(new Set())} style={S.btn('danger', true)}>Clear</button>}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #DFE7E3', borderRadius: 6 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#5D6C7B' }}>No accounts found</div>
          ) : filtered.map(acct => (
            <label key={acct.account_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer',
              background: selected.has(acct.account_id) ? '#EAF4EF' : 'transparent',
              borderBottom: '1px solid #DFE7E3', transition: 'background 0.1s' }}>
              <input type="checkbox" checked={selected.has(acct.account_id)} onChange={() => toggle(acct.account_id)} style={{ accentColor: '#1C4942' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.82rem', color: '#18191B', fontWeight: selected.has(acct.account_id) ? 600 : 400 }}>{acct.account_name}</div>
                <div style={{ fontSize: '0.7rem', color: '#5D6C7B' }}>{acct.account_type}{acct.account_code ? ` · ${acct.account_code}` : ''}{acct.parent_account_name ? ` · ${acct.parent_account_name}` : ''}</div>
              </div>
              {!acct.is_active && <span style={{ fontSize: '0.65rem', color: '#B45309', background: '#FFFBEB', padding: '1px 6px', borderRadius: 3 }}>Inactive</span>}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={S.btn('secondary')}>Cancel</button>
          <button onClick={() => onSave(itemId, [...selected])} style={S.btn('primary')}>Save Mapping</button>
        </div>
      </div>
    </div>
  );
}

// ─── P&L Table ────────────────────────────────────────────────────────────────
function PLTable({ periods, values, editMode, onValueChange }) {
  const plPeriods = PL_COL_KEYS.map(k => periods.find(p => p.key === k)).filter(Boolean);
  const computed  = useMemo(() => computeAll(values), [values]);

  const CellVal = ({ lineId, periodKey, formula, noteNum }) => {
    const isComputed = !!formula || (noteNum != null);
    const raw = computed[lineId]?.[periodKey];
    const val = raw;

    if (isComputed) {
      return <td style={{ padding: '4px 10px', textAlign: 'right', fontSize: '0.82rem', color: '#9BA8B0', background: '#F9F9F9', whiteSpace: 'nowrap' }}>{fmtPL(val)}</td>;
    }
    if (!editMode) {
      return <td style={{ padding: '4px 10px', textAlign: 'right', fontSize: '0.82rem', color: '#18191B', whiteSpace: 'nowrap' }}>{fmtPL(val)}</td>;
    }
    const cellVal = values[lineId]?.[periodKey] ?? '';
    return (
      <td style={{ padding: '2px 6px', textAlign: 'right' }}>
        <input type="number" value={cellVal} onChange={e => onValueChange(lineId, periodKey, e.target.value)}
          style={{ ...S.input, width: 110 }} placeholder="0.00" />
      </td>
    );
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ background: '#EAF4EF' }}>
            <th style={{ width: 40, padding: '8px 10px', color: '#9BA8B0', fontWeight: 600, textAlign: 'left', fontSize: '0.72rem' }}>Sr.</th>
            <th style={{ padding: '8px 10px', color: '#18191B', fontWeight: 700, textAlign: 'left' }}>Particulars</th>
            <th style={{ padding: '8px 6px', color: '#9BA8B0', fontWeight: 600, textAlign: 'right', fontSize: '0.7rem', width: 50 }}>Note No.</th>
            {plPeriods.map(p => (
              <th key={p.key} style={{ padding: '4px 10px', color: '#18191B', fontWeight: 700, textAlign: 'right', minWidth: 130 }}>
                <div style={{ fontSize: '0.65rem', color: '#5D6C7B', fontWeight: 400, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{p.colType}</div>
                <div>{p.label}</div>
                <div style={{ fontSize: '0.65rem', color: '#9BA8B0', fontWeight: 400 }}>({p.auditStatus})</div>
                <div style={{ fontSize: '0.65rem', color: '#5D6C7B', fontWeight: 400 }}>₹ in Lakhs</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PL_LINES.map((row, idx) => {
            if (row.type === 'spacer') return <tr key={idx}><td colSpan={3 + plPeriods.length} style={{ height: 8 }} /></tr>;
            if (row.type === 'header') return (
              <tr key={idx} style={{ background: '#F9F9F9' }}>
                <td style={{ padding: '6px 10px', color: '#9BA8B0', fontSize: '0.78rem', fontWeight: 600 }}>{row.roman}</td>
                <td colSpan={2 + plPeriods.length} style={{ padding: '6px 10px', color: '#18191B', fontWeight: 700 }}>{row.label}</td>
              </tr>
            );
            if (row.type === 'subheader') return (
              <tr key={idx} style={{ background: '#F9F9F9' }}>
                <td style={{ padding: '6px 10px' }} />
                <td colSpan={2 + plPeriods.length} style={{ padding: '6px 10px', color: '#9BA8B0', fontStyle: 'italic', fontSize: '0.8rem' }}>{row.label}</td>
              </tr>
            );
            const isComputed = !!row.formula;
            const isNoteTot  = row.inputType === 'note_total';
            return (
              <tr key={row.id} style={{ borderBottom: '1px solid #DFE7E3', background: (isComputed || isNoteTot) ? '#F9F9F9' : 'transparent' }}>
                <td style={{ padding: '4px 10px', color: '#5D6C7B', fontSize: '0.78rem', verticalAlign: 'middle' }}>{row.roman}</td>
                <td style={{ padding: '4px 10px', color: row.bold ? '#18191B' : '#18191B', fontWeight: row.bold ? 700 : 400, paddingLeft: row.indent ? 30 : 10, verticalAlign: 'middle' }}>
                  {row.label}
                </td>
                <td style={{ padding: '4px 6px', color: '#1C4942', textAlign: 'right', fontSize: '0.75rem', verticalAlign: 'middle' }}>
                  {row.noteNum ? row.noteNum : ''}
                </td>
                {plPeriods.map(p => {
                  const rawVal = computed[row.id + '__' + p.key] ?? (() => {
                    // compute row value per period
                    const perPeriodVals = {};
                    ALL_MAPPABLE_IDS.forEach(mid => { perPeriodVals[mid] = values[mid]?.[p.key]; });
                    // note totals
                    NOTES_DEF.forEach(nd => {
                      const hasAny = nd.items.some(it => perPeriodVals[it.id] != null && perPeriodVals[it.id] !== '');
                      if (hasAny) perPeriodVals[nd.plKey] = nd.items.reduce((s, it) => s + n(perPeriodVals[it.id]), 0);
                      else perPeriodVals[nd.plKey] = values[nd.plKey]?.[p.key];
                    });
                    PL_LINES.forEach(r => { if (r.formula && r.id) perPeriodVals[r.id] = r.formula(perPeriodVals); });
                    if (isComputed || isNoteTot) return perPeriodVals[row.id];
                    return values[row.id]?.[p.key];
                  })();

                  if (isComputed || isNoteTot) {
                    // compute per-period on the fly
                    const perPeriodVals = {};
                    ALL_MAPPABLE_IDS.forEach(mid => { perPeriodVals[mid] = values[mid]?.[p.key]; });
                    NOTES_DEF.forEach(nd => {
                      const hasAny = nd.items.some(it => perPeriodVals[it.id] != null && perPeriodVals[it.id] !== '');
                      if (hasAny) perPeriodVals[nd.plKey] = nd.items.reduce((s, it) => s + n(perPeriodVals[it.id]), 0);
                      else perPeriodVals[nd.plKey] = n(values[nd.plKey]?.[p.key]);
                    });
                    PL_LINES.forEach(r => { if (r.formula && r.id) perPeriodVals[r.id] = r.formula(perPeriodVals); });
                    const cellVal = perPeriodVals[row.id];
                    return (
                      <td key={p.key} style={{ padding: '4px 10px', textAlign: 'right', color: row.bold ? '#18191B' : '#9BA8B0', fontWeight: row.bold ? 700 : 400, whiteSpace: 'nowrap', background: '#F9F9F9' }}>
                        {fmtPL(cellVal)}
                      </td>
                    );
                  }
                  // manual input
                  const cellVal = values[row.id]?.[p.key] ?? '';
                  if (!editMode) return <td key={p.key} style={{ padding: '4px 10px', textAlign: 'right', color: '#18191B', whiteSpace: 'nowrap' }}>{fmtPL(cellVal)}</td>;
                  return (
                    <td key={p.key} style={{ padding: '2px 6px', textAlign: 'right' }}>
                      <input type="number" value={cellVal} onChange={e => onValueChange(row.id, p.key, e.target.value)}
                        style={{ ...S.input, width: 110 }} placeholder="0.00" step="0.01" />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── TB Drill-down Modal ──────────────────────────────────────────────────────
function TbDrillModal({ itemId, itemLabel, periodKey, periodLabel, onClose }) {
  const [rows, setRows]       = useState(null);
  const [error, setError]     = useState('');
  const groupings = TB_ITEM_GROUPINGS[itemId] || [];
  const sheet     = TB_PERIOD_SHEET[periodKey];

  useEffect(() => {
    if (!sheet || !groupings.length) { setRows([]); return; }
    api.finTbDrill(sheet, groupings)
      .then(r => setRows(r))
      .catch(() => setError('Failed to load TB data'));
  }, [itemId, periodKey]); // eslint-disable-line

  const total = rows ? rows.reduce((s, r) => s + r.lakhs, 0) : 0;

  const overlay = {
    position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
  };
  const box = {
    background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 10,
    maxWidth: 720, width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
  };
  const hdr = {
    padding: '14px 18px', borderBottom: '1px solid #DFE7E3', display: 'flex',
    alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
  };
  const body = { overflowY: 'auto', flex: 1 };
  const ftr  = { padding: '10px 18px', borderTop: '1px solid #DFE7E3', display: 'flex', justifyContent: 'space-between', alignItems: 'center' };

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={box}>
        <div style={hdr}>
          <div>
            <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.9rem' }}>{itemLabel}</div>
            <div style={{ color: '#9BA8B0', fontSize: '0.75rem', marginTop: 2 }}>
              Trial Balance drill-down · {sheet ? `TB ${sheet}` : '—'} · {periodLabel}
              {groupings.length > 0 && (
                <span style={{ marginLeft: 8, color: '#5D6C7B' }}>
                  [{groupings.join(', ')}]
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1, padding: 2 }}>✕</button>
        </div>
        <div style={body}>
          {!sheet && (
            <div style={{ padding: 24, color: '#9BA8B0', textAlign: 'center', fontSize: '0.8rem' }}>
              TB drill-down is only available for Year Ended columns (c4 / c5).
            </div>
          )}
          {sheet && !groupings.length && (
            <div style={{ padding: 24, color: '#9BA8B0', textAlign: 'center', fontSize: '0.8rem' }}>
              No TB grouping mapping defined for this item.
            </div>
          )}
          {error && <div style={{ padding: 24, color: '#DC2626', textAlign: 'center' }}>{error}</div>}
          {rows === null && sheet && groupings.length > 0 && (
            <div style={{ padding: 24, color: '#5D6C7B', textAlign: 'center', fontSize: '0.8rem' }}>Loading…</div>
          )}
          {rows && rows.length === 0 && sheet && groupings.length > 0 && (
            <div style={{ padding: 24, color: '#9BA8B0', textAlign: 'center', fontSize: '0.8rem' }}>No matching accounts found in TB.</div>
          )}
          {rows && rows.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
              <thead>
                <tr style={{ background: '#F9F9F9', position: 'sticky', top: 0 }}>
                  <th style={{ padding: '8px 16px', textAlign: 'left', color: '#9BA8B0', fontWeight: 600 }}>#</th>
                  <th style={{ padding: '8px 16px', textAlign: 'left', color: '#9BA8B0', fontWeight: 600 }}>Account / Head</th>
                  <th style={{ padding: '8px 16px', textAlign: 'left', color: '#9BA8B0', fontWeight: 600, width: 160 }}>TB Grouping</th>
                  <th style={{ padding: '8px 16px', textAlign: 'right', color: '#9BA8B0', fontWeight: 600, width: 120 }}>₹ in Lakhs</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #DFE7E3', background: i % 2 === 0 ? 'transparent' : '#F9F9F9' }}>
                    <td style={{ padding: '5px 16px', color: '#5D6C7B' }}>{i + 1}</td>
                    <td style={{ padding: '5px 16px', color: '#18191B' }}>{r.account}</td>
                    <td style={{ padding: '5px 16px', color: '#5D6C7B', fontSize: '0.72rem' }}>{r.grouping}</td>
                    <td style={{ padding: '5px 16px', textAlign: 'right', color: r.lakhs < 0 ? '#DC2626' : '#15803D', fontVariantNumeric: 'tabular-nums' }}>
                      {r.lakhs.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={ftr}>
          <span style={{ fontSize: '0.75rem', color: '#5D6C7B' }}>
            {rows ? `${rows.length} account${rows.length !== 1 ? 's' : ''}` : ''}
          </span>
          {rows && rows.length > 0 && (
            <span style={{ fontWeight: 700, color: total < 0 ? '#DC2626' : '#15803D', fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums' }}>
              Total: {total.toFixed(2)} L
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Note Table ───────────────────────────────────────────────────────────────
function NoteTable({ note, periods, values, editMode, onValueChange, colKeys: colKeysProp }) {
  const notePeriods = (colKeysProp || NOTE_COL_KEYS).map(k => periods.find(p => p.key === k)).filter(Boolean);
  const total = (pk) => note.items.reduce((s, it) => s + n(values[it.id]?.[pk]), 0);
  const [drillItem, setDrillItem] = useState(null); // { id, label, pk, label_period }

  if (note.textOnly) {
    return (
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontWeight: 700, color: '#18191B', fontSize: '0.88rem', marginBottom: 8 }}>
          Note {note.num}: {note.title}
        </div>
        <div style={{ color: '#18191B', fontSize: '0.8rem', lineHeight: 1.7, padding: '10px 14px', background: '#F9F9F9', borderRadius: 6, border: '1px solid #DFE7E3' }}>
          {note.text}
        </div>
      </div>
    );
  }

  const hasTb = (itemId, pk) => TB_PERIOD_SHEET[pk] && (TB_ITEM_GROUPINGS[itemId] || []).length > 0;

  return (
    <div style={{ marginBottom: 24 }}>
      {drillItem && (
        <TbDrillModal
          itemId={drillItem.id}
          itemLabel={drillItem.label}
          periodKey={drillItem.pk}
          periodLabel={drillItem.periodLabel}
          onClose={() => setDrillItem(null)}
        />
      )}
      <div style={{ fontWeight: 700, color: '#18191B', fontSize: '0.88rem', marginBottom: 8 }}>
        Note {note.num}: {note.title}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
          <thead>
            <tr style={{ background: '#EAF4EF' }}>
              <th style={{ padding: '7px 10px', textAlign: 'left', color: '#18191B', fontWeight: 700, minWidth: 260 }}>Particulars</th>
              {notePeriods.map(p => (
                <th key={p.key} style={{ padding: '4px 10px', textAlign: 'right', color: '#18191B', fontWeight: 700, minWidth: 130 }}>
                  <div style={{ fontSize: '0.65rem', color: '#5D6C7B', fontWeight: 400, textTransform: 'uppercase' }}>{p.colType}</div>
                  <div>{p.label}</div>
                  <div style={{ fontSize: '0.65rem', color: '#9BA8B0', fontWeight: 400 }}>₹ in Lakhs</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {note.items.map((item, idx) => (
              <React.Fragment key={item.id}>
                {item.subhead && (
                  <tr>
                    <td colSpan={1 + notePeriods.length} style={{ padding: '5px 10px', color: '#5D6C7B', fontStyle: 'italic', fontSize: '0.78rem', borderTop: idx > 0 ? '1px solid #DFE7E3' : 'none' }}>
                      {item.subhead}
                    </td>
                  </tr>
                )}
                <tr style={{ borderBottom: '1px solid #DFE7E3' }}>
                  <td style={{ padding: '4px 10px', color: '#18191B' }}>{item.label}</td>
                  {notePeriods.map(p => {
                    const cellVal = values[item.id]?.[p.key] ?? '';
                    const canDrill = !editMode && hasTb(item.id, p.key);
                    if (!editMode) return (
                      <td key={p.key}
                        onClick={canDrill ? () => setDrillItem({ id: item.id, label: item.label, pk: p.key, periodLabel: p.label }) : undefined}
                        title={canDrill ? 'Click to see TB breakdown' : undefined}
                        style={{
                          padding: '4px 10px', textAlign: 'right', color: '#18191B', whiteSpace: 'nowrap',
                          cursor: canDrill ? 'pointer' : 'default',
                          borderBottom: canDrill ? '1px dashed #1C4942' : undefined,
                        }}>
                        {fmtNoteVal(cellVal, item.unit)}
                        {canDrill && <span style={{ marginLeft: 4, fontSize: '0.65rem', color: '#1C4942', opacity: 0.7 }}>↗</span>}
                      </td>
                    );
                    return (
                      <td key={p.key} style={{ padding: '2px 6px', textAlign: 'right' }}>
                        <input type="number" value={cellVal} onChange={e => onValueChange(item.id, p.key, e.target.value)}
                          style={{ ...S.input, width: 110 }} placeholder="0.00" step="0.01" />
                      </td>
                    );
                  })}
                </tr>
              </React.Fragment>
            ))}
            {!note.noTotal && (
              <tr style={{ borderTop: '2px solid #DFE7E3', background: '#F9F9F9' }}>
                <td style={{ padding: '6px 10px', color: '#18191B', fontWeight: 700 }}>Total</td>
                {notePeriods.map(p => (
                  <td key={p.key} style={{ padding: '6px 10px', textAlign: 'right', color: '#18191B', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {fmtPL(total(p.key))}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {note.footnote && (
        <div style={{ marginTop: 6, color: '#5D6C7B', fontSize: '0.72rem', fontStyle: 'italic', padding: '0 4px' }}>
          {note.footnote}
        </div>
      )}
    </div>
  );
}

// ─── Chart of Accounts Tab ────────────────────────────────────────────────────
function CoaTab({ coa, coaFilter, coaLoading, onFilterChange }) {
  const [search, setSearch] = useState('');
  const filtered = coa.filter(a =>
    (a.account_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (a.account_code || '').toLowerCase().includes(search.toLowerCase()) ||
    (a.account_type || '').toLowerCase().includes(search.toLowerCase())
  );
  const typeColors = { income: '#10b981', expense: '#f59e0b', asset: '#3b82f6', liability: '#a78bfa', equity: '#ec4899', other: '#64748b' };
  const typeColor = (t) => {
    const low = (t || '').toLowerCase();
    if (low.includes('income') || low.includes('revenue')) return typeColors.income;
    if (low.includes('expense') || low.includes('cost')) return typeColors.expense;
    if (low.includes('asset') || low.includes('bank') || low.includes('receivable')) return typeColors.asset;
    if (low.includes('liability') || low.includes('payable')) return typeColors.liability;
    if (low.includes('equity') || low.includes('capital')) return typeColors.equity;
    return typeColors.other;
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {['all', 'active', 'inactive'].map(f => (
            <button key={f} onClick={() => onFilterChange(f)} style={S.tab(coaFilter === f)}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search accounts…"
          style={{ ...S.input, width: 240, textAlign: 'left', padding: '7px 12px' }} />
        <span style={{ color: '#5D6C7B', fontSize: '0.78rem' }}>{filtered.length} accounts</span>
      </div>
      {coaLoading ? (
        <div style={{ padding: 30, textAlign: 'center', color: '#5D6C7B' }}>Loading chart of accounts…</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead>
              <tr style={{ background: '#EAF4EF' }}>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: '#18191B', fontWeight: 700, minWidth: 260 }}>Account Name</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: '#18191B', fontWeight: 700, minWidth: 180 }}>Account Type</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: '#18191B', fontWeight: 700, width: 100 }}>Code</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: '#18191B', fontWeight: 700, minWidth: 180 }}>Parent Account</th>
                <th style={{ padding: '8px 10px', textAlign: 'center', color: '#18191B', fontWeight: 700, width: 80 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(acct => (
                <tr key={acct.account_id} style={{ borderBottom: '1px solid #DFE7E3' }}>
                  <td style={{ padding: '5px 10px', color: '#18191B', paddingLeft: 10 + (acct.depth || 0) * 14 }}>
                    {acct.account_name}
                  </td>
                  <td style={{ padding: '5px 10px' }}>
                    <span style={{ background: typeColor(acct.account_type) + '22', color: typeColor(acct.account_type), padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 600 }}>
                      {acct.account_type || '—'}
                    </span>
                  </td>
                  <td style={{ padding: '5px 10px', color: '#9BA8B0', fontFamily: 'monospace', fontSize: '0.75rem' }}>{acct.account_code || '—'}</td>
                  <td style={{ padding: '5px 10px', color: '#5D6C7B', fontSize: '0.78rem' }}>{acct.parent_account_name || '—'}</td>
                  <td style={{ padding: '5px 10px', textAlign: 'center' }}>
                    <span style={{ fontSize: '0.68rem', fontWeight: 600, padding: '2px 8px', borderRadius: 3,
                      background: acct.is_active ? '#EAF4EF' : '#FEF2F2', color: acct.is_active ? '#15803D' : '#DC2626' }}>
                      {acct.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── BS Note Detail Modal ─────────────────────────────────────────────────────
function BsNoteDetailModal({ noteNum, bsValues, onClose }) {
  const note = BS_NOTES_DEF.find(n => n.num === noteNum);
  if (!note) return null;
  const nv   = (id, pk) => { const v = bsValues[id]; return (v && v[pk] != null) ? parseFloat(v[pk]) || 0 : 0; };
  const total = (pk) => note.items.filter(it => !it.unit || it.unit !== 'nos').reduce((s, it) => s + nv(it.id, pk), 0);

  const overlay = { position:'fixed', inset:0, background:'rgba(0,18,20,0.5)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 };
  const box     = { background:'#F9F9F9', border:'1px solid #DFE7E3', borderRadius:10, maxWidth:760, width:'100%', maxHeight:'82vh', display:'flex', flexDirection:'column' };
  const hdrS    = { padding:'14px 18px', borderBottom:'1px solid #DFE7E3', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 };
  const body    = { overflowY:'auto', flex:1 };
  const ftr     = { padding:'10px 18px', borderTop:'1px solid #DFE7E3', display:'flex', justifyContent:'space-between', alignItems:'center' };

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={box}>
        <div style={hdrS}>
          <div>
            <div style={{ color:'#18191B', fontWeight:700, fontSize:'0.92rem' }}>Note {note.num}: {note.title}</div>
            <div style={{ color:'#9BA8B0', fontSize:'0.73rem', marginTop:2 }}>Balance Sheet note detail · ₹ in Lakhs</div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#5D6C7B', cursor:'pointer', fontSize:'1.2rem', lineHeight:1, padding:2 }}>✕</button>
        </div>
        <div style={body}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'0.8rem' }}>
            <thead>
              <tr style={{ background:'#F9F9F9', position:'sticky', top:0 }}>
                <th style={{ padding:'8px 16px', textAlign:'left', color:'#9BA8B0', fontWeight:600 }}>Particulars</th>
                {BS_PERIODS.map(p => (
                  <th key={p.key} style={{ padding:'6px 16px', textAlign:'right', color:'#9BA8B0', fontWeight:600, minWidth:140 }}>
                    <div style={{ fontSize:'0.63rem', color:'#5D6C7B', textTransform:'uppercase' }}>{p.colType}</div>
                    <div>{p.label}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {note.items.map((item, idx) => (
                <React.Fragment key={item.id}>
                  {item.subhead && (
                    <tr>
                      <td colSpan={3} style={{ padding:'5px 16px', color:'#5D6C7B', fontStyle:'italic', fontSize:'0.76rem', borderTop: idx > 0 ? '1px solid #DFE7E3':'none' }}>
                        {item.subhead}
                      </td>
                    </tr>
                  )}
                  <tr style={{ borderBottom:'1px solid #DFE7E3', background: idx%2===0?'transparent':'#F9F9F9' }}>
                    <td style={{ padding:'5px 16px', color:'#18191B' }}>{item.label}</td>
                    {BS_PERIODS.map(p => (
                      <td key={p.key} style={{ padding:'5px 16px', textAlign:'right', color:'#18191B', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>
                        {fmtNoteVal(nv(item.id, p.key), item.unit)}
                      </td>
                    ))}
                  </tr>
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div style={ftr}>
          <span style={{ fontSize:'0.73rem', color:'#5D6C7B' }}>{note.items.length} item{note.items.length!==1?'s':''}</span>
          {!note.noTotal && (
            <div style={{ display:'flex', gap:24 }}>
              {BS_PERIODS.map(p => (
                <span key={p.key} style={{ fontWeight:700, color:'#1C4942', fontSize:'0.85rem', fontVariantNumeric:'tabular-nums' }}>
                  {p.label}: {fmtPL(total(p.key))}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Balance Sheet Tab ────────────────────────────────────────────────────────
function BsTab({ lines, values }) {
  const [modal, setModal] = useState(null); // { type:'note', noteNum, label } | { type:'tb', id, label, pk }
  const nv  = (id, pk) => { const v = lines[id]; return (v && v[pk] != null) ? parseFloat(v[pk]) || 0 : 0; };
  const sum = (ids, pk) => ids.reduce((acc, id) => acc + nv(id, pk), 0);

  const NC_IDS  = ['bs_ppe','bs_cwip','bs_rou','bs_intangible','bs_intang_dev','bs_nc_invest','bs_nc_loans','bs_nc_ofa','bs_dta','bs_nc_other'];
  const CA_IDS  = ['bs_c_invest','bs_tr','bs_cash','bs_obank','bs_c_loans','bs_c_ofa','bs_cta','bs_c_other'];
  const EQ_IDS  = ['bs_share_cap','bs_other_equity'];
  const NCL_IDS = ['bs_nc_borrow','bs_nc_lease','bs_nc_ofl','bs_nc_prov'];
  const CL_IDS  = ['bs_c_borrow','bs_tp_msme','bs_tp_others','bs_c_lease','bs_c_ofl','bs_c_other_liab','bs_c_prov'];

  const SH     = { padding:'6px 10px 4px', color:'#1C4942', fontWeight:700, fontSize:'0.78rem', background:'#EAF4EF', textTransform:'uppercase', letterSpacing:'0.04em' };
  const SUBSEC = { padding:'5px 10px 3px', color:'#9BA8B0', fontWeight:600, fontSize:'0.78rem', fontStyle:'italic', borderTop:'1px solid #DFE7E3' };
  const LABEL  = { padding:'3px 10px', color:'#18191B', fontSize:'0.79rem', borderBottom:'1px solid #DFE7E3' };
  const SUBLABEL={ padding:'3px 10px', color:'#9BA8B0', fontSize:'0.77rem', borderBottom:'1px solid #DFE7E3', fontStyle:'italic' };
  const TOT    = { padding:'6px 10px', fontWeight:700, color:'#18191B', borderTop:'2px solid #DFE7E3', background:'#F9F9F9' };
  const GT     = { padding:'7px 10px', fontWeight:700, color:'#1C4942', borderTop:'2px solid #1C4942', background:'#EAF4EF' };
  const NUM    = { textAlign:'right', whiteSpace:'nowrap', fontVariantNumeric:'tabular-nums', minWidth:130 };
  const NC     = { textAlign:'center', width:72, color:'#1C4942', fontSize:'0.77rem' };

  // Determine what kind of drill-down an ID supports
  const drillType = (id) => {
    if (BS_LINE_NOTE_MAP[id]) return 'note';
    if ((TB_ITEM_GROUPINGS[id] || []).length > 0) return 'tb';
    return null;
  };

  const rowHdr = (label) => <tr><td colSpan={4} style={SH}>{label}</td></tr>;
  const rowSub = (label) => <tr><td colSpan={4} style={SUBSEC}>{label}</td></tr>;

  const rowItem = (id, label, noteNum, indent=0) => {
    const dt = drillType(id);
    return (
      <tr>
        <td style={{ ...LABEL, paddingLeft: 10 + indent * 18 }}>{label}</td>
        <td style={NC}>{noteNum || ''}</td>
        {BS_COL_KEYS.map(pk => {
          const val = fmtPL(nv(id, pk));
          const canClick = dt !== null && (dt === 'note' || TB_PERIOD_SHEET[pk]);
          return (
            <td key={pk}
              onClick={canClick ? () => {
                if (dt === 'note') setModal({ type:'note', noteNum: BS_LINE_NOTE_MAP[id], label });
                else setModal({ type:'tb', id, label, pk });
              } : undefined}
              title={canClick ? (dt === 'note' ? `Click to see Note ${BS_LINE_NOTE_MAP[id]} breakdown` : 'Click to see TB breakdown') : undefined}
              style={{
                ...LABEL, ...NUM,
                cursor: canClick ? 'pointer' : 'default',
                borderBottom: canClick ? '1px dashed #1C4942' : '1px solid #DFE7E3',
                color: canClick ? '#1C4942' : '#18191B',
              }}>
              {val}{canClick && <span style={{ marginLeft:3, fontSize:'0.62rem', opacity:0.65 }}>↗</span>}
            </td>
          );
        })}
      </tr>
    );
  };

  const rowTotal = (ids, label) => (
    <tr>
      <td colSpan={2} style={TOT}>{label}</td>
      {BS_COL_KEYS.map(pk => <td key={pk} style={{ ...TOT, ...NUM }}>{fmtPL(sum(ids, pk))}</td>)}
    </tr>
  );
  const rowGrand = (ids, label) => (
    <tr>
      <td colSpan={2} style={GT}>{label}</td>
      {BS_COL_KEYS.map(pk => <td key={pk} style={{ ...GT, ...NUM }}>{fmtPL(sum(ids, pk))}</td>)}
    </tr>
  );
  const spacer = () => <tr><td colSpan={4} style={{ height:10 }}></td></tr>;

  return (
    <div>
      {modal && modal.type === 'note' && (
        <BsNoteDetailModal noteNum={modal.noteNum} bsValues={values} onClose={() => setModal(null)} />
      )}
      {modal && modal.type === 'tb' && (
        <TbDrillModal
          itemId={modal.id} itemLabel={modal.label}
          periodKey={modal.pk} periodLabel={BS_PERIODS.find(p => p.key === modal.pk)?.label || modal.pk}
          onClose={() => setModal(null)}
        />
      )}
      <div style={{ textAlign:'center', marginBottom:16 }}>
        <div style={{ fontWeight:700, fontSize:'1rem', color:'#18191B', letterSpacing:'0.05em', textTransform:'uppercase' }}>Dev Accelerator Ltd</div>
        <div style={{ fontSize:'0.78rem', color:'#9BA8B0', marginTop:3 }}>Standalone Balance Sheet as at 31st March 2026 · (₹ in Lakhs)</div>
        <div style={{ fontSize:'0.72rem', color:'#5D6C7B', marginTop:4 }}>Click any figure to see note or TB breakdown</div>
      </div>
      <div style={S.card}>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'0.8rem' }}>
            <thead>
              <tr style={{ background:'#F9F9F9' }}>
                <th style={{ padding:'8px 10px', textAlign:'left', color:'#9BA8B0', fontWeight:700, minWidth:360 }}>Particulars</th>
                <th style={{ padding:'8px 10px', textAlign:'center', color:'#9BA8B0', fontWeight:700, width:72 }}>Note</th>
                {BS_PERIODS.map(p => (
                  <th key={p.key} style={{ padding:'4px 10px', textAlign:'right', color:'#18191B', fontWeight:700, minWidth:150 }}>
                    <div style={{ fontSize:'0.64rem', color:'#5D6C7B', fontWeight:400, textTransform:'uppercase', letterSpacing:'0.05em' }}>{p.colType}</div>
                    <div style={{ fontSize:'0.85rem' }}>{p.label}</div>
                    <div style={{ fontSize:'0.64rem', color:'#5D6C7B', fontWeight:400 }}>₹ in Lakhs</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowHdr('I. ASSETS')}
              {rowSub('1. Non-current Assets')}
              {rowItem('bs_ppe',        '(a) Property, Plant and Equipment',              '2',   1)}
              {rowItem('bs_cwip',       '(b) Capital Work-in-Progress',                    '2.1', 1)}
              {rowItem('bs_rou',        '(c) Right of Use Assets',                         '2.2', 1)}
              {rowItem('bs_intangible', '(d) Intangible Assets',                           '3',   1)}
              {rowItem('bs_intang_dev', '(e) Intangible Assets under Development',         '3.1', 1)}
              <tr><td colSpan={4} style={{ ...SUBLABEL, paddingLeft:28 }}>(f) Financial Assets</td></tr>
              {rowItem('bs_nc_invest',  '(i) Investments',                                 '4',   3)}
              {rowItem('bs_nc_loans',   '(ii) Loans',                                      '5',   3)}
              {rowItem('bs_nc_ofa',     '(iii) Other Financial Assets',                    '6',   3)}
              {rowItem('bs_dta',        '(g) Deferred Tax Assets (Net)',                   '7',   1)}
              {rowItem('bs_nc_other',   '(h) Other Non-current Assets',                   '8',   1)}
              {rowTotal(NC_IDS, 'Total Non-current Assets')}
              {spacer()}
              {rowSub('2. Current Assets')}
              <tr><td colSpan={4} style={{ ...SUBLABEL, paddingLeft:28 }}>(a) Financial Assets</td></tr>
              {rowItem('bs_c_invest',   '(i) Investments',                                 '9',   3)}
              {rowItem('bs_tr',         '(ii) Trade Receivables',                          '10',  3)}
              {rowItem('bs_cash',       '(iii) Cash and Cash Equivalents',                 '11',  3)}
              {rowItem('bs_obank',      '(iv) Other Bank Balances',                        '12',  3)}
              {rowItem('bs_c_loans',    '(v) Loans',                                       '13',  3)}
              {rowItem('bs_c_ofa',      '(vi) Other Financial Assets',                     '14',  3)}
              {rowItem('bs_cta',        '(b) Current Tax Assets (Net)',                    '15',  1)}
              {rowItem('bs_c_other',    '(c) Other Current Assets',                        '16',  1)}
              {rowTotal(CA_IDS, 'Total Current Assets')}
              {spacer()}
              {rowGrand([...NC_IDS, ...CA_IDS], 'TOTAL ASSETS')}
              {spacer()}
              {spacer()}
              {rowHdr('II. EQUITY AND LIABILITIES')}
              {rowSub('1. Equity')}
              {rowItem('bs_share_cap',    '(a) Equity Share Capital',                      '17',  1)}
              {rowItem('bs_other_equity', '(b) Other Equity',                              '18',  1)}
              {rowTotal(EQ_IDS, 'Total Equity')}
              {spacer()}
              {rowSub('2. Non-current Liabilities')}
              <tr><td colSpan={4} style={{ ...SUBLABEL, paddingLeft:28 }}>(a) Financial Liabilities</td></tr>
              {rowItem('bs_nc_borrow', '(i) Borrowings',                                   '19',  3)}
              {rowItem('bs_nc_lease',  '(ii) Lease Liabilities',                           '45',  3)}
              {rowItem('bs_nc_ofl',    '(iii) Other Financial Liabilities',                '20',  3)}
              {rowItem('bs_nc_prov',   '(b) Provisions',                                   '21',  1)}
              {rowTotal(NCL_IDS, 'Total Non-current Liabilities')}
              {spacer()}
              {rowSub('3. Current Liabilities')}
              <tr><td colSpan={4} style={{ ...SUBLABEL, paddingLeft:28 }}>(a) Financial Liabilities</td></tr>
              {rowItem('bs_c_borrow',     '(i) Borrowings',                                '22',  3)}
              <tr><td colSpan={4} style={{ ...SUBLABEL, paddingLeft:46 }}>(ii) Trade Payables</td></tr>
              {rowItem('bs_tp_msme',      '— MSME Enterprises',                            '23',  4)}
              {rowItem('bs_tp_others',    '— Other than MSME',                             null,  4)}
              {rowItem('bs_c_lease',      '(iii) Lease Liabilities',                       '45',  3)}
              {rowItem('bs_c_ofl',        '(iv) Other Financial Liabilities',              '24',  3)}
              {rowItem('bs_c_other_liab', '(b) Other Current Liabilities',                 '25',  1)}
              {rowItem('bs_c_prov',       '(c) Provisions',                                '26',  1)}
              {rowTotal(CL_IDS, 'Total Current Liabilities')}
              {spacer()}
              {rowGrand([...EQ_IDS, ...NCL_IDS, ...CL_IDS], 'TOTAL EQUITY AND LIABILITIES')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Account Mapping Tab ──────────────────────────────────────────────────────
function MappingTab({ mappings, coa, onSaveMapping, fetchZohoStatus, onFetchZoho, periods }) {
  const [modalItem, setModalItem] = useState(null); // { id, label }
  const coaById = useMemo(() => Object.fromEntries(coa.map(a => [a.account_id, a])), [coa]);

  const openModal = (id, label) => setModalItem({ id, label });
  const saveMapping = (id, ids) => { onSaveMapping(id, ids); setModalItem(null); };

  const MappedBadge = ({ id }) => {
    const ids = mappings[id] || [];
    if (ids.length === 0) return <span style={{ color: '#5D6C7B', fontSize: '0.72rem' }}>Not mapped</span>;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {ids.map(aid => (
          <span key={aid} style={{ background: '#EAF4EF', color: '#1C4942', padding: '2px 7px', borderRadius: 4, fontSize: '0.7rem' }}>
            {coaById[aid]?.account_name || aid}
          </span>
        ))}
      </div>
    );
  };

  const Section = ({ title, items }) => (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontWeight: 700, color: '#9BA8B0', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, borderBottom: '1px solid #DFE7E3', paddingBottom: 4 }}>{title}</div>
      {items.map(({ id, label }) => (
        <div key={id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '6px 0', borderBottom: '1px solid #DFE7E3' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.82rem', color: '#18191B', marginBottom: 3 }}>{label}</div>
            <MappedBadge id={id} />
          </div>
          <button onClick={() => openModal(id, label)} style={S.btn('secondary', true)}>Edit</button>
        </div>
      ))}
    </div>
  );

  // Periods available for Zoho fetch (those with from/to dates)
  const fetchPeriods = PL_COL_KEYS.concat(NOTE_COL_KEYS.filter(k => !PL_COL_KEYS.includes(k))).map(k => periods.find(p => p.key === k)).filter(Boolean);

  return (
    <div>
      <div style={{ background: '#EAF4EF', borderRadius: 8, padding: 14, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, color: '#1C4942', fontSize: '0.85rem', marginBottom: 2 }}>Fetch Amounts from Zoho Books</div>
          <div style={{ fontSize: '0.75rem', color: '#5D6C7B' }}>Once mappings are set, fetch account balances from Zoho for all configured periods.</div>
        </div>
        <button onClick={onFetchZoho} disabled={!!fetchZohoStatus} style={{ ...S.btn('success'), opacity: fetchZohoStatus ? 0.6 : 1 }}>
          {fetchZohoStatus || 'Fetch from Zoho'}
        </button>
      </div>

      {NOTES_DEF.map(note => (
        <Section key={note.num} title={`Note ${note.num}: ${note.title}`} items={note.items.map(i => ({ id: i.id, label: i.label }))} />
      ))}
      <Section title="Main P&L Items (Manual / Mapped)" items={[
        { id: 'VI',     label: 'Exceptional Items' },
        { id: 'VIIIa', label: 'Tax — Current Tax' },
        { id: 'VIIIb', label: 'Tax — Deferred Tax Liability / (Assets)' },
        { id: 'VIIIc', label: 'Tax — Adjustment for Earlier Years' },
        { id: 'OCIa',  label: 'OCI — Items not reclassified to P&L' },
        { id: 'OCIb',  label: 'OCI — Income tax on OCI items' },
        { id: 'XII',   label: 'Paid up equity share capital' },
        { id: 'XIII',  label: 'Other equity excluding Revaluation Reserve' },
        { id: 'XIVb',  label: 'EPS — Basic' },
        { id: 'XIVd',  label: 'EPS — Diluted' },
      ]} />

      {modalItem && (
        <MappingModal
          itemId={modalItem.id}
          itemLabel={modalItem.label}
          coa={coa}
          currentIds={mappings[modalItem.id] || []}
          onSave={saveMapping}
          onClose={() => setModalItem(null)}
        />
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function FinancialStatements() {
  const [tab, setTab]           = useState('bs');
  const [periods, setPeriods]   = useState(PERIODS_DEFAULT);
  const [values, setValues]     = useState({});     // { itemId: { periodKey: number } }
  const [mappings, setMappings] = useState({});
  const [coa, setCoa]           = useState([]);
  const [coaFilter, setCoaFilter] = useState('all');
  const [coaLoading, setCoaLoading] = useState(false);
  const [bsData, setBsData]     = useState({ lines: {}, values: {} });
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saveMsg, setSaveMsg]   = useState('');
  const [fetchStatus, setFetchStatus] = useState('');
  const [showPeriodModal, setShowPeriodModal] = useState(false);
  const [loading, setLoading]   = useState(true);

  // Initial data load + auto-fetch for periods with mappings but no data
  useEffect(() => {
    let alive = true;
    api.finBsData().then(d => { if (alive) setBsData(d || { lines: {}, values: {} }); }).catch(() => {});
    Promise.all([api.finPlData(), api.finMappings()]).then(([plData, maps]) => {
      if (!alive) return;

      // Always merge stored periods with PERIODS_DEFAULT so newly added periods (c0, etc.) are present
      const storedPeriods = (plData.periods && plData.periods.length > 0) ? plData.periods : [];
      const mergedPeriods = PERIODS_DEFAULT.map(defP => storedPeriods.find(p => p.key === defP.key) || defP);
      setPeriods(mergedPeriods);

      const loadedValues   = plData.values || {};
      const loadedMappings = maps || {};
      setValues(loadedValues);
      setMappings(loadedMappings);
      setLoading(false);

      // Auto-fetch any configured period that has mappings but no data yet
      const hasMappings = Object.values(loadedMappings).some(ids => Array.isArray(ids) && ids.length > 0);
      if (!hasMappings) return;

      const allPeriodKeys = [...new Set([...PL_COL_KEYS, ...NOTE_COL_KEYS])];
      const needFetch = allPeriodKeys
        .map(k => mergedPeriods.find(p => p.key === k))
        .filter(p => {
          if (!p) return false;
          // Period needs fetch if none of the mapped items have data for it
          return !Object.keys(loadedMappings).some(
            itemId => Array.isArray(loadedMappings[itemId]) && loadedMappings[itemId].length > 0 && loadedValues[itemId]?.[p.key] != null
          );
        });

      if (needFetch.length === 0) return;

      // Auto-fetch periods one at a time so the UI gets data progressively.
      // Start with c0 (most recent) first, then continue with older periods.
      const ordered = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
        .map(k => needFetch.find(p => p.key === k))
        .filter(Boolean);

      let accumulated = { ...loadedValues };

      const fetchNext = (idx) => {
        if (!alive || idx >= ordered.length) {
          setFetchStatus('');
          return;
        }
        const p = ordered[idx];
        setFetchStatus(`Fetching ${p.label}… (${idx + 1}/${ordered.length})`);
        api.finFetchZoho([{ key: p.key, from: p.from, to: p.to }])
          .then(result => {
            if (!alive) return;
            const lineAmts = result[p.key] || {};
            if (!lineAmts._error) {
              for (const [itemId, amt] of Object.entries(lineAmts)) {
                if (!accumulated[itemId]) accumulated[itemId] = {};
                // Expense items come as negative (debit > credit); negate so they display as positive costs
                accumulated[itemId][p.key] = EXPENSE_ITEM_IDS.has(itemId) ? -amt : amt;
              }
              setValues({ ...accumulated });
              api.finSavePlData({ periods: mergedPeriods, values: accumulated });
              setSaveMsg(`Fetched ${p.label}`);
              setTimeout(() => setSaveMsg(''), 2000);
            } else {
              console.warn('Auto-fetch error for', p.key, lineAmts._error);
            }
            fetchNext(idx + 1);
          })
          .catch(e => {
            if (!alive) return;
            console.error('Auto-fetch error:', e);
            fetchNext(idx + 1);
          });
      };

      fetchNext(0);
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // Load COA when tab switches to coa or mapping
  useEffect(() => {
    if (tab === 'coa' || tab === 'mapping') {
      if (coa.length === 0) loadCoa(coaFilter);
    }
  }, [tab]); // eslint-disable-line

  const loadCoa = useCallback(async (filter) => {
    setCoaLoading(true);
    try {
      const data = await api.finCoa(filter);
      setCoa(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('COA fetch error:', e);
    } finally {
      setCoaLoading(false);
    }
  }, []);

  const handleFilterChange = (f) => {
    setCoaFilter(f);
    loadCoa(f);
  };

  const handleValueChange = (itemId, periodKey, val) => {
    setValues(prev => ({
      ...prev,
      [itemId]: { ...prev[itemId], [periodKey]: val === '' ? null : parseFloat(val) },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.finSavePlData({ periods, values });
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch { setSaveMsg('Error saving'); setTimeout(() => setSaveMsg(''), 3000); }
    setSaving(false);
  };

  const handleSavePeriods = async (newPeriods) => {
    setPeriods(newPeriods);
    setShowPeriodModal(false);
    await api.finSavePlData({ periods: newPeriods, values });
  };

  const handleSaveMapping = async (itemId, ids) => {
    const newMaps = { ...mappings, [itemId]: ids };
    setMappings(newMaps);
    await api.finSaveMappings(newMaps);
  };

  const handleFetchZoho = async () => {
    const allPeriodKeys = [...new Set([...PL_COL_KEYS, ...NOTE_COL_KEYS])];
    const fetchPeriods  = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
      .map(k => allPeriodKeys.includes(k) ? periods.find(p => p.key === k) : null)
      .filter(Boolean);

    let accumulated = { ...values };

    for (let idx = 0; idx < fetchPeriods.length; idx++) {
      const p = fetchPeriods[idx];
      setFetchStatus(`Fetching ${p.label}… (${idx + 1}/${fetchPeriods.length})`);
      try {
        const result = await api.finFetchZoho([{ key: p.key, from: p.from, to: p.to }]);
        const lineAmts = result[p.key] || {};
        if (!lineAmts._error) {
          for (const [itemId, amt] of Object.entries(lineAmts)) {
            if (!accumulated[itemId]) accumulated[itemId] = {};
            // Expense items: Zoho credit-debit is negative; negate to store as positive cost
            accumulated[itemId][p.key] = EXPENSE_ITEM_IDS.has(itemId) ? -amt : amt;
          }
          setValues({ ...accumulated });
          await api.finSavePlData({ periods, values: accumulated });
          setSaveMsg(`Fetched ${p.label}`);
          setTimeout(() => setSaveMsg(''), 2000);
        } else {
          console.warn('Fetch error for', p.key, lineAmts._error);
        }
      } catch (e) {
        console.error(`Fetch error for ${p.key}:`, e.message);
        setSaveMsg(`Error fetching ${p.label}: ${e.message}`);
        setTimeout(() => setSaveMsg(''), 4000);
      }
    }
    setFetchStatus('');
    setSaveMsg('All periods fetched from Zoho');
    setTimeout(() => setSaveMsg(''), 3000);
  };

  if (loading) return (
    <div style={{ ...S.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#5D6C7B' }}>Loading financial data…</div>
    </div>
  );

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={S.h1}>Financial Statements</h1>
          <div style={{ fontSize: '0.75rem', color: '#5D6C7B', marginTop: 3 }}>
            SEBI Format — Profit & Loss Account with Notes to Accounts
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {saveMsg && <span style={{ fontSize: '0.78rem', color: saveMsg.includes('Error') ? '#DC2626' : '#15803D', padding: '4px 10px' }}>{saveMsg}</span>}
          {tab === 'pl' && (
            <>
              <button onClick={() => setShowPeriodModal(true)} style={S.btn('secondary', true)}>Configure Periods</button>
              <button onClick={() => setEditMode(m => !m)} style={S.btn(editMode ? 'success' : 'secondary', true)}>
                {editMode ? 'Exit Edit Mode' : 'Edit Values'}
              </button>
              {editMode && <button onClick={handleSave} disabled={saving} style={S.btn('primary', true)}>{saving ? 'Saving…' : 'Save'}</button>}
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {[
          { id: 'bs',      label: 'Balance Sheet' },
          { id: 'pl',      label: 'P&L Statement' },
          { id: 'notes',   label: 'Notes to Accounts' },
          { id: 'coa',     label: 'Chart of Accounts' },
          { id: 'mapping', label: 'Account Mapping' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={S.tab(tab === t.id)}>{t.label}</button>
        ))}
      </div>

      {/* Balance Sheet */}
      {tab === 'bs' && <BsTab lines={bsData.lines || {}} values={bsData.values || {}} />}

      {/* P&L Statement */}
      {tab === 'pl' && (
        <div>
          {/* Company header */}
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: '#18191B', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Dev Accelerator Ltd
            </div>
            <div style={{ fontSize: '0.8rem', color: '#9BA8B0', marginTop: 2 }}>
              CIN: [Your CIN] · Statement of Profit and Loss · (₹ in Lakhs)
            </div>
          </div>
          <div style={S.card}>
            <PLTable periods={periods} values={values} editMode={editMode} onValueChange={handleValueChange} />
          </div>
        </div>
      )}

      {/* Notes to Accounts */}
      {tab === 'notes' && (
        <div>
          {/* Balance Sheet Notes section */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontWeight: 700, color: '#1C4942', fontSize: '0.82rem', padding: '6px 0', borderBottom: '2px solid #DFE7E3', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Balance Sheet Notes
            </div>
            <div style={{ fontSize: '0.75rem', color: '#5D6C7B', marginBottom: 12 }}>
              Columns: As at 31/03/2026 · As at 31/03/2025
            </div>
            {BS_NOTES_DEF.map(note => (
              <div key={note.num} style={S.card}>
                <NoteTable note={note} periods={BS_PERIODS} values={bsData.values || {}} editMode={false} onValueChange={() => {}} colKeys={BS_COL_KEYS} />
              </div>
            ))}
          </div>

          {/* P&L Notes section */}
          <div>
            <div style={{ fontWeight: 700, color: '#1C4942', fontSize: '0.82rem', padding: '6px 0', borderBottom: '2px solid #DFE7E3', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span>Profit & Loss Notes</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setEditMode(m => !m)} style={S.btn(editMode ? 'success' : 'secondary', true)}>
                  {editMode ? 'Exit Edit Mode' : 'Edit Values'}
                </button>
                {editMode && <button onClick={handleSave} disabled={saving} style={S.btn('primary', true)}>{saving ? 'Saving…' : 'Save'}</button>}
              </div>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#5D6C7B', marginBottom: 12 }}>
              Columns: {NOTE_COL_KEYS.map(k => periods.find(p=>p.key===k)?.label).filter(Boolean).join(' · ')}
            </div>
            {NOTES_DEF.map(note => (
              <div key={note.num} style={S.card}>
                <NoteTable note={note} periods={periods} values={values} editMode={editMode} onValueChange={handleValueChange} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chart of Accounts */}
      {tab === 'coa' && (
        <div style={S.card}>
          <CoaTab coa={coa} coaFilter={coaFilter} coaLoading={coaLoading} onFilterChange={handleFilterChange} />
        </div>
      )}

      {/* Account Mapping */}
      {tab === 'mapping' && (
        <div style={S.card}>
          <MappingTab
            mappings={mappings}
            coa={coa}
            onSaveMapping={handleSaveMapping}
            fetchZohoStatus={fetchStatus}
            onFetchZoho={handleFetchZoho}
            periods={periods}
          />
        </div>
      )}

      {showPeriodModal && (
        <PeriodModal periods={periods} onSave={handleSavePeriods} onClose={() => setShowPeriodModal(false)} />
      )}
    </div>
  );
}
