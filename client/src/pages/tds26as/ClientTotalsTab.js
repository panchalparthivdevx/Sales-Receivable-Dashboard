import React, { useEffect, useMemo, useState } from 'react';
import { t, errMsg } from './api';
import { S, r, rs, dt, Msg, Modal, Field, StatusPill, tableWrap, table, STATUS_KEYS } from './ui';

// Client totals (24 Nov 2026): per client, the period's Zoho TDS against the 26AS figures, the difference and the items' statuses — and
// one status with remarks for a whole client (or several ticked clients), e.g. "Matched Rounding Diff." where the total difference is
// negligible. Server: GET /reports/clients, POST /review/client-decision (lib/review.decideClients).

const KIND = { client: '', unmapped_customer: 'Customer not mapped', unmapped_tan: 'Deductor not mapped', unallocated: 'Unallocated' };
const CLIENT_STATUSES = STATUS_KEYS.filter(s => s !== 'carry_forward');
const SORTS = { client: 'Client name', diff_asc: 'Smallest difference first', diff_desc: 'Largest difference first', zoho: 'Largest Zoho TDS first' };

export default function ClientTotalsTab({ meta, params, stamp, onDrill, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [f, setF] = useState({ search: '', max: '', show: 'all', sort: 'client' });
  const [sel, setSel] = useState({});
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const canReview = meta.rights.review;
  const load = () => { setErr(''); return t.clientTotals(params).then(x => { setD(x); setSel({}); }).catch(e => setErr(errMsg(e))); };
  useEffect(() => { setD(null); load(); }, [JSON.stringify(params), stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxP = f.max === '' || isNaN(parseFloat(f.max)) ? null : Math.round(parseFloat(f.max) * 100);
  const rows = useMemo(() => {
    if (!d) return [];
    const q = f.search.trim().toLowerCase();
    const by = {
      client: (a, b) => a.client.localeCompare(b.client),
      diff_asc: (a, b) => Math.abs(a.diff) - Math.abs(b.diff) || a.client.localeCompare(b.client),
      diff_desc: (a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.client.localeCompare(b.client),
      zoho: (a, b) => b.zoho - a.zoho || a.client.localeCompare(b.client),
    };
    return d.rows.filter(x => (!q || x.client.toLowerCase().includes(q) || x.tans.some(tn => tn.toLowerCase().includes(q)))
      && (maxP === null || Math.abs(x.diff) <= maxP)
      && (f.show === 'all' || (f.show === 'open' ? x.cleared < x.items : f.show === 'set' ? !!x.client_status : !x.client_status)))
      .sort(by[f.sort] || by.client);
  }, [d, f, maxP]);

  const chosen = rows.filter(x => sel[x.id]);
  const allShownTicked = rows.length > 0 && rows.every(x => sel[x.id]);
  const tickAll = on => setSel(on ? Object.fromEntries(rows.map(x => [x.id, true])) : {});
  const open = list => setEdit({ list, final_status: 'rounding', remarks: '', refs: '', attachments: [] });
  const exportIt = async () => { setBusy(true); setErr(''); try { await t.exportXlsx({ ...params, report: 'clients' }); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const drill = x => onDrill(x.kind === 'client' ? { group: x.id, label: x.client } : { ids: x.units.join(','), label: x.client });

  const upload = async file => {
    const fd = new FormData(); fd.append('entity', params.entity); fd.append('file', file);
    try { const a = await t.attach(fd); setEdit(e => ({ ...e, attachments: [...e.attachments, a] })); } catch (e) { setErr(errMsg(e)); }
  };
  const save = async () => {
    setBusy(true); setErr(''); setOk('');
    try {
      const out = await t.decideClients({ ...params, clients: edit.list.map(x => ({ id: x.id, units: x.units })), final_status: edit.final_status, remarks: edit.remarks,
        refs: edit.refs.split('\n').map(s => s.trim()).filter(Boolean), attachments: edit.attachments });
      const what = edit.final_status ? meta.statuses[edit.final_status] : 'the system status';
      setOk(`Saved: ${out.clients} client${out.clients === 1 ? '' : 's'}, ${out.units} item${out.units === 1 ? '' : 's'} set to ${what}.${out.skipped_carry_forward ? ` ${out.skipped_carry_forward} carry-forward item(s) were left as they are.` : ''}`);
      setEdit(null); onChanged(); await load();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  const tol = d ? d.rounding_tol_p : 200;
  const sumOf = (list, k) => list.reduce((a, x) => a + x[k], 0);
  const cols = [canReview ? '' : null, 'Client', 'Items', 'TDS booked (Zoho)', 'Tax deducted (26AS)', 'Tax deposited (26AS)', 'Difference', 'Item statuses', 'Client status / remarks', ''].filter(c => c !== null);
  const numCol = c => ['Items', 'TDS booked (Zoho)', 'Tax deducted (26AS)', 'Tax deposited (26AS)', 'Difference'].includes(c);

  return (
    <div>
      <Msg error={err} ok={ok} onClose={() => { setErr(''); setOk(''); }} />
      <div style={{ ...S.card, padding: '0.6rem 0.9rem', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label><span style={S.label}>Search</span><input style={{ ...S.input, width: 190 }} value={f.search} onChange={e => setF({ ...f, search: e.target.value })} placeholder="client or TAN" /></label>
        <label><span style={S.label}>Difference up to ₹ (either way)</span><input style={{ ...S.input, width: 120 }} inputMode="decimal" value={f.max} onChange={e => setF({ ...f, max: e.target.value.replace(/[^\d.]/g, '') })} placeholder="e.g. 500" /></label>
        <label><span style={S.label}>Show</span><select style={S.select} value={f.show} onChange={e => setF({ ...f, show: e.target.value })}>
          <option value="all">All clients</option><option value="open">With items not yet matched</option><option value="unset">No status for the whole client yet</option><option value="set">Status set for the whole client</option></select></label>
        <label><span style={S.label}>Sort</span><select style={S.select} value={f.sort} onChange={e => setF({ ...f, sort: e.target.value })}>{Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <div style={{ flex: 1 }} />
        {canReview && <button style={S.btn} disabled={!chosen.length} onClick={() => open(chosen)}>Set status for {chosen.length || ''} selected client{chosen.length === 1 ? '' : 's'}</button>}
        <button style={S.primary} disabled={busy} onClick={exportIt}>{busy && !edit ? 'Preparing…' : 'Export to Excel'}</button>
      </div>
      <div style={S.info}>
        Each row adds up the client's items in the selected period: the same figures as the Transactions list for that client. <b>Difference</b> = TDS booked in Zoho − tax deposited in 26AS.
        To clear clients whose total difference is negligible, enter an amount under <b>Difference up to ₹</b>, tick the clients and set one status with your remarks. It applies to every item of those clients in this period.
      </div>
      {!d ? <div style={S.center}>Loading…</div> : (
        <div style={S.card}>
          <div style={S.cardHead}>
            <span style={S.cardTitle}>{rows.length} client{rows.length === 1 ? '' : 's'}{rows.length !== d.rows.length ? ` of ${d.rows.length}` : ''}</span>
            <span style={S.muted}>{d.period.label || `${dt(d.period.from)} to ${dt(d.period.to)}`}</span>
          </div>
          <div style={tableWrap}>
            <table style={table}>
              <thead><tr>{cols.map((c, i) => <th key={c + i} style={{ ...S.th, ...(numCol(c) ? S.thR : {}) }}>{i === 0 && canReview ? <input type="checkbox" title="Tick every client shown" checked={allShownTicked} onChange={e => tickAll(e.target.checked)} /> : c}</th>)}</tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={cols.length} style={S.center}>No clients for these filters.</td></tr>}
                {rows.map(x => (
                  <tr key={x.id} style={sel[x.id] ? { background: '#F5F8FF' } : undefined}>
                    {canReview && <td style={S.td}><input type="checkbox" checked={!!sel[x.id]} onChange={e => setSel(s => ({ ...s, [x.id]: e.target.checked }))} /></td>}
                    <td style={{ ...S.td, minWidth: 210 }}><div style={{ fontWeight: 600 }}>{x.client}</div><div style={S.small}>{x.tans.join(', ')}{KIND[x.kind] ? ` · ${KIND[x.kind]}` : ''}</div></td>
                    <td style={{ ...S.td, ...S.num }}>{x.items}</td>
                    <td style={{ ...S.td, ...S.num }}>{r(x.zoho)}</td>
                    <td style={{ ...S.td, ...S.num }}>{r(x.deducted)}</td>
                    <td style={{ ...S.td, ...S.num }}>{r(x.deposited)}</td>
                    <td style={{ ...S.td, ...S.num, fontWeight: 700, color: x.diff === 0 ? '#15803D' : Math.abs(x.diff) <= tol ? '#0F766E' : '#B91C1C' }}>{rs(x.diff)}</td>
                    <td style={{ ...S.td, maxWidth: 260 }}><div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>{STATUS_KEYS.filter(k => x.by_status[k]).map(k => <StatusPill key={k} status={k} small statuses={{ [k]: `${x.by_status[k]} ${meta.statuses[k]}` }} />)}</div></td>
                    <td style={{ ...S.td, maxWidth: 280, fontSize: '0.72rem' }}>
                      {x.client_status ? <StatusPill status={x.client_status} statuses={meta.statuses} small title="Every item of the client in this period has this reviewer status" /> : x.reviewed ? <span style={S.small}>Reviewer status on {x.reviewed} of {x.items} items</span> : <span style={S.small}>—</span>}
                      {x.decision && <div style={{ marginTop: 3 }}>{x.decision.remarks}<div style={S.small}>{x.decision.by}, {dt(String(x.decision.at).slice(0, 10))}{!x.decision.this_period ? ` · set for ${x.decision.period.label || `${dt(x.decision.period.from)} to ${dt(x.decision.period.to)}`}` : ''}</div></div>}
                    </td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                      <button style={{ ...S.ghost, padding: '0.15rem 0.5rem' }} onClick={() => drill(x)}>Items</button>
                      {canReview && <button style={{ ...S.ghost, padding: '0.15rem 0.5rem', marginLeft: 4 }} onClick={() => open([x])}>Set status…</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && <tfoot><tr style={{ background: '#F9F9F9', fontWeight: 700 }}>
                {canReview && <td style={S.td} />}
                <td style={S.td}>Total ({rows.length} client{rows.length === 1 ? '' : 's'})</td>
                <td style={{ ...S.td, ...S.num }}>{sumOf(rows, 'items')}</td>
                {['zoho', 'deducted', 'deposited'].map(k => <td key={k} style={{ ...S.td, ...S.num }}>{r(sumOf(rows, k))}</td>)}
                <td style={{ ...S.td, ...S.num }}>{rs(sumOf(rows, 'diff'))}</td>
                <td style={S.td} colSpan={3} />
              </tr></tfoot>}
            </table>
          </div>
          {rows.length !== d.rows.length && <div style={{ ...S.small, padding: '0.5rem 1rem' }}>All {d.rows.length} rows in the period: Zoho {r(d.totals.zoho)} · deducted {r(d.totals.deducted)} · deposited {r(d.totals.deposited)} · difference {rs(d.totals.diff)}</div>}
        </div>
      )}
      {edit && (() => {
        const L = edit.list, items = sumOf(L, 'items'), diff = sumOf(L, 'diff');
        const over = L.filter(x => Math.abs(x.diff) > tol);
        const cf = L.reduce((a, x) => a + (x.carry_forward || 0), 0);
        const big = over.slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0];
        return (
          <Modal title={L.length === 1 ? `Status for the whole client — ${L[0].client}` : `Status for ${L.length} clients`} onClose={() => !busy && setEdit(null)}>
            <div style={{ fontSize: '0.8rem', display: 'grid', gap: 4, marginBottom: 10 }}>
              <div><b>{items}</b> item{items === 1 ? '' : 's'} in {d.period.label || `${dt(d.period.from)} to ${dt(d.period.to)}`} · Zoho {r(sumOf(L, 'zoho'))} · deposited {r(sumOf(L, 'deposited'))} · difference <b>{rs(diff)}</b></div>
              {L.length > 1 && <div style={S.small}>{L.slice(0, 8).map(x => `${x.client} (${rs(x.diff)})`).join(' · ')}{L.length > 8 ? ` · and ${L.length - 8} more` : ''}</div>}
            </div>
            {['matched', 'rounding'].includes(edit.final_status) && over.length > 0 && (
              <div style={S.notice}>{over.length === 1 && L.length === 1 ? `The client's difference of ${rs(big.diff)} is` : `${over.length} of these clients have a difference`} above the {r(tol)} rounding tolerance{over.length > 1 || L.length > 1 ? ` (largest ${rs(big.diff)}, ${big.client})` : ''}. The status is recorded as your decision, with your remarks.</div>
            )}
            <Field label="Final status for every item of the client">
              <select style={{ ...S.select, width: '100%', maxWidth: '100%' }} value={edit.final_status} onChange={e => setEdit({ ...edit, final_status: e.target.value })}>
                {CLIENT_STATUSES.map(s => <option key={s} value={s}>{meta.statuses[s]}</option>)}
                <option value="">Back to the system status (clear the reviewer status)</option>
              </select>
            </Field>
            <Field label={`Remarks${edit.final_status ? ' (required)' : ''}`} style={{ marginTop: 10 }}><textarea rows={3} style={{ ...S.input, width: '100%' }} value={edit.remarks} onChange={e => setEdit({ ...edit, remarks: e.target.value })} placeholder="e.g. Total difference ₹185.54 for Apr–Sep 2026 is negligible — checked with the manual reconciliation" /></Field>
            <Field label="Supporting references (one per line)" style={{ marginTop: 10 }}><textarea rows={2} style={{ ...S.input, width: '100%' }} value={edit.refs} onChange={e => setEdit({ ...edit, refs: e.target.value })} /></Field>
            <Field label="Attachment (e.g. your reconciliation working)" style={{ marginTop: 10 }}>
              <input type="file" onChange={e => e.target.files[0] && upload(e.target.files[0])} />
              {edit.attachments.length > 0 && <div style={S.small}>{edit.attachments.map(a => a.name).join(', ')}</div>}
            </Field>
            <div style={{ ...S.small, marginTop: 10, lineHeight: 1.5 }}>
              The status is saved on each Zoho entry and 26AS credit of the client{L.length > 1 ? 's' : ''} in this period, so it also shows in the Transactions list and when you look at a shorter period. Entries or credits that arrive later keep the system status until reviewed.{cf ? ` ${cf} item(s) carried forward are left as they are.` : ''}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button style={S.ghost} disabled={busy} onClick={() => setEdit(null)}>Cancel</button>
              <button style={S.primary} disabled={busy || (edit.final_status && !edit.remarks.trim())} onClick={save}>{busy ? 'Saving…' : `Save for ${items} item${items === 1 ? '' : 's'}`}</button>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
