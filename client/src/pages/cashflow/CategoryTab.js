import React, { useMemo, useState } from 'react';
import { Plus, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { S, Tag } from '../billbooking/ui';
import { inr, dmy, monthLabel, longMonth, addMonths } from './cfApi';
import { C, Num, StateTag } from './cfUi';
import { drillOf, DrillModal } from './Overview';
import FyGrid from './FyGrid';

// ─── One category tab: budget lines with their bills, bills without a budget, opening dues — and the advances apart ───

const ROWS_SHOWN = 50;          // rows per section before "show all"
const ADV_MIN = 100;            // ₹ — smaller unapplied leftovers of a payment are not listed as advances

const T = {
  table: { width: '100%', minWidth: 1320, borderCollapse: 'collapse', tableLayout: 'fixed' },
  th: { ...S.th, whiteSpace: 'normal', lineHeight: 1.25, verticalAlign: 'bottom' },
  td: { ...S.td, padding: '0.42rem 0.55rem', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle' },
  one: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' },
  section: { background: '#F6FAF8', cursor: 'pointer', borderTop: '1px solid #DFE7E3' },
  budgetRow: { background: '#FBFDFC' },
  sub: { color: '#9BA8B0', fontSize: '0.7rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' },
};
const one = (text, sub) => <><span style={T.one} title={typeof text === 'string' ? text : undefined}>{text || '—'}</span>{sub ? <span style={T.sub} title={typeof sub === 'string' ? sub : undefined}>{sub}</span> : null}</>;
const money = v => <Num value={v} />;

/** Category columns: w = width, b(budget row), p(bill row), sum = what the section header totals in this column */
function columns(cat) {
  const narrow = cat !== 'rent';
  const bill = { h: 'Bill', w: narrow ? 125 : 135, b: () => '', p: p => one(p.bill_no, cat === 'electricity' ? `${dmy(p.bill_date)} · due ${dmy(p.due)}` : dmy(p.bill_date)) };
  const vendor = h => ({ h, w: narrow ? 170 : 190, b: b => one(b.vendor_name || 'Any vendor', b.notes || ''), p: (p, nested) => one(`${nested ? '↳ ' : ''}${p.vendor}`) });
  const branch = { h: 'Branch', w: narrow ? 125 : 145, b: b => one(b.branch || 'All branches'), p: p => one(p.branch) };
  const budget = { h: cat === 'brokerage' ? 'Agreed amount' : 'Budget', w: 100, num: true, sum: 'budget',
    b: b => <><Num value={b.amount} strong />{Math.abs(b.original_amount - b.amount) > 0.5 && <span style={T.sub}>orig. {inr(b.original_amount)}</span>}<span style={{ ...T.sub, ...(b.at.excess ? C.neg : {}) }}>left {inr(b.at.remaining)}</span></>,
    p: () => '' };
  const figures = [
    { h: 'Net payable', w: 100, num: true, sum: 'net', b: b => money(b.at.billed), p: p => money(p.net) },
    { h: 'Paid', w: 100, num: true, sum: 'paid', b: b => money(b.at.paid), p: p => <>{money(p.at.paid)}{p.paid_later > 0.5 && <span style={T.sub}>+{inr(p.paid_later)} later</span>}</> },
    { h: 'Outstanding', w: 100, num: true, sum: 'out', b: () => '', p: p => money(p.at.final_out) },
    { h: 'Still to initiate', w: 100, num: true, sum: 'toinit', b: () => '', p: p => <Num value={p.at.to_initiate} strong={p.at.to_initiate > 0.5} /> },
    { h: 'Pay on', w: 92, b: b => (b.at.awaiting > 0.5 ? one(dmy(b.at.schedule[0]?.pay_on), 'forecast') : ''),
      p: p => (p.at.state === 'paid' ? '' : p.at.overdue ? <>{one(dmy(p.at.overdue.pay_on))}<span style={{ ...T.sub, color: '#B91C1C' }}>{p.at.overdue.days} days late</span></> : one(dmy(p.at.next_pay_on), p.schedule ? `${p.schedule.length} instalment(s)` : 'due date')) },
    { h: 'Status', w: 165, b: b => budgetState(b), p: p => partState(p) },
  ];
  if (cat === 'brokerage') return [
    { h: 'Month to pay', w: 78, b: b => monthLabel(b.planned_month), p: p => monthLabel(p.planned_month) },
    { h: 'Client', w: 150, b: b => one(b.client || '—'), p: p => (p.client ? one(p.client, p.client_source === 'team' ? 'entered by team' : p.client_source === 'bill text (suggested)' ? 'suggested — check' : 'from bill') : <Tag tone="amber">{p.client_options?.length ? 'Choose client' : 'Enter client'}</Tag>) },
    branch, vendor('Broker / vendor'), bill, budget, ...figures];
  if (cat === 'rent') return [branch, vendor('Landlord / developer'),
    { h: 'Rent period', w: 92, b: b => one(b.period_label || '—'), p: p => one(p.period.label, p.period.source === 'bill text' ? '' : 'bill month') },
    bill, budget, ...figures];
  return [branch, vendor('Provider / billing vendor'),
    { h: 'Connection / meter', w: 115, b: b => one(b.connection || '—'), p: p => one(p.connection || p.meter || '—', p.meter && p.connection ? `No. ${p.meter}` : '') },
    { h: 'Billing period', w: 85, b: b => one(b.period_label || '—'), p: p => one(p.period.label) },
    bill, budget, ...figures];
}

function budgetState(b) {
  if (b.at.excess) return <Tag tone="red">Budget exceeded</Tag>;
  if (b.at.awaiting > 0.5) return <Tag tone="amber">{b.at.bills ? 'More bills expected' : 'Awaiting bill'}</Tag>;
  if (b.at.unbilled > 0.5) return <><Tag tone="violet">Not fully billed</Tag><span style={T.sub}>{inr(b.at.unbilled)} to review</span></>;
  return <Tag tone="green">Billed</Tag>;
}
function partState(p) {
  return (
    <>
      <StateTag state={p.at.state} />
      {p.at.pending > 0.5 && <span style={T.sub}>{inr(p.at.pending)} initiated, pending</span>}
      {p.at.pending <= 0.5 && p.link === 'auto' && <span style={T.sub}>budget linked automatically</span>}
      {Math.abs(p.at.balance_gap) > 1 && <span style={{ ...T.sub, color: '#B91C1C' }} title="Differs from Zoho's balance — refresh from Zoho">check against Zoho</span>}
    </>
  );
}

const totals = (budgets, parts) => ({
  budget: budgets.reduce((s, b) => s + b.amount, 0),
  net: parts.reduce((s, p) => s + p.net, 0), paid: parts.reduce((s, p) => s + p.at.paid, 0) + budgets.reduce((s, b) => s + (b.at.paid_advances || 0), 0),
  out: parts.reduce((s, p) => s + Math.max(0, p.at.final_out), 0), toinit: parts.reduce((s, p) => s + p.at.to_initiate, 0),
});

/** A section: header row with count and totals in their columns, collapsible, the first rows then "show all" */
function Section({ title, hint, count, sums, cols, open, onToggle, children, more, onMore }) {
  const firstNum = cols.findIndex(c => c.num);
  return (
    <>
      <tr style={T.section} onClick={onToggle}>
        <td style={{ ...T.td, fontWeight: 700, whiteSpace: 'nowrap' }} colSpan={firstNum + 1}>
          {open ? <ChevronDown size={13} style={{ verticalAlign: -2 }} /> : <ChevronRight size={13} style={{ verticalAlign: -2 }} />} {title} <span style={{ ...S.small, fontWeight: 400 }}>· {count}{hint ? ` · ${hint}` : ''}</span>
        </td>
        {cols.slice(firstNum).map((c, i) => <td key={i} style={{ ...T.td, ...(c.num ? C.num : {}), fontWeight: 700 }}>{c.sum ? inr(sums[c.sum]) : ''}</td>)}
      </tr>
      {open && children}
      {open && more > 0 && <tr><td colSpan={cols.length + 1} style={{ ...T.td, textAlign: 'center' }}><button type="button" style={C.link} onClick={onMore}>Show all {count} — {more} more</button></td></tr>}
    </>
  );
}

export default function CategoryTab({ cat, catLabel, view, meta, filters, rights, onOpenPart, onOpenBudget, onAddBudget, copyBudgets }) {
  const [mode, setMode] = useState('month');
  const [drill, setDrill] = useState(null);
  const [closed, setClosed] = useState({});
  const [all, setAll] = useState({});
  const [advOpen, setAdvOpen] = useState(false);
  const cols = useMemo(() => columns(cat), [cat]);
  const parts = view.rows.parts.filter(p => p.category === cat);
  const budgets = view.rows.budgets.filter(b => b.category === cat).sort((a, b) => String(a.branch || '').localeCompare(String(b.branch || '')) || String(a.vendor_name || '').localeCompare(String(b.vendor_name || '')));
  const advancesAll = view.rows.advances.filter(a => a.category === cat).sort((a, b) => b.date.localeCompare(a.date));
  const advances = advancesAll.filter(a => a.unapplied >= ADV_MIN);
  const bIds = new Set(budgets.map(b => b.id));
  const byVendor = (a, b) => String(a.branch || '').localeCompare(String(b.branch || '')) || String(a.vendor).localeCompare(String(b.vendor)) || String(a.bill_date).localeCompare(String(b.bill_date));
  const linked = id => parts.filter(p => p.budget_id === id && !p.carried_from).sort(byVendor);
  const otherBudget = parts.filter(p => !p.carried_from && p.budget_id && !bIds.has(p.budget_id)).sort(byVendor);
  const unlinked = parts.filter(p => !p.carried_from && !p.budget_id).sort(byVendor);
  const opening = parts.filter(p => p.carried_from).sort((a, b) => b.bill_date.localeCompare(a.bill_date));
  const s = view.summary[cat] || {};
  const statuses = view.statuses || {};
  const waiting = Object.values(statuses).reduce((n, x) => n + (x?.remaining || 0), 0);
  const notRead = (view.coa_missing || []).length > 0;

  let sr = 0;
  const partRow = (p, nested) => (
    <tr key={p.key} className="cf-row" style={{ cursor: 'pointer' }} onClick={() => onOpenPart(p)}>
      <td style={{ ...T.td, color: '#9BA8B0' }}>{nested ? '' : ++sr}</td>
      {cols.map((c, i) => <td key={i} style={{ ...T.td, ...(c.num ? C.num : {}), ...(nested && i === 0 ? { paddingLeft: '1.2rem' } : {}) }}>{c.p(p, nested)}</td>)}
    </tr>
  );
  const rowsOf = (key, list, render) => (all[key] ? list : list.slice(0, ROWS_SHOWN)).map(render);
  const section = (key, title, list, opts = {}) => list.length > 0 && (
    <Section key={key} title={title} hint={opts.hint} count={opts.count ?? list.length} sums={opts.sums || totals([], list)} cols={cols}
      open={!closed[key]} onToggle={() => setClosed(c => ({ ...c, [key]: !c[key] }))}
      more={all[key] ? 0 : Math.max(0, list.length - ROWS_SHOWN)} onMore={() => setAll(a => ({ ...a, [key]: true }))}>
      {opts.children || rowsOf(key, list, p => partRow(p))}
    </Section>
  );

  return (
    <div>
      <style>{'.cf-row:hover td{background:#F4F8F6}'}</style>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: '0.75rem' }}>
            {[['budget', 'Finalised budget'], ['awaiting', 'Awaiting bills'], ['billed', 'Bills received'], ['paid_plan', 'Paid against plan'], ['remaining', 'Remaining budget'], ['final_out', 'Outstanding'], ['pending', 'Initiated & pending'], ['to_initiate', 'Still to initiate'], ['cash_out', 'Cash outflow']].map(([k, l]) => (
              <div key={k} style={{ ...S.card, marginBottom: 0, padding: '0.5rem 0.7rem' }}>
                <div style={{ ...S.label, marginBottom: 1 }}>{l}</div>
                <div style={{ fontSize: '1rem', fontWeight: 700 }}><Num value={s[k]} zeroDash={false} onClick={() => setDrill({ title: `${catLabel} — ${l}`, sub: longMonth(view.month), data: drillOf(view, cat, k) })} /></div>
              </div>
            ))}
          </div>

          <div style={{ ...S.card, overflowX: 'auto' }}>
            <table style={T.table}>
              <colgroup><col style={{ width: 44 }} />{cols.map(c => <col key={c.h} style={{ width: c.w }} />)}</colgroup>
              <thead><tr><th style={T.th}>#</th>{cols.map(c => <th key={c.h} style={{ ...T.th, ...(c.num ? { ...C.num, whiteSpace: 'normal' } : {}) }}>{c.h}</th>)}</tr></thead>
              <tbody>
                {!budgets.length && !parts.length && (
                  <tr><td colSpan={cols.length + 1} style={S.center}>
                    {notRead || waiting > 0
                      ? `No ${catLabel.toLowerCase()} bills yet — Zoho is still being read${waiting ? ` (${waiting} bill(s) waiting)` : ''}. The bills appear here as they come in${meta.vercel ? ' (every 15 minutes, or press Refresh from Zoho)' : ''}.`
                      : `Nothing planned or received for ${longMonth(view.month)}.${rights.plan ? ' Add a budget line to plan this month.' : ''}`}
                  </td></tr>
                )}
                {budgets.length > 0 && (
                  <Section title={`Budget for ${longMonth(view.month)}`} hint="each line with the bills linked to it" count={`${budgets.length} line(s)`}
                    sums={totals(budgets, budgets.flatMap(b => linked(b.id)))} cols={cols} open={!closed.budgets} onToggle={() => setClosed(c => ({ ...c, budgets: !c.budgets }))} more={0}>
                    {budgets.map(b => (
                      <React.Fragment key={b.id}>
                        <tr className="cf-row" style={{ ...T.budgetRow, cursor: 'pointer' }} onClick={() => onOpenBudget(b)}>
                          <td style={{ ...T.td, fontWeight: 700 }}>{++sr}</td>
                          {cols.map((c, i) => <td key={i} style={{ ...T.td, ...(c.num ? C.num : {}), fontWeight: 600 }}>{c.b(b)}</td>)}
                        </tr>
                        {linked(b.id).map(p => partRow(p, true))}
                      </React.Fragment>
                    ))}
                  </Section>
                )}
                {section('other', 'Scheduled this month, budget in another month', otherBudget)}
                {section('unlinked', 'Received without a linked budget', unlinked, { hint: 'open a bill to link it to a budget line' })}
                {section('opening', 'Opening dues', opening, { hint: 'earlier bills still unpaid at the start of the month', sums: { ...totals([], opening), out: opening.reduce((n, p) => n + Math.max(0, p.at.final_out), 0) } })}
              </tbody>
            </table>
          </div>

          {advancesAll.length > 0 && (
            <div style={S.card}>
              <div style={{ ...S.cardHead, cursor: 'pointer', padding: '0.6rem 1rem' }} onClick={() => setAdvOpen(o => !o)}>
                <span style={{ ...S.cardTitle, fontSize: '0.86rem' }}>{advOpen ? <ChevronDown size={13} style={{ verticalAlign: -2 }} /> : <ChevronRight size={13} style={{ verticalAlign: -2 }} />} Advances — paid, not yet applied to a bill</span>
                <span style={S.small}>{advances.length} payment(s) · {inr(advances.reduce((n, a) => n + a.unapplied, 0))} not yet applied{advancesAll.length > advances.length ? ` · ${advancesAll.length - advances.length} leftover(s) under ₹${ADV_MIN} not listed` : ''}</span>
              </div>
              {advOpen && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ ...T.table, minWidth: 980 }}>
                    <colgroup>{[90, 230, 140, 160, 200, 120, 120, 150].map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
                    <thead><tr>{['Paid on', 'Vendor', 'Branch', 'Payment no.', 'Reference', 'Payment amount', 'Not yet applied', 'Budget line'].map(h => <th key={h} style={{ ...T.th, ...(['Payment amount', 'Not yet applied'].includes(h) ? C.num : {}) }}>{h}</th>)}</tr></thead>
                    <tbody>
                      {(all.adv ? advances : advances.slice(0, ROWS_SHOWN)).map(a => (
                        <tr key={a.pid} className="cf-row" style={{ cursor: 'pointer' }} onClick={() => onOpenBudget({ advance: a })}>
                          <td style={T.td}>{dmy(a.date)}</td>
                          <td style={T.td}>{one(a.vendor)}</td>
                          <td style={T.td}>{one(a.branch || '—')}</td>
                          <td style={T.td}>{one(a.no || '—')}</td>
                          <td style={T.td}>{one(a.ref || '—')}</td>
                          <td style={{ ...T.td, ...C.num }}>{inr(a.amount)}</td>
                          <td style={{ ...T.td, ...C.num, fontWeight: 600 }}>{inr(a.unapplied)}</td>
                          <td style={T.td}>{a.budget_id ? <Tag tone="green">linked</Tag> : <span style={S.small}>—</span>}{a.slips.length > 0 && <> <Tag tone="grey">{a.slips.length} slip(s)</Tag></>}</td>
                        </tr>
                      ))}
                      {!all.adv && advances.length > ROWS_SHOWN && <tr><td colSpan={8} style={{ ...T.td, textAlign: 'center' }}><button type="button" style={C.link} onClick={() => setAll(x => ({ ...x, adv: true }))}>Show all {advances.length}</button></td></tr>}
                    </tbody>
                  </table>
                  <div style={{ ...S.small, padding: '0.5rem 1rem' }}>Money paid to these vendors that Zoho has not applied to a bill yet (a full advance, or what was left over from a payment). It counts as cash when paid; applying it to a bill later lowers that bill without a second outflow.</div>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <DrillModal drill={drill} onClose={() => setDrill(null)} onOpenPart={onOpenPart} onOpenBudget={onOpenBudget} />
    </div>
  );
}
