/**
 * Exports: CSV, XLSX, calendar (ICS) and ZIP (audit pack).
 *
 * Spreadsheet formula injection: any text cell that starts with = + - @ or a tab / carriage return is prefixed with an
 * apostrophe, so Excel shows it as text instead of running it. Numbers stay numbers.
 * Every export carries its context (dataset, filters, generated at, by) in a first block / sheet.
 */

'use strict';

const XLSX = require('xlsx');
const zlib = require('zlib');
const U = require('./util');

const safeCell = v => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

function csv(columns, rows, context) {
  const q = v => { const s = String(safeCell(v)); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [];
  for (const [k, v] of Object.entries(context || {})) lines.push([q(k), q(v)].join(','));
  if (lines.length) lines.push('');
  lines.push(columns.map(c => q(c.label)).join(','));
  for (const r of rows) lines.push(columns.map(c => q(c.get(r))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function xlsx(sheets, context) {
  const wb = XLSX.utils.book_new();
  const ctx = Object.entries(context || {}).map(([k, v]) => [safeCell(k), safeCell(v)]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Export context', ''], ...ctx]), 'Context');
  for (const s of sheets) {
    const aoa = [s.columns.map(c => c.label), ...s.rows.map(r => s.columns.map(c => safeCell(c.get(r))))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = s.columns.map(c => ({ wch: c.width || 16 }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── ICS ───────────────────────────────────────────────────────────────────────
const icsText = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = [];
  let l = line;
  while (Buffer.byteLength(l, 'utf8') > 74) { let n = 74; while (Buffer.byteLength(l.slice(0, n), 'utf8') > 74) n--; out.push(l.slice(0, n)); l = ` ${l.slice(n)}`; }
  out.push(l);
  return out.join('\r\n');
}
/** One all-day event per task with a due date (Asia/Kolkata dates) */
function ics(tasks, { name = 'Compliance calendar', host = 'compliance2.local' } = {}) {
  const stamp = U.nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Finance Dashboard//Compliance Vr.2.0//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name)}`, 'X-WR-TIMEZONE:Asia/Kolkata'];
  for (const t of tasks) {
    if (!t.effective_due) continue;
    const d = t.effective_due.replace(/-/g, '');
    const next = U.addDays(t.effective_due, 1).replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${t.id}@${host}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`,
      fold(`SUMMARY:${icsText(`${t.rule_name} — ${t.period_label} — ${t.scope_label}`)}`),
      fold(`DESCRIPTION:${icsText(`Status: ${t.status_label}\nStatutory due: ${t.effective_due}${t.revised_due ? ` (extended from ${t.original_due})` : ''}\nInternal target: ${t.internal_target || '—'}\nOwner: ${t.owner_name || '—'}\nTask ${t.id}`)}`),
      `CATEGORIES:${icsText(t.category)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

// ── ZIP (stored entries, CRC-32; no compression library needed) ───────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** files: [{ name, data: Buffer|string }] → Buffer (deflated when that is smaller) */
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  const dt = new Date(U.clock.now());
  const dosTime = (dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2);
  const dosDate = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const def = zlib.deflateRawSync(data);
    const useDef = def.length < data.length;
    const body = useDef ? def : data;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(useDef ? 8 : 0, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(useDef ? 8 : 0, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** Safe file / folder name part */
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '_';

module.exports = { safeCell, csv, xlsx, ics, zip, crc32, safeName };
