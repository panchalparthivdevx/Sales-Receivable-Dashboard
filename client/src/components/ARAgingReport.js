import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';

const BUCKET_COLORS = [
  '#22c55e', // Current       — green
  '#84cc16', // 1-90          — lime
  '#f59e0b', // 91-180        — amber
  '#f97316', // 181-270       — orange
  '#ef4444', // 271-360       — red
  '#dc2626', // 361-450       — dark red
  '#b91c1c', // 451-540       — deeper red
  '#7f1d1d', // 541+          — darkest red
];

function fmt(n) {
  if (n == null) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

export default function ARAgingReport() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const [expanded, setExpanded] = useState(null); // customer name

  const load = () => {
    setLoading(true);
    setError(false);
    api.arAging()
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setLoading(false); setError(true); });
  };

  useEffect(() => { load(); }, []);

  if (loading) return (
    <div style={S.section}>
      <div style={S.sectionHeader}>
        <h3 style={S.sectionTitle}>AR Aging Summary</h3>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' }}>
        {[1,2,3,4,5,6,7,8].map(i => <div key={i} style={S.skeleton} />)}
      </div>
      <div style={{ ...S.skeleton, height: 200, marginTop: '0.75rem' }} />
    </div>
  );

  if (error) return (
    <div style={S.section}>
      <div style={S.sectionHeader}>
        <h3 style={S.sectionTitle}>AR Aging Summary</h3>
      </div>
      <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
        <p style={{ margin: '0 0 0.75rem' }}>Could not load AR aging data.</p>
        <button style={S.retryBtn} onClick={load}>Retry</button>
      </div>
    </div>
  );

  if (!data) return null;

  const { buckets, customers, total_outstanding, total_invoices, as_of } = data;

  const totalAmt = buckets.reduce((s, b) => s + b.amount, 0);

  return (
    <div style={S.section}>
      {/* Header */}
      <div style={S.sectionHeader}>
        <div>
          <h3 style={S.sectionTitle}>AR Aging Summary</h3>
          <p style={S.sectionSub}>
            Overdue buckets at 90-day intervals — as of {as_of} &nbsp;·&nbsp; {total_invoices} unpaid invoices
          </p>
        </div>
        <div style={S.badge}>{fmt(total_outstanding)} Total Outstanding</div>
      </div>

      {/* 8 Bucket cards — 4 per row */}
      <div style={S.bucketGrid}>
        {buckets.map((b, i) => {
          const color = BUCKET_COLORS[i];
          const pct = totalAmt > 0 ? (b.amount / totalAmt) * 100 : 0;
          return (
            <div key={i} style={{ ...S.bucketCard, borderTop: `3px solid ${color}` }}>
              <p style={{ ...S.bucketLabel, color }}>{b.label}</p>
              <p style={{ ...S.bucketAmt, color }}>{fmt(b.amount)}</p>
              <p style={S.bucketCount}>{b.count} invoice{b.count !== 1 ? 's' : ''}</p>
              <div style={S.barTrack}>
                <div style={{ ...S.barFill, width: `${Math.min(pct, 100)}%`, background: color }} />
              </div>
              <p style={S.bucketPct}>{pct.toFixed(1)}% of total</p>
            </div>
          );
        })}
      </div>

      {/* Customer-wise breakdown table */}
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Customer</th>
              {buckets.map((b, i) => (
                <th key={i} style={{ ...S.thNum, color: BUCKET_COLORS[i] }}>{b.label}</th>
              ))}
              <th style={{ ...S.thNum, color: '#f1f5f9' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c, ri) => (
              <React.Fragment key={ri}>
                <tr
                  style={ri % 2 === 0 ? S.trEven : S.trOdd}
                  onClick={() => setExpanded(expanded === c.customer_name ? null : c.customer_name)}
                  title="Click to see invoices"
                >
                  <td style={{ ...S.td, cursor: 'pointer' }}>
                    <span style={S.expandIcon}>{expanded === c.customer_name ? '▾' : '▸'}</span>
                    {c.customer_name}
                  </td>
                  {c.buckets.map((bkt, bi) => (
                    <td key={bi} style={{ ...S.tdNum, color: bkt.amount > 0 ? BUCKET_COLORS[bi] : '#334155' }}>
                      {bkt.amount > 0 ? fmt(bkt.amount) : '—'}
                    </td>
                  ))}
                  <td style={{ ...S.tdNum, color: '#f1f5f9', fontWeight: 700 }}>{fmt(c.total_outstanding)}</td>
                </tr>
                {expanded === c.customer_name && (
                  <tr style={{ background: '#0a1628' }}>
                    <td colSpan={buckets.length + 2} style={{ padding: '0.5rem 1rem 0.75rem 2rem' }}>
                      <table style={{ ...S.table, fontSize: '0.78rem' }}>
                        <thead>
                          <tr>
                            {['Invoice #', 'Date', 'Due Date', 'Days Overdue', 'Branch', 'Balance'].map(h => (
                              <th key={h} style={{ ...S.th, fontSize: '0.72rem', padding: '0.4rem 0.6rem' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {c.invoices.sort((a, b) => b.days_overdue - a.days_overdue).map((inv, ii) => {
                            const bIdx = inv.days_overdue > 0 ? Math.min(Math.ceil(inv.days_overdue / 90), 7) : 0;
                            return (
                              <tr key={ii}>
                                <td style={S.tdSm}>{inv.invoice_number}</td>
                                <td style={S.tdSm}>{inv.date}</td>
                                <td style={S.tdSm}>{inv.due_date}</td>
                                <td style={{ ...S.tdSm, textAlign: 'right', color: BUCKET_COLORS[bIdx], fontWeight: 600 }}>
                                  {inv.days_overdue > 0 ? `${inv.days_overdue}d` : 'Not due'}
                                </td>
                                <td style={S.tdSm}>{inv.branch_name}</td>
                                <td style={{ ...S.tdSm, textAlign: 'right', color: '#ef4444', fontWeight: 600 }}>{fmt(inv.balance)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {/* Totals row */}
            {customers.length > 0 && (
              <tr style={{ borderTop: '2px solid #334155', background: '#0f172a' }}>
                <td style={{ ...S.td, fontWeight: 700, color: '#18191B' }}>TOTAL</td>
                {buckets.map((b, i) => (
                  <td key={i} style={{ ...S.tdNum, color: BUCKET_COLORS[i], fontWeight: 700 }}>{fmt(b.amount)}</td>
                ))}
                <td style={{ ...S.tdNum, color: '#18191B', fontWeight: 800, fontSize: '0.9rem' }}>{fmt(total_outstanding)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Colour legend */}
      <div style={S.legend}>
        <span style={S.legendTitle}>Aging Intervals:</span>
        {buckets.map((b, i) => (
          <span key={i} style={S.legendItem}>
            <span style={{ ...S.dot, background: BUCKET_COLORS[i] }} />
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
  badge: { padding: '4px 12px', borderRadius: '20px', background: '#FEF2F2', color: '#DC2626', fontSize: '0.82rem', fontWeight: 700, whiteSpace: 'nowrap' },
  skeleton: { height: 90, background: '#EAF4EF', borderRadius: 8 },
  retryBtn: { background: '#1C4942', border: 'none', color: '#fff', padding: '8px 20px', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' },
  // Bucket cards
  bucketGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' },
  bucketCard: { background: '#F9F9F9', borderRadius: '8px', border: '1px solid #DFE7E3', padding: '0.85rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' },
  bucketLabel: { margin: 0, fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  bucketAmt: { margin: 0, fontSize: '1.35rem', fontWeight: 800, lineHeight: 1.15 },
  bucketCount: { margin: 0, color: '#5D6C7B', fontSize: '0.72rem' },
  bucketPct: { margin: 0, color: '#9BA8B0', fontSize: '0.7rem' },
  barTrack: { height: 4, background: '#DFE7E3', borderRadius: 2, overflow: 'hidden', marginTop: '0.25rem' },
  barFill: { height: '100%', borderRadius: 2, transition: 'width 0.3s ease' },
  // Table
  tableWrap: { overflowX: 'auto', borderRadius: 8, border: '1px solid #DFE7E3' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th: { padding: '0.6rem 0.8rem', textAlign: 'left', color: '#5D6C7B', fontWeight: 600, fontSize: '0.75rem', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  thNum: { padding: '0.6rem 0.8rem', textAlign: 'right', fontWeight: 600, fontSize: '0.75rem', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', color: '#5D6C7B' },
  td: { padding: '0.5rem 0.8rem', color: '#18191B', verticalAlign: 'middle' },
  tdNum: { padding: '0.5rem 0.8rem', textAlign: 'right', verticalAlign: 'middle', fontSize: '0.8rem' },
  tdSm: { padding: '0.35rem 0.6rem', color: '#9BA8B0', verticalAlign: 'middle' },
  trEven: { background: '#FFFFFF' },
  trOdd: { background: '#F9F9F9' },
  expandIcon: { marginRight: '0.4rem', color: '#9BA8B0', fontSize: '0.7rem' },
  // Legend
  legend: { display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid #DFE7E3' },
  legendTitle: { color: '#5D6C7B', fontSize: '0.78rem', fontWeight: 600 },
  legendItem: { display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#9BA8B0', fontSize: '0.75rem' },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
};
