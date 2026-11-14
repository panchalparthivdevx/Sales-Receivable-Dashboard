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
  // downloads go through axios so the login header is sent
  download:     async (path, params, filename) => {
    const r = await axios.get(`${B}${path}`, { params: q(params), responseType: 'blob', timeout: 120000 });
    const url = URL.createObjectURL(r.data);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};

export const errText = e => e?.response?.data?.error || e?.message || 'Request failed';
