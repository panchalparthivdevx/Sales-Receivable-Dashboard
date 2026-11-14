import React, { useEffect, useState, useCallback } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { CheckCircle2, AlertTriangle, XCircle, MinusCircle, Info, HelpCircle, X, FileSpreadsheet, FileText } from 'lucide-react';
import { fsApi, errText } from './api';

// ── look (app light theme) ───────────────────────────────────────────────────
export const C = { green: '#1C4942', ink: '#18191B', ink2: '#5D6C7B', ink3: '#9BA8B0', line: '#DFE7E3', tint: '#EAF4EF', page: '#F9F9F9', white: '#FFFFFF',
  good: '#15803D', warn: '#B45309', bad: '#DC2626', info: '#1D4ED8', s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a' };
export const S = {
  card: { background: C.white, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 16 },
  h2: { fontSize: '0.95rem', fontWeight: 700, color: C.ink, margin: '0 0 10px' },
  small: { fontSize: '0.72rem', color: C.ink2 },
  th: { padding: '7px 10px', textAlign: 'left', color: C.ink, fontWeight: 700, fontSize: '0.75rem', background: C.tint, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  td: { padding: '5px 10px', borderBottom: `1px solid ${C.line}`, fontSize: '0.79rem', color: C.ink, verticalAlign: 'top' },
  num: { textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  btn: (v = 'secondary', sm = true) => ({ padding: sm ? '5px 12px' : '8px 16px', borderRadius: 6, border: v === 'outline' ? `1px solid ${C.line}` : 'none', cursor: 'pointer', fontSize: sm ? '0.75rem' : '0.82rem', fontWeight: 600,
    background: v === 'primary' ? C.green : v === 'danger' ? C.bad : v === 'outline' ? C.white : '#DFE7E3', color: v === 'primary' || v === 'danger' ? '#fff' : C.ink, display: 'inline-flex', alignItems: 'center', gap: 6 }),
  select: { border: `1px solid ${C.line}`, borderRadius: 6, padding: '5px 8px', fontSize: '0.78rem', background: C.white, color: C.ink },
  input: { border: `1px solid ${C.line}`, borderRadius: 6, padding: '5px 8px', fontSize: '0.78rem', background: C.white, color: C.ink },
};

// ── numbers ──────────────────────────────────────────────────────────────────
const nf = (d) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
/** Amount stored in ₹ lakh → shown in the chosen unit. Negative in brackets, as in the statements. */
export function fmtAmt(v, du = 'lakh', dec) {
  if (v == null || Number.isNaN(v)) return '';
  let x = v, d = dec ?? 2;
  if (du === 'inr') { x = v * 1e5; d = dec ?? 0; }
  if (du === 'crore') { x = v / 100; d = dec ?? 2; }
  const s = nf(d).format(Math.abs(x));
  return x < 0 ? `(${s})` : s;
}
export const unitLabel = du => ({ inr: '₹', lakh: '₹ lakh', crore: '₹ crore' })[du] || '₹ lakh';
/** Any metric by its unit type: lakh amounts follow the display unit; EPS, ratios, days, % never scale */
export function fmtVal(v, unit, du = 'lakh') {
  if (v == null || Number.isNaN(v)) return '';
  if (unit === 'lakh') return fmtAmt(v, du);
  if (unit === 'fraction') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'times') return `${v.toFixed(2)}×`;
  if (unit === 'days') return `${Math.round(v)} d`;
  if (unit === 'inr') return `₹${nf(v !== 0 && Math.abs(v) < 10 ? 4 : 0).format(v)}`;
  if (unit === 'nos') return nf(0).format(v);
  return nf(2).format(v);
}
export const pctTxt = (p, note) => (note ? note : p == null ? '—' : `${p >= 0 ? '+' : ''}${(p * 100).toFixed(1)}%`);

// ── status ───────────────────────────────────────────────────────────────────
const STATUS = {
  OK: [C.good, CheckCircle2], Agrees: [C.good, CheckCircle2], 'Within threshold': [C.good, CheckCircle2], Reported: [C.good, CheckCircle2],
  Rounding: [C.info, Info], Info: [C.info, Info], Derived: [C.info, Info], 'Within threshold (proxy)': [C.warn, AlertTriangle],
  Proxy: [C.warn, AlertTriangle], Difference: [C.warn, AlertTriangle], 'No threshold set': [C.ink2, MinusCircle], 'Not Applicable': [C.ink2, MinusCircle], 'Not Meaningful': [C.ink2, MinusCircle],
  'Missing Input': [C.warn, HelpCircle], 'Missing data': [C.warn, HelpCircle], 'Not available': [C.ink2, MinusCircle],
  'Material difference': [C.bad, XCircle], Breach: [C.bad, XCircle], Unreconciled: [C.bad, XCircle],
};
export function Badge({ status, title }) {
  const [col, Icon] = STATUS[status] || [C.ink2, Info];
  return <span title={title || status} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.7rem', fontWeight: 600, color: col, whiteSpace: 'nowrap' }}><Icon size={13} />{status}</span>;
}

// ── layout bits ──────────────────────────────────────────────────────────────
export const Card = ({ title, right, children, style }) => (
  <div style={{ ...S.card, ...style }}>
    {(title || right) && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}><div style={S.h2}>{title}</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{right}</div></div>}
    {children}
  </div>
);
export const Note = ({ children, tone = 'info' }) => (
  <div style={{ fontSize: '0.75rem', color: tone === 'warn' ? '#7C2D12' : C.ink2, background: tone === 'warn' ? '#FFF7ED' : C.page, border: `1px solid ${tone === 'warn' ? '#FED7AA' : C.line}`, borderRadius: 8, padding: '8px 12px', marginBottom: 12, lineHeight: 1.55 }}>{children}</div>
);
export function Loading({ text = 'Loading…' }) { return <div style={{ padding: 30, textAlign: 'center', color: C.ink2, fontSize: '0.82rem' }}>{text}</div>; }
export function ErrorBox({ error, onGo }) {
  if (!error) return null;
  const noImport = /No financial statements have been imported/.test(error);
  return <div style={{ ...S.card, borderColor: noImport ? C.line : '#FCA5A5', color: noImport ? C.ink2 : C.bad, fontSize: '0.82rem' }}>
    {error}{noImport && onGo && <div style={{ marginTop: 10 }}><button style={S.btn('primary')} onClick={onGo}>Go to Data Validation & Reconciliation → Import</button></div>}
  </div>;
}

export function useLoad(fn, deps) {
  const [state, set] = useState({ loading: true, data: null, error: null });
  const run = useCallback(() => {
    let alive = true;
    set(s => ({ ...s, loading: true, error: null }));
    fn().then(d => alive && set({ loading: false, data: d, error: null })).catch(e => alive && set({ loading: false, data: null, error: errText(e) }));
    return () => { alive = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => run(), [run]);
  return { ...state, reload: run };
}

// ── filters ──────────────────────────────────────────────────────────────────
export function FilterBar({ F, setF, show = {}, periods = [], budgetVersions = [], branches = [] }) {
  const set = (k, v) => setF(f => ({ ...f, [k]: v }));
  const Lbl = ({ t, children }) => <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.66rem', color: C.ink2, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{t}{children}</label>;
  const fys = [...new Set(periods.map(p => p.fy))].sort((a, b) => b - a);
  const flow = periods.filter(p => p.type !== 'BS');
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', background: C.white, border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
      <Lbl t="Company"><select style={S.select} value="devx" onChange={() => {}} title="Financial statements are imported for Dev Accelerator Ltd (standalone and consolidated). Other companies have no financial statements loaded."><option value="devx">Dev Accelerator Ltd</option></select></Lbl>
      <Lbl t="Basis"><select style={S.select} value={F.basis} onChange={e => set('basis', e.target.value)}><option value="SA">Standalone</option><option value="CO">Consolidated</option></select></Lbl>
      {show.period && <>
        <Lbl t="Financial year"><select style={S.select} value={F.fy || ''} onChange={e => set('fy', +e.target.value)}>{fys.map(fy => <option key={fy} value={fy}>FY{fy - 1}-{String(fy).slice(2)}</option>)}</select></Lbl>
        <Lbl t="Period"><select style={S.select} value={F.period || ''} onChange={e => set('period', e.target.value)}>
          <option value="month" disabled>Month — not in the statements</option>
          {flow.filter(p => !F.fy || p.fy === F.fy).map(p => <option key={p.id} value={p.id}>{p.type === 'H' && p.h === 1 ? `${p.short} (YTD Sep)` : p.type === '9M' ? `${p.short} (YTD Dec)` : p.type === 'FY' ? `${p.short} (full year)` : p.short}{p.availability === 'derived' ? ' — derived' : p.availability === 'working' ? ' — working col.' : ''}</option>)}
        </select></Lbl>
      </>}
      {show.comparator && <Lbl t="Compare with"><select style={S.select} value={F.cmp || 'auto'} onChange={e => set('cmp', e.target.value)}>
        <option value="auto">Auto (same period last year)</option>{flow.map(p => <option key={p.id} value={p.id}>{p.short}{p.availability === 'derived' ? ' — derived' : ''}</option>)}
      </select></Lbl>}
      <Lbl t="Financial version"><select style={S.select} value={F.mode} onChange={e => set('mode', e.target.value)} title="As originally reported: the workbook prepared for the period (e.g. FY2025-26 from the audited annual workbook). Latest reported: the most recent workbook that repeats the period (restated / regrouped comparatives)."><option value="original">As originally reported</option><option value="latest">Latest reported / regrouped</option></select></Lbl>
      {show.budget && <Lbl t="Budget version"><select style={S.select} value={F.budget || ''} onChange={e => set('budget', e.target.value)}><option value="">{budgetVersions.length ? 'Newest version' : 'No budget yet'}</option>{budgetVersions.map(v => <option key={v.id} value={v.id}>{v.name}{v.frozen ? ' (frozen)' : ''}</option>)}</select></Lbl>}
      {show.branch && <Lbl t="Branch / project"><select style={S.select} value={F.branch || ''} onChange={e => set('branch', e.target.value)}><option value="">All (company)</option>{branches.map(b => <option key={b}>{b}</option>)}</select></Lbl>}
      <Lbl t="Units"><select style={S.select} value={F.unit} onChange={e => set('unit', e.target.value)}><option value="inr">₹</option><option value="lakh">₹ lakh</option><option value="crore">₹ crore</option></select></Lbl>
      {show.display && <Lbl t="Show as"><select style={S.select} value={F.display} onChange={e => set('display', e.target.value)}><option value="amount">Amount</option><option value="pctrev">% of revenue</option><option value="seat">Per seat per month</option><option value="sqft">Per sq ft per month</option></select></Lbl>}
    </div>
  );
}

// ── where a figure comes from ────────────────────────────────────────────────
export function SourceDrill({ open, onClose, label, period, cell, files = [], unit = 'lakh', du = 'lakh' }) {
  if (!open || !cell) return null;
  const fname = f => files.find(x => x.f === f)?.name || `file ${f}`;
  const Row = ({ k, v }) => <tr><td style={{ ...S.td, color: C.ink2, width: 170 }}>{k}</td><td style={S.td}>{v}</td></tr>;
  const s = cell.src;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
      <div style={{ background: C.white, borderRadius: 12, maxWidth: 820, width: '100%', maxHeight: '86vh', overflow: 'auto', padding: 18 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <div><div style={{ fontWeight: 700, color: C.ink }}>{label}</div><div style={S.small}>{period?.label}</div></div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.ink2 }}><X size={18} /></button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
          <Row k="Figure shown" v={<b>{cell.v == null ? (cell.st === 'blank' ? '— (nil: blank in the source)' : cell.st === 'error' ? `Excel error ${s?.err || ''} — not treated as zero` : 'Not available') : fmtVal(cell.v, unit, du)}{unit === 'lakh' && cell.v != null ? ` ${unitLabel(du)}` : ''}</b>} />
          {s && <><Row k="Source file" v={fname(s.f)} /><Row k="Sheet / cell" v={`${s.sh} ! ${s.c}${s.hid ? ' (hidden sheet)' : ''}`} />
            <Row k="Formula in the workbook" v={s.fx ? <code style={{ fontSize: '0.75rem' }}>={s.fx}</code> : 'typed value (no formula)'} />
            <Row k="Column role" v={`${s.role === 'primary' ? 'Primary — the workbook prepared for this period' : s.role === 'comparative' ? 'Comparative column in a later / other workbook' : 'Working column outside the published statement'}${s.aud ? ` · ${s.aud}` : ''}`} />
            <Row k="Source row label" v={s.lbl} />
            {s.plug ? <Row k="Manual adjustment in formula" v={`${s.plug > 0 ? '+' : ''}${s.plug} (rounding plug typed in the workbook)`} /> : null}
            {s.der ? <Row k="Derived in the workbook" v={`The workbook calculates this column as ${s.der.plus} − ${s.der.minus}.`} /> : null}
            {s.r2 ? <Row k="Precision" v="Typed rounded to 2 decimals in the source" /> : null}</>}
          {cell.derived && <Row k="Derived by the module" v={<div>{cell.derived.formula} = {cell.derived.inputs.map(i => `${i.sign < 0 ? '− ' : '+ '}${fmtVal(i.v, unit, du)} (${i.p}${i.sh ? `, ${fname(i.f)} › ${i.sh}!${i.c}` : ''})`).join(' ')}{cell.derived.mixedFiles ? <div style={{ color: C.warn }}>Inputs come from different workbooks.</div> : null}<div style={S.small}>Shown only because the period is not reported directly.</div></div>} />}
          {cell.decided && <Row k="Decision" v="A recorded decision chose this source over the competing figures (Data Validation → decision requests)." />}
          {cell.adj && <Row k="Adjustments included" v={cell.adj.map(a => `${fmtVal(a.amount, 'lakh', du)} — ${a.reason} (${a.by}, ${a.at.slice(0, 10)})`).join('; ')} />}
          {cell.crossDerived && <Row k="Cross-check" v={`Derived ${cell.crossDerived.formula} = ${fmtVal(cell.crossDerived.v, unit, du)}`} />}
        </tbody></table>
        {cell.alts?.length > 0 && <>
          <div style={{ ...S.h2, marginTop: 14 }}>Other source figures for the same line and period</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={S.th}>Value</th><th style={S.th}>Difference</th><th style={S.th}>Where</th><th style={S.th}>Role</th></tr></thead><tbody>
            {cell.alts.map((a, i) => <tr key={i}><td style={{ ...S.td, ...S.num }}>{a.st === 'error' ? a.err : fmtVal(a.v, unit, du)}</td><td style={{ ...S.td, ...S.num }}>{a.v != null && cell.v != null ? fmtVal(a.v - cell.v, unit === 'lakh' ? 'lakh' : unit, du) : ''}</td><td style={S.td}>{fname(a.f)} › {a.sh}!{a.c}{a.r2 ? ' (rounded)' : ''}</td><td style={S.td}>{a.role}</td></tr>)}
          </tbody></table>
          <div style={{ ...S.small, marginTop: 6 }}>Differences are reconciled on the Data Validation & Reconciliation tab.</div>
        </>}
      </div>
    </div>
  );
}

// ── exports ──────────────────────────────────────────────────────────────────
/** PDF from rows already on screen: context header (company, basis, periods, units, version, filters, generated) */
export function exportPdf({ title, meta = [], columns, rows, landscape = true }) {
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  doc.setFontSize(13); doc.text(title, 40, 40);
  doc.setFontSize(8);
  meta.forEach(([k, v], i) => doc.text(`${k}: ${v}`.slice(0, 190), 40, 58 + i * 11));
  autoTable(doc, { startY: 64 + meta.length * 11, head: [columns.map(c => c.label)], body: rows.map(r => columns.map(c => { const v = typeof c.get === 'function' ? c.get(r) : r[c.key]; return v == null ? '' : String(v); })),
    styles: { fontSize: 7, cellPadding: 2.5 }, headStyles: { fillColor: [28, 73, 66] }, columnStyles: Object.fromEntries(columns.map((c, i) => [i, { halign: c.align || 'left' }])) });
  doc.save(`${title.replace(/[^\w]+/g, '_').slice(0, 80)}.pdf`);
}
export function pdfMeta(F, extra = {}) {
  return [['Company', 'Dev Accelerator Ltd'], ['Reporting basis', F.basis === 'CO' ? 'Consolidated' : 'Standalone'], ['Periods', extra.periods || ''], ['Units', `${unitLabel(F.unit)} (EPS in ₹; ratios, days and % unscaled)`],
    ['Financial version', F.mode === 'latest' ? 'Latest reported / regrouped' : 'As originally reported'], ['Source version', extra.version || ''], ['Filters', extra.filters || '—'], ['Generated', new Date().toLocaleString('en-IN')]];
}
export function ExportButtons({ xlsx, pdf }) {
  const [busy, setBusy] = useState(false);
  return <>
    {xlsx && <button style={S.btn('outline')} disabled={busy} onClick={async () => { setBusy(true); try { await fsApi.download(xlsx.path, xlsx.params, xlsx.filename); } catch (e) { alert(errText(e)); } setBusy(false); }}><FileSpreadsheet size={14} />Excel</button>}
    {pdf && <button style={S.btn('outline')} onClick={pdf}><FileText size={14} />PDF</button>}
  </>;
}

/** A small "what is missing" box listing input types and their record counts */
export function MissingInputs({ report, coverage }) {
  const list = coverage?.reports?.[report];
  if (!list) return null;
  const missing = list.filter(x => !x.records);
  if (!missing.length) return null;
  const here = missing.filter(m => !m.where), there = missing.filter(m => m.where);
  return <Note tone="warn"><b>Waiting for inputs:</b> {here.length > 0 && <>{here.map(m => m.label).join(' · ')} (Management Inputs tab, form or Excel template){there.length ? '; ' : '. '}</>}{there.length > 0 && <>{there.map(m => `${m.label} (Data Validation & Reconciliation → ${m.where})`).join(' · ')}. </>}Until then the parts of this page that need them say "Missing input" — nothing is estimated.</Note>;
}
