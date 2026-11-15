/**
 * Upload checks and assistive text reading.
 *
 *   sniff()     what the bytes really are (PDF, PNG, JPEG, XLSX/DOCX/ZIP, XLS, text) — the file name's extension must agree
 *   readText()  text of PDFs (text layer only), spreadsheets and text files. Scanned images are NOT read (no OCR here):
 *               the document is flagged "no readable text — check manually".
 *   findings()  GSTINs, TANs, PANs, ARNs and months mentioned in the text
 *   compare()   flags for a HUMAN to look at: another GSTIN / TAN / PAN / period than the task's. Flags never block an
 *               upload and never mark anything filed or verified.
 */

'use strict';

const XLSX = require('xlsx');
const U = require('./util');
const V = require('./validate');

const TYPES = {
  pdf: { mime: 'application/pdf', exts: ['pdf'] },
  png: { mime: 'image/png', exts: ['png'] },
  jpeg: { mime: 'image/jpeg', exts: ['jpg', 'jpeg'] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', exts: ['xlsx'] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', exts: ['docx'] },
  zip: { mime: 'application/zip', exts: ['zip'] },
  xls: { mime: 'application/vnd.ms-excel', exts: ['xls'] },
  csv: { mime: 'text/csv', exts: ['csv'] },
  txt: { mime: 'text/plain', exts: ['txt'] },
  json: { mime: 'application/json', exts: ['json'] },
};

/** → { ok, type, mime, error } */
function sniff(buf, originalName) {
  const ext = String(originalName || '').toLowerCase().split('.').pop();
  const head = buf.subarray(0, 8);
  let type = null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') type = 'pdf';
  else if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) type = 'png';
  else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) type = 'jpeg';
  else if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    // Office files are ZIP archives: an .xlsx holds xl/…, a .docx word/…
    const names = buf.toString('latin1');
    type = ext === 'xlsx' && names.includes('xl/') ? 'xlsx' : ext === 'docx' && names.includes('word/') ? 'docx' : 'zip';
  } else if (head.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) type = 'xls';
  else if (buf.length && !buf.subarray(0, 8192).includes(0)) {
    type = ext === 'csv' ? 'csv' : ext === 'json' ? 'json' : ext === 'txt' ? 'txt' : null;
    if (type === 'json') { try { JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch (_) { return { ok: false, error: 'The file is named .json but is not valid JSON' }; } }
  }
  if (!type) return { ok: false, error: `This kind of file is not accepted (allowed: ${Object.values(TYPES).flatMap(t => t.exts).join(', ')})` };
  if (!TYPES[type].exts.includes(ext)) return { ok: false, error: `The file content is ${type.toUpperCase()} but its name ends in .${ext} — rename it or upload the right file` };
  return { ok: true, type, mime: TYPES[type].mime };
}

let _pdf = null;
const pdfParse = () => (_pdf || (_pdf = require('pdf-parse/lib/pdf-parse.js')));

/** Plain text for the checks (at most ~200 000 characters) */
async function readText(buf, type) {
  try {
    if (type === 'pdf') return String((await pdfParse()(buf, { max: 30 })).text || '').slice(0, 200000);
    if (type === 'xlsx' || type === 'xls') {
      const wb = XLSX.read(buf, { type: 'buffer', cellFormula: false, cellHTML: false });
      return wb.SheetNames.slice(0, 10).map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n').slice(0, 200000);
    }
    if (['csv', 'txt', 'json'].includes(type)) return buf.toString('utf8').slice(0, 200000);
  } catch (_) { return ''; }
  return '';
}

const MONTH_RE = new RegExp(`\\b(${U.MONTHS_LONG.join('|')}|${U.MONTHS.join('|')})[a-z]*[\\s,.-]*(20\\d{2})\\b`, 'gi');

function findings(text) {
  const T = String(text || '').toUpperCase();
  const gstins = U.uniq((T.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z][A-Z][0-9A-Z]\b/g) || []).filter(g => V.gstinCheckChar(g.slice(0, 14)) === g[14]));
  const tans = U.uniq(T.match(/\b[A-Z]{4}\d{5}[A-Z]\b/g) || []);
  const pans = U.uniq((T.match(/\b[A-Z]{5}\d{4}[A-Z]\b/g) || []).filter(p => !gstins.some(g => g.includes(p))));
  const arns = U.uniq(T.match(/\bAA\d{2}\d{4}\d{7}[0-9A-Z]\b/g) || []);
  const months = new Set();
  for (const m of String(text || '').matchAll(MONTH_RE)) {
    const idx = U.MONTHS.findIndex(x => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
    if (idx >= 0) months.add(`${m[2]}-${String(idx + 1).padStart(2, '0')}`);
  }
  for (const m of T.matchAll(/\b(0[1-9]|1[0-2])[/-]?(20\d{2})\b/g)) months.add(`${m[2]}-${m[1]}`);   // 04/2026, 042026 (GST return period)
  return { gstins, tans, pans, arns, months: [...months].sort() };
}

/** Human-review flags for a document against the task it is attached to */
function compare(f, { task, entity, registration, textLength }) {
  const flags = [];
  if (!textLength) { flags.push({ code: 'no_text', text: 'No readable text (scanned image or protected file) — entity, registration and period were not checked; check them manually' }); return flags; }
  if (registration?.type?.startsWith('GST_') && f.gstins.length && !f.gstins.includes(registration.number)) flags.push({ code: 'gstin_mismatch', text: `Mentions GSTIN ${f.gstins.slice(0, 3).join(', ')} but the task is for ${registration.number}` });
  if (registration?.type === 'TAN' && f.tans.length && !f.tans.includes(registration.number)) flags.push({ code: 'tan_mismatch', text: `Mentions TAN ${f.tans.slice(0, 3).join(', ')} but the task is for ${registration.number}` });
  if (entity?.pan && f.pans.length && !f.pans.includes(entity.pan) && !f.gstins.some(g => g.includes(entity.pan))) flags.push({ code: 'pan_mismatch', text: `Mentions PAN ${f.pans.slice(0, 3).join(', ')}, not the entity's PAN ${entity.pan}` });
  if (task?.period_start && f.months.length) {
    // the document's months should overlap the task's period (a filing month after the period is normal, so allow +2 months)
    const from = task.period_start.slice(0, 7);
    const [y, m] = U.addMonths(+task.period_end.slice(0, 4), +task.period_end.slice(5, 7), 2);
    const to = `${y}-${String(m).padStart(2, '0')}`;
    if (!f.months.some(x => x >= from && x <= to)) flags.push({ code: 'period_mismatch', text: `Mentions ${f.months.slice(0, 4).join(', ')} — none of them in the task period ${task.period_label}` });
  }
  return flags;
}

module.exports = { TYPES, sniff, readText, findings, compare };
