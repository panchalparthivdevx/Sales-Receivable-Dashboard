import React, { useState } from 'react';
import { S, Tag } from '../billbooking/ui';
import { inr, dmy, monthLabel, longMonth } from './cfApi';
import { C, Num, Modal, PartsTable, BudgetsTable, CashTable } from './cfUi';

// ─── Monthly overview: one row per category and a total; every figure opens the transactions behind it ───

const COLS = [
  { k: 'budget', label: 'Finalised budget', tip: 'Budget lines planned for this month (the original figure is kept when a line is changed)' },
  { k: 'awaiting', label: 'Budget awaiting bills', tip: 'Planned payments whose bill has not come yet (or more bills expected)' },
  { k: 'billed', label: 'Bills received (net)', tip: 'Net payable (after TDS) of the bills planned for this month' },
  { k: 'opening', label: 'Opening dues b/f', tip: 'Earlier bills still unpaid at the start of the month' },
  { k: 'pending', label: 'Initiated & pending', tip: 'Payment instructions given but not yet settled in Zoho' },
  { k: 'paid_plan', label: 'Paid against plan', tip: 'Payments (and advances) on this month\'s plan' },
  { k: 'remaining', label: 'Remaining budget', tip: 'Finalised budget less cash payments allocated to it (negative = exceeded)' },
  { k: 'final_out', label: 'Final bill outstanding', tip: 'Net payable less payments, credits and advances applied' },
  { k: 'to_initiate', label: 'Still to initiate', tip: 'Scheduled amount not yet paid (at most the outstanding), less what is already initiated' },
];

export function drillOf(view, cat, k) {
  const inC = x => cat === 'total' || x.category === cat;
  const P = view.rows.parts.filter(inC), B = view.rows.budgets.filter(inC);
  switch (k) {
    case 'budget': case 'remaining': return { budgets: B };
    case 'awaiting': return { budgets: B.filter(b => b.at.awaiting > 0.5) };
    case 'unbilled': return { budgets: B.filter(b => b.at.unbilled > 0.5) };
    case 'billed': return { parts: P.filter(p => !p.carried_from) };
    case 'unlinked': return { parts: P.filter(p => !p.carried_from && !p.budget_id) };
    case 'opening': return { parts: P.filter(p => p.carried_from), show: { openingOut: true } };
    case 'pending': return { parts: P.filter(p => p.at.pending > 0.5) };
    case 'paid_plan': return { parts: P.filter(p => p.paid_against_plan > 0.5), show: { paidField: 'paid_against_plan' }, budgets: B.filter(b => b.at.paid_advances > 0.5) };
    case 'final_out': return { parts: P.filter(p => p.at.final_out > 0.5) };
    case 'to_initiate': return { parts: P.filter(p => p.at.to_initiate > 0.5) };
    case 'cash_out': return { cash: view.cash.filter(inC) };
    default: return {};
  }
}

export function DrillModal({ drill, onClose, onOpenPart, onOpenBudget }) {
  if (!drill) return null;
  const { title, sub, data } = drill;
  return (
    <Modal title={title} sub={sub} onClose={onClose} wide>
      {data.budgets && data.budgets.length > 0 && <><div style={C.subTitle}>Budget lines</div><BudgetsTable budgets={data.budgets} onOpen={b => { onClose(); onOpenBudget(b); }} /></>}
      {data.parts && <><div style={C.subTitle}>Bills</div><PartsTable parts={data.parts} show={data.show || {}} onOpen={p => { onClose(); onOpenPart(p); }} /></>}
      {data.cash && <CashTable items={data.cash} />}
      {!data.budgets && !data.parts && !data.cash && <div style={S.center}>Nothing to show.</div>}
    </Modal>
  );
}

export default function Overview({ view, categories, onOpenPart, onOpenBudget, onTab }) {
  const [drill, setDrill] = useState(null);
  const [list, setList] = useState('initiate');
  const label = c => (c === 'total' ? 'Total' : categories.find(x => x.key === c)?.label || c);
  const open = (cat, k, colLabel) => setDrill({ title: `${label(cat)} — ${colLabel}`, sub: `${longMonth(view.month)} · ${view.mode === 'month_end' ? `as at ${dmy(view.as_of)} (month-end)` : `status today (${dmy(view.as_of)})`}`, data: drillOf(view, cat, k) });
  const T = view.summary.total;
  const rows = [...categories.map(c => c.key), 'total'];

  return (
    <div>
      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.cardTitle}>Monthly summary — {longMonth(view.month)}</span>
          <span style={S.small}>{view.mode === 'month_end' ? (view.as_of < view.end ? `Month-end status: the month is not over — as at ${dmy(view.as_of)}` : `Month-end status: as at ${dmy(view.as_of)}`) : `Current status: as at ${dmy(view.as_of)}`} · click any figure for its transactions</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={S.th}>Category</th>
              {COLS.map(c => <th key={c.k} style={{ ...S.th, ...C.num, whiteSpace: 'normal', minWidth: 92 }} title={c.tip}>{c.label}</th>)}
              <th style={{ ...S.th, ...C.num, whiteSpace: 'normal', minWidth: 100, borderLeft: '2px solid #DFE7E3' }} title="Payments by their payment date, whatever month they were planned for (advances when paid)">Cash outflow (by payment date)</th>
            </tr></thead>
            <tbody>
              {rows.map(cat => {
                const s = view.summary[cat];
                if (!s) return null;
                const tot = cat === 'total';
                return (
                  <tr key={cat} style={tot ? { background: '#F6FAF8' } : {}}>
                    <td style={{ ...S.td, fontWeight: tot ? 700 : 600 }}>
                      {tot ? 'Total' : <button type="button" style={{ ...C.link, textDecoration: 'none', fontWeight: 600 }} onClick={() => onTab(cat)}>{label(cat)}</button>}
                    </td>
                    {COLS.map(c => (
                      <td key={c.k} style={{ ...S.td, ...C.num }}>
                        <Num value={s[c.k]} strong={tot} onClick={() => open(cat, c.k, c.label)} />
                        {c.k === 'budget' && Math.abs(s.budget_original - s.budget) > 0.5 && <div style={S.small}>orig. {inr(s.budget_original)}</div>}
                      </td>
                    ))}
                    <td style={{ ...S.td, ...C.num, borderLeft: '2px solid #DFE7E3' }}><Num value={s.cash_out} strong onClick={() => open(cat, 'cash_out', 'Cash outflow by payment date')} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '0.6rem 1.1rem', display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid #F0F2F1' }}>
          {T.counts.excess > 0 && <Tag tone="red">{T.counts.excess} budget line(s) exceeded</Tag>}
          {T.unbilled > 0.5 && <button type="button" style={{ ...C.link, textDecoration: 'none' }} onClick={() => open('total', 'unbilled', 'Budget not billed (review)')}><Tag tone="amber">{inr(T.unbilled)} of budget not billed — review</Tag></button>}
          {T.counts.unlinked > 0 && <button type="button" style={{ ...C.link, textDecoration: 'none' }} onClick={() => open('total', 'unlinked', 'Received without a linked budget')}><Tag tone="violet">{T.counts.unlinked} bill(s) received without a linked budget ({inr(T.unlinked)})</Tag></button>}
          {T.counts.overdue > 0 && <Tag tone="red">{T.counts.overdue} bill(s) of this month past their Pay On date</Tag>}
          {T.counts.overdue_opening > 0 && <Tag tone="amber">{T.counts.overdue_opening} opening due(s) from earlier months still to pay</Tag>}
          {!T.counts.excess && T.unbilled <= 0.5 && !T.counts.unlinked && !T.counts.overdue && !T.counts.overdue_opening && <span style={S.small}>No budget exceeded, nothing unlinked, no Pay On date missed.</span>}
        </div>
      </div>

      <div style={S.card}>
        <div style={{ ...S.cardHead, padding: '0.5rem 1.1rem' }}>
          <div style={{ display: 'flex', gap: 0 }}>
            {[['follow_up', 'Follow up for bills'], ['initiate', 'Initiate payment'], ['settlement', 'Check settlement']].map(([k, l], i) => (
              <button key={k} type="button" style={{ ...C.pill(list === k), borderRadius: i === 0 ? '6px 0 0 6px' : i === 2 ? '0 6px 6px 0' : 0, marginLeft: i ? -1 : 0 }} onClick={() => setList(k)}>
                {l} ({view.actions[k].length})
              </button>
            ))}
          </div>
          <span style={S.small}>{list === 'follow_up' ? 'Planned payments whose bill has not come yet' : list === 'initiate' ? 'Received bills with a scheduled amount still to initiate' : 'Payments initiated and awaiting settlement in Zoho'}</span>
        </div>
        <ActionList kind={list} items={view.actions[list]} view={view} categories={categories} onOpenPart={onOpenPart} onOpenBudget={onOpenBudget} />
      </div>

      <DrillModal drill={drill} onClose={() => setDrill(null)} onOpenPart={onOpenPart} onOpenBudget={onOpenBudget} />
    </div>
  );
}

function ActionList({ kind, items, view, categories, onOpenPart, onOpenBudget }) {
  if (!items.length) return <div style={S.center}>{kind === 'follow_up' ? 'Every planned payment has its bill.' : kind === 'initiate' ? 'Nothing left to initiate.' : 'No payment is waiting for settlement.'}</div>;
  const cat = k => categories.find(c => c.key === k)?.label || k;
  const partOf = key => view.rows.parts.find(p => p.key === key);
  const budgetOf = id => view.rows.budgets.find(b => b.id === id);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          {kind === 'follow_up' && ['Category', 'Branch', 'Vendor / client', 'Planned month', 'Pay on', 'Amount awaiting bill'].map(h => <th key={h} style={{ ...S.th, ...(h.startsWith('Amount') ? C.num : {}) }}>{h}</th>)}
          {kind === 'initiate' && ['Category', 'Branch', 'Vendor', 'Bill', 'Pay on', 'Delay', 'Still to initiate'].map(h => <th key={h} style={{ ...S.th, ...(h === 'Still to initiate' ? C.num : {}) }}>{h}</th>)}
          {kind === 'settlement' && ['Category', 'Branch', 'Vendor', 'Bill', 'Initiated on', 'Reference', 'Waiting', 'Pending'].map(h => <th key={h} style={{ ...S.th, ...(h === 'Pending' ? C.num : {}) }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {kind === 'follow_up' && items.map(x => (
            <tr key={x.id} style={{ cursor: 'pointer' }} onClick={() => { const b = budgetOf(x.id); if (b) onOpenBudget(b); else onOpenBudget({ ...x, id: x.id, needsLoad: true }); }}>
              <td style={S.td}>{cat(x.category)}</td><td style={S.td}>{x.branch || '—'}</td>
              <td style={S.td}>{x.vendor || '—'}{x.client ? <div style={S.small}>Client: {x.client}</div> : null}</td>
              <td style={S.td}>{monthLabel(x.planned_month)} {x.earlier && <Tag tone="red">earlier month</Tag>}</td><td style={S.td}>{dmy(x.pay_on)}</td>
              <td style={{ ...S.td, ...C.num }}>{inr(x.amount)}</td>
            </tr>
          ))}
          {kind === 'initiate' && items.map(x => (
            <tr key={x.key} style={{ cursor: 'pointer' }} onClick={() => { const p = partOf(x.key); if (p) onOpenPart(p); }}>
              <td style={S.td}>{cat(x.category)}</td><td style={S.td}>{x.branch || '—'}</td><td style={S.td}>{x.vendor}</td>
              <td style={S.td}>{x.bill_no}{x.carried_from && <div><Tag tone="amber">Opening due · bill of {monthLabel(x.bill_date.slice(0, 7))}</Tag></div>}</td>
              <td style={S.td}>{dmy(x.pay_on)}</td>
              <td style={S.td}>{x.delay_days > 0 ? <Tag tone={x.carried_from ? 'amber' : 'red'}>{x.delay_days} day(s) late</Tag> : <span style={S.small}>on time</span>}</td>
              <td style={{ ...S.td, ...C.num, fontWeight: 600 }}>{inr(x.amount)}</td>
            </tr>
          ))}
          {kind === 'settlement' && items.flatMap(x => x.initiations.map((i, n) => (
            <tr key={`${x.key}-${n}`} style={{ cursor: 'pointer' }} onClick={() => { const p = partOf(x.key); if (p) onOpenPart(p); }}>
              <td style={S.td}>{cat(x.category)}</td><td style={S.td}>{x.branch || '—'}</td><td style={S.td}>{x.vendor}</td><td style={S.td}>{x.bill_no}</td>
              <td style={S.td}>{dmy(i.date)}{i.source === 'portal' && <div><Tag tone="blue">Finance Portal</Tag></div>}</td><td style={S.td}>{i.reference || '—'}</td>
              <td style={S.td}>{i.age_days > 3 ? <Tag tone="amber">{i.age_days} days</Tag> : `${i.age_days} day(s)`}</td>
              <td style={{ ...S.td, ...C.num, fontWeight: 600 }}>{inr(i.amount)}</td>
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  );
}
