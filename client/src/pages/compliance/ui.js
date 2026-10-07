// Shared UI pieces for the Compliance Dashboard, built in the Finance Suite look
// (same card, table, button, badge and input styles as the GST / Financial Statements pages).

import React, { useEffect } from 'react';
import * as XLSX from 'xlsx';
import { X, RefreshCw, AlertTriangle } from 'lucide-react';
import { T } from '../../theme';

// ── Styles ────────────────────────────────────────────────────────────────────
export const S = {
  page:    { padding: '1.5rem 2rem', minHeight: '100vh', background: T.page, fontFamily: T.font, color: T.text },
  h1:      { color: T.text, fontSize: '1.25rem', fontWeight: 700, margin: 0 },
  sub:     { color: T.textMuted, fontSize: '0.82rem', margin: '4px 0 0', maxWidth: 760 },
  crumbs:  { fontSize: '0.72rem', color: T.textFaint, marginBottom: 6 },
  card:    { background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radius.lg, overflow: 'hidden', marginBottom: '1.1rem' },
  cardHead:{ display: 'flex', alignItems: 'center', gap: 10, padding: '0.8rem 1.1rem', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' },
  cardTitle: { color: T.text, fontWeight: 700, fontSize: '0.92rem' },
  cardSub: { color: T.textMuted, fontSize: '0.75rem', marginTop: 2 },
  label:   { display: 'block', fontSize: '0.62rem', fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 },
  control: { background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radius.sm, color: T.text, fontSize: '0.8rem', padding: '0.4rem 0.6rem', width: '100%', fontFamily: T.font },
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
  th:      { padding: '0.45rem 0.8rem', textAlign: 'left', verticalAlign: 'bottom', fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: T.textFaint, background: T.page, borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' },
  td:      { padding: '0.5rem 0.8rem', color: T.text, borderBottom: `1px solid ${T.border}`, verticalAlign: 'middle' },
  num:     { padding: '0.5rem 0.8rem', color: T.text, borderBottom: `1px solid ${T.border}`, verticalAlign: 'middle', textAlign: 'right', fontFamily: T.mono, whiteSpace: 'nowrap' },
  muted:   { color: T.textMuted, fontSize: '0.78rem' },
  faint:   { color: T.textFaint, fontSize: '0.74rem' },
  tabs:    { display: 'flex', gap: 4, background: T.card, border: `1px solid ${T.border}`, borderRadius: T.radius.md, padding: 4, width: 'fit-content', maxWidth: '100%', overflowX: 'auto' },
  tab:     active => ({ padding: '7px 18px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap',
    background: active ? T.primary : 'transparent', color: active ? '#fff' : T.textFaint, transition: 'all 0.15s', fontFamily: T.font }),
  subTab:  active => ({ padding: '6px 12px', borderRadius: 6, border: `1px solid ${active ? T.primary : T.border}`, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap',
    background: active ? T.primarySoft : T.card, color: active ? T.primary : T.textMuted, fontFamily: T.font, display: 'inline-flex', alignItems: 'center', gap: 6 }),
  linkBtn: { background: 'none', border: 'none', color: T.primary, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', padding: 0, fontFamily: T.font },
};

const BTN = {
  soft:    { background: T.primarySoft, color: T.primary, border: `1px solid ${T.border}` },
  primary: { background: T.primary, color: '#fff', border: `1px solid ${T.primary}` },
  ghost:   { background: T.card, color: T.textMuted, border: `1px solid ${T.border}` },
  danger:  { background: '#FEF2F2', color: T.danger, border: '1px solid #FECACA' },
};

export function Btn({ variant = 'soft', size = 'md', icon: Icon, children, style, disabled, spin, ...rest }) {
  return (
    <button
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 6, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: T.font,
        padding: size === 'sm' ? '4px 9px' : '6px 12px', fontSize: size === 'sm' ? '0.74rem' : '0.78rem',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, ...BTN[variant], ...style,
      }}
      {...rest}
    >
      {Icon && <Icon size={size === 'sm' ? 12 : 13} style={spin ? { animation: 'spin 1s linear infinite' } : undefined} />}
      {children}
    </button>
  );
}

export function Card({ title, subtitle, right, children, style, bodyStyle, icon: Icon }) {
  return (
    <div style={{ ...S.card, ...style }}>
      {(title || right) && (
        <div style={S.cardHead}>
          {Icon && <Icon size={15} color={T.primary} />}
          <div style={{ flex: 1, minWidth: 160 }}>
            {title && <div style={S.cardTitle}>{title}</div>}
            {subtitle && <div style={S.cardSub}>{subtitle}</div>}
          </div>
          {right}
        </div>
      )}
      <div style={bodyStyle}>{children}</div>
    </div>
  );
}

export function Field({ label, children, hint, style }) {
  return (
    <label style={{ display: 'block', minWidth: 0, ...style }}>
      <span style={S.label}>{label}</span>
      {children}
      {hint && <span style={{ ...S.faint, display: 'block', marginTop: 3 }}>{hint}</span>}
    </label>
  );
}

/** Native select; options: [{ value, label, disabled }] */
export function Select({ value, onChange, options, style, ...rest }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...S.control, ...style }} {...rest}>
      {options.map(o => (
        <option key={o.value} value={o.value} disabled={o.disabled} style={o.disabled ? { color: T.scroll } : undefined}>{o.label}</option>
      ))}
    </select>
  );
}

export function Input({ style, ...rest }) {
  return <input style={{ ...S.control, ...style }} {...rest} />;
}

export function StatusBadge({ status, colors, late }) {
  const c = colors?.[status] || T.status[status] || T.textMuted;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700, lineHeight: 1.45, background: `${c}18`, color: c, border: `1px solid ${c}40`, whiteSpace: 'nowrap' }}>
      {status}{late ? <span title="Completed after the due date" style={{ fontWeight: 600, opacity: 0.8 }}>· late</span> : null}
    </span>
  );
}

export function Chip({ children, onRemove, color = T.primary }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600, background: `${color}12`, color, border: `1px solid ${color}30` }}>
      {children}
      {onRemove && <button onClick={onRemove} title="Remove filter" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color, display: 'inline-flex' }}><X size={12} /></button>}
    </span>
  );
}

export function PctBar({ pct }) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const c = pct == null ? T.textFaint : pct >= 90 ? T.success : pct >= 60 ? T.primary : pct >= 30 ? T.warning : T.danger;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 7, background: T.track, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${v}%`, height: '100%', background: c, borderRadius: 4 }} />
      </div>
      <span style={{ fontFamily: T.mono, fontSize: '0.75rem', color: pct == null ? T.textFaint : T.text, minWidth: 42, textAlign: 'right' }}>{pct == null ? '—' : `${pct}%`}</span>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div style={{ textAlign: 'center', padding: '2.5rem' }}>
      <RefreshCw size={20} style={{ animation: 'spin 1s linear infinite', color: T.primary, display: 'block', margin: '0 auto 10px' }} />
      <div style={{ color: T.text, fontWeight: 600, fontSize: '0.85rem' }}>{label}</div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  return (
    <div style={{ textAlign: 'center', padding: '2rem' }}>
      <AlertTriangle size={24} style={{ color: T.warning, display: 'block', margin: '0 auto 8px' }} />
      <div style={{ color: '#B45309', fontWeight: 600, marginBottom: 6 }}>Could not load</div>
      <div style={{ color: T.textMuted, fontSize: '0.8rem', marginBottom: 14 }}>{error}</div>
      {onRetry && <Btn onClick={onRetry}>Retry</Btn>}
    </div>
  );
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div style={{ textAlign: 'center', padding: '2rem 1rem', color: T.textFaint }}>
      {Icon && <Icon size={22} style={{ display: 'block', margin: '0 auto 8px', color: T.scroll }} />}
      {title && <div style={{ color: T.textMuted, fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>{title}</div>}
      <div style={{ fontSize: '0.78rem' }}>{children}</div>
    </div>
  );
}

/** Inline message line (success / error / info) */
export function Note({ kind = 'info', children, style }) {
  const c = kind === 'error' ? T.danger : kind === 'success' ? T.success : kind === 'warning' ? T.warning : T.primary;
  if (!children) return null;
  return (
    <div style={{ padding: '0.55rem 0.8rem', borderRadius: T.radius.md, fontSize: '0.78rem', background: `${c}0D`, border: `1px solid ${c}33`, color: kind === 'info' ? T.text : c, lineHeight: 1.5, ...style }}>
      {children}
    </div>
  );
}

function useEscape(onClose) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Modal({ title, subtitle, onClose, children, footer, width = 560 }) {
  useEscape(onClose);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.45)', zIndex: 400, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto' }} onMouseDown={onClose}>
      <div role="dialog" aria-label={title} onMouseDown={e => e.stopPropagation()}
        style={{ background: T.card, borderRadius: T.radius.lg, border: `1px solid ${T.border}`, width: '100%', maxWidth: width, boxShadow: '0 12px 40px rgba(0,18,20,0.18)', fontFamily: T.font }}>
        <div style={{ ...S.cardHead, padding: '0.9rem 1.2rem' }}>
          <div style={{ flex: 1 }}>
            <div style={{ ...S.cardTitle, fontSize: '0.98rem' }}>{title}</div>
            {subtitle && <div style={S.cardSub}>{subtitle}</div>}
          </div>
          <button onClick={onClose} title="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textMuted, display: 'inline-flex' }}><X size={18} /></button>
        </div>
        <div style={{ padding: '1rem 1.2rem' }}>{children}</div>
        {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0.8rem 1.2rem', borderTop: `1px solid ${T.border}`, background: T.page, borderRadius: `0 0 ${T.radius.lg}px ${T.radius.lg}px`, flexWrap: 'wrap' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children, width = 600, right }) {
  useEscape(onClose);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.35)', zIndex: 400 }} onMouseDown={onClose}>
      <aside role="dialog" aria-label={title} onMouseDown={e => e.stopPropagation()}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: `min(${width}px, 100vw)`, background: T.page, borderLeft: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', fontFamily: T.font, boxShadow: '-8px 0 30px rgba(0,18,20,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '1rem 1.2rem', background: T.card, borderBottom: `1px solid ${T.border}` }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...S.cardTitle, fontSize: '0.98rem', fontFamily: T.mono, overflowWrap: 'anywhere' }}>{title}</div>
            {subtitle && <div style={S.cardSub}>{subtitle}</div>}
          </div>
          {right}
          <button onClick={onClose} title="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textMuted, display: 'inline-flex' }}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.2rem' }}>{children}</div>
      </aside>
    </div>
  );
}

// ── Formatting ────────────────────────────────────────────────────────────────
export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtINR(v) {
  if (v == null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v);
}
export function fmtSize(b) {
  if (!b) return '';
  return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}
export const dmyToIso = s => {
  const m = String(s || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
};

// ── Files ─────────────────────────────────────────────────────────────────────
export function saveBlob(data, filename) {
  const url = window.URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => window.URL.revokeObjectURL(url), 60000);
}

/** Excel export of rows using column definitions [{ key, header, type, width }] */
export function exportXlsx(filename, sheet, columns, rows, valueOf) {
  const val = valueOf || ((r, c) => (c.type === 'date' ? fmtDate(r[c.key]) : r[c.key] ?? ''));
  const ws = XLSX.utils.aoa_to_sheet([columns.map(c => c.header), ...rows.map(r => columns.map(c => {
    const v = val(r, c);
    return v === '—' ? '' : v;
  }))]);
  ws['!cols'] = columns.map(c => ({ wch: c.width || 16 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
  XLSX.writeFile(wb, filename);
}

/** Global styles for this page (responsive grids, spinner) */
export const PAGE_CSS = `
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .cmp-filters { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
  .cmp-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 1.1rem; }
  .cmp-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.1rem; }
  .cmp-two > div { min-width: 0; }
  .cmp-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .cmp-form3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .cmp-row:hover td { background: #F4F8F6; }
  .cmp-kpi:hover { filter: brightness(0.98); }
  .cmp-scroll { overflow-x: auto; }
  .cmp-scroll::-webkit-scrollbar { height: 10px; }
  .cmp-scroll::-webkit-scrollbar-track { background: ${T.track}; }
  .cmp-scroll::-webkit-scrollbar-thumb { background: #A9BDB5; border-radius: 6px; border: 2px solid ${T.track}; }
  @media (max-width: 1100px) { .cmp-filters { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 900px) { .cmp-two { grid-template-columns: minmax(0, 1fr); } .cmp-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 640px) { .cmp-filters, .cmp-form, .cmp-form3 { grid-template-columns: minmax(0, 1fr); } .cmp-page { padding: 1rem !important; } }
`;
