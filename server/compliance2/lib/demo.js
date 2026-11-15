/**
 * The DEMO space: ILLUSTRATIVE entities, registrations, decisions, tasks and sample files — none of it is real master data,
 * a real filing, a real payment or a verified legal rule. Every record is marked illustrative / sample, names start with
 * "Illustrative", PANs start with ZZZ, and amounts are invented.
 *
 * It shows: two companies and an LLP (one listed), several GSTINs including two in the same state (one monthly, one QRMP),
 * TAN / PF / ESIC / PT registrations (Gujarat has a draft PT rule, Maharashtra none → missing-rule queue), a director shared
 * by two companies (one DIR-3 KYC task), an AGM driving AOC-4 / MGT-7 dates, a notice with its reply date, a material event
 * with an hours-based time, completed filings with sample evidence, one late filing, items in review and missing evidence.
 *
 * The demo has a fixed snapshot date ("today" for the demo), shown on every demo screen.
 */

'use strict';

const U = require('./util');
const V = require('./validate');
const ORG = require('./org');
const RU = require('./rules');
const AP = require('./applicability');
const T = require('./tasks');
const W = require('./workflow');
const DOC = require('./documents');

const SEED_ACTOR = { id: 'demo-seed', name: 'Demo seed (illustrative data)', rights: { master: true } };
// the two working roles: the Initiator prepares and records the filing; the Approver checks the pack and closes
const INITIATOR = { id: 'demo-initiator-seed', name: 'Initiator (demo persona)', rights: { prepare: true, file: true } };
const APPROVER = { id: 'demo-approver-seed', name: 'Approver (demo persona)', rights: { review: true, verify: true, approve: true } };

const gstin = (state, pan, n) => { const f = `${state}${pan}${n}Z`; return f + V.gstinCheckChar(f); };

function fixedSnapshot() {
  const t = U.todayIST();
  return t >= '2026-04-15' && t <= '2027-03-31' ? t : '2026-11-14';
}

function buildOrg() {
  const org = ORG.EMPTY();
  org.groups = [{ id: 'G-1', name: 'Illustrative group (demo)' }];
  const ent = (x) => ORG.upsert(org, 'entity', x, { actor: SEED_ACTOR, illustrative: true }).record;
  const A = ent({ legal_name: 'Illustrative Alpha Workspaces Pvt Ltd', short_code: 'ALPHA', type: 'PRIVATE', pan: 'ZZZCA9001K', cin: 'U74999GJ2019PTC100001', listed: false, incorporation_date: '2019-06-12',
    flags: { has_employees: true, has_exports: true, has_msme_dues_over_45_days: true, has_deposit_or_loan_receipts: false, has_fdi: false, has_odi: false, has_ecb: false, has_international_transactions: false, has_specified_domestic_transactions: false, has_reportable_sft: false, cost_audit_sector: false, secretarial_audit_required: false },
    fy_facts: { '2025-26': { turnover: 4500000000, net_worth: 1200000000, net_profit: 80000000, paid_up_capital: 50000000, headcount: 107, tax_audit_required: true, source: 'Illustrative figures' }, '2026-27': { tax_audit_required: true, source: 'Illustrative' } } });
  const B = ent({ legal_name: 'Illustrative Beta Design LLP', short_code: 'BETA', type: 'LLP', pan: 'ZZZFB9002L', llpin: 'AAB-1234', incorporation_date: '2021-02-01',
    flags: { has_employees: true, has_exports: false, has_fdi: false, has_odi: false, has_ecb: false, has_international_transactions: false, has_specified_domestic_transactions: false, has_reportable_sft: false },
    fy_facts: { '2026-27': { tax_audit_required: false, source: 'Illustrative' } } });
  const C = ent({ legal_name: 'Illustrative Gamma Listed Ltd', short_code: 'GAMMA', type: 'PUBLIC', pan: 'ZZZCC9003M', cin: 'L72200MH2010PLC100003', listed: true, listing_type: 'equity', exchanges: ['NSE', 'BSE'], incorporation_date: '2010-03-15',
    flags: { has_employees: true, has_exports: false, has_fdi: true, has_odi: false, has_ecb: false, has_msme_dues_over_45_days: false, has_deposit_or_loan_receipts: true, has_international_transactions: true, has_reportable_sft: false, secretarial_audit_required: true, cost_audit_sector: false },
    fy_facts: { '2025-26': { turnover: 9800000000, net_worth: 6000000000, net_profit: 450000000, source: 'Illustrative figures' }, '2026-27': { tax_audit_required: true, source: 'Illustrative' } } });
  const est = (x) => ORG.upsert(org, 'establishment', x, { actor: SEED_ACTOR, illustrative: true }).record;
  const aAhd = est({ entity_id: A.id, name: 'Alpha — Ahmedabad hub', kind: 'office', state: 'GJ', city: 'Ahmedabad', headcount: 85, flags: { engages_contract_labour: true, pays_property_tax: false } });
  const aPune = est({ entity_id: A.id, name: 'Alpha — Pune office', kind: 'office', state: 'MH', city: 'Pune', headcount: 22, flags: { engages_contract_labour: false, pays_property_tax: false } });
  est({ entity_id: B.id, name: 'Beta studio', kind: 'office', state: 'KA', city: 'Bengaluru', headcount: 14, flags: { engages_contract_labour: false, pays_property_tax: false } });
  est({ entity_id: C.id, name: 'Gamma head office', kind: 'office', state: 'DL', city: 'New Delhi', headcount: 140, flags: { engages_contract_labour: true, pays_property_tax: true } });
  const reg = (x) => ORG.upsert(org, 'registration', x, { actor: SEED_ACTOR, illustrative: true }).record;
  reg({ entity_id: A.id, type: 'GST_REGULAR', number: gstin('24', A.pan, '1'), state: 'GJ', filing_frequency: 'monthly', regime: 'regular', active_from: '2019-07-01', establishment_ids: [aAhd.id], jurisdiction: 'Illustrative jurisdiction' });
  reg({ entity_id: A.id, type: 'GST_REGULAR', number: gstin('24', A.pan, '2'), state: 'GJ', filing_frequency: 'quarterly', regime: 'qrmp', active_from: '2023-04-01', flags: { uses_iff: true }, notes: 'Second Gujarat registration (separate business vertical) — illustrative' });
  reg({ entity_id: A.id, type: 'GST_REGULAR', number: gstin('27', A.pan, '1'), state: 'MH', filing_frequency: 'monthly', regime: 'regular', active_from: '2022-01-01', establishment_ids: [aPune.id] });
  reg({ entity_id: A.id, type: 'TAN', number: 'AHMZ90001A', active_from: '2019-07-01', flags: { deducts_salary: true, deducts_non_salary: true, deducts_non_resident: false, collects_tcs: false } });
  reg({ entity_id: A.id, type: 'PF', number: 'GJAHD0090001000', state: 'GJ', active_from: '2019-09-01' });
  reg({ entity_id: A.id, type: 'ESIC', number: '37000123450000999', state: 'GJ', active_from: '2019-09-01' });
  reg({ entity_id: A.id, type: 'PT_PTRC', number: 'ILLUS-GJ-PTRC-001', state: 'GJ', filing_frequency: 'monthly', active_from: '2019-09-01' });
  reg({ entity_id: A.id, type: 'PT_PTRC', number: 'ILLUS-MH-PTRC-002', state: 'MH', filing_frequency: 'monthly', active_from: '2022-01-01' });
  reg({ entity_id: A.id, type: 'LWF', number: 'ILLUS-GJ-LWF-003', state: 'GJ', filing_frequency: 'half_yearly', active_from: '2019-09-01' });
  reg({ entity_id: A.id, type: 'TRADE_LICENCE', number: 'ILLUS-AMC-TL-0001', state: 'GJ', active_from: '2024-02-01', active_to: '2027-01-31', authority: 'Illustrative municipal corporation' });
  reg({ entity_id: B.id, type: 'GST_REGULAR', number: gstin('29', B.pan, '1'), state: 'KA', filing_frequency: 'quarterly', regime: 'qrmp', active_from: '2021-03-01', flags: { uses_iff: false } });
  reg({ entity_id: B.id, type: 'TAN', number: 'BLRZ90002B', active_from: '2021-03-01', flags: { deducts_salary: true, deducts_non_salary: true, deducts_non_resident: false, collects_tcs: false } });
  reg({ entity_id: C.id, type: 'GST_REGULAR', number: gstin('07', C.pan, '1'), state: 'DL', filing_frequency: 'monthly', regime: 'regular', active_from: '2017-07-01' });
  reg({ entity_id: C.id, type: 'TAN', number: 'DELZ90003C', active_from: '2010-04-01', flags: { deducts_salary: true, deducts_non_salary: true, deducts_non_resident: true, collects_tcs: false } });
  reg({ entity_id: C.id, type: 'PF', number: 'DLCPM0090003000', state: 'DL', active_from: '2010-06-01' });
  reg({ entity_id: C.id, type: 'ESIC', number: '10000123450000777', state: 'DL', active_from: '2010-06-01' });
  const per = (x) => ORG.upsert(org, 'person', x, { actor: SEED_ACTOR, illustrative: true }).record;
  per({ name: 'Illustrative Director One', din: '90000001', dsc_expiry: '2027-02-15', roles: [{ entity_id: A.id, designation: 'Director' }, { entity_id: C.id, designation: 'Director' }] });
  per({ name: 'Illustrative Partner Two', din: '90000002', dsc_expiry: '2028-05-30', roles: [{ entity_id: B.id, designation: 'Designated partner' }] });
  return { org, A, B, C };
}

function buildEvents(org, { A, C }) {
  const ev = { events: [] };
  const add = x => { const { value, errors } = T.cleanEvent(x, org); if (errors.length) throw new Error(`demo event: ${errors.join('; ')}`); const e = { id: U.uid('V-'), ...value, illustrative: true, created_at: U.nowIso(), created_by: SEED_ACTOR.name, history: [] }; ev.events.push(e); return e; };
  const mh = org.registrations.find(r => r.entity_id === A.id && r.state === 'MH' && r.type === 'GST_REGULAR');
  add({ entity_id: A.id, type: 'AGM', title: 'AGM adopting FY 2025-26 accounts (illustrative)', event_date: '2026-09-26', fy: '2025-26' });
  add({ entity_id: C.id, type: 'AGM', title: 'AGM adopting FY 2025-26 accounts (illustrative)', event_date: '2026-09-20', fy: '2025-26' });
  add({ entity_id: A.id, registration_id: mh.id, type: 'NOTICE', title: 'Illustrative scrutiny notice (ASMT-10 style)', event_date: '2026-10-20', response_due: '2026-11-19', reference: 'ILLUSTRATIVE/NOTICE/001', authority: 'Illustrative GST office' });
  add({ entity_id: C.id, type: 'MATERIAL_EVENT', title: 'Illustrative material contract signed', event_date: '2026-11-10', event_at: '2026-11-10T19:15:00+05:30', reference: 'ILLUSTRATIVE/REG30/001' });
  return ev;
}

/** Applicability: records the suggestion as an illustrative decision where the facts decide it; leaves "needs review" open */
function buildDecisions(org, rulesDoc, fys) {
  const applic = { records: [] };
  const explicit = { 'GST-R9': 'applicable', 'GST-R9C': 'applicable' };
  for (const fy of fys) {
    const { start, end } = U.fyBounds(fy);
    for (const rule of rulesDoc.rules) {
      const vf = RU.versionFor(rule, start, { live: false });
      for (const scope of AP.scopesFor(rule, org, { start, end })) {
        const sType = AP.decisionScopeType(rule);
        const sId = sType === 'entity' ? scope.entity_id : scope.scope_id;
        if (AP.decisionOn(applic.records, rule.id, sType, sId, start)) continue;
        const sug = AP.suggest(vf.version, scope, fy);
        let status = sug.status;
        if (status === 'needs_review' && explicit[rule.id] && scope.entity.short_code === 'ALPHA') status = explicit[rule.id];
        if (status === 'needs_review') continue;                         // left undecided on purpose: shows as a coverage gap
        AP.record(applic, rulesDoc, org, { rule_id: rule.id, scope_type: sType, scope_id: sId, status, effective_from: '2017-04-01',
          reason: `ILLUSTRATIVE demo decision — ${status === sug.status ? `suggested by the rule test: ${sug.trace.join('; ') || 'always applies to this scope'}` : 'entered for the demo'}`, basis: 'demo' }, SEED_ACTOR);
      }
    }
  }
  return applic;
}

function sampleFile(task, entity, reg, docType, extra = '') {
  const lines = ['ILLUSTRATIVE SAMPLE — NOT A REAL DOCUMENT', `Document: ${docType}`, `Entity: ${entity.legal_name} (PAN ${entity.pan})`,
    reg ? `${reg.type === 'TAN' ? 'TAN' : reg.type.startsWith('GST') ? 'GSTIN' : 'Registration'}: ${reg.number}` : '', `Obligation: ${task.rule_name}`,
    `Period: ${task.period_label} (${U.MONTHS_LONG[+task.period_start.slice(5, 7) - 1]} ${task.period_start.slice(0, 4)})`, `Task: ${task.id}`, extra];
  return { buffer: Buffer.from(lines.filter(Boolean).join('\n'), 'utf8'), originalname: `SAMPLE_${entity.short_code}_${task.rule_id}_${task.period_key.replace(/[:]/g, '-')}_${docType}.txt` };
}

async function addSample(ctx, task, docType, extra) {
  const ent = ctx.org.entities.find(e => e.id === task.entity_id);
  const reg = task.registration_id ? ctx.org.registrations.find(r => r.id === task.registration_id) : null;
  const prepared = await DOC.prepare('demo', sampleFile(task, ent, reg, docType, extra), { generatedSample: true });
  DOC.add(ctx.docs, { prepared, task, entity: ent, registration: reg, doc_type: docType, actor: INITIATOR, sample: true });
}
const docsOf = (ctx, t) => ctx.docs.documents.filter(d => d.task_ids.includes(t.id));
const step = (ctx, t, action, input, actor) => W.act(t, action, { ...input, rev: t.rev }, { actor, docs: docsOf(ctx, t), nowMs: Date.now() });

/** Takes a task through the full workflow with sample evidence; filedOn decides on time / late */
async function completeTask(ctx, t, filedOn, { stopAt } = {}) {
  if ((t.evidence_rule.review || []).length) await addSample(ctx, t, 'working');
  step(ctx, t, 'submit', {}, INITIATOR);
  if (stopAt === 'ready_for_review') return;
  step(ctx, t, 'approve_filing', { note: 'Illustrative check' }, APPROVER);
  if (stopAt === 'approved_to_file') return;
  const payment = ['payment', 'return_payment'].includes(t.nature)
    ? { date: filedOn, ref_type: t.payment_ref === 'TDS' ? 'CIN' : t.payment_ref === 'PF' ? 'TRRN' : 'CHALLAN', reference: `ILLUS-${t.rule_id}-${t.period_key.slice(2).replace(/[:]/g, '')}`, bsr_code: t.payment_ref === 'TDS' ? '0001234' : '', challan_serial: t.payment_ref === 'TDS' ? '00042' : '', amounts: { tax: 10000 + (t.period_start.charCodeAt(6) % 9) * 1250, interest: 0, late_fee: 0, penalty: 0, other: 0 } }
    : undefined;
  step(ctx, t, 'record_filing', { filing: { filed_at: `${filedOn}T15:30:00+05:30`, ack_no: t.nature === 'payment' || t.internal ? '' : `ILLUS-ACK-${t.period_key.slice(2).replace(/[:]/g, '')}`, payment, portal_status: 'Filed (illustrative)', remarks: 'Illustrative demo filing' } }, INITIATOR);
  if (stopAt === 'filed') return;
  for (const k of T.requiredDocs(t)) if (!docsOf(ctx, t).some(d => d.doc_type === k)) await addSample(ctx, t, k);
  step(ctx, t, 'verify_close', { ack_verified: true, note: 'Illustrative verification' }, APPROVER);
}

/** Builds the whole demo space in memory (sample files are written to the demo file store). */
async function build() {
  const snapshot = fixedSnapshot();
  const { org, A } = buildOrg();
  const rulesDoc = RU.EMPTY();
  RU.seed(rulesDoc);
  const events = buildEvents(org, buildOrgRefs(org));
  const applic = buildDecisions(org, rulesDoc, ['2025-26', '2026-27']);
  const team = { rows: [{ id: 'TM-demo', entity_id: '*', category: '*', owner_id: 'demo:initiator', backup_owner_id: '', checker_id: 'demo:approver' }] };
  const names = { 'demo:initiator': 'Initiator (demo)', 'demo:approver': 'Approver (demo)' };
  const tasksDocs = {};
  const gen = (fy, ruleIds) => T.generate({ org, rulesDoc, applic, events, team, tasksDocs, fy, ruleIds, live: false, actor: SEED_ACTOR, nameOf: id => names[id] || '' });
  const g27 = gen('2026-27');
  const g26 = gen('2025-26', ['ROC-AOC4', 'ROC-MGT7']);
  const ctx = { org, docs: { documents: [] } };
  // completed months for Alpha's monthly Gujarat GSTIN, TAN, PF and ESIC
  const a = org.registrations.filter(r => r.entity_id === A.id);
  const gjMonthly = a.find(r => r.type === 'GST_REGULAR' && r.state === 'GJ' && r.filing_frequency === 'monthly');
  const pick = (rule, reg, key) => tasksDocs['2026-27'].tasks.find(t => t.rule_id === rule && t.registration_id === reg.id && t.period_key === key);
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  for (const m of months) {
    for (const [rule, reg] of [['GST-R1-M', gjMonthly], ['GST-3B-M', gjMonthly], ['TDS-DEP', a.find(r => r.type === 'TAN')], ['PF-ECR', a.find(r => r.type === 'PF')], ['PF-PAY', a.find(r => r.type === 'PF')], ['ESI-PAY', a.find(r => r.type === 'ESIC')]]) {
      const t = pick(rule, reg, `M:${m}`);
      if (!t || !t.original_due || t.original_due >= snapshot) continue;
      const late = rule === 'GST-R1-M' && m === '2026-07';
      const missingProof = rule === 'ESI-PAY' && m === '2026-09';
      await completeTask(ctx, t, late ? U.addDays(t.original_due, 2) : U.addDays(t.original_due, -1), { stopAt: missingProof ? 'filed' : undefined });
    }
  }
  const oct3b = pick('GST-3B-M', gjMonthly, 'M:2026-10');
  if (oct3b) await completeTask(ctx, oct3b, null, { stopAt: 'ready_for_review' });
  const octEcr = pick('PF-ECR', a.find(r => r.type === 'PF'), 'M:2026-10');
  if (octEcr) await completeTask(ctx, octEcr, null, { stopAt: 'approved_to_file' });
  // one document that mentions another GSTIN — shows the human-review mismatch flag
  const may1 = pick('GST-R1-M', gjMonthly, 'M:2026-05');
  if (may1) {
    const t = may1;
    const ent = org.entities.find(e => e.id === t.entity_id);
    const wrong = gstin('27', ent.pan, '1');
    const prepared = await DOC.prepare('demo', { buffer: Buffer.from(`ILLUSTRATIVE SAMPLE — NOT A REAL DOCUMENT\nSupporting working for GSTIN ${wrong}\nPeriod: May 2026`), originalname: `SAMPLE_${ent.short_code}_mismatch_example.txt` }, { generatedSample: true });
    t.locked = false;                                                      // seed only: attach to the already-closed sample task
    DOC.add(ctx.docs, { prepared, task: t, entity: ent, registration: gjMonthly, doc_type: 'other', actor: INITIATOR, sample: true });
    t.locked = true;
  }
  return {
    org, rules: rulesDoc, applic, events, team, docs: ctx.docs, tasksDocs,
    meta: { initialised_at: U.nowIso(), snapshot_date: snapshot, illustrative: true, generated: { '2026-27': g27.created.length, '2025-26': g26.created.length, blocked: g27.blocked.length } },
  };
}

function buildOrgRefs(org) {
  const by = code => org.entities.find(e => e.short_code === code);
  return { A: by('ALPHA'), B: by('BETA'), C: by('GAMMA') };
}

module.exports = { build, SEED_ACTOR, gstin, fixedSnapshot };
