import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../utils/api';

// Previous 3 years from audited annual report (values were in Millions → actual ₹)
const STATIC_YEARS = [
  { label: 'As at\nMarch 31,\n2025', top_customer_revenue: Math.round(130.77 * 1_000_000), ten_pct_total: null },
  { label: 'As at\nMarch 31,\n2024', top_customer_revenue: Math.round(86.11  * 1_000_000), ten_pct_total: null },
  { label: 'As at\nMarch 31,\n2023', top_customer_revenue: Math.round(56.68  * 1_000_000), ten_pct_total: null },
];

const LIVE_COLS = [
  { key: 'q1',  label: 'Q-1\nApr–Jun\n2025' },
  { key: 'q2',  label: 'Q-2\nJul–Sep\n2025' },
  { key: 'q3',  label: 'Q-3\nOct–Dec\n2025' },
  { key: 'q4',  label: 'Q-4\nJan–Mar\n2026' },
  { key: 'ytd', label: 'Year to\nDate' },
];

const ROWS = [
  { key: 'top',     label: 'Revenue from top customer' },
  { key: 'ten_pct', label: "Revenue from customers contributing 10% or more to the Company's revenues" },
];

const inr = n =>
  typeof n === 'number' && n > 0
    ? `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : '—';

export default function TopCustomerRevenueReport() {
  const [liveData, setLiveData] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(false);

  async function load() {
    setLoading(true);
    setError(false);
    try { setLiveData(await api.topCustomerRevenue()); }
    catch { setError(true); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const thBase = {
    padding: '0.6rem 0.9rem', color: '#5D6C7B', fontWeight: 600,
    fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em',
    background: '#F9F9F9', borderBottom: '1px solid #DFE7E3',
  };
  const tdBase = { padding: '0.85rem 0.9rem', borderBottom: '1px solid #F2F2F2' };

  function LiveCell({ colKey, rowKey }) {
    if (loading) return <span style={{ color: '#DFE7E3' }}>—</span>;
    if (error)   return <span style={{ color: '#DC2626', fontSize: '0.75rem' }}>Error</span>;
    const d = liveData?.[colKey];
    if (!d) return <span style={{ color: '#DFE7E3' }}>—</span>;

    if (rowKey === 'top') {
      return (
        <div>
          <div style={{ color: '#18191B', fontWeight: 600 }}>{inr(d.top_customer_revenue)}</div>
          {colKey === 'ytd' && d.top_customer_name && (
            <div style={{ color: '#9BA8B0', fontSize: '0.68rem', marginTop: 2 }}>{d.top_customer_name}</div>
          )}
        </div>
      );
    }
    if (rowKey === 'ten_pct') {
      return d.ten_pct_total
        ? <span style={{ color: '#18191B', fontWeight: 600 }}>{inr(d.ten_pct_total)}</span>
        : <span style={{ color: '#9BA8B0' }}>-</span>;
    }
    return '—';
  }

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,18,20,0.06)' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '1.25rem 1.5rem', borderBottom: '1px solid #DFE7E3', gap: '1rem' }}>
        <div>
          <h3 style={{ margin: 0, color: '#18191B', fontSize: '1rem', fontWeight: 700, lineHeight: 1.4 }}>
            Revenue Generated From Top Customer and Revenue From Transactions with Customers
            Amounting to 10% or More of Company's Revenue
          </h3>
          <p style={{ margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.8rem' }}>
            FY 2025-26 sourced live from Zoho Books · Prior years from audited annual report · Amounts in ₹
          </p>
        </div>
        <button onClick={load} disabled={loading} style={{ display: 'flex', alignItems: 'center', flexShrink: 0, background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '0.45rem 0.9rem', borderRadius: 7, cursor: 'pointer', fontSize: '0.82rem' }}>
          <RefreshCw size={14} style={{ marginRight: 4, animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            {/* ── Row 1: group labels ── */}
            <tr>
              <th rowSpan={2} style={{ ...thBase, width: 44, textAlign: 'center', verticalAlign: 'bottom', borderRight: '1px solid #DFE7E3' }}>
                Sr.<br />No.
              </th>
              <th rowSpan={2} style={{ ...thBase, textAlign: 'left', verticalAlign: 'bottom', borderRight: '1px solid #DFE7E3' }}>
                Particulars
              </th>
              {/* FY 2025-26 group */}
              <th
                colSpan={LIVE_COLS.length}
                style={{ ...thBase, textAlign: 'center', borderRight: '1px solid #DFE7E3', color: '#1C4942', borderBottom: '1px solid #DFE7E3', paddingBottom: '0.5rem' }}
              >
                FY 2025-26 &nbsp;
                <span style={{ fontSize: '0.6rem', background: '#EAF4EF', color: '#1C4942', padding: '1px 6px', borderRadius: 4, verticalAlign: 'middle' }}>LIVE</span>
              </th>
              {/* Static annual group */}
              <th
                colSpan={STATIC_YEARS.length}
                style={{ ...thBase, textAlign: 'center', color: '#9BA8B0', borderBottom: '1px solid #DFE7E3', paddingBottom: '0.5rem' }}
              >
                Annual (Audited)
              </th>
            </tr>

            {/* ── Row 2: individual column headers ── */}
            <tr>
              {LIVE_COLS.map(col => (
                <th key={col.key} style={{ ...thBase, textAlign: 'right', whiteSpace: 'pre-line', lineHeight: 1.4, width: 130, borderRight: col.key === 'ytd' ? '1px solid #DFE7E3' : undefined }}>
                  {col.label}
                </th>
              ))}
              {STATIC_YEARS.map((col, i) => (
                <th key={i} style={{ ...thBase, textAlign: 'right', whiteSpace: 'pre-line', lineHeight: 1.4, width: 160 }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {ROWS.map((row, idx) => (
              <tr key={row.key} style={{ background: idx % 2 === 0 ? 'transparent' : '#F9F9F9' }}>
                <td style={{ ...tdBase, textAlign: 'center', color: '#9BA8B0', borderRight: '1px solid #DFE7E3' }}>{idx + 1}</td>
                <td style={{ ...tdBase, color: '#18191B', maxWidth: 320, borderRight: '1px solid #DFE7E3' }}>{row.label}</td>

                {/* Live quarterly + YTD cells */}
                {LIVE_COLS.map(col => (
                  <td key={col.key} style={{ ...tdBase, textAlign: 'right', verticalAlign: 'top', borderRight: col.key === 'ytd' ? '1px solid #DFE7E3' : undefined }}>
                    <LiveCell colKey={col.key} rowKey={row.key} />
                  </td>
                ))}

                {/* Static annual cells */}
                {STATIC_YEARS.map((col, si) => (
                  <td key={si} style={{ ...tdBase, textAlign: 'right', verticalAlign: 'top' }}>
                    {row.key === 'top'
                      ? <span style={{ color: '#18191B', fontWeight: 600 }}>{inr(col.top_customer_revenue)}</span>
                      : <span style={{ color: '#9BA8B0' }}>-</span>
                    }
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
