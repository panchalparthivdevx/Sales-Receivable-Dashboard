import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';

function pctColor(pct) {
  if (pct >= 80) return '#22c55e';
  if (pct >= 60) return '#84cc16';
  if (pct >= 40) return '#f59e0b';
  return '#ef4444';
}

function PctBar({ pct }) {
  const color = pctColor(pct);
  return (
    <div style={S.barTrack}>
      <div style={{ ...S.barFill, width: `${Math.min(pct, 100)}%`, background: color }} />
    </div>
  );
}

function SummaryCard({ label, value, sub, color }) {
  return (
    <div style={S.summaryCard}>
      <p style={S.summaryLabel}>{label}</p>
      <p style={{ ...S.summaryValue, color: color || '#18191B' }}>{value}</p>
      {sub && <p style={S.summarySub}>{sub}</p>}
    </div>
  );
}

export default function OccupancyReport() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const [page, setPage]       = useState(1);
  const PAGE_SIZE = 15;

  const load = () => {
    setLoading(true);
    setError(false);
    api.occupancy()
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setLoading(false); setError(true); });
  };

  useEffect(() => { load(); }, []);

  if (loading) return (
    <div style={S.section}>
      <div style={S.sectionHeader}>
        <h3 style={S.sectionTitle}>Seat Occupancy Report</h3>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
        {[1,2,3,4].map(i => <div key={i} style={S.skeleton} />)}
      </div>
      <div style={S.skeleton} />
    </div>
  );

  if (error) return (
    <div style={S.section}>
      <div style={S.sectionHeader}>
        <h3 style={S.sectionTitle}>Seat Occupancy Report</h3>
      </div>
      <div style={{ textAlign: 'center', padding: '2rem', color: '#5D6C7B' }}>
        <p style={{ margin: '0 0 0.75rem' }}>Could not load occupancy data. Zoho may be temporarily rate-limited.</p>
        <button style={{ background: '#3b82f6', border: 'none', color: '#fff', padding: '8px 20px', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }} onClick={load}>
          Retry
        </button>
      </div>
    </div>
  );

  if (!data) return null;

  const monthLabel = (() => {
    const [y, m] = (data.month || '').split('-');
    if (!y) return '';
    return new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  })();

  const branches = data.branches || [];
  const totalPages = Math.ceil(branches.length / PAGE_SIZE);
  const paginated = branches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div style={S.section}>
      {/* Header */}
      <div style={S.sectionHeader}>
        <div>
          <h3 style={S.sectionTitle}>Seat Occupancy Report</h3>
          <p style={S.sectionSub}>Total Seats vs Occupied Seats — {monthLabel}</p>
        </div>
        <div style={{ ...S.badge, background: `${pctColor(data.overall_pct)}18`, color: pctColor(data.overall_pct) }}>
          {data.overall_pct}% Overall Occupancy
        </div>
      </div>

      {/* Summary KPI cards */}
      <div style={S.summaryGrid}>
        <SummaryCard label="Total Seats" value={data.total_seats.toLocaleString()} sub="From Excel (all branches)" />
        <SummaryCard label="Occupied Seats" value={data.total_occupied.toLocaleString()} color="#22c55e" sub="Billed in current month" />
        <SummaryCard label="Unoccupied Seats" value={data.total_unoccupied.toLocaleString()} color="#ef4444" sub="Available capacity" />
        <SummaryCard label="Occupancy %" value={`${data.overall_pct}%`} color={pctColor(data.overall_pct)} sub="Occupied / Total" />
      </div>

      {/* Overall progress bar */}
      <div style={S.overallBarWrap}>
        <span style={S.overallBarLabel}>Overall occupancy</span>
        <div style={{ flex: 1 }}>
          <PctBar pct={data.overall_pct} />
        </div>
        <span style={{ ...S.overallBarLabel, color: pctColor(data.overall_pct) }}>{data.overall_pct}%</span>
      </div>

      {/* Branch-wise table */}
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              {['Branch Name', 'Total Seats', 'Occupied Seats', 'Unoccupied Seats', 'Occupancy %'].map(h => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginated.map((row, i) => {
              const color = pctColor(row.occupancy_pct);
              return (
                <tr key={i} style={i % 2 === 0 ? S.trEven : S.trOdd}>
                  <td style={S.td}>{row.branch_name}</td>
                  <td style={{ ...S.tdNum }}>{row.total_seats.toLocaleString()}</td>
                  <td style={{ ...S.tdNum, color: '#22c55e' }}>{row.occupied_seats.toLocaleString()}</td>
                  <td style={{ ...S.tdNum, color: '#ef4444' }}>{row.unoccupied_seats.toLocaleString()}</td>
                  <td style={S.tdPct}>
                    <div style={S.pctCell}>
                      <span style={{ color, fontWeight: 600, minWidth: 38, textAlign: 'right' }}>{row.occupancy_pct}%</span>
                      <PctBar pct={row.occupancy_pct} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={S.pagination}>
          <button style={S.pgBtn} disabled={page === 1} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
          <span style={S.pgInfo}>Page {page} of {totalPages} ({branches.length} branches)</span>
          <button style={S.pgBtn} disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next ›</button>
        </div>
      )}

      {/* Legend */}
      <div style={S.legend}>
        <span style={S.legendTitle}>Occupancy Benchmarks:</span>
        {[
          { label: '≥80% Excellent', color: '#22c55e' },
          { label: '≥60% Good',      color: '#84cc16' },
          { label: '≥40% Average',   color: '#f59e0b' },
          { label: '<40% Low',       color: '#ef4444' },
        ].map(b => (
          <span key={b.label} style={S.legendItem}>
            <span style={{ ...S.dot, background: b.color }} />
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const S = {
  section: { background: '#FFFFFF', borderRadius: '10px', border: '1px solid #DFE7E3', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', boxShadow: '0 1px 3px rgba(0,18,20,0.06)' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' },
  sectionTitle: { margin: 0, color: '#18191B', fontSize: '0.95rem', fontWeight: 600 },
  sectionSub: { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.78rem' },
  badge: { padding: '4px 12px', borderRadius: '20px', fontSize: '0.82rem', fontWeight: 700, whiteSpace: 'nowrap' },
  skeleton: { height: 80, background: '#EAF4EF', borderRadius: 8 },
  // Summary cards
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' },
  summaryCard: { background: '#F9F9F9', borderRadius: '8px', border: '1px solid #DFE7E3', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  summaryLabel: { margin: 0, color: '#5D6C7B', fontSize: '0.78rem', fontWeight: 500 },
  summaryValue: { margin: 0, fontSize: '1.8rem', fontWeight: 800, lineHeight: 1.1 },
  summarySub: { margin: 0, color: '#9BA8B0', fontSize: '0.72rem' },
  // Overall bar
  overallBarWrap: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  overallBarLabel: { color: '#5D6C7B', fontSize: '0.78rem', whiteSpace: 'nowrap' },
  // Table
  tableWrap: { overflowX: 'auto', borderRadius: 8, border: '1px solid #DFE7E3' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th: { padding: '0.6rem 0.9rem', textAlign: 'left', color: '#5D6C7B', fontWeight: 600, fontSize: '0.78rem', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  td: { padding: '0.55rem 0.9rem', color: '#18191B', verticalAlign: 'middle' },
  tdNum: { padding: '0.55rem 0.9rem', textAlign: 'right', fontWeight: 600, verticalAlign: 'middle' },
  tdPct: { padding: '0.55rem 0.9rem', verticalAlign: 'middle', minWidth: 160 },
  trEven: { background: '#FFFFFF' },
  trOdd: { background: '#F9F9F9' },
  // Pct cell
  pctCell: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  barTrack: { flex: 1, height: 6, background: '#DFE7E3', borderRadius: 3, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s ease' },
  // Pagination
  pagination: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem' },
  pgBtn: { background: '#F2F2F2', border: '1px solid #DFE7E3', color: '#5D6C7B', cursor: 'pointer', padding: '4px 14px', borderRadius: 6, fontSize: '0.82rem' },
  pgInfo: { color: '#5D6C7B', fontSize: '0.78rem' },
  // Legend
  legend: { display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid #DFE7E3' },
  legendTitle: { color: '#5D6C7B', fontSize: '0.78rem', fontWeight: 600 },
  legendItem: { display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#9BA8B0', fontSize: '0.78rem' },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
};
