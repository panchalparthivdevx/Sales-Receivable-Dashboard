/**
 * Original bill files. Office PC: server/bill-booking/files/<bill id>/<file> (or BB_FILES_DIR).
 * Vercel: private Blob storage under bill-booking/<bill id>/ (server/file-store.js), read back only
 * through the module's own login-checked route.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

let dir = process.env.BB_FILES_DIR || path.join(__dirname, '..', 'files');
let blob = null;   // file-store.js when it is enabled (Vercel)
function configure(o = {}) { if (o.dir) dir = o.dir; if ('blob' in o) blob = o.blob; }
function init() { const fsStore = require('../../file-store'); if (fsStore.enabled) blob = fsStore; }

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};
const ACCEPTED = new Set(Object.values(MIME));
const mimeOf = (name, given) => (ACCEPTED.has(given) ? given : MIME[path.extname(String(name || '')).toLowerCase()] || given || 'application/octet-stream');

/** Upload names arrive as latin1 from multer — restore UTF-8 (accented vendor names) */
function fixName(name) {
  const s = String(name || 'bill');
  try { const u = Buffer.from(s, 'latin1').toString('utf8'); if (!u.includes('�')) return u; } catch (_) {}
  return s;
}
const safeName = name => fixName(name).replace(/[\\/:*?"<>|\x00-\x1F]+/g, '_').replace(/^\.+/, '').slice(-120) || 'bill';
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function save(billId, name, buffer, mime) {
  const file = safeName(name);
  if (blob) await blob.save(`bill-booking/${billId}/${file}`, buffer, mime);
  else {
    const d = path.join(dir, billId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, file), buffer);
  }
  return file;
}

async function read(billId, file) {
  if (!/^[A-Za-z0-9-]+$/.test(billId) || file.includes('/') || file.includes('\\') || file.startsWith('.')) return null;
  if (blob) return blob.read(`bill-booking/${billId}/${file}`);
  const p = path.join(dir, billId, file);
  if (!p.startsWith(path.join(dir, billId))) return null;
  try { return fs.readFileSync(p); } catch (_) { return null; }
}

module.exports = { configure, init, save, read, mimeOf, ACCEPTED, safeName, fixName, sha256 };
