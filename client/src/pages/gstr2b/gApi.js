import axios from 'axios';

// GSTR-2B Reco — server routes in server/gstr2b/index.js
const B = '/api/gstr2b';
const d = r => {
  if (!r.data || typeof r.data !== 'object') throw new Error('The dashboard server is running an older version — restart it to use GSTR-2B Reco.');
  return r.data;
};
// arrays → comma lists, empty values dropped (the server reads filters as comma lists)
const clean = p => Object.fromEntries(Object.entries(p || {}).filter(([, v]) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));

export const errMsg = e => e?.response?.data?.error || e?.message || 'Something went wrong';

/** Download a file from an authenticated route (the login token travels in the header, not in the link) */
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

export const g = {
  meta:        ()           => axios.get(`${B}/meta`).then(d),
  zohoOrgs:    ()           => axios.post(`${B}/onboard/zoho-orgs`, {}, { timeout: 120000 }).then(d),
  branches:    org_id       => axios.post(`${B}/onboard/branches`, { org_id }, { timeout: 120000 }).then(d),
  check:       company      => axios.post(`${B}/onboard/check`, { company }, { timeout: 180000 }).then(d),
  saveCompanies: companies  => axios.put(`${B}/config/companies`, { companies }, { timeout: 120000 }).then(d),
  saveSettings: s           => axios.put(`${B}/config/settings`, s).then(d),
  saveSchedule: s           => axios.put(`${B}/config/schedule`, s).then(d),
  saveSync:    s            => axios.put(`${B}/config/sync`, s).then(d),
  saveAccess:  access       => axios.put(`${B}/config/access`, { access }).then(d),

  syncStatus:  company      => axios.get(`${B}/sync/status`, { params: { company } }).then(d),
  syncRun:     body         => axios.post(`${B}/sync/run`, body, { timeout: 600000 }).then(d),
  syncCancel:  company      => axios.post(`${B}/sync/cancel`, { company }).then(d),
  syncKick:    company      => axios.post(`${B}/sync/kick`, { company }, { timeout: 600000 }).then(d),
  retryFailed: company      => axios.post(`${B}/sync/retry-failed`, { company }).then(d),
  refresh:     (company, doc_id) => axios.post(`${B}/sync/refresh`, { company, doc_id }, { timeout: 120000 }).then(d),

  preview:     (form, onProgress) => axios.post(`${B}/import/preview`, form, { timeout: 600000, onUploadProgress: onProgress }).then(d),
  commit:      body         => axios.post(`${B}/import/commit`, body, { timeout: 600000 }).then(d),
  imports:     params       => axios.get(`${B}/imports`, { params: clean(params) }).then(d),
  importOne:   id           => axios.get(`${B}/imports/${id}`).then(d),
  diff:        (a, b)       => axios.get(`${B}/imports/diff`, { params: { a, b } }).then(d),
  fileUrl:     id           => `${B}/imports/${id}/file`,

  reconRun:    body         => axios.post(`${B}/recon/run`, body, { timeout: 600000 }).then(d),
  summary:     params       => axios.get(`${B}/recon/summary`, { params: clean(params) }).then(d),
  rows:        params       => axios.get(`${B}/recon/rows`, { params: clean(params) }).then(d),
  row:         key          => axios.get(`${B}/recon/row`, { params: { key } }).then(d),
  vendors:     params       => axios.get(`${B}/recon/vendors`, { params: clean(params) }).then(d),
  bridge:      params       => axios.get(`${B}/recon/bridge`, { params: clean(params) }).then(d),
  options:     params       => axios.get(`${B}/recon/options`, { params: clean(params) }).then(d),
  link:        body         => axios.post(`${B}/recon/link`, body, { timeout: 120000 }).then(d),
  unlink:      body         => axios.post(`${B}/recon/unlink`, body, { timeout: 120000 }).then(d),
  approve:     body         => axios.post(`${B}/recon/approve`, body, { timeout: 120000 }).then(d),
  exclude:     body         => axios.post(`${B}/recon/exclude`, body, { timeout: 120000 }).then(d),
  assign:      body         => axios.post(`${B}/recon/assign`, body).then(d),
  note:        body         => axios.post(`${B}/recon/note`, body).then(d),
  exportXlsx:  params       => download(`${B}/export/xlsx`, params, 'GSTR2B_Reco.xlsx'),

  coverage:    company      => axios.get(`${B}/coverage`, { params: { company } }).then(d),
  audit:       month        => axios.get(`${B}/audit`, { params: { month } }).then(d),
  auditVerify: ()           => axios.get(`${B}/audit/verify`).then(d),
  itc:         ()           => axios.get(`${B}/itc`).then(d),
  demoLoad:    ()           => axios.post(`${B}/demo/load`, {}, { timeout: 300000 }).then(d),
  demoRemove:  ()           => axios.post(`${B}/demo/remove`, {}, { timeout: 120000 }).then(d),
};
