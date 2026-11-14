import React, { useEffect, useState } from 'react';
import { fsApi } from './api';
import { C, S, Card, Note, Loading, ErrorBox, SourceDrill, fmtVal, unitLabel, useLoad } from './ui';

// Notes are tied to the statement line they support (by meaning), so a note keeps working when its number differs between
// workbooks; the source note number is shown for every period.
export default function NotesTab({ F, periodsInfo, onGoImport }) {
  const bsDefaults = periodsInfo?.BS?.defaults || [];
  const flowDefaults = periodsInfo?.CF?.defaults || periodsInfo?.PL?.defaults || [];
  const [cols, setCols] = useState([]);
  const [open, setOpen] = useState({});
  const [drill, setDrill] = useState(null);
  const [filter, setFilter] = useState('');
  useEffect(() => { setCols([...bsDefaults, ...flowDefaults.filter(p => !bsDefaults.includes(p))]); }, [F.basis, periodsInfo]); // eslint-disable-line react-hooks/exhaustive-deps
  const { loading, data, error } = useLoad(() => (cols.length ? fsApi.notes({ basis: F.basis, periods: cols.join(','), mode: F.mode }) : Promise.resolve(null)), [F.basis, cols.join(','), F.mode]);
  const available = [...(periodsInfo?.BS?.available || []), ...(periodsInfo?.PL?.available || []).filter(p => p.availability === 'reported')];
  const files = data?.files || [];
  const groups = (data?.groups || []).filter(g => !filter || (g.title + g.lineLabel).toLowerCase().includes(filter.toLowerCase()));
  return (
    <div>
      {error && <ErrorBox error={error} onGo={onGoImport} />}
      <Card title={`Notes to Accounts — ${F.basis === 'CO' ? 'Consolidated' : 'Standalone'}`} right={<>
        <input style={{ ...S.input, width: 200 }} placeholder="Find a note…" value={filter} onChange={e => setFilter(e.target.value)} />
        <button style={S.btn('outline')} onClick={() => setOpen(Object.fromEntries((data?.groups || []).map((g, i) => [i, true])))}>Expand all</button>
        <button style={S.btn('outline')} onClick={() => setOpen({})}>Collapse all</button>
      </>}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <span style={S.small}>Columns:</span>
          {cols.map(id => <span key={id} style={{ background: C.tint, borderRadius: 12, padding: '2px 4px 2px 10px', fontSize: '0.72rem', color: C.green }}>{available.find(p => p.id === id)?.short || id}<button onClick={() => setCols(cols.filter(x => x !== id))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.ink2 }}>×</button></span>)}
          <select style={S.select} value="" onChange={e => e.target.value && setCols([...cols, e.target.value])}><option value="">+ add period…</option>{available.filter(p => !cols.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </div>
        <Note>Each note is shown against the statement line it supports. For every period the note is taken from the workbook chosen for that period (as for the statements); its own note number in that workbook is shown, because numbering differs between workbooks. The last row compares the note with the statement line.</Note>
        {loading ? <Loading /> : groups.map((g, gi) => {
          const isOpen = open[gi] ?? gi < 3;
          const periods = data.periods.filter(p => g.rows.some(r => r.cells[p.id]) || g.statement[p.id] != null);
          return (
            <div key={gi} style={{ border: `1px solid ${C.line}`, borderRadius: 8, marginBottom: 10 }}>
              <div onClick={() => setOpen(o => ({ ...o, [gi]: !isOpen }))} style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 10, background: C.page, borderRadius: 8 }}>
                <div><b style={{ fontSize: '0.84rem' }}>{g.title}</b> <span style={S.small}>→ {g.lineLabel}</span></div>
                <div style={S.small}>{Object.entries(g.sourceNotes).map(([p, n]) => `${available.find(x => x.id === p)?.short || p}: note ${n.num}`).join(' · ')} {isOpen ? '▾' : '▸'}</div>
              </div>
              {isOpen && <div style={{ overflowX: 'auto', padding: '0 4px 6px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={{ ...S.th, minWidth: 300 }}>Particulars</th>{periods.map(p => <th key={p.id} style={{ ...S.th, ...S.num }}><div style={{ fontSize: '0.62rem', fontWeight: 500 }}>{p.colType}</div>{p.headerDate}<div style={{ fontSize: '0.62rem', fontWeight: 500 }}>{unitLabel(F.unit)}</div></th>)}</tr></thead>
                  <tbody>
                    {g.rows.map((r, ri) => r.subhead ? <tr key={ri}><td colSpan={1 + periods.length} style={{ ...S.td, fontStyle: 'italic', color: C.ink2 }}>{r.label}</td></tr> : (
                      <tr key={ri} style={{ background: r.total ? C.page : 'transparent' }}>
                        <td style={{ ...S.td, fontWeight: r.total ? 700 : 400 }}>{r.label}</td>
                        {periods.map(p => { const c = r.cells[p.id]; return <td key={p.id} onClick={() => c && setDrill({ label: `${g.title} — ${r.label}`, p, c: { v: c.v, st: c.st, src: { f: c.src.f, sh: c.src.sh, c: c.src.c, fx: c.src.fx, role: `note ${c.src.note}`, lbl: r.label, err: c.err } } })}
                          style={{ ...S.td, ...S.num, fontWeight: r.total ? 700 : 400, cursor: c ? 'pointer' : 'default', color: c?.st === 'error' ? C.bad : C.ink }}>{c ? (c.st === 'error' ? c.err : c.st === 'blank' ? '—' : fmtVal(c.v, 'lakh', F.unit)) : ''}</td>; })}
                      </tr>))}
                    <tr><td style={{ ...S.td, color: C.green, fontWeight: 600 }}>Statement line: {g.lineLabel}</td>{periods.map(p => <td key={p.id} style={{ ...S.td, ...S.num, color: C.green, fontWeight: 600 }}>{fmtVal(g.statement[p.id], 'lakh', F.unit)}</td>)}</tr>
                  </tbody>
                </table>
                {g.text?.length > 0 && <div style={{ ...S.small, marginTop: 6 }}>{g.text.join(' ')}</div>}
              </div>}
            </div>
          );
        })}
      </Card>
      {data?.other?.length > 0 && <Card title={`Other notes and disclosures (from ${files.find(f => f.f === data.other[0].f)?.name || 'the latest workbook'})`}>
        {data.other.map((n, i) => <details key={i} style={{ marginBottom: 6 }}><summary style={{ cursor: 'pointer', fontSize: '0.8rem' }}>Note {n.num}: {n.title} <span style={S.small}>({n.sheet})</span></summary>
          {n.text && <div style={{ ...S.small, margin: '6px 0' }}>{n.text.join(' ')}</div>}
          <table style={{ borderCollapse: 'collapse', margin: '6px 0' }}><tbody>{n.items.map((it, j) => <tr key={j}><td style={{ ...S.td, fontStyle: it.subhead ? 'italic' : 'normal', fontWeight: it.total ? 700 : 400 }}>{it.label}</td>{n.periods.map(p => <td key={p} style={{ ...S.td, ...S.num }}>{it.v[p] ? (it.v[p].st === 'error' ? it.v[p].err : fmtVal(it.v[p].v, 'lakh', F.unit)) : ''}</td>)}</tr>)}</tbody></table>
        </details>)}
      </Card>}
      {data?.narrative?.length > 0 && <Card title={`Notes to the published results (as in ${data.narrativeFile})`}>
        <Note>Narrative notes are reproduced as they appear in the workbook. Some carry text from earlier years (e.g. old meeting dates) — they are not corrected here.</Note>
        <ol style={{ margin: 0, paddingLeft: 18 }}>{data.narrative.map((n, i) => <li key={i} style={{ fontSize: '0.8rem', marginBottom: 8, lineHeight: 1.55 }}>{n.text}
          {n.table?.length > 0 && <table style={{ borderCollapse: 'collapse', margin: '6px 0' }}><tbody>{n.table.map((t, j) => <tr key={j}><td style={S.td}>{t.label}</td>{t.values.map((v, k) => <td key={k} style={{ ...S.td, ...S.num }}>{fmtVal(v.v, 'lakh', 'lakh')}</td>)}</tr>)}</tbody></table>}
        </li>)}</ol>
      </Card>}
      <SourceDrill open={!!drill} onClose={() => setDrill(null)} label={drill?.label} period={drill?.p} cell={drill?.c} files={files} unit="lakh" du={F.unit} />
    </div>
  );
}
