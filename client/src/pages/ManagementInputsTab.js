/**
 * ManagementInputsTab — Step 13 Management Input Completion & Assumption Workspace
 *
 * Central hub for all management-required inputs needed to unblock the FP&A model.
 * Sections: Readiness, Branch Assumptions, Future Branches, Client Revenue,
 *           Cost Master, Debt Workspace, Utilities, Opening BS, Asset Register,
 *           GL Mapping, Unmapped Revenue.
 *
 * DO NOT fabricate assumptions. Do NOT auto-approve management decisions.
 * All inputs here require explicit management review and approval.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../utils/api';

// ─── Design tokens (match FPADashboard) ───────────────────────────────────────
const C = {
  bg: '#0F1117', surface: '#1A1D27', surfaceEl: '#21253B',
  border: '#2E3348', text: '#E8EAED', textSec: '#9AA3B2',
  textMut: '#5C6680', accent: '#6366F1', green: '#22C55E',
  yellow: '#F59E0B', red: '#EF4444', purple: '#A855F7',
  cyan: '#06B6D4', orange: '#F97316'
};

const SUB_TABS = [
  { id: 'readiness',       label: 'Readiness', icon: '◎' },
  { id: 'branch',          label: 'Branch Assumptions', icon: '🏢' },
  { id: 'future_branch',   label: 'Future Branches', icon: '＋' },
  { id: 'client_revenue',  label: 'Client Revenue', icon: '₹' },
  { id: 'cost_master',     label: 'Cost Master', icon: '📊' },
  { id: 'debt',            label: 'Debt Workspace', icon: '🏦' },
  { id: 'utilities',       label: 'Utilities', icon: '⚡' },
  { id: 'opening_bs',      label: 'Opening BS', icon: '📋' },
  { id: 'asset_register',  label: 'Asset Register', icon: '🔧' },
  { id: 'gl_mapping',      label: 'GL Mapping', icon: '🗺' },
  { id: 'unmapped_revenue',label: 'Unmapped Revenue', icon: '⚠' },
];

// ─── Shared styles ─────────────────────────────────────────────────────────────
const s = {
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginBottom: 16 },
  th: { padding: '8px 12px', textAlign: 'left', fontSize: 11, color: C.textMut, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: `1px solid ${C.border}` },
  td: { padding: '8px 12px', fontSize: 13, color: C.text, borderBottom: `1px solid ${C.border}` },
  input: { background: C.surfaceEl, border: `1px solid ${C.border}`, borderRadius: 4, padding: '5px 8px', color: C.text, fontSize: 13, width: '100%', boxSizing: 'border-box' },
  btn: (variant = 'primary') => ({
    padding: '6px 14px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
    background: variant === 'primary' ? C.accent : variant === 'danger' ? C.red : variant === 'success' ? C.green : C.surfaceEl,
    color: '#fff',
  }),
  badge: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: color + '22', color: color }),
  label: { fontSize: 11, color: C.textMut, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' },
  sectionTitle: { fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 },
  sectionSub: { fontSize: 13, color: C.textSec, marginBottom: 20 },
};

// ─── Helper: currency format ───────────────────────────────────────────────────
const fmtL = (v) => v == null ? '—' : `₹${Number(v).toFixed(2)}L`;
const fmtR = (v) => v == null ? '—' : `₹${(v / 100000).toFixed(2)}L`;

// ─── Readiness Section ─────────────────────────────────────────────────────────
function ReadinessSection({ branches, debtSchedule, assumptions, costMaster, obsData, assetRegister, glMapping, glData, unmapped, onNavigate }) {
  const sections = [
    {
      id: 'debt',
      label: 'Debt Workspace (B1)',
      desc: '32 facilities need interest rates + repayment schedules',
      check: () => {
        const total = (debtSchedule || []).length;
        // Actual JSON uses `rate` (not `interest_rate`); support both for safety
        const filled = (debtSchedule || []).filter(d => {
          const r = Number(d.rate ?? d.interest_rate ?? 0);
          return r > 0 && (d.repayment_schedule || []).length > 0;
        }).length;
        return { total, filled, pct: total ? Math.round(filled / total * 100) : 0 };
      },
      blocker: 'B1',
    },
    {
      id: 'opening_bs',
      label: 'Opening Balance Sheet (B2)',
      desc: 'OBS must be approved before forecast baseline can be generated',
      check: () => {
        const status = obsData?.approval_status;
        return { total: 1, filled: status === 'approved' ? 1 : 0, pct: status === 'approved' ? 100 : 0, status };
      },
      blocker: 'B2',
    },
    {
      id: 'client_revenue',
      label: 'Client Revenue (Contracted)',
      desc: 'Contracted monthly revenue per client-mapping',
      check: () => {
        const total = (assumptions || []).length;
        const filled = (assumptions || []).filter(a => a.contracted_monthly_revenue != null).length;
        return { total, filled, pct: total ? Math.round(filled / total * 100) : 0 };
      },
      blocker: null,
    },
    {
      id: 'branch',
      label: 'Branch Assumptions',
      desc: 'Capacity, seats, sqft per branch',
      check: () => {
        const total = (branches || []).length;
        const filled = (branches || []).filter(b => b.total_area_sqft && b.total_seats).length;
        return { total, filled, pct: total ? Math.round(filled / total * 100) : 0 };
      },
      blocker: null,
    },
    {
      id: 'cost_master',
      label: 'Cost Master',
      desc: 'Branch-level cost assumptions (rent, CAM, people)',
      check: () => {
        const entries = (costMaster || []).filter(c => c.active !== false).length;
        return { total: (branches || []).length, filled: entries, pct: (branches || []).length ? Math.min(100, Math.round(entries / (branches || []).length * 100)) : 0 };
      },
      blocker: null,
    },
    {
      id: 'asset_register',
      label: 'Asset Register (OI-009)',
      desc: 'Fixed asset register for PPE roll-forward',
      check: () => {
        const entries = (assetRegister || []).filter(a => a.active !== false).length;
        return { total: null, filled: entries, pct: entries > 0 ? 100 : 0 };
      },
      blocker: 'OI-009',
    },
    {
      id: 'gl_mapping',
      label: 'GL → FP&A Account Mapping (OI-011)',
      desc: 'COA groupings mapped from Zoho Chart of Accounts',
      check: () => {
        const glSum = glData?.summary || {};
        const total = glData?.total_groupings || (glMapping || []).length;
        const mapped = (glSum.auto_mapped || 0) + (glSum.confirmed || 0) + (glSum.resolved || 0);
        const filled = mapped || (glMapping || []).filter(m => m.active !== false).length;
        return { total, filled, pct: total ? Math.round(filled / total * 100) : 0 };
      },
      blocker: 'OI-011',
    },
    {
      id: 'unmapped_revenue',
      label: 'Unmapped Revenue Review',
      desc: 'Classify or branch-assign unmapped invoices',
      check: () => {
        const total = (unmapped || []).length;
        const resolved = (unmapped || []).filter(u => u.branch_id || u.exclude_from_forecast || u.revenue_category === 'deposit' || u.revenue_category === 'advance').length;
        return { total, filled: resolved, pct: total ? Math.round(resolved / total * 100) : 0 };
      },
      blocker: null,
    },
  ];

  const allPcts = sections.map(s => s.check().pct);
  const overall = Math.round(allPcts.reduce((a, b) => a + b, 0) / allPcts.length);

  return (
    <div>
      <div style={{ ...s.card, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 48, fontWeight: 700, color: overall >= 80 ? C.green : overall >= 50 ? C.yellow : C.red, lineHeight: 1 }}>{overall}%</div>
            <div style={{ fontSize: 12, color: C.textMut, marginTop: 4 }}>Overall Readiness</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ height: 12, background: C.surfaceEl, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${overall}%`, background: overall >= 80 ? C.green : overall >= 50 ? C.yellow : C.red, borderRadius: 6, transition: 'width 0.3s' }} />
            </div>
            <div style={{ fontSize: 13, color: C.textSec, marginTop: 8 }}>
              Management inputs must reach 100% before generating a forecast baseline.
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {sections.map(sec => {
          const { total, filled, pct, status } = sec.check();
          const color = pct === 100 ? C.green : pct >= 50 ? C.yellow : C.red;
          return (
            <div key={sec.id} style={{ ...s.card, marginBottom: 0, cursor: 'pointer', borderColor: pct === 100 ? C.green + '44' : C.border }}
              onClick={() => onNavigate(sec.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{sec.label}</div>
                  <div style={{ fontSize: 12, color: C.textMut, marginTop: 2 }}>{sec.desc}</div>
                </div>
                {sec.blocker && <span style={s.badge(C.orange)}>{sec.blocker}</span>}
              </div>
              <div style={{ height: 6, background: C.surfaceEl, borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3 }} />
              </div>
              <div style={{ fontSize: 12, color: color, fontWeight: 600 }}>
                {pct}% {total != null ? `— ${filled} / ${total}` : `— ${filled} entries`}
                {status && ` (${status})`}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 20, padding: 16, background: '#1A1D27', border: `1px solid ${C.yellow}44`, borderRadius: 8 }}>
        <div style={{ fontSize: 13, color: C.yellow, fontWeight: 600, marginBottom: 4 }}>
          ⚠ TEMPORARY / UNAPPROVED / INFLATED DERIVED FORECAST
        </div>
        <div style={{ fontSize: 12, color: C.textSec }}>
          Current forecast of ~₹6,556.68L/month is derived from 3-month Zoho actuals including Dec 2025 advance billing and security deposits.
          This is NOT the approved forecast baseline. Complete all inputs above and click "Generate Forecast Baseline" to replace it.
        </div>
      </div>
    </div>
  );
}

// ─── Branch Assumptions Section ────────────────────────────────────────────────
function BranchAssumptionsSection({ branches, onSave }) {
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState({});
  const [saved, setSaved] = useState({});

  useEffect(() => {
    setRows((branches || []).map(b => ({ ...b })));
  }, [branches]);

  const handleChange = (idx, field, val) => {
    setRows(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: val === '' ? null : (isNaN(val) ? val : Number(val)) };
      return next;
    });
    setSaved(prev => ({ ...prev, [rows[idx]?.branch_id]: false }));
  };

  const handleSave = async (branch) => {
    setSaving(prev => ({ ...prev, [branch.branch_id]: true }));
    try {
      await apiFetch(`/fpa/branch-master/${branch.branch_id}`, { method: 'PUT', data: branch });
      setSaved(prev => ({ ...prev, [branch.branch_id]: true }));
      if (onSave) onSave();
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      setSaving(prev => ({ ...prev, [branch.branch_id]: false }));
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>Branch Assumptions</div>
        <div style={s.sectionSub}>
          Enter capacity, area, seats, and opening dates for all branches.
          <strong style={{ color: C.yellow }}> Opening dates shown are derived from earliest Zoho invoice — confirm actual branch opening date.</strong>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Branch ID','Branch Name','City','Opening Date','Total Area (sqft)','Revenue Capacity (sqft)','Total Seats','Rent/sqft (₹)','Occupancy Ramp','Action'].map(h => (
                <th key={h} style={s.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b, idx) => (
              <tr key={b.branch_id} style={{ background: idx % 2 === 0 ? 'transparent' : C.surfaceEl + '33' }}>
                <td style={s.td}><span style={{ fontFamily: 'monospace', fontSize: 12, color: C.accent }}>{b.branch_id}</span></td>
                <td style={s.td}><span style={{ fontSize: 12 }}>{b.branch_name}</span></td>
                <td style={s.td}>{b.city}</td>
                <td style={s.td}>
                  <input type="date" value={b.opening_date || ''} onChange={e => handleChange(idx, 'opening_date', e.target.value)}
                    style={{ ...s.input, width: 140 }} />
                  {b.opening_date_source === 'earliest_zoho_invoice_in_sync_window' &&
                    <div style={{ fontSize: 10, color: C.yellow, marginTop: 2 }}>⚠ Zoho-derived</div>}
                </td>
                <td style={s.td}>
                  <input type="number" value={b.total_area_sqft ?? ''} min={0} placeholder="e.g. 12000"
                    onChange={e => handleChange(idx, 'total_area_sqft', e.target.value)}
                    style={{ ...s.input, width: 90 }} />
                </td>
                <td style={s.td}>
                  <input type="number" value={b.revenue_capacity_sqft ?? ''} min={0} placeholder="e.g. 10000"
                    onChange={e => handleChange(idx, 'revenue_capacity_sqft', e.target.value)}
                    style={{ ...s.input, width: 90 }} />
                </td>
                <td style={s.td}>
                  <input type="number" value={b.total_seats ?? ''} min={0} placeholder="e.g. 200"
                    onChange={e => handleChange(idx, 'total_seats', e.target.value)}
                    style={{ ...s.input, width: 80 }} />
                </td>
                <td style={s.td}>
                  <input type="number" value={b.rent_per_sqft ?? ''} min={0} step="0.01"
                    onChange={e => handleChange(idx, 'rent_per_sqft', e.target.value)}
                    style={{ ...s.input, width: 80 }} />
                </td>
                <td style={s.td}>
                  <select value={b.occupancy_ramp_template || 'base'} onChange={e => handleChange(idx, 'occupancy_ramp_template', e.target.value)}
                    style={{ ...s.input, width: 110 }}>
                    <option value="conservative">Conservative</option>
                    <option value="base">Base</option>
                    <option value="aggressive">Aggressive</option>
                    <option value="custom">Custom</option>
                  </select>
                </td>
                <td style={s.td}>
                  <button onClick={() => handleSave(rows[idx])} disabled={saving[b.branch_id]}
                    style={{ ...s.btn(saved[b.branch_id] ? 'success' : 'primary'), fontSize: 12 }}>
                    {saving[b.branch_id] ? 'Saving…' : saved[b.branch_id] ? '✓ Saved' : 'Save'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Future Branches Section ───────────────────────────────────────────────────
function FutureBranchesSection({ onSave }) {
  const blank = { branch_name: '', city: '', city_code: '', opening_date: '', total_area_sqft: '', revenue_capacity_sqft: '', total_seats: '', rent_per_sqft: '', occupancy_ramp_template: 'base' };
  const [form, setForm] = useState({ ...blank });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleAdd = async () => {
    if (!form.branch_name || !form.city) { setMessage({ type: 'error', text: 'Branch name and city are required.' }); return; }
    setSaving(true); setMessage(null);
    try {
      await apiFetch('/fpa/branch-master', { method: 'POST', data: {
        ...form,
        total_area_sqft: form.total_area_sqft ? Number(form.total_area_sqft) : null,
        revenue_capacity_sqft: form.revenue_capacity_sqft ? Number(form.revenue_capacity_sqft) : null,
        total_seats: form.total_seats ? Number(form.total_seats) : null,
        rent_per_sqft: form.rent_per_sqft ? Number(form.rent_per_sqft) : null,
        branch_type: 'coworking',
        data_source: 'management_input_future_branch',
      }});
      setForm({ ...blank });
      setMessage({ type: 'success', text: 'Branch added successfully.' });
      if (onSave) onSave();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const field = (label, key, type = 'text', placeholder = '') => (
    <div style={{ marginBottom: 12 }}>
      <label style={s.label}>{label}</label>
      <input type={type} value={form[key] ?? ''} placeholder={placeholder}
        onChange={e => set(key, e.target.value)}
        style={s.input} />
    </div>
  );

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>Add Future Branch</div>
        <div style={s.sectionSub}>New branches will be included in the forecast from their opening date.</div>
      </div>
      <div style={s.card}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            {field('Branch Name *', 'branch_name', 'text', 'e.g. Mum_Bandra_10th Floor')}
            {field('City *', 'city', 'text', 'e.g. Mumbai')}
            {field('City Code', 'city_code', 'text', 'e.g. MUM')}
            {field('Opening Date', 'opening_date', 'date')}
          </div>
          <div>
            {field('Total Area (sqft)', 'total_area_sqft', 'number', 'e.g. 12000')}
            {field('Revenue Capacity (sqft)', 'revenue_capacity_sqft', 'number', 'e.g. 10000')}
            {field('Total Seats', 'total_seats', 'number', 'e.g. 200')}
            {field('Rent per sqft (₹)', 'rent_per_sqft', 'number', 'e.g. 85')}
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={s.label}>Occupancy Ramp Template</label>
          <select value={form.occupancy_ramp_template} onChange={e => set('occupancy_ramp_template', e.target.value)} style={{ ...s.input, width: 200 }}>
            <option value="conservative">Conservative</option>
            <option value="base">Base</option>
            <option value="aggressive">Aggressive</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        {message && (
          <div style={{ padding: '8px 12px', borderRadius: 4, marginBottom: 12, fontSize: 13,
            background: message.type === 'error' ? C.red + '22' : C.green + '22',
            color: message.type === 'error' ? C.red : C.green }}>
            {message.text}
          </div>
        )}
        <button onClick={handleAdd} disabled={saving} style={s.btn()}>
          {saving ? 'Adding…' : '+ Add Branch'}
        </button>
      </div>
    </div>
  );
}

// ─── Client Revenue Section ────────────────────────────────────────────────────
function ClientRevenueSection({ assumptions, clients, branches, onSave }) {
  const [search, setSearch] = useState('');
  const [filterBranch, setFilterBranch] = useState('');
  const [bulkEsc, setBulkEsc] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);
  const [saving, setSaving] = useState({});
  const [localVals, setLocalVals] = useState({});

  const clientMap = {};
  (clients || []).forEach(c => { clientMap[c.client_id] = c; });

  const branchMap = {};
  (branches || []).forEach(b => { branchMap[b.branch_id] = b; });

  const rows = (assumptions || []).filter(a => {
    const client = clientMap[a.client_id];
    const nameMatch = !search || (client?.client_name || a.client_id).toLowerCase().includes(search.toLowerCase());
    const branchMatch = !filterBranch || a.branch_id === filterBranch;
    return nameMatch && branchMatch;
  });

  const setValue = (mapping_id, field, val) => {
    setLocalVals(prev => ({ ...prev, [`${mapping_id}.${field}`]: val }));
  };

  const getVal = (a, field) => {
    const key = `${a.mapping_id}.${field}`;
    return key in localVals ? localVals[key] : (a[field] ?? '');
  };

  const handleSave = async (a) => {
    setSaving(prev => ({ ...prev, [a.mapping_id]: true }));
    try {
      const cmr = localVals[`${a.mapping_id}.contracted_monthly_revenue`];
      const esc = localVals[`${a.mapping_id}.escalation_pct`];
      const patch = {};
      if (cmr !== undefined) patch.contracted_monthly_revenue = cmr === '' ? null : Number(cmr);
      if (esc !== undefined) patch.escalation_pct = esc === '' ? null : Number(esc);
      patch.revenue_assumption_source = 'management_input';
      await apiFetch(`/fpa/projection/assumptions/${a.mapping_id}`, { method: 'PUT', data: patch });
      if (onSave) onSave();
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      setSaving(prev => ({ ...prev, [a.mapping_id]: false }));
    }
  };

  const handleBulkEscalation = async () => {
    if (!bulkEsc) { alert('Enter an escalation % first'); return; }
    const confirm = window.confirm(`Apply ${bulkEsc}% escalation to ${filterBranch ? 'filtered' : 'ALL'} ${rows.length} clients?`);
    if (!confirm) return;
    setBulkApplying(true);
    try {
      const mapping_ids = rows.map(r => r.mapping_id);
      await apiFetch('/fpa/projection/assumptions/bulk-escalation', {
        method: 'PUT', data: { mapping_ids, escalation_pct: Number(bulkEsc) }
      });
      if (onSave) onSave();
    } catch (e) {
      alert('Bulk escalation failed: ' + e.message);
    } finally {
      setBulkApplying(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>Client Revenue Assumptions</div>
        <div style={s.sectionSub}>
          Enter contracted monthly revenue per client. Do NOT auto-assume from 3M actuals — this requires explicit management input.
          The "3M Avg (Actual)" column is shown for reference only.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Search client…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...s.input, width: 220 }} />
        <select value={filterBranch} onChange={e => setFilterBranch(e.target.value)} style={{ ...s.input, width: 200 }}>
          <option value="">All Branches</option>
          {(branches || []).map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <span style={{ fontSize: 12, color: C.textMut }}>Bulk Escalation %:</span>
          <input type="number" value={bulkEsc} onChange={e => setBulkEsc(e.target.value)} placeholder="e.g. 5"
            style={{ ...s.input, width: 80 }} />
          <button onClick={handleBulkEscalation} disabled={bulkApplying} style={s.btn('primary')}>
            {bulkApplying ? 'Applying…' : 'Apply to Filtered'}
          </button>
        </div>
      </div>

      <div style={{ fontSize: 13, color: C.textSec, marginBottom: 8 }}>Showing {rows.length} of {(assumptions || []).length} mappings</div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Client ID','Client Name','Branch','3M Avg (Actual ₹L)','Contracted Rev (₹L/mo)','Escalation %','Source','Action'].map(h => (
                <th key={h} style={s.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a, idx) => {
              const client = clientMap[a.client_id];
              const branch = branchMap[a.branch_id];
              return (
                <tr key={a.mapping_id} style={{ background: idx % 2 === 0 ? 'transparent' : C.surfaceEl + '22' }}>
                  <td style={s.td}><span style={{ fontFamily: 'monospace', fontSize: 11, color: C.textMut }}>{a.client_id}</span></td>
                  <td style={s.td}><span style={{ fontSize: 12 }}>{client?.client_name || a.client_id}</span></td>
                  <td style={s.td}><span style={{ fontSize: 11, color: C.cyan }}>{branch?.branch_name || a.branch_id}</span></td>
                  <td style={{ ...s.td, color: C.textMut, fontSize: 12 }}>
                    {a.derived_base_revenue != null ? fmtL(a.derived_base_revenue / 100000) : '—'}
                    <div style={{ fontSize: 10, color: C.textMut }}>Reference only</div>
                  </td>
                  <td style={s.td}>
                    <input type="number" min={0} step="0.01"
                      value={getVal(a, 'contracted_monthly_revenue')}
                      onChange={e => setValue(a.mapping_id, 'contracted_monthly_revenue', e.target.value)}
                      placeholder="REQUIRED"
                      style={{ ...s.input, width: 110, borderColor: a.contracted_monthly_revenue == null ? C.yellow + '88' : C.border }} />
                  </td>
                  <td style={s.td}>
                    <input type="number" min={0} max={100} step="0.1"
                      value={getVal(a, 'escalation_pct')}
                      onChange={e => setValue(a.mapping_id, 'escalation_pct', e.target.value)}
                      placeholder="e.g. 5"
                      style={{ ...s.input, width: 80 }} />
                  </td>
                  <td style={s.td}>
                    <span style={s.badge(a.revenue_assumption_source === 'management_input' ? C.green : C.yellow)}>
                      {a.revenue_assumption_source || 'PENDING'}
                    </span>
                  </td>
                  <td style={s.td}>
                    <button onClick={() => handleSave(a)} disabled={saving[a.mapping_id]}
                      style={{ ...s.btn('primary'), fontSize: 12 }}>
                      {saving[a.mapping_id] ? 'Saving…' : 'Save'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Cost Master Section ───────────────────────────────────────────────────────
function CostMasterSection({ costMaster, branches, onSave }) {
  const [form, setForm] = useState({ branch_id: '', cost_type: 'rent', calculation_method: 'fixed', amount: '', per_sqft: '', per_seat: '', pct_revenue: '', effective_from: '', note: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const branchMap = {};
  (branches || []).forEach(b => { branchMap[b.branch_id] = b; });

  const setF = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleAdd = async () => {
    if (!form.branch_id || !form.cost_type) { setMessage({ type: 'error', text: 'Branch and cost type are required.' }); return; }
    setSaving(true); setMessage(null);
    try {
      await apiFetch('/fpa/cost/cost-master', { method: 'POST', data: {
        ...form,
        amount: form.amount ? Number(form.amount) : null,
        per_sqft: form.per_sqft ? Number(form.per_sqft) : null,
        per_seat: form.per_seat ? Number(form.per_seat) : null,
        pct_revenue: form.pct_revenue ? Number(form.pct_revenue) : null,
        data_source: 'management_input',
      }});
      setForm(prev => ({ ...prev, amount: '', per_sqft: '', per_seat: '', pct_revenue: '', note: '' }));
      setMessage({ type: 'success', text: 'Cost assumption added.' });
      if (onSave) onSave();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const active = (costMaster || []).filter(c => c.active !== false);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>Branch Cost Master</div>
        <div style={s.sectionSub}>Enter cost assumptions per branch. Multiple methods supported: fixed amount, per sqft, per seat, % of revenue.</div>
      </div>

      <div style={s.card}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 12 }}>Add Cost Assumption</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <label style={s.label}>Branch *</label>
            <select value={form.branch_id} onChange={e => setF('branch_id', e.target.value)} style={s.input}>
              <option value="">Select branch…</option>
              {(branches || []).map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
            </select>
          </div>
          <div>
            <label style={s.label}>Cost Type *</label>
            <select value={form.cost_type} onChange={e => setF('cost_type', e.target.value)} style={s.input}>
              <option value="rent">Rent</option>
              <option value="cam">CAM / Maintenance</option>
              <option value="utilities">Utilities</option>
              <option value="people">People / Payroll</option>
              <option value="facility">Facility Management</option>
              <option value="pre_opening">Pre-Opening</option>
              <option value="other_opex">Other OpEx</option>
            </select>
          </div>
          <div>
            <label style={s.label}>Calculation Method</label>
            <select value={form.calculation_method} onChange={e => setF('calculation_method', e.target.value)} style={s.input}>
              <option value="fixed">Fixed Monthly Amount (₹)</option>
              <option value="per_sqft">Per sqft (₹/sqft/month)</option>
              <option value="per_seat">Per seat (₹/seat/month)</option>
              <option value="pct_revenue">% of Revenue</option>
              <option value="occupancy_linked">Occupancy-linked (% of max)</option>
            </select>
          </div>
          {form.calculation_method === 'fixed' && (
            <div>
              <label style={s.label}>Fixed Amount (₹/month)</label>
              <input type="number" value={form.amount} onChange={e => setF('amount', e.target.value)} placeholder="e.g. 500000" style={s.input} />
            </div>
          )}
          {form.calculation_method === 'per_sqft' && (
            <div>
              <label style={s.label}>Rate (₹/sqft/month)</label>
              <input type="number" value={form.per_sqft} onChange={e => setF('per_sqft', e.target.value)} placeholder="e.g. 75" style={s.input} />
            </div>
          )}
          {form.calculation_method === 'per_seat' && (
            <div>
              <label style={s.label}>Rate (₹/seat/month)</label>
              <input type="number" value={form.per_seat} onChange={e => setF('per_seat', e.target.value)} placeholder="e.g. 2500" style={s.input} />
            </div>
          )}
          {(form.calculation_method === 'pct_revenue' || form.calculation_method === 'occupancy_linked') && (
            <div>
              <label style={s.label}>Percentage (%)</label>
              <input type="number" value={form.pct_revenue} onChange={e => setF('pct_revenue', e.target.value)} placeholder="e.g. 5" style={s.input} />
            </div>
          )}
          <div>
            <label style={s.label}>Effective From</label>
            <input type="month" value={form.effective_from} onChange={e => setF('effective_from', e.target.value)} style={s.input} />
          </div>
          <div>
            <label style={s.label}>Note</label>
            <input type="text" value={form.note} onChange={e => setF('note', e.target.value)} placeholder="e.g. Lease agreement ref" style={s.input} />
          </div>
        </div>
        {message && (
          <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 4, fontSize: 13,
            background: message.type === 'error' ? C.red + '22' : C.green + '22',
            color: message.type === 'error' ? C.red : C.green }}>
            {message.text}
          </div>
        )}
        <button onClick={handleAdd} disabled={saving} style={{ ...s.btn(), marginTop: 12 }}>
          {saving ? 'Adding…' : '+ Add Cost Assumption'}
        </button>
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8 }}>Existing Assumptions ({active.length})</div>
      {active.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: C.textMut, fontSize: 13 }}>
          No cost assumptions entered. Add above to populate Branch OpEx (required to unblock RC-F02).
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>{['Branch','Cost Type','Method','Rate/Amount','Effective From','Note'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {active.map((c, i) => (
              <tr key={c.assumption_id} style={{ background: i % 2 === 0 ? 'transparent' : C.surfaceEl + '22' }}>
                <td style={s.td}>{branchMap[c.branch_id]?.branch_name || c.branch_id}</td>
                <td style={s.td}>{c.cost_type}</td>
                <td style={s.td}>{c.calculation_method}</td>
                <td style={s.td}>
                  {c.calculation_method === 'fixed' ? `₹${c.amount?.toLocaleString()}` :
                   c.calculation_method === 'per_sqft' ? `₹${c.per_sqft}/sqft` :
                   c.calculation_method === 'per_seat' ? `₹${c.per_seat}/seat` :
                   c.pct_revenue != null ? `${c.pct_revenue}%` : '—'}
                </td>
                <td style={s.td}>{c.effective_from || '—'}</td>
                <td style={s.td}><span style={{ fontSize: 12, color: C.textMut }}>{c.note || '—'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Debt Workspace Section ────────────────────────────────────────────────────
// Note: Zoho-synced facilities use `id`, `rate`, `opening_principal`, `label`, `lender`.
// Manually-created facilities use `facility_id`. Both are handled by the PUT endpoint.
function DebtWorkspaceSection({ debtSchedule, onSave }) {
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState({});
  const [saved, setSaved] = useState({});

  useEffect(() => {
    setRows((debtSchedule || []).map(d => ({ ...d })));
  }, [debtSchedule]);

  const getFacilityKey = (d) => d.id || d.facility_id;

  const handleChange = (idx, field, val) => {
    setRows(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: val === '' ? null : Number(val) };
      return next;
    });
    const key = getFacilityKey(rows[idx]);
    setSaved(prev => ({ ...prev, [key]: false }));
  };

  const handleSave = async (d) => {
    const key = getFacilityKey(d);
    setSaving(prev => ({ ...prev, [key]: true }));
    try {
      // rate field name in Zoho-synced data; the PUT endpoint merges whatever we send
      await apiFetch(`/fpa/integrated/debt-schedule/${key}`, {
        method: 'PUT', data: { rate: d.rate, emi_lakh: d.emi_lakh, repay_freq: d.repay_freq }
      });
      setSaved(prev => ({ ...prev, [key]: true }));
      if (onSave) onSave();
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      setSaving(prev => ({ ...prev, [key]: false }));
    }
  };

  const totalPrincipal = rows.reduce((s, d) => s + (d.opening_principal || d.outstanding_balance || 0), 0);
  const missingRate = rows.filter(d => {
    const r = Number(d.rate || d.interest_rate || 0);
    return r === 0;
  }).length;
  const missingSchedule = rows.filter(d => (d.repayment_schedule || []).length === 0).length;

  const getRateVal = (d) => d.rate ?? d.interest_rate ?? '';
  const getPrincipal = (d) => d.opening_principal ?? d.outstanding_balance ?? 0;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>Debt Workspace</div>
        <div style={s.sectionSub}>
          Review and update rates for all {rows.length} debt facilities.
          <strong style={{ color: C.yellow }}> B1 Blocker: Repayment schedules must be populated to compute finance cost, PAT, cash bridge, and balance sheet.</strong>
          <br/>
          <span style={{ color: C.textMut }}>Note: 12 Related Party loans show rate=0 — management must confirm if these are interest-free.</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={s.card}>
          <div style={{ fontSize: 12, color: C.textMut }}>Total Opening Principal</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.cyan }}>{fmtL(totalPrincipal)}</div>
        </div>
        <div style={{ ...s.card, borderColor: missingRate > 0 ? C.yellow + '66' : C.green + '66' }}>
          <div style={{ fontSize: 12, color: C.textMut }}>Facilities with rate = 0</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: missingRate > 0 ? C.yellow : C.green }}>{missingRate} / {rows.length}</div>
          <div style={{ fontSize: 11, color: C.textMut }}>Confirm if interest-free</div>
        </div>
        <div style={{ ...s.card, borderColor: C.red + '66' }}>
          <div style={{ fontSize: 12, color: C.textMut }}>Missing Repayment Schedule</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.red }}>{missingSchedule} / {rows.length}</div>
          <div style={{ fontSize: 11, color: C.red }}>CRITICAL — B1 Blocker</div>
        </div>
      </div>

      <div style={{ padding: '10px 14px', background: C.red + '11', border: `1px solid ${C.red}44`, borderRadius: 6, marginBottom: 16, fontSize: 12, color: C.textSec }}>
        <strong style={{ color: C.red }}>B1 Blocker:</strong> Finance cost = null until repayment schedules are entered.
        Repayment schedule entry via UI is complex — for bulk import use the Excel template or contact your system administrator to populate <code>repayment_schedule</code> arrays directly in debt_schedule.json.
        Rate updates can be saved here immediately.
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['ID','Label','Lender','Type','Principal (₹L)','Rate (% p.a.)','EMI (₹L)','Repay Freq','Maturity','Schedule','Action'].map(h => (
                <th key={h} style={s.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((d, idx) => {
              const key = getFacilityKey(d);
              const rate = Number(getRateVal(d) || 0);
              const rateZero = rate === 0;
              const hasSchedule = (d.repayment_schedule || []).length > 0;
              const rowBg = !hasSchedule ? C.red + '08' : idx % 2 === 0 ? 'transparent' : C.surfaceEl + '22';
              return (
                <tr key={key} style={{ background: rowBg }}>
                  <td style={s.td}><span style={{ fontFamily: 'monospace', fontSize: 11, color: C.accent }}>{key}</span></td>
                  <td style={s.td}><span style={{ fontSize: 12 }}>{d.label || d.facility_name || '—'}</span></td>
                  <td style={s.td}><span style={{ fontSize: 11, color: C.textMut }}>{d.lender || '—'}</span></td>
                  <td style={s.td}><span style={{ fontSize: 11 }}>{d.type || d.facility_type || '—'}</span></td>
                  <td style={s.td}>{fmtL(getPrincipal(d))}</td>
                  <td style={s.td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="number" min={0} max={50} step="0.01"
                        value={rows[idx].rate ?? rows[idx].interest_rate ?? ''}
                        onChange={e => handleChange(idx, 'rate', e.target.value)}
                        style={{ ...s.input, width: 80, borderColor: rateZero ? C.yellow + '88' : C.border }} />
                      <span style={{ color: C.textMut, fontSize: 11 }}>%</span>
                      {rateZero && <span style={{ fontSize: 10, color: C.yellow }}>Confirm 0%?</span>}
                    </div>
                  </td>
                  <td style={s.td}>{d.emi_lakh != null ? fmtL(d.emi_lakh) : '—'}</td>
                  <td style={s.td}><span style={{ fontSize: 11 }}>{d.repay_freq || '—'}</span></td>
                  <td style={s.td}><span style={{ fontSize: 11 }}>{d.maturity || '—'}</span></td>
                  <td style={s.td}>
                    <span style={s.badge(hasSchedule ? C.green : C.red)}>
                      {hasSchedule ? `${(d.repayment_schedule || []).length} entries` : 'MISSING'}
                    </span>
                  </td>
                  <td style={s.td}>
                    <button onClick={() => handleSave(rows[idx])} disabled={saving[key]}
                      style={{ ...s.btn(saved[key] ? 'success' : 'primary'), fontSize: 11, padding: '4px 10px' }}>
                      {saving[key] ? '…' : saved[key] ? '✓' : 'Save Rate'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Utilities Section ─────────────────────────────────────────────────────────
function UtilitiesSection({ globalAssumptions, onSave }) {
  const [form, setForm] = useState({ utilities_fixed_per_branch: '', utilities_variable_pct_revenue: '', utilities_per_seat: '', utilities_method: 'fixed', utilities_note: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (globalAssumptions) {
      setForm({
        utilities_fixed_per_branch: globalAssumptions.utilities_fixed_per_branch ?? '',
        utilities_variable_pct_revenue: globalAssumptions.utilities_variable_pct_revenue ?? '',
        utilities_per_seat: globalAssumptions.utilities_per_seat ?? '',
        utilities_method: globalAssumptions.utilities_method || 'fixed',
        utilities_note: globalAssumptions.utilities_note || '',
      });
    }
  }, [globalAssumptions]);

  const handleSave = async () => {
    setSaving(true); setMessage(null);
    try {
      await apiFetch('/fpa/global-assumptions', { method: 'PUT', data: {
        ...globalAssumptions,
        utilities_method: form.utilities_method,
        utilities_fixed_per_branch: form.utilities_fixed_per_branch ? Number(form.utilities_fixed_per_branch) : null,
        utilities_variable_pct_revenue: form.utilities_variable_pct_revenue ? Number(form.utilities_variable_pct_revenue) : null,
        utilities_per_seat: form.utilities_per_seat ? Number(form.utilities_per_seat) : null,
        utilities_note: form.utilities_note,
        utilities_approved_by: 'management',
        utilities_approved_at: new Date().toISOString(),
      }});
      setMessage({ type: 'success', text: 'Utilities assumption saved.' });
      if (onSave) onSave();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>Utilities Assumption (B3)</div>
        <div style={s.sectionSub}>Management decision required: choose how utilities cost is computed in the forecast.</div>
      </div>
      <div style={{ ...s.card, borderColor: globalAssumptions?.utilities_method ? C.green + '44' : C.yellow + '44' }}>
        <div style={{ marginBottom: 16 }}>
          <label style={s.label}>Calculation Method *</label>
          <select value={form.utilities_method} onChange={e => setForm(p => ({ ...p, utilities_method: e.target.value }))} style={{ ...s.input, width: 260 }}>
            <option value="fixed">Fixed Amount per Branch (₹/month)</option>
            <option value="per_seat">Per Seat (₹/seat/month)</option>
            <option value="pct_revenue">% of Revenue</option>
            <option value="included_in_cam">Included in CAM (zero separate)</option>
          </select>
        </div>
        {form.utilities_method === 'fixed' && (
          <div style={{ marginBottom: 16 }}>
            <label style={s.label}>Fixed Amount per Branch (₹/month)</label>
            <input type="number" value={form.utilities_fixed_per_branch} onChange={e => setForm(p => ({ ...p, utilities_fixed_per_branch: e.target.value }))} placeholder="e.g. 150000" style={{ ...s.input, width: 200 }} />
          </div>
        )}
        {form.utilities_method === 'per_seat' && (
          <div style={{ marginBottom: 16 }}>
            <label style={s.label}>Rate (₹/seat/month)</label>
            <input type="number" value={form.utilities_per_seat} onChange={e => setForm(p => ({ ...p, utilities_per_seat: e.target.value }))} placeholder="e.g. 500" style={{ ...s.input, width: 200 }} />
          </div>
        )}
        {form.utilities_method === 'pct_revenue' && (
          <div style={{ marginBottom: 16 }}>
            <label style={s.label}>% of Revenue</label>
            <input type="number" value={form.utilities_variable_pct_revenue} onChange={e => setForm(p => ({ ...p, utilities_variable_pct_revenue: e.target.value }))} placeholder="e.g. 3" style={{ ...s.input, width: 120 }} />
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <label style={s.label}>Management Note (required for non-obvious choices)</label>
          <textarea value={form.utilities_note} onChange={e => setForm(p => ({ ...p, utilities_note: e.target.value }))}
            placeholder="e.g. Utilities are billed directly by building management and are included in CAM per lease agreement."
            style={{ ...s.input, height: 72, resize: 'vertical' }} />
        </div>
        {message && (
          <div style={{ padding: '8px 12px', borderRadius: 4, marginBottom: 12, fontSize: 13,
            background: message.type === 'error' ? C.red + '22' : C.green + '22',
            color: message.type === 'error' ? C.red : C.green }}>
            {message.text}
          </div>
        )}
        <button onClick={handleSave} disabled={saving} style={s.btn()}>
          {saving ? 'Saving…' : 'Save Utilities Assumption'}
        </button>
      </div>
    </div>
  );
}

// ─── Opening BS Section ────────────────────────────────────────────────────────
function OpeningBSSection({ obsData, onSave }) {
  const [status, setStatus] = useState('draft');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setStatus(obsData?.approval_status || 'draft');
    setNote(obsData?.approval_note || '');
  }, [obsData]);

  const handleSave = async () => {
    if (status === 'approved' && !note) { setMessage({ type: 'error', text: 'Approval note is required when approving OBS.' }); return; }
    setSaving(true); setMessage(null);
    try {
      await apiFetch('/fpa/integrated/opening-balance-sheet', { method: 'PUT', data: {
        ...obsData,
        approval_status: status,
        approval_note: note,
        approval_actioned_by: 'management',
        approval_actioned_at: new Date().toISOString(),
      }});
      setMessage({ type: 'success', text: `Status updated to: ${status}` });
      if (onSave) onSave();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const totalAssets = obsData?.total_assets;
  // OBS JSON uses `total_el` (Total Equity + Liabilities), not `total_liabilities_equity`
  const totalLiabEquity = obsData?.total_el ?? obsData?.total_liabilities_equity;
  const bsDiff = obsData?.bs_check_diff; // pre-computed diff in the JSON
  const imbalance = bsDiff != null ? bsDiff : (totalAssets != null && totalLiabEquity != null ? totalAssets - totalLiabEquity : null);

  const statusColors = { draft: C.textMut, under_review: C.yellow, approved: C.green, rejected: C.red };

  return (
    <div style={{ maxWidth: 700 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>Opening Balance Sheet Approval (B2)</div>
        <div style={s.sectionSub}>Review the opening balance sheet and set approval status. Forecast baseline cannot be generated until status is "Approved".</div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
        {[
          { label: 'Total Assets', val: totalAssets != null ? fmtL(totalAssets) : '—', color: C.cyan },
          { label: 'Total Liab + Equity', val: totalLiabEquity != null ? fmtL(totalLiabEquity) : '—', color: C.cyan },
          { label: 'Imbalance', val: imbalance != null ? fmtL(imbalance) : '—', color: imbalance != null && Math.abs(imbalance) > 1 ? C.red : C.green },
        ].map(item => (
          <div key={item.label} style={{ ...s.card, flex: 1, marginBottom: 0 }}>
            <div style={{ fontSize: 12, color: C.textMut }}>{item.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: item.color }}>{item.val}</div>
          </div>
        ))}
      </div>

      {imbalance != null && Math.abs(imbalance) > 1 && (
        <div style={{ padding: 12, background: C.red + '11', border: `1px solid ${C.red}44`, borderRadius: 6, marginBottom: 16, fontSize: 13, color: C.red }}>
          ⚠ Balance sheet is out of balance by {fmtL(Math.abs(imbalance))}. This must be resolved before approval.
          Do NOT use an "Other Adjustment" to force balance — identify the source of the discrepancy.
        </div>
      )}

      <div style={s.card}>
        <div style={{ marginBottom: 16 }}>
          <label style={s.label}>Approval Status</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['draft', 'under_review', 'approved', 'rejected'].map(st => (
              <button key={st} onClick={() => setStatus(st)}
                style={{ ...s.btn(status === st ? 'primary' : 'default'), background: status === st ? statusColors[st] : C.surfaceEl, fontSize: 12 }}>
                {st.replace('_', ' ').toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={s.label}>Approval Note {status === 'approved' ? '(Required)' : '(Optional)'}</label>
          <textarea value={note} onChange={e => setNote(e.target.value)}
            placeholder={status === 'approved' ? 'State basis for approval and how imbalance was resolved (if any)' : 'Notes on review status, pending items, or rejection reason'}
            style={{ ...s.input, height: 80, resize: 'vertical' }} />
        </div>
        {message && (
          <div style={{ padding: '8px 12px', borderRadius: 4, marginBottom: 12, fontSize: 13,
            background: message.type === 'error' ? C.red + '22' : C.green + '22',
            color: message.type === 'error' ? C.red : C.green }}>
            {message.text}
          </div>
        )}
        <button onClick={handleSave} disabled={saving} style={s.btn()}>
          {saving ? 'Saving…' : 'Update Status'}
        </button>
      </div>
    </div>
  );
}

// ─── Asset Register Section ────────────────────────────────────────────────────
function AssetRegisterSection({ assetRegister, branches, onSave }) {
  const [form, setForm] = useState({ asset_name: '', asset_category: 'furniture', branch_id: '', cost: '', acquisition_date: '', useful_life_months: '', salvage_value: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const branchMap = {};
  (branches || []).forEach(b => { branchMap[b.branch_id] = b; });

  const setF = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleAdd = async () => {
    if (!form.asset_name || !form.cost) { setMessage({ type: 'error', text: 'Asset name and cost are required.' }); return; }
    setSaving(true); setMessage(null);
    try {
      await apiFetch('/fpa/integrated/asset-register', { method: 'POST', data: {
        ...form,
        cost: Number(form.cost),
        useful_life_months: form.useful_life_months ? Number(form.useful_life_months) : null,
        salvage_value: form.salvage_value ? Number(form.salvage_value) : 0,
        data_source: 'management_input',
      }});
      setForm(prev => ({ ...prev, asset_name: '', cost: '', acquisition_date: '', useful_life_months: '', salvage_value: '' }));
      setMessage({ type: 'success', text: 'Asset added.' });
      if (onSave) onSave();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const active = (assetRegister || []).filter(a => a.active !== false);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>Fixed Asset Register (OI-009)</div>
        <div style={s.sectionSub}>Enter existing fixed assets for PPE roll-forward. Required to unblock RC-F12.</div>
      </div>

      <div style={s.card}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 12 }}>Add Asset</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <label style={s.label}>Asset Name *</label>
            <input type="text" value={form.asset_name} onChange={e => setF('asset_name', e.target.value)} placeholder="e.g. Workstations Batch 1" style={s.input} />
          </div>
          <div>
            <label style={s.label}>Category</label>
            <select value={form.asset_category} onChange={e => setF('asset_category', e.target.value)} style={s.input}>
              <option value="furniture">Furniture & Fixtures</option>
              <option value="it_equipment">IT Equipment</option>
              <option value="fit_out">Fit-out / Leasehold Improvements</option>
              <option value="vehicles">Vehicles</option>
              <option value="plant_machinery">Plant & Machinery</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label style={s.label}>Branch</label>
            <select value={form.branch_id} onChange={e => setF('branch_id', e.target.value)} style={s.input}>
              <option value="">Corporate / Multi-branch</option>
              {(branches || []).map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
            </select>
          </div>
          <div>
            <label style={s.label}>Cost (₹) *</label>
            <input type="number" value={form.cost} onChange={e => setF('cost', e.target.value)} placeholder="e.g. 5000000" style={s.input} />
          </div>
          <div>
            <label style={s.label}>Acquisition Date</label>
            <input type="date" value={form.acquisition_date} onChange={e => setF('acquisition_date', e.target.value)} style={s.input} />
          </div>
          <div>
            <label style={s.label}>Useful Life (months)</label>
            <input type="number" value={form.useful_life_months} onChange={e => setF('useful_life_months', e.target.value)} placeholder="e.g. 60" style={s.input} />
          </div>
          <div>
            <label style={s.label}>Salvage Value (₹)</label>
            <input type="number" value={form.salvage_value} onChange={e => setF('salvage_value', e.target.value)} placeholder="0" style={s.input} />
          </div>
        </div>
        {message && (
          <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 4, fontSize: 13,
            background: message.type === 'error' ? C.red + '22' : C.green + '22',
            color: message.type === 'error' ? C.red : C.green }}>
            {message.text}
          </div>
        )}
        <button onClick={handleAdd} disabled={saving} style={{ ...s.btn(), marginTop: 12 }}>
          {saving ? 'Adding…' : '+ Add Asset'}
        </button>
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8 }}>Registered Assets ({active.length})</div>
      {active.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: C.textMut, fontSize: 13 }}>No assets registered yet. Add above to enable PPE roll-forward (RC-F12).</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>{['Asset Name','Category','Branch','Cost (₹L)','Acquired','Useful Life','Monthly Dep (₹L)'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {active.map((a, i) => {
              const monthlyDep = a.cost && a.useful_life_months ? ((a.cost - (a.salvage_value || 0)) / a.useful_life_months) / 100000 : null;
              return (
                <tr key={a.asset_id} style={{ background: i % 2 === 0 ? 'transparent' : C.surfaceEl + '22' }}>
                  <td style={s.td}>{a.asset_name}</td>
                  <td style={s.td}>{a.asset_category}</td>
                  <td style={s.td}>{branchMap[a.branch_id]?.branch_name || a.branch_id || 'Corporate'}</td>
                  <td style={s.td}>{fmtL(a.cost / 100000)}</td>
                  <td style={s.td}>{a.acquisition_date || '—'}</td>
                  <td style={s.td}>{a.useful_life_months ? `${a.useful_life_months} mo` : '—'}</td>
                  <td style={s.td}>{monthlyDep != null ? fmtL(monthlyDep) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── GL Mapping Section ────────────────────────────────────────────────────────
// Note: account_mapping.json stores COA groupings (not individual GL account pairs).
// summary.auto_mapped + confirmed + resolved = effectively mapped count.
// The `mappings` array holds each COA grouping object.
function GLMappingSection({ glMapping, glData, onSave }) {
  const [form, setForm] = useState({ zoho_account_code: '', zoho_account_name: '', fpa_account_code: '', fpa_account_name: '', account_type: 'revenue', note: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [search, setSearch] = useState('');

  const setF = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleAdd = async () => {
    if (!form.zoho_account_code || !form.fpa_account_code) { setMessage({ type: 'error', text: 'Zoho account code and FP&A account code are required.' }); return; }
    setSaving(true); setMessage(null);
    try {
      await apiFetch('/fpa/integrated/account-mapping', { method: 'POST', data: { ...form, data_source: 'management_input' }});
      setForm(prev => ({ ...prev, zoho_account_code: '', zoho_account_name: '', fpa_account_code: '', fpa_account_name: '', note: '' }));
      setMessage({ type: 'success', text: 'Mapping added.' });
      if (onSave) onSave();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const active = (glMapping || []).filter(m => m.active !== false);
  const filtered = active.filter(m => !search ||
    (m.zoho_account_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (m.zoho_account_code || '').toLowerCase().includes(search.toLowerCase()));

  const glSummary = glData?.summary || {};
  const totalGroupings = glData?.total_groupings || active.length;
  const autoMapped = glSummary.auto_mapped || 0;
  const confirmed = glSummary.confirmed || 0;
  const resolved = glSummary.resolved || 0;
  const pendingReview = glSummary.pending_review || 0;
  const manualReview = glSummary.manual_review || 0;
  const effectivelyMapped = autoMapped + confirmed + resolved;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>GL → FP&A Account Mapping (OI-011)</div>
        <div style={s.sectionSub}>
          COA groupings mapped from Zoho Books Chart of Accounts. {effectivelyMapped}/{totalGroupings} groupings effectively mapped.
          <br/><span style={{ color: C.textMut }}>Note: This data holds COA groupings (not individual account pairs). Auto-mapped + confirmed + resolved = effectively mapped. Pending review items need management confirmation.</span>
        </div>
      </div>

      {totalGroupings > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Total Groupings', val: totalGroupings, color: C.textSec },
            { label: 'Auto Mapped', val: autoMapped, color: C.green },
            { label: 'Confirmed', val: confirmed, color: C.green },
            { label: 'Resolved', val: resolved, color: C.cyan },
            { label: 'Pending Review', val: pendingReview, color: C.yellow },
            { label: 'Manual Review', val: manualReview, color: C.orange },
          ].map(item => (
            <div key={item.label} style={{ ...s.card, marginBottom: 0, padding: '10px 16px', minWidth: 110 }}>
              <div style={{ fontSize: 11, color: C.textMut }}>{item.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: item.color }}>{item.val}</div>
            </div>
          ))}
        </div>
      )}

      {pendingReview > 0 && (
        <div style={{ padding: '10px 14px', background: C.yellow + '11', border: `1px solid ${C.yellow}44`, borderRadius: 6, marginBottom: 16, fontSize: 12, color: C.textSec }}>
          <strong style={{ color: C.yellow }}>OI-011 Open Item:</strong> {pendingReview} COA grouping(s) are pending review. To resolve: update the grouping's status to "confirmed" or "resolved" in account_mapping.json and run a re-sync. RC-F15 requires 0 pending_review items before production cutover.
        </div>
      )}

      <div style={s.card}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 12 }}>Add Mapping</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <label style={s.label}>Zoho Account Code *</label>
            <input type="text" value={form.zoho_account_code} onChange={e => setF('zoho_account_code', e.target.value)} placeholder="e.g. 4000001" style={s.input} />
          </div>
          <div>
            <label style={s.label}>Zoho Account Name</label>
            <input type="text" value={form.zoho_account_name} onChange={e => setF('zoho_account_name', e.target.value)} placeholder="e.g. Coworking Revenue" style={s.input} />
          </div>
          <div>
            <label style={s.label}>Account Type</label>
            <select value={form.account_type} onChange={e => setF('account_type', e.target.value)} style={s.input}>
              <option value="revenue">Revenue</option>
              <option value="direct_cost">Direct Cost</option>
              <option value="overhead">Overhead</option>
              <option value="asset">Asset</option>
              <option value="liability">Liability</option>
              <option value="equity">Equity</option>
              <option value="exclude">Exclude from FP&A</option>
            </select>
          </div>
          <div>
            <label style={s.label}>FP&A Account Code *</label>
            <input type="text" value={form.fpa_account_code} onChange={e => setF('fpa_account_code', e.target.value)} placeholder="e.g. REV-COWO" style={s.input} />
          </div>
          <div>
            <label style={s.label}>FP&A Account Name</label>
            <input type="text" value={form.fpa_account_name} onChange={e => setF('fpa_account_name', e.target.value)} placeholder="e.g. Coworking Revenue" style={s.input} />
          </div>
          <div>
            <label style={s.label}>Note</label>
            <input type="text" value={form.note} onChange={e => setF('note', e.target.value)} placeholder="Optional mapping note" style={s.input} />
          </div>
        </div>
        {message && (
          <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 4, fontSize: 13,
            background: message.type === 'error' ? C.red + '22' : C.green + '22',
            color: message.type === 'error' ? C.red : C.green }}>
            {message.text}
          </div>
        )}
        <button onClick={handleAdd} disabled={saving} style={{ ...s.btn(), marginTop: 12 }}>
          {saving ? 'Adding…' : '+ Add Mapping'}
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Existing Mappings ({active.length})</div>
        <input placeholder="Search accounts…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...s.input, width: 220 }} />
      </div>
      {filtered.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: C.textMut, fontSize: 13 }}>No GL mappings yet. Add above to resolve OI-011 and enable RC-F15.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>{['Zoho Code','Zoho Account','FP&A Code','FP&A Account','Type','Note'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {filtered.map((m, i) => (
              <tr key={m.mapping_id || i} style={{ background: i % 2 === 0 ? 'transparent' : C.surfaceEl + '22' }}>
                <td style={s.td}><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{m.zoho_account_code}</span></td>
                <td style={s.td}>{m.zoho_account_name || '—'}</td>
                <td style={s.td}><span style={{ fontFamily: 'monospace', fontSize: 12, color: C.accent }}>{m.fpa_account_code}</span></td>
                <td style={s.td}>{m.fpa_account_name || '—'}</td>
                <td style={s.td}><span style={s.badge(m.account_type === 'revenue' ? C.green : m.account_type === 'exclude' ? C.red : C.cyan)}>{m.account_type}</span></td>
                <td style={s.td}><span style={{ fontSize: 12, color: C.textMut }}>{m.note || '—'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Unmapped Revenue Section ──────────────────────────────────────────────────
function UnmappedRevenueSection({ unmapped, branches, onSave }) {
  const [saving, setSaving] = useState({});
  const [localVals, setLocalVals] = useState({});
  const [message, setMessage] = useState({});

  const branchMap = {};
  (branches || []).forEach(b => { branchMap[b.branch_id] = b; });

  const getVal = (inv, field) => {
    const key = `${inv.invoice_number}.${field}`;
    return key in localVals ? localVals[key] : (inv[field] ?? '');
  };

  const setVal = (inv, field, val) => {
    const key = `${inv.invoice_number}.${field}`;
    setLocalVals(prev => ({ ...prev, [key]: val }));
  };

  const handleSave = async (inv) => {
    const branchKey = `${inv.invoice_number}.branch_id`;
    const catKey = `${inv.invoice_number}.revenue_category`;
    const noteKey = `${inv.invoice_number}.classification_note`;
    setSaving(prev => ({ ...prev, [inv.invoice_number]: true }));
    try {
      const patch = {};
      if (branchKey in localVals) patch.branch_id = localVals[branchKey] || null;
      if (catKey in localVals) patch.revenue_category = localVals[catKey];
      if (noteKey in localVals) patch.classification_note = localVals[noteKey];
      await apiFetch(`/fpa/revenue/unmapped/${encodeURIComponent(inv.invoice_number)}`, { method: 'PUT', data: patch });
      setMessage(prev => ({ ...prev, [inv.invoice_number]: { type: 'success', text: '✓' } }));
      if (onSave) onSave();
    } catch (e) {
      setMessage(prev => ({ ...prev, [inv.invoice_number]: { type: 'error', text: e.message } }));
    } finally {
      setSaving(prev => ({ ...prev, [inv.invoice_number]: false }));
    }
  };

  const totalAmt = (unmapped || []).reduce((s, i) => s + (i.sub_total || 0), 0);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={s.sectionTitle}>Unmapped Revenue Review</div>
        <div style={s.sectionSub}>
          {(unmapped || []).length} invoices totalling {fmtR(totalAmt)} could not be mapped to a branch.
          Classify each as recurring/deposit/advance/adjustment, or assign to a branch.
        </div>
      </div>

      {(unmapped || []).length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.green, fontSize: 14 }}>
          ✓ No unmapped invoices. RC-F03 gap resolved.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>{['Invoice No.','Date','Customer','Amount (₹L)','Raw Branch','Assign Branch','Category','Note','Action'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {(unmapped || []).map((inv, i) => (
              <tr key={inv.invoice_number} style={{ background: i % 2 === 0 ? 'transparent' : C.surfaceEl + '22' }}>
                <td style={s.td}><span style={{ fontFamily: 'monospace', fontSize: 11 }}>{inv.invoice_number}</span></td>
                <td style={s.td}>{inv.date}</td>
                <td style={s.td}><span style={{ fontSize: 12 }}>{inv.customer_name || '—'}</span></td>
                <td style={s.td}>{fmtR(inv.sub_total)}</td>
                <td style={s.td}><span style={{ fontSize: 11, color: C.yellow }}>{inv.branch_name_raw || '—'}</span></td>
                <td style={s.td}>
                  <select value={getVal(inv, 'branch_id')} onChange={e => setVal(inv, 'branch_id', e.target.value)}
                    style={{ ...s.input, width: 160, fontSize: 11 }}>
                    <option value="">Unassigned</option>
                    {(branches || []).map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
                  </select>
                </td>
                <td style={s.td}>
                  <select value={getVal(inv, 'revenue_category')} onChange={e => setVal(inv, 'revenue_category', e.target.value)}
                    style={{ ...s.input, width: 130, fontSize: 11 }}>
                    <option value="">Unclassified</option>
                    <option value="recurring">Recurring</option>
                    <option value="deposit">Security Deposit</option>
                    <option value="advance">Advance Payment</option>
                    <option value="adjustment">Adjustment</option>
                    <option value="non_recurring">Non-Recurring</option>
                  </select>
                </td>
                <td style={s.td}>
                  <input type="text" value={getVal(inv, 'classification_note')} onChange={e => setVal(inv, 'classification_note', e.target.value)}
                    placeholder="Optional" style={{ ...s.input, width: 140, fontSize: 11 }} />
                </td>
                <td style={s.td}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={() => handleSave(inv)} disabled={saving[inv.invoice_number]}
                      style={{ ...s.btn('primary'), fontSize: 11, padding: '4px 10px' }}>
                      {saving[inv.invoice_number] ? '…' : 'Save'}
                    </button>
                    {message[inv.invoice_number] && (
                      <span style={{ fontSize: 11, color: message[inv.invoice_number].type === 'success' ? C.green : C.red }}>
                        {message[inv.invoice_number].text}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Main ManagementInputsTab ──────────────────────────────────────────────────
export default function ManagementInputsTab() {
  const [subTab, setSubTab] = useState('readiness');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({
    branches: [],
    clients: [],
    assumptions: [],
    costMaster: [],
    debtSchedule: [],
    obsData: null,
    assetRegister: [],
    glMapping: [],
    glData: null,
    unmapped: [],
    globalAssumptions: {},
  });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [branchRes, clientRes, assumptionsRes, costRes, debtRes, obsRes, assetRes, glRes, unmappedRes, globalRes] = await Promise.all([
        apiFetch('/fpa/branch-master'),
        apiFetch('/fpa/client-master'),
        apiFetch('/fpa/projection/assumptions'),
        apiFetch('/fpa/cost/cost-master'),
        apiFetch('/fpa/integrated/debt-schedule'),
        apiFetch('/fpa/integrated/opening-balance-sheet'),
        apiFetch('/fpa/integrated/asset-register'),
        apiFetch('/fpa/integrated/account-mapping'),
        apiFetch('/fpa/revenue/unmapped'),
        apiFetch('/fpa/global-assumptions'),
      ]);
      setData({
        branches: branchRes.branches || [],
        clients: clientRes.clients || [],
        assumptions: assumptionsRes.assumptions || [],
        costMaster: costRes.assumptions || [],
        debtSchedule: debtRes.facilities || debtRes.debt_schedule || [],
        obsData: obsRes,
        assetRegister: assetRes.assets || assetRes.asset_register || [],
        glMapping: glRes.mappings || glRes.account_mapping || [],
        glData: glRes,
        unmapped: unmappedRes.records || [],
        globalAssumptions: globalRes || {},
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, color: C.textMut, fontSize: 14 }}>
      Loading management inputs…
    </div>
  );

  if (error) return (
    <div style={{ padding: 20, color: C.red, fontSize: 13 }}>
      Error loading data: {error}
      <button onClick={load} style={{ ...s.btn(), marginLeft: 12, fontSize: 12 }}>Retry</button>
    </div>
  );

  const navigate = (tab) => setSubTab(tab);

  return (
    <div style={{ color: C.text }}>
      {/* Header */}
      <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Management Inputs — Step 13</div>
        <div style={{ fontSize: 13, color: C.textSec, marginTop: 4 }}>
          Complete all sections before generating a forecast baseline. No inputs are auto-assumed.
        </div>
      </div>

      {/* Sub-tab nav */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, flexWrap: 'wrap' }}>
        {SUB_TABS.map(t => (
          <button key={t.id} onClick={() => setSubTab(t.id)}
            style={{
              padding: '6px 14px', borderRadius: 4, border: `1px solid ${subTab === t.id ? C.accent : C.border}`,
              background: subTab === t.id ? C.accent + '22' : 'transparent',
              color: subTab === t.id ? C.accent : C.textSec,
              cursor: 'pointer', fontSize: 12, fontWeight: 500,
            }}>
            {t.icon} {t.label}
          </button>
        ))}
        <button onClick={load} style={{ ...s.btn('default'), fontSize: 12, marginLeft: 'auto' }}>↺ Refresh</button>
      </div>

      {/* Content */}
      <div>
        {subTab === 'readiness' && (
          <ReadinessSection
            branches={data.branches}
            debtSchedule={data.debtSchedule}
            assumptions={data.assumptions}
            costMaster={data.costMaster}
            obsData={data.obsData}
            assetRegister={data.assetRegister}
            glMapping={data.glMapping}
            glData={data.glData}
            unmapped={data.unmapped}
            onNavigate={navigate}
          />
        )}
        {subTab === 'branch' && (
          <BranchAssumptionsSection branches={data.branches} onSave={load} />
        )}
        {subTab === 'future_branch' && (
          <FutureBranchesSection onSave={load} />
        )}
        {subTab === 'client_revenue' && (
          <ClientRevenueSection
            assumptions={data.assumptions}
            clients={data.clients}
            branches={data.branches}
            onSave={load}
          />
        )}
        {subTab === 'cost_master' && (
          <CostMasterSection costMaster={data.costMaster} branches={data.branches} onSave={load} />
        )}
        {subTab === 'debt' && (
          <DebtWorkspaceSection debtSchedule={data.debtSchedule} onSave={load} />
        )}
        {subTab === 'utilities' && (
          <UtilitiesSection globalAssumptions={data.globalAssumptions} onSave={load} />
        )}
        {subTab === 'opening_bs' && (
          <OpeningBSSection obsData={data.obsData} onSave={load} />
        )}
        {subTab === 'asset_register' && (
          <AssetRegisterSection assetRegister={data.assetRegister} branches={data.branches} onSave={load} />
        )}
        {subTab === 'gl_mapping' && (
          <GLMappingSection glMapping={data.glMapping} glData={data.glData} onSave={load} />
        )}
        {subTab === 'unmapped_revenue' && (
          <UnmappedRevenueSection unmapped={data.unmapped} branches={data.branches} onSave={load} />
        )}
      </div>
    </div>
  );
}
