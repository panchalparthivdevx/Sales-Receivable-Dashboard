import React, { useEffect, useMemo, useState } from 'react';
import { api, errMsg, download } from './api';
import { C, S, Section, Note, Btn, StatusBadge, Flags, Table, Tabs, Empty, dt } from './ui';

// Compliance register: every task that passes the filters, with exports (the exports use exactly the same filters).
const VIEWS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'statutory', label: 'Statutory', test: t => !t.internal },
  { id: 'internal', label: 'Internal controls', test: t => t.internal },
  { id: 'notices', label: 'Notices', test: t => t.nature === 'notice' },
  { id: 'renewals', label: 'Renewals', test: t => t.nature === 'renewal' },
  { id: 'revisions', label: 'Revisions', test: t => t.filing_version > 1 },
];
const SORTS = { due: (a, b) => String(a.effective_due || '9999').localeCompare(String(b.effective_due || '9999')), period: (a, b) => a.period_start.localeCompare(b.period_start), status: (a, b) => a.status.localeCompare(b.status), obligation: (a, b) => a.rule_name.localeCompare(b.rule_name) };

export default function RegisterTab({ params, stamp, onOpenTask, initialView }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState(initialView || 'all');
  const [sort, setSort] = useState('due');
  const [busy, setBusy] = useState('');
  useEffect(() => { setRows(null); api.tasks({ ...params, revisions: 'include' }).then(r => setRows(r.tasks)).catch(e => setErr(errMsg(e))); }, [params, stamp]);
  useEffect(() => { if (initialView) setView(initialView); }, [initialView]);
  const list = useMemo(() => (rows || []).filter(VIEWS.find(v => v.id === view).test).sort(SORTS[sort]), [rows, view, sort]);
  const exp = (path, name, extra = {}) => { setBusy(name); setErr(''); download(path, { ...params, ...extra }, name).catch(e => setErr(errMsg(e))).finally(() => setBusy('')); };
  if (!rows && !err) return <Empty>Loading…</Empty>;
  return (
    <div>
      {err && <Note tone="error">{err}</Note>}
      <Section title={`Compliance register — ${list.length} task(s)`} sub="Exports use the same filters and carry the dataset, filters and time they were made" right={<>
        <Btn kind="onNavy" small disabled={!!busy} onClick={() => exp('/export/register.xlsx', 'register.xlsx')}>Excel</Btn>
        <Btn kind="onNavy" small disabled={!!busy} onClick={() => exp('/export/register.csv', 'register.csv')}>CSV</Btn>
        <Btn kind="onNavy" small disabled={!!busy} onClick={() => exp('/export/exceptions.csv', 'exceptions.csv')}>Exception log</Btn>
        <Btn kind="onNavy" small disabled={!!busy} onClick={() => exp('/export/audit.zip', 'audit_pack.zip')}>Audit pack (ZIP)</Btn>
        {busy && <span style={{ fontSize: '0.75rem' }}>Preparing {busy}…</span>}
      </>} flush>
        <div style={{ padding: '0.75rem 1rem 0', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Tabs tabs={VIEWS.map(v => ({ id: v.id, label: v.label, count: (rows || []).filter(v.test).length }))} value={view} onChange={setView} />
          <label style={{ ...S.muted, display: 'flex', gap: 6, alignItems: 'center' }}>Sort
            <select value={sort} onChange={e => setSort(e.target.value)} style={{ ...S.input, width: 140 }}>
              <option value="due">Due date</option><option value="period">Period</option><option value="obligation">Obligation</option><option value="status">Status</option>
            </select></label>
        </div>
        <Table rows={list.slice(0, 1500)} onRow={r => onOpenTask(r.id)} maxHeight={640} empty="No tasks match. Tasks are created in Coverage → Generate tasks once applicability is decided (and, for live, rules are verified and approved)."
          cols={[
            { label: 'Due', render: r => (r.effective_due ? <><span className="c2-nowrap" style={{ color: r.overdue ? C.red : C.text, fontWeight: r.overdue ? 700 : 400 }}>{dt(r.effective_due)}</span>{r.revised_due && <div style={S.small}>orig. {dt(r.original_due)}</div>}</> : <i style={{ color: C.faint }} title={r.due_pending}>no date</i>) },
            { label: 'Internal target', render: r => (r.internal_target ? <span className="c2-nowrap">{dt(r.internal_target)}</span> : '—'), hideSm: true },
            { label: 'Obligation', render: r => <><b>{r.rule_name}</b>{r.filing_version > 1 && <span style={{ ...S.small, color: C.lav }}> · version {r.filing_version}</span>}<div style={S.small}>{r.category} · {r.form || r.rule_id}</div></> },
            { label: 'Period', render: r => r.period_label },
            { label: 'Scope', render: r => r.scope_label, hideSm: true },
            { label: 'Status', render: r => <StatusBadge status={r.status} label={r.status_label} /> },
            { label: 'Flags', render: r => <Flags flags={r.flags} />, hideSm: true },
            { label: 'Owner / reviewer', render: r => <>{r.owner_name || <i style={{ color: C.faint }}>—</i>}<div style={S.small}>{r.checker_name || ''}</div></>, hideSm: true },
            { label: 'Evidence', render: r => (r.evidence.required.length ? `${r.evidence.required.length - r.evidence.missing.length}/${r.evidence.required.length}` : '—'), hideSm: true },
          ]} />
        {list.length > 1500 && <div style={{ ...S.small, padding: 8 }}>Showing the first 1,500 — narrow the filters or export to see all {list.length}.</div>}
      </Section>
    </div>
  );
}
