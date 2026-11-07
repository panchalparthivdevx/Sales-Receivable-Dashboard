import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { X, ExternalLink, Plus, Trash2, RotateCcw, Check, FileText, Send } from 'lucide-react';
import { bb, errMsg } from './bbApi';
import { S, StatusPill, Tag, SOURCE_LABEL, money, dt, dtm, Field, Msg } from './ui';

// ─── One bill: the original next to what was read, suggested and still missing ───
// The team corrects details, chooses category / vendor / accounts / tax where the system was not
// sure, confirms flagged points, and creates the Zoho draft. Every change lands in the audit trail.

const lookupCache = {};   // company → { accounts, taxes, branches, projects } (this browser session)
async function lookupsFor(company) {
  if (!company) return { accounts: [], taxes: [], branches: [], projects: [], errors: [] };
  if (!lookupCache[company]) lookupCache[company] = bb.lookups(company).catch(e => { delete lookupCache[company]; throw e; });
  return lookupCache[company];
}

const STICKY = new Set(['draft_created', 'reviewed']);
const NUM_FIELDS = [['sub_total', 'Basic amount (taxable)'], ['cgst', 'CGST'], ['sgst', 'SGST / UTGST'], ['igst', 'IGST'], ['cess', 'Cess'], ['tax_total', 'GST total'], ['round_off', 'Round-off'], ['total', 'Invoice total']];
const ACK_LABEL = { debit_note: 'Book as a bill', reverse_charge: 'Treatment checked', doc_type_unclear: 'It is a bill', zoho_deleted: 'Create again', confirm_reading: 'Details checked' };

export default function BillDrawer({ id, meta, onClose, onSaved, onOpen }) {
  const [bill, setBill] = useState(null);
  const [form, setForm] = useState(null);
  const [look, setLook] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const [remember, setRemember] = useState(true);
  const [vq, setVq] = useState('');
  const [vendors, setVendors] = useState([]);
  const [showText, setShowText] = useState(false);
  const [note, setNote] = useState('');

  const reset = useCallback(b => {
    setBill(b);
    setForm({
      fields: { ...b.fields },
      company: b.company || '',
      vendor: b.vendor?.id ? { id: b.vendor.id, name: b.vendor.name } : null,
      category_id: b.category?.id || '',
      lines: (b.lines || []).map(l => ({ id: l.id, description: l.description || '', hsn_sac: l.hsn_sac || '', amount: l.amount ?? '', account_id: l.account?.id || '', tax_id: l.tax?.id || '' })),
      branch_id: b.bill_level?.branch?.id || '',
      cat_fields: Object.fromEntries(Object.entries(b.cat_field_state || {}).map(([k, v]) => [k, v.value])),
      remember_fields: [],
    });
  }, []);

  const load = useCallback(async () => {
    try { reset((await bb.bill(id)).bill); } catch (e) { setError(errMsg(e)); }
  }, [id, reset]);
  useEffect(() => { setBill(null); setError(''); setOk(''); load(); }, [load]);
  useEffect(() => {
    if (bill?.status !== 'received') return undefined;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [bill, load]);
  useEffect(() => {
    let live = true;
    if (!form?.company) { setLook(null); return undefined; }
    lookupsFor(form.company).then(l => live && setLook(l), e => live && setError(`Zoho look-ups: ${errMsg(e)}`));
    return () => { live = false; };
  }, [form?.company]);
  useEffect(() => {
    if (!form?.company || vq.length < 2) { setVendors([]); return undefined; }
    const t = setTimeout(() => bb.vendors(form.company, vq).then(r => setVendors(r.vendors)).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [vq, form?.company]);

  const r = meta.rights;
  const editable = r.review && bill && !STICKY.has(bill.status) && bill.status !== 'received';
  const category = meta.categories.find(c => c.id === form?.category_id);
  const blocks = (bill?.issues || []).filter(i => i.severity === 'block');
  const warns = (bill?.issues || []).filter(i => i.severity === 'warn');

  const accountsSorted = useMemo(() => {
    const all = look?.accounts || [];
    const byType = {};
    for (const a of all) (byType[a.type || 'other'] = byType[a.type || 'other'] || []).push(a);
    return Object.entries(byType).sort(([a], [b]) => (a === 'expense' ? -1 : b === 'expense' ? 1 : a.localeCompare(b)));
  }, [look]);

  // ── Changes since the bill was loaded ─────────────────────────────────────
  function changes() {
    const c = {};
    const fields = {};
    for (const [k, v] of Object.entries(form.fields)) if (String(v ?? '') !== String(bill.fields[k] ?? '')) fields[k] = v;
    if (Object.keys(fields).length) c.fields = fields;
    if (form.company !== (bill.company || '')) c.company = form.company;
    if ((form.vendor?.id || '') !== (bill.vendor?.id || '')) c.vendor = form.vendor ? { id: form.vendor.id } : null;
    if (form.category_id !== (bill.category?.id || '')) c.category_id = form.category_id;
    const oldLines = (bill.lines || []).map(l => JSON.stringify([l.id, l.description || '', l.hsn_sac || '', l.amount ?? '', l.account?.id || '', l.tax?.id || '']));
    const newLines = form.lines.map(l => JSON.stringify([l.id, l.description, l.hsn_sac, l.amount, l.account_id, l.tax_id]));
    if (JSON.stringify(oldLines) !== JSON.stringify(newLines)) { c.lines = form.lines; c.remember = { accounts: remember }; }
    if (form.branch_id !== (bill.bill_level?.branch?.id || '')) c.bill_level = { branch_id: form.branch_id };
    const cf = {};
    for (const [k, v] of Object.entries(form.cat_fields)) {
      const before = bill.cat_field_state?.[k]?.value ?? '';
      if (JSON.stringify(v ?? '') !== JSON.stringify(before)) cf[k] = v;
    }
    if (Object.keys(cf).length) c.cat_fields = cf;
    if (form.remember_fields.length) c.remember = { ...(c.remember || {}), fields: form.remember_fields };
    return c;
  }
  const dirty = form && bill && Object.keys(changes()).length > 0;

  async function act(label, fn, msg) {
    setBusy(label); setError(''); setOk('');
    try {
      const res = await fn();
      if (res?.bill) reset(res.bill);
      if (msg) setOk(typeof msg === 'function' ? msg(res) : msg);
      onSaved?.();
    } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  }
  const save = () => act('save', () => bb.edit(id, changes()), 'Saved — the bill was checked again');
  const action = (a, extra, msg) => act(a, () => bb.action(id, a, extra), msg);

  if (!bill || !form) {
    return <Shell onClose={onClose}><div style={S.center}>{error || 'Loading…'}</div></Shell>;
  }

  const setField = (k, v) => setForm(f => ({ ...f, fields: { ...f.fields, [k]: v } }));
  const setLine = (i, k, v) => setForm(f => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  const lineSum = form.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const isPdf = bill.file?.type === 'application/pdf';
  const co = meta.companies.find(c => c.id === bill.company);

  return (
    <Shell onClose={onClose} wide>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, padding: '0.9rem 1.1rem', borderBottom: '1px solid #DFE7E3', position: 'sticky', top: 0, background: '#fff', zIndex: 2 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: '1rem' }}>{bill.fields?.invoice_number || bill.source_ref?.attachment_name}</span>
            <StatusPill status={bill.status} statuses={meta.statuses} />
          </div>
          <div style={S.small}>{bill.id} · {bill.vendor?.name || bill.fields?.vendor_name || 'vendor ?'} · {money(bill.fields?.total, bill.fields?.currency)}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {r.draft && bill.status === 'ready' && !dirty && (
            <button style={S.primary} disabled={!!busy} onClick={() => act('draft', () => bb.draft(id), res => `Zoho draft ${res.bill.zoho?.bill_number || ''} created${res.bill.zoho?.attachment && res.bill.zoho.attachment !== 'attached' ? ` — original ${res.bill.zoho.attachment}` : ''}`)}>
              <Send size={13} /> {busy === 'draft' ? 'Creating…' : 'Create Zoho draft'}
            </button>
          )}
          {bill.zoho?.url && <a href={bill.zoho.url} target="_blank" rel="noreferrer" style={{ ...S.btn, textDecoration: 'none' }}>Open in Zoho <ExternalLink size={12} /></a>}
          {editable && dirty && <button style={S.primary} disabled={!!busy} onClick={save}><Check size={13} /> {busy === 'save' ? 'Saving…' : 'Save changes'}</button>}
          {editable && dirty && <button style={S.ghost} onClick={() => reset(bill)}>Undo changes</button>}
          <button style={S.ghost} onClick={onClose}><X size={14} /></button>
        </div>
      </div>

      <div style={{ padding: '0.9rem 1.1rem' }}>
        <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
        {bill.status === 'received' && <div style={S.notice}>Reading the bill… this refreshes by itself.</div>}
        {bill.zoho?.not_draft && <div style={S.error}>Zoho created this bill with status "{bill.zoho.status}", not as a draft. Check it in Zoho now. Draft creation has been stopped for {co?.name} until the draft test passes again.</div>}
        {bill.processing_error && <div style={S.error}>{bill.processing_error} {r.review && <button style={{ ...S.ghost, marginLeft: 8 }} onClick={() => action('retry', {}, 'Retried')}>Retry</button>}</div>}

        {/* Issues */}
        {(blocks.length > 0 || warns.length > 0) && (
          <div style={{ ...S.card, borderColor: blocks.some(i => !i.acked) ? '#FDE68A' : '#DFE7E3' }}>
            <div style={S.cardBody}>
              {blocks.map((i, k) => (
                <div key={`b${k}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.8rem', color: i.acked ? '#15803D' : '#B45309', marginBottom: 4 }}>
                  <span>{i.acked ? '✓' : '●'}</span><span style={{ flex: 1 }}>{i.message}</span>
                  {i.ackable && !i.acked && editable && <button style={S.btn} onClick={() => action('ack', { key: i.code }, 'Confirmed')}>{ACK_LABEL[i.code] || 'Confirm'}</button>}
                </div>
              ))}
              {warns.map((i, k) => <div key={`w${k}`} style={{ fontSize: '0.76rem', color: '#5D6C7B', marginBottom: 3 }}>ⓘ {i.message}</div>)}
            </div>
          </div>
        )}

        {/* Duplicate */}
        {bill.duplicate?.certainty && (
          <div style={{ ...S.card, borderColor: '#FECDD3' }}>
            <div style={S.cardBody}>
              <div style={{ color: '#9F1239', fontWeight: 600, fontSize: '0.82rem', marginBottom: 6 }}>⧉ {bill.duplicate.reason}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {bill.duplicate.of && <button style={S.ghost} onClick={() => onOpen?.(bill.duplicate.of)}>Open {bill.duplicate.of}</button>}
                {editable && <button style={S.btn} onClick={() => { const why = window.prompt('Why is this not a duplicate? (kept in the audit trail)'); if (why !== null) action('dismiss_duplicate', { reason: why }, 'Marked as not a duplicate'); }}>Not a duplicate</button>}
                {editable && ['possible', 'revised'].includes(bill.duplicate.certainty) && <button style={S.danger} onClick={() => action('confirm_duplicate', {}, 'Marked as duplicate')}>It is a duplicate</button>}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.25fr)', gap: '1rem' }}>
          {/* Left: original + source */}
          <div>
            <div style={S.card}>
              <div style={S.cardHead}>
                <span style={S.cardTitle}><FileText size={13} style={{ verticalAlign: -2 }} /> Original bill</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <a href={bb.fileUrl(id)} target="_blank" rel="noreferrer" style={{ ...S.ghost, textDecoration: 'none' }}>Open <ExternalLink size={11} /></a>
                  <a href={bb.fileUrl(id, true)} style={{ ...S.ghost, textDecoration: 'none' }}>Download</a>
                </span>
              </div>
              {isPdf
                ? <iframe title="bill" src={bb.fileUrl(id)} style={{ width: '100%', height: 560, border: 'none', borderRadius: '0 0 12px 12px' }} />
                : <img alt="bill" src={bb.fileUrl(id)} style={{ width: '100%', borderRadius: '0 0 12px 12px' }} />}
            </div>
            <div style={S.card}>
              <div style={S.cardHead}><span style={S.cardTitle}>Source</span>{bill.source === 'email' ? <Tag tone="blue">Email</Tag> : <Tag tone="violet">ERP upload</Tag>}</div>
              <div style={{ ...S.cardBody, fontSize: '0.78rem', lineHeight: 1.6 }}>
                {bill.source === 'email' ? <>
                  <div><b>Mailbox:</b> {bill.source_ref.mailbox} ({meta.team.find(m => m.id === bill.member_id)?.name || '—'})</div>
                  <div><b>Received:</b> {dtm(bill.source_ref.received_at)}</div>
                  <div><b>From:</b> {bill.source_ref.from}</div>
                  <div><b>Subject:</b> {bill.source_ref.subject}</div>
                  <div style={{ ...S.small, wordBreak: 'break-all' }}>Message ID: {bill.source_ref.internet_message_id || bill.source_ref.message_id}</div>
                  {bill.source_ref.body_preview && <div style={{ marginTop: 6, color: '#5D6C7B', whiteSpace: 'pre-wrap' }}>{bill.source_ref.body_preview.slice(0, 600)}</div>}
                </> : <>
                  <div><b>Uploaded by:</b> {bill.source_ref.uploaded_by} on {dtm(bill.created_at)}</div>
                  <div><b>ERP reference:</b> {bill.source_ref.erp_ref || '—'}</div>
                  <div><b>Responsible:</b> {meta.team.find(m => m.id === bill.member_id)?.name || '—'}</div>
                </>}
                <div><b>File:</b> {bill.source_ref.attachment_name} ({Math.round((bill.file?.size || 0) / 1024)} KB)</div>
              </div>
            </div>
            {bill.extraction && (
              <div style={S.card}>
                <div style={S.cardHead}><span style={S.cardTitle}>How it was read</span>
                  {editable && <button style={S.ghost} onClick={() => { if (window.confirm('Read the bill again from the original file? Changes made by hand on this bill are discarded.')) action('reprocess', {}, 'Read again'); }}><RotateCcw size={12} /> Read again</button>}
                </div>
                <div style={{ ...S.cardBody, fontSize: '0.76rem', lineHeight: 1.6 }}>
                  <div><b>Reader:</b> {bill.extraction.engine === 'claude' ? 'Claude' : bill.extraction.text_method === 'ocr' ? 'Built-in (OCR of a scan)' : 'Built-in (PDF text)'} · confidence {bill.extraction.confidence} · {dtm(bill.extraction.at)}</div>
                  <div><b>Document:</b> {meta.doc_types[bill.doc_type?.value] || bill.doc_type?.value} — {bill.doc_type?.basis}</div>
                  {bill.not_bill?.reason && <div style={{ color: '#64748B' }}><b>Not a bill:</b> {bill.not_bill.reason}{bill.not_bill.by ? ` (${bill.not_bill.by})` : ''}</div>}
                  <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                    {editable && bill.status !== 'not_bill' && <button style={S.ghost} onClick={() => { const why = window.prompt('Why is this not a bill? (e.g. quotation, statement)'); if (why !== null) action('not_bill', { reason: why || 'Marked as not a bill' }, 'Marked as not a bill'); }}>Not a bill</button>}
                    {r.review && bill.status === 'not_bill' && <button style={S.btn} onClick={() => action('is_bill', {}, 'Treated as a bill')}>It is a bill</button>}
                    <button style={S.ghost} onClick={() => setShowText(s => !s)}>{showText ? 'Hide' : 'Show'} text read</button>
                  </div>
                  {showText && <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.7rem', background: '#F9F9F9', padding: 8, borderRadius: 6, maxHeight: 260, overflow: 'auto' }}>{bill.extraction.text_sample || '(no text layer — read from the image)'}</pre>}
                </div>
              </div>
            )}
          </div>

          {/* Right: details */}
          <div>
            <div style={S.card}>
              <div style={S.cardHead}><span style={S.cardTitle}>Company &amp; vendor</span></div>
              <div style={{ ...S.cardBody, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Company / Zoho organisation">
                  <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={!editable} value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value, vendor: null, lines: f.lines.map(l => ({ ...l, account_id: '', tax_id: '' })), branch_id: '' }))}>
                    <option value="">— choose —</option>
                    {meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <div style={S.small}>{bill.company_basis}</div>
                </Field>
                <Field label="Zoho vendor">
                  <div style={{ fontWeight: 600, fontSize: '0.82rem' }}>{form.vendor?.name || <span style={{ color: '#B45309' }}>Not chosen</span>}</div>
                  {bill.vendor?.basis && (form.vendor?.id || '') === (bill.vendor?.id || '') && <div style={S.small}>{bill.vendor.basis}</div>}
                  {editable && form.company && <>
                    {(bill.vendor?.candidates || []).length > 0 && !form.vendor && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '4px 0' }}>
                        {bill.vendor.candidates.map(c => <button key={c.id} style={{ ...S.ghost, padding: '2px 6px', fontSize: '0.7rem' }} onClick={() => setForm(f => ({ ...f, vendor: { id: c.id, name: c.name } }))}>{c.name}{c.gstin ? ` · ${c.gstin}` : ''}{c.status === 'inactive' ? ' (inactive)' : ''}</button>)}
                      </div>
                    )}
                    <input style={{ ...S.input, width: '100%', marginTop: 4 }} placeholder="Search Zoho vendors (name / GSTIN)" value={vq} onChange={e => setVq(e.target.value)} />
                    {vendors.length > 0 && (
                      <div style={{ border: '1px solid #DFE7E3', borderRadius: 6, maxHeight: 160, overflow: 'auto', marginTop: 2 }}>
                        {vendors.map(v => <div key={v.id} onClick={() => { setForm(f => ({ ...f, vendor: { id: v.id, name: v.name } })); setVq(''); setVendors([]); }} style={{ padding: '4px 8px', fontSize: '0.75rem', cursor: 'pointer', borderBottom: '1px solid #F2F2F2' }}>{v.name} <span style={S.small}>{v.gstin}{v.status === 'inactive' ? ' · inactive' : ''}</span></div>)}
                      </div>
                    )}
                  </>}
                </Field>
                <Field label="Vendor name on bill"><input style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.vendor_name || ''} onChange={e => setField('vendor_name', e.target.value)} /></Field>
                <Field label="Vendor GSTIN"><input style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.vendor_gstin || ''} onChange={e => setField('vendor_gstin', e.target.value.toUpperCase())} /></Field>
              </div>
            </div>

            <div style={S.card}>
              <div style={S.cardHead}><span style={S.cardTitle}>Invoice</span><span style={S.small}>Billed to GSTIN {bill.fields.buyer_gstin || '—'}</span></div>
              <div style={{ ...S.cardBody, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <Field label="Invoice no."><input style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.invoice_number || ''} onChange={e => setField('invoice_number', e.target.value)} /></Field>
                <Field label="Invoice date"><input type="date" style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.invoice_date || ''} onChange={e => setField('invoice_date', e.target.value)} /></Field>
                <Field label="Due date"><input type="date" style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.due_date || ''} onChange={e => setField('due_date', e.target.value)} /></Field>
                {NUM_FIELDS.map(([k, label]) => (
                  <Field key={k} label={label}><input type="number" step="0.01" style={{ ...S.input, width: '100%', textAlign: 'right', fontWeight: k === 'total' ? 700 : 400 }} disabled={!editable} value={form.fields[k] ?? ''} onChange={e => setField(k, e.target.value)} /></Field>
                ))}
                <Field label="Currency"><input style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.currency || 'INR'} onChange={e => setField('currency', e.target.value.toUpperCase())} /></Field>
                {form.fields.currency && form.fields.currency !== 'INR' && <Field label="Exchange rate"><input type="number" style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.exchange_rate ?? ''} onChange={e => setField('exchange_rate', e.target.value)} /></Field>}
                <Field label="PO number"><input style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.po_number || ''} onChange={e => setField('po_number', e.target.value)} /></Field>
                <Field label="Service from"><input type="date" style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.service_period_from || ''} onChange={e => setField('service_period_from', e.target.value)} /></Field>
                <Field label="Service to"><input type="date" style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.service_period_to || ''} onChange={e => setField('service_period_to', e.target.value)} /></Field>
                <Field label="Description" style={{ gridColumn: '1 / -1' }}><input style={{ ...S.input, width: '100%' }} disabled={!editable} value={form.fields.description || ''} onChange={e => setField('description', e.target.value)} /></Field>
              </div>
            </div>

            <div style={S.card}>
              <div style={S.cardHead}><span style={S.cardTitle}>Bill category</span><span style={S.small}>Workflow &amp; ownership — not the expense account</span></div>
              <div style={S.cardBody}>
                <select style={{ ...S.select, maxWidth: 360 }} disabled={!editable} value={form.category_id} onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}>
                  <option value="">— choose —</option>
                  {meta.categories.filter(c => c.active !== false || c.id === form.category_id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {bill.category?.source && <Tag tone={bill.category.source === 'manual' ? 'green' : 'grey'}>{SOURCE_LABEL[bill.category.source]}</Tag>}
                <div style={{ ...S.small, marginTop: 4 }}>{bill.category?.basis}</div>
                {!form.category_id && bill.category?.suggested && editable && <button style={{ ...S.btn, marginTop: 4 }} onClick={() => setForm(f => ({ ...f, category_id: bill.category.suggested }))}>Use {meta.categories.find(c => c.id === bill.category.suggested)?.name}</button>}
              </div>
            </div>

            <div style={S.card}>
              <div style={S.cardHead}>
                <span style={S.cardTitle}>Lines, expense accounts &amp; GST</span>
                <span style={{ ...S.small, color: Math.abs(lineSum - (Number(form.fields.sub_total) || 0)) > 1 ? '#B45309' : '#9BA8B0' }}>Lines {money(lineSum)} · taxable {money(form.fields.sub_total)}</span>
              </div>
              <div style={S.cardBody}>
                {!form.company && <div style={S.muted}>Choose the company to see its Zoho accounts.</div>}
                {form.lines.map((l, i) => {
                  const bl = (bill.lines || []).find(x => x.id === l.id) || {};
                  const opts = bl.account_options || [];
                  return (
                    <div key={l.id || i} style={{ border: '1px solid #EEF2F0', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 120px 28px', gap: 6 }}>
                        <input style={S.input} disabled={!editable} placeholder="Description" value={l.description} onChange={e => setLine(i, 'description', e.target.value)} />
                        <input style={S.input} disabled={!editable} placeholder="HSN/SAC" value={l.hsn_sac} onChange={e => setLine(i, 'hsn_sac', e.target.value)} />
                        <input type="number" step="0.01" style={{ ...S.input, textAlign: 'right' }} disabled={!editable} placeholder="Amount" value={l.amount} onChange={e => setLine(i, 'amount', e.target.value)} />
                        {editable && form.lines.length > 1 ? <button title="Remove line" style={{ ...S.ghost, padding: 4 }} onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}><Trash2 size={12} /></button> : <span />}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
                        <div>
                          <select style={{ ...S.select, width: '100%', maxWidth: 'none', borderColor: l.account_id ? '#DFE7E3' : '#FDE68A' }} disabled={!editable || !look} value={l.account_id} onChange={e => setLine(i, 'account_id', e.target.value)}>
                            <option value="">— expense account —</option>
                            {opts.length > 0 && <optgroup label="Used for this vendor before">{opts.map(a => <option key={`o${a.id}`} value={a.id}>{a.name}{a.count ? ` (${a.count}×)` : ''}</option>)}</optgroup>}
                            {accountsSorted.map(([type, list]) => <optgroup key={type} label={type.replace(/_/g, ' ')}>{list.map(a => <option key={a.id} value={a.id}>{a.name}{a.code ? ` · ${a.code}` : ''}</option>)}</optgroup>)}
                            {l.account_id && !look?.accounts?.some(a => a.id === l.account_id) && <option value={l.account_id}>{bl.account?.name || l.account_id}</option>}
                          </select>
                          {l.account_id === (bl.account?.id || '') && bl.account ? <div style={S.small}><Tag tone={bl.account.source === 'manual' ? 'green' : bl.account.source === 'mapping' ? 'blue' : 'grey'}>{SOURCE_LABEL[bl.account.source]}</Tag> {bl.account.basis}</div>
                            : !l.account_id && bl.account_issue ? <div style={{ ...S.small, color: '#B45309' }}>{bl.account_issue}</div> : null}
                        </div>
                        <div>
                          <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={!editable || !look} value={l.tax_id} onChange={e => setLine(i, 'tax_id', e.target.value)}>
                            <option value="">— no GST —</option>
                            {(look?.taxes || []).filter(t => !t.inactive || t.id === l.tax_id).map(t => <option key={t.id} value={t.id}>{t.name} ({t.percentage}%)</option>)}
                          </select>
                          {l.tax_id === (bl.tax?.id || '') && bl.tax ? <div style={S.small}><Tag tone={bl.tax.source === 'manual' ? 'green' : bl.tax.source === 'mapping' ? 'blue' : 'grey'}>{SOURCE_LABEL[bl.tax.source]}</Tag> {bl.tax.basis}</div>
                            : !l.tax_id && bl.tax_issue ? <div style={{ ...S.small, color: '#B45309' }}>{bl.tax_issue}</div> : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {editable && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <button style={S.ghost} onClick={() => setForm(f => ({ ...f, lines: [...f.lines, { id: '', description: '', hsn_sac: '', amount: '', account_id: '', tax_id: '' }] }))}><Plus size={12} /> Add line</button>
                  <label style={{ ...S.muted, display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember account &amp; GST choices for this vendor (mapping)
                  </label>
                </div>}
              </div>
            </div>

            <div style={S.card}>
              <div style={S.cardHead}><span style={S.cardTitle}>Branch &amp; TDS</span></div>
              <div style={{ ...S.cardBody, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Branch">
                  <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={!editable || !look} value={form.branch_id} onChange={e => setForm(f => ({ ...f, branch_id: e.target.value }))}>
                    <option value="">— not set —</option>
                    {(look?.branches || []).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  {bill.bill_level?.branch?.basis && <div style={S.small}>{bill.bill_level.branch.basis}</div>}
                </Field>
                <Field label="TDS">
                  <div style={{ fontSize: '0.8rem' }}>{bill.bill_level?.tds?.id ? bill.bill_level.tds.name : 'Not applied — the reviewer applies TDS in Zoho if due'}</div>
                  {bill.bill_level?.tds?.basis && <div style={S.small}>{bill.bill_level.tds.basis}</div>}
                  {editable && bill.bill_level?.tds?.id && <button style={{ ...S.ghost, marginTop: 4 }} onClick={() => act('save', () => bb.edit(id, { bill_level: { tds_tax_id: '' } }), 'TDS removed')}>Remove TDS</button>}
                </Field>
              </div>
            </div>

            {category && category.fields.length > 0 && (
              <div style={S.card}>
                <div style={S.cardHead}><span style={S.cardTitle}>{category.name} — required details</span></div>
                <div style={{ ...S.cardBody, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {category.fields.map(def => {
                    const st = bill.cat_field_state?.[def.id] || {};
                    const v = form.cat_fields[def.id] ?? '';
                    const setV = val => setForm(f => ({ ...f, cat_fields: { ...f.cat_fields, [def.id]: val } }));
                    const refList = def.reference === 'zoho_branch' ? look?.branches : def.reference === 'zoho_project' ? look?.projects : null;
                    return (
                      <Field key={def.id} label={`${def.label}${def.mandatory ? ' *' : ''}`}>
                        {def.type === 'dropdown' ? (
                          <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={!editable} value={v} onChange={e => setV(e.target.value)}>
                            <option value="">—</option>{def.options.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : def.type === 'reference' && refList ? (
                          <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={!editable} value={v?.id || ''} onChange={e => { const x = refList.find(y => y.id === e.target.value); setV(x ? { id: x.id, name: x.name } : ''); }}>
                            <option value="">—</option>{refList.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </select>
                        ) : (
                          <input type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'} style={{ ...S.input, width: '100%' }} disabled={!editable}
                            value={typeof v === 'object' ? v?.name || '' : v} onChange={e => setV(e.target.value)} />
                        )}
                        {def.description && <div style={S.small}>{def.description}</div>}
                        {st.error ? <div style={{ ...S.small, color: '#B45309' }}>{st.error}</div> : st.source ? <div style={S.small}>{SOURCE_LABEL[st.source] || st.source}</div> : null}
                        {editable && def.source === 'mapping' && (
                          <label style={{ ...S.small, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
                            <input type="checkbox" checked={form.remember_fields.includes(def.id)} onChange={e => setForm(f => ({ ...f, remember_fields: e.target.checked ? [...f.remember_fields, def.id] : f.remember_fields.filter(x => x !== def.id) }))} /> Remember for this vendor
                          </label>
                        )}
                      </Field>
                    );
                  })}
                </div>
              </div>
            )}

            {(bill.zoho?.bill_id || bill.zoho?.previous || bill.reviewed) && (
              <div style={S.card}>
                <div style={S.cardHead}><span style={S.cardTitle}>Zoho Books</span></div>
                <div style={{ ...S.cardBody, fontSize: '0.78rem', lineHeight: 1.6 }}>
                  {bill.zoho?.bill_id && <>
                    <div><b>Draft:</b> {bill.zoho.bill_number} · status <b>{bill.zoho.status}</b> · created {dtm(bill.zoho.created_at)} by {bill.zoho.created_by}</div>
                    <div><b>Original:</b> {bill.zoho.attachment}</div>
                    {bill.zoho.check && <div style={{ color: '#B45309' }}>{bill.zoho.check}</div>}
                    <div style={S.small}>Status last checked {dtm(bill.zoho.last_checked)}{bill.zoho.check_error ? ` — ${bill.zoho.check_error}` : ''}</div>
                  </>}
                  {bill.reviewed && <div style={{ color: '#15803D' }}><b>Reviewed:</b> Zoho status {bill.reviewed.zoho_status} {bill.reviewed.by ? `(last changed by ${bill.reviewed.by})` : ''} · seen {dtm(bill.reviewed.at)}</div>}
                  {bill.zoho?.previous && <div style={{ color: '#B45309' }}>Earlier draft {bill.zoho.previous.bill_number} was deleted in Zoho.</div>}
                  {bill.status === 'draft_created' && <div style={{ ...S.small, marginTop: 4 }}>The team reviews this draft in Zoho and moves it on there. This page notes the change on its next Zoho status check.</div>}
                </div>
              </div>
            )}

            <div style={S.card}>
              <div style={S.cardHead}><span style={S.cardTitle}>Audit trail</span></div>
              <div style={{ ...S.cardBody, maxHeight: 280, overflow: 'auto' }}>
                {[...(bill.audit || [])].reverse().map((a, k) => (
                  <div key={k} style={{ fontSize: '0.74rem', borderBottom: '1px solid #F2F2F2', padding: '4px 0' }}>
                    <span style={S.small}>{dtm(a.at)}</span> · <b>{a.by}</b> · {a.action.replace(/_/g, ' ')}
                    <div style={{ color: '#5D6C7B' }}>{a.detail}</div>
                  </div>
                ))}
                {r.review && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <input style={{ ...S.input, flex: 1 }} placeholder="Add a note to the trail" value={note} onChange={e => setNote(e.target.value)} />
                    <button style={S.btn} disabled={!note.trim()} onClick={() => act('note', () => bb.action(id, 'note', { text: note }), 'Note added').then(() => setNote(''))}>Add</button>
                  </div>
                )}
              </div>
            </div>
            <div style={S.small}>Created {dt(bill.created_at)} · updated {dtm(bill.updated_at)}</div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children, onClose, wide }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,18,20,0.25)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: wide ? 'min(1280px, 96vw)' : 520, height: '100%', overflow: 'auto', background: '#F9F9F9', boxShadow: '-6px 0 24px rgba(0,18,20,0.15)' }}>
        {children}
      </div>
    </div>
  );
}
