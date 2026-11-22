import axios from 'axios';

// 26AS Reconciliation — server routes in server/tds26as/index.js
const B = '/api/tds26as';
// an unknown /api route answers with the app's index.html: that means the server has not been restarted with this module yet
const d = r => {
  if (!r.data || typeof r.data !== 'object') throw new Error('The dashboard server is running an older version — restart it to use 26AS Reconciliation.');
  return r.data;
};
const clean = p => Object.fromEntries(Object.entries(p || {}).filter(([, v]) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));

export const errMsg = e => e?.response?.data?.error || e?.message || 'Something went wrong';

/** Download from an authenticated route (the login token travels in the header) */
export async function download(url, params, fallbackName) {
  try {
    const r = await axios.get(url, { params: clean(params), responseType: 'blob', timeout: 300000 });
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

export const t = {
  meta:          ()        => axios.get(`${B}/meta`).then(d),
  zohoOrgs:      ()        => axios.post(`${B}/onboard/zoho-orgs`, {}, { timeout: 120000 }).then(d),
  ledgers:       org_id    => axios.post(`${B}/onboard/ledgers`, { org_id }, { timeout: 300000 }).then(d),
  check:         entity    => axios.post(`${B}/onboard/check`, { entity }, { timeout: 180000 }).then(d),
  saveEntities:  entities  => axios.put(`${B}/config/entities`, { entities }).then(d),
  saveSettings:  s         => axios.put(`${B}/config/settings`, s).then(d),
  saveSchedule:  s         => axios.put(`${B}/config/schedule`, s).then(d),
  saveAccess:    access    => axios.put(`${B}/config/access`, { access }).then(d),

  syncStatus:    entity    => axios.get(`${B}/sync/status`, { params: { entity } }).then(d),
  syncStep:      body      => axios.post(`${B}/sync/step`, body, { timeout: 700000 }).then(d),
  syncCancel:    entity    => axios.post(`${B}/sync/cancel`, { entity }).then(d),

  preview:       (form, onProgress) => axios.post(`${B}/import/preview`, form, { timeout: 600000, onUploadProgress: onProgress }).then(d),
  commit:        body      => axios.post(`${B}/import/commit`, body, { timeout: 600000 }).then(d),
  imports:       entity    => axios.get(`${B}/imports`, { params: { entity } }).then(d),
  importOne:     id        => axios.get(`${B}/imports/${id}`).then(d),
  fileDownload:  (id, name) => download(`${B}/imports/${id}/file`, {}, name),

  dashboard:     p         => axios.get(`${B}/recon/dashboard`, { params: clean(p), timeout: 180000 }).then(d),
  units:         p         => axios.get(`${B}/recon/units`, { params: clean(p), timeout: 180000 }).then(d),
  unit:          p         => axios.get(`${B}/recon/unit`, { params: clean(p) }).then(d),
  followup:      p         => axios.get(`${B}/reports/followup`, { params: clean(p), timeout: 180000 }).then(d),
  corrections:   p         => axios.get(`${B}/reports/corrections`, { params: clean(p), timeout: 180000 }).then(d),
  carryforward:  p         => axios.get(`${B}/reports/carryforward`, { params: clean(p) }).then(d),
  rerun:         entity    => axios.post(`${B}/recon/rerun`, { entity }, { timeout: 300000 }).then(d),
  exportXlsx:    p         => download(`${B}/export/xlsx`, p, '26AS_Reconciliation.xlsx'),

  clients:       entity    => axios.get(`${B}/clients`, { params: { entity } }).then(d),
  customers:     entity    => axios.get(`${B}/clients/customers`, { params: { entity } }).then(d),
  approve:       (entity, suggestions) => axios.post(`${B}/clients/approve`, { entity, suggestions }).then(d),
  saveGroup:     (entity, group) => axios.post(`${B}/clients/group`, { entity, group }).then(d),
  removeGroup:   (entity, id) => axios.post(`${B}/clients/remove`, { entity, id }).then(d),
  noCustomer:    (entity, tan, on, note) => axios.post(`${B}/clients/no-customer`, { entity, tan, on, note }).then(d),
  reject:        (entity, customer_id, tan) => axios.post(`${B}/clients/reject`, { entity, customer_id, tan }).then(d),

  decide:        body      => axios.post(`${B}/review/decision`, body, { timeout: 180000 }).then(d),
  attach:        form      => axios.post(`${B}/review/attachment`, form, { timeout: 300000 }).then(d),
  attachmentDownload: (entity, sha, name) => download(`${B}/review/attachment/${sha}`, { entity }, name),
  link:          body      => axios.post(`${B}/review/link`, body).then(d),
  unlink:        (entity, id) => axios.post(`${B}/review/unlink`, { entity, id }).then(d),
  setClient:     body      => axios.post(`${B}/review/client`, body).then(d),
  closeCf:       body      => axios.post(`${B}/cf/close`, body).then(d),

  audit:         month     => axios.get(`${B}/audit`, { params: { month } }).then(d),
  auditVerify:   ()        => axios.get(`${B}/audit/verify`).then(d),
  demoLoad:      ()        => axios.post(`${B}/demo/load`, {}, { timeout: 300000 }).then(d),
  demoRemove:    ()        => axios.post(`${B}/demo/remove`, {}, { timeout: 120000 }).then(d),
};
