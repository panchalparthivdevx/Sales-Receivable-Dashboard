/**
 * Form 26AS statements: preview → validate → commit, with versions.
 *
 * One entity + financial year can hold several uploads. The ACTIVE version is the one with the latest statement date ("data updated
 * till"); a re-upload of the same bytes changes nothing, a revised statement (later date) replaces the credits of the earlier one, and an
 * older statement uploaded later is kept as history only. Credits therefore never add up across uploads.
 *
 * Credit identity (`key`): entity + FY + TAN + section + transaction date + amount paid + tax deducted + occurrence number. The deposit
 * figure, booking status and booking date are NOT part of it, so a revised statement that only updates a deposit keeps the same credit
 * (and the review decisions on it), while a different deduction is a different credit.
 */

'use strict';

const store = require('./store');
const files = require('./files');
const P26 = require('./parse26as');
const PER = require('./periods');
const { sectionFamily } = require('./config');
const { sha256, hashOf, uid, sumBy, fmtR } = require('./util');

const IDX = 'stmt_idx';
const PREVIEW_TTL_MS = 6 * 3600 * 1000;

function controlChecks(parsed) {
  const out = [];
  const byDed = new Map();
  for (const r of parsed.rows) { const k = `${r.tan}|${r.deductor_sr}`; (byDed.get(k) || byDed.set(k, []).get(k)).push(r); }
  for (const d of parsed.deductors) {
    const rows = byDed.get(`${d.tan}|${d.sr}`) || [];
    for (const [f, label, sum] of [['total_paid', 'amount paid / credited', sumBy(rows, r => r.amount_paid)], ['total_deducted', 'tax deducted', sumBy(rows, r => r.deducted)], ['total_deposited', 'TDS deposited', sumBy(rows, r => r.deposited)]]) {
      if (d[f] === null || d[f] === undefined) continue;
      if (d[f] !== sum) out.push({ deductor: d.name, tan: d.tan, field: label, summary: d[f], rows: sum, src: d.src });
    }
    if (!rows.length && (d.total_deducted || d.total_deposited)) out.push({ deductor: d.name, tan: d.tan, field: 'transactions', summary: d.total_deducted, rows: 0, src: d.src, note: 'no transaction rows were read for this deductor' });
  }
  return out;
}

/** Statement-level facts + the checks shown before import (entity = the entity chosen on the upload screen) */
function validate(parsed, entity, { activeVersion, sameFile } = {}) {
  const h = parsed.header;
  const checks = [];
  const add = (id, ok, label, detail, level = ok ? 'ok' : 'error') => checks.push({ id, ok, label, detail, level });
  add('pan', !!h.pan && h.pan === entity.pan, 'PAN matches the selected entity',
    !h.pan ? 'No PAN was found in the statement header' : h.pan === entity.pan ? `${h.pan} = ${entity.name}` : `The statement is for PAN ${h.pan}${h.name ? ` (${h.name})` : ''}, but ${entity.name} has PAN ${entity.pan} — wrong entity selected, or the wrong file`);
  add('period', !!h.fy, 'Statement period', h.fy ? `Financial year ${h.fy}${h.ay ? ` (assessment year ${h.ay})` : ''}${h.tax_year ? ` · tax year ${h.tax_year}` : ''}` : 'The financial year could not be read — choose it below', h.fy ? 'ok' : 'warning');
  add('date', !!h.statement_date, 'Statement date', h.statement_date ? `${h.statement_date_basis}: ${h.statement_date}` : 'No "Data updated till" / file creation date was found — enter it below', h.statement_date ? 'ok' : 'warning');
  add('rows', parsed.rows.length > 0, 'Rows read from PART-I', `${parsed.rows.length} transaction row(s) under ${parsed.deductors.length || new Set(parsed.rows.map(r => r.tan)).size} deductor(s)`, parsed.rows.length ? 'ok' : 'error');
  const outside = h.fy ? parsed.rows.filter(r => r.txn_date && PER.fyOf(r.txn_date) !== h.fy) : [];
  if (outside.length) add('row_dates', false, 'Transaction dates inside the statement year', `${outside.length} row(s) are dated outside FY ${h.fy} (first: ${outside[0].txn_date}) — kept as printed`, 'warning');
  const ctl = controlChecks(parsed);
  add('control', ctl.length === 0, 'Control totals (deductor summary = its transactions)', ctl.length ? `${ctl.length} difference(s): ${ctl.slice(0, 3).map(c => `${c.deductor} ${c.field}: summary ${fmtR(c.summary)} vs rows ${fmtR(c.rows)}`).join('; ')}` : parsed.deductors.length ? `All ${parsed.deductors.length} deductor totals agree with their rows` : 'No deductor summary rows in this layout — nothing to compare', ctl.length ? 'error' : 'ok');
  const errs = parsed.problems.filter(p => p.level === 'error'), warns = parsed.problems.filter(p => p.level === 'warning');
  const unread = parsed.problems.filter(p => p.code === 'unreadable_row'), missing = parsed.problems.filter(p => p.code === 'missing_fields' || p.code === 'tan_invalid');
  add('unreadable', unread.length === 0, 'Unreadable rows', unread.length ? `${unread.length} line(s) inside PART-I could not be read (listed below with their page / line)` : 'None', unread.length ? 'warning' : 'ok');
  add('missing', missing.length === 0, 'Rows with missing or invalid fields', missing.length ? `${missing.length} row(s) — listed below` : 'None', missing.some(p => p.level === 'error') ? 'error' : missing.length ? 'warning' : 'ok');
  if (sameFile) add('duplicate', false, 'Already imported', `This exact file was imported on ${sameFile.uploaded_at.slice(0, 10)} as version ${sameFile.version} for FY ${sameFile.fy} — importing it again changes nothing`, 'warning');
  if (activeVersion && h.statement_date && activeVersion.statement_date && h.statement_date < activeVersion.statement_date) add('older', false, 'Older than the statement in use', `The statement in use is dated ${activeVersion.statement_date} (version ${activeVersion.version}); this one (${h.statement_date}) will be kept as history and will not replace it`, 'warning');
  const blockers = checks.filter(c => c.level === 'error' && ['pan', 'rows'].includes(c.id)).map(c => c.detail);
  const needsAck = checks.filter(c => c.level === 'error' && !['pan', 'rows'].includes(c.id)).map(c => c.label);
  return { checks, blockers, needs_ack: needsAck, problems: { errors: errs.length, warnings: warns.length } };
}

function totals(rows) {
  return { rows: rows.length, deductors: new Set(rows.map(r => r.tan)).size, amount_paid: sumBy(rows, r => r.amount_paid), deducted: sumBy(rows, r => r.deducted), deposited: sumBy(rows, r => r.deposited) };
}

/** Parsed rows → credits with their stable keys */
function toCredits(entityId, fy, rows, settings = {}) {
  const seen = new Map();
  return rows.map(r => {
    const base = `${entityId}|${fy}|${r.tan}|${String(r.section).toUpperCase()}|${r.txn_date}|${r.amount_paid}|${r.deducted}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return {
      key: `c${hashOf(`${base}|#${n}`)}`, fy, deductor: r.deductor, tan: r.tan, section_raw: r.section, section: sectionFamily(r.section, settings.section_aliases),
      txn_date: r.txn_date, status: r.status, booking_date: r.booking_date, remarks: r.remarks,
      amount_paid: r.amount_paid, deducted: r.deducted, deposited: r.deposited, src: r.src, raw: r.raw,
    };
  });
}

function diffCredits(prev, next) {
  const a = new Map(prev.map(c => [c.key, c])), b = new Map(next.map(c => [c.key, c]));
  const added = next.filter(c => !a.has(c.key)), removed = prev.filter(c => !b.has(c.key));
  const changed = next.filter(c => a.has(c.key) && (a.get(c.key).deposited !== c.deposited || a.get(c.key).status !== c.status || a.get(c.key).booking_date !== c.booking_date))
    .map(c => ({ key: c.key, tan: c.tan, deductor: c.deductor, txn_date: c.txn_date, before: { deposited: a.get(c.key).deposited, status: a.get(c.key).status }, after: { deposited: c.deposited, status: c.status } }));
  return { added: added.length, removed: removed.length, changed: changed.length, added_deposited: sumBy(added, c => c.deposited), removed_deposited: sumBy(removed, c => c.deposited), changes: changed.slice(0, 50),
    removed_list: removed.slice(0, 50).map(c => ({ key: c.key, tan: c.tan, deductor: c.deductor, txn_date: c.txn_date, deposited: c.deposited })) };
}

const index = async () => store.read(IDX, []);
const activeOf = (idx, entity, fy) => idx.filter(s => s.entity === entity && s.fy === fy && s.active)[0] || null;

async function preview({ buffer, fileName, password, entity, by, settings }) {
  const sha = sha256(buffer);
  const parsed = await P26.parse(buffer, fileName, { password });
  const idx = await index();
  const fy = parsed.header.fy;
  const sameFile = idx.find(s => s.entity === entity.id && s.sha256 === sha) || null;
  const activeVersion = fy ? activeOf(idx, entity.id, fy) : null;
  const v = validate(parsed, entity, { activeVersion, sameFile });
  let revision = null;
  if (activeVersion && fy && !sameFile) {
    const prev = (await store.read(`stmt_${activeVersion.id}`, { credits: [] })).credits;
    revision = { against: { id: activeVersion.id, version: activeVersion.version, statement_date: activeVersion.statement_date }, ...diffCredits(prev, toCredits(entity.id, fy, parsed.rows, settings)) };
  }
  await files.save(sha, buffer, parsed.format === 'pdf' ? 'application/pdf' : 'application/octet-stream');
  const id = uid('pv');
  await store.write(`preview_${id}`, { id, at: new Date().toISOString(), by, entity: entity.id, sha256: sha, file_name: fileName, size: buffer.length, parsed });
  return {
    preview_id: id, entity: entity.id, file_name: fileName, sha256: sha, format: parsed.format, header: parsed.header, parts_seen: parsed.parts_seen, inner_file: parsed.inner_file || null,
    totals: totals(parsed.rows), deductors: parsed.deductors.map(d => ({ sr: d.sr, name: d.name, tan: d.tan, total_paid: d.total_paid, total_deducted: d.total_deducted, total_deposited: d.total_deposited })),
    rows: parsed.rows.slice(0, 400), rows_shown: Math.min(400, parsed.rows.length), problems: parsed.problems.slice(0, 300), problem_count: parsed.problems.length, control: controlChecks(parsed),
    validation: v, same_file: sameFile ? { id: sameFile.id, version: sameFile.version, fy: sameFile.fy } : null, revision,
    active: activeVersion ? { id: activeVersion.id, version: activeVersion.version, statement_date: activeVersion.statement_date } : null,
  };
}

/** Commit a preview. fy / statement_date may be given when the file does not state them; ack is needed when a check failed. */
async function commit({ previewId, entity, fy: fyIn, statementDate, ack, by, settings }) {
  if (!/^pv[a-f0-9]{12}$/.test(previewId)) throw Object.assign(new Error('The preview has expired — upload the file again'), { status: 400 });
  const pv = await store.read(`preview_${previewId}`, null);
  if (!pv || Date.now() - Date.parse(pv.at) > PREVIEW_TTL_MS) throw Object.assign(new Error('The preview has expired — upload the file again'), { status: 400 });
  if (pv.entity !== entity.id) throw Object.assign(new Error('This preview was made for another entity — upload the file again for this entity'), { status: 400 });
  const parsed = pv.parsed;
  const fy = parsed.header.fy || (PER.isFy(fyIn) ? fyIn : '');
  if (!fy) throw Object.assign(new Error('Choose the financial year this statement is for'), { status: 400 });
  if (parsed.header.fy && fyIn && fyIn !== parsed.header.fy) throw Object.assign(new Error(`The statement says FY ${parsed.header.fy}; it cannot be imported as FY ${fyIn}`), { status: 400 });
  const sdate = parsed.header.statement_date || (/^\d{4}-\d{2}-\d{2}$/.test(String(statementDate || '')) ? statementDate : '');
  if (!sdate) throw Object.assign(new Error('Enter the statement date ("Data updated till" on the statement)'), { status: 400 });
  return store.withLock(IDX, async () => {
    const idx = await index();
    const sameFile = idx.find(s => s.entity === entity.id && s.sha256 === pv.sha256);
    if (sameFile) { await store.remove(`preview_${previewId}`); return { unchanged: true, statement: sameFile, message: `This file is already imported as version ${sameFile.version} (FY ${sameFile.fy}) — nothing changed` }; }
    const active = activeOf(idx, entity.id, fy);
    const v = validate({ ...parsed, header: { ...parsed.header, fy, statement_date: sdate } }, entity, { activeVersion: active });
    if (v.blockers.length) throw Object.assign(new Error(v.blockers.join(' · ')), { status: 400, blockers: v.blockers });
    if (v.needs_ack.length && !ack) throw Object.assign(new Error(`Confirm that you want to import despite: ${v.needs_ack.join(', ')}`), { status: 409, needs_ack: true, blockers: v.needs_ack });
    const credits = toCredits(entity.id, fy, parsed.rows, settings).map(c => ({ ...c, src: { ...c.src, sha256: pv.sha256 } }));
    const id = uid('st');
    const version = idx.filter(s => s.entity === entity.id && s.fy === fy).length + 1;
    const becomesActive = !active || sdate >= active.statement_date;
    let revision = null;
    if (active) revision = diffCredits((await store.read(`stmt_${active.id}`, { credits: [] })).credits, credits);
    const meta = {
      id, entity: entity.id, pan: parsed.header.pan, fy, version, statement_date: sdate, statement_date_basis: parsed.header.statement_date ? parsed.header.statement_date_basis : 'entered at import',
      uploaded_at: new Date().toISOString(), by, file_name: pv.file_name, sha256: pv.sha256, size: pv.size, format: parsed.format, inner_file: parsed.inner_file || null,
      totals: totals(parsed.rows), problems: parsed.problems.length, acknowledged: v.needs_ack.length ? v.needs_ack : [], active: becomesActive, supersedes: becomesActive && active ? active.id : null,
      superseded_by: null, revision: revision ? { added: revision.added, removed: revision.removed, changed: revision.changed } : null, parts_seen: parsed.parts_seen,
    };
    await store.write(`stmt_${id}`, { meta, header: parsed.header, deductors: parsed.deductors, credits, problems: parsed.problems, revision });
    const next = idx.map(s => (becomesActive && s.entity === entity.id && s.fy === fy && s.active ? { ...s, active: false, superseded_by: id } : s));
    next.push(meta);
    await store.write(IDX, next);
    await store.remove(`preview_${previewId}`);
    return { unchanged: false, statement: meta, revision };
  });
}

async function list(entityId) { return (await index()).filter(s => !entityId || s.entity === entityId).sort((a, b) => a.fy.localeCompare(b.fy) || a.version - b.version); }
async function get(id) { if (!/^st[a-f0-9]{12}$/.test(id)) return null; return store.read(`stmt_${id}`, null); }

/** Every credit of the entity's ACTIVE statements (one per FY), each with its statement reference */
async function activeCredits(entityId) {
  const out = [];
  for (const s of (await index()).filter(x => x.entity === entityId && x.active)) {
    const doc = await store.read(`stmt_${s.id}`, { credits: [] });
    for (const c of doc.credits) out.push({ ...c, stmt: { id: s.id, version: s.version, statement_date: s.statement_date, file: s.file_name } });
  }
  return out;
}
async function coverage(entityId) {
  return (await index()).filter(x => x.entity === entityId && x.active).map(s => ({ fy: s.fy, statement_date: s.statement_date, version: s.version, id: s.id, file: s.file_name, uploaded_at: s.uploaded_at }));
}

async function removeEntity(entityId) {
  await store.withLock(IDX, async () => {
    const idx = await index();
    for (const s of idx.filter(x => x.entity === entityId)) await store.remove(`stmt_${s.id}`);
    await store.write(IDX, idx.filter(x => x.entity !== entityId));
  });
}

module.exports = { preview, commit, list, get, activeCredits, coverage, validate, toCredits, diffCredits, removeEntity, controlChecks };
