/**
 * Demo space — ILLUSTRATIVE workspace records for the Reports, GST workspace, TDS Section-wise, Provident Fund & PT,
 * Payroll imports, Tax audit and Compliance Updates tabs. Invented amounts, references and people; every record is marked
 * illustrative and never mixes with records a user enters (reports keep the two datasets apart).
 *
 * Records are created through the same functions (and checks) the screens use. Sample files are generated text files
 * marked "ILLUSTRATIVE SAMPLE — NOT A REAL DOCUMENT".
 */

'use strict';

const U = require('./util');
const DOC = require('./documents');
const AT = require('./attachments');
const P = require('./payments');
const TDS = require('./tds');
const R = require('./recon');
const MI = require('./memberImports');
const TA = require('./taxAudit');
const UP = require('./updates');

const INITIATOR = { id: 'demo-initiator-seed', name: 'Initiator (demo persona)' };
const APPROVER = { id: 'demo-approver-seed', name: 'Approver (demo persona)' };

/** Curated reference entries (public official pages) — shown as curated, not as a live feed */
const CURATED = [
  { topic: 'E-way bill', kind: 'portal_advisory', issuer: 'NIC e-Way Bill portal', source_url: 'https://docs.ewaybillgst.gov.in/apidocs/announcements.html', title: 'EWB closure and mandatory Ship-to GSTIN changes kept on hold', published: '2026-07-30', effective_text: 'On-hold status announced 30 July 2026', summary: 'The official announcements page records that the EWB Closure functionality and mandatory Ship-to GSTIN changes have been kept on hold.', action: 'Review ERP validation changes against the current release notes. Do not activate the held requirements solely from an older announcement.', impact: 'medium' },
  { topic: 'Income Tax', kind: 'official_announcement', issuer: 'CBDT / Income Tax Department', source_url: 'https://www.incometaxindia.gov.in/documents/d/guest/press-release-income-tax-act-2025-comes-into-force-from-01-april-2026-pdf', title: 'Income-tax Act, 2025 commenced on 1 April 2026', published: '2026-04-01', effective: '2026-04-01', summary: 'CBDT announced commencement of the new Act and notification of Income-tax Rules, 2026 and corresponding forms.', action: 'Validate tax-year mappings, new forms and transition treatment separately from earlier assessment years.', impact: 'high' },
  { topic: 'TDS/TCS', kind: 'standing_guidance', issuer: 'Income Tax Department', source_url: 'https://www.incometaxindia.gov.in/income-tax-act-202511', title: 'Review TDS form and provision mappings under the new tax framework', published_text: 'Reference page — date not stated', effective_text: 'Check the relevant tax period', summary: 'The official reference page provides comparison utilities for Acts, Rules and forms, plus transition guidance.', action: 'Map legacy TDS sections and forms to the applicable current-period requirements before enabling return templates.', impact: 'high' },
  { topic: 'Provident Fund', kind: 'historical', issuer: 'PIB / EPFO', source_url: 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=2178587&lang=2&reg=3', title: 'Revamped ECR introduced for September 2025 wage month onwards', published: '2025-10-13', effective_text: 'September 2025 wage month', summary: 'EPFO announced the revamped ECR system. The announcement also records a September 2025-only filing extension to 22 October 2025.', action: 'Check ECR preparation and evidence workflow. Do not reuse the historical extension for current wage months.', impact: 'low' },
  { topic: 'E-invoice', kind: 'portal_advisory', issuer: 'IRIS IRP · GST-authorised portal', source_url: 'https://einvoice6.gst.gov.in/content/revised-time-limit-for-e-invoice-reporting-for-businesses-with-aato-of-%E2%82%B910-crores-above/', title: '30-day reporting restriction for AATO ₹10 crore and above', published: '2025-03-27', effective: '2025-04-01', summary: 'The portal describes the 30-day e-invoice reporting window for taxpayers with AATO of ₹10 crore or more.', action: 'Check turnover applicability and IRN ageing controls. This is a reporting-window threshold, not the general e-invoicing applicability threshold.', impact: 'medium' },
  { topic: 'Professional Tax', kind: 'state_reference', issuer: 'Maharashtra GST Department', source_url: 'https://www.mahagst.gov.in/user-registration/vat', title: 'Confirm FY 2026–27 PTRC periodicity from the state portal', state: 'Maharashtra', published_text: 'Reference page — date not stated', effective_text: 'FY 2026–27; verify registration', summary: 'The state portal points taxpayers to FY 2026–27 PTRC return filing periodicity and PT notices.', action: 'Confirm each Maharashtra registration’s periodicity and current notifications. Do not apply Maharashtra rules to Gujarat or other states.', impact: 'medium' },
  { topic: 'ISD', kind: 'standing_guidance', issuer: 'GST portal', source_url: 'https://tutorial.gst.gov.in/userguide/returns/GSTR-6_faq.htm', title: 'GSTR-6 is a monthly ISD return, including nil periods', published_text: 'Reference page — date not stated', effective_text: 'Standing rule; check extensions', summary: 'The GST FAQ states that registered ISDs file monthly GSTR-6, including nil returns, by the 13th of the following month or an extended date.', action: 'Map ISD registrations separately from regular GSTINs and link credit-distribution workings to the return task.', impact: 'low' },
  { topic: 'ESIC', kind: 'standing_guidance', issuer: 'ESIC', source_url: 'https://www.esic.nic.in/attachments/files/ESIC%20AD.pdf', title: 'ESI contribution baseline: 15th after month-end', published_text: 'Historical notice — exact issue date not shown', effective_text: 'June 2017 contribution onwards in cited notice', summary: 'ESIC’s notice changed the contribution payment date from the 21st to the 15th after month-end.', action: 'Use the established baseline only after checking current applicable extensions; retain challan and payment evidence.', impact: 'low' },
  { topic: 'GST', kind: 'standing_guidance', issuer: 'GST portal', source_url: 'https://tutorial.gst.gov.in/userguide/returns/FAQ_gstr2b.htm', title: 'GSTR-2B reconciliation is a control, not a separate filed return', published_text: 'Reference page — date not stated', effective_text: 'Relevant return period', summary: 'GST portal guidance explains GSTR-2B generation and the supplier-document cut-off windows.', action: 'Keep the reconciliation task linked to GSTR-3B and the correct GSTIN. Review current IMS behaviour when implementing the integration.', impact: 'low' },
];

const pad = n => String(n).padStart(2, '0');
const nextMonth = (ym, day) => { const [y, m] = U.addMonths(+ym.slice(0, 4), +ym.slice(5, 7), 1); return U.ymd(y, m, Math.min(day, U.daysInMonth(y, m))); };

async function sampleFile(files, entity, kind, name, text) {
  const prepared = await DOC.prepare('demo', { buffer: Buffer.from(`ILLUSTRATIVE SAMPLE — NOT A REAL DOCUMENT\n${text}\n`), originalname: name }, { generatedSample: true });
  return AT.add(files, { prepared, entity_id: entity.id, kind, actor: INITIATOR, sample: true });
}

async function build({ org, snapshot }) {
  const by = code => org.entities.find(e => e.short_code === code);
  const regOf = (e, type, state) => org.registrations.find(r => r.entity_id === e.id && r.type === type && (!state || r.state === state));
  const A = by('ALPHA'), B = by('BETA'), C = by('GAMMA');
  const files = AT.EMPTY(), payments = P.EMPTY(), tds = TDS.EMPTY(), recon = R.EMPTY(), imports = MI.EMPTY(), taxaudit = TA.EMPTY(), updates = UP.EMPTY();
  const months = []; for (let i = 0; i < 10; i++) { const [y, m] = U.addMonths(2026, 1, i); months.push(`${y}-${pad(m)}`); }   // Jan–Oct 2026
  const cur = snapshot.slice(0, 7);

  // ── Payment register (every section except TDS) ──
  const SECT = [['GST', 'GST_REGULAR', 360000, 20], ['Provident Fund', 'PF', 82000, 15], ['ESIC', 'ESIC', 18000, 15], ['Professional Tax', 'PT_PTRC', 4500, 28], ['Income Tax', null, 240000, 14]];
  [A, C, B].forEach((e, c) => {
    for (const [mi, m] of months.entries()) {
      for (const [s, [section, type, base, day]] of SECT.entries()) {
        if (section === 'Income Tax' && !['2026-03', '2026-06', '2026-09'].includes(m)) continue;
        const reg = type ? regOf(e, type, type === 'PT_PTRC' ? 'GJ' : undefined) || regOf(e, type) : null;
        if (type && !reg) continue;
        const paid = section === 'Income Tax' ? `${m}-${pad(day)}` : nextMonth(m, day);
        if (paid > snapshot || m >= cur) continue;
        const principal = Math.round(base * (1 + c * 0.34) * (1 + (mi % 7) * 0.075 + (mi % 3) * 0.04));
        P.add(payments, { entity_id: e.id, registration_id: reg?.id || null, section, liability_month: m, paid_date: paid, reference: `ILL-${e.short_code}-${section.replace(/\W+/g, '').slice(0, 4).toUpperCase()}-${m}`,
          principal, interest: s === 0 && m === '2026-07' ? 750 : 0, fee: 0, pt_type: section === 'Professional Tax' ? 'PTRC' : null, notes: 'Invented illustrative payment' }, { org, actor: INITIATOR, illustrative: true });
      }
    }
  });
  for (const p of payments.payments.filter(x => x.section === 'GST' && x.entity_id === A.id).slice(-3)) {
    const f = await sampleFile(files, A, 'challan', `SAMPLE_${A.short_code}_GST_PMT06_${p.liability_month}.txt`, `GST cash deposit (CPIN illustrative) for ${p.liability_month}: ₹${p.principal}`);
    p.evidence.push(f.id); AT.addLink(f, { module: 'payment', id: p.id });
  }

  // ── TDS challans + section allocations ──
  TDS.seed(tds);
  const contractor = tds.sections.find(s => s.act === '2025');
  Object.assign(contractor, { status: 'verified', verified_by: APPROVER.name, verified_by_id: APPROVER.id, verified_at: U.nowIso(), source: `${contractor.source} (demo: marked verified for illustration)` });
  let serial = 100;
  for (const [c, e] of [A, C, B].entries()) {
    const tan = regOf(e, 'TAN');
    if (!tan) continue;
    for (const [mi, m] of months.entries()) {
      if (m >= cur) continue;
      const old = m < '2026-04';
      const paid = m.endsWith('-03') ? `${m.slice(0, 4)}-04-30` : nextMonth(m, 7);
      if (paid > snapshot) continue;
      const f = 1 + c * 0.3 + (mi % 4) * 0.06;
      const lines = old ? [['192', 92000], ['194C', 24000], ['194J(b)', 18000]] : [[contractor.code, 26000], ...(c === 0 ? [['192', 0]] : [])].filter(x => x[1] > 0);
      const amounts = lines.map(([code, amt]) => [code, Math.round(amt * f)]);
      const tax = amounts.reduce((s, x) => s + x[1], 0) + (c === 2 && m === '2026-08' ? 5000 : 0);                 // Beta Aug: ₹5,000 left unallocated → queue
      const ch = TDS.addChallan(tds, { entity_id: e.id, registration_id: tan.id, itns: '281N', deductee_type: 'non_company', act: old ? '1961' : '2025', tax_year: old ? 'AY 2026-27' : 'TY 2026-27',
        paid_date: paid, bsr_code: '0510308', challan_serial: String(serial++), components: { tax, interest: c === 1 && m === '2026-06' ? 410 : 0 } }, { org, actor: INITIATOR, illustrative: true });
      if (!(c === 1 && m === '2026-09')) {                                                                       // Gamma Sep: no challan copy → queue
        const fl = await sampleFile(files, e, 'challan', `SAMPLE_${e.short_code}_TDS_challan_${m}.txt`, `ITNS 281N challan BSR 0510308 serial ${ch.challan_serial} dated ${paid}: ₹${ch.total}`);
        ch.evidence.push(fl.id); AT.addLink(fl, { module: 'tds_challan', id: ch.id });
      }
      for (const [code, amt] of amounts) TDS.allocate(tds, { challan_id: ch.id, liability_month: m, act: ch.act, section_code: code, principal: amt, nature: old ? '' : 'Payments to contractors' }, { actor: INITIATOR });
      if (ch.evidence.length && mi % 2 === 0) { TDS.review(tds, ch.id, 'submit', '', INITIATOR); TDS.review(tds, ch.id, 'approve', 'Illustrative review', APPROVER); }
    }
  }

  // ── Reconciliation inputs (from the demo's illustrative cases) ──
  const save = (input, by = INITIATOR) => R.save(recon, input, { org, actor: by, illustrative: true });
  const gstA = regOf(A, 'GST_REGULAR', 'GJ'), gstC = regOf(C, 'GST_REGULAR');
  for (const [c, e, reg] of [[0, A, gstA], [1, C, gstC]]) for (const m of ['2026-08', '2026-09', '2026-10']) {
    const base = 100000 + c * 40000 + (+m.slice(5) - 8) * 15000;
    save({ type: 'GST', entity_id: e.id, registration_id: reg.id, month: m, notes: 'Invented review scenario; not a real return.',
      values: { arn1: 'ILL-G1', arn3: 'ILL-3B', ledgerRef: 'ILL-LEDGER', scope: 'Comparable outward tax only', adjustReason: 'Example timing reconciliation' },
      rows: R.GST_HEADS.map((head, i) => { const n = i === 3 ? 0 : base, delta = c === 0 && m === '2026-10' && i === 0 ? 5000 : c === 0 && m === '2026-10' && i === 1 ? -2000 : 0; return { head, g1: n, g1a: 0, adjust: 0, declared: n - delta, cash: (n - delta) * 0.3, credit: (n - delta) * 0.7, otherCash: 0, otherCredit: 0, totalLiability: n - delta }; }) });
  }
  for (const m of ['2026-08', '2026-09', '2026-10']) for (const v of [0, 1]) {
    const mm = +m.slice(5);
    save({ type: 'VENDOR', entity_id: A.id, registration_id: gstA.id, month: m, notes: 'Invented assessment',
      values: { vendor: ['Illustrative supplier A', 'Illustrative supplier B'][v], vendorGstin: `DEMO-SUPPLIER-${v + 1}`, s1: v && mm === 10 ? 'Not filed' : 'On time', s3: mm === 10 ? 'Not due' : v ? 'Late' : 'On time',
        due1: `2026-${pad(mm + 1)}-11`, file1: v && mm === 10 ? '' : `2026-${pad(mm + 1)}-10`, due3: `2026-${pad(mm + 1)}-20`, file3: mm === 10 ? '' : `2026-${pad(mm + 1)}-${v ? '23' : '18'}`, checked: '2026-11-14', source: 'Illustrative only',
        invoiceRef: 'ILL-INVOICES', invoiceITC: 100000, reflected: v ? 60000 : 100000, eligible: v ? 50000 : 95000, vendorHold: v ? 40000 : 0, blocked: 5000, otherHold: v ? 5000 : 0, holdReason: 'Illustrative reviewer attribution; status dates shown only as sample' } });
  }
  const pfA = regOf(A, 'PF'), esiA = regOf(A, 'ESIC'), tanA = regOf(A, 'TAN'), ptA = regOf(A, 'PT_PTRC', 'MH');
  const pfRec = save({ type: 'PF', entity_id: A.id, registration_id: pfA.id, month: '2026-10', values: { reference: 'ILL-TRRN', payrollRef: 'ILL-PAYROLL', pAdmin: 500, pEdli: 150, pOther: 0, eAdmin: 500, eEdli: 150, eOther: 0, challan: 7730, paid: 7730, paidDate: '2026-11-12' },
    rows: [{ employee: 'DEMO-EMP-01', pGross: 24000, pBasic: 16000, pWage: 15000, pEE: 1800, pER: 550, pEPS: 1250, eGross: 24000, eWage: 15000, eEE: 1800, eER: 550, eEPS: 1250 }, { employee: 'DEMO-EMP-02', pGross: 22000, pBasic: 15000, pWage: 15000, pEE: 1800, pER: 550, pEPS: 1250, eGross: 22000, eWage: 14000, eEE: 1680, eER: 550, eEPS: 1250 }] });
  save({ type: 'ESIC', entity_id: A.id, registration_id: esiA.id, month: '2026-10', values: { reference: 'ILL-ESI', payrollRef: 'ILL-PAYROLL', eeRate: 0.75, erRate: 3.25, rounding: 'Next rupee', rateSource: 'Illustrative default rates; review required', challanEE: 225, challanER: 925, paid: 1150, paidDate: '2026-11-13' },
    rows: [{ employee: 'DEMO-EMP-01', covered: 'Yes', eeExempt: 'No', erExempt: 'No', wage: 20000, pEE: 150, pER: 650, portalEE: 150, portalER: 650 }, { employee: 'DEMO-EMP-02', covered: 'Yes', eeExempt: 'No', erExempt: 'No', wage: 10000, pEE: 75, pER: 325, portalEE: 75, portalER: 275 }] });
  const augAllocs = tds.allocations.filter(a => a.entity_id === A.id && a.liability_month === '2026-08');
  save({ type: 'TDS', entity_id: A.id, registration_id: tanA.id, month: '2026-08', values: { reference: 'ILL-TDS-WORKING-AUG', returnRef: '' },
    rows: [...augAllocs.map(a => ({ act: a.act, code: a.section_code, alias: a.legacy_ref, liability: a.principal + 1200 })), { act: '1961', code: '194-I(b)', alias: '194-I', liability: 15000 }] });
  save({ type: 'PT', entity_id: A.id, registration_id: ptA.id, month: '2026-10', values: { state: 'MH', employees: 22, payrollWages: 880000, deducted: 4400, assessed: 4400, paid: 4200, reference: 'ILL-PT-CH', returnRef: '', paidDate: '2026-11-10', ruleSource: 'Illustrative — confirm Maharashtra slab and periodicity' } });
  const pfFile = await sampleFile(files, A, 'ecr_source', 'SAMPLE_ALPHA_ECR_2026-10.txt', 'Illustrative ECR text');
  pfRec.evidence.push(pfFile.id); AT.addLink(pfFile, { module: 'recon', id: pfRec.id });
  R.transition(recon, pfRec.id, 'submit', { org, actor: INITIATOR });

  // ── Payroll import batch (PF, Alpha, Oct 2026) ──
  const payrollRows = [['100000000101', 'Illustrative Employee 1', 24000, 16000, 15000, 1800, 550, 1250], ['100000000102', 'Illustrative Employee 2', 22000, 15000, 15000, 1800, 550, 1250], ['100000000103', 'Illustrative Employee 3', 30000, 18000, 15000, 1800, 550, 1250], ['100000000104', 'Illustrative Employee 4', 12000, 8000, 0, 0, 0, 0]]
    .map(([key, name, gross, basic, wage, ee, er, eps], i) => ({ key, name, gross, basic, wage, ee, er, eps, source_row: i + 2 }));
  const ecrText = [['100000000101', 'Illustrative Employee 1', 24000, 15000, 15000, 15000, 1800, 1250, 550, 0, 0], ['100000000102', 'Illustrative Employee 2', 22000, 14000, 14000, 14000, 1680, 1250, 430, 0, 0], ['100000000105', 'Illustrative Employee 5', 18000, 15000, 15000, 15000, 1800, 1250, 550, 0, 0]].map(r => r.join('#~#')).join('\n');
  const payFile = await sampleFile(files, A, 'payroll_source', 'SAMPLE_ALPHA_payroll_2026-10.csv', 'Illustrative payroll extract');
  const ecrFile = await sampleFile(files, A, 'ecr_source', 'SAMPLE_ALPHA_ECR_member_2026-10.txt', ecrText);
  const batch = MI.create(imports, { entity_id: A.id, registration_id: pfA.id, fund: 'PF', month: '2026-10',
    payroll: { file_id: payFile.id, name: payFile.original_name, sha256: payFile.sha256, sheet: 'Sheet1', header_row: 1, mapping: { key: 0, name: 1, gross: 2, basic: 3, wage: 4, ee: 5, er: 6, eps: 7 }, rows: payrollRows },
    returns: { file_id: ecrFile.id, name: ecrFile.original_name, sha256: ecrFile.sha256, format: 'ecr_txt', rows: MI.parseEcr(ecrText) } }, { org, actor: INITIATOR });
  batch.illustrative = true;

  // ── Tax audit (FY 2025-26, Alpha) ──
  const lot = x => TA.saveLot(taxaudit, { entity_id: A.id, fy: '2025-26', registration_id: pfA.id, opening: false, month: '2025-04', received: '2025-04-30', baseline: '2025-05-15', due_source: 'Illustrative approved baseline; not a real notification', due_verified: true, deduction: 'yes', notes: 'Illustrative amounts and dates only', ...x }, { org, actor: INITIATOR });
  const l1 = lot({ kind: 'Employee PF', amount: 10000 });
  const l2 = lot({ kind: 'Employee ESIC', registration_id: esiA.id, amount: 2000 });
  const l3 = lot({ kind: 'Employer EPF', amount: 20000, opening: true, month: '2025-03', received: '2025-03-31', prior: 'Previously not allowable (disallowed in FY 2024-25)' });
  const l4 = lot({ kind: 'Employer EPF', month: '2026-03', received: '2026-03-01', baseline: '2026-04-15', amount: 50000 });
  const l5 = lot({ kind: 'Professional Tax · PTRC', registration_id: ptA.id, state: 'MH', amount: 3000, deduction: 'no', month: '2026-03', received: '2026-03-01', baseline: '2026-04-30' });
  for (const l of [l1, l2, l3, l4, l5]) TA.approveLot(taxaudit, l.id, APPROVER);
  const proof = await sampleFile(files, A, 'bank_proof', 'SAMPLE_ALPHA_bank_statement_extract.txt', 'Illustrative bank statement lines');
  const pay = (ref, paid, amount, l) => { const p = TA.savePayment(taxaudit, { entity_id: A.id, reference: ref, paid_date: paid, basis: 'paid_challan', total: amount, proof: [proof.id], allocations: [{ lot_id: l.id, amount }] }, { org, actor: INITIATOR }); TA.verifyPayment(taxaudit, p.id, true, APPROVER); return p; };
  pay('ILL-P1', '2025-05-15', 6000, l1); pay('ILL-P2', '2025-05-20', 3000, l1); pay('ILL-P3', '2025-05-20', 2000, l2); pay('ILL-P4', '2025-08-10', 8000, l3); pay('ILL-P5', '2026-03-25', 30000, l4); pay('ILL-P6', '2026-08-10', 15000, l4); pay('ILL-P7', '2026-05-10', 3000, l5);
  TA.saveSettings(taxaudit, { entity_id: A.id, fy: '2025-26', cutoff: '2026-10-31', source: 'Illustrative cut-off only; not the actual statutory deadline' }, INITIATOR);
  TA.saveSettings(taxaudit, { entity_id: A.id, fy: '2025-26', cutoff: '2026-10-31', source: 'Illustrative cut-off only; not the actual statutory deadline', confirmed: true }, APPROVER);

  // ── Compliance Updates: curated reference entries, monitor off ──
  UP.seedSources(updates);
  for (const s of updates.sources) s.enabled = false;
  for (const c of CURATED) {
    const u = UP.add(updates, { ...c, entity_ids: c.topic === 'Professional Tax' ? [A.id] : [] }, { org, actor: { id: 'demo-curator', name: 'Curated reference (demo)' }, curated: true });
    UP.addAction(updates, { update_id: u.id, title: c.action, owner_id: null, deadline: null }, { actor: { name: 'Curated reference (demo)' }, users: [] });
  }

  return { files, payments, tds, recon, imports, taxaudit, updates };
}

module.exports = { build, CURATED };
