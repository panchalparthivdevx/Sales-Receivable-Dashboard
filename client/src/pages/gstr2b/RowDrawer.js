import React, { useEffect, useState, useCallback } from 'react';
import { g, errMsg } from './gApi';
import { S, Drawer, StatusPill, FlagTags, Tag, Field, Msg, ReasonModal, DueNote, OwnerSelect, ownerValue, ownerPatch, inr, dt, dtm, monthName, COMP } from './ui';

const DQ = {
  bill_level_discount: 'A bill-level discount was taken off the taxable value.',
  arith_check_failed: 'Zoho\'s total does not equal taxable value + tax + adjustment − TDS. Check the document in Zoho.',
  taxes_vs_lines: 'The bill\'s tax summary differs from the sum of its line taxes.',
  subtotal_vs_lines: 'The bill\'s sub-total differs from the sum of its line amounts.',
  tax_inclusive_document: 'Tax-inclusive document — confirm the amounts.',
  igst_on_intra_state: 'IGST was charged although supplier state and place of supply are the same state.',
  cgst_sgst_on_inter_state: 'CGST/SGST was charged on an inter-state supply.',
  rcm_components_derived: 'Reverse charge: Zoho keeps the tax on the lines, so IGST / CGST / SGST were derived from it.',
  no_document_number: 'The expense has no supplier invoice number, so it can only be matched by hand.',
  bill_discount_after_tax: 'A discount applied after tax is not subtracted from the taxable value.',
};
const ISSUE = { doc_no_missing: 'document number missing', doc_date_invalid: 'document date unreadable', amounts_missing: 'amounts missing', invalid_gstin: 'GSTIN check digit wrong', supplier_gstin_missing: 'supplier GSTIN missing', note_type_unknown: 'credit / debit note type unknown' };
const SECTION = { b2b: 'B2B invoice', b2ba: 'B2B invoice — amendment', cdnr: 'Credit / debit note', cdnra: 'Credit / debit note — amendment', isd: 'ISD credit', isda: 'ISD credit — amendment', impg: 'Import of goods', impga: 'Import of goods — amendment', impgsez: 'Import from SEZ', impgasez: 'Import from SEZ — amendment', ecom: 'E-commerce operator document', ecoma: 'E-commerce operator document — amendment', itcrev: 'Rule 37A reversal' };

const KV = ({ k, v }) => (v === null || v === undefined || v === '' ? null : <div style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: '0.78rem' }}><span style={{ ...S.muted, minWidth: 150 }}>{k}</span><span style={{ wordBreak: 'break-word' }}>{v}</span></div>);

export default function RowDrawer({ rowKey, meta, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [modal, setModal] = useState(null);
  const [edit, setEdit] = useState(null);
  const [noteText, setNoteText] = useState('');
  const people = meta.people || [];          // the owner is chosen from these; a server that does not send the list yet keeps the typed name
  const load = useCallback(() => g.row(rowKey).then(x => { setD(x); setEdit({ owner: people.length ? ownerValue(x.row, people) : x.row.owner || '', workflow: x.row.workflow || '', next_action: x.row.next_action || '', due: x.row.due || '' }); }).catch(e => setError(errMsg(e))), [rowKey]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const { rights } = meta;

  if (!d) return <Drawer title="Row" onClose={onClose}>{error ? <div style={S.error}>{error}</div> : <div style={S.center}>Loading…</div>}</Drawer>;
  const r = d.row, company = meta.companies.find(c => c.id === r.company) || {};
  const pair = r.b.length > 0 && r.p.length > 0;           // a real boolean: `0 && …` would print "0" on the page
  const sign = r.doc_type === 'CRN' ? -1 : 1;
  const sum = (views, c) => views.reduce((a, v) => a + sign * ((v.amounts && v.amounts[c]) || 0), 0);
  const tol = r.diffs ? r.within : null;
  const run = async fn => { setError(''); setOk(''); try { await fn(); } catch (e) { setError(errMsg(e)); throw e; } };
  const done = () => { setModal(null); onChanged(); onClose(); };                 // the row may no longer exist after a decision: reload the list
  const save = () => run(async () => { const { owner, ...rest } = edit; await g.assign({ keys: [r.key], ...rest, ...(people.length ? ownerPatch(owner) : { owner }) }); setOk('Saved.'); await load(); onChanged(); });
  const addNote = () => run(async () => { await g.note({ key: r.key, text: noteText }); setNoteText(''); setOk('Note added.'); await load(); });
  const dl = d.claim_deadline;

  return (
    <Drawer title={<span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><StatusPill status={r.status} statuses={meta.statuses} />{r.supplier || r.supplier_gstin || 'Document'}{r.rule && <Tag tone="grey">{r.rule === 'R3' && r.identity ? `R3 (${r.identity})` : r.rule}</Tag>}{r.decision.mode === 'manual' && <Tag tone="violet">Manual — {r.decision.by}</Tag>}</span>} onClose={onClose}>
      <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
      {company.demo && <div style={S.demo}>DEMO DATA — synthetic</div>}
      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Why this status</span><FlagTags flags={r.flags} text={meta.flags} /></div>
        <div style={S.cardBody}>
          {r.explain.map((t, i) => <p key={i} style={{ margin: '0 0 6px', fontSize: '0.8rem', lineHeight: 1.5 }}>{t}</p>)}
          {r.decision.reason && <p style={{ ...S.muted, margin: 0 }}>Reviewer's reason: {r.decision.reason}</p>}
          {r.related && <div style={S.notice}>Possible wrong recipient GSTIN — the same document is {r.related.side === 'GSTR-2B' ? 'GSTR-2B-only' : 'Books-only'} under <b>{r.related.gstin}</b> ({r.related.company_name}). Nothing is matched across GSTINs.</div>}
          {r.exclusion && <div style={S.info}>Excluded: {r.exclusion.text}</div>}
          {dl && <div style={{ ...S.notice, marginTop: 8, marginBottom: 0 }}><b>ITC claim deadline (Section 16(4)): {dt(dl.deadline)}</b> — {dl.days_left >= 0 ? `${dl.days_left} day(s) left` : `passed ${-dl.days_left} day(s) ago`}. {dl.text}.<br />Unresolved, not lost: if the supplier reports this invoice before the deadline it appears in a later GSTR-2B.</div>}
        </div>
      </div>

      {r.diffs && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Component by component</span><span style={S.small}>Each tax component is compared on its own — no difference is offset against another</span></div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th} /><th style={{ ...S.th, ...S.thR }}>Books</th><th style={{ ...S.th, ...S.thR }}>GSTR-2B</th><th style={{ ...S.th, ...S.thR }}>Difference (2B − Books)</th><th style={{ ...S.th, ...S.thR }}>Tolerance</th><th style={S.th}>Result</th></tr></thead>
            <tbody>
              {COMP.map(([c, n]) => (
                <tr key={c}><td style={S.td}>{n}</td><td style={{ ...S.td, ...S.num }}>{inr(sum(r.b, c))}</td><td style={{ ...S.td, ...S.num }}>{inr(sum(r.p, c))}</td>
                  <td style={{ ...S.td, ...S.num, color: r.diffs[c] ? (tol[c] ? '#B45309' : '#B91C1C') : '#15803D', fontWeight: 600 }}>{inr(r.diffs[c], { sign: true })}</td>
                  <td style={{ ...S.td, ...S.num }}>±{inr(r.tolerance_p[c])}</td><td style={S.td}>{r.diffs[c] === 0 ? <Tag tone="green">Equal</Tag> : tol[c] ? <Tag tone="amber">Within tolerance</Tag> : <Tag tone="red">Outside tolerance</Tag>}</td></tr>))}
              <tr><td style={S.td}>Invoice value <span style={S.small}>(information only)</span></td><td style={{ ...S.td, ...S.num }}>{inr(r.b.reduce((a, v) => a + sign * (v.value || 0), 0))}</td><td style={{ ...S.td, ...S.num }}>{inr(r.p.reduce((a, v) => a + sign * (v.value || 0), 0))}</td><td style={{ ...S.td, ...S.num }}>{inr(r.diffs.invoice_value, { sign: true })}</td><td colSpan={2} style={S.td} /></tr>
            </tbody>
          </table>
        </div>
      )}

      {r.b.map(v => (
        <div key={v.id} style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Books — {v.kind === 'vendor_credit' ? 'vendor credit' : v.kind === 'expense' ? 'expense' : 'bill'} {v.no || '(no number)'}</span>
            <span style={{ display: 'flex', gap: 6 }}>{v.url && !company.demo && <a href={v.url} target="_blank" rel="noreferrer" style={{ ...S.btn, textDecoration: 'none' }}>Open in Zoho ↗</a>}
              {rights.prepare && !company.demo && <button style={S.ghost} onClick={() => run(async () => { await g.refresh(r.company, v.id); setOk('Re-read from Zoho.'); onChanged(); await load(); })}>Refresh from Zoho</button>}
              {rights.review && r.status !== 'excluded' && <button style={S.ghost} onClick={() => setModal({ type: 'exclude', id: v.id, side: 'books' })}>Exclude…</button>}</span></div>
          <div style={S.cardBody}>
            <KV k="Document number" v={v.no} /><KV k="Supplier invoice date" v={`${dt(v.date)}${v.date_assumed ? ' — ASSUMED (the supplier invoice date is not recorded; the posting date is used)' : ''}`} />
            <KV k="Posting date in Zoho" v={dt(v.posting)} /><KV k="Accounting month" v={monthName(v.period)} />
            <KV k="Supplier" v={v.supplier} /><KV k="Supplier GSTIN" v={v.gstin} />{v.master_gstin && v.master_gstin !== v.gstin && <KV k="Vendor master GSTIN" v={<span style={{ color: '#B91C1C' }}>{v.master_gstin} — differs from the GSTIN on this document</span>} />}
            <KV k="Recipient branch" v={v.branch} /><KV k="Projects" v={(v.projects || []).join(', ')} />
            <KV k="Zoho status" v={v.status} /><KV k="Reverse charge" v={v.rcm ? 'Yes' : ''} /><KV k="Place of supply" v={v.pos ? `state code ${v.pos}` : ''} />
            <KV k="Paid so far (in Zoho)" v={v.paid ? inr(v.paid) : ''} /><KV k="Last modified in Zoho" v={dtm(v.lmt)} />
            {v.stale && <div style={{ ...S.notice, marginTop: 6 }}>This document was changed in Zoho after it was last read; the figures are from the earlier version until the sync refreshes it.</div>}
            {(v.dq || []).length > 0 && <div style={{ marginTop: 6 }}><div style={S.label}>Data-quality notes</div>{v.dq.map(x => <div key={x} style={{ fontSize: '0.76rem', color: '#92400E', padding: '1px 0' }}>• {DQ[x] || x.replace('unknown_tax:', 'Unrecognised tax in Zoho: ')}</div>)}</div>}
          </div>
        </div>
      ))}

      {r.p.map(v => (
        <div key={v.id} style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>GSTR-2B — {SECTION[v.section] || v.section} {v.no || ''}</span>
            {rights.review && r.status !== 'excluded' && <button style={S.ghost} onClick={() => setModal({ type: 'exclude', id: v.id, side: 'portal' })}>Exclude…</button>}</div>
          <div style={S.cardBody}>
            <KV k="Document number" v={v.no} /><KV k="Document date" v={dt(v.date)} /><KV k="Return period (GSTR-2B)" v={monthName(v.period)} />
            <KV k="Supplier" v={v.supplier} /><KV k="Supplier GSTIN" v={v.gstin} />
            <KV k="Supplier reported in" v={v.filing_period ? `GSTR-1 / IFF period ${v.filing_period}${v.filing_date ? `, filed ${v.filing_date}` : ''}` : ''} />
            <KV k="ITC available per portal" v={v.itc ? `${v.itc === 'Y' ? 'Yes' : v.itc === 'N' ? 'No' : v.itc}${v.reason ? ` (reason code ${v.reason})` : ''} — the portal's statement, not an eligibility decision` : ''} />
            <KV k="Reverse charge" v={v.rcm ? 'Yes' : ''} /><KV k="Place of supply" v={v.pos} /><KV k="Source" v={v.source_type} />
            <KV k="Statement" v={`${v.stmt_id} · version ${v.version}`} /><KV k="Source row" v={v.src_id} />
            {(v.amended_from || []).length > 0 && <div style={{ marginTop: 6 }}><div style={S.label}>Amends earlier reporting (not counted twice)</div>{v.amended_from.map((a, i) => <div key={i} style={{ fontSize: '0.76rem' }}>• {SECTION[a.section] || a.section} {a.doc_no} dated {dt(a.doc_date)}, reported in {monthName(a.period)}</div>)}</div>}
            {(v.issues || []).length > 0 && <div style={{ ...S.notice, marginTop: 6 }}>Problems read from the statement: {v.issues.map(x => ISSUE[x] || x).join(', ')}.</div>}
          </div>
        </div>
      ))}

      {d.row.candidates.length > 0 && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Candidates the rules considered</span><span style={S.small}>Never matched automatically — a person decides</span></div>
          <div style={S.cardBody}>{d.row.candidates.map((c, i) => (
            <div key={i} style={{ borderBottom: '1px solid #F0F2F1', padding: '6px 0' }}>
              <div style={{ fontSize: '0.78rem' }}>{c.books ? <>Books <b>{c.books.no}</b> {dt(c.books.date)}</> : null}{c.books && c.portal ? ' ↔ ' : ''}{c.portal ? <>GSTR-2B <b>{c.portal.no}</b> {dt(c.portal.date)}</> : null} <Tag tone="grey">score {c.score}</Tag></div>
              <div style={S.muted}>{(c.reasons || []).join('; ')}</div>
              {rights.review && c.books && c.portal && !pair && <button style={{ ...S.ghost, marginTop: 4 }} onClick={() => setModal({ type: 'link', books: [c.books.id], portal: [c.portal.id] })}>Link these two…</button>}
            </div>))}</div>
        </div>
      )}

      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Review</span><span style={S.small}>Owner, workflow and next action are tracked here — not in Zoho</span></div>
        <div style={S.cardBody}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 8 }}>
            <Field label="Owner">{people.length
              ? <OwnerSelect people={people} value={edit.owner} disabled={!rights.prepare} onChange={v => setEdit({ ...edit, owner: v })} />
              : <input style={{ ...S.input, width: '100%' }} value={edit.owner} disabled={!rights.prepare} onChange={e => setEdit({ ...edit, owner: e.target.value })} />}</Field>
            <Field label="Workflow"><select style={{ ...S.select, width: '100%' }} value={edit.workflow} disabled={!rights.prepare} onChange={e => setEdit({ ...edit, workflow: e.target.value })}><option value="">Not started</option>{Object.entries(meta.workflow).map(([k, v]) => <option key={k} value={k} disabled={['accepted', 'resolved'].includes(k) && !rights.review}>{v}</option>)}</select></Field>
            <Field label="Next action"><input style={{ ...S.input, width: '100%' }} value={edit.next_action} disabled={!rights.prepare} onChange={e => setEdit({ ...edit, next_action: e.target.value })} /></Field>
            <Field label="Due"><input type="date" style={{ ...S.input, width: '100%' }} value={edit.due} disabled={!rights.prepare} onChange={e => setEdit({ ...edit, due: e.target.value })} /></Field>
          </div>
          <div style={{ marginTop: 6 }}>
            <DueNote due={r.due} state={r.due_state} days={r.due_days} />
            {r.owner && r.assigned_at && <div style={S.small}>Given to {r.owner} by {r.assigned_by || '—'} on {dtm(r.assigned_at)}</div>}
            {r.owner && r.open === false && <div style={S.small}>This row is no longer open (it is matched, excluded, or marked Accepted / Resolved), so it is not in the owner's "My rows" or reminders.</div>}
          </div>
          {rights.prepare && <button style={{ ...S.btn, marginTop: 8 }} onClick={save}>Save</button>}
          <div style={{ marginTop: 12 }}>
            <div style={S.label}>Notes</div>
            {d.review.notes.length === 0 && <div style={S.small}>No notes yet.</div>}
            {d.review.notes.map((n, i) => <div key={i} style={{ fontSize: '0.78rem', padding: '3px 0', borderBottom: '1px solid #F0F2F1' }}><b>{n.by}</b> <span style={S.small}>{dtm(n.at)}</span><br />{n.text}</div>)}
            {rights.prepare && <div style={{ display: 'flex', gap: 6, marginTop: 6 }}><input style={{ ...S.input, flex: 1 }} value={noteText} placeholder="Add a note" onChange={e => setNoteText(e.target.value)} /><button style={S.btn} disabled={!noteText.trim()} onClick={addNote}>Add note</button></div>}
          </div>
          <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}>Reviewer history ({d.review.history.length})</summary>
            {d.review.history.map((h, i) => <div key={i} style={{ fontSize: '0.74rem', padding: '2px 0' }}><span style={S.small}>{dtm(h.at)}</span> <b>{h.by}</b> — {h.action}{h.detail ? `: ${h.detail}` : ''}</div>)}
          </details>
        </div>
      </div>

      {rights.review && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {r.status === 'suggested' && <button style={S.primary} onClick={() => setModal({ type: 'approve' })}>Approve this match…</button>}
          {pair && <button style={S.danger} onClick={() => setModal({ type: 'unlink' })}>{r.decision.mode === 'manual' ? 'Unlink…' : 'Not a match…'}</button>}
          {d.review.exclusions.map(x => <button key={x.doc_id} style={S.ghost} onClick={() => run(async () => { await g.exclude({ company: r.company, gstin: r.gstin, doc_id: x.doc_id, include: true }); onChanged(); onClose(); })}>Include again ({x.by}: {x.reason})</button>)}
        </div>
      )}

      {modal && modal.type === 'approve' && (
        <ReasonModal title="Approve this suggested match" confirm="Approve" onCancel={() => setModal(null)}
          text="The two documents become a manual link, recorded under your name. Check the invoice with the supplier's copy first."
          extra={r.diffs && !Object.values(r.within).every(Boolean) ? <label style={{ display: 'flex', gap: 6, marginTop: 8, fontSize: '0.78rem' }}><input type="checkbox" id="g2b-var" /> Also accept the differences shown as an approved tolerance for this pair</label> : null}
          onConfirm={async reason => { await run(async () => { const v = await g.approve({ keys: [r.key], reason, approve_variance: !!document.getElementById('g2b-var')?.checked }); if (!v.approved) throw new Error((v.skipped[0] || {}).why || 'Nothing was approved'); }); done(); }} />
      )}
      {modal && modal.type === 'unlink' && (
        <ReasonModal title={r.decision.mode === 'manual' ? 'Unlink these documents' : 'These documents are not a match'} confirm="Confirm" danger onCancel={() => setModal(null)}
          text="The two documents are separated and will not be paired again automatically; each goes back to Books only / GSTR-2B only."
          onConfirm={async reason => { await run(async () => { await g.unlink({ key: r.key, reason }); }); done(); }} />
      )}
      {modal && modal.type === 'exclude' && (
        <ReasonModal title="Exclude this document from the reconciliation" confirm="Exclude" danger onCancel={() => setModal(null)}
          text="The document is kept and listed as Excluded with your reason. Use this only for documents that should never be in a GSTR-2B reconciliation."
          onConfirm={async reason => { await run(async () => { await g.exclude({ company: r.company, gstin: r.gstin, doc_id: modal.id, side: modal.side, reason }); }); done(); }} />
      )}
      {modal && modal.type === 'link' && (
        <ReasonModal title="Link these two documents" confirm="Link" onCancel={() => setModal(null)}
          text={`Links the ${r.b.length ? 'Books' : 'GSTR-2B'} document of this row with the candidate. The link is recorded under your name and kept when the reconciliation is re-run.`}
          onConfirm={async reason => { await run(async () => { await g.link({ company: r.company, gstin: r.gstin, books_ids: r.b.length ? r.b.map(x => x.id) : modal.books, portal_ids: r.p.length ? r.p.map(x => x.id) : modal.portal, reason }); }); done(); }} />
      )}
    </Drawer>
  );
}
