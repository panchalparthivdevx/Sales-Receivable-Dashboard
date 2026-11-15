import React, { useEffect, useState } from 'react';
import { api, errMsg, openDocument } from './api';
import { C, S, Section, Note, Btn, Table, Tag, Select, Input, Empty, dt, dtm } from './ui';

// Evidence vault: every document of the entities the user may see, with its checks (malware scan, entity / GSTIN / period
// mismatch, duplicate content), versions, legal hold and retention date. Files are encrypted at rest and opened through
// short-lived signed links.
const FLAGS = [['', 'Any'], ['gstin_mismatch', 'GSTIN mismatch'], ['tan_mismatch', 'TAN mismatch'], ['pan_mismatch', 'PAN mismatch'], ['period_mismatch', 'Period mismatch'], ['duplicate_content', 'Duplicate content'], ['no_text', 'No readable text'], ['unscanned', 'Not malware-scanned'], ['hold', 'Legal hold']];

export default function EvidenceTab({ stamp, meta, org, onOpenTask }) {
  const [q, setQ] = useState({ doc_type: '', flag: '', status: 'active', search: '', entity_ids: [] });
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { setData(null); api.documents(q).then(setData).catch(e => setErr(errMsg(e))); }, [q, stamp]);
  const ents = new Map((org?.entities || []).map(e => [e.id, e]));
  return (
    <div>
      {err && <Note tone="error">{err}</Note>}
      <Note tone="info">Text checks (GSTIN / TAN / PAN / period) are assistive only — a flag asks a person to look; it never blocks, files or verifies anything. Scanned images are not read (no OCR in this phase).</Note>
      <div style={{ ...S.card, padding: '0.75rem 0.9rem', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ width: 200 }}><span style={S.label}>Entity</span><Select value={q.entity_ids[0] || ''} onChange={v => setQ({ ...q, entity_ids: v ? [v] : [] })} options={(org?.entities || []).map(e => [e.id, `${e.short_code} — ${e.legal_name}`])} placeholder="All" /></div>
        <div style={{ width: 200 }}><span style={S.label}>Type</span><Select value={q.doc_type} onChange={v => setQ({ ...q, doc_type: v })} options={Object.entries(meta.constants.doc_types)} placeholder="All" /></div>
        <div style={{ width: 190 }}><span style={S.label}>Check</span><Select value={q.flag} onChange={v => setQ({ ...q, flag: v })} options={FLAGS.slice(1)} placeholder="Any" /></div>
        <div style={{ width: 140 }}><span style={S.label}>Status</span><Select value={q.status} onChange={v => setQ({ ...q, status: v })} options={[['active', 'Active'], ['withdrawn', 'Withdrawn'], ['all', 'All']]} /></div>
        <div style={{ width: 220 }}><span style={S.label}>Search</span><Input value={q.search} onChange={e => setQ({ ...q, search: e.target.value })} placeholder="File name, document id, SHA-256" /></div>
      </div>
      {!data ? <Empty>Loading…</Empty> : (
        <Section title={`Evidence vault — ${data.total} document(s)`} sub={`Storage: ${meta.storage.store === 'vercel-blob' ? 'private Vercel Blob' : 'this server\'s disk'}, encrypted (AES-256-GCM) · malware scan: ${meta.storage.scanner === 'none' ? 'not available on this server (documents are marked unscanned)' : meta.storage.scanner}`} flush>
          <Table rows={data.documents} maxHeight={640} empty="No documents"
            cols={[
              { label: 'Document', render: d => <><b>{meta.constants.doc_types[d.doc_type]}</b> · {d.current.original_name}<div style={S.small}>{d.id} · v{d.current.v} of {d.versions.length} · sha256 {d.current.sha256.slice(0, 12)}…</div></> },
              { label: 'Entity', render: d => ents.get(d.entity_id)?.short_code || d.entity_id, hideSm: true },
              { label: 'Tasks', render: d => d.tasks.map(t => <button key={t.id} type="button" onClick={() => onOpenTask(t.id)} style={{ display: 'block', border: 'none', background: 'none', padding: 0, color: C.lav, cursor: 'pointer', fontSize: '0.74rem', textAlign: 'left', fontFamily: 'inherit' }}>{t.rule_name} · {t.period_label}</button>) },
              { label: 'Checks', render: d => <>{d.current.scan?.status !== 'clean' && <Tag tone="amber">scan: {d.current.scan?.status}</Tag>}{(d.current.flags || []).filter(f => f.code !== 'not_scanned').map((f, i) => <Tag key={i} tone="amber" title={f.text}>{f.code.replace(/_/g, ' ')}</Tag>)}{d.legal_hold && <Tag tone="red" title={d.legal_hold.reason}>legal hold</Tag>}{d.sample && <Tag tone="lav">sample</Tag>}{d.status !== 'active' && <Tag>withdrawn</Tag>}</> },
              { label: 'Uploaded', render: d => <>{d.current.uploaded_by}<div style={S.small}>{dtm(d.current.at)}</div></>, hideSm: true },
              { label: 'Keep until', render: d => dt(d.retention_until), hideSm: true },
              { label: '', render: d => <Btn small kind="ghost" onClick={() => openDocument(d.id).catch(e => setErr(errMsg(e)))}>Download</Btn> },
            ]} />
        </Section>
      )}
    </div>
  );
}
