/**
 * Step 15A — Management Data Completion & Forecast Activation
 * Auto-populated: lease schedule (area/rent reference), Zoho bills (cost actuals reference)
 * Still requiring management input: seats, contracted revenue, FAR, OBS approval, debt schedules
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../utils/api';

const C = {
  bg:'#0F1117', surface:'#1A1D27', surfaceEl:'#21253B', border:'#2E3348',
  text:'#E8EAED', textSec:'#9AA3B2', textMut:'#5C6680',
  accent:'#6366F1', green:'#22C55E', yellow:'#F59E0B', red:'#EF4444',
  cyan:'#06B6D4', purple:'#A855F7', orange:'#F97316',
};
const SUB_TABS = [
  { id:'action_center', label:'🎯 Action Center' },
  { id:'rev_review',    label:'💰 Revenue Review' },
  { id:'client_rev',    label:'Client Revenue' },
  { id:'branch_cap',    label:'Branch Capacity' },
  { id:'cost',          label:'Cost & Utilities' },
  { id:'debt',          label:'Debt Completion' },
  { id:'obs',           label:'OBS Approval' },
  { id:'action_req',    label:'⚠ Action List' },
  { id:'completion',    label:'Completion Status' },
  { id:'readiness',     label:'Readiness' },
];

const sty = {
  card:  { background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:16, marginBottom:12 },
  th:    { padding:'7px 10px', textAlign:'left', fontSize:10, color:C.textMut, textTransform:'uppercase', letterSpacing:'.06em', borderBottom:`1px solid ${C.border}`, whiteSpace:'nowrap' },
  td:    { padding:'7px 10px', fontSize:12, color:C.text, borderBottom:`1px solid ${C.border}`, verticalAlign:'middle' },
  input: { background:C.surfaceEl, border:`1px solid ${C.border}`, borderRadius:4, padding:'4px 7px', color:C.text, fontSize:12, width:'100%', boxSizing:'border-box' },
  btn:   (v='def') => ({ padding:'5px 12px', borderRadius:4, border:'none', cursor:'pointer', fontSize:12, fontWeight:500,
    background: v==='primary'?C.accent : v==='success'?C.green : v==='danger'?C.red : v==='warn'?C.yellow : C.surfaceEl,
    color:'#fff' }),
  badge: (c) => ({ display:'inline-block', padding:'2px 7px', borderRadius:10, fontSize:10, fontWeight:600, background:c+'22', color:c }),
  lbl:   { fontSize:10, color:C.textMut, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3, display:'block' },
};

const fmtINR = (v) => { if(v==null) return '—'; const n=Number(v); if(n>=100000) return `₹${(n/100000).toFixed(2)}L`; if(n>=1000) return `₹${(n/1000).toFixed(1)}K`; return `₹${Math.round(n)}`; };
const fmtL = (v) => v==null ? '—' : `₹${Number(v).toFixed(2)}L`;
const statusColor = (s) => { if(!s) return C.textMut; const u=s.toUpperCase(); if(u.includes('COMPLETE')||u.includes('AUTO')||u.includes('APPROV')) return C.green; if(u.includes('PARTIAL')||u.includes('PROGRESS')) return C.cyan; if(u.includes('REVIEW')||u.includes('CONFIRM')||u.includes('REFERENCE')) return C.yellow; if(u.includes('REQUIRED')||u.includes('BLOCKED')||u.includes('MISSING')||u.includes('PENDING')) return C.red; return C.textMut; };
const prioColor = (p) => ({CRITICAL:C.red, HIGH:C.yellow, MEDIUM:C.cyan, LOW:C.textMut}[p]||C.textMut);

// ─── CSV download helper ──────────────────────────────────────────────────────
function getToken() { try { return localStorage.getItem('token') || sessionStorage.getItem('token') || ''; } catch { return ''; } }

async function downloadCSV(url, filename) {
  const token = getToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const blob = await res.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = filename; document.body.appendChild(a); a.click(); a.remove();
}

async function importCSV(file, uploadUrl) {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const res = await fetch(uploadUrl, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: e.target.result }),
        });
        resolve(await res.json());
      } catch (err) { reject(err); }
    };
    reader.readAsText(file);
  });
}

// ─── ProgressBar ──────────────────────────────────────────────────────────────
const ProgressBar = ({ pct, color, height=4 }) => (
  <div style={{ height, background:C.border, borderRadius:2, overflow:'hidden', width:'100%' }}>
    <div style={{ height, width:`${Math.min(100,pct||0)}%`, background:color||C.accent, borderRadius:2, transition:'width .4s' }} />
  </div>
);

// ─── SECTION: Management Action Center ───────────────────────────────────────
function ManagementActionCenter() {
  const [data, setData]   = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiFetch('/fpa/step15/action-center')); }
    catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding:20, color:C.textMut }}>Loading action center…</div>;
  if (!data)   return <div style={{ padding:20, color:C.red }}>Failed to load action center.</div>;

  const gateColor = data.gate_status?.includes('BLOCKED') ? C.red : data.gate_status?.includes('COMPLETE') ? C.green : C.yellow;
  const scMap = { COMPLETE:C.green, IN_PROGRESS:C.cyan, DRAFT:C.yellow, PENDING:C.red };

  return (
    <div>
      <div style={{ background:gateColor+'11', border:`2px solid ${gateColor}`, borderRadius:8, padding:'12px 18px', marginBottom:20, display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:700, color:gateColor, fontFamily:'monospace' }}>{(data.gate_status||'').replace(/_/g,' ')}</div>
          <div style={{ fontSize:12, color:C.textSec, marginTop:3 }}>
            Actions: <strong>{data.complete}/{data.total} complete</strong> &nbsp;|&nbsp; Blockers: <strong style={{ color:data.blockers>0?C.red:C.green }}>{data.blockers}</strong>
          </div>
        </div>
        <div style={{ fontSize:24, fontWeight:700, color:gateColor }}>{data.overall_pct}%</div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(320px,1fr))', gap:14 }}>
        {(data.actions||[]).map(a => {
          const sc = scMap[a.status] || C.textMut;
          return (
            <div key={a.action_num} style={{ ...sty.card, marginBottom:0, borderLeft:`4px solid ${a.blocker?C.red:sc}` }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
                <div>
                  <div style={{ fontSize:10, color:C.textMut, letterSpacing:'.08em', textTransform:'uppercase', marginBottom:2 }}>ACTION {a.action_num} · {a.priority}</div>
                  <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{a.title}</div>
                </div>
                <span style={sty.badge(sc)}>{a.status}</span>
              </div>
              <div style={{ marginBottom:8 }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:C.textSec, marginBottom:4 }}>
                  <span>{a.progress?.total != null ? `${a.progress.done} / ${a.progress.total}` : `${a.progress?.done} loaded`}</span>
                  <span style={{ color:sc }}>{a.progress?.pct}%</span>
                </div>
                <ProgressBar pct={a.progress?.pct} color={sc} height={5} />
              </div>
              <div style={{ fontSize:11, color:C.textSec, marginBottom:a.quick_win?8:0 }}>
                <span style={{ fontFamily:'monospace', color:C.cyan }}>{a.kpi}</span>
              </div>
              {a.quick_win && (
                <div style={{ fontSize:11, color:C.green, background:C.green+'11', padding:'5px 8px', borderRadius:4, marginTop:4 }}>⚡ {a.quick_win}</div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop:20, padding:'12px 16px', background:C.surfaceEl, border:`1px solid ${C.border}`, borderRadius:8, fontSize:11, color:C.textMut }}>
        <strong style={{ color:C.yellow }}>⚠ STOP CONDITION</strong> — DO NOT activate Baseline V1 automatically. DO NOT start Step 16 (CFO UAT).
        After Step 15B is complete, next step is: <strong style={{ color:C.text }}>STEP 15C — BASELINE V1 COMPUTE, THREE-STATEMENT VALIDATION & PRE-UAT GATE</strong>
      </div>
    </div>
  );
}

// ─── SECTION: Revenue Review ──────────────────────────────────────────────────
function RevenueReviewSection() {
  const [data,     setData]     = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [filter,   setFilter]   = useState({ confidence:'', exception_only:false, search:'' });
  const [page,     setPage]     = useState(1);
  const [selected, setSelected] = useState({});
  const [confirm,  setConfirm]  = useState(null);
  const [approving,setApproving]= useState(false);
  const [msg,      setMsg]      = useState(null);
  const PP = 50;

  const load = useCallback(async (flt, pg) => {
    const f = flt || filter; const p = pg || 1;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page:p, per_page:PP,
        ...(f.confidence && { confidence:f.confidence }),
        ...(f.exception_only && { exception_only:'true' }),
        ...(f.search && { search:f.search }),
      });
      const [d, cov] = await Promise.all([
        apiFetch(`/fpa/step15/revenue-proposals?${params}`),
        apiFetch('/fpa/step15/revenue-proposals/coverage').catch(()=>null),
      ]);
      setData(d); setCoverage(cov);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []); // eslint-disable-line

  useEffect(() => { load(); }, []); // eslint-disable-line

  const applyFilter = (newF) => {
    const f = { ...filter, ...newF };
    setFilter(f); setPage(1); setSelected({});
    load(f, 1);
  };

  const toggleSelect = (mid) => setSelected(p => { const n={...p}; n[mid]?delete n[mid]:n[mid]=true; return n; });
  const toggleAll = () => {
    const ids = (data?.rows||[]).map(r=>r.mapping_id);
    const allSel = ids.length>0 && ids.every(id=>selected[id]);
    setSelected(allSel ? {} : Object.fromEntries(ids.map(id=>[id,true])));
  };

  const prepareConfirm = (type, overrideIds) => {
    const summary = data?.summary||{};
    if (type==='high_confidence') {
      setConfirm({ type, ids:[], count:summary.high_confidence||0, totalProposed:0, totalRef:0 });
      return;
    }
    const ids = overrideIds || Object.keys(selected).filter(id=>selected[id]);
    if (!ids.length) { setMsg({ type:'warn', text:'Select at least one row.' }); return; }
    const rows = (data?.rows||[]).filter(r=>ids.includes(r.mapping_id));
    const totalProposed = rows.reduce((s,r)=>s+(r.proposed_monthly_revenue||0),0);
    const totalRef      = rows.reduce((s,r)=>s+(r.avg_6m||r.avg_3m||0),0);
    setConfirm({ type, ids, count:ids.length, totalProposed, totalRef });
  };

  const doApprove = async () => {
    if (!confirm) return;
    setApproving(true); setMsg(null);
    try {
      let text;
      if (confirm.type==='high_confidence') {
        const r = await apiFetch('/fpa/step15/revenue-proposals/approve-by-confidence', { method:'POST', data:{ confidence:'HIGH', approved_by:'management' } });
        text = r.message;
      } else {
        const r = await apiFetch('/fpa/step15/revenue-proposals/approve', { method:'POST', data:{ mapping_ids:confirm.ids, approved_by:'management' } });
        text = `${r.approved} mappings approved.`;
      }
      setMsg({ type:'success', text }); setConfirm(null); setSelected({});
      await load();
    } catch(e) { setMsg({ type:'error', text:e.message }); }
    finally { setApproving(false); }
  };

  const confColor = { HIGH:C.green, MEDIUM:C.yellow, LOW:C.orange, REVIEW_REQUIRED:C.red };

  const rows    = data?.rows||[];
  const summary = data?.summary||{};
  const total   = data?.total||0;
  const totalPages = Math.ceil(total/PP)||1;
  const selIds  = Object.keys(selected).filter(id=>selected[id]);

  return (
    <div>
      {/* Coverage tiles */}
      {coverage && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(135px,1fr))', gap:10, marginBottom:16 }}>
          {[
            { label:'Reference Rev (6M avg)', val:`₹${((coverage.total_reference_revenue||0)/100000).toFixed(0)}L`, sub:'all mappings', c:C.cyan },
            { label:'Proposed Rev', val:`₹${((coverage.total_proposed_revenue||0)/100000).toFixed(0)}L`, sub:`${coverage.value_proposed_pct}% of ref`, c:C.yellow },
            { label:'Approved Rev', val:`₹${((coverage.total_approved_revenue||0)/100000).toFixed(0)}L`, sub:`${coverage.value_approved_pct}% value coverage`, c:(coverage.value_approved_pct||0)>50?C.green:C.red },
            { label:'Approved Count', val:`${coverage.with_approved}/${coverage.total_mappings}`, sub:`${coverage.record_approved_pct}% records`, c:C.green },
            { label:'Needs Review', val:`${summary.review_required||0}`, sub:'exception flag set', c:C.red },
          ].map(k=>(
            <div key={k.label} style={{ ...sty.card, marginBottom:0, padding:'10px 14px' }}>
              <div style={{ fontSize:9, color:C.textMut }}>{k.label}</div>
              <div style={{ fontSize:15, fontWeight:700, color:k.c }}>{k.val}</div>
              <div style={{ fontSize:9, color:C.textMut }}>{k.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Materiality */}
      {coverage?.materiality && (
        <div style={{ ...sty.card, marginBottom:14, background:C.surfaceEl }}>
          <div style={{ fontSize:11, fontWeight:600, color:C.text, marginBottom:6 }}>Revenue Materiality (sorted by 6M avg desc)</div>
          <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
            {[80,90,95].map(t => {
              const m = coverage.materiality[`top_${t}_pct`]||{};
              return (
                <div key={t} style={{ fontSize:12, color:C.textSec }}>
                  <span style={{ color:C.accent, fontWeight:600 }}>Top {m.count||'?'} clients</span> = {t}% of revenue (₹{((m.ref_inr||0)/100000).toFixed(0)}L)
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter chips */}
      <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
        {[
          {key:'',label:'All',count:summary.total},
          {key:'HIGH',label:'HIGH',count:summary.high_confidence},
          {key:'MEDIUM',label:'MEDIUM',count:summary.medium_confidence},
          {key:'LOW',label:'LOW',count:summary.low_confidence},
          {key:'REVIEW_REQUIRED',label:'REVIEW REQ.',count:summary.review_required},
        ].map(c=>(
          <button key={c.key} onClick={()=>applyFilter({ confidence:c.key })}
            style={{ ...sty.btn(filter.confidence===c.key?'primary':'def'), fontSize:11, borderColor:c.key?confColor[c.key]+'66':C.border }}>
            {c.label}: {c.count}
          </button>
        ))}
        <label style={{ fontSize:12, color:C.textSec, display:'flex', alignItems:'center', gap:4, cursor:'pointer' }}>
          <input type="checkbox" checked={filter.exception_only} onChange={e=>applyFilter({ exception_only:e.target.checked })} />
          Exceptions only
        </label>
        <input type="text" value={filter.search} onChange={e=>applyFilter({ search:e.target.value })}
          placeholder="Search client…" style={{ ...sty.input, width:180, fontSize:11 }} />
      </div>

      {/* Bulk action bar */}
      <div style={{ ...sty.card, marginBottom:14, background:C.surfaceEl, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
        <span style={{ fontSize:12, color:C.textSec }}>{selIds.length} selected</span>
        <button onClick={()=>prepareConfirm('selected')} disabled={!selIds.length} style={sty.btn('primary')}>Approve Selected ({selIds.length})</button>
        <button onClick={()=>prepareConfirm('high_confidence')} style={sty.btn('success')}>⚡ Approve All HIGH ({summary.high_confidence||0})</button>
      </div>

      {/* Confirm modal */}
      {confirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
          <div style={{ background:C.surface, border:`2px solid ${C.accent}`, borderRadius:10, padding:24, maxWidth:480, width:'100%' }}>
            <div style={{ fontSize:14, fontWeight:700, color:C.text, marginBottom:12 }}>Confirm Bulk Approval</div>
            <div style={{ fontSize:12, color:C.textSec, marginBottom:10 }}>
              About to approve <strong style={{ color:C.text }}>{confirm.count} mapping{confirm.count!==1?'s':''}</strong>
              {confirm.type==='high_confidence'?' (all HIGH confidence)':''}
            </div>
            {confirm.type!=='high_confidence' && (
              <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:14 }}>
                {[
                  { label:'Proposed', val:`₹${(confirm.totalProposed/100000).toFixed(1)}L`, c:C.accent },
                  { label:'Reference (6M avg)', val:`₹${(confirm.totalRef/100000).toFixed(1)}L`, c:C.cyan },
                  { label:'Diff %', val:`${confirm.totalRef>0?(((confirm.totalProposed-confirm.totalRef)/confirm.totalRef)*100).toFixed(1):0}%`,
                    c:Math.abs(confirm.totalProposed-confirm.totalRef)/Math.max(1,confirm.totalRef)>0.2?C.yellow:C.green },
                ].map(k=>(
                  <div key={k.label} style={{ ...sty.card, marginBottom:0, flex:1, minWidth:100, padding:'8px 12px' }}>
                    <div style={{ fontSize:9, color:C.textMut }}>{k.label}</div>
                    <div style={{ fontSize:14, fontWeight:700, color:k.c }}>{k.val}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize:11, color:C.textMut, marginBottom:14, padding:'8px 12px', background:C.surfaceEl, borderRadius:6 }}>
              This sets <code style={{ color:C.cyan }}>contracted_monthly_revenue = proposed_monthly_revenue</code>. These are separate fields — proposed is never auto-approved.
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={doApprove} disabled={approving} style={sty.btn('success')}>{approving?'Approving…':'✓ Confirm Approval'}</button>
              <button onClick={()=>setConfirm(null)} style={sty.btn()}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {msg && <div style={{ padding:'8px 12px', borderRadius:4, marginBottom:10, fontSize:12, background:msg.type==='error'?C.red+'22':C.green+'22', color:msg.type==='error'?C.red:C.green }}>{msg.text}</div>}

      {/* Table */}
      {loading && !rows.length ? <div style={{ padding:20, color:C.textMut }}>Loading…</div> : (
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...sty.th, width:28 }}><input type="checkbox" onChange={toggleAll} checked={rows.length>0&&rows.every(r=>selected[r.mapping_id])} /></th>
                <th style={sty.th}>#</th>
                <th style={sty.th}>Client</th>
                <th style={sty.th}>Branch</th>
                <th style={{ ...sty.th, background:C.cyan+'0A' }}>Latest Actual</th>
                <th style={{ ...sty.th, background:C.cyan+'0A' }}>3M Avg</th>
                <th style={{ ...sty.th, background:C.cyan+'0A' }}>6M Avg</th>
                <th style={{ ...sty.th, background:C.accent+'12' }}>Proposed</th>
                <th style={sty.th}>Confidence</th>
                <th style={sty.th}>Exception</th>
                <th style={sty.th}>Approved Rev</th>
                <th style={sty.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r=>{
                const cc = confColor[r.confidence]||C.textMut;
                const isApproved = r.is_approved;
                return (
                  <tr key={r.mapping_id} style={{ background:r.needs_review?C.red+'06':selected[r.mapping_id]?C.accent+'12':isApproved?C.green+'04':'transparent' }}>
                    <td style={sty.td}><input type="checkbox" checked={!!selected[r.mapping_id]} onChange={()=>toggleSelect(r.mapping_id)} /></td>
                    <td style={{ ...sty.td, fontSize:10, color:C.textMut }}>{r.materiality_rank}</td>
                    <td style={{ ...sty.td, fontSize:11, fontWeight:500, maxWidth:150 }}>{r.client_name}</td>
                    <td style={{ ...sty.td, fontSize:11, color:C.textMut }}>{r.branch_name}</td>
                    <td style={{ ...sty.td, background:C.cyan+'06', fontSize:11, fontFamily:'monospace' }}>{r.latest_actual_revenue!=null?fmtINR(r.latest_actual_revenue):'—'}</td>
                    <td style={{ ...sty.td, background:C.cyan+'06', fontSize:11, fontFamily:'monospace' }}>{r.avg_3m!=null?fmtINR(r.avg_3m):'—'}</td>
                    <td style={{ ...sty.td, background:C.cyan+'06', fontSize:11, fontFamily:'monospace' }}>{r.avg_6m!=null?fmtINR(r.avg_6m):'—'}</td>
                    <td style={{ ...sty.td, background:C.accent+'0A', fontSize:11, fontFamily:'monospace', color:C.accent, fontWeight:600 }}>{r.proposed_monthly_revenue!=null?fmtINR(r.proposed_monthly_revenue):<span style={{ color:C.red }}>N/A</span>}</td>
                    <td style={sty.td}><span style={sty.badge(cc)}>{r.confidence}</span></td>
                    <td style={{ ...sty.td, fontSize:10, color:r.exception_flag?C.yellow:C.textMut, maxWidth:180 }}>{r.exception_flag||'—'}</td>
                    <td style={{ ...sty.td, fontSize:11, fontFamily:'monospace', color:isApproved?C.green:C.textMut }}>{r.contracted_monthly_revenue!=null?fmtINR(r.contracted_monthly_revenue):'—'}</td>
                    <td style={sty.td}><span style={sty.badge(isApproved?C.green:r.needs_review?C.red:C.textMut)}>{isApproved?'APPROVED':r.needs_review?'REVIEW':r.approval_status||'PENDING'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages>1 && (
        <div style={{ display:'flex', gap:8, justifyContent:'center', marginTop:14 }}>
          <button onClick={()=>{ const np=Math.max(1,page-1); setPage(np); load(filter,np); }} disabled={page===1} style={sty.btn()}>← Prev</button>
          <span style={{ color:C.textSec, fontSize:12, lineHeight:'28px' }}>Page {page}/{totalPages} ({total} rows)</span>
          <button onClick={()=>{ const np=Math.min(totalPages,page+1); setPage(np); load(filter,np); }} disabled={page>=totalPages} style={sty.btn()}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ─── SECTION: Completion Status ───────────────────────────────────────────────
function CompletionSection() {
  const [data,     setData]     = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [running,  setRunning]  = useState(null);
  const [msg,      setMsg]      = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [comp, cov] = await Promise.all([
        apiFetch('/fpa/step15/completion'),
        apiFetch('/fpa/step15/client-revenue/value-coverage').catch(() => null),
      ]);
      setData(comp); setCoverage(cov);
    } catch(e) { setMsg({ type:'error', text:e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runAction = async (label, url) => {
    setRunning(label); setMsg(null);
    try {
      const r = await apiFetch(url, { method:'POST', data:{} });
      setMsg({ type:'success', text:r.message });
      await load();
    } catch(e) { setMsg({ type:'error', text:e.message }); }
    finally { setRunning(null); }
  };

  if(loading) return <div style={{ padding:20, color:C.textMut }}>Loading…</div>;

  const gate = data?.gate || '';
  const blocked = gate.includes('BLOCKED');

  return (
    <div>
      <div style={{ background:blocked?C.red+'11':C.green+'11', border:`2px solid ${blocked?C.red:C.green}`, borderRadius:8, padding:'14px 18px', marginBottom:20, display:'flex', alignItems:'flex-start', gap:14, flexWrap:'wrap' }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:16, fontWeight:700, color:blocked?C.red:C.green, fontFamily:'monospace' }}>{gate}</div>
          <div style={{ fontSize:12, color:C.textSec, marginTop:4 }}>
            Overall: <strong>{data?.overall_pct}%</strong> &nbsp;|&nbsp; Critical blockers: <strong style={{ color:data?.critical_blockers>0?C.red:C.green }}>{data?.critical_blockers}</strong> &nbsp;|&nbsp; Modules: <strong>{data?.completed_modules}/{data?.total_modules}</strong>
          </div>
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <button onClick={() => runAction('actuals', '/fpa/step15/auto-populate-actuals')} disabled={!!running} style={sty.btn('primary')}>
            {running==='actuals' ? '⟳ Running…' : '⚡ Populate Revenue Actuals'}
          </button>
          <button onClick={() => runAction('branch', '/fpa/step15/auto-populate-branch-data')} disabled={!!running} style={sty.btn('primary')}>
            {running==='branch' ? '⟳ Running…' : '🏗 Populate Branch Ref Data'}
          </button>
        </div>
      </div>

      {msg && <div style={{ padding:'10px 14px', borderRadius:6, marginBottom:14, fontSize:12, background:msg.type==='error'?C.red+'22':C.green+'22', color:msg.type==='error'?C.red:C.green }}>{msg.text}</div>}

      {/* Value-weighted coverage */}
      {coverage && (
        <div style={{ ...sty.card, marginBottom:20, background:C.surfaceEl }}>
          <div style={{ fontSize:13, fontWeight:600, color:C.text, marginBottom:10 }}>Revenue Coverage (Value-Weighted)</div>
          <div style={{ display:'flex', gap:14, flexWrap:'wrap', marginBottom:10 }}>
            {[
              { label:'Contracted / Total', val:`${coverage.with_contracted}/${coverage.total_mappings}`, sub:'record count', c:coverage.record_coverage_pct===100?C.green:C.yellow },
              { label:'Record Coverage', val:`${coverage.record_coverage_pct}%`, sub:'mappings with contracted rev', c:coverage.record_coverage_pct===100?C.green:C.red },
              { label:'Reference Revenue (6M avg)', val:fmtINR(coverage.total_reference_revenue_inr), sub:'all active mappings', c:C.cyan },
              { label:'Contracted Revenue', val:fmtINR(coverage.contracted_revenue_inr), sub:'management confirmed', c:C.green },
              { label:'Value Coverage (₹-weighted)', val:`${coverage.value_coverage_pct}%`, sub:'contracted ÷ reference', c:coverage.value_coverage_pct>80?C.green:coverage.value_coverage_pct>40?C.yellow:C.red },
            ].map(k=>(
              <div key={k.label} style={{ ...sty.card, marginBottom:0, flex:1, minWidth:110, padding:'10px 14px' }}>
                <div style={{ fontSize:10, color:C.textMut }}>{k.label}</div>
                <div style={{ fontSize:16, fontWeight:700, color:k.c }}>{k.val}</div>
                <div style={{ fontSize:10, color:C.textMut }}>{k.sub}</div>
              </div>
            ))}
          </div>
          <ProgressBar pct={coverage.value_coverage_pct} color={coverage.value_coverage_pct>80?C.green:C.yellow} height={6} />
        </div>
      )}

      {/* Module table */}
      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr>{['Module','Source','Progress','Status','Priority','Action'].map(h=><th key={h} style={sty.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {(data?.modules||[]).map(m=>(
              <tr key={m.id} style={{ background:m.blocker?C.red+'06':'transparent' }}>
                <td style={{ ...sty.td, fontWeight:600 }}>{m.module}</td>
                <td style={{ ...sty.td, fontSize:11, color:C.textMut }}>{m.source}</td>
                <td style={{ ...sty.td, minWidth:130 }}>
                  <div style={{ fontSize:11, color:C.textSec, marginBottom:3 }}>{m.total!=null?`${m.populated}/${m.total} (${m.pct}%)`:m.populated}</div>
                  <ProgressBar pct={m.pct} color={m.pct===100?C.green:m.pct>0?C.yellow:C.red} />
                </td>
                <td style={sty.td}><span style={sty.badge(statusColor(m.status))}>{m.status}</span></td>
                <td style={sty.td}><span style={sty.badge(prioColor(m.priority))}>{m.priority}</span></td>
                <td style={{ ...sty.td, fontSize:11, color:C.textSec, maxWidth:280 }}>{m.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop:20, padding:'12px 16px', background:C.surfaceEl, border:`1px solid ${C.border}`, borderRadius:8, fontSize:11, color:C.textMut }}>
        <strong style={{ color:C.yellow }}>⚠ STOP CONDITION</strong>: DO NOT start Step 16 / CFO UAT. DO NOT generate Baseline V1 while critical inputs remain.
        The ₹6,556.68L/month forecast is <strong style={{ color:C.red }}>TEMPORARY / INFLATED / UNAPPROVED</strong>.
      </div>
    </div>
  );
}

// ─── SECTION: Action Required ──────────────────────────────────────────────────
function ActionRequiredSection() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ module:'', priority:'', owner:'', status:'' });
  const [page,    setPage]    = useState(0);
  const PAGE = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiFetch('/fpa/step15/action-required')); }
    catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const downloadMaster = async () => {
    try {
      const token = getToken();
      const res   = await fetch('/api/fpa/step15/export/master-bundle', { headers:{ Authorization:`Bearer ${token}` } });
      const json  = await res.json();
      for(const [sheet, csv] of Object.entries(json.sheets || {})) {
        const blob = new Blob([csv], { type:'text/csv' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `DevX_FPA_${sheet}.csv`; document.body.appendChild(a); a.click(); a.remove();
        await new Promise(r => setTimeout(r, 200));
      }
    } catch(e) { alert('Download failed: ' + e.message); }
  };

  if(loading) return <div style={{ padding:20, color:C.textMut }}>Loading action items…</div>;
  if(!data)   return <div style={{ padding:20, color:C.red }}>Failed to load.</div>;

  const modules   = [...new Set((data.items||[]).map(i => i.module))].sort();
  const owners    = [...new Set((data.items||[]).map(i => i.owner).filter(Boolean))].sort();
  const statuses  = [...new Set((data.items||[]).map(i => i.status).filter(Boolean))].sort();
  const priorities = ['CRITICAL','HIGH','MEDIUM','LOW'];

  const filtered = (data.items||[]).filter(i =>
    (!filters.module   || i.module===filters.module) &&
    (!filters.priority || i.priority===filters.priority) &&
    (!filters.owner    || i.owner===filters.owner) &&
    (!filters.status   || i.status===filters.status)
  );
  const totalPages = Math.ceil(filtered.length/PAGE);
  const pageItems  = filtered.slice(page*PAGE, (page+1)*PAGE);

  const sel = (field, vals, label) => (
    <select value={filters[field]} onChange={e=>{ setFilters(p=>({...p,[field]:e.target.value})); setPage(0); }}
      style={{ ...sty.input, width:150, fontSize:11 }}>
      <option value="">All {label}</option>
      {vals.map(v=><option key={v} value={v}>{v}</option>)}
    </select>
  );

  return (
    <div>
      <div style={{ display:'flex', gap:12, marginBottom:16, flexWrap:'wrap' }}>
        {Object.entries(data.by_priority||{}).map(([p,n])=>(
          <div key={p} style={{ ...sty.card, marginBottom:0, padding:'10px 14px', flex:1, minWidth:90 }}>
            <div style={{ fontSize:10, color:C.textMut }}>{p}</div>
            <div style={{ fontSize:22, fontWeight:700, color:prioColor(p) }}>{n}</div>
          </div>
        ))}
        <div style={{ ...sty.card, marginBottom:0, padding:'10px 14px', flex:1, minWidth:90 }}>
          <div style={{ fontSize:10, color:C.textMut }}>TOTAL</div>
          <div style={{ fontSize:22, fontWeight:700 }}>{data.total_items}</div>
        </div>
        <button onClick={downloadMaster} style={{ ...sty.btn('primary'), alignSelf:'flex-end', padding:'8px 14px' }}>
          📥 Download Master Input Workbook (5 CSV sheets)
        </button>
      </div>

      <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
        {sel('priority', priorities, 'Priority')}
        {sel('module', modules, 'Module')}
        {sel('owner', owners, 'Owner')}
        {sel('status', statuses, 'Status')}
        <button onClick={() => setFilters({ module:'',priority:'',owner:'',status:'' })} style={{ ...sty.btn(), fontSize:11 }}>Clear Filters</button>
        <span style={{ fontSize:12, color:C.textMut, paddingTop:6 }}>{filtered.length} of {data.total_items} items</span>
      </div>

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr>{['P','Module','Branch/Facility','Field','Existing','Reference Value','Required Input','Owner','Status'].map(h=><th key={h} style={sty.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {pageItems.map(item=>(
              <tr key={item.id} style={{ background:item.priority==='CRITICAL'?C.red+'05':item.priority==='HIGH'?C.yellow+'04':'transparent' }}>
                <td style={sty.td}><span style={sty.badge(prioColor(item.priority))}>{item.priority}</span></td>
                <td style={{ ...sty.td, fontWeight:500, fontSize:11 }}>{item.module}</td>
                <td style={{ ...sty.td, fontSize:11, color:C.textMut, maxWidth:160 }}>{item.branch||item.facility||item.client||'—'}</td>
                <td style={{ ...sty.td, fontSize:11, fontFamily:'monospace', color:C.cyan }}>{item.field_required}</td>
                <td style={{ ...sty.td, fontSize:11, color:C.textMut }}>{item.existing_value||'—'}</td>
                <td style={{ ...sty.td, fontSize:11, color:item.reference_value?C.yellow:C.textMut, maxWidth:180 }}>{item.reference_value||'—'}</td>
                <td style={{ ...sty.td, fontSize:11, maxWidth:220 }}>{item.required_input}</td>
                <td style={sty.td}><span style={sty.badge(C.purple)}>{item.owner}</span></td>
                <td style={sty.td}><span style={sty.badge(statusColor(item.status))}>{item.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages>1 && (
        <div style={{ display:'flex', gap:8, justifyContent:'center', marginTop:14 }}>
          <button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0} style={sty.btn()}>← Prev</button>
          <span style={{ color:C.textSec, fontSize:12, paddingTop:6 }}>Page {page+1}/{totalPages} ({filtered.length} items)</span>
          <button onClick={()=>setPage(p=>Math.min(totalPages-1,p+1))} disabled={page>=totalPages-1} style={sty.btn()}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ─── SECTION: Client Revenue Matrix ───────────────────────────────────────────
function ClientRevenueSection() {
  const [data,     setData]     = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState('');
  const [branchF,  setBranchF]  = useState('');
  const [showOnly, setShowOnly] = useState(false);
  const [editing,  setEditing]  = useState({});
  const [saving,   setSaving]   = useState({});
  const [saved,    setSaved]    = useState({});
  const [page,     setPage]     = useState(0);
  const [importMsg,setImportMsg]= useState(null);
  const fileRef = useRef();
  const PAGE = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, cov] = await Promise.all([
        apiFetch('/fpa/step15/client-revenue-matrix'),
        apiFetch('/fpa/step15/client-revenue/value-coverage').catch(()=>null),
      ]);
      setData(d); setCoverage(cov);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleExport = () => downloadCSV('/api/fpa/step15/export/client-revenue', 'client_revenue_management_input.csv');
  const handleImport = async (e) => {
    const file = e.target.files[0]; if(!file) return;
    setImportMsg({ type:'info', text:'Importing…' });
    try {
      const result = await importCSV(file, '/api/fpa/step15/import/client-revenue');
      setImportMsg({ type:result.errors>0?'warn':'success', text:`Imported ${result.updated} rows. ${result.errors} errors.` });
      await load();
    } catch(err) { setImportMsg({ type:'error', text:err.message }); }
    if(fileRef.current) fileRef.current.value='';
  };

  if(loading) return <div style={{ padding:20, color:C.textMut }}>Loading…</div>;
  if(!data)   return <div style={{ padding:20, color:C.red }}>Failed to load.</div>;

  const rows = (data.rows||[]).filter(r => {
    if(showOnly && r.has_contracted) return false;
    if(branchF && r.branch_id!==branchF) return false;
    if(search) { const q=search.toLowerCase(); return (r.client_name||'').toLowerCase().includes(q)||(r.branch_name||'').toLowerCase().includes(q); }
    return true;
  });
  const branches = [...new Set((data.rows||[]).map(r=>r.branch_id))].sort();
  const totalPages = Math.ceil(rows.length/PAGE);
  const pageRows   = rows.slice(page*PAGE,(page+1)*PAGE);
  const contracted = (data.rows||[]).filter(r=>r.has_contracted).length;

  const getE = (mid,f,fb) => editing[mid]?.[f]!==undefined ? editing[mid][f] : (fb??'');
  const setE = (mid,f,v) => { setEditing(p=>({...p,[mid]:{...p[mid],[f]:v===''?null:v}})); setSaved(p=>({...p,[mid]:false})); };
  const handleSave = async (row) => {
    const mid = row.mapping_id, patch = editing[mid]||{};
    if(!Object.keys(patch).length) return;
    setSaving(p=>({...p,[mid]:true}));
    try {
      const payload = {};
      if(patch.contracted_monthly_revenue!==undefined) payload.contracted_monthly_revenue = patch.contracted_monthly_revenue===null?null:Number(patch.contracted_monthly_revenue);
      if(patch.escalation_pct!==undefined) payload.escalation_pct = patch.escalation_pct===null?null:Number(patch.escalation_pct);
      ['escalation_effective_month','billing_frequency'].forEach(k=>{ if(patch[k]!==undefined) payload[k]=patch[k]; });
      await apiFetch(`/fpa/step15/client-revenue/${mid}`, { method:'PUT', data:payload });
      setSaved(p=>({...p,[mid]:true})); setEditing(p=>{const n={...p}; delete n[mid]; return n;});
      await load();
    } catch(e) { alert('Save failed: '+e.message); }
    finally { setSaving(p=>({...p,[mid]:false})); }
  };

  return (
    <div>
      <div style={{ ...sty.card, borderColor:contracted===0?C.red+'66':contracted<(data.rows||[]).length?C.yellow+'66':C.green+'66' }}>
        <div style={{ display:'flex', gap:14, flexWrap:'wrap', marginBottom:10 }}>
          {[
            { label:'Total Mappings', val:(data.rows||[]).length, c:C.text },
            { label:'Contracted', val:contracted, c:contracted===0?C.red:contracted===(data.rows||[]).length?C.green:C.yellow },
            { label:'Record Coverage', val:`${(data.rows||[]).length?Math.round(contracted/(data.rows||[]).length*100):0}%`, c:C.yellow },
            coverage?{ label:'Value Coverage (₹-wtd)', val:`${coverage.value_coverage_pct}%`, c:coverage.value_coverage_pct>80?C.green:C.yellow }:null,
            coverage?{ label:'Reference Revenue', val:fmtINR(coverage.total_reference_revenue_inr), c:C.cyan }:null,
            coverage?{ label:'Contracted Revenue', val:fmtINR(coverage.contracted_revenue_inr), c:C.green }:null,
          ].filter(Boolean).map(k=>(
            <div key={k.label} style={{ ...sty.card, marginBottom:0, flex:1, minWidth:100, padding:'10px 14px' }}>
              <div style={{ fontSize:10, color:C.textMut }}>{k.label}</div>
              <div style={{ fontSize:16, fontWeight:700, color:k.c }}>{k.val}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize:12, color:C.textSec }}>
          <strong>Enter Contracted Monthly Revenue in ₹/month.</strong> Actuals (Latest/3M/6M) are reference only — do NOT auto-copy.
        </div>
      </div>

      <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap' }}>
        <input placeholder="Search…" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}} style={{ ...sty.input, width:200 }} />
        <select value={branchF} onChange={e=>{setBranchF(e.target.value);setPage(0);}} style={{ ...sty.input, width:180 }}>
          <option value="">All Branches</option>
          {branches.map(b=><option key={b} value={b}>{b}</option>)}
        </select>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:C.textSec, cursor:'pointer' }}>
          <input type="checkbox" checked={showOnly} onChange={e=>{setShowOnly(e.target.checked);setPage(0);}} />
          Only missing
        </label>
        <span style={{ flex:1 }} />
        <button onClick={handleExport} style={sty.btn('primary')}>📥 Export CSV</button>
        <label style={{ ...sty.btn('primary'), cursor:'pointer' }}>
          📤 Import CSV
          <input type="file" accept=".csv" ref={fileRef} onChange={handleImport} style={{ display:'none' }} />
        </label>
      </div>

      {importMsg && <div style={{ padding:'8px 12px', borderRadius:4, marginBottom:10, fontSize:12, background:importMsg.type==='error'?C.red+'22':importMsg.type==='warn'?C.yellow+'22':C.green+'22', color:importMsg.type==='error'?C.red:importMsg.type==='warn'?C.yellow:C.green }}>{importMsg.text}</div>}
      <div style={{ fontSize:12, color:C.textMut, marginBottom:8 }}>Showing {rows.length} of {(data.rows||[]).length}</div>

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr>{['Client','Branch','Latest Actual','3M Avg','6M Avg','Contracted/Month (₹)','Esc %','Status','Save'].map(h=><th key={h} style={sty.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {pageRows.map(row=>{
              const mid = row.mapping_id, dirty = Object.keys(editing[mid]||{}).length>0;
              return (
                <tr key={mid} style={{ background:!row.has_contracted?C.red+'05':dirty?C.yellow+'04':'transparent' }}>
                  <td style={sty.td}>{row.client_name}</td>
                  <td style={{ ...sty.td, fontSize:11, color:C.textMut }}>{row.branch_name}</td>
                  <td style={{ ...sty.td, fontSize:11, fontFamily:'monospace', color:C.cyan }}>
                    {row.latest_actual_revenue!=null?<><span>{fmtINR(row.latest_actual_revenue)}</span><br/><span style={{ fontSize:10,color:C.textMut }}>{row.latest_actual_month}</span></>:'—'}
                  </td>
                  <td style={{ ...sty.td, fontSize:11, fontFamily:'monospace', color:C.textSec }}>{fmtINR(row.avg_3m)}</td>
                  <td style={{ ...sty.td, fontSize:11, fontFamily:'monospace', color:C.textSec }}>{fmtINR(row.avg_6m)}</td>
                  <td style={{ ...sty.td, minWidth:130 }}>
                    <input type="number" min={0} step="100"
                      value={getE(mid,'contracted_monthly_revenue',row.contracted_monthly_revenue??'')}
                      onChange={e=>setE(mid,'contracted_monthly_revenue',e.target.value)}
                      placeholder="₹/month"
                      style={{ ...sty.input, width:120, borderColor:!row.has_contracted?C.red+'88':C.border }} />
                  </td>
                  <td style={{ ...sty.td, minWidth:80 }}>
                    <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                      <input type="number" min={0} max={100} step="0.5" value={getE(mid,'escalation_pct',row.escalation_pct??'')} onChange={e=>setE(mid,'escalation_pct',e.target.value)} placeholder="0" style={{ ...sty.input, width:55 }} />
                      <span style={{ fontSize:11,color:C.textMut }}>%</span>
                    </div>
                  </td>
                  <td style={sty.td}><span style={sty.badge(row.has_contracted?C.green:C.red)}>{row.has_contracted?'SET':'MISSING'}</span></td>
                  <td style={sty.td}>
                    {dirty && <button onClick={()=>handleSave(row)} disabled={saving[mid]} style={{ ...sty.btn('primary'), fontSize:11, padding:'3px 8px' }}>{saving[mid]?'…':'✓ Save'}</button>}
                    {saved[mid]&&!dirty && <span style={{ color:C.green, fontSize:11 }}>✓</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalPages>1 && (
        <div style={{ display:'flex', gap:8, justifyContent:'center', marginTop:14 }}>
          <button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={page===0} style={sty.btn()}>← Prev</button>
          <span style={{ color:C.textSec, fontSize:12, paddingTop:6 }}>Page {page+1}/{totalPages} ({rows.length} rows)</span>
          <button onClick={()=>setPage(p=>Math.min(totalPages-1,p+1))} disabled={page>=totalPages-1} style={sty.btn()}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ─── SECTION: Branch Capacity ─────────────────────────────────────────────────
function BranchCapacitySection() {
  const [branches, setBranches] = useState([]);
  const [costRef,  setCostRef]  = useState([]);
  const [editing,  setEditing]  = useState({});
  const [saving,   setSaving]   = useState({});
  const [saved,    setSaved]    = useState({});
  const [loading,  setLoading]  = useState(true);
  const [importMsg,setImportMsg]= useState(null);
  const fileRef = useRef();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [brR, caR] = await Promise.all([apiFetch('/fpa/branch-master'), apiFetch('/fpa/step15/cost-actuals').catch(()=>({branches:[]}))]);
      setBranches(brR.branches||[]); setCostRef(caR.branches||[]);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const costByBranch = {};
  for(const c of costRef) costByBranch[c.branch_id] = c;

  const handleExport = () => downloadCSV('/api/fpa/step15/export/branch-capacity', 'branch_capacity_management_input.csv');
  const handleImport = async (e) => {
    const file = e.target.files[0]; if(!file) return;
    setImportMsg({ type:'info', text:'Importing…' });
    try {
      const r = await importCSV(file, '/api/fpa/step15/import/branch-capacity');
      setImportMsg({ type:r.errors>0?'warn':'success', text:`Imported ${r.updated} rows. ${r.errors} errors.` });
      await load();
    } catch(err) { setImportMsg({ type:'error', text:err.message }); }
    if(fileRef.current) fileRef.current.value='';
  };

  const getE = (bid,f,fb) => editing[bid]?.[f]!==undefined ? editing[bid][f] : (fb??'');
  const setE = (bid,f,v) => { setEditing(p=>({...p,[bid]:{...p[bid],[f]:v===''?null:v}})); setSaved(p=>({...p,[bid]:false})); };
  const handleSave = async (bid) => {
    const patch=editing[bid]; if(!patch||!Object.keys(patch).length) return;
    setSaving(p=>({...p,[bid]:true}));
    try {
      const pl={};
      ['total_seats','total_area_sqft','revenue_capacity_sqft','rent_per_sqft','rent_monthly','cam_monthly','target_occupancy_pct'].forEach(k=>{if(patch[k]!==undefined)pl[k]=patch[k]===null?null:Number(patch[k]);});
      ['status','opening_date'].forEach(k=>{if(patch[k]!==undefined)pl[k]=patch[k];});
      await apiFetch(`/fpa/step15/branch/${bid}`, { method:'PUT', data:pl });
      setSaved(p=>({...p,[bid]:true})); setEditing(p=>{const n={...p};delete n[bid];return n;});
      await load();
    } catch(e) { alert(e.message); }
    finally { setSaving(p=>({...p,[bid]:false})); }
  };

  if(loading) return <div style={{ padding:20, color:C.textMut }}>Loading…</div>;
  const withSeats = branches.filter(b=>Number(b.total_seats||0)>0).length;
  const withArea  = branches.filter(b=>Number(b.total_area_sqft||0)>0).length;

  return (
    <div>
      <div style={{ ...sty.card }}>
        <div style={{ display:'flex', gap:14, flexWrap:'wrap', marginBottom:12 }}>
          {[
            { label:'Branches', val:branches.length, c:C.text },
            { label:'With Seats ⚠', val:withSeats, c:withSeats===0?C.red:C.green },
            { label:'With Area', val:withArea, c:withArea<branches.length?C.yellow:C.green },
          ].map(k=>(
            <div key={k.label} style={{ ...sty.card, marginBottom:0, flex:1, minWidth:90, padding:'10px 14px' }}>
              <div style={{ fontSize:10, color:C.textMut }}>{k.label}</div>
              <div style={{ fontSize:20, fontWeight:700, color:k.c }}>{k.val}</div>
            </div>
          ))}
          <div style={{ fontSize:12, color:C.textSec, flex:2, minWidth:200, paddingTop:8 }}>
            <strong style={{ color:C.yellow }}>total_seats is NOT available from any data source and requires management input.</strong><br/>
            Reference columns (shaded) are pre-populated from lease_schedule.json.
          </div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={handleExport} style={sty.btn('primary')}>📥 Export Capacity Template</button>
          <label style={{ ...sty.btn('primary'), cursor:'pointer' }}>
            📤 Import Capacity
            <input type="file" accept=".csv" ref={fileRef} onChange={handleImport} style={{ display:'none' }} />
          </label>
        </div>
      </div>

      {importMsg && <div style={{ padding:'8px 12px', borderRadius:4, marginBottom:10, fontSize:12, background:importMsg.type==='error'?C.red+'22':C.green+'22', color:importMsg.type==='error'?C.red:C.green }}>{importMsg.text}</div>}

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr>
              <th style={sty.th}>Branch</th>
              <th style={{ ...sty.th, background:C.cyan+'11' }}>Ref: Lease Sqft</th>
              <th style={{ ...sty.th, background:C.cyan+'11' }}>Ref: Rent (₹L/mo)</th>
              <th style={sty.th}>Status</th>
              <th style={sty.th}>Total Area (sqft)</th>
              <th style={sty.th}>Rev Cap (sqft)</th>
              <th style={{ ...sty.th, color:C.red }}>Total Seats *</th>
              <th style={sty.th}>Target Occ%</th>
              <th style={sty.th}>Opening Date</th>
              <th style={sty.th}>Save</th>
            </tr>
          </thead>
          <tbody>
            {branches.map(b=>{
              const bid=b.branch_id, ca=costByBranch[bid]||{}, dirty=Object.keys(editing[bid]||{}).length>0, hasSeats=Number(b.total_seats||0)>0;
              const inp=(f,w=80,hl=false)=>(
                <input type="number" min={0} value={getE(bid,f,b[f])} onChange={e=>setE(bid,f,e.target.value)}
                  style={{ ...sty.input, width:w, borderColor:hl&&!b[f]?C.red+'88':C.border }} />
              );
              return (
                <tr key={bid} style={{ background:!hasSeats?C.red+'06':dirty?C.yellow+'04':'transparent' }}>
                  <td style={{ ...sty.td, fontWeight:500, fontSize:11 }}>{b.branch_name}<br/><span style={{ fontSize:10,color:C.textMut }}>{b.city}</span></td>
                  <td style={{ ...sty.td, background:C.cyan+'08', fontSize:11, fontFamily:'monospace', color:C.cyan }}>
                    {ca.lease_sqft_super?ca.lease_sqft_super.toLocaleString('en-IN'):'—'}
                    {ca.lease_count?<span style={{ fontSize:10,color:C.textMut }}><br/>{ca.lease_count} lease(s)</span>:null}
                  </td>
                  <td style={{ ...sty.td, background:C.cyan+'08', fontSize:11, fontFamily:'monospace', color:C.cyan }}>{ca.lease_rent_lakh?fmtL(ca.lease_rent_lakh):'—'}</td>
                  <td style={sty.td}>
                    <select value={getE(bid,'status',b.status||'LIVE')} onChange={e=>setE(bid,'status',e.target.value)} style={{ ...sty.input, width:90, fontSize:11 }}>
                      {['LIVE','PLANNED','UNDER FITOUT','FUTURE','CLOSED'].map(v=><option key={v} value={v}>{v}</option>)}
                    </select>
                  </td>
                  <td style={sty.td}>{inp('total_area_sqft',85,true)}</td>
                  <td style={sty.td}>{inp('revenue_capacity_sqft',85)}</td>
                  <td style={{ ...sty.td, background:!hasSeats?C.red+'08':'' }}>{inp('total_seats',70,true)}</td>
                  <td style={sty.td}>{inp('target_occupancy_pct',65)}</td>
                  <td style={sty.td}><input type="date" value={getE(bid,'opening_date',b.opening_date||'')} onChange={e=>setE(bid,'opening_date',e.target.value)} style={{ ...sty.input, width:130, fontSize:11 }} /></td>
                  <td style={sty.td}>
                    {dirty&&<button onClick={()=>handleSave(bid)} disabled={saving[bid]} style={{ ...sty.btn('primary'), fontSize:11, padding:'3px 7px' }}>{saving[bid]?'…':'Save'}</button>}
                    {saved[bid]&&!dirty&&<span style={{ color:C.green, fontSize:11 }}>✓</span>}
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

// ─── SECTION: Cost & Utilities ────────────────────────────────────────────────
function CostUtilitiesSection() {
  const [costActuals, setCostActuals] = useState([]);
  const [editing,     setEditing]     = useState({});
  const [saving,      setSaving]      = useState({});
  const [saved,       setSaved]       = useState({});
  const [loading,     setLoading]     = useState(true);
  const [utMeth,      setUtMeth]      = useState('');
  const [savingUtil,  setSavingUtil]  = useState(false);
  const [bulkMethod,  setBulkMethod]  = useState('6m');
  const [bulkEsc,     setBulkEsc]     = useState('0');
  const [bulkApplying,setBulkApplying]= useState(false);
  const [bulkMsg,     setBulkMsg]     = useState(null);
  const [expanded,    setExpanded]    = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ca, ga] = await Promise.all([apiFetch('/fpa/step15/cost-actuals'), apiFetch('/fpa/global-assumptions')]);
      setCostActuals(ca.branches||[]); setUtMeth(ga.utilities_method||'');
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const getE = (bid,f,fb) => editing[bid]?.[f]!==undefined ? editing[bid][f] : (fb??'');
  const setE = (bid,f,v) => { setEditing(p=>({...p,[bid]:{...p[bid],[f]:v===''?null:v}})); setSaved(p=>({...p,[bid]:false})); };

  const handleSave = async (bid) => {
    const patch=editing[bid]; if(!patch||!Object.keys(patch).length) return;
    setSaving(p=>({...p,[bid]:true}));
    try {
      const pl={};
      ['rent_monthly','cam_monthly','people_cost_monthly','utilities_monthly','other_direct_cost_monthly'].forEach(k=>{if(patch[k]!==undefined)pl[k]=patch[k]===null?null:Number(patch[k]);});
      await apiFetch(`/fpa/step15/branch/${bid}`, { method:'PUT', data:pl });
      setSaved(p=>({...p,[bid]:true})); setEditing(p=>{const n={...p};delete n[bid];return n;});
      await load();
    } catch(e) { alert(e.message); }
    finally { setSaving(p=>({...p,[bid]:false})); }
  };

  const applyToBranch = async (bid, method) => {
    setSaving(p=>({...p,[bid]:true}));
    try {
      await apiFetch('/fpa/step15/cost-actuals/apply', { method:'POST', data:{ branch_id:bid, method, escalation_pct:0 } });
      setSaved(p=>({...p,[bid]:true})); await load();
    } catch(e) { alert(e.message); }
    finally { setSaving(p=>({...p,[bid]:false})); }
  };

  const bulkApply = async () => {
    setBulkApplying(true); setBulkMsg(null);
    try {
      const r = await apiFetch('/fpa/step15/cost-actuals/bulk-apply', { method:'POST', data:{ method:bulkMethod, escalation_pct:Number(bulkEsc)||0 } });
      setBulkMsg({ type:'success', text:r.message }); await load();
    } catch(e) { setBulkMsg({ type:'error', text:e.message }); }
    finally { setBulkApplying(false); }
  };

  const saveUtMeth = async () => {
    if(!utMeth) { alert('Select a methodology first.'); return; }
    setSavingUtil(true);
    try {
      const ga = await apiFetch('/fpa/global-assumptions');
      ga.utilities_method = utMeth;
      await apiFetch('/fpa/global-assumptions', { method:'PUT', data:ga });
      await load();
    } catch(e) { alert(e.message); }
    finally { setSavingUtil(false); }
  };

  if(loading) return <div style={{ padding:20, color:C.textMut }}>Loading…</div>;
  const withCosts = costActuals.filter(c=>c.current_rent_monthly||c.current_cam_monthly).length;

  return (
    <div>
      {/* Utilities */}
      <div style={sty.card}>
        <div style={{ fontSize:13, fontWeight:600, color:C.text, marginBottom:8 }}>Utilities Methodology — Management Approval Required</div>
        <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <select value={utMeth} onChange={e=>setUtMeth(e.target.value)} style={{ ...sty.input, width:220 }}>
            <option value="">— Select Method —</option>
            {['100% Fixed Monthly','Per Seat','Per Sq Ft','Fixed + Variable','CAM Included','Metered Actual'].map(v=>(
              <option key={v} value={v.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z_+]/g,'')}>{v}</option>
            ))}
          </select>
          <button onClick={saveUtMeth} disabled={savingUtil||!utMeth} style={sty.btn(utMeth?'success':'def')}>{savingUtil?'Saving…':'✓ Approve'}</button>
          {utMeth && <span style={sty.badge(C.green)}>{utMeth}</span>}
        </div>
      </div>

      {/* Bulk Apply */}
      <div style={{ ...sty.card, borderColor:C.cyan+'55' }}>
        <div style={{ fontSize:13, fontWeight:600, color:C.text, marginBottom:6 }}>Bulk Apply Cost Base (All Branches from Zoho Bills)</div>
        <div style={{ fontSize:12, color:C.textSec, marginBottom:10 }}>
          Sets rent, utilities, people_cost, other_direct for all branches. Management selects the averaging period.
          Zoho bills history: Apr–Sep 2026 (6 months). CAM must be entered separately (not in bills).
        </div>
        <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <select value={bulkMethod} onChange={e=>setBulkMethod(e.target.value)} style={{ ...sty.input, width:180 }}>
            <option value="latest">Use Latest Month Actual</option>
            <option value="3m">Use 3-Month Average</option>
            <option value="6m">Use 6-Month Average</option>
            <option value="fytd">Use FYTD Average</option>
          </select>
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            <span style={{ fontSize:12, color:C.textSec }}>Escalation:</span>
            <input type="number" min={0} max={50} step="0.5" value={bulkEsc} onChange={e=>setBulkEsc(e.target.value)} style={{ ...sty.input, width:60 }} />
            <span style={{ fontSize:12, color:C.textSec }}>% p.a.</span>
          </div>
          <button onClick={bulkApply} disabled={bulkApplying} style={sty.btn('primary')}>{bulkApplying?'Applying…':'⚡ Apply to All Branches'}</button>
        </div>
        {bulkMsg && <div style={{ marginTop:8, padding:'8px 12px', borderRadius:4, fontSize:12, background:bulkMsg.type==='error'?C.red+'22':C.green+'22', color:bulkMsg.type==='error'?C.red:C.green }}>{bulkMsg.text}</div>}
      </div>

      {/* Branch table */}
      <div style={{ fontSize:13, fontWeight:600, color:C.text, marginBottom:6 }}>Per-Branch: {withCosts}/{costActuals.length} populated</div>
      <div style={{ fontSize:12, color:C.textSec, marginBottom:10 }}>
        Shaded columns = Zoho bills reference (6M avg). Green column = lease schedule. Click ▶ to see full bill category breakdown.
        Click 3M/6M/FYTD to apply that average directly, or enter manually.
      </div>
      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr>
              <th style={sty.th}>Branch</th>
              <th style={{ ...sty.th, background:C.green+'11' }}>Lease Rent (₹L)</th>
              <th style={{ ...sty.th, background:C.cyan+'11' }}>Bills Rent 6M</th>
              <th style={{ ...sty.th, background:C.cyan+'11' }}>Bills Util 6M</th>
              <th style={{ ...sty.th, background:C.cyan+'11' }}>Bills People 6M</th>
              <th style={sty.th}>Rent/Month (₹)</th>
              <th style={sty.th}>CAM (₹)</th>
              <th style={sty.th}>Utilities (₹)</th>
              <th style={sty.th}>People (₹)</th>
              <th style={sty.th}>Apply / Save</th>
            </tr>
          </thead>
          <tbody>
            {costActuals.map(ca=>{
              const bid=ca.branch_id, dirty=Object.keys(editing[bid]||{}).length>0;
              const hasCost = ca.current_rent_monthly||ca.current_cam_monthly;
              const inp=(f,refVal)=>(
                <input type="number" min={0}
                  value={getE(bid,f,ca[`current_${f}`])}
                  onChange={e=>setE(bid,f,e.target.value)}
                  placeholder={refVal?`≈${fmtINR(refVal)}`:'₹/month'}
                  style={{ ...sty.input, width:95, borderColor:!ca[`current_${f}`]&&!editing[bid]?.[f]?C.yellow+'66':C.border }} />
              );
              return (
                <React.Fragment key={bid}>
                  <tr style={{ background:!hasCost?C.yellow+'04':dirty?C.cyan+'04':'transparent' }}>
                    <td style={{ ...sty.td, fontSize:11 }}>
                      <button onClick={()=>setExpanded(expanded===bid?null:bid)} style={{ background:'none', border:'none', color:C.cyan, cursor:'pointer', fontSize:11, padding:0, marginRight:6 }}>{expanded===bid?'▼':'▶'}</button>
                      {ca.branch_name}
                    </td>
                    <td style={{ ...sty.td, background:C.green+'08', fontSize:11, fontFamily:'monospace', color:C.green }}>{ca.lease_rent_lakh?fmtL(ca.lease_rent_lakh):'—'}</td>
                    <td style={{ ...sty.td, background:C.cyan+'08', fontSize:11, fontFamily:'monospace', color:C.cyan }}>{fmtINR(ca.ref_rent)}</td>
                    <td style={{ ...sty.td, background:C.cyan+'08', fontSize:11, fontFamily:'monospace', color:C.cyan }}>{fmtINR(ca.ref_utilities)}</td>
                    <td style={{ ...sty.td, background:C.cyan+'08', fontSize:11, fontFamily:'monospace', color:C.cyan }}>{fmtINR(ca.ref_people_cost)}</td>
                    <td style={sty.td}>{inp('rent_monthly',ca.ref_rent)}</td>
                    <td style={sty.td}>{inp('cam_monthly',null)}</td>
                    <td style={sty.td}>{inp('utilities_monthly',ca.ref_utilities)}</td>
                    <td style={sty.td}>{inp('people_cost_monthly',ca.ref_people_cost)}</td>
                    <td style={{ ...sty.td, minWidth:170 }}>
                      <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                        {['3m','6m','fytd'].map(m=>(
                          <button key={m} onClick={()=>applyToBranch(bid,m)} disabled={saving[bid]} style={{ ...sty.btn('primary'), fontSize:10, padding:'2px 6px' }}>{m.toUpperCase()}</button>
                        ))}
                        {dirty&&<button onClick={()=>handleSave(bid)} disabled={saving[bid]} style={{ ...sty.btn('success'), fontSize:10, padding:'2px 6px' }}>{saving[bid]?'…':'Save'}</button>}
                        {saved[bid]&&!dirty&&<span style={{ color:C.green, fontSize:11 }}>✓</span>}
                      </div>
                    </td>
                  </tr>
                  {expanded===bid&&(
                    <tr>
                      <td colSpan={10} style={{ padding:'10px 16px', background:C.surfaceEl }}>
                        <div style={{ fontSize:12, fontWeight:600, color:C.text, marginBottom:8 }}>Bill Breakdown — {ca.branch_name}</div>
                        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                          {Object.entries(ca.bill_categories||{}).map(([cat,s])=>(
                            <div key={cat} style={{ ...sty.card, marginBottom:0, padding:'8px 12px', fontSize:11, minWidth:160 }}>
                              <div style={{ color:C.textMut, fontSize:10, marginBottom:2 }}>{cat}</div>
                              <div style={{ color:C.cyan, fontFamily:'monospace' }}>Latest: {fmtINR(s.latest_amount)}</div>
                              <div style={{ color:C.textSec }}>3M: {fmtINR(s.avg_3m)} &nbsp; 6M: {fmtINR(s.avg_6m)}</div>
                              <div style={{ fontSize:10, color:C.textMut }}>{s.months_of_data} months data</div>
                            </div>
                          ))}
                          {Object.keys(ca.bill_categories||{}).length===0 && <span style={{ color:C.textMut, fontSize:11 }}>No categorized bills found for this branch.</span>}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── SECTION: OBS Review & Approval ──────────────────────────────────────────
function OBSApprovalSection() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [decision,setDecision]= useState('approved');
  const [approver,setApprover]= useState('');
  const [comment, setComment] = useState('');
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState(null);
  const [showTrail,setShowTrail]= useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiFetch('/fpa/step15/obs-review')); }
    catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const handle = async () => {
    if (!approver.trim()) { setMsg({ type:'error', text:'Approver name is required.' }); return; }
    if (decision==='approved' && !comment.trim()) { setMsg({ type:'error', text:'Approval note required: state basis and confirm difference is immaterial.' }); return; }
    setSaving(true); setMsg(null);
    try {
      const r = await apiFetch('/fpa/step15/obs-approve-v2', { method:'POST', data:{ decision, approved_by:approver, comment } });
      setMsg({ type:'success', text:r.message }); setComment('');
      await load();
    } catch(e) { setMsg({ type:'error', text:e.message }); }
    finally { setSaving(false); }
  };

  if (loading) return <div style={{ padding:20, color:C.textMut }}>Loading OBS…</div>;
  if (!data)   return <div style={{ padding:20, color:C.red }}>Failed to load OBS.</div>;

  const diff     = data.bs_check_diff||0;
  const balanced = Math.abs(diff)<=0.1;
  const isApproved = data.approval_status==='approved';
  const decColors  = { approved:C.green, rejected:C.red, returned_for_correction:C.yellow };
  const statusColor2 = decColors[data.approval_status]||C.yellow;

  return (
    <div>
      {/* Summary tiles */}
      <div style={{ display:'flex', gap:12, marginBottom:16, flexWrap:'wrap' }}>
        {[
          { label:'Total Assets',     val:fmtL(data.total_assets), c:C.cyan },
          { label:'Total E+L',        val:fmtL(data.total_el||data.total_liabilities_equity), c:C.cyan },
          { label:'Difference',       val:fmtL(diff), c:balanced?C.green:C.red },
          { label:'Reconciliation',   val:data.reconciliation_status||'PENDING', c:balanced?C.green:C.red },
          { label:'Approval Status',  val:data.approval_status||'pending_review', c:statusColor2 },
        ].map(k=>(
          <div key={k.label} style={{ ...sty.card, marginBottom:0, flex:1, minWidth:110, padding:'10px 14px' }}>
            <div style={{ fontSize:10, color:C.textMut }}>{k.label}</div>
            <div style={{ fontSize:14, fontWeight:700, color:k.c }}>{k.val}</div>
          </div>
        ))}
      </div>

      {/* Reconciliation note */}
      <div style={{ padding:'10px 14px', background:balanced?C.green+'11':C.red+'11', border:`1px solid ${balanced?C.green:C.red}44`, borderRadius:6, marginBottom:14, fontSize:12, color:C.textSec }}>
        {data.reconciliation_note||'—'}
        {!balanced && <div style={{ color:C.red, marginTop:4, fontWeight:500 }}>DO NOT use a balancing plug. Identify the actual source of the difference before approving.</div>}
      </div>

      {/* Line items (if any) */}
      {data.has_line_items && (
        <div style={{ ...sty.card, marginBottom:14 }}>
          <div style={{ fontSize:12, fontWeight:600, color:C.text, marginBottom:8 }}>Balance Sheet Line Items</div>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead><tr>{['Category','Description','Amount (₹L)','Source'].map(h=><th key={h} style={sty.th}>{h}</th>)}</tr></thead>
              <tbody>
                {(data.line_items||[]).map((li,i)=>(
                  <tr key={i}>
                    <td style={{ ...sty.td, fontSize:11 }}>{li.category||'—'}</td>
                    <td style={{ ...sty.td, fontSize:11 }}>{li.description||'—'}</td>
                    <td style={{ ...sty.td, fontFamily:'monospace', fontSize:11, color:C.cyan }}>{fmtL(li.amount||li.value)}</td>
                    <td style={{ ...sty.td, fontSize:10, color:C.textMut }}>{li.source||'—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Approval panel */}
      {isApproved ? (
        <div style={{ ...sty.card, borderColor:C.green+'66' }}>
          <div style={{ fontSize:14, fontWeight:700, color:C.green, marginBottom:8 }}>✓ OBS APPROVED — Locked as Baseline Opening Position</div>
          <div style={{ fontSize:12, color:C.textSec, marginBottom:4 }}>
            Approved by: <strong style={{ color:C.text }}>{data.approved_by||'—'}</strong> &nbsp;·&nbsp; {data.approved_at||'—'}
          </div>
          <div style={{ fontSize:12, color:C.textSec, marginBottom:14 }}>Note: {data.approval_note||'—'}</div>
          <div style={{ marginBottom:8 }}>
            <button onClick={()=>setDecision('returned_for_correction')} style={sty.btn('warn')}>↩ Reopen for Correction</button>
          </div>
          {decision==='returned_for_correction' && (
            <div>
              <div style={{ marginBottom:8 }}>
                <span style={sty.lbl}>Your Name (required)</span>
                <input value={approver} onChange={e=>setApprover(e.target.value)} placeholder="Full name" style={{ ...sty.input, maxWidth:260 }} />
              </div>
              <div style={{ marginBottom:10 }}>
                <span style={sty.lbl}>Reason for reopening (required)</span>
                <textarea value={comment} onChange={e=>setComment(e.target.value)} rows={3} style={{ ...sty.input, resize:'vertical' }} />
              </div>
              {msg && <div style={{ padding:'6px 10px', borderRadius:4, marginBottom:8, fontSize:12, background:msg.type==='error'?C.red+'22':C.green+'22', color:msg.type==='error'?C.red:C.green }}>{msg.text}</div>}
              <button onClick={handle} disabled={saving} style={sty.btn('warn')}>{saving?'Saving…':'Confirm Return for Correction'}</button>
            </div>
          )}
        </div>
      ) : (
        <div style={sty.card}>
          <div style={{ fontSize:13, fontWeight:600, color:C.text, marginBottom:12 }}>Management Decision Required</div>
          <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
            {[
              { key:'approved', label:'✓ APPROVE', v:'success' },
              { key:'rejected', label:'✗ REJECT', v:'danger' },
              { key:'returned_for_correction', label:'↩ RETURN FOR CORRECTION', v:'warn' },
            ].map(o=>(
              <button key={o.key} onClick={()=>setDecision(o.key)}
                style={{ ...sty.btn(decision===o.key?o.v:'def'), fontSize:12, fontWeight:decision===o.key?600:400 }}>
                {o.label}
              </button>
            ))}
          </div>
          <div style={{ marginBottom:10 }}>
            <span style={sty.lbl}>Approver Name (required)</span>
            <input value={approver} onChange={e=>setApprover(e.target.value)} placeholder="Full name" style={{ ...sty.input, maxWidth:300 }} />
          </div>
          <div style={{ marginBottom:14 }}>
            <span style={sty.lbl}>{decision==='approved'?'Approval Note (required — basis, confirm difference is immaterial)':'Comment'}</span>
            <textarea value={comment} onChange={e=>setComment(e.target.value)} rows={4}
              placeholder={decision==='approved'?'I have reviewed and confirm OBS is correct. The ₹X difference is due to rounding and is immaterial.':''}
              style={{ ...sty.input, resize:'vertical' }} />
          </div>
          {msg && <div style={{ padding:'8px 12px', borderRadius:4, marginBottom:12, fontSize:12, background:msg.type==='error'?C.red+'22':C.green+'22', color:msg.type==='error'?C.red:C.green }}>{msg.text}</div>}
          <button onClick={handle} disabled={saving}
            style={sty.btn(decision==='approved'?'success':decision==='rejected'?'danger':'warn')}>
            {saving?'Saving…':`Submit: ${decision.replace(/_/g,' ').toUpperCase()}`}
          </button>
        </div>
      )}

      {/* Audit trail */}
      {(data.audit_trail||[]).length>0 && (
        <div style={{ marginTop:16 }}>
          <button onClick={()=>setShowTrail(p=>!p)} style={{ ...sty.btn(), fontSize:11 }}>
            {showTrail?'▲ Hide':'▶ Show'} Audit Trail ({(data.audit_trail||[]).length} entries)
          </button>
          {showTrail && (
            <div style={{ ...sty.card, marginTop:8 }}>
              {[...(data.audit_trail||[])].reverse().map((t,i,arr)=>(
                <div key={i} style={{ display:'flex', gap:12, padding:'8px 0', borderBottom:i<arr.length-1?`1px solid ${C.border}`:'none', fontSize:12, flexWrap:'wrap' }}>
                  <span style={{ fontFamily:'monospace', color:decColors[t.action]||C.textMut, fontWeight:600, minWidth:140 }}>{(t.action||'').replace(/_/g,' ').toUpperCase()}</span>
                  <span style={{ color:C.text }}>{t.by}</span>
                  <span style={{ color:C.textMut, fontSize:11 }}>{(t.at||'').slice(0,16)}</span>
                  {t.comment && <span style={{ color:C.textSec, fontStyle:'italic' }}>{t.comment}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SECTION: Debt Completion ─────────────────────────────────────────────────
function DebtFinanceSection() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState({});
  const [saving,  setSaving]  = useState({});
  const [schedule,setSchedule]= useState(null);
  const [importing,setImporting]= useState(false);
  const [msg,     setMsg]     = useState(null);
  const fileRef = useRef();

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await apiFetch('/fpa/step15/debt-completion')); }
    catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const getE = (id, f, fb) => editing[id]?.[f] !== undefined ? editing[id][f] : (fb ?? '');
  const setE = (id, f, v) => setEditing(p => ({ ...p, [id]: { ...p[id], [f]: v===''?null:v } }));

  const handleSave = async (fid) => {
    const patch = editing[fid]; if (!patch || !Object.keys(patch).length) return;
    setSaving(p=>({...p,[fid]:true}));
    try {
      await apiFetch('/fpa/step15/debt-completion/save', { method:'POST', data:{ facility_id:fid, ...patch } });
      setEditing(p=>{const n={...p};delete n[fid];return n;});
      setMsg({ type:'success', text:`Saved ${fid}.` }); await load();
    } catch(e) { setMsg({ type:'error', text:e.message }); }
    finally { setSaving(p=>({...p,[fid]:false})); }
  };

  const viewSchedule = async (fid) => {
    try {
      const s = await apiFetch(`/fpa/step15/debt-completion/${fid}/schedule`);
      setSchedule({ facility_id:fid, data:s });
    } catch(e) { setMsg({ type:'error', text:'Cannot derive schedule: '+e.message }); }
  };

  const handleExport = () => downloadCSV('/api/fpa/step15/export/debt-completion-csv', 'debt_completion_template.csv');
  const handleImport = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setImporting(true);
    try {
      const r = await importCSV(file, '/api/fpa/step15/import/debt-completion-csv');
      setMsg({ type:'success', text:`Imported ${r.updated} rows.` }); await load();
    } catch(err) { setMsg({ type:'error', text:err.message }); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value=''; }
  };

  if (loading) return <div style={{ padding:20, color:C.textMut }}>Loading…</div>;
  if (!data)   return <div style={{ padding:20, color:C.red }}>Failed to load.</div>;

  const facs = data.facilities||[];
  const s    = data.summary||{};

  return (
    <div>
      {/* Summary */}
      <div style={{ display:'flex', gap:12, marginBottom:16, flexWrap:'wrap' }}>
        {[
          { label:'Facilities', val:s.total, c:C.text },
          { label:'Complete / Derivable', val:`${s.complete||0} / ${s.can_derive||0}`, c:(s.complete||0)+(s.can_derive||0)===s.total?C.green:C.yellow },
          { label:'Needs Manual Input', val:s.needs_manual||0, c:(s.needs_manual||0)>0?C.red:C.green },
          { label:'Zero Rate (confirm)', val:s.zero_rate_confirm||0, c:(s.zero_rate_confirm||0)>0?C.yellow:C.green },
        ].map(k=>(
          <div key={k.label} style={{ ...sty.card, marginBottom:0, flex:1, minWidth:110, padding:'10px 14px' }}>
            <div style={{ fontSize:10, color:C.textMut }}>{k.label}</div>
            <div style={{ fontSize:18, fontWeight:700, color:k.c }}>{k.val}</div>
          </div>
        ))}
        <div style={{ display:'flex', gap:8, alignSelf:'center', flexWrap:'wrap' }}>
          <button onClick={handleExport} style={sty.btn('primary')}>📥 Export Template</button>
          <label style={{ ...sty.btn('primary'), cursor:'pointer' }}>
            {importing?'Importing…':'📤 Import CSV'}
            <input type="file" accept=".csv" ref={fileRef} onChange={handleImport} style={{ display:'none' }} />
          </label>
        </div>
      </div>

      <div style={{ padding:'10px 14px', background:C.red+'11', border:`1px solid ${C.red}44`, borderRadius:6, marginBottom:14, fontSize:12, color:C.textSec }}>
        <strong style={{ color:C.red }}>B1 BLOCKER</strong> — <code style={{ color:C.cyan }}>finance_cost = null</code> until at least one facility has a complete repayment schedule.
        Use EMI derivation where possible: provide rate + principal + tenor → click View Schedule to validate before approving.
      </div>

      {msg && <div style={{ padding:'8px 12px', borderRadius:4, marginBottom:10, fontSize:12, background:msg.type==='error'?C.red+'22':C.green+'22', color:msg.type==='error'?C.red:C.green }}>{msg.text}</div>}

      {/* Schedule modal */}
      {schedule && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.8)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:16, overflowY:'auto' }}>
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:20, maxWidth:720, width:'100%', maxHeight:'80vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:14 }}>
              <div>
                <div style={{ fontSize:14, fontWeight:700, color:C.text }}>Derived Repayment Schedule</div>
                <div style={{ fontSize:11, color:C.textMut }}>Facility: {schedule.facility_id}</div>
              </div>
              <button onClick={()=>setSchedule(null)} style={{ ...sty.btn(), padding:'3px 8px' }}>✕</button>
            </div>
            <div style={{ display:'flex', gap:10, marginBottom:14, flexWrap:'wrap' }}>
              {[
                { label:'Opening Principal', val:fmtL(schedule.data.opening_principal) },
                { label:'Annual Rate', val:`${schedule.data.rate_annual}%` },
                { label:'EMI', val:fmtL(schedule.data.emi) },
                { label:'Tenor', val:`${schedule.data.tenor_months} months` },
              ].map(k=>(
                <div key={k.label} style={{ ...sty.card, marginBottom:0, padding:'8px 12px', fontSize:11 }}>
                  <div style={{ color:C.textMut, fontSize:10 }}>{k.label}</div>
                  <div style={{ fontFamily:'monospace', color:C.cyan }}>{k.val}</div>
                </div>
              ))}
              <div style={{ ...sty.card, marginBottom:0, padding:'8px 12px', fontSize:11, borderColor:schedule.data.validation?.valid?C.green:C.red }}>
                <div style={{ color:C.textMut, fontSize:10 }}>Validation</div>
                <div style={{ color:schedule.data.validation?.valid?C.green:C.red, fontWeight:600 }}>{schedule.data.validation?.valid?'✓ VALID':'✗ MISMATCH'}</div>
                <div style={{ color:C.textMut, fontSize:10 }}>Δ = ₹{schedule.data.validation?.difference}L</div>
              </div>
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead><tr>{['Month','Opening (₹L)','Interest (₹L)','Principal (₹L)','Closing (₹L)'].map(h=><th key={h} style={sty.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {(schedule.data.schedule||[]).slice(0,60).map((row,i)=>(
                    <tr key={i}>
                      <td style={{ ...sty.td, fontFamily:'monospace', fontSize:11 }}>{row.month}</td>
                      <td style={{ ...sty.td, fontFamily:'monospace', fontSize:11, color:C.cyan }}>{row.opening}</td>
                      <td style={{ ...sty.td, fontFamily:'monospace', fontSize:11, color:C.yellow }}>{row.interest}</td>
                      <td style={{ ...sty.td, fontFamily:'monospace', fontSize:11, color:C.red }}>{row.principal}</td>
                      <td style={{ ...sty.td, fontFamily:'monospace', fontSize:11, color:C.green }}>{row.closing}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Facilities table */}
      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead>
            <tr>
              <th style={sty.th}>Facility</th>
              <th style={sty.th}>Lender</th>
              <th style={{ ...sty.th, background:C.cyan+'0A' }}>Principal (₹L)</th>
              <th style={sty.th}>Rate %</th>
              <th style={sty.th}>Start Date</th>
              <th style={sty.th}>Tenor (mo)</th>
              <th style={{ ...sty.th, background:C.accent+'12' }}>Derived EMI</th>
              <th style={sty.th}>Schedule</th>
              <th style={sty.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {facs.map(f=>{
              const fid  = f.facility_id;
              const dirty = Object.keys(editing[fid]||{}).length>0;
              const inp = (field, w=90, type='number') => (
                <input type={type} value={getE(fid, field, f[field]||'')} onChange={e=>setE(fid, field, e.target.value)}
                  style={{ ...sty.input, width:w, borderColor:(f.missing_fields||[]).includes(field)?C.yellow+'88':C.border }} />
              );
              return (
                <tr key={fid} style={{ background:f.is_complete?C.green+'05':(f.missing_fields||[]).length>0?C.yellow+'04':'transparent' }}>
                  <td style={{ ...sty.td, fontSize:11, fontWeight:500 }}>
                    {f.label}<br/>
                    <span style={{ fontSize:9, color:C.textMut, fontFamily:'monospace' }}>{fid}</span>
                    {(f.missing_fields||[]).length>0 && <div style={{ fontSize:9, color:C.yellow }}>{f.missing_fields.join(', ')}</div>}
                  </td>
                  <td style={{ ...sty.td, fontSize:11, color:C.textMut }}>{f.lender||'—'}</td>
                  <td style={{ ...sty.td, background:C.cyan+'06', fontFamily:'monospace', fontSize:11, color:C.cyan }}>{f.opening_principal||'—'}</td>
                  <td style={sty.td}>{inp('rate', 65)}</td>
                  <td style={sty.td}>{inp('repayment_start_date', 120, 'date')}</td>
                  <td style={sty.td}>{inp('tenor_months', 60)}</td>
                  <td style={{ ...sty.td, background:C.accent+'08', fontFamily:'monospace', fontSize:11, color:f.emi_lakh!=null?C.accent:C.textMut }}>
                    {f.emi_lakh!=null?fmtL(f.emi_lakh):'—'}
                    {f.emi_source && <span style={{ fontSize:9, color:C.textMut, display:'block' }}>{f.emi_source}</span>}
                  </td>
                  <td style={sty.td}>
                    <span style={sty.badge(f.schedule_provided?C.green:C.red)}>
                      {f.schedule_provided?`${f.schedule_months}mo`:'MISSING'}
                    </span>
                  </td>
                  <td style={{ ...sty.td, minWidth:150 }}>
                    <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                      {dirty && <button onClick={()=>handleSave(fid)} disabled={saving[fid]} style={{ ...sty.btn('primary'), fontSize:10, padding:'2px 6px' }}>{saving[fid]?'…':'Save'}</button>}
                      {f.can_derive && <button onClick={()=>viewSchedule(fid)} style={{ ...sty.btn('success'), fontSize:10, padding:'2px 6px' }}>View Schedule</button>}
                    </div>
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

// ─── SECTION: Readiness ───────────────────────────────────────────────────────
function ReadinessDashboard() {
  const [data,setData]=useState(null);
  const load=useCallback(async()=>{ try{setData(await apiFetch('/fpa/step15/completion'));}catch(e){console.error(e);} },[]);
  useEffect(()=>{load();},[load]);
  if(!data) return <div style={{ padding:20, color:C.textMut }}>Loading…</div>;
  const ready = !data.gate?.includes('BLOCKED') && data.critical_blockers===0;
  return (
    <div>
      <div style={{ background:ready?C.green+'11':C.red+'11', border:`2px solid ${ready?C.green:C.red}`, borderRadius:8, padding:'16px 20px', marginBottom:20 }}>
        <div style={{ fontSize:17, fontWeight:700, color:ready?C.green:C.red, fontFamily:'monospace' }}>{ready?'✅ READY FOR CFO UAT':'⛔ NOT READY — Management Data Required'}</div>
        <div style={{ fontSize:12, color:C.textSec, marginTop:4 }}>
          Readiness: <strong>{data.overall_pct}%</strong> &nbsp;|&nbsp; Blockers: <strong style={{ color:data.critical_blockers>0?C.red:C.green }}>{data.critical_blockers}</strong> &nbsp;|&nbsp; Modules: <strong>{data.completed_modules}/{data.total_modules}</strong>
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))', gap:12, marginBottom:20 }}>
        {(data.modules||[]).map(m=>(
          <div key={m.id} style={{ ...sty.card, marginBottom:0 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
              <span style={{ fontSize:12, fontWeight:600 }}>{m.module}</span>
              <span style={sty.badge(statusColor(m.status))}>{m.status}</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:C.textMut, marginBottom:4 }}>
              <span>{m.total!=null?`${m.populated}/${m.total}`:m.populated}</span>
              <span style={{ color:m.pct===100?C.green:m.pct>0?C.yellow:C.red }}>{m.pct}%</span>
            </div>
            <ProgressBar pct={m.pct} color={m.pct===100?C.green:m.pct>0?C.yellow:C.red} height={6} />
            {m.blocker && <div style={{ fontSize:10, color:C.red, marginTop:4 }}>⛔ {m.action}</div>}
          </div>
        ))}
      </div>
      <div style={{ padding:'14px 18px', background:C.surfaceEl, border:`1px solid ${C.border}`, borderRadius:8, fontSize:12, color:C.textSec }}>
        <strong style={{ color:C.yellow, fontFamily:'monospace' }}>⚠ STOP CONDITION</strong> — STOP after Step 15. DO NOT start CFO UAT. DO NOT migrate to production.<br/>
        Next step: <strong style={{ color:C.text }}>STEP 16 — CFO/MANAGEMENT UAT, FINAL MODEL SIGN-OFF & CUTOVER READINESS</strong>
      </div>
    </div>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function Step15Tab() {
  const [subTab, setSubTab] = useState('action_center');
  return (
    <div style={{ color:C.text }}>
      <div style={{ marginBottom:20, paddingBottom:14, borderBottom:`1px solid ${C.border}` }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:12, flexWrap:'wrap' }}>
          <span style={{ fontSize:18, fontWeight:700 }}>Step 15B — Management Review & Approval</span>
          <span style={sty.badge(C.yellow)}>MANAGEMENT APPROVAL REQUIRED</span>
          <span style={{ fontSize:11, color:C.textMut }}>650 revenue mappings · 32 debt facilities · OBS · Cost assumptions</span>
        </div>
        <div style={{ fontSize:13, color:C.textSec, marginTop:4 }}>REFERENCE DATA AVAILABLE → PROPOSE → MANAGEMENT APPROVE → MODEL ACTIVE</div>
      </div>
      <div style={{ display:'flex', gap:4, marginBottom:20, flexWrap:'wrap', borderBottom:`1px solid ${C.border}`, paddingBottom:10 }}>
        {SUB_TABS.map(t=>(
          <button key={t.id} onClick={()=>setSubTab(t.id)}
            style={{ ...sty.btn(subTab===t.id?'primary':'def'), fontSize:12, background:subTab===t.id?C.accent:C.surfaceEl }}>
            {t.label}
          </button>
        ))}
      </div>
      {subTab==='action_center' && <ManagementActionCenter />}
      {subTab==='rev_review'    && <RevenueReviewSection />}
      {subTab==='completion'    && <CompletionSection />}
      {subTab==='action_req'    && <ActionRequiredSection />}
      {subTab==='client_rev'    && <ClientRevenueSection />}
      {subTab==='branch_cap'    && <BranchCapacitySection />}
      {subTab==='cost'          && <CostUtilitiesSection />}
      {subTab==='debt'          && <DebtFinanceSection />}
      {subTab==='obs'           && <OBSApprovalSection />}
      {subTab==='readiness'     && <ReadinessDashboard />}
    </div>
  );
}
