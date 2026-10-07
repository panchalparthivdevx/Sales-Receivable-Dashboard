/**
 * Audit trail — who changed what, and when. Every important change in the Compliance
 * Dashboard adds an entry here (task updates, master edits, imports, uploads, deletes,
 * settings, roles, folder creation, Zoho syncs).
 */

'use strict';

const crypto = require('crypto');

/**
 * Build an audit entry.
 *   user      { id, username, name }
 *   action    'create' | 'update' | 'delete' | 'import' | 'upload' | 'replace' | 'download' | 'sync' | ...
 *   entity    'task' | 'company' | 'compliance' | 'applicability' | 'document' | 'settings' | 'role' | 'folder' | 'zoho' | 'user'
 *   changes   [{ field, from, to }]
 */
function entry(user, action, entity, entityId, summary, changes = [], extra = {}) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    at: new Date().toISOString(),
    user: user?.name || user?.username || 'system',
    user_id: user?.id || null,
    action, entity, entity_id: entityId ?? null,
    summary: summary || '',
    changes: changes.filter(c => c && String(c.from ?? '') !== String(c.to ?? '')),
    ...extra,
  };
}

/** Append entries inside a store transaction, trimming the oldest beyond `max` */
async function append(tx, entries, max = 50000) {
  const list = (await tx.get('audit', [])).slice();
  for (const e of [].concat(entries)) if (e) list.push(e);
  tx.set('audit', list.length > max ? list.slice(list.length - max) : list);
}

/** Field-by-field difference between two records for the given keys */
function diff(before, after, keys) {
  const out = [];
  for (const k of keys) {
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    if (JSON.stringify(a ?? '') !== JSON.stringify(b ?? '')) out.push({ field: k, from: a ?? '', to: b ?? '' });
  }
  return out;
}

module.exports = { entry, append, diff };
