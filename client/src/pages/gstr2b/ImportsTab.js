import React, { useEffect, useState, useCallback, useRef } from 'react';
import { g, errMsg, download } from './gApi';
import { S, Tag, Field, Msg, inr, dt, dtm, monthName } from './ui';

const RUN_TONE = { completed: 'green', partial: 'amber', paused_budget: 'amber', paused_limit: 'amber', needs_first_sync: 'amber', failed: 'red', cancelled: 'grey', running: 'blue' };
const RUN_TEXT = { completed: 'Completed', partial: 'Partly done (continues next run)', paused_budget: 'Paused — daily budget used', paused_limit: 'Paused — Zoho limit', needs_first_sync: 'First sync needed', failed: 'Failed', cancelled: 'Stopped', running: 'Running' };
const REASON = { no_supplier_gstin: 'No supplier GSTIN', void: 'Void', draft: 'Draft', deleted: 'Deleted in Zoho', opening_balance: 'Opening balance', composition_supplier: 'Composition supplier', recipient_unmapped: 'Branch without GSTIN', gstin_off: 'GSTIN switched off', outside_period: 'Before the first month synced', foreign_currency: 'Not in INR', no_gst: 'No GST', incomplete: 'Incomplete' };
const MAX_STEPS = 40;                                            // online: one click never goes on for more than about 2 hours
const thisMonth = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);          // India time
const monthsBack = (ym, n) => { let y = +ym.slice(0, 4), m = +ym.slice(5, 7) - n; while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };
/** A first sync has been started: the change feed has a starting point. ("Sync changes now" can only follow one.) */
const firstDone = s => !!(s && s.hwm && (s.hwm.bill || s.hwm.expense || s.hwm.vendor_credit));

export default function ImportsTab({ meta, filters, stamp, onChanged }) {
  const real = meta.companies.filter(c => !c.demo);
  const [company, setCompany] = useState(() => (real.find(c => c.id === filters.company) || real[0] || {}).id || '');
  return (
    <div>
      {real.length > 0 && <SyncPanel meta={meta} company={company} setCompany={setCompany} companies={real} onChanged={onChanged} />}
      {real.length === 0 && <div style={S.info}>No Zoho company is set up yet (Settings → Companies &amp; GSTINs), so there is nothing to sync. You can still look at the demo company's statements below.</div>}
      {meta.rights.prepare && <UploadPanel meta={meta} onChanged={onChanged} />}
      <Statements meta={meta} filters={filters} stamp={stamp} />
    </div>
  );
}

// ── Zoho sync ────────────────────────────────────────────────────────────────
function SyncPanel({ meta, company, setCompany, companies, onChanged }) {
  const [st, setSt] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [period, setPeriod] = useState(() => ({ from: monthsBack(thisMonth(), 2), to: thisMonth() }));      // the latest three months: a first sync that finishes in a day
  const [showPeriod, setShowPeriod] = useState(false);
  const [stepping, setStepping] = useState(false);               // online: this page is asking for the next step
  const stopAsked = useRef(false);
  const autoOpened = useRef(false);
  const timer = useRef(null);
  const load = useCallback(() => (company ? g.syncStatus(company).then(s => { setSt(s); setError(''); return s; }).catch(e => { setError(errMsg(e)); return null; }) : Promise.resolve(null)), [company]);
  useEffect(() => { autoOpened.current = false; setSt(null); load(); }, [load]);
  useEffect(() => { if (st && !autoOpened.current) { autoOpened.current = true; if (!firstDone(st)) setShowPeriod(true); } }, [st]);   // before the first sync, the month boxes are already open
  useEffect(() => { clearInterval(timer.current); timer.current = setInterval(() => { if (stepping) load(); else if (st && st.running) load().then(s => { if (s && !s.running) onChanged(); }); }, stepping ? 8000 : 3000); return () => clearInterval(timer.current); }, [st, load, stepping]); // eslint-disable-line
  useEffect(() => () => { stopAsked.current = true; }, []);   // leaving this page ends the steps after the one in progress

  const start = async mode => {
    setError(''); setNote('');
    const body = { company, mode, ...(mode === 'period' || mode === 'recheck' ? period : {}) };
    try {
      if (!meta.integrations.vercel) {                          // office PC: the server runs the whole sync in the background
        const r = await g.syncRun(body);
        setNote(r.busy ? r.message : 'Sync started — progress appears below.');
        setTimeout(load, 800);
        return;
      }
      // Online a request can only run a few minutes, so the sync is done in steps: this page asks for the next step until it is finished
      stopAsked.current = false; setStepping(true);
      let step = 0, read = 0;
      for (;;) {
        step++;
        setNote(`Syncing with Zoho — step ${step}${read ? `, ${read.toLocaleString('en-IN')} amounts read so far` : ''}. Keep this page open; a step takes a few minutes.`);
        const r = await g.syncRun(body);
        if (r.busy) { setNote(r.message); break; }
        const sm = r.summary || {};
        read += (sm.details && sm.details.fetched) || 0;
        const now = await load();
        if (sm.status === 'partial' && !stopAsked.current && step < MAX_STEPS) continue;
        const left = now && now.stats ? now.stats.pending || 0 : 0;
        const where = `${read.toLocaleString('en-IN')} amount(s) read in ${step} step(s); ${left.toLocaleString('en-IN')} still waiting.`;
        if (sm.status === 'failed') setError(`${sm.error || 'The sync failed'} (${where})`);
        else if (sm.status === 'completed') setNote(`Sync finished — ${where}`);
        else if (sm.status === 'needs_first_sync') setNote(sm.message);
        else if (sm.status === 'partial') setNote(`${stopAsked.current ? 'Stopped' : 'Paused after many steps'} — ${where} ${mode === 'period' ? 'Start the same period again to continue.' : 'Click the same button again to continue.'}`);
        else setNote(`${sm.message || RUN_TEXT[sm.status] || sm.status} — ${where}`);
        break;
      }
    } catch (e) { setError(errMsg(e)); }
    finally { setStepping(false); onChanged(); }
  };
  const stop = () => {
    stopAsked.current = true;
    g.syncCancel(company).catch(() => {});
    setNote(stepping ? 'Stopping — the step in progress finishes first (up to a few minutes online).' : 'Stopping after the current call…');
  };
  if (!st) return <div style={S.card}><div style={S.cardBody}>{error ? <span style={{ color: '#B91C1C' }}>{error}</span> : 'Loading sync status…'}</div></div>;
  const stats = st.stats || {}, b = st.budget || {};
  const never = !firstDone(st);                                 // no first sync yet (a "Sync changes now" that found nothing to build on does not count)
  const pend = stats.pending || 0;
  const busy = st.running || stepping;

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <span style={S.cardTitle}>Zoho Books sync <Tag tone="green">read-only</Tag></span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {companies.length > 1 && <select style={S.select} value={company} onChange={e => setCompany(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
          {busy ? <Tag tone="blue">Running…</Tag> : <Tag tone={st.last_error ? 'red' : never ? 'amber' : 'green'}>{st.last_error ? 'Last run failed' : never ? 'Never synced' : 'Idle'}</Tag>}
        </span>
      </div>
      <div style={S.cardBody}>
        <Msg error={error} ok={note} onClose={() => { setError(''); setNote(''); }} />
        {st.last_error && <div style={S.error}>Last error ({dtm(st.last_error.at)}): {st.last_error.message}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, marginBottom: 10 }}>
          <Stat k="Last successful sync" v={st.last_ok_at ? dtm(st.last_ok_at) : 'never'} />
          <Stat k="Documents read" v={`${(stats.total || 0).toLocaleString('en-IN')}`} sub={`${stats.in_scope || 0} can be matched · ${stats.detailed || 0} with amounts`} />
          <Stat k="Waiting for amounts" v={pend.toLocaleString('en-IN')} tone={pend ? 'warn' : 'good'} sub={pend ? `about ${st.eta_days} day(s) at the daily budget` : 'nothing waiting'} />
          <Stat k="Edited in Zoho, not refreshed" v={stats.stale || 0} tone={stats.stale ? 'warn' : undefined} />
          <Stat k="Zoho calls today" v={`${b.used} / ${b.limit}`} sub="this module's own budget" />
          <Stat k="Failing documents" v={st.failing_documents || 0} tone={st.failing_documents ? 'bad' : undefined} sub="skipped after 3 attempts" />
        </div>
        {st.scope && st.scope.gstins_total > 0 && (
          <div style={{ ...S.muted, marginBottom: 8 }}>
            Amounts are read from Zoho for <b>{st.scope.gstins_on.length} of {st.scope.gstins_total} GSTIN(s)</b> that are switched on{st.scope.gstins_on.length > 0 && st.scope.gstins_total > 1 ? ` (${st.scope.gstins_on.map(x => x.label || x.gstin).join(', ')})` : ''}{st.scope.from ? `, for documents from ${monthName(st.scope.from)}` : ''}.
            {st.scope.gstins_total > 1 && <> Switching a GSTIN on or off is the "Active" box in Settings → Companies &amp; GSTINs: fewer GSTINs means a much faster sync, and a GSTIN you switch on is read at the next sync.</>}
          </div>
        )}
        {Object.keys(stats.excluded || {}).length > 0 && <div style={{ ...S.muted, marginBottom: 8 }}>Kept out of matching (with reasons): {Object.entries(stats.excluded).map(([k, n]) => `${REASON[k] || k}: ${n}`).join(' · ')}</div>}
        <div style={{ ...S.muted, marginBottom: 10 }}>Credentials: {st.credentials}. Branch list read {st.branches_at ? dtm(st.branches_at) : '—'} ({st.branches} branches).{' '}
          {meta.integrations.scheduler
            ? <>Scheduled: {st.scheduled.enabled ? `${st.scheduled.times.join(', ')} IST` : 'off'}{st.scheduled.last && st.scheduled.last.last_tick_at ? ` · last scheduled run ${dtm(st.scheduled.last.last_tick_at)} (${st.scheduled.last.last_mode}: ${st.scheduled.last.last_result})` : ''}</>
            : <>Automatic sync: {st.auto_last ? `last run ${dtm(st.auto_last.at)} (${st.auto_last.mode === 'recheck' ? 'with the check for deleted documents' : st.auto_last.quiet ? 'nothing new' : (RUN_TEXT[st.auto_last.status] || st.auto_last.status).toLowerCase()})` : 'not seen yet'} — a GitHub schedule checks Zoho about every 15 minutes (8:37 AM–11:22 PM IST) and for deleted documents at 1 AM{st.auto_last ? '' : '; it starts once the first sync is done and the repository secrets APP_URL and CRON_SECRET are set'}. The buttons below sync now.</>}</div>

        {never && (
          <div style={S.notice}>
            <b>Step 1 — bring in your Zoho Books documents.</b> Nothing has been read from Zoho Books yet.{' '}
            {meta.rights.prepare
              ? <>Choose the months below (the latest three are filled in) and click <b>Start syncing this period</b>, then keep this page open until it says "Sync finished". <b>Sync changes now</b> becomes available after that — it only picks up changes made after a first sync. <b>Tip:</b> amounts are read only for GSTINs that are switched on (Settings → Companies &amp; GSTINs → Active), so switch off the ones you are not reconciling yet and the first sync is much faster.</>
              : <>Someone with the "Prepare" right needs to run the first sync.</>}
          </div>
        )}
        {meta.rights.prepare && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button style={never ? S.btn : S.primary} disabled={busy || never} onClick={() => start('incremental')} title={never ? 'Available after the first sync — it reads only what changed in Zoho since then' : 'Reads only what changed in Zoho since the last sync, then fetches amounts for new and edited documents'}>Sync changes now</button>
            <button style={never ? S.primary : S.btn} disabled={busy} onClick={() => setShowPeriod(v => !v)}>{never ? 'Start the first sync…' : 'Sync a period…'}</button>
            <button style={S.ghost} disabled={busy} onClick={() => start('recheck')} title="Re-reads the whole period and removes documents Zoho no longer has (deleted ones never show up as changes)">Check for deleted documents</button>
            {busy && <button style={S.danger} onClick={stop}>Stop</button>}
            <button style={S.ghost} onClick={load}>Refresh</button>
          </div>
        )}
        {showPeriod && meta.rights.prepare && (
          <div style={{ ...S.card, background: '#F9F9F9', padding: '0.8rem 1rem', marginTop: 10, marginBottom: 0 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="From month"><input type="month" style={S.input} value={period.from} onChange={e => setPeriod({ ...period, from: e.target.value })} /></Field>
              <Field label="To month"><input type="month" style={S.input} value={period.to} onChange={e => setPeriod({ ...period, to: e.target.value })} /></Field>
              <button style={S.primary} disabled={busy || !period.from || !period.to} onClick={() => { start('period'); setShowPeriod(false); }}>Start syncing this period</button>
            </div>
            <p style={{ ...S.muted, margin: '8px 0 0', lineHeight: 1.5 }}>Zoho's list has no GST amounts, so each bill that can be matched needs one extra call to read its detail. A long period therefore takes several days at the daily budget ({b.limit} calls){meta.integrations.scheduler ? ' — it keeps going on its own at each scheduled run' : ' — online, start the same period again on the next day (or when it pauses) and it carries on where it stopped'} and can be stopped and resumed safely. The latest three months are filled in so that the first sync finishes quickly; go further back afterwards, a few months at a time (the invoices of the last financial year are the most time-critical: see the deadline notice on Overview).</p>
          </div>
        )}
        {(st.runs || []).length > 0 && (
          <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>Recent sync runs ({st.runs.length})</summary>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
              <thead><tr><th style={S.th}>Started</th><th style={S.th}>Mode</th><th style={S.th}>By</th><th style={S.th}>Result</th><th style={{ ...S.th, ...S.thR }}>Amounts fetched</th><th style={{ ...S.th, ...S.thR }}>New / changed in list</th><th style={{ ...S.th, ...S.thR }}>Removed</th><th style={{ ...S.th, ...S.thR }}>Zoho calls</th><th style={S.th}>Note</th></tr></thead>
              <tbody>{st.runs.map(r => (
                <tr key={r.run_id}><td style={S.td}>{dtm(r.started_at)}</td><td style={S.td}>{r.mode}{r.from ? ` ${r.from}…${r.to}` : ''}</td><td style={S.td}>{r.by}</td><td style={S.td}><Tag tone={RUN_TONE[r.status] || 'grey'}>{RUN_TEXT[r.status] || r.status}</Tag></td>
                  <td style={{ ...S.td, ...S.num }}>{r.details.fetched}</td><td style={{ ...S.td, ...S.num }}>{Object.values(r.lists).reduce((a, l) => a + l.added + l.changed, 0)}</td><td style={{ ...S.td, ...S.num }}>{r.details.deleted}</td><td style={{ ...S.td, ...S.num }}>{r.calls}</td>
                  <td style={{ ...S.td, ...S.muted }}>{r.error || r.message || (r.warnings || []).slice(0, 2).join(' · ')}</td></tr>))}</tbody>
            </table></details>
        )}
      </div>
    </div>
  );
}
const Stat = ({ k, v, sub, tone }) => (
  <div style={{ border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.5rem 0.7rem' }}>
    <div style={S.label}>{k}</div><div style={{ fontSize: '1.05rem', fontWeight: 700, color: tone === 'bad' ? '#B91C1C' : tone === 'warn' ? '#B45309' : tone === 'good' ? '#15803D' : '#18191B' }}>{v}</div>{sub && <div style={S.small}>{sub}</div>}
  </div>
);

// ── Statement upload: preview, then import ───────────────────────────────────
function UploadPanel({ meta, onChanged }) {
  const [file, setFile] = useState(null);
  const [gstin, setGstin] = useState('');
  const [period, setPeriod] = useState('');
  const [pv, setPv] = useState(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const regs = meta.companies.filter(c => !c.demo).flatMap(c => c.registrations.map(r => ({ gstin: r.gstin, label: `${r.gstin} · ${c.short} ${r.label || ''}` })));
  const input = useRef(null);

  const preview = async () => {
    setBusy(true); setError(''); setPv(null); setResult(null); setAck(false);
    try { const f = new FormData(); f.append('file', file); if (gstin) f.append('gstin', gstin); if (period) f.append('period', period); setPv(await g.preview(f)); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const commit = async () => {
    setBusy(true); setError('');
    try { const r = await g.commit({ preview_id: pv.preview_id, gstin: pv.meta.gstin, period: pv.meta.period, ack }); setResult(r); setPv(null); setFile(null); if (input.current) input.current.value = ''; onChanged(); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div style={S.card}>
      <div style={S.cardHead}><span style={S.cardTitle}>Upload a GSTR-2B statement</span><span style={S.small}>From the GST portal: Returns → GSTR-2B → Download (JSON or Excel). One file per GSTIN and month.</span></div>
      <div style={S.cardBody}>
        <Msg error={error} />
        {result && (
          <div style={S.ok}>
            Imported {result.statement.gstin} {result.statement.period} — version {result.statement.version}{result.statement.is_current ? ' (now current)' : ' (kept as history only)'}: {result.statement.docs} documents.
            {result.reconciliation && result.reconciliation.summary && <> Reconciled: {result.reconciliation.summary.exact + result.reconciliation.summary.tolerance} matched, {result.reconciliation.summary.suggested} suggested, {result.reconciliation.summary.mismatched} mismatched, {result.reconciliation.summary.books_only} Books-only, {result.reconciliation.summary.portal_only} GSTR-2B-only.
              {result.reconciliation.changes && !result.reconciliation.changes.first_run && <> {result.reconciliation.changes.moved || 0} existing row(s) changed status.</>}</>}
            {result.reconciliation && result.reconciliation.error && <> Reconciliation did not run: {result.reconciliation.error}</>}
          </div>)}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="File (.json or .xlsx)"><input ref={input} type="file" accept=".json,.xlsx,.xls" onChange={e => { setFile(e.target.files[0] || null); setPv(null); setResult(null); }} /></Field>
          <Field label="GSTIN" hint="only if the file does not say"><select style={S.select} value={gstin} onChange={e => setGstin(e.target.value)}><option value="">From the file</option>{regs.map(r => <option key={r.gstin} value={r.gstin}>{r.label}</option>)}</select></Field>
          <Field label="Return period" hint="only if the file does not say"><input type="month" style={S.input} value={period} onChange={e => setPeriod(e.target.value)} /></Field>
          <button style={S.primary} disabled={!file || busy} onClick={preview}>{busy && !pv ? 'Reading…' : 'Preview'}</button>
        </div>
        <div style={{ ...S.small, marginTop: 6 }}>The file is stored unchanged (named by its SHA-256 fingerprint) before anything is read from it. Nothing is imported until you confirm the preview.</div>

        {pv && (
          <div style={{ marginTop: 14 }}>
            {pv.blockers.map((b, i) => <div key={i} style={S.error}>{b}</div>)}
            {pv.warnings.map((w, i) => <div key={i} style={S.notice}>{w}</div>)}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: 10 }}>
              <Stat k="File" v={pv.file_name} sub={`${pv.format.toUpperCase()} · ${(pv.size / 1024).toFixed(0)} KB`} />
              <Stat k="Belongs to" v={pv.meta.gstin || '—'} sub={pv.company_name || 'GSTIN not set up'} />
              <Stat k="Return period" v={pv.meta.period ? monthName(pv.meta.period) : '—'} sub={pv.meta.gendt ? `generated ${dt(pv.meta.gendt)}` : 'no generation date in file'} />
              <Stat k="Documents read" v={pv.docs} sub={`will be version ${pv.version}${pv.becomes_current ? ' · replaces the current one' : ' · history only'}`} />
              <Stat k="Row problems" v={pv.error_count} tone={pv.error_count ? 'warn' : 'good'} />
              <Stat k="Portal summary check" v={pv.control.ok === true ? 'Agrees' : pv.control.ok === false ? 'DIFFERS' : 'Not in file'} tone={pv.control.ok === false ? 'bad' : pv.control.ok ? 'good' : undefined} sub={pv.control.note} />
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
              <thead><tr><th style={S.th}>Section</th><th style={S.th}>Matched in Phase 1?</th><th style={{ ...S.th, ...S.thR }}>Documents</th><th style={{ ...S.th, ...S.thR }}>Taxable</th><th style={{ ...S.th, ...S.thR }}>IGST</th><th style={{ ...S.th, ...S.thR }}>CGST</th><th style={{ ...S.th, ...S.thR }}>SGST</th><th style={{ ...S.th, ...S.thR }}>Cess</th></tr></thead>
              <tbody>{Object.entries(pv.sections).map(([k, s]) => <tr key={k}><td style={S.td}>{s.label}</td><td style={S.td}>{s.matchable ? <Tag tone="green">Yes</Tag> : <Tag tone="amber">Imported only — shown as Excluded</Tag>}</td><td style={{ ...S.td, ...S.num }}>{s.count}</td>{['taxable', 'igst', 'cgst', 'sgst', 'cess'].map(c => <td key={c} style={{ ...S.td, ...S.num }}>{inr(s.amounts[c])}</td>)}</tr>)}
                {pv.unsupported.map(u => <tr key={u.section}><td style={S.td}>{u.label}</td><td style={S.td}><Tag tone="red">NOT imported</Tag></td><td style={{ ...S.td, ...S.num }}>{u.count}</td><td colSpan={5} style={{ ...S.td, ...S.muted }}>{u.reason}</td></tr>)}</tbody>
            </table>
            {pv.error_count > 0 && (
              <details open style={{ marginBottom: 10 }}><summary style={{ cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}>{pv.error_count} row problem(s){pv.errors.length < pv.error_count ? ` (first ${pv.errors.length} shown)` : ''}</summary>
                <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}><thead><tr><th style={S.th}>Section</th><th style={S.th}>Where in the file</th><th style={S.th}>Field</th><th style={S.th}>Problem</th></tr></thead>
                  <tbody>{pv.errors.slice(0, 60).map((e, i) => <tr key={i}><td style={S.td}>{e.section}</td><td style={S.td}>{e.ref}</td><td style={S.td}>{e.field}</td><td style={S.td}>{e.message}</td></tr>)}</tbody></table>
                <div style={S.small}>Documents with problems are still imported (flagged, and shown as Excluded where they cannot be matched reliably) — nothing is dropped.</div></details>)}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {pv.needs_ack && <label style={{ fontSize: '0.8rem', display: 'flex', gap: 6 }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> I have reviewed the row problems / control-total difference and want to import anyway</label>}
              <button style={S.primary} disabled={!pv.can_commit || busy || (pv.needs_ack && !ack)} onClick={commit}>{busy ? 'Importing…' : `Import as version ${pv.version}`}</button>
              <button style={S.ghost} onClick={() => setPv(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Statements and versions ──────────────────────────────────────────────────
function Statements({ meta, filters, stamp }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState([]);
  const [diff, setDiff] = useState(null);
  const key = JSON.stringify([filters.company, filters.gstin]);
  useEffect(() => { g.imports({ company: filters.company || 'all', gstin: filters.gstin }).then(r => setList(r.statements)).catch(e => setError(errMsg(e))); }, [key, stamp]);   // eslint-disable-line
  if (error) return <div style={S.error}>{error}</div>;
  if (!list) return <div style={S.center}>Loading…</div>;
  const togglePick = s => setPick(p => (p.includes(s.id) ? p.filter(x => x !== s.id) : [...p, s.id].slice(-2)));
  const two = pick.length === 2 ? pick.map(id => list.find(s => s.id === id)) : null;
  const canCompare = two && two[0].gstin === two[1].gstin && two[0].period === two[1].period;
  const compare = async () => { setError(''); try { const [a, b] = two.sort((x, y) => x.version - y.version); setDiff(await g.diff(a.id, b.id)); } catch (e) { setError(errMsg(e)); } };

  return (
    <div style={S.card}>
      <div style={S.cardHead}><span style={S.cardTitle}>Statements imported ({list.length})</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={S.small}>Tick two versions of the same GSTIN and month to compare them</span><button style={S.btn} disabled={!canCompare} onClick={compare}>Compare versions</button></span></div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
          <thead><tr><th style={S.th} /><th style={S.th}>GSTIN</th><th style={S.th}>Period</th><th style={S.th}>Version</th><th style={S.th}>Generated (portal)</th><th style={S.th}>Imported</th><th style={S.th}>By</th><th style={S.th}>File</th><th style={{ ...S.th, ...S.thR }}>Documents</th><th style={{ ...S.th, ...S.thR }}>Row problems</th><th style={S.th}>Portal summary</th><th style={S.th} /></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={12} style={{ ...S.td, textAlign: 'center', padding: '1.5rem', color: '#9BA8B0' }}>No statements imported yet.</td></tr>}
            {list.map(s => (
              <tr key={s.id} style={{ opacity: s.is_current ? 1 : 0.65 }}>
                <td style={S.td}><input type="checkbox" checked={pick.includes(s.id)} onChange={() => togglePick(s)} /></td>
                <td style={S.td}>{s.gstin}{s.demo && <Tag tone="violet">DEMO</Tag>}<div style={S.small}>{s.company_name}</div></td><td style={S.td}>{monthName(s.period)}</td>
                <td style={S.td}>v{s.version} {s.is_current ? <Tag tone="green">current</Tag> : <Tag tone="grey">history</Tag>}</td><td style={S.td}>{s.gendt ? dt(s.gendt) : '—'}</td><td style={S.td}>{dtm(s.imported_at)}</td><td style={S.td}>{s.imported_by}</td>
                <td style={{ ...S.td, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${s.file_name}\nSHA-256 ${s.sha256}`}>{s.file_name}</td>
                <td style={{ ...S.td, ...S.num }}>{s.docs}</td><td style={{ ...S.td, ...S.num, color: s.error_count ? '#B45309' : undefined }}>{s.error_count}{s.acknowledged ? ' ✓' : ''}</td>
                <td style={S.td}>{s.control && s.control.ok === true ? <Tag tone="green">Agrees</Tag> : s.control && s.control.ok === false ? <Tag tone="red">Differs</Tag> : <Tag tone="grey">n/a</Tag>}</td>
                <td style={S.td}><button style={{ ...S.ghost, padding: '0.1rem 0.5rem' }} onClick={() => download(g.fileUrl(s.id), {}, s.file_name).catch(e => setError(errMsg(e)))}>Original</button></td>
              </tr>))}
          </tbody>
        </table>
      </div>
      {diff && (
        <div style={{ padding: '0.8rem 1.1rem', borderTop: '1px solid #DFE7E3' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Version {diff.a.version} (generated {diff.a.gendt || '—'}, {diff.a.docs} documents) → version {diff.b.version} (generated {diff.b.gendt || '—'}, {diff.b.docs} documents)</div>
          <div style={{ ...S.muted, marginBottom: 6 }}>{diff.counts.added} added · {diff.counts.removed} removed · {diff.counts.changed} changed. Change in tax the portal marks "ITC available": IGST {inr(diff.itc_available_impact.igst, { sign: true })}, CGST {inr(diff.itc_available_impact.cgst, { sign: true })}, SGST {inr(diff.itc_available_impact.sgst, { sign: true })}, cess {inr(diff.itc_available_impact.cess, { sign: true })}.</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>Change</th><th style={S.th}>Supplier</th><th style={S.th}>Document</th><th style={S.th}>Date</th><th style={{ ...S.th, ...S.thR }}>Taxable</th><th style={{ ...S.th, ...S.thR }}>IGST</th><th style={{ ...S.th, ...S.thR }}>CGST</th><th style={{ ...S.th, ...S.thR }}>SGST</th></tr></thead>
            <tbody>
              {[...diff.added.map(x => ['Added', x]), ...diff.removed.map(x => ['Removed', x]), ...diff.changed.map(x => ['Changed', x.after, x.before])].slice(0, 200).map(([t, x, old], i) => (
                <tr key={i}><td style={S.td}><Tag tone={t === 'Added' ? 'green' : t === 'Removed' ? 'red' : 'amber'}>{t}</Tag></td><td style={S.td}>{x.name || x.supplier}</td><td style={S.td}>{x.doc_no}</td><td style={S.td}>{dt(x.doc_date)}</td>
                  {['taxable', 'igst', 'cgst', 'sgst'].map(c => <td key={c} style={{ ...S.td, ...S.num }}>{inr(x.amounts[c])}{old && old.amounts[c] !== x.amounts[c] ? <div style={S.small}>was {inr(old.amounts[c])}</div> : null}</td>)}</tr>))}
            </tbody>
          </table>
          <div style={S.small}>{diff.note}</div>
        </div>
      )}
    </div>
  );
}
