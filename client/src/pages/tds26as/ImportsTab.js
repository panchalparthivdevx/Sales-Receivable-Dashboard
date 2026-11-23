import React, { useEffect, useRef, useState } from 'react';
import { t, errMsg } from './api';
import { S, r, dt, dtm, Msg, Field, Tag, tableWrap, table, srcText } from './ui';

const ICON = { ok: '✔', warning: '⚠', error: '✖' };
const COLOR = { ok: '#15803D', warning: '#B45309', error: '#B91C1C' };

export default function ImportsTab({ meta, entity, params, stamp, onChanged }) {
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState('');
  const [needPw, setNeedPw] = useState(false);
  const [pv, setPv] = useState(null);
  const [extra, setExtra] = useState({ fy: '', statement_date: '', ack: false });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [list, setList] = useState(null);
  const [st, setSt] = useState(null);
  const [prog, setProg] = useState(null);
  const stop = useRef(false);
  const fileRef = useRef(null);
  const loadList = () => t.imports(entity.id).then(x => setList(x.statements)).catch(e => setErr(errMsg(e)));
  const loadSt = () => t.syncStatus(entity.id).then(setSt).catch(() => {});
  useEffect(() => { loadList(); loadSt(); }, [entity.id, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { stop.current = true; }, []);

  const preview = async () => {
    if (!file) return setErr('Choose a file first');
    setBusy('preview'); setErr(''); setOk(''); setPv(null);
    const fd = new FormData(); fd.append('entity', entity.id); fd.append('file', file); if (password) fd.append('password', password);
    try { const x = await t.preview(fd); setPv(x); setNeedPw(false); setExtra({ fy: x.header.fy || '', statement_date: x.header.statement_date || '', ack: false }); }
    catch (e) { const b = e?.response?.data; if (b && b.needs_password) { setNeedPw(true); setErr(b.wrong_password ? 'That password is not correct — try again.' : errMsg(e)); } else setErr(errMsg(e)); }
    finally { setBusy(''); }
  };
  const commit = async () => {
    setBusy('commit'); setErr('');
    try {
      const x = await t.commit({ entity: entity.id, preview_id: pv.preview_id, fy: extra.fy, statement_date: extra.statement_date, ack: extra.ack });
      setOk(x.unchanged ? x.message : `Imported: FY ${x.statement.fy}, version ${x.statement.version}${x.statement.active ? ' — now in use' : ' — kept as history (an equal or later statement is in use)'}; ${x.statement.totals.rows} rows, deposited ${r(x.statement.totals.deposited)}${x.revision ? `. Compared with the previous version: ${x.revision.added} added, ${x.revision.removed} removed, ${x.revision.changed} changed.` : '.'}`);
      setPv(null); setFile(null); setPassword(''); if (fileRef.current) fileRef.current.value = '';
      loadList(); onChanged();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(''); }
  };

  const sync = async mode => {
    stop.current = false; setErr(''); setOk(''); setBusy('sync');
    try {
      let x = await t.syncStep({ entity: entity.id, start: true, mode, ...params });
      setProg(x);
      for (let i = 0; x.more && !stop.current && i < 200; i++) { x = await t.syncStep({ entity: entity.id }); setProg(x); }
      if (x.busy) setErr(String(x.message || 'A sync step for this entity is already running — wait a few minutes and try again.'));
      else if (x.error) setErr(`Zoho sync: ${String(x.error)}`); else if (stop.current) setOk('Stopped after the current step — start again to continue.'); else setOk(`Zoho sync finished (${x.calls} calls in the last step). The reconciliation is up to date.`);
      onChanged();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(''); loadSt(); }
  };
  const cancel = async () => { stop.current = true; try { await t.syncCancel(entity.id); } catch (_) { /* best effort */ } };
  const v = pv && pv.validation;
  const blocked = v && v.blockers.length > 0;
  const needAck = v && v.needs_ack.length > 0;
  return (
    <div>
      <Msg error={err} ok={ok} onClose={() => { setErr(''); setOk(''); }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: '1rem' }}>
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Upload a Form 26AS — {entity.name}</span><span style={S.small}>PAN {entity.pan}</span></div>
          <div style={S.cardBody}>
            {!meta.rights.prepare ? <div style={S.muted}>Uploading needs the "Prepare" right.</div> : entity.demo ? <div style={S.muted}>The demo entity's statements are synthetic; choose a real entity to upload.</div> : (
              <>
                <p style={{ ...S.muted, marginTop: 0, lineHeight: 1.5 }}>PDF (from the e-filing portal or TRACES, password-protected or not), the TRACES text export (.txt, or the .zip as downloaded), or an Excel / CSV copy. Nothing is imported until you confirm the preview.</p>
                <input ref={fileRef} type="file" accept=".pdf,.txt,.zip,.xlsx,.xls,.csv" onChange={e => { setFile(e.target.files[0] || null); setPv(null); setNeedPw(false); setPassword(''); }} />
                {needPw && <Field label="Password of the file" style={{ marginTop: 10 }} hint="Usually the date of birth / incorporation as DDMMYYYY. It is used once to open the file and is not stored."><input type="password" autoFocus style={S.input} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && preview()} /></Field>}
                <div style={{ marginTop: 10 }}><button style={S.primary} disabled={!file || busy === 'preview'} onClick={preview}>{busy === 'preview' ? 'Reading…' : needPw ? 'Open with this password' : 'Preview'}</button> <span style={S.small}>max {meta.integrations.max_upload_mb} MB</span></div>
              </>
            )}
          </div>
        </div>
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Zoho Books sync (read-only)</span>{st && <span style={S.small}>{st.calls_day ? `${st.calls_day.n} of ${st.budget} calls today` : ''}</span>}</div>
          <div style={S.cardBody}>
            {entity.demo ? <div style={S.muted}>The demo entity has no Zoho organisation.</div> : (
              <>
                <div style={{ fontSize: '0.8rem', lineHeight: 1.6 }}>
                  Last successful sync: <b>{st && st.last_ok_at ? dtm(st.last_ok_at) : 'never'}</b>{st && st.last_period ? ` (${st.last_period.from} to ${st.last_period.to})` : ''}<br />
                  Ledgers: {entity.ledgers.map(l => <Tag key={l.account_id}>{l.name}{l.section ? ` · ${l.section}` : ''}</Tag>)}<br />
                  {st && st.last_error && <span style={{ color: '#B91C1C' }}>Last problem: {String(st.last_error)}</span>}
                </div>
                <p style={{ ...S.small, lineHeight: 1.5 }}>Reads the ledger postings for the period chosen above (month by month), then the invoices, payments and journals behind them — only new or changed ones after the first load. On the office PC the current year is also re-checked every day at {meta.schedule.times.join(', ')}.</p>
                {meta.rights.prepare && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button style={S.primary} disabled={!!busy} onClick={() => sync('changes')}>{busy === 'sync' ? 'Syncing…' : 'Sync the selected period'}</button>
                    <button style={S.ghost} disabled={!!busy} onClick={() => sync('full')} title="Also re-reads every invoice, payment and journal">Full re-read</button>
                    {busy === 'sync' && <button style={S.danger} onClick={cancel}>Stop</button>}
                  </div>
                )}
                {prog && <div style={{ ...S.small, marginTop: 8 }}>{prog.phase === 'ledgers' ? `Ledgers: ${prog.months_done} month(s) read, ${prog.months_left} to go` : prog.phase === 'details' ? `Details: ${prog.details_left} document(s) to read` : 'Done'} · {prog.calls} call(s) in the last step</div>}
                {st && st.listed && <div style={{ ...S.small, marginTop: 8 }}>Months synced: {Object.keys(st.listed).sort().join(', ') || 'none'}</div>}
              </>
            )}
          </div>
        </div>
      </div>

      {pv && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Preview — {pv.file_name}{pv.inner_file ? ` › ${pv.inner_file}` : ''}</span><span style={S.small}>format: {pv.format} · sha256 {pv.sha256.slice(0, 12)}…</span></div>
          <div style={S.cardBody}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
              <div>
                {v.checks.map(c => <div key={c.id} style={{ fontSize: '0.78rem', padding: '0.2rem 0', color: COLOR[c.level] }}><b>{ICON[c.level]} {c.label}</b><div style={{ color: '#5D6C7B', marginLeft: 16 }}>{c.detail}</div></div>)}
              </div>
              <div style={{ fontSize: '0.78rem', lineHeight: 1.7 }}>
                <div><b>PAN:</b> {pv.header.pan || '—'} {pv.header.name && `(${pv.header.name})`}</div>
                <div><b>Financial year:</b> {pv.header.fy || '—'}{pv.header.ay ? ` · AY ${pv.header.ay}` : ''}{pv.header.tax_year ? ` · tax year ${pv.header.tax_year}` : ''}</div>
                <div><b>Statement date:</b> {pv.header.statement_date ? `${dt(pv.header.statement_date)} (${pv.header.statement_date_basis})` : '—'}</div>
                <div><b>Rows:</b> {pv.totals.rows} · <b>deductors:</b> {pv.totals.deductors}</div>
                <div><b>Amount paid:</b> {r(pv.totals.amount_paid)} · <b>deducted:</b> {r(pv.totals.deducted)} · <b>deposited:</b> {r(pv.totals.deposited)}</div>
                <div><b>Parts found:</b> {pv.parts_seen.join(', ') || '—'}</div>
                {pv.sections && pv.sections.length > 0 && <div><b>Sections:</b> {pv.sections.map(x => <Tag key={x.code} title={`${x.label ? `${x.label} — ` : ''}${x.rows} row(s), deposited ${r(x.deposited)}`}>{x.code === x.family ? x.code : `${x.code} → ${x.family}`} · {x.rows}</Tag>)}</div>}
                {pv.reversals && (pv.reversals.pairs > 0 || pv.reversals.unpaired > 0) && <div><b>Reversals:</b> {pv.reversals.pairs} pair(s) of a row and the same row in brackets cancel out before matching ({r(pv.reversals.deposited)} each way){pv.reversals.unpaired ? ` · ${pv.reversals.unpaired} bracketed row(s) without a pair — shown for checking` : ''}</div>}
                {pv.revision && <div style={{ ...S.info, marginTop: 6 }}>Compared with version {pv.revision.against.version} (dated {dt(pv.revision.against.statement_date)}): {pv.revision.added} row(s) added ({r(pv.revision.added_deposited)}), {pv.revision.removed} removed ({r(pv.revision.removed_deposited)}), {pv.revision.changed} changed (deposit / status). Importing replaces its credits — they are not added on top.</div>}
              </div>
            </div>
            {pv.control.length > 0 && <div style={{ marginTop: 10 }}><b style={{ fontSize: '0.8rem' }}>Control-total differences</b>{pv.control.map((c, i) => <div key={i} style={{ fontSize: '0.75rem' }}>{c.deductor} ({c.tan}) — {c.field}: summary {r(c.summary)}, rows {r(c.rows)} <span style={S.small}>{srcText(c.src)}</span></div>)}</div>}
            {pv.problems.length > 0 && (
              <div style={{ marginTop: 10 }}><b style={{ fontSize: '0.8rem' }}>Rows to look at ({pv.problem_count})</b>
                <div style={{ maxHeight: 180, overflowY: 'auto' }}>{pv.problems.map((p, i) => <div key={i} style={{ fontSize: '0.74rem', color: COLOR[p.level] }}>{ICON[p.level]} {p.message} <span style={S.small}>{srcText(p.src)}</span></div>)}</div>
              </div>
            )}
            <div style={{ ...tableWrap, maxHeight: 300, marginTop: 10, border: '1px solid #DFE7E3', borderRadius: 8 }}>
              <table style={table}>
                <thead><tr>{['Deductor', 'TAN', 'Section', 'Transaction date', 'Status', 'Booking date', 'Amount paid', 'Tax deducted', 'TDS deposited', 'Source'].map((c, i) => <th key={c} style={{ ...S.th, ...(i >= 6 && i <= 8 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
                <tbody>{pv.rows.slice(0, 200).map((x, i) => (
                  <tr key={i}><td style={S.td}>{x.deductor}</td><td style={S.td}>{x.tan}</td><td style={S.td}>{x.section}{(() => { const f = (pv.sections || []).find(y => y.code === x.section); return f && f.family !== x.section ? <span style={S.small}> → {f.family}</span> : null; })()}</td><td style={S.td}>{dt(x.txn_date)}</td><td style={S.td}>{x.status}</td><td style={S.td}>{dt(x.booking_date)}</td>
                    <td style={{ ...S.td, ...S.num }}>{r(x.amount_paid)}</td><td style={{ ...S.td, ...S.num }}>{r(x.deducted)}</td><td style={{ ...S.td, ...S.num }}>{r(x.deposited)}</td><td style={{ ...S.td, ...S.small }}>{srcText(x.src)}</td></tr>))}</tbody>
              </table>
            </div>
            {pv.totals.rows > 200 && <div style={S.small}>First 200 of {pv.totals.rows} rows shown.</div>}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
              {!pv.header.fy && <Field label="Financial year of the statement"><input style={S.input} placeholder="2025-26" value={extra.fy} onChange={e => setExtra({ ...extra, fy: e.target.value })} /></Field>}
              {!pv.header.statement_date && <Field label='Statement date ("Data updated till")'><input type="date" style={S.input} value={extra.statement_date} onChange={e => setExtra({ ...extra, statement_date: e.target.value })} /></Field>}
              {needAck && !blocked && <label style={{ fontSize: '0.78rem', display: 'flex', gap: 6, alignItems: 'center', color: '#B45309' }}><input type="checkbox" checked={extra.ack} onChange={e => setExtra({ ...extra, ack: e.target.checked })} /> I have looked at "{v.needs_ack.join('", "')}" and want to import anyway</label>}
              <div style={{ flex: 1 }} />
              <button style={S.ghost} onClick={() => setPv(null)}>Discard</button>
              <button style={S.primary} disabled={blocked || (needAck && !extra.ack) || busy === 'commit'} onClick={commit}>{busy === 'commit' ? 'Importing…' : pv.same_file ? 'Confirm (nothing will change)' : 'Import this statement'}</button>
            </div>
            {blocked && <div style={{ ...S.error, marginTop: 8 }}>Cannot be imported for {entity.name}: {v.blockers.join(' · ')}</div>}
          </div>
        </div>
      )}

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Statements of {entity.name}</span><span style={S.small}>the version in use per year is the one with the latest statement date</span></div>
        <div style={tableWrap}>
          <table style={table}>
            <thead><tr>{['FY', 'Version', 'Statement date', 'Uploaded', 'File', 'Rows', 'Deposited', 'In use', 'Changes vs previous', ''].map((c, i) => <th key={c + i} style={{ ...S.th, ...(i === 5 || i === 6 ? S.thR : {}) }}>{c}</th>)}</tr></thead>
            <tbody>
              {list && list.length === 0 && <tr><td colSpan={10} style={S.center}>No statement uploaded yet.</td></tr>}
              {(list || []).map(s => (
                <tr key={s.id} style={{ opacity: s.active ? 1 : 0.6 }}>
                  <td style={S.td}>{s.fy}</td><td style={S.td}>v{s.version}</td><td style={S.td}>{dt(s.statement_date)}<div style={S.small}>{s.statement_date_basis}</div></td><td style={S.td}>{dtm(s.uploaded_at)}<div style={S.small}>{s.by}</div></td>
                  <td style={{ ...S.td, fontSize: '0.72rem' }}>{s.file_name}{s.problems ? <div style={S.small}>{s.problems} row problem(s){s.acknowledged.length ? ', acknowledged' : ''}</div> : null}</td>
                  <td style={{ ...S.td, ...S.num }}>{s.totals.rows}</td><td style={{ ...S.td, ...S.num }}>{r(s.totals.deposited)}</td>
                  <td style={S.td}>{s.active ? <Tag tone="green">in use</Tag> : <Tag>history</Tag>}</td>
                  <td style={{ ...S.td, fontSize: '0.72rem' }}>{s.revision ? `+${s.revision.added} −${s.revision.removed} ~${s.revision.changed}` : '—'}</td>
                  <td style={S.td}><button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => t.fileDownload(s.id, s.file_name).catch(e => setErr(errMsg(e)))}>Original</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
