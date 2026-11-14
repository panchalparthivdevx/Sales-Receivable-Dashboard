import React, { useMemo, useState } from 'react';
import { FolderOpen, Upload, CheckCircle2, RotateCcw, Trash2 } from 'lucide-react';
import { fsApi, errText } from './api';
import { C, S, Card, Note, Badge, Loading, fmtVal, useLoad, ExportButtons, exportPdf, pdfMeta } from './ui';

const STATUSES = ['Material difference', 'Unreconciled', 'Difference', 'Rounding', 'Agrees', 'Info'];
const pLabel = p => (p ? p.replace(/^FY(\d{4})-(.*)$/, (m, y, k) => `${k === 'FY' ? '' : `${k} `}FY${y.slice(2)}`).replace(/^BS-/, 'As at ') : '');

export default function ValidationTab({ F, status, reloadStatus }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const rec = useLoad(() => (status?.active ? fsApi.recon(F.mode) : Promise.resolve(null)), [status?.active?.id, F.mode]);
  const adj = useLoad(() => fsApi.adjustments(), [status?.active?.id]);
  const audit = useLoad(() => fsApi.audit(), [status?.active?.id]);
  const [flt, setFlt] = useState({ basis: '', check: '', status: '', stmt: '', q: '', hideAgrees: true });
  const [limit, setLimit] = useState(200);
  const [choice, setChoice] = useState({});
  const [adjForm, setAdjForm] = useState({ basis: 'SA', line: 'pl.rev', period: '', amount: '', reason: '', evidence: '' });
  const rights = status?.rights || {};
  const flash = t => { setMsg(t); setTimeout(() => setMsg(''), 9000); };
  const act = async (label, fn) => { setBusy(label); try { const r = await fn(); flash(typeof r === 'string' ? r : 'Done.'); await reloadStatus(); rec.reload(); adj.reload(); audit.reload(); } catch (e) { flash(errText(e)); } setBusy(''); };

  const rows = useMemo(() => rec.data?.rows || [], [rec.data]);
  const checks = useMemo(() => [...new Set(rows.map(r => r.check))], [rows]);
  const filtered = rows.filter(r => (!flt.basis || r.b === flt.basis) && (!flt.check || r.check === flt.check) && (!flt.status || r.status === flt.status) && (!flt.stmt || r.stmt === flt.stmt)
    && (!flt.hideAgrees || flt.status || r.status !== 'Agrees') && (!flt.q || `${r.particulars} ${r.ref} ${r.expl} ${r.p}`.toLowerCase().includes(flt.q.toLowerCase())));
  const files = rec.data?.files || [];
  const fmtN = (r, v) => (v == null ? '' : r.unit === 'nos' ? fmtVal(v, 'nos') : r.unit === 'inr' ? v.toFixed(4) : r.unit === 'times' ? v.toFixed(4) : fmtVal(v, 'lakh', 'lakh'));
  const cols = [{ label: 'Reporting basis', get: r => (r.b === 'CO' ? 'Consolidated' : 'Standalone') }, { label: 'Period', get: r => pLabel(r.p) }, { label: 'Statement', key: 'stmt' }, { label: 'Particulars', key: 'particulars' }, { label: 'Source figure', align: 'right', get: r => fmtN(r, r.source) }, { label: 'Module figure', align: 'right', get: r => fmtN(r, r.module) }, { label: 'Difference', align: 'right', get: r => fmtN(r, r.diff) }, { label: 'Source reference', key: 'ref' }, { label: 'Status', key: 'status' }, { label: 'Explanation', key: 'expl' }];
  const flowPeriods = [...new Set(rows.filter(r => /^FY|^BS/.test(r.p)).map(r => r.p))].sort().reverse();

  return (
    <div>
      {msg && <div style={{ ...S.card, background: C.tint, color: C.green, fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>{msg}</div>}
      <Card title="Import workbooks" right={rights.import && <>
        {status?.folderImport && <button style={S.btn('outline')} disabled={!!busy} onClick={() => act('folder', async () => { const r = await fsApi.importFolder(); return `Staged ${r.staged.length} workbook(s) from ${r.folder}.${r.errors.length ? `\nNot staged: ${r.errors.join('; ')}` : ''}`; })}><FolderOpen size={14} />{busy === 'folder' ? 'Reading…' : 'Import from folder'}</button>}
        <label style={{ ...S.btn('outline'), cursor: 'pointer' }}><Upload size={14} />{busy === 'upload' ? 'Reading…' : 'Upload workbook(s)'}<input type="file" accept=".xlsx" multiple style={{ display: 'none' }} onChange={e => { const fl = [...e.target.files]; e.target.value = ''; act('upload', async () => { const done = []; for (const f of fl) { const r = await fsApi.importUpload(f); done.push(r.staged.name); } return `Staged: ${done.join(', ')}`; }); }} /></label>
        <button style={S.btn('primary')} disabled={!!busy || !status?.staging?.length} onClick={() => act('commit', async () => { const r = await fsApi.commit(); return r.unchanged ? r.message : r.reactivated ? `These files match an earlier import (${r.id}); it was made active again.` : `Imported version ${r.id}: ${r.counts.facts} figures, ${r.counts.noteValues} note values. Reconciliation: ${Object.entries(r.recon).map(([k, v]) => `${k} ${v}`).join(', ')}. ${r.decisions} decision request(s).`; })}><CheckCircle2 size={14} />{busy === 'commit' ? 'Importing…' : 'Commit import'}</button>
      </>}>
        {!rights.import && <Note>Importing needs the "Import workbooks" right (User Settings → Financial Statements).</Note>}
        <div style={{ ...S.small, marginBottom: 8 }}>Workbooks are read by their statement titles, column headings, dates and audit labels — not by file or sheet names. Every figure keeps its file, sheet, cell and formula. Importing the same files again creates no duplicate; every import is a version you can roll back to.{status?.folder ? ` Folder: ${status.folder}` : ' Online: upload the workbooks one at a time.'}</div>
        {status?.staging?.length > 0 && <>
          <div style={{ ...S.h2, fontSize: '0.82rem' }}>Workbook set for the next import ({status.staging.length} files)</div><div style={{ ...S.small, marginBottom: 6 }}>Uploading a corrected workbook replaces the file of the same name, basis and period here. “Commit import” turns this set into a new version; if the set is unchanged nothing new is stored.</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}><thead><tr>{['Workbook', 'Basis', 'Prepared for', 'Statements found', 'Notes', 'Findings', ''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>{status.staging.map(s => <tr key={s.sha256}><td style={S.td}>{s.name}{status.active?.files?.some(f => f.sha256 === s.sha256) ? <div style={{ fontSize: '0.66rem', color: C.good }}>in the active version</div> : <div style={{ fontSize: '0.66rem', color: C.warn }}>new — not yet committed</div>}</td><td style={S.td}>{s.basis === 'CO' ? 'Consolidated' : 'Standalone'}</td><td style={S.td}>{s.reportingDate}</td>
              <td style={{ ...S.td, fontSize: '0.7rem' }}>{s.statements.map(st => <div key={st.sheet}>{st.type} “{st.sheet}”{st.hidden ? ' (hidden)' : ''}: {st.periods.join(', ')}</div>)}</td><td style={S.td}>{s.notes}</td>
              <td style={S.td}>{Object.entries(s.issues).map(([k, v]) => `${v} ${k}`).join(', ')}</td><td style={S.td}>{rights.import && <button style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.bad }} title="Remove from staging" onClick={() => act('unstage', () => fsApi.unstage(s.sha256).then(() => 'Removed from staging.'))}><Trash2 size={14} /></button>}</td></tr>)}</tbody></table>
        </>}
        <div style={{ ...S.h2, fontSize: '0.82rem' }}>Import versions</div>
        {!status?.versions?.length ? <Note tone="warn">Nothing imported yet. {status?.folderImport ? 'Use "Import from folder" (reads the six workbooks in Financials & Presentations\\Financials), then "Commit import".' : 'Upload the workbooks, then "Commit import".'}</Note> :
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Version', 'Imported', 'By', 'Files', 'Figures', 'Reconciliation', 'Status', ''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>{status.versions.map(v => <tr key={v.id}><td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.72rem' }}>{v.id}</td><td style={S.td}>{new Date(v.builtAt).toLocaleString('en-IN')}</td><td style={S.td}>{v.builtBy}</td><td style={{ ...S.td, fontSize: '0.7rem' }}>{v.files.map(f => f.name).join('; ')}</td><td style={{ ...S.td, ...S.num }}>{v.counts?.facts}</td>
              <td style={{ ...S.td, fontSize: '0.7rem' }}>{v.recon ? Object.entries(v.recon).map(([k, n]) => `${k} ${n}`).join(', ') : ''}{v.decisions ? `; ${v.decisions} decision(s)` : ''}</td><td style={S.td}><Badge status={v.status === 'active' ? 'OK' : 'Info'} title={v.status} /> {v.status}</td>
              <td style={S.td}>{rights.import && v.status !== 'active' && <button style={S.btn('outline')} onClick={() => { const reason = window.prompt('Reason for rolling back to this version?'); if (reason) act('rollback', () => fsApi.rollback(v.id, reason).then(() => `Version ${v.id} is active again.`)); }}><RotateCcw size={13} />Roll back to this</button>}</td></tr>)}</tbody></table>}
      </Card>

      {status?.active && <>
        {rec.loading ? <Loading text="Running reconciliation…" /> : rec.error ? <div style={{ ...S.card, color: C.bad }}>{rec.error}</div> : rec.data && <>
          <Card title={`Decision requests — material differences between sources (${rec.data.decisions.length})`}>
            {!rec.data.decisions.length ? <div style={S.small}>No conflict between source workbooks exceeds materiality ({rec.data.thresholds.materiality} ₹ lakh). Smaller differences are listed below as "Difference" and kept as separate source versions.</div> :
              rec.data.decisions.map(dcs => { const rk = `${dcs.key}|${F.mode}`; const recd = rec.data.recorded?.[rk]; return (
                <div key={dcs.key} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.82rem' }}>{dcs.label} — {pLabel(dcs.p)} ({dcs.b === 'CO' ? 'consolidated' : 'standalone'})</div>
                  <div style={S.small}>Shown now: {fmtVal(dcs.shown.v, dcs.unit === 'inr' ? 'inr' : 'lakh')} ({dcs.shown.decided ? 'by your decision' : 'by source priority'}). Choose the figure the statements should show for the "{F.mode === 'latest' ? 'Latest reported' : 'As originally reported'}" version:</div>
                  {dcs.options.map(o => <label key={o.factKey} style={{ display: 'block', fontSize: '0.78rem', margin: '4px 0' }}><input type="radio" name={dcs.key} disabled={!rights.adjust} checked={(choice[dcs.key]?.factKey ?? recd?.factKey ?? dcs.shown.factKey) === o.factKey} onChange={() => setChoice(c => ({ ...c, [dcs.key]: { ...(c[dcs.key] || {}), factKey: o.factKey } }))} /> <b>{fmtVal(o.v, dcs.unit === 'inr' ? 'inr' : 'lakh')}</b> — {o.ref} <span style={S.small}>({o.role}, prepared for {o.reportingDate})</span></label>)}
                  {rights.adjust && <div style={{ display: 'flex', gap: 6, marginTop: 6 }}><input style={{ ...S.input, flex: 1 }} placeholder="Reason / evidence for the choice (required)" value={choice[dcs.key]?.reason || ''} onChange={e => setChoice(c => ({ ...c, [dcs.key]: { ...(c[dcs.key] || {}), reason: e.target.value } }))} />
                    <button style={S.btn('primary')} onClick={() => act('decide', () => fsApi.decide({ key: dcs.key, mode: F.mode, factKey: choice[dcs.key]?.factKey || dcs.shown.factKey, reason: choice[dcs.key]?.reason }).then(() => 'Decision recorded.'))}>Record decision</button>
                    {recd && <button style={S.btn('outline')} onClick={() => act('undecide', () => fsApi.undecide(rk).then(() => 'Decision removed.'))}>Remove decision</button>}</div>}
                  {recd && <div style={{ ...S.small, marginTop: 4 }}>Decided by {recd.by} on {recd.at.slice(0, 10)}: {recd.reason}</div>}
                </div>); })}
          </Card>

          <Card title={`Reconciliation (${filtered.length} of ${rows.length} checks)`} right={<ExportButtons xlsx={{ path: '/export', params: { what: 'recon', mode: F.mode, filters: JSON.stringify(flt) }, filename: 'Data_validation_and_reconciliation.xlsx' }}
            pdf={() => exportPdf({ title: 'Data validation and reconciliation', meta: pdfMeta(F, { periods: 'all imported', version: status.active.id, filters: Object.entries(flt).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ') }), columns: cols, rows: filtered.slice(0, 1500) })} />}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>{Object.entries(rec.data.summary).map(([k, n]) => <span key={k} onClick={() => setFlt(f => ({ ...f, status: f.status === k ? '' : k }))} style={{ cursor: 'pointer', opacity: !flt.status || flt.status === k ? 1 : 0.4 }}><Badge status={k} /> <b style={{ fontSize: '0.82rem' }}>{n}</b></span>)}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <select style={S.select} value={flt.basis} onChange={e => setFlt(f => ({ ...f, basis: e.target.value }))}><option value="">Both bases</option><option value="SA">Standalone</option><option value="CO">Consolidated</option></select>
              <select style={S.select} value={flt.check} onChange={e => setFlt(f => ({ ...f, check: e.target.value }))}><option value="">All checks</option>{checks.map(c => <option key={c}>{c}</option>)}</select>
              <select style={S.select} value={flt.status} onChange={e => setFlt(f => ({ ...f, status: e.target.value }))}><option value="">All statuses</option>{STATUSES.map(c => <option key={c}>{c}</option>)}</select>
              <select style={S.select} value={flt.stmt} onChange={e => setFlt(f => ({ ...f, stmt: e.target.value }))}><option value="">All statements</option>{['PL', 'BS', 'CF', 'RT'].map(c => <option key={c}>{c}</option>)}</select>
              <input style={{ ...S.input, width: 220 }} placeholder="Search particulars, cells, periods…" value={flt.q} onChange={e => setFlt(f => ({ ...f, q: e.target.value }))} />
              <label style={{ ...S.small, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={flt.hideAgrees} onChange={e => setFlt(f => ({ ...f, hideAgrees: e.target.checked }))} />Hide checks that agree</label>
            </div>
            <Note>Tolerances: amounts ±{rec.data.thresholds.tolerance} ₹ lakh (+0.005 where one side was typed rounded to 2 decimals), materiality {rec.data.thresholds.materiality} ₹ lakh; EPS ±₹{rec.data.thresholds.epsTolerance}, materiality ₹{rec.data.thresholds.epsMateriality} — change them on Management Inputs → Settings. Every difference is listed, including those within tolerance. No balancing entry is ever posted and no source figure is changed.</Note>
            <div style={{ overflowX: 'auto', maxHeight: 640, overflowY: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{cols.map(c => <th key={c.label} style={{ ...S.th, ...(c.align === 'right' ? S.num : {}) }}>{c.label}</th>)}</tr></thead>
              <tbody>{filtered.slice(0, limit).map(r => <tr key={r.id}><td style={S.td}>{r.b === 'CO' ? 'Cons.' : 'Stand.'}</td><td style={{ ...S.td, whiteSpace: 'nowrap' }}>{pLabel(r.p)}</td><td style={S.td}>{r.stmt}</td><td style={{ ...S.td, minWidth: 220 }}><div style={{ fontSize: '0.66rem', color: C.ink2 }}>{r.check}</div>{r.particulars}</td>
                <td style={{ ...S.td, ...S.num }}>{fmtN(r, r.source)}</td><td style={{ ...S.td, ...S.num }}>{fmtN(r, r.module)}</td><td style={{ ...S.td, ...S.num, color: r.diff && Math.abs(r.diff) >= 0.0005 ? C.warn : C.ink }}>{fmtN(r, r.diff)}</td>
                <td style={{ ...S.td, fontSize: '0.68rem', color: C.ink2, maxWidth: 280, wordBreak: 'break-word' }}>{r.ref}</td><td style={S.td}><Badge status={r.status} /></td><td style={{ ...S.td, fontSize: '0.72rem', color: C.ink2, minWidth: 260 }}>{r.expl}</td></tr>)}</tbody>
            </table></div>
            {filtered.length > limit && <button style={{ ...S.btn('outline'), marginTop: 8 }} onClick={() => setLimit(l => l + 400)}>Show more ({filtered.length - limit} left)</button>}
          </Card>
        </>}

        <Card title="Statement-level adjustments">
          <div style={{ ...S.small, marginBottom: 8 }}>Adjustments are stored apart from the imported figures, with reason, evidence, user and date. They appear in the statements only when "include adjustments" is chosen, and are marked "adj".</div>
          {rights.adjust && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
            <select style={S.select} value={adjForm.basis} onChange={e => setAdjForm(f => ({ ...f, basis: e.target.value }))}><option value="SA">Standalone</option><option value="CO">Consolidated</option></select>
            <input style={{ ...S.input, width: 120 }} placeholder="line id e.g. pl.rev" value={adjForm.line} onChange={e => setAdjForm(f => ({ ...f, line: e.target.value }))} />
            <select style={S.select} value={adjForm.period} onChange={e => setAdjForm(f => ({ ...f, period: e.target.value }))}><option value="">period…</option>{flowPeriods.map(p => <option key={p} value={p}>{pLabel(p)}</option>)}</select>
            <input style={{ ...S.input, width: 110 }} type="number" step="any" placeholder="₹ lakh" value={adjForm.amount} onChange={e => setAdjForm(f => ({ ...f, amount: e.target.value }))} />
            <input style={{ ...S.input, width: 220 }} placeholder="Reason" value={adjForm.reason} onChange={e => setAdjForm(f => ({ ...f, reason: e.target.value }))} />
            <input style={{ ...S.input, width: 220 }} placeholder="Supporting evidence (document, approval)" value={adjForm.evidence} onChange={e => setAdjForm(f => ({ ...f, evidence: e.target.value }))} />
            <button style={S.btn('primary')} onClick={() => act('adj', () => fsApi.addAdjustment(adjForm).then(() => 'Adjustment recorded.'))}>Record adjustment</button>
          </div>}
          {!(adj.data?.items || []).length ? <div style={S.small}>No adjustments.</div> : <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Basis', 'Line', 'Period', 'Amount (₹ lakh)', 'Reason', 'Evidence', 'By / date', 'Status', ''].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>{adj.data.items.map(a => <tr key={a.id}><td style={S.td}>{a.b}</td><td style={S.td}>{a.l}</td><td style={S.td}>{pLabel(a.p)}</td><td style={{ ...S.td, ...S.num }}>{fmtVal(a.amount, 'lakh')}</td><td style={S.td}>{a.reason}</td><td style={S.td}>{a.evidence}</td><td style={S.td}>{a.by}, {a.at.slice(0, 10)}</td><td style={S.td}>{a.status}{a.reversedBy ? ` by ${a.reversedBy}` : ''}</td>
              <td style={S.td}>{rights.adjust && a.status === 'active' && <button style={S.btn('outline')} onClick={() => { const reason = window.prompt('Reason for reversing?'); if (reason) act('rev', () => fsApi.reverseAdj(a.id, reason).then(() => 'Reversed.')); }}>Reverse</button>}</td></tr>)}</tbody></table>}
        </Card>

        <Card title="Audit trail">
          {!(audit.data || []).length ? <div style={S.small}>No entries.</div> : <div style={{ maxHeight: 260, overflowY: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>{audit.data.slice(0, 150).map((a, i) => <tr key={i}><td style={{ ...S.td, whiteSpace: 'nowrap' }}>{new Date(a.at).toLocaleString('en-IN')}</td><td style={S.td}>{a.by}</td><td style={S.td}>{a.action}</td><td style={{ ...S.td, fontSize: '0.7rem', color: C.ink2 }}>{a.id || a.to || a.key || a.type || ''} {a.reason || ''}</td></tr>)}</tbody></table></div>}
        </Card>
      </>}
      {files.length > 0 && <div style={S.small}>Source files of the active version: {files.map(f => f.name).join(' · ')}</div>}
    </div>
  );
}
