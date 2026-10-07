import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../utils/api';

// ── Hardcoded annual figures from audited annual reports ───────────────────────
const STATIC_YEARS = [
  {
    label:            'As at\nMarch 31,\n2026',
    total_clients:    335,
    managed_offices:  86,
    coworking_spaces: 211,
    occupied_seats:   12015,
    occupancy_pct:    90.31,
    built_up_area:    829256,
  },
  {
    label:            'As at\nMarch 31,\n2025',
    total_clients:    468,
    managed_offices:  103,
    coworking_spaces: 365,
    occupied_seats:   12054,
    occupancy_pct:    87.61,
    built_up_area:    835035,
  },
  {
    label:            'As at\nMarch 31,\n2024',
    total_clients:    300,
    managed_offices:  69,
    coworking_spaces: 231,
    occupied_seats:   10422,
    occupancy_pct:    83.09,
    built_up_area:    806635,
  },
  {
    label:            'As at\nMarch 31,\n2023',
    total_clients:    227,
    managed_offices:  55,
    coworking_spaces: 172,
    occupied_seats:   8218,
    occupancy_pct:    80.85,
    built_up_area:    628737,
  },
];

const LIVE_COLS = [
  { key: 'q1',  label: 'Q-1\nApr–Jun\n2026' },
  { key: 'q2',  label: 'Q-2\nJul–Sep\n2026' },
  { key: 'q3',  label: 'Q-3\nOct–Dec\n2026' },
  { key: 'q4',  label: 'Q-4\nJan–Mar\n2027' },
  { key: 'ytd', label: 'Year to\nDate' },
];

const ROWS = [
  { key: 'total_clients',    label: 'Total number of clients',                               fmt: 'int'  },
  { key: 'managed_offices',  label: 'Managed office spaces',                                 fmt: 'int'  },
  { key: 'coworking_spaces', label: 'Co-working spaces',                                     fmt: 'int'  },
  { key: 'occupied_seats',   label: 'Number of Occupied Seats in Operational Centers ¹',     fmt: 'int'  },
  { key: 'occupancy_pct',    label: 'Occupancy rate in Operational Centers ² (%)',            fmt: 'pct'  },
  { key: 'built_up_area',    label: 'Operational Super Built-Up Area ³ (in sq. ft)',          fmt: 'area' },
];

function fmtVal(v, fmt) {
  if (v == null) return '—';
  if (fmt === 'pct')  return `${Number(v).toFixed(2)}%`;
  return Number(v).toLocaleString('en-IN');
}

export default function OperationalDataReport() {
  const [liveData, setLiveData] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(false);

  async function load() {
    setLoading(true);
    setError(false);
    try { setLiveData(await api.operationalData()); }
    catch { setError(true); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const thBase = {
    padding: '0.6rem 0.85rem', color: '#5D6C7B', fontWeight: 600,
    fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em',
    background: '#F9F9F9', borderBottom: '1px solid #DFE7E3',
  };
  const tdBase = { padding: '0.8rem 0.85rem', borderBottom: '1px solid #F2F2F2' };

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,18,20,0.06)' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '1.25rem 1.5rem', borderBottom: '1px solid #DFE7E3', gap: '1rem' }}>
        <div>
          <h3 style={{ margin: 0, color: '#18191B', fontSize: '1rem', fontWeight: 700 }}>Operational Data</h3>
          <p style={{ margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.8rem' }}>
            FY 2026-27 sourced live from Zoho Books · Prior years from audited annual report
            {loading && <span style={{ color: '#3b82f6', marginLeft: 8 }}>Computing — first load may take a few minutes…</span>}
          </p>
        </div>
        <button onClick={load} disabled={loading} style={{ display: 'flex', alignItems: 'center', flexShrink: 0, background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '0.45rem 0.9rem', borderRadius: 7, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '0.82rem' }}>
          <RefreshCw size={14} style={{ marginRight: 4, animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
          <thead>
            {/* Row 1: group labels */}
            <tr>
              <th rowSpan={2} style={{ ...thBase, width: 44, textAlign: 'center', verticalAlign: 'bottom', borderRight: '1px solid #DFE7E3' }}>
                Sr.<br />No.
              </th>
              <th rowSpan={2} style={{ ...thBase, textAlign: 'left', verticalAlign: 'bottom', borderRight: '1px solid #DFE7E3', minWidth: 260 }}>
                Particulars
              </th>
              <th
                colSpan={LIVE_COLS.length}
                style={{ ...thBase, textAlign: 'center', color: '#1C4942', borderRight: '1px solid #DFE7E3', borderBottom: '1px solid #DFE7E3', paddingBottom: '0.5rem' }}
              >
                FY 2026-27 &nbsp;
                <span style={{ fontSize: '0.6rem', background: '#EAF4EF', color: '#1C4942', padding: '1px 6px', borderRadius: 4, verticalAlign: 'middle' }}>LIVE</span>
              </th>
              <th
                colSpan={STATIC_YEARS.length}
                style={{ ...thBase, textAlign: 'center', color: '#9BA8B0', borderBottom: '1px solid #DFE7E3', paddingBottom: '0.5rem' }}
              >
                Annual (Audited)
              </th>
            </tr>
            {/* Row 2: individual column headers */}
            <tr>
              {LIVE_COLS.map(col => (
                <th key={col.key} style={{ ...thBase, textAlign: 'right', whiteSpace: 'pre-line', lineHeight: 1.4, width: 110, borderRight: col.key === 'ytd' ? '1px solid #DFE7E3' : undefined }}>
                  {col.label}
                </th>
              ))}
              {STATIC_YEARS.map((col, i) => (
                <th key={i} style={{ ...thBase, textAlign: 'right', whiteSpace: 'pre-line', lineHeight: 1.4, width: 140 }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {ROWS.map((row, idx) => (
              <tr key={row.key} style={{ background: idx % 2 === 0 ? 'transparent' : '#F9F9F9' }}>
                <td style={{ ...tdBase, textAlign: 'center', color: '#9BA8B0', borderRight: '1px solid #DFE7E3' }}>{idx + 1}</td>
                <td style={{ ...tdBase, color: '#18191B', borderRight: '1px solid #DFE7E3' }}>{row.label}</td>

                {/* Live quarterly + YTD cells */}
                {LIVE_COLS.map(col => {
                  const d   = liveData?.periods?.[col.key];
                  const val = d?.[row.key];
                  return (
                    <td key={col.key} style={{ ...tdBase, textAlign: 'right', borderRight: col.key === 'ytd' ? '1px solid #DFE7E3' : undefined }}>
                      {loading
                        ? <span style={{ color: '#DFE7E3' }}>—</span>
                        : error
                          ? <span style={{ color: '#DC2626', fontSize: '0.75rem' }}>Err</span>
                          : d === null
                            ? <span style={{ color: '#DFE7E3' }}>—</span>
                            : <span style={{ color: '#18191B', fontWeight: 600 }}>{fmtVal(val, row.fmt)}</span>
                      }
                    </td>
                  );
                })}

                {/* Static annual cells */}
                {STATIC_YEARS.map((col, si) => (
                  <td key={si} style={{ ...tdBase, textAlign: 'right' }}>
                    <span style={{ color: '#18191B', fontWeight: 600 }}>{fmtVal(col[row.key], row.fmt)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footnotes */}
      <div style={{ padding: '0.75rem 1.25rem', borderTop: '1px solid #DFE7E3', color: '#9BA8B0', fontSize: '0.72rem', lineHeight: 1.6 }}>
        ¹ Occupied seats as of last month of each quarter &nbsp;·&nbsp; ² (Occupied Seats ÷ Total Capacity) × 100 &nbsp;·&nbsp; ³ Sum of Super Built-Up Area across all operational centers per branch configuration
      </div>
    </div>
  );
}
