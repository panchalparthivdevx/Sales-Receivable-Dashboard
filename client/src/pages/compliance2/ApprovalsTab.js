import React, { useEffect, useState } from 'react';
import { api, errMsg } from './api';
import { C, S, Section, Note, Btn, Table, StatusBadge, Tag, Empty, dt } from './ui';

// Everything waiting for a second person: filing packs to review, filings to verify, evidence exceptions, rule versions to
// approve, extensions to approve and master data to approve.
export default function ApprovalsTab({ params, stamp, onOpenTask, meta, onGoto }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setData(null);
    Promise.all([api.tasks({ ...params, flags: ['open'] }), api.rules(), api.org()])
      .then(([t, r, o]) => setData({ tasks: t.tasks, rules: r, org: o })).catch(e => setErr(errMsg(e)));
  }, [params, stamp]);
  if (err) return <Note tone="error">{err}</Note>;
  if (!data) return <Empty>Loading…</Empty>;
  const me = meta.actor.id;
  const review = data.tasks.filter(t => t.status === 'ready_for_review');
  const verify = data.tasks.filter(t => t.status === 'filed_awaiting_verification');
  const exceptions = data.tasks.filter(t => t.exception?.status === 'requested');
  const versions = data.rules.rules.flatMap(r => r.versions.filter(v => v.status === 'verified').map(v => ({ ...v, rule: r })));
  const exts = (data.rules.extensions || []).filter(x => x.status === 'draft');
  const masters = [...data.org.entities.map(e => ({ kind: 'entity', id: e.id, label: `${e.short_code} — ${e.legal_name}`, status: e.data_status, note: e.approval_note })),
    ...data.org.registrations.map(r => ({ kind: 'registration', id: r.id, label: `${r.type} ${r.number}${r.state ? ` (${r.state})` : ''}`, status: r.data_status, note: r.approval_note }))].filter(x => x.status === 'draft');
  const mine = t => (t.workflow?.prepared_by_id === me ? <Tag tone="amber">you prepared it</Tag> : t.workflow?.filed_by_id === me ? <Tag tone="amber">you filed it</Tag> : null);
  const taskCols = [
    { label: 'Due', render: r => (r.effective_due ? <span style={{ color: r.overdue ? C.red : C.text }}>{dt(r.effective_due)}</span> : '—') },
    { label: 'Obligation', render: r => <><b>{r.rule_name}</b><div style={S.small}>{r.period_label} · {r.scope_label}</div></> },
    { label: 'Status', render: r => <StatusBadge status={r.status} label={r.status_label} /> },
    { label: 'Prepared / filed by', render: r => <>{r.workflow?.prepared_by || '—'}{r.workflow?.filed_by ? ` / ${r.workflow.filed_by}` : ''} {mine(r)}</> },
  ];
  return (
    <div>
      <Note tone="info">A person cannot approve, verify or decide something they prepared, filed, verified or asked for themselves — the server refuses it.</Note>
      <Section title={`Filing packs to review (${review.length})`} sub="Approver (not the Initiator who prepared it): approve to file or request changes" flush><Table rows={review} cols={taskCols} onRow={r => onOpenTask(r.id)} empty="Nothing waiting for review" /></Section>
      <Section title={`Filings to verify and close (${verify.length})`} sub="Approver (not the one who prepared or filed it): check the acknowledgement and the mandatory evidence, then close" flush>
        <Table rows={verify} onRow={r => onOpenTask(r.id)} empty="Nothing waiting for verification" cols={[...taskCols, { label: 'Evidence missing', render: r => r.evidence.missing.join(', ') || '—' }]} /></Section>
      <Section title={`Missing-evidence exceptions (${exceptions.length})`} sub="Approver (not the one who asked): decide with a note" flush>
        <Table rows={exceptions} onRow={r => onOpenTask(r.id)} empty="No exception requests" cols={[...taskCols.slice(0, 2), { label: 'Reason', render: r => r.exception.reason }, { label: 'Asked by', render: r => r.exception.requested_by }]} /></Section>
      <Section title={`Rule versions to approve (${versions.length})`} sub="Verified against a source; a second person approves after the impact preview" right={<Btn kind="onNavy" small onClick={() => onGoto('rules')}>Open rules</Btn>} flush>
        <Table rows={versions} rowKey={v => `${v.rule.id}@${v.version}`} onRow={() => onGoto('rules')} empty="No verified versions waiting"
          cols={[{ label: 'Rule', render: v => <><b>{v.rule.id}</b> v{v.version}<div style={S.small}>{v.rule.name}</div></> }, { label: 'Effective', render: v => `${dt(v.effective_from)} → ${v.effective_to ? dt(v.effective_to) : 'open'}` }, { label: 'Verified by', render: v => <>{v.verified_by}{v.verified_by_id === me && <Tag tone="amber">you</Tag>}</> }, { label: 'Source', render: v => v.notification_no || 'standing provision' }]} /></Section>
      <Section title={`Extensions / fee waivers to approve (${exts.length})`} right={<Btn kind="onNavy" small onClick={() => onGoto('rules')}>Open rules</Btn>} flush>
        <Table rows={exts} onRow={() => onGoto('rules')} empty="No drafts" cols={[{ label: 'Kind', render: x => (x.kind === 'fee_waiver' ? 'Fee waiver' : 'Deadline extension') }, { label: 'Rule', key: 'rule_id' }, { label: 'Periods', render: x => x.period_keys.join(', ') }, { label: 'New date', render: x => (x.new_due_date ? dt(x.new_due_date) : '—') }, { label: 'Recorded by', key: 'created_by' }]} /></Section>
      <Section title={`Master data to approve (${masters.length})`} sub="Live tasks are generated only for approved entities and registrations" right={<Btn kind="onNavy" small onClick={() => onGoto('masters')}>Open masters</Btn>} flush>
        <Table rows={masters} onRow={() => onGoto('masters')} empty="Nothing waiting" cols={[{ label: 'Kind', key: 'kind' }, { label: 'Record', key: 'label' }, { label: 'Note', render: x => x.note || '' }]} /></Section>
    </div>
  );
}
