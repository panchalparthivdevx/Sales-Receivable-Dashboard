/**
 * Malware scan of every upload, before it is stored.
 *
 *   C2_CLAMD_HOST[:C2_CLAMD_PORT]   a ClamAV daemon (INSTREAM) — works anywhere, including servers without Defender
 *   Windows (office PC)             Microsoft Defender's command-line scanner (MpCmdRun.exe), on a temporary copy
 *   neither (e.g. Vercel)           "unscanned" — the document is stored and visibly flagged as not scanned
 * Result: { status: 'clean' | 'infected' | 'unscanned' | 'error', engine, detail }. Infected uploads are refused.
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');
const { execFile } = require('child_process');

function defenderPath() {
  const base = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform';
  try {
    const vers = fs.readdirSync(base).filter(d => fs.existsSync(path.join(base, d, 'MpCmdRun.exe'))).sort();
    if (vers.length) return path.join(base, vers[vers.length - 1], 'MpCmdRun.exe');
  } catch (_) { /* not there */ }
  const p = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe';
  return fs.existsSync(p) ? p : null;
}

function clamd(buffer, host, port) {
  return new Promise(resolve => {
    const sock = net.createConnection({ host, port }, () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buffer.length; i += 64 * 1024) {
        const chunk = buffer.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
        sock.write(len); sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));
    });
    let out = '';
    sock.setTimeout(60000, () => { sock.destroy(); resolve({ status: 'error', engine: 'clamd', detail: 'timeout' }); });
    sock.on('data', d => { out += d.toString(); });
    sock.on('end', () => resolve(/FOUND/.test(out) ? { status: 'infected', engine: 'clamd', detail: out.replace(/\0/g, '').trim() } : /OK/.test(out) ? { status: 'clean', engine: 'clamd' } : { status: 'error', engine: 'clamd', detail: out.trim() }));
    sock.on('error', e => resolve({ status: 'error', engine: 'clamd', detail: e.message }));
  });
}

function defender(buffer, exe) {
  return new Promise(resolve => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2scan-'));
    const file = path.join(dir, 'upload.bin');
    const done = r => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } resolve(r); };
    try { fs.writeFileSync(file, buffer); } catch (e) { return done({ status: 'error', engine: 'defender', detail: e.message }); }
    execFile(exe, ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation'], { timeout: 120000, windowsHide: true }, (err, stdout) => {
      // real-time protection may already have removed the copy
      if (!fs.existsSync(file)) return done({ status: 'infected', engine: 'defender', detail: 'removed by real-time protection' });
      if (!err) return done({ status: 'clean', engine: 'defender' });
      if (err.code === 2) return done({ status: 'infected', engine: 'defender', detail: String(stdout || '').trim().slice(0, 500) });
      return done({ status: 'error', engine: 'defender', detail: `exit ${err.code}: ${String(stdout || err.message).trim().slice(0, 300)}` });
    });
  });
}

let override = null;
/** Tests replace the scanner: setScanner(async buf => ({ status: 'clean' })) */
const setScanner = fn => { override = fn; };

async function scan(buffer) {
  if (override) return override(buffer);
  if (process.env.C2_CLAMD_HOST) return clamd(buffer, process.env.C2_CLAMD_HOST, Number(process.env.C2_CLAMD_PORT || 3310));
  if (process.platform === 'win32' && !process.env.VERCEL) { const exe = defenderPath(); if (exe) return defender(buffer, exe); }
  return { status: 'unscanned', engine: 'none', detail: 'No malware scanner is configured on this server' };
}

function engine() {
  if (override) return 'test';
  if (process.env.C2_CLAMD_HOST) return 'clamd';
  if (process.platform === 'win32' && !process.env.VERCEL && defenderPath()) return 'defender';
  return 'none';
}

module.exports = { scan, setScanner, engine };
