/**
 * Test helpers: a temporary store and an Express app around the router with a fake logged-in user.
 * Synthetic workbooks are built in memory — their figures are SYNTHETIC, not company data.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-fin-reporting';

const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const REAL_DIR = path.join(__dirname, '..', '..', '..', 'Financials & Presentations', 'Financials');
const hasReal = () => fs.existsSync(REAL_DIR) && fs.readdirSync(REAL_DIR).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$')).length >= 6;

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-'));
  require('../lib/store').configure({ dir, useDb: false });
  return dir;
}

const USERS = [
  { id: '1', username: 'admin', name: 'Admin', role: 'admin', active: true, permissions: {} },
  { id: '2', username: 'viewer', name: 'Viewer', role: 'user', active: true, permissions: { fin_stmt: { enabled: true, sections: {} } } },
  { id: '3', username: 'none', name: 'No access', role: 'user', active: true, permissions: { fin_stmt: { enabled: false, sections: {} } } },
  { id: '4', username: 'importer', name: 'Importer', role: 'user', active: true, permissions: { fin_stmt: { enabled: true, sections: { fs_import: true } } } },
];

function app(router, userId = '1') {
  const express = require('express');
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = { id: req.headers['x-user'] || userId }; next(); });
  router.init({ loadUsers: async () => USERS, readLegacy: async () => null });
  a.use('/api/fin-reporting', router);
  return a;
}

async function call(server, method, url, { body, user, raw, form } = {}) {
  const { port } = server.address();
  const headers = { ...(user ? { 'x-user': user } : {}) };
  if (!form) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  if (raw) return r;
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: r.status, body: json, text };
}

/** In-memory synthetic workbook: { sheetName: [[cells]] }; opts.hidden, opts.merges, opts.formulas, opts.errors */
function workbook(sheets, opts = {}) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
    if (opts.merges?.[name]) ws['!merges'] = opts.merges[name];
    if (opts.formulas?.[name]) for (const [a, f] of Object.entries(opts.formulas[name])) ws[a] = { ...(ws[a] || { t: 'n' }), f };
    if (opts.errors?.[name]) for (const a of opts.errors[name]) ws[a] = { t: 'e', v: 23, w: '#REF!' };
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  if (opts.hidden) { wb.Workbook = wb.Workbook || {}; wb.Workbook.Sheets = wb.SheetNames.map(n => ({ name: n, Hidden: opts.hidden.includes(n) ? 1 : 0 })); }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { REAL_DIR, hasReal, tempStore, USERS, app, call, workbook };
