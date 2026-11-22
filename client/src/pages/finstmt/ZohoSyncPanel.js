import React, { useEffect, useState } from 'react';
import { fsApi, errText } from './api';
import { C, S, Card, Note, fmtTime, fmtDate } from './ui';

// The Zoho Books ledger behind the provisional statements: last successful run, next scheduled run, accounting cut-off,
// records added / changed, affected periods, failures and accounts awaiting mapping. Used on Sync Monitor and Account Mapping.
const MODE = { initial: 'Initial sync', hourly: 'Hourly', daily: 'Hourly + daily full month refresh', full: 'Full refresh' };
const per = id => { const m = String(id).match(/^FY(\d{4})-(.+)$/); return m ? `${m[2] === 'FY' ? '' : `${m[2]} `}FY${m[1].slice(2)}` : id; };

export default function ZohoSyncPanel({ canRun = false, compact = false, onChanged }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(null);
  const load = () => fsApi.glStatus().then(s => { setSt(s); setErr(''); return s; }).catch(e => setErr(errText(e)));
  useEffect(() => { load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, []);
  const run = async mode => {
    setMsg('');
    try { const r = await fsApi.glRun(mode); setMsg(r.status === 'started' ? `${MODE[mode] || mode} started — this panel updates by itself.` : r.status === 'ok' ? `${MODE[r.mode] || r.mode} finished.` : r.message || r.error || r.status); await load(); onChanged && onChanged(); }
    catch (e) { setMsg(errText(e)); }
  };
  if (err) return <Card title="Financial Statements — Zoho Books ledger (hourly)"><Note tone="warn">{err}</Note></Card>;
  if (!st) return <Card title="Financial Statements — Zoho Books ledger (hourly)"><div style={S.small}>Loading…</div></Card>;
  const last = st.lastRun, ok = st.lastSuccess;
  const failures = (st.runs || []).filter(r => r.status === 'failed' || r.status === 'partial').slice(0, 5);
  const day = (st.runs || []).filter(r => r.status === 'ok' && Date.now() - Date.parse(r.endedAt) < 86400000);
  const tot = day.reduce((t, r) => ({ a: t.a + (r.records?.added || 0), c: t.c + (r.records?.changed || 0), v: t.v + (r.records?.voided || 0) }), { a: 0, c: 0, v: 0 });
  const Kpi = ({ label, value, sub, tone }) => <div style={{ flex: '1 1 170px', border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 10px', background: C.white }}>
    <div style={{ fontSize: '0.62rem', color: C.ink2, fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
    <div style={{ fontSize: '0.95rem', fontWeight: 700, color: tone || C.ink, marginTop: 2 }}>{value}</div>
    {sub && <div style={{ fontSize: '0.66rem', color: C.ink2, marginTop: 2 }}>{sub}</div>}
  </div>;
  return (
    <Card title="Financial Statements — Zoho Books ledger (hourly)" right={canRun && <>
      {!st.initialDone && <button style={S.btn('primary')} disabled={st.running} onClick={() => run('initial')}>Run initial sync</button>}
      {st.initialDone && <button style={S.btn('primary')} disabled={st.running} onClick={() => run('hourly')}>Sync now</button>}
      {st.initialDone && <button style={S.btn('outline')} disabled={st.running} onClick={() => run('full')} title="Re-reads every month held and the chart of accounts">Full refresh</button>}
    </>}>
      {msg && <Note>{msg}</Note>}
      {!st.initialDone && <Note tone="warn">The initial sync has not been run: it reads the chart of accounts, the trial balances at 31 March 2025 / 31 March 2026 / today and every month's general ledger from April 2025 (about 60 Zoho calls, two minutes). After that the ledger is refreshed every hour.</Note>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Kpi label="Accounting cut-off" value={fmtDate(st.cutoff)} sub="the date the open month is read to" />
        <Kpi label="Last successful sync" value={ok ? fmtTime(ok.at) : '—'} sub={ok ? MODE[ok.mode] || ok.mode : ''} />
        <Kpi label="Next scheduled sync" value={st.schedule?.next ? fmtTime(st.schedule.next) : st.schedule?.armed === false ? 'not scheduled (server restart needed)' : '—'} sub={`every hour at minute ${st.schedule?.minuteIst ?? 45} (India time)${st.schedule?.onVercel ? ' — Vercel cron' : ' — office PC'}`} />
        <Kpi label="Records in the last 24 h" value={`${tot.a} added · ${tot.c} changed · ${tot.v} voided`} sub={`${day.length} successful run(s)`} />
        <Kpi label="Accounts awaiting mapping" value={st.awaitingCount ?? '—'} tone={st.awaitingCount ? C.warn : C.good} sub="Zoho accounts with an amount the mapping does not place" />
        <Kpi label="Status" value={st.running ? 'Running…' : st.pending ? `Resuming (${st.pending.left} step(s) left)` : last?.status === 'ok' ? 'OK' : last ? last.status : '—'} tone={last?.status === 'failed' ? C.bad : st.running ? C.info : C.good} sub={last?.error || ''} />
      </div>
      {last?.status === 'ok' && <div style={{ ...S.small, marginBottom: 6 }}>
        Last run: {MODE[last.mode] || last.mode}, {last.calls} Zoho call(s); records {last.records?.added || 0} added / {last.records?.changed || 0} changed / {last.records?.voided || 0} voided; months read {(last.monthsRead || []).join(', ') || '—'};
        {' '}months that changed: {(last.monthsChanged || []).length ? last.monthsChanged.map(m => `${m.month} (${m.accounts} account${m.accounts === 1 ? '' : 's'})`).join(', ') : 'none'};
        {' '}affected periods: {(last.affectedPeriods || []).length ? last.affectedPeriods.map(per).join(', ') : 'none'}.
        {last.tbCheck && <> Check against Zoho's trial balance at {fmtDate(last.tbCheck.asOf)}: {last.tbCheck.ok ? <b style={{ color: C.good }}>all {last.tbCheck.accounts} accounts agree</b> : last.tbCheck.ok === false ? <b style={{ color: C.bad }}>{last.tbCheck.differences} account(s) differ</b> : last.tbCheck.note}.</>}
      </div>}
      {failures.length > 0 && <Note tone="warn"><b>Failures / unfinished runs:</b> {failures.map(f => `${fmtTime(f.startedAt)} ${MODE[f.mode] || f.mode}: ${f.error || f.status}`).join(' · ')} — the checkpoint did not move; the next run re-reads the same window.</Note>}
      {!compact && <>
        <div style={{ display: 'flex', gap: 8, margin: '6px 0' }}>
          <button style={S.btn('outline')} onClick={() => setOpen(open === 'runs' ? null : 'runs')}>{open === 'runs' ? 'Hide' : 'Show'} run log</button>
          {st.awaitingCount > 0 && <button style={S.btn('outline')} onClick={() => setOpen(open === 'await' ? null : 'await')}>{open === 'await' ? 'Hide' : 'Show'} accounts awaiting mapping</button>}
          <button style={S.btn('outline')} onClick={() => setOpen(open === 'feeds' ? null : 'feeds')}>{open === 'feeds' ? 'Hide' : 'Show'} checkpoints</button>
        </div>
        {open === 'runs' && <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Started', 'Mode', 'Trigger', 'Status', 'Added', 'Changed', 'Voided', 'Months changed', 'Affected periods', 'Calls', 'Note'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead><tbody>
          {(st.runs || []).slice(0, 25).map(r => <tr key={r.id + r.startedAt}><td style={S.td}>{fmtTime(r.startedAt)}</td><td style={S.td}>{MODE[r.mode] || r.mode}</td><td style={S.td}>{r.trigger}</td><td style={{ ...S.td, color: r.status === 'ok' ? C.good : C.bad }}>{r.status}</td>
            <td style={{ ...S.td, ...S.num }}>{r.records?.added ?? ''}</td><td style={{ ...S.td, ...S.num }}>{r.records?.changed ?? ''}</td><td style={{ ...S.td, ...S.num }}>{r.records?.voided ?? ''}</td>
            <td style={S.td}>{(r.monthsChanged || []).map(m => m.month).join(', ')}</td><td style={S.td}>{(r.affectedPeriods || []).map(per).join(', ')}</td><td style={{ ...S.td, ...S.num }}>{r.calls ?? ''}</td><td style={{ ...S.td, ...S.small }}>{r.error || (r.records?.items || []).slice(0, 3).map(x => `${x.kind} ${x.no || x.id} ${x.change}${x.oldDate ? ` (date ${x.oldDate} → ${x.date})` : ''}`).join('; ')}</td></tr>)}
        </tbody></table></div>}
        {open === 'await' && <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Zoho account', 'Type', 'Amount at cut-off (₹ lakh)', 'Placed on', 'First seen'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead><tbody>
          {(st.awaiting || []).map(a => <tr key={a.id}><td style={S.td}>{a.name}<div style={S.small}>{a.id}</div></td><td style={S.td}>{a.type || '—'}</td><td style={{ ...S.td, ...S.num }}>{a.amount?.toFixed(2)}</td><td style={S.td}>{a.suggested ? `suggested: ${a.line} (${a.suggested})` : 'awaiting-mapping line'}</td><td style={S.td}>{a.created ? fmtDate(a.created) : a.first ? fmtDate(a.first) : '—'}</td></tr>)}
        </tbody></table><div style={S.small}>Map them on Financial Statements → Account Mapping (Ledger mapping → filter "Awaiting / suggested").</div></div>}
        {open === 'feeds' && <div style={S.small}>Checkpoints (records modified after these times are read next): {Object.values(st.feeds || {}).map(f => `${f.label}: ${f.hwm ? fmtTime(f.hwm) : '—'}`).join(' · ')}. Months held: {(st.monthsHeld || []).join(', ')}. Trial balances held: {(st.tbHeld || []).join(', ')}.</div>}
      </>}
    </Card>
  );
}
