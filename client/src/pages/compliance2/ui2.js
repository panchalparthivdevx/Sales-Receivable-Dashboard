import React from 'react';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ReferenceLine } from 'recharts';
import { C, S, Btn } from './ui';

// Workspace pieces shared by Reports, GST, TDS, Provident Fund & PT, Payroll imports, Tax audit and Updates — the demo's
// look: navy hero with an eyebrow, lavender pill sub-navigation, four-colour stat cards, amber notices, plain data tables.

export const STAT_COLORS = ['#6554C5', '#249D98', '#C58C2B', '#D85D70'];

export function Hero({ eyebrow, title, sub, tag, tagSub, right }) {
  return (
    <div className="c2-hero" style={{ background: 'linear-gradient(115deg, #18253F, #28365C)', borderRadius: 16, color: '#fff', padding: '24px 28px', margin: '4px 0 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0, flex: '1 1 420px' }}>
        <div style={{ color: '#B3BEE0', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.6, fontWeight: 650 }}>FINANCE &amp; COMPLIANCE / {eyebrow}</div>
        <h2 style={{ fontSize: 26, margin: '8px 0', lineHeight: 1.2, fontWeight: 800 }}>{title}</h2>
        {sub && <p style={{ color: '#C4CCE0', fontSize: 13, margin: 0, maxWidth: 850 }}>{sub}</p>}
      </div>
      {right || (tag && <div style={{ border: '1px solid #7380A455', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#E1E7F4' }}>{tag}{tagSub && <small style={{ display: 'block', marginTop: 5, color: '#AEBAD6' }}>{tagSub}</small>}</div>)}
    </div>
  );
}

export function Pills({ items, value, onChange, label = 'Views' }) {
  return (
    <div role="tablist" aria-label={label} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
      {items.map(([id, l]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}
          style={{ border: `1px solid ${value === id ? '#C9BFEE' : C.border}`, background: value === id ? '#EEEBFC' : '#fff', color: value === id ? '#5543B2' : '#485570', borderRadius: 8, padding: '8px 13px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: value === id ? 700 : 500 }}>{l}</button>
      ))}
    </div>
  );
}

/** Four stat cards — numbers in the demo's purple / teal / amber / rose */
export function Stats({ items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 18 }}>
      {items.map((it, i) => (
        <div key={it.label} style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, fontSize: 12, color: '#738097', minWidth: 0 }}>
          <div>{it.label}</div>
          <div style={{ color: it.color || STAT_COLORS[i % 4], fontSize: 28, fontWeight: 800, letterSpacing: -1, margin: '8px 0', overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>{it.value}</div>
          {it.sub && <div style={{ lineHeight: 1.4 }}>{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

export function Panel({ title, right, children, note, style }) {
  return (
    <section style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 13, padding: 20, marginBottom: 16, minWidth: 0, ...style }}>
      {(title || right) && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        {title && <h3 style={{ fontSize: 15, margin: 0, color: '#202C45' }}>{title}</h3>}{right && <div style={S.row}>{right}</div>}
      </div>}
      {children}
      {note && <p style={{ fontSize: 12, color: '#64718A', margin: '12px 0 0', lineHeight: 1.55 }}>{note}</p>}
    </section>
  );
}

export function Notice({ children, tone = 'amber' }) {
  const t = { amber: ['#FFF9E9', '#EEE3C1', '#766B50'], lav: ['#F7F5FE', '#E6DFF8', '#5543B2'], red: ['#FDECEF', '#F5C6CF', '#9F3247'] }[tone];
  return <div role="note" style={{ background: t[0], border: `1px solid ${t[1]}`, color: t[2], borderRadius: 10, fontSize: 12, padding: '11px 14px', marginBottom: 16, lineHeight: 1.55 }}>{children}</div>;
}

/** Simple data table: headers + rows of cells (strings or elements) */
export function DataTable({ headers, rows, empty = 'No records for this selection.', numeric = [], maxHeight }) {
  return (
    <div className="c2-scroll" style={{ overflow: 'auto', maxHeight }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', color: '#485570', lineHeight: 1.5 }}>
        <thead><tr>{headers.map((h, i) => <th key={i} scope="col" style={{ ...S.th, background: '#F8F9FD', color: '#7C87A0', fontSize: 10, letterSpacing: 0.7, padding: '12px', textAlign: numeric.includes(i) ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={headers.length} style={{ ...S.td, textAlign: 'center', color: C.muted, padding: '1.4rem' }}>{empty}</td></tr>}
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ ...S.td, padding: '11px 12px', borderColor: '#EDF0F6', ...(numeric.includes(j) ? S.num : {}) }}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

// ── Numbers ───────────────────────────────────────────────────────────────────
export const money = n => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
export const moneyOr = (n, missing = 'Not entered') => (n === null || n === undefined || n === '' ? missing : money(n));
export const compact = n => {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)}K`;
  return `${s}₹${Math.round(a)}`;
};
export const signed = (v, pct) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${pct ? `${Math.abs(v).toFixed(1)}%` : money(Math.abs(v))}`);
export const monthName = m => (m ? new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) : '—');
export function fyMonthList(fy) {
  if (!fy) return [];
  const s = parseInt(fy.slice(0, 4), 10);
  return Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; const y = i < 9 ? s : s + 1; return `${y}-${String(m).padStart(2, '0')}`; });
}
export function fyOf(date) {
  const y = +String(date).slice(0, 4), m = +String(date).slice(5, 7);
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}
export const fyLabel = fy => `FY ${fy.slice(0, 4)}–${fy.slice(5)}`;

// ── Charts ────────────────────────────────────────────────────────────────────
/** Column or line chart of [{ key, label, value, partial }] — a null value is "no data" (a gap, never a zero bar) */
export function TrendChart({ data, kind = 'columns', height = 260, valueLabel = 'Amount' }) {
  const rows = data.map(d => ({ ...d, v: d.value === null || d.value === undefined ? null : d.value }));
  const axis = { fontSize: 11, fill: '#8590A3' };
  const tip = v => (v === null ? 'No recorded data' : money(v));
  return (
    <div style={{ width: '100%', height }} role="img" aria-label={`${valueLabel}: ${rows.map(r => `${r.label} ${r.v === null ? 'no data' : money(r.v)}`).join('; ')}`}>
      <ResponsiveContainer>
        {kind === 'line' ? (
          <LineChart data={rows} margin={{ top: 10, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke="#EEF0F6" vertical={false} />
            <XAxis dataKey="label" tick={axis} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={compact} tick={axis} axisLine={false} tickLine={false} width={64} />
            <Tooltip formatter={v => [tip(v), valueLabel]} />
            <Line type="monotone" dataKey="v" stroke="#7865D6" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        ) : (
          <BarChart data={rows} margin={{ top: 10, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke="#EEF0F6" vertical={false} />
            <XAxis dataKey="label" tick={axis} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={compact} tick={axis} axisLine={false} tickLine={false} width={64} />
            <Tooltip formatter={v => [tip(v), valueLabel]} cursor={{ fill: '#F3F0FC' }} />
            <Bar dataKey="v" radius={[6, 6, 0, 0]} maxBarSize={52} isAnimationActive={false}>
              {rows.map((r, i) => <Cell key={i} fill={r.partial ? '#D5CCF5' : '#7865D6'} />)}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** Percentage movement around zero */
export function GrowthChart({ data, height = 220 }) {
  const rows = data.map(d => ({ ...d, v: d.pct }));
  return (
    <div style={{ width: '100%', height }} role="img" aria-label={rows.map(r => `${r.label} ${r.v === null ? 'not applicable' : `${r.v}%`}`).join('; ')}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 10, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid stroke="#EEF0F6" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8590A3' }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 11, fill: '#8590A3' }} axisLine={false} tickLine={false} width={48} />
          <ReferenceLine y={0} stroke="#98A0B8" />
          <Tooltip formatter={v => [v === null ? 'Not applicable' : `${v}%`, 'Change']} />
          <Bar dataKey="v" maxBarSize={40} isAnimationActive={false}>{rows.map((r, i) => <Cell key={i} fill={r.v >= 0 ? '#D97972' : '#249D98'} />)}</Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal bars: [[label, value]] */
export function HBars({ entries, isMoney = true, empty = 'No records for this selection.' }) {
  const max = Math.max(1, ...entries.map(e => Math.abs(e[1] || 0)));
  if (!entries.length) return <div style={{ color: C.muted, fontSize: 13, padding: '8px 0' }}>{empty}</div>;
  return (
    <div role="list">
      {entries.map(([l, v], i) => (
        <div role="listitem" key={`${l}-${i}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 34%) 1fr auto', gap: 10, alignItems: 'center', fontSize: 12, marginBottom: 8 }}>
          <span style={{ color: '#485570', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l}>{l}</span>
          <div style={{ background: '#F1F2F8', borderRadius: 6, height: 10 }}><div style={{ width: `${(Math.abs(v || 0) / max) * 100}%`, height: 10, borderRadius: 6, background: '#7865D6' }} /></div>
          <b style={{ color: '#34415B', fontVariantNumeric: 'tabular-nums' }}>{isMoney ? money(v) : v}</b>
        </div>
      ))}
    </div>
  );
}

/** Two-part stacked bars (cash vs ITC): [{ label, a, b }] */
export function StackedBars({ groups, aLabel, bLabel }) {
  const max = Math.max(1, ...groups.map(g => (g.a || 0) + (g.b || 0)));
  return (
    <div>
      <div style={{ fontSize: 12, marginBottom: 8 }}><span style={{ color: '#7865D6' }}>● {aLabel}</span> &nbsp; <span style={{ color: '#249D98' }}>● {bLabel}</span></div>
      {groups.map(g => (
        <div key={g.label} style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto', gap: 10, alignItems: 'center', fontSize: 12, marginBottom: 7 }}>
          <span>{g.label}</span>
          <div style={{ display: 'flex', background: '#F1F2F8', borderRadius: 6, height: 12, overflow: 'hidden' }}>
            {g.a === null ? <span style={{ fontSize: 10, color: C.muted, paddingLeft: 6 }}>no records</span> : <><div style={{ width: `${(g.a / max) * 100}%`, background: '#7865D6' }} /><div style={{ width: `${(g.b / max) * 100}%`, background: '#249D98' }} /></>}
          </div>
          <b>{g.a === null ? '—' : money(g.a + g.b)}</b>
        </div>
      ))}
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────
const cell = v => { const s = String(v ?? ''); return `"${(/^[=+@-]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
/** CSV with the dataset and filter context on top (formula injection neutralised) */
export function downloadCsv(name, context, headers, rows) {
  const lines = [...Object.entries(context).map(([k, v]) => [k, v]), [], headers, ...rows].map(r => r.map(cell).join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv' }));
  a.download = name.replace(/[^A-Za-z0-9_.-]+/g, '_');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function Toolbar({ children }) { return <div style={{ ...S.row, gap: 9, marginBottom: 16 }} className="c2-noprint">{children}</div>; }
export const PrintBtn = () => <Btn kind="ghost" onClick={() => window.print()}>Print / save as PDF</Btn>;

export function Filters({ children }) {
  return <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 16, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>{children}</div>;
}
export function FSel({ label, value, onChange, options, placeholder, width = 170, disabled }) {
  return (
    <label style={{ display: 'block', width, flex: `0 1 ${width}px`, minWidth: 120 }}>
      <span style={{ display: 'block', color: '#738097', fontSize: 12, marginBottom: 5 }}>{label}</span>
      <select value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} style={{ ...S.input, padding: '9px 10px' }}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map(o => (Array.isArray(o) ? <option key={o[0]} value={o[0]}>{o[1]}</option> : <option key={o} value={o}>{o}</option>))}
      </select>
    </label>
  );
}
export function FInput({ label, value, onChange, type = 'text', width = 170, placeholder }) {
  return (
    <label style={{ display: 'block', width, flex: `0 1 ${width}px`, minWidth: 120 }}>
      <span style={{ display: 'block', color: '#738097', fontSize: 12, marginBottom: 5 }}>{label}</span>
      <input type={type} value={value ?? ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} style={{ ...S.input, padding: '9px 10px' }} />
    </label>
  );
}

export const Badge = ({ tone = 'lav', children, title }) => {
  const t = { lav: ['#F0EFFA', '#7662B1'], green: ['#E8F6F1', '#27846B'], red: ['#FDECEF', '#C45669'], amber: ['#FFF4DD', '#947029'], grey: ['#F2F4F7', '#475467'] }[tone] || ['#F0EFFA', '#7662B1'];
  return <span title={title} style={{ background: t[0], color: t[1], borderRadius: 5, padding: '3px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-block', marginRight: 4, marginBottom: 2 }}>{children}</span>;
};
export const REVIEW_TONE = { draft: 'grey', ready_for_review: 'amber', reviewed: 'green' };
