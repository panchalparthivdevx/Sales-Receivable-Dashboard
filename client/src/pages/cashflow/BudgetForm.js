import React, { useEffect, useState } from 'react';
import { S, Field } from '../billbooking/ui';
import { cf, errMsg, inr } from './cfApi';
import { Modal } from './cfUi';

// ─── Add / edit a budget line or commitment (vendor, landlord or client known) ───

export default function BudgetForm({ meta, initial, branches, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [f, setF] = useState(() => ({
    company: initial?.company || (meta.companies.length === 1 ? meta.companies[0].id : 'devx'),
    category: initial?.category || 'rent', planned_month: initial?.planned_month || meta.current_month,
    amount: initial?.amount ?? '', branch: initial?.branch || '', vendor_id: initial?.vendor_id || '', vendor_name: initial?.vendor_name || '',
    client: initial?.client || '', period_label: initial?.period_label || '', connection: initial?.connection || '', notes: initial?.notes || '',
    expects_more_bills: !!initial?.expects_more_bills, pay_on: initial?.schedule?.[0]?.pay_on || '',
  }));
  const [vq, setVq] = useState('');
  const [vendors, setVendors] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const cat = meta.categories.find(c => c.key === f.category);
  const who = f.category === 'rent' ? 'Landlord / developer' : f.category === 'electricity' ? 'Electricity provider / billing vendor' : 'Broker / vendor';

  useEffect(() => {
    if (vq.length < 2) { setVendors([]); return undefined; }
    const t = setTimeout(() => cf.vendors(f.company, vq).then(d => setVendors(d.vendors)).catch(() => setVendors([])), 300);
    return () => clearTimeout(t);
  }, [vq, f.company]);

  async function submit() {
    setBusy(true); setErr('');
    try {
      const body = { company: f.company, category: f.category, planned_month: f.planned_month, amount: Number(f.amount), branch: f.branch, vendor_id: f.vendor_id, vendor_name: f.vendor_name,
        client: f.client, period_label: f.period_label, connection: f.connection, notes: f.notes, expects_more_bills: f.expects_more_bills };
      if (!editing && f.pay_on) body.schedule = [{ pay_on: f.pay_on, amount: Number(f.amount) }];
      if (editing) await cf.saveBudget(initial.id, body); else await cf.addBudget(body);
      onSaved();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={editing ? 'Edit budget line' : f.category === 'brokerage' ? 'Expected brokerage / budget line' : 'Add budget line'} sub="The finalised budget for a planned payment month. Name the vendor, landlord or client when you know it."
      onClose={onClose} footer={<><button type="button" style={S.ghost} onClick={onClose}>Cancel</button><button type="button" style={S.primary} disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {err && <div style={S.error}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Company">
          <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={editing} value={f.company} onChange={e => { set('company', e.target.value); set('vendor_id', ''); set('vendor_name', ''); }}>
            {meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Category">
          <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} disabled={editing} value={f.category} onChange={e => set('category', e.target.value)}>
            {meta.categories.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Planned payment month"><input type="month" style={{ ...S.input, width: '100%' }} value={f.planned_month} onChange={e => set('planned_month', e.target.value)} /></Field>
        <Field label={f.category === 'brokerage' ? 'Agreed / expected amount (₹)' : 'Finalised budget (₹)'}>
          <input type="number" min="0" style={{ ...S.input, width: '100%' }} value={f.amount} onChange={e => set('amount', e.target.value)} />
          {editing && Math.abs((initial.original_amount ?? initial.amount) - Number(f.amount || 0)) > 0.5 && <div style={S.small}>The original {inr(initial.original_amount ?? initial.amount)} is kept for comparison.</div>}
        </Field>
        <Field label="Branch">
          <input style={{ ...S.input, width: '100%' }} list="cf-branches" value={f.branch} onChange={e => set('branch', e.target.value)} placeholder="All branches" />
          <datalist id="cf-branches">{(branches || []).map(b => <option key={b} value={b} />)}</datalist>
        </Field>
        <Field label={`${who} (optional)`}>
          {f.vendor_id ? (
            <div style={{ fontSize: '0.8rem', paddingTop: 4 }}><b>{f.vendor_name}</b> <button type="button" style={{ ...S.ghost, padding: '1px 6px' }} onClick={() => { set('vendor_id', ''); set('vendor_name', ''); }}>change</button></div>
          ) : (
            <div style={{ position: 'relative' }}>
              <input style={{ ...S.input, width: '100%' }} value={vq} onChange={e => setVq(e.target.value)} placeholder="Search Zoho vendors" />
              {vendors.length > 0 && (
                <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 5, background: '#fff', border: '1px solid #DFE7E3', borderRadius: 6, maxHeight: 180, overflow: 'auto' }}>
                  {vendors.map(v => <div key={v.id} role="option" aria-selected="false" style={{ padding: '4px 8px', fontSize: '0.76rem', cursor: 'pointer' }}
                    onClick={e => { e.preventDefault(); set('vendor_id', v.id); set('vendor_name', v.name); setVq(''); setVendors([]); }}>{v.name}{v.category ? <span style={S.small}> · {v.category}</span> : null}</div>)}
                </div>
              )}
            </div>
          )}
        </Field>
        {f.category === 'brokerage' && <Field label="Client (brokerage payable for)"><input style={{ ...S.input, width: '100%' }} value={f.client} onChange={e => set('client', e.target.value)} placeholder="Client name" /></Field>}
        {f.category === 'rent' && <Field label="Rent period (optional)"><input style={{ ...S.input, width: '100%' }} value={f.period_label} onChange={e => set('period_label', e.target.value)} placeholder="e.g. Nov-26" /></Field>}
        {f.category === 'electricity' && <>
          <Field label="Connection / meter (optional)"><input style={{ ...S.input, width: '100%' }} value={f.connection} onChange={e => set('connection', e.target.value)} placeholder="Consumer or meter number" /></Field>
          <Field label="Billing period (optional)"><input style={{ ...S.input, width: '100%' }} value={f.period_label} onChange={e => set('period_label', e.target.value)} placeholder="e.g. Oct-26" /></Field>
        </>}
        {!editing && <Field label="Pay On date (optional)"><input type="date" style={{ ...S.input, width: '100%' }} value={f.pay_on} onChange={e => set('pay_on', e.target.value)} /></Field>}
        <Field label="More bills expected against it">
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem', paddingTop: 4 }}>
            <input type="checkbox" checked={f.expects_more_bills} onChange={e => set('expects_more_bills', e.target.checked)} />
            Keep the unbilled part as Awaiting Bill after the first bill
          </label>
        </Field>
        <Field label="Notes" style={{ gridColumn: 'span 2' }}><textarea style={{ ...S.input, width: '100%', minHeight: 50 }} value={f.notes} onChange={e => set('notes', e.target.value)} /></Field>
      </div>
      <div style={{ ...S.small, marginTop: 6 }}>{cat?.label}: when the bill arrives it links to this line automatically (same {f.category === 'brokerage' ? 'broker or client' : 'vendor or branch'} and month), so the forecast and the bill count only once.</div>
    </Modal>
  );
}
