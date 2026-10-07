import axios from 'axios';

const BASE = `/api`;

// 2-minute browser timeout — some endpoints (occupancy, forex) legitimately take
// 60–90 seconds on cold cache because they fetch many Zoho invoice details.
axios.defaults.timeout = 120000;

// An out-of-date server answers unknown /api routes with the app's HTML page instead of JSON
const rptJson = r => {
  if (!r.data || typeof r.data !== 'object') throw new Error('The dashboard server is running an older version — restart it to use Ledger Mapping.');
  return r.data;
};

export const api = {
  // ── Sales & Receivables ──────────────────────────────────────────────────────
  avgDelay:           () => axios.get(`${BASE}/kpi/avg-payment-delay`).then(r => r.data),
  invoiceCount:       () => axios.get(`${BASE}/kpi/invoice-count`).then(r => r.data),
  revenue:            () => axios.get(`${BASE}/kpi/revenue`).then(r => r.data),
  receivables:        () => axios.get(`${BASE}/kpi/receivables`).then(r => r.data),
  revenueByCategory:  () => axios.get(`${BASE}/charts/revenue-by-category`).then(r => r.data),
  revenueByTier:      () => axios.get(`${BASE}/charts/revenue-by-tier`).then(r => r.data),
  revenueByCity:      () => axios.get(`${BASE}/charts/revenue-by-city`).then(r => r.data),
  branchOutstanding:  () => axios.get(`${BASE}/charts/branch-outstanding`).then(r => r.data),
  topClients:         () => axios.get(`${BASE}/charts/top-clients`).then(r => r.data),
  collections:        () => axios.get(`${BASE}/kpi/collections`).then(r => r.data),
  escrowReport:            () => axios.get(`${BASE}/escrow/report`).then(r => r.data),
  escrowReceivablesDetail: (acctNo) => axios.get(`${BASE}/escrow/receivables-detail?acctNo=${encodeURIComponent(acctNo)}`).then(r => r.data),
  escrowFundDetail:        (acctNo) => axios.get(`${BASE}/escrow/fund-detail?acctNo=${encodeURIComponent(acctNo)}`).then(r => r.data),
  escrowClientsByBranch:   () => axios.get(`${BASE}/escrow/clients-by-branch`).then(r => r.data),
  escrowClientMapping:     () => axios.get(`${BASE}/escrow/client-mapping`).then(r => r.data),
  escrowSaveMapping:       (mapping) => axios.post(`${BASE}/escrow/client-mapping`, { mapping }).then(r => r.data),
  arRatios:           () => axios.get(`${BASE}/kpi/ar-ratios`).then(r => r.data),
  clientPaymentDelay: () => axios.get(`${BASE}/charts/client-payment-delay`).then(r => r.data),
  occupancy:          () => axios.get(`${BASE}/kpi/occupancy`).then(r => r.data),
  arAging:            () => axios.get(`${BASE}/kpi/ar-aging`).then(r => r.data),

  // ── Agreements ───────────────────────────────────────────────────────────────
  agreementStructure:  () => axios.get(`${BASE}/agreements/structure`).then(r => r.data),
  agreementData:       () => axios.get(`${BASE}/agreements/data`).then(r => r.data),
  agreementSave:       (payload) => axios.post(`${BASE}/agreements/save`, payload).then(r => r.data),
  agreementExpiry:     () => axios.get(`${BASE}/agreements/expiry`).then(r => r.data),
  agreementExtract:    () => axios.get(`${BASE}/agreements/extract`).then(r => r.data),
  agreementOcrExtract: () => axios.get(`${BASE}/agreements/ocr-extract`).then(r => r.data),
  agreementOcrStatus:  () => axios.get(`${BASE}/agreements/ocr-status`).then(r => r.data),

  // ── Purchase & Payables ───────────────────────────────────────────────────────
  purAvgDelay:         () => axios.get(`${BASE}/purchase/kpi/avg-payment-delay`).then(r => r.data),
  purBillCount:        () => axios.get(`${BASE}/purchase/kpi/bill-count`).then(r => r.data),
  purExpense:          () => axios.get(`${BASE}/purchase/kpi/expense`).then(r => r.data),
  purPayments:         () => axios.get(`${BASE}/purchase/kpi/payments`).then(r => r.data),
  purPayables:         () => axios.get(`${BASE}/purchase/kpi/payables`).then(r => r.data),
  purExpenseByCategory:() => axios.get(`${BASE}/purchase/charts/expense-by-category`).then(r => r.data),
  purExpenseByBranch:  () => axios.get(`${BASE}/purchase/charts/expense-by-branch`).then(r => r.data),
  purTopVendors:       () => axios.get(`${BASE}/purchase/charts/top-vendors`).then(r => r.data),
  purApAging:          () => axios.get(`${BASE}/purchase/kpi/ap-aging`).then(r => r.data),
  purRentMonthwise:         (fy) => axios.get(`${BASE}/purchase/charts/rent-monthwise${fy ? `?fy=${fy}` : ''}`, { timeout: 600000 }).then(r => r.data),
  purRecurExpenseReport:    (fy) => axios.get(`${BASE}/purchase/charts/recurring-expense-report${fy ? `?fy=${fy}` : ''}`, { timeout: 300000 }).then(r => r.data),
  purVendorCategoryReport: ()  => axios.get(`${BASE}/purchase/charts/vendor-category-report`).then(r => r.data),
  purPOReport:             ()  => axios.get(`${BASE}/purchase/po-report`).then(r => r.data),
  purMSMEReport:           ()  => axios.get(`${BASE}/purchase/msme-report`).then(r => r.data),
  purMSMEVendors:          ()  => axios.get(`${BASE}/purchase/msme-vendors`).then(r => r.data),
  purMSMESyncStatus:       ()  => axios.get(`${BASE}/purchase/msme-vendors/sync-status`).then(r => r.data),
  purMSMESync:             ()  => axios.post(`${BASE}/purchase/msme-vendors/sync`, {}, { timeout: 600000 }).then(r => r.data),

  // ── Payroll Dashboard (password-gated) ───────────────────────────────────────
  payrollAuth: (password) => axios.post(`${BASE}/payroll/auth`, { password }).then(r => r.data),
  payrollData: (token)    => axios.get(`${BASE}/payroll/data`, { headers: { 'x-payroll-token': token }, timeout: 60000 }).then(r => r.data),

  // ── GST — 180-Day ITC Monitoring Report ──────────────────────────────────────
  gst180Report: ()     => axios.get(`${BASE}/gst/180-report`, { timeout: 60000 }).then(r => r.data),
  gst180Export: (body) => axios.post(`${BASE}/gst/export`, body, { responseType: 'blob', timeout: 60000 }),

  // ── MSME Form-1 Report ───────────────────────────────────────────────────────
  msmeF1HalfYear:  (fy, half, refresh = false)  => axios.get(`${BASE}/msme-form1/half-year`, { params: { fy, half, ...(refresh ? { refresh: 1 } : {}) }, timeout: 300000 }).then(r => r.data),
  msmeF1SetReason: (body)      => axios.put(`${BASE}/msme-form1/reason`, body).then(r => r.data),
  msmeF1Freeze:    (body)      => axios.post(`${BASE}/msme-form1/freeze`, body).then(r => r.data),
  msmeF1Unfreeze:  (body)      => axios.post(`${BASE}/msme-form1/unfreeze`, body).then(r => r.data),
  msmeF1Audit:     ()          => axios.get(`${BASE}/msme-form1/audit`).then(r => r.data),
  msmeF1Export:    (body)      => axios.post(`${BASE}/msme-form1/export`, body, { responseType: 'blob', timeout: 60000 }),
  msmeF1RecheckVendor: (body)  => axios.post(`${BASE}/msme-form1/recheck-vendor`, body, { timeout: 600000 }).then(r => r.data),
  msmeF1Reconcile: (fy, half, live = false) => axios.get(`${BASE}/msme-form1/reconcile`, { params: { fy, half, ...(live ? { live: 1 } : {}) }, timeout: 600000 }).then(r => r.data),

  // ── MSME Interest Report ──────────────────────────────────────────────────────
  msmeIRSettings:      ()          => axios.get(`${BASE}/msme-interest/settings`).then(r => r.data),
  msmeIRSetSettings:   (data)      => axios.put(`${BASE}/msme-interest/settings`, data).then(r => r.data),
  msmeIRVendorMaster:  ()          => axios.get(`${BASE}/msme-interest/vendor-master`).then(r => r.data),
  msmeIRSetVendorAct:  (vid, data) => axios.put(`${BASE}/msme-interest/vendor-master/${vid}`, data).then(r => r.data),
  msmeIRQuarter:       (fy, q)     => axios.get(`${BASE}/msme-interest/quarter`, { params: { fy, q }, timeout: 120000 }).then(r => r.data),
  msmeIRFreeze:        (body)      => axios.post(`${BASE}/msme-interest/freeze`, body).then(r => r.data),
  msmeIRUnfreeze:      (body)      => axios.post(`${BASE}/msme-interest/unfreeze`, body).then(r => r.data),
  msmeIRAudit:         ()          => axios.get(`${BASE}/msme-interest/audit`).then(r => r.data),
  msmeIRExport:        (body)      => axios.post(`${BASE}/msme-interest/export`, body, { responseType: 'blob', timeout: 60000 }),

  // ── Foreign Exchange ─────────────────────────────────────────────────────────
  forexLive:           () => axios.get(`${BASE}/forex/live`).then(r => r.data),
  topCustomerRevenue:  () => axios.get(`${BASE}/kpi/top-customer-revenue`).then(r => r.data),
  operationalData:     () => axios.get(`${BASE}/kpi/operational-data`).then(r => r.data),
  compliancePayroll:   () => axios.get(`${BASE}/compliance/payroll`).then(r => r.data),
  loanData:            () => axios.get(`${BASE}/loans/data`).then(r => r.data),
  purVendorCreditsAging:     () => axios.get(`${BASE}/purchase/vendor-credits-aging`, { timeout: 120000 }).then(r => r.data),
  purBillsMissingAttachment: () => axios.get(`${BASE}/purchase/bills-missing-attachment`).then(r => r.data),

  // ── Related Party Transactions ───────────────────────────────────────────────
  rptParties:  () => axios.get(`${BASE}/rpt/parties`).then(r => r.data),
  rptSales:    (fy) => axios.get(`${BASE}/rpt/sales?fy=${fy}`).then(r => r.data),
  rptPurchase: (fy) => axios.get(`${BASE}/rpt/purchase?fy=${fy}`).then(r => r.data),
  rptLoans:    (fy, refresh) => axios.get(`${BASE}/rpt/loans?fy=${fy}${refresh ? '&refresh=1' : ''}`).then(rptJson),
  rptLoansSave:(payload) => axios.post(`${BASE}/rpt/loans`, payload).then(r => r.data),
  rptMapping:          ()                => axios.get(`${BASE}/rpt/mapping`).then(rptJson),
  rptMappingOptions:   (source, refresh) => axios.get(`${BASE}/rpt/mapping/options?source=${source}${refresh ? '&refresh=1' : ''}`, { timeout: 180000 }).then(rptJson),
  rptMappingUnmapped:  ()                => axios.get(`${BASE}/rpt/mapping/unmapped`, { timeout: 180000 }).then(rptJson),
  rptMappingSave:      (rows)            => axios.post(`${BASE}/rpt/mapping`, { rows }).then(rptJson),
  rptMappingDelete:    (id)              => axios.delete(`${BASE}/rpt/mapping/${id}`).then(rptJson),
  rptMappingIgnore:    (payload)         => axios.post(`${BASE}/rpt/mapping/ignore`, payload).then(rptJson),

  // ── Vendor Registration ──────────────────────────────────────────────────────
  vendorRegistrationList:    ()             => axios.get(`${BASE}/vendor-registrations`).then(r => r.data),
  vendorRegistrationDetail:  (id)           => axios.get(`${BASE}/vendor-registrations/${id}`).then(r => r.data),
  vendorRegistrationLegal:   (id, action, note, reviewedBy) =>
    axios.patch(`${BASE}/vendor-registrations/${id}/legal`,   { action, note, reviewedBy }).then(r => r.data),
  vendorRegistrationAccounts:(id, action, note, reviewedBy, existingZohoContactId) =>
    axios.patch(`${BASE}/vendor-registrations/${id}/accounts`, { action, note, reviewedBy, existingZohoContactId }).then(r => r.data),
  vendorZohoSearch: (q) => axios.get(`${BASE}/vendor-registrations/zoho-search`, { params: { q } }).then(r => r.data),
  vendorRegistrationRetryZoho: (id, zohoContactId) =>
    axios.post(`${BASE}/vendor-registrations/${id}/zoho-retry`, { zohoContactId }).then(r => r.data),

  // ── TDS Payable Dashboard ────────────────────────────────────────────────────
  tdsPayableMonthly:  (month) => axios.get(`${BASE}/tds-payable/monthly${month ? `?month=${month}` : ''}`).then(r => r.data),
  tdsPayableDiscover: (month) => axios.get(`${BASE}/tds-payable/discover${month ? `?month=${month}` : ''}`).then(r => r.data),
  tdsPayableSections: ()      => axios.get(`${BASE}/tds-payable/sections`).then(r => r.data),
  tdsPayableBSDebug:  (month) => axios.get(`${BASE}/tds-payable/bs-debug${month ? `?month=${month}` : ''}`).then(r => r.data),

  // ── POCM Dashboard ───────────────────────────────────────────────────────────
  pocmProjects:        ()        => axios.get(`${BASE}/pocm/projects`).then(r => r.data),
  pocmSaveProject:     (proj)    => axios.post(`${BASE}/pocm/projects`, proj).then(r => r.data),
  pocmDeleteProject:   (id)      => axios.delete(`${BASE}/pocm/projects/${id}`).then(r => r.data),
  pocmAccounts:        ()        => axios.get(`${BASE}/pocm/accounts`).then(r => r.data),
  pocmMapping:         ()        => axios.get(`${BASE}/pocm/mapping`).then(r => r.data),
  pocmSaveMapping:     (m)       => axios.post(`${BASE}/pocm/mapping`, m).then(r => r.data),
  pocmZohoProjects:    ()        => axios.get(`${BASE}/pocm/zoho-projects`).then(r => r.data),
  pocmMonthlyExpenses: (f, t, p) => axios.get(`${BASE}/pocm/monthly-expenses?fromDate=${f}&toDate=${t}${p ? `&zohoProjectName=${encodeURIComponent(p)}` : ''}`, { timeout: 600000 }).then(r => r.data),
  pocmMonthlyRevenue:  (f, t, p, c) => axios.get(`${BASE}/pocm/monthly-revenue?fromDate=${f}&toDate=${t}&zohoProjectName=${encodeURIComponent(p)}${c ? `&customerName=${encodeURIComponent(c)}` : ''}`, { timeout: 600000 }).then(r => r.data),
  pocmMonthlyOverhead: (f, t)    => axios.get(`${BASE}/pocm/monthly-overhead?fromDate=${f}&toDate=${t}`, { timeout: 600000 }).then(r => r.data),
  pocmBillsTranche:    (f, batchSize = 40) => axios.get(`${BASE}/pocm/bills-tranche?fromDate=${f}&batchSize=${batchSize}`, { timeout: 120000 }).then(r => r.data),
  pocmQuarterlyEstimates:     ()     => axios.get(`${BASE}/pocm/quarterly-estimates`).then(r => r.data),
  pocmSaveQuarterlyEstimate:  (body) => axios.post(`${BASE}/pocm/quarterly-estimates`, body).then(r => r.data),
  pocmQuarterlyEstimatesAudit:(projectId) => axios.get(`${BASE}/pocm/quarterly-estimates/audit${projectId ? `?projectId=${projectId}` : ''}`).then(r => r.data),
  pocmRptPurchaseOrders:  (status, f, t) => axios.get(`${BASE}/pocm/reports/purchase-orders?status=${status}&fromDate=${f}&toDate=${t}`, { timeout: 60000 }).then(r => r.data),
  pocmRptVendorPayments:  (f, t)         => axios.get(`${BASE}/pocm/reports/vendor-payments?fromDate=${f}&toDate=${t}`, { timeout: 60000 }).then(r => r.data),
  pocmRptOutstandingBills:(f, t)         => axios.get(`${BASE}/pocm/reports/outstanding-bills?fromDate=${f}&toDate=${t}`, { timeout: 60000 }).then(r => r.data),
  pocmRptClientInvoices:  (f, t)         => axios.get(`${BASE}/pocm/reports/client-invoices?fromDate=${f}&toDate=${t}`, { timeout: 60000 }).then(r => r.data),
  pocmRptDraftInvoices:   ()             => axios.get(`${BASE}/pocm/reports/draft-invoices`, { timeout: 60000 }).then(r => r.data),
  pocmRptProjectPL:       (asOnDate, ids) => axios.get(`${BASE}/pocm/reports/project-pl?asOnDate=${asOnDate}${ids ? `&projectIds=${encodeURIComponent(ids)}` : ''}`, { timeout: 300000 }).then(r => r.data),
  pocmRptProjectUtilisation:   (asOnDate, projectId) => axios.get(`${BASE}/pocm/reports/project-utilisation?asOnDate=${asOnDate}&projectId=${encodeURIComponent(projectId)}`, { timeout: 60000 }).then(r => r.data),
  pocmRptUtilisationExceptions:(asOnDate) => axios.get(`${BASE}/pocm/reports/utilisation-exceptions?asOnDate=${asOnDate}`, { timeout: 60000 }).then(r => r.data),
  pocmSyncNow:            (opts = {})    => axios.post(`${BASE}/pocm/sync/now`, opts, { timeout: 120000 }).then(r => r.data),
  pocmSyncFull:           (opts = {})    => axios.post(`${BASE}/pocm/sync/full`, opts, { timeout: 300000 }).then(r => r.data),
  pocmSyncStatus:         ()             => axios.get(`${BASE}/pocm/sync/status`).then(r => r.data),

  // ── Activity Tracker ─────────────────────────────────────────────────────────
  activitySummary: (from, to) => axios.get(`${BASE}/activity-tracker/summary?from=${from}&to=${to}`, { timeout: 180000 }).then(r => r.data),

  // ── Financial Statements ─────────────────────────────────────────────────────
  finCoa:         (filter) => axios.get(`${BASE}/financials/chart-of-accounts?filter=${filter||'all'}`, { timeout: 60000 }).then(r => r.data),
  finMappings:    ()       => axios.get(`${BASE}/financials/mappings`).then(r => r.data),
  finSaveMappings:(data)   => axios.post(`${BASE}/financials/mappings`, data).then(r => r.data),
  finPlData:      ()       => axios.get(`${BASE}/financials/pl-data`).then(r => r.data),
  finSavePlData:  (data)   => axios.post(`${BASE}/financials/pl-data`, data).then(r => r.data),
  finFetchZoho:   (periods)=> axios.post(`${BASE}/financials/fetch-from-zoho`, { periods }, { timeout: 600000 }).then(r => r.data),
  finBsData:      ()       => axios.get(`${BASE}/financials/bs-data`).then(r => r.data),
  finSaveBsData:  (data)   => axios.post(`${BASE}/financials/bs-data`, data).then(r => r.data),
  finTbDrill:     (sheet, groupings) => axios.get(`${BASE}/financials/tb-drill?sheet=${sheet}&groupings=${encodeURIComponent(groupings.join('|||'))}`).then(r => r.data),

  // ── Finance Portal ────────────────────────────────────────────────────────────
  portalSubmit:  (fd)       => axios.post(`${BASE}/portal/submit`, fd, { timeout: 60000 }).then(r => r.data),
  portalList:    (params)   => axios.get(`${BASE}/portal/submissions`, { params }).then(r => r.data),
  portalUpdate:  (id, data) => axios.patch(`${BASE}/portal/submissions/${id}`, data).then(r => r.data),
  portalPending: ()         => axios.get(`${BASE}/portal/pending-count`).then(r => r.data),
  portalVendors: (q)        => axios.get(`${BASE}/portal/zoho/vendors${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(r => r.data),
  portalPOs:     (vid)      => axios.get(`${BASE}/portal/zoho/purchase-orders?vendor_id=${vid}`).then(r => r.data),
  portalBills:   (vid)      => axios.get(`${BASE}/portal/zoho/bills?vendor_id=${vid}`).then(r => r.data),

  // ── Finance Overview ─────────────────────────────────────────────────────────
  financeBranches: ()              => axios.get(`${BASE}/finance/branches`).then(r => r.data),
  financeOverview: (branches = []) => axios.get(`${BASE}/finance/overview${branches.length ? `?branches=${encodeURIComponent(branches.join(','))}` : ''}`).then(r => r.data),

  // ── Branch P&L Report ────────────────────────────────────────────────────────
  plMapping:      ()         => axios.get(`${BASE}/pl/mapping`).then(r => r.data),
  plSaveMapping:  (data)     => axios.post(`${BASE}/pl/mapping`, data).then(r => r.data),
  plCapacity:     ()         => axios.get(`${BASE}/pl/branch-capacity`).then(r => r.data),
  plSaveCapacity: (data)     => axios.post(`${BASE}/pl/branch-capacity`, data).then(r => r.data),
  plCoa:          ()         => axios.get(`${BASE}/pl/coa`, { timeout: 60000 }).then(r => r.data),
  plReport:       (params)   => axios.get(`${BASE}/pl/report`,       { params, timeout: 30000 }).then(r => r.data),
  plDrill:        (params)   => axios.get(`${BASE}/pl/report/drill`, { params, timeout: 30000 }).then(r => r.data),
  plBillsSummary:    ()         => axios.get(`${BASE}/pl/bills-summary`).then(r => r.data),
  plSync:            (fy)       => axios.post(`${BASE}/pl/sync?fy=${encodeURIComponent(fy)}`).then(r => r.data),
  plSyncStatus:      (fy)       => axios.get(`${BASE}/pl/sync/status${fy ? `?fy=${encodeURIComponent(fy)}` : ''}`).then(r => r.data),
  plPrefetch:        (fy)       => axios.post(`${BASE}/pl/prefetch?fy=${encodeURIComponent(fy||'')}`).then(r => r.data),
  plPrefetchStatus:  (fy)       => axios.get(`${BASE}/pl/prefetch/status?fy=${encodeURIComponent(fy||'')}`).then(r => r.data),
  plCompare:         (params)   => axios.get(`${BASE}/pl/compare`, { params, timeout: 30000 }).then(r => r.data),
  plDebugAcct:       (params)   => axios.get(`${BASE}/pl/debug-acct`, { params }).then(r => r.data),

  // ── Shared ───────────────────────────────────────────────────────────────────
  clearCache: () => axios.post(`${BASE}/cache/clear`).then(r => r.data),

  // ── Sync Monitor (admin only) ─────────────────────────────────────────────────
  syncStatus:    ()         => axios.get(`${BASE}/admin/sync/status`).then(r => r.data),
  syncNow:       (entity)   => axios.post(`${BASE}/admin/sync/now`, entity ? { entity } : {}).then(r => r.data),
  syncFullResync:()         => axios.post(`${BASE}/admin/sync/full-resync`).then(r => r.data),
  syncLog:       ()         => axios.get(`${BASE}/admin/sync/log`).then(r => r.data),
  syncRun:       (mode, entity, confirm) => axios.post(`${BASE}/admin/sync/run`, { mode, ...(entity ? { entity } : {}), ...(confirm ? { confirm: true } : {}) }).then(r => r.data),
  syncRetry:     (entity)   => axios.post(`${BASE}/admin/sync/retry`, { entity }).then(r => r.data),
  syncProgress:  ()         => axios.get(`${BASE}/admin/sync/progress`).then(r => r.data),
  syncFreshness: ()         => axios.get(`${BASE}/sync/freshness`).then(r => r.data),
};

// Generic authenticated fetch helper used by the FP&A module.
// Uses the same da_token as the axios interceptor.
const SERVER = ``;
export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('da_token');
  const res = await fetch(`${SERVER}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// Plain <a href> file links can't send the Authorization header, so the login
// token rides in the query string (the server accepts it only on …/file/… GETs).
export function withToken(url) {
  const token = localStorage.getItem('da_token') || '';
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
