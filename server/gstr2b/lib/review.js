/**
 * Reviewer decisions — kept apart from the reconciliation result so a re-run never loses them.
 *
 * One document per company (review_<co>):
 *   links       manual links { books_ids, portal_ids, by, at, reason, approved_tol_p, approved_from }
 *   blocks      "not a match" decisions   { 'booksId|portalId': { by, at, reason } }
 *   exclusions  manual exclusions of one document { docId: { side, reason, by, at } }
 *   meta        per document (anchor)     { owner, owner_id, workflow, next_action, due, assigned_at, assigned_by, updated_at, updated_by }
 *   notes       per anchor                [{ at, by, text }]
 *   history     per anchor                [{ at, by, action, detail }]   (last 100)
 *
 * The "anchor" of a reconciliation row is its first Books document id, else its first GSTR-2B document id — so a note
 * written on a Books-only row is still there after that row becomes a matched row.
 */

'use strict';

const store = require('./store');
const { uid, nowIso } = require('./util');

const key = co => `review_${co}`;
const EMPTY = () => ({ links: {}, blocks: {}, exclusions: {}, meta: {}, notes: {}, history: {} });
const WORKFLOW = { open: 'Open', in_review: 'In review', vendor_followup: 'Vendor follow-up', waiting_vendor: 'Waiting for vendor', accepted: 'Accepted as is', resolved: 'Resolved' };

const load = async co => ({ ...EMPTY(), ...((await store.read(key(co), null)) || {}) });
const anchorOf = row => row.books_ids[0] || row.portal_ids[0];

/** Locked read-modify-write of the company's decisions; fn mutates and returns the document */
async function mutate(co, fn) {
  return store.update(key(co), EMPTY(), doc => { for (const [k, v] of Object.entries(EMPTY())) if (!doc[k]) doc[k] = v; return fn(doc) || doc; });
}

function addHistory(doc, anchors, by, action, detail) {
  for (const a of [].concat(anchors)) { const h = (doc.history[a] = doc.history[a] || []); h.push({ at: nowIso(), by, action, detail: String(detail || '').slice(0, 300) }); if (h.length > 100) h.splice(0, h.length - 100); }
}

/** Decisions in the shape the matcher wants */
async function decisionsFor(co) {
  const d = await load(co);
  return { links: Object.entries(d.links).map(([id, l]) => ({ id, ...l })), blocks: Object.keys(d.blocks), exclusions: d.exclusions, raw: d };
}

async function link(co, { books_ids, portal_ids, by, reason = '', approved_tol_p = null, approved_from = null }) {
  if (!books_ids || !books_ids.length || !portal_ids || !portal_ids.length) throw new Error('A link needs at least one Books document and one GSTR-2B document');
  const id = uid('lk_');
  await mutate(co, doc => {
    for (const [k, l] of Object.entries(doc.links)) if (l.books_ids.some(x => books_ids.includes(x)) || l.portal_ids.some(x => portal_ids.includes(x))) delete doc.links[k];   // a document is in one link only
    for (const b of books_ids) for (const p of portal_ids) delete doc.blocks[`${b}|${p}`];
    doc.links[id] = { books_ids, portal_ids, by, at: nowIso(), reason: String(reason || '').slice(0, 300), approved_tol_p, approved_from };
    addHistory(doc, [...books_ids, ...portal_ids], by, approved_from ? 'approve_suggestion' : 'link', reason);
    return doc;
  });
  return id;
}

/** Undo a manual link, or keep an automatic / suggested pair apart (a "not a match" block) */
async function unlink(co, row, by, reason = '') {
  await mutate(co, doc => {
    let had = false;
    for (const [k, l] of Object.entries(doc.links)) if (l.books_ids.some(x => row.books_ids.includes(x)) && l.portal_ids.some(x => row.portal_ids.includes(x))) { delete doc.links[k]; had = true; }
    for (const b of row.books_ids) for (const p of row.portal_ids) doc.blocks[`${b}|${p}`] = { by, at: nowIso(), reason: String(reason || '').slice(0, 300) };
    addHistory(doc, [...row.books_ids, ...row.portal_ids], by, had ? 'unlink_manual' : 'reject_match', reason);
    return doc;
  });
}

async function exclude(co, { doc_id, side, reason, by }) {
  if (!reason || !String(reason).trim()) throw new Error('A reason is required to exclude a document');
  await mutate(co, doc => { doc.exclusions[doc_id] = { side, reason: String(reason).slice(0, 300), by, at: nowIso() }; addHistory(doc, doc_id, by, 'exclude', reason); return doc; });
}
async function include(co, { doc_id, by }) {
  await mutate(co, doc => { delete doc.exclusions[doc_id]; addHistory(doc, doc_id, by, 'include', ''); return doc; });
}

/**
 * Owner, workflow, next action and due date of the given rows. `patch.owner_id` is the dashboard user behind the owner's name (see
 * lib/tasks.js); a name alone is kept as typed. Resolves to { given }: the anchors that now have a (different) owner — the rows somebody
 * was just handed, which is what the "assigned to you" email is about.
 */
async function assign(co, anchors, patch, by) {
  const clean = {};
  if (patch.owner !== undefined) { clean.owner = String(patch.owner || '').slice(0, 80); clean.owner_id = clean.owner && patch.owner_id ? String(patch.owner_id) : ''; }
  if (patch.workflow !== undefined) { if (patch.workflow && !WORKFLOW[patch.workflow]) throw new Error('Unknown workflow status'); clean.workflow = patch.workflow || ''; }
  if (patch.next_action !== undefined) clean.next_action = String(patch.next_action || '').slice(0, 200);
  if (patch.due !== undefined) clean.due = patch.due ? String(patch.due).slice(0, 10) : '';
  const given = [];
  await mutate(co, doc => {
    const at = nowIso();
    for (const a of anchors) {
      const prev = doc.meta[a] || {};
      const next = { ...prev, ...clean, updated_at: at, updated_by: by };
      if (clean.owner !== undefined && (clean.owner !== (prev.owner || '') || clean.owner_id !== (prev.owner_id || ''))) {
        if (clean.owner) { next.assigned_at = at; next.assigned_by = by; given.push(a); } else { delete next.assigned_at; delete next.assigned_by; }
      }
      doc.meta[a] = next;
    }
    addHistory(doc, anchors, by, 'assign', Object.entries(clean).filter(([k]) => k !== 'owner_id').map(([k, v]) => `${k}=${v}`).join(', '));
    return doc;
  });
  return { given };
}

async function note(co, anchor, text, by) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Write a note first');
  await mutate(co, doc => { (doc.notes[anchor] = doc.notes[anchor] || []).push({ at: nowIso(), by, text: t.slice(0, 2000) }); addHistory(doc, anchor, by, 'note', t.slice(0, 80)); return doc; });
}

/** Everything the drawer shows for one row */
async function detailFor(co, row) {
  const d = await load(co);
  const anchors = [...row.books_ids, ...row.portal_ids];
  const pick = m => anchors.flatMap(a => (m[a] || []).map(x => ({ ...x, anchor: a }))).sort((x, y) => String(x.at).localeCompare(String(y.at)));
  return { meta: d.meta[anchorOf(row)] || {}, notes: pick(d.notes), history: pick(d.history), exclusions: anchors.filter(a => d.exclusions[a]).map(a => ({ doc_id: a, ...d.exclusions[a] })) };
}

module.exports = { WORKFLOW, load, decisionsFor, link, unlink, exclude, include, assign, note, detailFor, anchorOf };
