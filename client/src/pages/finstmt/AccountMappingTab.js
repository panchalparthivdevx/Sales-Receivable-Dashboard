import React, { useMemo, useState } from 'react';
import { fsApi, errText } from './api';
import { C, S, Card, Note, Loading, useLoad, fmtTime, fmtDate } from './ui';
import ZohoSyncPanel from './ZohoSyncPanel';

// Account Mapping: every Zoho ledger → workbook account head (grouping) → statement line → note, built from the final
// workbook's trial-balance sheet; the reconciliation of the mapped Zoho figures to that workbook; the exceptions; edits.
const n2 = v => (v == null || v === '' ? '' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const STATUS = { traced: ['Traced', C.good], inferred: ['By grouping / rule', C.info], edited: ['Edited', C.green], suggested: ['Suggested', C.warn], awaiting: ['Awaiting mapping', C.bad], unmapped: ['Unmapped', C.bad], excluded: ['Excluded', C.ink3], zero: ['No amount', C.ink3] };
const PAGE = 100;

function ReconTable({ rows, unitNote }) {
  const [open, setOpen] = useState(null);
  return <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
    <thead><tr>{['Line', 'Final workbook', 'Zoho Books now', 'Difference', 'Workbook-only adjustments', 'Schedule vs ledgers', 'Zoho changes after the workbook', 'Other'].map(h => <th key={h} style={{ ...S.th, ...(h === 'Line' ? {} : S.num) }}>{h}</th>)}</tr></thead>
    <tbody>{rows.map(r => <React.Fragment key={r.id}>
      <tr onClick={() => r.leaf && setOpen(open === r.id ? null : r.id)} style={{ cursor: r.leaf ? 'pointer' : 'default', background: r.total ? C.page : 'transparent' }}>
        <td style={{ ...S.td, fontWeight: r.total ? 700 : 400 }}>{r.label}{r.leaf && (r.changes.length || r.dropped.length) ? <span style={S.small}> {open === r.id ? '▾' : '▸'}</span> : null}</td>
        <td style={{ ...S.td, ...S.num }}>{n2(r.workbook)}</td><td style={{ ...S.td, ...S.num }}>{n2(r.zoho)}</td>
        <td style={{ ...S.td, ...S.num, fontWeight: 700, color: r.difference && Math.abs(r.difference) >= 0.01 ? C.warn : C.ink3 }}>{r.difference == null ? '' : Math.abs(r.difference) < 0.01 ? '—' : n2(r.difference)}</td>
        <td style={{ ...S.td, ...S.num }}>{r.workbookOnly ? n2(r.workbookOnly) : ''}</td><td style={{ ...S.td, ...S.num }}>{r.schedule ? n2(r.schedule) : ''}</td>
        <td style={{ ...S.td, ...S.num }}>{r.zohoChanges ? n2(r.zohoChanges) : ''}</td><td style={{ ...S.td, ...S.num, color: r.other && Math.abs(r.other) >= 0.5 ? C.warn : C.ink }}>{r.other && Math.abs(r.other) >= 0.01 ? n2(r.other) : ''}</td>
      </tr>
      {open === r.id && <tr><td colSpan={8} style={{ ...S.td, background: C.page }}>
        {r.changes.length > 0 && <><b style={S.small}>Ledgers that changed in Zoho after the workbook's trial balance (effect on this line, ₹ lakh)</b>
          <table style={{ borderCollapse: 'collapse', margin: '4px 0 8px' }}><tbody>{r.changes.map(x => <tr key={x.id}><td style={S.td}>{x.name}<span style={S.small}> · {x.head || '—'}</span></td><td style={{ ...S.td, ...S.num }}>workbook {n2(x.workbook)}</td><td style={{ ...S.td, ...S.num }}>Zoho {n2(x.zoho)}</td><td style={{ ...S.td, ...S.num, fontWeight: 600 }}>{n2(x.effect)}</td></tr>)}</tbody></table></>}
        {r.dropped.length > 0 && <><b style={S.small}>Figures typed in the workbook (not in Zoho) — cell and amount</b><div style={S.small}>{r.dropped.map(x => `${x.cell}: ${n2(x.amount)}`).join(' · ')}</div></>}
        {r.obe ? <div style={S.small}>OBE column (workbook-only entries) on this line: {n2(r.obe)}</div> : null}
        {r.scheduleInfo && <div style={S.small}>Schedule {r.scheduleInfo.sheet}: {n2(r.scheduleInfo.workbook)} in the workbook vs {n2(r.scheduleInfo.ledgerAmount)} on the {r.scheduleInfo.ledgers} Zoho ledger(s) placed on this line.</div>}
      </td></tr>}
    </React.Fragment>)}</tbody></table>{unitNote && <div style={S.small}>{unitNote}</div>}</div>;
}

function EditModal({ row, view, onClose, onSaved }) {
  const cur = row.lines[0]?.line || '';
  const [line, setLine] = useState(row.edit?.line || cur);
  const [note, setNote] = useState(row.edit?.note || row.notes[0]?.key || '');
  const [sign, setSign] = useState(row.edit?.sign ?? '');
  const [exclude, setExclude] = useState(!!row.edit?.exclude);
  const [comment, setComment] = useState(row.edit?.comment || '');
  const [reviewed, setReviewed] = useState(!!row.reviewed);
  const [err, setErr] = useState('');
  const notes = view.noteOptions.filter(n => !line || n.lines.includes(line));
  const save = async clear => {
    try { await fsApi.mappingEdit(clear ? { id: row.id, clear: true } : { id: row.id, line: exclude ? null : line, note: exclude ? null : note || null, sign: sign === '' ? null : +sign, exclude, comment, reviewed }); onSaved(); }
    catch (e) { setErr(errText(e)); }
  };
  return <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
    <div style={{ background: C.white, borderRadius: 12, maxWidth: 720, width: '100%', padding: 18 }} onClick={e => e.stopPropagation()}>
      <div style={{ fontWeight: 700 }}>{row.name}</div>
      <div style={S.small}>Zoho account {row.id}{row.head ? ` · workbook head "${row.head}"` : ''} · now: {row.lines.map(l => view.lineOptions.find(o => o.id === l.line)?.label || l.line).join(' + ') || 'not placed'}{row.rule ? ` — ${row.rule}` : ''}</div>
      {err && <Note tone="warn">{err}</Note>}
      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, marginTop: 12, alignItems: 'center', fontSize: '0.8rem' }}>
        <span>Exclude from statements</span><label><input type="checkbox" checked={exclude} onChange={e => setExclude(e.target.checked)} /> not part of any line (say why below)</label>
        {!exclude && <><span>Statement line</span><select style={S.select} value={line} onChange={e => { setLine(e.target.value); setNote(''); }}><option value="">—</option>{['BS', 'PL'].map(g => <optgroup key={g} label={g === 'BS' ? 'Balance sheet' : 'Profit and loss'}>{view.lineOptions.filter(o => o.stmt === g).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</optgroup>)}</select>
          <span>Note / subheading</span><select style={S.select} value={note} onChange={e => setNote(e.target.value)}><option value="">—</option>{notes.map(n => <option key={n.key} value={n.key}>Note {n.num} {n.title} › {n.label}</option>)}</select>
          <span>Sign</span><select style={S.select} value={sign} onChange={e => setSign(e.target.value)}><option value="">The line's own (assets / expenses +, liabilities / income −)</option><option value="1">Debit balance adds to the line</option><option value="-1">Credit balance adds to the line</option></select></>}
        <span>Comment</span><input style={S.input} value={comment} onChange={e => setComment(e.target.value)} placeholder="why (kept with the mapping)" />
        <span>Reviewed</span><label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> mark as reviewed</label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        {row.edit && <button style={S.btn('outline')} onClick={() => save(true)}>Back to the workbook's mapping</button>}
        <button style={S.btn('outline')} onClick={onClose}>Cancel</button>
        <button style={S.btn('primary')} onClick={() => save(false)}>Save</button>
      </div>
      <div style={{ ...S.small, marginTop: 8 }}>A saved mapping is used by every later sync; the statements change at once. A split from the workbook (e.g. fixed deposits current / non-current) is replaced by the single line chosen here.</div>
    </div>
  </div>;
}

export default function AccountMappingTab({ rights = {}, legacy }) {
  const [rev, setRev] = useState(0);
  const view = useLoad(() => fsApi.mapping().catch(e => (e?.response?.data?.code === 'NO_MAPPING' ? { none: true, message: errText(e) } : Promise.reject(e))), [rev]);
  const recon = useLoad(() => fsApi.mappingRecon().catch(e => ({ error: errText(e) })), [rev]);
  const [msg, setMsg] = useState('');
  const [f, setF] = useState({ q: '', status: '', line: '', page: 0 });
  const [edit, setEdit] = useState(null);
  const [exTab, setExTab] = useState('awaiting');
  const [showLegacy, setShowLegacy] = useState(false);
  const reload = () => setRev(x => x + 1);
  const build = async file => { setMsg('Building the mapping…'); try { const r = await fsApi.mappingBuild(file); setMsg(`Mapping built from ${r.meta.file} › ${r.meta.sheet}: ${r.meta.counts.ledgers} ledgers (${r.meta.counts.traced} traced through the formulas, ${r.meta.counts.inferred} by grouping / rule, ${r.meta.counts.unmapped} unmapped), ${r.meta.counts.zohoMatched} matched to Zoho accounts.`); reload(); } catch (e) { setMsg(errText(e)); } };
  const v = view.data;
  const rows = useMemo(() => (v?.rows || []).filter(r => (!f.status || (f.status === 'open' ? ['awaiting', 'suggested', 'unmapped'].includes(r.status) || r.ambiguous : f.status === 'notreviewed' ? !r.reviewed && r.status !== 'zero' : r.status === f.status))
    && (!f.line || r.lines.some(l => l.line === f.line)) && (!f.q || `${r.name} ${r.id} ${r.head || ''} ${r.zohoName || ''}`.toLowerCase().includes(f.q.toLowerCase()))), [v, f]);
  const R = recon.data;
  const lineLabel = id => v?.lineOptions.find(o => o.id === id)?.label || id;
  const ex = R?.exceptions;
  const EX_TABS = ex ? [['awaiting', `New Zoho accounts (${ex.awaiting.length})`], ['unmapped', `Unmapped (${ex.unmapped.length})`], ['ambiguous', `Ambiguous / splits (${ex.ambiguous.length})`], ['wbonly', `Workbook-only adjustments (${ex.workbookOnlyByLedger.length + ex.workbookOnlyByLine.length})`], ['schedules', `Schedule vs ledgers (${ex.schedules.length})`], ['excluded', `Excluded (${ex.excluded.length})`], ['signs', `Formula issues (${ex.signRepairs.length + (ex.anomalies || []).length})`]] : [];
  const T = ({ cols, data }) => <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{cols.map(c => <th key={c[0]} style={{ ...S.th, ...(c[2] ? S.num : {}) }}>{c[0]}</th>)}</tr></thead><tbody>{data.map((x, i) => <tr key={i}>{cols.map(c => <td key={c[0]} style={{ ...S.td, ...(c[2] ? S.num : {}) }}>{c[1](x)}</td>)}</tr>)}</tbody></table>{!data.length && <div style={S.small}>None.</div>}</div>;
  return (
    <div>
      <ZohoSyncPanel canRun={rights.import || rights.admin} compact onChanged={reload} />
      <Card title="Account mapping — from the final workbook's trial balance" right={<>
        {(rights.import || rights.admin) && <button style={S.btn('primary')} onClick={() => build(null)} title="Office PC: reads the newest final workbook in the Financials folder">{v && !v.none ? 'Rebuild from the final workbook' : 'Build from the Q2 final workbook'}</button>}
        {(rights.import || rights.admin) && <label style={{ ...S.btn('outline'), display: 'inline-flex', alignItems: 'center' }}>Upload a final workbook<input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={e => e.target.files[0] && build(e.target.files[0])} /></label>}
        {v && !v.none && <button style={S.btn('outline')} onClick={() => fsApi.download('/mapping/export', {}, 'Account_mapping_and_reconciliation.xlsx').catch(e => setMsg(errText(e)))}>Excel</button>}
      </>}>
        {msg && <Note>{msg}</Note>}
        {view.loading && <Loading />}
        {view.error && <Note tone="warn">{errText(view.error)}</Note>}
        {v?.none && <Note tone="warn">{v.message}</Note>}
        {v && !v.none && <>
          <div style={{ ...S.small, marginBottom: 8, lineHeight: 1.6 }}>
            Built from <b>{v.meta.file}</b> › sheet <b>{v.meta.sheet}</b> (balance sheet {fmtDate(v.meta.reportingDate)}, P&L {v.meta.ytdPeriod}) on {fmtTime(v.meta.builtAt)}{v.meta.builtBy ? ` by ${v.meta.builtBy}` : ''}.
            Each ledger was traced through the workbook's formulas (notes, schedules, statements) to the line it lands in, with the workbook's signs, groupings, current / non-current splits and subtotals.
            {' '}{v.meta.counts.ledgers} ledgers: <b>{v.meta.counts.traced}</b> traced · <b>{v.meta.counts.inferred}</b> by grouping / rule · <b>{v.meta.counts.excluded}</b> excluded · <b>{v.meta.counts.unmapped}</b> unmapped · {v.meta.counts.zero} with no amount; {v.meta.counts.zohoMatched} matched to Zoho accounts by name.
            {v.counts.awaiting || v.counts.suggested ? <> Zoho accounts not in the workbook with an amount at the cut-off: <b style={{ color: C.warn }}>{(v.counts.awaiting || 0) + (v.counts.suggested || 0)}</b> ({v.counts.suggested || 0} placed by a suggestion from their parent account).</> : null}
          </div>
        </>}
      </Card>

      {R && !R.error && <Card title={`Reconciliation — mapped Zoho figures vs ${R.mapping.file}`}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          {[['Zoho balance sheet at ' + fmtDate(R.checks.zohoAtWorkbookDate?.date), R.checks.zohoAtWorkbookDate], ['Zoho balance sheet at the cut-off', R.checks.zohoAtCutoff], [`Provisional ${fmtDate(R.checks.provisionalClosing?.date)} column`, R.checks.provisionalClosing]].filter(x => x[1]).map(([t, c]) =>
            <div key={t} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 10px', fontSize: '0.74rem' }}><b>{t}</b><div>Assets {n2(c.assets)} · Equity & liabilities {n2(c.equityAndLiabilities)} · <b style={{ color: Math.abs(c.difference) < 0.01 ? C.good : C.bad }}>{Math.abs(c.difference) < 0.01 ? 'balances' : `differs by ${n2(c.difference)}`}</b></div></div>)}
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 10px', fontSize: '0.74rem' }}><b>Cash flow: closing cash vs balance sheet</b><div>{R.checks.cashFlow.every(x => Math.abs(x.difference) < 0.01) ? <b style={{ color: C.good }}>agrees in all {R.checks.cashFlow.length} provisional cash flows</b> : R.checks.cashFlow.filter(x => Math.abs(x.difference) >= 0.01).map(x => `${x.period} (${x.role}): ${n2(x.difference)}`).join(' · ')}</div></div>
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 10px', fontSize: '0.74rem' }}><b>Notes vs statement lines</b><div>{R.checks.notes.filter(x => Math.abs(x.difference) >= 0.01).length === 0 ? <b style={{ color: C.good }}>all {R.checks.notes.length} note totals agree</b> : `${R.checks.notes.filter(x => Math.abs(x.difference) >= 0.01).length} of ${R.checks.notes.length} differ`}</div></div>
        </div>
        <Note>Difference = final workbook − Zoho Books now (₹ lakh), explained as: <b>workbook-only adjustments</b> (the OBE column and figures typed in the workbook, not in Zoho) · <b>schedule vs ledgers</b> (the workbook takes the line from a register, e.g. fixed assets, which Zoho's ledgers classify differently) · <b>Zoho changes after the workbook</b> (postings or edits in Zoho after the workbook's trial balance — click a line for the ledgers) · <b>other</b> (lines the workbook rolls forward: Zoho's retained earnings against the audited opening; accounts not in the workbook). Accounting cut-off {fmtDate(R.cutoff)}; last successful sync {fmtTime(R.lastSuccess)}.</Note>
        <div style={S.h2}>Balance sheet as at {fmtDate(R.mapping.reportingDate)}</div>
        <ReconTable rows={R.bs} />
        <div style={{ ...S.h2, marginTop: 12 }}>Statement of profit and loss — {R.mapping.ytdPeriod.replace(/^FY(\d{4})-(\w+)$/, (m, y, p) => `${p} FY${y.slice(2)}`)}</div>
        <ReconTable rows={R.pl} />
        <div style={{ ...S.h2, marginTop: 12 }}>The quarter alone — {R.quarter.id.replace(/^FY(\d{4})-(\w+)$/, (m, y, p) => `${p} FY${y.slice(2)}`)}: Zoho's months vs the final quarter</div>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Line', 'Final quarter (results)', 'Final YTD − previous period', 'Zoho months', 'Difference', 'of which: YTD difference', 'less: previous-period difference'].map(h => <th key={h} style={{ ...S.th, ...(h === 'Line' ? {} : S.num) }}>{h}</th>)}</tr></thead>
          <tbody>{R.quarter.rows.map(r => <tr key={r.id}><td style={S.td}>{r.label}</td>{['finalQuarter', 'finalYtdLessPrevious', 'zohoMonths', 'difference', 'ytdDifference', 'previousDifference'].map(k => <td key={k} style={{ ...S.td, ...S.num, color: k === 'difference' && r[k] && Math.abs(r[k]) >= 0.01 ? C.warn : C.ink }}>{n2(r[k])}</td>)}</tr>)}</tbody></table>
          <div style={S.small}>Zoho's quarter − the final quarter = (Zoho YTD − final YTD) − (Zoho previous period − final previous period): a difference comes from the year to date as a whole or from postings that sit in a different quarter in Zoho now than in the previous final workbook.</div></div>
      </Card>}
      {R?.error && <Card title="Reconciliation"><Note tone="warn">{R.error}</Note></Card>}

      {ex && <Card title="Exceptions — by ledger and amount (₹ lakh)">
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>{EX_TABS.map(([k, l]) => <button key={k} style={S.tab(exTab === k)} onClick={() => setExTab(k)}>{l}</button>)}</div>
        {exTab === 'awaiting' && <T data={ex.awaiting} cols={[['Zoho account', x => <>{x.name}<div style={S.small}>{x.id}</div></>], ['Type', x => x.type || '—'], ['Amount at cut-off', x => n2(x.amount), 1], ['Where it is shown now', x => (x.suggested ? `${lineLabel(x.line)} — suggested from the ${x.suggested}` : x.line.includes('await') ? 'Accounts awaiting mapping line' : lineLabel(x.line))], ['Created in Zoho', x => (x.created ? fmtDate(x.created) : '—')]]} />}
        {exTab === 'unmapped' && <T data={ex.unmapped} cols={[['Ledger', x => x.name], ['Workbook head', x => x.head || '—'], ['Workbook TB', x => n2(x.workbook), 1], ['Zoho at workbook date', x => n2(x.zoho), 1]]} />}
        {exTab === 'ambiguous' && <T data={ex.ambiguous} cols={[['Ledger', x => x.name], ['Workbook head', x => x.head || '—'], ['Line(s)', x => x.lines.map(lineLabel).join(' + ')], ['Split', x => (x.split ? Object.entries(x.split).map(([k, s]) => `${lineLabel(k)} ${Math.round(s * 1000) / 10}%`).join(' / ') : '')], ['Why', x => x.rule || ''], ['Workbook TB', x => n2(x.workbook), 1]]} />}
        {exTab === 'wbonly' && <><div style={S.h2}>OBE column (entries in the workbook only), by ledger</div><T data={ex.workbookOnlyByLedger} cols={[['Ledger', x => x.name], ['Workbook head', x => x.head || '—'], ['OBE amount', x => n2(x.obe), 1], ['Zoho now − workbook TB', x => n2(x.nowInZoho), 1], ['Posted in Zoho since?', x => (x.nowInZoho != null && Math.abs(x.nowInZoho - x.obe) < 0.5 ? 'yes — same amount' : x.nowInZoho ? 'partly / other changes' : 'no')]]} />
          <div style={{ ...S.h2, marginTop: 10 }}>Figures typed in the workbook, by line</div><T data={ex.workbookOnlyByLine} cols={[['Line', x => x.label], ['Cell', x => x.cell], ['Kind', x => x.kind], ['Amount', x => n2(x.amount), 1]]} /></>}
        {exTab === 'schedules' && <T data={ex.schedules} cols={[['Line', x => x.label], ['Schedule', x => x.schedule], ['Workbook (schedule)', x => n2(x.workbook), 1], ['Zoho ledgers', x => n2(x.ledgers), 1], ['Difference', x => n2(x.difference), 1]]} />}
        {exTab === 'excluded' && <T data={ex.excluded} cols={[['Ledger', x => x.name], ['Why', x => x.rule], ['Workbook TB', x => n2(x.workbook), 1]]} />}
        {exTab === 'signs' && <><T data={ex.signRepairs} cols={[['Ledger', x => x.name], ['Line in the workbook formula', x => lineLabel(x.line)], ['Now on', x => (x.to ? lineLabel(x.to) : '—')], ['Typed figure', x => x.typed || ''], ['Amount', x => n2(x.amount), 1], ['Note', x => x.note || 'the workbook adds it with the wrong sign and cancels it with a typed figure — re-pointed to the typed line']]} />
          {(ex.anomalies || []).map((a, i) => <div key={i} style={S.small}>{a.sheet}!{a.addr}: {a.why}</div>)}
          <div style={S.small}>Income and expense reach other equity through total comprehensive income: checked for {ex.tciRule?.checked} ledgers — {ex.tciRule?.ok ? 'consistent' : `${ex.tciRule?.mismatches?.length} mismatch(es)`}.</div></>}
      </Card>}

      {v && !v.none && <Card title="Ledger mapping" right={<>
        <input style={{ ...S.input, width: 200 }} placeholder="Find a ledger, ID or head…" value={f.q} onChange={e => setF({ ...f, q: e.target.value, page: 0 })} />
        <select style={S.select} value={f.status} onChange={e => setF({ ...f, status: e.target.value, page: 0 })}><option value="">All statuses</option><option value="open">Needs attention (awaiting / suggested / unmapped / ambiguous)</option><option value="notreviewed">Not reviewed</option>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <select style={S.select} value={f.line} onChange={e => setF({ ...f, line: e.target.value, page: 0 })}><option value="">All lines</option>{v.lineOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
        {(rights.adjust || rights.admin) && <button style={S.btn('outline')} onClick={async () => { const ids = rows.filter(r => r.id && !r.reviewed).map(r => r.id); if (!ids.length) return; await fsApi.mappingReview(ids, true); setMsg(`${ids.length} ledger(s) marked reviewed.`); reload(); }}>Mark shown as reviewed</button>}
      </>}>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Zoho account ID', 'Ledger', 'Workbook account head', 'Statement line', 'Note / subheading', 'Rule', 'Status', `Workbook TB`, `Zoho ${fmtDate(v.meta.reportingDate)}`, `Zoho ${fmtDate(v.cutoff)}`, ''].map(h => <th key={h} style={{ ...S.th, ...(/TB|Zoho /.test(h) ? S.num : {}) }}>{h}</th>)}</tr></thead>
          <tbody>{rows.slice(f.page * PAGE, (f.page + 1) * PAGE).map(r => <tr key={`${r.row}|${r.id}`}>
            <td style={{ ...S.td, ...S.small }}>{r.id || '—'}</td>
            <td style={S.td}>{r.name}{r.zohoName && r.zohoName !== r.name ? <div style={S.small}>Zoho: {r.zohoName}</div> : null}</td>
            <td style={{ ...S.td, ...S.small }}>{r.head || '—'}</td>
            <td style={{ ...S.td, ...S.small }}>{r.lines.map(l => `${lineLabel(l.line)}${l.coef != null && Math.abs(Math.abs(l.coef) - 1) > 1e-4 ? ` (${Math.round(Math.abs(l.coef) * 1000) / 10}%)` : ''}`).join(' + ') || '—'}</td>
            <td style={{ ...S.td, ...S.small }}>{r.notes.map(n => `Note ${n.num} › ${n.label}`).join('; ')}</td>
            <td style={{ ...S.td, ...S.small, maxWidth: 260 }}>{r.repaired?.why || r.rule || ''}</td>
            <td style={{ ...S.td, ...S.small, color: (STATUS[r.status] || [])[1], fontWeight: 600 }}>{(STATUS[r.status] || [r.status])[0]}{r.ambiguous ? ' · check' : ''}{r.reviewed ? <div style={{ color: C.good, fontWeight: 400 }}>✓ reviewed {r.reviewed.by}</div> : null}</td>
            <td style={{ ...S.td, ...S.num }}>{n2(r.tb?.close)}</td><td style={{ ...S.td, ...S.num }}>{n2(r.zMap)}</td><td style={{ ...S.td, ...S.num }}>{n2(r.zNow)}</td>
            <td style={S.td}>{r.id && (rights.adjust || rights.admin) && <button style={S.btn('outline')} onClick={() => setEdit(r)}>Edit</button>}</td>
          </tr>)}</tbody>
        </table></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, ...S.small }}>
          {rows.length} ledger(s) · page {f.page + 1} of {Math.max(1, Math.ceil(rows.length / PAGE))}
          <button style={S.btn('outline')} disabled={f.page === 0} onClick={() => setF({ ...f, page: f.page - 1 })}>‹ Previous</button>
          <button style={S.btn('outline')} disabled={(f.page + 1) * PAGE >= rows.length} onClick={() => setF({ ...f, page: f.page + 1 })}>Next ›</button>
          <span>Amounts in ₹ lakh, debit positive (as the trial balance).</span>
        </div>
      </Card>}
      {edit && <EditModal row={edit} view={v} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setMsg('Mapping saved — the statements use it now and every later sync keeps it.'); reload(); }} />}

      {legacy && <Card title="Earlier P&L item mapping (before the workbook mapping)" right={<button style={S.btn('outline')} onClick={() => setShowLegacy(x => !x)}>{showLegacy ? 'Hide' : 'Show'}</button>}>
        {showLegacy ? legacy : <div style={S.small}>The earlier mapping of Zoho accounts to P&L items (used only by the "Zoho account mapping (live, editable)" source of the P&L tab) is kept here unchanged.</div>}
      </Card>}
    </div>
  );
}
