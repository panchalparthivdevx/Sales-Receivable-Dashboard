import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtINR = (n, opts = {}) => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  let str;
  if (abs >= 1e7) str = '₹' + (n / 1e7).toFixed(2) + ' Cr';
  else if (abs >= 1e5) str = '₹' + (n / 1e5).toFixed(2) + ' L';
  else str = '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return str;
};

const fmtFull = (n) => {
  if (n == null || isNaN(n)) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

const fmtPct = (n) => {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(2) + '%';
};

function fmtMonthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return (names[parseInt(m, 10) - 1] || m) + ' ' + y;
}

// ── Date helpers ──────────────────────────────────────────────────────────────
// Indian FY quarter: Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar
function getIndianFYQuarter(ym) {
  const m = parseInt(ym.substring(5, 7));
  if (m >= 4 && m <= 6)  return 1;
  if (m >= 7 && m <= 9)  return 2;
  if (m >= 10 && m <= 12) return 3;
  return 4;
}

const QUARTER_LABELS = { 1: 'Q1 (Apr–Jun)', 2: 'Q2 (Jul–Sep)', 3: 'Q3 (Oct–Dec)', 4: 'Q4 (Jan–Mar)' };

// ── Quarterly Project Value / Cost estimates ──────────────────────────────────
function fyLabel(fy) { return `${fy}-${String(fy + 1).slice(2)}`; }
function qeSortKey(fy, quarter) { return fy * 10 + quarter; }
function quarterEndDate(fy, quarter) {
  return { 1: `${fy}-06-30`, 2: `${fy}-09-30`, 3: `${fy}-12-31`, 4: `${fy + 1}-03-31` }[quarter];
}
function getCurrentFYQuarter() {
  const now = new Date();
  const fy = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return { fy, quarter: getIndianFYQuarter(ym) };
}
// The snapshot whose quarter contains, or most recently precedes, (fy, quarter) —
// i.e. what was "in effect" at that point in time. Falls back to the project's
// opening value/cost when no snapshot at or before it exists yet.
function resolveEstimateAsOf(project, snapshots, fy, quarter) {
  const targetKey = qeSortKey(fy, quarter);
  let best = null, bestKey = -1;
  for (const s of snapshots) {
    if (s.projectId !== project.id) continue;
    const k = qeSortKey(s.fy, s.quarter);
    if (k <= targetKey && k > bestKey) { best = s; bestKey = k; }
  }
  if (best) return { value: best.projectValue, estCost: best.projectCost, snapshot: best };
  return { value: parseFloat(project.value) || 0, estCost: parseFloat(project.estimatedCost) || 0, snapshot: null };
}
// Latest confirmed snapshot for a project, regardless of FY (for card display / "as of today")
function getLatestSnapshot(project, snapshots) {
  let best = null, bestKey = -1;
  for (const s of snapshots) {
    if (s.projectId !== project.id) continue;
    const k = qeSortKey(s.fy, s.quarter);
    if (k > bestKey) { best = s; bestKey = k; }
  }
  return best;
}
// Chronological list of every quarter-end snapshot for a project, PLUS a synthetic
// "Opening Estimate" row at the start — used by the View History modal.
function getProjectHistory(project, snapshots) {
  const mine = snapshots.filter(s => s.projectId === project.id).sort((a, b) => qeSortKey(a.fy, a.quarter) - qeSortKey(b.fy, b.quarter));
  const opening = {
    label: 'Opening Estimate', updateType: 'Original',
    projectValue: parseFloat(project.value) || 0, projectCost: parseFloat(project.estimatedCost) || 0,
    updatedBy: '—', updatedAt: null,
  };
  opening.estimatedProfit    = opening.projectValue - opening.projectCost;
  opening.estimatedProfitPct = opening.projectValue > 0 ? (opening.estimatedProfit / opening.projectValue) * 100 : 0;
  const rows = [opening, ...mine.map(s => ({ ...s, label: `Q${s.quarter} FY ${fyLabel(s.fy)}` }))];
  return rows.map((row, i) => ({
    ...row,
    deltaValue: i === 0 ? null : row.projectValue - rows[i - 1].projectValue,
    deltaCost:  i === 0 ? null : row.projectCost  - rows[i - 1].projectCost,
  }));
}

function getMonthsBetween(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const s = new Date(startDate);
  const e = new Date(endDate);
  const today = new Date();
  // Note: startDate/endDate are date-only ISO strings (parsed as UTC midnight),
  // so read them back with UTC getters — mixing local-constructed dates with
  // toISOString() (UTC) here previously shifted every month key back by one
  // in any positive-offset timezone (e.g. IST), silently dropping the most
  // recent month from every table.
  let y = s.getUTCFullYear(), m = s.getUTCMonth();
  const eY = e.getUTCFullYear(), eM = e.getUTCMonth();
  const tY = today.getFullYear(), tM = today.getMonth();
  const capIsEnd = eY < tY || (eY === tY && eM < tM);
  const capY = capIsEnd ? eY : tY;
  const capM = capIsEnd ? eM : tM;
  const months = [];
  while (y < capY || (y === capY && m <= capM)) {
    months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return months;
}

function projectDurationMonths(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const s = new Date(startDate);
  const e = new Date(endDate);
  return Math.max(0, (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1);
}

// ── POCM Calculation ──────────────────────────────────────────────────────────
// quarterlySnapshots (optional): every confirmed Quarterly Update snapshot, across
// ALL projects — filtered internally to this project. For each month, the
// applicable Project Value / Estimated Cost is whichever snapshot was "in effect"
// for that month's quarter (the snapshot at or most recently before it), NOT
// today's latest estimate. This is what keeps a Q3 revision from silently
// recalculating Q1/Q2's already-reported POCM figures.
function computePOCM(project, monthlyData, fyYear, quarterlySnapshots = []) {
  const openingValue = parseFloat(project.value) || 0;
  const openingCost  = parseFloat(project.estimatedCost) || 0;
  if (!openingValue || !openingCost) return [];

  const fyStart  = `${fyYear}-04-01`;
  const fyEnd    = `${fyYear + 1}-03-31`;
  // Cap months at the earlier of project end or FY end
  const endCap   = project.endDate && project.endDate < fyEnd ? project.endDate : fyEnd;
  const months   = getMonthsBetween(fyStart, endCap);
  let cumCost = 0;
  let cumRevenue = 0;
  let cumGross = 0;
  let cumNet = 0;
  let cumActualRevenue = 0;

  return months.map(month => {
    const quarter = getIndianFYQuarter(month);
    const { value, estCost } = resolveEstimateAsOf(project, quarterlySnapshots, fyYear, quarter);

    const md = monthlyData?.byMonth?.[month] || {};
    const projectCost    = md.projectCost    || 0;
    const salaries       = md.salaries       || 0;
    const marketing      = md.marketing      || 0;
    const travelling     = md.travelling     || 0;
    const other          = md.other          || 0;
    const actualRevenue  = md.actualRevenue  || 0;

    cumCost += projectCost;
    const pct = estCost > 0 ? Math.min((cumCost / estCost) * 100, 100) : 0;
    const revToDate = value * (pct / 100);
    const revThisMonth = revToDate - cumRevenue;
    cumRevenue = revToDate;

    const grossProfit = revThisMonth - projectCost;
    const netProfit1  = grossProfit - salaries - travelling;
    const overhead = salaries + marketing + travelling + other;
    const netProfit = grossProfit - overhead;
    cumGross += grossProfit;
    cumNet   += netProfit;
    cumActualRevenue += actualRevenue;
    const revenueProvision = revThisMonth - actualRevenue;

    return {
      month, projectCost, salaries, marketing, travelling, other,
      cumCost, pct, revThisMonth, cumRevenue, grossProfit, netProfit1, netProfit,
      overhead, cumGross, cumNet, actualRevenue, cumActualRevenue, revenueProvision,
      appliedValue: value, appliedCost: estCost, quarter, // which quarter's estimate was used this month
    };
  });
}

// ── Status badge ─────────────────────────────────────────────────────────────
// Uses the LATEST row's applied value/cost (this quarter's in-effect estimate)
// rather than the project's opening figures, so the badge reflects the current
// quarterly estimate once one has been confirmed.
function getProjectStatus(project, rows) {
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const value = last ? last.appliedValue : (parseFloat(project.value) || 0);
  const estCost = last ? last.appliedCost : (parseFloat(project.estimatedCost) || 0);
  const estProfit = value - estCost;
  if (estProfit < 0) return { label: 'Loss Making Project', color: '#ef4444', bg: 'rgba(239,68,68,0.12)', icon: '🔴' };
  const cumCost = last ? last.cumCost : 0;
  if (cumCost > estCost) return { label: 'Cost Overrun', color: '#f97316', bg: 'rgba(249,115,22,0.12)', icon: '⚠' };
  return { label: 'On Track', color: '#22c55e', bg: 'rgba(34,197,94,0.12)', icon: '✅' };
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  page:    { padding: '1.5rem', background: '#F9F9F9', minHeight: '100vh', color: '#18191B' },
  header:  { marginBottom: '1.5rem' },
  title:   { color: '#18191B', fontSize: '1.3rem', fontWeight: 700, margin: 0 },
  sub:     { color: '#5D6C7B', fontSize: '0.8rem', marginTop: 4 },
  tabs:    { display: 'flex', gap: 4, marginBottom: '1.5rem', borderBottom: '1px solid #DFE7E3', paddingBottom: 0 },
  tab:     (active) => ({
    padding: '0.55rem 1.1rem', fontSize: '0.82rem', fontWeight: 600,
    cursor: 'pointer', border: 'none', background: 'none',
    color: active ? '#1C4942' : '#5D6C7B',
    borderBottom: active ? '2px solid #1C4942' : '2px solid transparent',
    transition: 'color 0.15s',
  }),
  card:    { background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3', padding: '1.25rem', marginBottom: '1rem' },
  kpiGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '0.85rem', marginBottom: '1.5rem' },
  kpiBox:  { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '0.9rem 1rem' },
  kpiVal:  { fontSize: '1.25rem', fontWeight: 700, lineHeight: 1.2, color: '#18191B' },
  kpiLbl:  { color: '#5D6C7B', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 5 },
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' },
  th:      { padding: '0.55rem 0.75rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', textAlign: 'right' },
  thLeft:  { padding: '0.55rem 0.75rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', textAlign: 'left' },
  td:      { padding: '0.55rem 0.75rem', color: '#9BA8B0', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  tdLeft:  { padding: '0.55rem 0.75rem', color: '#18191B', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', textAlign: 'left' },
  btn:     { background: '#1C4942', color: '#fff', border: 'none', borderRadius: 7, padding: '0.5rem 1.1rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' },
  btnSm:   { background: '#EAF4EF', color: '#1C4942', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.3rem 0.7rem', fontSize: '0.75rem', cursor: 'pointer' },
  btnDng:  { background: 'none', color: '#DC2626', border: '1px solid #DC2626', borderRadius: 6, padding: '0.3rem 0.7rem', fontSize: '0.75rem', cursor: 'pointer' },
  label:   { color: '#5D6C7B', fontSize: '0.75rem', fontWeight: 600, display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.03em' },
  input:   { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, color: '#18191B', padding: '0.5rem 0.75rem', fontSize: '0.82rem', width: '100%', boxSizing: 'border-box' },
  select:  { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, color: '#18191B', padding: '0.5rem 0.75rem', fontSize: '0.82rem', width: '100%', boxSizing: 'border-box' },
  row2:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' },
  row3:    { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' },
  notice:  { background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 8, padding: '0.85rem 1rem', color: '#B45309', fontSize: '0.8rem', marginBottom: '1.25rem' },
  divider: { height: 1, background: '#DFE7E3', margin: '1rem 0' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  modalBox: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, width: '95vw', maxHeight: '85vh', overflowY: 'auto', padding: '1.5rem' },
  positive: '#15803D',
  negative: '#DC2626',
  neutral:  '#1C4942',
};

// ── Project Form ──────────────────────────────────────────────────────────────
function ProjectForm({ initial, onSave, onCancel }) {
  const blank = { name: '', client: '', value: '', estimatedCost: '', startDate: '', endDate: '', zohoProjectName: '' };
  const [form, setForm] = useState(initial ? { ...initial, value: initial.value || '', estimatedCost: initial.estimatedCost || '' } : blank);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [zohoProjects, setZohoProjects] = useState([]);

  useEffect(() => {
    api.pocmZohoProjects().then(setZohoProjects).catch(() => {});
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const dur = projectDurationMonths(form.startDate, form.endDate);
  const estProfit = (parseFloat(form.value) || 0) - (parseFloat(form.estimatedCost) || 0);
  const estPct = form.value ? (estProfit / parseFloat(form.value)) * 100 : 0;

  async function handleSave() {
    if (!form.name) return setErr('Project name is required.');
    if (!form.value || isNaN(form.value)) return setErr('Project Value must be a number.');
    if (!form.estimatedCost || isNaN(form.estimatedCost)) return setErr('Estimated Cost must be a number.');
    if (!form.startDate) return setErr('Start Date is required.');
    if (!form.endDate) return setErr('End Date is required.');
    if (!form.zohoProjectName) return setErr('Zoho Project Name is required — needed to fetch COGS from Zoho Books.');
    setErr(''); setSaving(true);
    try {
      await onSave({ ...form, value: parseFloat(form.value), estimatedCost: parseFloat(form.estimatedCost) });
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={S.card}>
      <div style={{ fontWeight: 700, color: '#18191B', marginBottom: '1.25rem', fontSize: '0.95rem' }}>
        {initial ? 'Edit Project' : 'Add New Project'}
      </div>

      <div style={S.row2}>
        <div>
          <label style={S.label}>Project / Contract Name *</label>
          {zohoProjects.length > 0 ? (
            <select
              style={S.select}
              value={form.zohoProjectName}
              onChange={e => {
                const selected = zohoProjects.find(p => p.name === e.target.value);
                setForm(f => ({
                  ...f,
                  zohoProjectName: e.target.value,
                  name: selected ? selected.name : e.target.value,
                  client: selected?.customer_name || f.client,
                }));
              }}
            >
              <option value="">— select project from Zoho Books —</option>
              {zohoProjects.map(p => (
                <option key={p.id} value={p.name}>
                  {p.name}{p.status && p.status !== 'active' ? ` (${p.status})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input style={S.input} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Arvind_Limited_AHD" />
          )}
        </div>
        <div>
          <label style={S.label}>Client Name <span style={{ color: '#5D6C7B', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(auto-filled from Zoho)</span></label>
          <input style={S.input} value={form.client} onChange={e => set('client', e.target.value)} placeholder="Auto-filled when project is selected" />
        </div>
      </div>

      <div style={S.row3}>
        <div>
          <label style={S.label}>Project / Contract Value (₹) *</label>
          <input style={S.input} type="number" value={form.value} onChange={e => set('value', e.target.value)} placeholder="e.g. 5000000" />
        </div>
        <div>
          <label style={S.label}>Total Estimated Project Cost (₹) *</label>
          <input style={S.input} type="number" value={form.estimatedCost} onChange={e => set('estimatedCost', e.target.value)} placeholder="e.g. 4000000" />
        </div>
        <div>
          <label style={S.label}>Project Duration (Months)</label>
          <input style={{ ...S.input, background: '#F9F9F9', color: '#5D6C7B' }} value={dur > 0 ? dur + ' months' : '—'} readOnly />
        </div>
      </div>

      <div style={S.row2}>
        <div>
          <label style={S.label}>Project Start Date *</label>
          <input style={S.input} type="date" value={form.startDate} onChange={e => set('startDate', e.target.value)} />
        </div>
        <div>
          <label style={S.label}>Project End Date *</label>
          <input style={S.input} type="date" value={form.endDate} onChange={e => set('endDate', e.target.value)} />
        </div>
      </div>

      {form.value && form.estimatedCost && (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
          <div style={{ ...S.kpiBox, flex: 1 }}>
            <div style={{ ...S.kpiVal, color: estProfit >= 0 ? S.positive : S.negative }}>{fmtFull(estProfit)}</div>
            <div style={S.kpiLbl}>Estimated Profit</div>
          </div>
          <div style={{ ...S.kpiBox, flex: 1 }}>
            <div style={{ ...S.kpiVal, color: estPct >= 0 ? S.positive : S.negative }}>{fmtPct(estPct)}</div>
            <div style={S.kpiLbl}>Estimated Profit %</div>
          </div>
        </div>
      )}

      {err && <div style={{ color: '#DC2626', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={S.btn} onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Project'}</button>
        <button style={{ ...S.btn, background: '#FFFFFF', color: '#9BA8B0', border: '1px solid #DFE7E3' }} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Project Card ──────────────────────────────────────────────────────────────
function ProjectCard({ project, snapshots, onEdit, onDelete, onSelect, onQuarterlyUpdate, onViewHistory }) {
  const latest = getLatestSnapshot(project, snapshots);
  const value = latest ? latest.projectValue : (parseFloat(project.value) || 0);
  const estCost = latest ? latest.projectCost : (parseFloat(project.estimatedCost) || 0);
  const estProfit = value - estCost;
  const estPct = value ? (estProfit / value) * 100 : 0;
  const dur = projectDurationMonths(project.startDate, project.endDate);
  const isLoss = estProfit < 0;

  return (
    <div style={{ ...S.card, cursor: 'pointer' }} onClick={() => onSelect(project)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.85rem' }}>
        <div>
          <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>{project.name}</div>
          {project.client && <div style={{ color: '#5D6C7B', fontSize: '0.78rem', marginTop: 2 }}>Client: {project.client}</div>}
          {project.zohoProjectName && <div style={{ color: '#5D6C7B', fontSize: '0.72rem', marginTop: 1 }}>Zoho Project: {project.zohoProjectName}</div>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button style={S.btnSm} onClick={e => { e.stopPropagation(); onQuarterlyUpdate(project); }}>Quarterly Update</button>
          <button style={S.btnSm} onClick={e => { e.stopPropagation(); onViewHistory(project); }}>View History</button>
          <button style={S.btnSm} onClick={e => { e.stopPropagation(); onEdit(project); }}>Edit</button>
          <button style={S.btnDng} onClick={e => { e.stopPropagation(); onDelete(project.id); }}>Delete</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', marginBottom: '0.6rem' }}>
        {[
          { label: 'Project Value', val: fmtINR(value), color: '#1C4942' },
          { label: 'Est. Cost', val: fmtINR(estCost), color: '#9BA8B0' },
          { label: 'Est. Profit', val: fmtINR(estProfit), color: isLoss ? S.negative : S.positive },
          { label: 'Profit %', val: fmtPct(estPct), color: isLoss ? S.negative : S.positive },
        ].map(kpi => (
          <div key={kpi.label} style={{ background: '#F9F9F9', borderRadius: 7, padding: '0.5rem 0.75rem' }}>
            <div style={{ color: kpi.color, fontWeight: 700, fontSize: '0.88rem' }}>{kpi.val}</div>
            <div style={{ color: '#9BA8B0', fontSize: '0.67rem', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{kpi.label}</div>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: '0.85rem', fontSize: '0.7rem', color: '#9BA8B0' }}>
        {latest
          ? <span>Latest Estimate: <span style={{ color: '#1C4942' }}>Q{latest.quarter} FY {fyLabel(latest.fy)}</span></span>
          : <span>Latest Estimate: <span style={{ color: '#5D6C7B' }}>Opening (no quarterly update yet)</span></span>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ color: '#9BA8B0', fontSize: '0.75rem' }}>
          {project.startDate} → {project.endDate}
          {dur > 0 && <span style={{ marginLeft: 8, color: '#5D6C7B' }}>({dur} months)</span>}
        </div>
        {isLoss
          ? <span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: 4, background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)' }}>🔴 Loss Making</span>
          : <span style={{ fontSize: '0.72rem', padding: '2px 8px', borderRadius: 4, background: 'rgba(34,197,94,0.1)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)' }}>✅ Estimated Profitable</span>
        }
      </div>
    </div>
  );
}

// ── Quarterly Update Modal ────────────────────────────────────────────────────
function QuarterlyUpdateModal({ project, snapshots, user, onClose, onSaved }) {
  const cur = getCurrentFYQuarter();
  const [fy, setFy]           = useState(cur.fy);
  const [quarter, setQuarter] = useState(cur.quarter);
  const [mode, setMode]       = useState('update'); // 'update' | 'same'
  const [revValue, setRevValue] = useState('');
  const [revCost, setRevCost]   = useState('');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');

  const isAdmin = user?.role === 'admin';
  const existing = snapshots.find(s => s.projectId === project.id && s.fy === fy && s.quarter === quarter);
  // Previous quarter's applicable estimate — the snapshot strictly before (fy, quarter)
  const prevEstimate = (() => {
    const targetKey = qeSortKey(fy, quarter);
    let best = null, bestKey = -1;
    for (const s of snapshots) {
      if (s.projectId !== project.id) continue;
      const k = qeSortKey(s.fy, s.quarter);
      if (k < targetKey && k > bestKey) { best = s; bestKey = k; }
    }
    if (best) return { value: best.projectValue, cost: best.projectCost };
    return { value: parseFloat(project.value) || 0, cost: parseFloat(project.estimatedCost) || 0 };
  })();

  const locked = existing && !isAdmin;

  useEffect(() => {
    if (existing) { setRevValue(String(existing.projectValue)); setRevCost(String(existing.projectCost)); setMode('update'); }
    else { setRevValue(''); setRevCost(''); setMode('update'); }
  }, [fy, quarter]); // eslint-disable-line react-hooks/exhaustive-deps

  const profit = (parseFloat(revValue) || 0) - (parseFloat(revCost) || 0);
  const profitPct = revValue ? (profit / parseFloat(revValue)) * 100 : 0;

  async function handleConfirm() {
    setErr('');
    if (mode === 'update') {
      if (!revValue || isNaN(revValue)) return setErr('Revised Project Value is required.');
      if (!revCost || isNaN(revCost))   return setErr('Revised Project Cost is required.');
    }
    setSaving(true);
    try {
      await api.pocmSaveQuarterlyEstimate({
        projectId: project.id, fy, quarter,
        updateType: mode === 'update' ? 'Updated' : 'Same as Previous Quarter',
        projectValue: mode === 'update' ? parseFloat(revValue) : prevEstimate.value,
        projectCost:  mode === 'update' ? parseFloat(revCost)  : prevEstimate.cost,
      });
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally { setSaving(false); }
  }

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={{ ...S.modalBox, maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, color: '#18191B', fontSize: '0.95rem', marginBottom: 4 }}>Quarterly Update</div>
        <div style={{ color: '#5D6C7B', fontSize: '0.8rem', marginBottom: '1rem' }}>{project.name}</div>

        <div style={S.row2}>
          <div>
            <label style={S.label}>Financial Year</label>
            <select style={S.select} value={fy} onChange={e => setFy(parseInt(e.target.value, 10))}>
              {FY_OPTIONS.map(o => <option key={o.value} value={o.value}>FY {o.label}</option>)}
            </select>
          </div>
          <div>
            <label style={S.label}>Quarter</label>
            <select style={S.select} value={quarter} onChange={e => setQuarter(parseInt(e.target.value, 10))}>
              {[1, 2, 3, 4].map(q => <option key={q} value={q}>{QUARTER_LABELS[q]}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
          <div style={{ ...S.kpiBox, flex: 1 }}>
            <div style={{ ...S.kpiVal, fontSize: '0.95rem' }}>{fmtFull(prevEstimate.value)}</div>
            <div style={S.kpiLbl}>Previous Quarter Project Value</div>
          </div>
          <div style={{ ...S.kpiBox, flex: 1 }}>
            <div style={{ ...S.kpiVal, fontSize: '0.95rem' }}>{fmtFull(prevEstimate.cost)}</div>
            <div style={S.kpiLbl}>Previous Quarter Project Cost</div>
          </div>
        </div>

        {locked ? (
          <div style={{ ...S.notice, marginBottom: '1rem' }}>
            This quarter has already been updated — by {existing.updatedBy} on {new Date(existing.updatedAt).toLocaleString('en-IN')}.
            {' '}Value {fmtFull(existing.projectValue)}, Cost {fmtFull(existing.projectCost)} ({existing.updateType}).
            Only an admin can amend a confirmed quarter.
          </div>
        ) : (
          <>
            {existing && isAdmin && (
              <div style={{ ...S.notice, marginBottom: '1rem' }}>
                ⚠ This quarter was already confirmed by {existing.updatedBy} on {new Date(existing.updatedAt).toLocaleString('en-IN')}.
                Saving again will amend it — the previous values are retained in the audit trail.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: '1rem' }}>
              <button onClick={() => setMode('update')}
                style={{ ...S.btnSm, flex: 1, textAlign: 'center', ...(mode === 'update' ? { background: '#1C4942', color: '#fff', borderColor: '#1C4942' } : {}) }}>
                Update
              </button>
              <button onClick={() => setMode('same')}
                style={{ ...S.btnSm, flex: 1, textAlign: 'center', ...(mode === 'same' ? { background: '#1C4942', color: '#fff', borderColor: '#1C4942' } : {}) }}>
                Same as Previous Quarter
              </button>
            </div>

            {mode === 'update' ? (
              <>
                <div style={S.row2}>
                  <div>
                    <label style={S.label}>Revised Project Value (₹) *</label>
                    <input style={S.input} type="number" value={revValue} onChange={e => setRevValue(e.target.value)} />
                  </div>
                  <div>
                    <label style={S.label}>Revised Project Cost (₹) *</label>
                    <input style={S.input} type="number" value={revCost} onChange={e => setRevCost(e.target.value)} />
                  </div>
                </div>
                {revValue && revCost && (
                  <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
                    <div style={{ ...S.kpiBox, flex: 1 }}>
                      <div style={{ ...S.kpiVal, color: profit >= 0 ? S.positive : S.negative }}>{fmtFull(profit)}</div>
                      <div style={S.kpiLbl}>Estimated Profit</div>
                    </div>
                    <div style={{ ...S.kpiBox, flex: 1 }}>
                      <div style={{ ...S.kpiVal, color: profitPct >= 0 ? S.positive : S.negative }}>{fmtPct(profitPct)}</div>
                      <div style={S.kpiLbl}>Estimated Profit %</div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ ...S.notice, background: '#EAF4EF', borderColor: '#A7C4BC', color: '#1C4942' }}>
                Will carry forward: Project Value {fmtFull(prevEstimate.value)}, Project Cost {fmtFull(prevEstimate.cost)} — no entry required.
              </div>
            )}

            {err && <div style={{ color: '#DC2626', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{err}</div>}

            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.btn} onClick={handleConfirm} disabled={saving}>{saving ? 'Saving…' : 'Confirm'}</button>
              <button style={{ ...S.btn, background: '#FFFFFF', color: '#9BA8B0', border: '1px solid #DFE7E3' }} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {locked && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...S.btn, background: '#FFFFFF', color: '#9BA8B0', border: '1px solid #DFE7E3' }} onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── View History Modal ────────────────────────────────────────────────────────
function HistoryModal({ project, snapshots, onClose }) {
  const rows = getProjectHistory(project, snapshots);
  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={{ ...S.modalBox, maxWidth: 780 }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, color: '#18191B', fontSize: '0.95rem', marginBottom: 4 }}>Quarter-wise Estimate History</div>
        <div style={{ color: '#5D6C7B', fontSize: '0.8rem', marginBottom: '1rem' }}>{project.name}</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.thLeft}>Quarter</th>
                <th style={S.th}>Project Value</th>
                <th style={S.th}>Δ Value</th>
                <th style={S.th}>Project Cost</th>
                <th style={S.th}>Δ Cost</th>
                <th style={S.th}>Est. Profit</th>
                <th style={S.th}>Profit %</th>
                <th style={S.thLeft}>Update Type</th>
                <th style={S.thLeft}>Updated By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={S.tdLeft}>{r.label}</td>
                  <td style={S.td}>{fmtFull(r.projectValue)}</td>
                  <td style={{ ...S.td, color: r.deltaValue == null ? '#9BA8B0' : r.deltaValue > 0 ? S.positive : r.deltaValue < 0 ? S.negative : '#9BA8B0' }}>
                    {r.deltaValue == null ? '—' : (r.deltaValue > 0 ? '+' : '') + fmtFull(r.deltaValue)}
                  </td>
                  <td style={S.td}>{fmtFull(r.projectCost)}</td>
                  <td style={{ ...S.td, color: r.deltaCost == null ? '#9BA8B0' : r.deltaCost > 0 ? S.negative : r.deltaCost < 0 ? S.positive : '#9BA8B0' }}>
                    {r.deltaCost == null ? '—' : (r.deltaCost > 0 ? '+' : '') + fmtFull(r.deltaCost)}
                  </td>
                  <td style={S.td}>{fmtFull(r.estimatedProfit)}</td>
                  <td style={S.td}>{fmtPct(r.estimatedProfitPct)}</td>
                  <td style={S.tdLeft}>{r.updateType}</td>
                  <td style={S.tdLeft}>
                    {r.updatedBy}
                    {r.updatedAt && <div style={{ color: '#9BA8B0', fontSize: '0.68rem' }}>{new Date(r.updatedAt).toLocaleString('en-IN')}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: '1.25rem' }}>
          <button style={{ ...S.btn, background: '#FFFFFF', color: '#9BA8B0', border: '1px solid #DFE7E3' }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Drill-Down Modal ──────────────────────────────────────────────────────────
function DrillDown({ title, rows, creditRows, onClose, type, quarterBreakdown }) {
  if (!rows) return null;
  const isRevenue  = type === 'revenue';
  const isSalary   = type === 'salary';
  const isOverhead = ['travelling', 'marketing', 'other'].includes(type);
  const overheadAccent = type === 'travelling' ? '#22d3ee' : type === 'marketing' ? '#fb923c' : '#a855f7';
  const grossTotal  = rows.reduce((s, r) => s + r.amount, 0);
  const creditTotal = (creditRows || []).reduce((s, r) => s + r.amount, 0);
  const hasCredits  = !isRevenue && !isSalary && !isOverhead && creditRows && creditRows.length > 0;
  const netTotal    = grossTotal - creditTotal;
  const accentColor = isRevenue ? '#fbbf24' : isSalary ? '#f472b6' : isOverhead ? overheadAccent : '#1C4942';
  const borderColor = isRevenue ? '#78350f' : isSalary ? '#6b21a8' : isOverhead ? (type === 'travelling' ? '#164e63' : type === 'marketing' ? '#7c2d12' : '#581c87') : '#DFE7E3';
  const borderFaint = isRevenue ? '#78350f' : isSalary ? '#6b21a8' : isOverhead ? borderColor : '#DFE7E3';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      onClick={onClose}>
      <div style={{ background: '#FFFFFF', border: `1px solid ${borderColor}`, borderRadius: 12, width: '95vw', maxWidth: 1100, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: `1px solid ${borderFaint}` }}>
          <div>
            <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.95rem' }}>{title}</div>
            <div style={{ color: '#5D6C7B', fontSize: '0.75rem', marginTop: 2 }}>
              {rows.length} line items · {hasCredits ? 'Gross (Purchase Bills)' : 'Total (allocated)'}: <span style={{ color: accentColor }}>{fmtFull(grossTotal)}</span>
              {hasCredits && <> · Net (after credits): <span style={{ color: '#34d399' }}>{fmtFull(netTotal)}</span></>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', fontSize: '1.2rem', padding: '0.25rem 0.5rem' }}>✕</button>
        </div>
        {/* Table(s) */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {quarterBreakdown && (
            <>
              <div style={{ padding: '0.75rem 1.25rem 0', color: '#818cf8', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                Full Year → Quarter Breakdown
              </div>
              <table style={{ ...S.table, fontSize: '0.75rem' }}>
                <thead>
                  <tr>
                    {quarterBreakdown.quarters.map(qr => <th key={qr.q} style={S.th}>{QUARTER_LABELS[qr.q]}</th>)}
                    <th style={{ ...S.th, color: '#818cf8' }}>FY Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {quarterBreakdown.quarters.map(qr => (
                      <td key={qr.q} style={{ ...S.td, color: qr.hasData ? '#18191B' : '#9BA8B0' }}>{qr.hasData ? fmtFull(qr.amount) : '—'}</td>
                    ))}
                    <td style={{ ...S.td, color: '#818cf8', fontWeight: 700 }}>{fmtFull(quarterBreakdown.fyTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
          {hasCredits && (
            <div style={{ padding: '0.75rem 1.25rem 0', color: '#1C4942', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
              A. Purchase Bills
            </div>
          )}
          <table style={{ ...S.table, fontSize: '0.75rem' }}>
            <thead>
              <tr>
                <th style={S.thLeft}>Date</th>
                <th style={S.thLeft}>{isRevenue ? 'Invoice #' : 'Bill #'}</th>
                <th style={S.thLeft}>{isRevenue ? 'Customer' : 'Vendor'}</th>
                <th style={S.thLeft}>Description</th>
                {(isSalary || isOverhead) && <th style={S.thLeft}>Account Head</th>}
                {!isRevenue && !isSalary && !isOverhead && <th style={S.thLeft}>Sub Category</th>}
                {!isRevenue && !isSalary && !isOverhead && <th style={S.thLeft}>Project</th>}
                <th style={S.th}>Qty</th>
                <th style={S.th}>Rate</th>
                <th style={S.th}>Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,18,20,0.025)' }}>
                  <td style={{ ...S.tdLeft, color: '#5D6C7B', fontSize: '0.72rem' }}>{r.date}</td>
                  <td style={{ ...S.tdLeft, color: accentColor, fontSize: '0.72rem' }}>{isRevenue ? r.invoice_number : r.bill_number}</td>
                  <td style={{ ...S.tdLeft, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isRevenue ? r.customer : r.vendor}</td>
                  <td style={{ ...S.tdLeft, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#5D6C7B', fontSize: '0.72rem' }}>{r.description}</td>
                  {(isSalary || isOverhead) && <td style={{ ...S.tdLeft, color: accentColor, fontSize: '0.72rem' }}>{r.sub_category || r.account}</td>}
                  {!isRevenue && !isSalary && !isOverhead && <td style={{ ...S.tdLeft, color: '#a78bfa', fontSize: '0.72rem' }}>{r.sub_category}</td>}
                  {!isRevenue && !isSalary && !isOverhead && <td style={{ ...S.tdLeft, color: '#34d399', fontSize: '0.72rem' }}>{r.project}</td>}
                  <td style={{ ...S.td, fontSize: '0.72rem' }}>{r.quantity > 0 ? r.quantity : '—'}</td>
                  <td style={{ ...S.td, fontSize: '0.72rem' }}>{r.rate > 0 ? fmtFull(r.rate) : '—'}</td>
                  <td style={{ ...S.td, color: '#18191B', fontWeight: 600 }}>{fmtFull(r.amount)}</td>
                </tr>
              ))}
              <tr style={{ background: isSalary ? 'rgba(244,114,182,0.06)' : isRevenue ? 'rgba(251,191,36,0.06)' : isOverhead ? 'rgba(0,18,20,0.06)' : '#EAF4EF', borderTop: `2px solid ${borderColor}` }}>
                <td colSpan={(isRevenue || isSalary || isOverhead) ? 7 : 8} style={{ ...S.tdLeft, fontWeight: 700, color: accentColor, fontSize: '0.72rem', textTransform: 'uppercase' }}>
                  {hasCredits ? 'Total Purchase Bills' : 'Total (Allocated)'}
                </td>
                <td style={{ ...S.td, color: '#18191B', fontWeight: 700 }}>{fmtFull(grossTotal)}</td>
              </tr>
            </tbody>
          </table>

          {hasCredits && (
            <>
              <div style={{ padding: '1rem 1.25rem 0', color: '#fca5a5', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                B. Vendor Credits / Credit Notes (–)
              </div>
              <table style={{ ...S.table, fontSize: '0.75rem' }}>
                <thead>
                  <tr>
                    <th style={S.thLeft}>Date</th>
                    <th style={S.thLeft}>Credit Note #</th>
                    <th style={S.thLeft}>Vendor</th>
                    <th style={S.thLeft}>Applied Against Bill(s)</th>
                    <th style={S.thLeft}>Description</th>
                    <th style={S.thLeft}>Project</th>
                    <th style={S.th}>Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {creditRows.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,18,20,0.025)' }}>
                      <td style={{ ...S.tdLeft, color: '#5D6C7B', fontSize: '0.72rem' }}>{r.date}</td>
                      <td style={{ ...S.tdLeft, color: '#f87171', fontSize: '0.72rem' }}>{r.credit_number}</td>
                      <td style={{ ...S.tdLeft, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.vendor}</td>
                      <td style={{ ...S.tdLeft, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#5D6C7B', fontSize: '0.72rem' }}>{r.applied_bills}</td>
                      <td style={{ ...S.tdLeft, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#5D6C7B', fontSize: '0.72rem' }}>{r.description}</td>
                      <td style={{ ...S.tdLeft, color: '#34d399', fontSize: '0.72rem' }}>{r.project}</td>
                      <td style={{ ...S.td, color: '#f87171', fontWeight: 600 }}>({fmtFull(r.amount)})</td>
                    </tr>
                  ))}
                  <tr style={{ background: 'rgba(239,68,68,0.08)', borderTop: '2px solid #7f1d1d' }}>
                    <td colSpan={6} style={{ ...S.tdLeft, fontWeight: 700, color: '#f87171', fontSize: '0.72rem', textTransform: 'uppercase' }}>Total Vendor Credits</td>
                    <td style={{ ...S.td, color: '#f87171', fontWeight: 700 }}>({fmtFull(creditTotal)})</td>
                  </tr>
                </tbody>
              </table>

              <div style={{ padding: '1rem 1.25rem 0', color: '#1C4942', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                C. Net Cost
              </div>
              <table style={{ ...S.table, fontSize: '0.75rem' }}>
                <tbody>
                  <tr style={{ background: 'rgba(52,211,153,0.08)', borderTop: '2px solid #065f46' }}>
                    <td style={{ ...S.tdLeft, fontWeight: 700, color: '#34d399', fontSize: '0.72rem', textTransform: 'uppercase' }}>
                      Purchase Bills ({fmtFull(grossTotal)}) − Vendor Credits ({fmtFull(creditTotal)})
                    </td>
                    <td style={{ ...S.td, color: '#34d399', fontWeight: 700, width: 160 }}>{fmtFull(netTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Monthly Working Tab ───────────────────────────────────────────────────────
// Build FY options: 4 years back to 1 year forward from current FY
function buildFYOptions() {
  const now = new Date();
  const curFY = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const opts = [];
  for (let y = curFY - 4; y <= curFY + 1; y++) {
    opts.push({ value: y, label: `${y}-${String(y + 1).slice(2)}` });
  }
  return opts;
}
const FY_OPTIONS = buildFYOptions();
const DEFAULT_FY  = FY_OPTIONS.find(o => {
  const now = new Date();
  return o.value === (now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1);
})?.value || FY_OPTIONS[FY_OPTIONS.length - 2].value;

function MonthlyWorking({ projects, snapshots = [] }) {
  const [selectedId, setSelectedId] = useState('');
  const [selectedFY, setSelectedFY] = useState(DEFAULT_FY);
  const [monthlyData, setMonthlyData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState('');
  const [err, setErr] = useState('');
  const [viewMonth, setViewMonth] = useState('');
  const [drillDown, setDrillDown] = useState(null); // { title, rows }
  const [syncStatus, setSyncStatus] = useState(null);

  const project = projects.find(p => p.id === selectedId) || null;

  const LS_TTL = 24 * 60 * 60 * 1000; // 24h — sync happens at 11PM so no point expiring during the day

  const lsKey = project ? `pocm_v5_${project.id}_fy${selectedFY}` : null;

  // Read from localStorage — returns data if fresh, null if missing/expired
  const readLocalCache = useCallback(() => {
    if (!lsKey) return null;
    try {
      const raw = localStorage.getItem(lsKey);
      if (!raw) return null;
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts > LS_TTL) { localStorage.removeItem(lsKey); return null; }
      return data;
    } catch (_) { return null; }
  }, [lsKey]);

  const saveLocalCache = useCallback((data) => {
    if (!lsKey) return;
    try { localStorage.setItem(lsKey, JSON.stringify({ data, ts: Date.now() })); } catch (_) {}
  }, [lsKey]);

  // Fetch sync status once on mount
  useEffect(() => {
    api.pocmSyncStatus().then(s => setSyncStatus(s)).catch(() => {});
  }, []);

  // forceRefresh=true clears local cache before fetching
  const loadData = useCallback(async (forceRefresh = false) => {
    if (!project) return;

    // Return immediately if fresh local data exists (and not a forced refresh)
    if (!forceRefresh) {
      const cached = readLocalCache();
      if (cached) {
        setMonthlyData(cached);
        return;
      }
    } else {
      if (lsKey) localStorage.removeItem(lsKey);
    }

    setLoading(true); setErr(''); setLoadingProgress('');
    try {
      const from = `${selectedFY}-04-01`;
      const to   = `${selectedFY + 1}-03-31`;
      const zohoProject = project.zohoProjectName || project.name || '';

      // Bill detail is the slow part (one Zoho call per bill, shared across all
      // projects) — warm it in small tranches first so no single request has to
      // fetch the whole FY's bills, and every month gets counted (see note on
      // getPocmAllBills: this used to silently cap at 500 bills, newest-first,
      // which dropped the OLDEST months in the FY from "Cost This Month").
      let trancheDone = false;
      while (!trancheDone) {
        const t = await api.pocmBillsTranche(from);
        trancheDone = t.complete;
        if (trancheDone) break;
        if (t.busy) {
          // Another tab/request is mid-batch for this FY — wait, don't race it
          await new Promise(r => setTimeout(r, 2000));
        } else if (t.retryAfterSecs) {
          for (let s = t.retryAfterSecs; s > 0; s--) {
            setLoadingProgress(`Fetching bills… ${t.done}/${t.total} (rate limited, resuming in ${s}s)`);
            await new Promise(r => setTimeout(r, 1000));
          }
        } else {
          setLoadingProgress(`Fetching bills… ${t.done}/${t.total}`);
        }
      }
      setLoadingProgress('');

      // Sequential: expenses → revenue → overhead (avoids concurrent Zoho rate limiting)
      const expData = await api.pocmMonthlyExpenses(from, to, zohoProject);
      const revData = await api.pocmMonthlyRevenue(from, to, zohoProject, project.client || '');
      const ohData  = await api.pocmMonthlyOverhead(from, to);

      const totalPortfolioValue = projects.reduce((s, p) => s + (parseFloat(p.value) || 0), 0);
      const salaryRatio = totalPortfolioValue > 0 ? (parseFloat(project.value) || 0) / totalPortfolioValue : 0;
      const projectStartYM = project.startDate.substring(0, 7);

      const mergedByMonth = { ...expData.byMonth };
      for (const [month, rev] of Object.entries(revData.byMonth || {})) {
        if (!mergedByMonth[month]) mergedByMonth[month] = { projectCost: 0 };
        mergedByMonth[month].actualRevenue = rev.actualRevenue || 0;
      }
      for (const [month, oh] of Object.entries(ohData.byMonth || {})) {
        if (!mergedByMonth[month]) mergedByMonth[month] = { projectCost: 0 };
        if (month >= projectStartYM) {
          mergedByMonth[month].salaries   = Math.round((oh.salary      || 0) * salaryRatio);
          mergedByMonth[month].travelling = Math.round((oh.travelling  || 0) * salaryRatio);
          mergedByMonth[month].marketing  = Math.round((oh.marketing   || 0) * salaryRatio);
          mergedByMonth[month].other      = Math.round((oh.other       || 0) * salaryRatio);
        }
      }

      const merged = {
        ...expData,
        byMonth:         mergedByMonth,
        revenueDetails:  revData.details  || {},
        revenueTotals:   revData.totals   || { actualRevenue: 0 },
        overheadDetails: ohData.details   || {},
        overheadTotals:  ohData.totals    || { salary: 0 },
        salaryRatio,
        fetchedAt: Date.now(),
      };

      setMonthlyData(merged);
      saveLocalCache(merged); // persist locally — survives browser refresh
    } catch (e) {
      const msg = e.response?.data?.error || e.message || 'Unknown error';
      if (msg.includes('ZOHO_DAILY_LIMIT') || msg.includes('10,000')) {
        setErr('⚠️ Zoho Books daily API limit reached. Try again tomorrow. Previously fetched data is still shown below.');
      } else {
        setErr(msg);
      }
    } finally { setLoading(false); }
  }, [project, projects, selectedFY, lsKey, readLocalCache, saveLocalCache]);

  // Clear cached data when FY changes so fresh data is fetched
  useEffect(() => {
    setMonthlyData(null);
    setViewMonth('');
  }, [selectedFY, selectedId]);

  useEffect(() => {
    if (project) loadData(false); // use local cache if available
  }, [project, loadData]);

  const pocmRows = useMemo(() => {
    if (!project || !monthlyData) return [];
    return computePOCM(project, monthlyData, selectedFY, snapshots);
  }, [project, monthlyData, selectedFY, snapshots]);

  const currentMonthRow = useMemo(() => {
    if (!pocmRows.length) return null;
    if (viewMonth) return pocmRows.find(r => r.month === viewMonth) || pocmRows[pocmRows.length - 1];
    return pocmRows[pocmRows.length - 1];
  }, [pocmRows, viewMonth]);

  const cumRow = pocmRows.length > 0 ? pocmRows[pocmRows.length - 1] : null;

  const status = project && pocmRows.length > 0 ? getProjectStatus(project, pocmRows) : null;

  // ── Shared table helpers ──────────────────────────────────────────────────
  const TH_COLS = (
    <tr>
      <th style={S.thLeft}>Month</th>
      <th style={S.th}>Cost This Month</th>
      <th style={S.th}>Cumulative Cost</th>
      <th style={S.th}>% Complete</th>
      <th style={S.th}>Revenue This Month</th>
      <th style={S.th}>Cumulative Revenue</th>
      <th style={{ ...S.th, color: '#fbbf24' }}>Actual Revenue</th>
      <th style={{ ...S.th, color: '#fbbf24' }}>Cum. Actual Revenue</th>
      <th style={{ ...S.th, color: '#fb923c' }}>Revenue Provision to be Book</th>
      <th style={S.th}>Gross Profit</th>
      <th style={S.th}>Salaries</th>
      <th style={S.th}>Travelling</th>
      <th style={{ ...S.th, color: '#34d399' }}>Net Profit (1)</th>
      <th style={S.th}>Marketing</th>
      <th style={S.th}>Other</th>
      <th style={{ ...S.th, color: '#34d399' }}>Final Net Profit</th>
      <th style={{ ...S.th, color: '#34d399' }}>Final Cum. Net Profit</th>
    </tr>
  );

  const mkMonthTr = (row, globalIdx, zebra) => {
    const monthDetails = monthlyData?.details?.[row.month] || [];
    const monthCredits = monthlyData?.creditDetails?.[row.month] || [];
    const cs = monthDetails.length > 0 ? { cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#DFE7E3' } : {};
    const openDrill = (label) => monthDetails.length && setDrillDown({ title: `${fmtMonthLabel(row.month)} — ${label}`, rows: monthDetails, creditRows: monthCredits });
    const cumDet = pocmRows.slice(0, globalIdx + 1).flatMap(r => monthlyData?.details?.[r.month] || []);
    const cumCredits = pocmRows.slice(0, globalIdx + 1).flatMap(r => monthlyData?.creditDetails?.[r.month] || []);
    const openCumDrill = (label) => cumDet.length && setDrillDown({ title: `Cumulative to ${fmtMonthLabel(row.month)} — ${label}`, rows: cumDet, creditRows: cumCredits });
    const revDet  = monthlyData?.revenueDetails?.[row.month] || [];
    const cumRevDet = pocmRows.slice(0, globalIdx + 1).flatMap(r => monthlyData?.revenueDetails?.[r.month] || []);
    const rCS = revDet.length > 0 ? { cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#d97706' } : {};
    const ohDet     = monthlyData?.overheadDetails?.[row.month] || [];
    const salaryDet = ohDet.filter(d => d._cat === 'salary');
    const travelDet = ohDet.filter(d => d._cat === 'travelling');
    const marketDet = ohDet.filter(d => d._cat === 'marketing');
    const otherDet  = ohDet.filter(d => d._cat === 'other');
    const sr = monthlyData?.salaryRatio || 0;
    const makeOhRows = (det) => det.map(r => ({ ...r, sub_category: r.account, amount: Math.round(r.amount * sr) }));
    const salaryCS = salaryDet.length > 0 ? { cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#f472b6' } : {};
    const travelCS = travelDet.length > 0 ? { cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#22d3ee' } : {};
    const marketCS = marketDet.length > 0 ? { cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#fb923c' } : {};
    const otherCS  = otherDet.length  > 0 ? { cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#a855f7' } : {};
    return (
      <tr key={row.month} style={{ background: zebra ? 'rgba(0,18,20,0.025)' : 'transparent' }}>
        <td style={S.tdLeft}>{fmtMonthLabel(row.month)}</td>
        <td style={{ ...S.td, ...cs }} onClick={() => openDrill('Cost of Goods Sold')}>{fmtFull(row.projectCost)}</td>
        <td style={{ ...S.td, cursor: cumDet.length ? 'pointer' : 'default', textDecoration: cumDet.length ? 'underline dotted' : 'none', textDecorationColor: '#DFE7E3' }} onClick={() => openCumDrill('Cumulative COGS')}>{fmtFull(row.cumCost)}</td>
        <td style={{ ...S.td, color: '#a78bfa', fontWeight: 600 }}>{fmtPct(row.pct)}</td>
        <td style={{ ...S.td, color: '#34d399', ...cs }} onClick={() => openDrill('Revenue Recognised (POCM)')}>{fmtFull(row.revThisMonth)}</td>
        <td style={{ ...S.td, color: '#34d399', cursor: cumDet.length ? 'pointer' : 'default', textDecoration: cumDet.length ? 'underline dotted' : 'none', textDecorationColor: '#DFE7E3' }} onClick={() => openCumDrill('Cumulative Revenue')}>{fmtFull(row.cumRevenue)}</td>
        <td style={{ ...S.td, color: '#fbbf24', fontWeight: 600, ...rCS }} onClick={() => revDet.length && setDrillDown({ title: `${fmtMonthLabel(row.month)} — Actual Revenue`, rows: revDet, type: 'revenue' })}>{fmtFull(row.actualRevenue)}</td>
        <td style={{ ...S.td, color: '#fbbf24', ...(cumRevDet.length ? { cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#d97706' } : {}) }} onClick={() => cumRevDet.length && setDrillDown({ title: `Cumulative to ${fmtMonthLabel(row.month)} — Actual Revenue`, rows: cumRevDet, type: 'revenue' })}>{fmtFull(row.cumActualRevenue)}</td>
        <td style={{ ...S.td, color: row.revenueProvision >= 0 ? '#fb923c' : '#f87171', fontWeight: 600 }}>{fmtFull(row.revenueProvision)}</td>
        <td style={{ ...S.td, color: row.grossProfit >= 0 ? S.positive : S.negative, fontWeight: 600, ...cs }} onClick={() => openDrill('Gross Profit Basis')}>{fmtFull(row.grossProfit)}</td>
        <td style={{ ...S.td, ...salaryCS }} onClick={() => salaryDet.length && setDrillDown({ title: `${fmtMonthLabel(row.month)} — Salary (${(sr * 100).toFixed(1)}% of Company)`, rows: makeOhRows(salaryDet), type: 'salary' })}>{fmtFull(row.salaries)}</td>
        <td style={{ ...S.td, ...travelCS }} onClick={() => travelDet.length && setDrillDown({ title: `${fmtMonthLabel(row.month)} — Travelling (${(sr * 100).toFixed(1)}% of Company)`, rows: makeOhRows(travelDet), type: 'travelling' })}>{fmtFull(row.travelling)}</td>
        <td style={{ ...S.td, color: row.netProfit1 >= 0 ? S.positive : S.negative, fontWeight: 600 }}>{fmtFull(row.netProfit1)}</td>
        <td style={{ ...S.td, ...marketCS }} onClick={() => marketDet.length && setDrillDown({ title: `${fmtMonthLabel(row.month)} — Marketing (${(sr * 100).toFixed(1)}% of Company)`, rows: makeOhRows(marketDet), type: 'marketing' })}>{fmtFull(row.marketing)}</td>
        <td style={{ ...S.td, ...otherCS  }} onClick={() => otherDet.length  && setDrillDown({ title: `${fmtMonthLabel(row.month)} — Other Expenses (${(sr * 100).toFixed(1)}% of Company)`, rows: makeOhRows(otherDet),  type: 'other' })}>{fmtFull(row.other)}</td>
        <td style={{ ...S.td, color: row.netProfit >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(row.netProfit)}</td>
        <td style={{ ...S.td, color: row.cumNet >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(row.cumNet)}</td>
      </tr>
    );
  };

  // Opening balance row (shows previous quarter's closing cumulative values)
  const mkOpeningTr = (prevRow) => (
    <tr style={{ background: 'rgba(99,102,241,0.09)', borderBottom: '1px solid #312e81' }}>
      <td style={{ ...S.tdLeft, color: '#818cf8', fontWeight: 700, fontSize: '0.72rem' }}>Opening Balance (B/F)</td>
      <td style={S.td}>—</td>
      <td style={{ ...S.td, color: '#818cf8', fontWeight: 700 }}>{fmtFull(prevRow.cumCost)}</td>
      <td style={{ ...S.td, color: '#818cf8', fontWeight: 600 }}>{fmtPct(prevRow.pct)}</td>
      <td style={S.td}>—</td>
      <td style={{ ...S.td, color: '#818cf8', fontWeight: 700 }}>{fmtFull(prevRow.cumRevenue)}</td>
      <td style={S.td}>—</td>
      <td style={{ ...S.td, color: '#818cf8', fontWeight: 700 }}>{fmtFull(prevRow.cumActualRevenue)}</td>
      <td style={S.td}>—</td>
      <td style={S.td}>—</td>
      <td style={S.td}>—</td>
      <td style={S.td}>—</td>
      <td style={S.td}>—</td>
      <td style={S.td}>—</td>
      <td style={S.td}>—</td>
      <td style={S.td}>—</td>
      <td style={{ ...S.td, color: '#818cf8', fontWeight: 700 }}>{fmtFull(prevRow.cumNet)}</td>
    </tr>
  );

  // Quarter closing / C/F row
  const mkClosingTr = (qRows, qNum) => {
    const last = qRows[qRows.length - 1];
    const sum = (f) => qRows.reduce((s, r) => s + r[f], 0);
    const qProv  = sum('revenueProvision');
    const qGross = sum('grossProfit');
    const qNet1  = sum('netProfit1');
    const qNet   = sum('netProfit');
    return (
      <tr style={{ background: 'rgba(99,102,241,0.12)', borderTop: '2px solid #4338ca' }}>
        <td style={{ ...S.tdLeft, color: '#818cf8', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase' }}>Q{qNum} Closing / C/F</td>
        <td style={{ ...S.td, color: '#18191B', fontWeight: 700 }}>{fmtFull(sum('projectCost'))}</td>
        <td style={{ ...S.td, color: '#818cf8', fontWeight: 700 }}>{fmtFull(last.cumCost)}</td>
        <td style={{ ...S.td, color: '#a78bfa', fontWeight: 700 }}>{fmtPct(last.pct)}</td>
        <td style={{ ...S.td, color: '#34d399', fontWeight: 700 }}>{fmtFull(sum('revThisMonth'))}</td>
        <td style={{ ...S.td, color: '#34d399', fontWeight: 700 }}>{fmtFull(last.cumRevenue)}</td>
        <td style={{ ...S.td, color: '#fbbf24', fontWeight: 700 }}>{fmtFull(sum('actualRevenue'))}</td>
        <td style={{ ...S.td, color: '#fbbf24', fontWeight: 700 }}>{fmtFull(last.cumActualRevenue)}</td>
        <td style={{ ...S.td, color: qProv >= 0 ? '#fb923c' : '#f87171', fontWeight: 700 }}>{fmtFull(qProv)}</td>
        <td style={{ ...S.td, color: qGross >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(qGross)}</td>
        <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(sum('salaries'))}</td>
        <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(sum('travelling'))}</td>
        <td style={{ ...S.td, color: qNet1 >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(qNet1)}</td>
        <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(sum('marketing'))}</td>
        <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(sum('other'))}</td>
        <td style={{ ...S.td, color: qNet >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(qNet)}</td>
        <td style={{ ...S.td, color: last.cumNet >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(last.cumNet)}</td>
      </tr>
    );
  };

  const value = parseFloat(project?.value) || 0;
  const estCost = parseFloat(project?.estimatedCost) || 0;
  const estProfit = value - estCost;
  const estProfitPct = value ? (estProfit / value) * 100 : 0;

  if (!projects.length) {
    return (
      <div style={{ textAlign: 'center', padding: '3rem', color: '#9BA8B0' }}>
        <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>📁</div>
        No projects found. Add a project first in the Projects tab.
      </div>
    );
  }

  return (
    <div>
      {/* Project selector */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <label style={S.label}>Select Project</label>
          <select style={S.select} value={selectedId} onChange={e => { setSelectedId(e.target.value); setMonthlyData(null); }}>
            <option value="">— choose a project —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 140 }}>
          <label style={S.label}>Financial Year</label>
          <select
            style={{ ...S.select, background: '#EAF4EF', border: '1px solid #1C4942', color: '#1C4942', fontWeight: 700 }}
            value={selectedFY}
            onChange={e => setSelectedFY(parseInt(e.target.value))}
          >
            {FY_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>FY {o.label}</option>
            ))}
          </select>
        </div>
        {selectedId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {syncStatus?.data_as_of && (
              <span style={{ fontSize: '0.72rem', color: '#5D6C7B' }}>
                Data as of <strong style={{ color: '#2D6B62' }}>{formatDataAsOf(syncStatus.data_as_of)}</strong>
                {syncStatus.next_run && (
                  <> · Next sync: {formatNextSync(syncStatus.next_run)}</>
                )}
              </span>
            )}
            {monthlyData?.fetchedAt && !loading && !syncStatus?.lastSync && (
              <span style={{ fontSize: '0.72rem', color: '#5D6C7B' }}>
                Loaded {new Date(monthlyData.fetchedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button style={S.btn} onClick={() => loadData(true)} disabled={loading}>
              {loading ? 'Fetching…' : '↺ Refresh from Zoho'}
            </button>
          </div>
        )}
      </div>

      {err && <div style={S.notice}>Error: {err}</div>}

      {!selectedId && (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#9BA8B0', fontSize: '0.85rem' }}>
          Select a project above to view POCM working.
        </div>
      )}

      {selectedId && !loading && !monthlyData && !err && (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#9BA8B0' }}>Loading data…</div>
      )}

      {selectedId && loading && (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#5D6C7B', fontSize: '0.85rem' }}>
          <div style={{ marginBottom: 8 }}>{loadingProgress || 'Fetching data from Zoho Books (Needle And Thread)…'}</div>
          <div style={{ color: '#9BA8B0', fontSize: '0.78rem' }}>Fetching all bill details to find COGS by project (in small batches, rate-limit-safe). First load can take a few minutes depending on number of bills. Data is cached locally for 24 hours after that.</div>
        </div>
      )}

      {project && monthlyData && (
        <>
          {!monthlyData.hasMapping && (
            <div style={S.notice}>
              ⚠ Zoho Project Name not set for this project. Edit the project and select the Zoho Books project name to fetch COGS data.
            </div>
          )}
          {monthlyData.hasMapping && monthlyData.lineCount === 0 && (
            <div style={S.notice}>
              ℹ No "Cost of Goods Sold" line items found for project "{project.zohoProjectName}" in the selected date range.
              Verify the project name exactly matches the Zoho Books project name.
            </div>
          )}

          {/* Status + Project header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div>
              <div style={{ color: '#18191B', fontWeight: 700, fontSize: '1.1rem' }}>{project.name}</div>
              {project.client && <div style={{ color: '#5D6C7B', fontSize: '0.8rem', marginTop: 2 }}>Client: {project.client}</div>}
            </div>
            {status && (
              <span style={{ padding: '4px 12px', borderRadius: 6, background: status.bg, color: status.color, fontWeight: 700, fontSize: '0.8rem', border: `1px solid ${status.color}33` }}>
                {status.icon} {status.label}
              </span>
            )}
          </div>

          {/* Project KPI strip */}
          <div style={S.kpiGrid}>
            {[
              { label: 'Project Value',           val: fmtINR(value),                                color: '#1C4942' },
              { label: 'Estimated Cost',           val: fmtINR(estCost),                             color: '#9BA8B0' },
              { label: 'Estimated Profit',         val: fmtINR(estProfit),                           color: estProfit >= 0 ? S.positive : S.negative },
              { label: 'Estimated Profit %',       val: fmtPct(estProfitPct),                        color: estProfit >= 0 ? S.positive : S.negative },
              { label: 'Total Cost Incurred',      val: fmtINR(cumRow?.cumCost || 0),                color: '#18191B' },
              { label: 'Remaining Cost',           val: fmtINR(Math.max(0, estCost - (cumRow?.cumCost || 0))), color: '#fbbf24' },
              { label: '% Completed',              val: fmtPct(cumRow?.pct || 0),                    color: '#a78bfa' },
              { label: 'Revenue Recognised',       val: fmtINR(cumRow?.cumRevenue || 0),             color: '#34d399' },
              { label: 'Remaining Revenue',        val: fmtINR(value - (cumRow?.cumRevenue || 0)),   color: '#9BA8B0' },
              { label: 'Gross Profit (Cumulative)', val: fmtINR(cumRow?.cumGross || 0),              color: cumRow?.cumGross >= 0 ? S.positive : S.negative },
              { label: 'Net Operating Profit',     val: fmtINR(cumRow?.cumNet || 0),                 color: cumRow?.cumNet  >= 0 ? S.positive : S.negative },
              { label: 'Estimated Final Profit',   val: fmtINR(estProfit),                           color: estProfit >= 0 ? S.positive : S.negative },
            ].map(kpi => (
              <div key={kpi.label} style={S.kpiBox}>
                <div style={{ ...S.kpiVal, color: kpi.color }}>{kpi.val}</div>
                <div style={S.kpiLbl}>{kpi.label}</div>
              </div>
            ))}
          </div>

          {/* Monthly POCM Table */}
          {drillDown && <DrillDown title={drillDown.title} rows={drillDown.rows} creditRows={drillDown.creditRows} type={drillDown.type || 'cost'} onClose={() => setDrillDown(null)} />}

          {pocmRows.length > 0 && (
            <>
              <div style={{ color: '#9BA8B0', fontSize: '0.72rem', marginBottom: '1rem' }}>
                💡 Click any cost/revenue figure to see the underlying bill line items
              </div>

              {/* ── Quarterly Tables ─────────────────────────────────────── */}
              {[1, 2, 3, 4].map(q => {
                const qRows = pocmRows.filter(r => getIndianFYQuarter(r.month) === q);
                if (qRows.length === 0) return null;
                const firstGlobalIdx = pocmRows.indexOf(qRows[0]);
                const prevRow = firstGlobalIdx > 0 ? pocmRows[firstGlobalIdx - 1] : null;
                return (
                  <div key={q} style={{ marginBottom: '1.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                      <div style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid #4338ca', borderRadius: 6, padding: '2px 10px', color: '#818cf8', fontWeight: 700, fontSize: '0.78rem' }}>
                        {QUARTER_LABELS[q]}
                      </div>
                      <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.88rem' }}>
                        Monthly POCM Working — Ind AS 115 / IFRS 15
                        <span style={{ marginLeft: 10, color: '#1C4942', fontWeight: 500, fontSize: '0.78rem' }}>FY {selectedFY}-{String(selectedFY + 1).slice(2)}</span>
                      </div>
                    </div>
                    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #DFE7E3' }}>
                      <table style={S.table}>
                        <thead>{TH_COLS}</thead>
                        <tbody>
                          {prevRow && mkOpeningTr(prevRow)}
                          {qRows.map((row, qi) => mkMonthTr(row, firstGlobalIdx + qi, qi % 2 !== 0))}
                          {mkClosingTr(qRows, q)}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}

              {/* ── Annual Summary Table (all months) ────────────────────── */}
              <div style={{ marginBottom: '1.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                  <div style={{ background: '#EAF4EF', border: '1px solid #DFE7E3', borderRadius: 6, padding: '2px 10px', color: '#1C4942', fontWeight: 700, fontSize: '0.78rem' }}>
                    Annual Summary
                  </div>
                  <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.88rem' }}>All Months — Full Year</div>
                </div>
                <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #DFE7E3' }}>
                  <table style={S.table}>
                    <thead>{TH_COLS}</thead>
                    <tbody>
                      {pocmRows.map((row, i) => mkMonthTr(row, i, i % 2 !== 0))}
                      {/* Annual Project Total */}
                      {(() => {
                        const sum = (f) => pocmRows.reduce((s, r) => s + r[f], 0);
                        const totProv = sum('revenueProvision');
                        return (
                          <tr style={{ background: '#EAF4EF', borderTop: '2px solid #1C4942' }}>
                            <td style={{ ...S.tdLeft, fontWeight: 700, color: '#1C4942', fontSize: '0.72rem', textTransform: 'uppercase' }}>Project Total</td>
                            <td style={{ ...S.td, color: '#18191B', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#DFE7E3' }}
                                onClick={() => { const all = pocmRows.flatMap(r => monthlyData?.details?.[r.month] || []); const allCr = pocmRows.flatMap(r => monthlyData?.creditDetails?.[r.month] || []); if (all.length) setDrillDown({ title: 'All Months — Total COGS', rows: all, creditRows: allCr }); }}>
                              {fmtFull(sum('projectCost'))}
                            </td>
                            <td style={S.td}>—</td>
                            <td style={{ ...S.td, color: '#a78bfa', fontWeight: 700 }}>{fmtPct(cumRow?.pct || 0)}</td>
                            <td style={{ ...S.td, color: '#34d399', fontWeight: 700 }}>{fmtFull(sum('revThisMonth'))}</td>
                            <td style={S.td}>—</td>
                            <td style={{ ...S.td, color: '#fbbf24', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#d97706' }}
                                onClick={() => { const all = pocmRows.flatMap(r => monthlyData?.revenueDetails?.[r.month] || []); if (all.length) setDrillDown({ title: 'All Months — Total Actual Revenue', rows: all, type: 'revenue' }); }}>
                              {fmtFull(sum('actualRevenue'))}
                            </td>
                            <td style={S.td}>—</td>
                            <td style={{ ...S.td, fontWeight: 700, color: totProv >= 0 ? '#fb923c' : '#f87171' }}>{fmtFull(totProv)}</td>
                            <td style={{ ...S.td, fontWeight: 700, color: cumRow?.cumGross >= 0 ? S.positive : S.negative }}>{fmtFull(cumRow?.cumGross || 0)}</td>
                            <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(sum('salaries'))}</td>
                            <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(sum('marketing'))}</td>
                            <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(sum('travelling'))}</td>
                            <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(sum('other'))}</td>
                            <td style={{ ...S.td, fontWeight: 700, color: cumRow?.cumNet >= 0 ? S.positive : S.negative }}>{fmtFull(cumRow?.cumNet || 0)}</td>
                            <td style={S.td}>—</td>
                          </tr>
                        );
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Management Dashboard Summary */}
              <div style={{ fontWeight: 700, color: '#18191B', marginBottom: '0.75rem', fontSize: '0.9rem' }}>
                Management Dashboard
              </div>

              {/* Month selector for "Current Month" column */}
              <div style={{ marginBottom: '0.85rem' }}>
                <label style={S.label}>Current Month View</label>
                <select style={{ ...S.select, maxWidth: 200 }} value={viewMonth} onChange={e => setViewMonth(e.target.value)}>
                  {pocmRows.map(r => <option key={r.month} value={r.month}>{fmtMonthLabel(r.month)}</option>)}
                </select>
              </div>

              <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #DFE7E3', marginBottom: '1.5rem' }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={{ ...S.thLeft, minWidth: 220 }}>Particular</th>
                      <th style={S.th}>Current Month ({fmtMonthLabel(currentMonthRow?.month)})</th>
                      <th style={S.th}>Cumulative</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'A. Project Value', cur: '—', cum: fmtFull(value), bold: false, color: '#1C4942' },
                      { label: 'B. Estimated Cost', cur: '—', cum: fmtFull(estCost), bold: false },
                      { label: 'C. Estimated Profit', cur: '—', cum: fmtFull(estProfit), bold: false, color: estProfit >= 0 ? S.positive : S.negative },
                      { label: 'D. Estimated Profit %', cur: '—', cum: fmtPct(estProfitPct), bold: false, color: estProfit >= 0 ? S.positive : S.negative },
                      { divider: true },
                      { label: 'E. Cost Incurred (COGS)', cur: fmtFull(currentMonthRow?.projectCost), cum: fmtFull(cumRow?.cumCost), bold: false },
                      { label: 'F. Percentage of Completion', cur: fmtPct(currentMonthRow?.pct), cum: fmtPct(cumRow?.pct), bold: false, color: '#a78bfa' },
                      { divider: true },
                      { label: 'Revenue Recognised (A × F)', cur: fmtFull(currentMonthRow?.revThisMonth), cum: fmtFull(cumRow?.cumRevenue), bold: true, color: '#34d399' },
                      { label: 'Less: Project Cost (COGS)', cur: fmtFull(currentMonthRow?.projectCost), cum: fmtFull(cumRow?.cumCost), bold: false },
                      { label: 'Gross Profit', cur: fmtFull(currentMonthRow?.grossProfit), cum: fmtFull(cumRow?.cumGross), bold: true, color: currentMonthRow?.grossProfit >= 0 ? S.positive : S.negative },
                      { divider: true },
                      { label: 'Less: Salaries & Wages', cur: fmtFull(currentMonthRow?.salaries), cum: fmtFull(pocmRows.reduce((s, r, i2) => i2 <= pocmRows.indexOf(currentMonthRow) ? s + r.salaries : s, 0)), bold: false },
                      { label: 'Less: Marketing Expenses', cur: fmtFull(currentMonthRow?.marketing), cum: fmtFull(pocmRows.reduce((s, r, i2) => i2 <= pocmRows.indexOf(currentMonthRow) ? s + r.marketing : s, 0)), bold: false },
                      { label: 'Less: Travelling & Hotel Exp.', cur: fmtFull(currentMonthRow?.travelling), cum: fmtFull(pocmRows.reduce((s, r, i2) => i2 <= pocmRows.indexOf(currentMonthRow) ? s + r.travelling : s, 0)), bold: false },
                      { label: 'Less: Other Operating Expenses', cur: fmtFull(currentMonthRow?.other), cum: fmtFull(pocmRows.reduce((s, r, i2) => i2 <= pocmRows.indexOf(currentMonthRow) ? s + r.other : s, 0)), bold: false },
                      { divider: true },
                      { label: 'Net Operating Profit', cur: fmtFull(currentMonthRow?.netProfit), cum: fmtFull(cumRow?.cumNet), bold: true, color: cumRow?.cumNet >= 0 ? S.positive : S.negative },
                    ].map((row, i) => {
                      if (row.divider) return <tr key={i}><td colSpan={3} style={{ padding: '2px 0', background: '#DFE7E3', height: 1 }} /></tr>;
                      return (
                        <tr key={i} style={{ background: row.bold ? '#EAF4EF' : 'transparent' }}>
                          <td style={{ ...S.tdLeft, color: row.bold ? '#18191B' : '#9BA8B0', fontWeight: row.bold ? 700 : 400, paddingLeft: row.label.startsWith('Less') ? '1.5rem' : S.tdLeft.padding }}>{row.label}</td>
                          <td style={{ ...S.td, color: row.color || (row.bold ? '#18191B' : '#9BA8B0'), fontWeight: row.bold ? 700 : 400 }}>{row.cur || '—'}</td>
                          <td style={{ ...S.td, color: row.color || (row.bold ? '#18191B' : '#9BA8B0'), fontWeight: row.bold ? 700 : 400 }}>{row.cum || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {pocmRows.length === 0 && monthlyData && (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#9BA8B0', fontSize: '0.85rem' }}>
              No months to display. Ensure the project has started and dates are correct.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Reports Tab ──────────────────────────────────────────────────────────────
const REPORT_LIST = [
  { id: 'vendor-payments',    label: 'Payment Report',              group: 'Expense' },
  { id: 'advance-payments',   label: 'Advance Payment Report',      group: 'Expense' },
  { id: 'outstanding-bills',  label: 'Outstanding Bills',           group: 'Expense' },
  { id: 'draft-pos',          label: 'Draft PO Report',             group: 'Expense' },
  { id: 'approved-pos',       label: 'Approved / Issued PO Report', group: 'Expense' },
  { id: 'client-invoices',    label: 'Invoice & Payment Report',    group: 'Revenue' },
  { id: 'draft-invoices',     label: 'Draft Invoices Report',       group: 'Revenue' },
  { id: 'project-pl',         label: 'Project-wise P&L',            group: 'P&L'     },
];

// Quarter → [fromDate, toDate]
function quarterDateRange(fyYear, q) {
  const map = { 1: [4, 6], 2: [7, 9], 3: [10, 12], 4: [1, 3] };
  const [sm, em] = map[q];
  const yr = q === 4 ? fyYear + 1 : fyYear;
  const lastDay = new Date(yr, em, 0).getDate();
  return [`${yr}-${String(sm).padStart(2,'0')}-01`, `${yr}-${String(em).padStart(2,'0')}-${lastDay}`];
}

function getReportDateRange(fyYear, quarter, month) {
  if (month) {
    const [y, m] = month.split('-');
    return [`${month}-01`, `${month}-${new Date(y, m, 0).getDate()}`];
  }
  if (quarter) return quarterDateRange(fyYear, parseInt(quarter));
  return [`${fyYear}-04-01`, `${fyYear + 1}-03-31`];
}

function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '—'; }

function RptBadge({ n, pos }) {
  if (!n && n !== 0) return <span style={{ color: '#5D6C7B' }}>—</span>;
  const c = pos ? (n >= 0 ? '#15803D' : '#DC2626') : '#9BA8B0';
  return <span style={{ color: c, fontWeight: 600 }}>{fmtFull(n)}</span>;
}

// ── Project-wise P&L Report ───────────────────────────────────────────────────
function formatDataAsOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  const yyyy = d.getFullYear();
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const mm = String(m).padStart(2, '0');
  return `${dd}-${mon}-${yyyy} ${h}:${mm} ${ampm} IST`;
}

function formatNextSync(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const mm = String(m).padStart(2, '0');
  return `${dd}-${mon} ${h}:${mm} ${ampm}`;
}

function CostDrillModal({ open, onClose, projectName, field, monthRows }) {
  if (!open || !monthRows) return null;
  const isCost = field === 'cost';
  const dateToFY = (ym) => { const m = parseInt(ym.slice(5,7)); const y = parseInt(ym.slice(0,4)); return m >= 4 ? y : y - 1; };
  const fyGroups = {};
  for (const r of monthRows) {
    const fy = dateToFY(r.month);
    if (!fyGroups[fy]) fyGroups[fy] = [];
    fyGroups[fy].push(r);
  }
  const fys = Object.keys(fyGroups).map(Number).sort();
  const grandTotal = monthRows.reduce((s, r) => s + (isCost ? r.projectCost : r.actualRevenue), 0);

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.52)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={onClose}>
      <div style={{ background:'#fff', borderRadius:12, width:'min(600px,95vw)', maxHeight:'82vh', overflow:'hidden',
        display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.28)' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ background:'#1C4942', color:'#EAF4EF', padding:'0.9rem 1.25rem', display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12, flexShrink:0 }}>
          <div>
            <div style={{ fontWeight:700, fontSize:'0.88rem' }}>{projectName}</div>
            <div style={{ fontSize:'0.71rem', color:'#A8C4C0', marginTop:3 }}>
              {isCost ? 'Cost to Date — Year-wise Breakdown' : 'Actual Revenue — Year-wise Breakdown'}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#EAF4EF', fontSize:'1.4rem', cursor:'pointer', lineHeight:1, padding:0, flexShrink:0 }}>×</button>
        </div>
        {/* Body */}
        <div style={{ overflowY:'auto', padding:'0.75rem 1.25rem 1.25rem' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'0.8rem' }}>
            <thead>
              <tr>
                <th style={{ textAlign:'left', padding:'0.35rem 0.5rem', borderBottom:'2px solid #DFE7E3', color:'#5D6C7B', fontSize:'0.69rem', textTransform:'uppercase', letterSpacing:'0.04em' }}>Month</th>
                <th style={{ textAlign:'right', padding:'0.35rem 0.5rem', borderBottom:'2px solid #DFE7E3', color:'#5D6C7B', fontSize:'0.69rem', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                  {isCost ? 'Cost This Month' : 'Actual Revenue'}
                </th>
              </tr>
            </thead>
            <tbody>
              {fys.map(fy => {
                const fyRows = fyGroups[fy];
                const fyTotal = fyRows.reduce((s, r) => s + (isCost ? r.projectCost : r.actualRevenue), 0);
                const fyLabel = `FY ${fy}-${String(fy + 1).slice(2)}`;
                return (
                  <React.Fragment key={fy}>
                    <tr>
                      <td colSpan={2} style={{ padding:'0.5rem 0.5rem 0.2rem', fontWeight:700, fontSize:'0.72rem', color:'#1C4942',
                        background:'#EAF4EF', borderTop:'1px solid #C5DDD8', letterSpacing:'0.02em' }}>
                        {fyLabel}
                      </td>
                    </tr>
                    {fyRows.map((r, idx) => {
                      const amt = isCost ? r.projectCost : r.actualRevenue;
                      return (
                        <tr key={r.month} style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(0,18,20,0.025)' }}>
                          <td style={{ padding:'0.28rem 0.5rem 0.28rem 1.5rem', color: amt === 0 ? '#9BA8B0' : '#5D6C7B' }}>
                            {fmtMonthLabel(r.month)}
                          </td>
                          <td style={{ padding:'0.28rem 0.5rem', textAlign:'right', fontFamily:'monospace',
                            color: amt === 0 ? '#C8D2D8' : amt < 0 ? '#DC2626' : '#18191B' }}>
                            {fmtFull(amt)}
                          </td>
                        </tr>
                      );
                    })}
                    <tr style={{ background:'#F4F8F7', borderTop:'1px solid #DFE7E3', borderBottom:'2px solid #DFE7E3' }}>
                      <td style={{ padding:'0.38rem 0.5rem', fontWeight:700, color:'#1C4942', fontSize:'0.79rem' }}>
                        {fyLabel} Total
                      </td>
                      <td style={{ padding:'0.38rem 0.5rem', textAlign:'right', fontFamily:'monospace', fontWeight:700,
                        color: fyTotal < 0 ? '#DC2626' : '#1C4942' }}>
                        {fmtFull(fyTotal)}
                      </td>
                    </tr>
                    <tr><td colSpan={2} style={{ height:6 }} /></tr>
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop:'2px solid #1C4942', background:'#EAF4EF' }}>
                <td style={{ padding:'0.55rem 0.5rem', fontWeight:700, color:'#1C4942', fontSize:'0.83rem' }}>
                  Grand Total
                </td>
                <td style={{ padding:'0.55rem 0.5rem', textAlign:'right', fontFamily:'monospace', fontWeight:700, color:'#1C4942', fontSize:'0.86rem' }}>
                  {fmtFull(grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Utilised by Project — drill-down & exception lists ───────────────────────
function downloadCsv(filename, header, rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [header.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function UtilModalShell({ title, subtitle, onClose, children }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.52)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={onClose}>
      <div style={{ background:'#fff', borderRadius:12, width:'min(1180px,95vw)', maxHeight:'86vh', overflow:'hidden',
        display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.28)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ background:'#1C4942', color:'#EAF4EF', padding:'0.9rem 1.25rem', display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12, flexShrink:0 }}>
          <div>
            <div style={{ fontWeight:700, fontSize:'0.88rem' }}>{title}</div>
            {subtitle && <div style={{ fontSize:'0.71rem', color:'#A8C4C0', marginTop:3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#EAF4EF', fontSize:'1.4rem', cursor:'pointer', lineHeight:1, padding:0, flexShrink:0 }}>×</button>
        </div>
        <div style={{ overflowY:'auto', padding:'0.9rem 1.25rem 1.25rem' }}>{children}</div>
      </div>
    </div>
  );
}

function UtilTable({ title, columns, rows, total, emptyText, onExport }) {
  return (
    <div style={{ marginBottom:'1.25rem' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.4rem' }}>
        <div style={{ color:'#1C4942', fontWeight:700, fontSize:'0.76rem', textTransform:'uppercase', letterSpacing:'0.04em' }}>
          {title} <span style={{ color:'#9BA8B0', fontWeight:400 }}>({rows.length})</span>
        </div>
        {onExport && rows.length > 0 && <button style={S.btnSm} onClick={onExport}>Export CSV</button>}
      </div>
      {rows.length === 0 ? (
        <div style={{ color:'#9BA8B0', fontSize:'0.76rem', padding:'0.5rem 0' }}>{emptyText}</div>
      ) : (
        <div style={{ overflowX:'auto', border:'1px solid #DFE7E3', borderRadius:8 }}>
          <table style={S.table}>
            <thead><tr>{columns.map(c => <th key={c.label} style={c.right ? S.th : S.thLeft}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,18,20,0.025)' }}>
                  {columns.map(c => (
                    <td key={c.label} style={{ ...(c.right ? S.td : S.tdLeft), color: c.color ? c.color(r) : '#18191B', fontSize:'0.75rem' }}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
              {total != null && (
                <tr style={{ background:'#EAF4EF' }}>
                  <td colSpan={columns.length - 1} style={{ ...S.tdLeft, fontWeight:700, color:'#1C4942', fontSize:'0.74rem' }}>Total</td>
                  <td style={{ ...S.td, fontWeight:700, color:'#1C4942' }}>{fmtFull(total)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UtilisedDrillModal({ project, asOnDate, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.pocmRptProjectUtilisation(asOnDate, project.id).then(setD)
      .catch(e => setErr(e.response?.data?.error || e.message));
  }, [project.id, asOnDate]);
  const colsA = [
    { label: 'Payment Date', render: r => fmtDate(r.payment_date) },
    { label: 'Vendor', render: r => r.vendor },
    { label: 'Payment Number', render: r => r.payment_number },
    { label: 'Bill Number', render: r => r.bill_number },
    { label: 'Bill Date', render: r => fmtDate(r.bill_date) },
    { label: 'Project', render: r => r.project },
    { label: 'Amount Allocated to Bill', right: true,
      render: r => <>{fmtFull(r.amount)}{r.bill_share < 1 && <div style={{ fontSize:'0.62rem', color:'#9BA8B0' }}>{(r.bill_share * 100).toFixed(1)}% of bill on this project</div>}</> },
  ];
  const colsB = [
    { label: 'Payment Date', render: r => fmtDate(r.payment_date) },
    { label: 'Vendor', render: r => r.vendor },
    { label: 'Payment Number', render: r => r.payment_number },
    { label: 'PO Number', render: r => r.po_number || '—' },
    { label: 'Project from PO', render: r => r.po_project || '—' },
    { label: 'Project Name-', render: r => r.cf_project || '—' },
    { label: 'Mapping Source', render: r => <>{r.source}{r.note && <div style={{ fontSize:'0.62rem', color:'#B45309' }}>{r.note}</div>}</> },
    { label: 'Amount', right: true, render: r => fmtFull(r.amount) },
  ];
  return (
    <UtilModalShell title={project.name} subtitle={`Utilised by Project — Inception to ${asOnDate}`} onClose={onClose}>
      {err && <div style={S.notice}>{err}</div>}
      {!d && !err && <div style={{ color:'#5D6C7B', padding:'1.5rem', textAlign:'center' }}>Loading transactions…</div>}
      {d && (
        <>
          <UtilTable title="Section A — Payments Against Bills" columns={colsA} rows={d.sectionA} total={d.totals.bills}
            emptyText="No vendor payments adjusted against this project's bills up to the As-on Date."
            onExport={() => downloadCsv(`utilised-bills-${project.name}-${asOnDate}.csv`,
              ['Payment Date','Vendor','Payment Number','Bill Number','Bill Date','Project','Amount Allocated to Bill','Share of Bill'],
              d.sectionA.map(r => [r.payment_date, r.vendor, r.payment_number, r.bill_number, r.bill_date, r.project, Math.round(r.amount * 100) / 100, (r.bill_share * 100).toFixed(2) + '%']))} />
          <UtilTable title="Section B — Advance Payments (not yet adjusted against a bill)" columns={colsB} rows={d.sectionB} total={d.totals.advances}
            emptyText="No unadjusted advance payments mapped to this project at the As-on Date."
            onExport={() => downloadCsv(`utilised-advances-${project.name}-${asOnDate}.csv`,
              ['Payment Date','Vendor','Payment Number','PO Number','Project from PO','Project Name-','Mapping Source','Amount'],
              d.sectionB.map(r => [r.payment_date, r.vendor, r.payment_number, r.po_number, r.po_project, r.cf_project, r.source, Math.round(r.amount * 100) / 100]))} />
          <div style={{ display:'flex', justifyContent:'flex-end', gap:18, padding:'0.7rem 0.9rem', background:'#EAF4EF', borderRadius:8, color:'#1C4942', fontSize:'0.8rem', flexWrap:'wrap' }}>
            <span>Payments Against Bills <strong>{fmtFull(d.totals.bills)}</strong></span>
            <span>+ Advance Payments <strong>{fmtFull(d.totals.advances)}</strong></span>
            <span>= Utilised by Project <strong>{fmtFull(d.totals.total)}</strong></span>
          </div>
        </>
      )}
    </UtilModalShell>
  );
}

function UtilisationExceptionsModal({ asOnDate, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.pocmRptUtilisationExceptions(asOnDate).then(setD)
      .catch(e => setErr(e.response?.data?.error || e.message));
  }, [asOnDate]);
  const s = d?.stats || {};
  const counts = d ? [
    ['Bill payment allocations processed', s.billAllocations],
    ['Advance payments processed', s.advancePayments],
    ['Mapped through PO Number', s.viaPO],
    ['Mapped through Project Name-', s.viaProjectName],
    ['PO vs Project Name- mismatches', s.mismatches],
    ['Unmapped advance payments', s.unmapped],
    ['Advances later adjusted against bills (counted once)', s.advancesLaterAdjusted],
    ['Duplicates prevented', (s.duplicateAllocationsPrevented || 0) + (s.duplicatePaymentsDropped || 0)],
    ['Pending (bill project not yet fetched)', s.pendingCount],
  ] : [];
  const colsM = [
    { label: 'Payment Date', render: r => fmtDate(r.payment_date) },
    { label: 'Vendor Name', render: r => r.vendor },
    { label: 'Payment Number / Reference Number', render: r => <>{r.payment_number}{r.reference_number && <div style={{ fontSize:'0.62rem', color:'#9BA8B0' }}>{r.reference_number}</div>}</> },
    { label: 'Payment Amount', right: true, render: r => fmtFull(r.amount) },
    { label: 'PO Number', render: r => r.po_number },
    { label: 'Project as per PO Number', render: r => r.po_project },
    { label: 'Project as per "Project Name-"', render: r => r.cf_project },
    { label: 'Difference Status', render: r => r.status, color: () => S.negative },
  ];
  const colsU = [
    { label: 'Payment Date', render: r => fmtDate(r.payment_date) },
    { label: 'Vendor', render: r => r.vendor },
    { label: 'Payment Number', render: r => r.payment_number },
    { label: 'Amount', right: true, render: r => fmtFull(r.amount) },
    { label: 'PO Number', render: r => r.po_number || '—' },
    { label: 'Project Name-', render: r => r.cf_project || '—' },
    { label: 'Reason for not mapping', render: r => r.reason, color: () => '#B45309' },
  ];
  const colsP = [
    { label: 'Payment Date', render: r => fmtDate(r.payment_date) },
    { label: 'Vendor', render: r => r.vendor },
    { label: 'Payment Number', render: r => r.payment_number },
    { label: 'Bill Number', render: r => r.bill_number || '—' },
    { label: 'Reason', render: r => r.reason },
    { label: 'Amount', right: true, render: r => fmtFull(r.amount) },
  ];
  return (
    <UtilModalShell title="Utilised by Project — Validation" subtitle={`Advance payment mapping exceptions as at ${asOnDate} (all projects)`} onClose={onClose}>
      {err && <div style={S.notice}>{err}</div>}
      {!d && !err && <div style={{ color:'#5D6C7B', padding:'1.5rem', textAlign:'center' }}>Loading…</div>}
      {d && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(210px, 1fr))', gap:'0.5rem', marginBottom:'1.1rem' }}>
            {counts.map(([label, n]) => (
              <div key={label} style={{ background:'#F9F9F9', border:'1px solid #DFE7E3', borderRadius:7, padding:'0.45rem 0.7rem' }}>
                <div style={{ fontWeight:700, color:'#18191B', fontSize:'0.9rem' }}>{(n || 0).toLocaleString('en-IN')}</div>
                <div style={{ color:'#5D6C7B', fontSize:'0.66rem', marginTop:2 }}>{label}</div>
              </div>
            ))}
          </div>
          <UtilTable title="Project Mapping Mismatch" columns={colsM} rows={d.mismatches}
            emptyText="No advance payment has a PO project different from its Project Name-."
            onExport={() => downloadCsv(`project-mapping-mismatch-${asOnDate}.csv`,
              ['Payment Date','Vendor Name','Payment Number','Reference Number','Payment Amount','PO Number','Project as per PO Number','Project as per Project Name-','Difference Status'],
              d.mismatches.map(r => [r.payment_date, r.vendor, r.payment_number, r.reference_number, Math.round(r.amount * 100) / 100, r.po_number, r.po_project, r.cf_project, r.status]))} />
          <UtilTable title="Unmapped Advance Payments" columns={colsU} rows={d.unmapped}
            emptyText="Every advance payment has a PO Number or a Project Name-."
            onExport={() => downloadCsv(`unmapped-advance-payments-${asOnDate}.csv`,
              ['Payment Date','Vendor','Payment Number','Amount','PO Number','Project Name-','Reason for not mapping'],
              d.unmapped.map(r => [r.payment_date, r.vendor, r.payment_number, Math.round(r.amount * 100) / 100, r.po_number, r.cf_project, r.reason]))} />
          {d.pending.length > 0 && (
            <UtilTable title="Pending — not yet included" columns={colsP} rows={d.pending}
              emptyText="" onExport={null} />
          )}
        </>
      )}
    </UtilModalShell>
  );
}

function ProjectPLReport({ projects }) {
  const today = new Date().toISOString().slice(0, 10);
  const { user } = useAuth();
  const [asOnDate, setAsOnDate]     = useState(today);
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedIds, setSelectedIds]   = useState([]);
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');
  const [expanded, setExpanded] = useState({});
  const [syncing, setSyncing]     = useState(false);
  const [syncMsg, setSyncMsg]     = useState('');
  const [syncDropOpen, setSyncDropOpen] = useState(false);
  const [drillModal, setDrillModal] = useState(null);
  const [utilDrill, setUtilDrill]   = useState(null);
  const [utilExceptionsOpen, setUtilExceptionsOpen] = useState(false);

  const openDrill = (row, field) => setDrillModal({
    projectName: row.project?.name || '',
    field,
    monthRows: row.monthRows || [],
  });

  // Close sync dropdown on outside click. React 19 runs this effect before the opening
  // click reaches `document`, so clicks inside the button/menu must be ignored.
  const syncWrapRef = useRef(null);
  useEffect(() => {
    if (!syncDropOpen) return;
    const close = (e) => { if (!syncWrapRef.current?.contains(e.target)) setSyncDropOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [syncDropOpen]);

  const statusOptions = useMemo(() => {
    const s = new Set(projects.map(p => p.status).filter(Boolean));
    return [...s].sort();
  }, [projects]);

  const filteredProjects = useMemo(() =>
    statusFilter ? projects.filter(p => p.status === statusFilter) : projects
  , [projects, statusFilter]);

  const toggleId = (id) => setSelectedIds(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
  );
  const toggleAll = () => setSelectedIds(selectedIds.length > 0 ? [] : filteredProjects.map(p => p.id));
  const effectiveIds = selectedIds.length > 0 ? selectedIds : filteredProjects.map(p => p.id);

  async function runReport() {
    if (!asOnDate) return;
    setLoading(true); setErr(''); setData(null); setExpanded({});
    try {
      const result = await api.pocmRptProjectPL(asOnDate, effectiveIds.join(','));
      setData(result);
    } catch(e) {
      setErr(e.response?.data?.error || e.message || 'Failed to load report');
    } finally { setLoading(false); }
  }

  async function syncNow(mode = 'quick') {
    setSyncing(true); setSyncDropOpen(false);
    const label = mode === 'full' ? 'Full sync' : 'Quick sync';
    setSyncMsg(`${label} running — fetching changes from Zoho Books…`);
    const finish = (msg, rerun) => {
      setSyncMsg(msg); setSyncing(false);
      if (rerun) runReport();
      setTimeout(() => setSyncMsg(''), 15000);
    };
    const failedFYs = (fyList) => fyList.filter(f => f.status === 'failed').map(f => f.label || `FY ${f.fy}`);
    const syncFn = mode === 'full' ? api.pocmSyncFull : api.pocmSyncNow;
    try {
      const res = await syncFn({});
      const r = res?.result || {};
      if (r.status === 'skipped') return finish(`${label} not started — a sync is already running. Try again in a few minutes.`, false);
      const bad = failedFYs(Object.values(r.results || {}).map(x => ({ status: x?.status, fy: x?.fy, label: x?.fy ? `FY ${x.fy}-${String(x.fy + 1).slice(2)}` : '' })));
      finish(bad.length ? `${label} failed for ${bad.join(', ')} — other data refreshed.` : `${label} complete. Report refreshed with the latest data.`, true);
    } catch (e) {
      // The browser stops waiting after 2 minutes but the server keeps syncing — follow its status
      if (e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '')) {
        setSyncMsg(`${label} still running on the server — the report will refresh when it finishes…`);
        let s = null;
        for (let i = 0; i < 360 && !s; i++) {
          await new Promise(r => setTimeout(r, 10000));
          try { const st = await api.pocmSyncStatus(); if (!st.in_progress) s = st; } catch (_) {}
        }
        if (!s) return finish(`${label} is taking longer than expected — re-run the report later.`, false);
        const bad = failedFYs(s.fy_coverage || []);
        finish(bad.length ? `${label} failed for ${bad.join(', ')} — other data refreshed.` : `${label} complete. Report refreshed with the latest data.`, true);
      } else {
        finish(`${label} failed: ${e.response?.data?.error || e.message}`, false);
      }
    }
  }

  function exportCSV() {
    if (!data?.rows?.length) return;
    const h = ['Project','Client','Status','Cost to Date','% Complete','Recog. Revenue','Actual Revenue','Rev. Provision','Gross Profit','Salaries','Travelling','Marketing','Other','Total Overhead','Net Profit','GPM%','NPM%',
      'Project Value','Amount Recd. Till Date','Balance Receivable','Estimated Project Cost','Utilised by Project','Balance to Pay'];
    const csvAmt = (n) => (n == null ? '' : Math.round(n));
    const body = data.rows.filter(r => r.totals).map(r => {
      const t = r.totals;
      const tm = r.team || {};
      return [
        `"${r.project.name}"`, `"${r.project.client||''}"`, r.project.status||'',
        Math.round(t.cumCost), t.pct.toFixed(2),
        Math.round(t.cumRecognisedRevenue), Math.round(t.cumActualRevenue),
        Math.round(t.revenueProvision), Math.round(t.grossProfit),
        Math.round(t.salaries), Math.round(t.travelling), Math.round(t.marketing), Math.round(t.other),
        Math.round(t.totalOverhead), Math.round(t.netProfit),
        t.gpm != null ? t.gpm.toFixed(2) : '', t.npm != null ? t.npm.toFixed(2) : '',
        csvAmt(tm.projectValue), csvAmt(tm.amountRecd), csvAmt(tm.balanceReceivable),
        csvAmt(tm.estProjectCost), csvAmt(tm.utilised), csvAmt(tm.balanceToPay),
      ].join(',');
    });
    const csv  = [h.join(','), ...body].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `project-pl-${asOnDate}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const toggleExpand = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }));

  const rows = data?.rows || [];

  // Sales Team / Purchase Team cells (after Net Profit)
  const groupStart = { borderLeft: '1px solid #C5DDD8' };
  const balColor = (n) => (n != null && n < 0 ? S.negative : '#18191B');
  const teamCells = (tm, bold, project) => {
    const w = bold ? 700 : 600;
    if (!tm) return [0,1,2,3,4,5].map(k => <td key={`tm${k}`} style={{ ...S.td, ...(k === 0 || k === 3 ? groupStart : {}) }}>—</td>);
    return [
      <td key="pv" style={{ ...S.td, ...groupStart, color:'#1C4942', fontWeight:w }}>{fmtFull(tm.projectValue)}</td>,
      <td key="rc" style={{ ...S.td, color:'#18191B', fontWeight: bold ? 700 : 400 }}
        title={tm.amountRecd != null ? `Cash ${fmtFull(tm.amountRecdCash)} + TDS deducted by client ${fmtFull(tm.amountRecdTds)}` : 'Customer receipts not synced yet'}>
        {fmtFull(tm.amountRecd)}
        {tm.clientUnallocated > 0 && (
          <div style={{ color:'#B45309', fontSize:'0.63rem', fontWeight:400 }}
            title="Received from this client but not tied to a single project (the client has more than one Zoho project). Not included above.">
            +{fmtFull(tm.clientUnallocated)} unallocated
          </div>
        )}
      </td>,
      <td key="br" style={{ ...S.td, color: balColor(tm.balanceReceivable), fontWeight:w }}>{fmtFull(tm.balanceReceivable)}</td>,
      <td key="ec" style={{ ...S.td, ...groupStart, color:'#5D6C7B', fontWeight:w }}>{fmtFull(tm.estProjectCost)}</td>,
      <td key="ut"
        style={{ ...S.td, color:'#18191B', fontWeight: bold ? 700 : 400,
          ...(project && tm.utilised != null ? { cursor:'pointer', textDecoration:'underline dotted', textDecorationColor:'#9BA8B0', textUnderlineOffset:3 } : {}) }}
        title={tm.utilised != null ? `Payments against bills ${fmtFull(tm.utilisedBills)} + Advance payments ${fmtFull(tm.utilisedAdvances)}${project ? ' — click for transactions' : ''}` : 'Vendor payments not synced yet'}
        onClick={project && tm.utilised != null ? (e => { e.stopPropagation(); setUtilDrill(project); }) : undefined}>
        {fmtFull(tm.utilised)}
      </td>,
      <td key="bp" style={{ ...S.td, color: balColor(tm.balanceToPay), fontWeight:w }}>{fmtFull(tm.balanceToPay)}</td>,
    ];
  };

  return (
    <div>
      {/* Filter bar */}
      <div style={{ background:'#FFFFFF', border:'1px solid #DFE7E3', borderRadius:10, padding:'1rem', marginBottom:'1rem',
        display:'flex', gap:'0.75rem', flexWrap:'wrap', alignItems:'flex-start' }}>
        <div style={{ minWidth:165 }}>
          <label style={S.label}>As-on Date</label>
          <input type="date" style={{ ...S.input, minWidth:155 }} value={asOnDate} max={today}
            onChange={e => setAsOnDate(e.target.value)} />
        </div>
        <div style={{ minWidth:155 }}>
          <label style={S.label}>Project Status</label>
          <select style={S.select} value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setSelectedIds([]); }}>
            <option value="">— All Status —</option>
            {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ minWidth:240, flex:1 }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
            <label style={S.label}>Projects</label>
            <button style={{ background:'none', border:'none', color:'#1C4942', fontSize:'0.68rem', cursor:'pointer', padding:0 }}
              onClick={toggleAll}>
              {selectedIds.length > 0 ? 'Clear (include all)' : 'Deselect all'}
            </button>
          </div>
          <div style={{ border:'1px solid #DFE7E3', borderRadius:7, background:'#FFFFFF', maxHeight:120, overflowY:'auto', padding:'0.2rem 0' }}>
            {filteredProjects.map(p => (
              <label key={p.id} style={{ display:'flex', alignItems:'center', gap:7, padding:'0.28rem 0.75rem',
                cursor:'pointer', background: selectedIds.includes(p.id)?'#EAF4EF':'transparent' }}>
                <input type="checkbox" checked={selectedIds.length === 0 || selectedIds.includes(p.id)}
                  onChange={() => toggleId(p.id)} style={{ accentColor:'#1C4942' }} />
                <span style={{ fontSize:'0.76rem', color:'#18191B' }}>{p.name}</span>
                {p.client && <span style={{ fontSize:'0.68rem', color:'#9BA8B0' }}>· {p.client}</span>}
              </label>
            ))}
          </div>
        </div>
        <div style={{ alignSelf:'flex-end', display:'flex', gap:8 }}>
          <button style={S.btn} onClick={runReport} disabled={loading}>
            {loading ? 'Loading…' : 'Run Report'}
          </button>
          {data?.rows?.length > 0 && (
            <button style={{ ...S.btn, background:'#F2F2F2', color:'#5D6C7B', border:'1px solid #DFE7E3' }}
              onClick={exportCSV}>Export CSV</button>
          )}
        </div>
      </div>

      {/* Info banner */}
      {data && (
        <div style={{ background:'#EAF4EF', border:'1px solid #DFE7E3', borderRadius:8, padding:'0.6rem 1rem',
          marginBottom:'0.5rem', color:'#1C4942', fontSize:'0.78rem', display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
          <span style={{ fontWeight:700 }}>Project Inception to {data.asOnDate}</span>
          <span style={{ color:'#9BA8B0' }}>·</span>
          <span>All Financial Years — balances <strong>not reset</strong> at April 1</span>
          {data.fyCoverage && <span style={{ color:'#5D6C7B' }}>· {data.fyCoverage}</span>}
          <span style={{ color:'#9BA8B0' }}>·</span>
          <span>{rows.length} project{rows.length !== 1 ? 's' : ''}</span>
          {data.dataAsOf && (
            <>
              <span style={{ color:'#9BA8B0' }}>·</span>
              <span style={{ color:'#2D6B62' }}>
                Data as of: <strong>{formatDataAsOf(data.dataAsOf)}</strong>
              </span>
            </>
          )}
          {data.nextSync && (
            <span style={{ color:'#5D6C7B', fontSize:'0.73rem' }}>
              · Next sync: {formatNextSync(data.nextSync)}
            </span>
          )}
          {user?.role === 'admin' && (
            <div ref={syncWrapRef} style={{ marginLeft:'auto', position:'relative' }}>
              <button
                onClick={() => !syncing && setSyncDropOpen(o => !o)}
                disabled={syncing}
                style={{ background: syncing ? '#9BA8B0' : '#1C4942', color:'#EAF4EF',
                  border:'none', borderRadius:5, padding:'0.28rem 0.75rem', fontSize:'0.72rem',
                  cursor: syncing ? 'not-allowed' : 'pointer', whiteSpace:'nowrap', display:'flex', alignItems:'center', gap:4 }}>
                {syncing ? '⟳ Syncing…' : '⟳ Sync Now'}
                {!syncing && <span style={{ fontSize:'0.6rem', opacity:0.7 }}>▼</span>}
              </button>
              {syncDropOpen && (
                <div style={{ position:'absolute', right:0, top:'110%', background:'#001C20', border:'1px solid #1C4942',
                  borderRadius:6, minWidth:160, zIndex:100, boxShadow:'0 4px 16px rgba(0,0,0,0.35)' }}>
                  <button onClick={() => syncNow('quick')}
                    style={{ display:'block', width:'100%', background:'none', border:'none', color:'#A8C4C0',
                      padding:'0.5rem 1rem', fontSize:'0.75rem', textAlign:'left', cursor:'pointer' }}>
                    ⚡ Quick Sync
                    <div style={{ fontSize:'0.65rem', color:'#4A7A76', marginTop:2 }}>Incremental — new/changed only</div>
                  </button>
                  <div style={{ height:1, background:'#1C4942' }} />
                  <button onClick={() => syncNow('full')}
                    style={{ display:'block', width:'100%', background:'none', border:'none', color:'#A8C4C0',
                      padding:'0.5rem 1rem', fontSize:'0.75rem', textAlign:'left', cursor:'pointer' }}>
                    ↺ Full Sync
                    <div style={{ fontSize:'0.65rem', color:'#4A7A76', marginTop:2 }}>Refetch all data from Zoho</div>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {syncMsg && (
        <div style={{ background: syncMsg.includes('failed') || syncMsg.includes('Failed') ? '#FFF7ED' : '#EAF4EF',
          border:'1px solid', borderColor: syncMsg.includes('failed') || syncMsg.includes('Failed') ? '#FED7AA' : '#A7D4C0',
          borderRadius:7, padding:'0.4rem 0.9rem', marginBottom:'0.5rem',
          fontSize:'0.75rem', color: syncMsg.includes('failed') || syncMsg.includes('Failed') ? '#B45309' : '#1C4942' }}>
          {syncMsg}
        </div>
      )}

      {/* Utilised by Project — mapping validation summary */}
      {data?.utilisation && (() => {
        const us = data.utilisation.stats;
        const flagged = us.mismatches + us.unmapped;
        return (
          <div style={{ background:'#FFFFFF', border:'1px solid #DFE7E3', borderRadius:8, padding:'0.45rem 1rem', marginBottom:'0.5rem',
            fontSize:'0.74rem', color:'#5D6C7B', display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
            <span style={{ fontWeight:700, color:'#1C4942' }}>Utilised by Project</span>
            <span>{us.billAllocations.toLocaleString('en-IN')} bill payment allocations</span>
            <span style={{ color:'#9BA8B0' }}>·</span>
            <span>{us.advancePayments.toLocaleString('en-IN')} advance payments ({us.viaPO} via PO, {us.viaProjectName} via Project Name-)</span>
            <span style={{ color:'#9BA8B0' }}>·</span>
            <span style={{ color: us.mismatches ? S.negative : '#5D6C7B', fontWeight: us.mismatches ? 700 : 400 }}>{us.mismatches} PO / Project Name- mismatch{us.mismatches === 1 ? '' : 'es'}</span>
            <span style={{ color:'#9BA8B0' }}>·</span>
            <span style={{ color: us.unmapped ? '#B45309' : '#5D6C7B', fontWeight: us.unmapped ? 700 : 400 }}>{us.unmapped} unmapped advance{us.unmapped === 1 ? '' : 's'}</span>
            <button style={{ ...S.btnSm, marginLeft:'auto', ...(flagged ? { borderColor:'#FED7AA', background:'#FFF7ED', color:'#B45309' } : {}) }}
              onClick={() => setUtilExceptionsOpen(true)}>View validation lists</button>
          </div>
        );
      })()}

      {/* Overhead cache warnings */}
      {data?.warnings?.length > 0 && (
        <div style={{ background:'#FFF7ED', border:'1px solid #FED7AA', borderRadius:8, padding:'0.65rem 1rem', marginBottom:'1rem' }}>
          {data.warnings.map((w, i) => (
            <div key={i} style={{ color:'#B45309', fontSize:'0.76rem' }}>⚠ {w}</div>
          ))}
        </div>
      )}

      {err && <div style={S.notice}>{err}</div>}
      {loading && (
        <div style={{ textAlign:'center', padding:'2.5rem', color:'#5D6C7B' }}>
          <div style={{ marginBottom:8 }}>Fetching from Zoho Books — first load may take a minute…</div>
          <div style={{ fontSize:'0.72rem' }}>Bills and invoices for all FYs are loading in parallel.</div>
        </div>
      )}

      {!loading && !data && !err && (
        <div style={{ textAlign:'center', padding:'3rem', color:'#5D6C7B' }}>
          <div style={{ fontSize:'2rem', marginBottom:'0.5rem' }}>📊</div>
          <div>Select an As-on Date and click <strong style={{ color:'#1C4942' }}>Run Report</strong></div>
          <div style={{ fontSize:'0.75rem', marginTop:6 }}>Shows cumulative P&amp;L from each project's inception across all financial years.</div>
        </div>
      )}

      {/* Summary table */}
      {!loading && data?.rows?.length > 0 && (
        <div style={{ overflowX:'auto' }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th colSpan={8} style={{ ...S.thLeft, padding:'0.3rem 0.75rem', borderBottom:'none' }} />
                <th colSpan={3} style={{ ...S.th, ...groupStart, textAlign:'center', padding:'0.35rem 0.75rem', background:'#EAF4EF', color:'#1C4942', fontWeight:700, letterSpacing:'0.08em' }}>Sales Team</th>
                <th colSpan={3} style={{ ...S.th, ...groupStart, textAlign:'center', padding:'0.35rem 0.75rem', background:'#EAF4EF', color:'#1C4942', fontWeight:700, letterSpacing:'0.08em' }}>Purchase Team</th>
              </tr>
              <tr>
                <th style={{ ...S.thLeft, minWidth:200 }}>Project / Client</th>
                <th style={S.th}>Cost to Date</th>
                <th style={S.th}>% Complete</th>
                <th style={{ ...S.th, color: S.positive }}>Recog. Revenue</th>
                <th style={{ ...S.th, color:'#B45309' }}>Actual Revenue</th>
                <th style={{ ...S.th, color:'#B45309' }}>Rev. Provision</th>
                <th style={{ ...S.th, color: S.positive }}>Gross Profit</th>
                <th style={{ ...S.th, color: S.positive }}>Net Profit</th>
                <th style={{ ...S.th, ...groupStart }} title="From Projects — the estimate in effect at the As-on Date">Project Value</th>
                <th style={S.th} title="Customer receipts up to the As-on Date (cash + TDS deducted by client)">Amount Recd. Till Date</th>
                <th style={S.th} title="Project Value − Amount Recd. Till Date">Balance Receivable</th>
                <th style={{ ...S.th, ...groupStart }} title="From Projects — the estimate in effect at the As-on Date">Estimated Project Cost</th>
                <th style={S.th} title="Vendor payments up to the As-on Date: amounts adjusted against the project's bills + advance payments not yet adjusted (mapped by PO Number, else Project Name-). Click a figure for the transactions.">Utilised by Project</th>
                <th style={S.th} title="Estimated Project Cost − Utilised by Project">Balance to Pay</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const p = row.project || {};
                const t = row.totals;
                if (!t) return (
                  <tr key={p.id || i} style={{ background: i%2===0?'transparent':'rgba(0,18,20,0.025)' }}>
                    <td style={S.tdLeft} colSpan={8}>
                      <span style={{ color: '#9BA8B0', fontSize:'0.78rem' }}>{p.name} — no financial data in range</span>
                    </td>
                    {teamCells(row.team, false, p)}
                  </tr>
                );
                const isOpen   = !!expanded[p.id];
                const gpmColor = t.gpm == null ? '#9BA8B0' : t.gpm >= 0 ? S.positive : S.negative;
                const npmColor = t.npm == null ? '#9BA8B0' : t.npm >= 0 ? S.positive : S.negative;
                return (
                  <React.Fragment key={p.id || i}>
                    <tr style={{ background: i%2===0?'transparent':'rgba(0,18,20,0.025)', cursor:'pointer' }}
                        onClick={() => toggleExpand(p.id)}>
                      <td style={S.tdLeft}>
                        <div style={{ display:'flex', alignItems:'flex-start', gap:6 }}>
                          <span style={{ color: isOpen?'#1C4942':'#9BA8B0', fontSize:'0.7rem', marginTop:3, flexShrink:0,
                            transition:'transform 0.15s', display:'inline-block', transform: isOpen?'rotate(90deg)':'none' }}>▶</span>
                          <div>
                            <div style={{ fontWeight:600, color:'#18191B', fontSize:'0.82rem' }}>{p.name}</div>
                            {p.client && <div style={{ color:'#9BA8B0', fontSize:'0.68rem' }}>{p.client}</div>}
                            {p.status && <span style={{ display:'inline-block', marginTop:2, fontSize:'0.63rem', background:'#EAF4EF', color:'#1C4942', padding:'1px 6px', borderRadius:4 }}>{p.status}</span>}
                          </div>
                        </div>
                      </td>
                      <td style={{ ...S.td, cursor:'pointer', textDecoration:'underline dotted', textDecorationColor:'#9BA8B0', textUnderlineOffset:3 }}
                        title="Click to see year-wise breakdown"
                        onClick={e => { e.stopPropagation(); openDrill(row, 'cost'); }}>
                        {fmtFull(t.cumCost)}
                      </td>
                      <td style={{ ...S.td, color:'#5D6C7B', fontWeight:600 }}>{fmtPct(t.pct)}</td>
                      <td style={{ ...S.td, color: S.positive, fontWeight:600 }}>{fmtFull(t.cumRecognisedRevenue)}</td>
                      <td style={{ ...S.td, color:'#B45309', cursor:'pointer', textDecoration:'underline dotted', textDecorationColor:'#B45309', textUnderlineOffset:3 }}
                        title="Click to see year-wise breakdown"
                        onClick={e => { e.stopPropagation(); openDrill(row, 'actual'); }}>
                        {fmtFull(t.cumActualRevenue)}
                      </td>
                      <td style={{ ...S.td, color: t.revenueProvision >= 0 ? '#B45309' : '#9BA8B0', fontWeight:600 }}>
                        {fmtFull(t.revenueProvision)}
                      </td>
                      <td style={{ ...S.td, color: t.grossProfit>=0?S.positive:S.negative, fontWeight:700 }}>
                        {fmtFull(t.grossProfit)}
                        {t.gpm != null && <div style={{ color: gpmColor, fontSize:'0.63rem', fontWeight:400 }}>{fmtPct(t.gpm)}</div>}
                      </td>
                      <td style={{ ...S.td, color: t.netProfit>=0?S.positive:S.negative, fontWeight:700 }}>
                        {fmtFull(t.netProfit)}
                        {t.npm != null && <div style={{ color: npmColor, fontSize:'0.63rem', fontWeight:400 }}>{fmtPct(t.npm)}</div>}
                      </td>
                      {teamCells(row.team, false, p)}
                    </tr>
                    {isOpen && (
                      <tr style={{ background: '#F9F9F9' }}>
                        <td colSpan={14} style={{ padding:'0.75rem 1rem 1rem 2.5rem' }}>
                          <div style={{ maxWidth:520 }}>
                            <div style={{ fontWeight:700, color:'#5D6C7B', marginBottom:'0.5rem', fontSize:'0.68rem', textTransform:'uppercase', letterSpacing:'0.05em' }}>
                              P&L Account — Inception to {data?.asOnDate}
                            </div>
                            {[
                              { label: 'Recognised Revenue (POCM)',  value: t.cumRecognisedRevenue,  color: S.positive },
                              { label: 'Less: Direct Cost (COGS)',   value: -t.cumCost,               indent: true },
                              { label: 'Gross Profit',               value: t.grossProfit,            bold: true, color: t.grossProfit>=0?S.positive:S.negative, suffix: t.gpm!=null?` (${fmtPct(t.gpm)})`:'', sep: true },
                              { label: 'Less: Salaries',             value: -t.salaries,              indent: true },
                              { label: 'Less: Marketing',            value: -t.marketing,             indent: true },
                              { label: 'Less: Travelling',           value: -t.travelling,            indent: true },
                              { label: 'Less: Other Expenses',       value: -t.other,                 indent: true },
                              { label: 'Net Profit',                 value: t.netProfit,              bold: true, color: t.netProfit>=0?S.positive:S.negative, suffix: t.npm!=null?` (${fmtPct(t.npm)})`:'', sep: true },
                            ].map((line, li) => (
                              <div key={li} style={{ display:'flex', justifyContent:'space-between', padding: line.bold ? '0.3rem 0' : '0.18rem 0',
                                borderTop: line.sep ? '1px solid #DFE7E3' : 'none', marginTop: line.sep ? '0.05rem' : 0 }}>
                                <span style={{ color: line.indent ? '#5D6C7B' : '#18191B', paddingLeft: line.indent ? 16 : 0,
                                  fontWeight: line.bold ? 700 : 400, fontSize: '0.8rem' }}>{line.label}</span>
                                <span style={{ fontFamily:'monospace', color: line.color || (line.value < 0 ? S.negative : '#18191B'),
                                  fontWeight: line.bold ? 700 : 400, fontSize: '0.8rem' }}>
                                  {fmtFull(line.value)}{line.suffix || ''}
                                </span>
                              </div>
                            ))}
                            <div style={{ marginTop:'0.85rem', padding:'0.55rem 0.75rem', background:'#F2F2F2', borderRadius:6, border:'1px solid #DFE7E3' }}>
                              <div style={{ color:'#5D6C7B', fontSize:'0.65rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:'0.3rem' }}>Revenue Reconciliation</div>
                              {[
                                { label: 'Invoiced (Actual Revenue)',              value: t.cumActualRevenue, color: '#B45309' },
                                { label: 'Revenue Provision (Accrued / Unearned)', value: t.revenueProvision, color: t.revenueProvision >= 0 ? '#B45309' : '#9BA8B0' },
                              ].map((ln, li2) => (
                                <div key={li2} style={{ display:'flex', justifyContent:'space-between', padding:'0.15rem 0', fontSize:'0.78rem' }}>
                                  <span style={{ color:'#5D6C7B' }}>{ln.label}</span>
                                  <span style={{ fontFamily:'monospace', color: ln.color }}>{fmtFull(ln.value)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {rows.length > 1 && (() => {
                const withData = rows.filter(r => r.totals);
                if (!withData.length) return null;
                const sum = (f) => withData.reduce((s, r) => s + (r.totals[f] || 0), 0);
                const tGross = sum('grossProfit'), tNet = sum('netProfit'), tRev = sum('cumRecognisedRevenue');
                const withTeam = rows.filter(r => r.team);
                const teamSum = (f) => withTeam.some(r => r.team[f] == null) ? null : withTeam.reduce((s, r) => s + r.team[f], 0);
                const teamTotal = withTeam.length ? {
                  projectValue: teamSum('projectValue'), amountRecd: teamSum('amountRecd'),
                  amountRecdCash: teamSum('amountRecdCash'), amountRecdTds: teamSum('amountRecdTds'),
                  balanceReceivable: teamSum('balanceReceivable'), estProjectCost: teamSum('estProjectCost'),
                  utilised: teamSum('utilised'), utilisedBills: teamSum('utilisedBills'), utilisedAdvances: teamSum('utilisedAdvances'),
                  balanceToPay: teamSum('balanceToPay'), clientUnallocated: 0,
                } : null;
                return (
                  <tr style={{ background:'#EAF4EF', borderTop:'2px solid #DFE7E3' }}>
                    <td style={{ ...S.tdLeft, fontWeight:700, color:'#1C4942', fontSize:'0.74rem', textTransform:'uppercase' }}>
                      Total — All Projects
                    </td>
                    <td style={{ ...S.td, fontWeight:700 }}>{fmtFull(sum('cumCost'))}</td>
                    <td style={S.td}>—</td>
                    <td style={{ ...S.td, color: S.positive, fontWeight:700 }}>{fmtFull(tRev)}</td>
                    <td style={{ ...S.td, color:'#B45309', fontWeight:700 }}>{fmtFull(sum('cumActualRevenue'))}</td>
                    <td style={{ ...S.td, color:'#B45309', fontWeight:700 }}>{fmtFull(sum('revenueProvision'))}</td>
                    <td style={{ ...S.td, color: tGross>=0?S.positive:S.negative, fontWeight:700 }}>
                      {fmtFull(tGross)}
                      {tRev > 0 && <div style={{ fontSize:'0.63rem' }}>{fmtPct(tGross/tRev*100)}</div>}
                    </td>
                    <td style={{ ...S.td, color: tNet>=0?S.positive:S.negative, fontWeight:700 }}>
                      {fmtFull(tNet)}
                      {tRev > 0 && <div style={{ fontSize:'0.63rem' }}>{fmtPct(tNet/tRev*100)}</div>}
                    </td>
                    {teamCells(teamTotal, true)}
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </div>
      )}

      {drillModal && (
        <CostDrillModal
          open={true}
          onClose={() => setDrillModal(null)}
          projectName={drillModal.projectName}
          field={drillModal.field}
          monthRows={drillModal.monthRows}
        />
      )}
      {utilDrill && data && (
        <UtilisedDrillModal project={utilDrill} asOnDate={data.asOnDate} onClose={() => setUtilDrill(null)} />
      )}
      {utilExceptionsOpen && data && (
        <UtilisationExceptionsModal asOnDate={data.asOnDate} onClose={() => setUtilExceptionsOpen(false)} />
      )}
    </div>
  );
}

function ReportsTab({ projects, snapshots = [] }) {
  const [activeReport, setActiveReport] = useState('vendor-payments');
  const [selectedFY, setSelectedFY]     = useState(DEFAULT_FY);
  const [filterProject, setFilterProject] = useState('');
  const [filterClient, setFilterClient]   = useState('');
  const [filterMonth, setFilterMonth]     = useState('');
  const [filterQuarter, setFilterQuarter] = useState('');
  const [data, setData]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');

  const isPL = activeReport === 'project-pl';
  const selProject = projects.find(p => p.id === filterProject) || null;
  const isRevenueReport = activeReport === 'client-invoices' || activeReport === 'draft-invoices';

  // Auto-fill client name ONLY for revenue reports; clear for expense reports
  useEffect(() => {
    if (isRevenueReport && selProject) setFilterClient(selProject.client || '');
    else setFilterClient('');
  }, [filterProject, activeReport]); // eslint-disable-line

  // Clear data when report or filters change
  useEffect(() => { setData(null); setErr(''); }, [activeReport, selectedFY, filterProject, filterClient, filterMonth, filterQuarter]);

  const monthOptions = useMemo(() => {
    const opts = [];
    const months = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
    const mNums  = [4,5,6,7,8,9,10,11,12,1,2,3];
    for (let i = 0; i < 12; i++) {
      const yr = mNums[i] >= 4 ? selectedFY : selectedFY + 1;
      opts.push({ value: `${yr}-${String(mNums[i]).padStart(2,'0')}`, label: `${months[i]} ${yr}` });
    }
    return opts;
  }, [selectedFY]);

  async function fetchReport() {
    setLoading(true); setErr(''); setData(null);
    const [from, to] = getReportDateRange(selectedFY, filterQuarter, filterMonth);
    try {
      let result;
      if (activeReport === 'vendor-payments' || activeReport === 'advance-payments') {
        result = await api.pocmRptVendorPayments(from, to);
      } else if (activeReport === 'outstanding-bills') {
        result = await api.pocmRptOutstandingBills(from, to);
      } else if (activeReport === 'draft-pos') {
        result = await api.pocmRptPurchaseOrders('draft', from, to);
      } else if (activeReport === 'approved-pos') {
        result = await api.pocmRptPurchaseOrders('open', from, to);
      } else if (activeReport === 'client-invoices') {
        result = await api.pocmRptClientInvoices(from, to);
      } else if (activeReport === 'draft-invoices') {
        result = await api.pocmRptDraftInvoices();
      }
      setData(result);
    } catch(e) {
      setErr(e.response?.data?.error || e.message || 'Failed to fetch report');
    } finally { setLoading(false); }
  }

  // Client-side filter helpers
  const matchesVendor = (row) => {
    if (!filterClient) return true;
    return (row.vendor_name || '').toLowerCase().includes(filterClient.toLowerCase());
  };
  const matchesCustomer = (row) => {
    if (!filterClient) return true;
    return (row.customer_name || '').toLowerCase().includes(filterClient.toLowerCase());
  };
  // For expense reports: match by project_name on the row (set by Zoho on bills/POs)
  // For revenue reports: match customer_name against project's client name
  const matchesProject = (row) => {
    if (!selProject) return true;
    const projectName = (selProject.zohoProjectName || selProject.name || '').toLowerCase();
    if (isRevenueReport) {
      const clientKey = (selProject.client || '').substring(0, 20).toLowerCase();
      return !clientKey || (row.customer_name || '').toLowerCase().includes(clientKey);
    }
    // Expense: match by project_name field if present; if not present show row (vendor payments have no project_name)
    const rowProject = (row.project_name || '').toLowerCase();
    return !rowProject || rowProject.includes(projectName);
  };

  // ── Render helpers ────────────────────────────────────────────────────────
  const TH = (label, right) => <th style={right ? S.th : S.thLeft}>{label}</th>;

  function renderVendorPayments() {
    const isAdv = activeReport === 'advance-payments';

    if (!isAdv) {
      // Payment Report — prefer direct vendor payments; fall back to all bills if none
      const rawPayments = (data?.payments || []).filter(matchesVendor).filter(matchesProject);
      const rawBills    = (data?.bills    || []).filter(matchesVendor).filter(matchesProject);
      const useBills    = rawPayments.length === 0;

      if (!rawPayments.length && !rawBills.length) return (
        <div style={{ color:'#5D6C7B', padding:'2rem', textAlign:'center' }}>
          No payments found for the selected filters.
          <div style={{ marginTop:8, fontSize:'0.75rem' }}>No vendor payment records in Zoho Books for this period.</div>
        </div>
      );

      if (!useBills) {
        // ── Direct vendor payment records ─────────────────────────────
        const total = rawPayments.reduce((s,p) => s + (parseFloat(p.amount)||0), 0);
        return (
          <div style={{ overflowX:'auto' }}>
            <table style={S.table}>
              <thead><tr>
                {TH('Date')}{TH('Payment #')}{TH('Vendor')}{TH('Project')}
                {TH('Bill #')}{TH('Mode')}{TH('Amount Paid',true)}{TH('Unused',true)}
              </tr></thead>
              <tbody>
                {rawPayments.map((p,i) => (
                  <tr key={p.payment_id||i} style={{ background:i%2===0?'transparent':'rgba(0,18,20,0.025)' }}>
                    <td style={{ ...S.tdLeft, fontSize:'0.75rem' }}>{fmtDate(p.date)}</td>
                    <td style={{ ...S.tdLeft, color:'#1C4942', fontSize:'0.75rem' }}>{p.payment_number||'—'}</td>
                    <td style={{ ...S.tdLeft, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.vendor_name}</td>
                    <td style={{ ...S.tdLeft, color:'#a78bfa', fontSize:'0.72rem', maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.project_name||'—'}</td>
                    <td style={{ ...S.tdLeft, color:'#5D6C7B', fontSize:'0.72rem' }}>{(p.bills||[]).map(b=>b.bill_number).join(', ')||'—'}</td>
                    <td style={{ ...S.tdLeft, color:'#5D6C7B', fontSize:'0.75rem' }}>{p.payment_mode||'—'}</td>
                    <td style={{ ...S.td, color:'#22c55e', fontWeight:600 }}>{fmtFull(parseFloat(p.amount)||0)}</td>
                    <td style={{ ...S.td, color:(parseFloat(p.unused_amount)||0)>0?'#fbbf24':'#5D6C7B' }}>{fmtFull(parseFloat(p.unused_amount)||0)}</td>
                  </tr>
                ))}
                <tr style={{ background:'rgba(34,197,94,0.06)', borderTop:'2px solid #14532d' }}>
                  <td colSpan={6} style={{ ...S.tdLeft, fontWeight:700, color:'#22c55e', fontSize:'0.72rem', textTransform:'uppercase' }}>Total Paid</td>
                  <td style={{ ...S.td, color:'#22c55e', fontWeight:700 }}>{fmtFull(total)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        );
      }

      // ── Bill payment tracker fallback ──────────────────────────────
      const totBilled = rawBills.reduce((s,b) => s + (b.total||0), 0);
      const totPaid   = rawBills.reduce((s,b) => s + (b.payment_made||0), 0);
      const totBal    = rawBills.reduce((s,b) => s + (b.balance||0), 0);
      const sColor = { paid:'#22c55e', partial:'#fbbf24', open:'#1C4942', overdue:'#f87171' };
      return (
        <div>
          <div style={{ fontSize:'0.72rem', color:'#5D6C7B', marginBottom:'0.5rem' }}>No direct vendor payment records — showing bill payment status.</div>
          <div style={{ display:'flex', gap:'1rem', marginBottom:'0.75rem', flexWrap:'wrap' }}>
            {[['Total Billed',totBilled,'#c7d2fe','rgba(99,102,241,0.08)','rgba(99,102,241,0.2)'],
              ['Amount Paid', totPaid,  '#86efac','rgba(34,197,94,0.08)', 'rgba(34,197,94,0.2)'],
              ['Outstanding', totBal,   '#fca5a5','rgba(239,68,68,0.08)', 'rgba(239,68,68,0.2)']
            ].map(([label,val,fg,bg,br]) => (
              <div key={label} style={{ background:bg, border:`1px solid ${br}`, borderRadius:6, padding:'0.5rem 1rem', minWidth:140 }}>
                <div style={{ fontSize:'0.68rem', color:'#9BA8B0', textTransform:'uppercase', marginBottom:2 }}>{label}</div>
                <div style={{ fontSize:'1rem', fontWeight:700, color:fg }}>{fmtFull(val)}</div>
              </div>
            ))}
          </div>
          <div style={{ overflowX:'auto' }}>
            <table style={S.table}>
              <thead><tr>
                {TH('Bill Date')}{TH('Bill #')}{TH('Vendor')}{TH('Project')}
                {TH('Status')}{TH('Bill Total',true)}{TH('Paid',true)}{TH('Balance',true)}
              </tr></thead>
              <tbody>
                {rawBills.map((b,i) => {
                  const sc = sColor[(b.status||'').toLowerCase()] || '#9BA8B0';
                  return (
                    <tr key={b.bill_id||i} style={{ background:i%2===0?'transparent':'rgba(0,18,20,0.025)' }}>
                      <td style={{ ...S.tdLeft, fontSize:'0.75rem' }}>{fmtDate(b.date)}</td>
                      <td style={{ ...S.tdLeft, color:'#1C4942', fontSize:'0.75rem' }}>{b.bill_number||'—'}</td>
                      <td style={{ ...S.tdLeft, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.vendor_name}</td>
                      <td style={{ ...S.tdLeft, color:'#a78bfa', fontSize:'0.72rem', maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.project_name||'—'}</td>
                      <td style={{ ...S.tdLeft }}><span style={{ color:sc, fontSize:'0.7rem', fontWeight:700, textTransform:'uppercase' }}>{b.status}</span></td>
                      <td style={{ ...S.td }}>{fmtFull(b.total)}</td>
                      <td style={{ ...S.td, color:'#22c55e', fontWeight:600 }}>{fmtFull(b.payment_made)}</td>
                      <td style={{ ...S.td, color:b.balance>0?'#f87171':'#22c55e', fontWeight:600 }}>{fmtFull(b.balance)}</td>
                    </tr>
                  );
                })}
                <tr style={{ background:'rgba(99,102,241,0.06)', borderTop:'2px solid #312e81' }}>
                  <td colSpan={5} style={{ ...S.tdLeft, fontWeight:700, color:'#c7d2fe', fontSize:'0.72rem', textTransform:'uppercase' }}>Total</td>
                  <td style={{ ...S.td, color:'#18191B', fontWeight:700 }}>{fmtFull(totBilled)}</td>
                  <td style={{ ...S.td, color:'#22c55e', fontWeight:700 }}>{fmtFull(totPaid)}</td>
                  <td style={{ ...S.td, color:'#f87171', fontWeight:700 }}>{fmtFull(totBal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // Advance Payment Report — direct vendor payments with remaining balance
    const payments = (data?.payments || []).filter(p => {
      const apBills = p.bills || [];
      return apBills.length === 0 || (parseFloat(p.remaining_amount) || 0) > 0;
    }).filter(matchesVendor).filter(matchesProject);
    if (!payments.length) return (
      <div style={{ color:'#5D6C7B', padding:'2rem', textAlign:'center' }}>
        No advance payments found for the selected filters.
      </div>
    );
    const total = payments.reduce((s,p) => s + (parseFloat(p.amount)||0), 0);
    return (
      <div style={{ overflowX:'auto' }}>
        <table style={S.table}>
          <thead><tr>
            {TH('Date')}{TH('Payment #')}{TH('Vendor')}{TH('Project')}
            {TH('Mode')}{TH('Amount Paid',true)}{TH('Outstanding Balance',true)}
          </tr></thead>
          <tbody>
            {payments.map((p,i) => (
              <tr key={p.payment_id||i} style={{ background:i%2===0?'transparent':'rgba(0,18,20,0.025)' }}>
                <td style={{ ...S.tdLeft, fontSize:'0.75rem' }}>{fmtDate(p.date)}</td>
                <td style={{ ...S.tdLeft, color:'#1C4942', fontSize:'0.75rem' }}>{p.payment_number||'—'}</td>
                <td style={{ ...S.tdLeft, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.vendor_name}</td>
                <td style={{ ...S.tdLeft, color:'#a78bfa', fontSize:'0.72rem', maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.project_name||'—'}</td>
                <td style={{ ...S.tdLeft, color:'#5D6C7B', fontSize:'0.75rem' }}>{p.payment_mode||'—'}</td>
                <td style={{ ...S.td, color:'#22c55e', fontWeight:600 }}>{fmtFull(parseFloat(p.amount)||0)}</td>
                <td style={{ ...S.td, color:'#fbbf24', fontWeight:600 }}>{fmtFull(parseFloat(p.remaining_amount)||0)}</td>
              </tr>
            ))}
            <tr style={{ background:'rgba(34,197,94,0.06)', borderTop:'2px solid #14532d' }}>
              <td colSpan={6} style={{ ...S.tdLeft, fontWeight:700, color:'#22c55e', fontSize:'0.72rem', textTransform:'uppercase' }}>Total Advance Paid</td>
              <td style={{ ...S.td, color:'#22c55e', fontWeight:700 }}>{fmtFull(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  function renderOutstandingBills() {
    const bills = (data?.bills || []).filter(matchesVendor).filter(matchesProject);
    if (!bills.length) return <div style={{ color:'#5D6C7B', padding:'2rem', textAlign:'center' }}>No outstanding bills found.</div>;
    const totBal = bills.reduce((s,b) => s + (parseFloat(b.balance)||0), 0);
    const totAmt = bills.reduce((s,b) => s + (parseFloat(b.total)||0), 0);
    return (
      <div style={{ overflowX:'auto' }}>
        <table style={S.table}>
          <thead><tr>
            {TH('Bill Date')}{TH('Due Date')}{TH('Bill #')}{TH('Vendor')}{TH('Project')}
            {TH('Status')}{TH('Total', true)}{TH('Paid', true)}{TH('Balance Due', true)}{TH('Days Overdue', true)}
          </tr></thead>
          <tbody>
            {bills.map((b, i) => {
              const balance = parseFloat(b.balance) || 0;
              const paid    = (parseFloat(b.total)||0) - balance;
              const overdue = b.daysOutstanding || 0;
              return (
                <tr key={b.bill_id||i} style={{ background: i%2===0?'transparent':'rgba(0,18,20,0.025)' }}>
                  <td style={{ ...S.tdLeft, fontSize:'0.75rem' }}>{fmtDate(b.date)}</td>
                  <td style={{ ...S.tdLeft, fontSize:'0.75rem', color: overdue>0?'#ef4444':'#5D6C7B' }}>{fmtDate(b.due_date)}</td>
                  <td style={{ ...S.tdLeft, color:'#1C4942', fontSize:'0.75rem' }}>{b.bill_number}</td>
                  <td style={{ ...S.tdLeft, maxWidth:180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.vendor_name}</td>
                  <td style={{ ...S.tdLeft, color:'#a78bfa', fontSize:'0.72rem' }}>{b.project_name || '—'}</td>
                  <td style={{ ...S.tdLeft }}>
                    <span style={{ padding:'1px 6px', borderRadius:4, fontSize:'0.68rem', fontWeight:600,
                      background: b.status==='partial'?'rgba(251,191,36,0.12)':'rgba(239,68,68,0.12)',
                      color: b.status==='partial'?'#fbbf24':'#ef4444' }}>{b.status}</span>
                  </td>
                  <td style={S.td}>{fmtFull(parseFloat(b.total)||0)}</td>
                  <td style={{ ...S.td, color:'#22c55e' }}>{fmtFull(paid)}</td>
                  <td style={{ ...S.td, color:'#ef4444', fontWeight:700 }}>{fmtFull(balance)}</td>
                  <td style={{ ...S.td, color: overdue>30?'#ef4444':overdue>0?'#f97316':'#22c55e', fontWeight:600 }}>
                    {overdue > 0 ? `${overdue}d` : '—'}
                  </td>
                </tr>
              );
            })}
            <tr style={{ background:'rgba(239,68,68,0.06)', borderTop:'2px solid #7f1d1d' }}>
              <td colSpan={6} style={{ ...S.tdLeft, fontWeight:700, color:'#ef4444', fontSize:'0.72rem', textTransform:'uppercase' }}>Total</td>
              <td style={{ ...S.td, color:'#18191B', fontWeight:700 }}>{fmtFull(totAmt)}</td>
              <td style={{ ...S.td, color:'#22c55e', fontWeight:700 }}>{fmtFull(totAmt - totBal)}</td>
              <td style={{ ...S.td, color:'#ef4444', fontWeight:700 }}>{fmtFull(totBal)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  function renderPurchaseOrders() {
    const isDraft = activeReport === 'draft-pos';
    const pos = (data?.purchaseOrders || []).filter(po => {
      if (!matchesProject(po)) return false;
      if (filterClient) return (po.vendor_name||'').toLowerCase().includes(filterClient.toLowerCase());
      return true;
    });
    if (!pos.length) return <div style={{ color:'#5D6C7B', padding:'2rem', textAlign:'center' }}>No purchase orders found.</div>;
    const totAmt = pos.reduce((s,p) => s + (parseFloat(p.total)||0), 0);
    const totPending = pos.reduce((s,p) => s + (parseFloat(p.balance)||parseFloat(p.total)||0), 0);
    return (
      <div style={{ overflowX:'auto' }}>
        <table style={S.table}>
          <thead><tr>
            {TH('PO Date')}{TH('PO #')}{TH('Vendor')}{TH('Project')}
            {isDraft ? TH('Days in Draft', true) : TH('Billed Status')}
            {TH('PO Total', true)}
            {!isDraft && TH('Billed Amount', true)}
            {!isDraft && TH('Pending to Bill', true)}
          </tr></thead>
          <tbody>
            {pos.map((po, i) => {
              const total    = parseFloat(po.total) || 0;
              const balance  = parseFloat(po.balance) || total;
              const billed   = total - balance;
              const billedSt = po.billed_status || po.status;
              return (
                <tr key={po.purchaseorder_id||i} style={{ background: i%2===0?'transparent':'rgba(0,18,20,0.025)' }}>
                  <td style={{ ...S.tdLeft, fontSize:'0.75rem' }}>{fmtDate(po.date)}</td>
                  <td style={{ ...S.tdLeft, color:'#1C4942', fontSize:'0.75rem' }}>{po.purchaseorder_number}</td>
                  <td style={{ ...S.tdLeft, maxWidth:180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{po.vendor_name}</td>
                  <td style={{ ...S.tdLeft, color:'#a78bfa', fontSize:'0.72rem' }}>{po.project_name || po.reference_number || '—'}</td>
                  {isDraft
                    ? <td style={{ ...S.td, color: (po.daysInStatus||0)>30?'#ef4444':'#fbbf24', fontWeight:600 }}>{po.daysInStatus||0}d</td>
                    : <td style={{ ...S.tdLeft }}>
                        <span style={{ padding:'1px 6px', borderRadius:4, fontSize:'0.68rem', fontWeight:600,
                          background: billedSt==='fully_billed'?'rgba(34,197,94,0.12)':billedSt==='partial'||billedSt==='partially_billed'?'rgba(251,191,36,0.12)':'#EAF4EF',
                          color: billedSt==='fully_billed'?'#22c55e':billedSt==='partial'||billedSt==='partially_billed'?'#fbbf24':'#1C4942' }}>
                          {billedSt || 'pending'}
                        </span>
                      </td>
                  }
                  <td style={{ ...S.td, fontWeight:600 }}>{fmtFull(total)}</td>
                  {!isDraft && <td style={{ ...S.td, color:'#22c55e' }}>{fmtFull(billed)}</td>}
                  {!isDraft && <td style={{ ...S.td, color: balance>0?'#f97316':'#22c55e', fontWeight:700 }}>{fmtFull(balance)}</td>}
                </tr>
              );
            })}
            <tr style={{ background:'rgba(99,102,241,0.08)', borderTop:'2px solid #4338ca' }}>
              <td colSpan={isDraft?4:4} style={{ ...S.tdLeft, fontWeight:700, color:'#818cf8', fontSize:'0.72rem', textTransform:'uppercase' }}>Total</td>
              <td style={S.td}>—</td>
              <td style={{ ...S.td, color:'#18191B', fontWeight:700 }}>{fmtFull(totAmt)}</td>
              {!isDraft && <td style={{ ...S.td, color:'#22c55e', fontWeight:700 }}>{fmtFull(totAmt - totPending)}</td>}
              {!isDraft && <td style={{ ...S.td, color:'#f97316', fontWeight:700 }}>{fmtFull(totPending)}</td>}
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  function renderClientInvoices() {
    const invoices  = (data?.invoices  || []).filter(matchesCustomer).filter(matchesProject);
    const payments  = (data?.payments  || []).filter(matchesCustomer).filter(matchesProject);
    const totInv    = invoices.reduce((s,i)  => s + (parseFloat(i.total)||0), 0);
    const totBal    = invoices.reduce((s,i)  => s + (parseFloat(i.balance)||0), 0);
    const totPaid   = invoices.reduce((s,i)  => s + ((parseFloat(i.total)||0) - (parseFloat(i.balance)||0)), 0);
    const totPay    = payments.reduce((s,p)  => s + (parseFloat(p.amount)||0), 0);
    const totUnused = payments.reduce((s,p)  => s + (parseFloat(p.unused_amount)||0), 0);
    if (!invoices.length && !payments.length) return <div style={{ color:'#5D6C7B', padding:'2rem', textAlign:'center' }}>No invoices / payments found.</div>;
    return (
      <div>
        {invoices.length > 0 && (
          <>
            <div style={{ color:'#5D6C7B', fontSize:'0.75rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem' }}>Invoices</div>
            <div style={{ overflowX:'auto', marginBottom:'1.5rem' }}>
              <table style={S.table}>
                <thead><tr>
                  {TH('Invoice Date')}{TH('Invoice #')}{TH('Customer')}{TH('Status')}
                  {TH('Total', true)}{TH('Amount Received', true)}{TH('Outstanding', true)}
                </tr></thead>
                <tbody>
                  {invoices.map((inv, i) => {
                    const balance = parseFloat(inv.balance) || 0;
                    const received = (parseFloat(inv.total)||0) - balance;
                    return (
                      <tr key={inv.invoice_id||i} style={{ background: i%2===0?'transparent':'rgba(0,18,20,0.025)' }}>
                        <td style={{ ...S.tdLeft, fontSize:'0.75rem' }}>{fmtDate(inv.date)}</td>
                        <td style={{ ...S.tdLeft, color:'#fbbf24', fontSize:'0.75rem' }}>{inv.invoice_number}</td>
                        <td style={{ ...S.tdLeft, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{inv.customer_name}</td>
                        <td style={{ ...S.tdLeft }}>
                          <span style={{ padding:'1px 6px', borderRadius:4, fontSize:'0.68rem', fontWeight:600,
                            background: inv.status==='paid'?'rgba(34,197,94,0.12)':inv.status==='partial'?'rgba(251,191,36,0.12)':inv.status==='overdue'?'rgba(239,68,68,0.12)':'#EAF4EF',
                            color: inv.status==='paid'?'#22c55e':inv.status==='partial'?'#fbbf24':inv.status==='overdue'?'#ef4444':'#1C4942' }}>
                            {inv.status}
                          </span>
                        </td>
                        <td style={S.td}>{fmtFull(parseFloat(inv.total)||0)}</td>
                        <td style={{ ...S.td, color:'#22c55e' }}>{fmtFull(received)}</td>
                        <td style={{ ...S.td, color: balance>0?'#ef4444':'#22c55e', fontWeight:700 }}>{fmtFull(balance)}</td>
                      </tr>
                    );
                  })}
                  <tr style={{ background:'rgba(251,191,36,0.06)', borderTop:'2px solid #78350f' }}>
                    <td colSpan={4} style={{ ...S.tdLeft, fontWeight:700, color:'#fbbf24', fontSize:'0.72rem', textTransform:'uppercase' }}>Total</td>
                    <td style={{ ...S.td, color:'#18191B', fontWeight:700 }}>{fmtFull(totInv)}</td>
                    <td style={{ ...S.td, color:'#22c55e', fontWeight:700 }}>{fmtFull(totPaid)}</td>
                    <td style={{ ...S.td, color: totBal>0?'#ef4444':'#22c55e', fontWeight:700 }}>{fmtFull(totBal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
        {payments.length > 0 && (
          <>
            <div style={{ color:'#5D6C7B', fontSize:'0.75rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem' }}>Customer Payments Received</div>
            <div style={{ overflowX:'auto' }}>
              <table style={S.table}>
                <thead><tr>
                  {TH('Payment Date')}{TH('Payment #')}{TH('Customer')}{TH('Mode')}
                  {TH('Amount', true)}{TH('Applied to Invoices', true)}{TH('Unused / Advance', true)}
                </tr></thead>
                <tbody>
                  {payments.map((p, i) => {
                    const unused = parseFloat(p.unused_amount) || 0;
                    const applied = (parseFloat(p.amount)||0) - unused;
                    return (
                      <tr key={p.payment_id||i} style={{ background: i%2===0?'transparent':'rgba(0,18,20,0.025)' }}>
                        <td style={{ ...S.tdLeft, fontSize:'0.75rem' }}>{fmtDate(p.date)}</td>
                        <td style={{ ...S.tdLeft, color:'#22c55e', fontSize:'0.75rem' }}>{p.payment_number}</td>
                        <td style={{ ...S.tdLeft, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.customer_name}</td>
                        <td style={{ ...S.tdLeft, color:'#5D6C7B', fontSize:'0.75rem' }}>{p.payment_mode || '—'}</td>
                        <td style={{ ...S.td, fontWeight:600 }}>{fmtFull(parseFloat(p.amount)||0)}</td>
                        <td style={{ ...S.td, color:'#34d399' }}>{fmtFull(applied)}</td>
                        <td style={{ ...S.td, color: unused>0?'#fbbf24':'#5D6C7B', fontWeight: unused>0?700:400 }}>{fmtFull(unused)}</td>
                      </tr>
                    );
                  })}
                  <tr style={{ background:'rgba(34,197,94,0.06)', borderTop:'2px solid #14532d' }}>
                    <td colSpan={4} style={{ ...S.tdLeft, fontWeight:700, color:'#22c55e', fontSize:'0.72rem', textTransform:'uppercase' }}>Total</td>
                    <td style={{ ...S.td, color:'#18191B', fontWeight:700 }}>{fmtFull(totPay)}</td>
                    <td style={{ ...S.td, color:'#34d399', fontWeight:700 }}>{fmtFull(totPay - totUnused)}</td>
                    <td style={{ ...S.td, color: totUnused>0?'#fbbf24':'#5D6C7B', fontWeight:700 }}>{fmtFull(totUnused)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderDraftInvoices() {
    const invoices = (data?.invoices || []).filter(matchesCustomer).filter(matchesProject);
    if (!invoices.length) return <div style={{ color:'#5D6C7B', padding:'2rem', textAlign:'center' }}>No draft invoices found.</div>;
    return (
      <div style={{ overflowX:'auto' }}>
        <table style={S.table}>
          <thead><tr>
            {TH('Invoice Date')}{TH('Invoice #')}{TH('Customer')}{TH('Project')}
            {TH('Amount', true)}{TH('Days in Draft', true)}
          </tr></thead>
          <tbody>
            {invoices.map((inv, i) => {
              const days = inv.daysInDraft || 0;
              return (
                <tr key={inv.invoice_id||i} style={{ background: i%2===0?'transparent':'rgba(0,18,20,0.025)' }}>
                  <td style={{ ...S.tdLeft, fontSize:'0.75rem' }}>{fmtDate(inv.date)}</td>
                  <td style={{ ...S.tdLeft, color:'#fbbf24', fontSize:'0.75rem' }}>{inv.invoice_number || '—'}</td>
                  <td style={{ ...S.tdLeft, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{inv.customer_name}</td>
                  <td style={{ ...S.tdLeft, color:'#a78bfa', fontSize:'0.72rem' }}>{inv.project_name || '—'}</td>
                  <td style={S.td}>{fmtFull(parseFloat(inv.total)||0)}</td>
                  <td style={{ ...S.td, color: days>30?'#ef4444':days>7?'#f97316':'#fbbf24', fontWeight:700 }}>{days}d</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderReport() {
    if (!data) return null;
    if (activeReport === 'vendor-payments' || activeReport === 'advance-payments') return renderVendorPayments();
    if (activeReport === 'outstanding-bills')  return renderOutstandingBills();
    if (activeReport === 'draft-pos' || activeReport === 'approved-pos') return renderPurchaseOrders();
    if (activeReport === 'client-invoices')    return renderClientInvoices();
    if (activeReport === 'draft-invoices')     return renderDraftInvoices();
    return null;
  }

  const [from, to] = getReportDateRange(selectedFY, filterQuarter, filterMonth);
  const curInfo = REPORT_LIST.find(r => r.id === activeReport);

  return (
    <div>
      {/* Report sub-navigation */}
      <div style={{ display:'flex', gap:0, marginBottom:'1.25rem', borderBottom:'1px solid #DFE7E3', flexWrap:'wrap' }}>
        {['Expense','Revenue','P&L'].map(group => (
          <div key={group} style={{ display:'flex', flexDirection:'column', marginRight:'1.5rem' }}>
            <div style={{ color: group === 'P&L' ? '#1C4942' : '#5D6C7B', fontSize:'0.65rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', padding:'0.3rem 0.5rem 0.1rem' }}>{group}</div>
            <div style={{ display:'flex', gap:2 }}>
              {REPORT_LIST.filter(r => r.group === group).map(r => (
                <button key={r.id} style={{ ...S.tab(activeReport === r.id), fontSize:'0.75rem', padding:'0.4rem 0.85rem' }}
                  onClick={() => setActiveReport(r.id)}>{r.label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {isPL ? <ProjectPLReport projects={projects} /> : (<>
      {/* Filters */}
      <div style={{ background:'#FFFFFF', border:'1px solid #DFE7E3', borderRadius:10, padding:'1rem', marginBottom:'1.25rem', display:'flex', gap:'0.75rem', flexWrap:'wrap', alignItems:'flex-end' }}>
        <div style={{ minWidth:130 }}>
          <label style={S.label}>Financial Year</label>
          <select style={{ ...S.select, background:'#F9F9F9', border:'1px solid #DFE7E3', color:'#1C4942', fontWeight:700 }}
            value={selectedFY} onChange={e => setSelectedFY(parseInt(e.target.value))}>
            {FY_OPTIONS.map(o => <option key={o.value} value={o.value}>FY {o.label}</option>)}
          </select>
        </div>
        <div style={{ minWidth:180 }}>
          <label style={S.label}>Project Name</label>
          <select style={S.select} value={filterProject} onChange={e => setFilterProject(e.target.value)}>
            <option value="">— All Projects —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={{ minWidth:180 }}>
          <label style={S.label}>{isRevenueReport ? 'Client Name' : 'Vendor Name'}</label>
          <input style={S.input} value={filterClient} onChange={e => setFilterClient(e.target.value)}
            placeholder={isRevenueReport ? 'Filter by client…' : 'Filter by vendor…'} />
        </div>
        <div style={{ minWidth:130 }}>
          <label style={S.label}>Quarter</label>
          <select style={S.select} value={filterQuarter} onChange={e => { setFilterQuarter(e.target.value); setFilterMonth(''); }}>
            <option value="">— Full Year —</option>
            {[1,2,3,4].map(q => <option key={q} value={q}>{QUARTER_LABELS[q]}</option>)}
          </select>
        </div>
        <div style={{ minWidth:140 }}>
          <label style={S.label}>Month</label>
          <select style={S.select} value={filterMonth} onChange={e => { setFilterMonth(e.target.value); setFilterQuarter(''); }}>
            <option value="">— All Months —</option>
            {monthOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label style={S.label}>&nbsp;</label>
          <button style={S.btn} onClick={fetchReport} disabled={loading}>
            {loading ? 'Loading…' : 'Run Report'}
          </button>
        </div>
      </div>

      {/* Range info */}
      {!loading && data && (
        <div style={{ color:'#5D6C7B', fontSize:'0.72rem', marginBottom:'0.75rem' }}>
          {curInfo?.label} · {from} to {to}
          {(() => {
            const raw = data.payments?.length || data.bills?.length || data.purchaseOrders?.length || (data.invoices?.length || 0) + (data.payments?.length || 0) || 0;
            return raw > 0 ? <span style={{ marginLeft:8, color:'#5D6C7B' }}>· {raw} record{raw!==1?'s':''} fetched from Zoho</span> : null;
          })()}
          {filterClient && <span style={{ marginLeft:8, color:'#1C4942' }}>· {isRevenueReport ? 'Client' : 'Vendor'}: {filterClient}</span>}
        </div>
      )}

      {err && <div style={S.notice}>{err}</div>}
      {loading && <div style={{ textAlign:'center', padding:'2rem', color:'#5D6C7B' }}>Fetching from Zoho Books…</div>}

      {!loading && !data && !err && (
        <div style={{ textAlign:'center', padding:'3rem', color:'#5D6C7B' }}>
          <div style={{ fontSize:'2rem', marginBottom:'0.5rem' }}>📋</div>
          Set your filters above and click <strong style={{ color:'#1C4942' }}>Run Report</strong> to fetch data.
        </div>
      )}

      {renderReport()}
      </>)}
    </div>
  );
}

// ── Summary Tab ──────────────────────────────────────────────────────────────
function SummaryTab({ projects, snapshots = [] }) {
  const [selectedFY, setSelectedFY] = useState(DEFAULT_FY);
  const [allData, setAllData]       = useState({});
  const [loading, setLoading]       = useState(false);
  const [loadingName, setLoadingName] = useState('');
  const [err, setErr]               = useState('');
  const [fyDrillDown, setFyDrillDown] = useState(null); // { title, project, field, type }

  const LS_TTL = 24 * 60 * 60 * 1000; // 24h — sync happens at 11PM

  const readCache = (projectId) => {
    try {
      const raw = localStorage.getItem(`pocm_v5_${projectId}_fy${selectedFY}`);
      if (!raw) return null;
      const { data, ts } = JSON.parse(raw);
      return Date.now() - ts < LS_TTL ? data : null;
    } catch { return null; }
  };

  const saveCache = (projectId, data) => {
    try {
      localStorage.setItem(`pocm_v5_${projectId}_fy${selectedFY}`, JSON.stringify({ data, ts: Date.now() }));
    } catch {}
  };

  // On mount / FY change, pull whatever is already in localStorage
  useEffect(() => {
    const fromCache = {};
    for (const p of projects) {
      const c = readCache(p.id);
      if (c) fromCache[p.id] = c;
    }
    setAllData(fromCache);
  }, [selectedFY, projects.length]); // eslint-disable-line

  const loadAll = useCallback(async (forceRefresh = false) => {
    if (!projects.length) return;
    setLoading(true); setErr('');
    const from = `${selectedFY}-04-01`;
    const to   = `${selectedFY + 1}-03-31`;
    const totalPortfolioValue = projects.reduce((s, p) => s + (parseFloat(p.value) || 0), 0);

    try {
      // Bill line-item detail is the slow part (one Zoho call per bill) — for a full
      // FY that can be 500+ calls, well past any single request's timeout. Warm the
      // shared bill cache in small tranches first, with visible progress, so no
      // single request has to finish the whole list.
      let trancheDone = false;
      while (!trancheDone) {
        const t = await api.pocmBillsTranche(from);
        trancheDone = t.complete;
        if (trancheDone) break;
        if (t.busy) {
          // Another tab/request is mid-batch for this FY — wait, don't race it
          await new Promise(r => setTimeout(r, 2000));
        } else if (t.retryAfterSecs) {
          // Zoho's per-minute limit was hit — back off before retrying the same bill
          for (let s = t.retryAfterSecs; s > 0; s--) {
            setLoadingName(`Fetching bills… ${t.done}/${t.total} (rate limited, resuming in ${s}s)`);
            await new Promise(r => setTimeout(r, 1000));
          }
        } else {
          setLoadingName(`Fetching bills… ${t.done}/${t.total}`);
        }
      }

      // Overhead is shared — fetch once (bill cache is now warm, so this returns fast)
      const ohData = await api.pocmMonthlyOverhead(from, to);

      const result = { ...allData };
      for (const project of projects) {
        if (!forceRefresh && result[project.id]) continue;
        setLoadingName(project.name);
        try {
          const zohoProject = project.zohoProjectName || project.name || '';
          const expData = await api.pocmMonthlyExpenses(from, to, zohoProject);
          const revData = await api.pocmMonthlyRevenue(from, to, zohoProject, project.client || '');
          const salaryRatio    = totalPortfolioValue > 0 ? (parseFloat(project.value) || 0) / totalPortfolioValue : 0;
          const projectStartYM = project.startDate.substring(0, 7);
          const mergedByMonth  = { ...expData.byMonth };
          for (const [m, rev] of Object.entries(revData.byMonth || {})) {
            if (!mergedByMonth[m]) mergedByMonth[m] = { projectCost: 0 };
            mergedByMonth[m].actualRevenue = rev.actualRevenue || 0;
          }
          for (const [m, oh] of Object.entries(ohData.byMonth || {})) {
            if (!mergedByMonth[m]) mergedByMonth[m] = { projectCost: 0 };
            if (m >= projectStartYM) {
              mergedByMonth[m].salaries   = Math.round((oh.salary      || 0) * salaryRatio);
              mergedByMonth[m].travelling = Math.round((oh.travelling  || 0) * salaryRatio);
              mergedByMonth[m].marketing  = Math.round((oh.marketing   || 0) * salaryRatio);
              mergedByMonth[m].other      = Math.round((oh.other       || 0) * salaryRatio);
            }
          }
          const merged = { ...expData, byMonth: mergedByMonth, revenueDetails: revData.details || {}, overheadDetails: ohData.details || {}, salaryRatio, fetchedAt: Date.now() };
          result[project.id] = merged;
          saveCache(project.id, merged);
        } catch (e) {
          if (e.message?.includes('ZOHO_DAILY_LIMIT')) throw e;
          console.warn(`Summary: failed to load ${project.name}:`, e.message);
        }
      }
      setAllData(result);
    } catch (e) {
      const msg = e.response?.data?.error || e.message || 'Unknown error';
      setErr(msg.includes('ZOHO_DAILY_LIMIT') ? '⚠️ Zoho daily API limit reached. Try again tomorrow.' : msg);
    } finally {
      setLoadingName('');
      setLoading(false);
    }
  }, [projects, selectedFY, allData]); // eslint-disable-line

  // Compute POCM rows for every project
  const allPocmRows = useMemo(() => {
    const out = {};
    for (const p of projects) {
      if (allData[p.id]) out[p.id] = computePOCM(p, allData[p.id], selectedFY, snapshots);
    }
    return out;
  }, [allData, projects, selectedFY, snapshots]);

  const missingCount = projects.filter(p => !allData[p.id]).length;

  // Shared aggregation — quarterly AND full-FY views both reduce the SAME
  // per-month rows from computePOCM (one source of truth). Additive fields
  // (cost, revenue, salaries, ...) are summed across whatever rows are passed
  // in; cumulative/closing fields (cumCost, pct, cumRevenue, cumNet, ...) are
  // taken from the LAST row instead of summed, so a full-FY aggregate never
  // double-counts a closing balance across its constituent quarters.
  const aggregateProjectRows = (rows) => {
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    const sum  = (f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
    return { last,
      projectCost: sum('projectCost'),   cumCost: last.cumCost,      pct: last.pct,
      revThisMonth: sum('revThisMonth'), cumRevenue: last.cumRevenue,
      actualRevenue: sum('actualRevenue'), cumActualRevenue: last.cumActualRevenue,
      revenueProvision: sum('revenueProvision'), grossProfit: sum('grossProfit'),
      salaries: sum('salaries'),   travelling: sum('travelling'), netProfit1: sum('netProfit1'),
      marketing: sum('marketing'), other: sum('other'),
      netProfit: sum('netProfit'), cumNet: last.cumNet,
    };
  };

  const getQRows = (q) =>
    projects.map(project => {
      const rows = allPocmRows[project.id] || [];
      const qRows = rows.filter(r => getIndianFYQuarter(r.month) === q);
      const agg = aggregateProjectRows(qRows);
      return agg ? { project, ...agg } : null;
    }).filter(Boolean);

  // Full Financial Year = same aggregation over the project's UNFILTERED row
  // set (every month April→March, or April→latest-available-month for an
  // ongoing FY — computePOCM already caps months at "today", so this is
  // automatically FY-to-date with no separate YTD logic needed).
  const getFYRows = () =>
    projects.map(project => {
      const rows = allPocmRows[project.id] || [];
      const agg = aggregateProjectRows(rows);
      return agg ? { project, rows, ...agg } : null;
    }).filter(Boolean);

  // FY drill-down: "FY Total → Quarter → underlying transactions" for one
  // project/field. Quarter breakdown reuses the identical per-quarter
  // aggregation as the quarterly report; the transaction list reuses whatever
  // Monthly Working already stores for that project (details/creditDetails/
  // overheadDetails/revenueDetails) — no new data-fetching, one source of truth.
  const FIELD_SOURCE = {
    projectCost:  { label: 'Cost',           kind: 'cost' },
    actualRevenue:{ label: 'Actual Revenue', kind: 'revenue' },
    salaries:     { label: 'Salaries',       kind: 'overhead', cat: 'salary' },
    travelling:   { label: 'Travelling',     kind: 'overhead', cat: 'travelling' },
    marketing:    { label: 'Marketing',      kind: 'overhead', cat: 'marketing' },
    other:        { label: 'Other Expenses', kind: 'overhead', cat: 'other' },
  };

  const openFyDrill = (project, field) => {
    const rows = allPocmRows[project.id] || [];
    if (!rows.length) return;
    const src = FIELD_SOURCE[field];
    const quarters = [1, 2, 3, 4].map(q => {
      const qRows = rows.filter(r => getIndianFYQuarter(r.month) === q);
      const amount = qRows.reduce((s, r) => s + (r[field] || 0), 0);
      return { q, amount, hasData: qRows.length > 0 };
    });
    const fyTotal = quarters.reduce((s, qr) => s + qr.amount, 0);

    const pd = allData[project.id] || {};
    let drillRows = [], creditRows = [];
    if (src.kind === 'cost') {
      drillRows  = rows.flatMap(r => pd.details?.[r.month] || []);
      creditRows = rows.flatMap(r => pd.creditDetails?.[r.month] || []);
    } else if (src.kind === 'revenue') {
      drillRows = rows.flatMap(r => pd.revenueDetails?.[r.month] || []);
    } else if (src.kind === 'overhead') {
      drillRows = rows.flatMap(r => (pd.overheadDetails?.[r.month] || []).filter(d => d._cat === src.cat))
        .map(d => ({ ...d, amount: Math.round(d.amount * (pd.salaryRatio || 0)) }));
    }

    setFyDrillDown({
      title: `FY ${selectedFY}-${String(selectedFY + 1).slice(2)} — ${project.name} — ${src.label}`,
      rows: drillRows,
      creditRows: src.kind === 'cost' ? creditRows : undefined,
      type: src.kind === 'revenue' ? 'revenue' : src.kind === 'overhead' ? src.cat : undefined,
      quarterBreakdown: { quarters, fyTotal },
    });
  };

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 140 }}>
          <label style={S.label}>Financial Year</label>
          <select style={{ ...S.select, background: '#F9F9F9', border: '1px solid #DFE7E3', color: '#1C4942', fontWeight: 700 }}
            value={selectedFY} onChange={e => setSelectedFY(parseInt(e.target.value))}>
            {FY_OPTIONS.map(o => <option key={o.value} value={o.value}>FY {o.label}</option>)}
          </select>
        </div>
        <button style={S.btn} onClick={() => loadAll(false)} disabled={loading}>
          {loading ? (loadingName.startsWith('Fetching bills') ? loadingName : `Loading… ${loadingName}`) : missingCount > 0 ? `↺ Load ${missingCount} Missing Project${missingCount > 1 ? 's' : ''}` : '↺ Refresh All'}
        </button>
        {!loading && missingCount > 0 && (
          <span style={{ color: '#f59e0b', fontSize: '0.78rem', alignSelf: 'center' }}>
            {missingCount} project{missingCount > 1 ? 's' : ''} not yet loaded — click Load to fetch
          </span>
        )}
      </div>

      {err && <div style={S.notice}>{err}</div>}

      {[1, 2, 3, 4].map(q => {
        const qRows = getQRows(q);
        if (!qRows.length) return null;
        const tot = (f) => qRows.reduce((s, r) => s + (r[f] || 0), 0);
        const tGross = tot('grossProfit'), tNet1 = tot('netProfit1'), tNet = tot('netProfit'), tCumNet = tot('cumNet');
        const tProv  = tot('revenueProvision');

        return (
          <div key={q} style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.6rem' }}>
              <div style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid #4338ca', borderRadius: 6, padding: '2px 10px', color: '#818cf8', fontWeight: 700, fontSize: '0.78rem' }}>
                {QUARTER_LABELS[q]}
              </div>
              <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.88rem' }}>
                POCM Summary — All Projects · Quarterly Closing
                <span style={{ marginLeft: 10, color: '#1C4942', fontWeight: 500, fontSize: '0.78rem' }}>FY {selectedFY}-{String(selectedFY + 1).slice(2)}</span>
              </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={{ ...S.thLeft, minWidth: 160 }}>Project / Client</th>
                    <th style={S.th}>Cost This Qtr</th>
                    <th style={S.th}>Cum. Cost</th>
                    <th style={S.th}>% Complete</th>
                    <th style={S.th}>Revenue This Qtr</th>
                    <th style={S.th}>Cum. Revenue</th>
                    <th style={{ ...S.th, color: '#fbbf24' }}>Actual Revenue</th>
                    <th style={{ ...S.th, color: '#fbbf24' }}>Cum. Actual Rev.</th>
                    <th style={{ ...S.th, color: '#fb923c' }}>Rev. Provision</th>
                    <th style={S.th}>Gross Profit</th>
                    <th style={S.th}>Salaries</th>
                    <th style={S.th}>Travelling</th>
                    <th style={{ ...S.th, color: '#34d399' }}>Net Profit (1)</th>
                    <th style={S.th}>Marketing</th>
                    <th style={S.th}>Other</th>
                    <th style={{ ...S.th, color: '#34d399' }}>Final Net Profit</th>
                    <th style={{ ...S.th, color: '#34d399' }}>Final Cum. Net Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {qRows.map((r, i) => (
                    <tr key={r.project.id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,18,20,0.025)' }}>
                      <td style={S.tdLeft}>
                        <div style={{ fontWeight: 600, color: '#18191B', fontSize: '0.8rem' }}>{r.project.name}</div>
                        {r.project.client && <div style={{ color: '#5D6C7B', fontSize: '0.68rem' }}>{r.project.client}</div>}
                      </td>
                      <td style={S.td}>{fmtFull(r.projectCost)}</td>
                      <td style={{ ...S.td, color: '#818cf8' }}>{fmtFull(r.cumCost)}</td>
                      <td style={{ ...S.td, color: '#a78bfa', fontWeight: 600 }}>{fmtPct(r.pct)}</td>
                      <td style={{ ...S.td, color: '#34d399' }}>{fmtFull(r.revThisMonth)}</td>
                      <td style={{ ...S.td, color: '#34d399' }}>{fmtFull(r.cumRevenue)}</td>
                      <td style={{ ...S.td, color: '#fbbf24', fontWeight: 600 }}>{fmtFull(r.actualRevenue)}</td>
                      <td style={{ ...S.td, color: '#fbbf24' }}>{fmtFull(r.cumActualRevenue)}</td>
                      <td style={{ ...S.td, color: r.revenueProvision >= 0 ? '#fb923c' : '#f87171', fontWeight: 600 }}>{fmtFull(r.revenueProvision)}</td>
                      <td style={{ ...S.td, color: r.grossProfit >= 0 ? S.positive : S.negative, fontWeight: 600 }}>{fmtFull(r.grossProfit)}</td>
                      <td style={S.td}>{fmtFull(r.salaries)}</td>
                      <td style={S.td}>{fmtFull(r.travelling)}</td>
                      <td style={{ ...S.td, color: r.netProfit1 >= 0 ? S.positive : S.negative, fontWeight: 600 }}>{fmtFull(r.netProfit1)}</td>
                      <td style={S.td}>{fmtFull(r.marketing)}</td>
                      <td style={S.td}>{fmtFull(r.other)}</td>
                      <td style={{ ...S.td, color: r.netProfit >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(r.netProfit)}</td>
                      <td style={{ ...S.td, color: r.cumNet >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(r.cumNet)}</td>
                    </tr>
                  ))}
                  {/* Total row */}
                  <tr style={{ background: 'rgba(99,102,241,0.12)', borderTop: '2px solid #4338ca' }}>
                    <td style={{ ...S.tdLeft, color: '#818cf8', fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase' }}>Total — All Projects</td>
                    <td style={{ ...S.td, color: '#18191B', fontWeight: 700 }}>{fmtFull(tot('projectCost'))}</td>
                    <td style={{ ...S.td, color: '#818cf8', fontWeight: 700 }}>{fmtFull(tot('cumCost'))}</td>
                    <td style={S.td}>—</td>
                    <td style={{ ...S.td, color: '#34d399', fontWeight: 700 }}>{fmtFull(tot('revThisMonth'))}</td>
                    <td style={{ ...S.td, color: '#34d399', fontWeight: 700 }}>{fmtFull(tot('cumRevenue'))}</td>
                    <td style={{ ...S.td, color: '#fbbf24', fontWeight: 700 }}>{fmtFull(tot('actualRevenue'))}</td>
                    <td style={{ ...S.td, color: '#fbbf24', fontWeight: 700 }}>{fmtFull(tot('cumActualRevenue'))}</td>
                    <td style={{ ...S.td, color: tProv >= 0 ? '#fb923c' : '#f87171', fontWeight: 700 }}>{fmtFull(tProv)}</td>
                    <td style={{ ...S.td, color: tGross >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(tGross)}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(tot('salaries'))}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(tot('travelling'))}</td>
                    <td style={{ ...S.td, color: tNet1 >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(tNet1)}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(tot('marketing'))}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(tot('other'))}</td>
                    <td style={{ ...S.td, color: tNet >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(tNet)}</td>
                    <td style={{ ...S.td, color: tCumNet >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(tCumNet)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {/* ══ Full Financial Year Summary — All Projects ══════════════════════ */}
      {(() => {
        const fyRows = getFYRows();
        if (!fyRows.length) return null;

        const fyEndYM = `${selectedFY + 1}-03`;
        const latestMonth = fyRows.reduce((max, r) => {
          const m = r.last?.month;
          return (!max || (m && m > max)) ? m : max;
        }, null);
        const isYTD = latestMonth && latestMonth < fyEndYM;

        const tot = (f) => fyRows.reduce((s, r) => s + (r[f] || 0), 0);
        const tGross = tot('grossProfit'), tNet1 = tot('netProfit1'), tNet = tot('netProfit');
        const tProv  = tot('revenueProvision'), tRev = tot('revThisMonth');
        const margin = tRev !== 0 ? (tNet / tRev) * 100 : null;

        const kpis = [
          { label: 'Total FY Revenue',        val: fmtINR(tRev),               color: '#34d399' },
          { label: 'Total FY Actual Revenue', val: fmtINR(tot('actualRevenue')), color: '#fbbf24' },
          { label: 'Total FY Cost',           val: fmtINR(tot('projectCost')),   color: '#9BA8B0' },
          { label: 'FY Gross Profit',         val: fmtINR(tGross),               color: tGross >= 0 ? S.positive : S.negative },
          { label: 'Total FY Salaries',       val: fmtINR(tot('salaries')),      color: '#9BA8B0' },
          { label: 'Total FY Travelling',     val: fmtINR(tot('travelling')),    color: '#9BA8B0' },
          { label: 'Total FY Marketing',      val: fmtINR(tot('marketing')),     color: '#9BA8B0' },
          { label: 'Total FY Other Expenses', val: fmtINR(tot('other')),         color: '#9BA8B0' },
          { label: 'FY Net Profit (1)',       val: fmtINR(tNet1),                color: tNet1 >= 0 ? S.positive : S.negative },
          { label: 'FY Final Net Profit',     val: fmtINR(tNet),                 color: tNet >= 0 ? S.positive : S.negative },
        ];

        return (
          <div style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
              <div style={{ background: '#EAF4EF', border: '1px solid #1C4942', borderRadius: 6, padding: '3px 12px', color: '#1C4942', fontWeight: 700, fontSize: '0.8rem' }}>
                FULL FINANCIAL YEAR (APR–MAR) — POCM SUMMARY — ALL PROJECTS
              </div>
              <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.88rem' }}>
                FY {selectedFY}-{String(selectedFY + 1).slice(2)} · 1 April {selectedFY} to 31 March {selectedFY + 1}
              </div>
              {isYTD && (
                <div style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid #a16207', borderRadius: 6, padding: '2px 10px', color: '#fbbf24', fontWeight: 600, fontSize: '0.72rem' }}>
                  YTD through {fmtMonthLabel(latestMonth)}
                </div>
              )}
            </div>

            {/* KPI cards */}
            <div style={{ ...S.kpiGrid, marginBottom: '1rem' }}>
              {kpis.map(k => (
                <div key={k.label} style={S.kpiBox}>
                  <div style={{ ...S.kpiVal, color: k.color }}>{k.val}</div>
                  <div style={S.kpiLbl}>{k.label}</div>
                </div>
              ))}
              <div style={S.kpiBox}>
                <div style={{ ...S.kpiVal, color: margin == null ? '#5D6C7B' : margin >= 0 ? S.positive : S.negative }}>
                  {margin == null ? '—' : fmtPct(margin)}
                </div>
                <div style={S.kpiLbl}>Final Net Profit Margin %</div>
              </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={{ ...S.thLeft, minWidth: 160 }}>Project / Client</th>
                    <th style={S.th}>Cost (FY)</th>
                    <th style={S.th}>Cum. Cost</th>
                    <th style={S.th}>% Complete</th>
                    <th style={S.th}>Revenue (FY)</th>
                    <th style={S.th}>Cum. Revenue</th>
                    <th style={{ ...S.th, color: '#fbbf24' }}>Actual Revenue</th>
                    <th style={{ ...S.th, color: '#fbbf24' }}>Cum. Actual Rev.</th>
                    <th style={{ ...S.th, color: '#fb923c' }}>Rev. Provision</th>
                    <th style={S.th}>Gross Profit</th>
                    <th style={S.th}>Salaries</th>
                    <th style={S.th}>Travelling</th>
                    <th style={{ ...S.th, color: '#34d399' }}>Net Profit (1)</th>
                    <th style={S.th}>Marketing</th>
                    <th style={S.th}>Other</th>
                    <th style={{ ...S.th, color: '#34d399' }}>Final Net Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {fyRows.map((r, i) => {
                    const clickable = { cursor: 'pointer', textDecoration: 'underline dotted', textDecorationColor: '#DFE7E3' };
                    return (
                      <tr key={r.project.id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,18,20,0.025)' }}>
                        <td style={S.tdLeft}>
                          <div style={{ fontWeight: 600, color: '#18191B', fontSize: '0.8rem' }}>{r.project.name}</div>
                          {r.project.client && <div style={{ color: '#5D6C7B', fontSize: '0.68rem' }}>{r.project.client}</div>}
                        </td>
                        <td style={{ ...S.td, ...clickable }} onClick={() => openFyDrill(r.project, 'projectCost')}>{fmtFull(r.projectCost)}</td>
                        <td style={{ ...S.td, color: '#818cf8' }}>{fmtFull(r.cumCost)}</td>
                        <td style={{ ...S.td, color: '#a78bfa', fontWeight: 600 }}>{fmtPct(r.pct)}</td>
                        <td style={{ ...S.td, color: '#34d399' }}>{fmtFull(r.revThisMonth)}</td>
                        <td style={{ ...S.td, color: '#34d399' }}>{fmtFull(r.cumRevenue)}</td>
                        <td style={{ ...S.td, color: '#fbbf24', fontWeight: 600, ...clickable }} onClick={() => openFyDrill(r.project, 'actualRevenue')}>{fmtFull(r.actualRevenue)}</td>
                        <td style={{ ...S.td, color: '#fbbf24' }}>{fmtFull(r.cumActualRevenue)}</td>
                        <td style={{ ...S.td, color: r.revenueProvision >= 0 ? '#fb923c' : '#f87171', fontWeight: 600 }}>{fmtFull(r.revenueProvision)}</td>
                        <td style={{ ...S.td, color: r.grossProfit >= 0 ? S.positive : S.negative, fontWeight: 600 }}>{fmtFull(r.grossProfit)}</td>
                        <td style={{ ...S.td, ...clickable }} onClick={() => openFyDrill(r.project, 'salaries')}>{fmtFull(r.salaries)}</td>
                        <td style={{ ...S.td, ...clickable }} onClick={() => openFyDrill(r.project, 'travelling')}>{fmtFull(r.travelling)}</td>
                        <td style={{ ...S.td, color: r.netProfit1 >= 0 ? S.positive : S.negative, fontWeight: 600 }}>{fmtFull(r.netProfit1)}</td>
                        <td style={{ ...S.td, ...clickable }} onClick={() => openFyDrill(r.project, 'marketing')}>{fmtFull(r.marketing)}</td>
                        <td style={{ ...S.td, ...clickable }} onClick={() => openFyDrill(r.project, 'other')}>{fmtFull(r.other)}</td>
                        <td style={{ ...S.td, color: r.netProfit >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(r.netProfit)}</td>
                      </tr>
                    );
                  })}
                  {/* Total row */}
                  <tr style={{ background: 'rgba(52,211,153,0.10)', borderTop: '2px solid #065f46' }}>
                    <td style={{ ...S.tdLeft, color: '#34d399', fontWeight: 700, fontSize: '0.78rem', textTransform: 'uppercase' }}>Total — All Projects</td>
                    <td style={{ ...S.td, color: '#18191B', fontWeight: 700 }}>{fmtFull(tot('projectCost'))}</td>
                    <td style={{ ...S.td, color: '#818cf8', fontWeight: 700 }}>{fmtFull(tot('cumCost'))}</td>
                    <td style={S.td}>—</td>
                    <td style={{ ...S.td, color: '#34d399', fontWeight: 700 }}>{fmtFull(tRev)}</td>
                    <td style={{ ...S.td, color: '#34d399', fontWeight: 700 }}>{fmtFull(tot('cumRevenue'))}</td>
                    <td style={{ ...S.td, color: '#fbbf24', fontWeight: 700 }}>{fmtFull(tot('actualRevenue'))}</td>
                    <td style={{ ...S.td, color: '#fbbf24', fontWeight: 700 }}>{fmtFull(tot('cumActualRevenue'))}</td>
                    <td style={{ ...S.td, color: tProv >= 0 ? '#fb923c' : '#f87171', fontWeight: 700 }}>{fmtFull(tProv)}</td>
                    <td style={{ ...S.td, color: tGross >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(tGross)}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(tot('salaries'))}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(tot('travelling'))}</td>
                    <td style={{ ...S.td, color: tNet1 >= 0 ? S.positive : S.negative, fontWeight: 700 }}>{fmtFull(tNet1)}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(tot('marketing'))}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{fmtFull(tot('other'))}</td>
                    <td style={{ ...S.td, color: tNet >= 0 ? S.positive : S.negative, fontWeight: 800, fontSize: '0.88rem' }}>{fmtFull(tNet)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {fyDrillDown && <DrillDown {...fyDrillDown} onClose={() => setFyDrillDown(null)} />}

      {!loading && Object.keys(allData).length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#5D6C7B' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>📊</div>
          <div style={{ fontWeight: 600, color: '#5D6C7B', marginBottom: 6 }}>No data loaded yet</div>
          <div style={{ fontSize: '0.82rem' }}>Click "Load" above, or load individual projects in Monthly Working first.</div>
        </div>
      )}
    </div>
  );
}

// ── COA Mapping Tab ───────────────────────────────────────────────────────────
function COAMapping() {
  const [accounts, setAccounts] = useState([]);
  const [mapping, setMapping] = useState({ projectCost: [], salaries: [], marketing: [], travelling: [], other: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    Promise.all([api.pocmAccounts(), api.pocmMapping()])
      .then(([accts, mp]) => {
        setAccounts(accts);
        setMapping({ projectCost: [], salaries: [], marketing: [], travelling: [], other: [], ...mp });
      })
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  function getCat(id) {
    for (const cat of ['projectCost', 'salaries', 'marketing', 'travelling', 'other']) {
      if (mapping[cat]?.includes(id)) return cat;
    }
    return '';
  }

  function setCat(id, cat) {
    setMapping(prev => {
      const next = { ...prev };
      for (const c of ['projectCost', 'salaries', 'marketing', 'travelling', 'other']) {
        next[c] = (next[c] || []).filter(x => x !== id);
      }
      if (cat) next[cat] = [...(next[cat] || []), id];
      return next;
    });
    setSaved(false);
  }

  async function saveMapping() {
    setSaving(true); setErr('');
    try {
      await api.pocmSaveMapping(mapping);
      setSaved(true);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  const catLabels = {
    '': 'Not Mapped',
    projectCost: 'Project Cost (COGS)',
    salaries:    'Salaries & Wages',
    marketing:   'Marketing Expenses',
    travelling:  'Travelling & Hotel Expenses',
    other:       'Other Operating Expenses',
  };

  const catColors = {
    projectCost: '#1C4942',
    salaries:    '#8b5cf6',
    marketing:   '#ec4899',
    travelling:  '#f97316',
    other:       '#5D6C7B',
  };

  const summary = ['projectCost', 'salaries', 'marketing', 'travelling', 'other']
    .map(c => ({ cat: c, count: (mapping[c] || []).length }))
    .filter(x => x.count > 0);

  const filtered = accounts.filter(a =>
    !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.type.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <div style={{ padding: '2rem', color: '#5D6C7B' }}>Loading chart of accounts from Zoho Books (Needle And Thread)…</div>;

  return (
    <div>
      <div style={S.notice}>
        Map each Zoho Books Chart of Account to an expense category. This determines how actual costs are classified for POCM calculations.
        <br />Only accounts mapped to "Project Cost (COGS)" are used in the Percentage of Completion formula. Other categories are deducted for profitability but not for % complete.
      </div>

      {/* Summary */}
      {summary.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          {summary.map(({ cat, count }) => (
            <span key={cat} style={{ padding: '3px 10px', borderRadius: 5, fontSize: '0.73rem', fontWeight: 600, background: catColors[cat] + '22', color: catColors[cat], border: `1px solid ${catColors[cat]}44` }}>
              {catLabels[cat]}: {count} accounts
            </span>
          ))}
        </div>
      )}

      {err && <div style={{ color: '#ef4444', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{err}</div>}

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', alignItems: 'center' }}>
        <input style={{ ...S.input, maxWidth: 300 }} placeholder="Search accounts…" value={search} onChange={e => setSearch(e.target.value)} />
        <button style={S.btn} onClick={saveMapping} disabled={saving}>{saving ? 'Saving…' : 'Save Mapping'}</button>
        {saved && <span style={{ color: '#22c55e', fontSize: '0.8rem' }}>✓ Mapping saved</span>}
      </div>

      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #DFE7E3' }}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.thLeft}>Account Name</th>
              <th style={S.thLeft}>Account Type</th>
              <th style={S.thLeft}>Category Mapping</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((acct, i) => {
              const cat = getCat(acct.id);
              return (
                <tr key={acct.id} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,18,20,0.025)' }}>
                  <td style={S.tdLeft}>{acct.name}</td>
                  <td style={{ ...S.tdLeft, color: '#5D6C7B', fontSize: '0.75rem' }}>{acct.type}</td>
                  <td style={S.tdLeft}>
                    <select
                      value={cat}
                      onChange={e => setCat(acct.id, e.target.value)}
                      style={{ ...S.select, maxWidth: 240, padding: '0.3rem 0.6rem', fontSize: '0.75rem',
                        color: cat ? catColors[cat] : '#5D6C7B',
                        borderColor: cat ? catColors[cat] + '66' : '#DFE7E3',
                        background: cat ? catColors[cat] + '11' : '#FFFFFF',
                      }}
                    >
                      <option value="">— Not Mapped —</option>
                      {Object.entries(catLabels).filter(([k]) => k).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && accounts.length === 0 && (
        <div style={{ textAlign: 'center', padding: '2rem', color: '#5D6C7B', fontSize: '0.85rem' }}>
          No accounts loaded. Ensure the server can reach Zoho Books (org: 60007894213).
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function POCMDashboard() {
  const { user } = useAuth();
  const [tab, setTab] = useState('projects');
  const [projects, setProjects] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [quarterlyUpdateProject, setQuarterlyUpdateProject] = useState(null);
  const [historyProject, setHistoryProject] = useState(null);
  const [err, setErr] = useState('');

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.pocmProjects();
      setProjects(data);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);

  const loadSnapshots = useCallback(async () => {
    try { setSnapshots(await api.pocmQuarterlyEstimates()); } catch (_) {}
  }, []);

  useEffect(() => { loadProjects(); loadSnapshots(); }, [loadProjects, loadSnapshots]);

  async function handleSave(proj) {
    await api.pocmSaveProject(proj);
    await loadProjects();
    setShowForm(false);
    setEditing(null);
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this project?')) return;
    await api.pocmDeleteProject(id);
    await loadProjects();
  }

  function handleSelect(project) {
    setTab('working');
  }

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <h1 style={S.title}>POCM Dashboard — Needle And Thread Designs LLP</h1>
        <div style={S.sub}>Percentage of Completion Method · Ind AS 115 / IFRS 15 · Zoho Books Org: 60007894213</div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {[
          { id: 'projects', label: 'Projects' },
          { id: 'working',  label: 'Monthly Working' },
          { id: 'summary',  label: 'Summary' },
          { id: 'reports',  label: 'Reports' },
          { id: 'mapping',  label: 'COA Mapping' },
        ].map(t => (
          <button key={t.id} style={S.tab(tab === t.id)} onClick={() => { setTab(t.id); setShowForm(false); setEditing(null); }}>
            {t.label}
          </button>
        ))}
      </div>

      {err && <div style={S.notice}>{err}</div>}

      {/* ── Projects Tab ── always mounted */}
      <div style={{ display: tab === 'projects' ? 'block' : 'none' }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div style={{ color: '#5D6C7B', fontSize: '0.82rem' }}>
              {projects.length} project{projects.length !== 1 ? 's' : ''} · Needle And Thread Designs LLP
            </div>
            {!showForm && !editing && (
              <button style={S.btn} onClick={() => setShowForm(true)}>+ Add Project</button>
            )}
          </div>

          {(showForm || editing) && (
            <ProjectForm
              initial={editing}
              onSave={handleSave}
              onCancel={() => { setShowForm(false); setEditing(null); }}
            />
          )}

          {loading && <div style={{ color: '#5D6C7B', fontSize: '0.85rem' }}>Loading…</div>}

          {!loading && projects.length === 0 && !showForm && (
            <div style={{ textAlign: 'center', padding: '3rem', color: '#5D6C7B' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📋</div>
              <div style={{ fontWeight: 600, color: '#5D6C7B', marginBottom: 6 }}>No projects yet</div>
              <div style={{ fontSize: '0.82rem' }}>Add your first project to start POCM tracking.</div>
            </div>
          )}

          {projects.map(p => (
            <ProjectCard
              key={p.id}
              project={p}
              snapshots={snapshots}
              onEdit={proj => { setEditing(proj); setShowForm(false); window.scrollTo(0, 0); }}
              onDelete={handleDelete}
              onSelect={handleSelect}
              onQuarterlyUpdate={setQuarterlyUpdateProject}
              onViewHistory={setHistoryProject}
            />
          ))}
        </div>
      </div>

      {quarterlyUpdateProject && (
        <QuarterlyUpdateModal
          project={quarterlyUpdateProject}
          snapshots={snapshots}
          user={user}
          onClose={() => setQuarterlyUpdateProject(null)}
          onSaved={() => { setQuarterlyUpdateProject(null); loadSnapshots(); }}
        />
      )}
      {historyProject && (
        <HistoryModal
          project={historyProject}
          snapshots={snapshots}
          onClose={() => setHistoryProject(null)}
        />
      )}

      {/* ── Monthly Working Tab ── always mounted so data survives tab switches */}
      <div style={{ display: tab === 'working' ? 'block' : 'none' }}>
        <MonthlyWorking projects={projects} snapshots={snapshots} />
      </div>

      {/* ── Summary Tab ── always mounted so data survives tab switches */}
      <div style={{ display: tab === 'summary' ? 'block' : 'none' }}>
        <SummaryTab projects={projects} snapshots={snapshots} />
      </div>

      {/* ── Reports Tab ── always mounted so data survives tab switches */}
      <div style={{ display: tab === 'reports' ? 'block' : 'none' }}>
        <ReportsTab projects={projects} snapshots={snapshots} />
      </div>

      {/* ── COA Mapping Tab ── always mounted */}
      <div style={{ display: tab === 'mapping' ? 'block' : 'none' }}>
        <COAMapping />
      </div>
    </div>
  );
}
