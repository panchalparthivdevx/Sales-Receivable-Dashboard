/**
 * Evidence files at rest: encrypted (AES-256-GCM), stored once per content (named by the SHA-256 of the original bytes),
 * never overwritten or deleted by the module.
 *
 *   office PC   server/compliance2/files/<space>/<sha256>.c2e  (or C2_FILES_DIR)
 *   Vercel      private Blob "compliance2/<space>/<sha256>.c2e" (server/file-store.js) — readable only through the module
 *
 * Key: C2_FILE_KEY (64 hex characters, i.e. 32 random bytes) — REQUIRED for the live space; keep a copy of it apart from
 * the data backups (without it the files cannot be read). The demo space, which holds sample files only, uses a key derived
 * from JWT_SECRET when C2_FILE_KEY is not set.
 * File layout: "C2E1" · key id (1 byte) · IV (12) · tag (16) · ciphertext.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const U = require('./util');

let opts = { dir: process.env.C2_FILES_DIR || path.join(__dirname, '..', 'files'), blob: undefined, env: process.env };
let _blob = null;
const blob = () => {
  if (opts.blob !== undefined) return opts.blob;
  if (!_blob) _blob = require('../../file-store');
  return _blob.enabled ? _blob : null;
};
const configure = o => { opts = { ...opts, ...o }; };
const MAGIC = Buffer.from('C2E1');

function keyFor(space) {
  const k = opts.env.C2_FILE_KEY;
  if (k && /^[0-9a-f]{64}$/i.test(k)) return { id: 1, key: Buffer.from(k, 'hex') };
  if (space === 'demo' && opts.env.JWT_SECRET) return { id: 2, key: Buffer.from(crypto.hkdfSync('sha256', opts.env.JWT_SECRET, 'compliance2', 'demo-file-key', 32)) };
  throw U.httpError(503, k ? 'C2_FILE_KEY must be 64 hexadecimal characters' : 'Documents cannot be stored yet: the encryption key C2_FILE_KEY is not set on the server (see the module README, "Setup").');
}
function keyById(id, space) {
  if (id === 1) return keyFor('live').key;
  if (id === 2 && space === 'demo') return keyFor('demo').key;
  throw U.httpError(500, 'This file was encrypted with a key that is not available');
}
const status = () => ({ live_key: /^[0-9a-f]{64}$/i.test(opts.env.C2_FILE_KEY || ''), store: blob() ? 'vercel-blob' : 'local-disk' });

function encrypt(space, plain) {
  const { id, key } = keyFor(space);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from([id]), iv, c.getAuthTag(), body]);
}
function decrypt(space, packed) {
  if (!packed || packed.length < 33 || !packed.subarray(0, 4).equals(MAGIC)) throw U.httpError(500, 'The stored file is not in the expected format');
  const d = crypto.createDecipheriv('aes-256-gcm', keyById(packed[4], space), packed.subarray(5, 17));
  d.setAuthTag(packed.subarray(17, 33));
  return Buffer.concat([d.update(packed.subarray(33)), d.final()]);
}

const safeSpace = s => { if (!['live', 'demo'].includes(s)) throw new Error('Invalid space'); return s; };
const safeSha = h => { if (!/^[a-f0-9]{64}$/.test(h)) throw new Error('Invalid file reference'); return h; };
const nameOf = (space, sha) => `compliance2/${safeSpace(space)}/${safeSha(sha)}.c2e`;
const fileOf = (space, sha) => path.join(opts.dir, safeSpace(space), `${safeSha(sha)}.c2e`);

async function exists(space, sha) {
  const b = blob();
  return b ? b.exists(nameOf(space, sha)) : fs.existsSync(fileOf(space, sha));
}

/** Store the original bytes (encrypted). Identical content already stored → nothing is written. */
async function save(space, sha, plain) {
  if (U.sha256(plain) !== sha) throw new Error('Content hash mismatch');
  if (await exists(space, sha)) return { stored: false };
  const packed = encrypt(space, plain);
  const b = blob();
  if (b) { await b.save(nameOf(space, sha), packed, 'application/octet-stream'); return { stored: true }; }
  const file = fileOf(space, sha);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, packed);
  fs.renameSync(tmp, file);
  return { stored: true };
}

/** The original bytes, checked against their hash (a changed or damaged file is refused) */
async function read(space, sha) {
  const b = blob();
  let packed;
  if (b) packed = await b.read(nameOf(space, sha));
  else { try { packed = fs.readFileSync(fileOf(space, sha)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  if (!packed) return null;
  const plain = decrypt(space, packed);
  if (U.sha256(plain) !== sha) throw U.httpError(500, 'The stored file does not match its recorded hash');
  return plain;
}

const options = () => ({ ...opts });

module.exports = { configure, options, save, read, exists, status, encrypt, decrypt };
