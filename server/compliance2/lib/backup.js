/**
 * Backups and restore tests.
 *
 *   backup({ out })        copies every Compliance Vr.2.0 document (c2_* from the PC files or Neon) and every evidence file
 *                          they refer to (still ENCRYPTED, exactly as stored) into out/c2-backup-<time>/, with a manifest of
 *                          SHA-256 hashes. The encryption key is never written into a backup — keep it separately.
 *   restoreCheck(dir)      rebuilds the backup in a temporary folder and checks it: every hash in the manifest, the audit
 *                          chain of each space, and that every document version's file decrypts to its recorded SHA-256.
 *   restoreTo(dir, target) the same, into an EMPTY data / files folder (refuses a folder that already has data).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./util');
const store = require('./store');
const BL = require('./blobs');
const AU = require('./audit');

let _fileStore = null;
const fileStore = () => { if (!_fileStore) _fileStore = require('../../file-store'); return _fileStore.enabled ? _fileStore : null; };

/** Encrypted bytes of one stored file, as stored */
async function packedOf(space, sha, filesDir) {
  const fsb = fileStore();
  if (fsb) return fsb.read(`compliance2/${space}/${sha}.c2e`);
  try { return fs.readFileSync(path.join(filesDir, space, `${sha}.c2e`)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function backup({ out, filesDir = process.env.C2_FILES_DIR || path.join(__dirname, '..', 'files') } = {}) {
  const dir = path.join(out, `c2-backup-${U.nowIso().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const manifest = { created_at: U.nowIso(), format: 1, docs: [], files: [], missing_files: [], note: 'Evidence files are encrypted. The key (C2_FILE_KEY) is NOT in this backup — keep it separately.' };
  const shas = { live: new Set(), demo: new Set() };
  for (const key of (await store.list('')).sort()) {
    const value = await store.read(key, null);
    const text = JSON.stringify(value);
    fs.writeFileSync(path.join(dir, 'docs', `${key}.json`), text);
    manifest.docs.push({ key, sha256: U.sha256(text), bytes: Buffer.byteLength(text) });
    const m = /^(live|demo)_docs$/.exec(key);
    if (m) for (const d of value?.documents || []) for (const v of d.versions) shas[m[1]].add(v.sha256);
  }
  for (const space of ['live', 'demo']) {
    for (const sha of shas[space]) {
      const packed = await packedOf(space, sha, filesDir);
      if (!packed) { manifest.missing_files.push({ space, sha256: sha }); continue; }
      fs.mkdirSync(path.join(dir, 'files', space), { recursive: true });
      fs.writeFileSync(path.join(dir, 'files', space, `${sha}.c2e`), packed);
      manifest.files.push({ space, sha256: sha, packed_sha256: U.sha256(packed), bytes: packed.length });
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir, docs: manifest.docs.length, files: manifest.files.length, missing_files: manifest.missing_files };
}

/** Rebuilds a backup in `target` (default: a new temporary folder) and verifies it. → { ok, problems, report } */
async function restoreCheck(dir, { target, keep = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const base = target || fs.mkdtempSync(path.join(os.tmpdir(), 'c2restore-'));
  const dataDir = path.join(base, 'data'), filesDir = path.join(base, 'files');
  if (target && fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) throw new Error(`${dataDir} already has data — restore only into an empty folder`);
  fs.mkdirSync(dataDir, { recursive: true });
  const problems = [];
  for (const d of manifest.docs) {
    const text = fs.readFileSync(path.join(dir, 'docs', `${d.key}.json`), 'utf8');
    if (U.sha256(text) !== d.sha256) problems.push(`document ${d.key}: hash differs from the manifest`);
    fs.writeFileSync(path.join(dataDir, `${d.key}.json`), text);
  }
  for (const f of manifest.files) {
    const packed = fs.readFileSync(path.join(dir, 'files', f.space, `${f.sha256}.c2e`));
    if (U.sha256(packed) !== f.packed_sha256) problems.push(`file ${f.space}/${f.sha256}: changed since the backup`);
    fs.mkdirSync(path.join(filesDir, f.space), { recursive: true });
    fs.writeFileSync(path.join(filesDir, f.space, `${f.sha256}.c2e`), packed);
  }
  for (const m of manifest.missing_files) problems.push(`file ${m.space}/${m.sha256} was already missing when the backup was made`);
  // check the rebuilt copy through the module's own reader, then put the module back on its normal folders
  const prevStore = store.options(), prevBlobs = BL.options();
  const report = {};
  store.configure({ dir: dataDir, useDb: false });
  BL.configure({ dir: filesDir, blob: null });
  try {
    for (const sp of ['live', 'demo']) {
      const chain = await AU.verify(store, sp);
      if (!chain.ok) problems.push(`${sp} audit trail: ${chain.reason} (entry ${chain.at_seq})`);
      const docs = await store.read(`${sp}_docs`, { documents: [] });
      let readable = 0;
      for (const d of docs.documents) for (const v of d.versions) {
        try { if (await BL.read(sp, v.sha256)) readable++; else problems.push(`${sp} document ${d.id} v${v.v}: file missing`); }
        catch (e) { problems.push(`${sp} document ${d.id} v${v.v}: ${e.message}`); }
      }
      const taskKeys = (await store.list(`${sp}_tasks_`));
      let tasks = 0;
      for (const k of taskKeys) tasks += (await store.read(k, { tasks: [] })).tasks.length;
      report[sp] = { audit_entries: chain.checked, documents: docs.documents.length, file_versions_readable: readable, tasks };
    }
  } finally {
    store.configure(prevStore);
    BL.configure(prevBlobs);
    if (!keep && !target) { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
  }
  return { ok: problems.length === 0, problems, report, restored_to: keep || target ? base : null };
}

module.exports = { backup, restoreCheck };
