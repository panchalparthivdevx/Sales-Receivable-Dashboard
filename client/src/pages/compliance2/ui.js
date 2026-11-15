import React, { useEffect, useRef, useState } from 'react';

// Compliance Dashboard Vr.2.0 — design system (navy + lavender, used inside this module only; the rest of the app keeps its
// own theme). Pale canvas, navy gradient section headers, lavender active navigation and primary actions, white rounded
// cards, restrained shadows, readable tables, status badges, visible focus rings.

export const C = {
  canvas: '#F5F6FB', card: '#FFFFFF', border: '#E3E6F0', line: '#EEF0F6',
  navy: '#1B2452', navy2: '#2C3A7C', navyText: '#E8EAF6',
  lav: '#6656D6', lavSoft: '#EEEBFD', lavLine: '#CFC8F7', teal: '#0E8C7F', tealSoft: '#E6F6F3',
  text: '#1A1D2E', muted: '#5F6680', faint: '#98A0B8',
  red: '#B42318', redSoft: '#FEF3F2', amber: '#B54708', amberSoft: '#FFFAEB', green: '#067647', greenSoft: '#ECFDF3', blue: '#175CD3', blueSoft: '#EFF8FF',
};

export const STATUS_TONE = {
  not_started: ['#475467', '#F2F4F7'], in_progress: [C.blue, C.blueSoft], ready_for_review: [C.amber, C.amberSoft], changes_requested: ['#C4320A', '#FFF4ED'],
  approved_to_file: [C.lav, C.lavSoft], filed_awaiting_verification: [C.teal, C.tealSoft], completed: [C.green, C.greenSoft],
};
export const FLAG_META = {
  overdue: ['Overdue', 'red'], due_soon: ['Due soon', 'amber'], no_due_date: ['No due date', 'grey'], filed_late: ['Filed late', 'red'], evidence_missing: ['Evidence missing', 'red'],
  rule_unverified: ['Rule unverified', 'amber'], missing_rule: ['Missing state rule', 'amber'], document_flags: ['Document check', 'amber'], sample: ['Sample', 'lav'],
};
const TONES = { grey: ['#475467', '#F2F4F7'], red: [C.red, C.redSoft], amber: [C.amber, C.amberSoft], green: [C.green, C.greenSoft], blue: [C.blue, C.blueSoft], lav: [C.lav, C.lavSoft], teal: [C.teal, C.tealSoft] };

export const S = {
  page: { padding: '1.25rem 1.75rem 2rem', background: C.canvas, minHeight: '100vh', color: C.text, fontFamily: 'Figtree, Inter, system-ui, sans-serif' },
  card: { background: C.card, borderRadius: 14, border: `1px solid ${C.border}`, boxShadow: '0 1px 2px rgba(16,24,40,0.05)', marginBottom: '1rem' },
  body: { padding: '1rem 1.15rem' },
  muted: { color: C.muted, fontSize: '0.8rem' },
  small: { color: C.faint, fontSize: '0.72rem' },
  label: { display: 'block', color: C.muted, fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 },
  input: { width: '100%', background: '#fff', border: `1px solid ${C.border}`, color: C.text, borderRadius: 8, padding: '0.42rem 0.6rem', fontSize: '0.82rem', fontFamily: 'inherit', boxSizing: 'border-box' },
  th: { textAlign: 'left', padding: '0.5rem 0.6rem', fontSize: '0.66rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.03em', background: '#F8F9FC', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 },
  td: { padding: '0.5rem 0.6rem', fontSize: '0.78rem', color: C.text, borderBottom: `1px solid ${C.line}`, verticalAlign: 'top' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  grid: min => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: '0.85rem' }),
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
};

/** Focus rings and small responsive rules (inline styles cannot express :focus-visible) */
export function GlobalStyle() {
  return (
    <style>{`
      .c2 *:focus-visible { outline: 2px solid ${C.lav}; outline-offset: 2px; border-radius: 6px; }
      .c2 button:disabled { opacity: .5; cursor: not-allowed; }
      .c2 tr.c2-click:hover td { background: #F7F6FE; cursor: pointer; }
      .c2 .c2-scroll { overflow: auto; }
      @media (max-width: 720px) { .c2 .c2-hide-sm { display: none; } .c2.c2-page { padding: 12px 16px 24px !important; } }
      .c2 .c2-nowrap { white-space: nowrap; }
    `}</style>
  );
}

const BTN = {
  base: { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 8, padding: '0.42rem 0.85rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' },
  primary: { background: C.lav, border: `1px solid ${C.lav}`, color: '#fff' },
  soft: { background: C.lavSoft, border: `1px solid ${C.lavLine}`, color: C.lav },
  ghost: { background: '#fff', border: `1px solid ${C.border}`, color: C.muted },
  danger: { background: C.redSoft, border: '1px solid #FECDCA', color: C.red },
  onNavy: { background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)', color: '#fff' },
};
export function Btn({ kind = 'soft', small, children, style, ...p }) {
  return <button type="button" {...p} style={{ ...BTN.base, ...BTN[kind], ...(small ? { padding: '0.25rem 0.6rem', fontSize: '0.72rem' } : {}), ...style }}>{children}</button>;
}

export function Tag({ tone = 'grey', children, title }) {
  const [c, bg] = TONES[tone] || TONES.grey;
  return <span title={title} style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 999, fontSize: '0.66rem', fontWeight: 700, color: c, background: bg, whiteSpace: 'nowrap', marginRight: 4, marginBottom: 2 }}>{children}</span>;
}
export function StatusBadge({ status, label }) {
  const [c, bg] = STATUS_TONE[status] || TONES.grey;
  return <span style={{ display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: c, background: bg, whiteSpace: 'nowrap' }}>{label || status}</span>;
}
export function Flags({ flags = [], skip = [] }) {
  return <>{flags.filter(f => !skip.includes(f) && FLAG_META[f]).map(f => <Tag key={f} tone={FLAG_META[f][1]}>{FLAG_META[f][0]}</Tag>)}</>;
}

/** Card with a navy gradient header */
export function Section({ title, sub, right, children, flush, id }) {
  return (
    <section style={S.card} aria-labelledby={id}>
      <div style={{ background: `linear-gradient(120deg, ${C.navy} 0%, ${C.navy2} 100%)`, color: '#fff', borderRadius: '14px 14px 0 0', padding: '0.7rem 1.1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h2 id={id} style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700 }}>{title}</h2>
          {sub && <div style={{ fontSize: '0.74rem', color: C.navyText, opacity: 0.85, marginTop: 2 }}>{sub}</div>}
        </div>
        {right && <div style={S.row}>{right}</div>}
      </div>
      <div style={flush ? {} : S.body}>{children}</div>
    </section>
  );
}

export function Note({ tone = 'info', children, style }) {
  const t = { info: [C.blue, C.blueSoft, '#B2DDFF'], warn: [C.amber, C.amberSoft, '#FEDF89'], error: [C.red, C.redSoft, '#FECDCA'], demo: [C.lav, C.lavSoft, C.lavLine], ok: [C.green, C.greenSoft, '#ABEFC6'] }[tone];
  return <div role={tone === 'error' ? 'alert' : 'note'} style={{ color: t[0], background: t[1], border: `1px solid ${t[2]}`, borderRadius: 10, padding: '0.55rem 0.8rem', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: '0.75rem', ...style }}>{children}</div>;
}

export function Kpi({ label, value, sub, tone = 'navy', onClick, active }) {
  const color = { navy: C.navy, red: C.red, amber: C.amber, green: C.green, lav: C.lav, teal: C.teal }[tone];
  const Tagn = onClick ? 'button' : 'div';
  return (
    <Tagn type={onClick ? 'button' : undefined} onClick={onClick} aria-pressed={onClick ? !!active : undefined}
      style={{ textAlign: 'left', background: '#fff', border: `1px solid ${active ? C.lav : C.border}`, boxShadow: active ? `0 0 0 3px ${C.lavSoft}` : '0 1px 2px rgba(16,24,40,0.05)', borderRadius: 14, padding: '0.85rem 1rem', cursor: onClick ? 'pointer' : 'default', fontFamily: 'inherit', width: '100%' }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 800, color, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.72rem', color: C.muted, marginTop: 2, lineHeight: 1.35 }}>{sub}</div>}
    </Tagn>
  );
}

/** Completion donut — numerator / denominator always shown; no denominator = "not configured" */
export function Donut({ numerator, denominator, label, size = 132 }) {
  const r = size / 2 - 12, c = 2 * Math.PI * r;
  const frac = denominator ? numerator / denominator : 0;
  return (
    <figure style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 14 }} aria-label={`${label}: ${denominator ? `${numerator} of ${denominator}` : 'no records'}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.line} strokeWidth="12" />
        {denominator > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.lav} strokeWidth="12" strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
        <text x="50%" y="48%" textAnchor="middle" fontSize="20" fontWeight="800" fill={C.navy}>{denominator ? `${Math.round(frac * 1000) / 10}%` : '—'}</text>
        <text x="50%" y="63%" textAnchor="middle" fontSize="10" fill={C.muted}>{denominator ? `${numerator} / ${denominator}` : 'no records'}</text>
      </svg>
      <figcaption style={{ fontSize: '0.78rem', color: C.muted, maxWidth: 220, lineHeight: 1.45 }}>{label}</figcaption>
    </figure>
  );
}

/** Horizontal stacked bar: [{ value, color, label }] */
export function StackBar({ parts, total }) {
  const sum = total ?? parts.reduce((a, p) => a + p.value, 0);
  if (!sum) return <div style={{ height: 8, borderRadius: 8, background: C.line }} />;
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 8, overflow: 'hidden', background: C.line }} role="img" aria-label={parts.map(p => `${p.label} ${p.value}`).join(', ')}>
      {parts.filter(p => p.value > 0).map(p => <div key={p.label} title={`${p.label}: ${p.value}`} style={{ width: `${(p.value / sum) * 100}%`, background: p.color }} />)}
    </div>
  );
}

export function Field({ label, children, hint, style }) {
  return <label style={{ display: 'block', ...style }}><span style={S.label}>{label}</span>{children}{hint && <span style={{ ...S.small, display: 'block', marginTop: 3 }}>{hint}</span>}</label>;
}
export function Input(p) { return <input {...p} style={{ ...S.input, ...p.style }} />; }
export function Area(p) { return <textarea {...p} style={{ ...S.input, minHeight: 70, resize: 'vertical', ...p.style }} />; }
export function Select({ options, value, onChange, placeholder, style, ...p }) {
  return (
    <select {...p} value={value ?? ''} onChange={e => onChange(e.target.value)} style={{ ...S.input, ...style }}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map(o => (Array.isArray(o) ? <option key={o[0]} value={o[0]}>{o[1]}</option> : <option key={o} value={o}>{o}</option>))}
    </select>
  );
}

/** Multi-select as a checkbox dropdown. options: [[value, label]] */
export function Multi({ label, options, value = [], onChange, width = 190 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  const toggle = v => onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v]);
  const text = !value.length ? 'All' : value.length === 1 ? (options.find(o => o[0] === value[0])?.[1] || value[0]) : `${value.length} selected`;
  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 120, width }}>
      <span style={S.label}>{label}</span>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)} style={{ ...S.input, textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 6, color: value.length ? C.lav : C.text, fontWeight: value.length ? 700 : 400 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span><span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div role="listbox" aria-multiselectable="true" style={{ position: 'absolute', zIndex: 30, top: '100%', left: 0, marginTop: 4, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 12px 24px rgba(16,24,40,0.14)', minWidth: Math.max(220, width), maxHeight: 320, overflow: 'auto', padding: 6 }}>
          {value.length > 0 && <button type="button" onClick={() => onChange([])} style={{ ...BTN.base, ...BTN.ghost, width: '100%', justifyContent: 'center', marginBottom: 4, padding: '0.2rem' }}>Clear</button>}
          {options.length === 0 && <div style={{ ...S.small, padding: 6 }}>Nothing to choose</div>}
          {options.map(([v, l]) => (
            <label key={v} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 6px', fontSize: '0.8rem', cursor: 'pointer', borderRadius: 6, background: value.includes(v) ? C.lavSoft : 'transparent' }}>
              <input type="checkbox" checked={value.includes(v)} onChange={() => toggle(v)} /> {l}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Side panel (dialog) */
export function Drawer({ title, onClose, children, width = 760 }) {
  useEffect(() => { const k = e => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(16,24,64,0.35)' }} />
      <div className="c2" style={{ position: 'relative', width: `min(${width}px, 100vw)`, height: '100%', background: C.canvas, overflow: 'auto', boxShadow: '-12px 0 32px rgba(16,24,40,0.2)' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 5, background: `linear-gradient(120deg, ${C.navy}, ${C.navy2})`, color: '#fff', padding: '0.85rem 1.1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>{title}</h2>
          <Btn kind="onNavy" small onClick={onClose} aria-label="Close">Close ✕</Btn>
        </div>
        <div style={{ padding: '1rem 1.1rem' }}>{children}</div>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, width = 520 }) {
  useEffect(() => { const k = e => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(16,24,64,0.4)' }} />
      <div className="c2" style={{ position: 'relative', width: `min(${width}px, 100%)`, maxHeight: '90vh', overflow: 'auto', background: '#fff', borderRadius: 14, boxShadow: '0 24px 48px rgba(16,24,40,0.25)' }}>
        <div style={{ background: `linear-gradient(120deg, ${C.navy}, ${C.navy2})`, color: '#fff', padding: '0.75rem 1rem', borderRadius: '14px 14px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{title}</h3>
          <Btn kind="onNavy" small onClick={onClose} aria-label="Close">✕</Btn>
        </div>
        <div style={{ padding: '1rem' }}>{children}</div>
      </div>
    </div>
  );
}

export function Table({ cols, rows, onRow, empty = 'Nothing to show', maxHeight, rowKey = r => r.id }) {
  return (
    <div className="c2-scroll" style={{ maxHeight, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{cols.map(c => <th key={c.key || c.label} scope="col" className={c.hideSm ? 'c2-hide-sm' : undefined} style={{ ...S.th, ...(c.num ? { textAlign: 'right' } : {}), width: c.width }}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={cols.length} style={{ ...S.td, textAlign: 'center', color: C.muted, padding: '1.5rem' }}>{empty}</td></tr>}
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} className={onRow ? 'c2-click' : undefined} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? e => { if (e.key === 'Enter') onRow(r); } : undefined}>
              {cols.map(c => <td key={c.key || c.label} className={c.hideSm ? 'c2-hide-sm' : undefined} style={{ ...S.td, ...(c.num ? S.num : {}) }}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: 4, marginBottom: '1rem' }}>
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          style={{ border: 'none', borderRadius: 9, padding: '0.45rem 0.85rem', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', background: value === t.id ? C.lavSoft : 'transparent', color: value === t.id ? C.lav : C.muted }}>
          {t.label}{t.count ? <span style={{ marginLeft: 6, background: value === t.id ? C.lav : C.line, color: value === t.id ? '#fff' : C.muted, borderRadius: 999, padding: '0 6px', fontSize: '0.66rem' }}>{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export const dt = s => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const dtm = s => (s ? new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const inr = n => (n === null || n === undefined || n === '' ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
export const ratioText = r => (!r || !r.denominator ? 'no records' : `${r.numerator} of ${r.denominator} (${r.pct}%)`);
export const Empty = ({ children }) => <div style={{ padding: '1.5rem', textAlign: 'center', color: C.muted, fontSize: '0.85rem' }}>{children}</div>;
