import React, { useState, useEffect, useCallback } from 'react';
import {
  TrendingDown, CheckCircle2, AlertTriangle,
  Calendar, RefreshCw, FileText, ArrowRight,
} from 'lucide-react';
import { api } from '../utils/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const inr = (n) =>
  typeof n === 'number'
    ? `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : '—';

function monthOptions() {
  const opts = [];
  const now  = new Date();
  for (let i = 0; i < 24; i++) {
    const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym  = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const lbl = d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
    opts.push({ value: ym, label: lbl });
  }
  return opts;
}
const MONTHS    = monthOptions();
const CUR_MONTH = MONTHS[0].value;

// ─── Sub-components (identical to TDSPayableDashboard) ────────────────────────
function KCard({ num, title, color, icon: Icon, loading, onClick, children }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: '#FFFFFF', border: '1px solid #DFE7E3',
        borderTop: `3px solid ${color}`, borderRadius: 10,
        overflow: 'hidden', cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ padding: '0.8rem 1.1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: '0.6rem' }}>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon size={12} color={color} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: '0.6rem', fontFamily: 'monospace', color, fontWeight: 700 }}>{num}.</span>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#5D6C7B' }}>{title}</span>
          </div>
        </div>
        {loading
          ? <div style={{ height: 68, background: '#EAF4EF', borderRadius: 6 }} />
          : <div>{children}</div>}
      </div>
    </div>
  );
}

function KRow({ label, value, dim }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.18rem 0', gap: 8 }}>
      <span style={{ fontSize: '0.7rem', color: dim ? '#DFE7E3' : '#5D6C7B', flexShrink: 0 }}>{label}</span>
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
      <span style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9BA8B0', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '1.05rem', fontFamily: 'monospace', fontWeight: 700, color, whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function TDSKPIOverview() {
  const [month,   setMonth]   = useState(CUR_MONTH);
  const [report,  setReport]  = useState(null);
  const [loading, setLoading] = useState(false);
  const [bdOpen,  setBdOpen]  = useState(false);

  const fetchReport = useCallback(async (m) => {
    setLoading(true);
    try {
      const data = await api.tdsPayableMonthly(m);
      setReport(data);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchReport(month); }, [month, fetchReport]);

  // ── Derived values ─────────────────────────────────────────────────────────
  const s      = report?.summary  || {};
  const alerts = report?.alerts   || {};

  const bdCount  = alerts.backdated_entries?.length || 0;
  const bdImpact = (alerts.backdated_entries || []).reduce((a, e) => a + (e.tds_amount || 0), 0);

  const daysAbs   = Math.abs(report?.days_to_due || 0);
  const isOverdue = report?.is_overdue;
  const isPaid    = s.payment_status === 'fully_paid';
  const statusLabel = isOverdue ? 'Overdue' : (isPaid ? 'Completed' : (daysAbs === 0 ? 'Due Today' : 'Upcoming'));
  const statusColor = isOverdue ? '#ef4444' : (isPaid ? '#10b981' : '#f59e0b');

  const selectedLabel = MONTHS.find(m => m.value === month)?.label || month;

  return (
    <div style={{ width: '100%' }}>

      {/* Section header + month picker */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.9rem' }}>
        <div>
          <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.88rem' }}>TDS Overview</div>
          <div style={{ color: '#9BA8B0', fontSize: '0.72rem', marginTop: 2 }}>
            Consolidated KPI snapshot · {selectedLabel}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={month}
            onChange={e => setMonth(e.target.value)}
            style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B', borderRadius: 6, padding: '4px 10px', fontSize: '0.75rem', cursor: 'pointer', outline: 'none', fontFamily: 'inherit' }}
          >
            {MONTHS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            onClick={() => fetchReport(month)}
            disabled={loading}
            style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F2F2F2', border: '1px solid #DFE7E3', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', color: '#5D6C7B' }}
          >
            <RefreshCw size={12} style={{ animation: loading ? 'kpi-spin 1s linear infinite' : 'none' }} />
          </button>
        </div>
      </div>

      {/* ── 3 × 2 KPI Grid ──────────────────────────────────────────────────── */}
      <style>{`@keyframes kpi-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>

        {/* 1. Outstanding TDS */}
        <KCard num="1" title="Outstanding TDS" color="#f59e0b" icon={TrendingDown} loading={loading}>
          <KRow label="Previous Outstanding"       value={inr(0)} dim />
          <KRow label="Current Period Outstanding" value={inr(s.pending)} />
          <KDash />
          <KTotal label="Total Outstanding" value={inr(s.pending)} color="#f59e0b" />
        </KCard>

        {/* 2. TDS Payable */}
        <KCard num="2" title="TDS Payable" color="#3b82f6" icon={FileText} loading={loading}>
          <KRow label="Current Period Payable"     value={inr(s.total_payable)} />
          <KRow label="Prev. Outstanding Included" value={inr(0)} dim />
          <KDash />
          <KTotal label="Grand Payable" value={inr(s.total_payable)} color="#3b82f6" />
        </KCard>

        {/* 3. TDS Paid */}
        <KCard num="3" title="TDS Paid" color="#10b981" icon={CheckCircle2} loading={loading}>
          <KRow label="Paid This Period"        value={inr(s.total_paid)} />
          <KRow label="Prev. Period Adjustment" value={inr(0)} dim />
          <KDash />
          <KTotal label="Total Paid" value={inr(s.total_paid)} color="#10b981" />
        </KCard>

        {/* 4. Net Liability */}
        <KCard num="4" title="Net Liability" color={s.pending > 0 ? '#ef4444' : '#10b981'} icon={AlertTriangle} loading={loading}>
          <KRow label="Payable" value={inr(s.total_payable)} />
          <KRow label="Paid"    value={`- ${inr(s.total_paid)}`} />
          <KDash />
          <KTotal label="Net Liability" value={inr(s.pending)} color={s.pending > 0 ? '#ef4444' : '#10b981'} />
        </KCard>

        {/* 5. Payment Due */}
        <KCard num="5" title="Payment Due" color={statusColor} icon={Calendar} loading={loading}>
          <KRow label="Next Due Date"  value={report?.due_date || '—'} />
          <KRow label="Days Remaining" value={isOverdue ? `${daysAbs}d overdue` : `${daysAbs} Days`} />
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
        <div style={{ marginTop: '0.75rem', background: '#F2F2F2', border: '1px solid #DFE7E3', borderRadius: 10, padding: '0.85rem 1rem' }}>
          <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.83rem', marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: 7 }}>
            <AlertTriangle size={13} color="#8b5cf6" /> Backdated Entries Detail ({bdCount})
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.79rem' }}>
              <thead><tr>
                {['Bill No.','Vendor','Section','TDS (₹)','Bill Date','Days Late'].map(h => (
                  <th key={h} style={{ padding: '0.42rem 0.85rem', textAlign: h === 'TDS (₹)' || h === 'Days Late' ? 'right' : 'left', fontSize: '0.63rem', fontWeight: 700, textTransform: 'uppercase', color: '#5D6C7B', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {alerts.backdated_entries.map((e, i) => (
                  <tr key={i}>
                    <td style={{ padding: '0.48rem 0.85rem', color: '#5D6C7B', borderBottom: '1px solid #F2F2F2', fontFamily: 'monospace', fontSize: '0.73rem' }}>{e.bill_number}</td>
                    <td style={{ padding: '0.48rem 0.85rem', color: '#18191B', borderBottom: '1px solid #F2F2F2', fontSize: '0.79rem' }}>{e.vendor_name}</td>
                    <td style={{ padding: '0.48rem 0.85rem', borderBottom: '1px solid #F2F2F2' }}>
                      <span style={{ background: 'rgba(139,92,246,0.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.25)', borderRadius: 4, padding: '2px 7px', fontSize: '0.68rem', fontWeight: 700 }}>{e.section || '—'}</span>
                    </td>
                    <td style={{ padding: '0.48rem 0.85rem', color: '#DC2626', borderBottom: '1px solid #F2F2F2', fontFamily: 'monospace', fontWeight: 700, textAlign: 'right' }}>{inr(e.tds_amount)}</td>
                    <td style={{ padding: '0.48rem 0.85rem', color: '#5D6C7B', borderBottom: '1px solid #F2F2F2', fontFamily: 'monospace', fontSize: '0.73rem' }}>{e.bill_date}</td>
                    <td style={{ padding: '0.48rem 0.85rem', color: '#DC2626', borderBottom: '1px solid #F2F2F2', fontFamily: 'monospace', fontWeight: 700, textAlign: 'right' }}>{e.days_after_due}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
