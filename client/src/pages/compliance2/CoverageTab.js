import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errMsg, download } from './api';
import { C, S, Section, Note, Btn, Table, Tag, Kpi, Modal, Field, Select, Input, Area, Empty } from './ui';

// Coverage: one row per obligation × scope that can apply. Applicability is decided by a person (Applicable / Not applicable /
// Needs review, with a reason); an automatic suggestion only helps. Unknown is never "not applicable". Tasks are generated
// from here — the preview shows what would be created and what is blocked, and why, before anything is saved.

const DEC_TONE = { applicable: 'green', not_applicable: 'grey', needs_review: 'amber' };

function DecideModal({ row, meta, fy, onClose, onDone }) {
  const [f, setF] = useState({ status: row.decision?.status || (row.suggestion.status !== 'needs_review' ? row.suggestion.status : 'needs_review'), reason: '', evidence: '', effective_from: `${fy.slice(0, 4)}-04-01`, effective_to: '' });
  const [err, setErr] = useState('');
  const save = () => api.decide({ rule_id: row.rule_id, scope_type: row.scope_type === 'registration' || row.scope_type === 'establishment' || row.scope_type === 'person' ? row.scope_type : 'entity', scope_id: row.scope_type === 'entity' ? row.entity_id : row.scope_id, ...f, effective_to: f.effective_to || null })
    .then(onDone).catch(e => setErr(errMsg(e)));
  return (
    <Modal title={`Applicability — ${row.rule_name}`} onClose={onClose}>
      {err && <Note tone="error">{err}</Note>}
      <div style={{ ...S.muted, marginBottom: 8 }}>{row.scope_label}</div>
      <Note tone="info">Suggestion: <b>{meta.constants.applicability[row.suggestion.status]}</b>. {row.suggestion.trace.join('; ')}{row.suggestion.missing.length ? ` — not recorded: ${row.suggestion.missing.join(', ')}` : ''}</Note>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Decision"><Select value={f.status} onChange={v => setF({ ...f, status: v })} options={Object.entries(meta.constants.applicability)} /></Field>
        <div />
        <Field label="Effective from"><Input type="date" value={f.effective_from} onChange={e => setF({ ...f, effective_from: e.target.value })} /></Field>
        <Field label="Effective to (optional)"><Input type="date" value={f.effective_to} onChange={e => setF({ ...f, effective_to: e.target.value })} /></Field>
        <Field label="Reason (required)" style={{ gridColumn: '1 / -1' }}><Area value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} placeholder="Why it applies / does not apply / is still open" /></Field>
        <Field label="Evidence (reference or note)" style={{ gridColumn: '1 / -1' }}><Input value={f.evidence} onChange={e => setF({ ...f, evidence: e.target.value })} placeholder="e.g. registration certificate, turnover statement, board minute" /></Field>
      </div>
      <div style={{ ...S.row, justifyContent: 'flex-end', marginTop: 12 }}><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={save}>Record decision</Btn></div>
    </Modal>
  );
}

export default function CoverageTab({ meta, org, defaultFy, stamp, onChanged }) {
  const [fy, setFy] = useState(defaultFy);
  const [cov, setCov] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState({ gap: '', category: '', entity: '', search: '', decision: '' });
  const [decide, setDecide] = useState(null);
  const [gen, setGen] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setCov(null); api.coverage({ fy }).then(setCov).catch(e => setErr(errMsg(e))); }, [fy]);
  useEffect(() => { load(); }, [load, stamp]);
  const rows = useMemo(() => (cov?.rows || []).filter(r => (!q.gap || (q.gap === 'covered' ? !r.gaps.length : r.gaps.includes(q.gap))) && (!q.category || r.category === q.category) && (!q.entity || r.entity_id === q.entity)
    && (!q.decision || (q.decision === 'none' ? !r.decision : r.decision?.status === q.decision)) && (!q.search || `${r.rule_id} ${r.rule_name} ${r.scope_label}`.toLowerCase().includes(q.search.toLowerCase()))), [cov, q]);
  const r = meta.actor.rights;
  const fys = (() => { const y = parseInt(defaultFy.slice(0, 4), 10); return [y - 1, y, y + 1].map(s => `${s}-${String((s + 1) % 100).padStart(2, '0')}`); })();
  const acceptable = rows.filter(x => !x.decision && x.suggestion.status !== 'needs_review');
  const accept = async () => {
    setBusy(true); setErr('');
    try { const res = await api.accept({ fy, items: acceptable.map(x => ({ rule_id: x.rule_id, scope_id: x.scope_type === 'entity' ? x.entity_id : x.scope_id })) }); setMsg(`${res.accepted} decision(s) recorded from the rule tests; ${res.skipped.length} left for a person.`); load(); onChanged(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const generate = async commit => {
    setBusy(true); setErr('');
    try { const res = await api.generate({ fy, entity_ids: q.entity ? [q.entity] : [], commit }); setGen(res); if (commit) { setMsg(`${res.created} task(s) created for FY ${fy}; ${res.existing} already existed (never duplicated).`); onChanged(); load(); } }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  if (!cov) return err ? <Note tone="error">{err}</Note> : <Empty>Loading…</Empty>;
  const s = cov.summary;
  return (
    <div>
      {err && <Note tone="error">{err}</Note>}
      {msg && <Note tone="ok">{msg}</Note>}
      <div style={{ ...S.row, marginBottom: 12 }}>
        <div style={{ width: 130 }}><span style={S.label}>Financial year</span><Select value={fy} onChange={setFy} options={fys} /></div>
        <Btn kind="ghost" onClick={() => download('/export/coverage.csv', { fy }, 'coverage.csv').catch(e => setErr(errMsg(e)))} style={{ marginTop: 16 }}>Export coverage CSV</Btn>
      </div>
      <div style={{ ...S.grid(150), marginBottom: '1rem' }}>
        <Kpi label="Obligation × scope rows" value={s.rows} />
        <Kpi label="Covered" value={s.covered} tone="green" sub="decided; and if applicable, scheduled" />
        <Kpi label="Not decided" value={s.by_decision.not_decided} tone="amber" onClick={() => setQ({ ...q, decision: 'none', gap: '' })} active={q.decision === 'none'} />
        <Kpi label="Needs review" value={s.by_decision.needs_review} tone="amber" onClick={() => setQ({ ...q, decision: 'needs_review', gap: '' })} active={q.decision === 'needs_review'} />
        <Kpi label="Rule not approved" value={s.by_gap.RULE_UNVERIFIED} tone="red" sub={cov.live ? 'blocked from live scheduling' : 'demo uses drafts'} onClick={() => setQ({ ...q, gap: 'RULE_UNVERIFIED', decision: '' })} active={q.gap === 'RULE_UNVERIFIED'} />
        <Kpi label="Missing-rule queue" value={cov.missing_rules.length} tone="red" sub="no date can be computed" />
      </div>

      {r.master && (
        <Section title="Generate tasks" sub={`FY ${fy}${q.entity ? ' · selected entity only' : ' · all entities you can see'}. Only decided-applicable obligations get tasks; ${cov.live ? 'live: only verified and approved rule versions, approved master data' : 'demo: unverified rules allowed, tasks marked "rule unverified"'}. Re-running never duplicates.`}
          right={<><Btn kind="onNavy" small disabled={busy} onClick={() => generate(false)}>Preview</Btn>{gen?.preview && <Btn kind="onNavy" small disabled={busy || !gen.created} onClick={() => generate(true)}>Create {gen.created} task(s)</Btn>}</>}>
          {gen ? (
            <div style={{ fontSize: '0.8rem' }}>
              <b>{gen.preview ? 'Would create' : 'Created'} {gen.created}</b> · already existing {gen.existing} · not applicable {gen.not_applicable} · blocked {gen.blocked}
              {gen.blocked > 0 && <div style={{ marginTop: 6 }}>{Object.entries(gen.blocked_by_code).map(([k, v]) => <Tag key={k} tone="amber">{(cov.gap_labels[k] || k.replace(/_/g, ' '))}: {v}</Tag>)}</div>}
              {gen.blocked_rows?.length > 0 && <details style={{ marginTop: 6 }}><summary style={{ cursor: 'pointer', ...S.small }}>What is blocked and why</summary>
                {gen.blocked_rows.slice(0, 200).map((b, i) => <div key={i} style={{ ...S.small, padding: '2px 0' }}>{b.rule_id} · {b.scope_label}{b.period_label ? ` · ${b.period_label}` : ''} — {b.reason}</div>)}</details>}
            </div>
          ) : <div style={S.muted}>Preview first: nothing is created until you confirm.</div>}
        </Section>
      )}

      <Section title={`Coverage — ${rows.length} row(s)`} sub="Click a row to record a decision (with reason and effective dates)" right={r.rules && acceptable.length > 0 && <Btn kind="onNavy" small disabled={busy} onClick={accept} title="Only rows whose recorded facts decide the answer">Accept {acceptable.length} suggestion(s)</Btn>} flush>
        <div style={{ padding: '0.75rem 1rem', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ width: 230 }}><span style={S.label}>Gap</span><Select value={q.gap} onChange={v => setQ({ ...q, gap: v })} options={[['covered', 'Covered (no gap)'], ...Object.entries(cov.gap_labels)]} placeholder="All rows" /></div>
          <div style={{ width: 160 }}><span style={S.label}>Decision</span><Select value={q.decision} onChange={v => setQ({ ...q, decision: v })} options={[['none', 'Not decided'], ...Object.entries(meta.constants.applicability)]} placeholder="Any" /></div>
          <div style={{ width: 170 }}><span style={S.label}>Category</span><Select value={q.category} onChange={v => setQ({ ...q, category: v })} options={cov.categories} placeholder="All" /></div>
          <div style={{ width: 200 }}><span style={S.label}>Entity</span><Select value={q.entity} onChange={v => setQ({ ...q, entity: v })} options={(org?.entities || []).map(e => [e.id, `${e.short_code} — ${e.legal_name}`])} placeholder="All" /></div>
          <div style={{ width: 200 }}><span style={S.label}>Search</span><Input value={q.search} onChange={e => setQ({ ...q, search: e.target.value })} placeholder="Rule, GSTIN, entity" /></div>
        </div>
        <Table rows={rows.slice(0, 800)} rowKey={x => `${x.rule_id}|${x.scope_id}`} onRow={r.rules ? x => setDecide(x) : undefined} maxHeight={620} empty="No rows in this selection"
          cols={[
            { label: 'Obligation', render: x => <><b>{x.rule_name}</b><div style={S.small}>{x.rule_id} · {x.category} · {x.reference?.due_text} ({x.reference?.status})</div></> },
            { label: 'Scope', render: x => x.scope_label },
            { label: 'Decision', render: x => (x.decision ? <><Tag tone={DEC_TONE[x.decision.status]}>{meta.constants.applicability[x.decision.status]}</Tag><div style={S.small}>{x.decision.reviewer}</div></> : <Tag tone="amber">Not decided</Tag>) },
            { label: 'Suggestion', render: x => <span title={x.suggestion.trace.join('\n')}><Tag tone={DEC_TONE[x.suggestion.status]}>{meta.constants.applicability[x.suggestion.status]}</Tag>{x.suggestion.missing.length > 0 && <div style={S.small}>missing: {x.suggestion.missing.join(', ')}</div>}</span>, hideSm: true },
            { label: 'Rule', render: x => <Tag tone={x.rule_state === 'approved' ? 'green' : 'amber'}>{x.rule_state}</Tag>, hideSm: true },
            { label: 'Due rule', render: x => <span style={{ fontSize: '0.74rem', color: ['NO_DUE_RULE', 'STATE_RULE_MISSING'].includes(x.due_state.code) ? C.red : C.muted }}>{x.due_state.text}</span>, hideSm: true },
            { label: 'Tasks', num: true, render: x => x.tasks },
            { label: 'Gaps', render: x => (x.gaps.length ? x.gaps.map(g => <Tag key={g} tone="red">{cov.gap_labels[g]}</Tag>) : <Tag tone="green">covered</Tag>) },
          ]} />
      </Section>

      <Section title={`Missing-rule queue (${cov.missing_rules.length})`} sub="Applies (or may apply) but no date can be computed: a state rule, a due-date rule or the registration's periodicity is missing. These stay unscheduled and visible.">
        {cov.missing_rules.length === 0 ? <div style={S.muted}>Empty.</div> : cov.missing_rules.map(m => (
          <div key={`${m.rule_id}|${m.state}`} style={{ padding: '6px 0', borderBottom: `1px solid ${C.line}`, fontSize: '0.8rem' }}>
            <b>{m.rule_name}</b>{m.state && <Tag tone="red">{m.state}</Tag>} <span style={S.small}>{m.rule_id} · {m.category}</span>
            <div style={S.small}>{m.reason} — {m.scopes.map(x => `${x.scope_label} (${x.decision})`).join('; ')}</div>
          </div>
        ))}
      </Section>

      <Section title={`Registration checks (${cov.registration_checks.length})`} sub="Registration data that looks missing — confirm or record it in Masters">
        {cov.registration_checks.length === 0 ? <div style={S.muted}>Nothing found.</div> : cov.registration_checks.map((c, i) => <div key={i} style={{ fontSize: '0.8rem', padding: '4px 0', borderBottom: `1px solid ${C.line}` }}><Tag tone={c.info ? 'blue' : 'amber'}>{c.code.replace(/_/g, ' ').toLowerCase()}</Tag> <b>{c.entity}</b> — {c.text}</div>)}
      </Section>

      {decide && <DecideModal row={decide} meta={meta} fy={fy} onClose={() => setDecide(null)} onDone={() => { setDecide(null); setMsg('Decision recorded'); load(); onChanged(); }} />}
    </div>
  );
}
