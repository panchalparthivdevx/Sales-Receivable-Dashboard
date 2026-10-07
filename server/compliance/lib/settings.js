/**
 * Settings = defaults from config/compliance.config.json, overlaid with the values an admin
 * changed in the app (stored in the 'settings' store document).
 *
 * Arrays replace, objects merge. "Reset to defaults" simply clears the stored overrides.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const P    = require('./period');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'compliance.config.json');

function loadDefaults() {
  // Read fresh each time so edits to the config file apply without a restart
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

const FLAG_KEYS = ['edit_tasks', 'manage_documents', 'edit_master', 'import', 'admin'];
// Never allowed as upload types, whatever the settings say
const BLOCKED_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.com', '.ps1', '.sh', '.js', '.mjs', '.vbs', '.msi', '.dll', '.scr',
  '.html', '.htm', '.svg', '.xhtml', '.php', '.jar', '.hta', '.lnk', '.reg']);

/** Effective settings object */
function merge(overrides) {
  const s = deepMerge(loadDefaults(), overrides || {});
  delete s._readme;
  return s;
}

/**
 * Validate a settings patch (only the keys present are checked).
 * Returns a list of { field, error, fix }.
 */
function validatePatch(patch) {
  const errs = [];
  const add = (field, error, fix) => errs.push({ field, error, fix });

  if ('fy_list' in patch) {
    if (!Array.isArray(patch.fy_list) || !patch.fy_list.length) add('fy_list', 'At least one Financial Year is required.', 'Add a year like 2026-27.');
    else {
      const seen = new Set();
      for (const fy of patch.fy_list) {
        const n = P.normFY(fy);
        if (!n) add('fy_list', `"${fy}" is not a valid Financial Year.`, 'Use the form 2026-27.');
        else if (seen.has(n)) add('fy_list', `${n} is listed twice.`, 'Remove the duplicate.');
        else seen.add(n);
      }
    }
  }
  if ('modules' in patch) {
    if (!Array.isArray(patch.modules) || !patch.modules.length) add('modules', 'At least one module is required.', 'Keep GST, Payroll or TDS.');
    else {
      const seen = new Set();
      for (const m of patch.modules) {
        const key = String(m?.key || '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9 &-]{0,23}$/.test(key)) add('modules', `Module key "${key}" is not valid.`, 'Use letters, digits, spaces, & or - (max 24).');
        else if (seen.has(key.toLowerCase())) add('modules', `Module ${key} is listed twice.`, 'Remove the duplicate.');
        else seen.add(key.toLowerCase());
        if (m?.folder !== undefined && !String(m.folder).trim()) add('modules', `Module ${key} needs a folder name.`, 'Use one of the folder modules, e.g. Other Compliance.');
      }
    }
  }
  if ('folder_modules' in patch && (!Array.isArray(patch.folder_modules) || !patch.folder_modules.length || patch.folder_modules.some(f => !String(f).trim()))) {
    add('folder_modules', 'Folder modules must be a non-empty list of names.', 'e.g. TDS, GST, Payroll, Other Compliance');
  }
  if ('document_types' in patch && (!Array.isArray(patch.document_types) || !patch.document_types.length || patch.document_types.some(t => !String(t).trim()))) {
    add('document_types', 'Document types must be a non-empty list.', 'Keep at least "Other".');
  }
  if ('storage_root' in patch && !String(patch.storage_root || '').trim()) add('storage_root', 'Storage root cannot be empty.', 'Enter a folder path, e.g. D:\\Compliance Documents');
  if ('due_soon_days' in patch) {
    const n = Number(patch.due_soon_days);
    if (!Number.isInteger(n) || n < 0 || n > 90) add('due_soon_days', 'Due Soon days must be a whole number from 0 to 90.', 'e.g. 7');
  }
  if ('upload' in patch) {
    const u = patch.upload || {};
    if ('max_size_mb' in u) {
      const n = Number(u.max_size_mb);
      if (!(n > 0 && n <= 100)) add('upload.max_size_mb', 'Maximum upload size must be between 1 and 100 MB.', 'e.g. 15');
    }
    if ('allowed_extensions' in u) {
      if (!Array.isArray(u.allowed_extensions) || !u.allowed_extensions.length) add('upload.allowed_extensions', 'At least one file type is required.', 'e.g. .pdf');
      else for (const e of u.allowed_extensions) {
        const ext = String(e).trim().toLowerCase();
        if (!/^\.[a-z0-9]{1,6}$/.test(ext)) add('upload.allowed_extensions', `"${e}" is not a file extension.`, 'Start with a dot, e.g. .pdf');
        else if (BLOCKED_EXTENSIONS.has(ext)) add('upload.allowed_extensions', `${ext} files can never be uploaded (security).`, 'Remove it.');
      }
    }
  }
  if ('applicability_default' in patch && !['Yes', 'No'].includes(patch.applicability_default)) add('applicability_default', 'Must be Yes or No.', 'Yes');
  if ('roles' in patch) {
    const roles = patch.roles || {};
    if (!roles.admin) add('roles', 'The admin role cannot be removed.', 'Keep the admin role.');
    for (const [name, r] of Object.entries(roles)) {
      if (!/^[a-z][a-z0-9_]{1,20}$/.test(name)) add('roles', `Role name "${name}" is not valid.`, 'Lower-case letters, digits, underscore.');
      for (const f of FLAG_KEYS) if (r && f in r && typeof r[f] !== 'boolean') add('roles', `${name}.${f} must be true or false.`, 'Tick or untick the box.');
    }
    if (roles.admin && FLAG_KEYS.some(f => roles.admin[f] === false)) add('roles', 'The admin role must keep every permission.', 'Tick all boxes for admin.');
  }
  if ('default_role' in patch) {
    if (!String(patch.default_role || '').trim()) add('default_role', 'Default role is required.', 'viewer');
  }
  return errs;
}

module.exports = { merge, deepMerge, validatePatch, loadDefaults, FLAG_KEYS, BLOCKED_EXTENSIONS, CONFIG_FILE };
