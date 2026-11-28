import axios from 'axios';
import { withToken } from '../../utils/api';
import { serverErrorText } from '../../utils/serverError';

// Management Cash Flow — server routes in server/cashflow/index.js
const B = '/api/cashflow';
const d = r => {
  if (!r.data || typeof r.data !== 'object') throw new Error('The dashboard server is running an older version — restart it to use Management Cash Flow.');
  return r.data;
};
export const errMsg = e => serverErrorText(e);

export const cf = {
  meta:        ()                 => axios.get(`${B}/meta`).then(d),
  view:        (params)           => axios.get(`${B}/view`, { params }).then(d),
  fyGrid:      (params)           => axios.get(`${B}/fy-grid`, { params }).then(d),
  budgets:     (params)           => axios.get(`${B}/budgets`, { params }).then(d),
  vendors:     (company, q)       => axios.get(`${B}/vendors`, { params: { company, q } }).then(d),
  addBudget:   (body)             => axios.post(`${B}/budgets`, body).then(d),
  saveBudget:  (id, body)         => axios.put(`${B}/budgets/${id}`, body).then(d),
  delBudget:   (id, company)      => axios.delete(`${B}/budgets/${id}`, { params: { company } }).then(d),
  copyBudgets: (body)             => axios.post(`${B}/budgets/copy`, body).then(d),
  savePart:    (key, body)        => axios.put(`${B}/parts/${key}`, body).then(d),
  addInit:     (key, body)        => axios.post(`${B}/parts/${key}/initiations`, body).then(d),
  saveInit:    (key, id, body)    => axios.put(`${B}/parts/${key}/initiations/${id}`, body).then(d),
  delInit:     (key, id, company) => axios.delete(`${B}/parts/${key}/initiations/${id}`, { params: { company } }).then(d),
  saveAdvance: (pid, body)        => axios.put(`${B}/advances/${pid}`, body).then(d),
  addSlip:     (pid, company, file) => { const f = new FormData(); f.append('company', company); f.append('file', file); return axios.post(`${B}/slips/${pid}`, f).then(d); },
  delSlip:     (pid, sha, company) => axios.delete(`${B}/slips/${pid}/${sha}`, { params: { company } }).then(d),
  slipUrl:     (company, pid, sha) => withToken(`${B}/file/${company}/${pid}/${sha}`),
  status:      ()                 => axios.get(`${B}/status`).then(d),
  refresh:     (body)             => axios.post(`${B}/refresh`, body).then(d),
  saveConfig:  (categories)       => axios.put(`${B}/config`, { categories }).then(d),
  accounts:    (company)          => axios.get(`${B}/accounts`, { params: { company } }).then(d),
  audit:       (month)            => axios.get(`${B}/audit`, { params: { month } }).then(d),
};

// ── Formatting ────────────────────────────────────────────────────────────────
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** ₹ in Indian grouping, whole rupees (tables) */
export const inr = n => {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  const v = Math.round(Number(n));
  return `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN')}`;
};
/** ₹ with paise (details) */
export const inr2 = n => (n == null || n === '' ? '—' : `${Number(n) < 0 ? '−' : ''}₹${Math.abs(Number(n)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const monthLabel = m => (m ? `${MON[Number(m.slice(5)) - 1]}-${m.slice(2, 4)}` : '—');
export const longMonth = m => (m ? `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(m.slice(5)) - 1]} ${m.slice(0, 4)}` : '');
export const dmy = s => (s ? `${s.slice(8, 10)}-${MON[Number(s.slice(5, 7)) - 1]}-${s.slice(2, 4)}` : '—');
export const fyMonths = fy => { const y = Number(fy.slice(0, 4)); return Array.from({ length: 12 }, (_, i) => { const t = y * 12 + 3 + i; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; }); };
export const fyOfMonth = m => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5)); const s = mo >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
export const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + (mo - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };

export const STATE = {
  paid:         { label: 'Paid',                  tone: 'green' },
  initiated:    { label: 'Initiated — pending',   tone: 'blue' },
  part_paid:    { label: 'Part paid',             tone: 'amber' },
  to_initiate:  { label: 'To initiate',           tone: 'grey' },
  unconfirmed:  { label: 'Initiation unconfirmed', tone: 'amber' },
  not_received: { label: 'Not received',          tone: 'grey' },
};
export const LINK_LABEL = { team: 'linked by team', auto: 'linked automatically', none: 'no budget', missing: 'budget removed' };
