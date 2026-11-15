/**
 * Microsoft Graph (OneDrive) — the few calls the folder engine needs, on behalf of the signed-in user (delegated permission
 * Files.ReadWrite: that user's own OneDrive only). The access token comes from lib/msauth.js; nothing here stores it.
 *
 *   resolveBase(url)              the folder a OneDrive / SharePoint link points to (never guessed from the text)
 *   children / createFolder       a folder is created with conflictBehavior "fail"; if the name already exists the existing
 *                                 folder is returned as reused — a folder is never replaced or renamed by accident
 *   rename                        only for a company folder whose legal name changed (its id, and so its mapping, stays)
 *   upload                        small files in one request, larger ones through an upload session; never overwrites
 * Throttling (429 / 503) is retried after Retry-After; a revoked sign-in surfaces as { revoked: true }.
 */

'use strict';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = p => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

function graphError(e) {
  const d = e.response?.data?.error || {};
  const err = new Error(d.message || e.message);
  err.status = e.response?.status || 0;
  err.code = d.code || e.code || '';
  if (e.revoked) err.revoked = true;
  return err;
}

function create({ getToken, http = require('axios'), wait = sleep } = {}) {
  async function call(method, url, data, headers = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await getToken();                      // throws { revoked } when the sign-in is no longer valid
      try {
        const r = await http({ method, url: url.startsWith('http') ? url : `${GRAPH}${url}`, data, headers: { Authorization: `Bearer ${token}`, ...headers }, timeout: 60000, maxBodyLength: Infinity });
        return r.data;
      } catch (e) {
        if (e.revoked) throw e;
        const status = e.response?.status;
        if ((status === 429 || status === 503 || status === 504) && attempt < 4) { await wait(Math.min(60, Number(e.response.headers?.['retry-after']) || 2 ** attempt) * 1000); continue; }
        const err = graphError(e);
        if (status === 401) err.revoked = true;
        throw err;
      }
    }
  }
  const sel = '$select=id,name,folder,file,size,webUrl,parentReference';
  const api = {
    me: () => call('GET', '/me?$select=id,displayName,userPrincipalName,mail'),
    item: (driveId, id) => call('GET', `/drives/${driveId}/items/${id}?${sel}`),
    itemByPath: path => call('GET', `/me/drive/root:/${enc(path)}?${sel}`),
    async children(driveId, id) {
      const out = [];
      let url = `/drives/${driveId}/items/${id}/children?${sel}&$top=200`;
      while (url) { const r = await call('GET', url); out.push(...(r.value || [])); url = r['@odata.nextLink'] || null; }
      return out;
    },
    async createFolder(driveId, parentId, name) {
      try {
        return { item: await call('POST', `/drives/${driveId}/items/${parentId}/children`, { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }), reused: false };
      } catch (e) {
        if (e.status !== 409) throw e;
        const hit = (await api.children(driveId, parentId)).find(k => k.name.toLowerCase() === name.toLowerCase());
        if (hit?.folder) return { item: hit, reused: true };
        throw Object.assign(new Error(`A file (not a folder) named "${name}" is already there`), { status: 409 });
      }
    },
    rename: (driveId, id, name) => call('PATCH', `/drives/${driveId}/items/${id}`, { name, '@microsoft.graph.conflictBehavior': 'fail' }),
    async upload(driveId, parentId, name, buffer) {
      try {
        if (buffer.length <= 4 * 1024 * 1024) return { item: await call('PUT', `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`, buffer, { 'Content-Type': 'application/octet-stream' }), reused: false };
        const s = await call('POST', `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}:/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'fail' } });
        const CH = 5 * 1024 * 1024;                          // a multiple of 320 KiB
        let last = null;
        for (let i = 0; i < buffer.length; i += CH) {
          const part = buffer.subarray(i, i + CH);
          last = await call('PUT', s.uploadUrl, part, { 'Content-Range': `bytes ${i}-${i + part.length - 1}/${buffer.length}`, 'Content-Length': String(part.length) });
        }
        return { item: last, reused: false };
      } catch (e) {
        if (e.status !== 409) throw e;
        const hit = (await api.children(driveId, parentId)).find(k => k.name.toLowerCase() === name.toLowerCase() && k.file);
        if (hit && hit.size === buffer.length) return { item: hit, reused: true };            // uploaded earlier, answer lost
        throw Object.assign(new Error(`A different file named "${name}" is already there — nothing was overwritten`), { status: 409 });
      }
    },
    /**
     * The folder a link points to. Accepts the OneDrive web address (…/my?id=/personal/<user>/Documents/<path>, or
     * …/personal/<user>/Documents/<path>) and sharing links. It must be in the signed-in user's own OneDrive.
     */
    async resolveBase(url, me) {
      let u;
      try { u = new URL(String(url).trim()); } catch (_) { throw Object.assign(new Error('That is not a web address'), { status: 400 }); }
      const idParam = u.searchParams.get('id');
      const full = decodeURIComponent(idParam || u.pathname);
      const m = /\/personal\/([^/]+)\/Documents(?:\/(.*))?$/i.exec(full);
      if (m) {
        const owner = m[1].toLowerCase();
        const mine = String(me?.userPrincipalName || me?.mail || '').toLowerCase().replace(/[@.]/g, '_');
        if (mine && owner !== mine) throw Object.assign(new Error(`The link is to another person's OneDrive (${m[1]}). Sign in as that person, or use a folder in your own OneDrive.`), { status: 400 });
        const path = (m[2] || '').replace(/\/+$/, '');
        const item = path ? await api.itemByPath(path) : await call('GET', `/me/drive/root?${sel}`);
        if (!item.folder) throw Object.assign(new Error('The link points to a file, not a folder'), { status: 400 });
        return { item, path: path || '/' };
      }
      const share = `u!${Buffer.from(String(url).trim()).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
      const item = await call('GET', `/shares/${share}/driveItem?${sel}`);
      if (!item.folder) throw Object.assign(new Error('The link points to a file, not a folder'), { status: 400 });
      return { item, path: item.name };
    },
  };
  return api;
}

module.exports = { create };
