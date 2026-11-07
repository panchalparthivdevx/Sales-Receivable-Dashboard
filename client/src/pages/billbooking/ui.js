import React from 'react';

// Shared look for the Bill Collection & Booking screens (light theme, same tokens as the rest of the app)
export const STATUS_META = {
  received:      { color: '#475569', bg: '#F1F5F9', border: '#E2E8F0' },
  extracted:     { color: '#475569', bg: '#F1F5F9', border: '#E2E8F0' },
  needs_input:   { color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  ready:         { color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  draft_created: { color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  reviewed:      { color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  duplicate:     { color: '#9F1239', bg: '#FFF1F2', border: '#FECDD3' },
  failed:        { color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  not_bill:      { color: '#64748B', bg: '#F8FAFC', border: '#E2E8F0' },
};
export const STATUS_ORDER = ['received', 'extracted', 'needs_input', 'ready', 'draft_created', 'reviewed', 'duplicate', 'failed', 'not_bill'];

export const SOURCE_LABEL = { history: 'Earlier bill', mapping: 'Confirmed mapping', manual: 'Chosen by team', description: 'Bill wording', team: 'Team', extraction: 'Read from bill', default: 'Default', '': '' };

export function StatusPill({ status, statuses }) {
  const m = STATUS_META[status] || STATUS_META.received;
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 600, whiteSpace: 'nowrap',
      color: m.color, background: m.bg, border: `1px solid ${m.border}` }}>
      {statuses?.[status] || status}
    </span>
  );
}

export function Tag({ children, tone = 'grey', title }) {
  const t = { grey: ['#5D6C7B', '#F2F4F5'], green: ['#15803D', '#F0FDF4'], amber: ['#B45309', '#FFFBEB'], red: ['#B91C1C', '#FEF2F2'], blue: ['#1D4ED8', '#EFF6FF'], violet: ['#6D28D9', '#F5F3FF'] }[tone];
  return <span title={title} style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: '0.66rem', fontWeight: 600, color: t[0], background: t[1], whiteSpace: 'nowrap' }}>{children}</span>;
}

export const money = (n, cur = 'INR') => (n == null || n === '' ? '—'
  : `${cur && cur !== 'INR' ? `${cur} ` : '₹'}${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const dt = s => (s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const dtm = s => (s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const S = {
  page: { padding: '1.5rem 2rem', background: '#F9F9F9', minHeight: '100vh', color: '#18191B' },
  topBar: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1rem', gap: '1rem', flexWrap: 'wrap' },
  pageTitle: { color: '#18191B', fontSize: '1.3rem', fontWeight: 700, margin: 0 },
  pageSub: { color: '#5D6C7B', fontSize: '0.82rem', margin: '0.2rem 0 0' },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #DFE7E3', marginBottom: '1rem', flexWrap: 'wrap' },
  tab: a => ({ padding: '0.55rem 0.95rem', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
    borderBottom: `2px solid ${a ? '#1C4942' : 'transparent'}`, color: a ? '#1C4942' : '#5D6C7B', marginBottom: -1 }),
  card: { background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3', boxShadow: '0 1px 3px rgba(0,18,20,0.06)', marginBottom: '1rem' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.85rem 1.1rem', borderBottom: '1px solid #DFE7E3', gap: 8, flexWrap: 'wrap' },
  cardTitle: { fontWeight: 700, fontSize: '0.92rem', color: '#18191B' },
  cardBody: { padding: '1rem 1.1rem' },
  muted: { color: '#5D6C7B', fontSize: '0.78rem' },
  small: { color: '#9BA8B0', fontSize: '0.72rem' },
  btn: { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#EAF4EF', border: '1px solid #A7C4BC', color: '#1C4942', borderRadius: 6, padding: '0.35rem 0.8rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600 },
  primary: { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#1C4942', border: '1px solid #1C4942', color: '#FFFFFF', borderRadius: 6, padding: '0.4rem 0.9rem', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 600 },
  ghost: { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', borderRadius: 6, padding: '0.35rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer' },
  danger: { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 6, padding: '0.35rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600 },
  input: { background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B', borderRadius: 6, padding: '0.35rem 0.55rem', fontSize: '0.8rem', fontFamily: 'inherit', boxSizing: 'border-box' },
  select: { background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B', borderRadius: 6, padding: '0.35rem 0.5rem', fontSize: '0.8rem', fontFamily: 'inherit', maxWidth: 260 },
  label: { display: 'block', color: '#5D6C7B', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 },
  th: { textAlign: 'left', padding: '0.5rem 0.6rem', fontSize: '0.68rem', fontWeight: 700, color: '#5D6C7B', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 },
  td: { padding: '0.5rem 0.6rem', fontSize: '0.78rem', color: '#18191B', borderBottom: '1px solid #F0F2F1', verticalAlign: 'top' },
  error: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 8, padding: '0.55rem 0.8rem', fontSize: '0.8rem', marginBottom: '0.75rem' },
  notice: { background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E', borderRadius: 8, padding: '0.55rem 0.8rem', fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.5 },
  ok: { background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#15803D', borderRadius: 8, padding: '0.55rem 0.8rem', fontSize: '0.8rem', marginBottom: '0.75rem' },
  center: { padding: '2rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.85rem' },
};

export function Field({ label, children, style }) {
  return <label style={{ display: 'block', ...style }}><span style={S.label}>{label}</span>{children}</label>;
}

export function Msg({ error, ok, onClose }) {
  if (!error && !ok) return null;
  return (
    <div style={error ? S.error : S.ok}>
      {error || ok}
      {onClose && <button onClick={onClose} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>}
    </div>
  );
}
