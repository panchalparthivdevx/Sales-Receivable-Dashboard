import React, { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';
import { X, TrendingUp, TrendingDown, Minus, Search, ChevronUp, ChevronDown } from 'lucide-react';
import { api } from '../utils/api';
import { formatINR, formatDate } from '../utils/format';

function delayColor(days) {
  if (days <= 0) return '#22c55e';
  if (days <= 15) return '#f59e0b';
  if (days <= 30) return '#f97316';
  return '#ef4444';
}

function delayLabel(days) {
  if (days <= 0) return 'On-time';
  if (days <= 15) return `+${days}d`;
  if (days <= 30) return `+${days}d`;
  return `+${days}d`;
}

function TrendIcon({ trend }) {
  if (trend > 5) return <TrendingUp size={14} color="#ef4444" />;
  if (trend < -5) return <TrendingDown size={14} color="#22c55e" />;
  return <Minus size={14} color="#9BA8B0" />;
}

function ClientModal({ client, months, onClose }) {
  const trendData = client.monthly_trend.map(m => ({
    month: m.month.slice(5),
    avg_delay: m.avg_delay,
    count: m.count,
  }));

  const hasTrend = trendData.some(d => d.count > 0);

  const cols = [
    { key: 'invoice_number', label: 'Invoice #' },
    { key: 'due_date', label: 'Due Date' },
    { key: 'payment_date', label: 'Paid On' },
    { key: 'delay_days', label: 'Delay (Days)', align: 'right' },
    { key: 'amount', label: 'Amount', align: 'right' },
    { key: 'branch_name', label: 'Branch' },
  ];

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.mHeader}>
          <div>
            <h2 style={S.mTitle}>{client.customer_name}</h2>
            <p style={S.mSub}>Payment delay trend — past 6 months</p>
          </div>
          <button style={S.closeBtn} onClick={onClose}><X size={20} /></button>
        </div>

        {/* Summary chips */}
        <div style={S.chips}>
          <div style={S.chip}>
            <span style={S.chipLabel}>Avg Delay</span>
            <span style={{ ...S.chipVal, color: delayColor(client.avg_delay_days) }}>
              {client.avg_delay_days > 0 ? `+${client.avg_delay_days} days` : 'On-time'}
            </span>
          </div>
          <div style={S.chip}>
            <span style={S.chipLabel}>Total Payments</span>
            <span style={S.chipVal}>{client.total_invoices}</span>
          </div>
          <div style={S.chip}>
            <span style={S.chipLabel}>Late Payments</span>
            <span style={{ ...S.chipVal, color: '#ef4444' }}>{client.delayed_invoices}</span>
          </div>
          <div style={S.chip}>
            <span style={S.chipLabel}>Max Delay</span>
            <span style={{ ...S.chipVal, color: delayColor(client.max_delay_days) }}>
              {client.max_delay_days > 0 ? `+${client.max_delay_days} days` : '-'}
            </span>
          </div>
        </div>

        {/* Monthly trend chart */}
        <div style={{ padding: '0 1.5rem 1rem' }}>
          <p style={S.sectionLabel}>Monthly Avg. Delay (days)</p>
          {hasTrend ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={trendData} barSize={32}>
                <XAxis dataKey="month" tick={{ fill: '#18191B', fontSize: 11 }} />
                <YAxis tick={{ fill: '#5D6C7B', fontSize: 11 }} />
                <Tooltip
                  formatter={(v, n, p) => [`${v > 0 ? '+' : ''}${v} days (${p.payload.count} payments)`, 'Avg Delay']}
                  contentStyle={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, fontSize: '0.82rem' }}
                  labelStyle={{ color: '#5D6C7B' }}
                />
                <ReferenceLine y={0} stroke="#DFE7E3" />
                <Bar dataKey="avg_delay" radius={[4, 4, 0, 0]}>
                  {trendData.map((d, i) => <Cell key={i} fill={delayColor(d.avg_delay)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p style={{ color: '#5D6C7B', fontSize: '0.85rem', padding: '1rem 0' }}>No monthly data available.</p>
          )}
        </div>

        {/* Payment detail table */}
        <div style={S.tableWrap}>
          <p style={{ ...S.sectionLabel, padding: '0 1.5rem' }}>Individual Payments</p>
          <div style={{ overflowY: 'auto', maxHeight: '240px' }}>
            <table style={S.table}>
              <thead>
                <tr>{cols.map(c => <th key={c.key} style={{ ...S.th, textAlign: c.align || 'left' }}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {client.payments.map((p, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : '#F9F9F9' }}>
                    <td style={S.td}>{p.invoice_number}</td>
                    <td style={S.td}>{formatDate(p.due_date)}</td>
                    <td style={S.td}>{formatDate(p.payment_date)}</td>
                    <td style={{ ...S.td, textAlign: 'right' }}>
                      <span style={{ color: delayColor(p.delay_days), fontWeight: 600 }}>
                        {p.delay_days > 0 ? `+${p.delay_days}` : p.delay_days === 0 ? '0' : `${p.delay_days}`}
                      </span>
                    </td>
                    <td style={{ ...S.td, textAlign: 'right' }}>{formatINR(p.amount)}</td>
                    <td style={S.td}>{p.branch_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ClientDelayReport() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('avg_delay_days');
  const [sortDir, setSortDir] = useState('desc');
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 15;

  useEffect(() => {
    api.clientPaymentDelay().then(d => { setData(d); setLoading(false); }).catch(e => { console.error('ClientDelayReport error:', e); setLoading(false); });
  }, []);

  if (loading) return <div style={S.card}><div style={S.skeleton} /></div>;
  if (!data) return null;

  const toggleSort = key => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
    setPage(1);
  };

  const filtered = (data.clients || [])
    .filter(c => c.customer_name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const v = sortDir === 'asc' ? 1 : -1;
      return (a[sortKey] > b[sortKey] ? 1 : -1) * v;
    });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const SortIcon = ({ k }) => sortKey === k
    ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
    : <ChevronDown size={12} style={{ opacity: 0.3 }} />;

  const cols = [
    { key: 'customer_name', label: 'Client Name', align: 'left' },
    { key: 'avg_delay_days', label: 'Avg Delay', align: 'right' },
    { key: 'total_invoices', label: 'Payments', align: 'right' },
    { key: 'delayed_invoices', label: 'Late', align: 'right' },
    { key: 'max_delay_days', label: 'Max Delay', align: 'right' },
  ];

  return (
    <div style={S.card}>
      <div style={S.header}>
        <div>
          <h3 style={S.title}>Client-wise Payment Delay</h3>
          <p style={S.sub}>Past 6 months · {data.clients?.length || 0} clients · Click a row for trend</p>
        </div>
        <div style={S.searchWrap}>
          <Search size={14} color="#9BA8B0" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
          <input
            style={S.searchInput}
            placeholder="Search client..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{ ...S.th, width: 40, textAlign: 'center' }}>#</th>
              {cols.map(c => (
                <th key={c.key} style={{ ...S.th, textAlign: c.align, cursor: 'pointer' }} onClick={() => toggleSort(c.key)}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {c.label} <SortIcon k={c.key} />
                  </span>
                </th>
              ))}
              <th style={{ ...S.th, textAlign: 'center' }}>6-Month Trend</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((c, i) => {
              const trendVals = (Array.isArray(c.monthly_trend) ? c.monthly_trend : []).filter(m => m.count > 0).map(m => m.avg_delay);
              const trend = trendVals.length >= 2 ? trendVals[trendVals.length - 1] - trendVals[0] : 0;

              return (
                <tr key={c.customer_name} style={S.row} onClick={() => setSelected(c)}>
                  <td style={{ ...S.td, textAlign: 'center', color: '#9BA8B0', fontSize: '0.78rem' }}>
                    {(page - 1) * PAGE_SIZE + i + 1}
                  </td>
                  <td style={{ ...S.td, fontWeight: 500, color: '#e2e8f0' }}>{c.customer_name}</td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <span style={{ color: delayColor(c.avg_delay_days), fontWeight: 700, fontSize: '0.95rem' }}>
                      {c.avg_delay_days > 0 ? `+${c.avg_delay_days}d` : c.avg_delay_days === 0 ? '0d' : `${c.avg_delay_days}d`}
                    </span>
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', color: '#94a3b8' }}>{c.total_invoices}</td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <span style={{ color: c.delayed_invoices > 0 ? '#ef4444' : '#22c55e' }}>{c.delayed_invoices}</span>
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', color: delayColor(c.max_delay_days) }}>
                    {c.max_delay_days > 0 ? `+${c.max_delay_days}d` : '-'}
                  </td>
                  <td style={{ ...S.td, textAlign: 'center' }}>
                    <MiniTrend data={c.monthly_trend} />
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
          <span style={{ color: '#5D6C7B', fontSize: '0.8rem' }}>
            {filtered.length} clients · Page {page} of {totalPages}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={S.pageBtn} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <button style={S.pageBtn} disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        </div>
      )}

      {selected && <ClientModal client={selected} months={data.months} onClose={() => setSelected(null)} />}
    </div>
  );
}

function MiniTrend({ data }) {
  const vals = data.map(m => m.avg_delay);
  const max = Math.max(...vals.map(Math.abs), 1);
  const w = 8, gap = 3, h = 28;

  return (
    <svg width={vals.length * (w + gap)} height={h} style={{ verticalAlign: 'middle' }}>
      {vals.map((v, i) => {
        const barH = Math.max(2, (Math.abs(v) / max) * (h / 2));
        const y = v >= 0 ? h / 2 - barH : h / 2;
        return (
          <rect key={i} x={i * (w + gap)} y={y} width={w} height={barH}
            fill={delayColor(v)} rx={2} opacity={data[i].count > 0 ? 1 : 0.15} />
        );
      })}
      <line x1={0} y1={h / 2} x2={vals.length * (w + gap)} y2={h / 2} stroke="#DFE7E3" strokeWidth={1} />
    </svg>
  );
}

const S = {
  card: { background: '#FFFFFF', borderRadius: '10px', border: '1px solid #DFE7E3', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,18,20,0.06)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '1.25rem 1.5rem 1rem', flexWrap: 'wrap', gap: '0.75rem' },
  title: { margin: 0, color: '#18191B', fontSize: '0.95rem', fontWeight: 600 },
  sub: { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.78rem' },
  skeleton: { height: 200, background: '#EAF4EF', borderRadius: 8, margin: '1rem' },
  searchWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  searchInput: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, color: '#18191B', padding: '6px 12px 6px 30px', fontSize: '0.82rem', outline: 'none', width: 200 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th: { padding: '0.6rem 1rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', background: '#F9F9F9' },
  td: { padding: '0.7rem 1rem', color: '#18191B', borderBottom: '1px solid #F2F2F2' },
  row: { cursor: 'pointer', transition: 'background 0.1s' },
  pagination: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1.5rem', borderTop: '1px solid #DFE7E3' },
  pageBtn: { background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem' },
  // Modal styles
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  modal: { background: '#FFFFFF', borderRadius: 12, width: '100%', maxWidth: 820, maxHeight: '88vh', display: 'flex', flexDirection: 'column', border: '1px solid #DFE7E3', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,18,20,0.2)' },
  mHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '1.25rem 1.5rem', borderBottom: '1px solid #DFE7E3' },
  mTitle: { margin: 0, color: '#18191B', fontSize: '1.05rem', fontWeight: 600 },
  mSub: { margin: '4px 0 0', color: '#5D6C7B', fontSize: '0.8rem' },
  closeBtn: { background: 'none', border: 'none', color: '#9BA8B0', cursor: 'pointer', padding: 4 },
  chips: { display: 'flex', gap: '1rem', padding: '1rem 1.5rem', flexWrap: 'wrap' },
  chip: { background: '#F2F2F2', borderRadius: 8, padding: '0.6rem 1rem', display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 120px' },
  chipLabel: { color: '#5D6C7B', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em' },
  chipVal: { color: '#18191B', fontSize: '1.1rem', fontWeight: 700 },
  sectionLabel: { color: '#5D6C7B', fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' },
  tableWrap: { borderTop: '1px solid #DFE7E3', paddingTop: '0.75rem', flex: 1, overflowY: 'auto' },
};
