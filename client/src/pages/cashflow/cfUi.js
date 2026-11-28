import React from 'react';
import { X } from 'lucide-react';
import { S, Tag } from '../billbooking/ui';
import { inr, dmy, monthLabel, STATE, LINK_LABEL } from './cfApi';

// Shared pieces of the Management Cash Flow screens (light theme, same tokens as the rest of the app)

export const C = {
  num: { textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  link: { background: 'none', border: 'none', padding: 0, color: '#1C4942', cursor: 'pointer', font: 'inherit', textDecoration: 'underline dotted', textUnderlineOffset: 3 },
  groupRow: { background: '#F6FAF8' },
  subTitle: { fontSize: '0.74rem', fontWeight: 700, color: '#5D6C7B', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '0.6rem 0.6rem 0.3rem' },
  neg: { color: '#B91C1C', fontWeight: 600 },
  pill: on => ({ padding: '0.3rem 0.7rem', fontSize: '0.76rem', fontWeight: 600, cursor: 'pointer', border: '1px solid #DFE7E3', background: on ? '#1C4942' : '#FFFFFF', color: on ? '#FFFFFF' : '#5D6C7B' }),
};

/** A figure that opens the transactions behind it */
export function Num({ value, onClick, strong, neg, title, zeroDash = true }) {
  const v = Number(value) || 0;
  const txt = zeroDash && Math.abs(v) < 0.5 ? '—' : inr(v);
  const style = { ...(strong ? { fontWeight: 700 } : {}), ...((neg ?? v < -0.5) ? C.neg : {}) };
  if (!onClick || txt === '—') return <span style={style} title={title}>{txt}</span>;
  return <button type="button" style={{ ...C.link, ...style }} title={title || 'Show the transactions behind this figure'} onClick={onClick}>{txt}</button>;
}

export function Modal({ title, sub, onClose, children, wide, footer }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.35)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 1rem', overflow: 'auto' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label={title} style={{ ...S.card, width: wide ? 'min(1200px, 96vw)' : 'min(640px, 96vw)', marginBottom: 0 }}>
        <div style={S.cardHead}>
          <div><div style={S.cardTitle}>{title}</div>{sub && <div style={S.small}>{sub}</div>}</div>
          <button type="button" aria-label="Close" style={{ ...S.ghost, padding: '0.25rem 0.45rem' }} onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ ...S.cardBody, maxHeight: '76vh', overflow: 'auto' }}>{children}</div>
        {footer && <div style={{ ...S.cardBody, borderTop: '1px solid #DFE7E3', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, sub, onClose, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.25)', zIndex: 900 }} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside role="dialog" aria-label={title} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(860px, 96vw)', background: '#F9F9F9', boxShadow: '-4px 0 18px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ ...S.cardHead, background: '#FFFFFF' }}>
          <div style={{ minWidth: 0 }}><div style={{ ...S.cardTitle, fontSize: '1rem' }}>{title}</div>{sub && <div style={S.muted}>{sub}</div>}</div>
          <button type="button" aria-label="Close" style={{ ...S.ghost, padding: '0.25rem 0.45rem' }} onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.1rem' }}>{children}</div>
      </aside>
    </div>
  );
}

export function Section({ title, right, children }) {
  return (
    <div style={S.card}>
      <div style={{ ...S.cardHead, padding: '0.6rem 0.9rem' }}><span style={{ ...S.cardTitle, fontSize: '0.84rem' }}>{title}</span>{right}</div>
      <div style={{ padding: '0.75rem 0.9rem' }}>{children}</div>
    </div>
  );
}

export const StateTag = ({ state }) => { const s = STATE[state] || STATE.to_initiate; return <Tag tone={s.tone}>{s.label}</Tag>; };

/** Bill rows (parts) behind a figure — the drill-down table */
export function PartsTable({ parts, onOpen, show = {} }) {
  if (!parts.length) return <div style={S.center}>No transactions.</div>;
  const tot = k => parts.reduce((s, p) => s + (Number(k(p)) || 0), 0);
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>
        {['Branch', 'Vendor', 'Bill', 'Bill date', 'Planned', 'Net payable', 'Paid', 'Pending', 'Outstanding', 'To initiate', 'Status'].map(h => <th key={h} style={{ ...S.th, ...(['Net payable', 'Paid', 'Pending', 'Outstanding', 'To initiate'].includes(h) ? C.num : {}) }}>{h}</th>)}
      </tr></thead>
      <tbody>
        {parts.map(p => (
          <tr key={p.key} style={{ cursor: onOpen ? 'pointer' : 'default' }} onClick={() => onOpen && onOpen(p)}>
            <td style={S.td}>{p.branch || '—'}</td>
            <td style={S.td}>{p.vendor}{p.carried_from ? <div><Tag tone="amber">Opening due · planned {monthLabel(p.carried_from)}</Tag></div> : p.earlier_bill ? <div><Tag tone="violet">Earlier bill</Tag></div> : null}</td>
            <td style={S.td}>{p.bill_no}</td>
            <td style={S.td}>{dmy(p.bill_date)}</td>
            <td style={S.td}>{monthLabel(p.planned_month)}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(p.net)}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(show.paidField ? p[show.paidField] : p.at?.paid)}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(p.at?.pending)}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(show.openingOut ? p.opening_out : p.at?.final_out)}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(p.at?.to_initiate)}</td>
            <td style={S.td}><StateTag state={p.at?.state} /></td>
          </tr>
        ))}
        <tr><td style={{ ...S.td, fontWeight: 700 }} colSpan={5}>Total ({parts.length})</td>
          <td style={{ ...S.td, ...C.num, fontWeight: 700 }}>{inr(tot(p => p.net))}</td>
          <td style={{ ...S.td, ...C.num, fontWeight: 700 }}>{inr(tot(p => (show.paidField ? p[show.paidField] : p.at?.paid)))}</td>
          <td style={{ ...S.td, ...C.num, fontWeight: 700 }}>{inr(tot(p => p.at?.pending))}</td>
          <td style={{ ...S.td, ...C.num, fontWeight: 700 }}>{inr(tot(p => (show.openingOut ? p.opening_out : p.at?.final_out)))}</td>
          <td style={{ ...S.td, ...C.num, fontWeight: 700 }}>{inr(tot(p => p.at?.to_initiate))}</td><td style={S.td} /></tr>
      </tbody>
    </table>
  );
}

/** Budget lines behind a figure */
export function BudgetsTable({ budgets, onOpen }) {
  if (!budgets.length) return <div style={S.center}>No budget lines.</div>;
  const tot = k => budgets.reduce((s, b) => s + (Number(k(b)) || 0), 0);
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>{['Branch', 'Vendor / client', 'Planned', 'Finalised budget', 'Bills received', 'Paid against it', 'Remaining', 'Awaiting bill', 'Not billed (review)'].map(h => <th key={h} style={{ ...S.th, ...(['Branch', 'Vendor / client', 'Planned'].includes(h) ? {} : C.num) }}>{h}</th>)}</tr></thead>
      <tbody>
        {budgets.map(b => (
          <tr key={b.id} style={{ cursor: onOpen ? 'pointer' : 'default' }} onClick={() => onOpen && onOpen(b)}>
            <td style={S.td}>{b.branch || '—'}</td>
            <td style={S.td}>{b.vendor_name || '—'}{b.client ? <div style={S.small}>Client: {b.client}</div> : null}</td>
            <td style={S.td}>{monthLabel(b.planned_month)}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(b.amount)}{Math.abs(b.original_amount - b.amount) > 0.5 && <div style={S.small}>orig. {inr(b.original_amount)}</div>}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(b.at?.billed)}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(b.at?.paid)}</td>
            <td style={{ ...S.td, ...C.num, ...(b.at?.excess ? C.neg : {}) }}>{inr(b.at?.remaining)}{b.at?.excess && <div><Tag tone="red">Exceeded</Tag></div>}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(b.at?.awaiting)}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(b.at?.unbilled)}</td>
          </tr>
        ))}
        <tr><td style={{ ...S.td, fontWeight: 700 }} colSpan={3}>Total ({budgets.length})</td>
          {[b => b.amount, b => b.at?.billed, b => b.at?.paid, b => b.at?.remaining, b => b.at?.awaiting, b => b.at?.unbilled].map((f, i) => <td key={i} style={{ ...S.td, ...C.num, fontWeight: 700 }}>{inr(tot(f))}</td>)}</tr>
      </tbody>
    </table>
  );
}

/** Cash movements behind the cash outflow figure */
export function CashTable({ items }) {
  if (!items.length) return <div style={S.center}>No payments in this month.</div>;
  const KIND = { bill_payment: 'Bill payment', advance_applied: 'Advance (applied to the bill later)', advance_unapplied: 'Advance (not yet applied to a bill)' };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>{['Payment date', 'Vendor', 'Branch', 'Bill', 'Payment no.', 'Reference', 'Type', 'Amount'].map(h => <th key={h} style={{ ...S.th, ...(h === 'Amount' ? C.num : {}) }}>{h}</th>)}</tr></thead>
      <tbody>
        {[...items].sort((a, b) => a.date.localeCompare(b.date)).map((x, i) => (
          <tr key={i}><td style={S.td}>{dmy(x.date)}</td><td style={S.td}>{x.vendor}</td><td style={S.td}>{x.branch || '—'}</td><td style={S.td}>{x.bill_no || '—'}</td>
            <td style={S.td}>{x.payment_no || '—'}</td><td style={S.td}>{x.ref || '—'}</td><td style={S.td}>{KIND[x.kind] || x.kind}{x.kind === 'advance_applied' && x.apply ? <div style={S.small}>applied {dmy(x.apply)}</div> : null}</td>
            <td style={{ ...S.td, ...C.num }}>{inr(x.amount)}</td></tr>
        ))}
        <tr><td style={{ ...S.td, fontWeight: 700 }} colSpan={7}>Total ({items.length})</td><td style={{ ...S.td, ...C.num, fontWeight: 700 }}>{inr(items.reduce((s, x) => s + x.amount, 0))}</td></tr>
      </tbody>
    </table>
  );
}

export const linkLabel = l => LINK_LABEL[l] || '';
