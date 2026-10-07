/**
 * Step 15D — Baseline Input Closure Workspace
 * Consolidates all management approvals required to unblock Step 15C gate.
 * Routes → /api/fpa/step15/step15d/*
 */
import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api';

const C = {
  bg:'#F9F9F9', surface:'#FFFFFF', surfaceEl:'#F2F2F2', border:'#DFE7E3',
  text:'#18191B', textSec:'#5D6C7B', textMut:'#9BA8B0',
  accent:'#1C4942', green:'#15803D', yellow:'#B45309', red:'#DC2626',
  cyan:'#0891B2', purple:'#7C3AED', orange:'#C2410C',
};
const sty = {
  card:  { background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:16, marginBottom:12 },
  th:    { padding:'7px 10px', textAlign:'left', fontSize:10, color:C.textMut, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:`1px solid ${C.border}`, whiteSpace:'nowrap' },
  td:    { padding:'7px 10px', fontSize:12, color:C.text, borderBottom:`1px solid ${C.border}`, verticalAlign:'middle' },
  input: { background:C.surfaceEl, border:`1px solid ${C.border}`, borderRadius:4, padding:'5px 8px', color:C.text, fontSize:12, width:'100%', boxSizing:'border-box' },
  btn:   (v='def',extra={}) => ({ padding:'6px 14px', borderRadius:4, border:'none', cursor:'pointer', fontSize:12, fontWeight:600,
    background: v==='primary'?C.accent : v==='success'?C.green : v==='danger'?C.red : v==='warn'?C.yellow : C.surfaceEl,
    color:'#fff', ...extra }),
  badge: (c) => ({ display:'inline-block', padding:'2px 8px', borderRadius:10, fontSize:10, fontWeight:700, background:c+'22', color:c }),
  lbl:   { fontSize:10, color:C.textMut, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3, display:'block' },
};
const fmtL = (v) => v==null ? '—' : `₹${Number(v).toFixed(2)}L`;
const fmtPct = (v) => v==null ? '—' : `${Number(v).toFixed(1)}%`;
const gateColor = (g='') => {
  if (g.includes('FROZEN')||g.includes('STEP_16')) return C.green;
  if (g.includes('CFO_REVIEW')) return C.cyan;
  if (g.includes('INPUTS_COMPLETE')) return C.yellow;
  return C.red;
};
const PB = ({ pct, color }) => (
  <div style={{ height:5, background:C.border, borderRadius:3, overflow:'hidden', marginTop:4 }}>
    <div style={{ height:5, width:`${Math.min(100,pct||0)}%`, background:color||C.accent, borderRadius:3, transition:'width .3s' }} />
  </div>
);

const TABS = [
  { id:'overview',  label:'📊 Overview' },
  { id:'revenue',   label:'💰 Revenue' },
  { id:'capacity',  label:'🏢 Capacity' },
  { id:'cost',      label:'💸 Cost Master' },
  { id:'obs',       label:'📋 Opening BS' },
  { id:'leases',    label:'🔑 Leases' },
  { id:'gl',        label:'🔖 GL Mapping' },
  { id:'far',       label:'📐 FAR / Dep.' },
  { id:'baseline',  label:'🚀 Draft Baseline' },
];

// ─── Status Banner ─────────────────────────────────────────────────────────────
function StatusBanner({ status }) {
  if (!status) return null;
  const { gate, hard_blockers, complete_pct, revenue_value_weighted_pct, approved_revenue_lakh, blockers=[], warnings=[] } = status;
  const gc = gateColor(gate || '');
  return (
    <div style={{ background:gc+'12', border:`2px solid ${gc}`, borderRadius:10, padding:'16px 20px', marginBottom:20 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ fontFamily:'monospace', fontSize:14, fontWeight:700, color:gc, letterSpacing:'.03em' }}>{gate || 'LOADING...'}</div>
          <div style={{ fontSize:11, color:C.textSec, marginTop:4 }}>
            {hard_blockers} hard blockers · {fmtPct(complete_pct)} modules complete · {fmtPct(revenue_value_weighted_pct)} revenue value-weighted approved
          </div>
        </div>
        <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
          {[
            { lbl:'Hard Blockers', val: hard_blockers, color: hard_blockers > 0 ? C.red : C.green },
            { lbl:'Module Completion', val: fmtPct(complete_pct), color: C.cyan },
            { lbl:'Revenue Approved', val: fmtL(approved_revenue_lakh), color: C.green },
            { lbl:'Value-Weighted', val: fmtPct(revenue_value_weighted_pct), color: revenue_value_weighted_pct >= 80 ? C.green : C.yellow },
          ].map(({ lbl, val, color }) => (
            <div key={lbl} style={{ textAlign:'center' }}>
              <div style={{ fontSize:9, color:C.textMut, textTransform:'uppercase', letterSpacing:'.08em' }}>{lbl}</div>
              <div style={{ fontSize:18, fontWeight:700, color }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:12 }}>
        {blockers.map(b => (
          <span key={b.id} style={sty.badge(b.blocked ? C.red : C.green)}>
            {b.id}: {b.label} {b.blocked ? '⛔' : '✓'}
          </span>
        ))}
        {warnings.map(w => (
          <span key={w.id} style={sty.badge(C.yellow)}>{w.id}: {w.label} ⚠</span>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: Overview
// ═══════════════════════════════════════════════════════════════════════════════
function OverviewTab() {
  const [data, setData]   = useState(null);
  const [ready, setReady] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/fpa/step15/step15d/status'),
      apiFetch('/api/fpa/step15/step15d/readiness'),
    ]).then(([s, r]) => { setData(s); setReady(r); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color:C.textSec, padding:20 }}>Loading...</div>;
  if (!data)   return <div style={{ color:C.red, padding:20 }}>Failed to load</div>;

  const modules = [
    { label:'Revenue Coverage', pct: data.revenue_value_weighted_pct, color: data.revenue_value_weighted_pct >= 80 ? C.green : C.red, detail:`${fmtL(data.approved_revenue_lakh)} / ${fmtL(data.total_reference_revenue_lakh)}` },
    ...(data.modules || []).map(m => ({
      label: m.module,
      pct:   m.record_pct,
      color: m.status === 'COMPLETE' ? C.green : m.status === 'IN_PROGRESS' ? C.yellow : C.red,
      detail: m.status,
    })),
  ];

  return (
    <div>
      <StatusBanner status={data} />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))', gap:10, marginBottom:20 }}>
        {modules.map(m => (
          <div key={m.label} style={{ ...sty.card, borderColor: m.color+'44', background: m.color+'0A', marginBottom:0 }}>
            <div style={{ fontSize:11, color:C.textSec, marginBottom:4 }}>{m.label}</div>
            <div style={{ fontSize:20, fontWeight:700, color:m.color }}>{fmtPct(m.pct)}</div>
            <PB pct={m.pct} color={m.color} />
            <div style={{ fontSize:10, color:C.textMut, marginTop:4 }}>{m.detail}</div>
          </div>
        ))}
      </div>
      {ready && (
        <div style={sty.card}>
          <div style={{ fontWeight:700, color:C.text, marginBottom:12 }}>Value-Weighted Materiality</div>
          <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
            {[ready.revenue?.materiality_80, ready.revenue?.materiality_90, ready.revenue?.materiality_95].filter(Boolean).map((m, i) => (
              <div key={i} style={{ background:C.surfaceEl, borderRadius:6, padding:'10px 14px', minWidth:160 }}>
                <div style={{ fontSize:10, color:C.textMut }}>{['80% (Top 24)','90% (Top 58)','95% (Top 92)'][i]}</div>
                <div style={{ fontSize:15, fontWeight:700, color:C.cyan }}>{fmtPct(m.pct)}</div>
                <div style={{ fontSize:11, color:C.textSec }}>Approved {fmtL(m.approved_value)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={sty.card}>
        <div style={{ fontWeight:700, color:C.text, marginBottom:10 }}>Blocker Detail</div>
        {(data.blockers||[]).map(b => (
          <div key={b.id} style={{ display:'flex', gap:10, alignItems:'center', padding:'7px 0', borderBottom:`1px solid ${C.border}` }}>
            <span style={sty.badge(b.blocked ? C.red : C.green)}>{b.id}</span>
            <span style={{ fontSize:12, color:C.text, flex:1 }}>{b.label}</span>
            <span style={{ fontSize:11, color:C.textSec }}>{b.detail}</span>
            <span style={sty.badge(b.blocked ? C.red : C.green)}>{b.blocked ? 'BLOCKER' : 'RESOLVED'}</span>
          </div>
        ))}
        {(data.warnings||[]).map(w => (
          <div key={w.id} style={{ display:'flex', gap:10, alignItems:'center', padding:'7px 0', borderBottom:`1px solid ${C.border}` }}>
            <span style={sty.badge(C.yellow)}>{w.id}</span>
            <span style={{ fontSize:12, color:C.text, flex:1 }}>{w.label}</span>
            <span style={{ fontSize:11, color:C.textSec }}>{w.detail}</span>
            <span style={sty.badge(C.yellow)}>WARNING</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: Revenue
// ═══════════════════════════════════════════════════════════════════════════════
function RevenueTab() {
  const [data, setData]       = useState([]);
  const [coverage, setCoverage] = useState(null);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [page, setPage]         = useState(1);
  const [confFilter, setConf]   = useState('ALL');
  const [approver, setApprover] = useState('');
  const [msg, setMsg]           = useState('');
  const [editing, setEditing]   = useState({});
  const PAGE = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c] = await Promise.all([
        apiFetch('/api/fpa/step15/revenue-proposals?page=1&limit=500'),
        apiFetch('/api/fpa/step15/revenue-proposals/coverage'),
      ]);
      setData(r.proposals || []);
      setCoverage(c);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = data.filter(m => confFilter === 'ALL' || m.confidence === confFilter);
  const pageData = filtered.slice((page-1)*PAGE, page*PAGE);
  const pages    = Math.ceil(filtered.length / PAGE);

  const toggleSelect = (id) => setSelected(s => s.includes(id) ? s.filter(x=>x!==id) : [...s,id]);
  const selAll = () => setSelected(pageData.map(m => m.mapping_id));
  const selHigh = () => setSelected(data.filter(m=>m.confidence==='HIGH'&&m.status!=='approved').map(m=>m.mapping_id));

  const doApprove = async (ids, conf) => {
    if (!approver.trim()) { setMsg('Enter approver name first'); return; }
    if (ids.length === 0 && !conf) { setMsg('Select mappings first'); return; }
    const res = await apiFetch('/api/fpa/step15/step15d/revenue/bulk-approve-v2', {
      method:'POST', body:JSON.stringify({ mapping_ids: ids, confidence_filter: conf || undefined, approved_by: approver }),
    });
    setMsg(`✓ Approved ${res.approved} · skipped ${res.skipped}`);
    setSelected([]); load();
  };

  const saveEdit = async (id, fields) => {
    const res = await apiFetch(`/api/fpa/step15/step15d/revenue/${id}`, {
      method:'PUT', body: JSON.stringify(fields),
    });
    if (res.ok) { setEditing(e => { const n={...e}; delete n[id]; return n; }); load(); }
  };

  const confColors = { HIGH:C.green, MEDIUM:C.yellow, LOW:C.orange, REVIEW_REQUIRED:C.red };

  return (
    <div>
      {coverage && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:8, marginBottom:16 }}>
          {[
            { lbl:'Reference Monthly', val:fmtL(coverage.reference_monthly_lakh), color:C.cyan },
            { lbl:'Proposed', val:fmtL(coverage.proposed_monthly_lakh), color:C.yellow },
            { lbl:'Approved', val:fmtL(coverage.approved_monthly_lakh), color:C.green },
            { lbl:'Value-Weighted %', val:fmtPct(coverage.value_approved_pct), color: coverage.value_approved_pct>=80?C.green:C.red },
            { lbl:'Approved Count', val:`${coverage.approved_count||0} / ${coverage.total_count||0}`, color:C.text },
          ].map(({ lbl, val, color }) => (
            <div key={lbl} style={{ ...sty.card, borderColor:color+'33', marginBottom:0 }}>
              <div style={{ fontSize:9, color:C.textMut, textTransform:'uppercase', letterSpacing:'.08em' }}>{lbl}</div>
              <div style={{ fontSize:18, fontWeight:700, color, marginTop:2 }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:12, alignItems:'center' }}>
        <input value={approver} onChange={e=>setApprover(e.target.value)} placeholder="Your name (approver)" style={{ ...sty.input, width:180 }} />
        {['ALL','HIGH','MEDIUM','LOW','REVIEW_REQUIRED'].map(c => (
          <button key={c} onClick={()=>{setConf(c);setPage(1);}} style={sty.btn(confFilter===c?'primary':'def',{fontSize:11,padding:'4px 10px'})}>
            {c}
          </button>
        ))}
        <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
          <button onClick={() => doApprove(selected)} style={sty.btn('success',{fontSize:11})}>Approve Selected ({selected.length})</button>
          <button onClick={() => doApprove([], 'HIGH')} style={sty.btn('primary',{fontSize:11})}>⚡ Approve All HIGH</button>
        </div>
      </div>
      {msg && <div style={{ padding:'6px 10px', background:C.green+'15', borderRadius:4, color:C.green, fontSize:12, marginBottom:8 }}>{msg}</div>}

      <div style={{ overflowX:'auto', border:`1px solid ${C.border}`, borderRadius:8 }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:C.surfaceEl }}>
              <th style={sty.th}><input type="checkbox" onChange={selAll} /></th>
              <th style={sty.th}>Branch</th>
              <th style={sty.th}>Client</th>
              <th style={sty.th}>Latest</th>
              <th style={sty.th}>3M Avg</th>
              <th style={sty.th}>6M Avg</th>
              <th style={sty.th}>Proposed</th>
              <th style={sty.th}>Approved</th>
              <th style={sty.th}>Esc %</th>
              <th style={sty.th}>Esc Month</th>
              <th style={sty.th}>Confidence</th>
              <th style={sty.th}>Status</th>
              <th style={sty.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map(m => {
              const isEdit = editing[m.mapping_id];
              const rev = m.contracted_monthly_revenue || m.proposed_revenue || m.avg_6m || 0;
              return (
                <tr key={m.mapping_id} style={{ background: selected.includes(m.mapping_id) ? C.accent+'15' : 'transparent' }}>
                  <td style={sty.td}><input type="checkbox" checked={selected.includes(m.mapping_id)} onChange={() => toggleSelect(m.mapping_id)} /></td>
                  <td style={sty.td}><span style={{ fontSize:11 }}>{m.branch_id}</span></td>
                  <td style={sty.td}><span style={{ fontSize:11 }}>{m.client_name || m.client_id}</span></td>
                  <td style={{ ...sty.td, fontFamily:'monospace' }}>{fmtL(m.latest_actual_revenue / 100000)}</td>
                  <td style={{ ...sty.td, fontFamily:'monospace' }}>{fmtL(m.avg_3m / 100000)}</td>
                  <td style={{ ...sty.td, fontFamily:'monospace' }}>{fmtL(m.avg_6m / 100000)}</td>
                  <td style={{ ...sty.td, fontFamily:'monospace', color:C.yellow }}>{fmtL(m.proposed_revenue / 100000)}</td>
                  <td style={{ ...sty.td, fontFamily:'monospace', color:m.approval_status==='approved'?C.green:C.textMut }}>{fmtL(m.contracted_monthly_revenue / 100000)}</td>
                  <td style={sty.td}>
                    {isEdit ? <input type="number" defaultValue={m.escalation_pct||''} style={{ ...sty.input, width:60 }} id={`esc_${m.mapping_id}`} /> : (m.escalation_pct != null ? `${m.escalation_pct}%` : '—')}
                  </td>
                  <td style={sty.td}>
                    {isEdit ? <input type="text" defaultValue={m.escalation_effective_month||''} placeholder="YYYY-MM" style={{ ...sty.input, width:90 }} id={`escm_${m.mapping_id}`} /> : (m.escalation_effective_month || '—')}
                  </td>
                  <td style={sty.td}><span style={sty.badge(confColors[m.confidence]||C.textMut)}>{m.confidence}</span></td>
                  <td style={sty.td}><span style={sty.badge(m.approval_status==='approved'?C.green:m.approval_status==='proposed'?C.yellow:C.textMut)}>{m.approval_status||'REFERENCE'}</span></td>
                  <td style={sty.td}>
                    {isEdit ? (
                      <button onClick={() => saveEdit(m.mapping_id, {
                        escalation_pct: parseFloat(document.getElementById(`esc_${m.mapping_id}`)?.value)||null,
                        escalation_effective_month: document.getElementById(`escm_${m.mapping_id}`)?.value||null,
                      })} style={sty.btn('success',{fontSize:10,padding:'3px 7px'})}>Save</button>
                    ) : (
                      <button onClick={() => setEditing(e => ({...e,[m.mapping_id]:true}))} style={sty.btn('def',{fontSize:10,padding:'3px 7px'})}>Edit</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:8, fontSize:12, color:C.textSec }}>
        <span>{filtered.length} records · showing page {page}/{pages}</span>
        <div style={{ display:'flex', gap:6 }}>
          <button disabled={page===1} onClick={() => setPage(p=>p-1)} style={sty.btn()}>‹ Prev</button>
          <button disabled={page===pages} onClick={() => setPage(p=>p+1)} style={sty.btn()}>Next ›</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: Branch Capacity
// ═══════════════════════════════════════════════════════════════════════════════
function CapacityTab() {
  const [data, setData]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState({});
  const [msg, setMsg]         = useState('');
  const [approver, setApprover] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await apiFetch('/api/fpa/step15/step15d/branch-proposals'); setData(r.proposals || []); }
    catch {} setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const bulkPropose = async () => {
    const r = await apiFetch('/api/fpa/step15/step15d/branch/bulk-propose', { method:'POST', body:'{}' });
    setMsg(`✓ ${r.message}`); load();
  };

  const saveCapacity = async (branch_id) => {
    const e = editing[branch_id] || {};
    const r = await apiFetch(`/api/fpa/step15/step15d/branch/${branch_id}/capacity`, {
      method:'PUT', body: JSON.stringify({ ...e, approve: !!e.approve, approved_by: approver }),
    });
    if (r.ok) { setEditing(ed => { const n={...ed}; delete n[branch_id]; return n; }); load(); }
  };

  const upd = (bid, k, v) => setEditing(e => ({ ...e, [bid]: { ...(e[bid]||{}), [k]: v } }));

  if (loading) return <div style={{ color:C.textSec, padding:20 }}>Loading...</div>;

  const comp  = data.filter(b => b.capacity_approved).length;
  const withRef = data.filter(b => b.has_reference_data).length;

  return (
    <div>
      <div style={{ display:'flex', gap:8, marginBottom:12, alignItems:'center', flexWrap:'wrap' }}>
        <div style={{ ...sty.card, flex:1, marginBottom:0, padding:'10px 14px' }}>
          <span style={{ fontSize:11, color:C.textSec }}>Approved: <strong style={{color:C.green}}>{comp}/{data.length}</strong></span>
          <span style={{ fontSize:11, color:C.textSec, marginLeft:16 }}>With ref data: <strong style={{color:C.yellow}}>{withRef}/{data.length}</strong></span>
        </div>
        <input value={approver} onChange={e=>setApprover(e.target.value)} placeholder="Approver name" style={{ ...sty.input, width:160 }} />
        <button onClick={bulkPropose} style={sty.btn('warn')}>⚡ Bulk Propose from Lease Ref</button>
      </div>
      {msg && <div style={{ padding:'6px 10px', background:C.yellow+'15', borderRadius:4, color:C.yellow, fontSize:12, marginBottom:8 }}>{msg}</div>}

      <div style={{ overflowX:'auto', border:`1px solid ${C.border}`, borderRadius:8 }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:C.surfaceEl }}>
              <th style={sty.th}>Branch</th><th style={sty.th}>City</th>
              <th style={sty.th}>Area sqft (approved)</th><th style={sty.th}>Rev Capacity sqft</th>
              <th style={sty.th}>Seats</th><th style={sty.th}>Occupancy %</th>
              <th style={sty.th}>Ref Area</th><th style={sty.th}>Status</th><th style={sty.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map(b => {
              const e = editing[b.branch_id] || {};
              const isEdit = Object.keys(e).length > 0;
              return (
                <tr key={b.branch_id} style={{ background: b.capacity_approved ? C.green+'08' : 'transparent' }}>
                  <td style={sty.td}>{b.branch_name}</td>
                  <td style={sty.td}>{b.city}</td>
                  <td style={sty.td}>
                    {isEdit ? <input type="number" value={e.total_area_sqft ?? (b.proposed_area_sqft||'')} onChange={ev=>upd(b.branch_id,'total_area_sqft',Number(ev.target.value))} style={{ ...sty.input, width:90 }} />
                    : <span style={{ color: b.total_area_sqft ? C.text : C.yellow }}>{b.total_area_sqft?.toLocaleString() || (b.proposed_area_sqft ? `~${b.proposed_area_sqft?.toLocaleString()} (proposed)` : '—')}</span>}
                  </td>
                  <td style={sty.td}>
                    {isEdit ? <input type="number" value={e.revenue_capacity_sqft ?? (b.proposed_rev_area||'')} onChange={ev=>upd(b.branch_id,'revenue_capacity_sqft',Number(ev.target.value))} style={{ ...sty.input, width:90 }} />
                    : (b.revenue_capacity_sqft?.toLocaleString() || (b.proposed_rev_area ? `~${b.proposed_rev_area?.toLocaleString()}` : '—'))}
                  </td>
                  <td style={sty.td}>
                    {isEdit ? <input type="number" value={e.total_seats ?? (b.proposed_seats||'')} onChange={ev=>upd(b.branch_id,'total_seats',Number(ev.target.value))} style={{ ...sty.input, width:70 }} />
                    : <span style={{ color: b.total_seats ? C.text : C.yellow }}>{b.total_seats || (b.proposed_seats ? `~${b.proposed_seats}` : '—')}</span>}
                  </td>
                  <td style={sty.td}>
                    {isEdit ? <input type="number" value={e.target_occupancy_pct ?? (b.target_occupancy_pct||75)} onChange={ev=>upd(b.branch_id,'target_occupancy_pct',Number(ev.target.value))} style={{ ...sty.input, width:60 }} />
                    : (b.target_occupancy_pct ? `${b.target_occupancy_pct}%` : '—')}
                  </td>
                  <td style={{ ...sty.td, color:C.textMut, fontSize:11 }}>{b.ref_lease_area?.toLocaleString() || '—'}</td>
                  <td style={sty.td}><span style={sty.badge(b.capacity_approved?C.green:b.has_reference_data?C.yellow:C.red)}>{b.capacity_approved?'APPROVED':b.has_reference_data?'HAS REF':'MANUAL REQ'}</span></td>
                  <td style={sty.td}>
                    {isEdit ? (
                      <div style={{ display:'flex', gap:4 }}>
                        <button onClick={() => upd(b.branch_id,'approve',true)} style={sty.btn(e.approve?'success':'def',{fontSize:10,padding:'3px 6px'})}>{e.approve?'✓ Approve':'Approve?'}</button>
                        <button onClick={() => saveCapacity(b.branch_id)} style={sty.btn('primary',{fontSize:10,padding:'3px 6px'})}>Save</button>
                        <button onClick={() => setEditing(ed=>{const n={...ed};delete n[b.branch_id];return n;})} style={sty.btn('def',{fontSize:10,padding:'3px 6px'})}>Cancel</button>
                      </div>
                    ) : (
                      <button onClick={() => setEditing(e=>({...e,[b.branch_id]:{total_area_sqft:b.total_area_sqft,total_seats:b.total_seats,revenue_capacity_sqft:b.revenue_capacity_sqft,target_occupancy_pct:b.target_occupancy_pct||75}}))} style={sty.btn('def',{fontSize:10,padding:'3px 7px'})}>Edit</button>
                    )}
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

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: Cost Master
// ═══════════════════════════════════════════════════════════════════════════════
function CostTab() {
  const [data, setData]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg]         = useState('');
  const [approver, setApprover] = useState('');
  const [expanded, setExpanded] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await apiFetch('/api/fpa/step15/step15d/cost-proposals'); setData(r.proposals||[]); }
    catch {} setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const bulkPropose = async () => {
    const r = await apiFetch('/api/fpa/step15/step15d/cost/bulk-propose', { method:'POST', body:'{}' });
    setMsg(`✓ ${r.message}`); load();
  };

  const approveBranch = async (branch_id, cost_lines) => {
    if (!approver.trim()) { setMsg('Enter approver name'); return; }
    const r = await apiFetch(`/api/fpa/step15/step15d/cost/${branch_id}`, {
      method:'PUT', body: JSON.stringify({ cost_lines, approve: true, approved_by: approver }),
    });
    if (r.ok) load();
  };

  if (loading) return <div style={{ color:C.textSec, padding:20 }}>Loading...</div>;
  const withRef = data.filter(d=>d.has_reference).length;
  const approved = data.filter(d=>d.approved_flag).length;

  const COST_LINES = ['rent','utilities','people','other'];

  return (
    <div>
      <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ ...sty.card, flex:1, marginBottom:0, padding:'10px 14px' }}>
          <span style={{ fontSize:11, color:C.textSec }}>Approved: <strong style={{color:C.green}}>{approved}/{data.length}</strong></span>
          <span style={{ fontSize:11, color:C.textSec, marginLeft:16 }}>With bill reference: <strong style={{color:C.yellow}}>{withRef}/{data.length}</strong></span>
        </div>
        <input value={approver} onChange={e=>setApprover(e.target.value)} placeholder="Approver name" style={{ ...sty.input, width:160 }} />
        <button onClick={bulkPropose} style={sty.btn('warn')}>⚡ Bulk Propose from Bills</button>
      </div>
      {msg && <div style={{ padding:'6px 10px', background:C.yellow+'15', borderRadius:4, color:C.yellow, fontSize:12, marginBottom:8 }}>{msg}</div>}

      <div style={{ border:`1px solid ${C.border}`, borderRadius:8, overflow:'hidden' }}>
        {data.map(b => {
          const lines = b.approved || b.proposed || {};
          const isExp = expanded[b.branch_id];
          const totalProp = b.proposed ? Object.values(b.proposed).filter(v=>typeof v==='number').reduce((s,v)=>s+v,0) : 0;
          return (
            <div key={b.branch_id} style={{ borderBottom:`1px solid ${C.border}` }}>
              <div
                onClick={() => setExpanded(e=>({...e,[b.branch_id]:!e[b.branch_id]}))}
                style={{ display:'flex', gap:12, alignItems:'center', padding:'10px 14px', cursor:'pointer', background: b.approved_flag ? C.green+'08' : 'transparent' }}
              >
                <span style={{ fontSize:12, color:C.text, flex:1 }}>{b.branch_name}</span>
                <span style={{ fontSize:11, color:C.textMut }}>{b.city}</span>
                <span style={{ fontSize:12, fontFamily:'monospace', color: b.has_reference ? C.yellow : C.textMut }}>{b.proposed ? fmtL(totalProp) + '/mo (proposed)' : '—'}</span>
                <span style={sty.badge(b.approved_flag?C.green:b.has_reference?C.yellow:C.red)}>{b.approved_flag?'APPROVED':b.has_reference?'PROPOSED':'NEEDS INPUT'}</span>
                <span style={{ color:C.textMut }}>{isExp?'▲':'▼'}</span>
              </div>
              {isExp && (
                <div style={{ padding:'12px 16px', background:C.bg }}>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:8, marginBottom:10 }}>
                    {COST_LINES.map(line => {
                      const prop = b.proposed?.[line];
                      const appr = b.approved?.[line];
                      return (
                        <div key={line} style={{ background:C.surfaceEl, borderRadius:6, padding:'8px 10px' }}>
                          <div style={sty.lbl}>{line}</div>
                          <div style={{ fontSize:13, fontWeight:600, color:C.yellow }}>{fmtL(prop)}</div>
                          {appr && <div style={{ fontSize:11, color:C.textSec }}>Approved: {fmtL(appr.approved || appr.proposed)}</div>}
                          <div style={{ fontSize:10, color:C.textMut }}>Source: {b.source}</div>
                        </div>
                      );
                    })}
                  </div>
                  {!b.approved_flag && b.has_reference && (
                    <button onClick={() => approveBranch(b.branch_id, {
                      rent:      { proposed: b.proposed?.rent,      approved: b.proposed?.rent,      driver:'FIXED', source:'bills_6m_avg' },
                      utilities: { proposed: b.proposed?.utilities, approved: b.proposed?.utilities, driver:'FIXED', source:'bills_6m_avg' },
                      people:    { proposed: b.proposed?.people,    approved: b.proposed?.people,    driver:'FIXED', source:'bills_6m_avg' },
                      other:     { proposed: b.proposed?.other,     approved: b.proposed?.other,     driver:'FIXED', source:'bills_6m_avg' },
                    })} style={sty.btn('success',{fontSize:11})}>Approve Bill Average Proposals</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: Opening BS (simplified — links to main OBS approval in Step15Tab)
// ═══════════════════════════════════════════════════════════════════════════════
function OBSTab() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState('approved');
  const [approver, setApprover] = useState('');
  const [comment, setComment]   = useState('');
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiFetch('/api/fpa/step15/obs-review')); }
    catch {} setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const handle = async () => {
    if (!approver || !comment) { setMsg('Approver and comment required'); return; }
    setSaving(true);
    const r = await apiFetch('/api/fpa/step15/obs-approve-v2', {
      method:'POST', body: JSON.stringify({ decision, approved_by: approver, comment }),
    });
    setMsg(r.message || r.error || ''); setSaving(false); load();
  };

  if (loading) return <div style={{ color:C.textSec, padding:20 }}>Loading...</div>;
  if (!data)   return null;

  const isApproved = data.approval_status === 'approved';
  const diffColor  = data.is_rounding ? C.green : Math.abs(data.bs_check_diff) < 1 ? C.yellow : C.red;

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:8, marginBottom:16 }}>
        {[
          { lbl:'Total Assets', val: fmtL(data.total_assets), color:C.cyan },
          { lbl:'Total E + L', val: fmtL(data.total_el), color:C.cyan },
          { lbl:'Difference', val: fmtL(data.bs_check_diff), color:diffColor },
          { lbl:'Status', val: data.approval_status, color: isApproved ? C.green : C.yellow },
          { lbl:'Reconciliation', val: data.reconciliation_status, color: diffColor },
        ].map(({ lbl, val, color }) => (
          <div key={lbl} style={{ ...sty.card, borderColor:color+'33', marginBottom:0 }}>
            <div style={{ fontSize:9, color:C.textMut, textTransform:'uppercase', letterSpacing:'.08em' }}>{lbl}</div>
            <div style={{ fontSize:14, fontWeight:700, color, marginTop:2 }}>{val}</div>
          </div>
        ))}
      </div>

      {data.is_rounding && (
        <div style={{ background:C.green+'12', border:`1px solid ${C.green}44`, borderRadius:6, padding:'8px 12px', marginBottom:12, fontSize:12, color:C.green }}>
          ✓ Difference of ₹{Math.abs(data.bs_check_diff)}L is within rounding tolerance. Ready to approve.
        </div>
      )}
      <div style={{ fontSize:11, color:C.textSec, marginBottom:12 }}>{data.reconciliation_note}</div>

      {!isApproved ? (
        <div style={sty.card}>
          <div style={{ fontWeight:700, marginBottom:12 }}>Approval Decision</div>
          <div style={{ display:'flex', gap:6, marginBottom:10 }}>
            {['approved','rejected','returned_for_correction'].map(d => (
              <button key={d} onClick={() => setDecision(d)} style={sty.btn(decision===d?'primary':'def',{fontSize:11})}>{d}</button>
            ))}
          </div>
          <label style={sty.lbl}>Approver Name</label>
          <input value={approver} onChange={e=>setApprover(e.target.value)} style={{ ...sty.input, marginBottom:8 }} />
          <label style={sty.lbl}>Comment</label>
          <textarea value={comment} onChange={e=>setComment(e.target.value)} rows={3} style={{ ...sty.input, resize:'vertical', marginBottom:8 }} />
          <button onClick={handle} disabled={saving} style={sty.btn('success')}>{saving ? 'Saving...' : 'Submit Decision'}</button>
          {msg && <div style={{ marginTop:8, fontSize:12, color:C.yellow }}>{msg}</div>}
        </div>
      ) : (
        <div style={{ background:C.green+'15', border:`1px solid ${C.green}44`, borderRadius:8, padding:'12px 16px' }}>
          <div style={{ fontWeight:700, color:C.green, marginBottom:6 }}>✓ Opening Balance Sheet APPROVED</div>
          <div style={{ fontSize:12, color:C.textSec }}>Approved by: {data.approved_by} · {data.approved_at?.slice(0,10)}</div>
          <div style={{ fontSize:12, color:C.textSec }}>{data.approval_note}</div>
          <button onClick={() => handle()} style={{ ...sty.btn('warn',{fontSize:11}), marginTop:8 }} onClick={async()=>{setDecision('returned_for_correction');setComment('Reopened for correction');setSaving(true);const r=await apiFetch('/api/fpa/step15/obs-approve-v2',{method:'POST',body:JSON.stringify({decision:'returned_for_correction',approved_by:'System',comment:'Reopened'})});setSaving(false);load();}}>Reopen for Correction</button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: Leases / Ind AS 116
// ═══════════════════════════════════════════════════════════════════════════════
function LeasesTab() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [blended, setBlended] = useState('');
  const [approver, setApprover] = useState('');
  const [comment, setComment]   = useState('');
  const [msg, setMsg]           = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiFetch('/api/fpa/step15/step15d/lease-review')); }
    catch {} setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const setBlendedRate = async () => {
    if (!blended || !approver) { setMsg('Rate and approver required'); return; }
    const r = await apiFetch('/api/fpa/step15/step15d/lease/set-blended-rate', {
      method:'POST', body: JSON.stringify({ rate_pct: parseFloat(blended), approved_by: approver, comment }),
    });
    setMsg(r.message || r.error || ''); load();
  };

  if (loading || !data) return <div style={{ color:C.textSec, padding:20 }}>Loading...</div>;

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:8, marginBottom:16 }}>
        {[
          { lbl:'Total Leases', val: data.total, color:C.cyan },
          { lbl:'With Discount Rate', val: data.with_discount_rate, color: data.with_discount_rate > 0 ? C.green : C.red },
          { lbl:'Without Rate', val: data.without_rate, color: data.without_rate === 0 ? C.green : C.orange },
          { lbl:'Monthly Cash Rent', val: fmtL(data.total_monthly_rent_lakh), color:C.text },
          { lbl:'Opening LL (BS)', val: fmtL(data.opening_lease_liability_bs), color:C.cyan },
          { lbl:'Blended IBR', val: data.blended_rate_pct ? `${data.blended_rate_pct}%` : 'NOT SET', color: data.blended_rate_pct ? C.green : C.red },
        ].map(({ lbl, val, color }) => (
          <div key={lbl} style={{ ...sty.card, borderColor:color+'33', marginBottom:0 }}>
            <div style={{ fontSize:9, color:C.textMut, textTransform:'uppercase', letterSpacing:'.08em' }}>{lbl}</div>
            <div style={{ fontSize:16, fontWeight:700, color, marginTop:2 }}>{val}</div>
          </div>
        ))}
      </div>

      <div style={sty.card}>
        <div style={{ fontWeight:700, color:C.text, marginBottom:8 }}>Set Management-Approved Blended Discount Rate (IBR)</div>
        <div style={{ fontSize:12, color:C.textSec, marginBottom:12 }}>
          Setting a blended IBR enables approximate Ind AS 116 aggregate roll-forward for Baseline V1.
          This is a management decision — label will be: <strong style={{color:C.yellow}}>MANAGEMENT_APPROVED_BLENDED_ESTIMATE</strong>.
          Per-lease rates from the auditor are preferred for precision.
        </div>
        {data.blended_rate_pct && (
          <div style={{ background:C.green+'12', border:`1px solid ${C.green}33`, borderRadius:6, padding:'8px 12px', marginBottom:12, fontSize:12 }}>
            ✓ Current blended rate: <strong style={{color:C.green}}>{data.blended_rate_pct}%</strong> approved by {data.blended_approved_by}
          </div>
        )}
        <div style={{ display:'flex', gap:8, alignItems:'flex-end', flexWrap:'wrap' }}>
          <div>
            <label style={sty.lbl}>Blended IBR %</label>
            <input type="number" value={blended} onChange={e=>setBlended(e.target.value)} placeholder="e.g. 10.5" style={{ ...sty.input, width:100 }} />
          </div>
          <div>
            <label style={sty.lbl}>Approved By</label>
            <input value={approver} onChange={e=>setApprover(e.target.value)} style={{ ...sty.input, width:160 }} />
          </div>
          <div>
            <label style={sty.lbl}>Comment</label>
            <input value={comment} onChange={e=>setComment(e.target.value)} style={{ ...sty.input, width:220 }} />
          </div>
          <button onClick={setBlendedRate} style={sty.btn('success')}>Approve Blended Rate</button>
        </div>
        {msg && <div style={{ marginTop:8, fontSize:12, color:C.yellow }}>{msg}</div>}
      </div>

      <div style={{ overflowX:'auto', border:`1px solid ${C.border}`, borderRadius:8 }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:C.surfaceEl }}>
              <th style={sty.th}>#</th><th style={sty.th}>Branch</th><th style={sty.th}>Vendor</th>
              <th style={sty.th}>Monthly Rent</th><th style={sty.th}>Expiry</th>
              <th style={sty.th}>Discount Rate</th><th style={sty.th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {(data.leases||[]).slice(0,100).map(l => (
              <tr key={l.idx}>
                <td style={{ ...sty.td, color:C.textMut }}>{l.idx+1}</td>
                <td style={sty.td}>{l.branch}</td>
                <td style={{ ...sty.td, fontSize:11, color:C.textSec }}>{l.vendor}</td>
                <td style={{ ...sty.td, fontFamily:'monospace' }}>{fmtL(l.monthly_rent)}</td>
                <td style={{ ...sty.td, fontSize:11 }}>{l.expiry}</td>
                <td style={{ ...sty.td, color: l.discount_rate_pct ? C.green : C.textMut }}>
                  {l.discount_rate_pct ? `${l.discount_rate_pct}%` : (data.blended_rate_pct ? `${data.blended_rate_pct}% (blended)` : '—')}
                </td>
                <td style={sty.td}><span style={sty.badge(l.discount_rate_pct?C.green:data.blended_rate_pct?C.yellow:C.red)}>{l.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(data.leases||[]).length > 100 && <div style={{ fontSize:11, color:C.textMut, padding:'8px 0' }}>Showing first 100 of {data.leases.length} leases.</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: GL Mapping
// ═══════════════════════════════════════════════════════════════════════════════
function GLTab() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [approver, setApprover] = useState('');
  const [msg, setMsg]           = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiFetch('/api/fpa/step15/step15d/gl-review')); }
    catch {} setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const approve = async (account, decision) => {
    if (!approver) { setMsg('Enter approver name'); return; }
    const r = await apiFetch('/api/fpa/step15/step15d/gl/approve', {
      method:'POST', body: JSON.stringify({ account, decision, approved_by: approver }),
    });
    if (r.ok) { setMsg(`✓ ${account} → ${decision}`); load(); }
  };

  if (loading || !data) return <div style={{ color:C.textSec, padding:20 }}>Loading...</div>;

  return (
    <div>
      <div style={{ display:'flex', gap:12, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ ...sty.card, flex:1, marginBottom:0, padding:'10px 14px' }}>
          <span style={{ fontSize:11, color:C.textSec }}>Pending: <strong style={{color:C.yellow}}>{data.pending?.length||0}</strong></span>
          <span style={{ fontSize:11, color:C.textSec, marginLeft:16 }}>Pending value: <strong style={{color:C.yellow}}>{fmtL(data.pending_value_lakh)}</strong></span>
          <span style={{ fontSize:11, color:C.textSec, marginLeft:16 }}>Resolved: <strong style={{color:C.green}}>{data.resolved}</strong></span>
        </div>
        <input value={approver} onChange={e=>setApprover(e.target.value)} placeholder="Reviewer/CA name" style={{ ...sty.input, width:180 }} />
      </div>
      {msg && <div style={{ padding:'6px 10px', background:C.green+'15', borderRadius:4, color:C.green, fontSize:12, marginBottom:8 }}>{msg}</div>}

      <div style={{ overflowX:'auto', border:`1px solid ${C.border}`, borderRadius:8 }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr style={{ background:C.surfaceEl }}>
              <th style={sty.th}>Account</th><th style={sty.th}>FPA Line</th><th style={sty.th}>Statement</th>
              <th style={sty.th}>Value (₹L)</th><th style={sty.th}>Confidence</th><th style={sty.th}>Status</th><th style={sty.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data.pending||[]).map(p => (
              <tr key={p.account}>
                <td style={sty.td}>{p.account}</td>
                <td style={{ ...sty.td, fontFamily:'monospace', fontSize:11, color:C.cyan }}>{p.fpa_line}</td>
                <td style={sty.td}>{p.statement}</td>
                <td style={{ ...sty.td, fontFamily:'monospace', color:C.yellow }}>{fmtL(p.value_lakh)}</td>
                <td style={sty.td}><span style={sty.badge(C.cyan)}>{p.confidence}</span></td>
                <td style={sty.td}><span style={sty.badge(C.yellow)}>{p.current_status}</span></td>
                <td style={sty.td}>
                  <div style={{ display:'flex', gap:4 }}>
                    <button onClick={() => approve(p.account, 'approve')} style={sty.btn('success',{fontSize:10,padding:'3px 6px'})}>Confirm</button>
                    <button onClick={() => approve(p.account, 'na')} style={sty.btn('def',{fontSize:10,padding:'3px 6px'})}>N/A</button>
                  </div>
                </td>
              </tr>
            ))}
            {(!data.pending || data.pending.length === 0) && (
              <tr><td colSpan={7} style={{ ...sty.td, textAlign:'center', color:C.green, padding:20 }}>✓ All GL mappings resolved</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: FAR / Depreciation
// ═══════════════════════════════════════════════════════════════════════════════
function FARTab() {
  const [data, setData]   = useState(null);
  const [loading, setL]   = useState(true);
  useEffect(() => {
    apiFetch('/api/fpa/step15/step15d/far-review').then(r=>{setData(r);setL(false);}).catch(()=>setL(false));
  }, []);
  if (loading) return <div style={{ color:C.textSec, padding:20 }}>Loading...</div>;
  if (!data)   return null;
  return (
    <div>
      <div style={{ background: data.computable ? C.green+'12' : C.yellow+'12', border:`1px solid ${data.computable?C.green:C.yellow}44`, borderRadius:8, padding:'10px 14px', marginBottom:14, fontSize:12 }}>
        <strong style={{color: data.computable?C.green:C.yellow}}>{data.label}</strong> — {data.source}<br/>
        <span style={{color:C.textSec}}>{data.limitation}</span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:8, marginBottom:16 }}>
        {[
          { lbl:'Gross Block', val: fmtL(data.total_gross_block_lakh), color:C.cyan },
          { lbl:'Accum. Dep.', val: fmtL(data.total_accum_dep_lakh),  color:C.textSec },
          { lbl:'Opening NBV', val: fmtL(data.total_nbv_lakh),         color:C.green },
          { lbl:'Monthly Dep.', val: fmtL(data.total_monthly_dep_lakh), color:C.yellow },
          { lbl:'CWIP',          val: fmtL(data.cwip_lakh),             color:C.orange },
        ].map(({ lbl, val, color }) => (
          <div key={lbl} style={{ ...sty.card, borderColor:color+'33', marginBottom:0 }}>
            <div style={{ fontSize:9, color:C.textMut, textTransform:'uppercase', letterSpacing:'.08em' }}>{lbl}</div>
            <div style={{ fontSize:16, fontWeight:700, color, marginTop:2 }}>{val}</div>
          </div>
        ))}
      </div>
      <div style={{ overflowX:'auto', border:`1px solid ${C.border}`, borderRadius:8 }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead><tr style={{background:C.surfaceEl}}>
            <th style={sty.th}>Category</th><th style={sty.th}>Gross Block</th><th style={sty.th}>Accum Dep</th>
            <th style={sty.th}>NBV (Opening)</th><th style={sty.th}>WDV Rate %</th><th style={sty.th}>Monthly Dep</th><th style={sty.th}>Computable</th>
          </tr></thead>
          <tbody>
            {(data.categories||[]).map(c => (
              <tr key={c.category}>
                <td style={sty.td}>{c.category}</td>
                <td style={{ ...sty.td, fontFamily:'monospace' }}>{fmtL(c.gross_block_lakh)}</td>
                <td style={{ ...sty.td, fontFamily:'monospace' }}>{fmtL(c.accum_dep_lakh)}</td>
                <td style={{ ...sty.td, fontFamily:'monospace', color:C.cyan }}>{fmtL(c.nbv_lakh)}</td>
                <td style={{ ...sty.td, fontFamily:'monospace', color:C.yellow }}>{c.implied_wdv_rate_pct != null ? `${c.implied_wdv_rate_pct}%` : '—'}</td>
                <td style={{ ...sty.td, fontFamily:'monospace', color:C.green }}>{fmtL(c.monthly_dep_lakh)}</td>
                <td style={sty.td}><span style={sty.badge(c.computable?C.green:C.red)}>{c.computable?'YES':'NO'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize:11, color:C.orange, marginTop:10, padding:'8px 12px', background:C.orange+'0D', borderRadius:6 }}>
        ⚠ CWIP {fmtL(data.cwip_lakh)}: {data.cwip_note}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: Draft Baseline
// ═══════════════════════════════════════════════════════════════════════════════
function BaselineTab() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [approver, setApprover] = useState('');
  const [cfoComment, setCfoComment] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setResults(await apiFetch('/api/fpa/step15/step15d/draft-baseline/results')); }
    catch {} setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const runDraft = async () => {
    if (!approver) { setMsg('Enter name'); return; }
    setRunning(true); setMsg('');
    try {
      const r = await apiFetch('/api/fpa/step15/step15d/draft-baseline/run', {
        method:'POST', body: JSON.stringify({ approved_by: approver }),
      });
      if (r.ok) { setMsg(`✓ ${r.message}`); load(); }
      else setMsg(`Blocked: ${(r.blockers||[r.message||r.error||'Error']).join('; ')}`);
    } catch (e) { setMsg(e.message); }
    setRunning(false);
  };

  const freeze = async () => {
    if (!approver || !cfoComment) { setMsg('Approver and CFO comment required'); return; }
    if (!window.confirm(`FREEZE BASELINE V1?\n\nApproved by: ${approver}\n\nThis action cannot be undone. Confirm?`)) return;
    setFreezing(true);
    const r = await apiFetch('/api/fpa/step15/step15d/baseline/freeze', {
      method:'POST', body: JSON.stringify({ approved_by: approver, cfo_comment: cfoComment }),
    });
    setMsg(r.message || r.error || ''); setFreezing(false); load();
  };

  if (loading) return <div style={{ color:C.textSec, padding:20 }}>Loading...</div>;

  const isFrozen   = results?.status === 'FROZEN';
  const isComputed = results?.status === 'COMPUTED' || isFrozen;

  return (
    <div>
      <div style={{ background:C.red+'10', border:`1px solid ${C.red}44`, borderLeft:`4px solid ${C.red}`, borderRadius:6, padding:'10px 14px', marginBottom:16, fontSize:12, color:C.textSec }}>
        <strong style={{color:C.red}}>STOP CONDITION</strong> — DO NOT freeze Baseline V1 automatically. Explicit CFO approval required. DO NOT proceed to Step 16 without management sign-off.
      </div>

      {!isComputed && (
        <div style={sty.card}>
          <div style={{ fontWeight:700, color:C.text, marginBottom:8 }}>Run Draft Baseline V1</div>
          <div style={{ fontSize:12, color:C.textSec, marginBottom:12 }}>
            Computes a 36-month P&amp;L projection using all approved inputs. Gate conditions must be met (revenue ≥80% value-weighted, OBS approved, etc.).
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <input value={approver} onChange={e=>setApprover(e.target.value)} placeholder="Your name" style={{ ...sty.input, width:180 }} />
            <button onClick={runDraft} disabled={running} style={sty.btn('primary')}>{running ? 'Computing...' : 'RUN DRAFT BASELINE V1'}</button>
          </div>
          {msg && <div style={{ marginTop:8, fontSize:12, color: msg.startsWith('✓') ? C.green : C.red }}>{msg}</div>}
        </div>
      )}

      {isComputed && (
        <>
          <div style={{ background: isFrozen ? C.green+'12' : C.cyan+'10', border:`1px solid ${isFrozen?C.green:C.cyan}44`, borderRadius:8, padding:'10px 14px', marginBottom:14, fontSize:12 }}>
            <strong style={{color:isFrozen?C.green:C.cyan}}>
              {isFrozen ? `✓ FROZEN — ${results.version_label}` : '📊 DRAFT BASELINE V1 — PENDING CFO REVIEW'}
            </strong>
            {isFrozen && <span style={{color:C.textSec, marginLeft:8}}>Frozen by {results.frozen_by} on {results.frozen_at?.slice(0,10)}</span>}
          </div>

          <div style={{ overflowX:'auto', border:`1px solid ${C.border}`, borderRadius:8, marginBottom:16 }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead><tr style={{background:C.surfaceEl}}>
                <th style={sty.th}>Year</th><th style={sty.th}>Revenue</th><th style={sty.th}>EBITDA</th>
                <th style={sty.th}>EBITDA %</th><th style={sty.th}>EBIT</th><th style={sty.th}>PBT</th><th style={sty.th}>PAT</th>
              </tr></thead>
              <tbody>
                {(results.annual_summary||[]).map(r => (
                  <tr key={r.year}>
                    <td style={{ ...sty.td, fontWeight:700 }}>{r.year}</td>
                    <td style={{ ...sty.td, fontFamily:'monospace', color:C.cyan }}>{fmtL(r.revenue)}</td>
                    <td style={{ ...sty.td, fontFamily:'monospace', color: r.ebitda >= 0 ? C.green : C.red }}>{fmtL(r.ebitda)}</td>
                    <td style={{ ...sty.td, fontFamily:'monospace', color: r.ebitda_pct >= 0 ? C.green : C.red }}>{fmtPct(r.ebitda_pct)}</td>
                    <td style={{ ...sty.td, fontFamily:'monospace', color: r.ebit >= 0 ? C.green : C.red }}>{fmtL(r.ebit)}</td>
                    <td style={{ ...sty.td, fontFamily:'monospace', color: r.pbt >= 0 ? C.green : C.red }}>{fmtL(r.pbt)}</td>
                    <td style={{ ...sty.td, fontFamily:'monospace', color: r.pat >= 0 ? C.green : C.red }}>{fmtL(r.pat)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!isFrozen && (
            <div style={sty.card}>
              <div style={{ fontWeight:700, color:C.text, marginBottom:8 }}>CFO Approval — Freeze Baseline V1</div>
              <div style={{ fontSize:12, color:C.yellow, marginBottom:12 }}>
                ⚠ Once frozen, Baseline V1 cannot be silently overwritten. Any subsequent change creates Draft V2.
              </div>
              <div style={{ display:'flex', gap:8, flexDirection:'column', maxWidth:480 }}>
                <input value={approver} onChange={e=>setApprover(e.target.value)} placeholder="CFO / Approver name" style={sty.input} />
                <textarea value={cfoComment} onChange={e=>setCfoComment(e.target.value)} placeholder="CFO approval comment (required)" rows={3} style={{ ...sty.input, resize:'vertical' }} />
                <button onClick={freeze} disabled={freezing} style={sty.btn('danger',{background:C.green})}>
                  {freezing ? 'Freezing...' : '🔒 APPROVE & FREEZE BASELINE V1'}
                </button>
              </div>
              {msg && <div style={{ marginTop:8, fontSize:12, color: msg.startsWith('✓')||msg.includes('frozen') ? C.green : C.yellow }}>{msg}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════════════
export default function Step15DWorkspace() {
  const [tab, setTab]     = useState('overview');
  const [status, setStatus] = useState(null);

  useEffect(() => {
    apiFetch('/api/fpa/step15/step15d/status').then(setStatus).catch(() => {});
  }, [tab]);

  const COMPONENTS = {
    overview: <OverviewTab />,
    revenue:  <RevenueTab />,
    capacity: <CapacityTab />,
    cost:     <CostTab />,
    obs:      <OBSTab />,
    leases:   <LeasesTab />,
    gl:       <GLTab />,
    far:      <FARTab />,
    baseline: <BaselineTab />,
  };

  const gc = gateColor(status?.gate || '');

  return (
    <div style={{ background:C.bg, minHeight:'100vh', color:C.text, fontFamily:'Inter,system-ui,sans-serif', padding:24 }}>
      <div style={{ marginBottom:20 }}>
        <div style={{ fontSize:10, color:C.textMut, textTransform:'uppercase', letterSpacing:'.1em', marginBottom:6 }}>Dev Accelerator Limited · FP&A</div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:10 }}>
          <div>
            <h1 style={{ margin:0, fontSize:22, fontWeight:800, color:C.text }}>Step 15D — Baseline Input Closure</h1>
            <div style={{ fontSize:12, color:C.textSec, marginTop:4 }}>Management Review & Approval Workspace · {status ? `${status.hard_blockers} blocker(s) active` : 'Loading...'}</div>
          </div>
          {status && (
            <div style={{ background:gc+'12', border:`1px solid ${gc}44`, borderRadius:6, padding:'6px 12px', fontSize:11, fontFamily:'monospace', color:gc }}>
              {status.gate?.replace(/_/g,' ')}
            </div>
          )}
        </div>
      </div>

      <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:20, borderBottom:`1px solid ${C.border}`, paddingBottom:12 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding:'6px 14px', borderRadius:4, border:'none', cursor:'pointer', fontSize:12, fontWeight:500,
            background: tab === t.id ? C.accent : C.surfaceEl,
            color: tab === t.id ? '#fff' : C.textSec,
          }}>{t.label}</button>
        ))}
      </div>

      {COMPONENTS[tab] || <div style={{ color:C.textSec }}>Tab not found</div>}

      <div style={{ marginTop:32, padding:'12px 16px', background:C.red+'0A', border:`1px solid ${C.red}33`, borderRadius:6, fontSize:11, color:C.textSec }}>
        <strong style={{color:C.red}}>STOP CONDITION</strong> — DO NOT begin Step 16 CFO UAT automatically. DO NOT activate Baseline V1 without explicit CFO approval. DO NOT migrate to production. Wait for management sign-off.
      </div>
    </div>
  );
}
