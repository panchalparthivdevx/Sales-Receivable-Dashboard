import React, { useMemo, useState } from 'react';
import { Plus, Copy } from 'lucide-react';
import { S, Tag } from '../billbooking/ui';
import { inr, dmy, monthLabel, longMonth, addMonths } from './cfApi';
import { C, Num, StateTag, linkLabel } from './cfUi';
import { drillOf, DrillModal } from './Overview';
import FyGrid from './FyGrid';

// ─── One category tab: budget lines with their bills, bills without a budget, opening dues, advances ───

const money = (v, o = {}) => <Num value={v} {...o} />;
const billCell = p => <><div>{p.bill_no}</div><div style={S.small}>{dmy(p.bill_date)}</div></>;
const payOn = p => (p.at.overdue ? <><div>{dmy(p.at.overdue.pay_on)}</div><Tag tone="red">{p.at.overdue.days}d late</Tag></> : p.at.next_pay_on ? <><div>{dmy(p.at.next_pay_on)}</div>{p.schedule ? <div style={S.small}>{p.schedule.length} instalment(s)</div> : <div style={S.small}>due date</div>}</> : '—');

/** Columns per category. b = budget row, p = bill row; each returns the cell. num: right aligned */
function columns(cat) {
  const common = [
    { h: 'Net payable', num: true, b: b => money(b.at.billed), p: p => money(p.net) },
    { h: 'Paid', num: true, b: b => money(b.at.paid), p: p => <>{money(p.at.paid)}{p.paid_later > 0.5 && <div style={S.small}>+{inr(p.paid_later)} after month-end</div>}</> },
    { h: 'Initiated & pending', num: true, b: () => '', p: p => money(p.at.pending) },
    { h: 'Outstanding', num: true, b: () => '', p: p => money(p.at.final_out) },
    { h: 'Still to initiate', num: true, b: () => '', p: p => money(p.at.to_initiate, { strong: p.at.to_initiate > 0.5 }) },
    { h: 'Pay on', b: b => (b.at.awaiting > 0.5 ? dmy(b.at.schedule[0]?.pay_on) : ''), p: payOn },
    { h: 'Status', b: b => budgetState(b), p: p => <StateTag state={p.at.state} /> },
  ];
  const budgetCol = { h: cat === 'brokerage' ? 'Agreed amount' : 'Finalised budget', num: true,
    b: b => <>{money(b.amount, { strong: true })}{Math.abs(b.original_amount - b.amount) > 0.5 && <div style={S.small}>orig. {inr(b.original_amount)}</div>}<div style={{ ...S.small, ...(b.at.excess ? C.neg : {}) }}>left {inr(b.at.remaining)}</div></>,
    p: () => '' };
  if (cat === 'brokerage') return [
    { h: 'Month to pay', b: b => monthLabel(b.planned_month), p: p => monthLabel(p.planned_month) },
    { h: 'Client', b: b => b.client || '—', p: p => (p.client ? <>{p.client}{p.client_source === 'team' ? <div style={S.small}>entered by team</div> : p.client_source === 'bill text (suggested)' ? <Tag tone="amber">suggested from bill — check</Tag> : <div style={S.small}>from bill text</div>}</> : p.client_options?.length ? <Tag tone="amber">Client unclear — choose</Tag> : <Tag tone="amber">Client not in bill — enter</Tag>) },
    { h: 'Branch', b: b => b.branch || '—', p: p => p.branch || '—' },
    { h: 'Broker / vendor', b: b => b.vendor_name || '—', p: p => p.vendor },
    budgetCol, { h: 'Bill', b: () => '', p: billCell }, ...common];
  if (cat === 'rent') return [
    { h: 'Branch', b: b => b.branch || '—', p: p => p.branch || '—' },
    { h: 'Landlord / developer', b: b => b.vendor_name || '—', p: p => p.vendor },
    { h: 'Rent period', b: b => b.period_label || '—', p: p => p.period.label },
    { h: 'Planned', b: b => monthLabel(b.planned_month), p: p => monthLabel(p.planned_month) },
    budgetCol, { h: 'Bill', b: () => '', p: billCell },
    { h: 'Basic', num: true, b: () => '', p: p => money(p.basic) }, { h: 'GST', num: true, b: () => '', p: p => money(p.gst) }, { h: 'TDS', num: true, b: () => '', p: p => money(p.tds) },
    ...common];
  return [
    { h: 'Branch', b: b => b.branch || '—', p: p => p.branch || '—' },
    { h: 'Provider / billing vendor', b: b => b.vendor_name || '—', p: p => p.vendor },
    { h: 'Connection / meter', b: b => b.connection || '—', p: p => <>{p.connection || '—'}{p.meter && <div style={S.small}>No. {p.meter}</div>}</> },
    { h: 'Billing period', b: b => b.period_label || '—', p: p => p.period.label },
    { h: 'Bill date / due', b: () => '', p: p => <><div>{p.bill_no}</div><div style={S.small}>{dmy(p.bill_date)} · due {dmy(p.due)}</div></> },
    { h: 'Planned', b: b => monthLabel(b.planned_month), p: p => monthLabel(p.planned_month) },
    budgetCol, ...common];
}

function budgetState(b) {
  if (b.at.excess) return <Tag tone="red">Exceeded</Tag>;
  if (b.at.awaiting > 0.5) return <Tag tone="amber">{b.at.bills ? 'More bills expected' : 'Awaiting bill'}</Tag>;
  if (b.at.unbilled > 0.5) return <Tag tone="violet">{inr(b.at.unbilled)} not billed — review</Tag>;
  return <Tag tone="green">Billed</Tag>;
}

export default function CategoryTab({ cat, catLabel, view, meta, filters, rights, onOpenPart, onOpenBudget, onAddBudget, onCopied, copyBudgets }) {
  const [mode, setMode] = useState('month');
  const [drill, setDrill] = useState(null);
  const cols = useMemo(() => columns(cat), [cat]);
  const parts = view.rows.parts.filter(p => p.category === cat);
  const budgets = view.rows.budgets.filter(b => b.category === cat).sort((a, b) => String(a.branch || '').localeCompare(String(b.branch || '')) || String(a.vendor_name || '').localeCompare(String(b.vendor_name || '')));
  const advances = view.rows.advances.filter(a => a.category === cat);
  const bIds = new Set(budgets.map(b => b.id));
  const linked = id => parts.filter(p => p.budget_id === id && !p.carried_from);
  const otherBudget = parts.filter(p => !p.carried_from && p.budget_id && !bIds.has(p.budget_id));
  const unlinked = parts.filter(p => !p.carried_from && !p.budget_id);
  const opening = parts.filter(p => p.carried_from);
  const s = view.summary[cat] || {};
  let sr = 0;

  const partRow = (p, indent) => (
    <tr key={p.key} style={{ cursor: 'pointer' }} onClick={() => onOpenPart(p)}>
      <td style={{ ...S.td, color: '#9BA8B0' }}>{indent ? '' : ++sr}</td>
      {cols.map((c, i) => <td key={i} style={{ ...S.td, ...(c.num ? C.num : {}), ...(indent && i === 0 ? { paddingLeft: '1.4rem' } : {}) }}>{c.p(p)}</td>)}
      <td style={S.td}>{p.link === 'auto' ? <Tag tone="blue">auto</Tag> : p.link === 'team' ? <Tag tone="green">team</Tag> : ''}{p.earlier_bill && !p.carried_from && <Tag tone="violet">earlier bill</Tag>}{Math.abs(p.at.balance_gap) > 1 && <Tag tone="red" title="Differs from Zoho's balance — refresh from Zoho">check balance</Tag>}</td>
    </tr>
  );
  const group = title => <tr><td colSpan={cols.length + 2} style={{ ...C.subTitle, background: '#FFFFFF', borderBottom: '1px solid #DFE7E3' }}>{title}</td></tr>;

  return (
    <div>
      <div style={{ ...S.topBar, marginBottom: '0.6rem', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 0 }}>
          {[['month', `Month view — ${longMonth(view.month)}`], ...(cat === 'rent' ? [['fy', 'Financial year, month-wise']] : [])].map(([k, l], i, a) => (
            <button key={k} type="button" style={{ ...C.pill(mode === k), borderRadius: a.length === 1 ? 6 : i === 0 ? '6px 0 0 6px' : '0 6px 6px 0', marginLeft: i ? -1 : 0 }} onClick={() => setMode(k)}>{l}</button>
          ))}
        </div>
        {rights.plan && mode === 'month' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={S.btn} onClick={() => onAddBudget(cat)}><Plus size={13} /> {cat === 'brokerage' ? 'Expected brokerage / budget' : 'Budget line'}</button>
            <button type="button" style={S.ghost} title={`Copy ${monthLabel(addMonths(view.month, -1))}'s ${catLabel} budget lines to ${monthLabel(view.month)}`} onClick={() => copyBudgets(cat)}><Copy size={13} /> Copy from {monthLabel(addMonths(view.month, -1))}</button>
          </div>
        )}
      </div>

      {mode === 'fy' ? <FyGrid cat={cat} filters={filters} meta={meta} onOpenPart={onOpenPart} /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: '0.75rem' }}>
            {[['budget', 'Finalised budget'], ['awaiting', 'Awaiting bills'], ['billed', 'Bills received'], ['paid_plan', 'Paid against plan'], ['remaining', 'Remaining budget'], ['final_out', 'Outstanding'], ['pending', 'Initiated & pending'], ['to_initiate', 'Still to initiate'], ['cash_out', 'Cash outflow']].map(([k, l]) => (
              <div key={k} style={{ ...S.card, marginBottom: 0, padding: '0.55rem 0.75rem' }}>
                <div style={S.label}>{l}</div>
                <div style={{ fontSize: '1.02rem', fontWeight: 700 }}><Num value={s[k]} zeroDash={false} onClick={() => setDrill({ title: `${catLabel} — ${l}`, sub: longMonth(view.month), data: drillOf(view, cat, k) })} /></div>
              </div>
            ))}
          </div>

          <div style={{ ...S.card, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={S.th}>Sr.</th>{cols.map(c => <th key={c.h} style={{ ...S.th, ...(c.num ? C.num : {}) }}>{c.h}</th>)}<th style={S.th} /></tr></thead>
              <tbody>
                {!budgets.length && !parts.length && !advances.length && <tr><td colSpan={cols.length + 2} style={S.center}>Nothing planned or received for {longMonth(view.month)}.{rights.plan ? ' Add a budget line to plan this month.' : ''}</td></tr>}
                {budgets.length > 0 && group(`Budget for ${longMonth(view.month)} and the bills linked to it`)}
                {budgets.map(b => (
                  <React.Fragment key={b.id}>
                    <tr style={{ ...C.groupRow, cursor: 'pointer' }} onClick={() => onOpenBudget(b)}>
                      <td style={{ ...S.td, fontWeight: 700 }}>{++sr}</td>
                      {cols.map((c, i) => <td key={i} style={{ ...S.td, ...(c.num ? C.num : {}), fontWeight: 600 }}>{c.b(b)}</td>)}
                      <td style={S.td}>{b.expects_more_bills && <Tag tone="grey">more bills expected</Tag>}</td>
                    </tr>
                    {linked(b.id).map(p => partRow(p, true))}
                  </React.Fragment>
                ))}
                {otherBudget.length > 0 && group('Bills scheduled this month, linked to another month\'s budget')}
                {otherBudget.map(p => partRow(p))}
                {unlinked.length > 0 && group('Received without a linked budget — review')}
                {unlinked.map(p => partRow(p))}
                {opening.length > 0 && group('Opening dues — earlier bills still unpaid at the start of the month')}
                {opening.map(p => partRow(p))}
                {advances.length > 0 && group('Advances paid, not yet applied to a bill')}
                {advances.map(a => (
                  <tr key={a.pid} style={{ cursor: 'pointer' }} onClick={() => onOpenBudget({ advance: a })}>
                    <td style={{ ...S.td, color: '#9BA8B0' }}>{++sr}</td>
                    <td colSpan={Math.max(1, cols.length - 7)} style={S.td}>{a.vendor} <span style={S.small}>· paid {dmy(a.date)} · {a.no || ''} {a.ref ? `· ${a.ref}` : ''}</span>{a.budget_id && <Tag tone="green">linked to a budget</Tag>}{a.slips.length > 0 && <Tag tone="grey">{a.slips.length} slip(s)</Tag>}</td>
                    <td style={{ ...S.td, ...C.num }} colSpan={2}>advance {inr(a.amount)}</td>
                    <td style={{ ...S.td, ...C.num }} colSpan={2}>not applied {inr(a.unapplied)}</td>
                    <td style={S.td} colSpan={4} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unlinked.length > 0 && <div style={S.small}>Bills without a linked budget stay in the totals; open one to link it to a budget line.</div>}
          <div style={{ ...S.small, marginTop: 4 }}>{linkLabel('auto')}: matched by vendor / client / branch and month — open a bill to change it.</div>
        </>
      )}
      <DrillModal drill={drill} onClose={() => setDrill(null)} onOpenPart={onOpenPart} onOpenBudget={onOpenBudget} />
    </div>
  );
}
