/**
 * Documents & folder storage.
 *
 * Canonical path:
 *   ROOT / COMPANY / FY 2025-26 / MODULE / Q1 / April / Receipt | Challan | Other Data
 *
 *   • ROOT comes from settings (storage_root) — never hard-coded.
 *   • FY is the top storage level under a company; FYs are never mixed.
 *   • Folder creation is idempotent: existing folders are reported as "Already Exists".
 *   • Upload routing: "Challan" → Challan; any type containing "Receipt" → Receipt; else Other Data.
 *
 * Security
 *   • Files live outside the web root and are only served by authenticated API routes.
 *   • Every path segment is sanitised; every final path is checked to be inside ROOT.
 *   • File type = extension allow-list + content signature check. Size limit from settings.
 *   • Duplicate uploads are blocked by SHA-256 hash.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const P      = require('./period');
const store  = require('./store');
const { BLOCKED_EXTENSIONS } = require('./settings');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Make one folder/file name safe: no separators, no traversal, no control chars */
function sanitizeSegment(name, fallback = 'item') {
  let s = String(name ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s || s === '.' || s === '..') s = fallback;
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return s.slice(0, 120);
}

/** File name: sanitised base + lower-case extension */
function sanitizeFileName(original) {
  const base = path.basename(String(original ?? '').replace(/\\/g, '/'));
  const ext = path.extname(base).toLowerCase();
  const stem = sanitizeSegment(base.slice(0, base.length - ext.length), 'document');
  return { name: `${stem}${ext}`, ext };
}

function rootOf(settings) {
  return path.resolve(store.resolveProjectPath(String(settings.storage_root || '').trim()));
}

/** Join under root; throws if the result escapes root */
function safeJoin(root, ...segments) {
  const full = path.resolve(root, ...segments);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Blocked: path is outside the storage root.');
  return full;
}

/** Which storage module folder a compliance module uses */
function folderModuleOf(settings, moduleKey) {
  const m = (settings.modules || []).find(x => x.key.toLowerCase() === String(moduleKey).toLowerCase());
  const f = m?.folder || moduleKey;
  return (settings.folder_modules || []).includes(f) ? f : (settings.default_folder_module || 'Other Compliance');
}

/** Leaf folder for a document type */
function leafFor(settings, docType) {
  const L = settings.folder_leaves || { receipt: 'Receipt', challan: 'Challan', other: 'Other Data' };
  const t = String(docType || '').toLowerCase();
  if (t.includes('challan')) return L.challan;
  if (t.includes('receipt')) return L.receipt;
  return L.other;
}

/** Relative path segments for a month folder (without leaf) */
function monthSegments(settings, companyFolder, fy, folderModule, month) {
  return [
    sanitizeSegment(companyFolder, 'Company'),
    sanitizeSegment(`${settings.fy_folder_prefix ?? 'FY '}${fy}`, `FY ${fy}`),
    sanitizeSegment(folderModule, 'Other Compliance'),
    P.quarterOf(month),
    P.monthLabel(month),
  ];
}

const leaves = settings => Object.values(settings.folder_leaves || { receipt: 'Receipt', challan: 'Challan', other: 'Other Data' });

/**
 * Create ROOT/COMPANY/FY/MODULE/Qn/Month/{leaves} for every module and month.
 * Idempotent. Returns per-module results and registry entries to record.
 */
function createFolderStructure({ settings, company, fy, modules }) {
  const root = rootOf(settings);
  fs.mkdirSync(root, { recursive: true });
  const results = [];
  const registry = [];
  for (const mod of modules) {
    let created = 0, existed = 0;
    for (const month of P.MONTH_KEYS) {
      const segs = monthSegments(settings, company.name, fy, mod, month);
      for (const leaf of leaves(settings)) {
        const dir = safeJoin(root, ...segs, sanitizeSegment(leaf));
        if (fs.existsSync(dir)) existed++;
        else { fs.mkdirSync(dir, { recursive: true }); created++; }
      }
      registry.push({ company_id: company.id, fy, module: mod, quarter: P.quarterOf(month), month, path: segs.join('/') });
    }
    results.push({ module: mod, created, existed, status: created ? 'Created' : 'Already Exists' });
  }
  return { root, results, registry };
}

/** Which modules already have a complete structure for company + FY (checks disk) */
function folderStatus({ settings, company, fy }) {
  const root = rootOf(settings);
  return (settings.folder_modules || []).map(mod => {
    let present = 0, total = 0;
    for (const month of P.MONTH_KEYS) {
      const segs = monthSegments(settings, company.name, fy, mod, month);
      for (const leaf of leaves(settings)) {
        total++;
        try { if (fs.existsSync(safeJoin(root, ...segs, sanitizeSegment(leaf)))) present++; } catch (_) { /* ignore */ }
      }
    }
    return { module: mod, present, total, complete: present === total };
  });
}

// ── File type checks ──────────────────────────────────────────────────────────

const SIGNATURES = {
  '.pdf':  [[0x25, 0x50, 0x44, 0x46]],                       // %PDF
  '.png':  [[0x89, 0x50, 0x4e, 0x47]],
  '.jpg':  [[0xff, 0xd8, 0xff]],
  '.jpeg': [[0xff, 0xd8, 0xff]],
  '.xlsx': [[0x50, 0x4b, 0x03, 0x04]],                       // zip container
  '.docx': [[0x50, 0x4b, 0x03, 0x04]],
  '.zip':  [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]],
  '.xls':  [[0xd0, 0xcf, 0x11, 0xe0]],                       // OLE2
  '.doc':  [[0xd0, 0xcf, 0x11, 0xe0]],
};
const TEXT_TYPES = new Set(['.csv', '.txt']);

/** Validate an uploaded buffer against settings. Returns null or an error message. */
function checkFile(buffer, originalName, settings) {
  const { ext } = sanitizeFileName(originalName);
  const allowed = (settings.upload?.allowed_extensions || []).map(e => e.toLowerCase());
  if (!ext || !allowed.includes(ext) || BLOCKED_EXTENSIONS.has(ext)) return `File type "${ext || 'none'}" is not allowed. Allowed: ${allowed.join(', ')}.`;
  const maxBytes = (Number(settings.upload?.max_size_mb) || 15) * 1024 * 1024;
  if (!buffer || !buffer.length) return 'The file is empty.';
  if (buffer.length > maxBytes) return `The file is larger than ${settings.upload.max_size_mb} MB.`;
  const sigs = SIGNATURES[ext];
  if (sigs && !sigs.some(sig => sig.every((b, i) => buffer[i] === b))) return `The file content does not look like a real ${ext} file.`;
  if (TEXT_TYPES.has(ext) && buffer.subarray(0, 4096).includes(0)) return `The file content does not look like a ${ext} text file.`;
  return null;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** Find a free file name in a folder: name.pdf, name (2).pdf, … */
function uniqueName(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = fileName, n = 2;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${stem} (${n++})${ext}`;
  return candidate;
}

/**
 * Write an uploaded file into its routed folder.
 *   ctx: { settings, company, task, compliance, docType }
 * Returns { rel, abs, fileName }.
 */
function writeRoutedFile(buffer, originalName, { settings, company, task, compliance }, docType) {
  const root = rootOf(settings);
  const mod = folderModuleOf(settings, compliance.module);
  const segs = monthSegments(settings, company.name, task.fy, mod, task.month);
  const leaf = sanitizeSegment(leafFor(settings, docType));
  const dir = safeJoin(root, ...segs, leaf);
  fs.mkdirSync(dir, { recursive: true });
  const { name } = sanitizeFileName(originalName);
  const fileName = uniqueName(dir, name);
  const abs = safeJoin(dir, fileName);
  fs.writeFileSync(abs, buffer, { flag: 'wx' });
  return { rel: path.relative(root, abs).split(path.sep).join('/'), abs, fileName, folder: [...segs, leaf].join('/') };
}

/** Absolute path of a stored document (re-checked against root) */
function absPathOf(settings, doc) {
  return safeJoin(rootOf(settings), ...String(doc.stored_path).split('/'));
}

/** Move a replaced/deleted file into ROOT/_archive (kept, never served) */
function archiveFile(settings, doc, reason) {
  try {
    const src = absPathOf(settings, doc);
    if (!fs.existsSync(src)) return null;
    const dir = safeJoin(rootOf(settings), '_archive');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = safeJoin(dir, `${stamp}_${reason}_${doc.id}_${path.basename(src)}`);
    fs.renameSync(src, dest);
    return path.relative(rootOf(settings), dest).split(path.sep).join('/');
  } catch (_) { return null; }
}

/** Duplicate check by hash. Returns the clashing document or null. */
function findDuplicate(state, hash, taskId, settings) {
  return state.documents.find(d => d.kind === 'file' && d.sha256 === hash && (d.task_id === taskId || !settings.allow_duplicate_across_tasks)) || null;
}

const newDocId = () => crypto.randomBytes(12).toString('hex');

module.exports = {
  sanitizeSegment, sanitizeFileName, rootOf, safeJoin, folderModuleOf, leafFor, monthSegments,
  createFolderStructure, folderStatus, checkFile, sha256, writeRoutedFile, absPathOf, archiveFile,
  findDuplicate, newDocId,
};
