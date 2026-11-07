import React, { useState, useEffect } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { bb, errMsg } from './bbApi';
import { S, Tag, Field, Msg } from './ui';

// ─── Bill categories and their required fields ────────────────────────────────
// Categories decide workflow and ownership (and which extra details a bill needs before booking);
// the expense account is chosen separately, per line. Nothing here is pre-filled with accounting or
// tax rules — each category's fields are defined by the user.

const TYPE_LABEL = { text: 'Text', number: 'Number', date: 'Date', dropdown: 'Dropdown', reference: 'Reference (Zoho list)' };
const SOURCE_LABEL = { extraction: 'Read from the bill', history: "Vendor's earlier Zoho bills", mapping: 'Saved mapping (per vendor)', team: 'Team input' };
const REF_LABEL = { zoho_branch: 'Zoho branch', zoho_project: 'Zoho project', zoho_vendor: 'Zoho vendor' };
const TARGET_LABEL = { none: 'Not sent to Zoho', bill_custom_field: 'Bill custom field', bill_field: 'Bill field', line_field: 'Each line field' };
const KEY_LABEL = { po_number: 'PO number', service_period_from: 'Service period from', service_period_to: 'Service period to', place_of_supply: 'Place of supply', description: 'Description', due_date: 'Due date', irn: 'IRN', buyer_gstin: 'Billed-to GSTIN' };
const newField = () => ({ label: '', description: '', type: 'text', options: [], reference: '', mandatory: false, default: '', source: 'team', extraction_key: '', zoho: { target: 'none', key: '' }, validation: { regex: '', min: null, max: null, message: '' } });

export default function CategoriesTab({ meta, reloadMeta }) {
  const [cats, setCats] = useState(meta.categories);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const can = meta.rights.config;
  useEffect(() => { setCats(meta.categories); }, [meta.categories]);
  const dirty = JSON.stringify(cats) !== JSON.stringify(meta.categories);

  const upd = (i, patch) => setCats(cs => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const updField = (i, k, patch) => setCats(cs => cs.map((c, j) => (j === i ? { ...c, fields: c.fields.map((f, n) => (n === k ? { ...f, ...patch } : f)) } : c)));

  async function save() {
    setBusy(true); setError(''); setOk('');
    try { await bb.saveCategories(cats); await reloadMeta(); setOk('Categories saved — new bills use them; open bills are checked again when next changed'); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <div>
      <Msg error={error} ok={ok} onClose={() => { setError(''); setOk(''); }} />
      <div style={S.notice}>
        A <b>bill category</b> decides who handles a bill and which extra details it needs. It is <b>not</b> the expense account — accounts are chosen per line from the vendor's earlier bills, confirmed mappings or the team.
        Category-specific fields are empty until you define them below.
      </div>
      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.cardTitle}>Bill categories</span>
          {can && <div style={{ display: 'flex', gap: 6 }}>
            <button style={S.btn} onClick={() => { setCats([...cats, { id: '', name: 'New category', active: true, keywords: [], vendor_category_aliases: [], fields: [] }]); setOpen(cats.length); }}><Plus size={13} /> Add category</button>
            {dirty && <button style={S.primary} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save categories'}</button>}
            {dirty && <button style={S.ghost} onClick={() => setCats(meta.categories)}>Undo</button>}
          </div>}
        </div>
        {cats.map((c, i) => (
          <div key={c.id || `new${i}`} style={{ borderBottom: '1px solid #F0F2F1' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.6rem 1.1rem', cursor: 'pointer' }} onClick={() => setOpen(open === i ? null : i)}>
              {open === i ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span style={{ fontWeight: 600, fontSize: '0.84rem', flex: 1, opacity: c.active ? 1 : 0.5 }}>{c.name}</span>
              <span style={S.small}>{c.keywords.length} keywords · {c.fields.length} field(s)</span>
              {!c.active && <Tag>Inactive</Tag>}
            </div>
            {open === i && (
              <div style={{ padding: '0 1.1rem 1rem 2.4rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
                  <Field label="Name"><input style={{ ...S.input, width: '100%' }} disabled={!can} value={c.name} onChange={e => upd(i, { name: e.target.value })} /></Field>
                  <Field label="Keywords that point to this category (comma separated)">
                    <textarea rows={2} style={{ ...S.input, width: '100%' }} disabled={!can} value={c.keywords.join(', ')} onChange={e => upd(i, { keywords: e.target.value.split(',').map(s => s.trimStart()) })} />
                  </Field>
                  <Field label="Zoho vendor categories that point here">
                    <input style={{ ...S.input, width: '100%' }} disabled={!can} value={(c.vendor_category_aliases || []).join(', ')} onChange={e => upd(i, { vendor_category_aliases: e.target.value.split(',').map(s => s.trimStart()) })} placeholder="e.g. HK Salary (Recurring)" />
                  </Field>
                  <Field label="Status">
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem' }}><input type="checkbox" disabled={!can} checked={c.active} onChange={e => upd(i, { active: e.target.checked })} /> Active</label>
                  </Field>
                </div>

                <div style={{ marginTop: 12, fontWeight: 700, fontSize: '0.8rem' }}>Required details for {c.name}</div>
                {!c.fields.length && <div style={{ ...S.muted, margin: '4px 0' }}>No category-specific fields yet.</div>}
                {c.fields.map((f, k) => (
                  <div key={k} style={{ border: '1px solid #EEF2F0', borderRadius: 8, padding: 10, margin: '8px 0', background: '#FCFDFC' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                      <Field label="Field name"><input style={{ ...S.input, width: '100%' }} disabled={!can} value={f.label} onChange={e => updField(i, k, { label: e.target.value })} /></Field>
                      <Field label="Type">
                        <select style={{ ...S.select, width: '100%' }} disabled={!can} value={f.type} onChange={e => updField(i, k, { type: e.target.value })}>
                          {meta.field_meta.types.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                        </select>
                      </Field>
                      <Field label="Value comes from">
                        <select style={{ ...S.select, width: '100%' }} disabled={!can} value={f.source} onChange={e => updField(i, k, { source: e.target.value })}>
                          {meta.field_meta.sources.map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                        </select>
                      </Field>
                      <Field label="Mandatory">
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem' }}><input type="checkbox" disabled={!can} checked={f.mandatory} onChange={e => updField(i, k, { mandatory: e.target.checked })} /> Required before drafting</label>
                      </Field>
                      <Field label="Description (shown to the team)" style={{ gridColumn: 'span 2' }}><input style={{ ...S.input, width: '100%' }} disabled={!can} value={f.description} onChange={e => updField(i, k, { description: e.target.value })} /></Field>
                      {f.type === 'dropdown' && <Field label="Allowed options (comma separated)" style={{ gridColumn: 'span 2' }}><input style={{ ...S.input, width: '100%' }} disabled={!can} value={(f.options || []).join(', ')} onChange={e => updField(i, k, { options: e.target.value.split(',').map(s => s.trimStart()) })} /></Field>}
                      {f.type === 'reference' && <Field label="Refers to"><select style={{ ...S.select, width: '100%' }} disabled={!can} value={f.reference || ''} onChange={e => updField(i, k, { reference: e.target.value })}><option value="">—</option>{meta.field_meta.references.map(x => <option key={x} value={x}>{REF_LABEL[x]}</option>)}</select></Field>}
                      {f.source === 'extraction' && <Field label="Bill detail"><select style={{ ...S.select, width: '100%' }} disabled={!can} value={f.extraction_key || ''} onChange={e => updField(i, k, { extraction_key: e.target.value })}><option value="">—</option>{meta.field_meta.extraction_keys.map(x => <option key={x} value={x}>{KEY_LABEL[x] || x}</option>)}</select></Field>}
                      <Field label="Default value"><input style={{ ...S.input, width: '100%' }} disabled={!can} value={f.default || ''} onChange={e => updField(i, k, { default: e.target.value })} /></Field>
                      <Field label="Zoho Books field">
                        <select style={{ ...S.select, width: '100%' }} disabled={!can} value={f.zoho?.target || 'none'} onChange={e => updField(i, k, { zoho: { ...f.zoho, target: e.target.value } })}>
                          {meta.field_meta.zoho_targets.map(x => <option key={x} value={x}>{TARGET_LABEL[x]}</option>)}
                        </select>
                      </Field>
                      {f.zoho?.target && f.zoho.target !== 'none' && <Field label="Zoho API name"><input style={{ ...S.input, width: '100%' }} disabled={!can} value={f.zoho.key || ''} onChange={e => updField(i, k, { zoho: { ...f.zoho, key: e.target.value } })} placeholder="e.g. cf_service_month or branch_id" /></Field>}
                      <Field label="Validation pattern (optional)"><input style={{ ...S.input, width: '100%' }} disabled={!can} value={f.validation?.regex || ''} onChange={e => updField(i, k, { validation: { ...f.validation, regex: e.target.value } })} placeholder="regular expression" /></Field>
                      {f.type === 'number' && <>
                        <Field label="Minimum"><input type="number" style={{ ...S.input, width: '100%' }} disabled={!can} value={f.validation?.min ?? ''} onChange={e => updField(i, k, { validation: { ...f.validation, min: e.target.value } })} /></Field>
                        <Field label="Maximum"><input type="number" style={{ ...S.input, width: '100%' }} disabled={!can} value={f.validation?.max ?? ''} onChange={e => updField(i, k, { validation: { ...f.validation, max: e.target.value } })} /></Field>
                      </>}
                      <Field label="Message when invalid"><input style={{ ...S.input, width: '100%' }} disabled={!can} value={f.validation?.message || ''} onChange={e => updField(i, k, { validation: { ...f.validation, message: e.target.value } })} /></Field>
                    </div>
                    {can && <button style={{ ...S.danger, marginTop: 8 }} onClick={() => upd(i, { fields: c.fields.filter((_, n) => n !== k) })}><Trash2 size={12} /> Remove field</button>}
                  </div>
                ))}
                {can && <button style={S.btn} onClick={() => upd(i, { fields: [...c.fields, newField()] })}><Plus size={12} /> Add field</button>}
                {can && !c.id && <button style={{ ...S.danger, marginLeft: 8 }} onClick={() => { setCats(cats.filter((_, j) => j !== i)); setOpen(null); }}>Remove new category</button>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
