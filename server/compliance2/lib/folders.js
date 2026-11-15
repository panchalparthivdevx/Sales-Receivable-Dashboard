/**
 * The approved OneDrive folder structure (V4) — planned from the masters, and where each uploaded document belongs.
 *
 *   Finance & Compliance / <Company legal name> / FY 2026-27 / <category> / <registration> / <period> / <document type>
 *
 * Categories (inside every financial year): 01_Financials … 09_Notices_and_Correspondence, exactly as approved. GST has a
 * folder per GSTIN (State_GSTIN), TDS per TAN, PF per establishment code, ESIC per employer code, PT per state and
 * registration. Payment / challan folders are created only when a real payment document is uploaded. Consolidated
 * financials only where the entity is marked as preparing them.
 *
 * Every folder has a KEY built from immutable ids ("E:<entity id>|FY:2026-27|C:gst|R:<registration id>|P:M:2026-04|D:04_GSTR-3B").
 * The key is the folder's identity; its name is only a label — a renamed company keeps its folder (and its mapping).
 *
 * A document is filed by its COMPLIANCE period (a March 2027 TDS deposit paid in April 2027 stays in FY 2026-27 / 2027-03_March).
 */

'use strict';

const U = require('./util');
const V = require('./validate');
const DE = require('./dueEngine');

const ROOT_NAME = 'Finance & Compliance';
const CATS = {
  financials: '01_Financials', gst: '02_GST', tds: '03_TDS', pf: '04_Provident_Fund', esic: '05_ESIC', pt: '06_Professional_Tax',
  other_pay: '07_Other_Payment_Advice', register: '08_Compliance_Register', notices: '09_Notices_and_Correspondence',
};
const GST_DOCS = ['01_GSTR-1', '02_GSTR-1A', '03_GSTR-2B', '04_GSTR-3B', '05_GST_Payments', '06_Supporting_Documents'];
const FIN_DOCS = ['01_Source_Data', '02_Workings', '03_Review_Drafts', '04_Final_Approved', '05_Signed_and_Audit_Reports'];
const FIN_PERIODS = [['monthly', '01_Monthly'], ['quarterly', '02_Quarterly'], ['half_yearly', '03_Half_Yearly'], ['annual', '04_Annual']];
const OTHER_PAY = ['01_Vendors', '02_Rent_and_Landlords', '03_Salary_and_Reimbursements', '04_Loans_and_Interest', '05_Other_Payments'];
const TDS_PARTS = { monthly: '01_Monthly_Payments', quarterly: '02_Quarterly_Returns', certificates: '03_TDS_Certificates', reco: '04_Reconciliations' };
const GST_REG_TYPES = ['GST_REGULAR', 'GST_COMPOSITION', 'GST_ISD', 'GST_TDS', 'GST_TCS', 'GST_NRTP', 'GST_OIDAR', 'GST_CASUAL'];

// ── Names ─────────────────────────────────────────────────────────────────────
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** A folder / file name OneDrive accepts: no " * : < > ? / \ |, no leading / trailing spaces or dots, no reserved names */
function safeName(raw, max = 120) {
  let s = String(raw ?? '').replace(/[\u0000-\u001f"*:<>?/\\|]/g, '_').replace(/_vti_/gi, '_vti').replace(/\s+/g, ' ').trim();
  s = s.replace(/^~\$/, '_').replace(/[. ]+$/g, '').replace(/^[. ]+/, '');
  if (!s) s = '_';
  if (RESERVED.test(s.split('.')[0])) s = `${s}_`;
  return s.slice(0, max).replace(/[. ]+$/g, '') || '_';
}
const stateName = abbr => (V.stateOf(abbr)?.name || abbr || 'Unknown_State').replace(/\s+/g, '_');
const fyName = fy => `FY ${fy}`;
function periodName(p) {
  if (p.kind === 'month') return `${p.start.slice(0, 7)}_${U.MONTHS_LONG[+p.start.slice(5, 7) - 1]}`;
  if (p.kind === 'quarter') return { Q1: 'Q1_Apr-Jun', Q2: 'Q2_Jul-Sep', Q3: 'Q3_Oct-Dec', Q4: 'Q4_Jan-Mar' }[p.quarter];
  if (p.kind === 'half') return p.half === 'H1' ? 'H1_Apr-Sep' : 'H2_Oct-Mar';
  if (p.kind === 'year') return `FY_${p.fy}`;
  return safeName(p.label || p.key);
}
const regFolder = r => (GST_REG_TYPES.includes(r.type) ? `${stateName(r.state)}_${r.number}` : r.type === 'PT_PTEC' ? `Entity_Enrolment_${r.number}` : r.type === 'PT_PTRC' ? `Employer_Deduction_${r.number}` : r.number);

// ── Plan ──────────────────────────────────────────────────────────────────────
/**
 * Folders that should exist. opts: { fys, entityIds, trigger: 'saved' | 'approved', live }.
 * Returns { nodes: [{ key, parent, name, kind, entity_id }], pending: [{ key?, entity_id, text }] } — parents before children.
 */
function plan(org, { fys = [], entityIds, trigger = 'saved', live = true } = {}) {
  const nodes = [{ key: 'ROOT', parent: null, name: ROOT_NAME, kind: 'root' }];
  const pending = [];
  const add = (key, parent, name, kind, entity_id, extra) => { nodes.push({ key, parent, name: safeName(name), kind, entity_id, ...(extra || {}) }); return key; };
  // live: real master data only, as soon as it is saved or only once approved (setting); demo: illustrative, simulated folders
  const ok = rec => {
    if (rec.status === 'inactive') return false;
    if (!live) return true;
    if (rec.data_status === 'illustrative') return false;
    return trigger === 'saved' || rec.data_status === 'approved';
  };
  for (const e of org.entities) {
    if (entityIds && !entityIds.includes(e.id)) continue;
    if (!ok(e)) { if (e.status !== 'inactive') pending.push({ entity_id: e.id, text: `${e.legal_name}: not approved yet — folders are created on approval (setting)` }); continue; }
    const E = add(`E:${e.id}`, 'ROOT', e.legal_name, 'company', e.id, { label: e.legal_name });
    for (const fy of fys) {
      const { start, end } = U.fyBounds(fy);
      const F = add(`${E}|FY:${fy}`, E, fyName(fy), 'fy', e.id);
      const months = DE.periodsOf('monthly', fy), quarters = DE.periodsOf('quarterly', fy), halves = DE.periodsOf('half_yearly', fy), years = DE.periodsOf('annual', fy);
      const byFreq = { monthly: months, quarterly: quarters, half_yearly: halves, annual: years };
      const cat = c => add(`${F}|C:${c}`, F, CATS[c], 'category', e.id);
      // 01 Financials
      const fin = cat('financials');
      for (const [basis, label] of [['standalone', '01_Standalone'], ['consolidated', '02_Consolidated']]) {
        if (basis === 'consolidated' && e.flags?.consolidated_financials !== true) continue;
        const B = add(`${fin}|B:${basis}`, fin, label, 'folder', e.id);
        for (const [freq, flabel] of FIN_PERIODS) {
          const PR = add(`${B}|PR:${freq}`, B, flabel, 'folder', e.id);
          for (const p of byFreq[freq]) { const P = add(`${PR}|P:${p.key}`, PR, periodName(p), 'period', e.id); for (const d of FIN_DOCS) add(`${P}|D:${d}`, P, d, 'doc', e.id); }
        }
      }
      const regs = org.registrations.filter(r => r.entity_id === e.id && ok(r) && (!r.active_from || r.active_from <= end) && (!r.active_to || r.active_to >= start));
      // 02 GST — one folder per GSTIN (several in one state are separate)
      const gst = cat('gst');
      for (const r of regs.filter(x => GST_REG_TYPES.includes(x.type))) {
        const R = add(`${gst}|R:${r.id}`, gst, regFolder(r), 'registration', e.id);
        for (const p of months) { const P = add(`${R}|P:${p.key}`, R, periodName(p), 'period', e.id); for (const d of GST_DOCS) add(`${P}|D:${d}`, P, d, 'doc', e.id); }
        add(`${R}|ANNUAL`, R, 'Annual_Returns', 'folder', e.id);
      }
      // 03 TDS — one folder per TAN
      const tds = cat('tds');
      for (const r of regs.filter(x => x.type === 'TAN')) {
        const R = add(`${tds}|R:${r.id}`, tds, regFolder(r), 'registration', e.id);
        const M = add(`${R}|T:monthly`, R, TDS_PARTS.monthly, 'folder', e.id);
        for (const p of months) add(`${M}|P:${p.key}`, M, periodName(p), 'period', e.id);
        const Q = add(`${R}|T:quarterly`, R, TDS_PARTS.quarterly, 'folder', e.id);
        for (const p of quarters) add(`${Q}|P:${p.key}`, Q, periodName(p), 'period', e.id);
        add(`${R}|T:certificates`, R, TDS_PARTS.certificates, 'folder', e.id);
        const RC = add(`${R}|T:reco`, R, TDS_PARTS.reco, 'folder', e.id);
        for (const p of [...quarters, ...years]) add(`${RC}|P:${p.key}`, RC, p.kind === 'year' ? 'Annual' : periodName(p), 'period', e.id);
      }
      // 04 PF, 05 ESIC — per code, monthly
      for (const [c, type] of [['pf', 'PF'], ['esic', 'ESIC']]) {
        const C = cat(c);
        for (const r of regs.filter(x => x.type === type)) {
          const R = add(`${C}|R:${r.id}`, C, regFolder(r), 'registration', e.id);
          for (const p of months) add(`${R}|P:${p.key}`, R, periodName(p), 'period', e.id);
        }
      }
      // 06 PT — state → registration → its own periodicity (missing periodicity = pending, never guessed)
      const pt = cat('pt');
      for (const st of U.uniq(regs.filter(x => ['PT_PTRC', 'PT_PTEC'].includes(x.type)).map(x => x.state))) {
        const S = add(`${pt}|S:${st}`, pt, stateName(st), 'folder', e.id);
        for (const r of regs.filter(x => ['PT_PTRC', 'PT_PTEC'].includes(x.type) && x.state === st)) {
          const R = add(`${S}|R:${r.id}`, S, regFolder(r), 'registration', e.id);
          if (!byFreq[r.filing_frequency]) { pending.push({ key: R, entity_id: e.id, text: `${e.short_code} PT ${r.number} (${st}): periodicity not recorded — period folders wait for it` }); continue; }
          for (const p of byFreq[r.filing_frequency]) add(`${R}|P:${p.key}`, R, periodName(p), 'period', e.id);
        }
      }
      // 07 other payment advice — month → payment category
      const op = cat('other_pay');
      for (const p of months) { const P = add(`${op}|P:${p.key}`, op, periodName(p), 'period', e.id); for (const d of OTHER_PAY) add(`${P}|D:${d}`, P, d, 'doc', e.id); }
      cat('register');
      cat('notices');
    }
    for (const r of org.registrations.filter(x => x.entity_id === e.id && x.status !== 'inactive' && !ok(x))) pending.push({ entity_id: e.id, text: `${e.short_code} ${r.type} ${r.number}: not approved yet — its folders follow approval` });
  }
  return { nodes, pending };
}

// ── Where a document goes ─────────────────────────────────────────────────────
const CAT_OF = { GST: 'gst', 'TDS/TCS': 'tds', 'Provident Fund': 'pf', ESIC: 'esic', 'Professional Tax': 'pt', 'Notices & Litigation': 'notices' };
const TOKEN = { gst: 'GST', tds: 'TDS', pf: 'PF', esic: 'ESIC', pt: 'PT' };
const compact = s => String(s || '').replace(/[^A-Za-z0-9]/g, '');

/** The period folder of a task (QRMP quarters go in the quarter's last month, as the GST structure is monthly) */
function taskPeriod(t, registration) {
  const p = DE.periodFromKey(t.period_key);
  if (p) {
    if (p.kind === 'quarter' && registration && GST_REG_TYPES.includes(registration.type)) return DE.monthPeriod(+p.end.slice(0, 4), +p.end.slice(5, 7));
    return p;
  }
  return DE.monthPeriod(+t.period_start.slice(0, 4), +t.period_start.slice(5, 7));      // events / renewals: their month
}

/**
 * Folder chain (after the category folder) and file name for one document version.
 * → { keys: [{ key, parent, name }], file_name } or { unrouted: reason }
 */
function route({ task, doc, version, entity, registration, event }) {
  const c = CAT_OF[task.category];
  if (!c) return { unrouted: `The approved folder structure has no folder for ${task.category} documents yet` };
  const F = `E:${task.entity_id}|FY:${task.fy}`;
  const C = `${F}|C:${c}`;
  const chain = [];
  const push = (key, name) => { chain.push({ key, parent: chain.length ? chain[chain.length - 1].key : C, name: safeName(name) }); return key; };
  const pay = task.filing?.payment;
  const challan = pay?.reference ? safeName(`${pay.date || 'undated'}_${pay.reference}`) : null;
  const isPay = ['payment_proof', 'bank_advice'].includes(doc.doc_type);
  if (['gst', 'tds', 'pf', 'esic', 'pt'].includes(c) && !registration) return { unrouted: 'The task has no registration (GSTIN / TAN / code) to file it under' };
  if (c === 'gst') {
    const R = push(`${C}|R:${registration.id}`, regFolder(registration));
    const annual = DE.periodFromKey(task.period_key)?.kind === 'year';
    if (annual) push(`${R}|ANNUAL`, 'Annual_Returns');
    else {
      const p = taskPeriod(task, registration);
      const P = push(`${R}|P:${p.key}`, periodName(p));
      const sub = isPay || task.rule_id === 'GST-PMT06' ? '05_GST_Payments' : ['reconciliation', 'approval', 'source_data', 'other'].includes(doc.doc_type) && !/^GST-2B/.test(task.rule_id) ? '06_Supporting_Documents'
        : /^GST-(R1|IFF)/.test(task.rule_id) ? '01_GSTR-1' : /^GST-2B/.test(task.rule_id) ? '03_GSTR-2B' : /^GST-3B/.test(task.rule_id) ? '04_GSTR-3B' : '06_Supporting_Documents';
      const D = push(`${P}|D:${sub}`, sub);
      if (sub === '05_GST_Payments' && isPay && challan) push(`${D}|X:${challan}`, challan);
    }
  } else if (c === 'tds') {
    const R = push(`${C}|R:${registration.id}`, regFolder(registration));
    const p = taskPeriod(task, registration);
    if (task.rule_id === 'TDS-DEP') {
      const M = push(`${R}|T:monthly`, TDS_PARTS.monthly);
      const P = push(`${M}|P:${p.key}`, periodName(p));
      if (challan) push(`${P}|X:${challan}`, challan);
    } else if (task.rule_id === 'TDS-CERT') {
      const T = push(`${R}|T:certificates`, TDS_PARTS.certificates);
      const K = push(`${T}|K:${compact(task.form) || 'Certificates'}`, task.form || 'Certificates');
      push(`${K}|P:${p.key}`, periodName(p));
    } else if (doc.doc_type === 'reconciliation') {
      const T = push(`${R}|T:reco`, TDS_PARTS.reco);
      push(`${T}|P:${p.key}`, p.kind === 'year' ? 'Annual' : periodName(p));
    } else {
      const T = push(`${R}|T:quarterly`, TDS_PARTS.quarterly);
      const P = push(`${T}|P:${p.key}`, periodName(p));
      push(`${P}|K:${compact(task.form) || task.rule_id}`, task.form || task.rule_name);
    }
  } else if (c === 'pf' || c === 'esic') {
    const R = push(`${C}|R:${registration.id}`, regFolder(registration));
    const p = taskPeriod(task, registration);
    push(`${R}|P:${p.key}`, periodName(p));
  } else if (c === 'pt') {
    const S = push(`${C}|S:${registration.state}`, stateName(registration.state));
    const R = push(`${S}|R:${registration.id}`, regFolder(registration));
    const p = taskPeriod(task, registration);
    push(`${R}|P:${p.key}`, periodName(p));
  } else if (c === 'notices') {
    const label = event ? `${event.event_date}_${event.reference || event.title || event.type}` : `${task.period_start}_${task.rule_name}`;
    push(`${C}|V:${task.event_id || task.id}`, label);
  }
  return { keys: chain, category_key: C, fy_key: F, file_name: fileName({ task, doc, version, entity, registration, c }) };
}

/** CompanyCode_Registration_DocumentType_Period_Reference_Status.ext (the approved naming standard) */
function fileName({ task, doc, version, entity, registration, c }) {
  const ext = (String(version.original_name).match(/\.([A-Za-z0-9]{1,6})$/) || [, 'bin'])[1].toLowerCase();
  const p = DE.periodFromKey(task.period_key);
  const period = p?.kind === 'month' ? p.start.slice(0, 7) : p ? compact(p.label.replace(/^FY /, 'FY')) : task.period_start.slice(0, 7);
  const form = compact(task.form || task.rule_id);
  const kind = {
    filed_return: [form, 'Filed'], acknowledgement: [`${form}Ack`, 'Ack'], payment_proof: [`${TOKEN[c] || ''}Challan`, 'Paid'], bank_advice: [`${TOKEN[c] || ''}Advice`, ''],
    working: [`${form}Working`, 'Working'], reconciliation: [`${form}Reconciliation`, ''], approval: [`${form}Approval`, ''], certificate: [`${form}Certificate`, ''],
    notice: ['Notice', ''], reply: ['Reply', 'Submitted'], source_data: [`${form}SourceData`, ''], other: [`${form}Document`, ''],
  }[doc.doc_type] || [form, ''];
  const ref = doc.doc_type === 'payment_proof' || doc.doc_type === 'bank_advice' ? task.filing?.payment?.reference : ['filed_return', 'acknowledgement'].includes(doc.doc_type) ? task.filing?.ack_no : '';
  const parts = [entity?.short_code || 'ENTITY', registration?.number || 'ENTITY', kind[0], period, ref || doc.id, kind[1], version.v > 1 ? `v${version.v}` : ''].filter(Boolean).map(x => compact(x) === x ? x : safeName(x).replace(/\s+/g, '-'));
  return safeName(`${parts.join('_')}.${ext}`, 200);
}

module.exports = { ROOT_NAME, CATS, GST_DOCS, FIN_DOCS, OTHER_PAY, TDS_PARTS, safeName, stateName, periodName, regFolder, plan, route, fileName, taskPeriod };
