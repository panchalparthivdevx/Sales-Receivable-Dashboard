import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api';
import ManagementInputsTab from './ManagementInputsTab';
import Step15Tab from './Step15Tab';

// ─── Palette / Design tokens ──────────────────────────────────────────────────
const C = {
  bg:       '#F9F9F9',
  surface:  '#FFFFFF',
  surfaceEl:'#F2F2F2',
  border:   '#DFE7E3',
  borderFt: '#C8D6D0',
  text:     '#18191B',
  textSec:  '#5D6C7B',
  textMut:  '#9BA8B0',
  accent:   '#1C4942',
  accentD:  '#002B31',
  green:    '#15803D',
  yellow:   '#B45309',
  red:      '#DC2626',
  purple:   '#7C3AED',
  cyan:     '#0891B2',
  orange:   '#C2410C',
};

const pill = (color, label) => (
  <span style={{ background: color + '22', color, border: `1px solid ${color}44`, borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 700, letterSpacing: 0.3 }}>{label}</span>
);

const statusColors = { existing: C.green, signed: C.cyan, pipeline: C.yellow, closed: C.textMut };
const statusLabels = { existing: 'EXISTING', signed: 'SIGNED', pipeline: 'PIPELINE', closed: 'CLOSED' };
const clientStatusColors = { active: C.green, exited: C.textMut, suspended: C.yellow };
const mapStatusColors = { confirmed: C.green, provisional: C.yellow, unmapped: C.red, historical: C.textMut };
const validColors = { error: C.red, warning: C.yellow, info: C.cyan };

const fmt = n => n !== null && n !== undefined ? Number(n).toLocaleString('en-IN') : '—';
const fmtPct = n => n !== null && n !== undefined ? `${n}%` : '—';

function KpiCard({ label, value, sub, color = C.accent }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '14px 18px', minWidth: 110 }}>
      <div style={{ fontSize: 11, color: C.textSec, fontWeight: 600, letterSpacing: 0.5, marginBottom: 4, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMut, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? C.accent : 'transparent',
      color: active ? '#fff' : C.textSec,
      border: active ? 'none' : `1px solid ${C.border}`,
      borderRadius: 6, padding: '6px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
      transition: 'all 0.15s',
    }}>{children}</button>
  );
}

function Modal({ title, onClose, children, width = 560 }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, width: Math.min(width, window.innerWidth - 32), maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textSec, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: '20px', overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, required, source, children }) {
  const tagColor = source === 'ZOHO' ? C.cyan : source === 'CALC' ? C.green : source === 'OVERRIDE' ? C.orange : C.textSec;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <label style={{ fontSize: 11.5, color: C.textSec, fontWeight: 600 }}>{label}{required && <span style={{ color: C.red }}> *</span>}</label>
        {source && <span style={{ fontSize: 10, color: tagColor, border: `1px solid ${tagColor}44`, borderRadius: 3, padding: '1px 5px', fontWeight: 700 }}>{source}</span>}
      </div>
      {children}
    </div>
  );
}

const inp = (extra = {}) => ({
  width: '100%', boxSizing: 'border-box', background: C.bg, border: `1px solid ${C.border}`,
  color: C.text, borderRadius: 5, padding: '7px 10px', fontSize: 13, outline: 'none',
  ...extra,
});

function Inp({ value, onChange, type = 'text', placeholder, style = {} }) {
  return <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={inp(style)} />;
}
function Sel({ value, onChange, children, style = {} }) {
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value)} style={{ ...inp(), ...style }}>
      {children}
    </select>
  );
}
function Textarea({ value, onChange, rows = 3, placeholder }) {
  return <textarea value={value ?? ''} onChange={e => onChange(e.target.value)} rows={rows} placeholder={placeholder} style={{ ...inp(), resize: 'vertical' }} />;
}

function TwoCol({ children }) {
  const arr = React.Children.toArray(children);
  const pairs = [];
  for (let i = 0; i < arr.length; i += 2) pairs.push([arr[i], arr[i + 1]]);
  return (
    <div>
      {pairs.map((pair, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {pair[0]}{pair[1] || <div />}
        </div>
      ))}
    </div>
  );
}

function SaveBtn({ onClick, loading, label = 'Save' }) {
  return (
    <button onClick={onClick} disabled={loading} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 700, fontSize: 13, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}>
      {loading ? 'Saving…' : label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BRANCH MASTER TAB
// ─────────────────────────────────────────────────────────────────────────────
function BranchMasterTab({ branches, loading, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');
  const blank = { branch_id: '', branch_name: '', city: '', state: '', branch_status: 'existing', opening_date: '', closing_date: '', total_area_sqft: '', revenue_capacity_sqft: '', current_occupancy_pct: '', target_occupancy_pct: 100, occupancy_ramp_template: 'base', revenue_per_sqft: '', rent_per_sqft: '', other_opex_per_sqft: '', capex_per_sqft: '', security_deposit_months: '', capex_lead_months: '', deposit_lead_months: '', revenue_escalation_pct: '', rent_escalation_pct: '', opex_escalation_pct: '', depreciation_life_months: '', zoho_branch_tag: '', data_source: 'manual', notes: '', active: true };
  const [form, setForm]         = useState(blank);

  const f = k => v => setForm(p => ({ ...p, [k]: v }));

  const openAdd  = () => { setForm(blank); setEditing(null); setErr(''); setShowForm(true); };
  const openEdit = b  => { setForm({ ...blank, ...b }); setEditing(b.branch_id); setErr(''); setShowForm(true); };

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      if (editing) {
        await apiFetch(`/api/fpa/branch-master/${editing}`, { method: 'PUT', body: JSON.stringify(form) });
      } else {
        await apiFetch('/api/fpa/branch-master', { method: 'POST', body: JSON.stringify(form) });
      }
      setShowForm(false); onRefresh();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  const deactivate = async (id) => {
    if (!window.confirm(`Deactivate branch ${id}?`)) return;
    try { await apiFetch(`/api/fpa/branch-master/${id}`, { method: 'PUT', body: JSON.stringify({ active: false }) }); onRefresh(); }
    catch (e) { alert(e.message); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Branch Master</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>One record per DevX centre. Every client, occupancy assumption and projection reads from here.</div>
        </div>
        <button onClick={openAdd} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>+ Add Branch</button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: C.surfaceEl }}>
              {['Branch ID','Branch Name','City','Status','Area (sqft)','Rev/sf','Rent/sf','Occupancy','Template','Opening Date','Active'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
              <th style={{ padding: '8px 12px', color: C.textSec, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={12} style={{ padding: '2rem', textAlign: 'center', color: C.textMut }}>Loading…</td></tr>
            ) : branches.length === 0 ? (
              <tr><td colSpan={12} style={{ padding: '2rem', textAlign: 'center', color: C.textMut }}>No branches yet. Click "Add Branch" to create the first one.</td></tr>
            ) : branches.map(b => (
              <tr key={b.branch_id} style={{ borderBottom: `1px solid ${C.border}`, opacity: b.active ? 1 : 0.45 }}>
                <td style={{ padding: '9px 12px', color: C.accent, fontWeight: 600, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{b.branch_id}</td>
                <td style={{ padding: '9px 12px', color: C.text, fontWeight: 500 }}>{b.branch_name}</td>
                <td style={{ padding: '9px 12px', color: C.textSec }}>{b.city}{b.state ? `, ${b.state}` : ''}</td>
                <td style={{ padding: '9px 12px' }}>{pill(statusColors[b.branch_status] || C.textSec, statusLabels[b.branch_status] || b.branch_status)}</td>
                <td style={{ padding: '9px 12px', color: C.text, fontVariantNumeric: 'tabular-nums' }}>{fmt(b.total_area_sqft)}</td>
                <td style={{ padding: '9px 12px', color: C.textSec, fontVariantNumeric: 'tabular-nums' }}>{b.revenue_per_sqft ? `₹${b.revenue_per_sqft}` : <span style={{ color: C.textMut }}>global</span>}</td>
                <td style={{ padding: '9px 12px', color: C.textSec, fontVariantNumeric: 'tabular-nums' }}>{b.rent_per_sqft ? `₹${b.rent_per_sqft}` : <span style={{ color: C.textMut }}>global</span>}</td>
                <td style={{ padding: '9px 12px', color: C.textSec }}>{b.current_occupancy_pct !== null && b.current_occupancy_pct !== undefined ? `${b.current_occupancy_pct}% → ${b.target_occupancy_pct || 100}%` : '—'}</td>
                <td style={{ padding: '9px 12px' }}>{pill(C.textSec, (b.occupancy_ramp_template || 'base').toUpperCase())}</td>
                <td style={{ padding: '9px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{b.opening_date || '—'}</td>
                <td style={{ padding: '9px 12px' }}>{pill(b.active ? C.green : C.textMut, b.active ? 'YES' : 'NO')}</td>
                <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                  <button onClick={() => openEdit(b)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 4, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', marginRight: 4 }}>Edit</button>
                  {b.active && <button onClick={() => deactivate(b.branch_id)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.yellow, borderRadius: 4, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer' }}>Deactivate</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <Modal title={editing ? `Edit Branch — ${editing}` : 'Add New Branch'} onClose={() => setShowForm(false)} width={700}>
          {err && <div style={{ background: C.red + '22', border: `1px solid ${C.red}44`, color: C.red, borderRadius: 5, padding: '8px 12px', marginBottom: 12, fontSize: 12.5 }}>{err}</div>}

          <div style={{ marginBottom: 8, fontSize: 11.5, color: C.textMut }}>Fields marked <span style={{ color: C.red }}>*</span> are required. Leave numeric fields blank to inherit the global default.</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 0 }}>
            <Field label="Branch ID" source="MANUAL"><Inp value={form.branch_id} onChange={f('branch_id')} placeholder="e.g. AMD-01 (auto if blank)" /></Field>
            <Field label="Branch Name" required source="MANUAL"><Inp value={form.branch_name} onChange={f('branch_name')} placeholder="Full commercial name" /></Field>
          </div>

          <TwoCol>
            <Field label="City" source="MANUAL"><Inp value={form.city} onChange={f('city')} /></Field>
            <Field label="State" source="MANUAL"><Inp value={form.state} onChange={f('state')} /></Field>
            <Field label="Branch Status" source="MANUAL">
              <Sel value={form.branch_status} onChange={f('branch_status')}>
                <option value="existing">Existing / Live</option>
                <option value="signed">Signed / Upcoming</option>
                <option value="pipeline">Pipeline / Planned</option>
                <option value="closed">Closed / Inactive</option>
              </Sel>
            </Field>
            <Field label="Active" source="MANUAL">
              <Sel value={form.active ? 'true' : 'false'} onChange={v => f('active')(v === 'true')}>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Sel>
            </Field>
            <Field label="Opening Date" source="MANUAL"><Inp type="date" value={form.opening_date} onChange={f('opening_date')} /></Field>
            <Field label="Closing Date" source="MANUAL"><Inp type="date" value={form.closing_date} onChange={f('closing_date')} /></Field>
            <Field label="Total Area (sq ft)" required source="MANUAL"><Inp type="number" value={form.total_area_sqft} onChange={f('total_area_sqft')} placeholder="e.g. 45000" /></Field>
            <Field label="Revenue Capacity (sq ft)" source="MANUAL"><Inp type="number" value={form.revenue_capacity_sqft} onChange={f('revenue_capacity_sqft')} placeholder="Defaults to total area" /></Field>
          </TwoCol>

          <div style={{ borderTop: `1px solid ${C.border}`, margin: '14px 0', paddingTop: 14 }}>
            <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Occupancy</div>
            <TwoCol>
              <Field label="Current Occupancy %" source="MANUAL"><Inp type="number" value={form.current_occupancy_pct} onChange={f('current_occupancy_pct')} placeholder="Actual % today" /></Field>
              <Field label="Target Occupancy %" source="MANUAL"><Inp type="number" value={form.target_occupancy_pct} onChange={f('target_occupancy_pct')} placeholder="100" /></Field>
              <Field label="Ramp Template" source="MANUAL">
                <Sel value={form.occupancy_ramp_template} onChange={f('occupancy_ramp_template')}>
                  <option value="base">Base (0/0/0/30/50/60/70/80/80/90/100/100%)</option>
                  <option value="conservative">Conservative (reaches 80% at month 11)</option>
                  <option value="aggressive">Aggressive (reaches 100% by month 8)</option>
                  <option value="custom">Custom (manual monthly overrides)</option>
                </Sel>
              </Field>
              <Field label="Data Source" source="MANUAL">
                <Sel value={form.data_source} onChange={f('data_source')}>
                  <option value="manual">Manual</option>
                  <option value="excel-import">Excel Import</option>
                  <option value="zoho">Zoho (future)</option>
                </Sel>
              </Field>
            </TwoCol>
          </div>

          <div style={{ borderTop: `1px solid ${C.border}`, margin: '14px 0', paddingTop: 14 }}>
            <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Revenue & Cost Assumptions <span style={{ color: C.textMut, fontWeight: 400 }}>(leave blank to use global default)</span></div>
            <TwoCol>
              <Field label="Revenue / sq ft (₹/mo)" source="OVERRIDE"><Inp type="number" value={form.revenue_per_sqft} onChange={f('revenue_per_sqft')} /></Field>
              <Field label="Rent / sq ft (₹/mo)" source="OVERRIDE"><Inp type="number" value={form.rent_per_sqft} onChange={f('rent_per_sqft')} /></Field>
              <Field label="Other Opex / sq ft (₹/mo)" source="OVERRIDE"><Inp type="number" value={form.other_opex_per_sqft} onChange={f('other_opex_per_sqft')} /></Field>
              <Field label="Capex / sq ft (₹)" source="OVERRIDE"><Inp type="number" value={form.capex_per_sqft} onChange={f('capex_per_sqft')} /></Field>
              <Field label="Security Deposit (months)" source="OVERRIDE"><Inp type="number" value={form.security_deposit_months} onChange={f('security_deposit_months')} /></Field>
              <Field label="Capex Lead Time (months)" source="OVERRIDE"><Inp type="number" value={form.capex_lead_months} onChange={f('capex_lead_months')} /></Field>
              <Field label="Deposit Lead Time (months)" source="OVERRIDE"><Inp type="number" value={form.deposit_lead_months} onChange={f('deposit_lead_months')} /></Field>
              <Field label="Depreciation Life (months)" source="OVERRIDE"><Inp type="number" value={form.depreciation_life_months} onChange={f('depreciation_life_months')} /></Field>
            </TwoCol>
          </div>

          <div style={{ borderTop: `1px solid ${C.border}`, margin: '14px 0', paddingTop: 14 }}>
            <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Escalation Overrides <span style={{ color: C.textMut, fontWeight: 400 }}>(leave blank to use global default)</span></div>
            <TwoCol>
              <Field label="Revenue Escalation % / yr" source="OVERRIDE"><Inp type="number" value={form.revenue_escalation_pct} onChange={f('revenue_escalation_pct')} /></Field>
              <Field label="Rent Escalation % / yr" source="OVERRIDE"><Inp type="number" value={form.rent_escalation_pct} onChange={f('rent_escalation_pct')} /></Field>
              <Field label="Opex Escalation % / yr" source="OVERRIDE"><Inp type="number" value={form.opex_escalation_pct} onChange={f('opex_escalation_pct')} /></Field>
              <Field label="Zoho Branch Tag" source="MANUAL"><Inp value={form.zoho_branch_tag} onChange={f('zoho_branch_tag')} placeholder="Tag used in Zoho Books (for future integration)" /></Field>
            </TwoCol>
          </div>

          <Field label="Notes" source="MANUAL"><Textarea value={form.notes} onChange={f('notes')} placeholder="Any additional context for this branch" /></Field>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8 }}>
            <button onClick={() => setShowForm(false)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '7px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <SaveBtn onClick={save} loading={saving} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT MASTER TAB
// ─────────────────────────────────────────────────────────────────────────────
function ClientMasterTab({ clients, loading, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');
  const blank = { client_id: '', client_name: '', zoho_customer_id: '', contract_start_date: '', contract_end_date: '', exit_date: '', current_monthly_revenue: '', occupied_sqft: '', escalation_pct: '', escalation_effective_date: '', escalation_frequency: 'annual', client_status: 'active', revenue_type: 'actual', data_source: 'manual', notes: '', active: true };
  const [form, setForm] = useState(blank);
  const f = k => v => setForm(p => ({ ...p, [k]: v }));

  const openAdd  = () => { setForm(blank); setEditing(null); setErr(''); setShowForm(true); };
  const openEdit = c  => { setForm({ ...blank, ...c }); setEditing(c.client_id); setErr(''); setShowForm(true); };

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      if (editing) await apiFetch(`/api/fpa/client-master/${editing}`, { method: 'PUT', body: JSON.stringify(form) });
      else         await apiFetch('/api/fpa/client-master', { method: 'POST', body: JSON.stringify(form) });
      setShowForm(false); onRefresh();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Client Revenue Master</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>One record per client. Will link to Zoho Books Customer IDs in Step 6. Escalation at client level overrides branch and global defaults.</div>
        </div>
        <button onClick={openAdd} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>+ Add Client</button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: C.surfaceEl }}>
              {['Client ID','Client Name','Zoho ID','Monthly Revenue','Escalation','Eff. Date','Freq','Status','Revenue Type','Active'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
              <th style={{ padding: '8px 12px', color: C.textSec, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={11} style={{ padding: '2rem', textAlign: 'center', color: C.textMut }}>Loading…</td></tr>
            ) : clients.length === 0 ? (
              <tr><td colSpan={11} style={{ padding: '2rem', textAlign: 'center', color: C.textMut }}>No clients yet. In Step 6 these will be auto-populated from Zoho Books.</td></tr>
            ) : clients.map(c => (
              <tr key={c.client_id} style={{ borderBottom: `1px solid ${C.border}`, opacity: c.active ? 1 : 0.45 }}>
                <td style={{ padding: '9px 12px', color: C.accent, fontWeight: 600, fontFamily: 'monospace' }}>{c.client_id}</td>
                <td style={{ padding: '9px 12px', color: C.text, fontWeight: 500 }}>{c.client_name}</td>
                <td style={{ padding: '9px 12px', color: C.textMut, fontFamily: 'monospace', fontSize: 11 }}>{c.zoho_customer_id || <span style={{ color: C.textMut }}>Pending Zoho sync</span>}</td>
                <td style={{ padding: '9px 12px', color: C.text, fontVariantNumeric: 'tabular-nums' }}>{c.current_monthly_revenue ? `₹${fmt(c.current_monthly_revenue)}` : '—'}</td>
                <td style={{ padding: '9px 12px', color: c.escalation_pct ? C.cyan : C.textMut }}>{c.escalation_pct ? `${c.escalation_pct}%` : <span style={{ color: C.textMut }}>branch/global</span>}</td>
                <td style={{ padding: '9px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{c.escalation_effective_date || '—'}</td>
                <td style={{ padding: '9px 12px', color: C.textSec }}>{c.escalation_frequency || '—'}</td>
                <td style={{ padding: '9px 12px' }}>{pill(clientStatusColors[c.client_status] || C.textSec, (c.client_status || '').toUpperCase())}</td>
                <td style={{ padding: '9px 12px' }}>{pill(c.revenue_type === 'actual' ? C.green : c.revenue_type === 'forecast' ? C.yellow : C.textSec, (c.revenue_type || '').toUpperCase())}</td>
                <td style={{ padding: '9px 12px' }}>{pill(c.active ? C.green : C.textMut, c.active ? 'YES' : 'NO')}</td>
                <td style={{ padding: '9px 12px' }}>
                  <button onClick={() => openEdit(c)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 4, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer' }}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <Modal title={editing ? `Edit Client — ${editing}` : 'Add New Client'} onClose={() => setShowForm(false)} width={680}>
          {err && <div style={{ background: C.red + '22', color: C.red, border: `1px solid ${C.red}44`, borderRadius: 5, padding: '8px 12px', marginBottom: 12, fontSize: 12.5 }}>{err}</div>}

          <TwoCol>
            <Field label="Client ID" source="MANUAL"><Inp value={form.client_id} onChange={f('client_id')} placeholder="Auto-generated if blank" /></Field>
            <Field label="Client Name" required source="MANUAL"><Inp value={form.client_name} onChange={f('client_name')} /></Field>
            <Field label="Zoho Customer ID" source="ZOHO"><Inp value={form.zoho_customer_id} onChange={f('zoho_customer_id')} placeholder="Will auto-fill after Zoho sync (Step 6)" /></Field>
            <Field label="Client Status" source="MANUAL">
              <Sel value={form.client_status} onChange={f('client_status')}>
                <option value="active">Active</option>
                <option value="exited">Exited</option>
                <option value="suspended">Suspended</option>
              </Sel>
            </Field>
          </TwoCol>

          <div style={{ borderTop: `1px solid ${C.border}`, margin: '14px 0', paddingTop: 14 }}>
            <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Contract Dates</div>
            <TwoCol>
              <Field label="Contract Start Date" source="MANUAL"><Inp type="date" value={form.contract_start_date} onChange={f('contract_start_date')} /></Field>
              <Field label="Contract End Date" source="MANUAL"><Inp type="date" value={form.contract_end_date} onChange={f('contract_end_date')} /></Field>
              <Field label="Exit / Termination Date" source="MANUAL"><Inp type="date" value={form.exit_date} onChange={f('exit_date')} /></Field>
              <Field label="Revenue Type" source="MANUAL">
                <Sel value={form.revenue_type} onChange={f('revenue_type')}>
                  <option value="actual">Actual (from Zoho)</option>
                  <option value="forecast">Forecast</option>
                  <option value="budget">Budget</option>
                  <option value="manual_override">Manual Override</option>
                </Sel>
              </Field>
            </TwoCol>
          </div>

          <div style={{ borderTop: `1px solid ${C.border}`, margin: '14px 0', paddingTop: 14 }}>
            <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Revenue</div>
            <TwoCol>
              <Field label="Current Monthly Revenue (₹)" source="ZOHO"><Inp type="number" value={form.current_monthly_revenue} onChange={f('current_monthly_revenue')} placeholder="Will auto-fill from Zoho invoices in Step 6" /></Field>
              <Field label="Occupied Area (sq ft)" source="MANUAL"><Inp type="number" value={form.occupied_sqft} onChange={f('occupied_sqft')} /></Field>
            </TwoCol>
          </div>

          <div style={{ borderTop: `1px solid ${C.border}`, margin: '14px 0', paddingTop: 14 }}>
            <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Escalation <span style={{ color: C.textMut, fontWeight: 400 }}>(overrides branch default → overrides global default)</span></div>
            <TwoCol>
              <Field label="Escalation %" source="OVERRIDE"><Inp type="number" value={form.escalation_pct} onChange={f('escalation_pct')} placeholder="Leave blank = use branch/global" /></Field>
              <Field label="Effective Date" source="OVERRIDE"><Inp type="date" value={form.escalation_effective_date} onChange={f('escalation_effective_date')} /></Field>
              <Field label="Frequency" source="MANUAL">
                <Sel value={form.escalation_frequency} onChange={f('escalation_frequency')}>
                  <option value="annual">Annual</option>
                  <option value="bi-annual">Bi-annual</option>
                  <option value="ad_hoc">Ad hoc</option>
                </Sel>
              </Field>
              <Field label="Active" source="MANUAL">
                <Sel value={form.active ? 'true' : 'false'} onChange={v => f('active')(v === 'true')}>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </Sel>
              </Field>
            </TwoCol>
          </div>

          <Field label="Notes" source="MANUAL"><Textarea value={form.notes} onChange={f('notes')} /></Field>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8 }}>
            <button onClick={() => setShowForm(false)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '7px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <SaveBtn onClick={save} loading={saving} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAPPING TAB
// ─────────────────────────────────────────────────────────────────────────────
function MappingTab({ mappings, branches, clients, loading, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');
  const blank = { client_id: '', branch_id: '', mapping_status: 'confirmed', mapping_source: 'manual', mapping_confidence: 'high', effective_from: '', effective_to: '', manual_override: false, allocation_pct: 100, notes: '', active: true };
  const [form, setForm] = useState(blank);
  const f = k => v => setForm(p => ({ ...p, [k]: v }));

  const openAdd  = () => { setForm(blank); setEditing(null); setErr(''); setShowForm(true); };
  const openEdit = m  => { setForm({ ...blank, ...m }); setEditing(m.mapping_id); setErr(''); setShowForm(true); };

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      if (editing) await apiFetch(`/api/fpa/mapping/${editing}`, { method: 'PUT', body: JSON.stringify(form) });
      else         await apiFetch('/api/fpa/mapping', { method: 'POST', body: JSON.stringify(form) });
      setShowForm(false); onRefresh();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  const deactivate = async id => {
    try { await apiFetch(`/api/fpa/mapping/${id}`, { method: 'PUT', body: JSON.stringify({ active: false }) }); onRefresh(); }
    catch (e) { alert(e.message); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Branch–Client Mapping</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>Links every client to one or more DevX branches. One client can map to multiple branches (multi-branch support). Each mapping has its own allocation % for revenue attribution.</div>
        </div>
        <button onClick={openAdd} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>+ Add Mapping</button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: C.surfaceEl }}>
              {['Map ID','Client','Branch','Alloc %','Status','Confidence','Source','Eff. From','Eff. To','Active'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
              <th style={{ padding: '8px 12px', color: C.textSec, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={11} style={{ padding: '2rem', textAlign: 'center', color: C.textMut }}>Loading…</td></tr>
            ) : mappings.length === 0 ? (
              <tr><td colSpan={11} style={{ padding: '2rem', textAlign: 'center', color: C.textMut }}>No mappings yet. Add branches and clients first, then map them here.</td></tr>
            ) : mappings.map(m => (
              <tr key={m.mapping_id} style={{ borderBottom: `1px solid ${C.border}`, opacity: m.active ? 1 : 0.45 }}>
                <td style={{ padding: '9px 12px', color: C.textSec, fontFamily: 'monospace', fontSize: 11 }}>{m.mapping_id}</td>
                <td style={{ padding: '9px 12px' }}>
                  <div style={{ color: C.text, fontWeight: 500 }}>{m.client_name}</div>
                  <div style={{ color: C.accent, fontFamily: 'monospace', fontSize: 11 }}>{m.client_id}</div>
                </td>
                <td style={{ padding: '9px 12px' }}>
                  <div style={{ color: C.text, fontWeight: 500 }}>{m.branch_name}</div>
                  <div style={{ color: C.cyan, fontFamily: 'monospace', fontSize: 11 }}>{m.branch_id}</div>
                </td>
                <td style={{ padding: '9px 12px', color: C.text, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{m.allocation_pct}%</td>
                <td style={{ padding: '9px 12px' }}>{pill(mapStatusColors[m.mapping_status] || C.textSec, (m.mapping_status || '').toUpperCase())}</td>
                <td style={{ padding: '9px 12px' }}>{pill(m.mapping_confidence === 'high' ? C.green : m.mapping_confidence === 'medium' ? C.yellow : C.red, (m.mapping_confidence || '').toUpperCase())}</td>
                <td style={{ padding: '9px 12px', color: C.textSec }}>{m.mapping_source}</td>
                <td style={{ padding: '9px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{m.effective_from || '—'}</td>
                <td style={{ padding: '9px 12px', color: C.textSec, whiteSpace: 'nowrap' }}>{m.effective_to || '—'}</td>
                <td style={{ padding: '9px 12px' }}>{pill(m.active ? C.green : C.textMut, m.active ? 'YES' : 'NO')}</td>
                <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                  <button onClick={() => openEdit(m)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 4, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer', marginRight: 4 }}>Edit</button>
                  {m.active && <button onClick={() => deactivate(m.mapping_id)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.yellow, borderRadius: 4, padding: '3px 10px', fontSize: 11.5, cursor: 'pointer' }}>Deactivate</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <Modal title={editing ? `Edit Mapping — ${editing}` : 'Add Mapping'} onClose={() => setShowForm(false)} width={600}>
          {err && <div style={{ background: C.red + '22', color: C.red, border: `1px solid ${C.red}44`, borderRadius: 5, padding: '8px 12px', marginBottom: 12, fontSize: 12.5 }}>{err}</div>}

          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 5, padding: '8px 12px', marginBottom: 14, fontSize: 12 }}>
            <strong style={{ color: C.cyan }}>Multi-branch clients:</strong> <span style={{ color: C.textSec }}>Create one mapping record per branch. Set allocation_pct for each (e.g. 60%+40% = 100%). Revenue will be attributed to each branch independently.</span>
          </div>

          <TwoCol>
            <Field label="Client" required source="MANUAL">
              <Sel value={form.client_id} onChange={f('client_id')}>
                <option value="">— Select Client —</option>
                {clients.map(c => <option key={c.client_id} value={c.client_id}>{c.client_name} ({c.client_id})</option>)}
              </Sel>
            </Field>
            <Field label="Branch" required source="MANUAL">
              <Sel value={form.branch_id} onChange={f('branch_id')}>
                <option value="">— Select Branch —</option>
                {branches.filter(b => b.active).map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name} ({b.branch_id})</option>)}
              </Sel>
            </Field>
            <Field label="Allocation %" source="MANUAL"><Inp type="number" value={form.allocation_pct} onChange={f('allocation_pct')} /></Field>
            <Field label="Mapping Status" source="MANUAL">
              <Sel value={form.mapping_status} onChange={f('mapping_status')}>
                <option value="confirmed">Confirmed</option>
                <option value="provisional">Provisional</option>
                <option value="historical">Historical</option>
                <option value="unmapped">Unmapped</option>
              </Sel>
            </Field>
            <Field label="Confidence" source="MANUAL">
              <Sel value={form.mapping_confidence} onChange={f('mapping_confidence')}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Sel>
            </Field>
            <Field label="Source" source="MANUAL">
              <Sel value={form.mapping_source} onChange={f('mapping_source')}>
                <option value="manual">Manual</option>
                <option value="zoho_tag">Zoho Tag</option>
                <option value="invoice_analysis">Invoice Analysis</option>
              </Sel>
            </Field>
            <Field label="Effective From" source="MANUAL"><Inp type="date" value={form.effective_from} onChange={f('effective_from')} /></Field>
            <Field label="Effective To" source="MANUAL"><Inp type="date" value={form.effective_to} onChange={f('effective_to')} /></Field>
            <Field label="Manual Override" source="OVERRIDE">
              <Sel value={form.manual_override ? 'true' : 'false'} onChange={v => f('manual_override')(v === 'true')}>
                <option value="false">No</option>
                <option value="true">Yes — this overrides auto-derived mapping</option>
              </Sel>
            </Field>
            <Field label="Active" source="MANUAL">
              <Sel value={form.active ? 'true' : 'false'} onChange={v => f('active')(v === 'true')}>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Sel>
            </Field>
          </TwoCol>

          <Field label="Notes" source="MANUAL"><Textarea value={form.notes} onChange={f('notes')} /></Field>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8 }}>
            <button onClick={() => setShowForm(false)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '7px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <SaveBtn onClick={save} loading={saving} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OCCUPANCY TAB
// ─────────────────────────────────────────────────────────────────────────────
function OccupancyTab({ branches, loading, onRefresh }) {
  const [occ, setOcc]         = useState({ branch_templates: {}, overrides: {} });
  const [templates, setTmpl]  = useState({});
  const [saving, setSaving]   = useState('');
  const [editCell, setEditCell] = useState(null); // { branch_id, month }
  const [cellVal, setCellVal]   = useState('');

  // Model months Oct-26 → Mar-29 (30 months)
  const months = [];
  let d = new Date(2026, 9, 1); // Oct 2026
  while (d <= new Date(2029, 2, 1)) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() + 1);
  }

  const loadOcc = useCallback(async () => {
    try {
      const data = await apiFetch('/api/fpa/occupancy');
      setOcc(data);
      setTmpl(data.templates || {});
    } catch (_) {}
  }, []);

  useEffect(() => { loadOcc(); }, [loadOcc]);

  const setTemplate = async (branch_id, template) => {
    setSaving(branch_id);
    try {
      await apiFetch('/api/fpa/occupancy/template', { method: 'PUT', body: JSON.stringify({ branch_id, template }) });
      await loadOcc();
    } catch (e) { alert(e.message); }
    setSaving('');
  };

  const saveCell = async () => {
    if (!editCell) return;
    const pct = parseFloat(cellVal);
    if (isNaN(pct)) { setEditCell(null); return; }
    if (pct > 100) { alert('Occupancy cannot exceed 100%. Set manual_occ_before_open on the branch to override.'); return; }
    setSaving(editCell.branch_id + editCell.month);
    try {
      await apiFetch('/api/fpa/occupancy/override', { method: 'POST', body: JSON.stringify({ branch_id: editCell.branch_id, month: editCell.month, pct }) });
      await loadOcc();
    } catch (e) { alert(e.message); }
    setSaving(''); setEditCell(null);
  };

  const clearCell = async (branch_id, month) => {
    try {
      await apiFetch('/api/fpa/occupancy/override', { method: 'DELETE', body: JSON.stringify({ branch_id, month }) });
      await loadOcc();
    } catch (e) { alert(e.message); }
  };

  const getOccPct = (branch, month) => {
    // Priority: monthly override → branch template → global default template
    const override = occ.overrides?.[branch.branch_id]?.[month];
    if (override !== undefined) return { pct: override, source: 'override' };

    const tmpl = occ.branch_templates?.[branch.branch_id] || 'base';
    if (tmpl === 'custom') return { pct: null, source: 'custom-no-override' };

    const tmplData = templates[tmpl];
    if (!tmplData) return { pct: null, source: 'no-template' };

    if (!branch.opening_date) return { pct: 0, source: 'template-no-open' };
    const openDate = new Date(branch.opening_date);
    const monthDate = new Date(month + '-01');
    if (monthDate < openDate) return { pct: 0, source: 'pre-open' };
    const monthIdx = Math.round((monthDate - openDate) / (30.44 * 24 * 3600 * 1000));
    const pct = monthIdx < tmplData.monthly_pct.length ? tmplData.monthly_pct[monthIdx] : tmplData.steady_state_pct;
    return { pct, source: 'template' };
  };

  const activeBranches = (branches || []).filter(b => b.active);

  const getCellColor = (pct, source) => {
    if (source === 'override') return C.orange;
    if (pct === null) return C.textMut;
    if (pct >= 90) return C.green;
    if (pct >= 60) return C.cyan;
    if (pct >= 30) return C.yellow;
    if (pct > 0)   return C.orange;
    return C.textMut;
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Occupancy Assumptions</div>
        <div style={{ color: C.textSec, fontSize: 12, marginBottom: 8 }}>Set monthly occupancy per branch. Click any cell to set a manual override. Overrides are highlighted in orange. Pre-open months are auto-set to 0%.</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11.5 }}>
          {[['Override (manual)', C.orange], ['Template (auto)', C.cyan], ['≥90%', C.green], ['30–89%', C.yellow], ['1–29%', C.orange], ['0%', C.textMut]].map(([l, c]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
              <span style={{ color: C.textSec }}>{l}</span>
            </div>
          ))}
        </div>
      </div>

      {loading ? <div style={{ color: C.textMut, padding: '2rem' }}>Loading…</div> :
        activeBranches.length === 0 ? <div style={{ color: C.textMut, padding: '2rem' }}>Add branches first, then set occupancy assumptions here.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead>
                <tr style={{ background: C.surfaceEl }}>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, borderBottom: `1px solid ${C.border}`, minWidth: 180, position: 'sticky', left: 0, background: C.surfaceEl, zIndex: 2 }}>Branch</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, borderBottom: `1px solid ${C.border}`, minWidth: 130 }}>Template</th>
                  {months.map(m => (
                    <th key={m} style={{ padding: '6px 4px', textAlign: 'center', color: C.textSec, fontWeight: 600, borderBottom: `1px solid ${C.border}`, minWidth: 52, whiteSpace: 'nowrap', fontSize: 10 }}>
                      {m.replace('20', '').replace('-', '‑')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeBranches.map(b => {
                  const tmpl = occ.branch_templates?.[b.branch_id] || 'base';
                  return (
                    <tr key={b.branch_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '8px 12px', position: 'sticky', left: 0, background: C.surface, zIndex: 1 }}>
                        <div style={{ color: C.text, fontWeight: 500, fontSize: 12 }}>{b.branch_name}</div>
                        <div style={{ color: C.accent, fontFamily: 'monospace', fontSize: 10 }}>{b.branch_id}</div>
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <select value={tmpl} onChange={e => setTemplate(b.branch_id, e.target.value)} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 4, padding: '3px 6px', fontSize: 11, cursor: 'pointer', opacity: saving === b.branch_id ? 0.5 : 1 }}>
                          <option value="conservative">Conservative</option>
                          <option value="base">Base</option>
                          <option value="aggressive">Aggressive</option>
                          <option value="custom">Custom</option>
                        </select>
                      </td>
                      {months.map(month => {
                        const { pct, source } = getOccPct(b, month);
                        const isEditing = editCell?.branch_id === b.branch_id && editCell?.month === month;
                        const hasOverride = occ.overrides?.[b.branch_id]?.[month] !== undefined;
                        const color = getCellColor(pct, source);

                        return (
                          <td key={month} style={{ padding: '4px 2px', textAlign: 'center', position: 'relative' }}
                              onDoubleClick={() => { if (hasOverride) clearCell(b.branch_id, month); }}>
                            {isEditing ? (
                              <input autoFocus type="number" value={cellVal} onChange={e => setCellVal(e.target.value)}
                                onBlur={saveCell} onKeyDown={e => { if (e.key === 'Enter') saveCell(); if (e.key === 'Escape') setEditCell(null); }}
                                style={{ width: 44, background: C.bg, border: `1px solid ${C.accent}`, color: C.text, borderRadius: 3, padding: '2px 4px', fontSize: 11, textAlign: 'center', outline: 'none' }} />
                            ) : (
                              <div onClick={() => { setEditCell({ branch_id: b.branch_id, month }); setCellVal(pct !== null ? String(pct) : ''); }}
                                style={{ cursor: 'pointer', borderRadius: 3, padding: '3px 2px', color, fontWeight: hasOverride ? 700 : 500, background: hasOverride ? C.orange + '18' : source === 'pre-open' ? C.border + '33' : 'transparent', border: hasOverride ? `1px solid ${C.orange}44` : '1px solid transparent', userSelect: 'none', minWidth: 36 }}>
                                {pct !== null ? `${pct}%` : <span style={{ color: C.textMut, fontSize: 9 }}>—</span>}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize: 11, color: C.textMut, marginTop: 8 }}>Click any cell to edit. Double-click an orange override cell to clear it back to the template value.</div>
          </div>
        )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ASSUMPTIONS TAB
// ─────────────────────────────────────────────────────────────────────────────
function GlobalAssumptionsTab() {
  const [data, setData]     = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm]     = useState({});
  const [err, setErr]       = useState('');
  const f = k => v => setForm(p => ({ ...p, [k]: v }));

  useEffect(() => {
    apiFetch('/api/fpa/global-assumptions').then(d => { setData(d); setForm(d); }).catch(() => {});
  }, []);

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      const updated = await apiFetch('/api/fpa/global-assumptions', { method: 'PUT', body: JSON.stringify(form) });
      setData(updated); setForm(updated);
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  if (!data) return <div style={{ color: C.textMut, padding: '2rem' }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ color: C.text, fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Global Default Assumptions</div>
      <div style={{ color: C.textSec, fontSize: 12, marginBottom: 16 }}>Fallback values used when a branch or client has no specific override. All escalation assumptions here follow from the Step-1 workbook analysis.</div>
      {err && <div style={{ background: C.red + '22', color: C.red, border: `1px solid ${C.red}44`, borderRadius: 5, padding: '8px 12px', marginBottom: 12, fontSize: 12.5 }}>{err}</div>}

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14, marginTop: 4 }}>
        <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Model Period</div>
        <TwoCol>
          <Field label="Model Start Date" source="MANUAL"><Inp type="date" value={form.model_start_date} onChange={f('model_start_date')} /></Field>
          <Field label="Model End Date" source="MANUAL"><Inp type="date" value={form.model_end_date} onChange={f('model_end_date')} /></Field>
        </TwoCol>
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
        <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Default Escalation</div>
        <TwoCol>
          <Field label="Revenue Escalation % / yr" source="MANUAL"><Inp type="number" value={form.revenue_escalation_pct} onChange={f('revenue_escalation_pct')} /></Field>
          <Field label="Rent Escalation % / yr" source="MANUAL"><Inp type="number" value={form.rent_escalation_pct} onChange={f('rent_escalation_pct')} /></Field>
          <Field label="Opex Escalation % / yr" source="MANUAL"><Inp type="number" value={form.opex_escalation_pct} onChange={f('opex_escalation_pct')} /></Field>
          <Field label="Default Ramp Template" source="MANUAL">
            <Sel value={form.default_ramp_template} onChange={f('default_ramp_template')}>
              <option value="base">Base</option>
              <option value="conservative">Conservative</option>
              <option value="aggressive">Aggressive</option>
            </Sel>
          </Field>
        </TwoCol>
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
        <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Default ₹/sq ft Rates</div>
        <TwoCol>
          <Field label="Revenue / sq ft (₹/mo)" source="MANUAL"><Inp type="number" value={form.revenue_per_sqft} onChange={f('revenue_per_sqft')} /></Field>
          <Field label="Rent / sq ft (₹/mo)" source="MANUAL"><Inp type="number" value={form.rent_per_sqft} onChange={f('rent_per_sqft')} /></Field>
          <Field label="Other Opex / sq ft (₹/mo)" source="MANUAL"><Inp type="number" value={form.other_opex_per_sqft} onChange={f('other_opex_per_sqft')} /></Field>
          <Field label="Capex / sq ft (₹)" source="MANUAL"><Inp type="number" value={form.capex_per_sqft} onChange={f('capex_per_sqft')} /></Field>
        </TwoCol>
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
        <div style={{ fontSize: 11.5, color: C.textSec, fontWeight: 700, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Lead Times & Deposit</div>
        <TwoCol>
          <Field label="Security Deposit (months)" source="MANUAL"><Inp type="number" value={form.security_deposit_months} onChange={f('security_deposit_months')} /></Field>
          <Field label="Capex Lead Time (months)" source="MANUAL"><Inp type="number" value={form.capex_lead_months} onChange={f('capex_lead_months')} /></Field>
          <Field label="Deposit Lead Time (months)" source="MANUAL"><Inp type="number" value={form.deposit_lead_months} onChange={f('deposit_lead_months')} /></Field>
          <Field label="Depreciation Life (months)" source="MANUAL"><Inp type="number" value={form.depreciation_life_months} onChange={f('depreciation_life_months')} /></Field>
        </TwoCol>
      </div>

      <div style={{ paddingTop: 8 }}>
        <SaveBtn onClick={save} loading={saving} label="Save Global Assumptions" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION TAB
// ─────────────────────────────────────────────────────────────────────────────
function ValidationTab() {
  const [result, setResult]   = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try { setResult(await apiFetch('/api/fpa/validation')); }
    catch (e) { alert(e.message); }
    setLoading(false);
  };

  useEffect(() => { run(); }, []);

  const groupBy = (arr, key) => arr.reduce((m, i) => { (m[i[key]] = m[i[key]] || []).push(i); return m; }, {});

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Validation Controls</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>18 validation checks covering branch integrity, client completeness, mapping consistency, occupancy bounds, and escalation coverage.</div>
        </div>
        <button onClick={run} disabled={loading} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '7px 16px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>
          {loading ? 'Running…' : '↻ Re-run'}
        </button>
      </div>

      {result && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <KpiCard label="Status" value={result.summary.status === 'pass' ? 'PASS' : result.summary.status === 'warn' ? 'WARN' : 'FAIL'} color={result.summary.status === 'pass' ? C.green : result.summary.status === 'warn' ? C.yellow : C.red} />
            <KpiCard label="Errors" value={result.summary.errors} color={result.summary.errors > 0 ? C.red : C.green} />
            <KpiCard label="Warnings" value={result.summary.warnings} color={result.summary.warnings > 0 ? C.yellow : C.green} />
            <KpiCard label="Info" value={result.summary.info} color={C.cyan} />
          </div>

          {result.summary.total === 0 ? (
            <div style={{ background: C.green + '18', border: `1px solid ${C.green}44`, borderRadius: 6, padding: '16px 20px', color: C.green, fontWeight: 600 }}>All validation checks passed. No issues found.</div>
          ) : (
            Object.entries(groupBy(result.issues, 'level')).map(([level, issues]) => (
              <div key={level} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: validColors[level], textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{level === 'error' ? '🔴' : level === 'warning' ? '🟡' : 'ℹ️'} {level.toUpperCase()} ({issues.length})</div>
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
                  {issues.map((issue, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', borderBottom: i < issues.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: validColors[level], background: validColors[level] + '18', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap', flexShrink: 0 }}>{issue.code}</span>
                      <span style={{ fontSize: 12.5, color: C.textSec }}>{issue.message}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: C.textMut, whiteSpace: 'nowrap' }}>{issue.entity}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTUAL REVENUE TAB — Step 3
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_LABELS = {
  recurring_workspace: 'Recurring Workspace',
  meeting_room:        'Meeting Room',
  virtual_office:      'Virtual Office',
  one_time:            'One-Time',
  reimbursement:       'Reimbursement',
  intercompany:        'Intercompany',
  review_required:     'Review Required',
};
const CATEGORY_COLORS = {
  recurring_workspace: C.green,
  meeting_room:        C.cyan,
  virtual_office:      C.purple,
  one_time:            C.yellow,
  reimbursement:       C.orange,
  intercompany:        C.accent,
  review_required:     C.red,
};
const SOURCE_COLORS = {
  zoho_field:         C.cyan,
  zoho_field_partial: C.yellow,
  mapping_master:     C.purple,
  city_field:         C.orange,
  manual:             C.green,
  keyword:            C.accent,
  UNMAPPED:           C.red,
  UNCLASSIFIED:       C.red,
};

const fmtINR = n => {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${Number(n).toLocaleString('en-IN')}`;
};

function ReconBadge({ pass }) {
  return pass
    ? <span style={{ background: C.green + '22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>✓ PASS</span>
    : <span style={{ background: C.red   + '22', color: C.red,   border: `1px solid ${C.red}44`,   borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>✗ FAIL</span>;
}

function ActualRevenueTab({ branches }) {
  const [status,        setStatus]        = useState(null);
  const [summary,       setSummary]       = useState(null);
  const [monthly,       setMonthly]       = useState([]);
  const [unmapped,      setUnmapped]      = useState(null);
  const [unclassified,  setUnclassified]  = useState(null);
  const [recon,         setRecon]         = useState(null);
  const [view,          setView]          = useState('overview'); // overview|monthly|unmapped|unclassified|reconciliation
  const [syncing,       setSyncing]       = useState(false);
  const [syncMsg,       setSyncMsg]       = useState('');
  const [classifyModal, setClassifyModal] = useState(null); // { invoice_id, current_category }
  const [mapModal,      setMapModal]      = useState(null); // { invoice_id, customer_name }
  const [classifyVal,   setClassifyVal]   = useState('');
  const [mapVal,        setMapVal]        = useState('');
  const [saving,        setSaving]        = useState(false);
  const [configStart,   setConfigStart]   = useState('2024-04-01');
  const [showConfig,    setShowConfig]    = useState(false);
  const [pollTimer,     setPollTimer]     = useState(null);

  const loadStatus  = () => apiFetch('/api/fpa/revenue/status').then(setStatus).catch(() => {});
  const loadSummary = () => apiFetch('/api/fpa/revenue/summary').then(setSummary).catch(() => {});
  const loadMonthly = () => apiFetch('/api/fpa/revenue/monthly').then(d => setMonthly(d.months || [])).catch(() => {});
  const loadUnmapped     = () => apiFetch('/api/fpa/revenue/unmapped').then(setUnmapped).catch(() => {});
  const loadUnclassified = () => apiFetch('/api/fpa/revenue/unclassified').then(setUnclassified).catch(() => {});
  const loadRecon   = () => apiFetch('/api/fpa/revenue/reconciliation').then(setRecon).catch(() => {});

  const loadAll = useCallback(() => {
    loadStatus(); loadSummary(); loadMonthly(); loadUnmapped(); loadUnclassified(); loadRecon();
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Poll every 4s while a sync is running
  useEffect(() => {
    if (status?.sync_status === 'running' || status?.sync_in_progress) {
      const t = setTimeout(() => { loadAll(); }, 4000);
      setPollTimer(t);
      return () => clearTimeout(t);
    }
    // Reload data once sync completes
    if (pollTimer && status?.sync_status !== 'running') {
      loadAll();
      setPollTimer(null);
    }
  }, [status?.sync_status, status?.sync_in_progress]);

  const triggerSync = async (fullResync = false) => {
    setSyncing(true); setSyncMsg('');
    try {
      const r = await apiFetch('/api/fpa/revenue/sync', {
        method: 'POST',
        body: JSON.stringify({ full_resync: fullResync, from_date: fullResync ? configStart : undefined }),
      });
      setSyncMsg(r.message || 'Sync started');
      setTimeout(loadStatus, 1500);
    } catch (e) { setSyncMsg('Error: ' + e.message); }
    setSyncing(false);
  };

  const saveClassify = async () => {
    if (!classifyModal || !classifyVal) return;
    setSaving(true);
    try {
      await apiFetch('/api/fpa/revenue/classify', { method: 'PUT', body: JSON.stringify({ invoice_id: classifyModal.invoice_id, category: classifyVal }) });
      setClassifyModal(null);
      loadAll();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  const saveMap = async () => {
    if (!mapModal || !mapVal) return;
    setSaving(true);
    try {
      await apiFetch('/api/fpa/revenue/map', { method: 'PUT', body: JSON.stringify({ invoice_id: mapModal.invoice_id, branch_id: mapVal }) });
      setMapModal(null);
      loadAll();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  const syncRunning = status?.sync_status === 'running' || status?.sync_in_progress;

  const syncStatusColor = {
    idle: C.textMut, running: C.yellow, success: C.green, error: C.red,
  }[status?.sync_status || 'idle'] || C.textMut;

  // ── Sub-views ──────────────────────────────────────────────────────────────
  const views = [
    { id: 'overview',       label: 'Overview' },
    { id: 'monthly',        label: 'Monthly Actuals' },
    { id: 'unmapped',       label: `Unmapped (${summary?.unmapped_count ?? '…'})` },
    { id: 'unclassified',   label: `Unclassified (${summary?.unclassified_count ?? '…'})` },
    { id: 'reconciliation', label: 'Reconciliation' },
  ];

  return (
    <div>
      {/* Modals */}
      {classifyModal && (
        <Modal title={`Classify Invoice ${classifyModal.invoice_number || classifyModal.invoice_id}`} onClose={() => setClassifyModal(null)}>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 12 }}>
            Customer: <strong style={{ color: C.text }}>{classifyModal.customer_name}</strong> · Current: {pill(CATEGORY_COLORS[classifyModal.revenue_category] || C.textMut, CATEGORY_LABELS[classifyModal.revenue_category] || classifyModal.revenue_category)}
          </div>
          <Field label="New Category" required>
            <Sel value={classifyVal} onChange={setClassifyVal}>
              <option value="">Select…</option>
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Sel>
          </Field>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <SaveBtn onClick={saveClassify} loading={saving} label="Save Classification" />
            <button onClick={() => setClassifyModal(null)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </Modal>
      )}
      {mapModal && (
        <Modal title={`Map Branch: ${mapModal.invoice_number || mapModal.invoice_id}`} onClose={() => setMapModal(null)}>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 12 }}>
            Customer: <strong style={{ color: C.text }}>{mapModal.customer_name}</strong>
            {mapModal.branch_name_raw && <span> · Zoho branch_name: <code style={{ color: C.cyan }}>{mapModal.branch_name_raw}</code></span>}
          </div>
          <Field label="Assign to Branch" required>
            <Sel value={mapVal} onChange={setMapVal}>
              <option value="">Select branch…</option>
              {(branches || []).filter(b => b.active !== false).map(b => (
                <option key={b.branch_id} value={b.branch_id}>{b.branch_name} ({b.branch_id})</option>
              ))}
            </Sel>
          </Field>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <SaveBtn onClick={saveMap} loading={saving} label="Save Mapping" />
            <button onClick={() => setMapModal(null)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Header row: sync controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Zoho Actual Revenue</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>
            Invoices + credit notes from Zoho Books · Classified · Branch-mapped · Reconciled
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {status && (
            <span style={{ fontSize: 11, color: syncStatusColor, fontWeight: 600 }}>
              {syncRunning ? '⟳ Syncing…' : `● ${(status.sync_status || 'idle').toUpperCase()}`}
              {status.last_sync_at && !syncRunning && (
                <span style={{ color: C.textMut, fontWeight: 400 }}> · {new Date(status.last_sync_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</span>
              )}
            </span>
          )}
          <button onClick={() => setShowConfig(v => !v)} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 5, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer', fontWeight: 600 }}>⚙ Config</button>
          <button onClick={() => triggerSync(false)} disabled={syncing || syncRunning} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 5, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer', fontWeight: 600, opacity: (syncing || syncRunning) ? 0.5 : 1 }}>↻ Incremental Sync</button>
          <button onClick={() => triggerSync(true)} disabled={syncing || syncRunning} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '5px 14px', fontSize: 11.5, cursor: 'pointer', fontWeight: 700, opacity: (syncing || syncRunning) ? 0.5 : 1 }}>⟳ Full Resync</button>
        </div>
      </div>

      {/* Config panel */}
      {showConfig && (
        <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '14px 18px', marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Historical Start Date (used for full resync)">
            <Inp type="date" value={configStart} onChange={setConfigStart} style={{ width: 160 }} />
          </Field>
          <SaveBtn onClick={async () => { try { await apiFetch('/api/fpa/revenue/config', { method: 'PUT', body: JSON.stringify({ historical_start_date: configStart }) }); setShowConfig(false); } catch (e) { alert(e.message); } }} label="Save" />
          <div style={{ fontSize: 11, color: C.textMut, alignSelf: 'center' }}>
            {status?.total_invoices_synced > 0 && `${status.total_invoices_synced} invoices · ${status.total_credit_notes_synced} credit notes stored`}
          </div>
        </div>
      )}

      {/* Status error banner */}
      {status?.sync_status === 'error' && status.sync_error && (
        <div style={{ background: C.red + '18', border: `1px solid ${C.red}44`, color: C.red, borderRadius: 6, padding: '10px 14px', marginBottom: 14, fontSize: 12.5 }}>
          Sync error: {status.sync_error}
        </div>
      )}
      {syncMsg && (
        <div style={{ background: C.accent + '18', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 6, padding: '8px 14px', marginBottom: 14, fontSize: 12 }}>
          {syncMsg}
        </div>
      )}

      {/* Never-synced empty state */}
      {!status?.last_sync_at && status?.sync_status !== 'running' && (
        <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 8, padding: '28px', textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📥</div>
          <div style={{ color: C.text, fontWeight: 700, marginBottom: 6 }}>No revenue data yet</div>
          <div style={{ color: C.textSec, fontSize: 12.5, marginBottom: 16 }}>Click "Full Resync" to fetch invoices and credit notes from Zoho Books.</div>
          <button onClick={() => triggerSync(true)} disabled={syncing} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 6, padding: '8px 24px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>⟳ Full Resync Now</button>
        </div>
      )}

      {/* Sub-view tabs */}
      {(status?.last_sync_at || status?.sync_status === 'running') && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {views.map(v => <TabButton key={v.id} active={view === v.id} onClick={() => setView(v.id)}>{v.label}</TabButton>)}
          </div>

          {/* ── OVERVIEW ── */}
          {view === 'overview' && summary && (
            <div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                <KpiCard label="Gross Revenue (ex-GST)" value={fmtINR(summary.total_invoices_amount)} color={C.green} />
                <KpiCard label="Credit Notes" value={fmtINR(summary.total_credit_notes_amount)} color={C.red} />
                <KpiCard label="Net Revenue" value={fmtINR(summary.net_revenue)} color={C.accent} />
                <KpiCard label="Mapped %" value={summary.total_invoices_amount > 0 ? `${Math.round(summary.mapped_amount / summary.total_invoices_amount * 100)}%` : '—'} color={summary.unmapped_amount > 0 ? C.yellow : C.green} sub={summary.unmapped_count > 0 ? `${summary.unmapped_count} unmapped invoices` : 'All mapped'} />
                <KpiCard label="Classified %" value={summary.total_invoices_amount > 0 ? `${Math.round(summary.classified_amount / summary.total_invoices_amount * 100)}%` : '—'} color={summary.unclassified_count > 0 ? C.yellow : C.green} sub={summary.unclassified_count > 0 ? `${summary.unclassified_count} need review` : 'All classified'} />
                <KpiCard label="Recon" value={summary.reconciliation_mapping_ok && summary.reconciliation_classif_ok ? 'PASS' : 'FAIL'} color={summary.reconciliation_mapping_ok && summary.reconciliation_classif_ok ? C.green : C.red} />
              </div>

              {/* Category breakdown */}
              {summary.by_category && Object.keys(summary.by_category).length > 0 && (
                <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '16px 20px', marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSec, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>Revenue by Category</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                    {Object.entries(summary.by_category).sort(([,a],[,b]) => b - a).map(([cat, amt]) => (
                      <div key={cat} style={{ background: C.surface, borderRadius: 6, padding: '10px 14px', border: `1px solid ${(CATEGORY_COLORS[cat] || C.textMut)}22` }}>
                        <div style={{ fontSize: 10, color: CATEGORY_COLORS[cat] || C.textMut, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{CATEGORY_LABELS[cat] || cat}</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{fmtINR(amt)}</div>
                        <div style={{ fontSize: 11, color: C.textMut, marginTop: 2 }}>{summary.total_invoices_amount > 0 ? `${Math.round(amt / summary.total_invoices_amount * 100)}%` : '—'} of total</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Reconciliation status strip */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 6, padding: '10px 16px', fontSize: 12, color: C.textSec, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ReconBadge pass={summary.reconciliation_mapping_ok} />
                  <span>Mapping check: mapped + unmapped = total</span>
                </div>
                <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 6, padding: '10px 16px', fontSize: 12, color: C.textSec, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ReconBadge pass={summary.reconciliation_classif_ok} />
                  <span>Classification check: classified + unclassified = total</span>
                </div>
              </div>
            </div>
          )}

          {/* ── MONTHLY ACTUALS ── */}
          {view === 'monthly' && (
            <div>
              <div style={{ fontSize: 12, color: C.textSec, marginBottom: 12 }}>Monthly ex-GST revenue by branch and client. Credit notes deducted per month.</div>
              {monthly.length === 0 ? (
                <div style={{ color: C.textMut, padding: '2rem', textAlign: 'center' }}>No monthly data yet — run a sync first.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: C.surfaceEl }}>
                        {['Month', 'Gross Revenue', 'Mapped', 'Unmapped', 'Classified', 'Unclassified', 'Recon'].map(h => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Month' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...monthly].reverse().map(m => {
                        const reconOk = Math.abs((m.mapped + m.unmapped) - m.total) < 0.02 && Math.abs((m.classified + m.unclassified) - m.total) < 0.02;
                        return (
                          <tr key={m.month} style={{ borderBottom: `1px solid ${C.border}` }}>
                            <td style={{ padding: '8px 12px', color: C.text, fontWeight: 600, fontFamily: 'monospace' }}>{m.month}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: C.text, fontVariantNumeric: 'tabular-nums' }}>{fmtINR(m.total)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: C.green, fontVariantNumeric: 'tabular-nums' }}>{fmtINR(m.mapped)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: m.unmapped > 0 ? C.red : C.textMut, fontVariantNumeric: 'tabular-nums' }}>{m.unmapped > 0 ? fmtINR(m.unmapped) : '—'}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: C.green, fontVariantNumeric: 'tabular-nums' }}>{fmtINR(m.classified)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: m.unclassified > 0 ? C.yellow : C.textMut, fontVariantNumeric: 'tabular-nums' }}>{m.unclassified > 0 ? fmtINR(m.unclassified) : '—'}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right' }}><ReconBadge pass={reconOk} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── UNMAPPED EXCEPTIONS ── */}
          {view === 'unmapped' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div>
                  <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Unmapped Revenue</div>
                  <div style={{ fontSize: 12, color: C.textSec }}>Invoices that could not be assigned to any branch. Never silently dropped — shown here for mandatory resolution.</div>
                </div>
                {unmapped && <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: unmapped.count > 0 ? C.red : C.green }}>{unmapped.count}</div>
                  <div style={{ fontSize: 11, color: C.textMut }}>{fmtINR(unmapped.total_amount)}</div>
                </div>}
              </div>
              {unmapped?.count === 0 ? (
                <div style={{ background: C.green + '12', border: `1px solid ${C.green}33`, borderRadius: 6, padding: '16px 20px', color: C.green, fontWeight: 600, fontSize: 13 }}>✓ All invoices are mapped to a branch.</div>
              ) : unmapped?.records?.length > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: C.surfaceEl }}>
                        {['Invoice #', 'Customer', 'Date', 'Amount (ex-GST)', 'Zoho Branch Raw', 'Action'].map(h => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Amount (ex-GST)' ? 'right' : 'left', color: C.textSec, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {unmapped.records.map(r => (
                        <tr key={r.invoice_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: C.accent, fontSize: 11 }}>{r.invoice_number}</td>
                          <td style={{ padding: '8px 12px', color: C.text }}>{r.customer_name}</td>
                          <td style={{ padding: '8px 12px', color: C.textSec, fontFamily: 'monospace', fontSize: 11 }}>{r.date}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: C.text, fontVariantNumeric: 'tabular-nums' }}>{fmtINR(r.sub_total)}</td>
                          <td style={{ padding: '8px 12px', color: C.textMut, fontStyle: r.branch_name_raw ? 'normal' : 'italic', fontSize: 11 }}>{r.branch_name_raw || '(none)'}</td>
                          <td style={{ padding: '8px 12px' }}>
                            <button onClick={() => { setMapModal(r); setMapVal(''); }} style={{ background: C.accent + '22', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 4, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Map Branch</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ color: C.textMut, padding: '2rem' }}>Loading…</div>
              )}
            </div>
          )}

          {/* ── UNCLASSIFIED EXCEPTIONS ── */}
          {view === 'unclassified' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div>
                  <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Unclassified Revenue</div>
                  <div style={{ fontSize: 12, color: C.textSec }}>Invoices that could not be auto-classified. Manual classification here is saved and survives future syncs.</div>
                </div>
                {unclassified && <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: unclassified.count > 0 ? C.yellow : C.green }}>{unclassified.count}</div>
                  <div style={{ fontSize: 11, color: C.textMut }}>{fmtINR(unclassified.total_amount)}</div>
                </div>}
              </div>
              {unclassified?.count === 0 ? (
                <div style={{ background: C.green + '12', border: `1px solid ${C.green}33`, borderRadius: 6, padding: '16px 20px', color: C.green, fontWeight: 600, fontSize: 13 }}>✓ All invoices are classified.</div>
              ) : unclassified?.records?.length > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: C.surfaceEl }}>
                        {['Invoice #', 'Customer', 'Date', 'Amount (ex-GST)', 'cf_invoice_category', 'Action'].map(h => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Amount (ex-GST)' ? 'right' : 'left', color: C.textSec, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {unclassified.records.map(r => (
                        <tr key={r.invoice_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: C.accent, fontSize: 11 }}>{r.invoice_number}</td>
                          <td style={{ padding: '8px 12px', color: C.text }}>{r.customer_name}</td>
                          <td style={{ padding: '8px 12px', color: C.textSec, fontFamily: 'monospace', fontSize: 11 }}>{r.date}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: C.text, fontVariantNumeric: 'tabular-nums' }}>{fmtINR(r.sub_total)}</td>
                          <td style={{ padding: '8px 12px', color: C.textMut, fontStyle: r.cf_invoice_category ? 'normal' : 'italic', fontSize: 11 }}>{r.cf_invoice_category || '(empty)'}</td>
                          <td style={{ padding: '8px 12px' }}>
                            <button onClick={() => { setClassifyModal(r); setClassifyVal(r.revenue_category || ''); }} style={{ background: C.yellow + '22', border: `1px solid ${C.yellow}44`, color: C.yellow, borderRadius: 4, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Classify</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ color: C.textMut, padding: '2rem' }}>Loading…</div>
              )}
            </div>
          )}

          {/* ── RECONCILIATION ── */}
          {view === 'reconciliation' && recon && (
            <div>
              <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Reconciliation Controls</div>
              <div style={{ fontSize: 12, color: C.textSec, marginBottom: 16 }}>Ensures no revenue is silently dropped — total must equal mapped + unmapped and classified + unclassified.</div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                <KpiCard label="Total Invoice Rev." value={fmtINR(recon.total_invoice_amount)} />
                <KpiCard label="Credit Notes" value={fmtINR(recon.credit_note_total)} color={C.red} />
                <KpiCard label="Net Revenue" value={fmtINR(recon.net_revenue)} color={C.green} />
                <KpiCard label="Mapped" value={fmtINR(recon.mapped_amount)} color={C.green} />
                <KpiCard label="Unmapped" value={fmtINR(recon.unmapped_amount)} color={recon.unmapped_amount > 0 ? C.red : C.textMut} />
              </div>

              <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'hidden' }}>
                {recon.checks.map((c, i) => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', borderBottom: i < recon.checks.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.textMut, background: C.surface, padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>{c.id}</span>
                    <ReconBadge pass={c.pass} />
                    <div style={{ flex: 1 }}>
                      <div style={{ color: C.text, fontSize: 12.5, fontWeight: 600 }}>{c.name}</div>
                      {c.note && <div style={{ color: C.textMut, fontSize: 11, marginTop: 2 }}>{c.note}</div>}
                      {c.gap !== undefined && Math.abs(c.gap) > 0.01 && <div style={{ color: C.red, fontSize: 11, marginTop: 2 }}>Gap: ₹{c.gap.toFixed(2)}</div>}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 12, padding: '12px 16px', background: recon.all_checks_pass ? C.green + '12' : C.red + '12', border: `1px solid ${recon.all_checks_pass ? C.green : C.red}33`, borderRadius: 6, fontSize: 13, color: recon.all_checks_pass ? C.green : C.red, fontWeight: 700 }}>
                {recon.all_checks_pass ? '✓ All reconciliation checks pass. Revenue data is internally consistent.' : '✗ One or more reconciliation checks failed. Review and resolve exceptions.'}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// REVENUE PROJECTION TAB — Step 4
// ─────────────────────────────────────────────────────────────────────────────
const fmtINR2 = n => {
  if (!n && n !== 0) return '—';
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${(n/1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `₹${(n/1e5).toFixed(2)}L`;
  return `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

const TYPE_COLORS = { actual: C.green, forecast: C.accent, not_open: C.textMut, closed: C.textMut };

function ReconBadge2({ pass }) {
  return pass
    ? <span style={{ background: C.green+'22', color: C.green, border: `1px solid ${C.green}44`, borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>✓ PASS</span>
    : <span style={{ background: C.red+'22',   color: C.red,   border: `1px solid ${C.red}44`,   borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>✗ FAIL</span>;
}

function ProjectionTab({ branches }) {
  const [summary,    setSummary]    = useState(null);
  const [monthly,    setMonthly]    = useState([]);
  const [bridge,     setBridge]     = useState([]);
  const [recon,      setRecon]      = useState(null);
  const [valIssues,  setValIssues]  = useState(null);
  const [config,     setConfig]     = useState(null);
  const [assumptions,setAssumptions]= useState([]);
  const [view,       setView]       = useState('overview');
  const [computing,  setComputing]  = useState(false);
  const [computeMsg, setComputeMsg] = useState('');
  const [selBranch,  setSelBranch]  = useState('');
  const [branchDetail,setBranchDetail]=useState([]);
  const [editConfig, setEditConfig] = useState(false);
  const [configForm, setConfigForm] = useState({});
  const [asmModal,   setAsmModal]   = useState(null);
  const [asmForm,    setAsmForm]    = useState({});
  const [asmSaving,  setAsmSaving]  = useState(false);
  const [derivingMsg,setDerivingMsg]= useState('');

  const loadAll = useCallback(async () => {
    try {
      const [sum, mon, br, rec, val, cfg, asm] = await Promise.all([
        apiFetch('/api/fpa/projection/summary').catch(() => null),
        apiFetch('/api/fpa/projection/monthly').catch(() => ({ months: [] })),
        apiFetch('/api/fpa/projection/bridge').catch(() => ({ bridge: [] })),
        apiFetch('/api/fpa/projection/reconciliation').catch(() => null),
        apiFetch('/api/fpa/projection/validation').catch(() => ({ issues: [] })),
        apiFetch('/api/fpa/projection/config').catch(() => null),
        apiFetch('/api/fpa/projection/assumptions').catch(() => ({ assumptions: [] })),
      ]);
      setSummary(sum);
      setMonthly(mon.months || []);
      setBridge(br.bridge || []);
      setRecon(rec);
      setValIssues(val?.issues || []);
      setConfig(cfg);
      setConfigForm(cfg || {});
      setAssumptions(asm.assumptions || []);
    } catch (e) { console.error('Projection load:', e); }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (summary?.compute_in_progress) {
      const t = setTimeout(loadAll, 4000);
      return () => clearTimeout(t);
    }
  }, [summary?.compute_in_progress, loadAll]);

  const triggerCompute = async () => {
    setComputing(true); setComputeMsg('');
    try {
      const r = await apiFetch('/api/fpa/projection/compute', { method: 'POST' });
      setComputeMsg(r.message || 'Computation started');
      setTimeout(loadAll, 2000);
    } catch (e) { setComputeMsg('Error: ' + e.message); }
    setComputing(false);
  };

  const deriveBases = async () => {
    setDerivingMsg('Deriving from Zoho actuals…');
    try {
      const r = await apiFetch('/api/fpa/projection/derive-bases', { method: 'POST' });
      setDerivingMsg(`Done — ${r.updated} mappings updated`);
      loadAll();
    } catch (e) { setDerivingMsg('Error: ' + e.message); }
    setTimeout(() => setDerivingMsg(''), 3000);
  };

  const saveConfig = async () => {
    try {
      await apiFetch('/api/fpa/projection/config', { method: 'PUT', body: JSON.stringify(configForm) });
      setEditConfig(false); loadAll();
    } catch (e) { alert(e.message); }
  };

  const loadBranchDetail = async (bid) => {
    setSelBranch(bid);
    try {
      const d = await apiFetch(`/api/fpa/projection/branch/${bid}`);
      setBranchDetail(d.months || []);
    } catch (e) { setBranchDetail([]); }
  };

  const openAsmModal = (asm) => { setAsmModal(asm); setAsmForm({ ...asm }); };

  const saveAsm = async () => {
    if (!asmModal?.mapping_id) return;
    setAsmSaving(true);
    try {
      await apiFetch(`/api/fpa/projection/assumptions/${asmModal.mapping_id}`, { method: 'PUT', body: JSON.stringify(asmForm) });
      setAsmModal(null); loadAll();
    } catch (e) { alert(e.message); }
    setAsmSaving(false);
  };

  const subViews = [
    { id: 'overview',       label: 'Overview' },
    { id: 'monthly',        label: 'Monthly Table' },
    { id: 'branch',         label: 'Branch View' },
    { id: 'bridge',         label: 'Revenue Bridge' },
    { id: 'reconciliation', label: 'Reconciliation' },
    { id: 'assumptions',    label: 'Assumptions' },
    { id: 'validation',     label: `Validation (${valIssues?.length ?? '…'})` },
  ];

  const isRunning = summary?.compute_in_progress || computing;

  return (
    <div>
      {/* Assumption edit modal */}
      {asmModal && (
        <Modal title={`Forecast Assumptions — ${asmModal.client_id || asmModal.mapping_id}`} onClose={() => setAsmModal(null)} width={600}>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 14 }}>
            Derived base: <strong style={{ color: C.cyan }}>{fmtINR2(asmModal.derived_base_revenue)}</strong>
            <span style={{ color: C.textMut }}> ({asmModal.derived_base_source || '—'})</span>
          </div>
          <TwoCol>
            <Field label="Contracted Monthly Revenue (₹)" source="MANUAL">
              <Inp type="number" value={asmForm.contracted_monthly_revenue} onChange={v => setAsmForm(p => ({ ...p, contracted_monthly_revenue: v === '' ? null : Number(v) }))} placeholder="leave blank to use derived" />
            </Field>
            <Field label="Manual Override Revenue (₹)" source="OVERRIDE">
              <Inp type="number" value={asmForm.manual_override_revenue} onChange={v => setAsmForm(p => ({ ...p, manual_override_revenue: v === '' ? null : Number(v) }))} placeholder="highest priority" />
            </Field>
            <Field label="Revenue Start Date" source="MANUAL">
              <Inp type="date" value={asmForm.revenue_start_date} onChange={v => setAsmForm(p => ({ ...p, revenue_start_date: v || null }))} />
            </Field>
            <Field label="Revenue End Date" source="MANUAL">
              <Inp type="date" value={asmForm.revenue_end_date} onChange={v => setAsmForm(p => ({ ...p, revenue_end_date: v || null }))} />
            </Field>
            <Field label="Capacity (sq ft)" source="MANUAL">
              <Inp type="number" value={asmForm.capacity_sqft} onChange={v => setAsmForm(p => ({ ...p, capacity_sqft: v === '' ? null : Number(v) }))} placeholder="for anti-double-count" />
            </Field>
            <Field label="Escalation %" source="MANUAL">
              <Inp type="number" value={asmForm.escalation_pct} onChange={v => setAsmForm(p => ({ ...p, escalation_pct: v === '' ? null : Number(v) }))} placeholder="override branch/global" />
            </Field>
            <Field label="Escalation Effective Date" source="MANUAL">
              <Inp type="date" value={asmForm.escalation_effective_date} onChange={v => setAsmForm(p => ({ ...p, escalation_effective_date: v || null }))} />
            </Field>
            <Field label="Escalation Frequency" source="MANUAL">
              <Sel value={asmForm.escalation_frequency || 'annual'} onChange={v => setAsmForm(p => ({ ...p, escalation_frequency: v }))}>
                <option value="annual">Annual</option>
                <option value="one_time">One-Time</option>
              </Sel>
            </Field>
          </TwoCol>
          {asmForm.manual_override_revenue && (
            <Field label="Override Reason" required>
              <Inp value={asmForm.manual_override_reason} onChange={v => setAsmForm(p => ({ ...p, manual_override_reason: v }))} placeholder="Required when using manual override" />
            </Field>
          )}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <SaveBtn onClick={saveAsm} loading={asmSaving} />
            <button onClick={() => setAsmModal(null)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Header controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Revenue Projection Engine</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>Client forecast · Escalation · Incremental capacity · Revenue bridge · 5 reconciliation checks</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {summary?.computed_at && !isRunning && (
            <span style={{ fontSize: 11, color: C.textMut }}>
              Last computed: {new Date(summary.computed_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          )}
          {isRunning && <span style={{ fontSize: 11, color: C.yellow, fontWeight: 600 }}>⟳ Computing…</span>}
          <button onClick={deriveBases} disabled={isRunning} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 5, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer', fontWeight: 600 }}>
            ⟳ Derive Bases from Zoho
          </button>
          <button onClick={() => setEditConfig(v => !v)} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 5, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer', fontWeight: 600 }}>
            ⚙ Config
          </button>
          <button onClick={triggerCompute} disabled={isRunning} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '5px 16px', fontSize: 11.5, cursor: 'pointer', fontWeight: 700, opacity: isRunning ? 0.5 : 1 }}>
            ▶ Run Projection
          </button>
        </div>
      </div>

      {derivingMsg && <div style={{ background: C.accent+'18', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 6, padding: '8px 14px', marginBottom: 12, fontSize: 12 }}>{derivingMsg}</div>}
      {computeMsg && <div style={{ background: C.accent+'18', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 6, padding: '8px 14px', marginBottom: 12, fontSize: 12 }}>{computeMsg}</div>}

      {/* Config panel */}
      {editConfig && config && (
        <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '14px 20px', marginBottom: 16 }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 12 }}>Forecast Configuration</div>
          <TwoCol>
            <Field label="Actual Cut-Off Month (last actual)" source="MANUAL">
              <Inp type="month" value={configForm.actual_cutoff_month} onChange={v => setConfigForm(p => ({ ...p, actual_cutoff_month: v }))} />
            </Field>
            <Field label="Forecast Start Month" source="MANUAL">
              <Inp type="month" value={configForm.forecast_start} onChange={v => setConfigForm(p => ({ ...p, forecast_start: v }))} />
            </Field>
            <Field label="Forecast End Month" source="MANUAL">
              <Inp type="month" value={configForm.forecast_end} onChange={v => setConfigForm(p => ({ ...p, forecast_end: v }))} />
            </Field>
            <Field label="Scenario" source="MANUAL">
              <Sel value={configForm.scenario || 'base'} onChange={v => setConfigForm(p => ({ ...p, scenario: v }))}>
                <option value="base">Base</option>
                <option value="conservative">Conservative</option>
                <option value="aggressive">Aggressive</option>
              </Sel>
            </Field>
            <Field label="Proration Method" source="MANUAL">
              <Sel value={configForm.proration_method || 'daily'} onChange={v => setConfigForm(p => ({ ...p, proration_method: v }))}>
                <option value="daily">Daily Proration</option>
                <option value="full_month">Full Month</option>
                <option value="next_full_month">Next Full Month</option>
              </Sel>
            </Field>
            <Field label="Version Label" source="MANUAL">
              <Inp value={configForm.version_label} onChange={v => setConfigForm(p => ({ ...p, version_label: v }))} />
            </Field>
          </TwoCol>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <SaveBtn onClick={saveConfig} label="Save Config" />
            <button onClick={() => setEditConfig(false)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      {/* No output state */}
      {!summary?.has_output && !isRunning && (
        <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 8, padding: '28px', textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
          <div style={{ color: C.text, fontWeight: 700, marginBottom: 6 }}>No projection computed yet</div>
          <div style={{ color: C.textSec, fontSize: 12.5, marginBottom: 16 }}>
            First run "Derive Bases from Zoho" to auto-populate base revenues, then click "Run Projection".
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={deriveBases} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 18px', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>① Derive Bases from Zoho</button>
            <button onClick={triggerCompute} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 6, padding: '8px 24px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>② Run Projection</button>
          </div>
        </div>
      )}

      {/* Sub-views */}
      {(summary?.has_output || isRunning) && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {subViews.map(v => <TabButton key={v.id} active={view === v.id} onClick={() => setView(v.id)}>{v.label}</TabButton>)}
          </div>

          {/* ── OVERVIEW ── */}
          {view === 'overview' && summary && (
            <div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                <KpiCard label="Last Actual Month" value={fmtINR2(summary.last_actual_revenue)} color={C.green} sub={summary.last_actual_month || '—'} />
                <KpiCard label="Next Forecast Month" value={fmtINR2(summary.first_forecast_revenue)} color={C.accent} sub={summary.first_forecast_month || '—'} />
                <KpiCard label={summary.fy_label + ' Total'} value={fmtINR2(summary.fy_forecast_total)} color={C.purple} />
                <KpiCard label="Actual Months" value={summary.total_actual_months} color={C.green} sub="in projection range" />
                <KpiCard label="Forecast Months" value={summary.total_forecast_months} color={C.accent} />
                <KpiCard label="Reconciliation" value={summary.reconciliation_pass ? 'PASS' : summary.reconciliation_pass === false ? 'FAIL' : '—'} color={summary.reconciliation_pass ? C.green : C.red} />
                <KpiCard label="Validation Issues" value={summary.validation_issue_count} color={summary.validation_issue_count > 0 ? C.yellow : C.green} />
              </div>
              {config && (
                <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '14px 18px', fontSize: 12 }}>
                  <div style={{ color: C.textSec, fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5, marginBottom: 10 }}>Active Configuration</div>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    {[
                      ['Actual Cut-Off', config.actual_cutoff_month],
                      ['Forecast Start', config.forecast_start],
                      ['Forecast End', config.forecast_end],
                      ['Scenario', config.scenario],
                      ['Proration', config.proration_method],
                      ['Version', config.version_label],
                    ].map(([l, v]) => (
                      <div key={l}><div style={{ color: C.textMut, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>{l}</div><div style={{ color: C.text, fontWeight: 600, marginTop: 2 }}>{v || '—'}</div></div>
                    ))}
                  </div>
                  <div style={{ marginTop: 10, padding: '8px 12px', background: C.surface, borderRadius: 5, color: C.textMut, fontSize: 11 }}>
                    ⚡ Months ≤ {config.actual_cutoff_month} use <strong style={{ color: C.green }}>Zoho actual</strong> revenue. Months &gt; {config.actual_cutoff_month} use <strong style={{ color: C.accent }}>projected</strong> values.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── MONTHLY TABLE ── */}
          {view === 'monthly' && (
            <div>
              <div style={{ fontSize: 12, color: C.textSec, marginBottom: 10 }}>Green rows = Actuals from Zoho. Blue rows = Forecast. Amounts are ex-GST.</div>
              {monthly.length === 0
                ? <div style={{ color: C.textMut, padding: '2rem' }}>No data — run projection first.</div>
                : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: C.surfaceEl }}>
                        {['Month', 'FY', 'Type', 'Client Base', 'Escalation', 'Vacant Cap.', 'Total Revenue', 'Branches', 'Issues'].map(h => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Month' || h === 'FY' || h === 'Type' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {monthly.map(m => (
                        <tr key={m.month} style={{ borderBottom: `1px solid ${C.border}`, background: m.type === 'actual' ? C.green + '06' : 'transparent' }}>
                          <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: C.text, fontWeight: 600 }}>{m.month}</td>
                          <td style={{ padding: '7px 12px', fontSize: 11, color: C.textMut }}>{m.fy}</td>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ background: (TYPE_COLORS[m.type] || C.textMut) + '22', color: TYPE_COLORS[m.type] || C.textMut, border: `1px solid ${(TYPE_COLORS[m.type] || C.textMut)}44`, borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 700 }}>{m.type?.toUpperCase()}</span>
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textSec, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.client_base)}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: m.client_escalation > 0 ? C.green : C.textMut, fontVariantNumeric: 'tabular-nums' }}>{m.client_escalation > 0 ? fmtINR2(m.client_escalation) : '—'}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.purple, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.vacant_capacity)}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_total)}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textMut, fontSize: 11 }}>{m.branch_count}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: m.validation_issue_count > 0 ? C.yellow : C.textMut, fontSize: 11 }}>{m.validation_issue_count || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── BRANCH VIEW ── */}
          {view === 'branch' && (
            <div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
                <Field label="Select Branch">
                  <Sel value={selBranch} onChange={v => { if (v) loadBranchDetail(v); setSelBranch(v); }} style={{ width: 280 }}>
                    <option value="">Choose a branch…</option>
                    {(branches || []).filter(b => b.active !== false).map(b => (
                      <option key={b.branch_id} value={b.branch_id}>{b.branch_name} ({b.branch_id})</option>
                    ))}
                  </Sel>
                </Field>
              </div>
              {selBranch && branchDetail.length === 0 && <div style={{ color: C.textMut }}>No data for this branch. Run projection first.</div>}
              {branchDetail.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: C.surfaceEl }}>
                        {['Month', 'Type', 'Client Rev', 'Escalation', 'Vacant Cap', 'Total', 'Clients', 'Capacity', 'Occ %', 'Rate ₹/sqft'].map(h => (
                          <th key={h} style={{ padding: '7px 12px', textAlign: h === 'Month' || h === 'Type' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {branchDetail.map(row => (
                        <tr key={row.month} style={{ borderBottom: `1px solid ${C.border}`, background: row.month_type === 'actual' ? C.green + '06' : 'transparent' }}>
                          <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: C.text, fontWeight: 600 }}>{row.month}</td>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ background: (TYPE_COLORS[row.type] || C.textMut) + '22', color: TYPE_COLORS[row.type] || C.textMut, borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700 }}>{row.type?.toUpperCase()}</span>
                          </td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textSec, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(row.client_base_revenue)}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: row.client_escalation_revenue > 0 ? C.green : C.textMut, fontVariantNumeric: 'tabular-nums' }}>{row.client_escalation_revenue > 0 ? fmtINR2(row.client_escalation_revenue) : '—'}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.purple, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(row.vacant_capacity_revenue)}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(row.total_revenue)}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textMut, fontSize: 11 }}>{row.clients?.length || 0}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textMut, fontSize: 11 }}>{row.existing_client_capacity > 0 ? `${row.existing_client_capacity}/${row.total_capacity} sqft` : row.total_capacity > 0 ? `${row.total_capacity} sqft` : '—'}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: row.occupancy_pct > 100 ? C.red : C.textSec, fontSize: 11 }}>{row.occupancy_pct != null ? `${row.occupancy_pct}%` : '—'}</td>
                          <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textMut, fontSize: 11 }}>{row.revenue_rate != null ? `₹${row.revenue_rate}` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── REVENUE BRIDGE ── */}
          {view === 'bridge' && (
            <div>
              <div style={{ fontSize: 12, color: C.textSec, marginBottom: 12 }}>Opening revenue + escalations + new clients − exits + vacant capacity + future branches = closing revenue. Actual months show net movement only.</div>
              {bridge.length === 0
                ? <div style={{ color: C.textMut }}>No data. Run projection first.</div>
                : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: C.surfaceEl }}>
                        {['Month', 'Type', 'Opening', 'Client Base', 'Escalation', 'New Clients', 'Exits', 'Vacant Cap', 'Future Branch', 'Closing', 'Δ Net'].map(h => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: h === 'Month' || h === 'Type' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {bridge.map(row => (
                        <tr key={row.month} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontSize: 11, color: C.text }}>{row.month}</td>
                          <td style={{ padding: '7px 10px' }}>
                            <span style={{ background: (TYPE_COLORS[row.type] || C.textMut) + '22', color: TYPE_COLORS[row.type] || C.textMut, borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700 }}>{row.type?.toUpperCase()}</span>
                          </td>
                          {[row.opening_revenue, row.client_base, row.escalation_additions, row.new_client_additions, row.exit_deductions, row.vacant_capacity, row.future_branch, row.closing_revenue].map((v, i) => (
                            <td key={i} style={{ padding: '7px 10px', textAlign: 'right', color: C.textSec, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(v)}</td>
                          ))}
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: row.net_movement >= 0 ? C.green : C.red, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{row.net_movement >= 0 ? '+' : ''}{fmtINR2(row.net_movement)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── RECONCILIATION ── */}
          {view === 'reconciliation' && recon && (
            <div>
              <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Projection Reconciliation Checks</div>
              <div style={{ fontSize: 12, color: C.textSec, marginBottom: 16 }}>RC-P01 through RC-P05 verify internal consistency of the projection engine.</div>
              {!recon.checks?.length
                ? <div style={{ color: C.textMut }}>No reconciliation data. Run projection first.</div>
                : (
                <>
                  <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'hidden', marginBottom: 14 }}>
                    {recon.checks.map((c, i) => (
                      <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 16px', borderBottom: i < recon.checks.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.textMut, background: C.surface, padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>{c.id}</span>
                        <ReconBadge2 pass={c.pass} />
                        <div style={{ flex: 1 }}>
                          <div style={{ color: C.text, fontSize: 12.5, fontWeight: 600 }}>{c.name}</div>
                          {c.note && <div style={{ color: C.textMut, fontSize: 11, marginTop: 2 }}>{c.note}</div>}
                          {c.gap !== undefined && c.gap !== 0 && <div style={{ color: C.red, fontSize: 11, marginTop: 2 }}>Gap: ₹{c.gap?.toFixed(2)}</div>}
                          {c.violations?.length > 0 && <div style={{ color: C.red, fontSize: 11, marginTop: 2 }}>{c.violations.join(' · ')}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding: '12px 16px', background: recon.all_pass ? C.green + '12' : C.red + '12', border: `1px solid ${recon.all_pass ? C.green : C.red}33`, borderRadius: 6, color: recon.all_pass ? C.green : C.red, fontWeight: 700, fontSize: 13 }}>
                    {recon.all_pass ? '✓ All projection reconciliation checks pass.' : '✗ One or more checks failed. Review data issues.'}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── ASSUMPTIONS ── */}
          {view === 'assumptions' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Client Forecast Assumptions</div>
                  <div style={{ fontSize: 12, color: C.textSec }}>Base revenues, escalation, start/end dates, capacity. Click a row to edit. Run "Derive Bases from Zoho" first.</div>
                </div>
              </div>
              {assumptions.length === 0
                ? (
                <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '24px', textAlign: 'center', color: C.textMut }}>
                  <div style={{ marginBottom: 8 }}>No assumptions yet.</div>
                  <button onClick={deriveBases} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '6px 16px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Derive Bases from Zoho Actuals</button>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: C.surfaceEl }}>
                        {['Mapping', 'Client', 'Branch', 'Derived Base', 'Contracted', 'Override', 'Escalation', 'Start', 'End', 'Capacity', 'Actions'].map(h => (
                          <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {assumptions.map(a => (
                        <tr key={a.mapping_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.textMut, fontSize: 10 }}>{a.mapping_id}</td>
                          <td style={{ padding: '7px 12px', color: C.text }}>{a.client_id}</td>
                          <td style={{ padding: '7px 12px', color: C.textSec, fontSize: 11 }}>{a.branch_id}</td>
                          <td style={{ padding: '7px 12px', color: C.cyan, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(a.derived_base_revenue)}</td>
                          <td style={{ padding: '7px 12px', color: a.contracted_monthly_revenue ? C.green : C.textMut, fontVariantNumeric: 'tabular-nums' }}>{a.contracted_monthly_revenue ? fmtINR2(a.contracted_monthly_revenue) : '—'}</td>
                          <td style={{ padding: '7px 12px', color: a.manual_override_revenue != null ? C.orange : C.textMut, fontVariantNumeric: 'tabular-nums' }}>{a.manual_override_revenue != null ? fmtINR2(a.manual_override_revenue) : '—'}</td>
                          <td style={{ padding: '7px 12px', color: C.textSec, fontSize: 11 }}>{a.escalation_pct != null ? `${a.escalation_pct}%` : '—'}</td>
                          <td style={{ padding: '7px 12px', color: C.textMut, fontSize: 11, fontFamily: 'monospace' }}>{a.revenue_start_date || '—'}</td>
                          <td style={{ padding: '7px 12px', color: C.textMut, fontSize: 11, fontFamily: 'monospace' }}>{a.revenue_end_date || '—'}</td>
                          <td style={{ padding: '7px 12px', color: C.textMut, fontSize: 11 }}>{a.capacity_sqft ? `${a.capacity_sqft} sqft` : '—'}</td>
                          <td style={{ padding: '7px 12px' }}>
                            <button onClick={() => openAsmModal(a)} style={{ background: C.accent + '22', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 4, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Edit</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── VALIDATION ── */}
          {view === 'validation' && (
            <div>
              <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Projection Validation Issues</div>
              <div style={{ fontSize: 12, color: C.textSec, marginBottom: 14 }}>Capacity errors, missing base revenues, occupancy anomalies, and double-count warnings.</div>
              {!valIssues?.length
                ? <div style={{ background: C.green + '12', border: `1px solid ${C.green}33`, borderRadius: 6, padding: '16px 20px', color: C.green, fontWeight: 600, fontSize: 13 }}>✓ No projection validation issues.</div>
                : (
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
                  {valIssues.map((issue, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', borderBottom: i < valIssues.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: issue.level === 'error' ? C.red : issue.level === 'warning' ? C.yellow : C.cyan, background: (issue.level === 'error' ? C.red : issue.level === 'warning' ? C.yellow : C.cyan) + '18', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>{issue.code || issue.level?.toUpperCase()}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: C.textSec, fontSize: 12.5 }}>{issue.message}</div>
                        <div style={{ color: C.textMut, fontSize: 11, marginTop: 2 }}>{issue.month} · {issue.branch_name || issue.branch_id}{issue.client_name ? ` · ${issue.client_name}` : ''}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BRANCH PROFITABILITY TAB — Step 5
// ─────────────────────────────────────────────────────────────────────────────
const COST_CAT_COLORS = {
  rent: C.red, cam: C.orange, utilities: C.yellow,
  facility: C.purple, people: C.cyan, other_opex: C.textSec,
};
const COST_CAT_LABELS = {
  rent: 'Rent', cam: 'CAM', utilities: 'Utilities',
  facility: 'Facility', people: 'People', other_opex: 'Other OpEx',
};

function CostBreakBar({ rent, cam, utilities, facility, people, other_opex }) {
  const total = (rent || 0) + (cam || 0) + (utilities || 0) + (facility || 0) + (people || 0) + (other_opex || 0);
  if (!total) return <span style={{ color: C.textMut, fontSize: 11 }}>—</span>;
  const segments = [
    { k: 'rent', v: rent }, { k: 'cam', v: cam }, { k: 'utilities', v: utilities },
    { k: 'facility', v: facility }, { k: 'people', v: people }, { k: 'other_opex', v: other_opex },
  ].filter(s => s.v > 0);
  return (
    <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', width: '100%', gap: 1 }}>
      {segments.map(s => (
        <div key={s.k} title={`${COST_CAT_LABELS[s.k]}: ${fmtINR2(s.v)}`}
          style={{ background: COST_CAT_COLORS[s.k], width: `${s.v / total * 100}%`, minWidth: 2 }} />
      ))}
    </div>
  );
}

function ProfitabilityTab({ branches }) {
  const [summary,     setSummary]     = useState(null);
  const [monthly,     setMonthly]     = useState([]);
  const [recon,       setRecon]       = useState(null);
  const [valIssues,   setValIssues]   = useState([]);
  const [costMaster,  setCostMaster]  = useState([]);
  const [capexMaster, setCapexMaster] = useState([]);
  const [depMaster,   setDepMaster]   = useState([]);
  const [capexSched,  setCapexSched]  = useState([]);
  const [depSched,    setDepSched]    = useState([]);
  const [unitEcon,    setUnitEcon]    = useState([]);
  const [config,      setConfig]      = useState(null);
  const [view,        setView]        = useState('overview');
  const [computing,   setComputing]   = useState(false);
  const [computeMsg,  setComputeMsg]  = useState('');
  const [selBranch,   setSelBranch]   = useState('');
  const [branchDetail,setBranchDetail]= useState([]);
  const [editConfig,  setEditConfig]  = useState(false);
  const [configForm,  setConfigForm]  = useState({});
  // CRUD modals
  const [costModal,   setCostModal]   = useState(null);
  const [costForm,    setCostForm]    = useState({});
  const [costSaving,  setCostSaving]  = useState(false);
  const [capexModal,  setCapexModal]  = useState(null);
  const [capexForm,   setCapexForm]   = useState({});
  const [capexSaving, setCapexSaving] = useState(false);
  const [depModal,    setDepModal]    = useState(null);
  const [depForm,     setDepForm]     = useState({});
  const [depSaving,   setDepSaving]   = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [sum, mon, rec, val, cm, cxm, dm, cxs, ds, ue, cfg] = await Promise.all([
        apiFetch('/api/fpa/cost/summary').catch(() => null),
        apiFetch('/api/fpa/cost/monthly').catch(() => ({ months: [] })),
        apiFetch('/api/fpa/cost/reconciliation').catch(() => null),
        apiFetch('/api/fpa/cost/validation').catch(() => ({ issues: [] })),
        apiFetch('/api/fpa/cost/cost-master').catch(() => ({ assumptions: [] })),
        apiFetch('/api/fpa/cost/capex-master').catch(() => ({ capex_entries: [] })),
        apiFetch('/api/fpa/cost/deposit-master').catch(() => ({ deposits: [] })),
        apiFetch('/api/fpa/cost/capex-schedule').catch(() => ({ schedule: [] })),
        apiFetch('/api/fpa/cost/deposit-schedule').catch(() => ({ schedule: [] })),
        apiFetch('/api/fpa/cost/unit-economics').catch(() => ({ months: [] })),
        apiFetch('/api/fpa/cost/config').catch(() => null),
      ]);
      setSummary(sum); setMonthly(mon.months || []);
      setRecon(rec); setValIssues(val?.issues || []);
      setCostMaster(cm.assumptions || []);
      setCapexMaster(cxm.capex_entries || []);
      setDepMaster(dm.deposits || []);
      setCapexSched(cxs.schedule || []);
      setDepSched(ds.schedule || []);
      setUnitEcon(ue.months || []);
      setConfig(cfg); setConfigForm(cfg || {});
    } catch (e) { console.error('Cost load error:', e); }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    if (summary?.compute_in_progress) { const t = setTimeout(loadAll, 4000); return () => clearTimeout(t); }
  }, [summary?.compute_in_progress, loadAll]);

  const triggerCompute = async () => {
    setComputing(true); setComputeMsg('');
    try {
      const r = await apiFetch('/api/fpa/cost/compute', { method: 'POST' });
      setComputeMsg(r.message || 'Computation started');
      setTimeout(loadAll, 2000);
    } catch (e) { setComputeMsg('Error: ' + e.message); }
    setComputing(false);
  };

  const saveConfig = async () => {
    try { await apiFetch('/api/fpa/cost/config', { method: 'PUT', body: JSON.stringify(configForm) }); setEditConfig(false); loadAll(); }
    catch (e) { alert(e.message); }
  };

  const loadBranchDetail = async (bid) => {
    setSelBranch(bid);
    try { const d = await apiFetch(`/api/fpa/cost/branch/${bid}`); setBranchDetail(d.months || []); }
    catch (e) { setBranchDetail([]); }
  };

  // Cost Master CRUD
  const openCostModal = (asm) => { setCostModal(asm || { _new: true }); setCostForm(asm ? { ...asm } : { cost_category: 'occupancy', cost_subcategory: 'rent', calc_method: 'per_sqft', variability: 'fixed', cost_nature: 'opex', active: true }); };
  const saveCost = async () => {
    setCostSaving(true);
    try {
      if (costModal._new) await apiFetch('/api/fpa/cost/cost-master', { method: 'POST', body: JSON.stringify(costForm) });
      else await apiFetch(`/api/fpa/cost/cost-master/${costModal.assumption_id}`, { method: 'PUT', body: JSON.stringify(costForm) });
      setCostModal(null); loadAll();
    } catch (e) { alert(e.message); }
    setCostSaving(false);
  };
  const deleteCost = async (id) => {
    if (!window.confirm('Deactivate this cost assumption?')) return;
    try { await apiFetch(`/api/fpa/cost/cost-master/${id}`, { method: 'DELETE' }); loadAll(); }
    catch (e) { alert(e.message); }
  };

  // Capex Master CRUD
  const openCapexModal = (cx) => {
    setCapexModal(cx || { _new: true });
    setCapexForm(cx ? { ...cx } : { capex_category: 'fit_out', payment_schedule: [{ months_before_opening: 3, pct: 30 }, { months_before_opening: 2, pct: 40 }, { months_before_opening: 1, pct: 20 }, { months_before_opening: 0, pct: 10 }], active: true });
  };
  const saveCapex = async () => {
    setCapexSaving(true);
    try {
      if (capexModal._new) await apiFetch('/api/fpa/cost/capex-master', { method: 'POST', body: JSON.stringify(capexForm) });
      else await apiFetch(`/api/fpa/cost/capex-master/${capexModal.capex_id}`, { method: 'PUT', body: JSON.stringify(capexForm) });
      setCapexModal(null); loadAll();
    } catch (e) { alert(e.message); }
    setCapexSaving(false);
  };

  // Deposit Master CRUD
  const openDepModal = (dep) => {
    setDepModal(dep || { _new: true });
    setDepForm(dep ? { ...dep } : { deposit_type: 'security_deposit', deposit_months: 6, months_before_opening: 3, refundable: true, active: true });
  };
  const saveDep = async () => {
    setDepSaving(true);
    try {
      if (depModal._new) await apiFetch('/api/fpa/cost/deposit-master', { method: 'POST', body: JSON.stringify(depForm) });
      else await apiFetch(`/api/fpa/cost/deposit-master/${depModal.deposit_id}`, { method: 'PUT', body: JSON.stringify(depForm) });
      setDepModal(null); loadAll();
    } catch (e) { alert(e.message); }
    setDepSaving(false);
  };

  const isRunning = summary?.compute_in_progress || computing;

  const subViews = [
    { id: 'overview',       label: 'Overview' },
    { id: 'monthly',        label: 'Monthly P&L' },
    { id: 'branch',         label: 'Branch View' },
    { id: 'unit_economics', label: 'Unit Economics' },
    { id: 'capex',          label: 'Capex' },
    { id: 'deposits',       label: 'Deposits' },
    { id: 'reconciliation', label: 'Reconciliation' },
    { id: 'cost_master',    label: `Cost Master (${costMaster.filter(a => a.active !== false).length})` },
    { id: 'validation',     label: `Validation (${valIssues.length || '…'})` },
  ];

  return (
    <div>
      {/* Cost Master modal */}
      {costModal && (
        <Modal title={costModal._new ? 'Add Cost Assumption' : `Edit — ${costModal.assumption_id}`} onClose={() => setCostModal(null)} width={660}>
          <TwoCol>
            <Field label="Branch" required>
              <Sel value={costForm.branch_id || ''} onChange={v => setCostForm(p => ({ ...p, branch_id: v }))}>
                <option value="">Select branch…</option>
                {(branches || []).map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
              </Sel>
            </Field>
            <Field label="Cost Category" required>
              <Sel value={costForm.cost_category || ''} onChange={v => setCostForm(p => ({ ...p, cost_category: v }))}>
                <option value="occupancy">Occupancy / Property</option>
                <option value="utilities">Utilities</option>
                <option value="facility">Facility Operations</option>
                <option value="people">People Cost</option>
                <option value="other_opex">Other Centre OpEx</option>
              </Sel>
            </Field>
            <Field label="Subcategory">
              <Inp value={costForm.cost_subcategory || ''} onChange={v => setCostForm(p => ({ ...p, cost_subcategory: v }))} placeholder="rent / cam / electricity / housekeeping …" />
            </Field>
            <Field label="Cost Nature">
              <Sel value={costForm.cost_nature || 'opex'} onChange={v => setCostForm(p => ({ ...p, cost_nature: v }))}>
                <option value="opex">OpEx (EBITDA)</option>
                <option value="pre_opening">Pre-Opening</option>
              </Sel>
            </Field>
            <Field label="Variability">
              <Sel value={costForm.variability || 'fixed'} onChange={v => setCostForm(p => ({ ...p, variability: v }))}>
                <option value="fixed">Fixed</option>
                <option value="semi_variable">Semi-Variable</option>
                <option value="variable">Variable</option>
              </Sel>
            </Field>
            <Field label="Calculation Method" required>
              <Sel value={costForm.calc_method || 'fixed_monthly'} onChange={v => setCostForm(p => ({ ...p, calc_method: v }))}>
                <option value="fixed_monthly">Fixed Monthly</option>
                <option value="per_sqft">Per Sq. Ft.</option>
                <option value="per_seat">Per Seat</option>
                <option value="pct_of_revenue">% of Revenue</option>
                <option value="occupancy_linked">Occupancy-Linked</option>
                <option value="manual_override">Manual Override</option>
              </Sel>
            </Field>
            {(costForm.calc_method === 'per_sqft' || costForm.calc_method === 'occupancy_linked') && (
              <Field label="Rate per Sq. Ft. (₹)" required>
                <Inp type="number" value={costForm.rate_per_sqft ?? ''} onChange={v => setCostForm(p => ({ ...p, rate_per_sqft: v === '' ? null : Number(v) }))} />
              </Field>
            )}
            {costForm.calc_method === 'per_seat' && (
              <Field label="Rate per Seat (₹)" required>
                <Inp type="number" value={costForm.rate_per_seat ?? ''} onChange={v => setCostForm(p => ({ ...p, rate_per_seat: v === '' ? null : Number(v) }))} />
              </Field>
            )}
            {(costForm.calc_method === 'fixed_monthly' || costForm.calc_method === 'manual_override') && (
              <Field label="Fixed Monthly Amount (₹)">
                <Inp type="number" value={costForm.fixed_monthly_amount ?? ''} onChange={v => setCostForm(p => ({ ...p, fixed_monthly_amount: v === '' ? null : Number(v) }))} />
              </Field>
            )}
            {costForm.calc_method === 'pct_of_revenue' && (
              <Field label="Variable % of Revenue">
                <Inp type="number" value={costForm.variable_pct ?? ''} onChange={v => setCostForm(p => ({ ...p, variable_pct: v === '' ? null : Number(v) }))} />
              </Field>
            )}
            {costForm.calc_method === 'per_sqft' && (
              <Field label="Applicable Area Sq. Ft. (blank = branch area)">
                <Inp type="number" value={costForm.applicable_area_sqft ?? ''} onChange={v => setCostForm(p => ({ ...p, applicable_area_sqft: v === '' ? null : Number(v) }))} />
              </Field>
            )}
            <Field label="Effective From">
              <Inp type="date" value={costForm.effective_from || ''} onChange={v => setCostForm(p => ({ ...p, effective_from: v || null }))} />
            </Field>
            <Field label="Effective To">
              <Inp type="date" value={costForm.effective_to || ''} onChange={v => setCostForm(p => ({ ...p, effective_to: v || null }))} />
            </Field>
            {costForm.cost_subcategory === 'rent' && <>
              <Field label="Rent Commencement Date">
                <Inp type="date" value={costForm.rent_commencement_date || ''} onChange={v => setCostForm(p => ({ ...p, rent_commencement_date: v || null }))} />
              </Field>
              <Field label="Rent-Free Start">
                <Inp type="date" value={costForm.rent_free_start || ''} onChange={v => setCostForm(p => ({ ...p, rent_free_start: v || null }))} />
              </Field>
              <Field label="Rent-Free End">
                <Inp type="date" value={costForm.rent_free_end || ''} onChange={v => setCostForm(p => ({ ...p, rent_free_end: v || null }))} />
              </Field>
            </>}
            <Field label="Escalation %">
              <Inp type="number" value={costForm.escalation_pct ?? ''} onChange={v => setCostForm(p => ({ ...p, escalation_pct: v === '' ? null : Number(v) }))} placeholder="blank = no escalation" />
            </Field>
            <Field label="Escalation Effective Date">
              <Inp type="date" value={costForm.escalation_effective_date || ''} onChange={v => setCostForm(p => ({ ...p, escalation_effective_date: v || null }))} />
            </Field>
            <Field label="Escalation Frequency">
              <Sel value={costForm.escalation_frequency || 'annual'} onChange={v => setCostForm(p => ({ ...p, escalation_frequency: v }))}>
                <option value="annual">Annual</option>
                <option value="every_3_years">Every 3 Years</option>
                <option value="one_time">One-Time</option>
              </Sel>
            </Field>
          </TwoCol>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <SaveBtn onClick={saveCost} loading={costSaving} label={costModal._new ? 'Add Assumption' : 'Save'} />
            <button onClick={() => setCostModal(null)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Capex modal */}
      {capexModal && (
        <Modal title={capexModal._new ? 'Add Capex Entry' : `Edit Capex — ${capexModal.capex_id}`} onClose={() => setCapexModal(null)} width={600}>
          <TwoCol>
            <Field label="Branch" required>
              <Sel value={capexForm.branch_id || ''} onChange={v => setCapexForm(p => ({ ...p, branch_id: v }))}>
                <option value="">Select branch…</option>
                {(branches || []).map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
              </Sel>
            </Field>
            <Field label="Capex Category">
              <Sel value={capexForm.capex_category || 'fit_out'} onChange={v => setCapexForm(p => ({ ...p, capex_category: v }))}>
                <option value="fit_out">Fit-Out</option>
                <option value="furniture">Furniture</option>
                <option value="it_network">IT / Network</option>
                <option value="electrical">Electrical</option>
                <option value="hvac">HVAC</option>
                <option value="security_systems">Security Systems</option>
                <option value="leasehold">Leasehold Improvements</option>
                <option value="other">Other Capex</option>
              </Sel>
            </Field>
            <Field label="Area Sq. Ft.">
              <Inp type="number" value={capexForm.area_sqft ?? ''} onChange={v => setCapexForm(p => ({ ...p, area_sqft: v === '' ? null : Number(v) }))} />
            </Field>
            <Field label="Capex per Sq. Ft. (₹)">
              <Inp type="number" value={capexForm.capex_per_sqft ?? ''} onChange={v => setCapexForm(p => ({ ...p, capex_per_sqft: v === '' ? null : Number(v) }))} />
            </Field>
            <Field label="Fixed Capex (₹) — overrides per-sqft">
              <Inp type="number" value={capexForm.fixed_capex ?? ''} onChange={v => setCapexForm(p => ({ ...p, fixed_capex: v === '' ? null : Number(v) }))} />
            </Field>
            <Field label="Opening Date" required>
              <Inp type="date" value={capexForm.opening_date || ''} onChange={v => setCapexForm(p => ({ ...p, opening_date: v || null }))} />
            </Field>
            <Field label="Useful Life (years)">
              <Inp type="number" value={capexForm.useful_life_years ?? ''} onChange={v => setCapexForm(p => ({ ...p, useful_life_years: v === '' ? null : Number(v) }))} placeholder="For Step 6 depreciation" />
            </Field>
            <Field label="Capex Status">
              <Sel value={capexForm.capex_status || 'planned'} onChange={v => setCapexForm(p => ({ ...p, capex_status: v }))}>
                <option value="planned">Planned</option>
                <option value="committed">Committed</option>
                <option value="completed">Completed</option>
              </Sel>
            </Field>
          </TwoCol>
          <div style={{ marginTop: 10, fontSize: 12, color: C.textSec, marginBottom: 6 }}>Payment Schedule (must sum to 100%)</div>
          {(capexForm.payment_schedule || []).map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <Inp type="number" value={t.months_before_opening ?? ''} onChange={v => { const s = [...(capexForm.payment_schedule || [])]; s[i] = { ...s[i], months_before_opening: Number(v) }; setCapexForm(p => ({ ...p, payment_schedule: s })); }} style={{ width: 80 }} />
              <span style={{ color: C.textMut, fontSize: 12 }}>months before opening</span>
              <Inp type="number" value={t.pct ?? ''} onChange={v => { const s = [...(capexForm.payment_schedule || [])]; s[i] = { ...s[i], pct: Number(v) }; setCapexForm(p => ({ ...p, payment_schedule: s })); }} style={{ width: 60 }} />
              <span style={{ color: C.textMut, fontSize: 12 }}>%</span>
              <button onClick={() => { const s = (capexForm.payment_schedule || []).filter((_, j) => j !== i); setCapexForm(p => ({ ...p, payment_schedule: s })); }} style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', padding: '2px 6px' }}>×</button>
            </div>
          ))}
          <button onClick={() => setCapexForm(p => ({ ...p, payment_schedule: [...(p.payment_schedule || []), { months_before_opening: 0, pct: 0 }] }))} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 5, padding: '4px 10px', fontSize: 11.5, cursor: 'pointer', marginTop: 4 }}>+ Add Tranche</button>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <SaveBtn onClick={saveCapex} loading={capexSaving} label={capexModal._new ? 'Add Capex' : 'Save'} />
            <button onClick={() => setCapexModal(null)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Deposit modal */}
      {depModal && (
        <Modal title={depModal._new ? 'Add Security Deposit' : `Edit Deposit — ${depModal.deposit_id}`} onClose={() => setDepModal(null)} width={520}>
          <TwoCol>
            <Field label="Branch" required>
              <Sel value={depForm.branch_id || ''} onChange={v => setDepForm(p => ({ ...p, branch_id: v }))}>
                <option value="">Select branch…</option>
                {(branches || []).map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
              </Sel>
            </Field>
            <Field label="Deposit Type">
              <Sel value={depForm.deposit_type || 'security_deposit'} onChange={v => setDepForm(p => ({ ...p, deposit_type: v }))}>
                <option value="security_deposit">Security Deposit</option>
                <option value="other_deposit">Other Refundable Deposit</option>
              </Sel>
            </Field>
            <Field label="Deposit Months (× Monthly Rent)">
              <Inp type="number" value={depForm.deposit_months ?? ''} onChange={v => setDepForm(p => ({ ...p, deposit_months: v === '' ? null : Number(v) }))} />
            </Field>
            <Field label="Rent Basis Amount (₹/mo) — blank = from Cost Master">
              <Inp type="number" value={depForm.rent_basis_amount ?? ''} onChange={v => setDepForm(p => ({ ...p, rent_basis_amount: v === '' ? null : Number(v) }))} />
            </Field>
            <Field label="Fixed Deposit Amount (₹) — overrides months calc">
              <Inp type="number" value={depForm.fixed_deposit_amount ?? ''} onChange={v => setDepForm(p => ({ ...p, fixed_deposit_amount: v === '' ? null : Number(v) }))} />
            </Field>
            <Field label="Months Before Opening">
              <Inp type="number" value={depForm.months_before_opening ?? 3} onChange={v => setDepForm(p => ({ ...p, months_before_opening: Number(v) }))} />
            </Field>
            <Field label="Refundable">
              <Sel value={depForm.refundable === false ? 'false' : 'true'} onChange={v => setDepForm(p => ({ ...p, refundable: v === 'true' }))}>
                <option value="true">Yes — Refundable</option>
                <option value="false">No — Non-Refundable</option>
              </Sel>
            </Field>
            <Field label="Expected Refund Date">
              <Inp type="date" value={depForm.expected_refund_date || ''} onChange={v => setDepForm(p => ({ ...p, expected_refund_date: v || null }))} />
            </Field>
          </TwoCol>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <SaveBtn onClick={saveDep} loading={depSaving} label={depModal._new ? 'Add Deposit' : 'Save'} />
            <button onClick={() => setDepModal(null)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Header controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Branch Profitability Engine</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>Rent · CAM · Utilities · Facility · People · Other OpEx → Centre Contribution / EBITDA · Capex · Security Deposits</div>
          <div style={{ color: C.red, fontSize: 11, marginTop: 3 }}>⚠ Capex and Security Deposits are NOT EBITDA — they appear separately. Do not deduct them from Centre Contribution.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {summary?.computed_at && !isRunning && <span style={{ fontSize: 11, color: C.textMut }}>Last: {new Date(summary.computed_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</span>}
          {isRunning && <span style={{ fontSize: 11, color: C.yellow, fontWeight: 600 }}>⟳ Computing…</span>}
          <button onClick={() => setEditConfig(v => !v)} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 5, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer', fontWeight: 600 }}>⚙ Config</button>
          <button onClick={triggerCompute} disabled={isRunning} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '5px 16px', fontSize: 11.5, cursor: 'pointer', fontWeight: 700, opacity: isRunning ? 0.5 : 1 }}>▶ Run Cost Compute</button>
        </div>
      </div>

      {computeMsg && <div style={{ background: C.accent+'18', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 6, padding: '8px 14px', marginBottom: 12, fontSize: 12 }}>{computeMsg}</div>}

      {editConfig && config && (
        <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '14px 20px', marginBottom: 16 }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 12 }}>Cost Engine Configuration</div>
          <TwoCol>
            <Field label="Actual Cut-Off Month"><Inp type="month" value={configForm.actual_cutoff_month || ''} onChange={v => setConfigForm(p => ({ ...p, actual_cutoff_month: v }))} /></Field>
            <Field label="Forecast Start"><Inp type="month" value={configForm.forecast_start || ''} onChange={v => setConfigForm(p => ({ ...p, forecast_start: v }))} /></Field>
            <Field label="Forecast End"><Inp type="month" value={configForm.forecast_end || ''} onChange={v => setConfigForm(p => ({ ...p, forecast_end: v }))} /></Field>
            <Field label="Version Label"><Inp value={configForm.version_label || ''} onChange={v => setConfigForm(p => ({ ...p, version_label: v }))} /></Field>
          </TwoCol>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <SaveBtn onClick={saveConfig} label="Save Config" />
            <button onClick={() => setEditConfig(false)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!summary?.has_output && !isRunning && (
        <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 8, padding: '28px', textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>💰</div>
          <div style={{ color: C.text, fontWeight: 700, marginBottom: 6 }}>No cost projection computed yet</div>
          <div style={{ color: C.textSec, fontSize: 12.5, marginBottom: 16 }}>Add cost assumptions in <strong>Cost Master</strong>, then run compute. Step-4 revenue projection must be computed first.</div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => setView('cost_master')} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 18px', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>① Add Cost Assumptions</button>
            <button onClick={triggerCompute} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 6, padding: '8px 24px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>② Run Cost Compute</button>
          </div>
        </div>
      )}

      {/* Sub-view navigation */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {subViews.map(v => <TabButton key={v.id} active={view === v.id} onClick={() => setView(v.id)}>{v.label}</TabButton>)}
      </div>

      {/* ── OVERVIEW ── */}
      {view === 'overview' && summary && (
        <div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <KpiCard label={`${summary.fy_label} Revenue`} value={fmtINR2(summary.fy_revenue)} color={C.green} />
            <KpiCard label={`${summary.fy_label} Total OpEx`} value={fmtINR2(summary.fy_total_opex)} color={C.red} />
            <KpiCard label={`${summary.fy_label} Contribution`} value={fmtINR2(summary.fy_contribution)} color={C.accent} />
            <KpiCard label="Contribution Margin" value={summary.fy_contribution_margin != null ? `${summary.fy_contribution_margin}%` : '—'} color={summary.fy_contribution_margin > 0 ? C.green : C.red} />
            <KpiCard label="Total Capex (in range)" value={fmtINR2(summary.total_capex_in_range)} color={C.orange} sub="NOT in EBITDA" />
            <KpiCard label="Total Deposits (in range)" value={fmtINR2(summary.total_deposits_in_range)} color={C.purple} sub="Balance sheet" />
            <KpiCard label="Reconciliation" value={summary.reconciliation_pass ? 'PASS' : summary.reconciliation_pass === false ? 'FAIL' : '—'} color={summary.reconciliation_pass ? C.green : C.red} />
            <KpiCard label="Validation Issues" value={summary.validation_issue_count} color={summary.validation_issue_count > 0 ? C.yellow : C.green} />
          </div>
          {config && (
            <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '14px 18px', fontSize: 12 }}>
              <div style={{ color: C.textSec, fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5, marginBottom: 10 }}>Active Configuration</div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                {[['Actual Cut-Off', config.actual_cutoff_month], ['Forecast Start', config.forecast_start], ['Forecast End', config.forecast_end], ['Version', config.version_label]].map(([l, v]) => (
                  <div key={l}><div style={{ color: C.textMut, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>{l}</div><div style={{ color: C.text, fontWeight: 600, marginTop: 2 }}>{v || '—'}</div></div>
                ))}
              </div>
              <div style={{ marginTop: 10, padding: '8px 12px', background: C.surface, borderRadius: 5, fontSize: 11 }}>
                <span style={{ color: C.yellow, fontWeight: 700 }}>Note</span>
                <span style={{ color: C.textMut }}> — Capex and Security Deposits are shown separately and do NOT affect EBITDA / Centre Contribution calculations. They are inputs for Step 6 (Cash Bridge / Balance Sheet integration).</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MONTHLY P&L ── */}
      {view === 'monthly' && (
        <div>
          {!monthly.length
            ? <div style={{ color: C.textMut }}>No data. Run compute first.</div>
            : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: C.surfaceEl }}>
                    {['Month', 'Type', 'Revenue', 'Rent', 'CAM', 'Utilities', 'Facility', 'People', 'Other', 'Total OpEx', 'Contribution', 'Margin%', 'Capex¹', 'Deposit¹'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: h === 'Month' || h === 'Type' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monthly.map(m => (
                    <tr key={m.month} style={{ borderBottom: `1px solid ${C.border}`, background: m.type === 'actual' ? C.green + '06' : 'transparent' }}>
                      <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontSize: 11, color: C.text, fontWeight: 600 }}>{m.month}</td>
                      <td style={{ padding: '6px 10px' }}><span style={{ background: (m.type === 'actual' ? C.green : C.accent) + '22', color: m.type === 'actual' ? C.green : C.accent, borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{m.type?.toUpperCase()}</span></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.green, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_revenue)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.red, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_rent)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.orange, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_cam)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.yellow, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_utilities)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.purple, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_facility)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.cyan, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_people)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.textSec, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_other_opex)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_total_opex)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: m.company_contribution >= 0 ? C.accent : C.red, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(m.company_contribution)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: m.company_contribution_margin_pct > 0 ? C.green : C.red, fontVariantNumeric: 'tabular-nums' }}>{m.company_contribution_margin_pct != null ? `${m.company_contribution_margin_pct}%` : '—'}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.orange, fontVariantNumeric: 'tabular-nums' }}>{m.company_capex > 0 ? fmtINR2(m.company_capex) : '—'}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.purple, fontVariantNumeric: 'tabular-nums' }}>{m.company_deposit > 0 ? fmtINR2(m.company_deposit) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ color: C.textMut, fontSize: 10.5, marginTop: 8 }}>¹ Capex and Deposits are shown for reference only — they do NOT affect Contribution or EBITDA.</div>
            </div>
          )}
        </div>
      )}

      {/* ── BRANCH VIEW ── */}
      {view === 'branch' && (
        <div>
          <div style={{ marginBottom: 14 }}>
            <Field label="Select Branch">
              <Sel value={selBranch} onChange={v => { if (v) loadBranchDetail(v); setSelBranch(v); }} style={{ width: 280 }}>
                <option value="">Choose a branch…</option>
                {(branches || []).filter(b => b.active !== false).map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
              </Sel>
            </Field>
          </div>
          {selBranch && !branchDetail.length && <div style={{ color: C.textMut }}>No data for this branch. Run compute first.</div>}
          {branchDetail.length > 0 && (
            <div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ background: C.surfaceEl }}>
                      {['Month', 'Revenue', 'Rent', 'CAM', 'Util', 'Facility', 'People', 'Other', 'Total OpEx', 'Contribution', 'Margin%', 'Occ%', 'Capex', 'Deposit'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: h === 'Month' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {branchDetail.map(b => (
                      <tr key={b.month} style={{ borderBottom: `1px solid ${C.border}`, background: b.is_pre_opening ? C.yellow + '08' : 'transparent' }}>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontSize: 11, color: C.text, fontWeight: 600 }}>
                          {b.month}
                          {b.is_pre_opening && <span style={{ marginLeft: 6, background: C.yellow + '22', color: C.yellow, borderRadius: 3, padding: '1px 5px', fontSize: 9, fontWeight: 700 }}>PRE-OPEN</span>}
                        </td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.green, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(b.revenue)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.red, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(b.rent)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.orange, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(b.cam)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.yellow, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(b.utilities)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.purple, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(b.facility)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.cyan, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(b.people)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.textSec, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(b.other_opex)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(b.total_opex)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: b.centre_contribution >= 0 ? C.accent : C.red, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(b.centre_contribution)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: b.contribution_margin_pct > 0 ? C.green : C.red }}>{b.contribution_margin_pct != null ? `${b.contribution_margin_pct}%` : '—'}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.textSec }}>{b.occupancy_pct != null ? `${b.occupancy_pct}%` : '—'}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.orange }}>{b.capex > 0 ? fmtINR2(b.capex) : '—'}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', color: C.purple }}>{b.deposit > 0 ? fmtINR2(b.deposit) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {branchDetail[0] && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  {Object.entries(COST_CAT_LABELS).map(([k, label]) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: COST_CAT_COLORS[k] }} />
                      <span style={{ color: C.textMut, fontSize: 11 }}>{label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── UNIT ECONOMICS ── */}
      {view === 'unit_economics' && (
        <div>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 12 }}>Revenue, Cost, and Contribution per Sq. Ft. Break-even occupancy = Fixed costs ÷ Full-capacity revenue × 100.</div>
          {!unitEcon.length
            ? <div style={{ color: C.textMut }}>No data. Run compute first (forecast months only).</div>
            : unitEcon.slice(0, 12).map(mRow => (
              <div key={mRow.month} style={{ marginBottom: 20 }}>
                <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{mRow.month} <span style={{ color: C.textMut, fontSize: 11, fontWeight: 400 }}>{mRow.fy}</span></div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: C.surfaceEl }}>
                        {['Branch', 'Revenue/sqft', 'Rent/sqft', 'OpEx/sqft', 'Contribution/sqft', 'Contribution%', 'Occ%', 'Break-even Occ%'].map(h => (
                          <th key={h} style={{ padding: '6px 12px', textAlign: h === 'Branch' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(mRow.branches || []).map(b => (
                        <tr key={b.branch_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ padding: '6px 12px', color: C.text }}>{b.branch_name || b.branch_id}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: C.green, fontVariantNumeric: 'tabular-nums' }}>{b.revenue_per_sqft != null ? `₹${b.revenue_per_sqft}` : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: C.red, fontVariantNumeric: 'tabular-nums' }}>{b.rent_per_sqft != null ? `₹${b.rent_per_sqft}` : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: C.orange, fontVariantNumeric: 'tabular-nums' }}>{b.opex_per_sqft != null ? `₹${b.opex_per_sqft}` : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: b.contribution_per_sqft >= 0 ? C.accent : C.red, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{b.contribution_per_sqft != null ? `₹${b.contribution_per_sqft}` : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: b.contribution_margin_pct > 0 ? C.green : C.red }}>{b.contribution_margin_pct != null ? `${b.contribution_margin_pct}%` : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: C.textSec }}>{b.occupancy_pct != null ? `${b.occupancy_pct}%` : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: b.breakeven_occupancy_pct > 100 ? C.red : b.breakeven_occupancy_pct > 80 ? C.yellow : C.green }}>{b.breakeven_occupancy_pct != null ? `${b.breakeven_occupancy_pct}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          }
          {unitEcon.length > 12 && <div style={{ color: C.textMut, fontSize: 11, marginTop: 8 }}>Showing first 12 forecast months. All months available via API.</div>}
        </div>
      )}

      {/* ── CAPEX ── */}
      {view === 'capex' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Capex Master & Schedule</div>
            <button onClick={() => openCapexModal(null)} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>+ Add Capex</button>
          </div>
          <div style={{ color: C.orange, background: C.orange + '12', border: `1px solid ${C.orange}33`, borderRadius: 5, padding: '8px 12px', fontSize: 12, marginBottom: 14 }}>
            ⚠ Capex cash outflows are shown below for Cash Bridge planning (Step 6). They are <strong>NOT deducted from EBITDA</strong>.
          </div>
          {!capexMaster.length && <div style={{ color: C.textMut, marginBottom: 12 }}>No capex entries yet. Add entries above.</div>}
          {capexMaster.length > 0 && (
            <div style={{ overflowX: 'auto', marginBottom: 20 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: C.surfaceEl }}>
                    {['ID', 'Branch', 'Category', 'Area', '₹/sqft', 'Total Capex', 'Opening', 'Schedule', 'Status', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {capexMaster.filter(c => c.active !== false).map(cx => {
                    const total = cx.fixed_capex ?? ((cx.area_sqft || 0) * (cx.capex_per_sqft || 0));
                    const pctSum = (cx.payment_schedule || []).reduce((s, t) => s + (t.pct || 0), 0);
                    return (
                      <tr key={cx.capex_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.cyan, fontSize: 11 }}>{cx.capex_id}</td>
                        <td style={{ padding: '7px 12px', color: C.text }}>{(branches || []).find(b => b.branch_id === cx.branch_id)?.branch_name || cx.branch_id}</td>
                        <td style={{ padding: '7px 12px', color: C.textSec, fontSize: 11 }}>{cx.capex_category}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textMut, fontSize: 11 }}>{cx.area_sqft ? `${cx.area_sqft} sqft` : '—'}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textMut, fontSize: 11 }}>{cx.capex_per_sqft ? `₹${cx.capex_per_sqft}` : '—'}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', color: C.orange, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(total)}</td>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.textMut, fontSize: 11 }}>{cx.opening_date || '—'}</td>
                        <td style={{ padding: '7px 12px', color: Math.abs(pctSum - 100) < 0.01 ? C.green : C.red, fontSize: 11 }}>{(cx.payment_schedule || []).length} tranches ({pctSum}%)</td>
                        <td style={{ padding: '7px 12px' }}>
                          <span style={{ background: (cx.capex_status === 'completed' ? C.green : cx.capex_status === 'committed' ? C.yellow : C.accent) + '22', color: cx.capex_status === 'completed' ? C.green : cx.capex_status === 'committed' ? C.yellow : C.accent, borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 700 }}>{cx.capex_status || 'PLANNED'}</span>
                        </td>
                        <td style={{ padding: '7px 12px' }}>
                          <button onClick={() => openCapexModal(cx)} style={{ background: C.accent + '22', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 4, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Edit</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {capexSched.length > 0 && (
            <>
              <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Cash Outflow Schedule</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: C.surfaceEl }}>
                      {['Month', 'Branch', 'Category', 'Tranche%', 'Amount', 'Opening Month', 'In Range'].map(h => (
                        <th key={h} style={{ padding: '6px 12px', textAlign: h === 'Amount' || h === 'Tranche%' ? 'right' : 'left', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {capexSched.map((r, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, opacity: r.in_range ? 1 : 0.5 }}>
                        <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: C.text }}>{r.month}</td>
                        <td style={{ padding: '6px 12px', color: C.textSec }}>{(branches || []).find(b => b.branch_id === r.branch_id)?.branch_name || r.branch_id}</td>
                        <td style={{ padding: '6px 12px', color: C.textMut, fontSize: 11 }}>{r.capex_category}</td>
                        <td style={{ padding: '6px 12px', textAlign: 'right', color: C.textSec }}>{r.pct}%</td>
                        <td style={{ padding: '6px 12px', textAlign: 'right', color: C.orange, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(r.amount)}</td>
                        <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: C.textMut }}>{r.opening_month}</td>
                        <td style={{ padding: '6px 12px', fontSize: 11, color: r.in_range ? C.green : C.textMut }}>{r.in_range ? '✓' : 'Outside range'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── DEPOSITS ── */}
      {view === 'deposits' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Security Deposit Master & Schedule</div>
            <button onClick={() => openDepModal(null)} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>+ Add Deposit</button>
          </div>
          <div style={{ color: C.purple, background: C.purple + '12', border: `1px solid ${C.purple}33`, borderRadius: 5, padding: '8px 12px', fontSize: 12, marginBottom: 14 }}>
            ⚠ Security deposits are Balance Sheet assets, <strong>NOT EBITDA expenses</strong>. They appear here for Cash Bridge planning (Step 6) only.
          </div>
          {!depMaster.length && <div style={{ color: C.textMut, marginBottom: 12 }}>No deposit entries yet.</div>}
          {depMaster.length > 0 && (
            <div style={{ overflowX: 'auto', marginBottom: 20 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: C.surfaceEl }}>
                    {['ID', 'Branch', 'Months', 'Amount', 'Pay T-n months', 'Refundable', 'Refund Date', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {depMaster.filter(d => d.active !== false).map(dep => {
                    const depSch = depSched.find(s => s.deposit_id === dep.deposit_id);
                    return (
                      <tr key={dep.deposit_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.cyan, fontSize: 11 }}>{dep.deposit_id}</td>
                        <td style={{ padding: '7px 12px', color: C.text }}>{(branches || []).find(b => b.branch_id === dep.branch_id)?.branch_name || dep.branch_id}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textSec }}>{dep.deposit_months || '—'}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', color: C.purple, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{depSch ? fmtINR2(depSch.deposit_amount) : dep.fixed_deposit_amount ? fmtINR2(dep.fixed_deposit_amount) : '—'}</td>
                        <td style={{ padding: '7px 12px', color: C.textSec, fontSize: 11 }}>T-{dep.months_before_opening ?? 3} {depSch ? `(${depSch.month})` : ''}</td>
                        <td style={{ padding: '7px 12px' }}>
                          <span style={{ background: (dep.refundable !== false ? C.green : C.red) + '22', color: dep.refundable !== false ? C.green : C.red, borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 700 }}>{dep.refundable !== false ? 'REFUNDABLE' : 'NON-REFUND'}</span>
                        </td>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: C.textMut }}>{dep.expected_refund_date || '—'}</td>
                        <td style={{ padding: '7px 12px' }}>
                          <button onClick={() => openDepModal(dep)} style={{ background: C.accent + '22', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 4, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Edit</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── RECONCILIATION ── */}
      {view === 'reconciliation' && recon && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Cost Reconciliation Checks (RC-C01 to RC-C08)</div>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 16 }}>Verifies internal consistency of the cost projection engine and its linkage to Step-4 revenue.</div>
          {!recon.checks?.length
            ? <div style={{ color: C.textMut }}>No reconciliation data. Run compute first.</div>
            : (
            <>
              <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'hidden', marginBottom: 14 }}>
                {recon.checks.map((c, i) => (
                  <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 16px', borderBottom: i < recon.checks.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.textMut, background: C.surface, padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>{c.id}</span>
                    <ReconBadge2 pass={c.pass} />
                    <div style={{ flex: 1 }}>
                      <div style={{ color: C.text, fontSize: 12.5, fontWeight: 600 }}>{c.name}</div>
                      {c.note && <div style={{ color: C.textMut, fontSize: 11, marginTop: 2 }}>{c.note}</div>}
                      {c.max_gap > 0 && <div style={{ color: C.red, fontSize: 11, marginTop: 2 }}>Max gap: ₹{c.max_gap?.toFixed(2)}</div>}
                      {c.gap !== undefined && c.gap !== 0 && <div style={{ color: C.red, fontSize: 11, marginTop: 2 }}>Gap: ₹{c.gap?.toFixed(2)}</div>}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: '12px 16px', background: recon.all_pass ? C.green + '12' : C.red + '12', border: `1px solid ${recon.all_pass ? C.green : C.red}33`, borderRadius: 6, color: recon.all_pass ? C.green : C.red, fontWeight: 700, fontSize: 13 }}>
                {recon.all_pass ? '✓ All cost reconciliation checks pass.' : '✗ One or more checks failed. Review above.'}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── COST MASTER ── */}
      {view === 'cost_master' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Branch Cost Master</div>
              <div style={{ fontSize: 12, color: C.textSec }}>Define cost assumptions per branch. Add at least one rent entry and operating cost entries before running compute.</div>
            </div>
            <button onClick={() => openCostModal(null)} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>+ Add Assumption</button>
          </div>
          {!costMaster.filter(a => a.active !== false).length
            ? (
            <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '24px', textAlign: 'center', color: C.textMut }}>
              <div style={{ marginBottom: 8 }}>No active cost assumptions.</div>
              <div style={{ fontSize: 12, marginBottom: 14 }}>Add at minimum: Rent (per_sqft), CAM, and at least one utility cost per branch.</div>
              <button onClick={() => openCostModal(null)} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '6px 16px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Add First Cost Assumption</button>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: C.surfaceEl }}>
                    {['ID', 'Branch', 'Category', 'Subcategory', 'Method', 'Rate', 'Escalation', 'From', 'To', 'Nature', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {costMaster.filter(a => a.active !== false).map(asm => {
                    const rateDisplay = asm.calc_method === 'per_sqft' || asm.calc_method === 'occupancy_linked'
                      ? `₹${asm.rate_per_sqft}/sqft` : asm.calc_method === 'per_seat' ? `₹${asm.rate_per_seat}/seat`
                      : asm.calc_method === 'pct_of_revenue' ? `${asm.variable_pct}% rev`
                      : fmtINR2(asm.fixed_monthly_amount || asm.base_amount);
                    return (
                      <tr key={asm.assumption_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.cyan, fontSize: 11 }}>{asm.assumption_id}</td>
                        <td style={{ padding: '7px 12px', color: C.text }}>{(branches || []).find(b => b.branch_id === asm.branch_id)?.branch_name || asm.branch_id}</td>
                        <td style={{ padding: '7px 12px' }}>
                          <span style={{ background: (COST_CAT_COLORS[asm.cost_category] || C.textMut) + '22', color: COST_CAT_COLORS[asm.cost_category] || C.textMut, borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700 }}>{asm.cost_category}</span>
                        </td>
                        <td style={{ padding: '7px 12px', color: C.textSec, fontSize: 11 }}>{asm.cost_subcategory || '—'}</td>
                        <td style={{ padding: '7px 12px', color: C.textMut, fontSize: 11 }}>{asm.calc_method}</td>
                        <td style={{ padding: '7px 12px', color: C.text, fontVariantNumeric: 'tabular-nums' }}>{rateDisplay}</td>
                        <td style={{ padding: '7px 12px', color: C.textMut, fontSize: 11 }}>{asm.escalation_pct ? `${asm.escalation_pct}%` : '—'}</td>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.textMut, fontSize: 10 }}>{(asm.rent_commencement_date || asm.effective_from)?.substring(0, 10) || '—'}</td>
                        <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.textMut, fontSize: 10 }}>{asm.effective_to?.substring(0, 10) || 'ongoing'}</td>
                        <td style={{ padding: '7px 12px' }}>
                          <span style={{ background: (asm.cost_nature === 'pre_opening' ? C.yellow : C.accent) + '22', color: asm.cost_nature === 'pre_opening' ? C.yellow : C.accent, borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700 }}>{asm.cost_nature === 'pre_opening' ? 'PRE-OPEN' : 'OPEX'}</span>
                        </td>
                        <td style={{ padding: '7px 12px', display: 'flex', gap: 6 }}>
                          <button onClick={() => openCostModal(asm)} style={{ background: C.accent + '22', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 4, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Edit</button>
                          <button onClick={() => deleteCost(asm.assumption_id)} style={{ background: C.red + '22', border: `1px solid ${C.red}44`, color: C.red, borderRadius: 4, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Del</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── VALIDATION ── */}
      {view === 'validation' && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Cost Validation Issues</div>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 14 }}>Missing rent rates, commencement dates, capex schedules, deposit amounts, and other data quality issues.</div>
          {!valIssues.length
            ? <div style={{ background: C.green + '12', border: `1px solid ${C.green}33`, borderRadius: 6, padding: '16px 20px', color: C.green, fontWeight: 600, fontSize: 13 }}>✓ No cost validation issues.</div>
            : (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
              {valIssues.map((issue, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', borderBottom: i < valIssues.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: issue.level === 'error' ? C.red : issue.level === 'warning' ? C.yellow : C.cyan, background: (issue.level === 'error' ? C.red : issue.level === 'warning' ? C.yellow : C.cyan) + '18', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>{issue.code}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: C.textSec, fontSize: 12.5 }}>{issue.message}</div>
                    {issue.context && <div style={{ color: C.textMut, fontSize: 11, marginTop: 2 }}>Context: {issue.context}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATED FINANCIALS TAB — Step 6 (PARALLEL MODEL)
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  critical_blocker: C.red, data_required: C.orange, pending_live_data: C.yellow,
  requires_decision: C.purple, resolved: C.green, open: C.textSec,
};

function MigrationGateBadge({ status }) {
  const ready = status === 'READY_FOR_MIGRATION';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 6, background: ready ? C.green + '18' : C.red + '14', border: `1px solid ${ready ? C.green : C.red}44`, fontWeight: 700, fontSize: 13, color: ready ? C.green : C.red }}>
      {ready ? '✅ READY FOR MIGRATION' : '⛔ NOT READY FOR MIGRATION'}
    </div>
  );
}

function DataFlagBadge({ flag }) {
  const label = flag.replace(/_/g, ' ').replace('REQUIRES ', '⚠ ');
  return <span style={{ fontSize: 9.5, fontFamily: 'monospace', background: C.orange + '18', color: C.orange, borderRadius: 3, padding: '1px 5px', marginRight: 3 }}>{label}</span>;
}

function NullCell({ flags }) {
  return <span style={{ color: C.textMut, fontSize: 11 }}>—{flags?.length > 0 && <span style={{ color: C.orange, fontSize: 9, marginLeft: 3 }}>⚠</span>}</span>;
}

function FmtCell({ val, color }) {
  if (val == null) return <NullCell />;
  return <span style={{ color: color || C.text, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(val)}</span>;
}

function IntegratedFinancialsTab({ branches }) {
  const [view,       setView]       = useState('overview');
  const [summary,    setSummary]    = useState(null);
  const [plData,     setPlData]     = useState([]);
  const [bsData,     setBsData]     = useState([]);
  const [cbData,     setCbData]     = useState([]);
  const [recon,      setRecon]      = useState(null);
  const [valIssues,  setValIssues]  = useState([]);
  const [gateData,   setGateData]   = useState(null);
  const [openItems,  setOpenItems]  = useState([]);
  const [corpCost,   setCorpCost]   = useState([]);
  const [debtSched,  setDebtSched]  = useState([]);
  const [leaseSched, setLeaseSched] = useState([]);
  const [computing,  setComputing]  = useState(false);
  const [computeMsg, setComputeMsg] = useState('');
  const [config,     setConfig]     = useState(null);
  const [wcParams,   setWcParams]   = useState(null);
  const [taxParams,  setTaxParams]  = useState(null);
  const [editConfig, setEditConfig] = useState(false);
  const [configForm, setConfigForm] = useState({});
  // Corporate cost modal
  const [corpModal,  setCorpModal]  = useState(null);
  const [corpForm,   setCorpForm]   = useState({});
  const [corpSaving, setCorpSaving] = useState(false);
  // Debt/Lease modals
  const [debtModal,  setDebtModal]  = useState(null);
  const [debtForm,   setDebtForm]   = useState({});
  const [leaseModal, setLeaseModal] = useState(null);
  const [leaseForm,  setLeaseForm]  = useState({});

  const loadAll = useCallback(async () => {
    try {
      const [sum, pl, bs, cb, rec, val, gate, oi, cc, ds, ls, cfg, wc, tax] = await Promise.all([
        apiFetch('/api/fpa/integrated/summary').catch(() => null),
        apiFetch('/api/fpa/integrated/pl').catch(() => ({ months: [] })),
        apiFetch('/api/fpa/integrated/balance-sheet').catch(() => ({ months: [] })),
        apiFetch('/api/fpa/integrated/cash-bridge').catch(() => ({ months: [] })),
        apiFetch('/api/fpa/integrated/reconciliation').catch(() => null),
        apiFetch('/api/fpa/integrated/validation').catch(() => ({ issues: [] })),
        apiFetch('/api/fpa/integrated/migration-gate').catch(() => null),
        apiFetch('/api/fpa/integrated/open-items').catch(() => ({ items: [] })),
        apiFetch('/api/fpa/integrated/corporate-cost-master').catch(() => ({ assumptions: [] })),
        apiFetch('/api/fpa/integrated/debt-schedule').catch(() => ({ facilities: [] })),
        apiFetch('/api/fpa/integrated/lease-schedule').catch(() => ({ leases: [] })),
        apiFetch('/api/fpa/integrated/config').catch(() => null),
        apiFetch('/api/fpa/integrated/wc-params').catch(() => null),
        apiFetch('/api/fpa/integrated/tax-params').catch(() => null),
      ]);
      setSummary(sum); setPlData(pl.months || []); setBsData(bs.months || []);
      setCbData(cb.months || []); setRecon(rec); setValIssues(val?.issues || []);
      setGateData(gate); setOpenItems(oi?.items || []);
      setCorpCost(cc.assumptions || []); setDebtSched(ds.facilities || []);
      setLeaseSched(ls.leases || []); setConfig(cfg); setConfigForm(cfg || {});
      setWcParams(wc); setTaxParams(tax);
    } catch (e) { console.error('Integrated load error:', e); }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    if (summary?.compute_in_progress) { const t = setTimeout(loadAll, 3500); return () => clearTimeout(t); }
  }, [summary?.compute_in_progress, loadAll]);

  const triggerCompute = async () => {
    setComputing(true); setComputeMsg('');
    try { const r = await apiFetch('/api/fpa/integrated/compute', { method: 'POST' }); setComputeMsg(r.message || 'Started'); setTimeout(loadAll, 2000); }
    catch (e) { setComputeMsg('Error: ' + e.message); }
    setComputing(false);
  };

  const saveConfig = async () => {
    try { await apiFetch('/api/fpa/integrated/config', { method: 'PUT', body: JSON.stringify(configForm) }); setEditConfig(false); loadAll(); }
    catch (e) { alert(e.message); }
  };

  const resolveItem = async (id, status) => {
    try { await apiFetch(`/api/fpa/integrated/open-items/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }); loadAll(); }
    catch (e) { alert(e.message); }
  };

  // Corporate cost CRUD
  const openCorpModal = (asm) => { setCorpModal(asm || { _new: true }); setCorpForm(asm ? { ...asm } : { cost_category: 'payroll', calc_method: 'fixed_monthly', active: true }); };
  const saveCorpCost = async () => {
    setCorpSaving(true);
    try {
      if (corpModal._new) await apiFetch('/api/fpa/integrated/corporate-cost-master', { method: 'POST', body: JSON.stringify(corpForm) });
      else await apiFetch(`/api/fpa/integrated/corporate-cost-master/${corpModal.assumption_id}`, { method: 'PUT', body: JSON.stringify(corpForm) });
      setCorpModal(null); loadAll();
    } catch (e) { alert(e.message); }
    setCorpSaving(false);
  };

  const isRunning = summary?.compute_in_progress || computing;

  const subViews = [
    { id: 'overview',    label: 'Overview' },
    { id: 'pl',          label: 'P&L' },
    { id: 'bs',          label: 'Balance Sheet' },
    { id: 'cash_bridge', label: 'Cash Bridge' },
    { id: 'corp_cost',   label: `Corp Cost (${corpCost.filter(a=>a.active!==false).length})` },
    { id: 'debt',        label: `Debt (${debtSched.filter(d=>d.active!==false).length})` },
    { id: 'lease',       label: `Leases (${leaseSched.filter(l=>l.active!==false).length})` },
    { id: 'reconciliation', label: 'Reconciliation' },
    { id: 'open_items',  label: `Open Items (${openItems.filter(i=>i.status!=='resolved').length})` },
    { id: 'migration',   label: 'Migration Gate' },
    { id: 'setup',       label: 'Data Setup' },
    { id: 'step7',       label: '🔎 Step 7 Readiness' },
    { id: 'bs_bridge',   label: 'BS Bridge' },
    { id: 'scorecard',   label: 'Scorecard' },
    { id: 'accept_tests',label: 'Acceptance Tests' },
  ];

  return (
    <div>
      {/* Corporate cost modal */}
      {corpModal && (
        <Modal title={corpModal._new ? 'Add Corporate Cost Assumption' : `Edit — ${corpModal.assumption_id}`} onClose={() => setCorpModal(null)} width={600}>
          <TwoCol>
            <Field label="Category" required>
              <Sel value={corpForm.cost_category || 'payroll'} onChange={v => setCorpForm(p => ({ ...p, cost_category: v }))}>
                <option value="payroll">Corporate Payroll</option>
                <option value="marketing">Sales & Marketing</option>
                <option value="technology">Technology</option>
                <option value="professional_fees">Professional Fees</option>
                <option value="other">Other Corporate OpEx</option>
              </Sel>
            </Field>
            <Field label="Description"><Inp value={corpForm.description || ''} onChange={v => setCorpForm(p => ({ ...p, description: v }))} /></Field>
            <Field label="Calculation Method">
              <Sel value={corpForm.calc_method || 'fixed_monthly'} onChange={v => setCorpForm(p => ({ ...p, calc_method: v }))}>
                <option value="fixed_monthly">Fixed Monthly</option>
                <option value="pct_of_revenue">% of Revenue</option>
                <option value="manual_override">Manual Override</option>
              </Sel>
            </Field>
            {(corpForm.calc_method === 'fixed_monthly' || corpForm.calc_method === 'manual_override') && (
              <Field label="Fixed Monthly Amount (₹)">
                <Inp type="number" value={corpForm.fixed_monthly_amount ?? ''} onChange={v => setCorpForm(p => ({ ...p, fixed_monthly_amount: v === '' ? null : Number(v) }))} />
              </Field>
            )}
            {corpForm.calc_method === 'pct_of_revenue' && (
              <Field label="% of Revenue">
                <Inp type="number" value={corpForm.variable_pct ?? ''} onChange={v => setCorpForm(p => ({ ...p, variable_pct: v === '' ? null : Number(v) }))} />
              </Field>
            )}
            <Field label="Effective From"><Inp type="date" value={corpForm.effective_from || ''} onChange={v => setCorpForm(p => ({ ...p, effective_from: v || null }))} /></Field>
            <Field label="Effective To"><Inp type="date" value={corpForm.effective_to || ''} onChange={v => setCorpForm(p => ({ ...p, effective_to: v || null }))} /></Field>
          </TwoCol>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <SaveBtn onClick={saveCorpCost} loading={corpSaving} label={corpModal._new ? 'Add Cost' : 'Save'} />
            <button onClick={() => setCorpModal(null)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Integrated Financial Statements</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>P&L · Balance Sheet · Cash Bridge · Working Capital · Capex · Debt · Leases — PARALLEL MODEL, not yet replacing production</div>
          <div style={{ color: C.orange, fontSize: 11, marginTop: 2 }}>⚠ DO NOT use this model to replace production until the Migration Gate is READY and explicit approval is given.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {summary?.computed_at && !isRunning && <span style={{ fontSize: 11, color: C.textMut }}>Last: {new Date(summary.computed_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</span>}
          {isRunning && <span style={{ fontSize: 11, color: C.yellow, fontWeight: 600 }}>⟳ Computing…</span>}
          <button onClick={() => setEditConfig(v => !v)} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 5, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer', fontWeight: 600 }}>⚙ Config</button>
          <button onClick={triggerCompute} disabled={isRunning} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '5px 16px', fontSize: 11.5, cursor: 'pointer', fontWeight: 700, opacity: isRunning ? 0.5 : 1 }}>▶ Run Full Compute</button>
        </div>
      </div>

      {computeMsg && <div style={{ background: C.accent + '18', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 6, padding: '8px 14px', marginBottom: 12, fontSize: 12 }}>{computeMsg}</div>}

      {editConfig && config && (
        <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '14px 20px', marginBottom: 14 }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Configuration</div>
          <TwoCol>
            <Field label="Actual Cut-Off"><Inp type="month" value={configForm.actual_cutoff_month || ''} onChange={v => setConfigForm(p => ({ ...p, actual_cutoff_month: v }))} /></Field>
            <Field label="Forecast Start"><Inp type="month" value={configForm.forecast_start || ''} onChange={v => setConfigForm(p => ({ ...p, forecast_start: v }))} /></Field>
            <Field label="Forecast End"><Inp type="month" value={configForm.forecast_end || ''} onChange={v => setConfigForm(p => ({ ...p, forecast_end: v }))} /></Field>
            <Field label="Min Cash Req (₹)"><Inp type="number" value={configForm.min_cash_requirement ?? ''} onChange={v => setConfigForm(p => ({ ...p, min_cash_requirement: Number(v) }))} /></Field>
          </TwoCol>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <SaveBtn onClick={saveConfig} label="Save" />
            <button onClick={() => setEditConfig(false)} style={{ background: 'none', border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Sub-view nav */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {subViews.map(v => <TabButton key={v.id} active={view === v.id} onClick={() => setView(v.id)}>{v.label}</TabButton>)}
      </div>

      {/* ── OVERVIEW ── */}
      {view === 'overview' && (
        <div>
          {gateData && <div style={{ marginBottom: 20 }}><MigrationGateBadge status={gateData.status} />{gateData.total_blockers > 0 && <span style={{ color: C.textSec, fontSize: 12, marginLeft: 12 }}>{gateData.total_blockers} blocker(s) unresolved — see Migration Gate tab</span>}</div>}
          {!summary?.has_output && !isRunning && (
            <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 8, padding: '28px', textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
              <div style={{ color: C.text, fontWeight: 700, marginBottom: 6 }}>No integrated model computed yet</div>
              <div style={{ color: C.textSec, fontSize: 12.5, marginBottom: 16 }}>Steps 1–5 must be computed first. Configure opening balances and schedules in <strong>Data Setup</strong>, then run compute. Many inputs are REQUIRES DATA — the model will compute the P&L through EBITDA and flag missing items.</div>
              <button onClick={triggerCompute} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 6, padding: '8px 24px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Run Compute</button>
            </div>
          )}
          {summary?.has_output && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
              <KpiCard label={`${summary.fy_label} EBITDA`} value={fmtINR2(summary.fy_ebitda)} color={summary.fy_ebitda >= 0 ? C.green : C.red} />
              <KpiCard label={`${summary.fy_label} PAT`} value={summary.fy_pat != null ? fmtINR2(summary.fy_pat) : 'REQUIRES DATA'} color={summary.fy_pat > 0 ? C.accent : C.orange} />
              <KpiCard label="Closing Cash" value={summary.closing_cash != null ? fmtINR2(summary.closing_cash) : 'REQUIRES DATA'} color={summary.closing_cash > 0 ? C.cyan : C.red} />
              <KpiCard label="Funding Gap" value={summary.funding_gap != null ? fmtINR2(summary.funding_gap) : 'REQUIRES DATA'} color={summary.funding_gap >= 0 ? C.green : C.red} sub={summary.funding_gap < 0 ? 'FUNDING REQUIRED' : 'Positive'} />
              <KpiCard label="Reconciliation" value={summary.reconciliation_pass ? 'PASS' : summary.reconciliation_pass === false ? 'FAIL' : '—'} color={summary.reconciliation_pass ? C.green : C.red} />
              <KpiCard label="Open Items" value={openItems.filter(i => i.status !== 'resolved').length} color={C.yellow} sub={`${openItems.filter(i => i.is_migration_blocker && i.status !== 'resolved').length} migration blockers`} />
              <KpiCard label="Validation Issues" value={valIssues.length} color={valIssues.length > 0 ? C.orange : C.green} />
            </div>
          )}
          <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '14px 18px', fontSize: 12, marginTop: 8 }}>
            <div style={{ color: C.textSec, fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5, marginBottom: 10 }}>Parallel Model Status</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 12 }}>
              {[
                ['Revenue (Step 3/4)', C.green, plData.length > 0 ? 'LINKED' : 'PENDING COMPUTE'],
                ['Branch OpEx (Step 5)', C.green, plData.length > 0 ? 'LINKED' : 'PENDING COMPUTE'],
                ['Corporate Costs', corpCost.filter(a=>a.active!==false).length > 0 ? C.green : C.yellow, corpCost.filter(a=>a.active!==false).length > 0 ? 'CONFIGURED' : 'EMPTY — ADD CORP COSTS'],
                ['Opening Balance Sheet', C.orange, 'REQUIRES DATA'],
                ['Debt Schedule', debtSched.filter(d=>d.active!==false).length > 0 ? C.green : C.orange, debtSched.filter(d=>d.active!==false).length > 0 ? 'CONFIGURED' : 'REQUIRES DATA'],
                ['Lease Schedule', leaseSched.filter(l=>l.active!==false).length > 0 ? C.green : C.orange, leaseSched.filter(l=>l.active!==false).length > 0 ? 'CONFIGURED' : 'REQUIRES DATA'],
                ['Asset Register', C.orange, 'REQUIRES DATA'],
                ['Existing BS Imbalance', C.red, '₹9.17 Cr — REQUIRES REVIEW'],
              ].map(([label, color, status]) => (
                <div key={label}>
                  <div style={{ color: C.textMut, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
                  <div style={{ color, fontWeight: 600, fontSize: 12 }}>{status}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── P&L ── */}
      {view === 'pl' && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Monthly Integrated P&L — PARALLEL MODEL</div>
          <div style={{ color: C.orange, fontSize: 11.5, marginBottom: 12 }}>Null cells (—) indicate REQUIRES DATA. This model is independent of the production P&L and will not replace it until approved.</div>
          {!plData.length
            ? <div style={{ color: C.textMut }}>No data. Run compute first.</div>
            : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: C.surfaceEl }}>
                    {['Month', 'Type', 'Revenue', 'Direct Costs', 'Centre Contrib', 'Corp OpEx', 'EBITDA', 'Margin%', 'D&A', 'Finance Cost', 'PBT', 'Tax', 'PAT'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: h === 'Month' || h === 'Type' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {plData.map(m => (
                    <tr key={m.month} style={{ borderBottom: `1px solid ${C.border}`, background: m.type === 'actual' ? C.green + '05' : 'transparent' }}>
                      <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontSize: 11, color: C.text, fontWeight: 600 }}>{m.month}</td>
                      <td style={{ padding: '6px 10px' }}><span style={{ background: (m.type === 'actual' ? C.green : C.accent) + '22', color: m.type === 'actual' ? C.green : C.accent, borderRadius: 4, padding: '1px 6px', fontSize: 9, fontWeight: 700 }}>{m.type?.toUpperCase() || '—'}</span></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.revenue?.total} color={C.green} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.direct_costs?.total ? -m.direct_costs.total : null} color={C.red} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.centre_contribution} color={m.centre_contribution >= 0 ? C.accent : C.red} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.corporate_costs?.total ? -m.corporate_costs.total : null} color={C.orange} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.ebitda} color={m.ebitda >= 0 ? C.green : C.red} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: m.ebitda_margin_pct > 0 ? C.green : C.red }}>{m.ebitda_margin_pct != null ? `${m.ebitda_margin_pct}%` : '—'}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.depreciation ? -m.depreciation : m.depreciation} color={C.textSec} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.finance_cost ? -m.finance_cost : m.finance_cost} color={C.textSec} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.pbt} color={m.pbt >= 0 ? C.accent : C.red} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.current_tax ? -m.current_tax : m.current_tax} color={C.textSec} /></td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}><FmtCell val={m.pat} color={m.pat >= 0 ? C.green : C.red} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── BALANCE SHEET ── */}
      {view === 'bs' && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Monthly Balance Sheet — PARALLEL MODEL</div>
          <div style={{ color: C.orange, fontSize: 11.5, marginBottom: 12 }}>Opening BS not yet provided. Cells requiring opening balances show —. BS Check shows imbalance when items are partially computed.</div>
          {!bsData.length
            ? <div style={{ color: C.textMut }}>No data. Run compute first.</div>
            : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: C.surfaceEl }}>
                    {['Month', 'PPE Net', 'ROU Assets', 'Sec Deposits', 'Trade AR', 'Cash', 'Total Assets', 'Share Cap', 'Ret Earnings', 'Total Equity', 'Borrowings', 'Lease Liab', 'Trade AP', 'Total Liab', 'BS Check'].map(h => (
                      <th key={h} style={{ padding: '6px 8px', textAlign: h === 'Month' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bsData.map(m => (
                    <tr key={m.month} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontSize: 11, color: C.text, fontWeight: 600 }}>{m.month}</td>
                      {[
                        [m.assets?.non_current?.ppe_net, C.text],
                        [m.assets?.non_current?.rou_assets, C.text],
                        [m.assets?.non_current?.security_deposits, C.purple],
                        [m.assets?.current?.trade_receivables, C.cyan],
                        [m.assets?.current?.cash, C.green],
                        [m.assets?.total_assets, C.text, true],
                        [m.equity?.share_capital, C.text],
                        [m.equity?.retained_earnings, C.accent],
                        [m.equity?.total_equity, C.accent, true],
                        [m.liabilities?.non_current?.borrowings, C.red],
                        [m.liabilities?.non_current?.lease_liabilities, C.orange],
                        [m.liabilities?.current?.trade_payables, C.yellow],
                        [m.liabilities?.total_liabilities, C.red, true],
                        [m.bs_check, m.bs_check != null && Math.abs(m.bs_check) > 1 ? C.red : C.green],
                      ].map(([val, col, bold], i) => (
                        <td key={i} style={{ padding: '5px 8px', textAlign: 'right', fontWeight: bold ? 700 : 400 }}>
                          <FmtCell val={val} color={col} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── CASH BRIDGE ── */}
      {view === 'cash_bridge' && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Monthly Cash Bridge — PARALLEL MODEL</div>
          <div style={{ color: C.textSec, fontSize: 11.5, marginBottom: 12 }}>Opening Cash → Operating → Investing → Financing → Closing Cash. Closing Cash must equal next month's Opening Cash (RC-F09).</div>
          {!cbData.length
            ? <div style={{ color: C.textMut }}>No data. Run compute first.</div>
            : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: C.surfaceEl }}>
                    {['Month', 'Opening Cash', 'Collections', 'Vendor Pmts', 'Rent/Lease', 'Net Operating', 'Capex', 'Deposits', 'Net Investing', 'Debt Draw', 'Debt Repay', 'Net Financing', 'Closing Cash', 'Funding Gap'].map(h => (
                      <th key={h} style={{ padding: '6px 8px', textAlign: h === 'Month' ? 'left' : 'right', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cbData.map(m => (
                    <tr key={m.month} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontSize: 11, color: C.text, fontWeight: 600 }}>{m.month}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}><FmtCell val={m.opening_cash} color={C.textSec} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}><FmtCell val={m.operating?.collections} color={C.green} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}><FmtCell val={m.operating?.vendor_payments} color={C.red} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}><FmtCell val={m.operating?.rent_payments} color={C.red} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 700 }}><FmtCell val={m.operating?.net_operating} color={m.operating?.net_operating >= 0 ? C.accent : C.red} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}><FmtCell val={m.investing?.capex} color={C.orange} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}><FmtCell val={m.investing?.security_deposits_paid} color={C.purple} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 700 }}><FmtCell val={m.investing?.net_investing} color={m.investing?.net_investing >= 0 ? C.green : C.orange} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}><FmtCell val={m.financing?.debt_drawdown} color={C.cyan} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}><FmtCell val={m.financing?.debt_repayment} color={C.red} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 700 }}><FmtCell val={m.financing?.net_financing} color={m.financing?.net_financing >= 0 ? C.green : C.red} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 700 }}><FmtCell val={m.closing_cash} color={m.closing_cash >= 0 ? C.green : C.red} /></td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}>{m.funding_gap != null ? <span style={{ color: m.funding_gap >= 0 ? C.green : C.red, fontWeight: 700 }}>{fmtINR2(m.funding_gap)}</span> : <NullCell />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ color: C.textMut, fontSize: 10.5, marginTop: 8 }}>¹ Negative Investing/Financing values = cash outflow (displayed as computed). Funding Gap = Closing Cash − Min Cash Requirement.</div>
            </div>
          )}
        </div>
      )}

      {/* ── CORPORATE COST ── */}
      {view === 'corp_cost' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Corporate / HO Cost Master</div>
              <div style={{ fontSize: 12, color: C.textSec }}>Head Office costs NOT included in Branch Cost (Step 5). These reduce Centre Contribution to EBITDA.</div>
            </div>
            <button onClick={() => openCorpModal(null)} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>+ Add Cost</button>
          </div>
          <div style={{ color: C.yellow, background: C.yellow + '10', border: `1px solid ${C.yellow}30`, borderRadius: 5, padding: '8px 12px', fontSize: 12, marginBottom: 12 }}>
            Ensure no cost appears in both Branch Cost (Step 5) and Corporate Cost. Duplicate-category validation is in Reconciliation RC-F02.
          </div>
          {!corpCost.filter(a => a.active !== false).length
            ? <div style={{ color: C.textMut, padding: 20 }}>No corporate cost assumptions. Add at least one assumption to compute EBITDA.</div>
            : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: C.surfaceEl }}>
                    {['ID', 'Category', 'Description', 'Method', 'Amount', 'From', 'To', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {corpCost.filter(a => a.active !== false).map(asm => (
                    <tr key={asm.assumption_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '7px 12px' }} className="mono">{asm.assumption_id}</td>
                      <td style={{ padding: '7px 12px', color: C.text }}>{asm.cost_category}</td>
                      <td style={{ padding: '7px 12px', color: C.textSec, fontSize: 11 }}>{asm.description || '—'}</td>
                      <td style={{ padding: '7px 12px', color: C.textMut, fontSize: 11 }}>{asm.calc_method}</td>
                      <td style={{ padding: '7px 12px', color: C.text, fontVariantNumeric: 'tabular-nums' }}>{asm.calc_method === 'pct_of_revenue' ? `${asm.variable_pct}% rev` : fmtINR2(asm.fixed_monthly_amount)}</td>
                      <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 10, color: C.textMut }}>{asm.effective_from?.substring(0, 10) || '—'}</td>
                      <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 10, color: C.textMut }}>{asm.effective_to?.substring(0, 10) || 'ongoing'}</td>
                      <td style={{ padding: '7px 12px' }}>
                        <button onClick={() => openCorpModal(asm)} style={{ background: C.accent + '22', border: `1px solid ${C.accent}44`, color: C.accent, borderRadius: 4, padding: '3px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Edit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── DEBT ── */}
      {view === 'debt' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Debt Schedule</div>
          </div>
          <div style={{ background: C.orange + '10', border: `1px solid ${C.orange}30`, borderRadius: 5, padding: '10px 14px', fontSize: 12, color: C.orange, marginBottom: 14 }}>
            ⚠ REQUIRES DATA — Populate with validated debt schedule from your existing model or banking documents. Do NOT invent opening principal, interest rates, or repayment schedules.
          </div>
          {!debtSched.filter(d => d.active !== false).length
            ? <div style={{ color: C.textMut }}>No debt facilities configured. Add via API or database. Fields: facility_name, lender, facility_type, opening_principal, interest_rate, interest_type, drawdown_schedule, repayment_schedule.</div>
            : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead><tr style={{ background: C.surfaceEl }}>
                  {['ID', 'Name', 'Type', 'Opening Principal', 'Interest Rate', 'Drawdowns', 'Repayments'].map(h => (
                    <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {debtSched.filter(d => d.active !== false).map(f => (
                    <tr key={f.facility_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.cyan, fontSize: 11 }}>{f.facility_id}</td>
                      <td style={{ padding: '7px 12px', color: C.text, fontWeight: 600 }}>{f.facility_name || '—'}</td>
                      <td style={{ padding: '7px 12px', color: C.textSec, fontSize: 11 }}>{f.facility_type || '—'}</td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: C.red, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(f.opening_principal)}</td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textSec }}>{f.interest_rate ? `${f.interest_rate}% ${f.interest_type || ''}` : '—'}</td>
                      <td style={{ padding: '7px 12px', color: C.textMut, fontSize: 11 }}>{(f.drawdown_schedule || []).length} entries</td>
                      <td style={{ padding: '7px 12px', color: C.textMut, fontSize: 11 }}>{(f.repayment_schedule || []).length} entries</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── LEASE ── */}
      {view === 'lease' && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Ind AS 116 Lease Schedule</div>
          <div style={{ background: C.orange + '10', border: `1px solid ${C.orange}30`, borderRadius: 5, padding: '10px 14px', fontSize: 12, color: C.orange, marginBottom: 14 }}>
            ⚠ REQUIRES DATA — Populate with lease schedules from your existing Ind AS 116 model or audited accounts. Do NOT assume Cash Rent = P&L Rent Expense for Ind AS 116 leases.
          </div>
          {!leaseSched.filter(l => l.active !== false).length
            ? <div style={{ color: C.textMut }}>No leases configured. Required fields: branch_id, commencement_date, lease_term_months, monthly_payment, discount_rate, classification, opening_rou, opening_liability.</div>
            : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead><tr style={{ background: C.surfaceEl }}>
                  {['ID', 'Branch', 'Commencement', 'Term', 'Monthly Payment', 'Rate%', 'Classification', 'Opening ROU', 'Opening Liability'].map(h => (
                    <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {leaseSched.filter(l => l.active !== false).map(l => (
                    <tr key={l.lease_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: C.cyan, fontSize: 11 }}>{l.lease_id}</td>
                      <td style={{ padding: '7px 12px', color: C.text }}>{(branches || []).find(b => b.branch_id === l.branch_id)?.branch_name || l.branch_id || '—'}</td>
                      <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: C.textMut }}>{l.commencement_date || '—'}</td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textSec }}>{l.lease_term_months ? `${l.lease_term_months} mo` : '—'}</td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: C.text, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(l.monthly_payment)}</td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: C.textSec }}>{l.discount_rate ? `${l.discount_rate}%` : '—'}</td>
                      <td style={{ padding: '7px 12px' }}>
                        <span style={{ background: (l.classification === 'ind_as_116' ? C.red : l.classification === 'short_term_exempt' ? C.green : C.yellow) + '22', color: l.classification === 'ind_as_116' ? C.red : l.classification === 'short_term_exempt' ? C.green : C.yellow, borderRadius: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700 }}>{l.classification || 'REVIEW'}</span>
                      </td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: C.accent, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(l.opening_rou)}</td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: C.red, fontVariantNumeric: 'tabular-nums' }}>{fmtINR2(l.opening_liability)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── RECONCILIATION ── */}
      {view === 'reconciliation' && recon && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Integrated Reconciliation Checks (RC-F01 to RC-F15)</div>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 14 }}>Verifies three-statement linkage, Step 3/4/5 integration, and data completeness.</div>
          {!recon.checks?.length
            ? <div style={{ color: C.textMut }}>Run compute first.</div>
            : (
            <>
              <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'hidden', marginBottom: 12 }}>
                {recon.checks.map((c, i) => (
                  <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 16px', borderBottom: i < recon.checks.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.textMut, background: C.surface, padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>{c.id}</span>
                    <ReconBadge2 pass={c.pass} />
                    <div style={{ flex: 1 }}>
                      <div style={{ color: C.text, fontSize: 12.5, fontWeight: 600 }}>{c.name}</div>
                      {c.note && <div style={{ color: C.orange, fontSize: 11, marginTop: 2 }}>{c.note}</div>}
                      {c.max_gap > 0 && <div style={{ color: C.red, fontSize: 11, marginTop: 2 }}>Max gap: ₹{c.max_gap?.toFixed(2)}</div>}
                      {c.gap != null && c.gap !== 0 && <div style={{ color: C.red, fontSize: 11, marginTop: 2 }}>Gap: ₹{c.gap?.toFixed(2)}</div>}
                      {c.tolerance != null && <div style={{ color: C.textMut, fontSize: 10.5, marginTop: 1 }}>Tolerance: ₹{c.tolerance}</div>}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: '12px 16px', background: recon.all_pass ? C.green + '12' : C.red + '12', border: `1px solid ${recon.all_pass ? C.green : C.red}33`, borderRadius: 6, color: recon.all_pass ? C.green : C.red, fontWeight: 700 }}>
                {recon.all_pass ? '✓ All 15 reconciliation checks pass.' : '✗ One or more checks failed. Production migration blocked.'}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── OPEN ITEMS ── */}
      {view === 'open_items' && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Open Items / Migration Blockers Register</div>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 14 }}>All unresolved items from Steps 4, 5, and 6. Critical Blockers prevent production migration.</div>
          {[
            { label: 'Critical Blocker', key: 'critical_blocker', color: C.red },
            { label: 'Data Required', key: 'data_required', color: C.orange },
            { label: 'Pending Live Data', key: 'pending_live_data', color: C.yellow },
            { label: 'Requires Decision', key: 'requires_decision', color: C.purple },
            { label: 'Requires Accounting Review', key: 'requires_accounting_review', color: C.red },
            { label: 'Resolved', key: 'resolved', color: C.green },
          ].map(({ label, key, color }) => {
            const items = openItems.filter(i => i.classification === key || (key === 'resolved' && i.status === 'resolved'));
            if (!items.length) return null;
            return (
              <div key={key} style={{ marginBottom: 20 }}>
                <div style={{ color, fontWeight: 700, fontSize: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label} ({items.length})</div>
                {items.map(item => (
                  <div key={item.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: '12px 14px', marginBottom: 6, borderLeft: `3px solid ${color}` }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <div>
                        <span style={{ fontFamily: 'monospace', fontSize: 10, color: C.textMut, background: C.surfaceEl, padding: '1px 5px', borderRadius: 3, marginRight: 8 }}>{item.id}</span>
                        <span style={{ fontFamily: 'monospace', fontSize: 10, color: C.accent, background: C.accent + '18', padding: '1px 5px', borderRadius: 3, marginRight: 8 }}>STEP {item.step}</span>
                        <span style={{ color: C.text, fontWeight: 600, fontSize: 12.5 }}>{item.title}</span>
                      </div>
                      {item.status !== 'resolved' && <button onClick={() => resolveItem(item.id, 'resolved')} style={{ background: C.green + '22', border: `1px solid ${C.green}44`, color: C.green, borderRadius: 4, padding: '3px 10px', fontSize: 11, cursor: 'pointer', flexShrink: 0, fontWeight: 600 }}>Mark Resolved</button>}
                      {item.status === 'resolved' && <span style={{ color: C.green, fontSize: 11 }}>✓ Resolved</span>}
                    </div>
                    {item.description && <div style={{ color: C.textSec, fontSize: 12, marginTop: 6, lineHeight: 1.55 }}>{item.description}</div>}
                    {item.is_migration_blocker && item.status !== 'resolved' && <div style={{ color: C.red, fontSize: 10.5, marginTop: 4, fontWeight: 600 }}>⛔ MIGRATION BLOCKER</div>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* ── MIGRATION GATE ── */}
      {view === 'migration' && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 16 }}>Production Migration Gate</div>
          {!gateData
            ? <div style={{ color: C.textMut }}>Run compute first to evaluate the migration gate.</div>
            : (
            <div>
              <div style={{ marginBottom: 20 }}>
                <MigrationGateBadge status={gateData.status} />
                <div style={{ color: C.textSec, fontSize: 12, marginTop: 10, lineHeight: 1.65 }}>{gateData.message}</div>
                {gateData.evaluated_at && <div style={{ color: C.textMut, fontSize: 11, marginTop: 4 }}>Evaluated: {new Date(gateData.evaluated_at).toLocaleString('en-IN')}</div>}
              </div>
              {gateData.blockers?.length > 0 && (
                <div>
                  <div style={{ color: C.red, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{gateData.total_blockers} Blocker(s) Remaining</div>
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
                    {gateData.blockers.map((b, i) => (
                      <div key={i} style={{ padding: '10px 14px', borderBottom: i < gateData.blockers.length - 1 ? `1px solid ${C.border}` : 'none', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <span style={{ color: C.red, flexShrink: 0, fontSize: 14 }}>⛔</span>
                        <span style={{ color: C.textSec, fontSize: 12.5, lineHeight: 1.55 }}>{b}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ marginTop: 20, background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '14px 18px' }}>
                <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Migration Criteria</div>
                {[
                  ['No Critical Blockers', gateData.total_blockers === 0],
                  ['BS Check passes (Total Assets = Total Equity & Liabilities)', recon?.checks?.find(c => c.id === 'RC-F10')?.pass || false],
                  ['Cash roll-forward passes (RC-F09)', recon?.checks?.find(c => c.id === 'RC-F09')?.pass || false],
                  ['Revenue reconciles with Step 4 (RC-F01)', recon?.checks?.find(c => c.id === 'RC-F01')?.pass || false],
                  ['Cost reconciles with Step 5 (RC-F02)', recon?.checks?.find(c => c.id === 'RC-F02')?.pass || false],
                  ['Step-4 live-data tests resolved', openItems.filter(i => i.status === 'pending_live_data').length === 0],
                  ['Step-5 utilities decision resolved', openItems.find(i => i.id === 'OI-005')?.status === 'resolved'],
                  ['Opening Balance Sheet provided', openItems.find(i => i.id === 'OI-006')?.status === 'resolved'],
                  ['Existing BS imbalance (₹9.17 Cr) traced and resolved', openItems.find(i => i.id === 'OI-010')?.status === 'resolved'],
                ].map(([label, pass]) => (
                  <div key={label} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ color: pass ? C.green : C.red, fontSize: 14, flexShrink: 0 }}>{pass ? '✓' : '✗'}</span>
                    <span style={{ color: pass ? C.textSec : C.text, fontSize: 12.5 }}>{label}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16, background: C.red + '08', border: `1px solid ${C.red}30`, borderRadius: 6, padding: '14px 18px' }}>
                <div style={{ color: C.red, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>⛔ Even when gate is READY — do NOT migrate automatically</div>
                <div style={{ color: C.textSec, fontSize: 12, lineHeight: 1.6 }}>The migration gate evaluates technical readiness only. Production migration requires explicit management approval and change-management sign-off. The existing production model will remain unchanged until you give that approval separately.</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── DATA SETUP ── */}
      {view === 'setup' && (
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Data Setup — Required Inputs</div>
          <div style={{ fontSize: 12, color: C.textSec, marginBottom: 16 }}>Populate these inputs before running compute. Items marked REQUIRES DATA will leave model outputs null until provided.</div>
          {[
            { title: 'Opening Balance Sheet', status: 'REQUIRES DATA', note: 'PUT /api/fpa/integrated/opening-balance-sheet — Provide the latest approved actual month-end BS as JSON with { as_at_month, source, balances: { assets: { non_current: { ppe_net, rou_assets, security_deposits, other_non_current }, current: { trade_receivables, cash, advances, tax_assets } }, equity: { share_capital, securities_premium, retained_earnings, other_reserves }, liabilities: { non_current: { borrowings, lease_liabilities }, current: { trade_payables, other_current } } } }', color: C.red },
            { title: 'Debt Schedule', status: 'REQUIRES DATA', note: 'POST /api/fpa/integrated/debt-schedule per facility. Fields: facility_name, opening_principal, interest_rate, interest_type, drawdown_schedule [{month, amount}], repayment_schedule [{month, principal, interest}]', color: C.red },
            { title: 'Lease Schedule (Ind AS 116)', status: 'REQUIRES DATA', note: 'POST /api/fpa/integrated/lease-schedule per lease. Fields: branch_id, commencement_date, lease_term_months, monthly_payment, discount_rate, classification (ind_as_116/short_term_exempt/low_value_exempt), opening_rou, opening_liability', color: C.red },
            { title: 'Fixed Asset Register (Existing)', status: 'REQUIRES DATA', note: 'POST /api/fpa/integrated/asset-register per asset. Fields: asset_name, asset_category, cost, capitalisation_date, useful_life_months, depreciation_method (slm/wdv), residual_value, accumulated_depreciation', color: C.red },
            { title: 'Account Mapping (Zoho GL)', status: 'REQUIRES DATA', note: 'POST /api/fpa/integrated/account-mapping per GL account. Fields: zoho_account_id, zoho_account_name, account_type, fpa_statement (pl/bs), fpa_line, branch_or_corporate, cash_flow_line, mapping_status', color: C.orange },
            { title: 'WC Parameters', status: wcParams?.ar_dso_days ? 'CONFIGURED (defaults)' : 'CHECK', note: `PUT /api/fpa/integrated/wc-params. Current: AR DSO ${wcParams?.ar_dso_days || '?'} days, AP DPO ${wcParams?.ap_dpo_days || '?'} days. Override with client-specific terms for accuracy.`, color: C.yellow },
            { title: 'Tax Parameters', status: taxParams?.tax_rate_pct ? 'CONFIGURED (defaults)' : 'CHECK', note: `PUT /api/fpa/integrated/tax-params. Current: ${taxParams?.tax_rate_pct || 25.17}% (${taxParams?.method || 'configured_rate'}). Confirm method with management.`, color: C.yellow },
          ].map(({ title, status, note, color }) => (
            <div key={title} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: '12px 16px', marginBottom: 8, borderLeft: `3px solid ${color}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{title}</span>
                <span style={{ background: color + '18', color, borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 700 }}>{status}</span>
              </div>
              <div style={{ color: C.textSec, fontSize: 11.5, lineHeight: 1.55, fontFamily: 'monospace' }}>{note}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── STEP 7 READINESS DASHBOARD ── */}
      {view === 'step7' && <Step7ReadinessView />}

      {/* ── BS IMBALANCE BRIDGE ── */}
      {view === 'bs_bridge' && <BsBridgeView />}

      {/* ── DATA QUALITY SCORECARD ── */}
      {view === 'scorecard' && <ScorecardView />}

      {/* ── ACCEPTANCE TESTS ── */}
      {view === 'accept_tests' && <AcceptanceTestsView />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7 SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
const AT_STATUS_COLOR = { PASS: C.green, FAIL: C.red, BLOCKED: C.orange, REQUIRES_DATA: C.yellow, REQUIRES_DECISION: C.purple, REVIEW_REQUIRED: C.cyan, IN_PROGRESS: C.accent };

function Step7ReadinessView() {
  const [status, setStatus]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try { const s = await apiFetch('/api/fpa/step7/status'); setStatus(s); }
    catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const autoRun = async (action, label) => {
    setRunning(p => ({ ...p, [action]: true }));
    try {
      const r = await apiFetch(`/api/fpa/step7/${action}`, { method: 'POST' });
      alert(r.message || 'Done');
      load();
    } catch (e) { alert('Error: ' + e.message); }
    setRunning(p => ({ ...p, [action]: false }));
  };

  const sc = status?.scorecard;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>Step 7 — Migration Readiness</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>Data Completion · Root-Cause Reconciliation · Live-Data Testing · Three-Statement Validation</div>
        </div>
        <button onClick={load} style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, color: C.textSec, borderRadius: 5, padding: '5px 12px', fontSize: 11.5, cursor: 'pointer' }}>↻ Refresh</button>
      </div>

      {/* Migration Gate Badge */}
      {status?.migration_gate && (
        <div style={{ marginBottom: 20 }}>
          <MigrationGateBadge status={status.migration_gate.status} />
          <span style={{ color: C.textSec, fontSize: 12, marginLeft: 12 }}>{status.migration_gate.total_blockers} blocker(s)</span>
        </div>
      )}

      {/* Auto-populate actions */}
      <div style={{ background: C.surfaceEl, border: `1px solid ${C.accent}33`, borderRadius: 8, padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ color: C.accent, fontWeight: 700, fontSize: 13, marginBottom: 12 }}>Auto-Populate from Existing Data Sources</div>
        <div style={{ color: C.textSec, fontSize: 12, marginBottom: 14, lineHeight: 1.55 }}>
          These actions populate FP&A model inputs from the existing audited financial data already in the system. <strong style={{ color: C.orange }}>Review all auto-populated data before approving for migration.</strong>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { action: 'auto-populate-opening-bs', label: '📊 Populate Opening BS', desc: 'From financial_bs_data.json (Audited FY2025-26)', color: C.green },
            { action: 'auto-populate-account-mapping', label: '🗂 Populate GL Mapping', desc: 'From financial_tb_data.json (1,895 GL accounts)', color: C.cyan },
            { action: 'auto-populate-debt', label: '🏦 Populate Debt Schedule', desc: 'Opening balances from audited BS Note 19/22', color: C.orange },
          ].map(({ action, label, desc, color }) => (
            <div key={action} style={{ background: C.surface, border: `1px solid ${color}44`, borderRadius: 6, padding: '12px 16px', flex: '1 1 200px' }}>
              <div style={{ color: C.text, fontWeight: 700, fontSize: 12.5, marginBottom: 3 }}>{label}</div>
              <div style={{ color: C.textMut, fontSize: 11, marginBottom: 10 }}>{desc}</div>
              <button onClick={() => autoRun(action, label)} disabled={running[action]} style={{ background: color + '22', border: `1px solid ${color}55`, color, borderRadius: 4, padding: '4px 14px', fontSize: 11.5, cursor: 'pointer', fontWeight: 700, opacity: running[action] ? 0.5 : 1 }}>
                {running[action] ? '⟳ Running…' : 'Run'}
              </button>
            </div>
          ))}
        </div>
        <div style={{ color: C.yellow, fontSize: 11.5, marginTop: 12, fontWeight: 600 }}>
          ⚠ Lease Schedule and Fixed Asset Register still REQUIRE MANUAL INPUT — per-lease/asset detail (commencement date, discount rate, useful life) not available in any existing data file.
        </div>
      </div>

      {/* Data completeness grid */}
      {sc && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 10, marginBottom: 20 }}>
          {[
            { label: 'Overall Completeness', val: `${sc.overall_completeness_pct}%`, color: sc.overall_completeness_pct > 70 ? C.green : sc.overall_completeness_pct > 40 ? C.yellow : C.red },
            { label: 'Opening BS', val: sc.opening_bs.complete ? `✓ Populated` : 'MISSING', color: sc.opening_bs.complete ? C.green : C.red },
            { label: 'Debt Schedule', val: sc.debt.facilities > 0 ? `${sc.debt.facilities} facilities` : 'MISSING', color: sc.debt.complete ? C.yellow : C.red },
            { label: 'Lease Schedule', val: sc.lease.leases > 0 ? `${sc.lease.leases} leases` : 'REQUIRES DATA', color: sc.lease.complete ? C.yellow : C.red },
            { label: 'Asset Register', val: sc.asset_register.assets > 0 ? `${sc.asset_register.assets} assets` : 'REQUIRES DATA', color: sc.asset_register.complete ? C.yellow : C.red },
            { label: 'GL Mapping', val: `${sc.account_mapping.coverage_pct}% (${sc.account_mapping.mapped}/${sc.account_mapping.total_gl})`, color: sc.account_mapping.coverage_pct > 80 ? C.green : sc.account_mapping.coverage_pct > 0 ? C.yellow : C.red },
            { label: 'Critical Blockers', val: sc.open_items.critical_blockers, color: sc.open_items.critical_blockers === 0 ? C.green : C.red },
            { label: 'BS Imbalance', val: sc.bs_imbalance.resolved ? '✓ Resolved' : `₹${sc.bs_imbalance.gap_lakhs}L`, color: sc.bs_imbalance.resolved ? C.green : C.red },
          ].map(({ label, val, color }) => (
            <div key={label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: '10px 14px' }}>
              <div style={{ color: C.textMut, fontSize: 10, textTransform: 'uppercase', fontWeight: 700, marginBottom: 4 }}>{label}</div>
              <div style={{ color, fontWeight: 700, fontSize: 13 }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Required manual inputs */}
      <div style={{ background: C.red + '08', border: `1px solid ${C.red}25`, borderRadius: 7, padding: '14px 18px' }}>
        <div style={{ color: C.red, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Remaining REQUIRES DATA — No Auto-Populate Available</div>
        {[
          { title: 'Ind AS 116 Lease Schedule', fields: 'commencement_date, lease_term_months, discount_rate, opening_rou, opening_liability per branch', source: 'Lease agreements / auditor Ind AS 116 workings', api: 'POST /api/fpa/integrated/lease-schedule' },
          { title: 'Fixed Asset Register', fields: 'asset_name, category, cost, capitalisation_date, useful_life_months, accumulated_depreciation per asset', source: 'FAR from accounting / auditor', api: 'POST /api/fpa/integrated/asset-register' },
          { title: 'Debt Interest Rates & Repayment Schedules', fields: 'interest_rate, repayment_schedule[{month, principal, interest}] for each facility', source: 'Loan Data Final.xlsx — Loan Module', api: 'PUT /api/fpa/integrated/debt-schedule/:id for each facility' },
          { title: 'Utilities Fixed/Variable Decision', fields: 'fixed_pct, variable_pct, variable_driver', source: 'Management decision', api: 'PUT /api/fpa/step7/utilities-decision' },
        ].map(({ title, fields, source, api }) => (
          <div key={title} style={{ marginBottom: 10, padding: '10px 14px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, borderLeft: `3px solid ${C.red}` }}>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 12.5, marginBottom: 3 }}>{title}</div>
            <div style={{ color: C.textSec, fontSize: 11.5, marginBottom: 2 }}>Fields: <code style={{ fontSize: 10.5 }}>{fields}</code></div>
            <div style={{ color: C.textMut, fontSize: 11 }}>Source: {source} · API: <code style={{ color: C.cyan, fontSize: 10.5 }}>{api}</code></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BsBridgeView() {
  const [bridge, setBridge] = useState(null);
  const [form, setForm]     = useState({ cause: '', explanation: '', amount_lakhs: '', evidence: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { const b = await apiFetch('/api/fpa/step7/bs-imbalance-bridge'); setBridge(b); }
    catch (e) { console.error(e); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addItem = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/fpa/step7/bs-imbalance-bridge', { method: 'PUT', body: JSON.stringify({ cause: form.cause, explanation: form.explanation, amount_lakhs: parseFloat(form.amount_lakhs), evidence: form.evidence }) });
      setForm({ cause: '', explanation: '', amount_lakhs: '', evidence: '' });
      load();
    } catch (e) { alert(e.message); }
    setSaving(false);
  };

  return (
    <div>
      <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>₹9.17 Cr Balance Sheet Imbalance Bridge</div>
      <div style={{ color: C.textSec, fontSize: 12, marginBottom: 16 }}>Trace each component of the identified imbalance from ₹9.17 Cr towards ₹0. Every correction requires evidence.</div>
      {bridge && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <KpiCard label="Starting Imbalance" value={`₹${bridge.starting_imbalance_lakhs}L`} color={C.red} />
            <KpiCard label="Remaining Gap" value={`₹${bridge.current_imbalance_lakhs?.toFixed(2)}L`} color={Math.abs(bridge.current_imbalance_lakhs) < 1 ? C.green : C.red} />
            <KpiCard label="Status" value={bridge.resolution_status?.replace('_',' ').toUpperCase()} color={bridge.resolution_status === 'resolved' ? C.green : C.yellow} />
          </div>
          {bridge.items?.length > 0 && (
            <div style={{ overflowX: 'auto', marginBottom: 20 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: C.surfaceEl }}>
                    {['ID', 'Cause', 'Correction (₹L)', 'Cumulative (₹L)', 'Evidence', 'Status'].map(h => (
                      <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: C.textSec, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bridge.items.map(item => (
                    <tr key={item.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: '7px 12px', fontFamily: 'monospace', fontSize: 11, color: C.cyan }}>{item.id}</td>
                      <td style={{ padding: '7px 12px', color: C.text, fontWeight: 600, maxWidth: 260 }}>{item.cause}</td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: item.amount_lakhs < 0 ? C.green : C.red, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{item.amount_lakhs > 0 ? '+' : ''}{item.amount_lakhs?.toFixed(2)}</td>
                      <td style={{ padding: '7px 12px', textAlign: 'right', color: Math.abs(item.cumulative_after || 0) < 1 ? C.green : C.yellow, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{item.cumulative_after?.toFixed(2)}</td>
                      <td style={{ padding: '7px 12px', color: C.textMut, fontSize: 11, maxWidth: 220 }}>{item.evidence || '—'}</td>
                      <td style={{ padding: '7px 12px' }}>
                        <span style={{ background: (item.status === 'resolved' ? C.green : C.yellow) + '22', color: item.status === 'resolved' ? C.green : C.yellow, borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 700 }}>{item.status?.toUpperCase()}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {bridge.notes && <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: C.textSec, marginBottom: 16 }}>{bridge.notes}</div>}
        </>
      )}
      <div style={{ background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 7, padding: '16px 18px' }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Add Bridge Correction Item</div>
        <TwoCol>
          <Field label="Cause (brief description)" required><Inp value={form.cause} onChange={v => setForm(p=>({...p,cause:v}))} /></Field>
          <Field label="Correction Amount (₹L — negative = reduces gap)"><Inp type="number" value={form.amount_lakhs} onChange={v => setForm(p=>({...p,amount_lakhs:v}))} /></Field>
          <Field label="Explanation"><Inp value={form.explanation} onChange={v => setForm(p=>({...p,explanation:v}))} /></Field>
          <Field label="Evidence Reference"><Inp value={form.evidence} onChange={v => setForm(p=>({...p,evidence:v}))} /></Field>
        </TwoCol>
        <SaveBtn onClick={addItem} loading={saving} label="Add to Bridge" />
        <div style={{ color: C.red, fontSize: 11, marginTop: 8, fontWeight: 600 }}>⛔ No balancing plugs. Every correction must have evidence and traceability to accounting records.</div>
      </div>
    </div>
  );
}

function ScorecardView() {
  const [sc, setSc] = useState(null);
  const load = useCallback(async () => { try { setSc(await apiFetch('/api/fpa/step7/scorecard')); } catch {} }, []);
  useEffect(() => { load(); }, [load]);
  if (!sc) return <div style={{ color: C.textMut }}>Loading scorecard…</div>;
  const bars = [
    { label: 'Opening BS', pct: sc.opening_bs.pct, note: sc.opening_bs.complete ? `Populated (${sc.opening_bs.check})` : 'MISSING', color: sc.opening_bs.complete ? C.green : C.red },
    { label: 'Debt Schedule', pct: sc.debt.pct, note: sc.debt.facilities > 0 ? `${sc.debt.facilities} facilities (interest rates pending)` : 'MISSING', color: sc.debt.complete ? C.yellow : C.red },
    { label: 'Lease Schedule', pct: sc.lease.pct, note: sc.lease.note || (sc.lease.leases > 0 ? `${sc.lease.leases} leases` : 'MISSING'), color: sc.lease.complete ? C.green : C.red },
    { label: 'Asset Register', pct: sc.asset_register.pct, note: sc.asset_register.note || (sc.asset_register.assets > 0 ? `${sc.asset_register.assets} assets` : 'MISSING'), color: sc.asset_register.complete ? C.green : C.red },
    { label: 'GL Account Mapping', pct: sc.account_mapping.coverage_pct, note: `${sc.account_mapping.mapped} / ${sc.account_mapping.total_gl} accounts`, color: sc.account_mapping.coverage_pct > 80 ? C.green : sc.account_mapping.coverage_pct > 0 ? C.yellow : C.red },
    { label: 'Reconciliation (15 checks)', pct: sc.reconciliation.computed ? (sc.reconciliation.all_pass ? 100 : 30) : 0, note: sc.reconciliation.computed ? (sc.reconciliation.all_pass ? 'All PASS' : 'Some failing') : 'Pending compute', color: sc.reconciliation.all_pass ? C.green : sc.reconciliation.computed ? C.red : C.textMut },
  ];
  return (
    <div>
      <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Data Quality & Migration Readiness Scorecard</div>
      <div style={{ color: C.textSec, fontSize: 12, marginBottom: 16 }}>Completeness assessment for each required input. A score does not override a critical blocker.</div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ color: C.textMut, fontSize: 10, textTransform: 'uppercase', fontWeight: 700, marginBottom: 4 }}>Overall Completeness</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, background: C.surfaceEl, borderRadius: 8, height: 18, overflow: 'hidden' }}>
            <div style={{ background: C.accent, height: '100%', width: `${sc.overall_completeness_pct}%`, transition: 'width 0.5s', borderRadius: 8 }} />
          </div>
          <span style={{ color: C.accent, fontWeight: 700, fontSize: 18, minWidth: 50 }}>{sc.overall_completeness_pct}%</span>
        </div>
      </div>
      {bars.map(({ label, pct, note, color }) => (
        <div key={label} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: C.text, fontSize: 12.5, fontWeight: 600 }}>{label}</span>
            <span style={{ color, fontSize: 12, fontWeight: 700 }}>{pct}%</span>
          </div>
          <div style={{ background: C.surfaceEl, borderRadius: 5, height: 10, overflow: 'hidden', marginBottom: 3 }}>
            <div style={{ background: color, height: '100%', width: `${pct}%`, transition: 'width 0.5s', borderRadius: 5 }} />
          </div>
          <div style={{ color: C.textMut, fontSize: 11 }}>{note}</div>
        </div>
      ))}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, padding: '12px 16px', marginTop: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[
            { label: 'Critical Blockers', val: sc.open_items.critical_blockers, color: sc.open_items.critical_blockers === 0 ? C.green : C.red },
            { label: 'Material Blockers', val: sc.open_items.material_blockers, color: sc.open_items.material_blockers === 0 ? C.green : C.orange },
            { label: 'BS Imbalance', val: sc.bs_imbalance.resolved ? '✓ RESOLVED' : `₹${sc.bs_imbalance.gap_lakhs}L`, color: sc.bs_imbalance.resolved ? C.green : C.red },
            { label: 'Reconciliation', val: sc.reconciliation.all_pass ? '✓ All PASS' : sc.reconciliation.computed ? 'FAILING' : 'Pending', color: sc.reconciliation.all_pass ? C.green : C.orange },
          ].map(({ label, val, color }) => (
            <div key={label}>
              <div style={{ color: C.textMut, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
              <div style={{ color, fontWeight: 700, fontSize: 14 }}>{val}</div>
            </div>
          ))}
        </div>
        <div style={{ color: C.orange, fontSize: 11, marginTop: 12, fontWeight: 600 }}>A high completeness score does not override an unresolved critical blocker. All 9 migration gate criteria must be met independently.</div>
      </div>
    </div>
  );
}

function AcceptanceTestsView() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setResult(await apiFetch('/api/fpa/step7/acceptance-tests')); }
    catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const groups = [
    { label: 'Opening Balance Sheet (1–10)', start: 0, end: 10 },
    { label: 'Debt (11–13)', start: 10, end: 13 },
    { label: 'Lease / Ind AS 116 (14–18)', start: 13, end: 18 },
    { label: 'Fixed Assets (19–23)', start: 18, end: 23 },
    { label: 'Working Capital (24–27)', start: 23, end: 27 },
    { label: 'Account Mapping / TB (28–30)', start: 27, end: 30 },
    { label: 'Three Statements (31–39)', start: 30, end: 39 },
    { label: 'Prior Steps (40–43)', start: 39, end: 43 },
    { label: 'Migration Gate (44–50)', start: 43, end: 50 },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Step 7 — 50 Acceptance Tests</div>
          <div style={{ color: C.textSec, fontSize: 12 }}>All tests must PASS before Migration Gate = READY FOR MIGRATION</div>
        </div>
        <button onClick={load} disabled={loading} style={{ background: C.accent, border: 'none', color: '#fff', borderRadius: 5, padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: loading ? 0.5 : 1 }}>{loading ? '⟳' : '↻ Re-run'}</button>
      </div>

      {result?.counts && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {Object.entries(result.counts).filter(([,v])=>v>0).map(([k,v]) => (
            <div key={k} style={{ background: (AT_STATUS_COLOR[k] || C.textMut) + '18', border: `1px solid ${(AT_STATUS_COLOR[k]||C.textMut)}44`, color: AT_STATUS_COLOR[k]||C.textMut, borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 700 }}>
              {k.replace('_',' ')}: {v}
            </div>
          ))}
          <div style={{ background: C.text + '10', color: C.textSec, borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 700 }}>TOTAL: {result.total}</div>
        </div>
      )}

      {result?.tests && groups.map(({ label, start, end }) => {
        const grpTests = result.tests.slice(start, end);
        const allPass  = grpTests.every(t => t.status === 'PASS');
        return (
          <div key={label} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '8px 12px', background: C.surfaceEl, borderRadius: 6 }}>
              <span style={{ color: allPass ? C.green : C.orange, fontSize: 14 }}>{allPass ? '✓' : '○'}</span>
              <span style={{ color: C.text, fontWeight: 700, fontSize: 12.5 }}>{label}</span>
              <span style={{ color: allPass ? C.green : C.textMut, fontSize: 11 }}>{grpTests.filter(t=>t.status==='PASS').length}/{grpTests.length} PASS</span>
            </div>
            {grpTests.map((t, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface }}>
                <span style={{ color: AT_STATUS_COLOR[t.status] || C.textMut, fontSize: 11, fontWeight: 700, flexShrink: 0, minWidth: 110 }}>{t.status?.replace('_',' ')}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ color: C.text, fontSize: 12 }}>{t.desc}</div>
                  {(t.evidence || t.reason || t.what || t.note) && <div style={{ color: C.textMut, fontSize: 11, marginTop: 2 }}>{t.evidence || t.reason || t.what || t.note}</div>}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8 — DATA CLOSURE + LIVE ZOHO VALIDATION + FINAL UAT
// ─────────────────────────────────────────────────────────────────────────────
const S8_GATE_COLOR = { ready: C.green, ready_with_conditions: C.yellow, not_ready: C.red };
const S8_STATUS_COLOR = { pass: C.green, fail: C.red, blocked: C.orange, pending: C.yellow, in_progress: C.accent, resolved: C.green, open: C.red, decision_required: C.purple, requires_data: C.red, approved: C.green, not_run: C.textMut };
function S8Badge({ status, children }) {
  const col = S8_STATUS_COLOR[status] || C.textSec;
  return <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:99, fontSize:10, fontWeight:700, letterSpacing:'.4px', background:`${col}18`, border:`1px solid ${col}40`, color:col }}>{(children || status || '').toString().toUpperCase().replace(/_/g,' ')}</span>;
}

function Step8Tab({ branches }) {
  const S8_VIEWS = [
    { id:'overview',     label:'📋 Overview' },
    { id:'obs',          label:'✅ Opening BS Review' },
    { id:'debt',         label:'🏦 Debt Closure' },
    { id:'lease',        label:'📄 Ind AS 116' },
    { id:'far',          label:'🏗 Fixed Assets' },
    { id:'zoho',         label:'🔄 Zoho Sync' },
    { id:'utilities',    label:'⚡ Utilities' },
    { id:'gl_mapping',   label:'🗂 GL Mapping' },
    { id:'tb_recon',     label:'⚖ TB Reconciliation' },
    { id:'compute',      label:'⚙ Compute' },
    { id:'rc',           label:'✔ RC Controls' },
    { id:'at',           label:'🧪 Acceptance Tests' },
    { id:'uat',          label:'🎯 Final UAT' },
    { id:'scorecard',    label:'📊 Scorecard' },
    { id:'open_items',   label:'📌 Open Items' },
    { id:'gate',         label:'🚦 Migration Gate' },
  ];
  const [view, setView] = useState('overview');
  const [status, setStatus] = useState(null);
  const [data, setData] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const api = (path, opts = {}) => api8(path, opts);
  function api8(path, opts = {}) {
    return fetch(`/api/fpa/step8${path}`, { ...opts, headers: { 'Content-Type':'application/json', Authorization:`Bearer ${localStorage.getItem('da_token')}`, ...opts.headers } })
      .then(r => r.json());
  }

  const load = (v) => {
    const vv = v || view;
    setBusy(true); setMsg(null);
    let path = '';
    switch(vv) {
      case 'overview':  path = '/status'; break;
      case 'obs':       path = '/obs-review'; break;
      case 'debt':      path = '/debt-closure'; break;
      case 'lease':     path = '/lease-closure'; break;
      case 'far':       path = '/far-closure'; break;
      case 'zoho':      path = '/zoho-sync'; break;
      case 'utilities': path = '/utilities-decision'; break;
      case 'gl_mapping':path = '/gl-mapping-queue'; break;
      case 'tb_recon':  path = '/tb-reconciliation'; break;
      case 'compute':   path = '/status'; break;
      case 'rc':        path = '/rc-controls'; break;
      case 'at':        path = '/acceptance-tests'; break;
      case 'uat':       path = '/uat'; break;
      case 'scorecard': path = '/scorecard'; break;
      case 'open_items':path = '/open-items-closure'; break;
      case 'gate':      path = '/migration-gate'; break;
      default: path = '/status';
    }
    api8(path).then(d => { setData(d); setBusy(false); }).catch(e => { setMsg(e.message); setBusy(false); });
  };

  useEffect(() => { load(view); }, [view]);

  const action = async (path, body, method = 'POST') => {
    setBusy(true); setMsg(null);
    try {
      const d = await api8(path, { method, body: body ? JSON.stringify(body) : undefined });
      setMsg(d.error ? `Error: ${d.error}` : 'Done');
      load(view);
    } catch(e) { setMsg(e.message); }
    setBusy(false);
  };

  const fmtL = (v) => v == null ? '—' : `₹${parseFloat(v).toFixed(2)}L`;
  const pct   = (c,t) => t > 0 ? `${Math.round(c/t*100)}%` : '—';

  const ProgressBar = ({ value, max, color }) => {
    const p = max > 0 ? Math.min(100, Math.round(value/max*100)) : 0;
    return <div style={{background:C.surfEl,borderRadius:4,height:8,overflow:'hidden',flex:1}}>
      <div style={{width:`${p}%`,height:'100%',background:color||C.accent,transition:'width .3s'}}/>
    </div>;
  };

  return (
    <div>
      {/* Sub-nav */}
      <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:16}}>
        {S8_VIEWS.map(v => <button key={v.id} onClick={() => { setView(v.id); load(v.id); }}
          style={{padding:'4px 12px',borderRadius:6,border:'none',cursor:'pointer',fontSize:12,fontWeight:view===v.id?700:400,background:view===v.id?C.accent:`${C.accent}18`,color:view===v.id?'#fff':C.accent}}>{v.label}</button>)}
      </div>
      {msg && <div style={{padding:'8px 12px',borderRadius:6,marginBottom:12,background:msg.startsWith('Error')?`${C.red}18`:`${C.green}18`,color:msg.startsWith('Error')?C.red:C.green,fontSize:12}}>{msg}</div>}
      {busy && <div style={{color:C.textMut,fontSize:12,marginBottom:8}}>Loading…</div>}

      {/* OVERVIEW */}
      {view === 'overview' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}>
            <h3 style={{color:C.text,margin:0}}>Step 8 — Data Closure + UAT</h3>
            {data.migration_gate_result && <S8Badge status={data.migration_gate_result.gate}>{data.migration_gate_result.gate==='ready'?'READY FOR MIGRATION':data.migration_gate_result.gate==='ready_with_conditions'?'READY WITH CONDITIONS':'NOT READY FOR MIGRATION'}</S8Badge>}
            {data.migration_gate_result && <span style={{fontSize:11,color:C.textMut}}>{data.migration_gate_result.blocker_count} blocker(s)</span>}
          </div>
          <div style={{background:`${C.orange}12`,border:`1px solid ${C.orange}30`,borderRadius:6,padding:'10px 14px',marginBottom:16,fontSize:12,color:C.orange}}>
            ⚠ Step 8 is DATA CLOSURE + UAT — not production migration. Even if Migration Gate = READY, do not migrate without explicit approval in Step 9.
          </div>
          {data.migration_gate_result?.criteria && (
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:8}}>
              {Object.entries(data.migration_gate_result.criteria).map(([k,c]) => (
                <div key={k} style={{background:C.surfEl,borderRadius:6,padding:'10px 14px',borderLeft:`3px solid ${c.pass?C.green:c.blocking?C.red:C.yellow}`}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                    <span style={{fontSize:12,color:C.text}}>{c.label}</span>
                    <S8Badge status={c.pass?'pass':c.blocking?'fail':'pending'}>{c.pass?'PASS':'FAIL'}</S8Badge>
                  </div>
                  {!c.pass && c.blocking && <div style={{fontSize:10,color:C.red,marginTop:4}}>⛔ MIGRATION BLOCKER</div>}
                </div>
              ))}
            </div>
          )}
          <div style={{display:'flex',gap:8,marginTop:16}}>
            <button onClick={() => load('overview')} style={{padding:'6px 14px',borderRadius:6,border:`1px solid ${C.border}`,background:C.surfEl,color:C.text,cursor:'pointer',fontSize:12}}>Refresh</button>
          </div>
        </div>
      )}

      {/* OPENING BS REVIEW */}
      {view === 'obs' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <h3 style={{color:C.text,margin:0}}>Opening Balance Sheet Review</h3>
            <S8Badge status={data.approval_status || 'pending_review'}>{data.approval_status || 'PENDING REVIEW'}</S8Badge>
            {data.bs_check_pass!=null && <S8Badge status={data.bs_check_pass?'pass':'fail'}>BS CHECK {data.bs_check_pass?'PASS':'FAIL'} ({fmtL(data.bs_check_diff)} diff)</S8Badge>}
          </div>
          <div style={{fontSize:12,color:C.textSec,marginBottom:12}}>As at: <strong style={{color:C.text}}>{data.as_at_month || '—'}</strong> &nbsp;|&nbsp; Source: Audited FY2025-26 financial statements (financial_bs_data.json)</div>
          <div style={{background:`${C.accent}10`,border:`1px solid ${C.accent}30`,borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:11,color:C.accent}}>
            Correction policy: Do NOT modify audited amounts. If a line maps to the wrong FP&A category, correct the mapping only (action: correct_mapping).
          </div>
          <div style={{overflowX:'auto',marginBottom:12}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{background:C.surfEl}}>
                <th style={{padding:'7px 10px',textAlign:'left',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase'}}>Category</th>
                <th style={{padding:'7px 10px',textAlign:'left',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase'}}>Field</th>
                <th style={{padding:'7px 10px',textAlign:'right',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase'}}>Amount (₹L)</th>
                <th style={{padding:'7px 10px',textAlign:'left',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase'}}>Approval</th>
                <th style={{padding:'7px 10px',textAlign:'left',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase'}}>Actions</th>
              </tr></thead>
              <tbody>
                {(data.lines || []).map(ln => (
                  <tr key={ln.key} style={{borderBottom:`1px solid ${C.border}`}}>
                    <td style={{padding:'6px 10px',color:C.textMut,fontSize:11}}>{ln.category}</td>
                    <td style={{padding:'6px 10px',color:C.text,fontWeight:600,fontSize:12}}>{ln.field.replace(/_/g,' ')}</td>
                    <td style={{padding:'6px 10px',textAlign:'right',fontFamily:'monospace',color:ln.amount_lakhs<0?C.red:C.text}}>{fmtL(ln.amount_lakhs)}</td>
                    <td style={{padding:'6px 10px'}}><S8Badge status={ln.approval_status}>{ln.approval_status}</S8Badge></td>
                    <td style={{padding:'6px 10px',display:'flex',gap:4}}>
                      <button onClick={() => action('/obs-review', { action:'approve_line', line_key:ln.key }, 'PUT')} style={{padding:'2px 8px',fontSize:10,borderRadius:4,border:`1px solid ${C.green}40`,background:`${C.green}12`,color:C.green,cursor:'pointer'}}>Approve</button>
                      <button onClick={() => action('/obs-review', { action:'reject_line', line_key:ln.key }, 'PUT')} style={{padding:'2px 8px',fontSize:10,borderRadius:4,border:`1px solid ${C.red}40`,background:`${C.red}12`,color:C.red,cursor:'pointer'}}>Reject</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 10px',background:C.surfEl,borderRadius:6}}>
            <div style={{fontSize:13,fontWeight:700,color:C.text}}>
              Total Assets: {fmtL(data.total_assets)} &nbsp;|&nbsp; Total E+L: {fmtL(data.total_el)} &nbsp;|&nbsp; <span style={{color:data.bs_check_pass?C.green:C.red}}>Diff: {fmtL(data.bs_check_diff)}</span>
            </div>
            {data.approval_status !== 'approved' && (
              <button onClick={() => action('/obs-review', { action:'approve_all', approved_by:'reviewer' }, 'PUT')} style={{padding:'6px 16px',borderRadius:6,border:'none',background:C.green,color:'#fff',cursor:'pointer',fontWeight:700,fontSize:12}}>Approve Entire OBS</button>
            )}
            {data.approval_status === 'approved' && <S8Badge status="approved">APPROVED</S8Badge>}
          </div>
        </div>
      )}

      {/* DEBT CLOSURE */}
      {view === 'debt' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <h3 style={{color:C.text,margin:0}}>Debt Schedule Closure</h3>
            <S8Badge status={data.summary?.complete === 7 ? 'approved' : 'in_progress'}>{data.summary?.complete||0}/7 Complete</S8Badge>
          </div>
          <div style={{background:`${C.orange}12`,border:`1px solid ${C.orange}30`,borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:11,color:C.orange}}>
            7 facilities auto-identified from audited BS Note 19/22. Opening balances populated. Interest rates and repayment schedules still required.
            <br/>Download template → complete in Excel → import via API or paste JSON.
          </div>
          <a href="/api/fpa/step8/debt-template" download style={{display:'inline-block',marginBottom:12,padding:'6px 14px',borderRadius:6,border:`1px solid ${C.cyan}40`,background:`${C.cyan}12`,color:C.cyan,fontSize:12,textDecoration:'none',fontWeight:600}}>⬇ Download Debt Schedule Template (CSV)</a>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{background:C.surfEl}}>
                {['ID','Facility','Type','Opening (₹L)','Rate','Maturity','Status','Completeness'].map(h => <th key={h} style={{padding:'7px 10px',textAlign:'left',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {(data.facilities||[]).map(f => (
                  <tr key={f.id} style={{borderBottom:`1px solid ${C.border}`}}>
                    <td style={{padding:'6px 10px',fontFamily:'monospace',color:C.cyan,fontSize:11}}>{f.id}</td>
                    <td style={{padding:'6px 10px',color:C.text,fontWeight:600,fontSize:12}}>{f.facility_name||f.id}</td>
                    <td style={{padding:'6px 10px',color:C.textSec,fontSize:11}}>{f.type||'—'}</td>
                    <td style={{padding:'6px 10px',textAlign:'right',fontFamily:'monospace'}}>{fmtL(f.opening_principal)}</td>
                    <td style={{padding:'6px 10px',color:f.interest_rate?C.text:C.red}}>{f.interest_rate ? `${f.interest_rate}% ${f.interest_type||''}` : <S8Badge status="fail">REQUIRED</S8Badge>}</td>
                    <td style={{padding:'6px 10px',color:C.textSec,fontSize:11}}>{f.maturity_date||<S8Badge status="pending">REQUIRED</S8Badge>}</td>
                    <td style={{padding:'6px 10px'}}><S8Badge status={f.completeness===100?'approved':f.completeness>50?'in_progress':'fail'}>{f.completeness||0}%</S8Badge></td>
                    <td style={{padding:'6px 10px',width:120}}>
                      <div style={{display:'flex',alignItems:'center',gap:6}}>
                        <div style={{background:C.surfEl,borderRadius:3,height:6,flex:1,overflow:'hidden'}}><div style={{width:`${f.completeness||0}%`,height:'100%',background:f.completeness===100?C.green:C.orange}}/></div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* IND AS 116 LEASE */}
      {view === 'lease' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <h3 style={{color:C.text,margin:0}}>Ind AS 116 Lease Schedule</h3>
            <S8Badge status={data.status}>{data.status}</S8Badge>
            <span style={{fontSize:11,color:C.textSec}}>{data.total||0} leases · {data.complete||0} complete</span>
          </div>
          {data.status === 'requires_data' && (
            <div style={{background:`${C.red}12`,border:`1px solid ${C.red}30`,borderRadius:6,padding:'10px 14px',marginBottom:12,fontSize:12}}>
              <div style={{color:C.red,fontWeight:700,marginBottom:6}}>⛔ BLOCKED — REQUIRES DATA</div>
              <p style={{color:C.textSec,margin:0}}>Per-lease Ind AS 116 detail is not available in any existing project file. Required fields:</p>
              <ul style={{color:C.textSec,margin:'6px 0 0',paddingLeft:20,fontSize:11}}>
                <li>Commencement Date · Expiry Date · Lease Term</li>
                <li>Monthly Lease Payment · Escalation % · Discount Rate</li>
                <li>Opening Lease Liability · Opening ROU Asset</li>
                <li>Current / Non-current portion of liability</li>
              </ul>
              <p style={{color:C.orange,margin:'8px 0 0',fontSize:11}}>Source: Lease agreements or auditor Ind AS 116 workings. Download template below.</p>
            </div>
          )}
          <a href="/api/fpa/step8/lease-template" download style={{display:'inline-block',marginBottom:12,padding:'6px 14px',borderRadius:6,border:`1px solid ${C.cyan}40`,background:`${C.cyan}12`,color:C.cyan,fontSize:12,textDecoration:'none',fontWeight:600}}>⬇ Download Ind AS 116 Lease Template (CSV)</a>
          {data.leases?.length > 0 && (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead><tr style={{background:C.surfEl}}>
                  {['Lease ID','Branch','Lessor','Commencement','Expiry','Monthly Pmt (₹L)','Disc Rate','Opening Liab (₹L)','Opening ROU (₹L)','Completeness'].map(h => <th key={h} style={{padding:'6px 8px',textAlign:'left',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {data.leases.map(l => (
                    <tr key={l.lease_id} style={{borderBottom:`1px solid ${C.border}`}}>
                      <td style={{padding:'5px 8px',fontFamily:'monospace',color:C.cyan,fontSize:11}}>{l.lease_id}</td>
                      <td style={{padding:'5px 8px',color:C.text}}>{l.branch}</td>
                      <td style={{padding:'5px 8px',color:C.textSec}}>{l.lessor||'—'}</td>
                      <td style={{padding:'5px 8px',color:C.textSec,fontSize:11}}>{l.commencement_date||<S8Badge status="fail">REQ</S8Badge>}</td>
                      <td style={{padding:'5px 8px',color:C.textSec,fontSize:11}}>{l.expiry_date||'—'}</td>
                      <td style={{padding:'5px 8px',textAlign:'right',fontFamily:'monospace'}}>{fmtL(l.monthly_payment)}</td>
                      <td style={{padding:'5px 8px',color:l.discount_rate?C.text:C.red}}>{l.discount_rate ? `${l.discount_rate}%` : <S8Badge status="fail">REQ</S8Badge>}</td>
                      <td style={{padding:'5px 8px',textAlign:'right',fontFamily:'monospace'}}>{fmtL(l.opening_liability)}</td>
                      <td style={{padding:'5px 8px',textAlign:'right',fontFamily:'monospace'}}>{fmtL(l.opening_rou)}</td>
                      <td style={{padding:'5px 8px'}}><S8Badge status={l.completeness===100?'approved':'in_progress'}>{l.completeness||0}%</S8Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* FIXED ASSET REGISTER */}
      {view === 'far' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <h3 style={{color:C.text,margin:0}}>Fixed Asset Register</h3>
            <S8Badge status={data.status}>{data.status}</S8Badge>
            <span style={{fontSize:11,color:C.textSec}}>{data.total||0} assets</span>
          </div>
          {data.status === 'requires_data' && (
            <div style={{background:`${C.red}12`,border:`1px solid ${C.red}30`,borderRadius:6,padding:'10px 14px',marginBottom:12,fontSize:12}}>
              <div style={{color:C.red,fontWeight:700,marginBottom:6}}>⛔ BLOCKED — REQUIRES DATA</div>
              <p style={{color:C.textSec,margin:0}}>Per-asset Fixed Asset Register is not available in any existing project file.</p>
              <p style={{color:C.orange,margin:'6px 0 0',fontSize:11}}>Source: Accounting team or auditor FAR. Aggregate PPE (₹6,454.27L from audited BS) is the reconciliation target — do NOT fabricate assets from it.</p>
            </div>
          )}
          {data.reconciliation_diff != null && (
            <div style={{display:'flex',gap:12,marginBottom:12,flexWrap:'wrap'}}>
              <div style={{background:C.surfEl,borderRadius:6,padding:'10px 14px',flex:1,minWidth:160}}>
                <div style={{fontSize:10,color:C.textMut,textTransform:'uppercase',marginBottom:4}}>FAR Closing NBV</div>
                <div style={{fontSize:16,fontWeight:700,color:C.text}}>{fmtL(data.far_nbv_lakhs)}</div>
              </div>
              <div style={{background:C.surfEl,borderRadius:6,padding:'10px 14px',flex:1,minWidth:160}}>
                <div style={{fontSize:10,color:C.textMut,textTransform:'uppercase',marginBottom:4}}>Audited PPE (BS)</div>
                <div style={{fontSize:16,fontWeight:700,color:C.cyan}}>{fmtL(data.audited_ppe_lakhs)}</div>
              </div>
              <div style={{background:C.surfEl,borderRadius:6,padding:'10px 14px',flex:1,minWidth:160}}>
                <div style={{fontSize:10,color:C.textMut,textTransform:'uppercase',marginBottom:4}}>Reconciliation Diff</div>
                <div style={{fontSize:16,fontWeight:700,color:data.reconciliation_status==='pass'?C.green:C.red}}>{fmtL(data.reconciliation_diff)}</div>
                <S8Badge status={data.reconciliation_status}>{data.reconciliation_status}</S8Badge>
              </div>
            </div>
          )}
          <a href="/api/fpa/step8/far-template" download style={{display:'inline-block',marginBottom:12,padding:'6px 14px',borderRadius:6,border:`1px solid ${C.cyan}40`,background:`${C.cyan}12`,color:C.cyan,fontSize:12,textDecoration:'none',fontWeight:600}}>⬇ Download Fixed Asset Register Template (CSV)</a>
        </div>
      )}

      {/* ZOHO SYNC */}
      {view === 'zoho' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <h3 style={{color:C.text,margin:0}}>Zoho Revenue Sync</h3>
            <S8Badge status={data.status}>{data.status}</S8Badge>
            {data.last_sync && <span style={{fontSize:11,color:C.textMut}}>Last: {data.last_sync}</span>}
          </div>
          <div style={{background:`${C.accent}10`,border:`1px solid ${C.accent}30`,borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:11,color:C.accent}}>
            Uses existing Step-3 Zoho infrastructure. Does not create a new integration. GST excluded from revenue per requirements.
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:8,marginBottom:16}}>
            {[
              ['Invoice Count', data.invoice_count, C.text],
              ['Credit Notes', data.credit_note_count, C.text],
              ['Gross Revenue', fmtL(data.gross_amount_lakhs), C.text],
              ['GST Excluded', fmtL(data.gst_excluded_lakhs), C.orange],
              ['Credit Notes Amt', fmtL(data.credit_notes_lakhs), C.orange],
              ['Net Revenue', fmtL(data.net_revenue_lakhs), C.green],
              ['Unmapped Invoices', data.unmapped_invoices, data.unmapped_invoices>0?C.red:C.green],
            ].map(([lbl,val,col]) => (
              <div key={lbl} style={{background:C.surfEl,borderRadius:6,padding:'10px 14px'}}>
                <div style={{fontSize:10,color:C.textMut,textTransform:'uppercase',marginBottom:4,letterSpacing:'.4px'}}>{lbl}</div>
                <div style={{fontSize:15,fontWeight:700,color:col}}>{val==null?'—':val}</div>
              </div>
            ))}
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={() => action('/zoho-sync', { type:'incremental' })} style={{padding:'7px 16px',borderRadius:6,border:'none',background:C.accent,color:'#fff',cursor:'pointer',fontWeight:600,fontSize:12}}>▶ Incremental Sync</button>
            <button onClick={() => action('/zoho-sync', { type:'full' })} style={{padding:'7px 16px',borderRadius:6,border:`1px solid ${C.border}`,background:C.surfEl,color:C.text,cursor:'pointer',fontSize:12}}>Full Resync</button>
          </div>
          {data.note && <div style={{marginTop:10,fontSize:11,color:C.textMut}}>{data.note}</div>}
        </div>
      )}

      {/* UTILITIES DECISION */}
      {view === 'utilities' && (
        <div>
          <h3 style={{color:C.text,marginBottom:12}}>Utilities Fixed / Variable Decision</h3>
          <S8UtilitiesDecision data={data} onSave={(body) => action('/utilities-decision', body, 'PUT')} />
        </div>
      )}

      {/* GL MAPPING REVIEW */}
      {view === 'gl_mapping' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12,flexWrap:'wrap'}}>
            <h3 style={{color:C.text,margin:0}}>GL Mapping Review Queue</h3>
            <S8Badge status={data.review_required===0?'approved':'pending'}>{data.review_required||0} pending review</S8Badge>
            <span style={{fontSize:11,color:C.textSec}}>{data.approved||0} approved · {data.not_applicable||0} N/A</span>
          </div>
          {data.material_unmapped > 0 && (
            <div style={{background:`${C.red}12`,border:`1px solid ${C.red}30`,borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:11,color:C.red}}>
              ⛔ Material unmapped balance: {fmtL(data.material_unmapped)} — RC-F15 will fail until all material GL is reviewed.
            </div>
          )}
          <div style={{background:`${C.accent}10`,border:`1px solid ${C.accent}30`,borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:11,color:C.accent}}>
            Target: Material Unmapped GL = ₹0. Small immaterial items may remain only where explicitly approved as Not Applicable.
          </div>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{background:C.surfEl}}>
                {['Account ID','Account Name','Type','FP&A Line','Statement','CF Line','Balance (₹L)','Status','Actions'].map(h => <th key={h} style={{padding:'6px 8px',textAlign:'left',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {(data.queue||[]).slice(0,50).map(m => (
                  <tr key={m.account_id||m.grouping} style={{borderBottom:`1px solid ${C.border}`}}>
                    <td style={{padding:'5px 8px',fontFamily:'monospace',color:C.cyan,fontSize:10}}>{m.account_id||m.grouping}</td>
                    <td style={{padding:'5px 8px',color:C.text,fontSize:11}}>{m.account_name||m.grouping}</td>
                    <td style={{padding:'5px 8px',color:C.textSec,fontSize:10}}>{m.account_type||'—'}</td>
                    <td style={{padding:'5px 8px',color:C.text,fontSize:11}}>{m.fpa_line||<span style={{color:C.red}}>—</span>}</td>
                    <td style={{padding:'5px 8px',color:C.textSec,fontSize:10}}>{m.fpa_statement||'—'}</td>
                    <td style={{padding:'5px 8px',color:C.textSec,fontSize:10}}>{m.cash_flow_line||'—'}</td>
                    <td style={{padding:'5px 8px',textAlign:'right',fontFamily:'monospace',fontSize:11}}>{fmtL(m.balance_lakhs)}</td>
                    <td style={{padding:'5px 8px'}}><S8Badge status={m.status}>{m.status}</S8Badge></td>
                    <td style={{padding:'5px 8px',display:'flex',gap:3}}>
                      <button onClick={() => action(`/gl-mapping-queue/${m.account_id||m.grouping}`, { action:'approve' }, 'PUT')} style={{padding:'2px 6px',fontSize:9,borderRadius:3,border:`1px solid ${C.green}40`,background:`${C.green}12`,color:C.green,cursor:'pointer'}}>✓</button>
                      <button onClick={() => action(`/gl-mapping-queue/${m.account_id||m.grouping}`, { action:'not_applicable' }, 'PUT')} style={{padding:'2px 6px',fontSize:9,borderRadius:3,border:`1px solid ${C.textMut}40`,background:C.surfEl,color:C.textSec,cursor:'pointer'}}>N/A</button>
                    </td>
                  </tr>
                ))}
                {(data.queue||[]).length > 50 && <tr><td colSpan={9} style={{padding:'8px 10px',color:C.textMut,fontSize:11}}>…and {data.queue.length-50} more. Use API to review in bulk.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TB RECONCILIATION */}
      {view === 'tb_recon' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <h3 style={{color:C.text,margin:0}}>Trial Balance Reconciliation</h3>
            <S8Badge status={data.pass?'pass':'fail'}>{data.pass?'PASS':'FAIL'}</S8Badge>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:8,marginBottom:16}}>
            {[
              ['Total Accounting Balance', fmtL(data.total_accounting_balance_lakhs), C.text],
              ['Mapped FP&A Balance', fmtL(data.mapped_fpa_balance_lakhs), C.green],
              ['Not Applicable', fmtL(data.not_applicable_lakhs), C.textSec],
              ['Unmapped', fmtL(data.unmapped_balance_lakhs), data.unmapped_balance_lakhs>0?C.red:C.green],
              ['Difference', fmtL(data.difference_lakhs), Math.abs(data.difference_lakhs||0)<1?C.green:C.red],
              ['Difference %', data.difference_pct ? `${data.difference_pct}%` : '—', Math.abs(parseFloat(data.difference_pct||0))<2?C.green:C.red],
            ].map(([l,v,c]) => <div key={l} style={{background:C.surfEl,borderRadius:6,padding:'10px 14px'}}><div style={{fontSize:10,color:C.textMut,textTransform:'uppercase',marginBottom:4}}>{l}</div><div style={{fontSize:14,fontWeight:700,color:c}}>{v}</div></div>)}
          </div>
        </div>
      )}

      {/* COMPUTE */}
      {view === 'compute' && data && (
        <div>
          <h3 style={{color:C.text,marginBottom:12}}>Integrated Compute</h3>
          <div style={{background:`${C.accent}10`,border:`1px solid ${C.accent}30`,borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:11,color:C.accent}}>
            Computes P&L → EBITDA → PBT → PAT → Balance Sheet → Cash Bridge for all months. Requires Opening BS to be approved.
          </div>
          <div style={{background:C.surfEl,borderRadius:8,padding:'14px 18px',marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <div style={{fontSize:10,color:C.textMut,textTransform:'uppercase',marginBottom:4}}>Compute Status</div>
                <S8Badge status={data.compute?.status||'not_run'}>{data.compute?.status||'not_run'}</S8Badge>
                {data.compute?.last_run && <span style={{fontSize:11,color:C.textMut,marginLeft:8}}>Last run: {data.compute.last_run}</span>}
              </div>
              <button onClick={() => action('/compute', {})} disabled={busy} style={{padding:'8px 20px',borderRadius:6,border:'none',background:C.accent,color:'#fff',cursor:'pointer',fontWeight:700,fontSize:13}}>▶ Run Compute</button>
            </div>
          </div>
          {data.compute?.errors?.length > 0 && (
            <div style={{background:`${C.red}12`,border:`1px solid ${C.red}30`,borderRadius:6,padding:'10px 14px',marginBottom:12}}>
              <div style={{color:C.red,fontWeight:700,marginBottom:8,fontSize:12}}>Compute Errors</div>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                <thead><tr>{['Module','Missing Field','Missing Source','Blocking'].map(h => <th key={h} style={{textAlign:'left',padding:'4px 8px',color:C.textSec,fontSize:9,textTransform:'uppercase'}}>{h}</th>)}</tr></thead>
                <tbody>{data.compute.errors.map((e,i) => <tr key={i}><td style={{padding:'4px 8px',color:C.text}}>{e.module||'—'}</td><td style={{padding:'4px 8px',color:C.red}}>{e.missing||e.error||'—'}</td><td style={{padding:'4px 8px',color:C.textSec}}>{e.required||'—'}</td><td style={{padding:'4px 8px'}}><S8Badge status={e.blocking?'fail':'pending'}>{e.blocking?'Blocking':'Non-blocking'}</S8Badge></td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* RC CONTROLS */}
      {view === 'rc' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <h3 style={{color:C.text,margin:0}}>RC-F01 to RC-F15</h3>
            <S8Badge status={data.all_pass?'pass':'fail'}>{data.all_pass?'ALL PASS':`${(data.controls||[]).filter(c=>!c.pass).length} FAILING`}</S8Badge>
          </div>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{background:C.surfEl}}>
                {['Control','Description','Status','Blocker'].map(h => <th key={h} style={{padding:'7px 10px',textAlign:'left',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase'}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {(data.controls||[]).map(c => (
                  <tr key={c.id} style={{borderBottom:`1px solid ${C.border}`}}>
                    <td style={{padding:'6px 10px',fontFamily:'monospace',color:C.cyan,fontSize:11}}>{c.id}</td>
                    <td style={{padding:'6px 10px',color:C.text,fontSize:12}}>{c.description}</td>
                    <td style={{padding:'6px 10px'}}><S8Badge status={c.pass?'pass':'fail'}>{c.pass?'PASS':'FAIL'}</S8Badge></td>
                    <td style={{padding:'6px 10px',color:C.orange,fontSize:11}}>{c.blocker||'—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ACCEPTANCE TESTS */}
      {view === 'at' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <h3 style={{color:C.text,margin:0}}>50 Acceptance Tests</h3>
            <span style={{fontSize:11,color:C.textSec}}>
              {(data.tests||[]).filter(t=>t.status==='pass').length} pass · {(data.tests||[]).filter(t=>t.status==='blocked').length} blocked · {(data.tests||[]).filter(t=>t.status==='fail').length} fail
            </span>
          </div>
          {['Opening BS','Debt','Lease','FAR','Working Capital','GL Mapping','Three Statements','Prior Steps (Step 4)','Migration Gate'].map(grp => {
            const tests = (data.tests||[]).filter(t => t.group === grp);
            if (!tests.length) return null;
            return (
              <div key={grp} style={{marginBottom:14}}>
                <div style={{fontSize:11,fontWeight:700,color:C.textSec,textTransform:'uppercase',letterSpacing:'.5px',marginBottom:6}}>{grp} ({tests.filter(t=>t.status==='pass').length}/{tests.length})</div>
                {tests.map(t => (
                  <div key={t.id} style={{display:'flex',alignItems:'center',gap:8,padding:'5px 8px',borderRadius:5,marginBottom:3,background:C.surfEl}}>
                    <span style={{fontFamily:'monospace',fontSize:10,color:C.cyan,width:70,flexShrink:0}}>{t.id}</span>
                    <span style={{flex:1,fontSize:11,color:C.textSec}}>{t.description}</span>
                    <S8Badge status={t.status}>{t.status}</S8Badge>
                    {t.status==='pass' && <span style={{fontSize:10,color:C.textMut,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.evidence}</span>}
                    {t.status!=='pass' && t.evidence && <span style={{fontSize:10,color:C.orange,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.evidence}</span>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* FINAL UAT */}
      {view === 'uat' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
            <h3 style={{color:C.text,margin:0}}>Final UAT — 12 Tests</h3>
            <S8Badge status={Object.values(data.uat_results||{}).every(u=>u.status==='pass')?'approved':'pending'}>
              {Object.values(data.uat_results||{}).filter(u=>u.status==='pass').length}/12 Pass
            </S8Badge>
          </div>
          <div style={{background:`${C.accent}10`,border:`1px solid ${C.accent}30`,borderRadius:6,padding:'8px 12px',marginBottom:12,fontSize:11,color:C.accent}}>
            UAT tests require manual tester execution. Record results via the Pass/Fail buttons. Note any exception if a test fails.
          </div>
          {Object.entries(data.uat_results||{}).map(([id,uat]) => (
            <div key={id} style={{background:C.surfEl,borderRadius:7,padding:'12px 14px',marginBottom:8,borderLeft:`3px solid ${uat.status==='pass'?C.green:uat.status==='fail'?C.red:C.border}`}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8}}>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                    <span style={{fontFamily:'monospace',fontSize:11,color:C.cyan,fontWeight:700}}>{id}</span>
                    <S8Badge status={uat.status}>{uat.status}</S8Badge>
                  </div>
                  <div style={{fontSize:12,color:C.textSec}}>{uat.description}</div>
                  {uat.result && <div style={{fontSize:11,color:uat.status==='pass'?C.green:C.orange,marginTop:4}}>{uat.result}</div>}
                  {uat.exception && <div style={{fontSize:11,color:C.red,marginTop:4}}>Exception: {uat.exception}</div>}
                  {uat.run_at && <div style={{fontSize:10,color:C.textMut,marginTop:4}}>Run at: {uat.run_at}</div>}
                </div>
                <div style={{display:'flex',gap:4,flexShrink:0}}>
                  <button onClick={() => action(`/uat/${id}`, { status:'pass', result:'Test passed by tester', evidence:'Manual UAT execution' }, 'PUT')} style={{padding:'4px 10px',fontSize:11,borderRadius:4,border:`1px solid ${C.green}40`,background:`${C.green}12`,color:C.green,cursor:'pointer',fontWeight:600}}>✓ Pass</button>
                  <button onClick={() => action(`/uat/${id}`, { status:'fail', result:'Test failed — see exception' }, 'PUT')} style={{padding:'4px 10px',fontSize:11,borderRadius:4,border:`1px solid ${C.red}40`,background:`${C.red}12`,color:C.red,cursor:'pointer',fontWeight:600}}>✗ Fail</button>
                  {id === 'UAT-10' && <button onClick={() => action(`/run-uat/${id}`, {})} style={{padding:'4px 10px',fontSize:11,borderRadius:4,border:`1px solid ${C.accent}40`,background:`${C.accent}12`,color:C.accent,cursor:'pointer',fontWeight:600}}>▶ Auto</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* DATA COMPLETENESS SCORECARD */}
      {view === 'scorecard' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}>
            <h3 style={{color:C.text,margin:0}}>Data Completeness Scorecard</h3>
            <div style={{fontFamily:'monospace',fontSize:22,fontWeight:700,color:data.overall_pct>=80?C.green:data.overall_pct>=50?C.yellow:C.red}}>{data.overall_pct||0}%</div>
          </div>
          {(data.dimensions||[]).map(d => (
            <div key={d.dimension} style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
              <div style={{width:180,fontSize:12,color:C.textSec,flexShrink:0}}>{d.dimension}</div>
              <div style={{flex:1,display:'flex',alignItems:'center',gap:8}}>
                <div style={{background:C.surfEl,borderRadius:4,height:10,flex:1,overflow:'hidden'}}><div style={{width:`${d.pct}%`,height:'100%',background:d.pct>=100?C.green:d.pct>=60?C.yellow:C.red,transition:'width .3s'}}/></div>
                <span style={{fontFamily:'monospace',fontSize:12,width:40,textAlign:'right',color:d.pct>=100?C.green:d.pct>=60?C.yellow:C.red}}>{d.pct}%</span>
                <span style={{fontFamily:'monospace',fontSize:11,color:C.textMut,width:60}}>{d.complete}/{d.total}</span>
              </div>
              <span style={{fontSize:11,color:C.textMut,width:200,textOverflow:'ellipsis',overflow:'hidden',whiteSpace:'nowrap'}}>{d.note}</span>
            </div>
          ))}
        </div>
      )}

      {/* OPEN ITEMS CLOSURE */}
      {view === 'open_items' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12,flexWrap:'wrap'}}>
            <h3 style={{color:C.text,margin:0}}>Open Items Closure Report</h3>
            <S8Badge status="approved">{data.summary?.resolved||0} Resolved</S8Badge>
            <S8Badge status="fail">{data.summary?.critical_blocking||0} Critical Blockers</S8Badge>
            <S8Badge status="pending">{data.summary?.open||0} Open</S8Badge>
          </div>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{background:C.surfEl}}>
                {['ID','Title','Original','Resolution','Final Status','Blocking'].map(h => <th key={h} style={{padding:'7px 10px',textAlign:'left',color:C.textSec,borderBottom:`1px solid ${C.border}`,fontSize:10,textTransform:'uppercase'}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {(data.items||[]).map(oi => (
                  <tr key={oi.id} style={{borderBottom:`1px solid ${C.border}`}}>
                    <td style={{padding:'6px 10px',fontFamily:'monospace',color:C.cyan,fontSize:11,whiteSpace:'nowrap'}}>{oi.id}</td>
                    <td style={{padding:'6px 10px',color:C.text,fontWeight:600,fontSize:12}}>{oi.title}</td>
                    <td style={{padding:'6px 10px'}}><S8Badge status={oi.original_status}>{oi.original_status}</S8Badge></td>
                    <td style={{padding:'6px 10px',color:C.textSec,fontSize:11,maxWidth:220}}>{oi.resolution}</td>
                    <td style={{padding:'6px 10px'}}><S8Badge status={oi.final_status}>{oi.final_status}</S8Badge></td>
                    <td style={{padding:'6px 10px',textAlign:'center',fontSize:12,color:oi.migration_blocking?C.red:C.green}}>{oi.migration_blocking?'⛔ YES':'—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MIGRATION GATE */}
      {view === 'gate' && data && (
        <div>
          <div style={{display:'flex',alignItems:'center',gap:16,marginBottom:16,flexWrap:'wrap'}}>
            <h3 style={{color:C.text,margin:0}}>Final Migration Gate</h3>
            <div style={{padding:'10px 24px',borderRadius:8,border:`2px solid ${S8_GATE_COLOR[data.gate]||C.red}`,background:`${S8_GATE_COLOR[data.gate]||C.red}15`,fontWeight:700,fontSize:16,color:S8_GATE_COLOR[data.gate]||C.red}}>
              {data.gate === 'ready' ? '✅ READY FOR MIGRATION' : data.gate === 'ready_with_conditions' ? '⚠ READY WITH CONDITIONS' : '⛔ NOT READY FOR MIGRATION'}
            </div>
          </div>
          <div style={{background:`${C.orange}12`,border:`1px solid ${C.orange}30`,borderRadius:6,padding:'10px 14px',marginBottom:16,fontSize:12,color:C.orange,fontWeight:600}}>
            ⚠ Even if gate = READY FOR MIGRATION — DO NOT MIGRATE. Publish report and STOP. Wait for explicit approval in Step 9.
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:8}}>
            {Object.entries(data.criteria||{}).map(([k,c]) => (
              <div key={k} style={{background:C.surfEl,borderRadius:7,padding:'12px 14px',borderLeft:`3px solid ${c.pass?C.green:c.blocking?C.red:C.yellow}`}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                  <span style={{fontSize:12,color:C.text,fontWeight:600}}>{c.label}</span>
                  <S8Badge status={c.pass?'pass':c.blocking?'fail':'pending'}>{c.pass?'PASS':'FAIL'}</S8Badge>
                </div>
                {!c.pass && c.blocking && <div style={{fontSize:10,color:C.red,marginTop:4,fontWeight:700}}>⛔ MIGRATION BLOCKER</div>}
              </div>
            ))}
          </div>
          <div style={{marginTop:16,display:'flex',gap:8}}>
            <button onClick={() => load('gate')} style={{padding:'6px 14px',borderRadius:6,border:`1px solid ${C.border}`,background:C.surfEl,color:C.text,cursor:'pointer',fontSize:12}}>Recalculate Gate</button>
          </div>
        </div>
      )}
    </div>
  );
}

function S8UtilitiesDecision({ data, onSave }) {
  const [option, setOption] = useState(data?.option || '');
  const [fixed, setFixed]   = useState(data?.fixed_pct ?? '');
  const [variable, setVariable] = useState(data?.variable_pct ?? '');

  const OPTIONS = [
    { id:'option1', label:'Option 1 — Fully Fixed', desc:'100% Fixed / 0% Variable', fixedPct:100, varPct:0 },
    { id:'option2', label:'Option 2 — Fully Variable', desc:'0% Fixed / 100% Variable', fixedPct:0, varPct:100 },
    { id:'option3', label:'Option 3 — Management Split', desc:'Enter fixed % and variable % (must sum to 100%)', fixedPct:null, varPct:null },
    { id:'option4', label:'Option 4 — Historical Driver-Based', desc:'Only if sufficient actual historical data exists', fixedPct:null, varPct:null },
  ];

  const handleSelect = (id, fp, vp) => {
    setOption(id);
    if (fp != null) { setFixed(fp); setVariable(vp); }
  };

  return (
    <div>
      <div style={{background:`${C.accent}10`,border:`1px solid ${C.accent}30`,borderRadius:6,padding:'8px 12px',marginBottom:16,fontSize:11,color:C.accent}}>
        This is a management decision. Do not approximate. Until approved, total P&L still runs but break-even / scenario analytics show LIMITED.
      </div>
      {data?.status === 'approved' && (
        <div style={{background:`${C.green}12`,border:`1px solid ${C.green}30`,borderRadius:6,padding:'10px 14px',marginBottom:12,fontSize:12,color:C.green,fontWeight:700}}>
          ✓ Utilities decision approved: {data.option} &nbsp;|&nbsp; Fixed: {data.fixed_pct}% / Variable: {data.variable_pct}%
        </div>
      )}
      <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:16}}>
        {OPTIONS.map(o => (
          <div key={o.id} onClick={() => handleSelect(o.id, o.fixedPct, o.varPct)}
            style={{background:option===o.id?`${C.accent}18`:C.surfEl,border:`1px solid ${option===o.id?C.accent:C.border}`,borderRadius:8,padding:'12px 16px',cursor:'pointer'}}>
            <div style={{fontWeight:700,fontSize:13,color:option===o.id?C.accent:C.text}}>{o.label}</div>
            <div style={{fontSize:11,color:C.textSec,marginTop:3}}>{o.desc}</div>
            {o.id === 'option3' && option === 'option3' && (
              <div style={{display:'flex',gap:12,marginTop:10}} onClick={e => e.stopPropagation()}>
                <div><label style={{fontSize:11,color:C.textSec}}>Fixed %</label><br/>
                  <input type="number" value={fixed} onChange={e=>setFixed(e.target.value)} min={0} max={100} style={{marginTop:3,padding:'4px 8px',borderRadius:5,border:`1px solid ${C.border}`,background:C.bg,color:C.text,width:80,fontSize:13}}/></div>
                <div><label style={{fontSize:11,color:C.textSec}}>Variable %</label><br/>
                  <input type="number" value={variable} onChange={e=>setVariable(e.target.value)} min={0} max={100} style={{marginTop:3,padding:'4px 8px',borderRadius:5,border:`1px solid ${C.border}`,background:C.bg,color:C.text,width:80,fontSize:13}}/></div>
                {(parseFloat(fixed||0)+parseFloat(variable||0))!==100 && <div style={{alignSelf:'flex-end',fontSize:11,color:C.red,paddingBottom:6}}>Must sum to 100%</div>}
              </div>
            )}
          </div>
        ))}
      </div>
      <button onClick={() => onSave({ option, fixed_pct: parseFloat(fixed)||null, variable_pct: parseFloat(variable)||null })}
        disabled={!option || (option==='option3' && (parseFloat(fixed||0)+parseFloat(variable||0))!==100)}
        style={{padding:'7px 20px',borderRadius:6,border:'none',background:C.accent,color:'#fff',cursor:'pointer',fontWeight:700,fontSize:13}}>
        Approve Utilities Decision
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
export default function FPADashboard() {
  const [tab, setTab]         = useState('branch');
  const [summary, setSummary] = useState(null);
  const [branches, setBranches] = useState([]);
  const [clients, setClients]   = useState([]);
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading]   = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sum, br, cl, mp] = await Promise.all([
        apiFetch('/api/fpa/summary'),
        apiFetch('/api/fpa/branch-master'),
        apiFetch('/api/fpa/client-master'),
        apiFetch('/api/fpa/mapping'),
      ]);
      setSummary(sum);
      setBranches(br.branches || []);
      setClients(cl.clients || []);
      setMappings(mp.mappings || []);
    } catch (e) { console.error('FPA load error:', e); }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const tabs = [
    { id: 'branch',     label: 'Branch Master' },
    { id: 'client',     label: 'Client Master' },
    { id: 'mapping',    label: 'Branch–Client Mapping' },
    { id: 'occupancy',  label: 'Occupancy' },
    { id: 'global',     label: 'Global Assumptions' },
    { id: 'validation', label: 'Validation' },
    { id: 'revenue',    label: '⚡ Actual Revenue' },
    { id: 'projection',    label: '📈 Revenue Projection' },
    { id: 'profitability', label: '💰 Branch Profitability' },
    { id: 'integrated',   label: '📊 Integrated Financials' },
    { id: 'step8',        label: '🚀 Step 8 UAT' },
    { id: 'mgmt_inputs',  label: '⚙ Management Inputs' },
    { id: 'step15',       label: '🏗 Step 15 — Data Completion' },
  ];

  const valColor = summary?.validation?.status === 'pass' ? C.green : summary?.validation?.status === 'warn' ? C.yellow : C.red;

  return (
    <div style={{ padding: '1.5rem 2rem', minHeight: '100vh', background: C.bg }}>
      {/* Header */}
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <h1 style={{ color: C.text, fontSize: '1.2rem', fontWeight: 700, margin: 0 }}>FP&amp;A — Financial Model</h1>
              {pill(C.yellow, 'STEP 2')}
              {pill(C.cyan, 'STEP 3')}
              {pill(C.purple, 'ZOHO ACTUALS')}
              {pill(C.orange, 'STEP 4')}
              {pill(C.green, 'PROJECTION ENGINE')}
              {pill(C.red, 'STEP 5')}
              {pill(C.yellow, 'BRANCH ECONOMICS')}
              {pill(C.cyan, 'STEP 6')}
              {pill(C.green, 'INTEGRATED MODEL')}
              {pill(C.red, 'STEP 8')}
              {pill(C.orange, 'DATA CLOSURE + UAT')}
              {pill(C.purple, 'STEP 13')}
              {pill(C.yellow, 'MGMT INPUTS')}
            </div>
            <p style={{ color: C.textSec, fontSize: '0.82rem', margin: 0 }}>
              Branch Master · Client Revenue Master · Branch–Client Mapping · Occupancy Assumptions · Zoho Actual Revenue · Revenue Projection Engine · Branch Cost Engine · Capex · Security Deposits · Integrated P&amp;L · Balance Sheet · Cash Bridge
            </p>
            <p style={{ color: C.textMut, fontSize: '0.78rem', margin: '3px 0 0' }}>
              ⚡ Isolated from production P&L / Cash Bridge / Balance Sheet. Step 5 (Cost/EBITDA Engine) requires separate approval.
            </p>
          </div>
          {summary && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <KpiCard label="Branches" value={summary.branches?.active || 0} sub={`${summary.branches?.existing || 0} existing · ${summary.branches?.signed || 0} signed`} />
              <KpiCard label="Clients" value={summary.clients?.active || 0} sub={summary.clients?.unmapped > 0 ? `${summary.clients.unmapped} unmapped` : 'All mapped'} color={summary.clients?.unmapped > 0 ? C.yellow : C.green} />
              <KpiCard label="Mappings" value={summary.mappings?.active || 0} />
              <KpiCard label="Validation" value={(summary.validation?.status || '—').toUpperCase()} color={valColor} sub={`${summary.validation?.errors || 0} errors · ${summary.validation?.warnings || 0} warnings`} />
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        {tabs.map(t => <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</TabButton>)}
      </div>

      {/* Content */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '20px 24px' }}>
        {tab === 'branch'     && <BranchMasterTab    branches={branches}  loading={loading} onRefresh={loadAll} />}
        {tab === 'client'     && <ClientMasterTab     clients={clients}    loading={loading} onRefresh={loadAll} />}
        {tab === 'mapping'    && <MappingTab          mappings={mappings}  branches={branches} clients={clients} loading={loading} onRefresh={loadAll} />}
        {tab === 'occupancy'  && <OccupancyTab        branches={branches}  loading={loading} onRefresh={loadAll} />}
        {tab === 'global'     && <GlobalAssumptionsTab />}
        {tab === 'validation' && <ValidationTab />}
        {tab === 'revenue'    && <ActualRevenueTab    branches={branches} />}
        {tab === 'projection'    && <ProjectionTab        branches={branches} />}
        {tab === 'profitability' && <ProfitabilityTab     branches={branches} />}
        {tab === 'integrated'   && <IntegratedFinancialsTab branches={branches} />}
        {tab === 'step8'        && <Step8Tab branches={branches} />}
        {tab === 'mgmt_inputs'  && <ManagementInputsTab />}
        {tab === 'step15'       && <Step15Tab />}
      </div>

      {/* Step isolation notice */}
      <div style={{ marginTop: 16, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>🔒</span>
        <div style={{ fontSize: 12, color: C.textSec }}>
          <strong style={{ color: C.text }}>Production isolation active.</strong> Steps 2 &amp; 3 store data in <code style={{ color: C.cyan, fontSize: 11 }}>server/fpa/</code> and do not modify any existing Cash Bridge, P&amp;L, Balance Sheet, or Debt Schedule calculations.
          The Revenue Projection Engine (Step 4) requires separate approval before any forecasting logic is connected.
        </div>
      </div>
    </div>
  );
}
