import React, { useState } from 'react';
import { Multi, Select, Input, Btn, S, C } from './ui';

// Filters shared by Overview, Calendar, Register and Workload. Every count on those screens comes from the tasks that pass them.
export const EMPTY_FILTERS = { fy: '', entity_ids: [], registration_ids: [], states: [], months: [], quarters: [], categories: [], owners: [], checkers: [], priorities: [], statuses: [], flags: [], search: '' };

const FLAG_OPTS = [['overdue', 'Overdue'], ['due_soon', 'Due soon'], ['review', 'Awaiting review / verification'], ['evidence_missing', 'Evidence missing'], ['no_due_date', 'No due date'], ['missing_rule', 'Missing state rule'], ['filed_late', 'Filed late'], ['rule_unverified', 'Rule unverified'], ['document_flags', 'Document check'], ['open', 'Open (not completed)']];

function fyMonths(fy) {
  if (!fy) return [];
  const s = parseInt(fy.slice(0, 4), 10);
  return Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; const y = i < 9 ? s : s + 1; return [`${y}-${String(m).padStart(2, '0')}`, new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })]; });
}

export default function FilterBar({ filters, setFilters, meta, org, users, fyOptions }) {
  const f = filters;
  const set = (k, v) => setFilters({ ...f, [k]: v });
  const ents = (org?.entities || []).map(e => [e.id, `${e.short_code} — ${e.legal_name}`]);
  const regs = (org?.registrations || []).filter(r => !f.entity_ids.length || f.entity_ids.includes(r.entity_id)).map(r => [r.id, `${r.state ? `${r.state} · ` : ''}${r.type.replace('GST_', 'GST ')} ${r.number}`]);
  const states = [...new Set((org?.registrations || []).map(r => r.state).filter(Boolean))].sort().map(s => [s, s]);
  const people = (users || []).map(u => [u.id, u.name]);
  const any = Object.entries(f).some(([k, v]) => k !== 'fy' && (Array.isArray(v) ? v.length : v));
  const moreSet = ['states', 'months', 'quarters', 'owners', 'checkers', 'priorities', 'statuses', 'flags'].filter(k => f[k].length).length;
  const [more, setMore] = useState(moreSet > 0);
  return (
    <div style={{ background: '#fff', border: '1px solid #E4E7EF', borderRadius: 12, padding: 14, marginBottom: 18, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }} role="search" aria-label="Filters">
      <Multi label="Company" options={ents} value={f.entity_ids} onChange={v => setFilters({ ...f, entity_ids: v, registration_ids: [] })} width={220} />
      <Multi label="Registration" options={regs} value={f.registration_ids} onChange={v => set('registration_ids', v)} width={210} />
      <Multi label="Category" options={(meta?.constants.categories || []).map(c => [c, c])} value={f.categories} onChange={v => set('categories', v)} width={170} />
      <div style={{ width: 200 }}><span style={S.label}>Search</span><Input value={f.search} onChange={e => set('search', e.target.value)} placeholder="Task, owner, acknowledgement…" aria-label="Search tasks" /></div>
      <div style={{ width: 120 }}><span style={S.label}>Financial year</span><Select value={f.fy} onChange={v => setFilters({ ...f, fy: v, months: [] })} options={fyOptions} placeholder="All years" aria-label="Financial year" /></div>
      <Btn kind="ghost" onClick={() => setMore(m => !m)} aria-expanded={more}>{more ? 'Fewer filters' : `More filters${moreSet ? ` (${moreSet})` : ''}`}</Btn>
      {any && <Btn kind="ghost" onClick={() => setFilters({ ...EMPTY_FILTERS, fy: f.fy })} style={{ color: C.lav }}>Clear filters</Btn>}
      {more && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', width: '100%', borderTop: '1px solid #EEF0F6', paddingTop: 12 }}>
      <Multi label="States" options={states} value={f.states} onChange={v => set('states', v)} width={110} />
      <Multi label="Months" options={fyMonths(f.fy)} value={f.months} onChange={v => set('months', v)} width={130} />
      <Multi label="Quarters" options={[['Q1', 'Q1 Apr–Jun'], ['Q2', 'Q2 Jul–Sep'], ['Q3', 'Q3 Oct–Dec'], ['Q4', 'Q4 Jan–Mar']]} value={f.quarters} onChange={v => set('quarters', v)} width={120} />
      <Multi label="Owner" options={[['__none__', 'Unassigned'], ...people]} value={f.owners} onChange={v => set('owners', v)} width={140} />
      <Multi label="Approver" options={[['__none__', 'Unassigned'], ...people]} value={f.checkers} onChange={v => set('checkers', v)} width={140} />
      <Multi label="Priority" options={[['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]} value={f.priorities} onChange={v => set('priorities', v)} width={110} />
      <Multi label="Status" options={Object.entries(meta?.constants.statuses || {})} value={f.statuses} onChange={v => set('statuses', v)} width={170} />
      <Multi label="Flags" options={FLAG_OPTS} value={f.flags} onChange={v => set('flags', v)} width={160} />
      </div>}
    </div>
  );
}
