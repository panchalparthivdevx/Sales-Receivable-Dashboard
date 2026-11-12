import React, { useEffect, useState, useCallback } from 'react';
import { g, errMsg } from './gApi';
import { S, StatusPill, FlagTags, Tag, Field, Msg, Modal, ReasonModal, inr, dt, monthName, COMP } from './ui';
import RowDrawer from './RowDrawer';

// Books and GSTR-2B side by side: invoice details, each tax component, the differences, why, source links, owner and next action.
// The same component serves the Books-only, GSTR-2B-only and mismatch / duplicate queues.

const sideOf = (views, type) => {
  const sign = type === 'CRN' ? -1 : 1;
  const a = {};
  for (const [c] of COMP) a[c] = views.length ? views.reduce((s, v) => s + sign * ((v.amounts && v.amounts[c]) || 0), 0) : null;
  return a;
};
const WF = { vendor_followup: 'amber', waiting_vendor: 'amber', in_review: 'blue', accepted: 'green', resolved: 'green' };

export default function WorkbenchTab({ meta, filters, stamp, onChanged, title, queue }) {
  const [page, setPage] = useState(1);
  const [per, setPer] = useState(100);
  const [sort, setSort] = useState('status');
  const [dir, setDir] = useState('asc');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [sel, setSel] = useState({});
  const [open, setOpen] = useState(null);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const fkey = JSON.stringify(filters);

  const load = useCallback(() => { setError(''); g.rows({ ...filters, page, per, sort, dir }).then(setData).catch(e => setError(errMsg(e))); }, [fkey, page, per, sort, dir]); // eslint-disable-line
  useEffect(() => { setPage(1); setSel({}); }, [fkey]);
  useEffect(() => { load(); }, [load, stamp]);

  const rows = data ? data.rows : [];
  const picked = Object.values(sel);
  const toggle = r => setSel(s => { const n = { ...s }; if (n[r.key]) delete n[r.key]; else n[r.key] = r; return n; });
  const allOn = rows.length > 0 && rows.every(r => sel[r.key]);
  const total = data ? data.total : 0, pages = Math.max(1, Math.ceil(total / per));
  const { rights } = meta;
  const run = async fn => { setBusy(true); setError(''); setOk(''); try { await fn(); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); } };
  const exportXlsx = () => run(() => g.exportXlsx({ ...filters }));

  // ── bulk actions ──
  const sameScope = picked.every(r => r.company === picked[0].company && r.gstin === picked[0].gstin);
  const suggested = picked.filter(r => r.status === 'suggested');
  const pairs = picked.filter(r => r.b.length && r.p.length && r.status !== 'excluded');
  const booksOnly = picked.filter(r => r.status === 'books_only'), portalOnly = picked.filter(r => r.status === 'portal_only');
  const canLink = rights.review && sameScope && booksOnly.length >= 1 && portalOnly.length >= 1 && booksOnly.length + portalOnly.length === picked.length;
  const afterAction = msg => { setModal(null); setSel({}); setOk(msg); onChanged(); };

  const th = (label, key, extra) => <th style={{ ...S.th, ...extra, cursor: key ? 'pointer' : 'default' }} onClick={key ? () => { if (sort === key) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(key); setDir('asc'); } } : undefined}>{label}{sort === key ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>;
  const amt = (v, c, r, side) => {
    if (v === null) return <td style={{ ...S.td, ...S.num, color: '#C7D0D4' }}>—</td>;
    return <td style={{ ...S.td, ...S.num, color: v === 0 ? '#9BA8B0' : undefined }}>{inr(v)}</td>;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div><span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{title}</span> <span style={S.muted}>{data ? `${total.toLocaleString('en-IN')} row${total === 1 ? '' : 's'}` : ''}</span></div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select style={S.select} value={`${sort}:${dir}`} onChange={e => { const [a, b] = e.target.value.split(':'); setSort(a); setDir(b); }}>
            <option value="status:asc">Sort: needs attention first</option><option value="gst:asc">Sort: largest GST first</option><option value="supplier:asc">Sort: supplier A–Z</option><option value="date:desc">Sort: newest document first</option><option value="date:asc">Sort: oldest document first</option></select>
          <select style={S.select} value={per} onChange={e => { setPer(+e.target.value); setPage(1); }}>{[50, 100, 250, 500].map(n => <option key={n} value={n}>{n} per page</option>)}</select>
          <button style={S.ghost} disabled={busy} onClick={exportXlsx}>Export this view to Excel</button>
        </div>
      </div>
      <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />

      {picked.length > 0 && (
        <div style={{ ...S.card, padding: '0.55rem 0.9rem', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: '#F0F7F4' }}>
          <b style={{ fontSize: '0.8rem' }}>{picked.length} selected</b>
          {rights.prepare && <button style={S.btn} onClick={() => setModal({ type: 'assign' })}>Assign owner / next action…</button>}
          {rights.review && suggested.length > 0 && <button style={S.btn} onClick={() => setModal({ type: 'approve' })}>Approve {suggested.length} suggested…</button>}
          {rights.review && pairs.length > 0 && <button style={S.ghost} onClick={() => setModal({ type: 'reject' })}>Not a match ({pairs.length})…</button>}
          {canLink && <button style={S.btn} onClick={() => setModal({ type: 'link' })}>Link {booksOnly.length} Books + {portalOnly.length} GSTR-2B document(s)…</button>}
          {!sameScope && <span style={S.small}>Select rows of one GSTIN to act on them together.</span>}
          <button style={S.ghost} onClick={() => setSel({})}>Clear selection</button>
        </div>
      )}

      {!data && !error && <div style={S.center}>Loading…</div>}
      {data && (
        <div style={{ ...S.card, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto', maxHeight: '68vh' }}>
            <table style={{ borderCollapse: 'collapse', minWidth: 2150 }}>
              <thead>
                <tr>
                  <th style={{ ...S.th, background: '#EEF2F0' }} colSpan={3} />
                  <th style={{ ...S.th, background: '#EDE9FE', color: '#5B21B6' }} colSpan={6}>BOOKS (Zoho)</th>
                  <th style={{ ...S.th, background: '#DBEAFE', color: '#1E40AF' }} colSpan={6}>GSTR-2B (GST portal)</th>
                  <th style={{ ...S.th, background: '#FEF3C7', color: '#92400E' }} colSpan={5}>DIFFERENCE (2B − Books)</th>
                  <th style={{ ...S.th, background: '#EEF2F0' }} colSpan={3} />
                </tr>
                <tr>
                  <th style={S.th}><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? {} : Object.fromEntries(rows.map(r => [r.key, r])))} /></th>
                  {th('Status', 'status')}{th('Supplier', 'supplier')}
                  {th('Document / date', 'date')}{COMP.map(([c, n]) => <th key={`b${c}`} style={{ ...S.th, ...S.thR }}>{n}</th>)}
                  <th style={S.th}>Document / date / period</th>{COMP.map(([c, n]) => <th key={`p${c}`} style={{ ...S.th, ...S.thR }}>{n}</th>)}
                  {COMP.map(([c, n]) => <th key={`d${c}`} style={{ ...S.th, ...S.thR }}>{n}</th>)}
                  <th style={S.th}>Flags</th><th style={S.th}>Owner · next action</th><th style={S.th}>Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={24} style={{ ...S.td, textAlign: 'center', padding: '2rem', color: '#9BA8B0' }}>Nothing here for the current filters.</td></tr>}
                {rows.map(r => {
                  const b = sideOf(r.b, r.doc_type), p = sideOf(r.p, r.doc_type);
                  const company = meta.companies.find(c => c.id === r.company) || {};
                  const bv = r.b[0], pv = r.p[0];
                  return (
                    <tr key={r.key} onClick={() => setOpen(r.key)} style={{ cursor: 'pointer', background: sel[r.key] ? '#F0F7F4' : undefined }}>
                      <td style={S.td} onClick={e => { e.stopPropagation(); toggle(r); }}><input type="checkbox" checked={!!sel[r.key]} readOnly /></td>
                      <td style={S.td}><StatusPill status={r.status} statuses={meta.statuses} small />
                        <div style={S.small}>{r.rule ? (r.rule === 'R3' && r.identity ? `R3 · ${r.identity}` : r.rule) : ''}{r.decision.mode === 'manual' ? ' · manual' : ''}</div>
                        {r.doc_type !== 'INV' && <Tag tone="blue">{r.doc_type === 'CRN' ? 'Credit note' : 'Debit note'}</Tag>}</td>
                      <td style={{ ...S.td, minWidth: 190 }}><div style={{ fontWeight: 600 }}>{r.supplier || '—'}</div><div style={S.small}>{r.supplier_gstin}</div><div style={S.small}>→ {r.gstin}{meta.companies.length > 1 || company.demo ? ` · ${company.short || company.name}` : ''}</div></td>
                      <td style={{ ...S.td, minWidth: 150 }}>{bv ? <><div style={{ fontWeight: 600 }}>{bv.no || '—'}{r.b.length > 1 ? ` +${r.b.length - 1}` : ''}</div><div style={S.small}>{dt(bv.date)}{bv.date_assumed ? ' *' : ''} · {bv.branch}</div></> : <span style={{ color: '#C7D0D4' }}>—</span>}</td>
                      {COMP.map(([c]) => amt(b[c], c, r, 'b'))}
                      <td style={{ ...S.td, minWidth: 160 }}>{pv ? <><div style={{ fontWeight: 600 }}>{pv.no || '—'}{r.p.length > 1 ? ` +${r.p.length - 1}` : ''}</div><div style={S.small}>{dt(pv.date)} · {monthName(pv.period)} · {pv.section}</div></> : <span style={{ color: '#C7D0D4' }}>—</span>}</td>
                      {COMP.map(([c]) => amt(p[c], c, r, 'p'))}
                      {COMP.map(([c]) => (r.diffs
                        ? <td key={c} style={{ ...S.td, ...S.num, fontWeight: r.diffs[c] ? 700 : 400, color: !r.diffs[c] ? '#9BA8B0' : r.within[c] ? '#B45309' : '#B91C1C' }}>{r.diffs[c] ? inr(r.diffs[c], { sign: true }) : '0.00'}</td>
                        : <td key={c} style={{ ...S.td, ...S.num, color: '#C7D0D4' }}>—</td>))}
                      <td style={{ ...S.td, minWidth: 190 }}><FlagTags flags={r.flags.filter(f => !['zero_tax'].includes(f))} text={meta.flags} max={4} />
                        {r.exclusion && <div style={S.small}>{r.exclusion.text}</div>}</td>
                      <td style={{ ...S.td, minWidth: 150 }}>{r.owner && <div style={{ fontWeight: 600 }}>{r.owner}</div>}{r.workflow && <Tag tone={WF[r.workflow] || 'grey'}>{meta.workflow[r.workflow]}</Tag>}{r.next_action && <div style={S.small}>{r.next_action}{r.due ? ` · ${dt(r.due)}` : ''}</div>}{r.notes > 0 && <div style={S.small}>{r.notes} note{r.notes > 1 ? 's' : ''}</div>}</td>
                      <td style={{ ...S.td, minWidth: 110 }} onClick={e => e.stopPropagation()}>
                        {bv && bv.url && !company.demo && <a href={bv.url} target="_blank" rel="noreferrer" style={{ color: '#1C4942', fontSize: '0.74rem', display: 'block' }}>Zoho ↗</a>}
                        {pv && <span style={S.small}>{pv.src_id ? pv.src_id.replace(/^st_/, '') : ''}</span>}
                      </td>
                    </tr>);
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 1rem', borderTop: '1px solid #DFE7E3', flexWrap: 'wrap', gap: 8 }}>
            <span style={S.muted}>Page {page} of {pages}</span>
            <span style={{ display: 'flex', gap: 6 }}><button style={S.ghost} disabled={page <= 1} onClick={() => setPage(page - 1)}>← Previous</button><button style={S.ghost} disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button></span>
          </div>
        </div>
      )}
      <div style={S.small}>* the supplier's invoice date is not recorded in Zoho; the posting date is shown. Credit notes are shown as negative amounts. Click a row for the full explanation, both source documents and the review history.</div>

      {open && <RowDrawer rowKey={open} meta={meta} onClose={() => setOpen(null)} onChanged={() => { onChanged(); }} />}

      {modal && modal.type === 'approve' && (
        <ReasonModal title={`Approve ${suggested.length} suggested match(es)`} confirm="Approve" onCancel={() => setModal(null)}
          text="Each approved pair becomes a manual link under your name. Matches that are ambiguous, under a different supplier GSTIN, grouped, or with different document numbers are skipped here — open them one by one."
          onConfirm={async reason => run(async () => { const r = await g.approve({ keys: suggested.map(x => x.key), reason }); afterAction(`${r.approved} approved${r.skipped.length ? `; ${r.skipped.length} skipped (${[...new Set(r.skipped.map(s => s.why))].join('; ')})` : ''}.`); })} />
      )}
      {modal && modal.type === 'reject' && (
        <ReasonModal title={`Mark ${pairs.length} pair(s) as not a match`} confirm="Separate them" danger onCancel={() => setModal(null)}
          text="The documents of each pair are separated and will not be paired again automatically."
          onConfirm={async reason => run(async () => { for (const x of pairs) await g.unlink({ key: x.key, reason }); afterAction(`${pairs.length} pair(s) separated.`); })} />
      )}
      {modal && modal.type === 'link' && (
        <ReasonModal title="Link these documents" confirm="Link" onCancel={() => setModal(null)}
          text={`${booksOnly.length} Books document(s) and ${portalOnly.length} GSTR-2B document(s) of ${picked[0].gstin} become one manual link (use several on one side for a split or consolidated invoice). Documents of different GSTINs can never be linked.`}
          onConfirm={async reason => run(async () => { await g.link({ company: picked[0].company, gstin: picked[0].gstin, books_ids: booksOnly.flatMap(x => x.b.map(v => v.id)), portal_ids: portalOnly.flatMap(x => x.p.map(v => v.id)), reason }); afterAction('Linked.'); })} />
      )}
      {modal && modal.type === 'assign' && <AssignModal meta={meta} picked={picked} onCancel={() => setModal(null)} onDone={m => afterAction(m)} setError={setError} />}
    </div>
  );
}

function AssignModal({ meta, picked, onCancel, onDone, setError }) {
  const [f, setF] = useState({ owner: '', workflow: '', next_action: '', due: '' });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const patch = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
      const groups = {};
      for (const r of picked) (groups[`${r.company}|${r.gstin}`] = groups[`${r.company}|${r.gstin}`] || []).push(r.key);
      for (const keys of Object.values(groups)) await g.assign({ keys, ...patch });
      onDone(`Updated ${picked.length} row(s).`);
    } catch (e) { setError(errMsg(e)); onCancel(); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Assign ${picked.length} row(s)`} onClose={onCancel}>
      <p style={{ ...S.muted, marginTop: 0 }}>Leave a field empty to keep what each row has.</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Owner"><input list="g2b-owners3" style={{ ...S.input, width: '100%' }} value={f.owner} onChange={e => setF({ ...f, owner: e.target.value })} /><datalist id="g2b-owners3">{(meta.admin_users || []).map(u => <option key={u.id} value={u.name} />)}</datalist></Field>
        <Field label="Workflow"><select style={{ ...S.select, width: '100%' }} value={f.workflow} onChange={e => setF({ ...f, workflow: e.target.value })}><option value="">(keep)</option>{Object.entries(meta.workflow).map(([k, v]) => <option key={k} value={k} disabled={['accepted', 'resolved'].includes(k) && !meta.rights.review}>{v}</option>)}</select></Field>
        <Field label="Next action"><input style={{ ...S.input, width: '100%' }} value={f.next_action} onChange={e => setF({ ...f, next_action: e.target.value })} /></Field>
        <Field label="Due"><input type="date" style={{ ...S.input, width: '100%' }} value={f.due} onChange={e => setF({ ...f, due: e.target.value })} /></Field>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}><button style={S.ghost} onClick={onCancel}>Cancel</button><button style={S.primary} disabled={busy || !Object.values(f).some(Boolean)} onClick={submit}>{busy ? 'Saving…' : 'Save'}</button></div>
    </Modal>
  );
}
