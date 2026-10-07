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

  // Rent report state
  const [rentData,         setRentData]         = useState(null);
  const [rentLoading,      setRentLoading]      = useState(false);
  const [rentBranch,       setRentBranch]       = useState('All Branches');
  const [rentVendor,       setRentVendor]       = useState('All Vendors');
  const [rentVendorCat,    setRentVendorCat]    = useState('All Categories');
  const [rentSubCat,       setRentSubCat]       = useState('All Sub-Categories');
  const [rentFY,           setRentFY]           = useState('current');
  const [rentQuarter,      setRentQuarter]      = useState('all');

  const [recurData,        setRecurData]        = useState(null);
  const [recurLoading,     setRecurLoading]     = useState(false);
  const [recurBranch,      setRecurBranch]      = useState('All Branches');
  const [recurHead,        setRecurHead]        = useState('all');
  const [recurFY,          setRecurFY]          = useState('current');
  const [recurQuarter,     setRecurQuarter]     = useState('all');

  const isLoading = k => loading[k] !== false;

  const loadOne = useCallback((key, fetcher) => {
    setLoading(p => ({ ...p, [key]: true }));
    setErrors(p => ({ ...p, [key]: false }));
    fetcher()
      .then(d => setData(p => ({ ...p, [key]: d })))
      .catch(e => { console.error(key, e); setErrors(p => ({ ...p, [key]: true })); })
      .finally(() => setLoading(p => ({ ...p, [key]: false })));
  }, []);

  const loadRent = useCallback((fy = 'current') => {
    setRentLoading(true);
    setRentBranch('All Branches');
    setRentVendor('All Vendors');
    setRentVendorCat('All Categories');
    setRentSubCat('All Sub-Categories');
    api.purRentMonthwise(fy === 'current' ? null : fy)
      .then(d => setRentData(d))
      .catch(e => console.error('rent-monthwise', e))
      .finally(() => setRentLoading(false));
  }, []);

  const loadRecur = useCallback((fy = 'current') => {
    setRecurLoading(true);
    setRecurBranch('All Branches');
    setRecurHead('all');
    setRecurQuarter('all');
    api.purRecurExpenseReport(fy === 'current' ? null : fy)
      .then(d => setRecurData(d))
      .catch(e => console.error('recur-expense-report', e))
      .finally(() => setRecurLoading(false));
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
    loadRent(rentFY);
    loadRecur(recurFY);
    loadVc();
    loadPo();
  }, [loadOne, loadRent, loadRecur, loadVc, loadPo, rentFY, recurFY]);

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

      {/* ── Month-wise Rent Expense Report ───────────────────────────────── */}
      {p('report_rent') && (
      <RentReport
        data={rentData}
        loading={rentLoading}
        branch={rentBranch}
        onBranchChange={setRentBranch}
        vendor={rentVendor}
        onVendorChange={setRentVendor}
        vendorCategory={rentVendorCat}
        onVendorCategoryChange={setRentVendorCat}
        subCategory={rentSubCat}
        onSubCategoryChange={setRentSubCat}
        fy={rentFY}
        onFYChange={fy => { setRentFY(fy); setRentQuarter('all'); loadRent(fy); }}
        quarter={rentQuarter}
        onQuarterChange={setRentQuarter}
        onRowClick={(title, bills) => openModal(title, bills, billCols)}
      />
      )}

      {/* ── Month-wise & Branch-wise Recurring Expense Report ───────────── */}
      <RecurringExpenseReport
        data={recurData}
        loading={recurLoading}
        branch={recurBranch}
        onBranchChange={setRecurBranch}
        head={recurHead}
        onHeadChange={setRecurHead}
        fy={recurFY}
        onFYChange={fy => { setRecurFY(fy); loadRecur(fy); }}
        quarter={recurQuarter}
        onQuarterChange={setRecurQuarter}
        onCellClick={(title, transactions) => {
          openModal(title, transactions, [
            { label:'Type',    key:'type' },
            { label:'Ref #',   key:'ref' },
            { label:'Vendor/Account', key:'vendor' },
            { label:'Date',    key:'date' },
            { label:'Amount',  key:'amount', format: v => formatINR(v) },
          ]);
        }}
      />

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

      {modal && <Modal title={modal.title} data={modal.rows} columns={modal.columns} onClose={closeModal} />}

      {/* ── Vendor Unused Credits Aging ──────────────────────────────────── */}
      <VendorCreditsAging
        data={vcAgingData}
        loading={vcAgingLoading}
        error={vcAgingError}
        catFilter={vcAgingCatFilter}
        onCatFilter={setVcAgingCatFilter}
        onLoad={loadVcAging}
      />

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

// ─── Rent Report component (pivot format: rows = Branch×Vendor, cols = months) ──
const RENT_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899',
  '#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#eab308',
  '#a855f7','#22c55e','#0ea5e9','#d946ef','#fb923c','#4ade80',
];
// Rent table value colours (same palette as the Vendor Category report)
const RC = { agreed: '#3b82f6', diff: '#8b5cf6', total: '#f59e0b', pos: '#22c55e', neg: '#ef4444', muted: '#64748b', dash: '#9BA8B0' };
const rentDiffColor = d => d > 0 ? RC.pos : d < 0 ? RC.neg : RC.muted;

const QUARTER_MONTHS = { q1:[4,5,6], q2:[7,8,9], q3:[10,11,12], q4:[1,2,3] };
const QUARTER_LABELS = { all:'All Quarters', q1:'Q1 (Apr–Jun)', q2:'Q2 (Jul–Sep)', q3:'Q3 (Oct–Dec)', q4:'Q4 (Jan–Mar)' };

// ─── Recurring Expense Report ─────────────────────────────────────────────────
const HEAD_COLORS = {
  hk_material: '#3b82f6', hk_service: '#8b5cf6', internet: '#06b6d4',
  security: '#f59e0b', tc_machine: '#f97316', tc_milk: '#10b981', electricity: '#ef4444',
};
// Current FY / FY 2025-26 pill toggle, styled like the Vendor Category report's period toggle
function FYToggle({ fy, onChange }) {
  return (
    <div style={VCS.toggleBar}>
      <button style={VCS.toggle(fy === 'current')} onClick={() => onChange('current')}>{fyLabel()}</button>
      <button style={VCS.toggle(fy === 'fy2526')}  onClick={() => onChange('fy2526')}>FY 2025-26</button>
    </div>
  );
}

function RecurringExpenseReport({ data, loading, branch, onBranchChange, head, onHeadChange, fy, onFYChange, quarter, onQuarterChange, onCellClick }) {
  const allMonths   = data?.months     || [];
  const allRows     = data?.rows       || [];
  const allBranches = data?.all_branches || ['All Branches'];
  const allHeads    = data?.heads      || [];

  const qMonthNums  = QUARTER_MONTHS[quarter] || null;
  const months      = qMonthNums ? allMonths.filter(m => qMonthNums.includes(parseInt(m.key.slice(5,7),10))) : allMonths;

  const rows = allRows.filter(r => {
    if (branch !== 'All Branches' && r.branch !== branch) return false;
    if (head   !== 'all'          && r.head_key !== head)  return false;
    return true;
  });

  // Group rows by head_key
  const groups = [];
  let curKey = null, curGroup = [];
  for (const r of rows) {
    if (r.head_key !== curKey) {
      if (curGroup.length) groups.push({ key: curKey, label: curGroup[0].head_label, rows: curGroup });
      curKey = r.head_key; curGroup = [r];
    } else { curGroup.push(r); }
  }
  if (curGroup.length) groups.push({ key: curKey, label: curGroup[0].head_label, rows: curGroup });

  // Chart: expense head totals per month
  const chartData = months.map(m => {
    const pt = { name: m.label };
    for (const h of allHeads) {
      pt[h.key] = rows.filter(r => r.head_key === h.key)
        .reduce((s, r) => s + (r.monthly[m.key]?.amount || 0), 0);
    }
    return pt;
  });

  const fmtAmt = v => v > 0 ? formatINR(v) : '—';
  const fmtMeta = (cell, metaDefs) => metaDefs.map(({ field, label }) => {
    const val = cell[field] || 0;
    return val > 0 ? `${label}: ${field.includes('unit') || field.includes('milk') ? val.toLocaleString('en-IN') : val}` : null;
  }).filter(Boolean).join(' | ');

  const _fmtNum = v => v > 0 ? '₹' + Math.round(v).toLocaleString('en-IN') : '—';

  const exportToCSV = () => {
    const cols = ['Branch', ...months.map(m => m.label), 'Total'];
    const esc  = s => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [cols.map(esc).join(',')];
    for (const { label: hLabel, rows: hRows } of groups) {
      lines.push([esc(`=== ${hLabel} ===`), ...months.map(() => '""'), '""'].join(','));
      for (const r of hRows) {
        const rowTotal = months.reduce((s, m) => s + (r.monthly[m.key]?.amount || 0), 0);
        lines.push([esc(r.branch), ...months.map(m => ((r.monthly[m.key]?.amount || 0).toFixed(2))), rowTotal.toFixed(2)].join(','));
      }
      const gTotal = hRows.reduce((s, r) => s + months.reduce((ms, m) => ms + (r.monthly[m.key]?.amount || 0), 0), 0);
      lines.push([esc(`Sub Total — ${hLabel}`), ...months.map(m => hRows.reduce((s, r) => s + (r.monthly[m.key]?.amount || 0), 0).toFixed(2)), gTotal.toFixed(2)].join(','));
      lines.push('');
    }
    const grandTotal = rows.reduce((s, r) => s + months.reduce((ms, m) => ms + (r.monthly[m.key]?.amount || 0), 0), 0);
    lines.push([esc('GRAND TOTAL'), ...months.map(m => rows.reduce((s, r) => s + (r.monthly[m.key]?.amount || 0), 0).toFixed(2)), grandTotal.toFixed(2)].join(','));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `recurring-expenses-${(data?.fy || 'fy').replace(/\s/g,'-')}-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const exportToPDF = () => {
    const colHeaders = ['Branch', ...months.map(m => m.label), 'Total'];
    let tableRows = '';
    for (const { label: hLabel, rows: hRows } of groups) {
      tableRows += `<tr class="gh"><td colspan="${colHeaders.length}">${hLabel}</td></tr>`;
      for (const r of hRows) {
        const rowTotal = months.reduce((s, m) => s + (r.monthly[m.key]?.amount || 0), 0);
        tableRows += `<tr><td>${r.branch}</td>${months.map(m => `<td>${_fmtNum(r.monthly[m.key]?.amount || 0)}</td>`).join('')}<td class="tot">${_fmtNum(rowTotal)}</td></tr>`;
      }
      const gTotal = hRows.reduce((s, r) => s + months.reduce((ms, m) => ms + (r.monthly[m.key]?.amount || 0), 0), 0);
      tableRows += `<tr class="st"><td>Sub Total — ${hLabel}</td>${months.map(m => `<td>${_fmtNum(hRows.reduce((s, r) => s + (r.monthly[m.key]?.amount || 0), 0))}</td>`).join('')}<td>${_fmtNum(gTotal)}</td></tr>`;
    }
    const grand = rows.reduce((s, r) => s + months.reduce((ms, m) => ms + (r.monthly[m.key]?.amount || 0), 0), 0);
    tableRows += `<tr class="gt"><td>GRAND TOTAL</td>${months.map(m => `<td>${_fmtNum(rows.reduce((s, r) => s + (r.monthly[m.key]?.amount || 0), 0))}</td>`).join('')}<td>${_fmtNum(grand)}</td></tr>`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recurring Expenses — ${data?.fy||''}</title><style>
      body{font-family:Arial,sans-serif;font-size:9px;margin:16px;color:#18191B}
      h2{font-size:13px;margin:0 0 3px}p{font-size:9px;color:#5D6C7B;margin:0 0 10px}
      table{border-collapse:collapse;width:100%}
      th{background:#1C4942;color:#fff;padding:5px 7px;text-align:right;white-space:nowrap;font-size:9px}
      th:first-child{text-align:left;min-width:160px}
      td{padding:3px 7px;text-align:right;border-bottom:1px solid #e2e8f0;white-space:nowrap}
      td:first-child{text-align:left}
      tr.gh td{background:#EAF4EF;color:#1C4942;font-weight:700;text-align:left;padding:5px 7px}
      tr.st td{background:#F0FDF4;color:#15803D;font-weight:700;border-top:1px solid #BBF7D0}
      tr.gt td{background:#1C4942;color:#fff;font-weight:700;font-size:10px;border-top:2px solid #002B31}
      td.tot{color:#B45309;font-weight:700}
      @media print{@page{size:landscape;margin:10mm}body{margin:0}}
    </style></head><body>
    <h2>Month-wise &amp; Branch-wise Recurring Expense Report — ${data?.fy||''}</h2>
    <p>Generated: ${new Date().toLocaleString('en-IN')}${branch!=='All Branches'?' · Branch: '+branch:''}${head!=='all'?' · Head: '+allHeads.find(h=>h.key===head)?.label:''}</p>
    <table><thead><tr>${colHeaders.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table>
    </body></html>`;
    const w = window.open('', '_blank', 'width=1300,height=850');
    w.document.write(html); w.document.close();
    w.addEventListener('load', () => w.print());
  };

  const anyFilter = branch !== 'All Branches' || head !== 'all' || (quarter || 'all') !== 'all';
  const clearAll  = () => { onBranchChange('All Branches'); onHeadChange('all'); onQuarterChange('all'); };
  const monthSum  = (list, key) => list.reduce((s, r) => s + (r.monthly[key]?.amount || 0), 0);
  const grpCell   = { ...VCS.td, ...VCS.num, fontWeight: 700, color: '#f59e0b' };
  const totCell   = { ...grpCell, paddingTop: '0.75rem' };

  return (
    <div style={VCS.card}>
      {/* Header */}
      <div style={VCS.hdr}>
        <h2 style={VCS.title}>Month-wise &amp; Branch-wise Recurring Expense Report</h2>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {data && rows.length > 0 && (
            <>
              <button onClick={exportToCSV} title="Download as CSV (opens in Excel)" style={{ ...VCS.exportBtn, background: '#F0FBF4', color: '#15803D', borderColor: '#BBF7D0' }}>⬇ Excel</button>
              <button onClick={exportToPDF} title="Open printable PDF view" style={{ ...VCS.exportBtn, background: '#FFF7ED', color: '#C2410C', borderColor: '#FED7AA' }}>⬇ PDF</button>
            </>
          )}
          <FYToggle fy={fy} onChange={onFYChange} />
        </div>
      </div>

      {/* Filters */}
      <div style={VCS.filterRow}>
        <span style={VCS.filterLbl}>Filters:</span>
        <select value={branch} onChange={e => onBranchChange(e.target.value)} style={{ ...VCS.select, minWidth: 150, color: branch !== 'All Branches' ? '#1C4942' : '#18191B' }}>
          {allBranches.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={head} onChange={e => onHeadChange(e.target.value)} style={{ ...VCS.select, minWidth: 200, color: head !== 'all' ? HEAD_COLORS[head] || '#18191B' : '#18191B' }}>
          <option value="all">All Expense Heads</option>
          {allHeads.map(h => <option key={h.key} value={h.key}>{h.label}</option>)}
        </select>
        <select value={quarter || 'all'} onChange={e => onQuarterChange(e.target.value)} style={{ ...VCS.select, minWidth: 140, color: (quarter && quarter !== 'all') ? '#7C3AED' : '#18191B' }}>
          {Object.entries(QUARTER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {anyFilter && <button onClick={clearAll} style={VCS.clearBtn}>Clear</button>}
      </div>

      {loading && <div style={VCS.empty}>Loading recurring expense data…</div>}
      {!loading && !data && <div style={VCS.empty}>No data available</div>}
      {!loading && data && rows.length === 0 && <div style={VCS.empty}>No data for selected filters.</div>}

      {!loading && data && rows.length > 0 && (
        <>
          {/* Stacked Bar Chart */}
          {chartData.some(pt => allHeads.some(h => (pt[h.key] || 0) > 0)) && (
            <div style={{ marginBottom: '1rem' }}>
              <p style={VCS.chartLbl}>Monthly Recurring Expense — By Head</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                  <XAxis dataKey="name" tick={{ fill: '#5D6C7B', fontSize: 10 }} axisLine={{ stroke: '#DFE7E3' }} tickLine={false} />
                  <YAxis tickFormatter={v => `₹${(v/100000).toFixed(0)}L`} tick={{ fill: '#5D6C7B', fontSize: 10 }} axisLine={false} tickLine={false} width={55} />
                  <Tooltip formatter={(v, name) => [formatINR(v), allHeads.find(h => h.key === name)?.label || name]} contentStyle={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, fontSize: '0.8rem' }} labelStyle={{ color: '#5D6C7B' }} cursor={{ fill: 'rgba(28,73,66,0.06)' }} />
                  {allHeads.filter(h => head === 'all' || h.key === head).map((h, i) => (
                    <Bar key={h.key} dataKey={h.key} stackId="a" fill={HEAD_COLORS[h.key] || COLORS[i % COLORS.length]} radius={i === allHeads.length - 1 ? [3,3,0,0] : [0,0,0,0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <div style={VCS.legend}>
                {allHeads.filter(h => head === 'all' || h.key === head).map(h => (
                  <span key={h.key} style={VCS.legendItem}>
                    <span style={{ ...VCS.legendSwatch, background: HEAD_COLORS[h.key] || '#9BA8B0' }} />{h.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Pivot Table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 700 }}>
              <thead>
                <tr>
                  <th style={{ ...VCS.th, minWidth: 220 }}>Expense Head / Branch</th>
                  {months.map(m => <th key={m.key} style={{ ...VCS.th, textAlign: 'right', minWidth: 110 }}>{m.label}</th>)}
                  <th style={{ ...VCS.th, textAlign: 'right', minWidth: 120, color: '#f59e0b' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(({ key: hKey, label: hLabel, rows: hRows }) => {
                  const metaDefs   = allHeads.find(h => h.key === hKey)?.meta || [];
                  const headColor  = HEAD_COLORS[hKey] || '#64748b';
                  const groupTotal = months.reduce((s, m) => s + monthSum(hRows, m.key), 0);
                  return (
                    <React.Fragment key={hKey}>
                      {/* Expense head row */}
                      <tr style={VCS.grpRow}>
                        <td style={{ ...VCS.td, fontWeight: 700, color: headColor, whiteSpace: 'nowrap' }}>
                          <span style={{ ...VCS.dot, background: headColor }} />
                          {hLabel}
                          <span style={VCS.count}>({hRows.length} branch{hRows.length !== 1 ? 'es' : ''})</span>
                        </td>
                        {months.map(m => <td key={m.key} style={grpCell}>{fmtAmt(monthSum(hRows, m.key))}</td>)}
                        <td style={grpCell}>{fmtAmt(groupTotal)}</td>
                      </tr>
                      {/* Branch rows */}
                      {hRows.map((r, i) => {
                        const rowTotal = months.reduce((s, m) => s + (r.monthly[m.key]?.amount || 0), 0);
                        return (
                          <tr key={`${hKey}|||${r.branch}`} style={VCS.vendRow(i)}>
                            <td style={{ ...VCS.td, paddingLeft: '1.75rem', color: '#5D6C7B', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>↳ {r.branch}</td>
                            {months.map(m => {
                              const cell = r.monthly[m.key] || { amount: 0, transactions: [] };
                              const meta = fmtMeta(cell, metaDefs);
                              const txns = cell.transactions || [];
                              return (
                                <td key={m.key} title={meta || undefined}
                                  onClick={() => txns.length > 0 && onCellClick(`${hLabel} — ${r.branch} — ${m.label}`, txns)}
                                  style={{ ...VCS.td, ...VCS.num, fontSize: '0.82rem', verticalAlign: 'top', cursor: txns.length > 0 ? 'pointer' : 'default' }}>
                                  {cell.amount > 0 ? (
                                    <>
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                        {formatINR(cell.amount)}{txns.length > 0 && <span style={{ fontSize: '0.62rem', color: '#3b82f6' }}>({txns.length})</span>}
                                      </span>
                                      {meta && <div style={{ fontSize: '0.65rem', color: '#9BA8B0', marginTop: 2 }}>{meta}</div>}
                                    </>
                                  ) : <span style={{ color: '#9BA8B0' }}>—</span>}
                                </td>
                              );
                            })}
                            <td style={{ ...VCS.td, ...VCS.num, fontSize: '0.82rem', fontWeight: 600, color: '#f59e0b' }}>{fmtAmt(rowTotal)}</td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #DFE7E3' }}>
                  <td style={{ ...VCS.td, fontWeight: 700, color: '#18191B', paddingTop: '0.75rem' }}>GRAND TOTAL</td>
                  {months.map(m => <td key={m.key} style={totCell}>{fmtAmt(monthSum(rows, m.key))}</td>)}
                  <td style={{ ...totCell, fontSize: '0.95rem' }}>{fmtAmt(months.reduce((s, m) => s + monthSum(rows, m.key), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function RentReport({ data, loading, branch, onBranchChange, vendor, onVendorChange, vendorCategory, onVendorCategoryChange, subCategory, onSubCategoryChange, fy, onFYChange, quarter, onQuarterChange, onRowClick }) {
  const allMonths            = data?.months               || [];
  const allRows              = data?.rows                 || [];
  const allBranches          = data?.all_branches         || ['All Branches'];
  const allVendors           = data?.all_vendors          || ['All Vendors'];
  const allVendorCategories  = data?.all_vendor_categories || ['All Categories'];
  const allSubCategories     = data?.all_sub_categories   || ['All Sub-Categories'];

  // Filter months by selected quarter (client-side)
  const qMonthNums = QUARTER_MONTHS[quarter] || null;
  const months = qMonthNums
    ? allMonths.filter(m => qMonthNums.includes(parseInt(m.key.slice(5, 7), 10)))
    : allMonths;

  // Apply all active filters
  const visibleRows = allRows.filter(r => {
    if (branch         !== 'All Branches'      && r.branch_full      !== branch)         return false;
    if (vendor         !== 'All Vendors'        && r.vendor           !== vendor)         return false;
    if (vendorCategory !== 'All Categories'     && r.vendor_category  !== vendorCategory) return false;
    if (subCategory    !== 'All Sub-Categories' && r.sub_category     !== subCategory)    return false;
    return true;
  });

  const anyFilterActive = branch !== 'All Branches' || vendor !== 'All Vendors' ||
                          vendorCategory !== 'All Categories' || subCategory !== 'All Sub-Categories' ||
                          (quarter || 'all') !== 'all';
  const clearFilters = () => {
    onBranchChange('All Branches');
    onVendorChange('All Vendors');
    onVendorCategoryChange('All Categories');
    onSubCategoryChange('All Sub-Categories');
    onQuarterChange('all');
  };

  // Recalculate totals for visible rows (scoped to visible months for quarter)
  const monthlyTotals = Object.fromEntries(
    months.map(m => [m.key, visibleRows.reduce((s, r) => s + (r.monthly[m.key] || 0), 0)])
  );
  const grandTotal = visibleRows.reduce((s, r) =>
    s + months.reduce((ms, m) => ms + (r.monthly[m.key] || 0), 0), 0);

  const agreedMonthlyTotals = Object.fromEntries(
    months.map(m => [m.key, visibleRows.reduce((s, r) => s + (r.agreed_monthly?.[m.key] || 0), 0)])
  );
  const agreedGrandTotal = visibleRows.reduce((s, r) =>
    s + months.reduce((ms, m) => ms + (r.agreed_monthly?.[m.key] || 0), 0), 0);

  // Chart: stacked bar by branch (top 8 + Others)
  const branchColorMap = {};
  [...new Set(allRows.map(r => r.branch_full))].sort().forEach((br, i) => {
    branchColorMap[br] = RENT_COLORS[i % RENT_COLORS.length];
  });

  const chartBranches = [...new Set(visibleRows.map(r => r.branch_full))].sort();
  const topChartBranches = chartBranches.slice(0, 10);
  const hasOther = chartBranches.length > 10;

  const chartData = months.map(m => {
    const point = { name: m.label };
    for (const br of topChartBranches) {
      point[br] = visibleRows.filter(r => r.branch_full === br).reduce((s, r) => s + (r.monthly[m.key] || 0), 0);
    }
    if (hasOther) {
      point['Other'] = visibleRows.filter(r => !topChartBranches.includes(r.branch_full)).reduce((s, r) => s + (r.monthly[m.key] || 0), 0);
    }
    return point;
  });

  const stackKeys = hasOther ? [...topChartBranches, 'Other'] : topChartBranches;

  const TT = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const total = payload.reduce((s, p) => s + (p.value || 0), 0);
    return (
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.75rem 1rem', fontSize: '0.8rem', maxWidth: 260, boxShadow: '0 2px 8px rgba(0,18,20,0.1)' }}>
        <p style={{ color: '#5D6C7B', margin: '0 0 6px', fontWeight: 600 }}>{label}</p>
        {payload.slice().reverse().map(p => (
          <p key={p.dataKey} style={{ color: p.fill, margin: '2px 0', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ color: '#5D6C7B', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.dataKey}</span>
            <span style={{ fontWeight: 600 }}>{formatINR(p.value)}</span>
          </p>
        ))}
        <p style={{ color: RC.total, margin: '6px 0 0', fontWeight: 700, borderTop: '1px solid #DFE7E3', paddingTop: 4 }}>Total: {formatINR(total)}</p>
      </div>
    );
  };

  // Group consecutive rows by branch
  const groups = [];
  for (const row of visibleRows) {
    const last = groups[groups.length - 1];
    if (last && last.branch === row.branch_full) last.rows.push(row);
    else groups.push({ branch: row.branch_full, rows: [row] });
  }

  const grpCell = { ...VCS.td, ...VCS.num, fontWeight: 700 };
  const totCell = { ...grpCell, paddingTop: '0.75rem' };

  // Agreed / Actual / Diff cells for a branch or grand-total row
  const sumCells = (key, agr, act, base) => {
    const shown = agr > 0 || act > 0;
    return [
      <td key={`${key}-agr`} style={{ ...base, color: agr > 0 ? RC.agreed : RC.dash }}>{agr > 0 ? formatINR(agr) : '—'}</td>,
      <td key={`${key}-act`} style={{ ...base, color: act > 0 ? RC.total : RC.dash }}>{act > 0 ? formatINR(act) : '—'}</td>,
      <td key={`${key}-dif`} style={{ ...base, color: shown ? rentDiffColor(agr - act) : RC.dash }}>{shown ? formatINR(agr - act) : '—'}</td>,
    ];
  };

  return (
    <div style={VCS.card}>
      {/* ── Header ── */}
      <div style={VCS.hdr}>
        <h2 style={VCS.title}>Month-wise Rent Expense Report</h2>
        <FYToggle fy={fy} onChange={onFYChange} />
      </div>

      {/* ── Filters ── */}
      <div style={VCS.filterRow}>
        <span style={VCS.filterLbl}>Filters:</span>
        <select value={branch} onChange={e => onBranchChange(e.target.value)} style={{ ...VCS.select, minWidth: 160, color: branch !== 'All Branches' ? '#1C4942' : '#18191B' }}>
          {allBranches.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={vendor} onChange={e => onVendorChange(e.target.value)} style={{ ...VCS.select, minWidth: 200 }}>
          {allVendors.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={vendorCategory} onChange={e => onVendorCategoryChange(e.target.value)} style={{ ...VCS.select, minWidth: 140 }}>
          {allVendorCategories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={subCategory} onChange={e => onSubCategoryChange(e.target.value)} style={{ ...VCS.select, minWidth: 180 }}>
          {allSubCategories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={quarter || 'all'} onChange={e => onQuarterChange(e.target.value)} style={{ ...VCS.select, minWidth: 140, color: (quarter && quarter !== 'all') ? '#7C3AED' : '#18191B' }}>
          {Object.entries(QUARTER_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        {anyFilterActive && <button onClick={clearFilters} style={VCS.clearBtn}>Clear</button>}
      </div>

      {!loading && data?.details_pending > 0 && (
        <div style={VCS.notice}>
          Fetching exact bill amounts from Zoho — {data.details_pending} bill{data.details_pending !== 1 ? 's' : ''} currently show an estimate. Refresh in a few minutes.
        </div>
      )}

      {loading && <div style={VCS.empty}>Loading rent data…</div>}
      {!loading && !data && <div style={VCS.empty}>No data available</div>}

      {!loading && data && (
        <>
          {/* ── Stacked Bar Chart ── */}
          {chartData.some(pt => stackKeys.some(k => (pt[k] || 0) > 0)) && (
            <div style={{ marginBottom: '1rem' }}>
              <p style={VCS.chartLbl}>Monthly Rent — Branch Breakdown</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                  <XAxis dataKey="name" tick={{ fill: '#5D6C7B', fontSize: 10 }} axisLine={{ stroke: '#DFE7E3' }} tickLine={false} />
                  <YAxis tickFormatter={v => `₹${(v / 100000).toFixed(0)}L`} tick={{ fill: '#5D6C7B', fontSize: 10 }} axisLine={false} tickLine={false} width={55} />
                  <Tooltip content={<TT />} cursor={{ fill: 'rgba(28,73,66,0.06)' }} />
                  {stackKeys.map((br, i) => (
                    <Bar key={br} dataKey={br} stackId="a" fill={br === 'Other' ? '#C9D3D8' : (branchColorMap[br] || RENT_COLORS[i % RENT_COLORS.length])} radius={i === stackKeys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              <div style={VCS.legend}>
                {stackKeys.map((br, i) => (
                  <span key={br} style={VCS.legendItem}>
                    <span style={{ ...VCS.legendSwatch, background: br === 'Other' ? '#C9D3D8' : (branchColorMap[br] || RENT_COLORS[i % RENT_COLORS.length]) }} />
                    {br}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── Pivot Table ── */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', minWidth: 900 }}>
              <thead>
                <tr>
                  <th rowSpan={2} style={{ ...VCS.th, minWidth: 220, verticalAlign: 'bottom' }}>Branch / Office No.</th>
                  <th rowSpan={2} style={{ ...VCS.th, minWidth: 180, verticalAlign: 'bottom' }}>Developer Name</th>
                  {months.map(m => (
                    <th key={m.key} colSpan={3} style={{ ...VCS.th, textAlign: 'center', minWidth: 240, color: '#18191B' }}>{m.label}</th>
                  ))}
                  <th colSpan={3} style={{ ...VCS.th, textAlign: 'center', minWidth: 255, color: RC.total }}>Total</th>
                </tr>
                <tr>
                  {[...months.map(m => m.key), 'total'].flatMap(k => [
                    <th key={`${k}-agr`} style={{ ...VCS.th, textAlign: 'right', minWidth: 80, color: RC.agreed }}>Agreed</th>,
                    <th key={`${k}-act`} style={{ ...VCS.th, textAlign: 'right', minWidth: 80 }}>Actual</th>,
                    <th key={`${k}-dif`} style={{ ...VCS.th, textAlign: 'right', minWidth: 80, color: RC.diff }}>Diff.</th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 && (
                  <tr><td colSpan={2 + months.length * 3 + 3} style={{ ...VCS.td, textAlign: 'center', color: '#475569', padding: '2rem' }}>No data for selected filters</td></tr>
                )}
                {groups.map(({ branch: br, rows }) => {
                  const brColor   = branchColorMap[br] || '#64748b';
                  const bAgrTotal = rows.reduce((s, r) => s + months.reduce((ms, m) => ms + (r.agreed_monthly?.[m.key] || 0), 0), 0);
                  const bActTotal = rows.reduce((s, r) => s + months.reduce((ms, m) => ms + (r.monthly[m.key] || 0), 0), 0);
                  return (
                    <React.Fragment key={br}>
                      {/* Branch row */}
                      <tr style={VCS.grpRow}>
                        <td colSpan={2} style={{ ...VCS.td, fontWeight: 700, color: brColor, whiteSpace: 'nowrap' }}>
                          <span style={{ ...VCS.dot, background: brColor }} />
                          {br}
                          <span style={VCS.count}>({rows.length} developer{rows.length !== 1 ? 's' : ''})</span>
                        </td>
                        {months.flatMap(m => sumCells(
                          m.key,
                          rows.reduce((s, r) => s + (r.agreed_monthly?.[m.key] || 0), 0),
                          rows.reduce((s, r) => s + (r.monthly[m.key] || 0), 0),
                          grpCell,
                        ))}
                        {sumCells('total', bAgrTotal, bActTotal, grpCell)}
                      </tr>

                      {/* Office rows */}
                      {rows.map((row, i) => {
                        const rowActTotal = months.reduce((s, m) => s + (row.monthly[m.key] || 0), 0);
                        const rowAgrTotal = months.reduce((s, m) => s + (row.agreed_monthly?.[m.key] || 0), 0);
                        const hasAgr = months.some(m => row.agreed_monthly?.[m.key] != null);
                        const cell = { ...VCS.td, ...VCS.num, fontSize: '0.82rem' };
                        return (
                          <tr key={`${row.branch_full}|||${row.vendor}`} style={VCS.vendRow(i)}>
                            <td style={{ ...VCS.td, paddingLeft: '1.75rem', color: '#18191B', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>↳ {row.office || '—'}</td>
                            <td style={{ ...VCS.td, color: '#5D6C7B', fontSize: '0.8rem' }}>{row.vendor}</td>
                            {months.flatMap(m => {
                              const amt   = row.monthly[m.key] || 0;
                              const agr   = row.agreed_monthly?.[m.key];
                              const diff  = agr != null ? agr - amt : null;
                              const bills = row.bills_by_month?.[m.key] || [];
                              return [
                                <td key={`${m.key}-agr`} style={{ ...cell, color: agr != null ? RC.agreed : RC.dash }}>
                                  {agr != null ? formatINR(agr) : '—'}
                                </td>,
                                <td key={`${m.key}-act`}
                                  onClick={() => amt > 0 && onRowClick(`${row.office} — ${m.label}`, bills)}
                                  style={{ ...cell, color: amt > 0 ? '#18191B' : RC.dash, cursor: amt > 0 ? 'pointer' : 'default' }}>
                                  {amt > 0 ? formatINR(amt) : '—'}
                                </td>,
                                <td key={`${m.key}-dif`} style={{ ...cell, color: diff != null ? rentDiffColor(diff) : RC.dash }}>
                                  {diff != null ? formatINR(diff) : '—'}
                                </td>,
                              ];
                            })}
                            <td style={{ ...cell, fontWeight: 600, color: hasAgr ? RC.agreed : RC.dash }}>
                              {hasAgr ? formatINR(rowAgrTotal) : '—'}
                            </td>
                            <td style={{ ...cell, fontWeight: 600, color: RC.total }}>
                              {formatINR(rowActTotal)}
                            </td>
                            <td style={{ ...cell, fontWeight: 600, color: hasAgr ? rentDiffColor(rowAgrTotal - rowActTotal) : RC.dash }}>
                              {hasAgr ? formatINR(rowAgrTotal - rowActTotal) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
              {visibleRows.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #DFE7E3' }}>
                    <td colSpan={2} style={{ ...VCS.td, fontWeight: 700, color: '#18191B', paddingTop: '0.75rem' }}>GRAND TOTAL</td>
                    {months.flatMap(m => sumCells(m.key, agreedMonthlyTotals[m.key] || 0, monthlyTotals[m.key] || 0, totCell))}
                    {sumCells('total', agreedGrandTotal, grandTotal, { ...totCell, fontSize: '0.95rem' })}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
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

const VCS = {
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
