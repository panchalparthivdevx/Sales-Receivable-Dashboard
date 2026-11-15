import axios from 'axios';

// Compliance Dashboard Vr.2.0 — server routes in server/compliance2/index.js
const B = '/api/compliance2';
let ctx = { space: 'live', persona: '' };
export const setContext = c => { ctx = { ...ctx, ...c }; };
const cfg = (extra = {}) => ({ ...extra, headers: { 'X-C2-Space': ctx.space, ...(ctx.space === 'demo' && ctx.persona ? { 'X-C2-Persona': ctx.persona } : {}), ...(extra.headers || {}) } });
const d = r => {
  if (!r.data || typeof r.data !== 'object') throw new Error('The dashboard server is running an older version — restart it to use Compliance Dashboard Vr.2.0.');
  return r.data;
};
// arrays → comma lists, empty values dropped
export const clean = p => Object.fromEntries(Object.entries(p || {}).filter(([, v]) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));
export const errMsg = e => e?.response?.data?.error || e?.message || 'Something went wrong';

const get = (p, params) => axios.get(`${B}${p}`, cfg({ params: clean(params) })).then(d);
const post = (p, body, extra) => axios.post(`${B}${p}`, body, cfg(extra)).then(d);
const put = (p, body) => axios.put(`${B}${p}`, body, cfg()).then(d);

export const api = {
  meta: () => get('/meta'), users: () => get('/users'), org: () => get('/org'),
  saveOrg: (kind, body, id) => (id ? put(`/org/${kind}/${id}`, body) : post(`/org/${kind}`, body)),
  approveOrg: (kind, id) => post(`/org/${kind}/${id}/approve`, {}),
  rules: () => get('/rules'),
  newDraft: (id, body) => post(`/rules/${id}/versions`, body),
  editDraft: (id, v, patch) => put(`/rules/${id}/versions/${v}`, { patch }),
  verifyRule: (id, v, body) => post(`/rules/${id}/versions/${v}/verify`, body),
  preview: (id, v, scope) => get(`/rules/${id}/versions/${v}/preview`, scope),
  approveRule: (id, v, body) => post(`/rules/${id}/versions/${v}/approve`, body),
  withdrawRule: (id, v, reason) => post(`/rules/${id}/versions/${v}/withdraw`, { reason }),
  createExt: body => post('/extensions', body),
  extAction: (id, action, body) => post(`/extensions/${id}/${action}`, body || {}),
  coverage: params => get('/coverage', params),
  decide: body => post('/applicability', body),
  accept: body => post('/applicability/accept', body),
  events: () => get('/events'),
  saveEvent: (body, id) => (id ? put(`/events/${id}`, body) : post('/events', body)),
  generate: body => post('/tasks/generate', body, { timeout: 300000 }),
  tasks: params => get('/tasks', params), overview: params => get('/overview', params), workload: params => get('/workload', params),
  task: id => get(`/tasks/${id}`),
  act: (id, body) => post(`/tasks/${id}/action`, body),
  edit: (id, body) => axios.patch(`${B}/tasks/${id}`, body, cfg()).then(d),
  upload: (id, form, onUploadProgress) => post(`/tasks/${id}/documents`, form, { timeout: 300000, onUploadProgress }),
  linkDoc: (id, doc_id) => post(`/tasks/${id}/documents/link`, { doc_id }),
  documents: params => get('/documents', params),
  linkUrl: (id, version) => post(`/documents/${id}/link-url`, { version }),
  docAction: (id, action, body) => post(`/documents/${id}/${action}`, body),
  team: () => get('/team'), saveTeam: rows => put('/team', { rows }),
  settings: () => get('/settings'), saveSettings: body => put('/settings', body), saveAccess: body => put('/settings/access', body),
  audit: params => get('/audit', params), verifyAudit: () => get('/audit/verify'),
  importStep: (step, form) => post(`/import/${step}`, form, { timeout: 300000 }),
  importV1: step => post(`/import-v1/${step}`, {}),
  demoReset: () => post('/demo/reset', {}, { timeout: 300000 }),
  // Document folders (OneDrive) — server/compliance2/lib/provision.js
  folders: params => get('/folders', params),
  foldersPreview: body => post('/folders/preview', body),
  foldersProvision: body => post('/folders/provision', body, { timeout: 900000 }),
  foldersScan: () => post('/folders/scan', {}, { timeout: 900000 }),
  foundAction: (itemId, action, body) => post(`/folders/found/${encodeURIComponent(itemId)}/${action}`, body || {}, { timeout: 900000 }),
  saveFolderSettings: body => put('/folders/settings', body),
  previewCompany: (name, fy) => get('/folders/preview-company', { name, fy }),
  connectUrl: () => post('/onedrive/connect-url', {}),
  setBase: url => post('/onedrive/base', { url }),
  disconnectOneDrive: () => post('/onedrive/disconnect', {}),
  docToOneDrive: (id, version) => post(`/documents/${id}/onedrive`, { version }, { timeout: 300000 }),
  // Workspace — server/compliance2/workspace.js
  ws: () => get('/ws/meta'), prompt: () => get('/ws/prompt'), savePrompt: form => axios.put(`${B}/ws/prompt`, form, cfg()).then(d),
  uploadFile: (form, onUploadProgress) => post('/files', form, { timeout: 300000, onUploadProgress }), files: params => get('/files', params), fileUrl: id => post(`/files/${id}/link-url`, {}),
  payments: params => get('/payments', params), addPayment: body => post('/payments', body), reversePayment: (id, reason) => post(`/payments/${id}/reverse`, { reason }),
  tds: params => get('/tds', params), addSection: body => post('/tds/sections', body), verifySection: (id, source) => post(`/tds/sections/${id}/verify`, { source }),
  addChallan: body => post('/tds/challans', body), reverseChallan: (id, reason) => post(`/tds/challans/${id}/reverse`, { reason }), reviewChallan: (id, action, note) => post(`/tds/challans/${id}/review`, { action, note }),
  allocate: (body, id) => (id ? put(`/tds/allocations/${id}`, body) : post('/tds/allocations', body)), reverseAllocation: (id, reason) => post(`/tds/allocations/${id}/reverse`, { reason }),
  recon: params => get('/recon', params), reconOne: id => get(`/recon/${id}`), saveRecon: (body, id) => (id ? put(`/recon/${id}`, body) : post('/recon', body)), reconAct: (id, action, body) => post(`/recon/${id}/${action}`, body || {}),
  reconImport: (type, form) => post(`/recon-import/${type}`, form),
  importParse: form => post('/imports/parse', form, { timeout: 300000 }), importMap: body => post('/imports/map', body), importSave: body => post('/imports/batches', body, { timeout: 300000 }),
  importBatches: params => get('/imports/batches', params), importToRecon: id => post(`/imports/batches/${id}/to-recon`, {}), importWithdraw: (id, reason) => post(`/imports/batches/${id}/withdraw`, { reason }),
  taxaudit: params => get('/taxaudit', params), saveLot: (body, id) => (id ? put(`/taxaudit/lots/${id}`, body) : post('/taxaudit/lots', body)), approveLot: id => post(`/taxaudit/lots/${id}/approve`, {}),
  saveTaPayment: (body, id) => (id ? put(`/taxaudit/payments/${id}`, body) : post('/taxaudit/payments', body)), verifyTaPayment: (id, verified) => post(`/taxaudit/payments/${id}/verify`, { verified }),
  reverseTaPayment: (id, reason) => post(`/taxaudit/payments/${id}/reverse`, { reason }), saveCutoff: body => put('/taxaudit/settings', body),
  updates: params => get('/updates', params), addUpdate: body => post('/updates', body), editUpdate: (id, body) => put(`/updates/${id}`, body), decideUpdate: (id, body) => post(`/updates/${id}/decide`, body),
  noteUpdate: (id, text) => post(`/updates/${id}/note`, { text }), markUpdate: (id, what, on) => post(`/updates/${id}/mark`, { what, on }), addAction: body => post('/updates/actions', body),
  setAction: (id, status) => post(`/updates/actions/${id}`, { status }), proposeRule: (id, body) => post(`/updates/${id}/propose-rule`, body), updateSettings: body => put('/updates/settings', body),
  addSource: body => post('/updates/sources', body), setSource: (id, body) => put(`/updates/sources/${id}`, body), runMonitor: () => post('/updates/run', {}, { timeout: 600000 }),
  reportPayments: params => get('/reports/payments', params), reportTrends: params => get('/reports/trends', params), reportTasks: params => get('/reports/tasks', params), reportRecon: (page, params) => get(`/reports/recon/${page}`, params),
};

/** Opens a workspace evidence file through a short-lived signed link */
export async function openFile(fileId) {
  const { url } = await api.fileUrl(fileId);
  const a = document.createElement('a');
  a.href = url; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

/** Download from an authenticated route (the login token travels in the header) */
export async function download(path, params, fallbackName) {
  try {
    const r = await axios.get(`${B}${path}`, cfg({ params: clean(params), responseType: 'blob', timeout: 300000 }));
    const m = (r.headers['content-disposition'] || '').match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(r.data); a.download = m ? m[1] : fallbackName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    if (e?.response?.data instanceof Blob) { let msg; try { msg = JSON.parse(await e.response.data.text()).error; } catch (_) { /* not JSON */ } throw new Error(msg || 'The download failed'); }
    throw e;
  }
}

/** Opens a document through a short-lived signed link (valid ~2 minutes, for this user only) */
export async function openDocument(docId, version) {
  const { url } = await api.linkUrl(docId, version);
  const a = document.createElement('a');
  a.href = url; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
