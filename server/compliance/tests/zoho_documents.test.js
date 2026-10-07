'use strict';

// Zoho period cache (no calls when revisiting a synced period) and document storage rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const P  = require('../lib/period');
const ZS = require('../lib/zohoSync');
const D  = require('../lib/documents');
const H  = require('./helpers');

function fakeZoho() {
  const calls = [];
  const zohoGet = async (p, params) => {
    calls.push({ path: p, params });
    const key = p.replace('/', '');
    const day = params.date_start;                         // pretend Zoho honoured the range
    return { [key]: [{ date: day, status: 'paid', total: 100, amount: 100 }, { date: day, status: 'void', total: 50 }], page_context: { has_more_page: false } };
  };
  return { zohoGet, calls };
}

test('Zoho: returning to an already-synced month makes zero Zoho calls', async () => {
  const state = H.seededState();
  const settings = H.settings();
  const { zohoGet, calls } = fakeZoho();
  const sync = ZS.createZohoSync({ zohoGet });
  const cache = { periods: {} };
  const save = async (k, rec) => { cache.periods[k] = rec; };
  const aug = P.validateSelection({ fy: '2026-27', month: 'AUG' });
  const sep = P.validateSelection({ fy: '2026-27', month: 'SEP' });
  const devx = { company_id: 'CO-001' };

  // Not synced yet: reading status/data never calls Zoho
  let st = ZS.statusOf(cache, ZS.periodsFor(state, aug, devx));
  assert.equal(st.synced, 0);
  assert.equal(calls.length, 0);

  // Explicit sync
  await sync.syncPeriods(ZS.periodsFor(state, aug, devx), cache, { settings, user: H.USER, save });
  const afterSync = calls.length;
  assert.ok(afterSync > 0);
  assert.ok(calls.every(c => c.params.organization_id === '60027116474' && c.params.date_start === '2026-08-01' && c.params.date_end === '2026-08-31'));

  // Switch away (September) and back (August): status + data read the cache only
  ZS.statusOf(cache, ZS.periodsFor(state, sep, devx));
  ZS.dataOf(cache, ZS.periodsFor(state, sep, devx), settings);
  st = ZS.statusOf(cache, ZS.periodsFor(state, aug, devx));
  const data = ZS.dataOf(cache, ZS.periodsFor(state, aug, devx), settings);
  assert.equal(st.synced, 1);
  assert.equal(data.entities.find(e => e.key === 'invoices').count, 1, 'void invoice excluded');
  // "Sync missing" on a synced month reuses stored data
  const r = await sync.syncPeriods(ZS.periodsFor(state, aug, devx), cache, { settings, user: H.USER, save, onlyMissing: true });
  assert.match(r[0].skipped, /reused/);
  assert.equal(calls.length, afterSync, 'no Zoho call after the first sync');
});

test('Zoho: a broader selection reports "x of y periods synced"; unlinked companies are not counted', () => {
  const state = H.seededState();
  const q2 = P.validateSelection({ fy: '2026-27', quarter: 'Q2' });
  const cache = { periods: { [ZS.cacheKey('CO-001', '2026-27', 'AUG')]: { ok: true, synced_at: '2026-10-03T10:00:00Z', entities: {} } } };
  const st = ZS.statusOf(cache, ZS.periodsFor(state, q2));
  assert.equal(st.total, 6);            // DEVX + NTD linked × 3 months; SAAS has no Zoho org
  assert.equal(st.synced, 1);
  assert.equal(st.unlinked, 3);
});

test('Documents: upload routing Challan / Receipt / Other Data', () => {
  const s = H.settings();
  assert.equal(D.leafFor(s, 'Challan'), 'Challan');
  assert.equal(D.leafFor(s, 'Payment Receipt'), 'Receipt');
  assert.equal(D.leafFor(s, 'Return Filing Receipt'), 'Receipt');
  assert.equal(D.leafFor(s, 'Acknowledgement Receipt'), 'Receipt');
  for (const t of ['TRACES Document', 'Form 16A', 'Notice', 'Reply', 'Other']) assert.equal(D.leafFor(s, t), 'Other Data', t);
});

test('Documents: folder creation is idempotent and follows ROOT/COMPANY/FY/MODULE/Qn/Month/leaf', () => {
  const root = H.tmpDir();
  const s = H.settings({ storage_root: root });
  const company = { id: 'CO-001', name: 'Dev Accelerator Limited' };
  const first = D.createFolderStructure({ settings: s, company, fy: '2025-26', modules: ['GST', 'TDS'] });
  assert.deepEqual(first.results.map(r => r.status), ['Created', 'Created']);
  assert.ok(fs.existsSync(path.join(root, 'Dev Accelerator Limited', 'FY 2025-26', 'GST', 'Q1', 'April', 'Receipt')));
  assert.ok(fs.existsSync(path.join(root, 'Dev Accelerator Limited', 'FY 2025-26', 'TDS', 'Q4', 'March', 'Other Data')));
  const second = D.createFolderStructure({ settings: s, company, fy: '2025-26', modules: ['GST', 'TDS'] });
  assert.deepEqual(second.results.map(r => r.status), ['Already Exists', 'Already Exists']);
  assert.equal(second.results[0].created, 0);
  // FYs never mix
  assert.ok(!fs.existsSync(path.join(root, 'Dev Accelerator Limited', 'FY 2026-27')));
});

test('Documents: sanitising and path traversal guard', () => {
  assert.equal(D.sanitizeFileName('../../etc/passwd.pdf').name, 'passwd.pdf');
  assert.equal(D.sanitizeFileName('..\\..\\win.ini.PDF').name, 'win.ini.pdf');
  assert.equal(D.sanitizeSegment('a/b\\c:d*e?f'), 'a-b-c-d-e-f');
  assert.equal(D.sanitizeSegment('..'), 'item');
  assert.equal(D.sanitizeSegment('CON'), '_CON');
  const root = H.tmpDir();
  assert.throws(() => D.safeJoin(root, '..', 'outside.txt'), /outside the storage root/);
});

test('Documents: file type, size and content checks', () => {
  const s = H.settings({ upload: { max_size_mb: 1, allowed_extensions: ['.pdf', '.csv'] } });
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100)]);
  assert.equal(D.checkFile(pdf, 'challan.pdf', s), null);
  assert.match(D.checkFile(Buffer.from('MZ....'), 'challan.pdf', s), /does not look like a real .pdf/);
  assert.match(D.checkFile(pdf, 'run.exe', s), /not allowed/);
  assert.match(D.checkFile(Buffer.alloc(2 * 1024 * 1024, 65), 'big.csv', s), /larger than 1 MB/);
});
