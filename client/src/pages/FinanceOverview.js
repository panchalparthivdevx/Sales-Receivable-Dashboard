import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Clock, FileText, TrendingUp, DollarSign, AlertCircle,
  RefreshCw, Truck, CreditCard, TrendingDown,
} from 'lucide-react';
import { api } from '../utils/api';
import { formatINR, formatNumber } from '../utils/format';
import KPICard from '../components/KPICard';
import Modal from '../components/Modal';
import PLReport from '../components/PLReport';
import PLMapping from '../components/PLMapping';

const monthLabel = () => new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' });
const fyLabel = () => {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `FY ${y}-${String(y + 1).slice(2)}`;
};

function BranchFilter({ branches, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef();

  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = branches.filter(b => b.toLowerCase().includes(search.toLowerCase()));

  const toggle = branch => {
    if (selected.includes(branch)) onChange(selected.filter(b => b !== branch));
    else onChange([...selected, branch]);
  };

  const label = selected.length === 0
    ? 'All Branches'
    : selected.length === 1
    ? selected[0]
    : `${selected.length} branches selected`;

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: '#fff', border: '1px solid #DFE7E3', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem', color: '#18191B', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
      >
        <span style={{ color: '#1C4942', fontWeight: 700, fontSize: '0.82rem' }}>Branch</span>
        <span style={{ color: '#5D6C7B', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ color: '#9CA3AF', fontSize: '0.7rem', marginLeft: 2 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 400, background: '#fff', border: '1px solid #DFE7E3', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,18,20,0.12)', width: 300 }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #EEF3F1' }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search branches…"
              style={{ width: '100%', border: '1px solid #DFE7E3', borderRadius: 6, padding: '6px 10px', fontSize: '0.81rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', color: '#18191B' }}
              autoFocus
            />
          </div>
          <div style={{ display: 'flex', gap: 6, padding: '7px 12px', borderBottom: '1px solid #EEF3F1' }}>
            <button onClick={() => { onChange([]); setSearch(''); }} style={S.chipBtn('#1C4942', '#fff')}>All</button>
            <button onClick={() => onChange([...branches])} style={S.chipBtn('#f0fdf4', '#1C4942')}>Select All</button>
            {selected.length > 0 && (
              <button onClick={() => onChange([])} style={S.chipBtn('#fff5f5', '#ef4444')}>Clear ({selected.length})</button>
            )}
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div style={{ padding: '12px 14px', fontSize: '0.81rem', color: '#9CA3AF', textAlign: 'center' }}>No branches found</div>
            )}
            {filtered.map(b => (
              <label key={b} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer', fontSize: '0.80rem', color: selected.includes(b) ? '#1C4942' : '#334155', background: selected.includes(b) ? '#f0fdf4' : 'transparent', borderBottom: '1px solid #F5F7F6' }}>
                <input type="checkbox" checked={selected.includes(b)} onChange={() => toggle(b)} style={{ cursor: 'pointer', accentColor: '#1C4942' }} />
                {b}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Column definitions ────────────────────────────────────────────────────────
const invoiceDetailCols = [
  { key: 'invoice_number', label: 'Invoice #' },
  { key: 'customer_name',  label: 'Customer'  },
  { key: 'date',           label: 'Date',             type: 'date'     },
  { key: 'branch_name',    label: 'Branch'            },
  { key: 'sub_total',      label: 'Amount (ex-tax)',   type: 'currency', align: 'right' },
  { key: 'status',         label: 'Status',            type: 'status'   },
];
const receivableDetailCols = [
  { key: 'invoice_number', label: 'Invoice #' },
  { key: 'customer_name',  label: 'Customer'  },
  { key: 'date',           label: 'Date',     type: 'date' },
  { key: 'due_date',       label: 'Due Date', type: 'date' },
  { key: 'branch_name',    label: 'Branch'    },
  { key: 'balance',        label: 'Balance',  type: 'currency', align: 'right' },
  { key: 'status',         label: 'Status',   type: 'status'   },
];
const collectionCols = [
  { key: 'customer_name',   label: 'Customer'      },
  { key: 'branch_name',     label: 'Branch'        },
  { key: 'payment_date',    label: 'Payment Date', type: 'date' },
  { key: 'payment_mode',    label: 'Mode'          },
  { key: 'reference_number',label: 'Reference #'   },
  { key: 'invoice_numbers', label: 'Invoice(s)'    },
  { key: 'amount',          label: 'Amount',       type: 'currency', align: 'right' },
];
const cnCols = [
  { key: 'creditnote_number',label: 'Credit Note #'              },
  { key: 'customer_name',    label: 'Customer'                   },
  { key: 'branch_name',      label: 'Branch'                     },
  { key: 'date',             label: 'Date',       type: 'date'   },
  { key: 'applied_amount',   label: 'Applied',    type: 'currency', align: 'right' },
  { key: 'status',           label: 'Status',     type: 'status' },
];
const delayCols = [
  { key: 'invoice_number',  label: 'Invoice #' },
  { key: 'customer_name',   label: 'Customer'  },
  { key: 'due_date',        label: 'Due Date',  type: 'date' },
  { key: 'payment_date',    label: 'Paid On',   type: 'date' },
  { key: 'delay_days',      label: 'Delay (Days)', align: 'right' },
  { key: 'amount',          label: 'Amount',    type: 'currency', align: 'right' },
];
const billCols = [
  { key: 'bill_number',  label: 'Bill #'          },
  { key: 'vendor_name',  label: 'Vendor'          },
  { key: 'date',         label: 'Date',    type: 'date'     },
  { key: 'branch_name',  label: 'Branch'          },
  { key: 'sub_total',    label: 'Amount (ex-tax)', type: 'currency', align: 'right' },
  { key: 'status',       label: 'Status',  type: 'status'   },
];
const vendorDelayCols = [
  { key: 'bill_number',  label: 'Bill #'   },
  { key: 'vendor_name',  label: 'Vendor'   },
  { key: 'due_date',     label: 'Due Date', type: 'date' },
  { key: 'payment_date', label: 'Paid On',  type: 'date' },
  { key: 'delay_days',   label: 'Delay (Days)', align: 'right' },
  { key: 'amount',       label: 'Amount',   type: 'currency', align: 'right' },
];
const vendorPaymentCols = [
  { key: 'vendor_name',     label: 'Vendor'        },
  { key: 'branch_name',     label: 'Branch'        },
  { key: 'payment_date',    label: 'Payment Date', type: 'date' },
  { key: 'payment_mode',    label: 'Mode'          },
  { key: 'reference_number',label: 'Reference #'   },
  { key: 'bill_numbers',    label: 'Bill(s)'       },
  { key: 'amount',          label: 'Amount',       type: 'currency', align: 'right' },
];
const vcCols = [
  { key: 'vendor_credit_number', label: 'Vendor Credit #'               },
  { key: 'vendor_name',          label: 'Vendor'                        },
  { key: 'branch_name',          label: 'Branch'                        },
  { key: 'date',                 label: 'Date',         type: 'date'    },
  { key: 'applied_amount',       label: 'Applied',      type: 'currency', align: 'right' },
  { key: 'status',               label: 'Status',       type: 'status'  },
];
const payableCols = [
  { key: 'bill_number', label: 'Bill #'   },
  { key: 'vendor_name', label: 'Vendor'   },
  { key: 'date',        label: 'Date',     type: 'date' },
  { key: 'due_date',    label: 'Due Date', type: 'date' },
  { key: 'branch_name', label: 'Branch'   },
  { key: 'balance',     label: 'Balance',  type: 'currency', align: 'right' },
  { key: 'status',      label: 'Status',   type: 'status'   },
];

export default function FinanceOverview() {
  const [branchList,      setBranchList]      = useState([]);
  const [selected,        setSelected]        = useState([]);
  const [data,            setData]            = useState(null);
  const [showPLMapping,   setShowPLMapping]   = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [modal,      setModal]      = useState(null);

  useEffect(() => {
    api.financeBranches().then(d => setBranchList(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const load = useCallback(async sel => {
    setLoading(true);
    try {
      const result = await api.financeOverview(sel);
      setData(result);
    } catch (e) {
      console.error('finance/overview', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(selected); }, [selected, load]);

  const openModal = (title, rows, columns) => setModal({ title, rows, columns });
  const closeModal = () => setModal(null);

  const s = data?.sales;
  const p = data?.purchase;
  const L = loading;

  return (
    <div style={S.page}>
      {modal && <Modal title={modal.title} data={modal.rows} columns={modal.columns} onClose={closeModal} />}

      {/* Header */}
      <div style={S.header}>
        <div>
          <h1 style={S.heading}>Finance Overview</h1>
          <p style={S.sub}>Dev Accelerator Limited · {monthLabel()}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <BranchFilter branches={branchList} selected={selected} onChange={setSelected} />
          <button
            style={{ ...S.refreshBtn, opacity: L ? 0.6 : 1 }}
            onClick={() => load(selected)}
            disabled={L}
          >
            <RefreshCw size={15} style={{ animation: L ? 'spin 1s linear infinite' : 'none', flexShrink: 0 }} />
            {L ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {selected.length > 0 && (
        <div style={S.filterBadge}>
          Filtered to {selected.length} branch{selected.length > 1 ? 'es' : ''}: {selected.join(', ')}
          <button onClick={() => setSelected([])} style={S.clearBtn}>× Clear filter</button>
        </div>
      )}

      {/* ── Section A: Sales & Receivables ─────────────────────────────────── */}
      <div style={S.sectionHeader}>
        <div style={{ ...S.dot, background: '#10b981' }} />
        <span style={S.sectionTitle}>Section A — Sales &amp; Receivables</span>
      </div>
      <div style={S.kpiGrid}>
        <KPICard
          title="Avg. Payment Delay"
          value={L ? '…' : `${s?.avg_delay_days ?? 0} Days`}
          subValue={L ? '…' : `${s?.avg_delay_analyzed ?? 0} payments`}
          subLabel="Current FY (paid invoices)"
          icon={Clock} color="#f59e0b" loading={L}
          onClick={() => openModal('Payment Delay Detail — Current FY', s?.avg_delay_detail || [], delayCols)}
        />
        <KPICard
          title={`Invoices Sent — ${monthLabel()}`}
          value={L ? '…' : formatNumber(s?.inv_count_month)}
          subValue={L ? '…' : formatNumber(s?.inv_count_fy)}
          subLabel={`Total ${fyLabel()}`}
          icon={FileText} color="#3b82f6" loading={L}
          onClick={() => openModal(`Invoices — ${monthLabel()}`, s?.inv_count_detail || [], invoiceDetailCols)}
        />
        <KPICard
          title={`Revenue — ${monthLabel()}`}
          value={L ? '…' : formatINR(s?.revenue_month)}
          subValue={L ? '…' : formatINR(s?.revenue_fy)}
          subLabel={`${fyLabel()} total`}
          icon={TrendingUp} color="#10b981" loading={L}
          onClick={() => openModal(`Revenue Detail — ${monthLabel()}`, s?.revenue_month_detail || [], invoiceDetailCols)}
        />
        <KPICard
          title={`Total Revenue — ${fyLabel()}`}
          value={L ? '…' : formatINR(s?.revenue_fy)}
          icon={DollarSign} color="#8b5cf6" loading={L}
          onClick={() => openModal(`All Revenue — ${fyLabel()}`, s?.revenue_fy_detail || [], invoiceDetailCols)}
        />
        <KPICard
          title="Today's Collection"
          value={L ? '…' : formatINR(s?.coll_today)}
          subValue={L ? '…' : `${s?.coll_today_detail?.length ?? 0} payments`}
          subLabel="Actual bank deposits only"
          icon={DollarSign} color="#22c55e" loading={L}
          onClick={() => openModal("Today's Collection — Bank Payments", s?.coll_today_detail || [], collectionCols)}
        />
        <KPICard
          title={`Collection — ${monthLabel()}`}
          value={L ? '…' : formatINR(s?.coll_month)}
          subValue={L ? '…' : `${s?.coll_month_detail?.length ?? 0} payments`}
          subLabel="Actual bank deposits only"
          icon={TrendingUp} color="#84cc16" loading={L}
          onClick={() => openModal(`Collection — ${monthLabel()} (Bank Payments)`, s?.coll_month_detail || [], collectionCols)}
        />
        <KPICard
          title="Credit Notes — Today"
          value={L ? '…' : formatINR(s?.cn_today)}
          subValue={L ? '…' : formatINR(s?.cn_month)}
          subLabel={`${monthLabel()} total`}
          icon={FileText} color="#f59e0b" loading={L}
          onClick={() => openModal(
            (s?.cn_today ?? 0) > 0 ? 'Credit Notes — Today' : `Credit Notes — ${monthLabel()}`,
            (s?.cn_today ?? 0) > 0 ? (s?.cn_today_detail || []) : (s?.cn_month_detail || []),
            cnCols
          )}
        />
        <KPICard
          title={`Receivable — ${monthLabel()}`}
          value={L ? '…' : formatINR(s?.recv_month)}
          subValue={L ? '…' : formatINR(s?.recv_total)}
          subLabel="Total as on date"
          icon={AlertCircle} color="#ef4444" loading={L}
          onClick={() => openModal(`Receivables — ${monthLabel()}`, s?.recv_month_detail || [], receivableDetailCols)}
        />
        <KPICard
          title="Total Receivable as on Date"
          value={L ? '…' : formatINR(s?.recv_total)}
          icon={DollarSign} color="#06b6d4" loading={L}
          onClick={() => openModal('All Receivables — As on Date', s?.recv_total_detail || [], receivableDetailCols)}
        />
      </div>

      {/* ── Section B: Purchase & Payables ─────────────────────────────────── */}
      <div style={S.sectionHeader}>
        <div style={{ ...S.dot, background: '#f59e0b' }} />
        <span style={S.sectionTitle}>Section B — Purchase &amp; Payables</span>
      </div>
      <div style={S.kpiGrid}>
        <KPICard
          title="Avg. Payment Delay (Vendor)"
          value={L ? '…' : `${p?.avg_delay_days ?? 0} Days`}
          subValue={L ? '…' : `${p?.avg_delay_analyzed ?? 0} payments`}
          subLabel="Current FY (paid bills)"
          icon={Clock} color="#f59e0b" loading={L}
          onClick={() => openModal('Vendor Payment Delay — Current FY', p?.avg_delay_detail || [], vendorDelayCols)}
        />
        <KPICard
          title={`Bills Received — ${monthLabel()}`}
          value={L ? '…' : formatNumber(p?.bill_count_month)}
          subValue={L ? '…' : formatNumber(p?.bill_count_fy)}
          subLabel={`Total ${fyLabel()}`}
          icon={FileText} color="#3b82f6" loading={L}
          onClick={() => openModal(`Bills Received — ${monthLabel()}`, p?.bill_count_detail || [], billCols)}
        />
        <KPICard
          title={`Expense — ${monthLabel()}`}
          value={L ? '…' : formatINR(p?.expense_month)}
          subValue={L ? '…' : formatINR(p?.expense_fy)}
          subLabel={`${fyLabel()} total`}
          icon={TrendingDown} color="#10b981" loading={L}
          onClick={() => openModal(`Expense Detail — ${monthLabel()}`, p?.expense_month_detail || [], billCols)}
        />
        <KPICard
          title={`Total Expense — ${fyLabel()}`}
          value={L ? '…' : formatINR(p?.expense_fy)}
          icon={DollarSign} color="#8b5cf6" loading={L}
          onClick={() => openModal(`All Expenses — ${fyLabel()}`, p?.expense_fy_detail || [], billCols)}
        />
        <KPICard
          title="Amount Paid Today"
          value={L ? '…' : formatINR(p?.paid_today)}
          subValue={L ? '…' : `${p?.paid_today_detail?.length ?? 0} payments`}
          subLabel="Actual bank deposits only"
          icon={DollarSign} color="#22c55e" loading={L}
          onClick={() => openModal('Amount Paid Today — Bank Payments', p?.paid_today_detail || [], vendorPaymentCols)}
        />
        <KPICard
          title={`Amount Paid — ${monthLabel()}`}
          value={L ? '…' : formatINR(p?.paid_month)}
          subValue={L ? '…' : `${p?.paid_month_detail?.length ?? 0} payments`}
          subLabel="Actual bank deposits only"
          icon={Truck} color="#84cc16" loading={L}
          onClick={() => openModal(`Amount Paid — ${monthLabel()} (Bank Payments)`, p?.paid_month_detail || [], vendorPaymentCols)}
        />
        <KPICard
          title="Vendor Credit Notes — Today"
          value={L ? '…' : formatINR(p?.vc_today)}
          subValue={L ? '…' : formatINR(p?.vc_month)}
          subLabel={`${monthLabel()} total`}
          icon={CreditCard} color="#f59e0b" loading={L}
          onClick={() => openModal(
            (p?.vc_today ?? 0) > 0 ? 'Vendor Credits — Today' : `Vendor Credits — ${monthLabel()}`,
            (p?.vc_today ?? 0) > 0 ? (p?.vc_today_detail || []) : (p?.vc_month_detail || []),
            vcCols
          )}
        />
        <KPICard
          title={`Payables — ${monthLabel()}`}
          value={L ? '…' : formatINR(p?.payable_month)}
          subValue={L ? '…' : formatINR(p?.payable_total)}
          subLabel="Total as on date"
          icon={AlertCircle} color="#ef4444" loading={L}
          onClick={() => openModal(`Payables — ${monthLabel()}`, p?.payable_month_detail || [], payableCols)}
        />
        <KPICard
          title="Total Payables as on Date"
          value={L ? '…' : formatINR(p?.payable_total)}
          icon={DollarSign} color="#06b6d4" loading={L}
          onClick={() => openModal('All Payables — As on Date', p?.payable_total_detail || [], payableCols)}
        />
      </div>

      {/* ── Section C: Branch P&L Account ──────────────────────────────────── */}
      <div style={{ ...S.sectionHeader, marginTop: 8 }}>
        <div style={{ ...S.dot, background: '#6366f1' }} />
        <span style={S.sectionTitle}>Section C — Branch Profit &amp; Loss Account</span>
      </div>
      <PLReport
        onOpenMapping={() => setShowPLMapping(true)}
      />

      {showPLMapping && <PLMapping onClose={() => setShowPLMapping(false)} />}
    </div>
  );
}

const S = {
  page: { padding: '2rem', maxWidth: 1400, margin: '0 auto' },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    marginBottom: '1.25rem', flexWrap: 'wrap', gap: 12,
  },
  heading: { fontSize: '1.4rem', fontWeight: 700, color: '#18191B', margin: 0 },
  sub: { fontSize: '0.85rem', color: '#5D6C7B', margin: '4px 0 0' },
  refreshBtn: {
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '8px 16px', background: '#1C4942', color: '#fff',
    border: 'none', borderRadius: 8, cursor: 'pointer',
    fontSize: '0.85rem', fontFamily: 'inherit',
  },
  filterBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    background: '#f0fdf4', border: '1px solid #bbf7d0',
    borderRadius: 8, padding: '6px 14px',
    fontSize: '0.81rem', color: '#166534',
    marginBottom: '1.25rem',
  },
  clearBtn: {
    background: 'none', border: 'none', color: '#ef4444',
    cursor: 'pointer', fontSize: '0.81rem', padding: 0,
    fontFamily: 'inherit',
  },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: 10,
    marginBottom: '0.85rem',
  },
  dot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  sectionTitle: {
    fontSize: '0.95rem', fontWeight: 700, color: '#1C4942', letterSpacing: '0.01em',
  },
  kpiGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: '1rem',
    marginBottom: '2rem',
  },
  chipBtn: (bg, color) => ({
    fontSize: '0.74rem', padding: '3px 10px',
    borderRadius: 5, border: `1px solid ${color}20`,
    background: bg, color: color,
    cursor: 'pointer', fontFamily: 'inherit',
  }),
};
