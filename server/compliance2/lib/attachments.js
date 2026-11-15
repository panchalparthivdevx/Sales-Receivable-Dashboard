/**
 * Evidence files that belong to records other than tasks — TDS challans, payments, reconciliation inputs, payroll imports,
 * tax-audit payments, update notes. Same pipeline as task documents (type check, malware scan, SHA-256, AES-256-GCM, one stored
 * copy per content: lib/documents.js prepare + lib/blobs.js); the record keeps which records use the file ("links").
 *
 * Store document "<sp>_files": { files: [{ id, sha256, size, type, mime, original_name, scan, entity_id, kind, links[{ module, id }],
 *   uploaded_by, uploaded_by_id, at, sample }] }
 * The same bytes for the same entity are ONE file record (a challan used by several section allocations is stored once).
 */

'use strict';

const U = require('./util');

const KINDS = {
  challan: 'Paid challan / payment receipt', bank_proof: 'Bank payment proof', return_file: 'Return / acknowledgement', working: 'Working',
  payroll_source: 'Payroll source file', ecr_source: 'ECR source file', esic_source: 'ESIC member contribution file', notice: 'Notice / source copy', other: 'Other',
};
const EMPTY = () => ({ files: [] });

/** Record a prepared upload (documents.prepare) → the file record (existing one when the same content was already stored) */
function add(doc, { prepared, entity_id, kind, link, actor, sample = false }) {
  if (!KINDS[kind]) throw U.httpError(400, `File kind must be one of: ${Object.keys(KINDS).join(', ')}`);
  let f = doc.files.find(x => x.sha256 === prepared.sha && x.entity_id === entity_id);
  if (!f) {
    f = { id: U.uid('F-'), sha256: prepared.sha, size: prepared.size, type: prepared.type, mime: prepared.mime, original_name: prepared.original_name, scan: prepared.scan,
      entity_id, kind, links: [], uploaded_by: actor.name, uploaded_by_id: actor.id, at: U.nowIso(), sample, reused: 0 };
    doc.files.push(f);
  } else f.reused = (f.reused || 0) + 1;
  if (link) addLink(f, link);
  return f;
}

function addLink(f, link) {
  if (!f.links.some(l => l.module === link.module && l.id === link.id)) f.links.push({ module: link.module, id: link.id, at: U.nowIso() });
  return f;
}

/** Link existing files to a record; every file must belong to the same entity */
function linkAll(doc, ids, entityId, link) {
  const out = [];
  for (const id of ids || []) {
    const f = doc.files.find(x => x.id === id);
    if (!f) throw U.httpError(400, `Evidence file ${id} not found`);
    if (f.entity_id !== entityId) throw U.httpError(400, `Evidence file ${f.original_name} belongs to another entity`);
    addLink(f, link);
    out.push(f.id);
  }
  return out;
}

const summary = f => (f ? { id: f.id, name: f.original_name, kind: f.kind, size: f.size, scan: f.scan?.status, sha256: f.sha256, sample: f.sample } : null);

module.exports = { KINDS, EMPTY, add, addLink, linkAll, summary };
