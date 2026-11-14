import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Lock, Unlock, Download, Upload, RefreshCw } from 'lucide-react';
import { fsApi, errText } from './api';
import { C, S, Card, Note, Loading, fmtAmt, useLoad, ExportButtons } from './ui';

// Budget (Data Validation & Reconciliation → Budget). The server computes it from Zoho; amounts arrive in ₹ lakh,
// edits (cell overrides, manual lines, client / rent amounts) are sent in rupees.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const mLabel = m => (m ? `${MON[+m.slice(5, 7) - 1]} ${m.slice(2, 4)}` : '');
const SECTIONS = [['revenue', 'Revenue (clients)'], ['other_income', 'Other income'], ['rent', 'Rent (agreements)'], ['expense', 'Other expenses']];
const METHOD_LABEL = { trend: 'Trend (12-month regression)', avg12: 'Average of 12 months', avg3: 'Average of 3 months', last: 'Last month', zero: 'Nil', debt: 'Debt schedule interest' };
const rs = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const L = v => fmtAmt(v, 'lakh');
const inrTxt = v => (v == null ? '' : `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v * 1e5)}`);

export function Pills({ items, value, onChange }) {
  return <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>{items.map(([k, l]) => <button key={k} onClick={() => onChange(k)} style={{ ...S.btn(value === k ? 'primary' : 'outline'), borderRadius: 16 }}>{l}</button>)}</div>;
}
export function FileButton({ label, onFile, accept = '.xlsx', disabled }) {
  return <label style={{ ...S.btn('outline'), cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}><Upload size={14} />{label}<input type="file" accept={accept} disabled={disabled} style={{ display: 'none' }} onChange={e => { const f = e.target.files[0]; e.target.value = ''; if (f) onFile(f); }} /></label>;
}
export const Field = ({ label, children, w }) => <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.68rem', color: C.ink2, fontWeight: 600, width: w }}>{label}{children}</label>;
export const Tbl = ({ head, num = [], children, maxHeight = 520 }) => (
  <div style={{ overflow: 'auto', maxHeight }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
    <thead><tr>{head.map((h, i) => <th key={i} style={{ ...S.th, ...(num.includes(i) ? S.num : {}) }}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
);

export default function BudgetSection({ rights, flash }) {
  const can = !!rights?.inputs;
  const vers = useLoad(() => fsApi.budgetVersions(), []);
  const versions = useMemo(() => vers.data?.versions || [], [vers.data]);
  const [vid, setVid] = useState('');
  const cur = versions.find(v => v.id === vid) || versions[0] || null;
  const grid = useLoad(() => (cur ? fsApi.budget(cur.id) : Promise.resolve(null)), [cur?.id]);
  const [view, setView] = useState('grid');
  const [busy, setBusy] = useState('');
  const frozen = !!cur?.frozen;
  const act = async (label, fn, after = []) => {
    setBusy(label);
    try { const r = await fn(); flash(typeof r === 'string' ? r : 'Saved.'); for (const a of after) a(); } catch (e) { flash(errText(e)); }
    setBusy('');
  };
  const reloadAll = () => { vers.reload(); grid.reload(); };

  const newVersion = () => {
    const name = window.prompt('Name of the new budget version (e.g. "FY27-28 Original", "Revised Nov-26")', '');
    if (!name) return;
    act('new', async () => { const r = await fsApi.addBudget({ name, copyFrom: cur?.id || undefined }); setVid(r.version.id); return `Budget version "${name}" created${cur ? ` (settings, manual lines and cell changes copied from "${cur.name}")` : ''}.`; }, [vers.reload]);
  };

  if (vers.loading && !vers.data) return <Loading text="Loading budget versions…" />;
  if (vers.error) return <div style={{ ...S.card, color: C.bad }}>{vers.error}</div>;

  return <div>
    <Card title="Budget" right={<>
      {versions.length > 0 && <select style={S.select} value={cur?.id || ''} onChange={e => setVid(e.target.value)}>{versions.map(v => <option key={v.id} value={v.id}>{v.name}{v.frozen ? ' (frozen)' : ''}</option>)}</select>}
      {can && <button style={S.btn('primary')} disabled={!!busy} onClick={newVersion}><Plus size={14} />New version</button>}
      {can && cur && <button style={S.btn('outline')} disabled={!!busy} onClick={() => act('freeze', () => fsApi.freezeBudget(cur.id, frozen).then(() => (frozen ? 'Unfrozen — the budget follows Zoho and your inputs again.' : 'Frozen — the figures are kept as they are now.')), [reloadAll])}>{frozen ? <Unlock size={14} /> : <Lock size={14} />}{frozen ? 'Unfreeze' : 'Freeze'}</button>}
      {cur && <ExportButtons xlsx={{ path: '/budget/export', params: { version: cur.id }, filename: `Budget_${cur.name.replace(/[^\w]+/g, '_')}.xlsx` }} />}
      {can && cur && <button style={{ ...S.btn('outline'), color: C.bad }} disabled={!!busy} onClick={() => { if (window.confirm(`Delete the budget version "${cur.name}" with its manual lines and cell changes?`)) act('del', () => fsApi.deleteBudget(cur.id).then(() => { setVid(''); return 'Budget version deleted.'; }), [vers.reload]); }}><Trash2 size={14} /></button>}
    </>}>
      <div style={S.small}>Revenue is each client's Zoho billing before GST, carried month by month until the client's agreement end date (Client end dates). Rent follows each agreement in the Rent Recurring Module until its end date (Rent agreements), with the agreed increments. Every other expense head of the Branch P&L mapping is projected from its last 12 months in Zoho (method per head), and you can add manual lines. A frozen version keeps its figures; an open one follows Zoho and your inputs.</div>
      {!can && <Note>Changing the budget needs the "Management inputs" right (User Settings → Financial Statements).</Note>}
      {!versions.length && <Note tone="warn">No budget version yet. {can ? 'Use "New version" to create one — it is built straight away from Zoho.' : ''}</Note>}
      {frozen && <Note>Frozen by {cur.frozen.by} on {new Date(cur.frozen.at).toLocaleString('en-IN')}. Unfreeze to change settings, cells or lines.</Note>}
    </Card>

    {cur && <>
      <Pills value={view} onChange={setView} items={[['grid', 'Budget'], ['clients', 'Client end dates'], ['rent', 'Rent agreements'], ['manual', 'Manual lines'], ['settings', 'Settings & history']]} />
      {view === 'grid' && <BudgetGrid grid={grid} cur={cur} can={can && !frozen} act={act} reloadAll={reloadAll} methods={vers.data?.methods || []} />}
      {view === 'clients' && <ClientEndDates can={can} act={act} onSaved={grid.reload} base={grid.data?.settings?.baseMonth} />}
      {view === 'rent' && <RentEndDates can={can} act={act} onSaved={grid.reload} />}
      {view === 'manual' && <ManualLines cur={cur} grid={grid} can={can && !frozen} act={act} />}
      {view === 'settings' && <BudgetSettings cur={cur} grid={grid} can={can && !frozen} act={act} reloadAll={reloadAll} categories={grid.data?.sources?.categories || []} />}
    </>}
  </div>;
}

// ── the budget itself ────────────────────────────────────────────────────────
function BudgetGrid({ grid, cur, can, act, reloadAll, methods }) {
  const [sec, setSec] = useState('');
  const [q, setQ] = useState('');
  const [flagOnly, setFlagOnly] = useState(false);
  const [limit, setLimit] = useState(80);
  const g = grid.data;
  const rows = useMemo(() => (g?.rows || []).filter(r => (!sec || r.section === sec) && (!q || `${r.label} ${r.branch}`.toLowerCase().includes(q.toLowerCase())) && (!flagOnly || r.meta?.flags?.length)), [g, sec, q, flagOnly]);
  if (grid.loading && !g) return <Loading text="Building the budget from Zoho…" />;
  if (grid.error) return <div style={{ ...S.card, color: C.bad }}>{grid.error}</div>;
  if (!g) return null;
  const months = g.months;
  const tot = k => months.reduce((s, m) => s + (g.totals[m]?.[k] || 0), 0);
  const src = g.sources || {};
  const editCell = (r, m) => {
    if (!can) return;
    const was = r.values[m];
    const x = window.prompt(`${r.label}${r.branch ? ` (${r.branch})` : ''} — ${mLabel(m)}\nBudget in ₹ lakh. Leave empty to go back to the computed figure.`, was == null ? '' : String(Math.round(was * 100) / 100));
    if (x === null) return;
    const note = x.trim() === '' ? '' : (window.prompt('Reason for the change (kept with the cell)', '') || '');
    act('cell', () => fsApi.budgetCell({ versionId: cur.id, rowId: r.id, month: m, value: x.trim() === '' ? null : Number(x) * 1e5, note }).then(() => 'Cell saved.'), [grid.reload]);
  };
  const setMethod = (head, method) => act('method', () => fsApi.saveBudget(cur.id, { settings: { headMethods: { ...(cur.settings?.headMethods || {}), [head]: method } } }).then(() => 'Method saved — the head is projected again.'), [reloadAll]);
  const TOT = [['revenue', 'Revenue'], ['otherIncome', 'Other income'], ['rent', 'Rent'], ['expenses', 'Other expenses'], ['ebitda', 'EBITDA (before finance costs)'], ['result', 'Result after finance costs']];

  return <>
    <Card title={`${cur.name} — ${mLabel(months[0])} to ${mLabel(months[months.length - 1])} (₹ lakh)`} right={<button style={S.btn('outline')} onClick={grid.reload}><RefreshCw size={14} />Recompute</button>}>
      <Tbl head={['', ...months.map(mLabel), 'Total']} num={[...months.map((_, i) => i + 1), months.length + 1]} maxHeight={360}>
        {TOT.map(([k, l]) => <tr key={k} style={{ fontWeight: ['ebitda', 'result'].includes(k) ? 700 : 400 }}><td style={{ ...S.td, whiteSpace: 'nowrap' }}>{l}</td>{months.map(m => <td key={m} style={{ ...S.td, ...S.num, color: (g.totals[m]?.[k] || 0) < 0 ? C.bad : C.ink }}>{L(g.totals[m]?.[k])}</td>)}<td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{L(tot(k))}</td></tr>)}
      </Tbl>
      <div style={{ ...S.small, marginTop: 8 }}>EBITDA here is on the books' basis — office rent is an expense. The published results follow Ind AS 116, so budget vs actual compares budget rent with the lease payments in the cash flow and this EBITDA with lease-adjusted EBITDA (Financial Performance, CFO Overview).</div>
    </Card>

    <Card title="Where the figures come from">
      <div style={{ fontSize: '0.78rem', lineHeight: 1.7 }}>
        <div>Invoices: {src.invoices?.count} from the Zoho sync{src.invoices?.syncedAt ? ` (${new Date(src.invoices.syncedAt).toLocaleString('en-IN')})` : ''}; base month <b>{mLabel(g.settings.baseMonth)}</b> ({g.settings.revenueBasis === 'avg3' ? 'average of the last 3 months' : 'that month\'s billing'}).{src.invoices?.gstFallback ? ` ${src.invoices.gstFallback} invoice(s) have no pre-GST amount cached — total ÷ 1.18 used.` : ''}</div>
        {src.invoices?.selfExcluded > 0 && <div>Left out: {src.invoices.selfExcluded} invoice(s) addressed to Dev Accelerator itself (inter-branch), {L(src.invoices.selfAmount / 1e5)} ₹ lakh — not revenue.</div>}
        <div>Rent: {src.rentFile ? `Rent Recurring Module "${src.rentFile}"` : <span style={{ color: C.bad }}>no Rent Recurring Module workbook found{src.rentError ? ` (${src.rentError})` : ''}</span>}.</div>
        <div>Expenses: Branch P&L mapping heads, Zoho account transactions — {Object.entries(src.plCoverage || {}).map(([fy, c]) => `FY ${fy}: ${c.accountsFound} account(s) cached${c.accountsMissing ? `, ${c.accountsMissing} not yet fetched` : ''}`).join('; ') || 'no data'}{src.plError ? ` — ${src.plError}` : ''}.</div>
      </div>
      {(g.flags?.noEndDate > 0 || g.flags?.contractUnmatched?.length > 0 || g.flags?.oneOff > 0) && <Note tone="warn">
        {g.flags.oneOff > 0 && <div>{g.flags.oneOff} client(s) were billed far more in {mLabel(g.settings.baseMonth)} than in their usual month, or only in that month ({L(g.flags.oneOffAmount / 1e5)} ₹ lakh a month) — if that was a one-off invoice, give the client a monthly amount or an end date under "Client end dates", or leave its invoice category out under "Settings". Tick "Only lines with a flag" to see them.</div>}
        {g.flags.noEndDate > 0 && <div>{g.flags.noEndDate} client(s) have no agreement end date — {g.settings.noEndDate === 'stop' ? 'they are not projected (setting)' : 'they are projected to the end of the budget'}. Add the dates under "Client end dates".</div>}
        {g.flags.contractUnmatched?.length > 0 && <div>End dates given for clients with no billing in the last 12 months and no monthly amount: {g.flags.contractUnmatched.slice(0, 12).join(', ')}{g.flags.contractUnmatched.length > 12 ? '…' : ''}.</div>}
      </Note>}
      {Object.values(src.plCoverage || {}).some(c => c.accountsMissing) && <Note tone="warn">Part of the last 12 months is not in the Zoho cache yet, so those months count as nil in the trend. Fetch them under "Settings & history".</Note>}
      {g.revenueCheck?.length > 0 && <>
        <div style={{ ...S.h2, fontSize: '0.82rem', marginTop: 6 }}>Zoho billing vs published revenue</div>
        <Tbl head={['Period', 'Zoho billing before GST', 'Revenue from operations (published, standalone)', 'Difference', 'Billing as % of published']} num={[1, 2, 3, 4]} maxHeight={200}>
          {g.revenueCheck.map(r => <tr key={r.period}><td style={S.td}>{r.period}</td><td style={{ ...S.td, ...S.num }}>{L(r.billing)}</td><td style={{ ...S.td, ...S.num }}>{r.published == null ? 'n/a' : L(r.published)}</td><td style={{ ...S.td, ...S.num }}>{r.published == null ? '' : L(r.billing - r.published)}</td><td style={{ ...S.td, ...S.num }}>{r.published ? `${((r.billing / r.published) * 100).toFixed(1)}%` : ''}</td></tr>)}
        </Tbl>
        <div style={{ ...S.small, marginTop: 6 }}>The published revenue also includes revenue booked by journals and Ind AS adjustments (for example straight-lining and unbilled revenue) that are not invoices. The budget follows billing.</div>
      </>}
    </Card>

    <Card title={`Budget lines (${rows.length})`}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <select style={S.select} value={sec} onChange={e => setSec(e.target.value)}><option value="">All sections</option>{SECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input style={{ ...S.input, width: 220 }} placeholder="Search client, landlord, head, branch…" value={q} onChange={e => setQ(e.target.value)} />
        <label style={{ ...S.small, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={flagOnly} onChange={e => setFlagOnly(e.target.checked)} />Only lines with a flag</label>
        <span style={S.small}>{can ? 'Double-click a month to change it (₹ lakh); changed cells are outlined.' : ''}</span>
      </div>
      <Tbl head={['Line', 'Branch', 'End date', 'Basis / method', ...months.map(mLabel), 'Total']} num={[...months.map((_, i) => i + 4), months.length + 4]} maxHeight={620}>
        {rows.slice(0, limit).map(r => <tr key={r.id}>
          <td style={{ ...S.td, minWidth: 200 }}><div style={{ fontSize: '0.64rem', color: C.ink2 }}>{SECTIONS.find(s => s[0] === r.section)?.[1]}{r.meta?.manual ? ' · manual' : ''}</div>{r.label}
            {r.meta?.flags?.length > 0 && <div style={{ fontSize: '0.66rem', color: C.warn }}>{r.meta.flags.join(' · ')}</div>}</td>
          <td style={{ ...S.td, fontSize: '0.72rem' }}>{r.branch}</td>
          <td style={{ ...S.td, whiteSpace: 'nowrap', fontSize: '0.72rem' }}>{r.meta?.endDate || (r.section === 'revenue' || r.section === 'rent' ? <span style={{ color: C.warn }}>none</span> : '')}</td>
          <td style={{ ...S.td, fontSize: '0.7rem', minWidth: 130 }}>
            {r.section === 'expense' || r.section === 'other_income' ? (r.meta?.manual ? `${inrTxt(r.meta.monthly)}/month${r.meta.growthPct ? `, +${r.meta.growthPct}% a year` : ''}` : can ? <select style={{ ...S.select, fontSize: '0.7rem' }} value={r.meta?.method || 'trend'} onChange={e => setMethod(r.head, e.target.value)}>{methods.map(x => <option key={x} value={x}>{METHOD_LABEL[x] || x}</option>)}</select> : METHOD_LABEL[r.meta?.method] || r.meta?.method)
              : r.section === 'rent' ? `${r.meta?.source || ''}${r.meta?.lastModule?.amount ? ` · ${inrTxt(r.meta.lastModule.amount)}/month` : ''}${r.meta?.incPct ? ` · +${Math.round(r.meta.incPct * 1000) / 10}% from ${r.meta.incOn || '—'}` : ''}`
              : `${r.meta?.basis || ''}${r.meta?.runRate ? ` · ${inrTxt(r.meta.runRate)}/month` : ''}${r.meta?.escalation ? ` · +${Math.round(r.meta.escalation.pct * 1000) / 10}% from ${r.meta.escalation.from}` : ''}`}
          </td>
          {months.map(m => { const o = r.overridden?.[m]; return <td key={m} onDoubleClick={() => editCell(r, m)} title={o ? `Changed by ${o.by} on ${o.at?.slice(0, 10)} (computed: ${L(o.was)})${o.note ? ` — ${o.note}` : ''}` : can ? 'Double-click to change' : ''}
            style={{ ...S.td, ...S.num, cursor: can ? 'pointer' : 'default', outline: o ? `2px solid ${C.s2}` : 'none', outlineOffset: -2, color: r.values[m] ? C.ink : C.ink3 }}>{r.values[m] ? L(r.values[m]) : '–'}</td>; })}
          <td style={{ ...S.td, ...S.num, fontWeight: 600 }}>{L(r.total)}</td>
        </tr>)}
      </Tbl>
      {rows.length > limit && <button style={{ ...S.btn('outline'), marginTop: 8 }} onClick={() => setLimit(l => l + 200)}>Show more ({rows.length - limit} left)</button>}
    </Card>
  </>;
}

// ── client end dates ─────────────────────────────────────────────────────────
function ClientEndDates({ can, act, onSaved, base }) {
  const d = useLoad(() => fsApi.clients(), []);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('missing');
  const [edit, setEdit] = useState({});
  const [limit, setLimit] = useState(100);
  const saved = useMemo(() => new Map((d.data?.items || []).map(x => [x.customerId || `n:${x.client.toLowerCase()}`, x])), [d.data]);
  if (d.loading && !d.data) return <Loading text="Reading clients from Zoho…" />;
  if (d.error) return <div style={{ ...S.card, color: C.bad }}>{d.error}</div>;
  const list = (d.data?.zoho || []).map(c => ({ ...c, saved: saved.get(c.customerId) || saved.get(`n:${String(c.client).toLowerCase()}`) || null }));
  const shown = list.filter(c => (!q || `${c.client} ${c.branch}`.toLowerCase().includes(q.toLowerCase())) && (only === 'all' || (only === 'missing' ? !c.saved?.endDate : !!c.saved)));
  const ed = c => edit[c.customerId] || { endDate: c.saved?.endDate || c.agreement?.end || '', monthlyRevenue: c.saved?.monthlyRevenue ?? '', escalationPct: c.saved?.escalationPct ?? c.agreement?.increment ?? '', escalationDate: c.saved?.escalationDate || '', source: c.saved?.source || (c.agreement?.end ? `Agreement extract${c.agreement.file ? `: ${c.agreement.file}` : ''}` : '') };
  const set = (c, k, v) => setEdit(e => ({ ...e, [c.customerId]: { ...ed(c), [k]: v } }));
  const save = c => { const x = ed(c); act('client', () => fsApi.saveClients([{ id: c.saved?.id, customerId: c.customerId, client: c.client, branch: c.branch, endDate: x.endDate, monthlyRevenue: rs(x.monthlyRevenue), escalationPct: rs(x.escalationPct), escalationDate: x.escalationDate, source: x.source }]).then(() => `${c.client}: saved.`), [d.reload, onSaved, () => setEdit(e => { const n = { ...e }; delete n[c.customerId]; return n; })]); };
  const withDate = list.filter(c => c.saved?.endDate).length;

  return <Card title={`Client end dates — ${withDate} of ${list.length} clients have an end date`} right={<>
    <button style={S.btn('outline')} onClick={() => fsApi.download('/budget/clients/template', {}, 'Client_end_dates.xlsx').catch(e => alert(errText(e)))}><Download size={14} />Excel format (prefilled)</button>
    {can && <FileButton label="Upload filled format" onFile={f => act('upc', () => fsApi.uploadClients(f).then(r => `${r.saved} client row(s) saved from ${f.name}.`), [d.reload, onSaved])} />}
  </>}>
    <div style={{ ...S.small, marginBottom: 8 }}>Every client billed in Zoho in the last 12 months, with the billing in {mLabel(base || d.data?.base)} before GST. Revenue is budgeted until the agreement end date (the last month is pro-rated by day). Where a client agreement has already been read by the dashboard, its end date and increment are offered — check them and save. A monthly amount replaces the current billing (for example a renewal at a new fee); escalation applies from the date given and every 12 months after. Download the format, fill the end dates, and upload it back, or edit here.</div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
      <select style={S.select} value={only} onChange={e => setOnly(e.target.value)}><option value="missing">Without a saved end date</option><option value="saved">Saved</option><option value="all">All clients</option></select>
      <input style={{ ...S.input, width: 240 }} placeholder="Search client or branch…" value={q} onChange={e => setQ(e.target.value)} />
    </div>
    <Tbl head={['Client', 'Branch', `Billing ${mLabel(base || d.data?.base)} (₹)`, 'From agreement', 'End date *', 'Monthly amount (₹)', 'Escalation %', 'Escalation from', 'Source *', '']} num={[2]} maxHeight={600}>
      {shown.slice(0, limit).map(c => { const x = ed(c); return <tr key={c.customerId}>
        <td style={{ ...S.td, minWidth: 180 }}>{c.client}{c.saved && <div style={{ fontSize: '0.64rem', color: C.good }}>saved by {c.saved.by} {c.saved.at?.slice(0, 10)}</div>}</td>
        <td style={{ ...S.td, fontSize: '0.72rem' }}>{c.branch}</td>
        <td style={{ ...S.td, ...S.num }}>{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(c.currentMonthly || 0)}</td>
        <td style={{ ...S.td, fontSize: '0.68rem', color: C.ink2 }}>{c.agreement ? <>{c.agreement.start ? `${c.agreement.start} → ` : ''}{c.agreement.end || 'no end date'}{c.agreement.increment ? ` · ${c.agreement.increment}%` : ''}</> : '—'}</td>
        <td style={S.td}><input type="date" disabled={!can} style={S.input} value={x.endDate || ''} onChange={e => set(c, 'endDate', e.target.value)} /></td>
        <td style={S.td}><input type="number" disabled={!can} style={{ ...S.input, width: 110 }} placeholder="current" value={x.monthlyRevenue ?? ''} onChange={e => set(c, 'monthlyRevenue', e.target.value)} /></td>
        <td style={S.td}><input type="number" step="any" disabled={!can} style={{ ...S.input, width: 70 }} value={x.escalationPct ?? ''} onChange={e => set(c, 'escalationPct', e.target.value)} /></td>
        <td style={S.td}><input type="date" disabled={!can} style={S.input} value={x.escalationDate || ''} onChange={e => set(c, 'escalationDate', e.target.value)} /></td>
        <td style={S.td}><input disabled={!can} style={{ ...S.input, width: 160 }} placeholder="agreement / email ref." value={x.source || ''} onChange={e => set(c, 'source', e.target.value)} /></td>
        <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{can && <button style={S.btn(edit[c.customerId] ? 'primary' : 'outline')} onClick={() => save(c)}>Save</button>}
          {can && c.saved && <button style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.bad }} title="Remove the saved end date" onClick={() => act('delc', () => fsApi.deleteClient(c.saved.id).then(() => 'Removed.'), [d.reload, onSaved])}><Trash2 size={13} /></button>}</td>
      </tr>; })}
    </Tbl>
    {shown.length > limit && <button style={{ ...S.btn('outline'), marginTop: 8 }} onClick={() => setLimit(l => l + 200)}>Show more ({shown.length - limit} left)</button>}
    {(d.data?.items || []).filter(x => !list.some(c => c.customerId === x.customerId)).length > 0 && <Note>Also saved (clients with no billing in the last 12 months — budgeted only when a monthly amount is given): {(d.data.items || []).filter(x => !list.some(c => c.customerId === x.customerId)).map(x => `${x.client} (${x.endDate || 'no end'}${x.monthlyRevenue ? `, ₹${x.monthlyRevenue}/month` : ''})`).join('; ')}</Note>}
    {can && <NewClient act={act} onSaved={() => { d.reload(); onSaved(); }} />}
  </Card>;
}
function NewClient({ act, onSaved }) {
  const [x, setX] = useState({ client: '', branch: '', startDate: '', endDate: '', monthlyRevenue: '', escalationPct: '', escalationDate: '', source: '' });
  const set = (k, v) => setX(o => ({ ...o, [k]: v }));
  return <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 12, paddingTop: 10 }}>
    <div style={{ ...S.h2, fontSize: '0.82rem' }}>New client (not billed yet)</div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <Field label="Client *"><input style={{ ...S.input, width: 200 }} value={x.client} onChange={e => set('client', e.target.value)} /></Field>
      <Field label="Branch"><input style={{ ...S.input, width: 120 }} value={x.branch} onChange={e => set('branch', e.target.value)} /></Field>
      <Field label="Start date *"><input type="date" style={S.input} value={x.startDate} onChange={e => set('startDate', e.target.value)} /></Field>
      <Field label="End date"><input type="date" style={S.input} value={x.endDate} onChange={e => set('endDate', e.target.value)} /></Field>
      <Field label="Monthly amount ₹ (before GST) *"><input type="number" style={{ ...S.input, width: 130 }} value={x.monthlyRevenue} onChange={e => set('monthlyRevenue', e.target.value)} /></Field>
      <Field label="Escalation %"><input type="number" step="any" style={{ ...S.input, width: 70 }} value={x.escalationPct} onChange={e => set('escalationPct', e.target.value)} /></Field>
      <Field label="Escalation from"><input type="date" style={S.input} value={x.escalationDate} onChange={e => set('escalationDate', e.target.value)} /></Field>
      <Field label="Source *"><input style={{ ...S.input, width: 160 }} value={x.source} onChange={e => set('source', e.target.value)} /></Field>
      <button style={S.btn('primary')} onClick={() => { if (!x.startDate || rs(x.monthlyRevenue) == null) { alert('A new client needs a start date and a monthly amount.'); return; } act('newc', () => fsApi.saveClients([{ ...x, monthlyRevenue: rs(x.monthlyRevenue), escalationPct: rs(x.escalationPct) }]).then(() => `${x.client}: added to the budget.`), [onSaved, () => setX({ client: '', branch: '', startDate: '', endDate: '', monthlyRevenue: '', escalationPct: '', escalationDate: '', source: '' })]); }}><Plus size={14} />Add</button>
    </div>
  </div>;
}

// ── rent agreement end dates ─────────────────────────────────────────────────
function RentEndDates({ can, act, onSaved }) {
  const d = useLoad(() => fsApi.rent(), []);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState({});
  if (d.loading && !d.data) return <Loading text="Reading the Rent Recurring Module…" />;
  if (d.error) return <div style={{ ...S.card, color: C.bad }}>{d.error}</div>;
  const ag = (d.data?.agreements || []).filter(a => !q || `${a.branch} ${a.vendor} ${a.office}`.toLowerCase().includes(q.toLowerCase()));
  const ed = a => edit[a.key] || { endDate: a.override?.endDate || '', monthlyRent: a.override?.monthlyRent ?? '', source: a.override?.source || '', note: a.override?.note || '' };
  const set = (a, k, v) => setEdit(e => ({ ...e, [a.key]: { ...ed(a), [k]: v } }));
  const save = a => { const x = ed(a); act('rent', () => fsApi.saveRent([{ key: a.key, endDate: x.endDate, monthlyRent: rs(x.monthlyRent), source: x.source, note: x.note }]).then(() => `${a.branch} / ${a.vendor}: saved.`), [d.reload, onSaved, () => setEdit(e => { const n = { ...e }; delete n[a.key]; return n; })]); };
  const today = new Date().toISOString().slice(0, 10);
  return <Card title={`Rent agreements (${(d.data?.agreements || []).length})`} right={<>
    <button style={S.btn('outline')} onClick={() => fsApi.download('/budget/rent/template', {}, 'Rent_agreement_end_dates.xlsx').catch(e => alert(errText(e)))}><Download size={14} />Excel format (prefilled)</button>
    {can && <FileButton label="Upload filled format" onFile={f => act('upr', () => fsApi.uploadRent(f).then(r => `${r.saved} agreement row(s) saved from ${f.name}.`), [d.reload, onSaved])} />}
  </>}>
    <div style={{ ...S.small, marginBottom: 8 }}>From {d.data?.file ? `"${d.data.file}"` : 'the Rent Recurring Module'} (one row per branch, landlord and office). Rent is budgeted at the current module amount, with the agreed increment on its date and every 12 months after, until the end date — the one you give here, otherwise the agreement end in the Rent module. A monthly rent here replaces the module amount. Branches that have Zoho rent bills but are not in the module are flagged on the budget.</div>
    {d.data?.error && <Note tone="warn">{d.data.error}</Note>}
    <input style={{ ...S.input, width: 260, marginBottom: 10 }} placeholder="Search branch, landlord, office…" value={q} onChange={e => setQ(e.target.value)} />
    <Tbl head={['Branch', 'Landlord', 'Office', 'Agreement (Rent module)', 'Current module rent (₹/month)', 'Increment', 'End date to use', 'Monthly rent to use (₹)', 'Source', '']} num={[4]} maxHeight={600}>
      {ag.map(a => { const x = ed(a); const end = x.endDate || a.agrEnd; return <tr key={a.key}>
        <td style={S.td}>{a.branch}</td><td style={{ ...S.td, minWidth: 160 }}>{a.vendor}</td><td style={{ ...S.td, fontSize: '0.72rem' }}>{a.office}</td>
        <td style={{ ...S.td, fontSize: '0.72rem', whiteSpace: 'nowrap', color: end && end < today ? C.bad : C.ink }}>{a.agrStart || '?'} → {a.agrEnd || <span style={{ color: C.warn }}>no end date</span>}</td>
        <td style={{ ...S.td, ...S.num }}>{a.last?.amount ? new Intl.NumberFormat('en-IN').format(a.last.amount) : ''}</td>
        <td style={{ ...S.td, fontSize: '0.7rem' }}>{a.last?.incPct ? `${Math.round(a.last.incPct * 1000) / 10}% on ${a.last.incOn || '—'}` : ''}</td>
        <td style={S.td}><input type="date" disabled={!can} style={S.input} value={x.endDate || ''} onChange={e => set(a, 'endDate', e.target.value)} /></td>
        <td style={S.td}><input type="number" disabled={!can} style={{ ...S.input, width: 110 }} placeholder="module" value={x.monthlyRent ?? ''} onChange={e => set(a, 'monthlyRent', e.target.value)} /></td>
        <td style={S.td}><input disabled={!can} style={{ ...S.input, width: 150 }} placeholder="agreement ref." value={x.source || ''} onChange={e => set(a, 'source', e.target.value)} /></td>
        <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{can && <button style={S.btn(edit[a.key] ? 'primary' : 'outline')} onClick={() => save(a)}>Save</button>}
          {can && a.override && <button style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.bad }} title="Back to the Rent module end date" onClick={() => act('delr', () => fsApi.deleteRent(a.key).then(() => 'Removed.'), [d.reload, onSaved])}><Trash2 size={13} /></button>}</td>
      </tr>; })}
    </Tbl>
    {(d.data?.overrides || []).filter(o => /\|\*$/.test(o.key)).length > 0 && <Note>Branch-wide end dates: {(d.data.overrides || []).filter(o => /\|\*$/.test(o.key)).map(o => `${o.key.replace('|*', '')} → ${o.endDate || '—'}`).join('; ')}</Note>}
    {can && <BranchWideRent act={act} onSaved={() => { d.reload(); onSaved(); }} />}
  </Card>;
}
function BranchWideRent({ act, onSaved }) {
  const [x, setX] = useState({ branch: '', endDate: '', monthlyRent: '', source: '' });
  return <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 12, paddingTop: 10 }}>
    <div style={{ ...S.h2, fontSize: '0.82rem' }}>End date for a branch with Zoho rent bills but no Rent module row</div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <Field label="Branch (as in Zoho) *"><input style={{ ...S.input, width: 160 }} value={x.branch} onChange={e => setX(o => ({ ...o, branch: e.target.value }))} /></Field>
      <Field label="End date"><input type="date" style={S.input} value={x.endDate} onChange={e => setX(o => ({ ...o, endDate: e.target.value }))} /></Field>
      <Field label="Monthly rent ₹ (optional)"><input type="number" style={{ ...S.input, width: 120 }} value={x.monthlyRent} onChange={e => setX(o => ({ ...o, monthlyRent: e.target.value }))} /></Field>
      <Field label="Source *"><input style={{ ...S.input, width: 160 }} value={x.source} onChange={e => setX(o => ({ ...o, source: e.target.value }))} /></Field>
      <button style={S.btn('primary')} onClick={() => act('rentw', () => fsApi.saveRent([{ key: `${x.branch.trim()}|*`, endDate: x.endDate, monthlyRent: rs(x.monthlyRent), source: x.source }]).then(() => `${x.branch}: saved.`), [onSaved])}>Save</button>
    </div>
  </div>;
}

// ── manual lines ─────────────────────────────────────────────────────────────
function ManualLines({ cur, grid, can, act }) {
  const heads = useMemo(() => (grid.data?.rows || []).filter(r => r.section === 'expense' && !r.meta?.manual).map(r => ({ id: r.head, label: r.label })), [grid.data]);
  const blank = { section: 'expense', head: '', label: '', branch: '', from: grid.data?.months?.[0] || '', to: '', monthly: '', growthPct: '', note: '', scope: 'version' };
  const [x, setX] = useState(blank);
  const set = (k, v) => setX(o => ({ ...o, [k]: v }));
  const lines = (grid.data?.rows || []).filter(r => r.meta?.manual);
  const save = () => act('man', () => fsApi.budgetLine({ ...x, versionId: x.scope === 'all' ? null : cur.id, monthly: rs(x.monthly), growthPct: rs(x.growthPct) || 0 }).then(() => 'Manual line added.'), [grid.reload, () => setX(blank)]);
  return <Card title="Manual lines">
    <div style={{ ...S.small, marginBottom: 8 }}>Add any amount the projection cannot know: a new branch's expenses, a planned hire, a one-off cost or income. Amounts in ₹ per month, from the start month to the end month (blank = to the end of the budget), with an optional yearly growth. An expense line is reported under the head you choose.</div>
    {can && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
      <Field label="Section"><select style={S.select} value={x.section} onChange={e => set('section', e.target.value)}><option value="expense">Expense</option><option value="revenue">Revenue</option><option value="other_income">Other income</option></select></Field>
      {x.section === 'expense' && <Field label="Expense head"><select style={S.select} value={x.head} onChange={e => set('head', e.target.value)}><option value="">Other expenses</option>{heads.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}</select></Field>}
      <Field label="Description *"><input style={{ ...S.input, width: 220 }} value={x.label} onChange={e => set('label', e.target.value)} /></Field>
      <Field label="Branch"><input style={{ ...S.input, width: 110 }} value={x.branch} onChange={e => set('branch', e.target.value)} /></Field>
      <Field label="From month *"><input type="month" style={S.input} value={x.from} onChange={e => set('from', e.target.value)} /></Field>
      <Field label="To month"><input type="month" style={S.input} value={x.to} onChange={e => set('to', e.target.value)} /></Field>
      <Field label="Monthly amount ₹ *"><input type="number" style={{ ...S.input, width: 120 }} value={x.monthly} onChange={e => set('monthly', e.target.value)} /></Field>
      <Field label="Growth % a year"><input type="number" step="any" style={{ ...S.input, width: 80 }} value={x.growthPct} onChange={e => set('growthPct', e.target.value)} /></Field>
      <Field label="Note"><input style={{ ...S.input, width: 160 }} value={x.note} onChange={e => set('note', e.target.value)} /></Field>
      <Field label="Applies to"><select style={S.select} value={x.scope} onChange={e => set('scope', e.target.value)}><option value="version">This version</option><option value="all">All versions</option></select></Field>
      <button style={S.btn('primary')} onClick={save}><Plus size={14} />Add line</button>
    </div>}
    {!lines.length ? <div style={S.small}>No manual lines.</div> : <Tbl head={['Section', 'Line', 'From', 'To', 'Monthly (₹)', 'Growth', 'Total (₹ lakh)', 'Added by', '']} num={[4, 6]}>
      {lines.map(r => <tr key={r.id}><td style={S.td}>{SECTIONS.find(s => s[0] === r.section)?.[1]}</td><td style={S.td}>{r.label}{r.meta.note ? <div style={S.small}>{r.meta.note}</div> : null}</td><td style={S.td}>{mLabel(r.meta.from)}</td><td style={S.td}>{r.meta.to ? mLabel(r.meta.to) : 'budget end'}</td>
        <td style={{ ...S.td, ...S.num }}>{inrTxt(r.meta.monthly)}</td><td style={S.td}>{r.meta.growthPct ? `${r.meta.growthPct}%` : ''}</td><td style={{ ...S.td, ...S.num }}>{L(r.total)}</td><td style={{ ...S.td, fontSize: '0.7rem' }}>{r.meta.by} {r.meta.at?.slice(0, 10)}</td>
        <td style={S.td}>{can && <button style={{ border: 'none', background: 'none', cursor: 'pointer', color: C.bad }} onClick={() => act('delm', () => fsApi.deleteBudgetLine(r.id.replace(/^man:/, '')).then(() => 'Line removed.'), [grid.reload])}><Trash2 size={13} /></button>}</td></tr>)}
    </Tbl>}
  </Card>;
}

// ── settings and Zoho history ────────────────────────────────────────────────
function BudgetSettings({ cur, grid, can, act, reloadAll, categories }) {
  const [st, setSt] = useState(cur.settings || {});
  useEffect(() => { setSt(cur.settings || {}); }, [cur.id, cur.settings]);
  const hist = useLoad(() => fsApi.budgetHistory(st.baseMonth), [st.baseMonth]);
  const set = (k, v) => setSt(o => ({ ...o, [k]: v }));
  const excl = new Set(st.excludeCategories || []);
  const running = Object.values(hist.data?.prefetch || {}).some(p => p?.running);
  return <>
    <Card title="Settings" right={can && <button style={S.btn('primary')} onClick={() => act('set', () => fsApi.saveBudget(cur.id, { settings: st }).then(() => 'Settings saved — the budget is built again.'), [reloadAll])}>Save settings</button>}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Budget from"><input type="month" disabled={!can} style={S.input} value={st.from || ''} onChange={e => set('from', e.target.value)} /></Field>
        <Field label="Budget to"><input type="month" disabled={!can} style={S.input} value={st.to || ''} onChange={e => set('to', e.target.value)} /></Field>
        <Field label="Base month (last actual month)"><input type="month" disabled={!can} style={S.input} value={st.baseMonth || ''} onChange={e => set('baseMonth', e.target.value)} /></Field>
        <Field label="Client revenue run-rate"><select disabled={!can} style={S.select} value={st.revenueBasis || 'last'} onChange={e => set('revenueBasis', e.target.value)}><option value="last">Base month billing</option><option value="avg3">Average of the last 3 months</option></select></Field>
        <Field label="Client without an end date"><select disabled={!can} style={S.select} value={st.noEndDate || 'continue'} onChange={e => set('noEndDate', e.target.value)}><option value="continue">Project to the budget end</option><option value="stop">Do not project</option></select></Field>
        <Field label="Default expense method"><select disabled={!can} style={S.select} value={st.defaultMethod || 'trend'} onChange={e => set('defaultMethod', e.target.value)}>{Object.entries(METHOD_LABEL).filter(([k]) => k !== 'debt').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Trend limit (± % of 12-month average)"><input type="number" disabled={!can} style={{ ...S.input, width: 90 }} value={st.trendCap == null ? '' : Math.round(st.trendCap * 100)} onChange={e => set('trendCap', e.target.value === '' ? null : Number(e.target.value) / 100)} /></Field>
        <label style={{ ...S.small, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" disabled={!can} checked={st.financeFromDebt !== false} onChange={e => set('financeFromDebt', e.target.checked)} />Loan interest from the debt schedule (when entered)</label>
      </div>
      {categories.length > 0 && <div style={{ marginTop: 12 }}>
        <div style={{ ...S.small, fontWeight: 600, marginBottom: 4 }}>Invoice categories left out of revenue (e.g. reimbursements, deposits)</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{categories.map(c => <label key={c} style={{ ...S.small, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" disabled={!can} checked={excl.has(c)} onChange={e => set('excludeCategories', e.target.checked ? [...excl, c] : [...excl].filter(x => x !== c))} />{c}</label>)}</div>
      </div>}
      <div style={{ ...S.small, marginTop: 10 }}>The trend is a straight line through the last 12 months of each head, held within the limit around the 12-month average so a few unusual months cannot run away. Per-head methods are chosen on the budget lines.</div>
    </Card>
    <Card title="Zoho history behind the expense projection" right={<button style={S.btn('outline')} onClick={hist.reload}><RefreshCw size={14} />Refresh</button>}>
      {hist.loading && !hist.data ? <Loading /> : hist.error ? <div style={{ color: C.bad, fontSize: '0.8rem' }}>{hist.error}</div> : <>
        <div style={{ ...S.small, marginBottom: 8 }}>Months {mLabel(hist.data?.base)} and the 11 before it are read from the Zoho account transactions the Branch P&L keeps per financial year. A year that has not been fetched counts as nil.</div>
        <Tbl head={['Financial year', 'Accounts in the cache', 'Not fetched yet', 'Oldest fetch', 'Fetch', '']} num={[1, 2]} maxHeight={240}>
          {Object.entries(hist.data?.coverage || {}).map(([fy, c]) => { const p = hist.data.prefetch?.[fy]; return <tr key={fy}><td style={S.td}>FY {fy}</td><td style={{ ...S.td, ...S.num }}>{c.accountsFound}</td><td style={{ ...S.td, ...S.num, color: c.accountsMissing ? C.warn : C.ink }}>{c.accountsMissing}</td><td style={S.td}>{c.fetchedAt ? new Date(c.fetchedAt).toLocaleString('en-IN') : '—'}</td>
            <td style={{ ...S.td, fontSize: '0.72rem' }}>{p?.running ? `fetching… ${p.done} of ${p.total}` : p?.completed_at ? `last run ${new Date(p.completed_at).toLocaleString('en-IN')}: ${p.done} of ${p.total}${p.stopped_early ? ' (stopped at the time limit — run again)' : ''}` : ''}</td>
            <td style={S.td}>{can && <button style={S.btn(c.accountsMissing ? 'primary' : 'outline')} disabled={!!p?.running} onClick={() => { if (window.confirm(`Fetch the account transactions of FY ${fy} from Zoho? This uses about ${c.accountsFound + c.accountsMissing} Zoho calls and runs in the background (one account every half second).`)) act('fetch', () => fsApi.fetchHistory(fy).then(r => r.message || 'Started.'), [hist.reload]); }}>{c.accountsMissing ? 'Fetch from Zoho' : 'Fetch again'}</button>}</td></tr>; })}
        </Tbl>
        {running && <div style={{ ...S.small, marginTop: 6 }}>A fetch is running. Refresh this list to follow it; "Recompute" the budget when it has finished.</div>}
      </>}
      <div style={{ ...S.small, marginTop: 10 }}>The history window moves with the "Base month" setting.</div>
    </Card>
  </>;
}

// ── budget vs actual for a statement period (CFO Overview, Financial Performance) ─────────────────────────────────
const INCOME_LINES = new Set(['pl.rev', 'pl.oth_inc', 'pl.tot_inc', 'm.ebitda']);
export function BudgetVsActual({ F, period, goValidation }) {
  const d = useLoad(() => (period ? fsApi.budgetVsActual({ version: F.budget || undefined, period, basis: F.basis, mode: F.mode }) : Promise.resolve(null)), [F.budget, period, F.basis, F.mode]);
  if (d.loading) return <Loading />;
  if (d.error) return <Note tone="warn">{/No budget version/.test(d.error) ? 'No budget version yet.' : d.error} Budgets are built on Data Validation & Reconciliation → Budget.{goValidation && <> <button style={S.btn('outline')} onClick={goValidation}>Open</button></>}</Note>;
  const x = d.data;
  if (!x) return null;
  if (!x.covered) return <Note tone="warn">The budget "{x.version.name}" does not cover all of {x.period.label} (missing {x.missingMonths.map(mLabel).join(', ')}). Budget vs actual is shown only for periods the budget covers in full — choose a version whose "Budget from" starts at or before {mLabel(x.period.start.slice(0, 7))}.</Note>;
  return <>
    <Tbl head={['Line', 'Budget', 'Actual', 'Variance', '']} num={[1, 2, 3]} maxHeight={400}>
      {x.rows.map(r => { const v = r.actual == null ? null : r.actual - r.budget; const fav = v == null ? null : INCOME_LINES.has(r.id) ? v >= 0 : v <= 0;
        return <tr key={r.id} style={{ fontWeight: r.id === 'm.ebitda' ? 700 : 400 }}><td style={S.td}>{r.label}</td><td style={{ ...S.td, ...S.num }}>{fmtAmt(r.budget, F.unit)}</td><td style={{ ...S.td, ...S.num }}>{r.actual == null ? 'n/a' : fmtAmt(r.actual, F.unit)}</td>
          <td style={{ ...S.td, ...S.num, color: fav == null ? C.ink : fav ? C.good : C.bad }}>{v == null ? '' : `${fmtAmt(v, F.unit)}${r.budget ? ` (${(v / Math.abs(r.budget) * 100).toFixed(1)}%)` : ''}`}</td><td style={{ ...S.td, fontSize: '0.7rem', color: fav == null ? C.ink2 : fav ? C.good : C.bad }}>{fav == null ? '' : fav ? 'favourable' : 'adverse'}</td></tr>; })}
    </Tbl>
    <div style={{ ...S.small, marginTop: 6 }}>Budget "{x.version.name}"{x.version.frozen ? ' (frozen)' : ''}, {x.period.label}. {x.note}</div>
  </>;
}
