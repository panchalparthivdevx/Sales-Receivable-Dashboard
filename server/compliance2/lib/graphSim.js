/**
 * A SIMULATED OneDrive with the same calls as lib/graph.js — used by the demo space ("simulated, not synced": nothing is sent
 * to Microsoft) and by the tests (which can make calls fail or revoke the sign-in).
 *
 * State is plain data ({ items }) so the demo can keep it in its store document.
 */

'use strict';

const crypto = require('crypto');

function create(state = null) {
  const s = state || { drive: 'sim-drive', items: { root: { id: 'root', name: 'root', parent: null, folder: true } } };
  if (!s.items['sim-base']) s.items['sim-base'] = { id: 'sim-base', name: 'New folder', parent: 'root', folder: true };
  const calls = { read: 0, write: 0, creates: [] };
  let fail = [];                                                    // [{ op, times, error }]
  let revoked = false;
  const web = it => `https://onedrive.simulated.invalid/${it.id}`;
  const out = it => ({ id: it.id, name: it.name, folder: it.folder ? {} : undefined, file: it.folder ? undefined : {}, size: it.size || 0, webUrl: web(it), parentReference: { driveId: s.drive, id: it.parent } });
  function gate(op, write) {
    if (revoked) throw Object.assign(new Error('The sign-in was revoked'), { status: 401, code: 'invalid_grant', revoked: true });
    const f = fail.find(x => x.op === op || x.op === '*');
    if (f && f.times > 0) { f.times--; throw Object.assign(new Error(f.error || 'Simulated failure'), { status: f.status || 500 }); }
    if (write) calls.write++; else calls.read++;
  }
  const get = id => { const it = s.items[id]; if (!it) throw Object.assign(new Error('itemNotFound'), { status: 404 }); return it; };
  const kids = id => Object.values(s.items).filter(i => i.parent === id);
  const api = {
    simulated: true,
    async me() { gate('me'); return { id: 'sim-user', displayName: 'Simulated user', userPrincipalName: 'simulated@onedrive.invalid' }; },
    async item(driveId, id) { gate('item'); return out(get(id)); },
    async itemByPath(path) {
      gate('item');
      let cur = s.items.root;
      for (const part of path.split('/').filter(Boolean)) { cur = kids(cur.id).find(k => k.name.toLowerCase() === part.toLowerCase()); if (!cur) throw Object.assign(new Error('itemNotFound'), { status: 404 }); }
      return out(cur);
    },
    async children(driveId, id) { gate('children'); get(id); return kids(id).map(out); },
    async createFolder(driveId, parentId, name) {
      gate('createFolder', true);
      if (!get(parentId).folder) throw Object.assign(new Error('Parent is not a folder'), { status: 400 });
      const hit = kids(parentId).find(k => k.name.toLowerCase() === name.toLowerCase());
      if (hit) { if (!hit.folder) throw Object.assign(new Error(`A file (not a folder) named "${name}" is already there`), { status: 409 }); return { item: out(hit), reused: true }; }
      const it = { id: `sim-${crypto.randomBytes(6).toString('hex')}`, name, parent: parentId, folder: true };
      s.items[it.id] = it;
      calls.creates.push({ parent: parentId, name, id: it.id });
      return { item: out(it), reused: false };
    },
    async rename(driveId, id, name) {
      gate('rename', true);
      const it = get(id);
      if (kids(it.parent).some(k => k.id !== id && k.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('nameAlreadyExists'), { status: 409 });
      it.name = name;
      return out(it);
    },
    async upload(driveId, parentId, name, buffer) {
      gate('upload', true);
      const hit = kids(parentId).find(k => k.name.toLowerCase() === name.toLowerCase());
      if (hit) { if (!hit.folder && hit.size === buffer.length) return { item: out(hit), reused: true }; throw Object.assign(new Error('nameAlreadyExists'), { status: 409 }); }
      const it = { id: `sim-${crypto.randomBytes(6).toString('hex')}`, name, parent: parentId, folder: false, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
      s.items[it.id] = it;
      return { item: out(it), reused: false };
    },
    async resolveBase(url) {
      gate('item');
      if (!/^https:\/\//i.test(String(url || ''))) throw Object.assign(new Error('That is not a web address'), { status: 400 });
      return { item: out(s.items['sim-base']), path: 'New folder' };
    },
    // test / demo helpers
    state: () => s,
    calls,
    failNext(op, times = 1, error, status) { fail.push({ op, times, error, status }); },
    clearFailures() { fail = []; },
    revoke() { revoked = true; },
    /** a person creates a folder directly in OneDrive */
    addFolderByHand(parentId, name) { const it = { id: `sim-hand-${crypto.randomBytes(4).toString('hex')}`, name, parent: parentId, folder: true }; s.items[it.id] = it; return it; },
    pathOf(id) { const parts = []; let cur = s.items[id]; while (cur && cur.parent) { parts.unshift(cur.name); cur = s.items[cur.parent]; } return parts.join('/'); },
    isInside(id, ancestorId) { let cur = s.items[id]; while (cur) { if (cur.id === ancestorId) return true; cur = s.items[cur.parent]; } return false; },
  };
  return api;
}

module.exports = { create };
