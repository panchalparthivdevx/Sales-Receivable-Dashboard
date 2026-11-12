import React from 'react';

// Shared look for the GSTR-2B Reco screens (light theme, same tokens as the rest of the app)
export const STATUS_META = {
  exact:       { color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  tolerance:   { color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  suggested:   { color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  mismatched:  { color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  books_only:  { color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  portal_only: { color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  excluded:    { color: '#64748B', bg: '#F8FAFC', border: '#E2E8F0' },
};
export const STATUS_ORDER = ['exact', 'tolerance', 'suggested', 'mismatched', 'books_only', 'portal_only', 'excluded'];

export function StatusPill({ status, statuses, small }) {
  const m = STATUS_META[status] || STATUS_META.excluded;
  return (
    <span style={{ display: 'inline-block', padding: small ? '1px 6px' : '2px 8px', borderRadius: 10, fontSize: small ? '0.64rem' : '0.7rem', fontWeight: 600, whiteSpace: 'nowrap', color: m.color, background: m.bg, border: `1px solid ${m.border}` }}>
      {statuses?.[status] || status}
    </span>
  );
}

const TONES = { grey: ['#5D6C7B', '#F2F4F5'], green: ['#15803D', '#F0FDF4'], amber: ['#B45309', '#FFFBEB'], red: ['#B91C1C', '#FEF2F2'], blue: ['#1D4ED8', '#EFF6FF'], violet: ['#6D28D9', '#F5F3FF'] };
export function Tag({ children, tone = 'grey', title }) {
  const t = TONES[tone];
  return <span title={title} style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: '0.64rem', fontWeight: 600, color: t[0], background: t[1], whiteSpace: 'nowrap', marginRight: 3, marginBottom: 2 }}>{children}</span>;
}
const FLAG_TONE = {
  invalid_gstin: 'red', wrong_supplier_gstin: 'red', wrong_recipient_gstin: 'red', duplicate_suspected: 'red', tax_type_mismatch: 'red', incomplete_data: 'red', unsupported_section: 'grey',
  duplicate_possible: 'amber', ambiguous: 'amber', normalization_collision: 'amber', cross_period: 'amber', late_reporting: 'amber', early_reporting: 'amber', cross_fy: 'amber', date_assumed: 'amber', zoho_changed_not_refreshed: 'amber', data_quality_note: 'amber', portal_duplicate: 'amber', number_differs: 'amber', invoice_value_differs: 'amber',
  credit_note: 'blue', debit_note: 'blue', reverse_charge: 'blue', amendment: 'violet', grouped: 'violet', itc_not_available_per_portal: 'grey', zero_tax: 'grey',
};
export function FlagTags({ flags, text, max = 99 }) {
  const list = (flags || []).slice(0, max);
  return <>{list.map(f => <Tag key={f} tone={FLAG_TONE[f] || 'grey'} title={text?.[f] || f}>{text?.[f] || f}</Tag>)}{(flags || []).length > max && <Tag>+{flags.length - max}</Tag>}</>;
}

// amounts are paise; Indian digit grouping
export function inr(p, { sign = false } = {}) {
  if (p === null || p === undefined || p === '') return '—';
  const neg = p < 0, abs = Math.abs(Math.round(p));
  const r = String(Math.floor(abs / 100)), f = String(abs % 100).padStart(2, '0');
  const g = r.length > 3 ? `${r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${r.slice(-3)}` : r;
  return `${neg ? '-' : sign && abs ? '+' : ''}${g}.${f}`;
}
export const inr0 = p => (p === null || p === undefined ? '—' : `₹${inr(Math.round(p / 100) * 100).replace(/\.00$/, '')}`);
export const dt = s => (s ? new Date(`${s.length === 10 ? s : s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const dtm = s => (s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const pct = v => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
export const monthName = p => (p ? new Date(`${p}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—');
export const COMP = [['taxable', 'Taxable'], ['igst', 'IGST'], ['cgst', 'CGST'], ['sgst', 'SGST'], ['cess', 'Cess']];

export const S = {
  page: { padding: '1.5rem 2rem', background: '#F9F9F9', minHeight: '100vh', color: '#18191B' },
  topBar: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.9rem', gap: '1rem', flexWrap: 'wrap' },
  pageTitle: { color: '#18191B', fontSize: '1.3rem', fontWeight: 700, margin: 0 },
  pageSub: { color: '#5D6C7B', fontSize: '0.82rem', margin: '0.2rem 0 0' },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #DFE7E3', marginBottom: '1rem', flexWrap: 'wrap' },
  tab: a => ({ padding: '0.55rem 0.85rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none', borderBottom: `2px solid ${a ? '#1C4942' : 'transparent'}`, color: a ? '#1C4942' : '#5D6C7B', marginBottom: -1, whiteSpace: 'nowrap' }),
  card: { background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3', boxShadow: '0 1px 3px rgba(0,18,20,0.06)', marginBottom: '1rem' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.8rem 1.1rem', borderBottom: '1px solid #DFE7E3', gap: 8, flexWrap: 'wrap' },
  cardTitle: { fontWeight: 700, fontSize: '0.9rem', color: '#18191B' },
  cardBody: { padding: '1rem 1.1rem' },
  muted: { color: '#5D6C7B', fontSize: '0.78rem' },
  small: { color: '#9BA8B0', fontSize: '0.72rem' },
  btn: { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#EAF4EF', border: '1px solid #A7C4BC', color: '#1C4942', borderRadius: 6, padding: '0.35rem 0.8rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' },
  primary: { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#1C4942', border: '1px solid #1C4942', color: '#FFFFFF', borderRadius: 6, padding: '0.4rem 0.9rem', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' },
  ghost: { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#5D6C7B', borderRadius: 6, padding: '0.35rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  danger: { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 6, padding: '0.35rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' },
  input: { background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B', borderRadius: 6, padding: '0.35rem 0.55rem', fontSize: '0.8rem', fontFamily: 'inherit', boxSizing: 'border-box' },
  select: { background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B', borderRadius: 6, padding: '0.35rem 0.5rem', fontSize: '0.8rem', fontFamily: 'inherit', maxWidth: 260 },
  label: { display: 'block', color: '#5D6C7B', fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 },
  th: { textAlign: 'left', padding: '0.45rem 0.55rem', fontSize: '0.66rem', fontWeight: 700, color: '#5D6C7B', textTransform: 'uppercase', letterSpacing: '0.03em', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 },
  thR: { textAlign: 'right' },
  td: { padding: '0.45rem 0.55rem', fontSize: '0.76rem', color: '#18191B', borderBottom: '1px solid #F0F2F1', verticalAlign: 'top' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  error: { background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', borderRadius: 8, padding: '0.55rem 0.8rem', fontSize: '0.8rem', marginBottom: '0.75rem' },
  notice: { background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E', borderRadius: 8, padding: '0.55rem 0.8rem', fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.5 },
  info: { background: '#EFF6FF', border: '1px solid #BFDBFE', color: '#1E40AF', borderRadius: 8, padding: '0.55rem 0.8rem', fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.5 },
  ok: { background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#15803D', borderRadius: 8, padding: '0.55rem 0.8rem', fontSize: '0.8rem', marginBottom: '0.75rem' },
  demo: { background: '#7C3AED', color: '#fff', borderRadius: 8, padding: '0.5rem 0.9rem', fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.75rem', letterSpacing: '0.01em' },
  center: { padding: '2rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.85rem' },
  grid: n => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${n}px, 1fr))`, gap: '0.75rem' }),
};

export function Field({ label, children, style, hint }) {
  return <label style={{ display: 'block', ...style }}><span style={S.label}>{label}</span>{children}{hint && <span style={{ ...S.small, display: 'block', marginTop: 2 }}>{hint}</span>}</label>;
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

/** A figure with its label, a hover definition and an optional drill-down link */
export function Card({ title, value, sub, tone, def, onDrill, children, muted }) {
  const color = tone === 'bad' ? '#B91C1C' : tone === 'warn' ? '#B45309' : tone === 'good' ? '#15803D' : '#18191B';
  return (
    <div style={{ ...S.card, marginBottom: 0, padding: '0.85rem 1rem', opacity: muted ? 0.55 : 1, cursor: onDrill ? 'pointer' : 'default' }} onClick={onDrill} title={def}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ ...S.label, marginBottom: 4 }}>{title}</span>
        {def && <span title={def} style={{ color: '#9BA8B0', fontSize: '0.72rem', cursor: 'help' }}>ⓘ</span>}
      </div>
      <div style={{ fontSize: '1.25rem', fontWeight: 700, color, lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ ...S.muted, marginTop: 3, lineHeight: 1.4 }}>{sub}</div>}
      {children}
      {onDrill && <div style={{ ...S.small, marginTop: 4, color: '#1C4942' }}>Show the documents →</div>}
    </div>
  );
}

/** A slide-in panel from the right */
export function Drawer({ title, onClose, children, width = 760 }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,18,20,0.35)' }} />
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: `min(${width}px, 100vw)`, background: '#F9F9F9', boxShadow: '-6px 0 24px rgba(0,18,20,0.18)', overflowY: 'auto' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 2, background: '#fff', borderBottom: '1px solid #DFE7E3', padding: '0.8rem 1.1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{title}</div>
          <button onClick={onClose} style={{ ...S.ghost, padding: '0.25rem 0.6rem' }}>Close ✕</button>
        </div>
        <div style={{ padding: '1rem 1.1rem' }}>{children}</div>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, width = 520 }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,18,20,0.4)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ ...S.card, marginBottom: 0, width: `min(${width}px, 94vw)`, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={S.cardHead}><span style={S.cardTitle}>{title}</span><button onClick={onClose} style={{ ...S.ghost, padding: '0.2rem 0.55rem' }}>✕</button></div>
        <div style={S.cardBody}>{children}</div>
      </div>
    </div>
  );
}

/** Asks for a reason (required) before an action that changes a decision */
export function ReasonModal({ title, text, confirm = 'Confirm', danger, onCancel, onConfirm, extra }) {
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal title={title} onClose={onCancel}>
      {text && <p style={{ ...S.muted, marginTop: 0, lineHeight: 1.5 }}>{text}</p>}
      <Field label="Reason (kept in the audit trail)"><textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} rows={3} style={{ ...S.input, width: '100%', resize: 'vertical' }} /></Field>
      {extra}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button style={S.ghost} onClick={onCancel}>Cancel</button>
        <button style={danger ? S.danger : S.primary} disabled={!reason.trim() || busy} onClick={async () => { setBusy(true); try { await onConfirm(reason.trim()); } finally { setBusy(false); } }}>{busy ? 'Working…' : confirm}</button>
      </div>
    </Modal>
  );
}
