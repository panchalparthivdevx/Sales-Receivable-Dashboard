import React, { useEffect, useState, useCallback } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend
} from 'recharts';
import {
  Clock, FileText, TrendingUp, DollarSign, AlertCircle,
  RefreshCw, Building2, Users, MapPin, Award
} from 'lucide-react';
import { api } from '../utils/api';
import DataFreshness from '../components/DataFreshness';
import { formatINR, formatNumber, formatDate } from '../utils/format';
import KPICard from '../components/KPICard';
import ChartCard from '../components/ChartCard';
import Modal from '../components/Modal';
import ClientDelayReport from '../components/ClientDelayReport';
import ARRatios from '../components/ARRatios';
import OccupancyReport from '../components/OccupancyReport';
import ARAgingReport from '../components/ARAgingReport';
import AgreementExpiry from '../components/AgreementExpiry';
import ForexReport from '../components/ForexReport';
import TopCustomerRevenueReport from '../components/TopCustomerRevenueReport';
import OperationalDataReport from '../components/OperationalDataReport';
import EscrowCollectionReport from '../components/EscrowCollectionReport';
import { useAuth } from '../contexts/AuthContext';

const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#84cc16', '#f97316'];

const monthLabel = () => new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' });

export default function Dashboard() {
  const { hasPerm } = useAuth();
  const p = (key) => hasPerm('sales', key);

  const [loading, setLoading] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState({});

  const isLoading = (key) => loading[key] !== false;
  const [modal, setModal] = useState(null);
  const [catToggle, setCatToggle] = useState('This Month');
  const [tierToggle, setTierToggle] = useState('This Month');
  const [cityToggle, setCityToggle] = useState('This Month');

  const fyLabel = () => {
    const now = new Date();
    const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `FY ${fyYear}-${String(fyYear + 1).slice(2)}`;
  };

  const loadOne = useCallback((key, fetcher) => {
    setLoading(prev => ({ ...prev, [key]: true }));
    fetcher()
      .then(d => setData(prev => ({ ...prev, [key]: d })))
      .catch(e => console.error(key, e))
      .finally(() => setLoading(prev => ({ ...prev, [key]: false })));
  }, []);

  const loadAll = useCallback(async (bust = false) => {
    if (bust) { setRefreshing(true); await api.clearCache(); setRefreshing(false); }
    loadOne('delay',      api.avgDelay);
    loadOne('invCount',   api.invoiceCount);
    loadOne('revenue',    api.revenue);
    loadOne('collections',api.collections);
    loadOne('receivables',api.receivables);
    loadOne('category',   api.revenueByCategory);
    loadOne('tier',       api.revenueByTier);
    loadOne('city',       api.revenueByCity);
    loadOne('branch',     api.branchOutstanding);
    loadOne('clients',    api.topClients);
  }, [loadOne]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const openModal = (title, rows, columns) => setModal({ title, rows, columns });
  const closeModal = () => setModal(null);

  // ── Modal column definitions ──────────────────────────────────────────────
  const invoiceDetailCols = [
    { key: 'invoice_number', label: 'Invoice #' },
    { key: 'customer_name', label: 'Customer' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'sub_total', label: 'Amount (ex-tax)', type: 'currency', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ];

  const receivableDetailCols = [
    { key: 'invoice_number', label: 'Invoice #' },
    { key: 'customer_name', label: 'Customer' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'due_date', label: 'Due Date', type: 'date' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'balance', label: 'Balance', type: 'currency', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ];

  const collectionCols = [
    { key: 'customer_name', label: 'Customer' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'payment_date', label: 'Payment Date', type: 'date' },
    { key: 'payment_mode', label: 'Mode' },
    { key: 'reference_number', label: 'Reference #' },
    { key: 'invoice_numbers', label: 'Invoice(s)' },
    { key: 'amount', label: 'Amount', type: 'currency', align: 'right' },
  ];

  const cnCols = [
    { key: 'creditnote_number', label: 'Credit Note #' },
    { key: 'customer_name', label: 'Customer' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'applied_amount', label: 'Applied Against Invoice', type: 'currency', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ];

  const delayCols = [
    { key: 'invoice_number', label: 'Invoice #' },
    { key: 'customer_name', label: 'Customer' },
    { key: 'due_date', label: 'Due Date', type: 'date' },
    { key: 'payment_date', label: 'Paid On', type: 'date' },
    { key: 'delay_days', label: 'Delay (Days)', align: 'right' },
    { key: 'amount', label: 'Amount', type: 'currency', align: 'right' },
  ];

  const branchCols = [
    { key: 'branch_name', label: 'Branch' },
    { key: 'invoice_count', label: '# Invoices', align: 'right' },
    { key: 'total_outstanding', label: 'Outstanding', type: 'currency', align: 'right' },
  ];

  const clientCols = [
    { key: 'customer_name', label: 'Client' },
    { key: 'invoice_count', label: '# Invoices', align: 'right' },
    { key: 'revenue', label: 'Revenue', type: 'currency', align: 'right' },
    { key: 'outstanding', label: 'Outstanding', type: 'currency', align: 'right' },
  ];

  const branchInvCols = [
    { key: 'invoice_number', label: 'Invoice #' },
    { key: 'customer_name', label: 'Customer' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'due_date', label: 'Due Date', type: 'date' },
    { key: 'balance', label: 'Balance', type: 'currency', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ];

  // ── Chart helpers ─────────────────────────────────────────────────────────
  const catData = data.category ? (catToggle === 'This Month' ? data.category.this_month : data.category.all_time) || [] : [];
  const tierData = data.tier ? (tierToggle === 'This Month' ? data.tier.this_month : data.tier.all_time) || [] : [];
  const cityData = data.city ? (cityToggle === 'This Month' ? data.city.this_month : data.city.all_time) || [] : [];

  const CustomTooltip = ({ active, payload, label, type }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.75rem', fontSize: '0.85rem', boxShadow: '0 2px 8px rgba(0,18,20,0.1)' }}>
        <p style={{ color: '#5D6C7B', margin: 0 }}>{label || payload[0]?.name}</p>
        <p style={{ color: '#18191B', margin: '4px 0 0', fontWeight: 600 }}>
          {type === 'count' ? formatNumber(payload[0]?.value) : formatINR(payload[0]?.value)}
        </p>
      </div>
    );
  };

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.heading}>Sales & Receivable Dashboard</h1>
          <p style={styles.subheading}>Dev Accelerator Limited · {monthLabel()}</p>
          <DataFreshness entities={['invoices_fy', 'invoices_unpaid', 'customer_payments_fy', 'credit_notes_fy']} />
        </div>
        <button style={{ ...styles.refreshBtn, opacity: refreshing ? 0.6 : 1 }} onClick={() => loadAll(true)} disabled={refreshing}>
          <RefreshCw size={16} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* ── Row 1: KPI Cards ────────────────────────────────────────────────── */}
      <div style={styles.kpiGrid}>
        {p('kpi_avg_delay') && <KPICard
          title="Avg. Payment Delay"
          value={isLoading('delay') ? '...' : `${data.delay?.avg_delay_days ?? 0} Days`}
          subValue={isLoading('delay') ? '...' : `${data.delay?.total_payments_analyzed ?? 0} payments`}
          subLabel="Past 12 months"
          icon={Clock} color="#f59e0b" loading={isLoading('delay')}
          onClick={() => openModal('Payment Delay Detail (Past 12 Months)', data.delay?.detail || [], delayCols)}
        />}
        {p('kpi_invoice_count') && <KPICard
          title={`Invoices Sent — ${monthLabel()}`}
          value={isLoading('invCount') ? '...' : formatNumber(data.invCount?.this_month)}
          subValue={isLoading('invCount') ? '...' : formatNumber(data.invCount?.this_fy)}
          subLabel={`Total ${fyLabel()}`}
          icon={FileText} color="#3b82f6" loading={isLoading('invCount')}
          onClick={() => openModal(`Invoices — ${monthLabel()}`, data.invCount?.this_month_detail || [], invoiceDetailCols)}
        />}
        {p('kpi_revenue') && <KPICard
          title={`Revenue — ${monthLabel()}`}
          value={isLoading('revenue') ? '...' : formatINR(data.revenue?.this_month)}
          subValue={isLoading('revenue') ? '...' : formatINR(data.revenue?.this_fy)}
          subLabel={`${fyLabel()} total`}
          icon={TrendingUp} color="#10b981" loading={isLoading('revenue')}
          onClick={() => openModal(`Revenue Detail — ${monthLabel()}`, data.revenue?.this_month_detail || [], invoiceDetailCols)}
        />}
        {p('kpi_revenue') && <KPICard
          title={`Total Revenue — ${fyLabel()}`}
          value={isLoading('revenue') ? '...' : formatINR(data.revenue?.this_fy)}
          icon={DollarSign} color="#8b5cf6" loading={isLoading('revenue')}
          onClick={() => openModal(`All Revenue — ${fyLabel()}`, data.revenue?.this_fy_detail || [], invoiceDetailCols)}
        />}
        {p('kpi_collections') && <KPICard
          title="Today's Collection"
          value={isLoading('collections') ? '...' : formatINR(data.collections?.today)}
          subValue={isLoading('collections') ? '...' : `${data.collections?.today_detail?.length ?? 0} payments`}
          subLabel="Actual bank deposits only"
          icon={DollarSign} color="#22c55e" loading={isLoading('collections')}
          onClick={() => openModal("Today's Collection — Bank Payments", data.collections?.today_detail || [], collectionCols)}
        />}
        {p('kpi_collections') && <KPICard
          title={`Collection — ${monthLabel()}`}
          value={isLoading('collections') ? '...' : formatINR(data.collections?.this_month)}
          subValue={isLoading('collections') ? '...' : `${data.collections?.this_month_detail?.length ?? 0} payments`}
          subLabel="Actual bank deposits only"
          icon={TrendingUp} color="#84cc16" loading={isLoading('collections')}
          onClick={() => openModal(`Collection — ${monthLabel()} (Bank Payments)`, data.collections?.this_month_detail || [], collectionCols)}
        />}
        {p('kpi_collections') && <KPICard
          title="Credit Notes — Today"
          value={isLoading('collections') ? '...' : formatINR(data.collections?.today_credit_notes)}
          subValue={isLoading('collections') ? '...' : formatINR(data.collections?.month_credit_notes)}
          subLabel={`${monthLabel()} total`}
          icon={FileText} color="#f59e0b" loading={isLoading('collections')}
          onClick={() => openModal(
            (data.collections?.today_credit_notes ?? 0) > 0
              ? "Credit Notes — Today"
              : `Credit Notes — ${monthLabel()}`,
            (data.collections?.today_credit_notes ?? 0) > 0
              ? (data.collections?.today_cn_detail || [])
              : (data.collections?.month_cn_detail || []),
            cnCols
          )}
        />}
        {p('kpi_receivables') && <KPICard
          title={`Receivable — ${monthLabel()}`}
          value={isLoading('receivables') ? '...' : formatINR(data.receivables?.this_month)}
          subValue={isLoading('receivables') ? '...' : formatINR(data.receivables?.all_time)}
          subLabel="Total as on date"
          icon={AlertCircle} color="#ef4444" loading={isLoading('receivables')}
          onClick={() => openModal(`Receivables — ${monthLabel()}`, data.receivables?.this_month_detail || [], receivableDetailCols)}
        />}
        {p('kpi_receivables') && <KPICard
          title="Total Receivable as on Date"
          value={isLoading('receivables') ? '...' : formatINR(data.receivables?.all_time)}
          icon={DollarSign} color="#06b6d4" loading={isLoading('receivables')}
          onClick={() => openModal('All Receivables — As on Date', data.receivables?.all_time_detail || [], receivableDetailCols)}
        />}
      </div>

      {/* ── Row 2: Category + Tier ──────────────────────────────────────────── */}
      {(p('chart_rev_category') || p('chart_rev_tier')) && (
      <div style={styles.twoCol}>
        {p('chart_rev_category') && <ChartCard title="Revenue by Invoice Category" toggle={catToggle} onToggle={setCatToggle} toggleOptions={['This Month', fyLabel()]} loading={isLoading('category')}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={catData} layout="vertical" margin={{ left: 20 }}>
              <XAxis type="number" tickFormatter={v => `₹${(v / 100000).toFixed(0)}L`} tick={{ fill: '#5D6C7B', fontSize: 11 }} />
              <YAxis dataKey="category" type="category" tick={{ fill: '#18191B', fontSize: 11 }} width={130} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="revenue" radius={[0, 4, 4, 0]} onClick={(d) => openModal(`${d.category} — Invoices`, d.invoices || [], invoiceDetailCols)} style={{ cursor: 'pointer' }}>
                {catData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>}

        {p('chart_rev_tier') && <ChartCard title="Tier wise Revenue" toggle={tierToggle} onToggle={setTierToggle} toggleOptions={['This Month', fyLabel()]} loading={isLoading('tier')}>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={tierData} dataKey="revenue" nameKey="tier" cx="50%" cy="50%" outerRadius={90}
                onClick={(d) => openModal(`${d.tier} — Invoices`, d.invoices || [], invoiceDetailCols)}
                style={{ cursor: 'pointer' }}>
                {tierData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => formatINR(v)} />
              <Legend formatter={(v) => <span style={{ color: '#cbd5e1', fontSize: '0.8rem' }}>{v}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>}
      </div>
      )}

      {/* ── Row 3: City + Top Clients ───────────────────────────────────────── */}
      {(p('chart_rev_city') || p('chart_top_clients')) && (
      <div style={styles.twoCol}>
        {p('chart_rev_city') && <ChartCard title="City wise Revenue" toggle={cityToggle} onToggle={setCityToggle} toggleOptions={['This Month', fyLabel()]} loading={isLoading('city')}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={cityData}>
              <XAxis dataKey="city" tick={{ fill: '#18191B', fontSize: 11 }} />
              <YAxis tickFormatter={v => `₹${(v / 100000).toFixed(0)}L`} tick={{ fill: '#5D6C7B', fontSize: 11 }} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="revenue" radius={[4, 4, 0, 0]}
                onClick={(d) => openModal(`${d.city} — Invoices`, d.invoices || [], invoiceDetailCols)}
                style={{ cursor: 'pointer' }}>
                {cityData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>}

        {p('chart_top_clients') && <ChartCard title="Top 10 Clients by Revenue" loading={isLoading('clients')}>
          {!isLoading('clients') && (
            <div style={{ overflowY: 'auto', maxHeight: '260px' }}>
              {(data.clients || []).map((c, i) => (
                <div key={i} style={styles.clientRow}
                  onClick={() => openModal(`${c.customer_name} — Invoice History`, c.invoices || [], [
                    { key: 'invoice_number', label: 'Invoice #' },
                    { key: 'date', label: 'Date', type: 'date' },
                    { key: 'sub_total', label: 'Revenue', type: 'currency', align: 'right' },
                    { key: 'balance', label: 'Balance', type: 'currency', align: 'right' },
                    { key: 'branch_name', label: 'Branch' },
                    { key: 'status', label: 'Status', type: 'status' },
                  ])}>
                  <span style={styles.clientRank}>#{i + 1}</span>
                  <span style={styles.clientName}>{c.customer_name}</span>
                  <span style={styles.clientAmt}>{formatINR(c.revenue)}</span>
                </div>
              ))}
            </div>
          )}
        </ChartCard>}
      </div>
      )}

      {/* ── Row 4: Branch Outstanding Table ────────────────────────────────── */}
      {p('chart_branch_outstanding') && (
      <ChartCard title="Branch wise Outstanding as on Date" loading={isLoading('branch')}>
        {!isLoading('branch') && (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {['Branch', 'No. of Invoices', 'Total Outstanding'].map(h => (
                    <th key={h} style={{ ...styles.th, textAlign: h === 'Branch' ? 'left' : 'right' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.branch || []).map((b, i) => (
                  <tr key={i} style={{ cursor: 'pointer' }}
                    onClick={() => openModal(`${b.branch_name} — Outstanding Invoices`, b.invoices || [], branchInvCols)}>
                    <td style={styles.td}><span style={styles.branchName}><Building2 size={13} style={{ marginRight: 6 }} />{b.branch_name}</span></td>
                    <td style={{ ...styles.td, textAlign: 'right', color: '#94a3b8' }}>{b.invoice_count}</td>
                    <td style={{ ...styles.td, textAlign: 'right', color: '#ef4444', fontWeight: 600 }}>{formatINR(b.total_outstanding)}</td>
                  </tr>
                ))}
                {(data.branch || []).length > 0 && (
                  <tr style={{ borderTop: '2px solid #DFE7E3' }}>
                    <td style={{ ...styles.td, fontWeight: 700, color: '#18191B' }}>TOTAL</td>
                    <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600 }}>
                      {(data.branch || []).reduce((s, b) => s + b.invoice_count, 0)}
                    </td>
                    <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700, color: '#ef4444', fontSize: '1rem' }}>
                      {formatINR((data.branch || []).reduce((s, b) => s + b.total_outstanding, 0))}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>
      )}

      {/* ── Row 5: Analytical Ratios ────────────────────────────────────── */}
      {p('kpi_ar_ratios') && <ARRatios />}

      {/* ── Row 6: Client Payment Delay Report ─────────────────────────── */}
      {p('chart_payment_delay') && (
        <div style={{ borderTop: '1px solid #DFE7E3', marginTop: '0.5rem', paddingTop: '1.25rem' }}>
          <ClientDelayReport />
        </div>
      )}

      {/* ── Row 7: Seat Occupancy Report ─────────────────────────────────── */}
      {p('kpi_occupancy') && (
        <div style={{ borderTop: '1px solid #DFE7E3', marginTop: '0.5rem', paddingTop: '1.25rem' }}>
          <OccupancyReport />
        </div>
      )}

      {/* ── Row 8: AR Aging Summary ───────────────────────────────────────── */}
      {p('kpi_ar_aging') && (
        <div style={{ borderTop: '1px solid #DFE7E3', marginTop: '0.5rem', paddingTop: '1.25rem' }}>
          <ARAgingReport />
        </div>
      )}

      {/* ── Row 10: Agreement Expiry Alerts ──────────────────────────────── */}
      {p('section_agreements') && (
        <div style={{ borderTop: '1px solid #DFE7E3', marginTop: '0.5rem', paddingTop: '1.25rem' }}>
          <AgreementExpiry />
        </div>
      )}

      {/* ── Row 11: Foreign Exchange Earnings & Outgo ─────────────────── */}
      {p('section_forex') && (
        <div style={{ borderTop: '1px solid #DFE7E3', marginTop: '0.5rem', paddingTop: '1.25rem' }}>
          <ForexReport />
        </div>
      )}

      {/* ── Row 12: Top Customer Revenue ──────────────────────────────── */}
      {p('section_forex') && (
        <div style={{ borderTop: '1px solid #DFE7E3', marginTop: '0.5rem', paddingTop: '1.25rem' }}>
          <TopCustomerRevenueReport />
        </div>
      )}

      {/* ── Row 13: Operational Data ───────────────────────────────────── */}
      {p('section_forex') && (
        <div style={{ borderTop: '1px solid #DFE7E3', marginTop: '0.5rem', paddingTop: '1.25rem' }}>
          <OperationalDataReport />
        </div>
      )}

      {/* ── Row 14: ESCROW Collection Report ──────────────────────────── */}
      {p('section_forex') && (
        <div style={{ borderTop: '1px solid #DFE7E3', marginTop: '0.5rem', paddingTop: '1.25rem' }}>
          <EscrowCollectionReport />
        </div>
      )}

      {/* Modal */}
      {modal && <Modal title={modal.title} data={modal.rows} columns={modal.columns} onClose={closeModal} />}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }
        *::-webkit-scrollbar { width:6px; height:6px; }
        *::-webkit-scrollbar-track { background:#F2F2F2; }
        *::-webkit-scrollbar-thumb { background:#C8D6D0; border-radius:3px; }
      `}</style>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#F9F9F9', padding: '1.5rem 2rem', fontFamily: "'Figtree', 'Inter', -apple-system, sans-serif" },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' },
  heading: { margin: 0, color: '#18191B', fontSize: '1.5rem', fontWeight: 700 },
  subheading: { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.9rem' },
  refreshBtn: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '0.5rem 1rem', borderRadius: '8px', cursor: 'pointer', fontSize: '0.85rem' },
  kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem', marginBottom: '1.25rem' },
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' },
  clientRow: { display: 'flex', alignItems: 'center', padding: '0.6rem 0.5rem', borderRadius: '6px', cursor: 'pointer', gap: '0.75rem', transition: 'background 0.1s' },
  clientRank: { color: '#9BA8B0', fontSize: '0.8rem', width: '24px', flexShrink: 0 },
  clientName: { color: '#18191B', fontSize: '0.85rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  clientAmt: { color: '#15803D', fontWeight: 600, fontSize: '0.85rem', flexShrink: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' },
  th: { padding: '0.65rem 1rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #DFE7E3', background: '#F9F9F9' },
  td: { padding: '0.75rem 1rem', color: '#18191B', borderBottom: '1px solid #F2F2F2' },
  branchName: { display: 'flex', alignItems: 'center', color: '#18191B' },
};
