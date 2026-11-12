/**
 * GSTR-2B statements: preview, import, versions.
 *
 * - The original file is stored first, named by its SHA-256, and never touched again (lib/files.js).
 * - A statement belongs to ONE recipient GSTIN and ONE return period. A later upload for the same GSTIN + period is a
 *   new VERSION (a recomputed statement); the newest generation date is "current", older versions are kept as history.
 * - The same bytes cannot be imported twice.
 * - Documents of every section are stored (unsupported ones too — the reconciliation shows them as "Excluded").
 * - effective() resolves amendments: a later B2BA / CDNRA supersedes the original of the same document (same
 *   lineage = original number + date), so the same invoice is never counted twice.
 */

'use strict';

const store = require('./store');
const files = require('./files');
const { parseStatement } = require('./import2b');
const N = require('./normalize');
const { hashOf, sha256, groupBy, nowIso } = require('./util');
const { COMPONENTS, zeroAmounts, addAmounts } = require('./money');

const IDX = 'stmt_idx';

const lineageId = (rec, d) => hashOf({ r: rec, c: d.supplier.gstin, t: d.lineage.doc_type, k: d.lineage.doc_no_norm, d: d.lineage.doc_date, s: d.section.startsWith('impg') ? d.section.replace(/a(sez)?$/, '') : '' });

async function list() { return store.read(IDX, []); }
const find = async id => (await list()).find(s => s.id === id) || null;

/** Everything a person needs to decide whether to import this file — and whether it is allowed */
async function preview({ buffer, fileName, cfg, by, gstin: chosenGstin, period: chosenPeriod }) {
  const parsed = parseStatement(buffer, fileName);
  await files.save(parsed.sha256, buffer, parsed.format === 'json' ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');   // immutable original
  const blockers = [], warnings = [...parsed.warnings];
  const regs = cfg.companies.flatMap(co => co.registrations.map(r => ({ company: co, reg: r })));
  const fileG = parsed.meta.gstin ? N.normGstin(parsed.meta.gstin) : '';
  const wantG = chosenGstin ? N.normGstin(chosenGstin) : '';
  if (fileG && wantG && fileG !== wantG) blockers.push(`The file belongs to GSTIN ${fileG}, but you chose ${wantG}.`);
  const gstin = fileG || wantG;
  const target = regs.find(x => x.reg.gstin === gstin) || null;
  if (!gstin) blockers.push('Choose the GSTIN this statement belongs to.');
  else if (!N.gstinInfo(gstin).valid) blockers.push(`GSTIN ${gstin} is not a valid GSTIN.`);
  else if (!target) blockers.push(`GSTIN ${gstin} is not set up in Settings → Companies. Add it first so the statement is reconciled against the right Books.`);
  const filePeriod = parsed.meta.period, wantPeriod = chosenPeriod ? N.parsePeriod(chosenPeriod) : null;
  if (filePeriod && wantPeriod && filePeriod !== wantPeriod) blockers.push(`The file is for ${filePeriod}, but you chose ${wantPeriod}.`);
  const period = filePeriod || wantPeriod;
  if (!period) blockers.push('Choose the return period (month) of this statement.');
  else if (period > N.todayIST().slice(0, 7)) blockers.push(`Return period ${period} is in the future.`);
  if (!parsed.docs.length) blockers.push('No documents were read from this file.');
  const all = await list();
  const dup = all.find(s => s.sha256 === parsed.sha256);
  if (dup) blockers.push(`This exact file was already imported on ${dup.imported_at.slice(0, 10)} (${dup.gstin}, ${dup.period}, version ${dup.version}). Nothing was changed.`);
  const existing = all.filter(s => s.gstin === gstin && s.period === period).sort((a, b) => a.version - b.version);
  const current = existing.find(s => s.is_current) || null;
  let becomesCurrent = true;
  if (current) {
    const g = parsed.meta.gendt, cg = current.gendt;
    if (g && cg && g < cg) { becomesCurrent = false; warnings.push(`Version ${current.version} (generated ${cg}) is newer than this file (generated ${g}). This file will be kept as history and will NOT replace the current version.`); }
    else if (g && cg && g === cg) warnings.push(`Same generation date (${g}) as version ${current.version} but different content — it will be stored as the next version and become current.`);
    else if (!g) warnings.push('The file has no generation date; it will be treated as the newest version.');
    warnings.push(`There ${existing.length === 1 ? 'is' : 'are'} already ${existing.length} version${existing.length === 1 ? '' : 's'} for ${period}. This will be version ${existing.length + 1}${becomesCurrent ? ' and replace the current one for reconciliation' : ''}.`);
  }
  if (parsed.unsupported.length) warnings.push(`${parsed.unsupported.length} section(s) in the file are not imported: ${parsed.unsupported.map(u => `${u.label} (${u.count})`).join(', ')}.`);
  const nonMatchable = Object.entries(parsed.sections).filter(([, s]) => !s.matchable && s.count).map(([, s]) => `${s.label} (${s.count})`);
  if (nonMatchable.length) warnings.push(`Imported but not matched against Books in Phase 1 (shown as "Excluded" with the reason): ${nonMatchable.join(', ')}.`);
  if (parsed.control.ok === false) warnings.push(`Control totals: ${parsed.control.note}.`);
  return {
    preview_id: parsed.sha256, file_name: fileName, size: parsed.size, format: parsed.format,
    meta: { ...parsed.meta, gstin: gstin || '', period: period || null },
    company: target ? target.company.id : null, company_name: target ? target.company.name : null,
    docs: parsed.docs.length, sections: parsed.sections, unsupported: parsed.unsupported,
    errors: parsed.errors.slice(0, 200), error_count: parsed.errors.length, warnings, blockers,
    control: parsed.control, version: existing.length + 1, becomes_current: becomesCurrent,
    sample: parsed.docs.slice(0, 8).map(d => ({ section: d.section, supplier: d.supplier.gstin, number: d.doc_no, date: d.doc_date, type: d.doc_type, taxable: d.amounts.taxable, igst: d.amounts.igst, cgst: d.amounts.cgst, sgst: d.amounts.sgst, cess: d.amounts.cess })),
    needs_ack: parsed.errors.length > 0 || parsed.control.ok === false, can_commit: blockers.length === 0,
  };
}

/** Commit a previewed statement (re-reads the stored original, so what is imported is exactly what was stored) */
async function commit({ previewId, cfg, by, gstin: chosenGstin, period: chosenPeriod, ack = false, demo = false }) {
  const buffer = await files.read(previewId);
  if (!buffer) throw Object.assign(new Error('The uploaded file is no longer available — upload it again.'), { status: 410 });
  if (sha256(buffer) !== previewId) throw new Error('The stored file does not match its fingerprint — upload it again.');
  const pv = await preview({ buffer, fileName: 'stored', cfg, by, gstin: chosenGstin, period: chosenPeriod });
  if (!pv.can_commit) throw Object.assign(new Error(pv.blockers.join(' ')), { status: 409, blockers: pv.blockers });
  if (pv.needs_ack && !ack) throw Object.assign(new Error(`This statement has ${pv.error_count} row problem(s) or a control-total difference. Review them and confirm to import anyway.`), { status: 409, needs_ack: true });
  const parsed = parseStatement(buffer, '');
  const out = await store.withLock('stmt_idx', async () => {
    const idx = await list();
    const same = idx.filter(s => s.gstin === pv.meta.gstin && s.period === pv.meta.period);
    const version = same.length + 1;
    const id = `st_${parsed.sha256.slice(0, 10)}`;
    const meta = {
      id, company: pv.company, gstin: pv.meta.gstin, period: pv.meta.period, version, sha256: parsed.sha256, file_name: pv.file_name === 'stored' ? (idx.find(s => s.sha256 === parsed.sha256)?.file_name || 'GSTR-2B') : pv.file_name,
      size: parsed.size, format: parsed.format, imported_by: by, imported_at: nowIso(), gendt: parsed.meta.gendt, tool_version: parsed.meta.version || null,
      is_current: pv.becomes_current, superseded_by: null, demo: !!demo,
      docs: parsed.docs.length, sections: parsed.sections, unsupported: parsed.unsupported, error_count: parsed.errors.length, warnings: pv.warnings, control: parsed.control, acknowledged: !!ack && pv.needs_ack,
    };
    const docs = parsed.docs.map((d, i) => ({ ...d, src_id: `${id}:${i}`, stmt_id: id, recipient_gstin: meta.gstin, period: meta.period }));
    await store.write(`stmt_${id}`, { id, docs, errors: parsed.errors, itcsumm: parsed.itcsumm });
    const next = idx.map(s => (s.gstin === meta.gstin && s.period === meta.period && s.is_current && meta.is_current ? { ...s, is_current: false, superseded_by: id } : s));
    await store.write(IDX, [meta, ...next]);
    return meta;
  });
  return out;
}

async function get(id, { withDocs = false } = {}) {
  const meta = await find(id);
  if (!meta) return null;
  if (!withDocs) return meta;
  return { ...meta, ...(await store.read(`stmt_${id}`, { docs: [], errors: [] })) };
}

/** Portal documents of the CURRENT version of every period of one recipient GSTIN, amendments resolved */
async function effective(gstin) {
  const cur = (await list()).filter(s => s.gstin === gstin && s.is_current);
  const all = [];
  for (const s of cur) for (const d of (await store.read(`stmt_${s.id}`, { docs: [] })).docs) all.push({ ...d, version: s.version, imported_at: s.imported_at, demo: !!s.demo });
  const groups = groupBy(all, d => lineageId(gstin, d));
  const effective = [], superseded = [];
  for (const [lid, g] of groups) {
    g.sort((a, b) => String(a.period).localeCompare(String(b.period)) || (a.is_amendment ? 1 : 0) - (b.is_amendment ? 1 : 0) || String(a.imported_at).localeCompare(String(b.imported_at)));
    const last = g[g.length - 1];
    const id = `P:${lid}`;
    const history = g.slice(0, -1).map(d => ({ period: d.period, doc_no: d.doc_no, doc_date: d.doc_date, section: d.section, amounts: d.amounts, src_id: d.src_id }));
    const dupReports = g.filter(d => !d.is_amendment).length > 1 && !last.is_amendment;
    effective.push({ ...last, id, lineage_id: lid, amended_from: history, portal_duplicate: dupReports });
    for (const d of g.slice(0, -1)) superseded.push({ ...d, id, superseded_by: last.src_id });
  }
  return { effective, superseded };
}

/** What changed between two versions of a statement (same GSTIN + period) and what it does to ITC per the portal */
async function diff(idA, idB) {
  const [a, b] = [await get(idA, { withDocs: true }), await get(idB, { withDocs: true })];
  if (!a || !b) throw new Error('Statement not found');
  if (a.gstin !== b.gstin || a.period !== b.period) throw new Error('Only versions of the same GSTIN and period can be compared');
  const map = s => new Map(s.docs.map(d => [lineageId(s.gstin, d), d]));
  const A = map(a), B = map(b);
  const add = [], rem = [], chg = [];
  const itc = s => s.docs.filter(d => d.itc_available === 'Y' && d.matchable).reduce((acc, d) => { for (const c of ['igst', 'cgst', 'sgst', 'cess']) acc[c] += (d.sign || 1) * (d.amounts[c] || 0); return acc; }, zeroAmounts());
  const view = d => ({ section: d.section, supplier: d.supplier.gstin, name: d.supplier.name, doc_no: d.doc_no, doc_date: d.doc_date, type: d.doc_type, amounts: d.amounts, itc: d.itc_available });
  for (const [k, d] of B) { if (!A.has(k)) add.push(view(d)); else { const o = A.get(k); if (COMPONENTS.some(c => o.amounts[c] !== d.amounts[c]) || o.itc_available !== d.itc_available) chg.push({ before: view(o), after: view(d) }); } }
  for (const [k, d] of A) if (!B.has(k)) rem.push(view(d));
  const ia = itc(a), ib = itc(b);
  const impact = Object.fromEntries(['igst', 'cgst', 'sgst', 'cess'].map(c => [c, ib[c] - ia[c]]));
  return { a: { id: a.id, version: a.version, gendt: a.gendt, docs: a.docs.length }, b: { id: b.id, version: b.version, gendt: b.gendt, docs: b.docs.length },
    added: add.slice(0, 500), removed: rem.slice(0, 500), changed: chg.slice(0, 500), counts: { added: add.length, removed: rem.length, changed: chg.length }, itc_available_impact: impact,
    note: 'ITC impact = change in tax on documents the portal marks "ITC available", signed (credit notes negative). It is the portal\'s statement, not an eligibility decision.' };
}

module.exports = { preview, commit, list, get, find, effective, diff, lineageId };
