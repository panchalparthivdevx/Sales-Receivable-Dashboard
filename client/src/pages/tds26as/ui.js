import React from 'react';
import { S, inr, dt, dtm, Field, Msg, Card, Drawer, Modal, Tag } from '../gstr2b/ui';

// The app's light theme and the GSTR-2B screens' building blocks, plus this module's statuses
export { S, inr, dt, dtm, Field, Msg, Card, Drawer, Modal, Tag };

export const STATUS_META = {
  matched:       { color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  rounding:      { color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
  not_matched:   { color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  not_in_26as:   { color: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  not_in_zoho:   { color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  need_check:    { color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  carry_forward: { color: '#475569', bg: '#F1F5F9', border: '#CBD5E1' },
};
export const STATUS_KEYS = ['matched', 'rounding', 'not_matched', 'not_in_26as', 'not_in_zoho', 'need_check', 'carry_forward'];

export function StatusPill({ status, statuses, small, title }) {
  const m = STATUS_META[status] || STATUS_META.carry_forward;
  return <span title={title} style={{ display: 'inline-block', padding: small ? '1px 6px' : '2px 8px', borderRadius: 10, fontSize: small ? '0.64rem' : '0.7rem', fontWeight: 600, whiteSpace: 'nowrap', color: m.color, background: m.bg, border: `1px solid ${m.border}` }}>{statuses?.[status] || status}</span>;
}

/** System status, and the reviewer's final status when one is set */
export function Statuses({ u, statuses }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
      <StatusPill status={u.effective} statuses={statuses} title={u.final_status ? `Final status set by ${u.decision?.by || 'a reviewer'}; system status: ${statuses[u.status]}` : 'System status'} />
      {u.final_status && u.final_status !== u.status && <span style={{ fontSize: '0.64rem', color: '#9BA8B0' }}>system: {statuses[u.status]}</span>}
    </div>
  );
}

// amounts are paise; a negative amount reads "−₹2.00", a signed difference "+₹2.00" / "−₹2.00"
export const r = p => (p === null || p === undefined ? '—' : `${p < 0 ? '−' : ''}₹${inr(Math.abs(p))}`);
export const rs = p => (p === null || p === undefined ? '—' : `${p > 0 ? '+' : p < 0 ? '−' : ''}₹${inr(Math.abs(p))}`);
export const qLabel = k => { const m = String(k || '').match(/^(\d{4}-\d{2})-Q([1-4])$/); return m ? `Q${m[2]} FY ${m[1]}` : (k || ''); };
export const srcText = s => (s ? [s.sheet ? `sheet ${s.sheet}` : '', s.page ? `page ${s.page}` : '', s.line ? `line ${s.line}` : '', s.row ? `row ${s.row}` : ''].filter(Boolean).join(', ') : '');

export const FLAG_TEXT = {
  tds_booked_twice: 'TDS booked twice', ledger_fy_mismatch: 'Other FY ledger', section_differs_invoice: 'Section ≠ invoice', unallocated: 'No customer', payment_not_found: 'Payment not found', no_base: 'No base value',
  reference_not_found: 'Reference not a Zoho invoice', reversal: 'Reversal', deducted_exceeds_deposited: 'Deducted > deposited', section_mismatch: 'Section differs', one_credit_many_entries: 'One credit ↔ several entries',
  one_entry_many_credits: 'One entry ↔ several credits', remaining_totals: 'Remaining client total',
};
export function Flags({ flags }) {
  const tone = f => (/twice|mismatch|differs|deducted_exceeds|unallocated/.test(f) ? 'red' : /one_|remaining/.test(f) ? 'violet' : /reversal|no_base|not_found/.test(f) ? 'amber' : 'grey');
  return <>{(flags || []).filter(f => !/^linked by/.test(f)).map(f => <Tag key={f} tone={tone(f)}>{FLAG_TEXT[f] || f}</Tag>)}</>;
}

export const tableWrap = { overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' };
export const table = { width: '100%', borderCollapse: 'collapse' };

/** Small figure + label row used inside drawers */
export function KV({ k, v, strong }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '0.18rem 0', fontSize: '0.78rem' }}><span style={{ color: '#5D6C7B' }}>{k}</span><span style={{ fontWeight: strong ? 700 : 500, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: /^[+−]?₹/.test(String(v)) ? 'nowrap' : 'normal' }}>{v}</span></div>;
}
