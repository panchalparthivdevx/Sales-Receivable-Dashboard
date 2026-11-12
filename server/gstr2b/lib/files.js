/**
 * Original statement files: stored once, named by their SHA-256, never rewritten or deleted by the module.
 *
 * Office PC: server/gstr2b/files/<sha256>  ·  Vercel: private Blob "gstr2b/<sha256>" (see server/file-store.js)
 * A re-upload of identical bytes finds the file already there and changes nothing.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

let opts = { dir: process.env.G2B_FILES_DIR || path.join(__dirname, '..', 'files'), blob: undefined };
let _blob = null;
const blob = () => {
  if (opts.blob !== undefined) return opts.blob;
  if (!_blob) _blob = require('../../file-store');
  return _blob.enabled ? _blob : null;
};
const configure = o => { opts = { ...opts, ...o }; };
const safe = sha => { if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid file reference'); return sha; };

async function save(sha, buffer, contentType) {
  safe(sha);
  const b = blob();
  if (b) { if (!(await b.exists(`gstr2b/${sha}`))) await b.save(`gstr2b/${sha}`, buffer, contentType); return; }
  fs.mkdirSync(opts.dir, { recursive: true });
  const file = path.join(opts.dir, sha);
  if (fs.existsSync(file)) return;                                       // immutable: never overwritten
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
}

async function read(sha) {
  safe(sha);
  const b = blob();
  if (b) return b.read(`gstr2b/${sha}`);
  try { return fs.readFileSync(path.join(opts.dir, sha)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function exists(sha) {
  safe(sha);
  const b = blob();
  return b ? b.exists(`gstr2b/${sha}`) : fs.existsSync(path.join(opts.dir, sha));
}

module.exports = { configure, save, read, exists };
