import React, { useEffect, useMemo, useState } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from 'recharts';
import { Plus, Trash2, Download, RefreshCw, Edit3, Wand2 } from 'lucide-react';
import { fsApi, errText } from './api';
import { C, S, Card, Note, Badge, Loading, fmtAmt, useLoad } from './ui';
import { mLabel, Pills, FileButton, Field, Tbl } from './BudgetSection';

// Branch master, collections & payments forecast, debt schedule & covenants (Data Validation & Reconciliation).
const L = v => fmtAmt(v, 'lakh');
const lakhOfRs = v => (v == null ? '' : fmtAmt(v / 1e5, 'lakh'));
const rs = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const del = { border: 'none', background: 'none', cursor: 'pointer', color: C.bad };
const useAct = flash => {
  const [busy, setBusy] = useState('');
  const act = async (label, fn, after = []) => {
    setBusy(label);
    try { const r = await fn(); flash(typeof r === 'string' ? r : 'Saved.'); for (const a of after) a(); } catch (e) { flash(errText(e)); }
    setBusy('');
  };
  return [busy, act];
};

// ══ Branch master ════════════════════════════════════════════════════════════
const STATUSES = ['Operational', 'Under fit-out', 'Closed'];
const LAYOUT = [['Branch', ['name', 'status', 'model', 'zone']], ['Location', ['city', 'state', 'address']], ['Area & seats', ['superBuiltUp', 'carpet', 'seats']], ['Dates', ['expenseStart', 'revenueStart']], ['', ['source']]];

export function BranchMasterSection({ rights, flash }) {
  const can = !!rights?.inputs;
  const d = useLoad(() => fsApi.branches(), []);
  const [, act] = useAct(flash);
  const [form, setForm] = useState(null);
  const [q, setQ] = useState('');
  if (d.loading && !d.data) return <Loading text="Loading the branch master…" />;
  if (d.error) return <div style={{ ...S.card, color: C.bad }}>{d.error}</div>;
  const fields = Object.fromEntries((d.data.fields || []).map(f => [f.key, f]));
  const items = d.data.items || [], sug = d.data.suggestions || [];
  const all = [...items, ...sug].filter(b => !q || `${b.name} ${b.city} ${b.state}`.toLowerCase().includes(q.toLowerCase()));
  const save = draft => act('br', () => fsApi.saveBranches([form], draft).then(() => `${form.name}: saved${draft ? ' as a draft' : ''}.`), [d.reload, () => setForm(null)]);
  const input = k => {
    const f = fields[k]; if (!f) return null;
    const v = form[k] ?? '';
    const set = x => setForm(o => ({ ...o, [k]: x }));
    const label = `${f.label.replace(/ \(.*\)$/, '')}${f.required ? ' *' : ''}`;
    if (k === 'model') return <Field key={k} label={label}><select style={S.select} value={v} onChange={e => set(e.target.value)}><option value="">—</option>{d.data.models.map(m => <option key={m}>{m}</option>)}</select></Field>;
    if (k === 'zone') return <Field key={k} label={label}><select style={S.select} value={v} onChange={e => set(e.target.value)}><option value="">—</option>{d.data.zones.map(m => <option key={m}>{m}</option>)}</select></Field>;
    if (k === 'status') return <Field key={k} label={label}><select style={S.select} value={v} onChange={e => set(e.target.value)}><option value="">—</option>{STATUSES.map(m => <option key={m}>{m}</option>)}</select></Field>;
    if (f.type === 'date') return <Field key={k} label={label}><input type="date" style={S.input} value={v} onChange={e => set(e.target.value)} /></Field>;
    if (f.type === 'number') return <Field key={k} label={label}><input type="number" style={{ ...S.input, width: 120 }} value={v} onChange={e => set(e.target.value)} /></Field>;
    return <Field key={k} label={label}><input style={{ ...S.input, width: k === 'address' ? 380 : k === 'source' ? 420 : 180 }} value={v} onChange={e => set(e.target.value)} /></Field>;
  };
  const missingOf = b => (b.suggested ? ['not saved'] : b.missing || []);

  return <Card title={`Branch master — ${items.length} saved${sug.length ? `, ${sug.length} suggested` : ''}`} right={<>
    <button style={S.btn('outline')} onClick={() => fsApi.download('/branches/template', {}, 'Branch_master.xlsx').catch(e => alert(errText(e)))}><Download size={14} />Excel format (prefilled)</button>
    {can && <FileButton label="Upload filled format" onFile={f => act('upb', () => fsApi.uploadBranches(f).then(r => `${r.saved} branch(es) saved from ${f.name}.${r.errors?.length ? ` Rows not saved: ${r.errors.join('; ')}` : ''}`), [d.reload])} />}
    {can && <button style={S.btn('primary')} onClick={() => setForm({ name: '' })}><Plus size={14} />New branch</button>}
  </>}>
    <div style={{ ...S.small, marginBottom: 8 }}>One row per centre. Seats and super built-up area feed the per-seat and per-sq-ft figures in Ratio Analytics from the branch's revenue start date (expense start date if there is no revenue start date), unless that branch has its own rows under Management Inputs → Branch seats, occupancy & area. Suggested rows come from the branch list, the Finance Overview capacity and the Rent Recurring Module; nothing is saved until you review and save them.</div>
    {form && <div style={{ border: `1px solid ${C.green}`, borderRadius: 8, padding: 12, marginBottom: 12, background: C.page }}>
      {LAYOUT.map(([h, keys]) => <div key={h || 'x'} style={{ marginBottom: 8 }}>{h && <div style={{ ...S.small, fontWeight: 700, color: C.green, marginBottom: 4 }}>{h}</div>}<div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{keys.map(input)}</div></div>)}
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={S.btn('primary')} onClick={() => save(false)}>Save</button>
        <button style={S.btn('outline')} onClick={() => save(true)} title="Keep the row although required fields are still empty">Save as draft</button>
        <button style={S.btn('outline')} onClick={() => setForm(null)}>Cancel</button>
      </div>
    </div>}
    <input style={{ ...S.input, width: 240, marginBottom: 10 }} placeholder="Search branch, city, state…" value={q} onChange={e => setQ(e.target.value)} />
    <Tbl head={['Branch', 'City / state', 'Model', 'Zone', 'Super built-up (sq ft)', 'Carpet (sq ft)', 'Seats', 'Expense start', 'Revenue start', 'Status', 'Complete?', '']} num={[4, 5, 6]} maxHeight={640}>
      {all.map(b => { const miss = missingOf(b); return <tr key={b.id || `s:${b.name}`} style={{ opacity: b.suggested ? 0.75 : 1 }}>
        <td style={{ ...S.td, fontWeight: 600 }}>{b.name}{b.suggested && <div style={{ fontSize: '0.64rem', color: C.info, fontWeight: 400 }}>suggested — {b.source}</div>}{b.address && <div style={{ fontSize: '0.66rem', color: C.ink2, fontWeight: 400 }}>{b.address}</div>}</td>
        <td style={S.td}>{[b.city, b.state].filter(Boolean).join(', ')}</td><td style={{ ...S.td, fontSize: '0.72rem' }}>{b.model || ''}</td><td style={S.td}>{b.zone || ''}</td>
        <td style={{ ...S.td, ...S.num }}>{b.superBuiltUp != null ? new Intl.NumberFormat('en-IN').format(b.superBuiltUp) : ''}</td><td style={{ ...S.td, ...S.num }}>{b.carpet != null ? new Intl.NumberFormat('en-IN').format(b.carpet) : ''}</td><td style={{ ...S.td, ...S.num }}>{b.seats ?? ''}</td>
        <td style={S.td}>{b.expenseStart || ''}</td><td style={S.td}>{b.revenueStart || ''}</td><td style={S.td}>{b.status || ''}</td>
        <td style={S.td}>{miss.length ? <Badge status="Missing data" title={miss.join('; ')} /> : <Badge status="OK" />}</td>
        <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{can && <button style={S.btn('outline')} onClick={() => { const { missing, suggested, ...rest } = b; setForm(suggested ? { ...rest, id: undefined } : rest); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><Edit3 size={13} />{b.suggested ? 'Review & save' : 'Edit'}</button>}
          {can && !b.suggested && <button style={del} title="Delete" onClick={() => { if (window.confirm(`Delete ${b.name} from the branch master?`)) act('delb', () => fsApi.deleteBranch(b.id).then(() => 'Deleted.'), [d.reload]); }}><Trash2 size={13} /></button>}</td>
      </tr>; })}
    </Tbl>
  </Card>;
}

// ══ Collections & payments forecast ═════════════════════════════════════════
export function ForecastSection({ rights, flash }) {
  const can = !!rights?.inputs;
  const [version, setVersion] = useState('');
  const [months, setMonths] = useState('');
  const d = useLoad(() => fsApi.forecast(version || undefined, months || undefined), [version, months]);
  const [, act] = useAct(flash);
  const [view, setView] = useState('table');
  const f = d.data;
  if (d.loading && !f) return <Loading text="Reading 12 months of Zoho payments and building the forecast…" />;
  if (d.error) return <div style={{ ...S.card, color: C.bad }}>{d.error}</div>;
  if (!f) return null;
  const inKinds = [...new Set(f.table.flatMap(r => Object.keys(r.ins)))], outKinds = [...new Set(f.table.flatMap(r => Object.keys(r.outs)))];
  const sum = k => f.table.reduce((s, r) => s + (r[k] || 0), 0);
  const low = f.table.filter(r => r.closing != null).sort((a, b) => a.closing - b.closing)[0];
  const chart = f.table.map(r => ({ name: mLabel(r.month), Collections: r.totalIn, Payments: r.totalOut, 'Closing balance': r.closing }));
  const tick = { fontSize: 11, fill: C.ink2 };
  const Tile = ({ label, value, sub, tone }) => <div style={{ flex: '1 1 170px', border: `1px solid ${C.line}`, borderRadius: 8, padding: '10px 12px' }}><div style={{ ...S.small, fontWeight: 600 }}>{label}</div><div style={{ fontSize: '1.15rem', fontWeight: 700, color: tone || C.ink }}>{value}</div>{sub && <div style={{ fontSize: '0.66rem', color: C.ink2 }}>{sub}</div>}</div>;

  return <div>
    <Card title="Collections & payments forecast (₹ lakh)" right={<>
      <select style={S.select} value={version || f.budget?.id || ''} onChange={e => setVersion(e.target.value)}>{!f.versions.length && <option value="">No budget yet — open invoices and bills only</option>}{f.versions.map(v => <option key={v.id} value={v.id}>Budget: {v.name}</option>)}</select>
      <select style={S.select} value={months || f.months.length} onChange={e => setMonths(e.target.value)}>{[6, 12, 18, 24].map(n => <option key={n} value={n}>{n} months</option>)}</select>
      <button style={S.btn('outline')} onClick={d.reload}><RefreshCw size={14} />Recompute</button>
    </>}>
      <div style={{ ...S.small, marginBottom: 10 }}>Collections: for each client, the days between invoice date and payment over the last 12 months in Zoho give a median; open invoices are expected on invoice date + that median, and future billing from the budget is invoiced on the client's usual invoice day and collected after the same median, with GST added and the client's usual TDS deducted. Payments: open bills after each vendor's median days to pay; rent on the agreement's payment day at the landlord's billed amount after TDS; other budget expenses after a lag per head; debt service on the schedule's due dates; plus manual lines.</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Tile label="Opening cash" value={f.opening ? L(f.opening.amount) : '—'} sub={f.opening ? `${f.opening.source === 'entered' ? 'entered' : 'from the balance sheet'} as at ${f.opening.asAt}` : 'enter it below'} />
        <Tile label={`Collections, ${f.months.length} months`} value={L(sum('totalIn'))} />
        <Tile label={`Payments, ${f.months.length} months`} value={L(sum('totalOut'))} />
        <Tile label="Net" value={L(sum('net'))} tone={sum('net') < 0 ? C.bad : C.good} />
        {low && <Tile label="Lowest month-end balance" value={L(low.closing)} sub={mLabel(low.month)} tone={low.closing < 0 ? C.bad : C.ink} />}
      </div>
      {f.opening && f.opening.source !== 'entered' && <Note tone="warn">Opening cash is the {f.opening.source}. Enter today's bank balance under "Settings" for a usable forecast.</Note>}
      {f.table.some(r => r.gap) && <Note tone="warn">The balance goes below zero in {f.table.filter(r => r.gap).map(r => mLabel(r.month)).join(', ')}.</Note>}
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid stroke="#EEF2F0" vertical={false} />
          <XAxis dataKey="name" tick={tick} axisLine={{ stroke: C.line }} tickLine={false} />
          <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={v => fmtAmt(v, 'lakh', 0)} width={70} />
          <Tooltip formatter={(v, n) => [`${L(v)} ₹ lakh`, n]} contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${C.line}` }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Collections" fill={C.s1} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey="Payments" fill={C.s2} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Line type="monotone" dataKey="Closing balance" stroke={C.green} strokeWidth={2} dot={{ r: 4 }} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </Card>

    <Pills value={view} onChange={setView} items={[['table', 'Monthly'], ['flows', 'Expected receipts & payments'], ['clients', `Client payment patterns (${f.clients.length})`], ['vendors', `Vendor payment patterns (${f.vendors.length})`], ['overdue', 'Overdue'], ['manual', `Manual lines (${f.manual.length})`], ['settings', 'Settings']]} />
    {view === 'table' && <Card title="Month by month (₹ lakh)">
      <Tbl head={['', ...f.months.map(mLabel), 'Total']} num={[...f.months.map((_, i) => i + 1), f.months.length + 1]} maxHeight={640}>
        <tr><td style={{ ...S.td, fontWeight: 700 }}>Opening balance</td>{f.table.map(r => <td key={r.month} style={{ ...S.td, ...S.num }}>{L(r.opening)}</td>)}<td style={S.td} /></tr>
        {inKinds.map(k => <tr key={`i${k}`}><td style={S.td}>{k}</td>{f.table.map(r => <td key={r.month} style={{ ...S.td, ...S.num }}>{L(r.ins[k] || 0)}</td>)}<td style={{ ...S.td, ...S.num }}>{L(f.table.reduce((s, r) => s + (r.ins[k] || 0), 0))}</td></tr>)}
        <tr style={{ background: C.tint }}><td style={{ ...S.td, fontWeight: 700 }}>Total collections</td>{f.table.map(r => <td key={r.month} style={{ ...S.td, ...S.num, fontWeight: 700 }}>{L(r.totalIn)}</td>)}<td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{L(sum('totalIn'))}</td></tr>
        {outKinds.map(k => <tr key={`o${k}`}><td style={S.td}>{k}</td>{f.table.map(r => <td key={r.month} style={{ ...S.td, ...S.num }}>{L(r.outs[k] || 0)}</td>)}<td style={{ ...S.td, ...S.num }}>{L(f.table.reduce((s, r) => s + (r.outs[k] || 0), 0))}</td></tr>)}
        <tr style={{ background: C.tint }}><td style={{ ...S.td, fontWeight: 700 }}>Total payments</td>{f.table.map(r => <td key={r.month} style={{ ...S.td, ...S.num, fontWeight: 700 }}>{L(r.totalOut)}</td>)}<td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{L(sum('totalOut'))}</td></tr>
        <tr><td style={{ ...S.td, fontWeight: 700 }}>Net</td>{f.table.map(r => <td key={r.month} style={{ ...S.td, ...S.num, color: r.net < 0 ? C.bad : C.ink }}>{L(r.net)}</td>)}<td style={{ ...S.td, ...S.num }}>{L(sum('net'))}</td></tr>
        <tr><td style={{ ...S.td, fontWeight: 700 }}>Closing balance</td>{f.table.map(r => <td key={r.month} style={{ ...S.td, ...S.num, fontWeight: 700, color: r.gap ? C.bad : C.ink }}>{r.closing == null ? 'opening cash?' : L(r.closing)}</td>)}<td style={S.td} /></tr>
      </Tbl>
      <div style={{ ...S.small, marginTop: 8 }}>Company medians: clients pay {f.company.clients.medianDays ?? '—'} days after the invoice (GST factor {f.company.clients.gstFactor?.toFixed(3)}, TDS {((f.company.clients.tdsShare || 0) * 100).toFixed(1)}% of receipts); vendors are paid {f.company.vendors.medianDays ?? '—'} days after the bill{f.notes.vendorHistoryFrom ? ` (vendor history from ${f.notes.vendorHistoryFrom})` : ''}. Amounts after the last month shown are left out.</div>
      <div style={{ ...S.small, marginTop: 4 }}>{mLabel(f.months[0])}: budgeted billing is reduced by what each client has already been invoiced this month, and budgeted rent by the rent landlords have already billed ({L(f.notes.rentAlreadyBilled)} ₹ lakh) — those are in the open invoices and bills. Other bills already booked this month ({L(f.notes.billsThisMonth)} ₹ lakh open) are also in the month's budgeted expenses, so part of that may be counted twice.</div>
    </Card>}
    {view === 'flows' && <FlowList f={f} />}
    {view === 'clients' && <PatternTable title="Client payment patterns — last 12 months" rows={f.clients} kind="client" company={f.company.clients} />}
    {view === 'vendors' && <PatternTable title="Vendor payment patterns" rows={f.vendors} kind="vendor" company={f.company.vendors} />}
    {view === 'overdue' && <Card title="Overdue — expected date already passed">
      <div style={{ ...S.small, marginBottom: 8 }}>Invoices past their expected date: {f.settings.overdueCollections === 'aged' ? `expected this month, except those more than ${f.settings.overdueDays ?? 60} days late — doubtful, left out (${L(f.notes.overdueExcludedIn)} ₹ lakh)` : f.settings.overdueCollections === 'exclude' ? `all left out of the forecast (${L(f.notes.overdueExcludedIn)} ₹ lakh)` : 'all expected this month'}. Payments overdue: {f.settings.overduePayments === 'exclude' ? `left out (${L(f.notes.overdueExcludedOut)} ₹ lakh)` : 'counted in the current month'}. Change this under "Settings".</div>
      {[['in', 'Invoices not collected (after TDS)'], ['out', 'Bills not paid']].map(([k, t]) => <div key={k} style={{ marginBottom: 12 }}><div style={{ ...S.h2, fontSize: '0.82rem' }}>{t} — {(f.overdue[k] || []).length} left out</div>
        {!(f.overdue[k] || []).length ? <div style={S.small}>{k === 'in' ? (f.settings.overdueCollections === 'current' ? 'Included in the current month.' : 'None.') : (f.settings.overduePayments === 'exclude' ? 'None.' : 'Included in the current month — see "Overdue bills" in the monthly table.')}</div> :
          <Tbl head={['Party', 'Document', 'Expected by', 'Days late', 'Amount (₹ lakh)']} num={[3, 4]} maxHeight={300}>{f.overdue[k].map((x, i) => <tr key={i}><td style={S.td}>{x.party}</td><td style={S.td}>{x.label}</td><td style={S.td}>{x.date}</td><td style={{ ...S.td, ...S.num }}>{x.daysLate ?? ''}</td><td style={{ ...S.td, ...S.num }}>{L(x.amount)}</td></tr>)}</Tbl>}</div>)}
    </Card>}
    {view === 'manual' && <ForecastManual f={f} can={can} act={act} reload={d.reload} />}
    {view === 'settings' && <ForecastSettings f={f} can={can} act={act} reload={d.reload} />}
  </div>;
}

function FlowList({ f }) {
  const [m, setM] = useState(f.months[0]);
  const [dir, setDir] = useState('in');
  const [q, setQ] = useState('');
  const list = f.flows.filter(x => x.month === m && x.dir === dir && (!q || `${x.party} ${x.label} ${x.kind}`.toLowerCase().includes(q.toLowerCase())));
  return <Card title={`${dir === 'in' ? 'Expected receipts' : 'Expected payments'} — ${mLabel(m)} (${list.length})`}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
      <select style={S.select} value={m} onChange={e => setM(e.target.value)}>{f.months.map(x => <option key={x} value={x}>{mLabel(x)}</option>)}</select>
      <select style={S.select} value={dir} onChange={e => setDir(e.target.value)}><option value="in">Receipts</option><option value="out">Payments</option></select>
      <input style={{ ...S.input, width: 220 }} placeholder="Search party, document…" value={q} onChange={e => setQ(e.target.value)} />
    </div>
    <Tbl head={['Expected on', 'Kind', 'Party', 'Detail', 'Amount (₹ lakh)', 'Notes']} num={[4]} maxHeight={600}>
      {list.slice(0, 600).map((x, i) => <tr key={i}><td style={{ ...S.td, whiteSpace: 'nowrap' }}>{x.date}</td><td style={{ ...S.td, fontSize: '0.72rem' }}>{x.kind}</td><td style={S.td}>{x.party}</td><td style={{ ...S.td, fontSize: '0.72rem' }}>{x.label}</td><td style={{ ...S.td, ...S.num }}>{L(x.amount)}</td><td style={{ ...S.td, fontSize: '0.68rem', color: C.warn }}>{(x.flags || []).join(' · ')}</td></tr>)}
    </Tbl>
    {list.length > 600 && <div style={S.small}>First 600 shown — use the search.</div>}
  </Card>;
}

function PatternTable({ title, rows, kind, company }) {
  const [q, setQ] = useState('');
  const list = rows.filter(r => !q || String(r.name || '').toLowerCase().includes(q.toLowerCase()));
  return <Card title={title}>
    <div style={{ ...S.small, marginBottom: 8 }}>{kind === 'client' ? `Days from invoice date to payment for each invoice paid in the last 12 months (Zoho). "Usual invoice day" is the most common day of the month the client is invoiced. A client with no paid invoice in the window uses the median of all clients (${company.medianDays ?? '—'} days).` : `Days from bill date to payment, matching Zoho vendor payments to their bills. Vendors with no history use the median of all vendors (${company.medianDays ?? '—'} days).`}</div>
    <input style={{ ...S.input, width: 240, marginBottom: 10 }} placeholder={`Search ${kind}…`} value={q} onChange={e => setQ(e.target.value)} />
    {kind === 'client' ? <Tbl head={['Client', 'Paid invoices', 'Median days', '75th percentile', 'Usual invoice day', 'GST factor', 'TDS share', 'Open now (₹ lakh)']} num={[1, 2, 3, 4, 5, 6, 7]} maxHeight={600}>
      {list.map(r => <tr key={r.id}><td style={S.td}>{r.name}</td><td style={{ ...S.td, ...S.num }}>{r.payments}</td><td style={{ ...S.td, ...S.num, color: r.medianDays == null ? C.warn : C.ink }}>{r.medianDays == null ? 'no history' : Math.round(r.medianDays)}</td><td style={{ ...S.td, ...S.num }}>{r.p75 ?? ''}</td><td style={{ ...S.td, ...S.num }}>{r.invoiceDay}</td><td style={{ ...S.td, ...S.num }}>{r.gstFactor ? r.gstFactor.toFixed(3) : ''}</td><td style={{ ...S.td, ...S.num }}>{r.tdsShare != null ? `${(r.tdsShare * 100).toFixed(1)}%` : ''}</td><td style={{ ...S.td, ...S.num }}>{L(r.open)}</td></tr>)}
    </Tbl> : <Tbl head={['Vendor', 'Payments matched', 'Median days']} num={[1, 2]} maxHeight={600}>
      {list.map(r => <tr key={r.id}><td style={S.td}>{r.name}</td><td style={{ ...S.td, ...S.num }}>{r.payments}</td><td style={{ ...S.td, ...S.num }}>{r.medianDays == null ? '' : Math.round(r.medianDays)}</td></tr>)}
    </Tbl>}
  </Card>;
}

function ForecastManual({ f, can, act, reload }) {
  const blank = { dir: 'in', month: f.months[0], amount: '', label: '', note: '' };
  const [x, setX] = useState(blank);
  const set = (k, v) => setX(o => ({ ...o, [k]: v }));
  return <Card title="Manual receipts and payments">
    <div style={{ ...S.small, marginBottom: 8 }}>Anything the data cannot show: a security deposit refund, a capex payment, a fund raise, tax payments, an expected large collection. Amount in ₹, booked in the middle of the month.</div>
    {can && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
      <Field label="Direction"><select style={S.select} value={x.dir} onChange={e => set('dir', e.target.value)}><option value="in">Receipt</option><option value="out">Payment</option></select></Field>
      <Field label="Month *"><input type="month" style={S.input} value={x.month} onChange={e => set('month', e.target.value)} /></Field>
      <Field label="Amount ₹ *"><input type="number" style={{ ...S.input, width: 130 }} value={x.amount} onChange={e => set('amount', e.target.value)} /></Field>
      <Field label="Description *"><input style={{ ...S.input, width: 220 }} value={x.label} onChange={e => set('label', e.target.value)} /></Field>
      <Field label="Note"><input style={{ ...S.input, width: 200 }} value={x.note} onChange={e => set('note', e.target.value)} /></Field>
      <button style={S.btn('primary')} onClick={() => act('fm', () => fsApi.forecastLine({ ...x, amount: rs(x.amount) }).then(() => 'Line added.'), [reload, () => setX(blank)])}><Plus size={14} />Add</button>
    </div>}
    {!f.manual.length ? <div style={S.small}>No manual lines.</div> : <Tbl head={['Month', 'Direction', 'Description', 'Amount (₹ lakh)', 'Note', 'Added by', '']} num={[3]}>
      {f.manual.map(m => <tr key={m.id}><td style={S.td}>{mLabel(m.month)}</td><td style={S.td}>{m.dir === 'in' ? 'Receipt' : 'Payment'}</td><td style={S.td}>{m.label}</td><td style={{ ...S.td, ...S.num }}>{L(m.amountLakh)}</td><td style={S.td}>{m.note}</td><td style={{ ...S.td, fontSize: '0.7rem' }}>{m.by} {m.at?.slice(0, 10)}</td>
        <td style={S.td}>{can && <button style={del} onClick={() => act('fmd', () => fsApi.deleteForecastLine(m.id).then(() => 'Removed.'), [reload])}><Trash2 size={13} /></button>}</td></tr>)}
    </Tbl>}
  </Card>;
}

function ForecastSettings({ f, can, act, reload }) {
  const [st, setSt] = useState({ opening: { amount: '', asAt: '' }, headLags: {}, netFactors: {}, overdueCollections: 'aged', overdueDays: 60, overduePayments: 'current', includeOpen: true });
  useEffect(() => {
    setSt({ opening: f.opening?.source === 'entered' ? { amount: Math.round(f.opening.amount * 1e5), asAt: f.opening.asAt } : { amount: '', asAt: '' }, headLags: { ...(f.settings.headLags || {}) }, netFactors: { ...(f.settings.netFactors || {}) },
      overdueCollections: f.settings.overdueCollections, overdueDays: f.settings.overdueDays ?? 60, overduePayments: f.settings.overduePayments, includeOpen: f.settings.includeOpen !== false, versionId: f.budget?.id || '' });
  }, [f]);
  const setMap = (k, head, v) => setSt(o => ({ ...o, [k]: { ...o[k], [head]: v } }));
  const save = () => act('fs', () => fsApi.forecastSettings({ ...st, opening: st.opening.amount === '' ? null : { amount: rs(st.opening.amount), asAt: st.opening.asAt } }).then(() => 'Forecast settings saved.'), [reload]);
  return <Card title="Settings" right={can && <button style={S.btn('primary')} onClick={save}>Save settings</button>}>
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
      <Field label="Opening bank balance ₹ (all accounts)"><input type="number" disabled={!can} style={{ ...S.input, width: 160 }} placeholder={f.opening?.source !== 'entered' && f.opening ? `BS: ${Math.round(f.opening.amount * 1e5)}` : ''} value={st.opening.amount} onChange={e => setSt(o => ({ ...o, opening: { ...o.opening, amount: e.target.value } }))} /></Field>
      <Field label="As at"><input type="date" disabled={!can} style={S.input} value={st.opening.asAt || ''} onChange={e => setSt(o => ({ ...o, opening: { ...o.opening, asAt: e.target.value } }))} /></Field>
      <Field label="Budget version used"><select disabled={!can} style={S.select} value={st.versionId || ''} onChange={e => setSt(o => ({ ...o, versionId: e.target.value }))}><option value="">The newest</option>{f.versions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
      <Field label="Invoices past their expected date"><select disabled={!can} style={S.select} value={st.overdueCollections} onChange={e => setSt(o => ({ ...o, overdueCollections: e.target.value }))}><option value="aged">This month, unless very late</option><option value="current">All this month</option><option value="exclude">Leave all out (list them)</option></select></Field>
      {st.overdueCollections === 'aged' && <Field label="Very late = more than (days)"><input type="number" disabled={!can} style={{ ...S.input, width: 80 }} value={st.overdueDays} onChange={e => setSt(o => ({ ...o, overdueDays: e.target.value }))} /></Field>}
      <Field label="Overdue bills"><select disabled={!can} style={S.select} value={st.overduePayments} onChange={e => setSt(o => ({ ...o, overduePayments: e.target.value }))}><option value="current">Pay in the current month</option><option value="exclude">Leave out (list them)</option></select></Field>
      <label style={{ ...S.small, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" disabled={!can} checked={st.includeOpen} onChange={e => setSt(o => ({ ...o, includeOpen: e.target.checked }))} />Include open invoices and bills</label>
    </div>
    {!f.heads.length ? <div style={S.small}>Choose a budget version to set the payment lag of each expense head.</div> : <>
      <div style={{ ...S.small, marginBottom: 6 }}>Budgeted expenses are paid this many days after the month they belong to (blank = the median of all vendors, {f.company.vendors.medianDays ?? '—'} days), times the net factor (1.00 = the budget amount; e.g. 1.18 to add GST, 0.98 for 2% TDS withheld).</div>
      <Tbl head={['Expense head', 'Method in the budget', 'Payment lag (days)', 'Net factor']} maxHeight={420}>
        {f.heads.map(h => <tr key={h.id}><td style={S.td}>{h.label}</td><td style={{ ...S.td, fontSize: '0.72rem' }}>{h.method === 'debt' ? 'debt schedule (paid on due dates)' : h.method}</td>
          <td style={S.td}><input type="number" disabled={!can || h.method === 'debt'} style={{ ...S.input, width: 80 }} value={st.headLags[h.id] ?? ''} onChange={e => setMap('headLags', h.id, e.target.value)} /></td>
          <td style={S.td}><input type="number" step="0.01" disabled={!can || h.method === 'debt'} style={{ ...S.input, width: 80 }} value={st.netFactors[h.id] ?? ''} placeholder="1.00" onChange={e => setMap('netFactors', h.id, e.target.value)} /></td></tr>)}
      </Tbl>
    </>}
  </Card>;
}

// ══ Debt schedule & covenants ═══════════════════════════════════════════════
export function DebtSection({ rights, flash }) {
  const can = !!rights?.inputs;
  const d = useLoad(() => fsApi.debt(), []);
  const [, act] = useAct(flash);
  const [form, setForm] = useState(null);
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState('merge');
  const doc = d.data;
  const facName = id => (id === 'ALL' ? 'All facilities' : doc?.facilities.find(x => x.id === id)?.facilityName || '—');
  if (d.loading && !doc) return <Loading text="Loading the debt schedule…" />;
  if (d.error) return <div style={{ ...S.card, color: C.bad }}>{d.error}</div>;
  const F = doc.fields;
  const totals = doc.facilities.reduce((s, x) => ({ out: s.out + (x.outstanding || 0), n12: s.n12 + (x.next12Principal || 0) }), { out: 0, n12: 0 });
  const saveFac = () => act('fac', () => fsApi.saveFacility(form).then(r => `${form.facilityName}: saved${r.generated ? ` — ${r.generated} instalments generated from the terms` : ''}.`), [d.reload, () => setForm(null)]);
  const inputOf = ([k, label, type, req]) => {
    const v = form[k] ?? '';
    const set = x => setForm(o => ({ ...o, [k]: x }));
    const lab = `${label}${req ? ' *' : ''}`;
    if (k === 'basis') return <Field key={k} label="Basis"><select style={S.select} value={/cons|^CO$/i.test(v) ? 'CO' : 'SA'} onChange={e => set(e.target.value)}><option value="SA">Standalone</option><option value="CO">Consolidated (subsidiary)</option></select></Field>;
    if (k === 'repaymentType') return <Field key={k} label="Repayment *"><select style={S.select} value={v} onChange={e => set(e.target.value)}><option value="">—</option>{['EMI', 'Equal principal', 'Bullet', 'Custom'].map(x => <option key={x}>{x}</option>)}</select></Field>;
    if (k === 'frequency') return <Field key={k} label="Frequency *"><select style={S.select} value={v} onChange={e => set(e.target.value)}><option value="">—</option>{['Monthly', 'Quarterly', 'Half-yearly', 'Yearly'].map(x => <option key={x}>{x}</option>)}</select></Field>;
    if (k === 'rateType') return <Field key={k} label="Rate type"><select style={S.select} value={v} onChange={e => set(e.target.value)}><option value="">—</option><option>Fixed</option><option>Floating</option></select></Field>;
    if (k === 'facilityType') return <Field key={k} label="Type *"><select style={S.select} value={v} onChange={e => set(e.target.value)}><option value="">—</option>{['Term loan', 'NCD', 'Cash credit', 'Overdraft', 'Vehicle loan', 'ICD', 'Other'].map(x => <option key={x}>{x}</option>)}</select></Field>;
    if (type === 'date') return <Field key={k} label={lab}><input type="date" style={S.input} value={v} onChange={e => set(e.target.value)} /></Field>;
    if (type === 'number') return <Field key={k} label={lab}><input type="number" step="any" style={{ ...S.input, width: 140 }} value={v} onChange={e => set(e.target.value)} /></Field>;
    return <Field key={k} label={lab}><input style={{ ...S.input, width: ['source', 'security'].includes(k) ? 300 : 180 }} value={v} onChange={e => set(e.target.value)} /></Field>;
  };

  return <div>
    <Card title={`Debt schedule — ${doc.facilities.length} facilit${doc.facilities.length === 1 ? 'y' : 'ies'}`} right={<>
      <button style={S.btn('outline')} onClick={() => fsApi.download('/debt/template', {}, 'Debt_schedule_and_covenants.xlsx').catch(e => alert(errText(e)))}><Download size={14} />Excel format</button>
      {can && <><select style={S.select} value={mode} onChange={e => setMode(e.target.value)} title="Merge: facilities of the same name are replaced, others kept. Replace: the upload becomes the whole debt schedule."><option value="merge">Upload: merge</option><option value="replace">Upload: replace all</option></select>
        <FileButton label="Upload filled format" onFile={file => { if (mode === 'replace' && !window.confirm('Replace every facility, schedule row, covenant and test with the upload?')) return; act('upd', () => fsApi.uploadDebt(file, mode).then(r => `${r.facilities} facilit${r.facilities === 1 ? 'y' : 'ies'}, ${r.scheduleRows} instalments, ${r.covenants} covenant(s) read from ${file.name}.${r.errors?.length ? ` Notes: ${r.errors.join('; ')}` : ''}`), [d.reload]); }} />
        <button style={S.btn('outline')} onClick={() => act('loans', () => fsApi.importLoans().then(r => `${r.added} facilit${r.added === 1 ? 'y' : 'ies'} added from the Loan module (${r.skipped} already here). Complete the outstanding-as-at, first due and maturity dates, then generate the schedule.`), [d.reload])}>Add from Loan module</button>
        <button style={S.btn('primary')} onClick={() => setForm({ basis: 'SA', repaymentType: 'EMI', frequency: 'Monthly' })}><Plus size={14} />New facility</button></>}
    </>}>
      <div style={{ ...S.small, marginBottom: 8 }}>One row per loan, NCD or working-capital line, with its repayment schedule (one row per instalment: due date, principal, interest). Fill the format and upload it, or enter a facility here: for EMI, equal-principal or bullet repayment the schedule is generated from the terms (interest on the outstanding, actual/365) and can then be edited row by row; choose "Custom" to enter the schedule yourself. The schedule feeds the debt service in the forecast, the scheduled principal in DSCR (Ratio Analytics) and, when chosen in the budget settings, loan interest in the budget. Amounts in ₹.</div>
      {form && <div style={{ border: `1px solid ${C.green}`, borderRadius: 8, padding: 12, marginBottom: 12, background: C.page }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>{F.facility.map(inputOf)}</div>
        <div style={{ display: 'flex', gap: 6 }}><button style={S.btn('primary')} onClick={saveFac}>Save{form.id ? '' : ' and generate the schedule'}</button><button style={S.btn('outline')} onClick={() => setForm(null)}>Cancel</button></div>
        {form.id && <div style={{ ...S.small, marginTop: 6 }}>Saving keeps a schedule you edited by hand. Use "Generate" on the facility to rebuild it from the terms.</div>}
      </div>}
      {!doc.facilities.length ? <Note tone="warn">No facility entered. DSCR uses the repayments in the cash flow until a schedule is entered, and lender covenants are never assumed.</Note> : <>
        <Tbl head={['Lender / facility', 'Type', 'Basis', 'Outstanding (₹ lakh)', 'As at', 'Rate', 'Repayment', 'Maturity', 'Instalments', 'Next due', 'Principal next 12 months (₹ lakh)', '']} num={[3, 8, 10]} maxHeight={480}>
          {doc.facilities.map(x => <tr key={x.id} style={{ background: sel === x.id ? C.tint : 'transparent' }}>
            <td style={{ ...S.td, minWidth: 180 }}><b>{x.lender}</b><div style={{ fontSize: '0.72rem' }}>{x.facilityName}</div>{x.endText && <div style={{ fontSize: '0.64rem', color: C.ink2 }}>Loan module end: {x.endText}</div>}</td>
            <td style={S.td}>{x.facilityType}</td><td style={S.td}>{x.basis === 'CO' ? 'Cons.' : 'Stand.'}</td><td style={{ ...S.td, ...S.num }}>{lakhOfRs(x.outstanding)}</td><td style={{ ...S.td, whiteSpace: 'nowrap' }}>{x.outstandingAsAt || <span style={{ color: C.warn }}>missing</span>}</td>
            <td style={S.td}>{x.interestRate != null ? `${x.interestRate}%` : ''}{x.rateType ? ` ${x.rateType.toLowerCase()}` : ''}</td><td style={{ ...S.td, fontSize: '0.72rem' }}>{x.repaymentType} · {x.frequency}{x.instalment ? ` · ₹${new Intl.NumberFormat('en-IN').format(x.instalment)}` : ''}</td>
            <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{x.maturityDate || <span style={{ color: C.warn }}>missing</span>}</td><td style={{ ...S.td, ...S.num }}>{x.scheduleRows || <span style={{ color: C.warn }}>none</span>}</td>
            <td style={{ ...S.td, fontSize: '0.72rem', whiteSpace: 'nowrap' }}>{x.nextDue ? `${x.nextDue.dueDate}: ${lakhOfRs((x.nextDue.principal || 0) + (x.nextDue.interest || 0))}` : ''}</td><td style={{ ...S.td, ...S.num }}>{lakhOfRs(x.next12Principal)}</td>
            <td style={{ ...S.td, whiteSpace: 'nowrap' }}><button style={S.btn('outline')} onClick={() => setSel(sel === x.id ? null : x.id)}>Schedule</button>
              {can && <><button style={{ ...S.btn('outline'), marginLeft: 4 }} onClick={() => { const { scheduleRows, scheduledPrincipal, next12Principal, nextDue, ...rest } = x; setForm(rest); }}><Edit3 size={13} /></button>
                <button style={{ ...S.btn('outline'), marginLeft: 4 }} title="Generate the schedule from the terms (replaces the rows)" onClick={() => { if (window.confirm(`Rebuild the schedule of ${x.facilityName} from its terms? Rows entered by hand are replaced.`)) act('gen', () => fsApi.generateSchedule(x.id).then(r => `${r.rows} instalments generated${r.emi ? ` (EMI ₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(r.emi)})` : ''}.`), [d.reload]); }}><Wand2 size={13} /></button>
                <button style={del} title="Delete the facility, its schedule and covenants" onClick={() => { if (window.confirm(`Delete ${x.facilityName} with its schedule and covenants?`)) act('delf', () => fsApi.deleteFacility(x.id).then(() => 'Deleted.'), [d.reload]); }}><Trash2 size={13} /></button></>}</td>
          </tr>)}
          <tr style={{ background: C.tint }}><td style={{ ...S.td, fontWeight: 700 }} colSpan={3}>Total</td><td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{lakhOfRs(totals.out)}</td><td style={S.td} colSpan={6} /><td style={{ ...S.td, ...S.num, fontWeight: 700 }}>{lakhOfRs(totals.n12)}</td><td style={S.td} /></tr>
        </Tbl>
      </>}
    </Card>
    {sel && <ScheduleEditor key={sel} fac={doc.facilities.find(x => x.id === sel)} rows={doc.schedule.filter(r => r.facilityId === sel)} can={can} act={act} reload={d.reload} />}
    <Covenants doc={doc} can={can} act={act} reload={d.reload} facName={facName} />
  </div>;
}

function ScheduleEditor({ fac, rows, can, act, reload }) {
  const [list, setList] = useState(() => [...rows].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map(r => ({ ...r })));
  const [dirty, setDirty] = useState(false);
  const set = (i, k, v) => { setList(l => l.map((r, j) => (j === i ? { ...r, [k]: v } : r))); setDirty(true); };
  const tot = list.reduce((s, r) => ({ p: s.p + (Number(r.principal) || 0), i: s.i + (Number(r.interest) || 0) }), { p: 0, i: 0 });
  if (!fac) return null;
  return <Card title={`Repayment schedule — ${fac.facilityName} (${list.length} instalments, ₹)`} right={can && <>
    <button style={S.btn('outline')} onClick={() => { setList(l => [...l, { dueDate: '', principal: '', interest: '', note: '' }]); setDirty(true); }}><Plus size={14} />Add row</button>
    <button style={S.btn(dirty ? 'primary' : 'outline')} disabled={!dirty} onClick={() => act('sch', () => fsApi.saveSchedule(fac.id, list).then(r => `${r.rows} instalments saved.`), [reload, () => setDirty(false)])}>Save schedule</button>
  </>}>
    <div style={{ ...S.small, marginBottom: 8 }}>Total principal ₹{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(tot.p)} against outstanding ₹{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(fac.outstanding || 0)}{fac.outstanding && Math.abs(tot.p - fac.outstanding) > 1 ? <span style={{ color: C.warn }}> — they differ by ₹{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(tot.p - fac.outstanding)}</span> : ''}; interest ₹{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(tot.i)}.</div>
    <Tbl head={['#', 'Due date', 'Principal', 'Interest', 'Total', 'Note', '']} num={[4]} maxHeight={520}>
      {list.map((r, i) => <tr key={i}><td style={S.td}>{i + 1}</td>
        <td style={S.td}><input type="date" disabled={!can} style={S.input} value={r.dueDate || ''} onChange={e => set(i, 'dueDate', e.target.value)} /></td>
        <td style={S.td}><input type="number" step="any" disabled={!can} style={{ ...S.input, width: 120, textAlign: 'right' }} value={r.principal ?? ''} onChange={e => set(i, 'principal', e.target.value)} /></td>
        <td style={S.td}><input type="number" step="any" disabled={!can} style={{ ...S.input, width: 120, textAlign: 'right' }} value={r.interest ?? ''} onChange={e => set(i, 'interest', e.target.value)} /></td>
        <td style={{ ...S.td, ...S.num }}>{new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format((Number(r.principal) || 0) + (Number(r.interest) || 0))}</td>
        <td style={S.td}><input disabled={!can} style={{ ...S.input, width: 160 }} value={r.note || ''} onChange={e => set(i, 'note', e.target.value)} />{r.source === 'generated' && <span style={{ fontSize: '0.62rem', color: C.ink3, marginLeft: 4 }}>generated</span>}</td>
        <td style={S.td}>{can && <button style={del} onClick={() => { setList(l => l.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 size={13} /></button>}</td></tr>)}
    </Tbl>
  </Card>;
}

function Covenants({ doc, can, act, reload, facName }) {
  const blankC = { facilityId: doc.facilities[0]?.id || 'ALL', metric: '', definition: '', operator: '>=', threshold: '', frequency: 'Quarterly', basis: 'SA', firstTest: '', source: '' };
  const [c, setC] = useState(null);
  const [t, setT] = useState({ covenantId: '', periodEnd: '', value: '', note: '' });
  const tests = useMemo(() => [...(doc.tests || [])].sort((a, b) => (b.periodEnd || '').localeCompare(a.periodEnd || '')), [doc.tests]);
  const setc = (k, v) => setC(o => ({ ...o, [k]: v }));
  return <Card title={`Covenants (${doc.covenants.length})`} right={can && <button style={S.btn('primary')} onClick={() => setC(blankC)}><Plus size={14} />New covenant</button>}>
    <div style={{ ...S.small, marginBottom: 8 }}>Each covenant exactly as in the loan agreement — metric, definition, test and threshold — and, for each test date, the value the lender's definition gives. Covenant status is never assumed: without a tested value it shows "Missing data". The DSCR covenant's tested value appears as "DSCR — lender definition" in Ratio Analytics for the period ending on the test date.</div>
    {c && <div style={{ border: `1px solid ${C.green}`, borderRadius: 8, padding: 12, marginBottom: 12, background: C.page, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <Field label="Facility *"><select style={S.select} value={c.facilityId} onChange={e => setc('facilityId', e.target.value)}><option value="ALL">All facilities</option>{doc.facilities.map(x => <option key={x.id} value={x.id}>{x.facilityName}</option>)}</select></Field>
      <Field label="Metric *"><input list="cov-metrics" style={{ ...S.input, width: 160 }} value={c.metric} onChange={e => setc('metric', e.target.value)} /><datalist id="cov-metrics">{['DSCR', 'Debt / EBITDA', 'Total debt / tangible net worth', 'Security cover', 'Current ratio', 'Interest coverage', 'Minimum net worth'].map(x => <option key={x} value={x} />)}</datalist></Field>
      <Field label="Definition as in the agreement *"><input style={{ ...S.input, width: 360 }} value={c.definition} onChange={e => setc('definition', e.target.value)} /></Field>
      <Field label="Test *"><select style={S.select} value={c.operator} onChange={e => setc('operator', e.target.value)}><option value=">=">at least (≥)</option><option value="<=">at most (≤)</option></select></Field>
      <Field label="Threshold *"><input type="number" step="any" style={{ ...S.input, width: 90 }} value={c.threshold} onChange={e => setc('threshold', e.target.value)} /></Field>
      <Field label="Frequency"><select style={S.select} value={c.frequency} onChange={e => setc('frequency', e.target.value)}>{['Quarterly', 'Half-yearly', 'Yearly'].map(x => <option key={x}>{x}</option>)}</select></Field>
      <Field label="Basis"><select style={S.select} value={c.basis} onChange={e => setc('basis', e.target.value)}><option value="SA">Standalone</option><option value="CO">Consolidated</option></select></Field>
      <Field label="First test date"><input type="date" style={S.input} value={c.firstTest || ''} onChange={e => setc('firstTest', e.target.value)} /></Field>
      <Field label="Source (clause) *"><input style={{ ...S.input, width: 180 }} value={c.source} onChange={e => setc('source', e.target.value)} /></Field>
      <button style={S.btn('primary')} onClick={() => act('cov', () => fsApi.saveCovenant({ ...c, threshold: rs(c.threshold) }).then(() => 'Covenant saved.'), [reload, () => setC(null)])}>Save</button>
      <button style={S.btn('outline')} onClick={() => setC(null)}>Cancel</button>
    </div>}
    {!doc.covenants.length ? <Note tone="warn">No covenants entered.</Note> : <Tbl head={['Facility', 'Metric', 'Definition', 'Test', 'Latest tested value', 'Headroom', 'Status', '']} num={[4, 5]} maxHeight={420}>
      {doc.covenants.map(x => <tr key={x.id}><td style={S.td}>{facName(x.facilityId)}</td><td style={{ ...S.td, fontWeight: 600 }}>{x.metric}</td><td style={{ ...S.td, fontSize: '0.72rem', maxWidth: 320 }}>{x.definition}<div style={{ fontSize: '0.64rem', color: C.ink2 }}>{x.source}{x.frequency ? ` · ${x.frequency}` : ''} · {x.basis === 'CO' ? 'consolidated' : 'standalone'}</div></td>
        <td style={S.td}>{x.operator === '>=' ? '≥' : '≤'} {x.threshold}</td><td style={{ ...S.td, ...S.num }}>{x.test ? <>{x.test.value}<div style={{ fontSize: '0.64rem', color: C.ink2 }}>{x.test.periodEnd}</div></> : ''}</td>
        <td style={{ ...S.td, ...S.num }}>{x.headroom != null ? `${x.headroom.toFixed(2)}${x.headroomPct != null ? ` (${(x.headroomPct * 100).toFixed(0)}%)` : ''}` : ''}</td><td style={S.td}><Badge status={x.status} /></td>
        <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{can && <><button style={S.btn('outline')} onClick={() => setC({ ...x })}><Edit3 size={13} /></button><button style={del} onClick={() => { if (window.confirm('Delete this covenant and its tests?')) act('delcov', () => fsApi.deleteCovenant(x.id).then(() => 'Deleted.'), [reload]); }}><Trash2 size={13} /></button></>}</td></tr>)}
    </Tbl>}
    {doc.covenants.length > 0 && <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 12, paddingTop: 10 }}>
      <div style={{ ...S.h2, fontSize: '0.82rem' }}>Covenant tests</div>
      {can && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
        <Field label="Covenant *"><select style={S.select} value={t.covenantId} onChange={e => setT(o => ({ ...o, covenantId: e.target.value }))}><option value="">—</option>{doc.covenants.map(x => <option key={x.id} value={x.id}>{x.metric} — {facName(x.facilityId)}</option>)}</select></Field>
        <Field label="Test period end *"><input type="date" style={S.input} value={t.periodEnd} onChange={e => setT(o => ({ ...o, periodEnd: e.target.value }))} /></Field>
        <Field label="Tested value *"><input type="number" step="any" style={{ ...S.input, width: 100 }} value={t.value} onChange={e => setT(o => ({ ...o, value: e.target.value }))} /></Field>
        <Field label="Workings / note"><input style={{ ...S.input, width: 260 }} value={t.note} onChange={e => setT(o => ({ ...o, note: e.target.value }))} /></Field>
        <button style={S.btn('primary')} onClick={() => act('test', () => fsApi.saveTest({ ...t, value: rs(t.value) }).then(() => 'Test recorded.'), [reload, () => setT({ covenantId: '', periodEnd: '', value: '', note: '' })])}>Record test</button>
      </div>}
      {!tests.length ? <div style={S.small}>No tests recorded.</div> : <Tbl head={['Period end', 'Covenant', 'Tested value', 'Note', 'By']} num={[2]} maxHeight={300}>
        {tests.map(x => { const cv = doc.covenants.find(y => y.id === x.covenantId); return <tr key={x.id}><td style={S.td}>{x.periodEnd}</td><td style={S.td}>{cv ? `${cv.metric} — ${facName(cv.facilityId)}` : '(deleted)'}</td><td style={{ ...S.td, ...S.num }}>{x.value}</td><td style={{ ...S.td, fontSize: '0.72rem' }}>{x.note}</td><td style={{ ...S.td, fontSize: '0.7rem' }}>{x.by} {x.at?.slice(0, 10)}</td></tr>; })}
      </Tbl>}
    </div>}
  </Card>;
}
