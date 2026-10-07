import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Legend, Cell, LineChart, Line, PieChart, Pie,
} from 'recharts';
import {
  TrendingDown, CheckCircle2, AlertTriangle, Clock,
  Calendar, RefreshCw, Download, Info, FileText,
  ChevronRight, ArrowRight,
} from 'lucide-react';
import { api } from '../utils/api';

// ─── Section colour map ───────────────────────────────────────────────────────
const SECTION_COLORS = {
  '192':     '#8b5cf6',
  '194C':    '#3b82f6',
  '194J':    '#06b6d4',
  '194JA':   '#0891b2',
  '194JB':   '#0e7490',
  '194I':    '#f59e0b',
  '194I(a)': '#d97706',
  '194I(b)': '#ef4444',
  '194IA':   '#dc2626',
  '194H':    '#10b981',
  '194A':    '#f97316',
  '194Q':    '#a855f7',
  '195':     '#ec4899',
  'Unknown': '#64748b',
};
function sectionColor(code) { return SECTION_COLORS[code] || '#64748b'; }

// ─── Formatters ───────────────────────────────────────────────────────────────
const inr = (n) => typeof n === 'number'
  ? `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
  : '—';

function monthOptions() {
  const opts = [];
  const now  = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
    opts.push({ value: ym, label });
  }
  return opts;
}

const MONTHS    = monthOptions();
const CUR_MONTH = MONTHS[0].value;

// ─── FY Options ──────────────────────────────────────────────────────────────
const FY_OPTIONS = (() => {
  const now = new Date();
  const m = now.getMonth() + 1;
  const yr = now.getFullYear();
  const startYr = m >= 4 ? yr : yr - 1;
  const opts = [];
  for (let i = 0; i <= 3; i++) {
    const y = startYr - i;
    opts.push({ value: `${y}-${String(y + 1).slice(-2)}`, label: `FY ${y}-${String(y + 1).slice(-2)}` });
  }
  return opts;
})();

// ─── Quarter options ──────────────────────────────────────────────────────────
const QUARTER_OPTIONS = [
  { value: 'All',       label: 'All Quarters'              },
  { value: 'Q1',        label: 'Q1  (Apr – Jun)'           },
  { value: 'Q2',        label: 'Q2  (Jul – Sep)'           },
  { value: 'Q3',        label: 'Q3  (Oct – Dec)'           },
  { value: 'Q4',        label: 'Q4  (Jan – Mar)'           },
  { value: 'Q1+Q2',     label: 'Q1 + Q2  (Apr – Sep)'     },
  { value: 'Q1+Q2+Q3',  label: 'Q1 + Q2 + Q3  (Apr – Dec)'},
  { value: 'Full FY',   label: 'Full Financial Year'       },
];

const QUARTER_MONTHS = {
  'Q1': [4,5,6], 'Q2': [7,8,9], 'Q3': [10,11,12], 'Q4': [1,2,3],
  'Q1+Q2': [4,5,6,7,8,9], 'Q1+Q2+Q3': [4,5,6,7,8,9,10,11,12],
  'Full FY': [4,5,6,7,8,9,10,11,12,1,2,3],
};

// ─── Section badge ────────────────────────────────────────────────────────────
function SectionBadge({ code }) {
  const c = sectionColor(code);
  return (
    <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 700, background: `${c}15`, color: c, border: `1px solid ${c}35`, whiteSpace: 'nowrap' }}>
      {code}
    </span>
  );
}

// ─── Expandable section row ───────────────────────────────────────────────────
function SectionRow({ s, idx }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="tds-row-hover"
        style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)', cursor: s.bills?.length > 0 ? 'pointer' : 'default' }}
        onClick={() => s.bills?.length > 0 && setOpen(o => !o)}
      >
        <td style={T.td}>
          {s.bills?.length > 0 && <span style={{ color: '#DFE7E3', fontSize: '0.65rem', marginRight: 4 }}>{open ? '▼' : '▶'}</span>}
          <SectionBadge code={s.section} />
        </td>
        <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.79rem', color: '#B45309' }}>{inr(s.payable)}</td>
        <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.79rem', color: '#15803D' }}>{inr(s.paid)}</td>
        <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.79rem', color: s.difference > 0 ? '#DC2626' : '#15803D' }}>{inr(s.difference)}</td>
        <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.79rem', color: '#9BA8B0' }}>{inr(s.payable - s.paid)}</td>
      </tr>
      {open && s.bills?.map((b, bi) => (
        <tr key={bi} style={{ background: '#EAF4EF' }}>
          <td colSpan={5} style={{ ...T.td, paddingLeft: '2.25rem', fontSize: '0.73rem', color: '#5D6C7B' }}>
            {b.bill_number} · {b.vendor_name} · {inr(b.tds_amount)}
            {b.is_backdated && <span style={{ marginLeft: 8, fontSize: '0.62rem', background: 'rgba(220,38,38,0.08)', color: '#DC2626', padding: '1px 5px', borderRadius: 3, fontWeight: 700 }}>BACKDATED</span>}
          </td>
        </tr>
      ))}
    </>
  );
}

// ─── Chart tooltip ────────────────────────────────────────────────────────────
function DarkTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 7, padding: '0.55rem 0.8rem', fontSize: '0.75rem' }}>
      <div style={{ color: '#9BA8B0', marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: 'monospace' }}>{inr(p.value || 0)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.75rem', gap: 8 }}>
      <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite', color: '#1C4942' }} />
      <span style={{ fontSize: '0.75rem', color: '#5D6C7B' }}>Loading…</span>
    </div>
  );
}

// ─── Panel wrapper with header ────────────────────────────────────────────────
function Panel({ dot, title, subtitle, badge, action, children, style }) {
  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, overflow: 'hidden', ...style }}>
      <div style={{ padding: '0.8rem 1rem', borderBottom: '1px solid #DFE7E3', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: dot, fontSize: 13, lineHeight: 1, flexShrink: 0 }}>●</span>
          <div>
            <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.83rem' }}>{title}</div>
            {subtitle && <div style={{ color: '#5D6C7B', fontSize: '0.68rem', marginTop: 1 }}>{subtitle}</div>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
          {badge}
          {action && (
            <button onClick={action.onClick} style={{ color: '#1C4942', fontSize: '0.7rem', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, fontFamily: 'inherit', padding: 0 }}>
              {action.label} <ChevronRight size={11} />
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

// ─── Filter select ────────────────────────────────────────────────────────────
function FSel({ label, value, onChange, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <label style={{ fontSize: '0.6rem', fontWeight: 700, color: '#5D6C7B', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</label>
      <select value={value} onChange={onChange}
        style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#9BA8B0', borderRadius: 6, padding: '4px 8px', fontSize: '0.76rem', cursor: 'pointer', outline: 'none', fontFamily: 'inherit', minWidth: 100 }}>
        {children}
      </select>
    </div>
  );
}

// ─── KPI card (3 × 2 layout — wider cards) ───────────────────────────────────
function KCard({ num, title, color, icon: Icon, loading, onClick, children }) {
  return (
    <div onClick={onClick} style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderTop: `3px solid ${color}`, borderRadius: 10, overflow: 'hidden', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ padding: '0.8rem 1.1rem' }}>
        {/* Header row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div style={{ width: 22, height: 22, borderRadius: 6, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon size={12} color={color} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: '0.6rem', fontFamily: 'monospace', color, fontWeight: 700 }}>{num}.</span>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#9BA8B0' }}>{title}</span>
              </div>
            </div>
          </div>
        </div>
        {loading
          ? <div style={{ height: 68, background: '#EAF4EF', borderRadius: 6, animation: 'pulse 1.5s ease infinite' }} />
          : <div>{children}</div>}
      </div>
    </div>
  );
}

function KRow({ label, value, dim }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.18rem 0', gap: 8 }}>
      <span style={{ fontSize: '0.7rem', color: dim ? '#DFE7E3' : '#5D6C7B', lineHeight: 1.3, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '0.78rem', fontFamily: 'monospace', color: dim ? '#DFE7E3' : '#5D6C7B', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

function KDash() {
  return <div style={{ borderTop: '1px dashed #DFE7E3', margin: '0.4rem 0' }} />;
}

function KTotal({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
      <span style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#5D6C7B', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '1.05rem', fontFamily: 'monospace', fontWeight: 700, color, whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function TDSPayableDashboard() {
  const [month,         setMonth]         = useState(CUR_MONTH);
  const [fyFilter,      setFyFilter]      = useState(FY_OPTIONS[0]?.value || '');
  const [quarterFilter, setQuarterFilter] = useState('All');
  const [sectionFilter, setSectionFilter] = useState('All');
  const [vendorFilter,  setVendorFilter]  = useState('All');
  const [report,        setReport]        = useState(null);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState(null);
  const [trendData,     setTrendData]     = useState([]);
  const [lastSync,      setLastSync]      = useState(null);
  const [bdOpen,        setBdOpen]        = useState(false);

  // ── API fetch ──────────────────────────────────────────────────────────────
  const fetchReport = useCallback(async (m) => {
    setLoading(true); setError(null);
    try {
      const data = await api.tdsPayableMonthly(m);
      setReport(data);
      setLastSync(new Date());
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load TDS data');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchReport(month); }, [month, fetchReport]);

  // Trend data: last 5 months for charts
  useEffect(() => {
    const run = async () => {
      const last5 = MONTHS.slice(0, 5).reverse();
      const rows = [];
      for (const m of last5) {
        try {
          const d = await api.tdsPayableMonthly(m.value);
          const sm = d?.summary || {};
          rows.push({
            month: m.label.split(' ')[0].slice(0, 3) + '-' + (m.label.split(' ')[1] || '').slice(2, 4),
            payable: sm.total_payable || 0,
            paid:    sm.total_paid    || 0,
            outstanding: sm.pending  || 0,
          });
        } catch {}
      }
      setTrendData(rows);
    };
    run();
  }, []);

  // ── Derived values ─────────────────────────────────────────────────────────
  const s        = report?.summary  || {};
  const sections = report?.sections || [];
  const alerts   = report?.alerts   || {};
  const detect   = report?.detection || {};

  const filteredSections = sections.filter(sec =>
    (sectionFilter === 'All' || sec.section === sectionFilter) &&
    (vendorFilter  === 'All' || (sec.bills || []).some(b => b.vendor_name === vendorFilter))
  );

  const availableSections = ['All', ...new Set(sections.map(s2 => s2.section))];
  const allVendors        = ['All', ...new Set(sections.flatMap(sec => (sec.bills || []).map(b => b.vendor_name)).filter(Boolean))];

  const bdCount  = alerts.backdated_entries?.length || 0;
  const bdImpact = (alerts.backdated_entries || []).reduce((sum, e) => sum + (e.tds_amount || 0), 0);

  const daysAbs   = Math.abs(report?.days_to_due || 0);
  const isOverdue = report?.is_overdue;
  const isPaid    = s.payment_status === 'fully_paid';
  const statusLabel = isOverdue ? 'Overdue' : (isPaid ? 'Completed' : (daysAbs === 0 ? 'Due Today' : 'Upcoming'));
  const statusColor = isOverdue ? '#DC2626' : (isPaid ? '#15803D' : '#B45309');

  // Payment status donut data
  const fullyPaidAmt  = sections.filter(s2 => s2.status === 'fully_paid').reduce((a, s2) => a + s2.payable, 0);
  const pendingAmt    = sections.filter(s2 => s2.status === 'pending' || s2.status === 'partially_paid').reduce((a, s2) => a + s2.difference, 0);
  const overpaidAmt   = sections.filter(s2 => s2.status === 'overpaid').reduce((a, s2) => a + Math.abs(s2.difference), 0);
  const shortPaidAmt  = Math.max(0, (s.pending || 0) - overpaidAmt);
  const donutData = [
    { name: 'Fully Paid', value: fullyPaidAmt,  color: '#10b981' },
    { name: 'Pending',    value: pendingAmt,    color: '#f59e0b' },
    { name: 'Overpaid',   value: overpaidAmt,   color: '#3b82f6' },
    { name: 'Short Paid', value: shortPaidAmt,  color: '#ef4444' },
  ].filter(d => d.value > 0);

  // Vendor outstanding
  const vMap = {};
  sections.forEach(sec => {
    (sec.bills || []).forEach(b => {
      if (!b.vendor_name) return;
      if (!vMap[b.vendor_name]) vMap[b.vendor_name] = { vendor: b.vendor_name, section: sec.section, amount: 0 };
      vMap[b.vendor_name].amount += (b.tds_amount || 0);
    });
  });
  const vendorRows     = Object.values(vMap).sort((a, b) => b.amount - a.amount).slice(0, 10);
  const vendorTotal    = vendorRows.reduce((a, v) => a + v.amount, 0);

  // Quarter-wise table from trendData
  const qMap = {};
  trendData.forEach(d => {
    const mn = d.month;
    let q = '—';
    if (['Apr','May','Jun'].some(x => mn.startsWith(x))) q = 'Q1';
    else if (['Jul','Aug','Sep'].some(x => mn.startsWith(x))) q = 'Q2';
    else if (['Oct','Nov','Dec'].some(x => mn.startsWith(x))) q = 'Q3';
    else if (['Jan','Feb','Mar'].some(x => mn.startsWith(x))) q = 'Q4';
    if (!qMap[q]) qMap[q] = { quarter: q, payable: 0, paid: 0, outstanding: 0 };
    qMap[q].payable     += d.payable;
    qMap[q].paid        += d.paid;
    qMap[q].outstanding += d.outstanding;
  });
  const quarterRows = ['Q1','Q2','Q3','Q4'].map(q => qMap[q] || { quarter: q, payable: 0, paid: 0, outstanding: 0 });

  // Smart alerts
  const smartAlerts = [
    ...(alerts.short_payments  || []).map(sp => ({ icon: AlertTriangle, color: '#f59e0b', text: `${inr(sp.difference)} pending in Section ${sp.section}.` })),
    ...(bdCount > 0 ? [{ icon: Clock, color: '#ef4444', text: `${bdCount} backdated voucher${bdCount > 1 ? 's' : ''} detected.` }] : []),
    ...(detect.tds_paid_source !== 'vendor_payments' ? [{ icon: Info, color: '#ef4444', text: 'Challan not matched in Zoho Books.' }] : []),
    ...((alerts.data_gaps || []).length > 0 ? [{ icon: Info, color: '#f59e0b', text: `${alerts.data_gaps.length} invoice(s) without TDS deduction.` }] : []),
    ...(sections.some(s2 => (s2.bills || []).some(b => !b.pan)) ? [{ icon: Info, color: '#3b82f6', text: 'Some vendors are missing PAN.' }] : []),
  ].slice(0, 5);

  // Prev outstanding
  const prevRows      = trendData.slice(0, -1);
  const prevTotal     = prevRows.reduce((a, d) => a + d.outstanding, 0);

  const syncLabel = lastSync
    ? lastSync.toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  const handleQuarterChange = (q) => {
    setQuarterFilter(q);
    const qMonths = QUARTER_MONTHS[q];
    if (qMonths) {
      const fyYear = parseInt(fyFilter?.split('-')[0]) || new Date().getFullYear();
      const m = qMonths[0];
      const yr = m >= 4 ? fyYear : fyYear + 1;
      const ym = `${yr}-${String(m).padStart(2, '0')}`;
      setMonth(ym);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: '#F9F9F9', minHeight: 'calc(100vh - 105px)', padding: '1.1rem 1.4rem', fontFamily: "'Figtree','Inter',-apple-system,sans-serif" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .tds-row-hover:hover { background: rgba(0,0,0,0.03) !important; }
      `}</style>

      {/* ══ FILTER BAR ════════════════════════════════════════════════════════ */}
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '0.65rem 1rem', marginBottom: '0.85rem', display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <FSel label="Financial Year" value={fyFilter} onChange={e => setFyFilter(e.target.value)}>
            {FY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </FSel>
          <FSel label="Quarter" value={quarterFilter} onChange={e => handleQuarterChange(e.target.value)}>
            {QUARTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </FSel>
          <FSel label="Month" value={month} onChange={e => { setMonth(e.target.value); setQuarterFilter('All'); }}>
            {MONTHS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </FSel>
          <FSel label="Section" value={sectionFilter} onChange={e => setSectionFilter(e.target.value)}>
            {availableSections.map(s2 => <option key={s2} value={s2}>{s2 === 'All' ? 'All Sections' : s2}</option>)}
          </FSel>
          <FSel label="Vendor" value={vendorFilter} onChange={e => setVendorFilter(e.target.value)}>
            {allVendors.slice(0, 60).map(v => <option key={v} value={v}>{v === 'All' ? 'All Vendors' : v}</option>)}
          </FSel>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: '0.7rem', color: '#9BA8B0' }}>Last Sync: {syncLabel}</span>
          <button onClick={() => fetchReport(month)} disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: '1px solid #DFE7E3', background: '#F9F9F9', color: '#5D6C7B', cursor: loading ? 'not-allowed' : 'pointer' }}>
            <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          </button>
          <button style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 14px', borderRadius: 6, background: '#1C4942', border: 'none', color: 'white', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 600, fontFamily: 'inherit' }}>
            <Download size={11} /> Export
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 8, padding: '0.6rem 1rem', marginBottom: '0.85rem', color: '#DC2626', fontSize: '0.8rem' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* ══ KPI CARDS (3 × 2) ════════════════════════════════════════════════ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '0.85rem' }}>

        {/* 1. Outstanding TDS */}
        <KCard num="1" title="Outstanding TDS" color="#f59e0b" icon={TrendingDown} loading={loading}>
          <KRow label="Previous Outstanding"        value={inr(0)}       dim />
          <KRow label="Current Period Outstanding"  value={inr(s.pending)} />
          <KDash />
          <KTotal label="Total Outstanding" value={inr(s.pending)} color="#B45309" />
        </KCard>

        {/* 2. TDS Payable */}
        <KCard num="2" title="TDS Payable" color="#1C4942" icon={FileText} loading={loading}>
          <KRow label="Current Period Payable"      value={inr(s.total_payable)} />
          <KRow label="Prev. Outstanding Included"  value={inr(0)} dim />
          <KDash />
          <KTotal label="Grand Payable" value={inr(s.total_payable)} color="#1C4942" />
        </KCard>

        {/* 3. TDS Paid */}
        <KCard num="3" title="TDS Paid" color="#15803D" icon={CheckCircle2} loading={loading}>
          <KRow label="Paid This Period"            value={inr(s.total_paid)} />
          <KRow label="Prev. Period Adjustment"     value={inr(0)} dim />
          <KDash />
          <KTotal label="Total Paid" value={inr(s.total_paid)} color="#15803D" />
        </KCard>

        {/* 4. Net Liability */}
        <KCard num="4" title="Net Liability" color={s.pending > 0 ? '#DC2626' : '#15803D'} icon={AlertTriangle} loading={loading}>
          <KRow label="Payable" value={inr(s.total_payable)} />
          <KRow label="Paid"    value={`- ${inr(s.total_paid)}`} />
          <KDash />
          <KTotal label="Net Liability" value={inr(s.pending)} color={s.pending > 0 ? '#DC2626' : '#15803D'} />
        </KCard>

        {/* 5. Payment Due */}
        <KCard num="5" title="Payment Due" color={statusColor} icon={Calendar} loading={loading}>
          <KRow label="Next Due Date"   value={report?.due_date || '—'} />
          <KRow label="Days Remaining"  value={isOverdue ? `${daysAbs}d overdue` : `${daysAbs} Days`} />
          <KDash />
          <div style={{ marginTop: 4 }}>
            <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 700, background: `${statusColor}18`, color: statusColor, border: `1px solid ${statusColor}30` }}>
              {statusLabel}
            </span>
          </div>
        </KCard>

        {/* 6. Backdated Entries */}
        <KCard num="6" title="Backdated Entries" color="#8b5cf6" icon={AlertTriangle} loading={loading} onClick={() => setBdOpen(o => !o)}>
          <KRow label="Backdated Vouchers" value={String(bdCount)} />
          <KRow label="Impact Amount"      value={inr(bdImpact)} />
          <KDash />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <span style={{ fontSize: '0.68rem', color: '#8b5cf6', fontWeight: 600 }}>View Details</span>
            <ArrowRight size={11} color="#8b5cf6" />
          </div>
        </KCard>
      </div>

      {/* Backdated drill-down */}
      {bdOpen && bdCount > 0 && (
        <div style={{ background: '#FFFFFF', border: '1px solid #8b5cf640', borderRadius: 10, padding: '0.85rem 1rem', marginBottom: '0.85rem' }}>
          <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.83rem', marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: 7 }}>
            <AlertTriangle size={13} color="#8b5cf6" /> Backdated Entries Detail ({bdCount})
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={T.table}>
              <thead><tr>
                <th style={T.th}>Bill No.</th><th style={T.th}>Vendor</th>
                <th style={{ ...T.th, textAlign: 'center' }}>Section</th>
                <th style={{ ...T.th, textAlign: 'right' }}>TDS (₹)</th>
                <th style={{ ...T.th, textAlign: 'center' }}>Bill Date</th>
                <th style={{ ...T.th, textAlign: 'center' }}>Days Late</th>
                <th style={T.th}>Recommendation</th>
              </tr></thead>
              <tbody>
                {alerts.backdated_entries.map((e, i) => (
                  <tr key={i}>
                    <td style={{ ...T.td, fontFamily: 'monospace', fontSize: '0.73rem', color: '#5D6C7B' }}>{e.bill_number}</td>
                    <td style={{ ...T.td, color: '#18191B', fontSize: '0.79rem' }}>{e.vendor_name}</td>
                    <td style={{ ...T.td, textAlign: 'center' }}><SectionBadge code={e.section || 'Unknown'} /></td>
                    <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: '#DC2626', fontWeight: 700 }}>{inr(e.tds_amount)}</td>
                    <td style={{ ...T.td, textAlign: 'center', fontFamily: 'monospace', fontSize: '0.73rem' }}>{e.bill_date}</td>
                    <td style={{ ...T.td, textAlign: 'center', fontFamily: 'monospace', color: '#DC2626', fontWeight: 700 }}>{e.days_after_due}d</td>
                    <td style={{ ...T.td, fontSize: '0.73rem', color: '#5D6C7B' }}>{e.recommendation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══ ANALYSIS TABLES (3 columns) ═══════════════════════════════════════ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.65rem', marginBottom: '0.85rem' }}>

        {/* Section-wise Analysis */}
        <Panel dot="#3b82f6" title="Section-wise Analysis" subtitle={report?.period}
          action={{ label: 'View Full Report', onClick: () => {} }}>
          {loading ? <Spinner /> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={T.table}>
                <thead><tr>
                  <th style={T.th}>Section</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Payable</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Paid</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Diff.</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Outstanding</th>
                </tr></thead>
                <tbody>
                  {filteredSections.length === 0
                    ? <tr><td colSpan={5} style={{ ...T.td, textAlign: 'center', color: '#9BA8B0', padding: '1.5rem' }}>No data</td></tr>
                    : filteredSections.map((s2, i) => <SectionRow key={s2.section} s={s2} idx={i} />)}
                </tbody>
                {filteredSections.length > 0 && (
                  <tfoot><tr style={{ borderTop: '1px solid #DFE7E3', background: 'rgba(0,0,0,0.02)' }}>
                    <td style={{ ...T.td, fontWeight: 700, color: '#5D6C7B', fontSize: '0.72rem' }}>Total</td>
                    <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#B45309', fontSize: '0.79rem' }}>{inr(s.total_payable)}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#15803D', fontSize: '0.79rem' }}>{inr(s.total_paid)}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#B45309', fontSize: '0.79rem' }}>{inr(s.pending)}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#9BA8B0', fontSize: '0.79rem' }}>{inr(s.pending)}</td>
                  </tr></tfoot>
                )}
              </table>
            </div>
          )}
        </Panel>

        {/* Month-wise Analysis */}
        <Panel dot="#10b981" title="Month-wise Analysis" subtitle="Last 5 months"
          action={{ label: 'View Full Report', onClick: () => {} }}>
          {trendData.length === 0 ? <Spinner /> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={T.table}>
                <thead><tr>
                  <th style={T.th}>Month</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Payable</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Paid</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Outstanding</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Difference</th>
                </tr></thead>
                <tbody>
                  {trendData.map((d, i) => (
                    <tr key={i} className="tds-row-hover" style={{ cursor: 'pointer', background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)' }}>
                      <td style={{ ...T.td, color: '#9BA8B0', fontFamily: 'monospace', fontSize: '0.76rem' }}>{d.month}</td>
                      <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: '#B45309', fontSize: '0.79rem' }}>{inr(d.payable)}</td>
                      <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: '#15803D', fontSize: '0.79rem' }}>{inr(d.paid)}</td>
                      <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: d.outstanding > 0 ? '#DC2626' : '#15803D', fontSize: '0.79rem' }}>{inr(d.outstanding)}</td>
                      <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: '#5D6C7B', fontSize: '0.79rem' }}>{inr(d.payable - d.paid)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr style={{ borderTop: '1px solid #DFE7E3', background: 'rgba(0,0,0,0.02)' }}>
                  <td style={{ ...T.td, fontWeight: 700, color: '#5D6C7B', fontSize: '0.72rem' }}>Total</td>
                  <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#B45309', fontSize: '0.79rem' }}>{inr(trendData.reduce((a, d) => a + d.payable, 0))}</td>
                  <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#15803D', fontSize: '0.79rem' }}>{inr(trendData.reduce((a, d) => a + d.paid, 0))}</td>
                  <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#9BA8B0', fontSize: '0.79rem' }}>{inr(trendData.reduce((a, d) => a + d.outstanding, 0))}</td>
                  <td style={T.td}></td>
                </tr></tfoot>
              </table>
            </div>
          )}
        </Panel>

        {/* Quarter-wise Analysis */}
        <Panel dot="#8b5cf6" title="Quarter-wise Analysis" subtitle={fyFilter}
          action={{ label: 'View Full Report', onClick: () => {} }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={T.table}>
              <thead><tr>
                <th style={T.th}>Quarter</th>
                <th style={{ ...T.th, textAlign: 'right' }}>Payable</th>
                <th style={{ ...T.th, textAlign: 'right' }}>Paid</th>
                <th style={{ ...T.th, textAlign: 'right' }}>Outstanding</th>
                <th style={{ ...T.th, textAlign: 'right' }}>Difference</th>
              </tr></thead>
              <tbody>
                {quarterRows.map((d, i) => (
                  <tr key={d.quarter} className="tds-row-hover" style={{ cursor: 'pointer', background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)' }}>
                    <td style={{ ...T.td, color: '#9BA8B0', fontWeight: 600, fontSize: '0.79rem' }}>{d.quarter}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: '#B45309', fontSize: '0.79rem' }}>{inr(d.payable)}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: '#15803D', fontSize: '0.79rem' }}>{inr(d.paid)}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: d.outstanding > 0 ? '#DC2626' : '#15803D', fontSize: '0.79rem' }}>{inr(d.outstanding)}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: '#5D6C7B', fontSize: '0.79rem' }}>{inr(d.payable - d.paid)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr style={{ borderTop: '1px solid #DFE7E3', background: 'rgba(0,0,0,0.02)' }}>
                <td style={{ ...T.td, fontWeight: 700, color: '#5D6C7B', fontSize: '0.72rem' }}>Total</td>
                <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#B45309', fontSize: '0.79rem' }}>{inr(quarterRows.reduce((a, d) => a + d.payable, 0))}</td>
                <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#15803D', fontSize: '0.79rem' }}>{inr(quarterRows.reduce((a, d) => a + d.paid, 0))}</td>
                <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#9BA8B0', fontSize: '0.79rem' }}>{inr(quarterRows.reduce((a, d) => a + d.outstanding, 0))}</td>
                <td style={T.td}></td>
              </tr></tfoot>
            </table>
          </div>
        </Panel>
      </div>

      {/* ══ MIDDLE SECTION (4 columns) ════════════════════════════════════════ */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.65rem', marginBottom: '0.85rem' }}>

        {/* Prev Outstanding Breakdown */}
        <Panel dot="#f59e0b" title="Prev. Outstanding" subtitle="Month-wise breakdown"
          action={{ label: 'Drill Down', onClick: () => {} }}>
          <div style={{ padding: '0.35rem 0' }}>
            {prevRows.length === 0 ? <Spinner /> : (
              <>
                {prevRows.map((d, i) => (
                  <div key={i} className="tds-row-hover" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.42rem 1rem', cursor: 'pointer', borderBottom: '1px solid #DFE7E3' }}>
                    <span style={{ color: '#9BA8B0', fontSize: '0.76rem' }}>{d.month}</span>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.79rem', color: '#B45309', fontWeight: 600 }}>{inr(d.outstanding)}</span>
                      <span style={{ fontSize: '0.68rem', color: '#5D6C7B', minWidth: 36, textAlign: 'right' }}>
                        {prevTotal > 0 ? `${Math.round((d.outstanding / prevTotal) * 100)}%` : '—'}
                      </span>
                    </div>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 1rem', borderTop: '1px solid #DFE7E3', background: 'rgba(0,0,0,0.02)' }}>
                  <span style={{ color: '#5D6C7B', fontWeight: 700, fontSize: '0.72rem' }}>Total</span>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: '#B45309', fontWeight: 700 }}>{inr(prevTotal)}</span>
                </div>
              </>
            )}
          </div>
        </Panel>

        {/* Payment Summary */}
        <Panel dot="#10b981" title="Payment Summary" subtitle={report?.period}>
          <div style={{ padding: '0.35rem 0' }}>
            {[
              { label: 'Total Payable',    value: inr(s.total_payable), color: '#9BA8B0' },
              { label: 'Total Paid',       value: inr(s.total_paid),    color: '#15803D' },
              { label: 'Total Outstanding',value: inr(s.pending),       color: '#B45309' },
              { label: 'Next Due Date',    value: report?.due_date || '—', color: '#1C4942' },
            ].map((r, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.52rem 1rem', borderBottom: '1px solid #DFE7E3' }}>
                <span style={{ color: '#5D6C7B', fontSize: '0.76rem' }}>{r.label}</span>
                <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: r.color, fontWeight: 600 }}>{r.value}</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* Payment Status Donut */}
        <Panel dot="#3b82f6" title="Payment Status" subtitle="By TDS amount">
          {loading ? <Spinner /> : donutData.length === 0
            ? <div style={{ color: '#9BA8B0', textAlign: 'center', padding: '1.5rem', fontSize: '0.75rem' }}>No data</div>
            : (
              <>
                <ResponsiveContainer width="100%" height={110}>
                  <PieChart>
                    <Pie data={donutData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={30} outerRadius={48}>
                      {donutData.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Pie>
                    <Tooltip formatter={(v) => inr(v)} contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, fontSize: '0.72rem' }} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ padding: '0 0.85rem 0.65rem' }}>
                  {donutData.map((d, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.18rem 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: d.color, flexShrink: 0 }} />
                        <span style={{ fontSize: '0.7rem', color: '#9BA8B0' }}>{d.name}</span>
                      </div>
                      <span style={{ fontSize: '0.7rem', color: d.color, fontFamily: 'monospace', fontWeight: 600 }}>{inr(d.value)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
        </Panel>

        {/* Smart Alerts */}
        <Panel dot="#ef4444" title="Smart Alerts"
          badge={smartAlerts.length > 0 ? (
            <span style={{ fontSize: '0.65rem', background: 'rgba(220,38,38,0.08)', color: '#DC2626', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}>
              {smartAlerts.length}
            </span>
          ) : null}>
          <div style={{ padding: '0.25rem 0' }}>
            {loading ? <Spinner /> : smartAlerts.length === 0
              ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.85rem 1rem', color: '#15803D', fontSize: '0.77rem' }}>
                  <CheckCircle2 size={13} /> No alerts for this period.
                </div>
              )
              : smartAlerts.map((a, i) => {
                const Icon = a.icon;
                return (
                  <div key={i} className="tds-row-hover" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '0.52rem 1rem', borderBottom: '1px solid #DFE7E3', cursor: 'pointer' }}>
                    <Icon size={12} color={a.color} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ fontSize: '0.75rem', color: '#9BA8B0', lineHeight: 1.45, flex: 1 }}>{a.text}</span>
                    <ChevronRight size={11} color="#DFE7E3" style={{ flexShrink: 0, marginTop: 1 }} />
                  </div>
                );
              })}
          </div>
        </Panel>
      </div>

      {/* ══ BOTTOM SECTION (3 columns) ════════════════════════════════════════ */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: '0.65rem', marginBottom: '0.75rem' }}>

        {/* Payable vs Paid — Bar Chart */}
        <Panel dot="#3b82f6" title="Payable vs Paid" subtitle="Month-wise">
          <div style={{ padding: '0.5rem 0.4rem 0.4rem' }}>
            {trendData.length === 0 ? <Spinner /> : (
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={trendData} barSize={7} barGap={1}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#DFE7E3" />
                  <XAxis dataKey="month" tick={{ fill: '#5D6C7B', fontSize: 8 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#5D6C7B', fontSize: 8 }} axisLine={false} tickLine={false} tickFormatter={v => v === 0 ? '0' : `${(v/1000).toFixed(0)}K`} />
                  <Tooltip content={<DarkTooltip />} />
                  <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: '0.65rem', color: '#9BA8B0' }} />
                  <Bar dataKey="payable" name="Payable" fill="#f59e0b" radius={[2,2,0,0]} />
                  <Bar dataKey="paid"    name="Paid"    fill="#10b981" radius={[2,2,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Panel>

        {/* Outstanding Trend — Line Chart */}
        <Panel dot="#f59e0b" title="Outstanding Trend" subtitle="Month-wise">
          <div style={{ padding: '0.5rem 0.4rem 0.4rem' }}>
            {trendData.length === 0 ? <Spinner /> : (
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#DFE7E3" />
                  <XAxis dataKey="month" tick={{ fill: '#5D6C7B', fontSize: 8 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#5D6C7B', fontSize: 8 }} axisLine={false} tickLine={false} tickFormatter={v => v === 0 ? '0' : `${(v/1000).toFixed(0)}K`} />
                  <Tooltip content={<DarkTooltip />} />
                  <Line type="monotone" dataKey="outstanding" name="Outstanding" stroke="#f59e0b" strokeWidth={2} dot={{ fill: '#f59e0b', r: 3 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </Panel>

        {/* Vendor Wise Outstanding Report — expanded now that Quick Actions is removed */}
        <Panel dot="#06b6d4" title="Vendor Outstanding" subtitle="By TDS deducted — Top 10"
          action={{ label: 'All Vendors', onClick: () => {} }}>
          {loading ? <Spinner /> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={T.table}>
                <thead><tr>
                  <th style={T.th}>Vendor</th>
                  <th style={{ ...T.th, textAlign: 'center' }}>Sec.</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>TDS Amount</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>% Share</th>
                </tr></thead>
                <tbody>
                  {vendorRows.length === 0
                    ? <tr><td colSpan={4} style={{ ...T.td, textAlign: 'center', color: '#9BA8B0', padding: '1.5rem' }}>No vendor data</td></tr>
                    : vendorRows.map((v, i) => (
                      <tr key={i} className="tds-row-hover" style={{ cursor: 'pointer', background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)' }}>
                        <td style={{ ...T.td, color: '#18191B', fontSize: '0.76rem', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.vendor}</td>
                        <td style={{ ...T.td, textAlign: 'center' }}><SectionBadge code={v.section} /></td>
                        <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.76rem', color: '#B45309', fontWeight: 600 }}>{inr(v.amount)}</td>
                        <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', fontSize: '0.73rem', color: '#5D6C7B' }}>
                          {vendorTotal > 0 ? `${((v.amount / vendorTotal) * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
                {vendorRows.length > 0 && (
                  <tfoot><tr style={{ borderTop: '1px solid #DFE7E3', background: 'rgba(0,0,0,0.02)' }}>
                    <td colSpan={2} style={{ ...T.td, fontWeight: 700, color: '#5D6C7B', fontSize: '0.71rem' }}>Total</td>
                    <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#B45309', fontSize: '0.79rem' }}>{inr(vendorTotal)}</td>
                    <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: '#5D6C7B', fontSize: '0.73rem' }}>100%</td>
                  </tr></tfoot>
                )}
              </table>
            </div>
          )}
        </Panel>
      </div>

      {/* ══ FOOTER ════════════════════════════════════════════════════════════ */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#9BA8B0', fontSize: '0.7rem', padding: '0.25rem 0' }}>
        <Info size={11} color="#9BA8B0" />
        All figures are dynamically updated based on selected filters. Click on any value to drill down for detailed view.
      </div>
    </div>
  );
}

// ─── Shared table styles ──────────────────────────────────────────────────────
const T = {
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.79rem' },
  th:    { padding: '0.42rem 0.85rem', textAlign: 'left', fontSize: '0.63rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#9BA8B0', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  td:    { padding: '0.48rem 0.85rem', color: '#18191B', borderBottom: '1px solid #DFE7E3', verticalAlign: 'middle' },
};
