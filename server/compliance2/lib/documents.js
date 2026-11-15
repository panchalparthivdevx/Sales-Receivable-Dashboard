/**
 * Evidence documents.
 *
 * Record: { id, entity_id, task_ids[], doc_type, status 'active' | 'withdrawn', sample, legal_hold, retention_until,
 *           versions: [{ v, sha256, size, type, mime, original_name, uploaded_by, at, scan, findings, flags, restored_from }],
 *           current (= newest version), history[] }
 *
 *   • One upload = one version. Replacing a document adds a version; older versions stay retrievable ("restore" makes an old
 *     version current again by adding it as a new version — nothing is overwritten).
 *   • The same bytes are stored once (blobs.js). Uploading a file that is already attached elsewhere in the same entity as
 *     the same document type LINKS that document instead (e.g. one TDS challan used by several tasks); with another
 *     document type a second record is made over the same stored file and flagged "duplicate content" for a human.
 *   • Nothing is ever deleted: "withdraw" hides a document from evidence (with a reason) — not allowed under legal hold.
 *     retention_until = end of the task's FY + the retention years in Settings (default 8 — verify per law).
 *   • A closed (locked) task takes no uploads, replacements or withdrawals; re-open it first (new version).
 *   • Downloads go through short-lived signed links bound to the user (default 120 seconds); the user's access is checked
 *     again when the link is used.
 */

'use strict';

const crypto = require('crypto');
const U = require('./util');
const CAT = require('./catalogue');
const EX = require('./extract');
const SC = require('./scanner');
const BL = require('./blobs');

/** Checks, scans, reads and stores a file — before any record is written. Throws on a refused file. */
async function prepare(space, file, { maxMb = 25, generatedSample = false } = {}) {
  if (!file?.buffer?.length) throw U.httpError(400, 'No file received');
  if (file.buffer.length > maxMb * 1024 * 1024) throw U.httpError(413, `The file is larger than ${maxMb} MB`);
  const name = String(file.originalname || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);
  const s = EX.sniff(file.buffer, name);
  if (!s.ok) throw U.httpError(415, s.error);
  // the demo's own generated sample files are not scanned (they are made by this module, not uploaded) — and say so
  const scan = generatedSample && space === 'demo' ? { status: 'unscanned', engine: 'none', detail: 'generated demo sample, not an upload' } : await SC.scan(file.buffer);
  if (scan.status === 'infected') throw U.httpError(422, `The malware scan rejected this file (${scan.engine}: ${scan.detail || 'threat found'}). It was not stored.`, { scan });
  const sha = U.sha256(file.buffer);
  const text = await EX.readText(file.buffer, s.type);
  await BL.save(space, sha, file.buffer);
  return { sha, size: file.buffer.length, type: s.type, mime: s.mime, original_name: name, scan, findings: EX.findings(text), text_length: text.trim().length };
}

function retentionUntil(fy, years) { return `${U.fyStartYear(fy) + 1 + years}-03-31`; }

function versionOf(p, actor, extra) {
  return { sha256: p.sha, size: p.size, type: p.type, mime: p.mime, original_name: p.original_name, uploaded_by: actor.name, uploaded_by_id: actor.id, at: U.nowIso(), scan: p.scan, findings: p.findings, ...extra };
}

/**
 * Adds a prepared upload to the documents document. input: { prepared, task, entity, registration, doc_type, replace_doc_id, actor, retentionYears, sample }
 * → { doc, linked_existing, created }
 */
function add(docsDoc, { prepared, task, entity, registration, doc_type, replace_doc_id, actor, retentionYears = 8, sample = false }) {
  if (!CAT.DOC_TYPES[doc_type]) throw U.httpError(400, `Document type must be one of: ${Object.keys(CAT.DOC_TYPES).join(', ')}`);
  if (task.locked) throw U.httpError(400, 'This task is closed and locked — re-open it (new version) to add documents');
  const flags = EX.compare(prepared.findings, { task, entity, registration, textLength: prepared.text_length });
  if (prepared.scan.status !== 'clean') flags.push({ code: 'not_scanned', text: `Malware scan: ${prepared.scan.status}${prepared.scan.detail ? ` (${prepared.scan.detail})` : ''}` });
  if (replace_doc_id) {
    const doc = docsDoc.documents.find(d => d.id === replace_doc_id);
    if (!doc || !doc.task_ids.includes(task.id)) throw U.httpError(404, 'The document to replace is not attached to this task');
    if (doc.status !== 'active') throw U.httpError(400, 'A withdrawn document cannot be replaced');
    if (doc.current.sha256 === prepared.sha) throw U.httpError(409, 'This is the same file as the current version');
    const v = { v: doc.versions.length + 1, ...versionOf(prepared, actor, { flags }) };
    doc.versions.push(v);
    doc.current = v;
    doc.history.push({ at: v.at, by: actor.name, action: 'new_version', note: `Version ${v.v}: ${prepared.original_name}` });
    return { doc, created: false, linked_existing: false };
  }
  const same = docsDoc.documents.filter(d => d.status === 'active' && d.current.sha256 === prepared.sha);
  const here = same.find(d => d.task_ids.includes(task.id) && d.doc_type === doc_type);
  if (here) throw U.httpError(409, `This exact file is already attached to this task as "${CAT.DOC_TYPES[doc_type]}" (${here.id})`);
  const reuse = same.find(d => d.entity_id === task.entity_id && d.doc_type === doc_type);
  if (reuse) {
    reuse.task_ids.push(task.id);
    reuse.history.push({ at: U.nowIso(), by: actor.name, action: 'linked', note: `Linked to task ${task.id} (same file uploaded again — stored once)` });
    return { doc: reuse, created: false, linked_existing: true };
  }
  for (const d of same) flags.push({ code: 'duplicate_content', text: `Same file as document ${d.id} (${CAT.DOC_TYPES[d.doc_type]})${d.entity_id !== task.entity_id ? ' of ANOTHER entity' : ''}` });
  const v = { v: 1, ...versionOf(prepared, actor, { flags }) };
  const doc = {
    id: U.uid('D-'), entity_id: task.entity_id, task_ids: [task.id], doc_type, status: 'active', sample, legal_hold: null,
    retention_until: retentionUntil(task.fy, retentionYears), versions: [v], current: v,
    history: [{ at: v.at, by: actor.name, action: 'uploaded', note: `${CAT.DOC_TYPES[doc_type]}: ${prepared.original_name}` }],
  };
  docsDoc.documents.push(doc);
  return { doc, created: true, linked_existing: false };
}

/** Attach an existing document to another task of the same entity (one challan, several tasks) */
function link(docsDoc, docId, task, actor) {
  const doc = docsDoc.documents.find(d => d.id === docId);
  if (!doc || doc.status !== 'active') throw U.httpError(404, 'Document not found');
  if (doc.entity_id !== task.entity_id) throw U.httpError(400, 'A document can only be linked to tasks of the same entity');
  if (task.locked) throw U.httpError(400, 'This task is closed and locked');
  if (doc.task_ids.includes(task.id)) throw U.httpError(409, 'Already linked to this task');
  doc.task_ids.push(task.id);
  doc.history.push({ at: U.nowIso(), by: actor.name, action: 'linked', note: `Linked to task ${task.id}` });
  return doc;
}

function restore(doc, version, actor) {
  const old = doc.versions.find(v => v.v === Number(version));
  if (!old) throw U.httpError(404, `Version ${version} not found`);
  if (old.v === doc.current.v) throw U.httpError(400, 'That version is already the current one');
  const v = { ...U.clone(old), v: doc.versions.length + 1, restored_from: old.v, at: U.nowIso(), uploaded_by: actor.name, uploaded_by_id: actor.id };
  doc.versions.push(v);
  doc.current = v;
  doc.history.push({ at: v.at, by: actor.name, action: 'restored', note: `Version ${old.v} restored as version ${v.v}` });
  return doc;
}

function withdraw(doc, reason, actor, tasksLocked) {
  if (doc.legal_hold) throw U.httpError(400, `Under legal hold (${doc.legal_hold.reason}) — it cannot be withdrawn`);
  if (tasksLocked) throw U.httpError(400, 'It is evidence of a closed task — re-open the task first');
  if (doc.status !== 'active') throw U.httpError(400, 'Already withdrawn');
  if (String(reason || '').trim().length < 5) throw U.httpError(400, 'A reason is required');
  doc.status = 'withdrawn';
  doc.history.push({ at: U.nowIso(), by: actor.name, action: 'withdrawn', note: reason });
  return doc;
}

function hold(doc, on, reason, actor) {
  if (!String(reason || '').trim()) throw U.httpError(400, 'A reason is required');
  doc.legal_hold = on ? { reason: String(reason).slice(0, 500), by: actor.name, at: U.nowIso() } : null;
  doc.history.push({ at: U.nowIso(), by: actor.name, action: on ? 'legal_hold_on' : 'legal_hold_off', note: reason });
  return doc;
}

// ── Signed download links ─────────────────────────────────────────────────────
const signKey = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
  return Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'compliance2', 'download-link', 32));
};
function signLink({ space, doc_id, v, user_id }, ttlMs = 120000) {
  const body = Buffer.from(JSON.stringify({ s: space, d: doc_id, v, u: user_id, e: U.clock.now() + ttlMs, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', signKey()).update(body).digest('base64url')}`;
}
function readLink(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', signKey()).update(body).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.e > U.clock.now() ? p : null; } catch (_) { return null; }
}

module.exports = { prepare, add, link, restore, withdraw, hold, signLink, readLink, retentionUntil };
