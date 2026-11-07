import axios from 'axios';
import { withToken } from '../../utils/api';

// Bill Collection & Booking — server routes in server/bill-booking/index.js
const B = '/api/bill-booking';
const d = r => {
  if (!r.data || typeof r.data !== 'object') throw new Error('The dashboard server is running an older version — restart it to use Bill Collection & Booking.');
  return r.data;
};
export const errMsg = e => e?.response?.data?.error || e?.message || 'Something went wrong';

export const bb = {
  meta:          ()              => axios.get(`${B}/meta`).then(d),
  bills:         (params)        => axios.get(`${B}/bills`, { params }).then(d),
  bill:          (id)            => axios.get(`${B}/bills/${id}`).then(d),
  fileUrl:       (id, download)  => withToken(`${B}/file/${id}${download ? '?download=1' : ''}`),
  lookups:       (company)       => axios.get(`${B}/lookups`, { params: { company } }).then(d),
  vendors:       (company, q)    => axios.get(`${B}/vendors`, { params: { company, q } }).then(d),
  edit:          (id, changes)   => axios.put(`${B}/bills/${id}`, changes, { timeout: 180000 }).then(d),
  action:        (id, action, extra = {}) => axios.post(`${B}/bills/${id}/action`, { action, ...extra }, { timeout: 300000 }).then(d),
  draft:         (id)            => axios.post(`${B}/bills/${id}/draft`, {}, { timeout: 180000 }).then(d),
  refreshZoho:   (ids)           => axios.post(`${B}/zoho/refresh`, { ids }, { timeout: 300000 }).then(d),
  upload:        (form, onProgress) => axios.post(`${B}/upload`, form, { timeout: 600000, onUploadProgress: onProgress }).then(d),

  saveCategories: (categories)   => axios.put(`${B}/config/categories`, { categories }).then(d),
  saveCompanies:  (companies)    => axios.put(`${B}/config/companies`, { companies }).then(d),
  saveSettings:   (settings)     => axios.put(`${B}/config/settings`, settings).then(d),
  addMember:      (m)            => axios.post(`${B}/config/team`, m).then(d),
  saveMember:     (id, m)        => axios.put(`${B}/config/team/${id}`, m).then(d),
  removeMember:   (id)           => axios.delete(`${B}/config/team/${id}`).then(d),
  connect:        (id)           => axios.post(`${B}/config/team/${id}/connect`).then(d),
  disconnect:     (id)           => axios.post(`${B}/config/team/${id}/disconnect`).then(d),

  poll:           (member_id)    => axios.post(`${B}/mail/poll`, { member_id }, { timeout: 600000 }).then(d),
  mailLog:        ()             => axios.get(`${B}/mail/log`).then(d),
  processSkipped: (key)          => axios.post(`${B}/mail/skipped/process`, { key }, { timeout: 300000 }).then(d),

  mappings:       ()             => axios.get(`${B}/mappings`).then(d),
  saveMapping:    (id, m)        => axios.put(`${B}/mappings/${id}`, m).then(d),
  removeMapping:  (id)           => axios.delete(`${B}/mappings/${id}`).then(d),

  zohoCheck:      (company)      => axios.post(`${B}/zoho/check`, { company }, { timeout: 180000 }).then(d),
  draftTest:      (body)         => axios.post(`${B}/zoho/draft-test`, body, { timeout: 180000 }).then(d),
  audit:          (month)        => axios.get(`${B}/audit`, { params: { month } }).then(d),
};
