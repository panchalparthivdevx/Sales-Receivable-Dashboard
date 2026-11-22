'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const H = require('./helpers');
const P26 = require('../lib/parse26as');
const ST = require('../lib/statements');
const DEMO = require('../lib/demo');

const sc = DEMO.scenario();
const X = sc.entities[0];
const v1 = sc.statements[0];

test('TRACES text export: header, deductors, rows, sources and control totals', async () => {
  const p = await P26.parse(Buffer.from(v1.text), v1.file);
  assert.equal(p.format, 'traces_text');
  assert.equal(p.header.pan, 'ZZZPD1234K');
  assert.equal(p.header.fy, '2025-26');
  assert.equal(p.header.ay, '2026-27');
  assert.equal(p.header.statement_date, '2026-06-15');
  assert.equal(p.deductors.length, 10);
  assert.equal(p.rows.length, 11);
  const a = p.rows.find(r => r.tan === 'AHMA00001A' && r.deducted === 1000000);
  assert.deepEqual([a.section, a.txn_date, a.status, a.booking_date, a.amount_paid, a.deposited], ['194J(b)', '2026-01-12', 'F', '2026-05-15', 10000000, 1000000]);
  assert.equal(a.deductor, 'ALPHA EXACT PRIVATE LIMITED');
  assert.ok(a.src.line > 0 && a.src.file === v1.file, 'every row keeps its file and line');
  assert.equal(a.raw.paid, '100000.00', 'the printed value is kept');
  assert.ok(p.parts_seen.includes('PART-I') && p.parts_seen.includes('PART-II'));
  assert.deepEqual(ST.controlChecks(p), [], 'deductor totals agree with their rows');
  assert.equal(p.problems.length, 0);
});

test('a deductor total that disagrees with its rows, an unreadable row and a missing field are all reported', async () => {
  const bad = v1.text.replace('1^ALPHA EXACT PRIVATE LIMITED^AHMA00001A^^^^^120000.00^12000.00^12000.00', '1^ALPHA EXACT PRIVATE LIMITED^AHMA00001A^^^^^120000.00^12500.00^12000.00')
    .replace('^1^194C^16-Jan-2026^F^15-May-2026^-^249900.00^4998.00^4998.00', '^1^194C^16-Jan-2026^F^15-May-2026^-^249900.00^^4998.00\r\nthis line is garbage 123.45');
  const p = await P26.parse(Buffer.from(bad), 'bad.txt');
  const ctl = ST.controlChecks(p);
  assert.ok(ctl.some(c => c.tan === 'AHMA00001A' && c.field === 'tax deducted' && c.summary === 1250000 && c.rows === 1200000));
  assert.ok(p.problems.some(x => x.code === 'unreadable_row' && x.src.line > 0));
  assert.ok(p.problems.some(x => x.code === 'missing_fields' && /tax deducted/.test(x.message) && x.level === 'error'));
});

test('Excel: the text file split into columns, and a flat sheet with its own headings', async () => {
  const aoa = v1.text.split(/\r?\n/).map(l => l.split('^'));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '26AS');
  const p = await P26.parse(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'statement.xlsx');
  assert.equal(p.format, 'excel');
  assert.equal(p.rows.length, 11);
  assert.equal(p.header.pan, 'ZZZPD1234K');
  assert.ok(p.rows[0].src.sheet === '26AS' && p.rows[0].src.row > 0);

  const flat = [['Name of Deductor', 'TAN of Deductor', 'Section', 'Transaction Date', 'Status of Booking', 'Date of Booking', 'Amount Paid / Credited', 'Tax Deducted', 'TDS Deposited'],
    ['ALPHA EXACT PRIVATE LIMITED', 'AHMA00001A', '194J(b)', '12-Jan-2026', 'F', '15-May-2026', 100000, 10000, 10000],
    ['BETA ROUNDING LLP', 'AHMB00002B', '194C', 46038, 'F', '15-May-2026', 249900, 4998, 4998]];
  const wb2 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(flat), 'Sheet1');
  const f = await P26.parse(XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' }), 'flat.xlsx');
  assert.equal(f.format, 'excel_flat');
  assert.equal(f.rows.length, 2);
  assert.equal(f.rows[1].txn_date, '2026-01-16', 'an Excel date serial is read as a date');
  assert.equal(f.rows[1].deducted, 499800);
});

test('CSV with the statement\'s headings is read like Excel', async () => {
  const csv = 'Name of Deductor,TAN of Deductor,Section,Transaction Date,Status of Booking,Amount Paid / Credited,Tax Deducted,TDS Deposited\nGAMMA MISMATCH LIMITED,AHMC00003C,194C,06-Feb-2026,F,149899.50,2997.99,2997.99\n';
  const p = await P26.parse(Buffer.from(csv), 'x.csv');
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].deposited, 299799);
});

const pdfInput = { pan: X.pan, name: X.name, fy: '2025-26', ay: '2026-27', updated: '15-Jun-2026', deductors: [
  { sr: 1, cl: sc.C.A, rows: [{ section: '194J(b)', date: '12-Jan-2026', status: 'F', booked: '15-May-2026', paid: 100000, deducted: 10000, deposited: 10000 }, { section: '194J(b)', date: '05-Jan-2026', status: 'F', booked: '15-May-2026', paid: 20000, deducted: 2000, deposited: 2000 }] },
  { sr: 2, cl: sc.C.I, rows: [{ section: '194C', date: '26-Jan-2026', status: 'O', booked: '15-May-2026', paid: 300000, deducted: 6000, deposited: 0 }] },
  { sr: 3, cl: sc.C.B, rows: [{ section: '194C', date: '16-Jan-2026', status: 'F', booked: '15-May-2026', paid: 249900, deducted: 4998, deposited: 4998 }] }] };

test('PDF (portal layout, two pages): rows, page references, unreadable line flagged', async () => {
  const buf = H.statementPdf({ ...pdfInput, junk: 'Something unexpected 12,34.5x' });
  const p = await P26.parse(buf, 'statement.pdf');
  assert.equal(p.format, 'pdf');
  assert.equal(p.header.pan, 'ZZZPD1234K');
  assert.equal(p.header.fy, '2025-26');
  assert.equal(p.header.statement_date, '2026-06-15');
  assert.equal(p.rows.length, 4);
  assert.equal(p.deductors.length, 3);
  const i = p.rows.find(r => r.tan === 'AHMI00009I');
  assert.deepEqual([i.status, i.deducted, i.deposited], ['O', 600000, 0]);
  assert.ok(p.rows.some(r => r.src.page === 2), 'rows on page 2 carry their page');
  assert.deepEqual(ST.controlChecks(p), []);
  assert.ok(p.problems.some(x => x.code === 'unreadable_row' && x.src.page === 2));
});

test('password-protected PDF: asks for the password, rejects a wrong one, reads with the right one', async () => {
  const buf = H.statementPdf({ ...pdfInput, password: '01012010' });
  await assert.rejects(P26.parse(buf, 'locked.pdf'), e => e.needs_password === true && e.status === 422 && !e.wrong_password);
  await assert.rejects(P26.parse(buf, 'locked.pdf', { password: '31122099' }), e => e.needs_password === true && e.wrong_password === true);
  const p = await P26.parse(buf, 'locked.pdf', { password: '01012010' });
  assert.equal(p.rows.length, 4);
  assert.equal(p.header.pan, 'ZZZPD1234K');
});

test('TRACES ZIP with ZipCrypto password: prompt, wrong password, correct password', async () => {
  const zip = H.zipCrypto('ZZZPD1234K-2026.txt', v1.text, '15081995');
  await assert.rejects(P26.parse(zip, 'ZZZPD1234K-2026.zip'), e => e.needs_password === true);
  await assert.rejects(P26.parse(zip, 'ZZZPD1234K-2026.zip', { password: '00000000' }), e => e.wrong_password === true);
  const p = await P26.parse(zip, 'ZZZPD1234K-2026.zip', { password: '15081995' });
  assert.equal(p.rows.length, 11);
  assert.equal(p.inner_file, 'ZZZPD1234K-2026.txt');
  const open = await P26.parse(H.zipCrypto('a.txt', v1.text, null), 'a.zip');
  assert.equal(open.rows.length, 11);
});

test('validation: wrong entity (PAN) blocks the import; a statement with no rows is blocked', async () => {
  const p = await P26.parse(Buffer.from(v1.text), v1.file);
  const wrong = ST.validate(p, sc.entities[1]);
  assert.ok(wrong.blockers.some(b => /ZZZPD1234K/.test(b) && /ZZZFN5678L/.test(b)));
  const ok = ST.validate(p, X);
  assert.deepEqual(ok.blockers, []);
  assert.ok(ok.checks.find(c => c.id === 'pan').ok);
  const empty = await P26.parse(Buffer.from('hello world'), 'x.txt');
  assert.ok(ST.validate(empty, X).blockers.length >= 1);
});
