/**
 * Original files (uploaded Form 26AS statements and review attachments): stored once, named by their SHA-256, never rewritten.
 * Office PC: server/tds26as/files/<sha256>  ·  Vercel: private Blob "tds26as/<sha256>" (see server/file-store.js)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

let opts = { dir: process.env.T26_FILES_DIR || path.join(__dirname, '..', 'files'), blob: undefined };
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
  if (b) { if (!(await b.exists(`tds26as/${sha}`))) await b.save(`tds26as/${sha}`, buffer, contentType); return; }
  fs.mkdirSync(opts.dir, { recursive: true });
  const file = path.join(opts.dir, sha);
  if (fs.existsSync(file)) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
}

async function read(sha) {
  safe(sha);
  const b = blob();
  if (b) return b.read(`tds26as/${sha}`);
  try { return fs.readFileSync(path.join(opts.dir, sha)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

module.exports = { configure, save, read };
