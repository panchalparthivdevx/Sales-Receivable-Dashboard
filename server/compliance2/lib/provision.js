/**
 * Folder provisioning engine (OneDrive, through lib/graph.js — or lib/graphSim.js in the demo and the tests).
 *
 * Mapping document "<sp>_folders":
 *   base      the folder the user chose (drive id + item id, resolved from their link — never guessed)
 *   root      "Finance & Compliance" inside it (created or reused once; everything else lives below it)
 *   nodes     folder key → { item_id, web_url, name, label, status, attempts, next_retry_at, error, at, names[] }
 *   found     company-level folders someone created directly in OneDrive, waiting to be linked or ignored
 *   settings  { fys, trigger ('saved' | 'approved'), copy_documents }, log[], last_run, last_scan
 *
 * Rules:
 *   • preview makes NO call to Microsoft;
 *   • a folder whose key is mapped is never created again (re-runs, retries and duplicate events reuse it); a name that
 *     already exists in OneDrive is reused, not duplicated;
 *   • a folder is only ever created under the root or under a folder this engine mapped — never anywhere else;
 *   • nothing is deleted, moved or overwritten; a company folder is renamed only when the entity's legal name changes;
 *   • failures are recorded with a retry time (back-off) and the next run continues where this one stopped;
 *   • a revoked sign-in stops the run at once.
 */

'use strict';

const U = require('./util');
const FO = require('./folders');

const EMPTY = () => ({ base: null, root: null, nodes: {}, found: [], log: [], settings: { fys: [], trigger: 'saved', copy_documents: true }, last_run: null, last_scan: null });
const LOG_MAX = 1500;

function addLog(mapping, kind, key, name, detail) {
  mapping.log.push({ at: U.nowIso(), kind, key: key || '', name: name || '', detail: detail || '' });
  if (mapping.log.length > LOG_MAX) mapping.log.splice(0, mapping.log.length - LOG_MAX);
}

/** What a run would do — no remote call */
function preview(mapping, planned) {
  const out = { total: planned.nodes.length, mapped: 0, to_create: 0, failed: 0, pending: planned.pending, by_entity: {}, first: [] };
  const names = new Map(planned.nodes.map(n => [n.key, n]));
  const pathOf = key => { const parts = []; let n = names.get(key); while (n) { parts.unshift(n.name); n = names.get(n.parent); } return parts.join(' / '); };
  for (const n of planned.nodes) {
    const m = n.key === 'ROOT' ? mapping.root : mapping.nodes[n.key];
    const be = out.by_entity[n.entity_id || '-'] || (out.by_entity[n.entity_id || '-'] = { mapped: 0, to_create: 0 });
    if (m?.item_id) { out.mapped++; be.mapped++; continue; }
    if (m?.status === 'failed') out.failed++;
    out.to_create++; be.to_create++;
    if (out.first.length < 60) out.first.push(pathOf(n.key));
  }
  return out;
}

// Keys are hierarchical ("E:x|FY:2026-27|C:gst|…"): a key's parent is the key without its last part; a company's parent is ROOT
const parentKeyOf = key => (key.includes('|') ? key.slice(0, key.lastIndexOf('|')) : 'ROOT');

/**
 * Is a mapped folder really inside Finance & Compliance? Every mapped folder records the folder it was created in; the chain
 * of those records must lead, unbroken, to the root. A mapping changed by hand (or a folder flagged invalid) fails this check
 * and nothing is created under it.
 */
function insideRoot(mapping, key) {
  if (key === 'ROOT') return !!mapping.root?.item_id;
  for (let k = key; k !== 'ROOT'; k = parentKeyOf(k)) {
    const m = mapping.nodes[k];
    if (!m?.item_id || m.invalid) return false;
    const pk = parentKeyOf(k);
    const pid = pk === 'ROOT' ? mapping.root?.item_id : mapping.nodes[pk]?.item_id;
    if (!pid || m.parent_item_id !== pid) return false;
  }
  return true;
}

function record(mapping, key, node, item, reused, parentId) {
  const prev = mapping.nodes[key] || {};
  mapping.nodes[key] = { ...prev, item_id: item.id, parent_item_id: parentId, web_url: item.webUrl || '', name: item.name || node.name, label: node.label || node.name, status: reused ? 'reused' : 'created', at: U.nowIso(), attempts: prev.attempts || 0, error: '', next_retry_at: null, invalid: false };
  addLog(mapping, reused ? 'reused' : 'created', key, item.name || node.name);
}

/**
 * Before anything is written under an existing folder, OneDrive itself is asked where that folder (and each folder above it)
 * really is: each must sit in the folder the mapping says, up to Finance & Compliance. A folder that was moved out (or a
 * changed mapping) is flagged invalid and nothing is created in it; a folder deleted in OneDrive is forgotten so it is created
 * again. Folders created in the same run are trusted; answers are remembered for 10 minutes.
 */
const VERIFIED_TTL = 10 * 60000;
const verifiedAt = new Map();                                       // item id → when OneDrive confirmed its place
async function ensureInside(graph, mapping, key, trusted) {
  if (!insideRoot(mapping, key)) return false;
  const chain = [];
  for (let k = key; k !== 'ROOT'; k = parentKeyOf(k)) chain.unshift(k);
  let parentId = mapping.root.item_id;
  for (const k of chain) {
    const m = mapping.nodes[k];
    const fresh = trusted.has(m.item_id) || (verifiedAt.get(`${parentId}>${m.item_id}`) || 0) > U.clock.now() - VERIFIED_TTL;
    if (!fresh) {
      let it;
      try { it = await graph.item(mapping.base.drive_id, m.item_id); } catch (e) {
        if (e.revoked) throw e;
        if (e.status === 404) { addLog(mapping, 'missing', k, m.name, 'Deleted or moved in OneDrive — it will be created again'); mapping.nodes[k] = { name: m.name, label: m.label, names: m.names, status: 'missing', at: U.nowIso() }; return false; }
        throw e;
      }
      if (it.parentReference?.id !== parentId) {
        Object.assign(m, { invalid: true, error: 'This folder is not where it should be (moved out of its parent, or the mapping was changed) — nothing is created in it until it is moved back or re-linked' });
        addLog(mapping, 'failed', k, m.name, m.error);
        return false;
      }
      verifiedAt.set(`${parentId}>${m.item_id}`, U.clock.now());
    }
    parentId = m.item_id;
  }
  return true;
}

/**
 * Create what is missing. Mutates `mapping`. → { created, reused, known, renamed, failed, blocked, queued, pending, stopped, error }
 */
async function apply({ graph, mapping, planned, maxMs = 240000, force = false, now = () => U.clock.now() }) {
  if (!mapping.base?.item_id) throw U.httpError(400, 'Choose the OneDrive folder first (Document Folders → OneDrive folder)');
  const res = { created: 0, reused: 0, known: 0, renamed: 0, failed: 0, blocked: 0, queued: 0, pending: planned.pending.length, stopped: null, error: '' };
  const t0 = now();
  const drive = mapping.base.drive_id;
  const trusted = new Set();                                          // folders created in this run
  for (let i = 0; i < planned.nodes.length; i++) {
    const n = planned.nodes[i];
    if (now() - t0 > maxMs) { res.queued = planned.nodes.length - i; res.stopped = 'time'; break; }
    let parentId;
    if (n.key === 'ROOT') {
      if (mapping.root?.item_id) { res.known++; continue; }
      parentId = mapping.base.item_id;
    } else {
      const m = mapping.nodes[n.key];
      if (m?.item_id) {
        res.known++;
        // a company folder follows a change of the entity's LEGAL name (its id — and so every mapping — stays the same)
        if (n.kind === 'company' && m.label && n.label && m.label !== n.label) {
          try {
            if (!(await ensureInside(graph, mapping, n.key, trusted))) continue;      // never rename a folder outside the tree
            const it = await graph.rename(drive, m.item_id, n.name);
            m.names = [...(m.names || []), { name: m.name, until: U.nowIso() }];
            Object.assign(m, { name: it.name || n.name, label: n.label });
            addLog(mapping, 'renamed', n.key, n.name, `was "${m.names[m.names.length - 1].name}"`);
            res.renamed++;
          } catch (e) {
            if (e.revoked) { res.stopped = 'revoked'; res.error = e.message; break; }
            addLog(mapping, 'failed', n.key, n.name, `rename: ${e.message}`);
          }
        }
        continue;
      }
      if (m?.status === 'failed' && !force && m.next_retry_at && Date.parse(m.next_retry_at) > now()) { res.failed++; continue; }
      parentId = n.parent === 'ROOT' ? mapping.root?.item_id : mapping.nodes[n.parent]?.item_id;
      if (!parentId) { res.blocked++; continue; }
    }
    try {
      if (n.key !== 'ROOT' && n.parent !== 'ROOT' && !(await ensureInside(graph, mapping, n.parent, trusted))) { res.blocked++; continue; }
      const { item, reused } = await graph.createFolder(drive, parentId, n.name);
      if (n.key === 'ROOT') { mapping.root = { item_id: item.id, web_url: item.webUrl || '', name: item.name, parent_id: parentId, at: U.nowIso() }; addLog(mapping, reused ? 'reused' : 'created', 'ROOT', item.name); }
      else record(mapping, n.key, n, item, reused, parentId);
      trusted.add(item.id);
      if (reused) res.reused++; else res.created++;
    } catch (e) {
      if (e.revoked) { res.stopped = 'revoked'; res.error = e.message; break; }
      const prev = mapping.nodes[n.key] || {};
      const attempts = (prev.attempts || 0) + 1;
      if (n.key !== 'ROOT') mapping.nodes[n.key] = { ...prev, name: n.name, status: 'failed', attempts, error: e.message, next_retry_at: new Date(now() + Math.min(60, 2 ** attempts) * 60000).toISOString(), at: U.nowIso() };
      addLog(mapping, 'failed', n.key, n.name, e.message);
      res.failed++;
      if (n.key === 'ROOT') { res.stopped = 'root_failed'; res.error = e.message; break; }
    }
  }
  mapping.last_run = { at: U.nowIso(), ...res };
  return res;
}

const isCompanyKey = k => /^E:[^|]+$/.test(k);

/**
 * Company folders created directly under Finance & Compliance. Only that level counts (deeper folders, files and the engine's
 * own folders are ignored). A folder named exactly like an entity's legal name that has no folder yet is linked; anything else
 * waits for a person ("link to entity" / "not a company folder").
 */
async function scan({ graph, mapping, org }) {
  if (!mapping.root?.item_id) return { skipped: 'Finance & Compliance has not been created yet', linked: [], found: [] };
  const kids = await graph.children(mapping.base.drive_id, mapping.root.item_id);
  const mine = new Set(Object.entries(mapping.nodes).filter(([k]) => isCompanyKey(k)).map(([, v]) => v.item_id));
  const linked = [], foundNew = [];
  for (const k of kids.filter(x => x.folder)) {
    if (mine.has(k.id)) continue;
    const known = mapping.found.find(f => f.item_id === k.id);
    if (known) { known.name = k.name; continue; }
    const ent = org.entities.find(e => e.status !== 'inactive' && !mapping.nodes[`E:${e.id}`]?.item_id && FO.safeName(e.legal_name).toLowerCase() === k.name.trim().toLowerCase());
    if (ent) { link(mapping, k, ent); linked.push(ent.id); continue; }
    mapping.found.push({ item_id: k.id, name: k.name, web_url: k.webUrl || '', first_seen: U.nowIso(), status: 'open' });
    addLog(mapping, 'found', '', k.name, 'Folder added directly in OneDrive — waiting to be linked to an entity or ignored');
    foundNew.push(k.name);
  }
  mapping.last_scan = { at: U.nowIso(), folders: kids.filter(x => x.folder).length, linked: linked.length, found: foundNew.length };
  return { linked, found: foundNew };
}

/** Link a folder at company level to an entity (one company folder per entity) */
function link(mapping, item, entity) {
  if (mapping.nodes[`E:${entity.id}`]?.item_id) throw U.httpError(409, `${entity.legal_name} already has its company folder`);
  // only folders found directly in Finance & Compliance are offered for linking, so their parent is the root
  mapping.nodes[`E:${entity.id}`] = { item_id: item.id || item.item_id, parent_item_id: mapping.root?.item_id, web_url: item.webUrl || item.web_url || '', name: item.name, label: entity.legal_name, status: 'linked', at: U.nowIso(), attempts: 0 };
  const f = mapping.found.find(x => x.item_id === (item.id || item.item_id));
  if (f) Object.assign(f, { status: 'linked', entity_id: entity.id });
  addLog(mapping, 'linked', `E:${entity.id}`, item.name, `Linked to ${entity.legal_name}`);
}

/**
 * Put one document version into its folder (creating any missing folder on the way) → { item_id, web_url, path, file_name, reused }.
 * ctx: { graph, mapping, route (folders.route result), entity, buffer }
 */
async function uploadDocument({ graph, mapping, route, entity, buffer }) {
  if (!mapping.base?.item_id || !mapping.root?.item_id) throw U.httpError(400, 'The Finance & Compliance folder has not been created yet — run the folder set-up first');
  const fy = route.fy_key.split('|FY:')[1];
  const catCode = route.category_key.split('|C:')[1];
  const chain = [
    { key: `E:${entity.id}`, parent: 'ROOT', name: FO.safeName(entity.legal_name), label: entity.legal_name, kind: 'company' },
    { key: route.fy_key, parent: `E:${entity.id}`, name: `FY ${fy}` },
    { key: route.category_key, parent: route.fy_key, name: FO.CATS[catCode] },
    ...route.keys,
  ];
  const drive = mapping.base.drive_id;
  const path = [FO.ROOT_NAME];
  const trusted = new Set();
  for (const n of chain) {
    path.push(mapping.nodes[n.key]?.name || n.name);
    if (mapping.nodes[n.key]?.invalid) throw U.httpError(409, `Refused: the folder "${mapping.nodes[n.key].name}" would not be inside the Finance & Compliance folder (it was moved) — fix it in Document Folders`);
    if (mapping.nodes[n.key]?.item_id) continue;
    const parentId = n.parent === 'ROOT' ? mapping.root.item_id : mapping.nodes[n.parent]?.item_id;
    if (!parentId || (n.parent !== 'ROOT' && !(await ensureInside(graph, mapping, n.parent, trusted)))) throw U.httpError(500, `Refused: "${n.name}" would not be inside the Finance & Compliance folder`);
    const { item, reused } = await graph.createFolder(drive, parentId, n.name);
    record(mapping, n.key, n, item, reused, parentId);
    trusted.add(item.id);
  }
  const last = chain[chain.length - 1].key;
  if (!(await ensureInside(graph, mapping, last, trusted))) throw U.httpError(500, 'Refused: the document\'s folder is not inside the Finance & Compliance folder');
  const folderId = mapping.nodes[last].item_id;
  const { item, reused } = await graph.upload(drive, folderId, route.file_name, buffer);
  addLog(mapping, reused ? 'file_reused' : 'file_uploaded', chain[chain.length - 1].key, route.file_name);
  return { item_id: item.id, web_url: item.webUrl || '', path: `${path.join(' / ')} / ${route.file_name}`, file_name: route.file_name, reused };
}

/** Merge a run's mapping into the stored one (a key already mapped in the store wins; logs are appended) */
function merge(stored, ran, { logFrom = 0 } = {}) {
  if (!stored.root?.item_id && ran.root?.item_id) stored.root = ran.root;
  if (!stored.base && ran.base) stored.base = ran.base;
  for (const [k, v] of Object.entries(ran.nodes)) {
    const s = stored.nodes[k];
    if (s?.item_id && v.item_id && s.item_id !== v.item_id) continue;
    if (s?.item_id && !v.item_id) continue;
    stored.nodes[k] = v;
  }
  for (const f of ran.found) { const s = stored.found.find(x => x.item_id === f.item_id); if (s) Object.assign(s, f); else stored.found.push(f); }
  stored.log.push(...ran.log.slice(logFrom));
  if (stored.log.length > LOG_MAX) stored.log.splice(0, stored.log.length - LOG_MAX);
  if (ran.last_run) stored.last_run = ran.last_run;
  if (ran.last_scan) stored.last_scan = ran.last_scan;
  return stored;
}

module.exports = { EMPTY, preview, apply, scan, link, uploadDocument, merge, isCompanyKey };
