/**
 * Test harness: the module's router on a throw-away Express app, a temporary store and file folder, synthetic users,
 * a fixed clock and a stand-in malware scanner. ALL data here is SYNTHETIC.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-compliance2';
process.env.C2_FILE_KEY = '1f'.repeat(32);

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const store = require('../lib/store');
const BL = require('../lib/blobs');
const SC = require('../lib/scanner');
const U = require('../lib/util');
const V = require('../lib/validate');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const dataDir = tmp('c2data-');
const filesDir = tmp('c2files-');
store.configure({ dir: dataDir, useDb: false });
BL.configure({ dir: filesDir, blob: null, env: process.env });
SC.setScanner(async buf => (buf.includes('X5O!P%@AP-TEST-SIGNATURE') ? { status: 'infected', engine: 'test', detail: 'test signature' } : { status: 'clean', engine: 'test' }));
U.clock.set(() => Date.parse('2026-11-14T06:30:00Z'));                     // 14 Nov 2026, 12:00 IST

const perm = (...sections) => ({ compliance_v2: { enabled: true, sections: Object.fromEntries(sections.map(s => [s, true])) } });
const USERS = [
  { id: '1', username: 'admin', name: 'Admin', role: 'admin', active: true, permissions: {} },
  { id: 'm', username: 'maker', name: 'Maker', role: 'user', active: true, permissions: perm('c2_prepare', 'c2_master') },
  { id: 'c', username: 'checker', name: 'Checker', role: 'user', active: true, permissions: perm('c2_review') },
  { id: 'f', username: 'filer', name: 'Filer', role: 'user', active: true, permissions: perm('c2_file', 'c2_prepare') },
  { id: 'v', username: 'verifier', name: 'Verifier', role: 'user', active: true, permissions: perm('c2_verify') },
  { id: 'a', username: 'approver', name: 'Approver', role: 'user', active: true, permissions: perm('c2_approve', 'c2_rules') },
  { id: 'r', username: 'rules', name: 'Rules Editor', role: 'user', active: true, permissions: perm('c2_rules') },
  { id: 'aud', username: 'auditor', name: 'Auditor', role: 'user', active: true, permissions: perm('c2_auditor', 'c2_prepare', 'c2_master') },
  { id: 's', username: 'scoped', name: 'Scoped Maker', role: 'user', active: true, permissions: perm('c2_prepare', 'c2_master') },
  { id: 'n', username: 'none', name: 'No Access', role: 'user', active: true, permissions: {} },
  { id: 'ini', username: 'initiator', name: 'Initiator One', role: 'user', active: true, permissions: perm('c2_initiator') },
  { id: 'apr', username: 'approver1', name: 'Approver One', role: 'user', active: true, permissions: perm('c2_approver') },
];

const router = require('..');
router.init({ loadUsers: async () => USERS });
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  // like server/index.js: the signed download link and the Microsoft sign-in callback stand on their own
  if (req.path.startsWith('/api/compliance2/dl/') || req.path === '/api/compliance2/onedrive/callback') return next();
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'Not authenticated' });
  req.user = { id };
  next();
});
app.use('/api/compliance2', router);

let base = null;
let server = null;
async function start() {
  if (server) return;
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/compliance2`;
}
async function stop() { if (server) await new Promise(r => server.close(r)); server = null; }

/** call('m', 'POST', '/org/entity', body, { space: 'demo', persona: 'checker' }) → { status, body, headers, raw } */
async function call(user, method, p, body, { space, persona, form } = {}) {
  const url = `${base}${p}${space ? `${p.includes('?') ? '&' : '?'}space=${space}` : ''}`;
  const headers = {};
  if (user) headers['x-test-user'] = user;
  if (persona) headers['x-c2-persona'] = persona;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(url, { method, headers, body: payload });
  const raw = Buffer.from(await r.arrayBuffer());
  let parsed = null;
  if ((r.headers.get('content-type') || '').includes('json')) { try { parsed = JSON.parse(raw.toString('utf8')); } catch (_) { /* not JSON */ } }
  return { status: r.status, body: parsed, headers: r.headers, raw };
}

function fileForm(buffer, name, fields = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append('file', new Blob([buffer]), name);
  return f;
}

const gstin = (state, pan, n = '1') => { const f = `${state}${pan}${n}Z`; return f + V.gstinCheckChar(f); };

/** Minimal ZIP reader for the tests: [{ name, data }] */
function unzip(buf) {
  const zlib = require('zlib');
  const out = [];
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8), csize = buf.readUInt32LE(i + 18), nlen = buf.readUInt16LE(i + 26), xlen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nlen).toString('utf8');
    const body = buf.subarray(i + 30 + nlen + xlen, i + 30 + nlen + xlen + csize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(body) : body, crc: buf.readUInt32LE(i + 14) });
    i += 30 + nlen + xlen + csize;
  }
  return out;
}

module.exports = { start, stop, call, fileForm, gstin, unzip, USERS, dataDir, filesDir };
