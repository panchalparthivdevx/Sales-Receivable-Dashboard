// Compliance Dashboard API calls. Same pattern as utils/api.js: axios + the login token that
// AuthContext attaches to every request. Documents are fetched as blobs through the
// authenticated endpoint — there are no public or guessable document URLs.

import axios from 'axios';

const BASE = `/api/compliance`;

// An out-of-date server answers unknown /api routes with the app's HTML page instead of JSON
const json = r => {
  if (!r.data || typeof r.data !== 'object') {
    throw new Error('The dashboard server is running an older version — restart it to use the Compliance Dashboard.');
  }
  return r.data;
};

const get  = (url, params) => axios.get(`${BASE}${url}`, { params }).then(json);
const post = (url, body, cfg) => axios.post(`${BASE}${url}`, body, cfg).then(json);
const put  = (url, body, cfg) => axios.put(`${BASE}${url}`, body, cfg).then(json);
const del  = url => axios.delete(`${BASE}${url}`).then(json);
const blob = (url, params) => axios.get(`${BASE}${url}`, { params, responseType: 'blob', timeout: 120000 });

export const capi = {
  meta:        ()        => get('/meta'),
  dashboard:   (q)       => get('/dashboard', q),
  search:      (q)       => get('/search', q),

  task:        (id)      => get(`/tasks/${encodeURIComponent(id)}`),
  updateTask:  (id, b)   => put(`/tasks/${encodeURIComponent(id)}`, b),
  createTask:  (b)       => post('/tasks', b),
  deleteTask:  (id)      => del(`/tasks/${encodeURIComponent(id)}`),
  generate:    (b)       => post('/tasks/generate', b, { timeout: 120000 }),

  master:          ()        => get('/master'),
  saveCompany:     (b, id)   => (id ? put(`/master/companies/${id}`, b) : post('/master/companies', b)),
  deleteCompany:   (id)      => del(`/master/companies/${id}`),
  saveCompliance:  (b, id)   => (id ? put(`/master/compliances/${encodeURIComponent(id)}`, b) : post('/master/compliances', b)),
  deleteCompliance:(id)      => del(`/master/compliances/${encodeURIComponent(id)}`),
  saveApplicability: (b)     => put('/master/applicability', b),
  rulePreview:     (b)       => post('/master/rule-preview', b),
  template:        ()        => blob('/master/template'),
  exportMaster:    (fy)      => blob('/master/export', { fy }),

  importPreview: (file) => { const f = new FormData(); f.append('file', file); return post('/import/preview', f, { timeout: 120000 }); },
  importConfirm: (token) => post('/import/confirm', { token }, { timeout: 120000 }),
  importErrors:  (token) => blob(`/import/${token}/errors`),

  settings:      ()      => get('/settings'),
  saveSettings:  (b)     => put('/settings', b),
  resetSettings: (keys)  => post('/settings/reset', { keys }),

  users:        ()        => get('/users'),
  setUserRole:  (id, b)   => put(`/users/${id}/role`, b),
  createUser:   (b)       => post('/users', b),
  updateUser:   (id, b)   => put(`/users/${id}`, b),

  audit:        (q)       => get('/audit', q),

  folderStatus: (q)       => get('/folders/status', q),
  createFolders:(b)       => post('/folders/create', b),

  uploadDoc:   (taskId, file, docType) => { const f = new FormData(); f.append('doc_type', docType); f.append('file', file); return post(`/tasks/${encodeURIComponent(taskId)}/documents`, f, { timeout: 120000 }); },
  addLink:     (taskId, b) => post(`/tasks/${encodeURIComponent(taskId)}/links`, b),
  downloadDoc: (id, inline) => blob(`/documents/${id}/download`, inline ? { inline: 1 } : undefined),
  replaceDoc:  (id, file) => { const f = new FormData(); f.append('file', file); return put(`/documents/${id}/replace`, f, { timeout: 120000 }); },
  deleteDoc:   (id)       => del(`/documents/${id}`),

  zohoStatus: (q) => get('/zoho/status', q),
  zohoData:   (q) => get('/zoho/data', q),
  zohoSync:   (b) => post('/zoho/sync', b, { timeout: 600000 }),
};

/** Readable error text from an axios error (including JSON errors inside blob responses) */
export async function errText(e) {
  const d = e?.response?.data;
  if (d instanceof Blob) {
    try { const j = JSON.parse(await d.text()); if (j.error) return j.error; } catch (_) { /* not JSON */ }
  }
  return d?.error || e?.message || 'Something went wrong';
}
export const errSync = e => e?.response?.data?.error || e?.message || 'Something went wrong';
