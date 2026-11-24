import React, { useEffect, useState, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import {
  Clock, FileText, TrendingDown, DollarSign, AlertCircle,
  RefreshCw, ShoppingCart, Truck,
} from 'lucide-react';
import { api } from '../utils/api';
import DataFreshness from '../components/DataFreshness';
import { formatINR, formatNumber, formatDate } from '../utils/format';
import KPICard from '../components/KPICard';
import ChartCard from '../components/ChartCard';
import Modal from '../components/Modal';
import { useAuth } from '../contexts/AuthContext';
import POReport from './POReport';
import VendorPaymentReport from './VendorPaymentReport';

const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#84cc16', '#f97316'];

const monthLabel = () => new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' });
const fyLabel = () => {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `FY ${y}-${String(y + 1).slice(2)}`;
};

export default function PurchaseDashboard() {
  const { hasPerm } = useAuth();
  const p = (key) => hasPerm('purchase', key);

  const [loading,    setLoading]    = useState({});
  const [errors,     setErrors]     = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [data,       setData]       = useState({});
  const [modal,      setModal]      = useState(null);
  const [catToggle,  setCatToggle]  = useState('This Month');
  const [brToggle,   setBrToggle]   = useState('This Month');

  // Vendor Category report state
  const [vcData,    setVcData]    = useState(null);
  const [vcLoading, setVcLoading] = useState(false);

  // PO report state
  const [poData,    setPoData]    = useState(null);
  const [poLoading, setPoLoading] = useState(false);

  // Vendor Unused Credits Aging report
  const [vcAgingData,    setVcAgingData]    = useState(null);
  const [vcAgingLoading, setVcAgingLoading] = useState(false);
  const [vcAgingError,   setVcAgingError]   = useState(false);
  const [vcAgingCatFilter, setVcAgingCatFilter] = useState('All Categories');

  // Bills missing attachment report
  const [noAttachData,    setNoAttachData]    = useState(null);
  const [noAttachLoading, setNoAttachLoading] = useState(false);
  const [noAttachError,   setNoAttachError]   = useState(false);
  const [expandedCats,    setExpandedCats]    = useState({});

  // (The Month-wise Rent Expense Report now has its own page: RentReports.js, sidebar "Rent Reports")
  // (The Recurring Expense Report now has its own page: RecurringExpReports.js, sidebar "Recurring Exps. Reports")

  const isLoading = k => loading[k] !== false;

  const loadOne = useCallback((key, fetcher) => {
    setLoading(p => ({ ...p, [key]: true }));
    setErrors(p => ({ ...p, [key]: false }));
    fetcher()
      .then(d => setData(p => ({ ...p, [key]: d })))
      .catch(e => { console.error(key, e); setErrors(p => ({ ...p, [key]: true })); })
      .finally(() => setLoading(p => ({ ...p, [key]: false })));
  }, []);

  const loadVc = useCallback(() => {
    setVcLoading(true);
    api.purVendorCategoryReport()
      .then(d => setVcData(d))
      .catch(e => console.error('vc-report', e))
      .finally(() => setVcLoading(false));
  }, []);

  const loadPo = useCallback(() => {
    setPoLoading(true);
    api.purPOReport()
      .then(d => setPoData(d))
      .catch(e => console.error('po-report', e))
      .finally(() => setPoLoading(false));
  }, []);

  const loadVcAging = useCallback(() => {
    setVcAgingLoading(true);
    setVcAgingError(false);
    api.purVendorCreditsAging()
      .then(d => { setVcAgingData(d); setVcAgingCatFilter('All Categories'); })
      .catch(e => { console.error('vc-aging', e); setVcAgingError(true); })
      .finally(() => setVcAgingLoading(false));
  }, []);

  const loadNoAttach = useCallback(() => {
    setNoAttachLoading(true);
    setNoAttachError(false);
    api.purBillsMissingAttachment()
      .then(d => { setNoAttachData(d); setExpandedCats({}); })
      .catch(e => { console.error('bills-no-attach', e); setNoAttachError(true); })
      .finally(() => setNoAttachLoading(false));
  }, []);


  const loadAll = useCallback(async (bust = false) => {
    if (bust) { setRefreshing(true); await api.clearCache(); setRefreshing(false); }
    loadOne('delay',    api.purAvgDelay);
    loadOne('bills',    api.purBillCount);
    loadOne('expense',  api.purExpense);
    loadOne('payments', api.purPayments);
    loadOne('payables', api.purPayables);
    loadOne('cat',      api.purExpenseByCategory);
    loadOne('branch',   api.purExpenseByBranch);
    loadOne('vendors',  api.purTopVendors);
    loadOne('apAging',  api.purApAging);
    loadVc();
    loadPo();
  }, [loadOne, loadVc, loadPo]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const openModal = (title, rows, columns) => setModal({ title, rows, columns });
  const closeModal = () => setModal(null);

  // ── Column definitions ────────────────────────────────────────────────────
  const billCols = [
    { key: 'bill_number',  label: 'Bill #' },
    { key: 'vendor_name',  label: 'Vendor' },
    { key: 'date',         label: 'Date',      type: 'date' },
    { key: 'due_date',     label: 'Due Date',  type: 'date' },
    { key: 'branch_name',  label: 'Branch' },
    { key: 'account_name', label: 'Category' },
    { key: 'sub_total',    label: 'Amount (ex-tax)', type: 'currency', align: 'right' },
    { key: 'status',       label: 'Status',    type: 'status' },
  ];

  const payableCols = [
    { key: 'bill_number', label: 'Bill #' },
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'date',        label: 'Bill Date',  type: 'date' },
    { key: 'due_date',    label: 'Due Date',   type: 'date' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'balance',     label: 'Balance',    type: 'currency', align: 'right' },
    { key: 'status',      label: 'Status',     type: 'status' },
  ];

  const unusedCreditCols = [
    { key: 'vendor_credit_number', label: 'Credit Note #' },
    { key: 'vendor_name',          label: 'Vendor' },
    { key: 'branch_name',          label: 'Branch' },
    { key: 'date',                 label: 'Date',            type: 'date' },
    { key: 'balance',              label: 'Unused Balance',  type: 'currency', align: 'right' },
    { key: 'total',                label: 'Original Amount', type: 'currency', align: 'right' },
    { key: 'status',               label: 'Status',          type: 'status' },
  ];

  const paymentCols = [
    { key: 'vendor_name',      label: 'Vendor' },
    { key: 'branch_name',      label: 'Branch' },
    { key: 'payment_date',     label: 'Date',        type: 'date' },
    { key: 'payment_mode',     label: 'Mode' },
    { key: 'reference_number', label: 'Reference #' },
    { key: 'bill_numbers',     label: 'Bill(s)' },
    { key: 'amount',           label: 'Amount',      type: 'currency', align: 'right' },
  ];

  const vcCols = [
    { key: 'vendor_credit_number', label: 'Credit Note #' },
    { key: 'vendor_name',          label: 'Vendor' },
    { key: 'branch_name',          label: 'Branch' },
    { key: 'date',                 label: 'Date',           type: 'date' },
    { key: 'applied_amount',       label: 'Applied Amount', type: 'currency', align: 'right' },
    { key: 'status',               label: 'Status',         type: 'status' },
  ];

  const delayCols = [
    { key: 'bill_number',  label: 'Bill #' },
    { key: 'vendor_name',  label: 'Vendor' },
    { key: 'branch_name',  label: 'Branch' },
    { key: 'due_date',     label: 'Due Date',    type: 'date' },
    { key: 'payment_date', label: 'Paid On',     type: 'date' },
    { key: 'delay_days',   label: 'Delay (Days)', align: 'right' },
    { key: 'amount',       label: 'Amount',      type: 'currency', align: 'right' },
  ];

  const agingBillCols = [
    { key: 'bill_number',  label: 'Bill #' },
    { key: 'vendor_name',  label: 'Vendor' },
    { key: 'date',         label: 'Bill Date',    type: 'date' },
    { key: 'due_date',     label: 'Due Date',     type: 'date' },
    { key: 'branch_name',  label: 'Branch' },
    { key: 'balance',      label: 'Balance',      type: 'currency', align: 'right' },
    { key: 'overdue_days', label: 'Days Overdue', align: 'right' },
    { key: 'status',       label: 'Status',       type: 'status' },
  ];

  // ── Chart data ────────────────────────────────────────────────────────────
  const catData = data.cat
    ? (catToggle === 'This Month' ? data.cat.this_month : data.cat.all_time) || []
    : [];
  const brData = data.branch
    ? (brToggle === 'This Month' ? data.branch.this_month : data.branch.all_time) || []
    : [];

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.75rem', fontSize: '0.85rem', boxShadow: '0 2px 8px rgba(0,18,20,0.1)' }}>
        <p style={{ color: '#5D6C7B', margin: 0 }}>{label || payload[0]?.name}</p>
        <p style={{ color: '#18191B', margin: '4px 0 0', fontWeight: 600 }}>{formatINR(payload[0]?.value)}</p>
      </div>
    );
  };

  // ── AP Aging helpers ──────────────────────────────────────────────────────
  const aging = data.apAging || {};
  const agingBuckets = [
    { key: 'current', label: 'Current (Not Due)',  color: '#22c55e' },
    { key: '0-30',    label: '0–30 Days Overdue',  color: '#3b82f6' },
    { key: '31-60',   label: '31–60 Days Overdue', color: '#f59e0b' },
    { key: '61-90',   label: '61–90 Days Overdue', color: '#ef4444' },
    { key: '90+',     label: '90+ Days Overdue',   color: '#7f1d1d' },
  ];

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <h1 style={S.heading}>Purchase & Payables Dashboard</h1>
          <p style={S.subheading}>Dev Accelerator Limited · {monthLabel()}</p>
          <DataFreshness entities={['bills_fy', 'bills_open', 'bills_overdue', 'vendors_all', 'vendor_credits_all', 'vendor_payments_fy']} />
        </div>
        <button
          style={{ ...S.refreshBtn, opacity: refreshing ? 0.6 : 1 }}
          onClick={() => loadAll(true)}
          disabled={refreshing}
        >
          <RefreshCw size={16} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* ── KPI Cards ─────────────────────────────────────────────────────── */}
      <div style={S.kpiGrid}>
        {p('kpi_avg_delay') && <KPICard
          title="Avg. Payment Delay (Vendor)"
          value={isLoading('delay') ? '...' : `${data.delay?.avg_delay_days ?? 0} Days`}
          subValue={isLoading('delay') ? '...' : `${data.delay?.total_payments_analyzed ?? 0} payments`}
          subLabel="Past 12 months"
          icon={Clock} color="#f59e0b" loading={isLoading('delay')} error={errors.delay}
          onClick={() => openModal('Vendor Payment Delay — Past 12 Months', data.delay?.detail || [], delayCols)}
        />}
        {p('kpi_bill_count') && <KPICard
          title={`Bills Received — ${monthLabel()}`}
          value={isLoading('bills') ? '...' : formatNumber(data.bills?.this_month)}
          subValue={isLoading('bills') ? '...' : formatNumber(data.bills?.this_fy)}
          subLabel={`Total ${fyLabel()}`}
          icon={FileText} color="#3b82f6" loading={isLoading('bills')} error={errors.bills}
          onClick={() => openModal(`Bills Received — ${monthLabel()}`, data.bills?.this_month_detail || [], billCols)}
        />}
        {p('kpi_expense') && <KPICard
          title={`Expense — ${monthLabel()}`}
          value={isLoading('expense') ? '...' : formatINR(data.expense?.this_month)}
          subValue={isLoading('expense') ? '...' : formatINR(data.expense?.this_fy)}
          subLabel={`${fyLabel()} total`}
          icon={TrendingDown} color="#10b981" loading={isLoading('expense')} error={errors.expense}
          onClick={() => openModal(`Expense Detail — ${monthLabel()}`, data.expense?.this_month_detail || [], billCols)}
        />}
        {p('kpi_expense') && <KPICard
          title={`Total Expense — ${fyLabel()}`}
          value={isLoading('expense') ? '...' : formatINR(data.expense?.this_fy)}
          icon={DollarSign} color="#8b5cf6" loading={isLoading('expense')} error={errors.expense}
          onClick={() => openModal(`All Expenses — ${fyLabel()}`, data.expense?.this_fy_detail || [], billCols)}
        />}
        {p('kpi_payments') && <KPICard
          title="Amount Paid Today"
          value={isLoading('payments') ? '...' : formatINR(data.payments?.today)}
          subValue={isLoading('payments') ? '...' : `${data.payments?.today_detail?.length ?? 0} payments`}
          subLabel="Bank payments only"
          icon={DollarSign} color="#22c55e" loading={isLoading('payments')} error={errors.payments}
          onClick={() => openModal("Amount Paid Today — Bank Payments", data.payments?.today_detail || [], paymentCols)}
        />}
        {p('kpi_payments') && <KPICard
          title={`Amount Paid — ${monthLabel()}`}
          value={isLoading('payments') ? '...' : formatINR(data.payments?.this_month)}
          subValue={isLoading('payments') ? '...' : `${data.payments?.this_month_detail?.length ?? 0} payments`}
          subLabel="Bank payments only"
          icon={Truck} color="#84cc16" loading={isLoading('payments')} error={errors.payments}
          onClick={() => openModal(`Amount Paid — ${monthLabel()} (Bank Payments)`, data.payments?.this_month_detail || [], paymentCols)}
        />}
        {p('kpi_payments') && <KPICard
          title="Vendor Credit Notes — Today"
          value={isLoading('payments') ? '...' : formatINR(data.payments?.today_vendor_credits)}
          subValue={isLoading('payments') ? '...' : formatINR(data.payments?.month_vendor_credits)}
          subLabel={`${monthLabel()} total`}
          icon={FileText} color="#f59e0b" loading={isLoading('payments')} error={errors.payments}
          onClick={() => openModal(
            (data.payments?.today_vendor_credits ?? 0) > 0
              ? 'Vendor Credit Notes — Today'
              : `Vendor Credit Notes — ${monthLabel()}`,
            (data.payments?.today_vendor_credits ?? 0) > 0
              ? (data.payments?.today_vc_detail || [])
              : (data.payments?.month_vc_detail || []),
            vcCols
          )}
        />}
        {p('kpi_payables') && <KPICard
          title={`Payables — ${monthLabel()}`}
          value={isLoading('payables') ? '...' : formatINR(data.payables?.this_month)}
          subValue={isLoading('payables') ? '...' : formatINR(data.payables?.all_time)}
          subLabel="Total as on date"
          icon={AlertCircle} color="#ef4444" loading={isLoading('payables')} error={errors.payables}
          onClick={() => openModal(`Payables — ${monthLabel()}`, data.payables?.this_month_detail || [], payableCols)}
        />}
        {p('kpi_payables') && <KPICard
          title="Total Payables as on Date"
          value={isLoading('payables') ? '...' : formatINR(data.payables?.all_time)}
          icon={DollarSign} color="#06b6d4" loading={isLoading('payables')} error={errors.payables}
          onClick={() => openModal('All Payables — As on Date', data.payables?.all_time_detail || [], payableCols)}
        />}
      </div>

      {/* ── Charts Row ────────────────────────────────────────────────────── */}
      <div style={S.twoCol}>
        <ChartCard
          title="Expense by Category"
          toggle={catToggle} onToggle={setCatToggle}
          toggleOptions={['This Month', fyLabel()]}
          loading={isLoading('cat')}
        >
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={catData} layout="vertical" margin={{ left: 10, right: 10 }}>
              <XAxis type="number" tickFormatter={v => `₹${(v / 100000).toFixed(0)}L`} tick={{ fill: '#5D6C7B', fontSize: 11 }} />
              <YAxis dataKey="category" type="category" tick={{ fill: '#18191B', fontSize: 11 }} width={140} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="expense" radius={[0, 4, 4, 0]}
                onClick={d => openModal(`${d.category} — Bills`, d.bills || [], billCols)}
                style={{ cursor: 'pointer' }}>
                {catData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Branch Wise Expense"
          toggle={brToggle} onToggle={setBrToggle}
          toggleOptions={['This Month', fyLabel()]}
          loading={isLoading('branch')}
        >
          <ResponsiveContainer width="100%" height={380}>
            <BarChart data={brData} margin={{ top: 10, right: 10, bottom: 120, left: 10 }}>
              <XAxis
                dataKey="branch"
                tick={{ fill: '#18191B', fontSize: 10 }}
                angle={-45}
                textAnchor="end"
                interval={0}
                height={120}
              />
              <YAxis tickFormatter={v => `₹${(v / 100000).toFixed(0)}L`} tick={{ fill: '#5D6C7B', fontSize: 11 }} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="expense" radius={[4, 4, 0, 0]}
                onClick={d => openModal(`${d.branch} — Bills`, d.bills || [], billCols)}
                style={{ cursor: 'pointer' }}>
                {brData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Top Vendors + AP Aging ─────────────────────────────────────────── */}
      <div style={S.twoCol}>
        {/* Top 10 Vendors */}
        <ChartCard title="Top 10 Vendors by Expense" loading={isLoading('vendors')}>
          {!isLoading('vendors') && (
            <div style={{ overflowY: 'auto', maxHeight: 300 }}>
              {(data.vendors || []).map((v, i) => (
                <div key={i} style={S.vendorRow}
                  onClick={() => openModal(`${v.vendor_name} — Bill History`, v.bills || [], billCols)}>
                  <span style={S.vendorRank}>#{i + 1}</span>
                  <span style={S.vendorName}>{v.vendor_name}</span>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={S.vendorAmt}>{formatINR(v.expense)}</div>
                    {v.outstanding > 0 && (
                      <div style={S.vendorOwed}>{formatINR(v.outstanding)} due</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ChartCard>

        {/* AP Aging Summary */}
        <ChartCard title="AP Aging Summary — Outstanding Payables" loading={isLoading('apAging')}>
          {!isLoading('apAging') && (
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {['Aging Bucket', 'Bills', 'Outstanding'].map(h => (
                      <th key={h} style={{ ...S.th, textAlign: h === 'Aging Bucket' ? 'left' : 'right' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {agingBuckets.map(b => {
                    const bucket = aging[b.key] || { count: 0, total: 0, bills: [] };
                    return (
                      <tr key={b.key} style={{ cursor: 'pointer' }}
                        onClick={() => bucket.count > 0 && openModal(`AP Aging: ${b.label}`, bucket.bills, agingBillCols)}>
                        <td style={S.td}>
                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: b.color, marginRight: 8 }} />
                          <span style={{ color: b.color, fontWeight: 500 }}>{b.label}</span>
                        </td>
                        <td style={{ ...S.td, textAlign: 'right', color: '#94a3b8' }}>{bucket.count}</td>
                        <td style={{ ...S.td, textAlign: 'right', color: b.color, fontWeight: 600 }}>{formatINR(bucket.total)}</td>
                      </tr>
                    );
                  })}
                  {aging.grand_total != null && (
                    <tr style={{ borderTop: '2px solid #334155' }}>
                      <td style={{ ...S.td, fontWeight: 700, color: '#f1f5f9' }}>TOTAL</td>
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 600 }}>
                        {agingBuckets.reduce((s, b) => s + (aging[b.key]?.count || 0), 0)}
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#ef4444', fontSize: '1rem' }}>
                        {formatINR(aging.grand_total)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
      </div>

      {/* ── Vendor Category & Recurring Vendors Report ──────────────────── */}
      {p('report_vendor_cat') && (
      <VendorCategoryReport
        data={vcData}
        loading={vcLoading}
        onBillClick={(title, bills) => openModal(title, bills, billCols)}
        onPayableClick={(title, bills) => openModal(title, bills, payableCols)}
        onCreditClick={(title, credits) => openModal(title, credits, unusedCreditCols)}
      />
      )}

      {/* ── Project-wise PO Report ───────────────────────────────────────── */}
      {p('report_po') && (
        <POReport data={poData} loading={poLoading} />
      )}

      {modal && <Modal title={modal.title} data={modal.rows} columns={modal.columns} totals={!!modal.totals} wide={!!modal.wide} onClose={closeModal} />}

      {/* ── Vendor Unused Credits Aging ──────────────────────────────────── */}
      <VendorCreditsAging
        data={vcAgingData}
        loading={vcAgingLoading}
        error={vcAgingError}
        catFilter={vcAgingCatFilter}
        onCatFilter={setVcAgingCatFilter}
        onLoad={loadVcAging}
      />

      {/* ── Vendor Payment Report (against bills vs advances against POs) ─── */}
      {p('report_vendor_payments') && <VendorPaymentReport />}

      {/* ── Bills Missing Attachment ─────────────────────────────────────── */}
      <div style={NA.wrap}>
        <div style={NA.header}>
          <div>
            <span style={NA.title}>Bills Missing Attachment</span>
            <span style={NA.badge}>
              {noAttachData
                ? `${noAttachData.total_missing} bills · ${noAttachData.fy_range?.start?.slice(0,7)} to ${noAttachData.fy_range?.end?.slice(0,7)}`
                : 'Purchase bills without soft-copy in current FY'}
            </span>
          </div>
          <button onClick={loadNoAttach} disabled={noAttachLoading} style={NA.refreshBtn}>
            <RefreshCw size={13} style={{ marginRight: 4, opacity: noAttachLoading ? 0.5 : 1 }} />
            {noAttachLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {noAttachData && !noAttachLoading && (
          <div style={NA.kpiStrip}>
            <div style={NA.kpiBox}>
              <div style={NA.kpiVal}>{noAttachData.total_missing}</div>
              <div style={NA.kpiLbl}>Bills Without Attachment</div>
            </div>
            <div style={NA.kpiBox}>
              <div style={{ ...NA.kpiVal, color: '#f59e0b' }}>{noAttachData.categories?.length || 0}</div>
              <div style={NA.kpiLbl}>Categories Affected</div>
            </div>
            <div style={NA.kpiBox}>
              <div style={{ ...NA.kpiVal, color: '#ef4444' }}>{formatINR(noAttachData.total_amount || 0)}</div>
              <div style={NA.kpiLbl}>Total Bill Value</div>
            </div>
            <div style={NA.kpiBox}>
              <div style={{ ...NA.kpiVal, color: '#5D6C7B' }}>{noAttachData.total_fetched || 0}</div>
              <div style={NA.kpiLbl}>Total Bills Scanned</div>
            </div>
          </div>
        )}

        {noAttachLoading && (
          <div style={NA.center}>Fetching bills from Zoho Books…</div>
        )}
        {noAttachError && !noAttachLoading && (
          <div style={{ ...NA.center, color: '#ef4444' }}>
            Failed to load.{' '}
            <button onClick={loadNoAttach} style={NA.retryBtn}>Retry</button>
          </div>
        )}
        {!noAttachLoading && !noAttachError && !noAttachData && (
          <div style={NA.center}>
            <button onClick={loadNoAttach} style={NA.loadBtn}>Load Report</button>
          </div>
        )}
        {!noAttachLoading && !noAttachError && noAttachData && noAttachData.total_missing === 0 && (
          <div style={{ ...NA.center, color: '#10b981' }}>All bills in current FY have attachments</div>
        )}

        {!noAttachLoading && noAttachData && noAttachData.categories?.length > 0 && (
          <div>
            {noAttachData.categories.map((cat, ci) => {
              const isOpen = !!expandedCats[cat.category];
              return (
                <div key={cat.category} style={{ borderTop: ci > 0 ? '1px solid #1a2740' : 'none' }}>
                  <div
                    style={NA.catRow}
                    onClick={() => setExpandedCats(p => ({ ...p, [cat.category]: !p[cat.category] }))}
                  >
                    <span style={NA.catArrow}>{isOpen ? '▾' : '▸'}</span>
                    <span style={NA.catName}>{cat.category}</span>
                    <span style={NA.catCount}><span style={NA.countBadge}>{cat.count} bills</span></span>
                    <span style={NA.catAmt}>{formatINR(cat.total_amount)}</span>
                  </div>
                  {isOpen && (
                    <div style={{ overflowX: 'auto', background: '#070e1a' }}>
                      <table style={NA.table}>
                        <thead>
                          <tr>
                            {['Bill #','Vendor','Date','Due Date','Branch','Amount','Balance','Status'].map(h => (
                              <th key={h} style={NA.th}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {cat.bills.map((bill, bi) => {
                            const statusColor = {
                              open: '#f59e0b', overdue: '#ef4444', paid: '#10b981',
                              draft: '#64748b', void: '#475569',
                            }[bill.status?.toLowerCase()] || '#64748b';
                            return (
                              <tr key={bill.bill_id || bi} style={{ background: bi % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                                <td style={NA.td}>{bill.bill_number}</td>
                                <td style={NA.td}>{bill.vendor_name}</td>
                                <td style={NA.td}>{formatDate(bill.date)}</td>
                                <td style={NA.td}>{formatDate(bill.due_date)}</td>
                                <td style={NA.td}>{bill.branch_name}</td>
                                <td style={{ ...NA.td, textAlign: 'right', color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>{formatINR(bill.total)}</td>
                                <td style={{ ...NA.td, textAlign: 'right', color: bill.balance > 0 ? '#fca5a5' : '#475569', fontVariantNumeric: 'tabular-nums' }}>
                                  {bill.balance > 0 ? formatINR(bill.balance) : '—'}
                                </td>
                                <td style={NA.td}>
                                  <span style={{ background: `${statusColor}22`, color: statusColor, border: `1px solid ${statusColor}44`, borderRadius: 4, padding: '1px 8px', fontSize: '0.7rem', fontWeight: 600, textTransform: 'capitalize' }}>
                                    {bill.status}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
        *::-webkit-scrollbar{width:6px;height:6px}
        *::-webkit-scrollbar-track{background:#F2F2F2}
        *::-webkit-scrollbar-thumb{background:#C8D6D0;border-radius:3px}
      `}</style>
    </div>
  );
}

export const QUARTER_MONTHS = { q1:[4,5,6], q2:[7,8,9], q3:[10,11,12], q4:[1,2,3] };
export const QUARTER_LABELS = { all:'All Quarters', q1:'Q1 (Apr–Jun)', q2:'Q2 (Jul–Sep)', q3:'Q3 (Oct–Dec)', q4:'Q4 (Jan–Mar)' };

// Current FY / FY 2025-26 pill toggle, styled like the Vendor Category report's period toggle
export function FYToggle({ fy, onChange }) {
  return (
    <div style={VCS.toggleBar}>
      <button style={VCS.toggle(fy === 'current')} onClick={() => onChange('current')}>{fyLabel()}</button>
      <button style={VCS.toggle(fy === 'fy2526')}  onClick={() => onChange('fy2526')}>FY 2025-26</button>
    </div>
  );
}

// ─── Vendor Unused Credits Aging ─────────────────────────────────────────────

const BUCKET_COLORS = [
  '#10b981','#4ade80','#86efac',   // 0-180 days  (green shades)
  '#f59e0b','#fbbf24','#fcd34d',   // 181-360 days (amber shades)
  '#ef4444','#f87171','#fca5a5',   // 361-540 days (red shades)
  '#8b5cf6','#a78bfa','#c4b5fd',   // 541+ days    (purple shades)
];

function fmtAmt(n) {
  if (!n || n === 0) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

function VendorCreditsAging({ data, loading, error, catFilter, onCatFilter, onLoad }) {
  const [modal, setModal] = useState(null); // { vendor: row, bucketIdx: null | number }

  const bucketLabels   = data?.bucket_labels   || [];
  const summaryBuckets = data?.summary_buckets || [];
  const categories     = data?.categories      || [];
  const allRows        = data?.rows            || [];

  const rows = catFilter === 'All Categories'
    ? allRows
    : allRows.filter(r => r.category === catFilter);

  const filteredBuckets = bucketLabels.map((_, i) =>
    rows.reduce((s, r) => s + (r.buckets[i] || 0), 0)
  );
  const filteredTotal = rows.reduce((s, r) => s + r.total, 0);

  return (
    <div style={VC.wrap}>
      {/* Header */}
      <div style={VC.header}>
        <div>
          <span style={VC.title}>Vendors Unused Credits Aging</span>
          <span style={VC.badge}>
            {data
              ? `${data.total_vendors} vendors · ${data.total_credits} open credits · As of ${data.as_of}`
              : 'Open vendor credits aged by 60-day buckets'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {data && (
            <select
              value={catFilter}
              onChange={e => onCatFilter(e.target.value)}
              style={VC.catSelect}
            >
              <option value="All Categories">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <button onClick={onLoad} disabled={loading} style={VC.refreshBtn}>
            <RefreshCw size={13} style={{ marginRight: 4, opacity: loading ? 0.5 : 1 }} />
            {loading ? 'Loading…' : data ? 'Refresh' : 'Load Report'}
          </button>
        </div>
      </div>

      {/* KPI strip */}
      {data && !loading && (
        <div style={VC.kpiStrip}>
          <div style={VC.kpiBox}>
            <div style={{ ...VC.kpiVal, color: '#60a5fa' }}>{rows.length}</div>
            <div style={VC.kpiLbl}>Vendors with Unused Credits</div>
          </div>
          <div style={VC.kpiBox}>
            <div style={{ ...VC.kpiVal, color: '#f59e0b' }}>{rows.reduce((s, r) => s + r.credit_count, 0)}</div>
            <div style={VC.kpiLbl}>Open Credit Notes</div>
          </div>
          <div style={VC.kpiBox}>
            <div style={{ ...VC.kpiVal, color: '#ef4444' }}>{formatINR(filteredTotal)}</div>
            <div style={VC.kpiLbl}>Total Unused Credit Amount</div>
          </div>
          <div style={VC.kpiBox}>
            <div style={{ ...VC.kpiVal, color: '#a78bfa' }}>{data.oldest_days} days</div>
            <div style={VC.kpiLbl}>Oldest Unused Credit</div>
          </div>
        </div>
      )}

      {loading && <div style={VC.center}>Fetching vendor credits from Zoho Books…</div>}
      {error && !loading && (
        <div style={{ ...VC.center, color: '#ef4444' }}>
          Failed to load. <button onClick={onLoad} style={NA.retryBtn}>Retry</button>
        </div>
      )}
      {!loading && !error && !data && (
        <div style={VC.center}>
          <button onClick={onLoad} style={NA.loadBtn}>Load Report</button>
        </div>
      )}

      {!loading && data && rows.length === 0 && (
        <div style={{ ...VC.center, color: '#10b981' }}>
          No open vendor credits {catFilter !== 'All Categories' ? `in category "${catFilter}"` : ''}
        </div>
      )}

      {modal && (
        <div style={VC.modalOverlay} onClick={() => setModal(null)}>
          <div style={VC.modalBox} onClick={e => e.stopPropagation()}>
            <div style={VC.modalHeader}>
              <div>
                <div style={VC.modalTitle}>{modal.vendor.vendor_name}</div>
                <div style={VC.modalSub}>
                  {modal.bucketIdx !== null
                    ? `Bucket: ${bucketLabels[modal.bucketIdx]} days`
                    : 'All Credits'}
                  {' · '}{modal.vendor.category}
                </div>
              </div>
              <button onClick={() => setModal(null)} style={VC.modalClose}>✕ Close</button>
            </div>
            <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 420 }}>
              <table style={{ ...VC.table, fontSize: '0.78rem' }}>
                <thead>
                  <tr>
                    <th style={{ ...VC.th, minWidth: 140 }}>Credit No.</th>
                    <th style={{ ...VC.th, minWidth: 110 }}>Date</th>
                    <th style={{ ...VC.th, textAlign: 'right', minWidth: 130 }}>Original Amount</th>
                    <th style={{ ...VC.th, textAlign: 'right', minWidth: 130 }}>Unused Amount</th>
                    <th style={{ ...VC.th, textAlign: 'right', minWidth: 90 }}>Age (Days)</th>
                    <th style={{ ...VC.th, minWidth: 90 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(modal.vendor.credit_details || [])
                    .filter(cd => modal.bucketIdx === null || cd.bucket_idx === modal.bucketIdx)
                    .map((cd, idx) => (
                      <tr key={idx} style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                        <td style={{ ...VC.td, color: '#1C4942' }}>{cd.credit_number || '—'}</td>
                        <td style={{ ...VC.td, color: '#5D6C7B' }}>{cd.date}</td>
                        <td style={{ ...VC.td, textAlign: 'right', color: '#DC2626' }}>{fmtAmt(cd.total)}</td>
                        <td style={{ ...VC.td, textAlign: 'right', color: '#DC2626', fontWeight: 600 }}>{fmtAmt(cd.attributed)}</td>
                        <td style={{ ...VC.td, textAlign: 'right', color: cd.age_days > 180 ? '#DC2626' : '#5D6C7B' }}>{cd.age_days}</td>
                        <td style={{ ...VC.td, color: '#9BA8B0', textTransform: 'capitalize' }}>{cd.status}</td>
                      </tr>
                    ))}
                  {(modal.vendor.credit_details || []).filter(cd => modal.bucketIdx === null || cd.bucket_idx === modal.bucketIdx).length === 0 && (
                    <tr><td colSpan={6} style={{ ...VC.td, textAlign: 'center', color: '#475569', padding: '1.5rem' }}>No credit details available</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {!loading && data && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={VC.table}>
            <thead>
              <tr>
                <th style={{ ...VC.th, minWidth: 200, position: 'sticky', left: 0, zIndex: 2, background: '#0a1525' }}>Vendor Name</th>
                <th style={{ ...VC.th, minWidth: 140 }}>Category</th>
                <th style={{ ...VC.th, textAlign: 'right', minWidth: 60 }}>Credits</th>
                {bucketLabels.map((lbl, i) => (
                  <th key={lbl} style={{ ...VC.th, textAlign: 'right', minWidth: 80, color: BUCKET_COLORS[i] }}>
                    {lbl}
                  </th>
                ))}
                <th style={{ ...VC.th, textAlign: 'right', minWidth: 100 }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {/* Summary row */}
              <tr style={{ background: '#0d1f3c' }}>
                <td style={{ ...VC.td, fontWeight: 700, color: '#e2e8f0', position: 'sticky', left: 0, background: '#0d1f3c', zIndex: 1 }}>
                  Total ({rows.length} vendors)
                </td>
                <td style={VC.td} />
                <td style={{ ...VC.td, textAlign: 'right', color: '#5D6C7B' }}>
                  {rows.reduce((s, r) => s + r.credit_count, 0)}
                </td>
                {filteredBuckets.map((v, i) => (
                  <td key={i} style={{ ...VC.td, textAlign: 'right', fontWeight: 600, color: v ? BUCKET_COLORS[i] : '#1e3a5f' }}>
                    {v ? fmtAmt(v) : '—'}
                  </td>
                ))}
                <td style={{ ...VC.td, textAlign: 'right', fontWeight: 700, color: '#ef4444' }}>
                  {fmtAmt(filteredTotal)}
                </td>
              </tr>
              {/* Vendor rows */}
              {rows.map((r, ri) => (
                <tr key={r.vendor_id} style={{ background: ri % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                  <td style={{ ...VC.td, color: '#e2e8f0', position: 'sticky', left: 0, background: ri % 2 === 0 ? '#0a1628' : '#0b1b2e', zIndex: 1 }}>
                    {r.vendor_name}
                  </td>
                  <td style={VC.td}>
                    <span style={VC.catBadge}>{r.category}</span>
                  </td>
                  <td style={{ ...VC.td, textAlign: 'right', color: '#9BA8B0' }}>{r.credit_count}</td>
                  {r.buckets.map((v, i) => (
                    <td key={i}
                      onClick={() => v && setModal({ vendor: r, bucketIdx: i })}
                      style={{ ...VC.td, textAlign: 'right', color: v ? BUCKET_COLORS[i] : '#DFE7E3', fontVariantNumeric: 'tabular-nums', cursor: v ? 'pointer' : 'default' }}>
                      {v ? fmtAmt(v) : '—'}
                    </td>
                  ))}
                  <td
                    onClick={() => setModal({ vendor: r, bucketIdx: null })}
                    style={{ ...VC.td, textAlign: 'right', fontWeight: 600, color: '#DC2626', fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
                    {fmtAmt(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const VC = {
  wrap: {
    background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3',
    overflow: 'hidden', marginBottom: '1.5rem', boxShadow: '0 1px 3px rgba(0,18,20,0.06)',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3',
    flexWrap: 'wrap', gap: 8,
  },
  title:  { color: '#18191B', fontWeight: 700, fontSize: '0.95rem', marginRight: 10 },
  badge:  { color: '#9BA8B0', fontSize: '0.75rem' },
  refreshBtn: {
    display: 'flex', alignItems: 'center',
    background: '#EAF4EF', border: '1px solid #A7C4BC', color: '#1C4942',
    borderRadius: 6, padding: '0.35rem 0.85rem', fontSize: '0.78rem', cursor: 'pointer',
  },
  catSelect: {
    background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B',
    borderRadius: 6, padding: '0.35rem 0.65rem', fontSize: '0.78rem', cursor: 'pointer',
  },
  kpiStrip: { display: 'flex', borderBottom: '1px solid #DFE7E3', flexWrap: 'wrap' },
  kpiBox:   { flex: 1, minWidth: 140, padding: '0.85rem 1.25rem', borderRight: '1px solid #DFE7E3' },
  kpiVal:   { fontSize: '1.35rem', fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
  kpiLbl:   { color: '#9BA8B0', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 3 },
  center:   { padding: '2rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.85rem' },
  table:    { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
  th: {
    padding: '0.5rem 0.7rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.7rem',
    textTransform: 'uppercase', letterSpacing: '0.03em', background: '#F9F9F9',
    borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', textAlign: 'left',
  },
  td: {
    padding: '0.5rem 0.7rem', color: '#18191B',
    borderBottom: '1px solid #F2F2F2', whiteSpace: 'nowrap',
  },
  catBadge: {
    background: '#EAF4EF', color: '#1C4942',
    border: '1px solid #A7C4BC', borderRadius: 4,
    padding: '1px 6px', fontSize: '0.7rem', fontWeight: 600,
  },
  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)',
    zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  modalBox: {
    background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12,
    maxWidth: 900, width: '90vw', maxHeight: '80vh', overflow: 'hidden',
    display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,18,20,0.2)',
  },
  modalHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3', flexShrink: 0,
  },
  modalTitle: { color: '#18191B', fontWeight: 700, fontSize: '0.95rem' },
  modalSub:   { color: '#9BA8B0', fontSize: '0.75rem', marginTop: 4 },
  modalClose: {
    background: 'none', border: '1px solid #DFE7E3', color: '#5D6C7B',
    borderRadius: 6, padding: '0.3rem 0.75rem', cursor: 'pointer',
    fontSize: '0.78rem', flexShrink: 0, marginLeft: 16,
  },
};

const NA = {
  wrap: {
    background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3',
    overflow: 'hidden', marginBottom: '1.5rem', boxShadow: '0 1px 3px rgba(0,18,20,0.06)',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3',
  },
  title:  { color: '#18191B', fontWeight: 700, fontSize: '0.95rem', marginRight: 10 },
  badge:  { color: '#9BA8B0', fontSize: '0.75rem' },
  refreshBtn: {
    display: 'flex', alignItems: 'center',
    background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B',
    borderRadius: 6, padding: '0.35rem 0.85rem', fontSize: '0.78rem', cursor: 'pointer',
  },
  kpiStrip: { display: 'flex', borderBottom: '1px solid #DFE7E3' },
  kpiBox:   { flex: 1, padding: '0.85rem 1.25rem', borderRight: '1px solid #DFE7E3' },
  kpiVal:   { color: '#DC2626', fontSize: '1.4rem', fontWeight: 700, lineHeight: 1.2 },
  kpiLbl:   { color: '#9BA8B0', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 3 },
  center:   { padding: '2rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.85rem' },
  loadBtn: {
    background: '#1C4942', color: '#fff', border: 'none', borderRadius: 7,
    padding: '0.5rem 1.25rem', fontSize: '0.82rem', cursor: 'pointer', fontWeight: 600,
  },
  retryBtn: {
    background: 'none', border: '1px solid #DC2626', color: '#DC2626',
    borderRadius: 6, padding: '0.3rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer', marginLeft: 8,
  },
  catRow: {
    display: 'flex', alignItems: 'center', padding: '0.75rem 1.25rem',
    cursor: 'pointer', background: '#F2F2F2',
  },
  catArrow:   { color: '#9BA8B0', fontSize: '0.75rem', marginRight: 10, width: 12 },
  catName:    { flex: 1, color: '#18191B', fontWeight: 600, fontSize: '0.85rem' },
  catCount:   { marginRight: 16 },
  countBadge: {
    background: '#FEF2F2', color: '#DC2626',
    border: '1px solid #FECACA', borderRadius: 4,
    padding: '1px 8px', fontSize: '0.72rem', fontWeight: 600,
  },
  catAmt: { color: '#5D6C7B', fontSize: '0.82rem', minWidth: 100, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  table:  { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
  th: {
    padding: '0.5rem 0.85rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.7rem',
    textTransform: 'uppercase', letterSpacing: '0.04em', background: '#F9F9F9',
    borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', textAlign: 'left',
  },
  td: { padding: '0.6rem 0.85rem', color: '#18191B', borderBottom: '1px solid #F2F2F2', whiteSpace: 'nowrap' },
};

const S = {
  page:       { minHeight: '100vh', background: '#F9F9F9', padding: '1.5rem 2rem', fontFamily: "'Figtree', 'Inter', -apple-system, sans-serif" },
  header:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' },
  heading:    { margin: 0, color: '#18191B', fontSize: '1.5rem', fontWeight: 700 },
  subheading: { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.9rem' },
  refreshBtn: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '0.5rem 1rem', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem' },
  kpiGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem', marginBottom: '1.25rem' },
  twoCol:     { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' },
  vendorRow:  { display: 'flex', alignItems: 'center', padding: '0.55rem 0.5rem', borderRadius: 6, cursor: 'pointer', gap: '0.75rem', transition: 'background 0.1s' },
  vendorRank: { color: '#9BA8B0', fontSize: '0.8rem', width: 24, flexShrink: 0 },
  vendorName: { color: '#18191B', fontSize: '0.84rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  vendorAmt:  { color: '#B45309', fontWeight: 600, fontSize: '0.84rem' },
  vendorOwed: { color: '#DC2626', fontSize: '0.72rem', marginTop: 1 },
  table:      { width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' },
  th:         { padding: '0.55rem 0.9rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #DFE7E3', background: '#F9F9F9' },
  td:         { padding: '0.65rem 0.9rem', color: '#18191B', borderBottom: '1px solid #F2F2F2' },
};

// ─── Vendor Category & Recurring Vendors Report ───────────────────────────────
const VC_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899',
  '#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#eab308',
];

export const VCS = {
  wrap:    { background: '#F9F9F9', padding: '1.5rem 0 0' },
  card:    { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, padding: '1.25rem 1.5rem', marginBottom: '1.25rem', boxShadow: '0 1px 3px rgba(0,18,20,0.06)' },
  hdr:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' },
  title:   { color: '#18191B', fontWeight: 700, fontSize: '1.05rem', margin: 0 },
  tab:     (active) => ({
    padding: '0.35rem 1rem', borderRadius: 20, fontSize: '0.82rem', cursor: 'pointer', border: 'none', fontWeight: 600,
    background: active ? '#1C4942' : '#F2F2F2', color: active ? '#fff' : '#5D6C7B',
  }),
  toggle:  (active) => ({
    padding: '0.3rem 0.85rem', borderRadius: 6, fontSize: '0.78rem', cursor: 'pointer', border: 'none',
    background: active ? '#EAF4EF' : 'transparent', color: active ? '#1C4942' : '#9BA8B0', fontWeight: active ? 600 : 400,
  }),
  tabBar:    { display: 'flex', gap: '0.35rem', background: '#0f172a', borderRadius: 24, padding: '0.25rem' },
  toggleBar: { display: 'flex', gap: '0.25rem', background: '#0f172a', borderRadius: 6, padding: '0.2rem' },
  exportBtn: { border: '1px solid', borderRadius: 6, padding: '0.35rem 0.85rem', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 },
  filterRow: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' },
  filterLbl: { color: '#5D6C7B', fontSize: '0.74rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  select:    { background: '#FFFFFF', color: '#18191B', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.35rem 0.65rem', fontSize: '0.8rem', cursor: 'pointer' },
  clearBtn:  { background: 'transparent', border: '1px solid #DFE7E3', color: '#5D6C7B', borderRadius: 6, padding: '0.35rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer' },
  empty:     { textAlign: 'center', color: '#475569', padding: '3rem 0', fontSize: '0.9rem' },
  notice:    { background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E', borderRadius: 6, padding: '0.5rem 0.85rem', fontSize: '0.78rem', marginBottom: '1rem' },
  chartLbl:  { color: '#5D6C7B', fontSize: '0.74rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 0.75rem' },
  legend:       { display: 'flex', flexWrap: 'wrap', gap: '0.4rem 0.75rem', padding: '0.5rem 0 0.25rem' },
  legendItem:   { display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.73rem', color: '#5D6C7B' },
  legendSwatch: { width: 10, height: 10, borderRadius: 2, flexShrink: 0 },
  num:       { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  dot:       { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 8, verticalAlign: 'middle' },
  count:     { marginLeft: 8, color: '#475569', fontWeight: 400, fontSize: '0.75rem' },
  grpRow:    { background: '#F9F9F9' },
  th:      { padding: '0.5rem 0.75rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.74rem', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #DFE7E3', textAlign: 'left', whiteSpace: 'nowrap', background: '#F9F9F9' },
  td:      { padding: '0.55rem 0.75rem', color: '#18191B', borderBottom: '1px solid #F2F2F2', fontSize: '0.85rem' },
  catRow:    { background: '#F9F9F9', cursor: 'pointer' },
  subcatRow: { background: '#EAF4EF', cursor: 'pointer' },
  vendRow:   (i) => ({ background: i % 2 === 0 ? 'transparent' : '#F9F9F9' }),
};

function VendorCategoryReport({ data, loading, onBillClick, onPayableClick, onCreditClick }) {
  const [mainTab,      setMainTab]      = useState('category');
  const [period,       setPeriod]       = useState('fy');
  const [expanded,     setExpanded]     = useState({});    // category key → bool
  const [expandedSub,  setExpandedSub]  = useState({});   // "cat|||subcat" → bool

  const toggleCat    = cat => setExpanded(p => ({ ...p, [cat]: !p[cat] }));
  const toggleSubCat = key => setExpandedSub(p => ({ ...p, [key]: !p[key] }));

  const categories       = data?.categories       || [];
  const recurringVendors = data?.recurring_vendors || [];

  const expKey  = period === 'month' ? 'month_expense' : 'fy_expense';
  const billKey = period === 'month' ? 'month_bills'   : 'fy_bills';

  const expLabel      = period === 'month' ? new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' }) : fyLabel();
  const totalExpAll   = categories.reduce((s, c) => s + (c[expKey]  || 0), 0);
  const totalPayAll   = categories.reduce((s, c) => s + (c.payable  || 0), 0);
  const totalCredAll  = categories.reduce((s, c) => s + (c.credits  || 0), 0);

  return (
    <div style={VCS.wrap}>
      <div style={VCS.card}>
        {/* Header */}
        <div style={VCS.hdr}>
          <h2 style={VCS.title}>Vendor Category &amp; Recurring Vendors Report</h2>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Main tab */}
            <div style={VCS.tabBar}>
              <button style={VCS.tab(mainTab === 'category')}  onClick={() => setMainTab('category')}>By Category</button>
              <button style={VCS.tab(mainTab === 'recurring')} onClick={() => setMainTab('recurring')}>Recurring Vendors</button>
            </div>
            {/* Period toggle */}
            <div style={VCS.toggleBar}>
              <button style={VCS.toggle(period === 'month')} onClick={() => setPeriod('month')}>This Month</button>
              <button style={VCS.toggle(period === 'fy')}    onClick={() => setPeriod('fy')}>{fyLabel()}</button>
            </div>
          </div>
        </div>

        {loading && (
          <div style={{ textAlign: 'center', color: '#475569', padding: '3rem 0', fontSize: '0.9rem' }}>
            Loading vendor category data…
          </div>
        )}

        {!loading && mainTab === 'category' && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th style={{ ...VCS.th, width: 24 }}></th>
                  <th style={VCS.th}>Vendor / Category</th>
                  <th style={{ ...VCS.th, textAlign: 'right' }}>Expense ({expLabel})</th>
                  <th style={{ ...VCS.th, textAlign: 'right' }}>Payable (As on Date)</th>
                  <th style={{ ...VCS.th, textAlign: 'right', color: '#22c55e' }}>Unused Credits</th>
                </tr>
              </thead>
              <tbody>
                {categories.length === 0 && (
                  <tr><td colSpan={5} style={{ ...VCS.td, textAlign: 'center', color: '#334155', padding: '2rem' }}>No data available</td></tr>
                )}
                {categories.map((cat, ci) => {
                  const isCatOpen = !!expanded[cat.category];
                  const catColor  = VC_COLORS[ci % VC_COLORS.length];
                  const catExp    = cat[expKey] || 0;
                  const totalVendors = (cat.sub_categories || []).reduce((s, sc) => s + sc.vendors.length, 0);
                  return (
                    <React.Fragment key={cat.category}>
                      {/* ── Category row ── */}
                      <tr style={VCS.catRow} onClick={() => toggleCat(cat.category)}>
                        <td style={{ ...VCS.td, color: '#475569', fontSize: '0.7rem', width: 24, paddingRight: 0 }}>
                          {isCatOpen ? '▼' : '▶'}
                        </td>
                        <td style={{ ...VCS.td, fontWeight: 700, color: catColor }}>
                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: catColor, marginRight: 8, verticalAlign: 'middle' }} />
                          {cat.category}
                          <span style={{ marginLeft: 8, color: '#475569', fontWeight: 400, fontSize: '0.75rem' }}>
                            ({totalVendors} vendor{totalVendors !== 1 ? 's' : ''}, {(cat.sub_categories || []).length} sub-cat{(cat.sub_categories || []).length !== 1 ? 's' : ''})
                          </span>
                        </td>
                        <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 700, color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>
                          {catExp > 0 ? formatINR(catExp) : '—'}
                        </td>
                        <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 700, color: cat.payable > 0 ? '#ef4444' : '#334155', fontVariantNumeric: 'tabular-nums' }}>
                          {cat.payable > 0 ? formatINR(cat.payable) : '—'}
                        </td>
                        <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 700, color: cat.credits > 0 ? '#22c55e' : '#334155', fontVariantNumeric: 'tabular-nums' }}>
                          {cat.credits > 0 ? formatINR(cat.credits) : '—'}
                        </td>
                      </tr>

                      {/* ── Sub-category + vendor rows ── */}
                      {isCatOpen && (cat.sub_categories || []).map(sc => {
                        const scKey    = `${cat.category}|||${sc.sub_category}`;
                        const isScOpen = !!expandedSub[scKey];
                        const scExp    = sc[expKey] || 0;
                        return (
                          <React.Fragment key={scKey}>
                            {/* Sub-category row */}
                            <tr style={VCS.subcatRow} onClick={() => toggleSubCat(scKey)}>
                              <td style={{ ...VCS.td, color: '#334155', fontSize: '0.65rem', paddingLeft: '1.5rem', paddingRight: 0 }}>
                                {isScOpen ? '▼' : '▶'}
                              </td>
                              <td style={{ ...VCS.td, fontWeight: 600, color: '#60a5fa', paddingLeft: '1.75rem', fontSize: '0.82rem' }}>
                                ↳ {sc.sub_category}
                                <span style={{ marginLeft: 8, color: '#334155', fontWeight: 400, fontSize: '0.72rem' }}>
                                  ({sc.vendors.length} vendor{sc.vendors.length !== 1 ? 's' : ''})
                                </span>
                              </td>
                              <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 600, color: scExp > 0 ? '#cbd5e1' : '#334155', fontVariantNumeric: 'tabular-nums', fontSize: '0.82rem' }}>
                                {scExp > 0 ? formatINR(scExp) : '—'}
                              </td>
                              <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 600, color: sc.payable > 0 ? '#fca5a5' : '#334155', fontVariantNumeric: 'tabular-nums', fontSize: '0.82rem' }}>
                                {sc.payable > 0 ? formatINR(sc.payable) : '—'}
                              </td>
                              <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 600, color: sc.credits > 0 ? '#4ade80' : '#334155', fontVariantNumeric: 'tabular-nums', fontSize: '0.82rem' }}>
                                {sc.credits > 0 ? formatINR(sc.credits) : '—'}
                              </td>
                            </tr>

                            {/* Vendor rows */}
                            {isScOpen && sc.vendors.map((v, vi) => {
                              const vExp   = v[expKey] || 0;
                              const vBills = v[billKey] || [];
                              return (
                                <tr key={`${v.vendor_id || v.vendor_name}-${sc.sub_category}`} style={VCS.vendRow(vi)}>
                                  <td style={{ ...VCS.td }}></td>
                                  <td style={{ ...VCS.td, paddingLeft: '3.5rem', color: '#94a3b8', fontSize: '0.82rem' }}>
                                    ↳ {v.vendor_name}
                                  </td>
                                  <td
                                    style={{ ...VCS.td, textAlign: 'right', color: vExp > 0 ? '#e2e8f0' : '#334155', cursor: vBills.length > 0 ? 'pointer' : 'default', fontVariantNumeric: 'tabular-nums', fontSize: '0.82rem' }}
                                    onClick={() => vBills.length > 0 && onBillClick(`${v.vendor_name} — ${expLabel}`, vBills)}
                                  >
                                    {vExp > 0 ? (
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        {formatINR(vExp)}{vBills.length > 0 && <span style={{ fontSize: '0.62rem', color: '#3b82f6' }}>({vBills.length})</span>}
                                      </span>
                                    ) : '—'}
                                  </td>
                                  <td
                                    style={{ ...VCS.td, textAlign: 'right', color: v.payable > 0 ? '#fca5a5' : '#334155', cursor: v.payable_bills?.length > 0 ? 'pointer' : 'default', fontVariantNumeric: 'tabular-nums', fontSize: '0.82rem' }}
                                    onClick={() => v.payable_bills?.length > 0 && onPayableClick(`${v.vendor_name} — Outstanding Bills`, v.payable_bills)}
                                  >
                                    {v.payable > 0 ? (
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        {formatINR(v.payable)}{v.payable_bills?.length > 0 && <span style={{ fontSize: '0.62rem', color: '#ef4444' }}>({v.payable_bills.length})</span>}
                                      </span>
                                    ) : '—'}
                                  </td>
                                  <td
                                    style={{ ...VCS.td, textAlign: 'right', color: v.credits > 0 ? '#4ade80' : '#334155', cursor: v.credit_details?.length > 0 ? 'pointer' : 'default', fontVariantNumeric: 'tabular-nums', fontSize: '0.82rem' }}
                                    onClick={() => v.credit_details?.length > 0 && onCreditClick(`${v.vendor_name} — Unused Credits`, v.credit_details)}
                                  >
                                    {v.credits > 0 ? (
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        {formatINR(v.credits)}{v.credit_details?.length > 0 && <span style={{ fontSize: '0.62rem', color: '#22c55e' }}>({v.credit_details.length})</span>}
                                      </span>
                                    ) : '—'}
                                  </td>
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
              {categories.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #334155' }}>
                    <td colSpan={2} style={{ ...VCS.td, fontWeight: 700, color: '#f1f5f9', fontSize: '0.85rem', paddingTop: '0.75rem' }}>GRAND TOTAL</td>
                    <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 700, color: '#f59e0b', fontSize: '0.95rem', paddingTop: '0.75rem', fontVariantNumeric: 'tabular-nums' }}>
                      {formatINR(totalExpAll)}
                    </td>
                    <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 700, color: '#ef4444', fontSize: '0.95rem', paddingTop: '0.75rem', fontVariantNumeric: 'tabular-nums' }}>
                      {formatINR(totalPayAll)}
                    </td>
                    <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 700, color: '#22c55e', fontSize: '0.95rem', paddingTop: '0.75rem', fontVariantNumeric: 'tabular-nums' }}>
                      {totalCredAll > 0 ? formatINR(totalCredAll) : '—'}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}

        {!loading && mainTab === 'recurring' && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th style={VCS.th}>#</th>
                  <th style={VCS.th}>Vendor Name</th>
                  <th style={VCS.th}>Category</th>
                  <th style={VCS.th}>Recurrence</th>
                  <th style={VCS.th}>Next Bill</th>
                  <th style={{ ...VCS.th, textAlign: 'right' }}>Template Amt</th>
                  <th style={{ ...VCS.th, textAlign: 'right' }}>Expense ({expLabel})</th>
                  <th style={{ ...VCS.th, textAlign: 'right' }}>Payable</th>
                  <th style={{ ...VCS.th, textAlign: 'right', color: '#22c55e' }}>Unused Credits</th>
                </tr>
              </thead>
              <tbody>
                {recurringVendors.length === 0 && (
                  <tr><td colSpan={9} style={{ ...VCS.td, textAlign: 'center', color: '#334155', padding: '2rem' }}>No active recurring bills found</td></tr>
                )}
                {recurringVendors.map((rv, i) => {
                  const rvExp   = rv[expKey] || 0;
                  const rvBills = rv[billKey] || [];
                  const catColor = VC_COLORS[i % VC_COLORS.length];
                  return (
                    <tr key={rv.vendor_id || rv.recurrence_name} style={VCS.vendRow(i)}>
                      <td style={{ ...VCS.td, color: '#475569', fontSize: '0.75rem' }}>{i + 1}</td>
                      <td style={{ ...VCS.td, fontWeight: 500, color: '#e2e8f0' }}>
                        <div>{rv.vendor_name}</div>
                        {rv.recurrence_name && rv.recurrence_name !== rv.vendor_name && (
                          <div style={{ fontSize: '0.73rem', color: '#475569', marginTop: 2 }}>{rv.recurrence_name}</div>
                        )}
                      </td>
                      <td style={{ ...VCS.td }}>
                        <span style={{ background: catColor + '22', color: catColor, borderRadius: 12, padding: '0.2rem 0.6rem', fontSize: '0.75rem', fontWeight: 600 }}>
                          {rv.category}
                        </span>
                      </td>
                      <td style={{ ...VCS.td, color: '#94a3b8', fontSize: '0.8rem' }}>
                        {rv.recurrence_frequency
                          ? `Every ${rv.repeat_every > 1 ? rv.repeat_every + ' ' : ''}${rv.recurrence_frequency}`
                          : '—'}
                      </td>
                      <td style={{ ...VCS.td, color: '#64748b', fontSize: '0.8rem' }}>
                        {rv.next_bill_date ? formatDate(rv.next_bill_date) : '—'}
                      </td>
                      <td style={{ ...VCS.td, textAlign: 'right', color: '#60a5fa', fontVariantNumeric: 'tabular-nums' }}>
                        {rv.template_amount > 0 ? formatINR(rv.template_amount) : '—'}
                      </td>
                      <td
                        style={{ ...VCS.td, textAlign: 'right', color: rvExp > 0 ? '#e2e8f0' : '#334155', cursor: rvBills.length > 0 ? 'pointer' : 'default', fontVariantNumeric: 'tabular-nums' }}
                        onClick={() => rvBills.length > 0 && onBillClick(`${rv.vendor_name} — ${expLabel} Bills`, rvBills)}
                        title={rvBills.length > 0 ? 'Click to view bills' : ''}
                      >
                        {rvExp > 0 ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {formatINR(rvExp)}
                            {rvBills.length > 0 && <span style={{ fontSize: '0.65rem', color: '#3b82f6' }}>({rvBills.length})</span>}
                          </span>
                        ) : '—'}
                      </td>
                      <td
                        style={{ ...VCS.td, textAlign: 'right', color: rv.payable > 0 ? '#fca5a5' : '#334155', cursor: rv.payable_bills?.length > 0 ? 'pointer' : 'default', fontVariantNumeric: 'tabular-nums' }}
                        onClick={() => rv.payable_bills?.length > 0 && onPayableClick(`${rv.vendor_name} — Outstanding Bills`, rv.payable_bills)}
                        title={rv.payable_bills?.length > 0 ? 'Click to view outstanding bills' : ''}
                      >
                        {rv.payable > 0 ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {formatINR(rv.payable)}
                            {rv.payable_bills?.length > 0 && <span style={{ fontSize: '0.65rem', color: '#ef4444' }}>({rv.payable_bills.length})</span>}
                          </span>
                        ) : '—'}
                      </td>
                      <td
                        style={{ ...VCS.td, textAlign: 'right', color: rv.credits > 0 ? '#4ade80' : '#334155', cursor: rv.credit_details?.length > 0 ? 'pointer' : 'default', fontVariantNumeric: 'tabular-nums' }}
                        onClick={() => rv.credit_details?.length > 0 && onCreditClick(`${rv.vendor_name} — Unused Credits`, rv.credit_details)}
                        title={rv.credit_details?.length > 0 ? 'Click to view unused credits' : ''}
                      >
                        {rv.credits > 0 ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {formatINR(rv.credits)}
                            {rv.credit_details?.length > 0 && <span style={{ fontSize: '0.65rem', color: '#22c55e' }}>({rv.credit_details.length})</span>}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {recurringVendors.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #334155' }}>
                    <td colSpan={6} style={{ ...VCS.td, fontWeight: 700, color: '#f1f5f9', fontSize: '0.85rem', paddingTop: '0.75rem' }}>
                      TOTAL ({recurringVendors.length} recurring vendors)
                    </td>
                    <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 700, color: '#f59e0b', fontSize: '0.95rem', paddingTop: '0.75rem', fontVariantNumeric: 'tabular-nums' }}>
                      {formatINR(recurringVendors.reduce((s, v) => s + (v[expKey] || 0), 0))}
                    </td>
                    <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 700, color: '#ef4444', fontSize: '0.95rem', paddingTop: '0.75rem', fontVariantNumeric: 'tabular-nums' }}>
                      {formatINR(recurringVendors.reduce((s, v) => s + (v.payable || 0), 0))}
                    </td>
                    <td style={{ ...VCS.td, textAlign: 'right', fontWeight: 700, color: '#22c55e', fontSize: '0.95rem', paddingTop: '0.75rem', fontVariantNumeric: 'tabular-nums' }}>
                      {recurringVendors.reduce((s, v) => s + (v.credits || 0), 0) > 0
                        ? formatINR(recurringVendors.reduce((s, v) => s + (v.credits || 0), 0))
                        : '—'}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
