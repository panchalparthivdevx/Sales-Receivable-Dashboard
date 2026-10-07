import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../utils/api';

const FY_LABELS = {
  fy2526: 'F.Y. 2025-26',
  fy2627: 'F.Y. 2026-27',
};

const ROWS = [
  { key: 'earned', label: 'The Foreign Exchange earned in terms of actual inflows during the year' },
  { key: 'outgo',  label: 'The Foreign Exchange outgo during the year in terms of actual outflows' },
];

function CurrencyCell({ groups, loading, error }) {
  if (loading) return <span style={{ color: '#475569' }}>—</span>;
  if (error)   return <span style={{ color: '#ef4444', fontSize: '0.78rem' }}>Error</span>;

  const entries = groups ? Object.entries(groups).filter(([, v]) => v > 0) : [];
  if (entries.length === 0) return <span style={{ color: '#475569', fontStyle: 'italic' }}>NIL</span>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', alignItems: 'flex-end' }}>
      {entries.map(([cc, amount]) => (
        <span key={cc} style={{ color: '#10b981', fontWeight: 600 }}>
          {cc}&nbsp;{amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      ))}
    </div>
  );
}

export default function ForexReport() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await api.forexLive();
      setData(d);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <div>
          <h3 style={s.title}>Details of Foreign Exchange Earnings and Outgo</h3>
          <p style={s.subtitle}>Actual inflows and outflows — sourced from Zoho Books</p>
        </div>
        <button onClick={load} disabled={loading} style={s.refreshBtn}>
          <RefreshCw size={14} style={{ marginRight: 4, animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, width: 60, textAlign: 'center' }}>Sr. No.</th>
              <th style={{ ...s.th, textAlign: 'left' }}>Particular</th>
              {Object.entries(FY_LABELS).map(([fy, label]) => (
                <th key={fy} style={{ ...s.th, width: 240, textAlign: 'right' }}>{label} Amount</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row, idx) => (
              <tr key={row.key} style={idx % 2 === 0 ? s.rowEven : s.rowOdd}>
                <td style={{ ...s.td, textAlign: 'center', color: '#9BA8B0' }}>{idx + 1}</td>
                <td style={{ ...s.td, color: '#18191B' }}>{row.label}</td>
                {Object.keys(FY_LABELS).map(fy => (
                  <td key={fy} style={{ ...s.td, textAlign: 'right', verticalAlign: 'top' }}>
                    <CurrencyCell
                      groups={data?.[fy]?.[row.key]}
                      loading={loading}
                      error={error}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const s = {
  wrap:      { background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,18,20,0.06)' },
  header:    { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '1.25rem 1.5rem', borderBottom: '1px solid #DFE7E3' },
  title:     { margin: 0, color: '#18191B', fontSize: '1rem', fontWeight: 700 },
  subtitle:  { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.82rem' },
  tableWrap: { overflowX: 'auto' },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' },
  th:        { padding: '0.75rem 1.25rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3' },
  td:        { padding: '0.9rem 1.25rem', borderBottom: '1px solid #F2F2F2' },
  rowEven:   { background: 'transparent' },
  rowOdd:    { background: '#F9F9F9' },
  refreshBtn:{ display: 'flex', alignItems: 'center', background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '0.45rem 0.9rem', borderRadius: 7, cursor: 'pointer', fontSize: '0.82rem' },
};
