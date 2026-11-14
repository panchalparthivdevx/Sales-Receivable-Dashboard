import React, { useEffect, useMemo, useState } from 'react';
import { fsApi } from './api';
import { C, S, Card, Note, Loading, ErrorBox, SourceDrill, fmtVal, unitLabel, ExportButtons, exportPdf, pdfMeta, useLoad } from './ui';

const TITLES = { BS: 'Balance Sheet', PL: 'Statement of Profit and Loss', CF: 'Cash Flow Statement', RT: 'Ratios disclosed in the results' };
const BS_HEAD = { nca: ['I. ASSETS', '1. Non-current assets'], ca: [null, '2. Current assets'], eq: ['II. EQUITY AND LIABILITIES', '1. Equity'], ncl: [null, '2. Non-current liabilities'], cl: [null, '3. Current liabilities'] };
const PL_HEAD = { 'pl.exp_ops': 'Expenses', 'pl.tax_cur': 'Tax expense', 'pl.oci_nr': 'Other comprehensive income (net of tax)', 'pl.pat_owners': 'Profit for the period attributable to:', 'pl.oci_owners': 'Other comprehensive income attributable to:', 'pl.tci_owners': 'Total comprehensive income attributable to:', 'pl.eps_basic': 'Earnings per share (face value ₹2; interim periods not annualised)' };
const CF_HEAD = { A: 'A. Cash flow from operating activities', B: 'B. Cash flow from investing activities', C: 'C. Cash flow from financing activities' };
const lsKey = (stmt, b) => `fsr_cols_${stmt}_${b}`;

export default function StatementTab({ stmt, F, periodsInfo, onGoImport }) {
  const info = periodsInfo?.[stmt];
  const [cols, setCols] = useState(null);
  const [drill, setDrill] = useState(null);
  useEffect(() => {
    if (!info) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(lsKey(stmt, F.basis)) || 'null'); } catch (_) { saved = null; }
    const avail = new Set(info.available.map(p => p.id));
    setCols((saved || []).filter(p => avail.has(p)).length ? saved.filter(p => avail.has(p)) : info.defaults);
  }, [info, stmt, F.basis]);
  const saveCols = c => { setCols(c); try { localStorage.setItem(lsKey(stmt, F.basis), JSON.stringify(c)); } catch (_) { /* per-viewer convenience only */ } };

  const { loading, data, error } = useLoad(() => (cols ? fsApi.statement({ basis: F.basis, stmt, periods: cols.join(','), mode: F.mode, adj: F.withAdj ? '1' : '' }) : Promise.resolve(null)), [F.basis, stmt, cols && cols.join(','), F.mode, F.withAdj]);
  const needDen = stmt === 'PL' && (F.display === 'seat' || F.display === 'sqft');
  const den = useLoad(() => (needDen && cols ? fsApi.ratios({ basis: F.basis, periods: cols.filter(p => !p.startsWith('BS-')).join(','), mode: F.mode }) : Promise.resolve(null)), [needDen, F.basis, cols && cols.join(','), F.mode]);

  const rows = useMemo(() => data?.rows || [], [data]);
  const revRow = rows.find(r => r.id === 'pl.rev');
  const transform = (r, p, v) => {
    if (v == null || stmt !== 'PL' || r.unit !== 'lakh' || F.display === 'amount' || !F.display) return { v, unit: r.unit };
    if (F.display === 'pctrev') { const rv = revRow?.cells[p]?.v; return { v: rv ? v / rv : null, unit: 'fraction' }; }
    const d = den.data?.results?.find(x => x.period.id === p)?.denominators;
    const base = F.display === 'seat' ? d?.seats : d?.area;
    return { v: base && d?.months ? (v * 1e5) / base / d.months : null, unit: 'inr', missing: !base };
  };
  const anyMissingDen = needDen && rows.length && cols?.some(p => { const d = den.data?.results?.find(x => x.period.id === p)?.denominators; return !(F.display === 'seat' ? d?.seats : d?.area); });

  const periods = data?.periods || [];
  const audOf = p => rows.map(r => r.cells[p.id]?.src?.aud).find(Boolean);
  const conflict = c => c?.alts?.some(a => a.st === 'ok' && c.v != null && Math.abs(a.v - c.v) > 0.015);

  const table = useMemo(() => {
    const out = [];
    let lastSec = null;
    for (const r of rows) {
      if (stmt === 'BS' && r.sec && r.sec !== lastSec && BS_HEAD[r.sec]) { const [h1, h2] = BS_HEAD[r.sec]; if (h1) out.push({ head: h1, lvl: 0 }); out.push({ head: h2, lvl: 1 }); lastSec = r.sec; }
      if (stmt === 'PL' && PL_HEAD[r.id]) out.push({ head: PL_HEAD[r.id], lvl: 1 });
      if (stmt === 'CF' && r.sec && r.sec !== lastSec && CF_HEAD[r.sec]) { out.push({ head: CF_HEAD[r.sec], lvl: 0 }); lastSec = r.sec; }
      out.push(r);
    }
    return out;
  }, [rows, stmt]);

  if (!info) return <Loading />;
  const avail = info.available || [];
  const addCol = id => { if (id && !cols.includes(id)) saveCols([...cols, id]); };
  const exportRows = rows.map(r => ({ r }));
  return (
    <div>
      {error && <ErrorBox error={error} onGo={onGoImport} />}
      <Card title={`${TITLES[stmt]} — ${F.basis === 'CO' ? 'Consolidated' : 'Standalone'}`} right={<>
        <ExportButtons xlsx={{ path: '/export', params: { what: 'statement', basis: F.basis, stmt, periods: (cols || []).join(','), mode: F.mode }, filename: `${TITLES[stmt].replace(/ /g, '_')}_${F.basis}.xlsx` }}
          pdf={() => exportPdf({ title: `${TITLES[stmt]} (${F.basis === 'CO' ? 'consolidated' : 'standalone'})`, meta: pdfMeta(F, { periods: periods.map(p => p.label).join('; '), version: data?.versionId }),
            columns: [{ label: 'Particulars', get: x => `${'  '.repeat(x.r.indent || 0)}${x.r.label}` }, ...periods.map(p => ({ label: p.short, align: 'right', get: x => { const c = x.r.cells[p.id]; const t = transform(x.r, p.id, c?.v); return c?.st === 'error' ? c.src?.err : fmtVal(t.v, t.unit, F.unit); } }))], rows: exportRows })} />
      </>}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <span style={S.small}>Columns:</span>
          {(cols || []).map((id, i) => { const p = avail.find(x => x.id === id); return (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: C.tint, borderRadius: 12, padding: '2px 4px 2px 10px', fontSize: '0.72rem', color: C.green }}>
              {p?.short || id}{p?.availability === 'derived' ? ' (derived)' : ''}
              {i > 0 && <button title="Move left" onClick={() => { const c = [...cols]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; saveCols(c); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.green, padding: 0 }}>‹</button>}
              <button title="Remove column" onClick={() => saveCols(cols.filter(x => x !== id))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.ink2, padding: '0 4px' }}>×</button>
            </span>); })}
          <select style={S.select} value="" onChange={e => addCol(e.target.value)}>
            <option value="">+ add period…</option>
            {avail.filter(p => !(cols || []).includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.label}{p.availability === 'derived' ? ' — derived' : p.availability === 'working' ? ' — working column (unpublished)' : ''}</option>)}
          </select>
          <button style={S.btn('outline')} onClick={() => saveCols(info.defaults)}>Published layout</button>
        </div>
        {stmt === 'PL' && F.display === 'pctrev' && <Note>Showing each line as a percentage of revenue from operations of the same period. EPS is shown as reported.</Note>}
        {anyMissingDen && <Note tone="warn">Per-seat / per-sq-ft figures need branch capacity seats and operational area with effective dates (Management Inputs → Branch seats, occupancy & area). Periods without them show “Missing input”.</Note>}
        {stmt === 'RT' && <Note>These are the ratios exactly as disclosed in the SEBI results, with the definition printed under each one. The module's own recalculated ratios (with stated definitions and statuses) are on the Ratio Analytics tab — they are never mixed.</Note>}
        {loading || !cols ? <Loading /> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...S.th, minWidth: 340 }}>Particulars</th>
                {periods.map(p => <th key={p.id} style={{ ...S.th, ...S.num, minWidth: 130 }}>
                  <div style={{ fontSize: '0.62rem', color: C.ink2, fontWeight: 500, textTransform: 'uppercase' }}>{p.colType}</div>
                  <div>{p.headerDate}</div>
                  <div style={{ fontSize: '0.62rem', color: C.ink3, fontWeight: 500 }}>{audOf(p) ? `(${audOf(p)})` : avail.find(x => x.id === p.id)?.availability === 'derived' ? '(derived)' : ''}</div>
                  <div style={{ fontSize: '0.62rem', color: C.ink2, fontWeight: 500 }}>{stmt === 'RT' ? 'as disclosed' : F.display === 'pctrev' && stmt === 'PL' ? '% of revenue' : needDen ? '₹ per month' : unitLabel(F.unit)}</div>
                </th>)}
              </tr></thead>
              <tbody>
                {table.map((r, i) => r.head ? (
                  <tr key={`h${i}`}><td colSpan={1 + periods.length} style={{ ...S.td, fontWeight: 700, color: r.lvl === 0 ? C.green : C.ink2, background: r.lvl === 0 ? C.tint : C.white, fontStyle: r.lvl ? 'italic' : 'normal', fontSize: r.lvl === 0 ? '0.76rem' : '0.78rem', textTransform: r.lvl === 0 ? 'uppercase' : 'none' }}>{r.head}</td></tr>
                ) : (
                  <tr key={r.id} style={{ background: r.grand ? C.tint : r.bold ? C.page : 'transparent' }}>
                    <td style={{ ...S.td, fontWeight: r.bold ? 700 : 400, paddingLeft: 10 + (r.indent || 0) * 16, color: r.extra ? C.ink2 : C.ink }}>
                      {r.label}{r.unit === 'inr' && stmt !== 'RT' ? ' (₹)' : ''}
                      {stmt === 'RT' && data?.ratioDefs?.[r.id] && <div style={{ ...S.small, fontStyle: 'italic' }}>{data.ratioDefs[r.id]}</div>}
                    </td>
                    {periods.map(p => {
                      const c = r.cells[p.id];
                      const t = transform(r, p.id, c?.v);
                      const txt = c?.st === 'error' ? (c.src?.err || 'error') : c?.st === 'missing' ? '' : c?.st === 'blank' ? '—' : t.missing ? 'Missing input' : fmtVal(t.v, t.unit, F.unit);
                      return <td key={p.id} onClick={() => c && c.st !== 'missing' && setDrill({ r, p, c })} title={c?.derived ? `Derived: ${c.derived.formula}` : conflict(c) ? 'Other source figures differ — click for details' : 'Click to see the source'}
                        style={{ ...S.td, ...S.num, fontWeight: r.bold ? 700 : 400, cursor: c && c.st !== 'missing' ? 'pointer' : 'default', color: c?.st === 'error' ? C.bad : c?.derived ? C.info : C.ink, fontStyle: c?.derived ? 'italic' : 'normal' }}>
                        {txt}{conflict(c) && <span style={{ color: C.warn, marginLeft: 2, fontSize: '0.65rem', verticalAlign: 'top', lineHeight: 1 }} title="Another source shows a different figure">≠</span>}{c?.decided && <span style={{ color: C.good, marginLeft: 2, fontSize: '0.65rem', verticalAlign: 'top', lineHeight: 1 }}>✓</span>}{c?.st === 'adjusted' && <span style={{ color: C.info, marginLeft: 2, fontSize: '0.6rem', verticalAlign: 'top', lineHeight: 1 }}>adj</span>}
                      </td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ ...S.small, marginTop: 8, lineHeight: 1.6 }}>
              Click any figure for its file, sheet, cell, formula and any competing source figures. <span style={{ color: C.info, fontStyle: 'italic' }}>Blue italic</span> = derived by the module because the period is not reported directly (formula shown on hover). <span style={{ color: C.warn }}>≠</span> = another workbook shows a different figure (see Data Validation). “—” = nil (blank in the source). Excel errors are shown as errors, never as zero.
              {stmt === 'BS' && ' Balance sheets are never derived: only dates for which a balance sheet exists can be chosen.'}
            </div>
          </div>
        )}
      </Card>
      <SourceDrill open={!!drill} onClose={() => setDrill(null)} label={drill?.r.label} period={drill?.p} cell={drill?.c} files={data?.files} unit={drill?.r.unit} du={F.unit} />
    </div>
  );
}
