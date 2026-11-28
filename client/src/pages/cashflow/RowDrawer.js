import React, { useEffect, useState } from 'react';
import { ExternalLink, Plus, Trash2, Upload, Paperclip } from 'lucide-react';
import { S, Tag, Field } from '../billbooking/ui';
import { cf, errMsg, inr, inr2, dmy, monthLabel, longMonth } from './cfApi';
import { C, Drawer, Section, StateTag, linkLabel } from './cfUi';

// ─── The drawer opened from a row: a bill (part), a budget line, or an advance ───

const todayStr = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const Row = ({ l, v, strong }) => <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0', fontSize: '0.8rem', borderBottom: '1px dashed #F0F2F1' }}><span style={{ color: '#5D6C7B' }}>{l}</span><span style={{ ...(strong ? { fontWeight: 700 } : {}), textAlign: 'right' }}>{v}</span></div>;
const Err = ({ e }) => (e ? <div style={S.error}>{e}</div> : null);

function useBudgets(company, category) {
  const [list, setList] = useState([]);
  useEffect(() => { cf.budgets({ company, category }).then(d => setList(d.budgets)).catch(() => setList([])); }, [company, category]);
  return list;
}

/** Instalments: Pay On date + amount, decided in the management meeting */
function ScheduleEditor({ value, onSave, disabled, hint }) {
  const [rows, setRows] = useState(value || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => setRows(value || []), [value]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(value || []);
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return (
    <div>
      {rows.length === 0 && <div style={S.small}>{hint}</div>}
      {rows.map((r, i) => (
        <div key={r.id || i} style={{ display: 'grid', gridTemplateColumns: '150px 150px 1fr auto', gap: 6, marginBottom: 4 }}>
          <input type="date" aria-label="Pay On date" style={S.input} disabled={disabled} value={r.pay_on || ''} onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, pay_on: e.target.value } : x)))} />
          <input type="number" aria-label="Pay amount" style={S.input} disabled={disabled} value={r.amount ?? ''} placeholder="Amount" onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
          <input style={S.input} disabled={disabled} value={r.note || ''} placeholder="Note (optional)" onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
          {!disabled && <button type="button" aria-label="Remove instalment" style={{ ...S.ghost, padding: '0.25rem 0.45rem' }} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={12} /></button>}
        </div>
      ))}
      {!disabled && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <button type="button" style={S.ghost} onClick={() => setRows([...rows, { pay_on: todayStr(), amount: '' }])}><Plus size={12} /> Instalment</button>
          {dirty && <button type="button" style={S.primary} disabled={busy} onClick={async () => { setBusy(true); setErr(''); try { await onSave(rows.map(r => ({ ...r, amount: Number(r.amount) }))); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>{busy ? 'Saving…' : 'Save schedule'}</button>}
          {rows.length > 0 && <span style={S.small}>Scheduled {inr(total)}</span>}
        </div>
      )}
      <Err e={err} />
    </div>
  );
}

function Slips({ company, pid, slips, canEdit, onChanged }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div>
      {(slips || []).map(s => (
        <div key={s.sha} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.75rem' }}>
          <Paperclip size={11} /><a href={cf.slipUrl(company, pid, s.sha)} target="_blank" rel="noreferrer" style={{ color: '#1C4942' }}>{s.name}</a>
          <span style={S.small}>{s.by} · {dmy(String(s.at).slice(0, 10))}</span>
          {canEdit && <button type="button" aria-label="Remove slip" style={{ ...S.ghost, padding: '0 0.3rem' }} onClick={async () => { if (!window.confirm(`Remove ${s.name}?`)) return; try { await cf.delSlip(pid, s.sha, company); onChanged(); } catch (e) { setErr(errMsg(e)); } }}><Trash2 size={11} /></button>}
        </div>
      ))}
      {canEdit && (
        <label style={{ ...S.ghost, padding: '0.15rem 0.5rem', fontSize: '0.72rem', marginTop: 3 }}>
          <Upload size={11} /> {busy ? 'Uploading…' : 'Payment advice slip'}
          <input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv,.docx" onChange={async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; setBusy(true); setErr(''); try { await cf.addSlip(pid, company, f); onChanged(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); } }} />
        </label>
      )}
      <Err e={err} />
    </div>
  );
}

// ── A bill (one category's part of a Zoho bill) ───────────────────────────────
export function PartDrawer({ part: p, meta, rights, catLabel, onClose, onChanged }) {
  const budgets = useBudgets(p.company, p.category);
  const [err, setErr] = useState('');
  const [client, setClient] = useState(p.client || '');
  const [meter, setMeter] = useState(p.meter || '');
  const [remarks, setRemarks] = useState(p.remarks || '');
  const [ini, setIni] = useState({ date: todayStr(), amount: p.at.to_initiate > 0 ? Math.round(p.at.to_initiate * 100) / 100 : '', reference: '' });
  const save = async body => { setErr(''); try { await cf.savePart(p.key, { company: p.company, ...body }); onChanged(); } catch (e) { setErr(errMsg(e)); throw e; } };
  const near = budgets.filter(b => Math.abs((Number(b.planned_month.slice(0, 4)) * 12 + Number(b.planned_month.slice(5))) - (Number(p.planned_month.slice(0, 4)) * 12 + Number(p.planned_month.slice(5)))) <= 3);
  const at = p.at;

  return (
    <Drawer title={`${p.vendor} — ${p.bill_no}`} sub={`${catLabel} · ${p.branch || 'no branch'} · ${p.company_name}`} onClose={onClose}>
      <Err e={err} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <StateTag state={at.state} />
        {p.carried_from && <Tag tone="amber">Opening due · planned {monthLabel(p.carried_from)}</Tag>}
        {p.earlier_bill && <Tag tone="violet">Earlier bill (dated {dmy(p.bill_date)})</Tag>}
        {at.overdue && <Tag tone="red">Pay On {dmy(at.overdue.pay_on)} passed {at.overdue.days} day(s) ago — {inr(at.overdue.short)} not initiated</Tag>}
        <a href={p.url} target="_blank" rel="noreferrer" style={{ ...S.ghost, padding: '0.15rem 0.5rem', fontSize: '0.72rem', textDecoration: 'none' }}><ExternalLink size={11} /> Open in Zoho Books</a>
      </div>

      <Section title="Budget and schedule">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Linked budget line">
            <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={!rights.plan} value={p.link === 'auto' ? '__auto' : (p.budget_id || '')}
              onChange={e => save({ budget_id: e.target.value === '__auto' ? null : e.target.value }).catch(() => {})}>
              <option value="__auto">Automatic{p.link === 'auto' && p.budget_id ? ` (now: ${(budgets.find(b => b.id === p.budget_id) || {}).vendor_name || (budgets.find(b => b.id === p.budget_id) || {}).branch || 'a budget line'})` : ''}</option>
              <option value="">No budget (received without a linked budget)</option>
              {near.map(b => <option key={b.id} value={b.id}>{monthLabel(b.planned_month)} · {b.branch || 'all branches'} · {b.vendor_name || b.client || 'any vendor'} · {inr(b.amount)}</option>)}
            </select>
            <div style={S.small}>{linkLabel(p.link)}</div>
          </Field>
          <Field label="Planned payment month">
            <input type="month" style={{ ...S.input, width: '100%' }} disabled={!rights.plan} value={p.planned_override || p.planned_month} onChange={e => save({ planned_month: e.target.value }).catch(() => {})} />
            <div style={S.small}>{p.planned_override ? 'set by the team' : `from the ${p.planned_source}`}{p.planned_override && rights.plan && <> · <button type="button" style={C.link} onClick={() => save({ planned_month: '' }).catch(() => {})}>back to automatic</button></>}</div>
          </Field>
          {p.category === 'brokerage' && (
            <Field label="Client (brokerage payable for)">
              <div style={{ display: 'flex', gap: 6 }}>
                <input style={{ ...S.input, flex: 1 }} disabled={!rights.plan} value={client} list={`clients-${p.key}`} onChange={e => setClient(e.target.value)} placeholder="Client name" />
                {client !== (p.client || '') && <button type="button" style={S.primary} onClick={() => save({ client }).catch(() => {})}>Save</button>}
              </div>
              <datalist id={`clients-${p.key}`}>{(p.client_options || []).map(o => <option key={o} value={o} />)}</datalist>
              <div style={S.small}>{p.client_source === 'team' ? 'entered by the team' : p.client_source === 'bill text (suggested)' ? 'suggested from the bill wording — check it and press Save to confirm' : p.client ? 'found in the bill description (one of our customers)' : p.client_options?.length ? `Several clients named in the bill: ${p.client_options.join(', ')}` : 'not found in the bill description — enter it'}</div>
            </Field>
          )}
          {p.category === 'electricity' && (
            <Field label="Consumer / meter number">
              <div style={{ display: 'flex', gap: 6 }}>
                <input style={{ ...S.input, flex: 1 }} disabled={!rights.plan} value={meter} onChange={e => setMeter(e.target.value)} placeholder={p.connection || 'Meter / consumer no.'} />
                {meter !== (p.meter || '') && <button type="button" style={S.primary} onClick={() => save({ meter }).catch(() => {})}>Save</button>}
              </div>
              <div style={S.small}>Connection: {p.connection || '—'} · billing period {p.period.label}</div>
            </Field>
          )}
          {p.category === 'rent' && <Field label="Rent period"><div style={{ fontSize: '0.82rem', paddingTop: 4 }}>{p.period.label} <span style={S.small}>({p.period.source})</span></div></Field>}
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={S.label}>Pay On date and Pay Amount (instalments)</div>
          <ScheduleEditor value={p.schedule} disabled={!rights.plan} onSave={schedule => save({ schedule })}
            hint={`Not set: the whole net payable (${inr(p.net)}) is scheduled on the ${p.due ? `due date ${dmy(p.due)}` : `bill date ${dmy(p.bill_date)}`}. Add instalments to record what the management meeting decided.`} />
        </div>
      </Section>

      <Section title="Bill details from Zoho">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 18px' }}>
          <div>
            <Row l="Bill date" v={dmy(p.bill_date)} /><Row l="Bill number" v={p.bill_no} /><Row l="Due date" v={dmy(p.due)} /><Row l="Zoho status" v={p.status} />
            {p.ref && <Row l="Reference" v={p.ref} />}
          </div>
          <div>
            <Row l="Basic amount" v={inr2(p.basic)} /><Row l="GST amount" v={inr2(p.gst)} /><Row l="Gross bill amount" v={inr2(p.gross)} /><Row l="TDS (as in Zoho)" v={inr2(p.tds)} />
            <Row l="Net payable to vendor" v={inr2(p.net)} strong />
            {p.w < 1 && <div style={S.small}>This is the {catLabel.toLowerCase()} part ({Math.round(p.w * 1000) / 10}%) of a bill with other lines.</div>}
          </div>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
          <thead><tr>{['Description', 'Account', 'Amount', 'GST'].map(h => <th key={h} style={{ ...S.th, ...(['Amount', 'GST'].includes(h) ? C.num : {}) }}>{h}</th>)}</tr></thead>
          <tbody>{p.lines.map((l, i) => <tr key={i}><td style={{ ...S.td, whiteSpace: 'pre-wrap' }}>{l.desc || '—'}</td><td style={S.td}>{l.account}</td><td style={{ ...S.td, ...C.num }}>{inr2(l.amount)}</td><td style={{ ...S.td, ...C.num }}>{inr2(l.tax)}{l.tax_name ? <div style={S.small}>{l.tax_name}</div> : null}</td></tr>)}</tbody>
        </table>
      </Section>

      <Section title="Payment initiation" right={<span style={S.small}>Pending {inr(at.pending)} · still to initiate {inr(at.to_initiate)}</span>}>
        {!at.initiations.length && !p.initiations.length && <div style={S.small}>No initiation recorded {p.company === 'devx' ? '(and no Finance Portal payment request for this bill)' : ''} — Initiation unconfirmed.</div>}
        {p.initiations.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
            <thead><tr>{['Date', 'Amount', 'Reference', 'Source', 'Status', 'Settled', 'Pending', ''].map(h => <th key={h} style={{ ...S.th, ...(['Amount', 'Settled', 'Pending'].includes(h) ? C.num : {}) }}>{h}</th>)}</tr></thead>
            <tbody>
              {p.initiations.map(i => {
                const live = at.initiations.find(x => x.id === i.id);
                return (
                  <tr key={i.id}>
                    <td style={S.td}>{dmy(i.date)}</td><td style={{ ...S.td, ...C.num }}>{inr(i.amount)}</td><td style={S.td}>{i.reference || '—'}</td>
                    <td style={S.td}>{i.source === 'portal' ? <Tag tone="blue">Finance Portal</Tag> : <span style={S.small}>{i.by || 'team'}</span>}</td>
                    <td style={S.td}>
                      {i.source === 'portal' || !rights.payments ? <Tag tone={i.status === 'cancelled' || i.status === 'failed' ? 'red' : i.status === 'settled' ? 'green' : 'blue'}>{i.status}</Tag> : (
                        <select style={S.select} value={i.status} onChange={async e => { try { await cf.saveInit(p.key, i.id, { company: p.company, status: e.target.value }); onChanged(); } catch (x) { setErr(errMsg(x)); } }}>
                          {['initiated', 'settled', 'failed', 'cancelled'].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      )}
                    </td>
                    <td style={{ ...S.td, ...C.num }}>{live ? inr(live.settled) : '—'}</td><td style={{ ...S.td, ...C.num }}>{live ? inr(live.pending) : '—'}</td>
                    <td style={S.td}>{i.source !== 'portal' && rights.payments && <button type="button" aria-label="Remove" style={{ ...S.ghost, padding: '0 0.3rem' }} onClick={async () => { if (!window.confirm('Remove this initiation record?')) return; try { await cf.delInit(p.key, i.id, p.company); onChanged(); } catch (x) { setErr(errMsg(x)); } }}><Trash2 size={11} /></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {rights.payments && at.final_out > 0.5 && (
          <div style={{ display: 'grid', gridTemplateColumns: '140px 130px 1fr auto', gap: 6, alignItems: 'end' }}>
            <Field label="Initiated on"><input type="date" style={{ ...S.input, width: '100%' }} value={ini.date} onChange={e => setIni({ ...ini, date: e.target.value })} /></Field>
            <Field label="Amount"><input type="number" style={{ ...S.input, width: '100%' }} value={ini.amount} onChange={e => setIni({ ...ini, amount: e.target.value })} /></Field>
            <Field label="Reference (UTR / batch)"><input style={{ ...S.input, width: '100%' }} value={ini.reference} onChange={e => setIni({ ...ini, reference: e.target.value })} /></Field>
            <button type="button" style={S.primary} onClick={async () => { setErr(''); try { await cf.addInit(p.key, { company: p.company, ...ini, amount: Number(ini.amount) }); setIni({ date: todayStr(), amount: '', reference: '' }); onChanged(); } catch (e) { setErr(errMsg(e)); } }}>Record initiation</button>
          </div>
        )}
        <div style={{ ...S.small, marginTop: 6 }}>An instruction counts as settled when a Zoho payment on or after its date covers it; failed or cancelled ones never count.</div>
      </Section>

      <Section title="Actual payments" right={<span style={S.small}>Paid {inr(at.paid)}{p.paid_later > 0.5 ? ` (+${inr(p.paid_later)} after month-end)` : ''}</span>}>
        {!p.pays.length && <div style={S.small}>No payment in Zoho yet.</div>}
        {p.pays.map((x, i) => (
          <div key={`${x.pid}-${i}`} style={{ display: 'grid', gridTemplateColumns: '110px 120px 1fr', gap: 8, padding: '6px 0', borderBottom: '1px solid #F0F2F1', fontSize: '0.78rem' }}>
            <div><div style={{ fontWeight: 600 }}>{dmy(x.date)}</div>{x.advance && <Tag tone="violet">advance · applied {dmy(x.apply)}</Tag>}</div>
            <div style={C.num}>{inr2(x.amt)}</div>
            <div><div>{x.no || '—'} · {x.mode || ''} {x.ref ? `· ${x.ref}` : ''}</div><Slips company={p.company} pid={x.pid} slips={x.slips} canEdit={rights.payments} onChanged={onChanged} /></div>
          </div>
        ))}
      </Section>

      <Section title="Advances and outstanding">
        <Row l="Net payable" v={inr2(p.net)} />
        <Row l="Direct payments" v={`− ${inr2(at.direct)}`} />
        {at.credits > 0 && <Row l="Credit notes applied" v={`− ${inr2(at.credits)}`} />}
        <Row l="Outstanding before advance adjustment" v={inr2(at.out_before)} strong />
        <Row l="Advances applied to this bill" v={`− ${inr2(at.adv)}`} />
        {p.pays.filter(x => x.advance).map((x, i) => <div key={i} style={{ ...S.small, textAlign: 'right' }}>advance paid {dmy(x.date)} ({x.no || x.ref || 'payment'}) {inr2(x.amt)}, applied {dmy(x.apply)}</div>)}
        <Row l="Final outstanding" v={inr2(at.final_out)} strong />
        {Math.abs(at.balance_gap) > 1 && <div style={{ ...S.notice, marginTop: 6 }}>This differs from Zoho's balance for the bill by {inr2(at.balance_gap)} — a refresh from Zoho brings it up to date.</div>}
      </Section>

      <Section title="Remarks">
        <textarea style={{ ...S.input, width: '100%', minHeight: 60 }} disabled={!rights.plan} value={remarks} onChange={e => setRemarks(e.target.value)} />
        {remarks !== (p.remarks || '') && <button type="button" style={{ ...S.primary, marginTop: 6 }} onClick={() => save({ remarks }).catch(() => {})}>Save remarks</button>}
      </Section>
    </Drawer>
  );
}

// ── A budget line / commitment ────────────────────────────────────────────────
export function BudgetDrawer({ budget, view, meta, rights, catLabel, onClose, onChanged, onOpenPart, onEdit }) {
  const [err, setErr] = useState('');
  const [full, setFull] = useState(budget.needsLoad ? null : budget);
  useEffect(() => {
    if (!budget.needsLoad) return;
    cf.budgets({ company: budget.company, category: budget.category }).then(d => setFull(d.budgets.find(b => b.id === budget.id) || null)).catch(e => setErr(errMsg(e)));
  }, [budget]);
  if (!full) return <Drawer title="Budget line" onClose={onClose}><Err e={err} />{!err && <div style={S.center}>Loading…</div>}</Drawer>;
  const b = full;
  const parts = view.rows.parts.filter(p => p.budget_id === b.id);
  return (
    <Drawer title={`${catLabel} budget — ${longMonth(b.planned_month)}`} sub={`${b.company_name || ''} · ${b.branch || 'all branches'}${b.vendor_name ? ` · ${b.vendor_name}` : ''}${b.client ? ` · client ${b.client}` : ''}`} onClose={onClose}>
      <Err e={err} />
      <Section title="Plan" right={rights.plan && <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={S.btn} onClick={() => onEdit(b)}>Edit</button>
        <button type="button" style={S.danger} onClick={async () => { if (!window.confirm('Remove this budget line? Bills linked to it go back to automatic linking.')) return; try { await cf.delBudget(b.id, b.company); onChanged(); onClose(); } catch (e) { setErr(errMsg(e)); } }}>Remove</button>
      </div>}>
        <Row l="Planned payment month" v={longMonth(b.planned_month)} />
        <Row l="Finalised budget" v={inr2(b.amount)} strong />
        {Math.abs((b.original_amount ?? b.amount) - b.amount) > 0.5 && <Row l="Original budget (kept for comparison)" v={inr2(b.original_amount)} />}
        {b.at && <><Row l="Bills received (net)" v={inr2(b.at.billed)} /><Row l="Paid against it (incl. advances)" v={inr2(b.at.paid)} />
          <Row l="Remaining budget" v={<span style={b.at.excess ? C.neg : {}}>{inr2(b.at.remaining)}{b.at.excess ? ' — exceeded' : ''}</span>} strong />
          {b.at.awaiting > 0.5 && <Row l="Awaiting bill" v={inr2(b.at.awaiting)} />}
          {b.at.unbilled > 0.5 && <Row l="Budget not billed (review)" v={inr2(b.at.unbilled)} />}</>}
        <Row l="More bills expected" v={b.expects_more_bills ? 'Yes' : 'No'} />
        {b.period_label && <Row l="Period" v={b.period_label} />}
        {b.connection && <Row l="Connection / meter" v={b.connection} />}
        {b.notes && <Row l="Notes" v={b.notes} />}
        <div style={{ ...S.small, marginTop: 4 }}>Added by {b.created_by || '—'}{b.updated_by ? ` · last changed by ${b.updated_by}` : ''}</div>
      </Section>
      <Section title="Forecast — Pay On date and amount while the bill is awaited">
        <ScheduleEditor value={b.schedule} disabled={!rights.plan} hint={`Not set: forecast on ${dmy(b.at?.schedule?.[0]?.pay_on || '')} for the amount awaiting the bill.`}
          onSave={async schedule => { await cf.saveBudget(b.id, { company: b.company, schedule }); onChanged(); }} />
      </Section>
      <Section title={`Bills linked (${parts.length})`}>
        {!parts.length && <div style={S.small}>No bill linked yet{b.at?.awaiting > 0.5 ? ' — Awaiting Bill' : ''}.</div>}
        {parts.map(p => (
          <div key={p.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderBottom: '1px solid #F0F2F1', fontSize: '0.78rem', cursor: 'pointer' }} onClick={() => onOpenPart(p)}>
            <span>{p.vendor} · {p.bill_no} · {dmy(p.bill_date)} <span style={S.small}>({linkLabel(p.link)})</span></span>
            <span style={C.num}>{inr(p.net)} · outstanding {inr(p.at.final_out)}</span>
          </div>
        ))}
      </Section>
      {(b.history || []).length > 0 && (
        <Section title="Changes">
          {b.history.slice().reverse().map((h, i) => <div key={i} style={{ fontSize: '0.74rem', padding: '2px 0' }}><span style={S.small}>{dmy(String(h.at).slice(0, 10))}</span> · <b>{h.by}</b> · {h.field}: {String(h.from ?? '—')} → {typeof h.to === 'object' ? 'changed' : String(h.to)}</div>)}
        </Section>
      )}
    </Drawer>
  );
}

// ── An advance payment ────────────────────────────────────────────────────────
export function AdvanceDrawer({ advance: a, rights, categories, onClose, onChanged }) {
  const budgets = useBudgets(a.company, a.category);
  const [err, setErr] = useState('');
  return (
    <Drawer title={`Advance — ${a.vendor}`} sub={`${a.company_name} · paid ${dmy(a.date)}`} onClose={onClose}>
      <Err e={err} />
      <Section title="Payment">
        <Row l="Paid on" v={dmy(a.date)} /><Row l="Payment number" v={a.no || '—'} /><Row l="Reference" v={a.ref || '—'} />
        <Row l="Amount paid" v={inr2(a.amount)} strong /><Row l="Not yet applied to a bill" v={inr2(a.unapplied)} strong />
        {a.applications.length > 0 && <div style={{ ...S.small, marginTop: 4 }}>Applied to bills: {a.applications.map(x => `${inr(x.amt)} on ${dmy(x.apply)}`).join(', ')}</div>}
      </Section>
      <Section title="Plan">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Category">
            <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={!rights.plan} value={a.category} onChange={async e => { try { await cf.saveAdvance(a.pid, { company: a.company, category: e.target.value }); onChanged(); } catch (x) { setErr(errMsg(x)); } }}>
              {categories.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Budget line it is paid against">
            <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={!rights.plan} value={a.budget_id || ''} onChange={async e => { try { await cf.saveAdvance(a.pid, { company: a.company, budget_id: e.target.value }); onChanged(); } catch (x) { setErr(errMsg(x)); } }}>
              <option value="">None</option>
              {budgets.map(b => <option key={b.id} value={b.id}>{monthLabel(b.planned_month)} · {b.branch || 'all branches'} · {b.vendor_name || b.client || 'any vendor'} · {inr(b.amount)}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ ...S.small, marginTop: 6 }}>The advance counts as cash when it was paid. Applying it to a bill later lowers that bill's outstanding without a second outflow.</div>
      </Section>
      <Section title="Payment advice slip"><Slips company={a.company} pid={a.pid} slips={a.slips} canEdit={rights.payments} onChanged={onChanged} /></Section>
    </Drawer>
  );
}
