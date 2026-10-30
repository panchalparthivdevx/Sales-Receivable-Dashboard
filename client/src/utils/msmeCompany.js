import { createContext, useContext } from 'react';
import { api, companyApis } from './api';

// MSME Compliance companies. DevX is the default: the existing module with its original API.
// Another company gets the same pages and server logic on its own Zoho organisation and data.
export const MSME_COMPANIES = {
  devx:   { id: 'devx',   short: 'DevX',   name: 'DevX' },
  neddle: { id: 'neddle', short: 'Neddle', name: 'Neddle And Thread Designs LLP', orgId: '60007894213' },
};

export const MsmeCompanyContext = createContext('devx');

export function useMsmeCompany() {
  return MSME_COMPANIES[useContext(MsmeCompanyContext)] || MSME_COMPANIES.devx;
}

// API for the selected company (DevX → the original `api` object, so its requests are unchanged)
export function useMsmeApi() {
  return companyApis[useContext(MsmeCompanyContext)] || api;
}
