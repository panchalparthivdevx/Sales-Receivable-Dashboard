/**
 * Test helpers. ALL data is SYNTHETIC (PANs ZZZ…, TANs AHM…0000…): no real client, statement or amount.
 * - tempStore(): the module's store and file folder pointed at a fresh temporary folder (no database, no Blob)
 * - pdf(): a minimal PDF writer (text placed at x/y, several pages), optionally encrypted with the PDF Standard security handler
 *   (RC4, revision 2) so the password prompt is tested against a really protected file
 * - zipCrypto(): a ZIP with one entry, deflated and protected with traditional PKWARE (ZipCrypto) encryption, like the TRACES download
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-tds26as';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const store = require('../lib/store');
const files = require('../lib/files');
const CFG = require('../lib/config');
const { crc32, zipKeys } = require('../lib/parse26as');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't26test-'));
  store.configure({ dir: path.join(dir, 'data'), useDb: false });
  files.configure({ dir: path.join(dir, 'files'), blob: null });
  return dir;
}
const cfgNow = async () => CFG.merge(await store.read('config', null));
async function saveConfig(patch) { const c = await cfgNow(); await store.write('config', { ...c, ...patch }); }

// ── PDF ───────────────────────────────────────────────────────────────────────
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; out[k] = data[k] ^ s[(s[i] + s[j]) & 255]; }
  return out;
}
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const padPw = pw => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).slice(0, 32);
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** pages: [[{ x, y, t }]] (points, origin bottom-left, A4 = 595 × 842) */
function pdf(pages, { password } = {}) {
  const objs = [];
  const add = body => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesObj = add(null), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = [];
  const streams = [];
  for (const p of pages) {
    const content = p.map(c => `BT /F1 8 Tf ${c.x} ${c.y} Td (${esc(c.t)}) Tj ET`).join('\n');
    const cs = add({ stream: Buffer.from(content, 'latin1') });
    streams.push(cs);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${cs} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const id = crypto.randomBytes(16);
  let enc = null, key = null;
  if (password) {
    const P = -44;
    const oKey = md5(padPw(`${password}-owner`)).slice(0, 5);
    const O = rc4(oKey, padPw(password));
    const pb = Buffer.alloc(4); pb.writeInt32LE(P);
    key = md5(padPw(password), O, pb, id).slice(0, 5);
    const U = rc4(key, PAD);
    enc = add(`<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`);
  }
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = chunks[0].length;
  objs.forEach((o, i) => {
    const n = i + 1;
    let body;
    if (o && o.stream) {
      let data = o.stream;
      if (key) data = rc4(md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).slice(0, 10), data);
      body = Buffer.concat([Buffer.from(`${n} 0 obj\n<< /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else body = Buffer.from(`${n} 0 obj\n${o}\nendobj\n`, 'latin1');
    offsets.push(pos); chunks.push(body); pos += body.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${enc ? ` /Encrypt ${enc} 0 R` : ''} /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(chunks);
}

/** The demo statement's text layout turned into PDF lines the way the portal prints Part I (cells at fixed x per column) */
function statementPdf({ pan, name, fy, ay, updated, deductors, junk, password }) {
  const page1 = [], page2 = [];
  let y = 800;
  const line = (cells, pg = page1) => { cells.forEach(([x, t]) => pg.push({ x, y, t })); y -= 14; };
  // printed in pieces, as on a real statement: "Data" "updated" "till" "13-" "Apr-2026"
  const [dd, rest] = [updated.slice(0, 3), updated.slice(3)];
  line([[440, 'Data'], [462, 'updated'], [496, 'till'], [512, dd], [526, rest]]);
  line([[200, 'Annual Tax Statement']]);
  line([[18, 'Permanent Account Number (PAN)'], [140, pan], [200, 'Current Status of PAN'], [290, 'Active and Operative'], [360, 'Financial Year'], [420, fy], [460, 'Assessment Year'], [530, ay]]);
  line([[46, 'Name of Assessee'], [140, name]]);
  line([[10, 'PART-I - Details of Tax Deducted at Source']]);
  line([[16, 'Sr. No.'], [142, 'Name of Deductor'], [302, 'TAN of Deductor'], [366, 'Total Amount Paid/'], [435, 'Total Tax Deducted #'], [526, 'Total TDS']]);
  line([[382, 'Credited'], [527, 'Deposited']]);
  let pg = page1;
  deductors.forEach((d, di) => {
    if (di === Math.ceil(deductors.length / 2)) { pg = page2; y = 800; line([[20, `Assessee PAN: ${pan}`], [242, `Assessee Name: ${name}`], [498, `Assessment Year: ${ay}`]], pg); }
    const s = f => (d.rows.reduce((a, x) => a + Math.round(x[f] * 100), 0) / 100).toFixed(2);
    line([[16, String(d.sr)], [60, d.cl.name], [302, d.cl.tan], [380, s('paid')], [450, s('deducted')], [525, s('deposited')]], pg);
    line([[16, 'Sr. No.'], [47, 'Section 1'], [108, 'Transaction Date'], [173, 'Status of Booking*'], [241, 'Date of Booking'], [311, 'Remarks**'], [373, 'Amount Paid /'], [435, 'Tax Deducted ##'], [519, 'TDS Deposited']], pg);
    line([[382, 'Credited']], pg);
    d.rows.forEach((x, i) => line([[16, String(i + 1)], [47, x.section], [108, x.date], [180, x.status], [241, x.booked], [320, '-'], [380, x.paid.toFixed(2)], [450, x.deducted.toFixed(2)], [525, x.deposited.toFixed(2)]], pg));
  });
  if (junk) line([[16, junk]], pg);
  line([[10, 'PART-II - Details of Tax Deducted at Source for 15G / 15H']], pg);
  line([[10, 'No Transactions Present']], pg);
  return pdf(page2.length ? [page1, page2] : [page1], { password });
}

// ── ZIP (ZipCrypto) ───────────────────────────────────────────────────────────
function zipCrypto(name, content, password) {
  const plain = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const crc = crc32(plain);
  let data = zlib.deflateRawSync(plain);
  let flags = 0;
  if (password) {
    flags = 1;
    const z = zipKeys(password);
    const head = Buffer.concat([crypto.randomBytes(11), Buffer.from([(crc >>> 24) & 0xff])]);
    const all = Buffer.concat([head, data]);
    const out = Buffer.alloc(all.length);
    for (let i = 0; i < all.length; i++) { const k = z.byte(); out[i] = all[i] ^ k; z.upd(all[i]); }
    data = out;
  }
  const nm = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x5a00, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(nm.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x5a00, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(plain.length, 24); central.writeUInt16LE(nm.length, 28); central.writeUInt32LE(0, 42);
  const cdOff = 30 + nm.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + nm.length, 12); eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([local, nm, data, central, nm, eocd]);
}

module.exports = { tempStore, cfgNow, saveConfig, pdf, statementPdf, zipCrypto, rc4 };
