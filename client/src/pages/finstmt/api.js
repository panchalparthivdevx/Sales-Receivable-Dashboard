import axios from 'axios';

// Financial Reporting API (server/fin-reporting). Every call carries the shared filters it needs.
const B = '/api/fin-reporting';
const q = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const fsApi = {
  status:       ()            => axios.get(`${B}/status`).then(r => r.data),
  importFolder: ()            => axios.post(`${B}/import/folder`, {}, { timeout: 300000 }).then(r => r.data),
  importUpload: (file)        => { const f = new FormData(); f.append('file', file); return axios.post(`${B}/import/upload`, f, { timeout: 300000 }).then(r => r.data); },
  unstage:      (sha)         => axios.delete(`${B}/import/staging/${sha}`).then(r => r.data),
  commit:       ()            => axios.post(`${B}/import/commit`, {}, { timeout: 300000 }).then(r => r.data),
  rollback:     (versionId, reason) => axios.post(`${B}/import/rollback`, { versionId, reason }).then(r => r.data),
  periods:      (basis, mode) => axios.get(`${B}/periods`, { params: q({ basis, mode }) }).then(r => r.data),
  statement:    (p)           => axios.get(`${B}/statement`, { params: q(p) }).then(r => r.data),
  notes:        (p)           => axios.get(`${B}/notes`, { params: q(p) }).then(r => r.data),
  recon:        (mode)        => axios.get(`${B}/recon`, { params: q({ mode }), timeout: 120000 }).then(r => r.data),
  decide:       (body)        => axios.post(`${B}/decisions`, body).then(r => r.data),
  undecide:     (key)         => axios.delete(`${B}/decisions/${encodeURIComponent(key)}`).then(r => r.data),
  adjustments:  ()            => axios.get(`${B}/adjustments`).then(r => r.data),
  addAdjustment:(body)        => axios.post(`${B}/adjustments`, body).then(r => r.data),
  reverseAdj:   (id, reason)  => axios.post(`${B}/adjustments/${id}/reverse`, { reason }).then(r => r.data),
  audit:        ()            => axios.get(`${B}/audit`).then(r => r.data),
  compare:      (p)           => axios.get(`${B}/compare`, { params: q(p) }).then(r => r.data),
  presets:      (basis, mode) => axios.get(`${B}/compare/presets`, { params: q({ basis, mode }) }).then(r => r.data),
  threeYear:    (p)           => axios.get(`${B}/compare/three-year`, { params: q(p) }).then(r => r.data),
  ratios:       (p)           => axios.get(`${B}/ratios`, { params: q(p) }).then(r => r.data),
  dictionary:   ()            => axios.get(`${B}/ratios/dictionary`).then(r => r.data),
  cfo:          (p)           => axios.get(`${B}/cfo`, { params: q(p) }).then(r => r.data),
  inputs:       ()            => axios.get(`${B}/inputs`).then(r => r.data),
  saveInput:    (body)        => axios.post(`${B}/inputs/record`, body).then(r => r.data),
  deleteInput:  (id)          => axios.delete(`${B}/inputs/record/${id}`).then(r => r.data),
  saveSettings: (body)        => axios.put(`${B}/inputs/settings`, body).then(r => r.data),
  uploadInputs: (type, file)  => { const f = new FormData(); f.append('file', file); return axios.post(`${B}/inputs/upload/${type}`, f).then(r => r.data); },
  // planning (Data Validation → Budget, Branch master, Collections & payments forecast, Debt & covenants)
  budgetVersions: ()          => axios.get(`${B}/budget/versions`).then(r => r.data),
  addBudget:    (body)        => axios.post(`${B}/budget/versions`, body).then(r => r.data),
  saveBudget:   (id, body)    => axios.put(`${B}/budget/versions/${id}`, body).then(r => r.data),
  deleteBudget: (id)          => axios.delete(`${B}/budget/versions/${id}`).then(r => r.data),
  freezeBudget: (id, unfreeze) => axios.post(`${B}/budget/versions/${id}/freeze`, { unfreeze }).then(r => r.data),
  budget:       (version, live) => axios.get(`${B}/budget/compute`, { params: q({ version, live: live ? 1 : null }), timeout: 180000 }).then(r => r.data),
  budgetCell:   (body)        => axios.post(`${B}/budget/override`, body).then(r => r.data),
  budgetLine:   (body)        => axios.post(`${B}/budget/manual`, body).then(r => r.data),
  deleteBudgetLine: (id)      => axios.delete(`${B}/budget/manual/${id}`).then(r => r.data),
  budgetVsActual: (p)         => axios.get(`${B}/budget/vs-actual`, { params: q(p), timeout: 180000 }).then(r => r.data),
  budgetHistory: (base)       => axios.get(`${B}/budget/history`, { params: q({ base }) }).then(r => r.data),
  fetchHistory: (fy)          => axios.post(`${B}/budget/history/fetch`, { fy }).then(r => r.data),
  clients:      ()            => axios.get(`${B}/budget/clients`, { timeout: 120000 }).then(r => r.data),
  saveClients:  (items)       => axios.post(`${B}/budget/clients`, { items }).then(r => r.data),
  deleteClient: (id)          => axios.delete(`${B}/budget/clients/${id}`).then(r => r.data),
  uploadClients: (file)       => { const f = new FormData(); f.append('file', file); return axios.post(`${B}/budget/clients/upload`, f).then(r => r.data); },
  rent:         ()            => axios.get(`${B}/budget/rent`).then(r => r.data),
  saveRent:     (items)       => axios.post(`${B}/budget/rent/override`, { items }).then(r => r.data),
  deleteRent:   (key)         => axios.delete(`${B}/budget/rent/override`, { params: { key } }).then(r => r.data),
  uploadRent:   (file)        => { const f = new FormData(); f.append('file', file); return axios.post(`${B}/budget/rent/upload`, f).then(r => r.data); },
  branches:     ()            => axios.get(`${B}/branches`).then(r => r.data),
  saveBranches: (items, draft) => axios.post(`${B}/branches`, { items, draft }).then(r => r.data),
  deleteBranch: (id)          => axios.delete(`${B}/branches/${id}`).then(r => r.data),
  uploadBranches: (file)      => { const f = new FormData(); f.append('file', file); return axios.post(`${B}/branches/upload`, f).then(r => r.data); },
  debt:         ()            => axios.get(`${B}/debt`).then(r => r.data),
  saveFacility: (body)        => axios.post(`${B}/debt/facility`, body).then(r => r.data),
  deleteFacility: (id)        => axios.delete(`${B}/debt/facility/${id}`).then(r => r.data),
  generateSchedule: (id)      => axios.post(`${B}/debt/facility/${id}/generate`).then(r => r.data),
  saveSchedule: (id, rows)    => axios.put(`${B}/debt/schedule/${id}`, { rows }).then(r => r.data),
  saveCovenant: (body)        => axios.post(`${B}/debt/covenant`, body).then(r => r.data),
  deleteCovenant: (id)        => axios.delete(`${B}/debt/covenant/${id}`).then(r => r.data),
  saveTest:     (body)        => axios.post(`${B}/debt/test`, body).then(r => r.data),
  uploadDebt:   (file, mode)  => { const f = new FormData(); f.append('file', file); return axios.post(`${B}/debt/upload`, f, { params: { mode } }).then(r => r.data); },
  importLoans:  ()            => axios.post(`${B}/debt/import-loans`).then(r => r.data),
  forecast:     (version, months) => axios.get(`${B}/forecast`, { params: q({ version, months }), timeout: 180000 }).then(r => r.data),
  forecastSettings: (body)    => axios.put(`${B}/forecast/settings`, body).then(r => r.data),
  forecastLine: (body)        => axios.post(`${B}/forecast/manual`, body).then(r => r.data),
  deleteForecastLine: (id)    => axios.delete(`${B}/forecast/manual/${id}`).then(r => r.data),
  // downloads go through axios so the login header is sent
  download:     async (path, params, filename) => {
    const r = await axios.get(`${B}${path}`, { params: q(params), responseType: 'blob', timeout: 120000 });
    const url = URL.createObjectURL(r.data);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};

export const errText = e => e?.response?.data?.error || e?.message || 'Request failed';
