/**
 * Form 26AS (Annual Tax Statement) reader → one canonical statement:
 *   { format, header: { pan, name, fy, ay, tax_year, statement_date, … }, deductors[], rows[], problems[], parts_seen[] }
 *
 * Formats:
 *   traces_text   TRACES "Export as Text": "^"-separated lines (also inside the ZIP TRACES delivers, ZipCrypto-protected with the
 *                 PAN holder's date of birth / incorporation as DDMMYYYY)
 *   excel         the text file opened in Excel (Text to Columns on "^"), or any sheet laid out like the statement
 *   excel_flat    a sheet with one credit per row and its own heading row (Deductor, TAN, Section, Transaction Date, …)
 *   pdf           the statement PDF from the e-filing portal / TRACES, also when password-protected (pdf.js decrypts it)
 *
 * Only PART-I (Details of Tax Deducted at Source) is read — the credits a payee claims for income it received. Other parts are noted
 * in parts_seen. Columns are found by their headings, never by position alone, and every value keeps its source (line, sheet + row, or
 * PDF page + line) and the text as printed. Layout facts were checked against a published statement (Annual Tax Statement generated
 * 13-Apr-2026): Part I headings "Sr. No. | Name of Deductor | TAN of Deductor | Total Amount Paid/Credited | Total Tax Deducted # |
 * Total TDS Deposited" and "Sr. No. | Section | Transaction Date | Status of Booking* | Date of Booking | Remarks** | Amount Paid /
 * Credited | Tax Deducted ## | TDS Deposited"; dates as 15-Apr-2026; booking status legend U, M, P, F, O, Z.
 * NOT yet seen: a Tax Year 2026-27 statement (Form 168 under the Income-tax Act, 2025) — its headings may differ; anything not
 * recognised is reported as a problem instead of being guessed.
 */

'use strict';

const zlib = require('zlib');
const { toPaise, parseDate, TAN_RE, PAN_RE, normTan, normPan } = require('./util');

const BOOKING_STATUS = {
  F: 'Final — deposit matched with the deductor\'s statement',
  O: 'Overbooked — claimed in the statement but not fully deposited',
  U: 'Unmatched — deposit not found or particulars wrong',
  P: 'Provisional — government deductor, awaiting PAO verification',
  M: 'Matched (challan matched with OLTAS)',
  Z: 'Mismatch (challan not matched with OLTAS)',
};

// booking status as printed (letter or word) → the legend letter; "Mismatch" is Z, not M
const STATUS_OF_WORD = { FINAL: 'F', OVERBOOKED: 'O', UNMATCHED: 'U', PROVISIONAL: 'P', MATCHED: 'M', MISMATCH: 'Z' };
const statusLetter = v => { const t = String(v || '').trim().toUpperCase(); if (t.length === 1) return t; const w = (t.match(/^[A-Z]+/) || [''])[0]; return STATUS_OF_WORD[w] || t; };
const problem = (level, code, message, src) => ({ level, code, message, ...(src ? { src } : {}) });
const isAmount = s => typeof s === 'number' ? Number.isFinite(s) : /^\(?-?[\d,]+(\.\d{1,2})?\)?$/.test(String(s || '').trim()) && /\d/.test(String(s));
const amt = v => (typeof v === 'number' ? toPaise(v) : toPaise(String(v || '').trim()));
const txt = v => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();

function normFy(v) {
  const m = String(v || '').match(/(\d{4})\s*-\s*(\d{2,4})/);
  if (!m) return '';
  const s = +m[1];
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}
const fyFromAy = ay => { const f = normFy(ay); if (!f) return ''; const s = +f.slice(0, 4) - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

// ── Header block ──────────────────────────────────────────────────────────────
const HEADER_LABELS = [
  ['file_created', /file creation date/i], ['data_updated_till', /data updated till/i], ['pan_status', /current status of pan|status of pan/i],
  ['pan', /permanent account number|^pan$/i], ['fy', /^financial year/i], ['ay', /^assessment year/i], ['tax_year', /^tax year/i], ['name', /name of (the )?assessee|name of taxpayer/i],
];
const headerKey = cell => { const c = txt(cell); for (const [k, re] of HEADER_LABELS) if (re.test(c)) return k; return null; };

function finishHeader(h, problems) {
  const out = { pan: normPan(h.pan), name: txt(h.name), pan_status: txt(h.pan_status), fy: normFy(h.fy), ay: normFy(h.ay), tax_year: normFy(h.tax_year),
    data_updated_till: parseDate(h.data_updated_till), file_created: parseDate(h.file_created) };
  if (!out.fy && out.tax_year) out.fy = out.tax_year;           // Income-tax Act, 2025: the "tax year" is the financial year itself
  if (!out.fy && out.ay) out.fy = fyFromAy(out.ay);
  out.statement_date = out.data_updated_till || out.file_created || null;
  out.statement_date_basis = out.data_updated_till ? 'Data updated till' : out.file_created ? 'File creation date' : '';
  if (out.pan && !PAN_RE.test(out.pan)) problems.push(problem('error', 'pan_unreadable', `The PAN in the statement header ("${h.pan}") is not a valid PAN`));
  return out;
}

// ── Rows of cells (text export and Excel) ────────────────────────────────────
const SR_HEAD = /^(sr|sl|s)\.?\s*no/i;                          // "Sr. No." (26AS) and "S.No." (Tax Year 2026-27 statement)
const COLS_DEDUCTOR = [['sr', SR_HEAD], ['name', /name of deductor/i], ['tan', /tan of deductor/i], ['paid', /amount paid/i], ['deducted', /tax deducted/i], ['deposited', /tds deposited|tax deposited/i]];
const COLS_TXN = [['sr', SR_HEAD], ['section', /^section/i], ['txn_date', /transaction date/i], ['status', /status of booking/i], ['booking_date', /date of booking/i],
  ['remarks', /^remarks/i], ['paid', /amount paid/i], ['deducted', /tax deducted/i], ['deposited', /tds deposited|tax deposited/i]];
const COLS_FLAT = [['name', /name of deductor|deductor name|^deductor$/i], ['tan', /^tan|tan of deductor|deductor tan/i], ['section', /^section/i], ['txn_date', /transaction date|date of (payment|credit)/i],
  ['status', /status of booking|booking status/i], ['booking_date', /date of booking|booking date/i], ['remarks', /^remarks/i], ['paid', /amount paid|paid.*credited/i],
  ['deducted', /tax deducted|tds deducted/i], ['deposited', /tds deposited|tax deposited|deposited/i]];
function columns(cells, defs) {
  const idx = {};
  cells.forEach((c, i) => { const t = txt(c); if (!t) return; for (const [k, re] of defs) if (idx[k] === undefined && re.test(t)) { idx[k] = i; break; } });
  return idx;
}
const isPart1Title = t => /part\s*-?\s*(i|1|a)\b(?![iv])/i.test(t) && /tax deducted at source/i.test(t) && !/15g|15h|194ia|194ib|194m|194s|buyer|seller/i.test(t);
const otherPart = t => { const m = t.match(/^\s*part\s*-?\s*(ii|iii|iv|vi{0,3}|ix|x|[2-9]|10|[b-h])\b/i); return m ? `PART-${m[1].toUpperCase()}` : null; };
// page furniture repeated on every page ("Page 2 of 59", "Annual Tax Statement") is skipped, not reported
const SKIP_LINE = /no transactions present|^gross total|^total\b|^assessee pan|^\(all amount values|^page \d+ of\b|^annual tax statement$|^form (no\.?\s*)?(26as|168)$/i;

function parseCells(rowsIn, format, { srcOf }) {
  const problems = [], deductors = [], rows = [], partsSeen = [];
  const h = {};
  let part = null, dcols = null, tcols = null, current = null, gross = null;
  for (let i = 0; i < rowsIn.length; i++) {
    const cells = rowsIn[i].cells;
    const line = txt(cells.map(txt).filter(Boolean).join(' '));
    if (!line) continue;
    // header block (above PART-I): a label row with the values on the next row, "label: value" cells, label/value pairs side by side,
    // or label and value in one cell — the Tax Year 2026-27 statement prints "Data updated till 14-Nov-2026" in one cell and
    // "Name of Assessee" on its own row with the name below it (seen on a real statement, 23 Nov 2026)
    const keys = part === null ? cells.map(headerKey) : [];
    if (keys.some(Boolean)) {
      const next = (rowsIn[i + 1] || { cells: [] }).cells;
      const nextIsValues = !next.map(headerKey).some(Boolean) && (next.some(c => PAN_RE.test(normPan(c))) || keys.some((k, j) => k && txt(next[j])));
      let usedNext = false;
      keys.forEach((k, j) => {
        if (!k || h[k]) return;
        const c = txt(cells[j]);
        const inline = c.includes(':') ? c.split(/:\s*/).slice(1).join(':').trim() : '';
        const sameCell = (k === 'data_updated_till' || k === 'file_created') ? (c.match(/(\d{1,2}[-/.][A-Za-z0-9]{2,3}[-/.]\d{4})\s*$/) || [])[1] || '' : '';
        const below = nextIsValues ? txt(next[j]) : '';
        const side = keys[j + 1] ? '' : txt(cells[j + 1]);
        const v = inline || sameCell || below || side;
        if (v) { h[k] = v; if (!inline && !sameCell && below) usedNext = true; }
      });
      if (usedNext) i++;
      continue;
    }
    if (isPart1Title(line)) { part = 'I'; partsSeen.push('PART-I'); continue; }
    const op = otherPart(line);
    if (op && /details|tds|tcs|refund|defaults|tax/i.test(line)) { partsSeen.push(op); part = 'other'; continue; }
    if (part !== 'I') continue;
    if (/^gross total/i.test(line)) { gross = grossOf(cells.map(txt).filter(isAmount), srcOf(i)) || gross; continue; }
    if (SKIP_LINE.test(line)) continue;
    const dc = columns(cells, COLS_DEDUCTOR), tc = columns(cells, COLS_TXN);
    if (dc.name !== undefined && dc.tan !== undefined) { dcols = dc; continue; }
    if (tc.txn_date !== undefined && tc.section !== undefined) { tcols = tc; continue; }
    const src = srcOf(i);
    const tanCell = dcols && dcols.tan !== undefined ? normTan(cells[dcols.tan]) : '';
    if (dcols && TAN_RE.test(tanCell)) {
      current = { sr: txt(cells[dcols.sr]), name: txt(cells[dcols.name]), tan: tanCell, total_paid: amt(cells[dcols.paid]), total_deducted: amt(cells[dcols.deducted]), total_deposited: amt(cells[dcols.deposited]), src };
      deductors.push(current);
      continue;
    }
    const dateCell = tcols ? cells[tcols.txn_date] : undefined;
    if (tcols && parseDate(typeof dateCell === 'number' ? dateCell : txt(dateCell))) {
      const r = rowFrom(cells, tcols, current, src, problems);
      rows.push(r);
      continue;
    }
    problems.push(problem('warning', 'unreadable_row', `Line not understood inside PART-I: "${line.slice(0, 140)}"`, src));
  }
  return { header: finishHeader(h, problems), deductors, rows, problems, parts_seen: [...new Set(partsSeen)], format, gross };
}

/** PART-I "Gross Total" line: the last three amounts are paid / credited, tax deducted, TDS deposited (Tax Year 2026-27 statement) */
function grossOf(amounts, src) {
  if (amounts.length < 3) return null;
  const [p, d, dep] = amounts.slice(-3).map(amt);
  return { amount_paid: p, deducted: d, deposited: dep, src };
}

function rowFrom(cells, c, deductor, src, problems) {
  const raw = {};
  for (const k of Object.keys(c)) raw[k] = txt(cells[c[k]]);
  const status = txt(cells[c.status]).toUpperCase();
  const r = {
    deductor: deductor ? deductor.name : '', tan: deductor ? deductor.tan : '', deductor_sr: deductor ? deductor.sr : '',
    sr: raw.sr || '', section: raw.section || '', txn_date: parseDate(typeof cells[c.txn_date] === 'number' ? cells[c.txn_date] : raw.txn_date),
    status: statusLetter(status),
    booking_date: parseDate(typeof cells[c.booking_date] === 'number' ? cells[c.booking_date] : raw.booking_date), remarks: raw.remarks && raw.remarks !== '-' ? raw.remarks : '',
    amount_paid: amt(cells[c.paid]), deducted: amt(cells[c.deducted]), deposited: amt(cells[c.deposited]), src, raw,
  };
  checkRow(r, problems);
  return r;
}

function checkRow(r, problems) {
  const miss = [];
  if (!r.tan) miss.push('deductor TAN');
  if (!r.txn_date) miss.push('transaction date');
  if (r.deducted === null) miss.push('tax deducted');
  if (r.deposited === null) miss.push('TDS deposited');
  if (r.amount_paid === null) miss.push('amount paid / credited');
  if (!r.section) miss.push('section');
  if (miss.length) problems.push(problem(miss.some(m => /TAN|transaction date|tax deducted|TDS deposited/.test(m)) ? 'error' : 'warning', 'missing_fields', `Row ${r.sr || '?'}${r.deductor ? ` (${r.deductor})` : ''}: ${miss.join(', ')} missing`, r.src));
  if (r.tan && !TAN_RE.test(r.tan)) problems.push(problem('error', 'tan_invalid', `Row ${r.sr || '?'}: TAN "${r.tan}" is not a valid TAN`, r.src));
  if (r.status && !BOOKING_STATUS[r.status]) problems.push(problem('warning', 'status_unknown', `Row ${r.sr || '?'}: booking status "${r.status}" is not in the legend (U, M, P, F, O, Z)`, r.src));
}

/** A sheet with its own heading row and one credit per row (no deductor summary rows) */
function parseFlat(rowsIn, { srcOf }) {
  const problems = [], rows = [], deductors = [];
  let cols = null;
  for (let i = 0; i < rowsIn.length; i++) {
    const cells = rowsIn[i].cells;
    if (!cols) { const c = columns(cells, COLS_FLAT); if (c.tan !== undefined && c.txn_date !== undefined && (c.deducted !== undefined || c.deposited !== undefined)) cols = c; continue; }
    const line = txt(cells.map(txt).join(' '));
    if (!line) continue;
    const tan = normTan(cells[cols.tan]);
    const d = cells[cols.txn_date];
    if (!TAN_RE.test(tan) && !parseDate(typeof d === 'number' ? d : txt(d))) { if (!SKIP_LINE.test(line)) problems.push(problem('warning', 'unreadable_row', `Row not understood: "${line.slice(0, 140)}"`, srcOf(i))); continue; }
    const ded = { name: txt(cells[cols.name]), tan, sr: '' };
    const r = rowFrom(cells, cols, ded, srcOf(i), problems);
    r.tan = tan;
    rows.push(r);
  }
  return { cols, rows, deductors, problems };
}

// ── Text export ───────────────────────────────────────────────────────────────
function decodeText(buf) {
  const u = buf.toString('utf8');
  return (u.includes('�') ? buf.toString('latin1') : u).replace(/^﻿/, '');
}
function parseText(buf, fileName) {
  const lines = decodeText(buf).split(/\r?\n/);
  const rowsIn = lines.map(l => ({ cells: l.split('^') }));
  const out = parseCells(rowsIn, 'traces_text', { srcOf: i => ({ file: fileName, line: i + 1 }) });
  if (!out.rows.length && !out.deductors.length && !lines.some(l => l.includes('^'))) out.problems.push(problem('error', 'not_26as_text', 'This text file is not a TRACES Form 26AS export (no "^"-separated lines found)'));
  return out;
}

// ── Excel / CSV ───────────────────────────────────────────────────────────────
function parseExcel(buf, fileName) {
  const XLSX = require('xlsx');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: false }); }
  catch (e) {
    if (/password|encrypt/i.test(e.message)) throw Object.assign(new Error('This Excel file is password-protected. Open it in Excel, remove the password (File → Info → Protect Workbook → Encrypt with Password, clear it), save, and upload again — or upload the original PDF or text file.'), { status: 400 });
    throw Object.assign(new Error(`The Excel file could not be read: ${e.message}`), { status: 400 });
  }
  let best = null;
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    const rowsIn = aoa.map(r => ({ cells: r.map(v => (typeof v === 'string' ? v : v)) }));
    const srcOf = i => ({ file: fileName, sheet: name, row: i + 1 });
    const cellsOut = parseCells(rowsIn.map(r => ({ cells: r.cells.map(v => (typeof v === 'number' ? v : String(v))) })), 'excel', { srcOf });
    if (cellsOut.rows.length || cellsOut.deductors.length) { if (!best || cellsOut.rows.length > best.rows.length) best = { ...cellsOut, sheet: name }; continue; }
    const flat = parseFlat(rowsIn, { srcOf });
    if (flat.cols && (!best || flat.rows.length > best.rows.length)) best = { header: cellsOut.header, deductors: [], rows: flat.rows, problems: [...cellsOut.problems, ...flat.problems], parts_seen: cellsOut.parts_seen, format: 'excel_flat', sheet: name };
  }
  if (!best) return { format: 'excel', header: finishHeader({}, []), deductors: [], rows: [], parts_seen: [], problems: [problem('error', 'no_part1', 'No Form 26AS PART-I table and no sheet with Deductor / TAN / Transaction Date / Tax Deducted headings was found in this workbook')] };
  return best;
}

// ── PDF ───────────────────────────────────────────────────────────────────────
function shimCanvas() {
  try { require('canvas'); } catch (_) {
    try { const p = require.resolve('canvas'); require.cache[p] = { id: p, filename: p, loaded: true, exports: require('@napi-rs/canvas') }; } catch (_2) { /* text extraction does not need it */ }
  }
}

async function pdfLines(buf, password) {
  shimCanvas();
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(buf), password: password || undefined, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise; }
  catch (e) {
    if (e && e.name === 'PasswordException') throw Object.assign(new Error(e.code === 2 ? 'The password is not correct for this PDF.' : 'This PDF is password-protected. Enter its password (for Form 26AS usually the date of birth or incorporation as DDMMYYYY).'),
      { status: 422, needs_password: true, wrong_password: e.code === 2 });
    throw Object.assign(new Error(`The PDF could not be read: ${e.message}`), { status: 400 });
  }
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5], x = it.transform[4];
      let row = rows.find(r => Math.abs(r.y - y) <= 2.2);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, s: it.str.trim() });
    }
    rows.sort((a, b) => b.y - a.y);
    // pdfmake prints a date that does not fit its column as two pieces on the same line ("13-" "Apr-2026", seen on a real statement)
    const joinDates = s => s.replace(/\b(\d{1,2})\s*-\s+([A-Za-z]{3})\s*-\s*(\d{4})\b/g, '$1-$2-$3').replace(/\b(\d{1,2}-[A-Za-z]{3})-\s+(\d{4})\b/g, '$1-$2');
    rows.forEach((r, i) => out.push({ page: n, line: i + 1, text: joinDates(r.items.sort((a, b) => a.x - b.x).map(t => t.s).join(' ').replace(/\s+/g, ' ').trim()) }));
    page.cleanup();
  }
  await doc.destroy();
  return out;
}

const AMT = '\\(?-?\\d[\\d,]*\\.\\d{1,2}\\)?';
const DATE = '\\d{1,2}-[A-Za-z]{3}-\\d{4}';
// The Tax Year 2026-27 statement adds "PAN of Deductor (If Available)" after the TAN ("-" when absent), numbers transactions 1.1, 1.2 …
// and prints the booking status as a word ("Final"). Seen in the portal's Excel download (23 Nov 2026); its PDF is assumed to match.
const STATUS_WORD = '(?:[A-Z]|Final|Overbooked|Unmatched|Provisional|Matched|Mismatch)';
const RE_DED = new RegExp(`^(\\d+)\\s+(.+?)\\s+([A-Z]{4}\\d{5}[A-Z])\\s+(?:(?:[A-Z]{5}\\d{4}[A-Z]|-)\\s+)?(${AMT})\\s+(${AMT})\\s+(${AMT})$`);
const RE_TXN = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s+(.+?)\\s+(${DATE})\\s+(${STATUS_WORD})\\s+(${DATE}|-)\\s+(?:(.+?)\\s+)?(${AMT})\\s+(${AMT})\\s+(${AMT})$`);

async function parsePdf(buf, fileName, password) {
  const lines = await pdfLines(buf, password);
  const problems = [], deductors = [], rows = [], partsSeen = [];
  const all = lines.map(l => l.text).join('\n');
  const grab = re => { const m = all.match(re); return m ? m[1] : ''; };
  const h = {
    pan: grab(/Permanent Account Number\s*\(PAN\)[\s\S]{0,200}?\b([A-Z]{5}\d{4}[A-Z])\b/), pan_status: grab(/Current Status of PAN\s+(.+?)\s+(?:Financial Year|Tax Year|Assessment Year)/),
    fy: grab(/Financial Year[\s\S]{0,80}?(\d{4}\s*-\s*\d{2,4})/), ay: grab(/Assessment Year[\s\S]{0,80}?(\d{4}\s*-\s*\d{2,4})/), tax_year: grab(/Tax Year[\s\S]{0,80}?(\d{4}\s*-\s*\d{2,4})/),
    name: grab(/Name of (?:the )?Assessee\s*:?\s*(.+)/), data_updated_till: grab(/Data\s*updated\s*till\s*:?\s*(\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\d{4})/i),
  };
  let part = null, current = null, txnSinceDeductor = 0, seenHeading = false, gross = null;
  for (const l of lines) {
    const t = l.text;
    const src = { file: fileName, page: l.page, line: l.line };
    if (isPart1Title(t)) { part = 'I'; partsSeen.push('PART-I'); continue; }
    const op = otherPart(t);
    if (op) { partsSeen.push(op); part = 'other'; continue; }
    if (part !== 'I') continue;
    if (/^gross total/i.test(t)) { gross = grossOf(t.match(new RegExp(AMT, 'g')) || [], src) || gross; continue; }
    if (SKIP_LINE.test(t) || /^Assessee PAN:/i.test(t) || /^(Sr\.? No\.?|Credited|Deposited|Debited)\b/i.test(t) || /Name of Deductor|Transaction Date|Status of Booking/i.test(t)) { if (/Name of Deductor|Transaction Date/i.test(t)) seenHeading = true; continue; }
    let m = t.match(RE_DED);
    if (m) { current = { sr: m[1], name: m[2], tan: m[3], total_paid: toPaise(m[4]), total_deducted: toPaise(m[5]), total_deposited: toPaise(m[6]), src }; deductors.push(current); txnSinceDeductor = 0; continue; }
    m = t.match(RE_TXN);
    if (m) {
      const r = { deductor: current ? current.name : '', tan: current ? current.tan : '', deductor_sr: current ? current.sr : '', sr: m[1], section: m[2].replace(/\s+/g, ''), txn_date: parseDate(m[3]), status: statusLetter(m[4]),
        booking_date: m[5] === '-' ? null : parseDate(m[5]), remarks: m[6] && m[6] !== '-' ? m[6] : '', amount_paid: toPaise(m[7]), deducted: toPaise(m[8]), deposited: toPaise(m[9]), src,
        raw: { sr: m[1], section: m[2], txn_date: m[3], status: m[4], booking_date: m[5], remarks: m[6] || '', paid: m[7], deducted: m[8], deposited: m[9] } };
      checkRow(r, problems);
      rows.push(r); txnSinceDeductor++;
      continue;
    }
    // a long deductor name continues on the next line (no numbers on it) before the first transaction
    if (current && txnSinceDeductor === 0 && !/\d[\d,]*\.\d{2}/.test(t) && !new RegExp(DATE).test(t)) { current.name = `${current.name} ${t}`.trim(); continue; }
    if (seenHeading) problems.push(problem('warning', 'unreadable_row', `Line not understood inside PART-I (page ${l.page}): "${t.slice(0, 140)}"`, src));
  }
  // names completed after their transactions were read
  for (const r of rows) { const d = deductors.find(x => x.tan === r.tan && x.sr === r.deductor_sr); if (d) r.deductor = d.name; }
  return { format: 'pdf', header: finishHeader(h, problems), deductors, rows, problems, parts_seen: [...new Set(partsSeen)], pages: lines.length ? lines[lines.length - 1].page : 0, gross };
}

// ── ZIP (TRACES delivers the text export in a ZIP protected with ZipCrypto) ─────
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crcByte = (crc, b) => (CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcByte(c, buf[i]); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipKeys(password) {
  const k = [0x12345678, 0x23456789, 0x34567890];
  const upd = b => { k[0] = crcByte(k[0], b); k[1] = (k[1] + (k[0] & 0xff)) >>> 0; k[1] = (Math.imul(k[1], 134775813) + 1) >>> 0; k[2] = crcByte(k[2], (k[1] >>> 24) & 0xff); };
  const byte = () => { const t = (k[2] | 2) & 0xffff; return ((t * (t ^ 1)) >>> 8) & 0xff; };
  for (const b of Buffer.from(password, 'utf8')) upd(b);
  return { upd, byte };
}

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Object.assign(new Error('The ZIP file is damaged (no directory found)'), { status: 400 });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), time = buf.readUInt16LE(p + 12), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    out.push({ name: buf.slice(p + 46, p + 46 + nl).toString('utf8'), flags, method, time, crc, csize, usize, off });
    p += 46 + nl + el + cl;
  }
  return out;
}

function zipRead(buf, e, password) {
  const nl = buf.readUInt16LE(e.off + 26), el = buf.readUInt16LE(e.off + 28);
  let data = buf.slice(e.off + 30 + nl + el, e.off + 30 + nl + el + e.csize);
  if (e.method === 99) throw Object.assign(new Error('This ZIP uses AES encryption, which cannot be opened here. Extract the .txt file (with 7-Zip or Windows) and upload the .txt.'), { status: 400 });
  if (e.flags & 1) {
    if (!password) throw Object.assign(new Error('This ZIP is password-protected. Enter its password (for the TRACES download: date of birth / incorporation as DDMMYYYY).'), { status: 422, needs_password: true });
    const z = zipKeys(password);
    const plain = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) { const c = data[i] ^ z.byte(); z.upd(c); plain[i] = c; }
    const check = (e.flags & 8) ? (e.time >>> 8) & 0xff : (e.crc >>> 24) & 0xff;
    if (plain[11] !== check) throw Object.assign(new Error('The password is not correct for this ZIP file.'), { status: 422, needs_password: true, wrong_password: true });
    data = plain.slice(12);
  }
  const out = e.method === 8 ? zlib.inflateRawSync(data) : e.method === 0 ? data : null;
  if (!out) throw Object.assign(new Error(`The ZIP entry "${e.name}" uses a compression method this reader does not support`), { status: 400 });
  if (crc32(out) !== e.crc) throw Object.assign(new Error((e.flags & 1) ? 'The password is not correct for this ZIP file.' : 'The ZIP entry is damaged (checksum differs)'), { status: 422, needs_password: !!(e.flags & 1), wrong_password: !!(e.flags & 1) });
  return out;
}

// ── Entry point ───────────────────────────────────────────────────────────────
function kindOf(buf, fileName) {
  const n = String(fileName || '').toLowerCase();
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.readUInt32LE(0) === 0x04034b50) {
    try { const names = zipEntries(buf).map(e => e.name); if (names.some(x => /^xl\//.test(x))) return 'excel'; return 'zip'; } catch (_) { return 'excel'; }
  }
  if (buf.readUInt32LE(0) === 0xE011CFD0) return 'excel';             // .xls, or an encrypted .xlsx
  if (/\.(xlsx|xlsm|xls)$/.test(n)) return 'excel';
  if (/\.csv$/.test(n)) return 'csv';
  return 'text';
}

/** buffer + file name (+ password) → canonical statement. Throws { status, needs_password } for a protected PDF / ZIP without the password. */
async function parse(buffer, fileName, { password } = {}) {
  if (!buffer || !buffer.length) throw Object.assign(new Error('The file is empty'), { status: 400 });
  const kind = kindOf(buffer, fileName);
  let out;
  if (kind === 'pdf') out = await parsePdf(buffer, fileName, password);
  else if (kind === 'excel') out = parseExcel(buffer, fileName);
  else if (kind === 'csv') { const XLSX = require('xlsx'); out = parseExcel(XLSX.write(XLSX.read(decodeText(buffer), { type: 'string', raw: true }), { type: 'buffer', bookType: 'xlsx' }), fileName); }
  else if (kind === 'zip') {
    const entries = zipEntries(buffer).filter(e => /\.txt$/i.test(e.name) && e.usize > 0);
    if (!entries.length) throw Object.assign(new Error('The ZIP file contains no .txt statement'), { status: 400 });
    if (entries.length > 1) throw Object.assign(new Error(`The ZIP holds ${entries.length} text files (${entries.map(e => e.name).join(', ')}) — upload them one at a time`), { status: 400 });
    out = parseText(zipRead(buffer, entries[0], password), `${fileName} › ${entries[0].name}`);
    out.inner_file = entries[0].name;
  } else out = parseText(buffer, fileName);
  if (!out.parts_seen.includes('PART-I') && out.format !== 'excel_flat') out.problems.push(problem(out.rows.length ? 'warning' : 'error', 'no_part1', 'The "PART-I — Details of Tax Deducted at Source" heading was not found'));
  return out;
}

module.exports = { parse, BOOKING_STATUS, crc32, zipKeys, normFy };
