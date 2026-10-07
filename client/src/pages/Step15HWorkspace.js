import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api';

const C = {
  bg:'#F9F9F9', bg2:'#FFFFFF', bg3:'#F2F2F2', border:'#DFE7E3',
  text:'#18191B', text2:'#5D6C7B', text3:'#9BA8B0',
  red:'#DC2626', redBg:'#FEF2F2', redBorder:'#FECACA',
  amber:'#B45309', amberBg:'#FFFBEB', amberBorder:'#FDE68A',
  green:'#15803D', greenBg:'#F0FDF4', greenBorder:'#BBF7D0',
  blue:'#1C4942', blueBg:'#EAF4EF', blueBorder:'#A7C4BC',
  purple:'#7C3AED', purpleBg:'#F5F3FF', purpleBorder:'#DDD6FE',
};
const r2 = v => Math.round((v||0)*100)/100;
const fmt = v => v==null?'—':`₹${r2(v).toLocaleString('en-IN')}L`;
const btn = (bg,bd,tx='#fff') => ({
  padding:'6px 14px', borderRadius:6, border:`1px solid ${bd}`, background:bg,
  color:tx, fontSize:12, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap',
});
const inp = { background:C.bg3, border:`1px solid ${C.border}`, borderRadius:6,
  color:C.text, fontSize:12, padding:'5px 8px', width:'100%', boxSizing:'border-box' };
const tbl = { width:'100%', borderCollapse:'collapse', fontSize:12 };
const th = { padding:'7px 10px', background:C.bg3, color:C.text2, textAlign:'left',
  borderBottom:`1px solid ${C.border}`, fontWeight:600, whiteSpace:'nowrap' };
const td = { padding:'6px 10px', borderBottom:`1px solid ${C.bg3}`, color:C.text, verticalAlign:'middle' };

function SH({ children }) {
  return <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:10, paddingBottom:6,
    borderBottom:`1px solid ${C.border}` }}>{children}</div>;
}
function Pill({ s }) {
  const map = {
    NOT_STARTED:   [C.bg3, C.text3],
    IN_PROGRESS:   [C.amberBg, C.amber],
    SUBMITTED:     [C.blueBg, C.blue],
    UNDER_REVIEW:  [C.purpleBg, C.purple],
    APPROVED:      [C.greenBg, C.green],
    REJECTED:      [C.redBg, C.red],
    SAVED:         [C.bg3, C.text2],
    GREEN:         [C.greenBg, C.green],
    RED:           [C.redBg, C.red],
    AMBER:         [C.amberBg, C.amber],
  };
  const [bg, tx] = map[s]||[C.bg3, C.text2];
  return <span style={{ padding:'2px 8px', borderRadius:4, background:bg, color:tx,
    fontSize:11, fontWeight:700 }}>{s?.replace(/_/g,' ')}</span>;
}
function Card({ label, value, sub, color }) {
  return (
    <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:8, padding:'12px 14px', minWidth:120 }}>
      <div style={{ fontSize:11, color:C.text2, marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:700, color:color||C.text }}>{value}</div>
      {sub && <div style={{ fontSize:10, color:C.text3, marginTop:2 }}>{sub}</div>}
    </div>
  );
}

// Shared module status header with submit/approve actions
function ModuleHeader({ module, label, state, onRefresh }) {
  const [comment, setComment] = useState('');
  const [by, setBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const act = async (action) => {
    if (!by) { setMsg('Enter your name first.'); return; }
    if (!comment) { setMsg('Comment is mandatory.'); return; }
    setBusy(true); setMsg('');
    try {
      if (action === 'SUBMIT') {
        await apiFetch(`/api/fpa/step15/step15h/module/submit`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ module, submitted_by:by, comment }),
        });
      } else {
        await apiFetch(`/api/fpa/step15/step15h/module/approve`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ module, action, approved_by:by, comment }),
        });
      }
      setMsg(`✓ ${action} recorded.`);
      onRefresh?.();
    } catch(e) { setMsg('Error: ' + e.message); }
    setBusy(false);
  };

  const s = state?.status || 'NOT_STARTED';
  return (
    <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:8, padding:'12px 16px', marginBottom:14 }}>
      <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap', marginBottom:10 }}>
        <span style={{ fontWeight:700, color:C.text }}>{label}</span>
        <Pill s={s} />
        {state?.owner && <span style={{ fontSize:11, color:C.text2 }}>Owner: {state.owner}</span>}
        {state?.reviewer && <span style={{ fontSize:11, color:C.text2 }}>Reviewer: {state.reviewer}</span>}
        {state?.due_date && <span style={{ fontSize:11, color:C.amber }}>Due: {state.due_date}</span>}
        {state?.last_updated && <span style={{ fontSize:11, color:C.text3 }}>Updated: {state.last_updated?.slice(0,10)}</span>}
      </div>
      {state?.approval_comment && <div style={{ fontSize:11, color:C.text2, marginBottom:8, fontStyle:'italic' }}>Last comment: "{state.approval_comment}"</div>}
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
        <input placeholder="Your name (required)" value={by} onChange={e=>setBy(e.target.value)}
          style={{ ...inp, width:160 }} />
        <input placeholder="Comment (mandatory)" value={comment} onChange={e=>setComment(e.target.value)}
          style={{ ...inp, flex:1, minWidth:200 }} />
        {['NOT_STARTED','IN_PROGRESS','SAVED','REJECTED'].includes(s) &&
          <button style={btn(C.blueBg,C.blueBorder)} onClick={()=>act('SUBMIT')} disabled={busy}>Submit for Review</button>}
        {['SUBMITTED','UNDER_REVIEW'].includes(s) && <>
          <button style={btn(C.greenBg,C.greenBorder)} onClick={()=>act('APPROVE')} disabled={busy}>✓ Approve (CFO)</button>
          <button style={btn(C.redBg,C.redBorder)} onClick={()=>act('REJECT')} disabled={busy}>✗ Reject</button>
          <button style={btn(C.bg3,C.border,C.text2)} onClick={()=>act('RETURN')} disabled={busy}>↩ Return</button>
        </>}
        {msg && <span style={{ fontSize:11, color:msg.startsWith('✓')?C.green:C.red }}>{msg}</span>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 1 — DASHBOARD
// ═══════════════════════════════════════════════
function DashboardTab() {
  const [data, setData] = useState(null);
  const [assigning, setAssigning] = useState(null);
  const [assign, setAssign] = useState({ owner:'', reviewer:'', due_date:'' });
  const [msg, setMsg] = useState('');

  const load = () => apiFetch('/api/fpa/step15/step15h/dashboard').then(setData).catch(()=>{});
  useEffect(()=>{ load(); },[]);

  const saveAssign = async (mod) => {
    await apiFetch('/api/fpa/step15/step15h/module/assign', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ module:mod, ...assign }),
    });
    setAssigning(null); load();
    setMsg(`Assigned ${mod}.`); setTimeout(()=>setMsg(''),3000);
  };

  if (!data) return <div style={{ color:C.text2, padding:20 }}>Loading dashboard…</div>;

  const mods = data.modules || [];
  const approved = mods.filter(m=>m.status==='APPROVED').length;
  const pending  = mods.filter(m=>['SUBMITTED','UNDER_REVIEW'].includes(m.status)).length;
  const overall  = data.overall_pct || 0;

  return (
    <div>
      <SH>Management Input Dashboard — All Modules</SH>
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:16 }}>
        <Card label="Overall Completion" value={`${overall}%`} color={overall>=95?C.green:overall>=50?C.amber:C.red} />
        <Card label="Modules Approved" value={`${approved}/10`} color={approved>=10?C.green:C.text} />
        <Card label="Awaiting CFO Review" value={pending} color={pending>0?C.amber:C.green} />
        <Card label="Not Started" value={mods.filter(m=>m.status==='NOT_STARTED').length} color={C.text2} />
      </div>

      {msg && <div style={{ color:C.green, fontSize:12, marginBottom:8 }}>{msg}</div>}

      <div style={{ overflowX:'auto' }}>
        <table style={tbl}>
          <thead><tr>
            {['#','Module','Owner Role','Total','Auto','Input Req','Submitted','Approved','Completion','Status','Owner','Reviewer','Due','Actions'].map(h=>
              <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {mods.map(m => (
              <React.Fragment key={m.id}>
                <tr>
                  <td style={td}>{m.priority}</td>
                  <td style={{ ...td, fontWeight:600 }}>{m.label}</td>
                  <td style={{ ...td, color:C.text2 }}>{m.owner_role}</td>
                  <td style={td}>{m.total}</td>
                  <td style={{ ...td, color:C.text2 }}>{m.auto_populated}</td>
                  <td style={{ ...td, color:m.input_required>0?C.amber:C.text2 }}>{m.input_required}</td>
                  <td style={{ ...td, color:m.submitted>0?C.blue:C.text2 }}>{m.submitted}</td>
                  <td style={{ ...td, color:m.approved>0?C.green:C.text2 }}>{m.approved}</td>
                  <td style={td}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <div style={{ flex:1, height:6, background:C.bg3, borderRadius:3, minWidth:60, overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${m.completion_pct}%`, background:m.completion_pct>=95?C.green:m.completion_pct>=50?C.amber:C.red, borderRadius:3 }} />
                      </div>
                      <span style={{ fontSize:11, color:C.text2, minWidth:28 }}>{m.completion_pct}%</span>
                    </div>
                  </td>
                  <td style={td}><Pill s={m.status} /></td>
                  <td style={{ ...td, color:C.text2 }}>{m.owner||'—'}</td>
                  <td style={{ ...td, color:C.text2 }}>{m.reviewer||'—'}</td>
                  <td style={{ ...td, color:m.due_date?C.amber:C.text3 }}>{m.due_date||'—'}</td>
                  <td style={td}>
                    <button style={{ ...btn(C.bg3,C.border,C.text2), fontSize:10, padding:'3px 8px' }}
                      onClick={()=>{ setAssigning(m.id); setAssign({ owner:m.owner||'', reviewer:m.reviewer||'', due_date:m.due_date||'' }); }}>
                      Assign
                    </button>
                  </td>
                </tr>
                {assigning===m.id && (
                  <tr><td colSpan={14} style={{ background:C.bg3, padding:'10px 14px' }}>
                    <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                      <input placeholder="Owner name" value={assign.owner} onChange={e=>setAssign(a=>({...a,owner:e.target.value}))} style={{ ...inp, width:150 }} />
                      <input placeholder="Reviewer name" value={assign.reviewer} onChange={e=>setAssign(a=>({...a,reviewer:e.target.value}))} style={{ ...inp, width:150 }} />
                      <input type="date" value={assign.due_date} onChange={e=>setAssign(a=>({...a,due_date:e.target.value}))} style={{ ...inp, width:140 }} />
                      <button style={btn(C.blueBg,C.blueBorder)} onClick={()=>saveAssign(m.id)}>Save</button>
                      <button style={btn(C.bg3,C.border,C.text3)} onClick={()=>setAssigning(null)}>Cancel</button>
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize:11, color:C.text3, marginTop:10 }}>
        PROPOSED ≠ APPROVED · REFERENCE DATA ≠ MANAGEMENT ASSUMPTION · GREEN gate ≠ Baseline V1 approved
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 2 — REVENUE INPUT WORKSPACE
// ═══════════════════════════════════════════════
const QUEUES = [
  { id:'Q1', label:'Q1 · Strong Recurring', desc:'Group B — 3+ months consistent billing', color:C.green },
  { id:'Q2', label:'Q2 · Historical Proxy',  desc:'Group C — limited/variable history',     color:C.amber },
  { id:'Q3', label:'Q3 · Unsupported / Input Required', desc:'Group D — no invoice evidence', color:C.red },
  { id:'Q4', label:'Q4 · Material Exceptions', desc:'MRR gap >20% or flagged records',      color:C.purple },
  { id:'Q5', label:'Q5 · Expiry <12 Months',  desc:'Contracts expiring within 12 months',   color:C.blue },
];

function RevenueTab() {
  const [g1, setG1]       = useState(null);
  const [state, setState] = useState(null);
  const [queue, setQueue] = useState('Q3');
  const [search, setSearch]= useState('');
  const [upStatus, setUpStatus] = useState(null);
  const [upMsg, setUpMsg]  = useState('');
  const [editing, setEditing] = useState(null); // mapping_id being edited
  const [form, setForm]    = useState({});
  const [savMsg, setSavMsg] = useState('');

  const load = () => {
    apiFetch('/api/fpa/step15/step15g1/approval-groups').then(setG1).catch(()=>{});
    apiFetch('/api/fpa/step15/step15h/module-state/revenue').then(d=>setState(d.state)).catch(()=>{});
  };
  useEffect(()=>{ load(); },[]);

  const download = async (tmpl, grp) => {
    const token = localStorage.getItem('da_token')||'';
    const BASE = ``;
    const resp = await fetch(`${BASE}/api/fpa/step15/step15g1/export-template?template=${tmpl}&group=${grp}`,
      { headers: token ? { Authorization:`Bearer ${token}` } : {} });
    if (!resp.ok) { alert('Download failed'); return; }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition')||'';
    const fname = cd.match(/filename="([^"]+)"/)?.[1]||`Template${tmpl}_${grp}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setUpStatus('parsing'); setUpMsg('Reading CSV…');
    try {
      const text = await file.text();
      const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l=>l.trim());
      if (lines.length < 2) { setUpStatus('error'); setUpMsg('Empty file.'); return; }
      const parseRow = row => {
        const f=[]; let cur='',inQ=false;
        for (let i=0;i<row.length;i++) {
          const ch=row[i];
          if(ch==='"'&&!inQ){inQ=true;}
          else if(ch==='"'&&inQ&&row[i+1]==='"'){cur+='"';i++;}
          else if(ch==='"'&&inQ){inQ=false;}
          else if(ch===','&&!inQ){f.push(cur.trim());cur='';}
          else{cur+=ch;}
        }
        f.push(cur.trim()); return f;
      };
      const headers = parseRow(lines[0].replace(/^﻿/,''));
      const rows = lines.slice(1).map(l=>{
        const vals=parseRow(l); const obj={};
        headers.forEach((h,i)=>{ obj[h.trim()]=(vals[i]||'').trim(); });
        return obj;
      }).filter(r=>r.mapping_id);
      if (!rows.length) { setUpStatus('error'); setUpMsg('No valid rows (mapping_id required).'); return; }
      setUpStatus('uploading'); setUpMsg(`Uploading ${rows.length} rows…`);
      const res = await apiFetch('/api/fpa/step15/step15g1/import-contracts', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({rows}),
      });
      setUpStatus('ok');
      setUpMsg(`✓ ${res.created} new, ${res.updated} updated, ${res.skipped} skipped. Total in store: ${res.total_in_store}`);
      load();
    } catch(e){ setUpStatus('error'); setUpMsg('Upload error: '+(e.message||e)); }
    e.target.value='';
  };

  const saveRecord = async () => {
    if (!editing) return;
    try {
      await apiFetch('/api/fpa/step15/step15h/record/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ module:'revenue', record_id:editing, data:form, entered_by:form._entered_by||'MAKER', source:'MANAGEMENT_INPUT' }),
      });
      setSavMsg('✓ Saved'); setEditing(null); setTimeout(()=>setSavMsg(''),3000);
    } catch(e){ setSavMsg('Error: '+e.message); }
  };

  const getRows = () => {
    if (!g1) return [];
    const results = g1.results||[];
    const today = new Date();
    const rows = queue==='Q1' ? results.filter(r=>r.group==='B')
      : queue==='Q2' ? results.filter(r=>r.group==='C')
      : queue==='Q3' ? results.filter(r=>r.group==='D')
      : queue==='Q4' ? results.filter(r=>r.mrr_gap_pct>20||(r.flags&&r.flags.length>0))
      : results; // Q5 — filter by contract expiry (unknown here, show all)
    const s = search.toLowerCase();
    return s ? rows.filter(r=>(r.client_id||'').toLowerCase().includes(s)||(r.branch_id||'').toLowerCase().includes(s)) : rows;
  };

  const rows = getRows();

  return (
    <div>
      <ModuleHeader module="revenue" label="Revenue / Client Contracts" state={state} onRefresh={load} />

      {/* Download/Upload toolbar */}
      <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:8, padding:'12px 16px', marginBottom:14 }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.text, marginBottom:8 }}>
          Bulk Input: Step 1 — Download template · Step 2 — Fill in Excel · Step 3 — Upload
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
          <button style={btn(C.bg3,C.border,C.text)} onClick={()=>download('A','D')}>📥 Template A — Group D (Unsupported)</button>
          <button style={btn(C.bg3,C.border,C.text)} onClick={()=>download('A','ALL')}>📥 Template A — All 650 mappings</button>
          <button style={btn(C.bg3,C.border,C.text)} onClick={()=>download('B','ALL')}>📥 Template B — Groups B+C Approval</button>
        </div>
        <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <label style={{ ...btn(C.blueBg,C.blueBorder), cursor:'pointer', userSelect:'none' }}>
            📤 Upload Filled CSV
            <input type="file" accept=".csv,text/csv" onChange={handleUpload} style={{ display:'none' }} />
          </label>
          {upStatus && (
            <span style={{ fontSize:11, color: upStatus==='ok'?C.green: upStatus==='error'?C.red:C.amber }}>
              {upStatus==='parsing'?'⏳':upStatus==='uploading'?'⬆':''}  {upMsg}
            </span>
          )}
        </div>
        {savMsg && <div style={{ fontSize:11, color:C.green, marginTop:6 }}>{savMsg}</div>}
      </div>

      {/* Approval queues */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:12 }}>
        {QUEUES.map(q => (
          <button key={q.id} onClick={()=>setQueue(q.id)}
            style={{ ...btn(queue===q.id?q.color+'22':C.bg3, queue===q.id?q.color:C.border, queue===q.id?q.color:C.text2),
              borderWidth:queue===q.id?2:1 }}>
            {q.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize:11, color:C.text3, marginBottom:10 }}>
        {QUEUES.find(q=>q.id===queue)?.desc} · {rows.length} records
        <input placeholder="Search client/branch…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{ ...inp, width:200, display:'inline-block', marginLeft:12 }} />
      </div>

      <div style={{ overflowX:'auto', maxHeight:480, overflowY:'auto' }}>
        <table style={tbl}>
          <thead><tr>
            {['Mapping ID','Client','Branch','Group','Source','MRR (Zoho) ₹L','Invoice MRR ₹L','Gap%','Flags','Action'].map(h=>(
              <th key={h} style={{ ...th, position:'sticky', top:0 }}>{h}</th>))}
          </tr></thead>
          <tbody>
            {rows.slice(0,200).map(r => (
              <React.Fragment key={r.mapping_id}>
                <tr>
                  <td style={{ ...td, fontFamily:'monospace', fontSize:11 }}>{r.mapping_id}</td>
                  <td style={td}>{r.client_id}</td>
                  <td style={td}>{r.branch_id}</td>
                  <td style={td}><Pill s={r.group==='B'?'APPROVED':r.group==='C'?'IN_PROGRESS':r.group==='D'?'NOT_STARTED':'SAVED'} /></td>
                  <td style={{ ...td, color:C.text2, fontSize:10 }}>{r.source_label}</td>
                  <td style={td}>{fmt(r.mapping_revenue_lakh)}</td>
                  <td style={{ ...td, color:C.text2 }}>{fmt(r.normalised_mrr_lakh)}</td>
                  <td style={{ ...td, color:Math.abs(r.mrr_gap_pct||0)>20?C.red:C.text2 }}>
                    {r.mrr_gap_pct!=null?`${r.mrr_gap_pct}%`:'—'}
                  </td>
                  <td style={{ ...td, color:C.amber, fontSize:10 }}>{(r.flags||[]).join(', ')||'—'}</td>
                  <td style={td}>
                    <button style={{ ...btn(C.bg3,C.border,C.text2), fontSize:10, padding:'3px 8px' }}
                      onClick={()=>{ setEditing(r.mapping_id); setForm({ client_id:r.client_id, branch_id:r.branch_id, _source_level:r.source_level }); }}>
                      Enter Contract
                    </button>
                  </td>
                </tr>
                {editing===r.mapping_id && (
                  <tr><td colSpan={10} style={{ background:C.bg3, padding:'12px 14px' }}>
                    <div style={{ fontSize:12, fontWeight:600, color:C.text, marginBottom:8 }}>Contract Input — {r.mapping_id}</div>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:8 }}>
                      {[
                        ['contract_type','Contract Type','text'],['contract_start_date','Start Date','date'],
                        ['contract_end_date','End Date','date'],['lockin_end_date','Lock-in End','date'],
                        ['notice_period_days','Notice Period (days)','number'],['contracted_seats','Contracted Seats','number'],
                        ['area_sqft','Area (sq ft)','number'],['rate_per_seat_inr','Rate/Seat (₹)','number'],
                        ['rate_per_sqft_inr','Rate/SqFt (₹)','number'],['fixed_monthly_revenue_inr','Fixed Monthly Rev (₹)','number'],
                        ['escalation_pct','Escalation %','number'],['escalation_effective_date','Escalation Date','date'],
                        ['security_deposit_inr','Security Deposit (₹)','number'],['billing_frequency','Billing Frequency','text'],
                        ['current_status','Status','text'],['renewal_assumption','Renewal Assumption','text'],
                      ].map(([key,label,type])=>(
                        <label key={key} style={{ display:'block' }}>
                          <div style={{ fontSize:10, color:C.text2, marginBottom:2 }}>{label}</div>
                          <input type={type} value={form[key]||''} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))}
                            style={inp} />
                        </label>
                      ))}
                      <label style={{ gridColumn:'1/-1' }}>
                        <div style={{ fontSize:10, color:C.text2, marginBottom:2 }}>Notes / Source Reference</div>
                        <input value={form.notes||''} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} style={inp} />
                      </label>
                      <label style={{ display:'block' }}>
                        <div style={{ fontSize:10, color:C.text2, marginBottom:2 }}>Entered By (your name)</div>
                        <input value={form._entered_by||''} onChange={e=>setForm(f=>({...f,_entered_by:e.target.value}))} style={inp} />
                      </label>
                    </div>
                    <div style={{ display:'flex', gap:8, marginTop:10 }}>
                      <button style={btn(C.greenBg,C.greenBorder)} onClick={saveRecord}>Save Record</button>
                      <button style={btn(C.bg3,C.border,C.text3)} onClick={()=>setEditing(null)}>Cancel</button>
                    </div>
                    <div style={{ fontSize:10, color:C.text3, marginTop:6 }}>
                      PROPOSED ≠ APPROVED · Data saved here is PROPOSED — requires CFO approval before use in model.
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length>200 && <div style={{ fontSize:11, color:C.text3, marginTop:6 }}>Showing first 200 of {rows.length} rows. Use search to filter.</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 3 — BRANCH CAPACITY
// ═══════════════════════════════════════════════
function CapacityTab() {
  const [branches, setBranches] = useState([]);
  const [state, setState] = useState(null);
  const [records, setRecords] = useState({});
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState('');

  useEffect(()=>{
    apiFetch('/api/fpa/step15/step15h/module-state/capacity').then(d=>{ setState(d.state); }).catch(()=>{});
    apiFetch('/api/fpa/branches').then(d=>{ setBranches((d.branches||[]).filter(b=>b.active!==false)); }).catch(()=>{});
  },[]);

  const save = async (bid) => {
    try {
      const res = await apiFetch('/api/fpa/step15/step15h/record/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ module:'capacity', record_id:bid, data:form, entered_by:form._by||'MAKER' }),
      });
      setRecords(r=>({...r,[bid]:res.record}));
      setMsg('✓ Saved'); setEditing(null); setTimeout(()=>setMsg(''),3000);
    } catch(e){ setMsg('Error: '+e.message); }
  };

  return (
    <div>
      <ModuleHeader module="capacity" label="Branch Capacity" state={state} onRefresh={()=>{}} />
      {msg && <div style={{ fontSize:11, color:C.green, marginBottom:8 }}>{msg}</div>}
      <div style={{ fontSize:11, color:C.text3, marginBottom:10 }}>
        Pre-populate from lease/master data. Enter or confirm capacity inputs per branch.
      </div>
      <div style={{ overflowX:'auto', maxHeight:520, overflowY:'auto' }}>
        <table style={tbl}>
          <thead><tr>
            {['Branch ID','Branch Name','Op. Status','Total Area (sqft)','Chargeable Area','Total Seats','Saleable Seats','Current Occupied','Target Occ %','Comments','Status','Action'].map(h=>(
              <th key={h} style={{ ...th, position:'sticky', top:0 }}>{h}</th>))}
          </tr></thead>
          <tbody>
            {branches.map(b=>{
              const rec = records[b.branch_id];
              const d = rec?.data||{};
              return (
                <React.Fragment key={b.branch_id}>
                  <tr>
                    <td style={{ ...td, fontFamily:'monospace', fontSize:11 }}>{b.branch_id}</td>
                    <td style={{ ...td, fontWeight:600 }}>{b.branch_name||b.branch_id}</td>
                    <td style={td}>{d.op_status||b.operational_status||'—'}</td>
                    <td style={td}>{d.total_area_sqft||b.total_area_sqft||'—'}</td>
                    <td style={td}>{d.chargeable_area||b.chargeable_area||'—'}</td>
                    <td style={td}>{d.total_seats||b.total_seats||'—'}</td>
                    <td style={td}>{d.saleable_seats||'—'}</td>
                    <td style={td}>{d.current_occupied||'—'}</td>
                    <td style={td}>{d.target_occ_pct||'—'}</td>
                    <td style={{ ...td, color:C.text2, fontSize:10 }}>{d.comments||'—'}</td>
                    <td style={td}><Pill s={rec?.status||'NOT_STARTED'} /></td>
                    <td style={td}>
                      <button style={{ ...btn(C.bg3,C.border,C.text2), fontSize:10, padding:'3px 8px' }}
                        onClick={()=>{ setEditing(b.branch_id); setForm({ op_status:d.op_status||b.operational_status||'OPERATIONAL', total_area_sqft:d.total_area_sqft||b.total_area_sqft||'', chargeable_area:d.chargeable_area||b.chargeable_area||'', total_seats:d.total_seats||b.total_seats||'', saleable_seats:d.saleable_seats||'', current_occupied:d.current_occupied||'', target_occ_pct:d.target_occ_pct||'', ramp_months:d.ramp_months||'', comments:d.comments||'' }); }}>
                        Edit
                      </button>
                    </td>
                  </tr>
                  {editing===b.branch_id && (
                    <tr><td colSpan={12} style={{ background:C.bg3, padding:'12px 14px' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:8 }}>
                        {[['op_status','Operational Status'],['total_area_sqft','Total Area (sqft)'],['chargeable_area','Chargeable Area'],['total_seats','Total Seats'],['saleable_seats','Saleable Seats'],['current_occupied','Current Occupied'],['target_occ_pct','Target Occupancy %'],['ramp_months','Ramp-up (months)'],['opening_date','Opening Date'],['comments','Comments']].map(([k,l])=>(
                          <label key={k}>
                            <div style={{ fontSize:10, color:C.text2, marginBottom:2 }}>{l}</div>
                            <input value={form[k]||''} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} style={inp} />
                          </label>
                        ))}
                        <label><div style={{ fontSize:10, color:C.text2, marginBottom:2 }}>Entered By</div>
                          <input value={form._by||''} onChange={e=>setForm(f=>({...f,_by:e.target.value}))} style={inp} />
                        </label>
                      </div>
                      <div style={{ display:'flex', gap:8, marginTop:10 }}>
                        <button style={btn(C.greenBg,C.greenBorder)} onClick={()=>save(b.branch_id)}>Save</button>
                        <button style={btn(C.bg3,C.border,C.text3)} onClick={()=>setEditing(null)}>Cancel</button>
                      </div>
                    </td></tr>
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

// ═══════════════════════════════════════════════
// TAB 4 — COST MASTER
// ═══════════════════════════════════════════════
const COST_CATS = ['Rent','CAM','Electricity','Utilities','Housekeeping','Security','Facility Management','Internet','R&M','Employee Cost','Sales & Marketing','Other OpEx'];
const COST_METHODS = ['FIXED','PER SQ FT','PER SEAT','% REVENUE','HISTORICAL RUN RATE','MANUAL'];

function CostTab() {
  const [branches, setBranches] = useState([]);
  const [state, setState] = useState(null);
  const [branch, setBranch] = useState('');
  const [rows, setRows] = useState({});
  const [msg, setMsg] = useState('');

  useEffect(()=>{
    apiFetch('/api/fpa/branches').then(d=>setBranches((d.branches||[]).filter(b=>b.active!==false))).catch(()=>{});
    apiFetch('/api/fpa/step15/step15h/module-state/cost').then(d=>setState(d.state)).catch(()=>{});
  },[]);

  useEffect(()=>{
    if (!branch) return;
    const init={};
    COST_CATS.forEach(cat=>{ init[cat]={ method:'MANUAL', base_amount:'', driver:'', escalation_pct:'', effective_from:'', effective_to:'', comments:'' }; });
    setRows(init);
  },[branch]);

  const saveAll = async (enteredBy) => {
    if (!branch) { setMsg('Select a branch first.'); return; }
    const data = { branch_id:branch, cost_lines:rows };
    try {
      await apiFetch('/api/fpa/step15/step15h/record/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ module:'cost', record_id:branch, data, entered_by:enteredBy||'MAKER' }),
      });
      setMsg('✓ Cost master saved for '+branch); setTimeout(()=>setMsg(''),4000);
    } catch(e){ setMsg('Error: '+e.message); }
  };

  return (
    <div>
      <ModuleHeader module="cost" label="Cost Master" state={state} onRefresh={()=>{}} />
      <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:12, flexWrap:'wrap' }}>
        <select value={branch} onChange={e=>setBranch(e.target.value)} style={{ ...inp, width:220 }}>
          <option value="">— Select Branch —</option>
          {branches.map(b=><option key={b.branch_id} value={b.branch_id}>{b.branch_name||b.branch_id}</option>)}
        </select>
        {msg && <span style={{ fontSize:11, color:msg.startsWith('✓')?C.green:C.red }}>{msg}</span>}
      </div>
      {branch && (
        <div style={{ overflowX:'auto' }}>
          <table style={tbl}>
            <thead><tr>
              <th style={th}>Cost Category</th>
              <th style={th}>Method</th>
              <th style={th}>Base Amount (₹)</th>
              <th style={th}>Driver</th>
              <th style={th}>Escalation %</th>
              <th style={th}>Effective From</th>
              <th style={th}>Effective To</th>
              <th style={th}>Comments / Source</th>
            </tr></thead>
            <tbody>
              {COST_CATS.map(cat=>{
                const r = rows[cat]||{};
                const set = (k,v) => setRows(prev=>({...prev,[cat]:{...prev[cat],[k]:v}}));
                return (
                  <tr key={cat}>
                    <td style={{ ...td, fontWeight:600, color:C.text }}>{cat}</td>
                    <td style={td}>
                      <select value={r.method||'MANUAL'} onChange={e=>set('method',e.target.value)} style={{ ...inp, width:160 }}>
                        {COST_METHODS.map(m=><option key={m} value={m}>{m}</option>)}
                      </select>
                    </td>
                    <td style={td}><input type="number" value={r.base_amount||''} onChange={e=>set('base_amount',e.target.value)} style={{ ...inp, width:110 }} /></td>
                    <td style={td}><input value={r.driver||''} onChange={e=>set('driver',e.target.value)} style={{ ...inp, width:100 }} /></td>
                    <td style={td}><input type="number" value={r.escalation_pct||''} onChange={e=>set('escalation_pct',e.target.value)} style={{ ...inp, width:80 }} /></td>
                    <td style={td}><input type="date" value={r.effective_from||''} onChange={e=>set('effective_from',e.target.value)} style={{ ...inp, width:130 }} /></td>
                    <td style={td}><input type="date" value={r.effective_to||''} onChange={e=>set('effective_to',e.target.value)} style={{ ...inp, width:130 }} /></td>
                    <td style={td}><input value={r.comments||''} onChange={e=>set('comments',e.target.value)} style={{ ...inp, width:160 }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop:10, display:'flex', gap:8 }}>
            <button style={btn(C.greenBg,C.greenBorder)} onClick={()=>saveAll('MAKER')}>Save Cost Master</button>
            <span style={{ fontSize:10, color:C.text3 }}>PROPOSED only — requires CFO approval. "Accept Historical Run Rate" creates PROPOSED, never APPROVED automatically.</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 5 — OPENING BALANCE SHEET
// ═══════════════════════════════════════════════
function OBSTab() {
  const [obs, setObs] = useState(null);
  const [state, setState] = useState(null);

  useEffect(()=>{
    apiFetch('/api/fpa/step15/step15h/module-state/obs').then(d=>setState(d.state)).catch(()=>{});
    apiFetch('/api/fpa/step15/obs-summary').then(setObs).catch(()=>{});
  },[]);

  return (
    <div>
      <ModuleHeader module="obs" label="Opening Balance Sheet" state={state} onRefresh={()=>{}} />
      <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:8, padding:'16px 18px', marginBottom:14 }}>
        <SH>OBS Reconciliation — Audited FY 2025-26</SH>
        {obs ? (
          <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
            {[['Total Assets',obs.total_assets_lakh],['Total Liabilities',obs.total_liabilities_lakh],['Equity',obs.equity_lakh],['Difference',obs.difference_lakh]].map(([l,v])=>(
              <div key={l} style={{ background:C.bg3, borderRadius:6, padding:'10px 14px', minWidth:120 }}>
                <div style={{ fontSize:10, color:C.text2 }}>{l}</div>
                <div style={{ fontSize:18, fontWeight:700, color:Math.abs(v||0)>0.05?C.red:C.text }}>{fmt(v)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color:C.text2, fontSize:12, padding:'12px 0' }}>
            OBS data not loaded. Fetch from Step 15D or Step 15F.
          </div>
        )}
        <div style={{ marginTop:12, fontSize:11, color:C.text3 }}>
          OBS must be reviewed by CFO and CA, then submitted for formal approval using the controls above.
          Difference ≈ ₹0.01L is acceptable; any larger gap requires explanation before CFO approval.
        </div>
      </div>
      <div style={{ background:C.amberBg, border:`1px solid ${C.amberBorder}`, borderRadius:6, padding:'10px 14px', fontSize:12, color:C.amber }}>
        ⚠ OBS approval is a Baseline V1 gate requirement. Submit only after audited figures are confirmed. CFO comment is mandatory.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 6 — IND AS 116 / IBR
// ═══════════════════════════════════════════════
const IBR_BUCKETS = [
  { id:'lt5',  label:'< 5 years',    suggested:9.5  },
  { id:'5to10',label:'5 – 10 years', suggested:10.0 },
  { id:'10to15',label:'10 – 15 years',suggested:10.5 },
  { id:'gt15', label:'> 15 years',   suggested:11.0 },
];

function IBRTab() {
  const [state, setState] = useState(null);
  const [ibr, setIbr] = useState(()=>Object.fromEntries(IBR_BUCKETS.map(b=>[b.id,{ ref_rate:'', adjustment:'', final_ibr:b.suggested, n_leases:'', lease_liability_lakh:'', rou_impact_lakh:'', fin_cost_lakh:'', source:'RBI Repo + Spread', comments:'' }])));
  const [msg, setMsg] = useState('');

  useEffect(()=>{ apiFetch('/api/fpa/step15/step15h/module-state/ibr').then(d=>setState(d.state)).catch(()=>{}); },[]);

  const save = async () => {
    try {
      await apiFetch('/api/fpa/step15/step15h/record/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ module:'ibr', record_id:'ibr_matrix', data:{ buckets:ibr }, entered_by:'CA' }),
      });
      setMsg('✓ IBR matrix saved as PROPOSED. Requires CA/CFO approval.');
      setTimeout(()=>setMsg(''),5000);
    } catch(e){ setMsg('Error: '+e.message); }
  };

  return (
    <div>
      <ModuleHeader module="ibr" label="Ind AS 116 / IBR Decision Matrix" state={state} onRefresh={()=>{}} />
      <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:8, padding:'12px 16px', marginBottom:14 }}>
        <div style={{ fontSize:11, color:C.amber, marginBottom:8 }}>
          ⚠ DO NOT auto-assign IBR. Each rate requires explicit CA/CFO review and approval. This form creates PROPOSED only.
        </div>
        <div style={{ overflowX:'auto' }}>
          <table style={tbl}>
            <thead><tr>
              {['Tenure Bucket','Suggested IBR %','Reference Rate %','Adjustment %','Final Proposed IBR %','# Leases','Lease Liability ₹L','ROU Impact ₹L','Fin. Cost ₹L','Source','Comments'].map(h=><th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {IBR_BUCKETS.map(b=>{
                const r = ibr[b.id]||{};
                const set=(k,v)=>setIbr(prev=>({...prev,[b.id]:{...prev[b.id],[k]:v}}));
                return (
                  <tr key={b.id}>
                    <td style={{ ...td, fontWeight:600 }}>{b.label}</td>
                    <td style={{ ...td, color:C.text2 }}>{b.suggested}%</td>
                    <td style={td}><input type="number" step="0.1" value={r.ref_rate||''} onChange={e=>set('ref_rate',e.target.value)} style={{ ...inp, width:80 }} /></td>
                    <td style={td}><input type="number" step="0.1" value={r.adjustment||''} onChange={e=>set('adjustment',e.target.value)} style={{ ...inp, width:70 }} /></td>
                    <td style={{ ...td, color:C.amber }}><input type="number" step="0.1" value={r.final_ibr||b.suggested} onChange={e=>set('final_ibr',e.target.value)} style={{ ...inp, width:80, color:C.amber }} /></td>
                    <td style={td}><input type="number" value={r.n_leases||''} onChange={e=>set('n_leases',e.target.value)} style={{ ...inp, width:70 }} /></td>
                    <td style={td}><input type="number" value={r.lease_liability_lakh||''} onChange={e=>set('lease_liability_lakh',e.target.value)} style={{ ...inp, width:90 }} /></td>
                    <td style={td}><input type="number" value={r.rou_impact_lakh||''} onChange={e=>set('rou_impact_lakh',e.target.value)} style={{ ...inp, width:90 }} /></td>
                    <td style={td}><input type="number" value={r.fin_cost_lakh||''} onChange={e=>set('fin_cost_lakh',e.target.value)} style={{ ...inp, width:90 }} /></td>
                    <td style={td}><input value={r.source||'RBI Repo + Spread'} onChange={e=>set('source',e.target.value)} style={{ ...inp, width:150 }} /></td>
                    <td style={td}><input value={r.comments||''} onChange={e=>set('comments',e.target.value)} style={{ ...inp, width:180 }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display:'flex', gap:8, marginTop:10, alignItems:'center' }}>
          <button style={btn(C.amberBg,C.amberBorder,C.amber)} onClick={save}>Save IBR Matrix (PROPOSED)</button>
          {msg && <span style={{ fontSize:11, color:C.green }}>{msg}</span>}
        </div>
      </div>
      <div style={{ background:C.amberBg, border:`1px solid ${C.amberBorder}`, borderRadius:6, padding:'10px 14px', fontSize:11, color:C.amber }}>
        ⚠ IBR approval is a Baseline V1 gate requirement. Submit via controls above and await CFO/CA approval before proceeding.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 7 — DEBT SCHEDULE
// ═══════════════════════════════════════════════
function DebtTab() {
  const [state, setState] = useState(null);
  const [facilities, setFacilities] = useState(() =>
    Array.from({length:32},(_,i)=>({ id:`FAC-${String(i+1).padStart(2,'0')}`, lender:'', facility_type:'', opening_principal:'', interest_rate:'', rate_type:'FLOATING', emi:'', repayment_start:'', maturity:'', tenor_months:'', current_noncurrent:'CURRENT', comments:'' }))
  );
  const [msg, setMsg] = useState('');

  useEffect(()=>{ apiFetch('/api/fpa/step15/step15h/module-state/debt').then(d=>setState(d.state)).catch(()=>{}); },[]);

  const setF = (i,k,v) => setFacilities(prev=>prev.map((f,idx)=>idx===i?{...f,[k]:v}:f));

  const saveAll = async () => {
    try {
      await apiFetch('/api/fpa/step15/step15h/record/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ module:'debt', record_id:'debt_schedule', data:{ facilities }, entered_by:'TREASURY' }),
      });
      setMsg('✓ Debt schedule saved. Submit for CFO review above.'); setTimeout(()=>setMsg(''),4000);
    } catch(e){ setMsg('Error: '+e.message); }
  };

  return (
    <div>
      <ModuleHeader module="debt" label="Debt Schedule" state={state} onRefresh={()=>{}} />
      {msg && <div style={{ fontSize:11, color:C.green, marginBottom:8 }}>{msg}</div>}
      <div style={{ overflowX:'auto', maxHeight:520, overflowY:'auto' }}>
        <table style={tbl}>
          <thead><tr>
            {['ID','Lender','Facility Type','Opening Principal (₹L)','Interest Rate %','Rate Type','EMI (₹L)','Repayment Start','Maturity','Tenor (months)','Curr/Non-curr','Comments'].map(h=>(
              <th key={h} style={{ ...th, position:'sticky', top:0 }}>{h}</th>))}
          </tr></thead>
          <tbody>
            {facilities.map((f,i)=>(
              <tr key={f.id}>
                <td style={{ ...td, fontFamily:'monospace', fontSize:11, color:C.text3 }}>{f.id}</td>
                {[['lender',120],['facility_type',110]].map(([k,w])=>(
                  <td key={k} style={td}><input value={f[k]} onChange={e=>setF(i,k,e.target.value)} style={{ ...inp, width:w }} /></td>
                ))}
                {[['opening_principal',100],['interest_rate',80]].map(([k,w])=>(
                  <td key={k} style={td}><input type="number" step="0.01" value={f[k]} onChange={e=>setF(i,k,e.target.value)} style={{ ...inp, width:w }} /></td>
                ))}
                <td style={td}>
                  <select value={f.rate_type} onChange={e=>setF(i,'rate_type',e.target.value)} style={{ ...inp, width:100 }}>
                    <option>FLOATING</option><option>FIXED</option>
                  </select>
                </td>
                <td style={td}><input type="number" value={f.emi} onChange={e=>setF(i,'emi',e.target.value)} style={{ ...inp, width:90 }} /></td>
                {[['repayment_start',130],['maturity',130]].map(([k,w])=>(
                  <td key={k} style={td}><input type="date" value={f[k]} onChange={e=>setF(i,k,e.target.value)} style={{ ...inp, width:w }} /></td>
                ))}
                <td style={td}><input type="number" value={f.tenor_months} onChange={e=>setF(i,'tenor_months',e.target.value)} style={{ ...inp, width:80 }} /></td>
                <td style={td}>
                  <select value={f.current_noncurrent} onChange={e=>setF(i,'current_noncurrent',e.target.value)} style={{ ...inp, width:100 }}>
                    <option>CURRENT</option><option>NON-CURRENT</option>
                  </select>
                </td>
                <td style={td}><input value={f.comments} onChange={e=>setF(i,'comments',e.target.value)} style={{ ...inp, width:150 }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop:10 }}>
        <button style={btn(C.greenBg,C.greenBorder)} onClick={saveAll}>Save All 32 Facilities</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 8 — GL MAPPING
// ═══════════════════════════════════════════════
const GL_ACTIONS = ['CONFIRM','CHANGE','N/A'];
function GLTab() {
  const [state, setState] = useState(null);
  const [gl, setGL] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(()=>{
    apiFetch('/api/fpa/step15/step15h/module-state/gl').then(d=>setState(d.state)).catch(()=>{});
    apiFetch('/api/fpa/step15/gl-unresolved').then(setGL).catch(()=>{
      setGL({ items:[
        { gl_id:'GL001', zoho_gl:'Rent Expense', existing_mapping:'Occupancy Cost', proposed_mapping:'Rent & Lease', value_lakh:320, materiality:'HIGH', decision:'', comments:'' },
        { gl_id:'GL002', zoho_gl:'Management Fee', existing_mapping:'Other Income', proposed_mapping:'', value_lakh:85, materiality:'MEDIUM', decision:'', comments:'' },
        { gl_id:'GL003', zoho_gl:'Nodal Charges', existing_mapping:'Misc Expense', proposed_mapping:'', value_lakh:42, materiality:'MEDIUM', decision:'', comments:'' },
      ]});
    });
  },[]);

  const setItem = (id,k,v) => setGL(g=>({ ...g, items:g.items.map(i=>i.gl_id===id?{...i,[k]:v}:i) }));

  const saveAll = async () => {
    try {
      await apiFetch('/api/fpa/step15/step15h/record/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ module:'gl', record_id:'gl_mappings', data:{ items:gl?.items }, entered_by:'FINANCE' }),
      });
      setMsg('✓ GL decisions saved.'); setTimeout(()=>setMsg(''),3000);
    } catch(e){ setMsg('Error: '+e.message); }
  };

  return (
    <div>
      <ModuleHeader module="gl" label="GL Mapping Resolution" state={state} onRefresh={()=>{}} />
      {msg && <div style={{ fontSize:11, color:C.green, marginBottom:8 }}>{msg}</div>}
      <div style={{ fontSize:11, color:C.text2, marginBottom:10 }}>Unresolved and material GL codes shown first. CONFIRM / CHANGE / N/A for each.</div>
      <div style={{ overflowX:'auto' }}>
        <table style={tbl}>
          <thead><tr>
            {['GL ID','Zoho GL Account','Existing Mapping','Proposed Mapping','₹ Value (L)','Materiality','Management Decision','Comments'].map(h=>(
              <th key={h} style={th}>{h}</th>))}
          </tr></thead>
          <tbody>
            {(gl?.items||[]).map(item=>(
              <tr key={item.gl_id}>
                <td style={{ ...td, fontFamily:'monospace', fontSize:11 }}>{item.gl_id}</td>
                <td style={td}>{item.zoho_gl}</td>
                <td style={{ ...td, color:C.text2 }}>{item.existing_mapping||'—'}</td>
                <td style={td}><input value={item.proposed_mapping||''} onChange={e=>setItem(item.gl_id,'proposed_mapping',e.target.value)} style={{ ...inp, width:160 }} /></td>
                <td style={{ ...td, color:item.value_lakh>100?C.amber:C.text }}>{fmt(item.value_lakh)}</td>
                <td style={td}><Pill s={item.materiality==='HIGH'?'REJECTED':item.materiality==='MEDIUM'?'SUBMITTED':'SAVED'} /></td>
                <td style={td}>
                  <select value={item.decision||''} onChange={e=>setItem(item.gl_id,'decision',e.target.value)}
                    style={{ ...inp, width:110, color:item.decision==='CONFIRM'?C.green:item.decision==='N/A'?C.text3:C.amber }}>
                    <option value="">— Select —</option>
                    {GL_ACTIONS.map(a=><option key={a} value={a}>{a}</option>)}
                  </select>
                </td>
                <td style={td}><input value={item.comments||''} onChange={e=>setItem(item.gl_id,'comments',e.target.value)} style={{ ...inp, width:200 }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop:10 }}>
        <button style={btn(C.greenBg,C.greenBorder)} onClick={saveAll}>Save GL Decisions</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 9 — FAR / CWIP
// ═══════════════════════════════════════════════
const FAR_CATS = ['Land & Building','Office Equipment','Furniture & Fixture','Computers & IT','Vehicles','Plant & Machinery','CWIP — Office Fit-out','CWIP — IT Infrastructure','CWIP — Other'];
const DEP_METHODS = ['SLM','WDV'];

function FARTab() {
  const [state, setState] = useState(null);
  const [rows, setRows] = useState(()=>Object.fromEntries(FAR_CATS.map(c=>[c,{ gross_block:'', accum_dep:'', net_block:'', useful_life:'', dep_method:'SLM', addition:'', cap_date:'', cwip:'', expected_cap_date:'', is_assumption:false, comments:'' }])));
  const [msg, setMsg] = useState('');

  useEffect(()=>{ apiFetch('/api/fpa/step15/step15h/module-state/far').then(d=>setState(d.state)).catch(()=>{}); },[]);
  const set=(cat,k,v)=>setRows(p=>({...p,[cat]:{...p[cat],[k]:v}}));

  const saveAll = async () => {
    try {
      await apiFetch('/api/fpa/step15/step15h/record/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ module:'far', record_id:'far_schedule', data:{ categories:rows }, entered_by:'FINANCE' }),
      });
      setMsg('✓ FAR saved.'); setTimeout(()=>setMsg(''),3000);
    } catch(e){ setMsg('Error: '+e.message); }
  };

  return (
    <div>
      <ModuleHeader module="far" label="Fixed Asset Register / CWIP" state={state} onRefresh={()=>{}} />
      {msg && <div style={{ fontSize:11, color:C.green, marginBottom:8 }}>{msg}</div>}
      <div style={{ fontSize:11, color:C.text3, marginBottom:10 }}>
        Category-level assumptions where individual asset data unavailable — label these as MANAGEMENT ASSUMPTION.
      </div>
      <div style={{ overflowX:'auto' }}>
        <table style={tbl}>
          <thead><tr>
            {['Category','Gross Block (₹L)','Acc. Dep (₹L)','Net Block (₹L)','Useful Life (yr)','Method','Addition (₹L)','Cap. Date','CWIP (₹L)','Exp. Cap. Date','Mgmt Assumption?','Comments'].map(h=>(
              <th key={h} style={th}>{h}</th>))}
          </tr></thead>
          <tbody>
            {FAR_CATS.map(cat=>{
              const r=rows[cat]||{};
              return (
                <tr key={cat} style={{ background:r.is_assumption?'#1a1506':'' }}>
                  <td style={{ ...td, fontWeight:600 }}>
                    {cat}
                    {r.is_assumption && <span style={{ fontSize:9, color:C.amber, marginLeft:6 }}>MGMT ASSUMPTION</span>}
                  </td>
                  {[['gross_block',90],['accum_dep',90],['net_block',90]].map(([k,w])=>(
                    <td key={k} style={td}><input type="number" value={r[k]||''} onChange={e=>set(cat,k,e.target.value)} style={{ ...inp, width:w }} /></td>
                  ))}
                  <td style={td}><input type="number" value={r.useful_life||''} onChange={e=>set(cat,'useful_life',e.target.value)} style={{ ...inp, width:60 }} /></td>
                  <td style={td}>
                    <select value={r.dep_method||'SLM'} onChange={e=>set(cat,'dep_method',e.target.value)} style={{ ...inp, width:65 }}>
                      {DEP_METHODS.map(m=><option key={m}>{m}</option>)}
                    </select>
                  </td>
                  <td style={td}><input type="number" value={r.addition||''} onChange={e=>set(cat,'addition',e.target.value)} style={{ ...inp, width:90 }} /></td>
                  <td style={td}><input type="date" value={r.cap_date||''} onChange={e=>set(cat,'cap_date',e.target.value)} style={{ ...inp, width:130 }} /></td>
                  <td style={td}><input type="number" value={r.cwip||''} onChange={e=>set(cat,'cwip',e.target.value)} style={{ ...inp, width:90 }} /></td>
                  <td style={td}><input type="date" value={r.expected_cap_date||''} onChange={e=>set(cat,'expected_cap_date',e.target.value)} style={{ ...inp, width:130 }} /></td>
                  <td style={td}>
                    <input type="checkbox" checked={r.is_assumption||false} onChange={e=>set(cat,'is_assumption',e.target.checked)} />
                  </td>
                  <td style={td}><input value={r.comments||''} onChange={e=>set(cat,'comments',e.target.value)} style={{ ...inp, width:160 }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop:10 }}>
        <button style={btn(C.greenBg,C.greenBorder)} onClick={saveAll}>Save FAR Schedule</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 10 — CFO CONTROL CENTER
// ═══════════════════════════════════════════════
function CFOQueueTab() {
  const [queue, setQueue] = useState(null);
  const [audit, setAudit] = useState(null);
  const [selMod, setSelMod] = useState(null);
  const [comment, setComment] = useState('');
  const [by, setBy] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => {
    apiFetch('/api/fpa/step15/step15h/cfo-queue').then(setQueue).catch(()=>{});
    apiFetch('/api/fpa/step15/step15h/audit?limit=50').then(setAudit).catch(()=>{});
  };
  useEffect(()=>{ load(); },[]);

  const act = async (module, action) => {
    if (!by) { setMsg('Enter your name (CFO / approver).'); return; }
    if (!comment) { setMsg('Comment is mandatory for all actions.'); return; }
    try {
      await apiFetch('/api/fpa/step15/step15h/module/approve', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ module, action, approved_by:by, comment }),
      });
      setMsg(`✓ ${action} applied to ${module}.`);
      setSelMod(null); setComment(''); load();
      setTimeout(()=>setMsg(''),4000);
    } catch(e){ setMsg('Error: '+e.message); }
  };

  return (
    <div>
      <SH>CFO Control Center — All Modules Awaiting Action</SH>
      <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:12, flexWrap:'wrap' }}>
        <input placeholder="CFO / Approver name" value={by} onChange={e=>setBy(e.target.value)} style={{ ...inp, width:200 }} />
        <input placeholder="Mandatory comment for all actions" value={comment} onChange={e=>setComment(e.target.value)} style={{ ...inp, flex:1, minWidth:250 }} />
        {msg && <span style={{ fontSize:11, color:msg.startsWith('✓')?C.green:C.red }}>{msg}</span>}
      </div>

      <div style={{ overflowX:'auto', marginBottom:24 }}>
        <table style={tbl}>
          <thead><tr>
            {['Module','Status','Submitted By','Submitted At','Owner','Due Date','Actions'].map(h=><th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {(queue?.queue||[]).length===0 && (
              <tr><td colSpan={7} style={{ ...td, color:C.text3, textAlign:'center', padding:'20px' }}>No modules submitted for approval yet.</td></tr>
            )}
            {(queue?.queue||[]).map(q=>(
              <tr key={q.module}>
                <td style={{ ...td, fontWeight:600 }}>{q.label}</td>
                <td style={td}><Pill s={q.status} /></td>
                <td style={td}>{q.submitted_by||'—'}</td>
                <td style={{ ...td, color:C.text2 }}>{q.submitted_at?.slice(0,16)||'—'}</td>
                <td style={td}>{q.owner||'—'}</td>
                <td style={{ ...td, color:q.due_date?C.amber:C.text3 }}>{q.due_date||'—'}</td>
                <td style={td}>
                  <div style={{ display:'flex', gap:4 }}>
                    {q.awaiting && <>
                      <button style={{ ...btn(C.greenBg,C.greenBorder), fontSize:10, padding:'3px 8px' }} onClick={()=>act(q.module,'APPROVE')}>✓ Approve</button>
                      <button style={{ ...btn(C.redBg,C.redBorder), fontSize:10, padding:'3px 8px' }} onClick={()=>act(q.module,'REJECT')}>✗ Reject</button>
                      <button style={{ ...btn(C.bg3,C.border,C.text2), fontSize:10, padding:'3px 8px' }} onClick={()=>act(q.module,'RETURN')}>↩ Return</button>
                    </>}
                    {q.status==='APPROVED' && <span style={{ color:C.green, fontSize:11 }}>✓ Approved</span>}
                    {q.status==='REJECTED' && <span style={{ color:C.red, fontSize:11 }}>✗ Rejected</span>}
                    {q.status==='NOT_STARTED' && <span style={{ color:C.text3, fontSize:11 }}>Not submitted</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SH>Audit Trail — Last 50 Actions</SH>
      <div style={{ overflowX:'auto', maxHeight:300, overflowY:'auto' }}>
        <table style={tbl}>
          <thead><tr>
            {['Timestamp','Action','Module','Record','By'].map(h=><th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {(audit?.audit||[]).map((a,i)=>(
              <tr key={i}>
                <td style={{ ...td, fontFamily:'monospace', fontSize:11 }}>{a.ts?.slice(0,19)}</td>
                <td style={td}><Pill s={a.action==='APPROVE'?'APPROVED':a.action==='REJECT'?'REJECTED':a.action==='RETURN'?'IN_PROGRESS':a.action==='SUBMIT'?'SUBMITTED':'SAVED'} /></td>
                <td style={td}>{a.module}</td>
                <td style={{ ...td, color:C.text2, fontSize:11 }}>{a.record_id||'—'}</td>
                <td style={td}>{a.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 11 — COMPLETION GATE
// ═══════════════════════════════════════════════
function GateTab() {
  const [gate, setGate] = useState(null);
  useEffect(()=>{ apiFetch('/api/fpa/step15/step15h/gate').then(setGate).catch(()=>{}); },[]);

  if (!gate) return <div style={{ color:C.text2, padding:20 }}>Loading gate status…</div>;

  const G = gate.gates||[];
  return (
    <div>
      <SH>Baseline V1 Completion Gate</SH>
      <div style={{ background: gate.all_green?C.greenBg:C.redBg, border:`1px solid ${gate.all_green?C.greenBorder:C.redBorder}`, borderRadius:8, padding:'14px 18px', marginBottom:16 }}>
        <div style={{ fontSize:14, fontWeight:700, color:gate.all_green?C.green:C.red, marginBottom:4 }}>
          {gate.all_green ? '✓ ALL GATES GREEN' : `⛔ ${gate.critical_blockers} CRITICAL BLOCKER(S) — BASELINE V1 LOCKED`}
        </div>
        <div style={{ fontSize:12, color:gate.all_green?C.green:C.text2 }}>{gate.message}</div>
        {gate.all_green && (
          <div style={{ fontSize:11, color:C.text3, marginTop:8 }}>
            GREEN gate ≠ Baseline V1 is approved. It means prerequisites EXIST to compute the draft. CFO must explicitly instruct computation. Do NOT proceed without CFO direction.
          </div>
        )}
      </div>

      {G.map(g=>(
        <div key={g.id} style={{ display:'flex', gap:12, alignItems:'center', background:C.bg2, border:`1px solid ${g.status==='GREEN'?C.greenBorder:g.status==='RED'?C.redBorder:C.amberBorder}`, borderRadius:8, padding:'12px 16px', marginBottom:8 }}>
          <div style={{ width:10, height:10, borderRadius:'50%', background:g.status==='GREEN'?C.green:g.status==='RED'?C.red:C.amber, flexShrink:0 }} />
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:600, color:C.text, fontSize:12 }}>{g.label} {g.critical&&<span style={{ fontSize:9, color:C.red, marginLeft:4 }}>CRITICAL</span>}</div>
            <div style={{ fontSize:11, color:C.text2 }}>{g.desc}</div>
          </div>
          <div style={{ textAlign:'right' }}>
            <Pill s={g.status} />
            <div style={{ fontSize:11, color:C.text2, marginTop:2 }}>{g.value}</div>
            <div style={{ fontSize:10, color:C.text3 }}>Target: {g.target}</div>
          </div>
        </div>
      ))}

      <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:8, padding:'12px 16px', marginTop:8 }}>
        <div style={{ fontSize:12, fontWeight:600, color:C.text, marginBottom:6 }}>Gate Requirements — All 7 must be GREEN</div>
        {[
          'G1 Revenue: ≥95% value-weighted revenue approved + all material exceptions resolved',
          'G2 Opening BS: Approved by CFO with mandatory comment',
          'G3 Ind AS 116 / IBR: IBR methodology approved by CA and CFO',
          'G4 Branch Capacity: All material active branches completed',
          'G5 Cost Master: All material active branches approved',
          'G6 Debt Schedule: All required forecast fields completed',
          'G7 GL Mapping: All material GL codes resolved',
        ].map((r,i)=><div key={i} style={{ fontSize:11, color:C.text2, marginBottom:2 }}>• {r}</div>)}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// TAB 12 — USER GUIDE
// ═══════════════════════════════════════════════
const GUIDE_SECTIONS = [
  { n:'1', t:'Who Enters Each Module',
    body:`• Revenue / Client Contracts: BD Team (Maker), CFO (Approver)
• Branch Capacity: Operations Head (Maker), CFO (Approver)
• Cost Master: Finance Manager (Maker), CFO (Approver)
• Opening Balance Sheet: Finance / CA (Maker), CFO (Final Approver)
• Ind AS 116 / IBR: CA (Maker), CFO (Final Approver)
• Debt Schedule: Treasury (Maker), CFO (Approver)
• GL Mapping: Finance Manager (Maker), CFO (Approver)
• Fixed Asset Register / CWIP: Finance Manager (Maker), CFO (Approver)
• Working Capital / Tax: Finance + Tax team (Maker), CFO (Approver)` },
  { n:'2', t:'How to Navigate This Workspace',
    body:`Use the tabs at the top: Dashboard → Overview of all 10 modules.
Each module tab has: (a) Module status header, (b) Input form or table, (c) Submit/Approve actions.
Always start at the Dashboard to see which modules are in progress vs. need input.` },
  { n:'3', t:'What the Fields Mean',
    body:`System Data (grey): Fetched from Zoho Books. Do NOT modify.
Management Input Required (white): You must fill these fields.
Optional (light blue): Provide if available; leave blank if not known.
Calculated (amber): Auto-computed from your inputs — do not overwrite.
PROPOSED (amber badge): Saved but not yet approved.
APPROVED (green badge): CFO-reviewed and locked.` },
  { n:'4', t:'Mandatory vs Optional Fields',
    body:`Revenue: contract_start_date, contract_end_date, fixed_monthly_revenue_inr OR rate_per_seat_inr+contracted_seats are MANDATORY for Group D.
Capacity: total_seats, total_area_sqft, current_occupied are MANDATORY.
Cost: Method and Base Amount are MANDATORY for each line.
OBS: No input required — submit existing figures for CFO sign-off.
IBR: final_ibr % and source are MANDATORY per tenure bucket.
Debt: lender, interest_rate, opening_principal are MANDATORY per facility.` },
  { n:'5', t:'Source Documents Required',
    body:`Revenue: Signed client contracts, rate confirmation emails, POs.
Capacity: Lease agreements, floor plans, seat counts from fit-out drawings.
Cost: Vendor agreements, utility bills, expense reports.
OBS: Audited balance sheet as at FY2025-26 close.
IBR: RBI repo rate / yield curve as at measurement date. CA letter.
Debt: Sanction letters, facility agreements, latest statements.
GL: Zoho COA export, prior year mapping decisions.
FAR: Asset register export, depreciation schedule.` },
  { n:'6', t:'How to Download and Fill Templates',
    body:`1. Go to the Revenue tab → click "📥 Template A — Group D" (for unsupported clients).
2. Open the downloaded CSV in Excel (do NOT open in Notepad).
3. Column headers show: SYSTEM DATA (don't edit), MANAGEMENT INPUT REQUIRED (fill these), OPTIONAL.
4. Fill in contract details for each client × branch row.
5. Save as CSV (keep UTF-8 encoding).
6. Return to the Revenue tab → click "📤 Upload Filled CSV".` },
  { n:'7', t:'How to Correct Upload Errors',
    body:`If the upload shows an error count, the import was partially rejected.
The error report shows: Row number, Client, Branch, Field, Error description, Required correction.
Fix the highlighted rows in Excel and re-upload ONLY the corrected rows (or the full file — duplicates are updated, not doubled).
Do NOT manually edit the mapping_id column — it is the system key.` },
  { n:'8', t:'How to Submit for Review',
    body:`Once you have filled all required fields for a module:
1. Enter your name in the "Your name" field in the module header.
2. Enter a brief comment (e.g. "All Group D contracts entered. Source: signed agreements.").
3. Click "Submit for Review".
The module status changes to SUBMITTED. The CFO Control Center (tab 10) will show it in the approval queue.` },
  { n:'9', t:'Reviewer Checks',
    body:`Reviewer (if assigned) should:
• Verify each entry against the source document.
• Check for outliers — unusually high or low rates, future-dated contracts.
• Check that revenue is not fabricated to fill gaps.
• Add comment and either recommend approval or return to Maker.
Reviewer CANNOT approve — only the CFO can approve.` },
  { n:'10', t:'CFO Approval Process',
    body:`1. Go to Tab 10 — CFO Control Center.
2. Enter your name and a mandatory comment for each decision.
3. Click Approve, Reject, or Return to Maker.
BULK APPROVAL: Only permitted when the same evidence/methodology applies to ALL records in that approval batch. Requires explicit confirmation. Never auto-approve.
PROPOSED ≠ APPROVED. Every module requires an explicit CFO decision before it is treated as approved.` },
  { n:'11', t:'How to Revise After Rejection',
    body:`If CFO rejects or returns a module:
1. The module status changes to REJECTED or IN_PROGRESS.
2. Read the CFO's comment — it explains what needs correction.
3. Fix the identified records.
4. Re-submit using the Submit for Review button.
5. The full audit trail is preserved — original values are not lost.` },
  { n:'12', t:'How Completion % is Calculated',
    body:`Completion % = Approved Records ÷ Total Required Records × 100.
For Revenue: VALUE-WEIGHTED — a ₹100L/month client counts more than a ₹1L/month client.
The Dashboard tab shows both record count % and value-weighted % where applicable.
Auto-populated records (Groups B+C with invoice evidence) count toward completion — but only after CFO approval, not automatically.` },
  { n:'13', t:'When Does Baseline V1 Become Available?',
    body:`Baseline V1 can ONLY be computed when ALL 7 gates are GREEN:
G1: Revenue ≥95% value-weighted approved + material exceptions resolved.
G2: Opening Balance Sheet approved by CFO.
G3: IBR approved by CA and CFO.
G4: Branch Capacity completed.
G5: Cost Master approved.
G6: Debt Schedule complete.
G7: GL Mapping — all material codes resolved.
Even after all gates are GREEN, Baseline V1 is NOT automatically computed or activated. CFO must explicitly instruct the computation. See Tab 11 — Completion Gate for live status.` },
  { n:'14', t:'What NOT to Do',
    body:`× DO NOT invent or estimate revenue to fill model gaps.
× DO NOT use 3M/6M averages as approved contracted revenue — they are REFERENCE data only.
× DO NOT approve your own entries (no self-approval).
× DO NOT export and modify Zoho actual revenue fields.
× DO NOT mark something as APPROVED in any field unless the CFO has explicitly approved it.
× DO NOT proceed to Step 16 / compute Baseline V1 without CFO instruction.
× DO NOT use "Other Adjustment" entries without a written explanation.
If in doubt, leave it blank and flag it in your submission comment.` },
  { n:'15', t:'Where to Get Help',
    body:`For technical issues: Contact the system admin (Dev Accelerator).
For accounting / classification queries: CA / Finance Manager.
For approval questions: CFO directly.
For missing Zoho data: Re-run the data sync from FP&A → Mgmt Closure → Sync Monitor.
Always document what you did in the Comments field — the audit trail is your protection.` },
];

function GuideTab() {
  const [open, setOpen] = useState(null);
  return (
    <div>
      <SH>Built-in User Guide — How to Complete FP&A Management Inputs</SH>
      <div style={{ fontSize:12, color:C.text2, marginBottom:12 }}>
        This guide is for CFO, Finance team, BD team, CA, and all management input owners. No technical knowledge required.
      </div>
      {GUIDE_SECTIONS.map(s=>(
        <div key={s.n} style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:8, marginBottom:6, overflow:'hidden' }}>
          <button style={{ width:'100%', background:'none', border:'none', cursor:'pointer', padding:'11px 16px', textAlign:'left', color:C.text, display:'flex', justifyContent:'space-between', alignItems:'center' }}
            onClick={()=>setOpen(open===s.n?null:s.n)}>
            <span style={{ fontWeight:600, fontSize:13 }}><span style={{ color:C.text3, marginRight:8 }}>{s.n}.</span>{s.t}</span>
            <span style={{ color:C.text3, fontSize:16 }}>{open===s.n?'▲':'▼'}</span>
          </button>
          {open===s.n && (
            <div style={{ padding:'0 16px 14px', borderTop:`1px solid ${C.border}` }}>
              <pre style={{ margin:'10px 0 0', fontFamily:'inherit', fontSize:12, color:C.text2, whiteSpace:'pre-wrap', lineHeight:1.7 }}>{s.body}</pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════
// MAIN WORKSPACE
// ═══════════════════════════════════════════════
const TABS = [
  { id:'dashboard', label:'📊 Dashboard' },
  { id:'revenue',   label:'💰 Revenue' },
  { id:'capacity',  label:'🏢 Capacity' },
  { id:'cost',      label:'💸 Cost' },
  { id:'obs',       label:'📈 Opening BS' },
  { id:'ibr',       label:'📐 IBR' },
  { id:'debt',      label:'🏦 Debt' },
  { id:'gl',        label:'🗂 GL Mapping' },
  { id:'far',       label:'⚙ FAR/CWIP' },
  { id:'cfo',       label:'✓ CFO Queue' },
  { id:'gate',      label:'🔒 Gate' },
  { id:'guide',     label:'📖 Guide' },
];

export default function Step15HWorkspace() {
  const [tab, setTab] = useState('dashboard');

  return (
    <div style={{ background:C.bg, minHeight:'100vh', color:C.text, fontFamily:'system-ui,sans-serif', fontSize:14 }}>
      {/* Header */}
      <div style={{ background:C.bg2, borderBottom:`1px solid ${C.border}`, padding:'14px 24px' }}>
        <div style={{ fontSize:11, color:C.text3, marginBottom:2 }}>FP&A — Step 15H</div>
        <div style={{ fontSize:18, fontWeight:700, color:C.text }}>Management Input Operating Workflow</div>
        <div style={{ fontSize:12, color:C.text2, marginTop:2 }}>
          Central workspace for all management inputs required to compute Baseline V1 · STOP after 15H · Do NOT proceed to Step 16
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ background:C.bg2, borderBottom:`1px solid ${C.border}`, padding:'0 16px', display:'flex', gap:2, overflowX:'auto' }}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{ background:'none', border:'none', borderBottom:tab===t.id?`2px solid ${C.blue}`:'2px solid transparent', padding:'10px 14px', color:tab===t.id?C.blue:C.text2, fontSize:12, fontWeight:tab===t.id?700:400, cursor:'pointer', whiteSpace:'nowrap' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding:'20px 24px', maxWidth:1400, margin:'0 auto' }}>
        {tab==='dashboard' && <DashboardTab />}
        {tab==='revenue'   && <RevenueTab />}
        {tab==='capacity'  && <CapacityTab />}
        {tab==='cost'      && <CostTab />}
        {tab==='obs'       && <OBSTab />}
        {tab==='ibr'       && <IBRTab />}
        {tab==='debt'      && <DebtTab />}
        {tab==='gl'        && <GLTab />}
        {tab==='far'       && <FARTab />}
        {tab==='cfo'       && <CFOQueueTab />}
        {tab==='gate'      && <GateTab />}
        {tab==='guide'     && <GuideTab />}
      </div>
    </div>
  );
}
