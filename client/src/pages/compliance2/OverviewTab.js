import React, { useEffect, useState } from 'react';
import { api, errMsg } from './api';
import { C, S, Note, StatusBadge, Flags, Btn, dt, Empty } from './ui';
import { Hero, Panel, Badge, fyLabel } from './ui2';

// CFO overview (V5). Every figure is computed by the server from the tasks that pass the current filters. Workflow states
// (exclusive) and flags (overdue, evidence missing … can overlap) are reported separately. Completion is progress, not a
// statement of legal compliance; a category with no tasks is "not configured", never 100 %.

const GROUPS = [
  ['Indirect tax', ['GST']], ['Direct tax', ['Income Tax', 'TDS/TCS']], ['Company law', ['ROC/LLP']], ['Payroll & labour', ['Provident Fund', 'ESIC', 'Professional Tax', 'Labour & Payroll']],
  ['SEBI & FEMA', ['SEBI/Exchange', 'FEMA/RBI']], ['Other & controls', ['State & Licences', 'Notices & Litigation', 'Internal Controls']],
];
const QUEUE = [['open', 'Open'], ['overdue', 'Overdue'], ['due_soon', 'Due soon'], ['review', 'Review'], ['completed', 'Completed']];
const KPIS = [
  { id: 'all', label: 'Total obligations', color: '#202C45', get: o => o.totals.obligations, sub: () => 'Across current filters' },
  { id: 'completed', label: 'Completed', color: '#249D98', get: o => o.totals.completed, sub: o => (o.completion.denominator ? `${o.completion.pct}% of tracked obligations` : 'No obligations in this filter') },
  { id: 'overdue', label: 'Overdue', color: '#D85D70', get: o => o.totals.overdue, sub: () => 'Requires immediate attention' },
  { id: 'due_soon', label: `Due in 7 days`, color: '#C58C2B', get: o => o.totals.due_soon, sub: o => `${dt(o.as_of)} + ${o.soon_days} days, inclusive` },
  { id: 'review', label: 'Awaiting review', color: '#6554C5', get: o => o.totals.review, sub: () => 'Preparation or filing verification' },
];

export default function OverviewTab({ params, stamp, onOpenTask, onDrill, meta, demo, onGoto }) {
  const [ov, setOv] = useState(null);
  const [extra, setExtra] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('open');
  const [group, setGroup] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => {
    setOv(null); setDone(null);
    api.overview(params).then(setOv).catch(e => setErr(errMsg(e)));
    Promise.all([api.reportTasks(params).catch(() => null), api.updates({}).catch(() => null)]).then(([t, u]) => setExtra({ t, u }));
  }, [params, stamp]);
  useEffect(() => { if (q === 'completed' && !done) api.tasks({ ...params, statuses: 'completed' }).then(r => setDone(r.tasks)).catch(e => setErr(errMsg(e))); }, [q, done, params]);
  if (err) return <Note tone="error">{err}</Note>;
  if (!ov) return <Empty>Loading…</Empty>;
  const t = ov.totals;
  const cats = new Map(ov.categories.map(c => [c.category, c]));
  const groupCats = group ? GROUPS.find(g => g[0] === group)[1] : null;
  const base = q === 'completed' ? (done || []) : ov.queue_tasks;
  const queue = base.filter(x => (q === 'open' || q === 'completed' ? true : q === 'review' ? ['ready_for_review', 'filed_awaiting_verification'].includes(x.status) : x.flags.includes(q)) && (!groupCats || groupCats.includes(x.category)));
  const withTasks = ov.companies.filter(c => c.total > 0).length;
  const fy = params.fy || '';
  return (
    <div>
      <Hero eyebrow="EXECUTIVE OVERVIEW" title="Your compliance, at a glance." sub={`Group-wide visibility · ${t.obligations} tracked obligations · ${t.open} awaiting completion${t.internal_controls ? ` · ${t.internal_controls} internal controls counted separately` : ''}`}
        tag={`${fy ? fyLabel(fy) : 'All years'} · ${demo ? 'Demo snapshot' : 'Live'}`} tagSub={`${dt(ov.as_of)} / India`} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 18 }}>
        {KPIS.map(k => (
          <button key={k.id} type="button" onClick={() => { setQ(k.id === 'all' ? 'open' : k.id); setGroup(null); }} style={{ textAlign: 'left', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, fontSize: 12, color: '#738097', cursor: 'pointer', fontFamily: 'inherit' }}>
            <div>{k.label}</div>
            <div style={{ color: k.color, fontSize: 30, fontWeight: 800, letterSpacing: -1, margin: '8px 0' }}>{k.get(ov)}</div>
            <div>{k.sub(ov)}</div>
          </button>
        ))}
      </div>

      <div className="c2-three" style={{ display: 'grid', gap: 16, alignItems: 'start' }}>
        <Panel title="Completion health" right={<span style={S.small}>Task status</span>}>
          <Ring pct={ov.completion.denominator ? ov.completion.pct : null} />
          <div style={{ fontSize: 13, marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}><span><span style={{ color: '#7865D6' }}>●</span> Completed</span><b>{t.completed}</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span><span style={{ color: '#D9DCE8' }}>●</span> Open</span><b>{t.open}</b></div>
          </div>
          <p style={{ ...S.muted, marginTop: 12 }}>{ov.completion.denominator ? `${ov.completion.numerator} / ${ov.completion.denominator} tracked tasks.` : 'No tasks in this filter.'} This is completion progress, not a legal-compliance score. Filed on time: {ov.on_time.denominator ? `${ov.on_time.numerator} of ${ov.on_time.denominator} (${ov.on_time.pct}%)` : 'no filed tasks with a due date'}.</p>
          <div style={{ ...S.small, lineHeight: 1.6 }}>States (exclusive): {Object.entries(ov.states).filter(([, v]) => v).map(([k, v]) => `${meta.constants.statuses[k]} ${v}`).join(' · ') || '—'}<br />Flags (can overlap): {Object.entries(ov.flags).filter(([, v]) => v).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ') || 'none'}</div>
        </Panel>

        <Panel title="Compliance by category" right={<span style={S.small}>Completed / total</span>} note="Select a category to focus the action queue. Categories without tasks are not assumed compliant.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 10 }}>
            {GROUPS.map(([g, list]) => {
              const cs = list.map(c => cats.get(c)).filter(Boolean);
              const total = cs.reduce((a, c) => a + c.total, 0), completed = cs.reduce((a, c) => a + c.completed, 0), overdue = cs.reduce((a, c) => a + c.overdue, 0), nodate = cs.reduce((a, c) => a + c.no_due_date, 0);
              const on = group === g;
              return (
                <button key={g} type="button" aria-pressed={on} onClick={() => setGroup(on ? null : g)} style={{ textAlign: 'left', border: `1px solid ${on ? '#9A86E4' : '#E4E7EF'}`, background: on ? '#FAF8FF' : '#fff', borderRadius: 10, padding: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                  <b style={{ fontSize: 13, color: '#202C45' }}>{g}</b>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: total ? '#6554C5' : '#98A0B8', margin: '8px 0 6px' }}><span>{total ? `${total - completed} open` : 'Not configured'}</span><b>{completed} / {total}</b></div>
                  <div style={{ background: '#EEF0F6', borderRadius: 6, height: 5 }}><div style={{ width: `${total ? (completed / total) * 100 : 0}%`, height: 5, borderRadius: 6, background: '#7865D6' }} /></div>
                  <div style={{ fontSize: 11, color: '#8590A3', marginTop: 8 }}>{total ? `${overdue} overdue · ${nodate} missing dates` : 'No tasks within current filters'}</div>
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel title="Control checks" right={<span style={S.small}>Review flags</span>} note={`Flags may overlap. Sample documents do not count as real evidence. Updates are ${demo ? 'curated reference entries, not a live feed' : 'reviewed before they change anything'}.`}>
          {[['Filed / closed without real uploaded evidence', extra?.t ? extra.t.exceptions[0].count : '…', () => onGoto('reports', 'evidence')],
            ['Due-date rules awaiting confirmation', t.no_due_date + (ov.flags.rule_unverified || 0), () => onGoto('coverage')],
            ['Companies with tasks, group-wide', `${withTasks} / ${ov.companies.length}`, () => onGoto('masters')],
            [demo ? 'Curated updates unread by you' : 'Updates unread by you', extra?.u ? extra.u.counts.unread : '…', () => onGoto('updates')]].map(([l, v, go]) => (
            <button key={l} type="button" onClick={go} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '12px 0', border: 'none', borderBottom: '1px solid #EEF0F6', background: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontSize: 13, color: '#34415B' }}>
              <span>{l}</span><span style={{ background: '#F0EFFA', color: '#6554C5', borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12 }}>{v}</span>
            </button>
          ))}
        </Panel>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }} className="c2-two">
        <Panel title="Priority action queue" right={<><Btn small kind="ghost" onClick={() => onDrill({ ...(q === 'review' ? { flags: ['review'] } : q === 'completed' ? { statuses: ['completed'] } : q !== 'open' ? { flags: [q] } : { flags: ['open'] }), ...(groupCats ? { categories: groupCats } : {}) })}>Full register ↗</Btn>{group && <Btn small kind="ghost" onClick={() => setGroup(null)}>Clear category</Btn>}</>}
          note={`Showing ${Math.min(queue.length, 12)} of ${queue.length} matching tasks${group ? ` in ${group}` : ''}. Highest priority first; tasks without a due date appear last.`}>
          <div style={{ ...S.row, marginBottom: 10 }}>{QUEUE.map(([k, l]) => <button key={k} type="button" aria-pressed={q === k} onClick={() => setQ(k)} style={{ border: `1px solid ${q === k ? '#C9BFEE' : '#E4E7EF'}`, background: q === k ? '#EEEBFC' : '#fff', color: q === k ? '#5543B2' : '#485570', borderRadius: 7, padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>{l}</button>)}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Obligation / entity', 'Due date', 'Status', ''].map(h => <th key={h} style={{ ...S.th, background: '#F8F9FD' }}>{h}</th>)}</tr></thead>
            <tbody>
              {queue.length === 0 && <tr><td colSpan={4} style={{ ...S.td, textAlign: 'center', color: C.muted, padding: 20 }}>{q === 'completed' && !done ? 'Loading…' : 'Nothing in this selection.'}</td></tr>}
              {queue.slice(0, 12).map(x => (
                <tr key={x.id}>
                  <td style={{ ...S.td, padding: '12px 8px' }}><b style={{ fontWeight: 600 }}>{x.rule_name}{x.period_label ? ` · ${x.period_label}` : ''}</b><div style={S.small}>{x.scope_label}</div></td>
                  <td style={{ ...S.td, padding: '12px 8px', whiteSpace: 'nowrap' }}>{x.effective_due ? dt(x.effective_due) : <i style={{ color: C.faint }}>Not scheduled</i>}<div style={S.small}>{x.revised_due ? 'Revised date' : x.internal ? 'Internal target' : 'Statutory date'}</div></td>
                  <td style={{ ...S.td, padding: '12px 8px' }}>{x.overdue && <Badge tone="red">Overdue</Badge>}<StatusBadge status={x.status} label={x.status_label} /><div><Flags flags={x.flags} skip={['sample', 'overdue', 'rule_unverified']} /></div></td>
                  <td style={{ ...S.td, padding: '12px 8px' }}><Btn small kind="ghost" onClick={() => onOpenTask(x.id)}>Open ↗</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Company progress" right={<span style={S.small}>Filtered tasks</span>} note="Entities without tasks stay visible in Companies & GSTINs. Registration coverage = registrations with tasks ÷ active registrations.">
          {ov.companies.length === 0 && <span style={S.muted}>No companies in this filter.</span>}
          {ov.companies.map(c => (
            <div key={c.entity_id} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{c.name}</span><b>{c.completed}/{c.total}</b></div>
              <div style={{ background: '#EEF0F6', borderRadius: 6, height: 5, margin: '6px 0' }}><div style={{ width: `${c.total ? (c.completed / c.total) * 100 : 0}%`, height: 5, borderRadius: 6, background: '#249D98' }} /></div>
              <div style={{ fontSize: 11, color: '#8590A3' }}>{c.overdue} overdue · {c.no_due_date} missing dates · {c.missing_evidence} missing evidence · registrations {c.registrations.denominator ? `${c.registrations.numerator}/${c.registrations.denominator}` : '—'}{c.data_status !== 'approved' ? ` · ${c.data_status === 'illustrative' ? 'illustrative' : 'master data not approved'}` : ''}</div>
            </div>
          ))}
          <div style={{ ...S.row, borderTop: '1px solid #EEF0F6', paddingTop: 12 }}>
            <Btn small kind="ghost" onClick={() => onGoto('tds')}>TDS deposits ↗</Btn><Btn small kind="ghost" onClick={() => onGoto('folders')}>Document folders ↗</Btn><Btn small kind="ghost" onClick={() => onGoto('coverage')}>Coverage &amp; rules ↗</Btn><Btn small kind="ghost" onClick={() => onGoto('reports')}>Reports ↗</Btn>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Ring({ pct }) {
  const size = 150, r = 60, c = 2 * Math.PI * r;
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={pct === null ? 'No tasks' : `${pct}% completed`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EEF0F6" strokeWidth="14" />
        {pct !== null && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#7865D6" strokeWidth="14" strokeDasharray={`${(c * pct) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
        <text x="50%" y="50%" textAnchor="middle" fontSize="26" fontWeight="800" fill="#202C45">{pct === null ? '—' : `${Math.round(pct)}%`}</text>
        <text x="50%" y="63%" textAnchor="middle" fontSize="9" fill="#8590A3" letterSpacing="1">COMPLETED</text>
      </svg>
    </div>
  );
}
