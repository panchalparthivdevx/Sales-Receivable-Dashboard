import React, { useEffect, useState } from 'react';
import { t, errMsg } from './api';
import { S, r, rs, dt, dtm, Msg, Drawer, Field, Statuses, Flags, StatusPill, KV, qLabel, srcText, STATUS_KEYS } from './ui';

const nextQuarters = from => {
  const out = [];
  let [fy, q] = [from.slice(0, 7), +from.slice(-1)];
  for (let i = 0; i < 8; i++) { q++; if (q > 4) { q = 1; const s = +fy.slice(0, 4) + 1; fy = `${s}-${String((s + 1) % 100).padStart(2, '0')}`; } out.push(`${fy}-Q${q}`); }
  return out;
};
const quarterOf = iso => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7), s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}-Q${m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4}`; };

export default function UnitDrawer({ meta, params, id, onClose, onSaved }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => t.unit({ ...params, id }).then(x => {
    setD(x);
    const u = x.unit;
    setForm({ final_status: u.final_status || '', remarks: (u.decision && u.decision.remarks) || '', refs: ((u.decision && u.decision.refs) || []).join('\n'), attachments: [], cf_target: '', cf_reason: '', non_deposit: false, nd_evidence: '' });
  }).catch(e => setErr(errMsg(e)));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async file => {
    const fd = new FormData(); fd.append('entity', params.entity); fd.append('file', file);
    try { const a = await t.attach(fd); setForm(f => ({ ...f, attachments: [...f.attachments, a] })); } catch (e) { setErr(errMsg(e)); }
  };
  const save = async () => {
    setBusy(true); setErr(''); setOk('');
    try {
      const body = { ...params, unit: id, final_status: form.final_status, remarks: form.remarks, refs: form.refs.split('\n').map(s => s.trim()).filter(Boolean),
        attachments: form.attachments, ...(form.final_status === 'carry_forward' ? { carry_forward: { target: form.cf_target, reason: form.cf_reason } } : {}),
        ...(form.non_deposit ? { non_deposit: { evidence: form.nd_evidence } } : {}) };
      const out = await t.decide(body);
      setOk(out.carry_forward ? `Saved. ${r(out.carry_forward.balance)} carried forward to ${qLabel(out.carry_forward.target_quarter)}.` : 'Saved.');
      onSaved(); await load();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const linkCandidate = async zKey => {
    try { await t.link({ entity: params.entity, zoho: [zKey], credits: d.unit.credits, note: 'chosen among equal candidates' }); setOk('Linked — the reconciliation now treats this pair as one match.'); onSaved(); onClose(); } catch (e) { setErr(errMsg(e)); }
  };
  const unlink = async lid => { try { await t.unlink(params.entity, lid); setOk('Link removed.'); onSaved(); onClose(); } catch (e) { setErr(errMsg(e)); } };

  if (!d) return <Drawer title="Item" onClose={onClose}>{err ? <div style={S.error}>{err}</div> : <div style={S.center}>Loading…</div>}</Drawer>;
  const u = d.unit, c = d.comparison;
  const reason = u.reason;
  const origin = quarterOf(u.date || params.from || `${(params.fy || '2025-26').slice(0, 4)}-04-01`);
  const cell = { ...S.td, fontSize: '0.75rem' };
  return (
    <Drawer title={`${u.client || 'Item'}${u.method !== 'single' ? ` — ${u.method_label}` : ''}`} onClose={onClose} width={900}>
      <Msg error={err} ok={ok} onClose={() => { setErr(''); setOk(''); }} />
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <Statuses u={u} statuses={meta.statuses} />
        <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>Difference {rs(u.diff)}</span>
        {u.matched_amount > 0 && (u.open_zoho > 0 || u.open_26as > 0) && <span style={S.muted}>matched {r(u.matched_amount)} · open Zoho {r(u.open_zoho)} · open 26AS {r(u.open_26as)}</span>}
        <Flags flags={u.flags} />
      </div>
      {reason && (
        <div style={reason.code === 'deducted_exceeds_deposited' || u.effective === 'not_matched' ? S.error : S.notice}>
          <b>Likely reason:</b> {reason.text}
          {reason.responsibility && <div style={{ marginTop: 4 }}><b>Responsibility (established by the record):</b> {reason.responsibility}</div>}
        </div>
      )}
      {u.cf_item && <div style={S.info}>Carry-forward item: {r(u.cf_item.balance)} to {qLabel(u.cf_item.target_quarter)} — <b>{u.cf_item.status}</b>{u.cf_item.settlement && ` in ${qLabel(u.cf_item.settlement.quarter)} by ${u.cf_item.settlement.detail}`}{u.cf_item.closure && ` — closed: ${u.cf_item.closure.reason}`}</div>}
      {u.cf && <div style={S.info}>This credit settles {r(u.cf.balance)} carried forward from {qLabel(u.cf.origin_quarter)}.</div>}

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Side by side</span><span style={S.small}>amounts in ₹</span></div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={S.th} /><th style={S.th}>Zoho Books</th><th style={S.th}>Form 26AS</th><th style={S.th}>Calculated comparison</th></tr></thead>
          <tbody>
            <tr><td style={{ ...cell, fontWeight: 600 }}>Value</td>
              <td style={cell}><KV k="Invoice basic (excl. GST)" v={r(c.zoho.basic)} /><KV k="GST" v={r(c.zoho.gst)} /><KV k="Gross invoice value" v={r(c.zoho.gross)} /><KV k="Comparable base" v={r(c.zoho.comparable)} strong />{c.zoho.base_notes.map(n => <div key={n} style={S.small}>{n}</div>)}</td>
              <td style={cell}><KV k="Amount paid / credited" v={r(c.f26.paid)} strong /></td>
              <td style={cell}><KV k="Base difference (26AS − comparable)" v={rs(c.calc.base_diff)} strong /><KV k="vs gross value" v={rs(c.calc.base_diff_gross)} /></td></tr>
            <tr><td style={{ ...cell, fontWeight: 600 }}>TDS</td>
              <td style={cell}><KV k="TDS receivable booked" v={r(c.zoho.tds)} strong />{c.zoho.documents.map(x => <div key={x} style={S.small}>{x}</div>)}</td>
              <td style={cell}><KV k="Tax deducted" v={r(c.f26.deducted)} /><KV k="Tax deposited" v={r(c.f26.deposited)} strong /><KV k="Booking status" v={c.f26.booking_status.map(s => `${s} — ${meta.booking_status[s] || '?'}`).join('; ') || '—'} /></td>
              <td style={cell}><KV k="TDS difference (Zoho − deposited)" v={rs(c.calc.tds_diff)} strong /><KV k="Deducted − deposited" v={rs(c.calc.deducted_vs_deposited)} /></td></tr>
            <tr><td style={{ ...cell, fontWeight: 600 }}>Dates</td>
              <td style={cell}><KV k="Invoice date" v={c.zoho.invoice_dates.map(dt).join(', ') || '—'} /><KV k="Payment date" v={c.zoho.payment_dates.map(dt).join(', ') || '—'} /><KV k="TDS posting date" v={c.zoho.posting_dates.map(dt).join(', ') || '—'} /><KV k="Section (ledger)" v={c.zoho.sections.join(', ') || '—'} /></td>
              <td style={cell}><KV k="Transaction date" v={c.f26.txn_dates.map(dt).join(', ') || '—'} /><KV k="Booking date" v={c.f26.booking_dates.map(dt).join(', ') || '—'} /><KV k="Section" v={c.f26.sections.join(', ') || '—'} /></td>
              <td style={cell}><KV k="Period (Zoho / 26AS)" v={`${c.calc.period_zoho || '—'} / ${c.calc.period_26as || '—'}`} strong={c.calc.period_differs} /><KV k="Days between" v={c.calc.days_between ?? '—'} /><KV k="Effective rate — Zoho" v={c.calc.rate_zoho != null ? `${c.calc.rate_zoho}%` : '—'} /><KV k="Effective rate — 26AS" v={c.calc.rate_26as != null ? `${c.calc.rate_26as}%` : '—'} /></td></tr>
          </tbody>
        </table>
        {c.checks.length > 0 && <div style={{ padding: '0.5rem 1rem', fontSize: '0.75rem', color: '#92400E' }}>{c.checks.map(x => <div key={x}>• {x}</div>)}</div>}
      </div>

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Zoho entries ({u.zoho_lines.length})</span></div>
        <div style={S.cardBody}>{u.zoho_lines.length === 0 ? <span style={S.muted}>None in this period.</span> : u.zoho_lines.map(z => (
          <div key={z.key} style={{ borderBottom: '1px solid #F0F2F1', padding: '0.35rem 0', fontSize: '0.76rem' }}>
            <b>{z.type_label} {z.number}</b> · posted {dt(z.date)} · {z.ledgers.join(', ')} · <b>{r(z.amount)}</b> {z.url && <a href={z.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>open in Zoho ↗</a>}
            <div style={S.small}>{z.customer || 'no customer'}{z.customer_basis && z.customer_basis !== 'posting' ? ` (customer from the ${z.customer_basis === 'journal_line' ? 'journal\'s receivable line' : 'invoice named in the journal'})` : ''}{z.tan_hints.length ? ` · TAN on invoice ${z.tan_hints.join(', ')}` : ''}</div>
            {z.invoices.map(i => <div key={i.id} style={S.small}>Invoice {i.url ? <a href={i.url} target="_blank" rel="noreferrer">{i.no}</a> : i.no} of {dt(i.date)}: basic {r(i.basic)}, GST {r(i.gst)}{i.tds_percent != null ? `, TDS ${i.tds_percent}%` : ''}</div>)}
            {z.payment && <div style={S.small}>Payment {z.payment.url ? <a href={z.payment.url} target="_blank" rel="noreferrer">{z.payment.no}</a> : z.payment.no} of {dt(z.payment.date)}{z.payment.applied != null ? `: applied ${r(z.payment.applied)}, TDS ${r(z.payment.withheld_on_invoice)}` : ''}</div>}
            {z.journal && <div style={S.small}>Journal note: {z.journal.notes || '—'}</div>}
            <Flags flags={z.flags} />
          </div>))}</div>
      </div>
      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Form 26AS credits ({u.credit_lines.length})</span></div>
        <div style={S.cardBody}>{u.credit_lines.length === 0 ? <span style={S.muted}>None in this period.</span> : u.credit_lines.map(x => (
          <div key={x.key} style={{ borderBottom: '1px solid #F0F2F1', padding: '0.35rem 0', fontSize: '0.76rem' }}>
            <b>{x.deductor}</b> ({x.tan}) · section {x.section_raw} · {dt(x.txn_date)} · status {x.status}{x.booking_date ? ` · booked ${dt(x.booking_date)}` : ''}{x.remarks ? ` · remarks ${x.remarks}` : ''}
            <div>paid {r(x.amount_paid)} · deducted {r(x.deducted)} · deposited <b>{r(x.deposited)}</b></div>
            <div style={S.small}>Source: {x.stmt ? `${x.stmt.file} (version ${x.stmt.version}, dated ${dt(x.stmt.statement_date)})` : x.src && x.src.file} — {srcText(x.src)}</div>
          </div>))}</div>
      </div>
      {d.evidence.length > 0 && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>{u.reason && u.reason.code === 'ambiguous' ? 'Equally plausible Zoho entries' : 'Evidence outside the period'}</span></div>
          <div style={S.cardBody}>{d.evidence.map((e, i) => (
            <div key={i} style={{ fontSize: '0.76rem', padding: '0.3rem 0', borderBottom: '1px solid #F0F2F1' }}>
              {e.credit_line && <>26AS credit in <b>{qLabel(e.quarter)}</b>: {e.credit_line.deductor} · {dt(e.credit_line.txn_date)} · deducted {r(e.credit_line.deducted)} · deposited {r(e.credit_line.deposited)} <span style={S.small}>({e.credit_line.stmt ? e.credit_line.stmt.file : ''}) — not counted in this period's matched totals</span>{e.maybe_matched_there && <div style={{ ...S.small, color: '#B45309' }}>That quarter also has a Zoho booking of this amount for the client — the credit may belong to it.</div>}</>}
              {e.zoho_line && e.kind !== 'candidate' && <>Zoho entry in <b>{qLabel(e.quarter)}</b>: {e.zoho_line.type_label} {e.zoho_line.number} · {dt(e.zoho_line.date)} · {r(e.zoho_line.amount)}</>}
              {e.kind === 'candidate' && e.zoho_line && <>Candidate: {e.zoho_line.type_label} {e.zoho_line.number} · {dt(e.zoho_line.date)} · {r(e.zoho_line.amount)} {meta.rights.review && u.credits.length > 0 && <button style={{ ...S.btn, marginLeft: 8, padding: '0.1rem 0.5rem' }} onClick={() => linkCandidate(e.zoho)}>This is the invoice the credit belongs to</button>}</>}
            </div>))}</div>
        </div>
      )}
      {d.links.length > 0 && <div style={S.info}>Reviewer link{d.links.length > 1 ? 's' : ''}: {d.links.map(l => <span key={l.id}>by {l.by} on {dt(l.at)} {meta.rights.review && <button style={{ ...S.ghost, padding: '0.05rem 0.45rem' }} onClick={() => unlink(l.id)}>Unlink</button>}</span>)}</div>}

      {meta.rights.review && form && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Review</span><span style={S.small}>system status: <StatusPill status={u.status} statuses={meta.statuses} small /></span></div>
          <div style={{ ...S.cardBody, display: 'grid', gap: 10 }}>
            <Field label="Final status">
              <select style={{ ...S.select, maxWidth: 320 }} value={form.final_status} onChange={e => setForm({ ...form, final_status: e.target.value })}>
                <option value="">Keep the system status ({meta.statuses[u.status]})</option>{STATUS_KEYS.map(s => <option key={s} value={s}>{meta.statuses[s]}</option>)}
              </select>
            </Field>
            {form.final_status === 'carry_forward' && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Field label="Carry to"><select style={S.select} value={form.cf_target} onChange={e => setForm({ ...form, cf_target: e.target.value })}><option value="">Choose…</option>{nextQuarters(origin).map(q => <option key={q} value={q}>{qLabel(q)}</option>)}</select></Field>
                <Field label="Reason" style={{ flex: 1, minWidth: 260 }}><input style={{ ...S.input, width: '100%' }} value={form.cf_reason} onChange={e => setForm({ ...form, cf_reason: e.target.value })} placeholder="e.g. client deducted in April; credit expected in Q1" /></Field>
                <div style={{ ...S.small, width: '100%' }}>Balance carried: {r(u.open_zoho || u.open_26as)} from {qLabel(origin)}. It is closed automatically, once, when a matching credit (or booking) of this client appears from the target period on.</div>
              </div>
            )}
            <Field label="Remarks"><textarea rows={3} style={{ ...S.input, width: '100%' }} value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} /></Field>
            <Field label="Supporting references (one per line)" hint="e.g. email from the client of 12-Jun-2026, challan 0510308…, revised 26Q acknowledgement"><textarea rows={2} style={{ ...S.input, width: '100%' }} value={form.refs} onChange={e => setForm({ ...form, refs: e.target.value })} /></Field>
            <Field label="Attachments">
              <input type="file" onChange={e => e.target.files[0] && upload(e.target.files[0])} />
              <div>{[...((u.decision && u.decision.attachments) || []), ...form.attachments].map(a => <button key={a.sha256} style={{ ...S.ghost, padding: '0.1rem 0.5rem', margin: '4px 4px 0 0' }} onClick={() => t.attachmentDownload(params.entity, a.sha256, a.name).catch(e => setErr(errMsg(e)))}>{a.name}</button>)}</div>
            </Field>
            {u.credits.length > 0 || u.open_zoho > 0 ? (
              <div>
                <label style={{ fontSize: '0.78rem', display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={form.non_deposit} onChange={e => setForm({ ...form, non_deposit: e.target.checked })} /> Confirmed non-deposit (client confirmed the TDS was not deposited)</label>
                {form.non_deposit && <Field label="Evidence (required, with a reference or attachment above)"><textarea rows={2} style={{ ...S.input, width: '100%' }} value={form.nd_evidence} onChange={e => setForm({ ...form, nd_evidence: e.target.value })} /></Field>}
                {u.decision && u.decision.non_deposit && <div style={S.small}>Recorded by {u.decision.non_deposit.by} on {dt(u.decision.non_deposit.at)}: {u.decision.non_deposit.evidence}</div>}
              </div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={S.primary} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save review'}</button></div>
          </div>
        </div>
      )}
      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>History</span></div>
        <div style={S.cardBody}>
          {d.history.every(h => !h.history.length) ? <span style={S.muted}>No review yet.</span> : d.history.filter(h => h.history.length).slice(0, 1).flatMap(h => h.history.slice().reverse()).map((h, i) => (
            <div key={i} style={{ fontSize: '0.74rem', padding: '0.25rem 0', borderBottom: '1px solid #F0F2F1' }}>
              {dtm(h.at)} · <b>{h.by}</b> · system {meta.statuses[h.system_status] || h.system_status} → final {h.final_status ? meta.statuses[h.final_status] : '(system)'}{h.cf ? ` · carry forward ${h.cf}` : ''}{h.non_deposit ? ' · confirmed non-deposit' : ''}{h.whole_client ? ' · for the whole client (Client totals)' : ''}{h.bulk_cf ? ' · carried forward with other timing differences (Carry forward tab)' : ''}{h.remarks ? ` — ${h.remarks}` : ''}
            </div>))}
        </div>
      </div>
    </Drawer>
  );
}
