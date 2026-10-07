import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../utils/api';

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPES = [
  { key: 'bills',             label: 'Bills',              short: 'Bills',  color: '#60a5fa' },
  { key: 'journals',          label: 'Journals',           short: 'Journals', color: '#a78bfa' },
  { key: 'invoices',          label: 'Invoices',           short: 'Invoices', color: '#34d399' },
  { key: 'vendor_payments',   label: 'Vendor Payments',    short: 'VP',     color: '#fb923c' },
  { key: 'customer_payments', label: 'Customer Payments',  short: 'CP',     color: '#f472b6' },
  { key: 'credit_notes',      label: 'Credit Notes',       short: 'CN',     color: '#facc15' },
  { key: 'purchase_orders',   label: 'Purchase Orders',    short: 'PO',     color: '#2dd4bf' },
];

const DRILL_COLS = {
  bills: [
    { k: 'number',     h: 'Bill #',      w: 120 },
    { k: 'vendor',     h: 'Vendor',      w: 200 },
    { k: 'date',       h: 'Bill Date',   w: 100 },
    { k: 'entered_on', h: 'Entered On',  w: 100 },
    { k: 'category',   h: 'Category',    w: 150 },
    { k: 'amount',     h: 'Amount',      w: 110, right: true, fmt: fmtAmt },
    { k: 'status',     h: 'Status',      w: 80,  badge: true },
  ],
  journals: [
    { k: 'number',     h: 'Journal #',  w: 120 },
    { k: 'date',       h: 'Date',       w: 100 },
    { k: 'entered_on', h: 'Entered On', w: 100 },
    { k: 'reference',  h: 'Reference',  w: 130 },
    { k: 'notes',      h: 'Notes/Memo', w: 240 },
    { k: 'amount',     h: 'Debit Amt',  w: 110, right: true, fmt: fmtAmt },
  ],
  invoices: [
    { k: 'number',     h: 'Invoice #',  w: 120 },
    { k: 'customer',   h: 'Customer',   w: 200 },
    { k: 'date',       h: 'Date',       w: 100 },
    { k: 'entered_on', h: 'Entered On', w: 100 },
    { k: 'amount',     h: 'Amount',     w: 110, right: true, fmt: fmtAmt },
    { k: 'status',     h: 'Status',     w: 80,  badge: true },
  ],
  vendor_payments: [
    { k: 'number',     h: 'Payment #',  w: 120 },
    { k: 'vendor',     h: 'Vendor',     w: 200 },
    { k: 'date',       h: 'Date',       w: 100 },
    { k: 'entered_on', h: 'Entered On', w: 100 },
    { k: 'mode',       h: 'Mode',       w: 100 },
    { k: 'amount',     h: 'Amount',     w: 110, right: true, fmt: fmtAmt },
  ],
  customer_payments: [
    { k: 'number',     h: 'Payment #',  w: 120 },
    { k: 'customer',   h: 'Customer',   w: 200 },
    { k: 'date',       h: 'Date',       w: 100 },
    { k: 'entered_on', h: 'Entered On', w: 100 },
    { k: 'mode',       h: 'Mode',       w: 100 },
    { k: 'amount',     h: 'Amount',     w: 110, right: true, fmt: fmtAmt },
  ],
  credit_notes: [
    { k: 'number',     h: 'Credit Note #', w: 120 },
    { k: 'customer',   h: 'Customer',      w: 200 },
    { k: 'date',       h: 'Date',          w: 100 },
    { k: 'entered_on', h: 'Entered On',    w: 100 },
    { k: 'amount',     h: 'Amount',        w: 110, right: true, fmt: fmtAmt },
    { k: 'status',     h: 'Status',        w: 80,  badge: true },
  ],
  purchase_orders: [
    { k: 'number',     h: 'PO #',       w: 120 },
    { k: 'vendor',     h: 'Vendor',     w: 200 },
    { k: 'date',       h: 'Date',       w: 100 },
    { k: 'entered_on', h: 'Entered On', w: 100 },
    { k: 'amount',     h: 'Amount',     w: 110, right: true, fmt: fmtAmt },
    { k: 'status',     h: 'Status',     w: 80,  badge: true },
  ],
};

const STATUS_COLORS = {
  paid: '#34d399', sent: '#60a5fa', open: '#f59e0b', overdue: '#f87171',
  draft: '#94a3b8', void: '#475569', cancelled: '#475569',
  approved: '#34d399', issued: '#60a5fa', pending_approval: '#f59e0b',
  partial: '#a78bfa', billed: '#34d399',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmt(n) {
  if (!n && n !== 0) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function fmtDate(s) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function getTodayStr() { return new Date().toISOString().slice(0, 10); }

function getPresetRange(preset) {
  const today = getTodayStr();
  const now   = new Date();
  switch (preset) {
    case 'today':     return { from: today, to: today };
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      const ys = y.toISOString().slice(0, 10);
      return { from: ys, to: ys };
    }
    case 'this_week': {
      const d = new Date(now);
      const dow = d.getDay(); // 0=Sun
      d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1)); // move to Monday
      return { from: d.toISOString().slice(0, 10), to: today };
    }
    case 'this_month': {
      const f = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: f.toISOString().slice(0, 10), to: today };
    }
    case 'last_month': {
      const f = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const l = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: f.toISOString().slice(0, 10), to: l.toISOString().slice(0, 10) };
    }
    default: return { from: today, to: today };
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  page:    { padding: '1.5rem', maxWidth: 1400, margin: '0 auto' },
  hdr:     { marginBottom: '1.5rem' },
  title:   { fontSize: '1.25rem', fontWeight: 700, color: '#18191B', margin: 0 },
  sub:     { fontSize: '0.78rem', color: '#5D6C7B', marginTop: 3 },
  row:     { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: '1.25rem' },
  card:    { background: '#FFFFFF', borderRadius: 12, padding: '1.5rem' },
  presetBtn: (a) => ({ padding: '5px 14px', borderRadius: 20, border: `1px solid ${a ? '#1C4942' : '#DFE7E3'}`, background: a ? '#EAF4EF' : 'transparent', color: a ? '#1C4942' : '#9BA8B0', fontSize: '0.78rem', fontWeight: a ? 600 : 400, cursor: 'pointer' }),
  dateInp: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, color: '#18191B', padding: '5px 10px', fontSize: '0.78rem', outline: 'none' },
  btnPrimary: { background: '#1C4942', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' },
  btnSec: { background: 'transparent', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 8, padding: '5px 12px', fontSize: '0.78rem', cursor: 'pointer' },
  // Table
  tbl:     { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
  th:      (right) => ({ textAlign: right ? 'right' : 'left', padding: '0.5rem 0.6rem', fontSize: '0.68rem', color: '#5D6C7B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' }),
  tdUser:  { padding: '0.65rem 0.6rem', color: '#18191B', fontWeight: 600, fontSize: '0.82rem', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  tdNum:   (color, clickable) => ({ padding: '0.65rem 0.6rem', textAlign: 'right', fontWeight: 700, color: color || '#9BA8B0', borderBottom: '1px solid #DFE7E3', cursor: clickable ? 'pointer' : 'default', transition: 'color 0.1s' }),
  tdTotal: { padding: '0.65rem 0.6rem', textAlign: 'right', fontWeight: 800, color: '#18191B', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  totRow:  { background: '#F9F9F9' },
  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '2rem 1rem', overflowY: 'auto' },
  modal:   { background: '#FFFFFF', borderRadius: 14, padding: '1.5rem', maxWidth: 900, width: '100%', marginTop: 'auto', marginBottom: 'auto' },
  badge:   (s) => {
    const c = STATUS_COLORS[(s || '').toLowerCase()] || '#9BA8B0';
    return { color: c, fontSize: '0.68rem', fontWeight: 600, background: c + '20', borderRadius: 12, padding: '2px 8px', whiteSpace: 'nowrap' };
  },
};

// ── Drilldown Modal ────────────────────────────────────────────────────────────

function DrillModal({ user, typeKey, records, dateRange, onClose }) {
  const typeInfo = TYPES.find(t => t.key === typeKey);
  const cols     = DRILL_COLS[typeKey] || [];
  const [sortK, setSortK] = useState('date');
  const [sortD, setSortD] = useState(-1);

  const sorted = useMemo(() => {
    const arr = [...records];
    arr.sort((a, b) => {
      const va = a[sortK] ?? '', vb = b[sortK] ?? '';
      if (typeof va === 'number') return sortD * (va - vb);
      return sortD * String(va).localeCompare(String(vb));
    });
    return arr;
  }, [records, sortK, sortD]);

  const totalAmt = records.reduce((s, r) => s + (r.amount || 0), 0);

  function toggleSort(k) {
    if (sortK === k) setSortD(d => -d);
    else { setSortK(k); setSortD(-1); }
  }

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem' }}>
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#18191B' }}>{user}</div>
            <div style={{ fontSize: '0.78rem', color: typeInfo?.color || '#9BA8B0', marginTop: 2 }}>
              {typeInfo?.label} — {fmtDate(dateRange.from)}{dateRange.from !== dateRange.to ? ` to ${fmtDate(dateRange.to)}` : ''} — {records.length} {records.length === 1 ? 'entry' : 'entries'}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', fontSize: '1.5rem', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ overflowX: 'auto', maxHeight: '65vh', overflowY: 'auto' }}>
          <table style={S.tbl}>
            <thead style={{ position: 'sticky', top: 0, background: '#FFFFFF', zIndex: 1 }}>
              <tr>
                <th style={{ ...S.th(false), width: 40 }}>#</th>
                {cols.map(c => (
                  <th key={c.k} style={{ ...S.th(c.right), width: c.w, cursor: 'pointer' }} onClick={() => toggleSort(c.k)}>
                    {c.h}{sortK === c.k ? (sortD === -1 ? ' ▼' : ' ▲') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.id || i}
                  onMouseEnter={e => e.currentTarget.style.background = '#F9F9F9'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <td style={{ padding: '0.5rem 0.6rem', color: '#5D6C7B', fontSize: '0.72rem', borderBottom: '1px solid #DFE7E3' }}>{i + 1}</td>
                  {cols.map(c => (
                    <td key={c.k} style={{ padding: '0.5rem 0.6rem', textAlign: c.right ? 'right' : 'left', color: '#18191B', borderBottom: '1px solid #DFE7E3', maxWidth: c.w, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: c.k === 'notes' ? 'normal' : 'nowrap' }}>
                      {c.badge && r[c.k]
                        ? <span style={S.badge(r[c.k])}>{r[c.k]}</span>
                        : c.fmt ? c.fmt(r[c.k]) : (c.k === 'date' || c.k === 'entered_on') ? fmtDate(r[c.k]) : (r[c.k] || '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalAmt > 0 && (
          <div style={{ marginTop: '0.75rem', textAlign: 'right', fontSize: '0.82rem', color: '#9BA8B0' }}>
            Total: <span style={{ fontWeight: 700, color: '#18191B', fontSize: '0.9rem' }}>{fmtAmt(totalAmt)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── User Row ─────────────────────────────────────────────────────────────────

function UserRow({ user, summary, drilldown, dateRange, onDrill }) {
  const isUnattr = user === 'Unattributed';
  return (
    <tr
      onMouseEnter={e => e.currentTarget.style.background = '#EAF4EF'}
      onMouseLeave={e => e.currentTarget.style.background = ''}>
      <td style={{ ...S.tdUser, color: isUnattr ? '#5D6C7B' : '#18191B', fontStyle: isUnattr ? 'italic' : 'normal' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: isUnattr ? '#F9F9F9' : '#EAF4EF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 700, color: isUnattr ? '#5D6C7B' : '#1C4942', flexShrink: 0 }}>
            {isUnattr ? '?' : user.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
          </div>
          {user}
        </div>
      </td>
      {TYPES.map(t => {
        const count = summary[t.key] || 0;
        const recs  = (drilldown && drilldown[t.key]) || [];
        return (
          <td key={t.key}
            style={S.tdNum(count > 0 ? t.color : '#334155', count > 0)}
            onClick={() => count > 0 && onDrill(user, t.key, recs)}
            title={count > 0 ? `Click to see ${count} ${t.label}` : ''}
          >
            {count > 0 ? (
              <span style={{ borderBottom: `1px dashed ${t.color}50`, paddingBottom: 1 }}>{count}</span>
            ) : <span style={{ color: '#DFE7E3' }}>—</span>}
          </td>
        );
      })}
      <td style={S.tdTotal}>{summary.total || 0}</td>
    </tr>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ActivityTracker() {
  const [preset,     setPreset]  = useState('today');
  const [customFrom, setCfrom]   = useState('');
  const [customTo,   setCto]     = useState('');
  const [data,       setData]    = useState(null);
  const [loading,    setLoading] = useState(false);
  const [error,      setError]   = useState(null);
  const [drill,      setDrill]   = useState(null); // { user, typeKey, records }
  const [sortUser,   setSortUser]= useState('total'); // sort column for pivot
  const [sortDir,    setSortDir] = useState(-1);

  const dateRange = useMemo(() => {
    if (preset === 'custom') return { from: customFrom, to: customTo };
    return getPresetRange(preset);
  }, [preset, customFrom, customTo]);

  const loadData = useCallback(async () => {
    if (!dateRange.from || !dateRange.to) return;
    setLoading(true); setError(null);
    try {
      const r = await api.activitySummary(dateRange.from, dateRange.to);
      setData(r);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setLoading(false); }
  }, [dateRange.from, dateRange.to]);

  useEffect(() => { loadData(); }, [loadData]);

  // Sorted user list
  const sortedUsers = useMemo(() => {
    if (!data?.summary) return [];
    return Object.entries(data.summary)
      .sort(([ua, sa], [ub, sb]) => {
        const va = sortUser === 'name' ? ua : (sa[sortUser] ?? 0);
        const vb = sortUser === 'name' ? ub : (sb[sortUser] ?? 0);
        if (typeof va === 'number') return sortDir * (vb - va);
        return sortDir * String(va).localeCompare(String(vb));
      })
      .map(([user, summary]) => ({ user, summary }));
  }, [data, sortUser, sortDir]);

  function toggleSort(k) {
    if (sortUser === k) setSortDir(d => -d);
    else { setSortUser(k); setSortDir(-1); }
  }

  function SortTh({ k, children, right }) {
    return (
      <th style={{ ...S.th(right), cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(k)}>
        {children}{sortUser === k ? (sortDir === -1 ? ' ▼' : ' ▲') : ''}
      </th>
    );
  }

  const PRESETS = [
    { v: 'today', l: 'Today' }, { v: 'yesterday', l: 'Yesterday' },
    { v: 'this_week', l: 'This Week' }, { v: 'this_month', l: 'This Month' },
    { v: 'last_month', l: 'Last Month' }, { v: 'custom', l: 'Custom' },
  ];

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <h1 style={S.title}>Team Activity Tracker</h1>
        <p style={S.sub}>Per-user count of entries booked in Zoho Books — click any number to see the records</p>
      </div>

      {/* Filters */}
      <div style={S.row}>
        {PRESETS.map(p => (
          <button key={p.v} style={S.presetBtn(preset === p.v)} onClick={() => setPreset(p.v)}>{p.l}</button>
        ))}
        {preset === 'custom' && (
          <>
            <input type="date" value={customFrom} onChange={e => setCfrom(e.target.value)} style={S.dateInp} />
            <span style={{ color: '#5D6C7B', fontSize: '0.78rem' }}>to</span>
            <input type="date" value={customTo} onChange={e => setCto(e.target.value)} style={S.dateInp} />
          </>
        )}
        <button onClick={loadData} disabled={loading} style={{ ...S.btnPrimary, marginLeft: preset !== 'custom' ? 'auto' : 0 }}>
          {loading ? '⟳ Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* Period label */}
      {dateRange.from && (
        <div style={{ fontSize: '0.78rem', color: '#5D6C7B', marginBottom: '1rem' }}>
          Showing: {fmtDate(dateRange.from)}{dateRange.from !== dateRange.to ? ` — ${fmtDate(dateRange.to)}` : ''}
          {data?.meta?.fetched_at && <span style={{ marginLeft: 12, color: '#1C4942' }}>Fetched at {new Date(data.meta.fetched_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      )}

      {error && (
        <div style={{ background: '#FEF2F2', border: '1px solid #DC2626', color: '#DC2626', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.82rem' }}>
          Error: {error}
        </div>
      )}

      {loading && (
        <div style={{ ...S.card, textAlign: 'center', padding: '3rem', color: '#5D6C7B' }}>
          <div style={{ fontSize: '0.9rem', marginBottom: 8 }}>Fetching data from Zoho Books…</div>
          <div style={{ fontSize: '0.75rem', color: '#9BA8B0' }}>Fetching 7 record types in parallel — usually takes 10–40 seconds on first load</div>
        </div>
      )}

      {!loading && data && (
        <div style={S.card}>
          {sortedUsers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: '#9BA8B0' }}>
              <div style={{ fontSize: '2rem', marginBottom: 12 }}>📊</div>
              <div style={{ fontSize: '0.9rem', color: '#5D6C7B' }}>No entries found for this period.</div>
            </div>
          ) : (
            <>
              {/* Attribution note */}
              {data.summary['Unattributed'] && (
                <div style={{ background: '#FFFBEB', border: '1px solid #B45309', color: '#B45309', borderRadius: 8, padding: '0.6rem 1rem', marginBottom: '1rem', fontSize: '0.75rem' }}>
                  ⚠ Some entries show as "Unattributed" — Zoho Books list API may not return the creator field for those record types. Drilldown still works.
                </div>
              )}

              <div style={{ overflowX: 'auto' }}>
                <table style={S.tbl}>
                  <thead>
                    <tr>
                      <SortTh k="name" right={false}>Team Member</SortTh>
                      {TYPES.map(t => (
                        <SortTh key={t.key} k={t.key} right>{t.short}</SortTh>
                      ))}
                      <SortTh k="total" right>Total</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedUsers.map(({ user, summary }) => (
                      <UserRow
                        key={user}
                        user={user}
                        summary={summary}
                        drilldown={data.drilldown[user]}
                        dateRange={dateRange}
                        onDrill={(u, tk, recs) => setDrill({ user: u, typeKey: tk, records: recs })}
                      />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={S.totRow}>
                      <td style={{ ...S.tdUser, color: '#5D6C7B', fontSize: '0.75rem', fontWeight: 700 }}>TOTAL</td>
                      {TYPES.map(t => (
                        <td key={t.key} style={{ ...S.tdNum(t.color, false), fontWeight: 800 }}>
                          {data.totals[t.key] || 0}
                        </td>
                      ))}
                      <td style={{ ...S.tdTotal, fontSize: '0.9rem' }}>{data.totals.total || 0}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Type legend */}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid #DFE7E3' }}>
                {TYPES.map(t => (
                  <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: t.color }} />
                    <span style={{ fontSize: '0.7rem', color: '#5D6C7B' }}>{t.short} = {t.label}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Summary cards */}
      {!loading && data && sortedUsers.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginTop: '1rem' }}>
          {TYPES.map(t => (
            <div key={t.key} style={{ background: '#FFFFFF', borderRadius: 10, padding: '0.85rem', borderLeft: `3px solid ${t.color}` }}>
              <div style={{ fontSize: '0.68rem', color: '#5D6C7B', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{t.label}</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 800, color: t.color }}>{data.totals[t.key] || 0}</div>
            </div>
          ))}
        </div>
      )}

      {drill && (
        <DrillModal
          user={drill.user}
          typeKey={drill.typeKey}
          records={drill.records}
          dateRange={dateRange}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
