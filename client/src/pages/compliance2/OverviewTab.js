import React, { useEffect, useState } from 'react';
import { api, errMsg } from './api';
import { C, S, Section, Kpi, Donut, StackBar, Note, Table, StatusBadge, Flags, Btn, dt, ratioText, inr, Empty } from './ui';

// CFO overview. Every figure is computed by the server from the tasks that pass the current filters. Workflow states (each
// task is in exactly one) and flags (overdue, evidence missing … can overlap) are shown separately. Completion says nothing
// about legal compliance or timeliness: those have their own measures, each with its numerator and denominator.

const METRICS = [
  { id: 'overdue', label: 'Overdue', tone: 'red', flags: ['overdue'], get: o => o.totals.overdue, sub: 'not filed and past the effective statutory date' },
  { id: 'due_soon', label: 'Due soon', tone: 'amber', flags: ['due_soon'], get: o => o.totals.due_soon, sub: o => `next ${o.soon_days} days, not filed` },
  { id: 'review', label: 'Review queue', tone: 'lav', flags: ['review'], get: o => o.totals.review, sub: 'ready for review + filed awaiting verification' },
  { id: 'evidence', label: 'Missing evidence', tone: 'red', flags: ['evidence_missing'], get: o => o.totals.missing_evidence, sub: 'filed / closed without mandatory documents' },
  { id: 'no_due', label: 'No due date', tone: 'amber', flags: ['no_due_date'], get: o => o.totals.no_due_date, sub: 'rule, state rule or event date missing — never counted overdue' },
  { id: 'completed', label: 'Completed', tone: 'green', statuses: ['completed'], get: o => o.totals.completed, sub: 'verified and closed' },
];

export default function OverviewTab({ params, stamp, onOpenTask, onDrill, meta, demo }) {
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);
  const [cat, setCat] = useState(null);
  useEffect(() => { setOv(null); api.overview(params).then(setOv).catch(e => setErr(errMsg(e))); }, [params, stamp]);
  if (err) return <Note tone="error">{err}</Note>;
  if (!ov) return <Empty>Loading…</Empty>;

  const metric = METRICS.find(m => m.id === sel);
  const queue = ov.queue_tasks.filter(t => (!metric || (metric.flags ? metric.flags.every(f => (f === 'review' ? ['ready_for_review', 'filed_awaiting_verification'].includes(t.status) : t.flags.includes(f))) : metric.statuses.includes(t.status))) && (!cat || t.category === cat));
  const t = ov.totals;
  return (
    <div>
      {demo && <Note tone="demo"><b>DEMO snapshot as of {dt(ov.snapshot)}</b> — illustrative entities and sample filings. Sample evidence is not a verified real document and sample amounts are not real payments.</Note>}
      {/* executive summary */}
      <div style={{ background: `linear-gradient(120deg, ${C.navy} 0%, ${C.navy2} 100%)`, color: '#fff', borderRadius: 16, padding: '1.1rem 1.3rem', marginBottom: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 240 }}>
          <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.75 }}>As of {dt(ov.as_of)} {demo ? '(demo snapshot)' : '(Asia/Kolkata)'}</div>
          <div style={{ fontSize: '1.9rem', fontWeight: 800, marginTop: 4 }}>{t.obligations} <span style={{ fontSize: '0.95rem', fontWeight: 600, opacity: 0.85 }}>statutory obligations in this filter</span></div>
          <div style={{ fontSize: '0.8rem', opacity: 0.85, marginTop: 4 }}>{t.open} open · {t.filed} filed · {t.internal_controls} internal controls counted separately{t.revisions_in_progress ? ` · ${t.revisions_in_progress} revision(s) in progress` : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: '1.6rem', flexWrap: 'wrap' }}>
          {[['Completion', ov.completion], ['Filed on time', ov.on_time], ['Review completion', ov.review_completion]].map(([l, r]) => (
            <div key={l} title={r.note}><div style={{ fontSize: '0.7rem', opacity: 0.75, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{l}</div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800 }}>{r.denominator ? `${r.pct}%` : '—'}</div>
              <div style={{ fontSize: '0.72rem', opacity: 0.8 }}>{r.denominator ? `${r.numerator} of ${r.denominator}` : 'no records'}</div></div>
          ))}
        </div>
      </div>

      <div style={{ ...S.grid(165), marginBottom: '1rem' }}>
        {METRICS.map(m => <Kpi key={m.id} label={m.label} value={m.get(ov)} tone={m.tone} sub={typeof m.sub === 'function' ? m.sub(ov) : m.sub} active={sel === m.id} onClick={() => setSel(sel === m.id ? null : m.id)} />)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem' }}>
        <Section title="Completion" sub="Completed ÷ statutory obligations in the filter — not a statement of legal compliance">
          <Donut numerator={ov.completion.numerator} denominator={ov.completion.denominator} label={ov.completion.note} />
          <div style={{ marginTop: 12, ...S.muted }}>
            <div><b>Filed on time:</b> {ratioText(ov.on_time)} — {ov.on_time.note}</div>
            <div><b>Review completion:</b> {ratioText(ov.review_completion)}</div>
            <div><b>Internal controls:</b> {ov.internal.total ? `${ov.internal.completed} of ${ov.internal.total} done, ${ov.internal.overdue} overdue` : 'none in this filter'}</div>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={S.label}>Workflow state (exclusive)</div>
            <StackBar parts={[['not_started', '#98A2B3'], ['in_progress', C.blue], ['ready_for_review', C.amber], ['changes_requested', '#C4320A'], ['approved_to_file', C.lav], ['filed_awaiting_verification', C.teal], ['completed', C.green]].map(([k, color]) => ({ value: ov.states[k], color, label: meta.constants.statuses[k] }))} />
            <div style={{ ...S.small, marginTop: 6, lineHeight: 1.6 }}>{Object.entries(ov.states).filter(([, v]) => v).map(([k, v]) => `${meta.constants.statuses[k]} ${v}`).join(' · ') || 'no tasks'}</div>
            <div style={{ ...S.label, marginTop: 10 }}>Flags (can overlap)</div>
            <div style={{ ...S.small, lineHeight: 1.6 }}>{Object.entries(ov.flags).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')}</div>
          </div>
        </Section>

        <Section title="By category" sub="Click a category to narrow the action list. No tasks = not configured (never 100%).">
          {ov.categories.map(c => (
            <button key={c.category} type="button" onClick={() => setCat(cat === c.category ? null : c.category)} aria-pressed={cat === c.category}
              style={{ display: 'block', width: '100%', textAlign: 'left', border: `1px solid ${cat === c.category ? C.lav : 'transparent'}`, background: cat === c.category ? C.lavSoft : 'transparent', borderRadius: 10, padding: '6px 8px', marginBottom: 4, cursor: 'pointer', fontFamily: 'inherit' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: 4 }}>
                <b style={{ color: C.text }}>{c.category}{c.internal_only ? ' (internal)' : ''}</b>
                <span style={{ color: c.configured ? C.muted : C.faint }}>{c.configured ? `${c.completed}/${c.total} · ${c.overdue} overdue` : 'Not configured'}</span>
              </div>
              {c.configured && <StackBar total={c.total} parts={[{ value: c.completed, color: C.green, label: 'completed' }, { value: c.overdue, color: C.red, label: 'overdue' }, { value: c.due_soon, color: C.amber, label: 'due soon' }]} />}
            </button>
          ))}
        </Section>
      </div>

      <Section title="Action queue" sub={`${metric ? metric.label : 'Highest priority first'}${cat ? ` · ${cat}` : ''} — ${queue.length} task(s)`} right={<>
        {(sel || cat) && <Btn kind="onNavy" small onClick={() => { setSel(null); setCat(null); }}>Clear selection</Btn>}
        <Btn kind="onNavy" small onClick={() => onDrill({ ...(metric?.flags ? { flags: metric.flags } : {}), ...(metric?.statuses ? { statuses: metric.statuses } : {}), ...(cat ? { categories: [cat] } : {}) })}>Open in register</Btn>
      </>} flush>
        <Table rows={queue} onRow={r => onOpenTask(r.id)} maxHeight={420} empty="Nothing needs action in this selection"
          cols={[
            { label: 'Due', render: r => (r.effective_due ? <span className="c2-nowrap" style={{ color: r.overdue ? C.red : C.text, fontWeight: r.overdue ? 700 : 400 }}>{dt(r.effective_due)}{r.overdue ? ` (+${r.days_overdue}d)` : ''}</span> : <i style={{ color: C.faint }}>no date</i>) },
            { label: 'Obligation', render: r => <><b>{r.rule_name}</b><div style={S.small}>{r.period_label}</div></> },
            { label: 'Scope', render: r => r.scope_label, hideSm: true },
            { label: 'Status', render: r => <StatusBadge status={r.status} label={r.status_label} /> },
            { label: 'Flags', render: r => <Flags flags={r.flags} skip={['sample', 'rule_unverified']} />, hideSm: true },
            { label: 'Owner', render: r => r.owner_name || <i style={{ color: C.faint }}>unassigned</i>, hideSm: true },
          ]} />
      </Section>

      <Section title="Company health" sub="Per entity in the filter; registration coverage = registrations that have tasks ÷ active registrations" flush>
        <Table rows={ov.companies} rowKey={r => r.entity_id} empty="No entities in this filter"
          cols={[
            { label: 'Entity', render: r => <><b>{r.short_code}</b> {r.name}{r.data_status !== 'approved' && <div style={S.small}>{r.data_status === 'illustrative' ? 'illustrative (demo)' : 'master data not approved'}</div>}</> },
            { label: 'Obligations', num: true, render: r => r.total },
            { label: 'Completed', num: true, render: r => (r.completion ? `${r.completed} (${r.completion.pct}%)` : '—') },
            { label: 'Overdue', num: true, render: r => <span style={{ color: r.overdue ? C.red : C.text }}>{r.overdue}</span> },
            { label: 'Due soon', num: true, render: r => r.due_soon },
            { label: 'Missing evidence', num: true, render: r => r.missing_evidence, hideSm: true },
            { label: 'No due date', num: true, render: r => r.no_due_date, hideSm: true },
            { label: 'Registrations covered', num: true, render: r => (r.registrations.denominator ? `${r.registrations.numerator}/${r.registrations.denominator}` : '—'), hideSm: true },
          ]} />
      </Section>

      <Section title="Payments recorded" sub={ov.payments.note}>
        {ov.payments.count ? (
          <div style={S.row}>{Object.entries(ov.payments.by_category).map(([k, v]) => <div key={k} style={{ ...S.card, padding: '0.6rem 0.8rem', marginBottom: 0 }}><div style={S.label}>{k}</div><b>{inr(v)}</b></div>)}
            <div style={S.muted}>Total {inr(ov.payments.total)} from {ov.payments.count} filing record(s).</div></div>
        ) : <div style={S.muted}>No payment recorded on filing records in this filter.</div>}
        <div style={{ ...S.small, marginTop: 8 }}>Unpaid liabilities, interest exposure and cash forecasts need liability data and are not available in this phase.</div>
      </Section>
    </div>
  );
}
