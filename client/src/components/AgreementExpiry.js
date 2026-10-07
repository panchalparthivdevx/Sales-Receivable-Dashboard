import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';

function fmtDate(d) { if (!d) return '—'; const [y,m,day] = d.split('-'); return `${day}/${m}/${y}`; }
function fmt(n) { return n != null ? '₹' + Number(n).toLocaleString('en-IN') : '—'; }

function ExpiryTable({ items }) {
  if (!items || items.length === 0)
    return <p style={{ color: '#475569', fontSize: '0.82rem', padding: '0.75rem 0', margin: 0 }}>No agreements expiring in this period.</p>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={S.table}>
        <thead>
          <tr>
            {['Branch', 'Client', 'Seats', 'Rate/Seat', 'Agreement End', 'Lock-in End', 'Term', 'Lock-in', 'Notice Period', 'Alert'].map(h => (
              <th key={h} style={S.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((r, i) => (
            <tr key={i} style={i % 2 === 0 ? S.trEven : S.trOdd}>
              <td style={S.td}><span style={S.badge}>{r.branch}</span></td>
              <td style={{ ...S.td, fontWeight: 600, color: '#e2e8f0' }}>{r.client}</td>
              <td style={S.tdNum}>{r.no_of_seats ?? '—'}</td>
              <td style={S.tdNum}>{r.rate_per_seat ? fmt(r.rate_per_seat) : '—'}</td>
              <td style={{ ...S.td, color: r.end_expires ? '#ef4444' : '#64748b', fontWeight: r.end_expires ? 700 : 400 }}>
                {fmtDate(r.end_date)}
              </td>
              <td style={{ ...S.td, color: r.lock_in_expires ? '#f59e0b' : '#64748b', fontWeight: r.lock_in_expires ? 700 : 400 }}>
                {fmtDate(r.lock_in_date)}
              </td>
              <td style={S.td}>{r.agreement_term || '—'}</td>
              <td style={S.td}>{r.lock_in_term || '—'}</td>
              <td style={S.td}>{r.notice_period || '—'}</td>
              <td style={S.td}>
                {r.end_expires    && <span style={S.alertRed}>Agreement Ends</span>}
                {r.lock_in_expires && <span style={S.alertAmber}>Lock-in Ends</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AgreementExpiry() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const [tab, setTab]         = useState('current_month');

  const load = () => {
    setLoading(true); setError(false);
    api.agreementExpiry()
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setLoading(false); setError(true); });
  };

  useEffect(() => { load(); }, []);

  const tabs = [
    { key: 'current_month',   label: 'This Month' },
    { key: 'current_quarter', label: 'This Quarter' },
    { key: 'next_quarter',    label: 'Next Quarter' },
  ];

  if (loading) return (
    <div style={S.section}>
      <h3 style={S.title}>Agreement Term & Lock-in Expiry Alerts</h3>
      <div style={{ color: '#64748b', padding: '1.5rem 0' }}>Loading…</div>
    </div>
  );

  if (error) return (
    <div style={S.section}>
      <h3 style={S.title}>Agreement Term & Lock-in Expiry Alerts</h3>
      <div style={{ textAlign: 'center', padding: '1.5rem', color: '#64748b' }}>
        <p style={{ margin: '0 0 0.5rem' }}>Could not load expiry data.</p>
        <button style={S.retryBtn} onClick={load}>Retry</button>
      </div>
    </div>
  );

  const totalAlerts = Object.values(data || {}).reduce((s, d) => s + (d.items?.length || 0), 0);

  if (totalAlerts === 0) return (
    <div style={S.section}>
      <h3 style={S.title}>Agreement Term & Lock-in Expiry Alerts</h3>
      <p style={{ color: '#22c55e', fontSize: '0.85rem', margin: 0 }}>
        No agreements expiring in this month, current quarter, or next quarter.
        {totalAlerts === 0 && ' (Enter agreement data via the Master Report above to see expiry alerts.)'}
      </p>
    </div>
  );

  const active = data[tab];

  return (
    <div style={S.section}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h3 style={S.title}>Agreement Term & Lock-in Expiry Alerts</h3>
          <p style={S.sub}>Agreements whose term or lock-in period ends in the selected window</p>
        </div>
        <div style={S.totalBadge}>{totalAlerts} total alerts</div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {tabs.map(t => {
          const count = data[t.key]?.items?.length || 0;
          return (
            <button key={t.key}
              style={{ ...S.tab, ...(tab === t.key ? S.tabActive : {}) }}
              onClick={() => setTab(t.key)}>
              {t.label}
              <span style={{ ...S.tabCount, background: tab === t.key ? '#3b82f6' : '#334155' }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Period label */}
      {active && (
        <p style={{ margin: 0, color: '#5D6C7B', fontSize: '0.78rem' }}>Period: <b style={{ color: '#18191B' }}>{active.label}</b></p>
      )}

      {/* Table */}
      <ExpiryTable items={active?.items || []} />

      {/* Legend */}
      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid #DFE7E3' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: '#9BA8B0' }}>
          <span style={S.alertRed}>Agreement Ends</span> Agreement expiry date falls in this period
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: '#9BA8B0' }}>
          <span style={S.alertAmber}>Lock-in Ends</span> Lock-in period ends in this period (renewal window opens)
        </span>
      </div>
    </div>
  );
}

const S = {
  section: { background: '#FFFFFF', borderRadius: '10px', border: '1px solid #DFE7E3', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.85rem', boxShadow: '0 1px 3px rgba(0,18,20,0.06)' },
  title: { margin: 0, color: '#18191B', fontSize: '0.95rem', fontWeight: 600 },
  sub: { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.78rem' },
  totalBadge: { padding: '4px 12px', borderRadius: 20, background: '#FEF2F2', color: '#DC2626', fontSize: '0.82rem', fontWeight: 700, whiteSpace: 'nowrap' },
  retryBtn: { background: '#1C4942', border: 'none', color: '#fff', padding: '6px 16px', borderRadius: 6, cursor: 'pointer', fontSize: '0.82rem' },
  tabs: { display: 'flex', gap: '0.5rem' },
  tab: { background: '#F2F2F2', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '0.4rem 0.85rem', borderRadius: 6, cursor: 'pointer', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.5rem' },
  tabActive: { background: '#EAF4EF', border: '1px solid #A7C4BC', color: '#1C4942' },
  tabCount: { padding: '1px 7px', borderRadius: 10, fontSize: '0.72rem', color: '#fff', fontWeight: 700 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
  th: { padding: '0.55rem 0.75rem', textAlign: 'left', color: '#5D6C7B', fontWeight: 600, fontSize: '0.72rem', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  td: { padding: '0.5rem 0.75rem', color: '#18191B', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  tdNum: { padding: '0.5rem 0.75rem', textAlign: 'right', color: '#18191B', verticalAlign: 'middle' },
  trEven: { background: '#FFFFFF' },
  trOdd: { background: '#F9F9F9' },
  badge: { background: '#EAF4EF', color: '#1C4942', padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600 },
  alertRed:   { background: '#FEF2F2', color: '#DC2626', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700 },
  alertAmber: { background: '#FFFBEB', color: '#B45309', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700 },
};
