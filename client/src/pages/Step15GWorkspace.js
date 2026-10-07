import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api';

// â”€â”€â”€ Design tokens â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const C = {
  bg:'#F9F9F9', bg2:'#FFFFFF', bg3:'#F2F2F2', border:'#DFE7E3',
  text:'#18191B', text2:'#5D6C7B', text3:'#9BA8B0',
  red:'#DC2626', redBg:'#FEF2F2', redBorder:'#FECACA',
  amber:'#B45309', amberBg:'#FFFBEB', amberBorder:'#FDE68A',
  green:'#15803D', greenBg:'#F0FDF4', greenBorder:'#BBF7D0',
  blue:'#1C4942', blueBg:'#EAF4EF', blueBorder:'#A7C4BC',
  purple:'#7C3AED', purpleBg:'#F5F3FF', purpleBorder:'#DDD6FE',
};
const fmtL = v => v == null ? 'â€”' : `â‚¹${Number(v).toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2})}L`;
const fmtN = v => v == null ? 'â€”' : Number(v).toLocaleString('en-IN');
const pct  = v => v == null ? 'â€”' : `${Number(v).toFixed(1)}%`;

function pill(label, color='grey') {
  const s = {
    red:   {bg:C.redBg,    border:C.redBorder,    text:C.red},
    amber: {bg:C.amberBg,  border:C.amberBorder,  text:C.amber},
    green: {bg:C.greenBg,  border:C.greenBorder,  text:C.green},
    blue:  {bg:C.blueBg,   border:C.blueBorder,   text:C.blue},
    purple:{bg:C.purpleBg, border:C.purpleBorder, text:C.purple},
    grey:  {bg:C.bg3,      border:C.border,        text:C.text2},
  }[color] || {bg:C.bg3, border:C.border, text:C.text2};
  return <span style={{display:'inline-block',padding:'2px 7px',borderRadius:3,fontSize:10,fontWeight:700,letterSpacing:'0.04em',whiteSpace:'nowrap',background:s.bg,border:`1px solid ${s.border}`,color:s.text}}>{label}</span>;
}

function StatCard({label, value, sub, color}) {
  const c = {red:C.red,amber:C.amber,green:C.green,blue:C.blue,purple:C.purple}[color]||C.text;
  return (
    <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:6,padding:'14px 16px'}}>
      <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.07em',textTransform:'uppercase',color:C.text3,marginBottom:4}}>{label}</div>
      <div style={{fontSize:22,fontWeight:700,fontFamily:'monospace',color:c,fontVariantNumeric:'tabular-nums'}}>{value}</div>
      {sub && <div style={{fontSize:11,color:C.text2,marginTop:2}}>{sub}</div>}
    </div>
  );
}

function InfoBox({children, variant='blue'}) {
  const s = {red:{bg:C.redBg,border:C.redBorder,c:C.red},amber:{bg:C.amberBg,border:C.amberBorder,c:C.amber},green:{bg:C.greenBg,border:C.greenBorder,c:C.green}}[variant]||{bg:C.blueBg,border:C.blueBorder,c:C.text2};
  return <div style={{background:s.bg,border:`1px solid ${s.border}`,borderRadius:6,padding:'11px 15px',fontSize:12,color:s.c,lineHeight:1.65,marginBottom:10}}>{children}</div>;
}

function SectionHead({tag, title}) {
  return (
    <div style={{display:'flex',alignItems:'baseline',gap:10,borderBottom:`1px solid ${C.border}`,paddingBottom:8,marginBottom:16}}>
      {tag && <span style={{fontSize:9,fontWeight:700,letterSpacing:'0.11em',color:C.text3,fontFamily:'monospace',textTransform:'uppercase'}}>{tag}</span>}
      <span style={{fontSize:15,fontWeight:700,color:C.text}}>{title}</span>
    </div>
  );
}

const TH = {padding:'7px 10px',fontSize:9,fontWeight:700,letterSpacing:'0.08em',textTransform:'uppercase',color:'#4a5a78',whiteSpace:'nowrap',textAlign:'left',borderBottom:`1px solid #252e44`,background:'#1c2436'};
const TD = {padding:'7px 10px',color:'#e2e8f4',verticalAlign:'top',borderBottom:`1px solid #1c2436`};

// â”€â”€â”€ Tabs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TABS = [
  {id:'overview',    label:'Overview'},
  {id:'contractrev', label:'âš¡ Contract Rev 15G.1'},
  {id:'integrity',  label:'Data Integrity'},
  {id:'revenue',    label:'Revenue Analysis'},
  {id:'cost',       label:'Cost Analysis'},
  {id:'obs',        label:'Opening BS'},
  {id:'capacity',   label:'Capacity'},
  {id:'ibr',        label:'Ind AS 116'},
  {id:'debt',       label:'Debt'},
  {id:'gl',         label:'GL Mapping'},
  {id:'quickwins',  label:'CFO Quick Wins'},
  {id:'simulator',  label:'Readiness Sim'},
];

// â”€â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function Step15GWorkspace() {
  const [tab, setTab]       = useState('overview');
  const [state, setState]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg]       = useState(null);

  const showMsg = (m, ok) => { setMsg({text:m,ok}); setTimeout(()=>setMsg(null),5000); };
  const loadState = useCallback(async () => {
    setLoading(true);
    try { const d = await apiFetch('/api/fpa/step15/step15g/state'); setState(d); }
    catch(e) { showMsg(e.message, false); }
    finally { setLoading(false); }
  }, []);
  useEffect(()=>{loadState();},[loadState]);

  const api = async (path, method='GET', body) => {
    try {
      const d = await apiFetch(path, {method, body:body?JSON.stringify(body):undefined, headers:body?{'Content-Type':'application/json'}:undefined});
      showMsg(d.message||d.ok||'Done', true);
      await loadState();
      return d;
    } catch(e) { showMsg(e.message,false); return null; }
  };

  return (
    <div style={{background:C.bg,minHeight:'100vh',color:C.text,fontFamily:'system-ui,sans-serif'}}>
      {/* Header */}
      <div style={{background:C.bg2,borderBottom:`1px solid ${C.border}`,padding:'14px 24px'}}>
        <div style={{display:'flex',alignItems:'center',gap:16,flexWrap:'wrap'}}>
          <div>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',color:C.text3,fontFamily:'monospace'}}>Dev Accelerator Ltd Â· Step 15G</div>
            <div style={{fontSize:18,fontWeight:700,color:C.text}}>Assisted Management Closure &amp; Exception-Based Approval</div>
          </div>
          {state && (
            <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:10}}>
              {pill(`GATE: ${state.gate}`, state.gate==='GREEN'?'green':state.gate==='AMBER'?'amber':'red')}
              {pill(`${state.hard_blockers} blockers`, state.hard_blockers===0?'green':'red')}
              <button onClick={loadState} style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:4,color:C.text2,padding:'5px 10px',fontSize:11,cursor:'pointer'}}>â†»</button>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {msg && <div style={{background:msg.ok?C.greenBg:C.redBg,border:`1px solid ${msg.ok?C.greenBorder:C.redBorder}`,color:msg.ok?C.green:C.red,padding:'8px 24px',fontSize:12}}>{msg.text}</div>}

      {/* Tabs */}
      <div style={{display:'flex',gap:0,borderBottom:`1px solid ${C.border}`,overflowX:'auto',background:C.bg2}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{background:'none',border:'none',borderBottom:tab===t.id?`2px solid ${C.blue}`:'2px solid transparent',color:tab===t.id?C.blue:C.text2,padding:'10px 14px',fontSize:12,fontWeight:600,cursor:'pointer',whiteSpace:'nowrap'}}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{padding:'24px 28px',maxWidth:1200}}>
        {loading && <div style={{color:C.text2,fontSize:13}}>Loadingâ€¦</div>}
        {!loading && tab==='overview'    && <OverviewTab    s={state} />}
        {!loading && tab==='contractrev' && <ContractRevTab api={api} />}
        {!loading && tab==='integrity'   && <IntegrityTab   api={api} />}
        {!loading && tab==='revenue'    && <RevenueTab    api={api} />}
        {!loading && tab==='cost'       && <CostTab       api={api} />}
        {!loading && tab==='obs'        && <OBSTab        api={api} />}
        {!loading && tab==='capacity'   && <CapacityTab   api={api} />}
        {!loading && tab==='ibr'        && <IBRTab        api={api} />}
        {!loading && tab==='debt'       && <DebtTab       api={api} />}
        {!loading && tab==='gl'         && <GLTab         api={api} />}
        {!loading && tab==='quickwins'  && <QuickWinsTab  api={api} />}
        {!loading && tab==='simulator'  && <SimulatorTab  api={api} />}
      </div>
    </div>
  );
}

// â”€â”€â”€ Overview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function OverviewTab({s}) {
  if (!s) return null;
  return (
    <div>
      <div style={{background:s.gate==='GREEN'?C.greenBg:s.gate==='AMBER'?C.amberBg:C.redBg,border:`2px solid ${s.gate==='GREEN'?C.greenBorder:s.gate==='AMBER'?C.amberBorder:C.redBorder}`,borderRadius:8,padding:'16px 20px',marginBottom:20}}>
        <div style={{fontFamily:'monospace',fontSize:16,fontWeight:800,color:s.gate==='GREEN'?C.green:s.gate==='AMBER'?C.amber:C.red}}>STEP 15G â€” GATE: {s.gate} â€” {s.hard_blockers} HARD BLOCKER{s.hard_blockers!==1?'S':''} ACTIVE</div>
        <div style={{marginTop:6,fontSize:12,color:C.text2}}>Step 15G: Analytical validation complete. All proposals reviewed programmatically. Management review queue available per tab.</div>
      </div>

      <InfoBox variant="red">
        <strong>NO AUTO-APPROVAL.</strong> Step 15G classifies proposals as RECOMMENDED or EXCEPTION based on analytical criteria. RECOMMENDED status is not approval. No assumption may move from PROPOSED â†’ APPROVED without explicit management confirmation in the CFO Approval Center (Step 15F tabs).
      </InfoBox>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(165px,1fr))',gap:10,marginBottom:20}}>
        <StatCard label="Gate"         value={s.gate}                                       color={s.gate==='GREEN'?'green':s.gate==='AMBER'?'amber':'red'} sub={`${s.hard_blockers} hard blockers`}/>
        <StatCard label="Revenue"      value={`${s.revenue?.coverage_pct||0}%`}             color={(s.revenue?.coverage_pct||0)>=95?'green':'red'} sub={`${s.revenue?.approved||0}/${s.revenue?.total} approved`}/>
        <StatCard label="Cost"         value={`${s.cost?.approved||0}/${s.cost?.proposals}`} color={(s.cost?.approved||0)>0?'amber':'red'} sub="branches approved"/>
        <StatCard label="Opening BS"   value={s.obs?.status==='approved'?'APPROVED':'PENDING'} color={s.obs?.status==='approved'?'green':'red'}/>
        <StatCard label="IBR"          value={s.lease?.ibr_set?'SET':'NOT SET'}              color={s.lease?.ibr_set?'green':'red'} sub={`${s.lease?.total} leases`}/>
        <StatCard label="Audit Entries" value={s.audit_entries||0} sub="all approvals logged"/>
      </div>

      <div style={{marginTop:10}}>
        <InfoBox>
          <strong>Step 15G Analytical Work Completed:</strong><br/>
          â€¢ Data integrity check across all modules (Revenue, Cost, Lease, GL, OBS)<br/>
          â€¢ Revenue: 650 mappings reviewed â€” all flagged INSUFFICIENT_HISTORY (1 month only). No mapping qualifies for auto-RECOMMENDED. Exception queue built by â‚¹ materiality.<br/>
          â€¢ Cost: 28 branches analysed â€” 20 RECOMMENDED_WITH_NOTES, 6 EXCEPTION, 2 missing (BR-AMD-004, BR-CORP-001)<br/>
          â€¢ OBS: â‚¹0.01L difference confirmed as rounding. Ready for CFO sign-off.<br/>
          â€¢ Capacity: 10 missing branches â€” lease reference searched, proxy estimates provided with LOW confidence.<br/>
          â€¢ Ind AS 116: IBR analysis with 1 known borrowing rate (Molkem @ 15%). CA confirmation required.<br/>
          â€¢ Debt: 32 facilities â€” 1 partially complete, 31 manual input required.<br/>
          â€¢ GL: 112 groups sorted by â‚¹ materiality â€” P1/P2/P3 priority applied.
        </InfoBox>
      </div>
    </div>
  );
}

// â”€â”€â”€ Data Integrity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function IntegrityTab({api}) {
  const [data, setData] = useState(null);
  useEffect(()=>{ apiFetch('/api/fpa/step15/step15g/data-integrity').then(setData).catch(console.error); },[]);

  if (!data) return <div style={{color:C.text2}}>Loadingâ€¦</div>;
  const statusColor = {PASS:'green',WARNING:'amber',FAIL:'red'};

  return (
    <div>
      <SectionHead tag="1" title="Data Integrity Check"/>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
        <StatCard label="Overall Status" value={data.overall} color={statusColor[data.overall]||'amber'}/>
        <StatCard label="PASS" value={data.summary?.pass} color="green"/>
        <StatCard label="WARNING" value={data.summary?.warn} color="amber"/>
        <StatCard label="FAIL" value={data.summary?.fail} color="red"/>
      </div>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
          <thead><tr>{['ID','Check','Status','Detail'].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
          <tbody>
            {(data.checks||[]).map(c=>(
              <tr key={c.id}>
                <td style={{...TD,fontFamily:'monospace',fontSize:10}}>{c.id}</td>
                <td style={TD}>{c.label}</td>
                <td style={TD}>{pill(c.status, statusColor[c.status]||'grey')}</td>
                <td style={{...TD,fontSize:11,color:C.text2}}>{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.overall!=='PASS' && (
        <InfoBox variant="amber" style={{marginTop:12}}>
          {data.overall==='FAIL' ? 'FAIL: Material data integrity issues detected. Review before approving any proposals.' : 'WARNING: Some checks flagged. Review individual items. Key warning: ALL revenue mappings have 1 month of data only.'}
        </InfoBox>
      )}
    </div>
  );
}

// â”€â”€â”€ Revenue Analysis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function RevenueTab({api}) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('ALL');
  useEffect(()=>{ apiFetch('/api/fpa/step15/step15g/revenue/analytical-review').then(setData).catch(console.error); },[]);

  if (!data) return <div style={{color:C.text2}}>Loadingâ€¦</div>;
  const {summary, by_materiality, exception_queue} = data;

  const matColors = {CRITICAL:'red',HIGH:'amber',MEDIUM:'grey',LOW:'grey'};
  const items = (exception_queue||[]).filter(m => filter==='ALL' || m.materiality===filter);

  return (
    <div>
      <SectionHead tag="2" title="Revenue Analytical Review â€” 650 Mappings"/>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:10,marginBottom:16}}>
        <StatCard label="Total Mappings" value={summary?.total} sub={`${fmtL(summary?.total_monthly_lakh)}/mo`}/>
        <StatCard label="Recommended" value={summary?.recommended_count||0} color="green" sub="meets all criteria"/>
        <StatCard label="In Exception Queue" value={summary?.exception_count||0} color="amber" sub="require review"/>
        <StatCard label="Approved" value={summary?.approved_count||0} color={summary?.approved_count>0?'green':'red'} sub={pct(summary?.coverage_pct)}/>
      </div>

      <InfoBox variant="amber">
        <strong>DATA LIMITATION â€” NO RECOMMENDED POOL:</strong> {summary?.data_limitation}
      </InfoBox>

      {/* By materiality */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
        {Object.entries(by_materiality||{}).map(([tier,b])=>(
          <div key={tier} style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',borderLeft:`4px solid ${tier==='CRITICAL'?C.red:tier==='HIGH'?C.amber:C.border}`}}>
            <div style={{fontSize:9,fontWeight:700,letterSpacing:'0.08em',textTransform:'uppercase',color:tier==='CRITICAL'?C.red:tier==='HIGH'?C.amber:C.text3,marginBottom:4}}>{tier}</div>
            <div style={{fontSize:18,fontWeight:700,fontFamily:'monospace',color:C.text}}>{b.count}</div>
            <div style={{fontSize:11,color:C.text2}}>{fmtL(b.monthly_lakh)}/mo</div>
            <div style={{fontSize:10,color:C.text3}}>Individual review req.</div>
          </div>
        ))}
      </div>

      {/* Exception queue */}
      <div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
        <span style={{fontSize:11,color:C.text2,alignSelf:'center'}}>Filter:</span>
        {['ALL','CRITICAL','HIGH','MEDIUM','LOW'].map(f=>(
          <button key={f} onClick={()=>setFilter(f)}
            style={{background:filter===f?C.blue:C.bg3,border:`1px solid ${filter===f?C.blue:C.border}`,borderRadius:4,color:filter===f?'#000':C.text2,padding:'4px 10px',fontSize:11,cursor:'pointer',fontWeight:filter===f?700:400}}>
            {f}
          </button>
        ))}
      </div>

      <div style={{fontSize:12,color:C.text2,marginBottom:8}}>Exception Queue â€” Top 50 by â‚¹ Value (showing {items.length})</div>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
          <thead><tr>{['Branch','Materiality','Proposed â‚¹L/mo','Annual â‚¹L','% Total','Months','Confidence','Flags'].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
          <tbody>
            {items.slice(0,50).map(m=>(
              <tr key={m.mapping_id}>
                <td style={TD}><div style={{fontSize:10}}>{m.branch_id}</div><div style={{fontSize:9,color:C.text3}}>{m.zoho_customer_id}</div></td>
                <td style={TD}>{pill(m.materiality, matColors[m.materiality]||'grey')}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{fmtL(m.proposed_lakh)}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{fmtL(m.annualised_lakh)}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{pct(m.pct_of_total)}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{m.months_with_data}</td>
                <td style={TD}>{pill(m.confidence||'LOW',m.confidence==='HIGH'?'green':m.confidence==='MEDIUM'?'amber':'red')}</td>
                <td style={TD}>
                  {(m.flags||[]).map((f,i)=>(
                    <div key={i} style={{fontSize:10,color:C.amber,marginBottom:2}}>âš  {f.msg}</div>
                  ))}
                  {!m.flags?.length && <span style={{color:C.text3,fontSize:10}}>No flags</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// â”€â”€â”€ Cost Analysis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function CostTab({api}) {
  const [data, setData] = useState(null);
  useEffect(()=>{ apiFetch('/api/fpa/step15/step15g/cost/analytical-review').then(setData).catch(console.error); },[]);
  if (!data) return <div style={{color:C.text2}}>Loadingâ€¦</div>;
  const {summary, branches, missing_branches} = data;
  const recColors = {RECOMMENDED:'green',RECOMMENDED_WITH_NOTES:'amber',EXCEPTION:'red',MGMT_INPUT_REQUIRED:'red'};

  return (
    <div>
      <SectionHead tag="6" title="Cost Master â€” Analytical Review"/>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(155px,1fr))',gap:10,marginBottom:16}}>
        <StatCard label="Total/mo" value={fmtL(summary?.total_monthly_lakh)} color="blue"/>
        <StatCard label="Recommended" value={summary?.recommended_count} color="green"/>
        <StatCard label="Exceptions" value={summary?.exception_count} color="amber"/>
        <StatCard label="Missing" value={summary?.missing} color="red"/>
      </div>

      {missing_branches?.length > 0 && (
        <InfoBox variant="red">
          <strong>2 Missing Cost Branches:</strong><br/>
          {missing_branches.map(b=>(
            <div key={b.branch_id} style={{marginTop:4}}>â€¢ <strong>{b.branch_id}</strong> ({b.branch_name}, {b.city}) â€” {b.flags?.[0]?.msg}</div>
          ))}
          <div style={{marginTop:6}}>Management must provide cost assumptions for these branches. No Zoho bills data found.</div>
        </InfoBox>
      )}

      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
          <thead><tr>{['Branch','City','Rent â‚¹L','Util â‚¹L','People â‚¹L','Other â‚¹L','Total â‚¹L','Cost/Rev%','Recommendation','Flags'].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
          <tbody>
            {(branches||[]).map(b=>(
              <tr key={b.branch_id} style={{background:b.recommendation==='MGMT_INPUT_REQUIRED'?C.redBg:undefined}}>
                <td style={TD}><div style={{fontSize:10}}>{b.branch_id}</div><div style={{fontSize:9,color:C.text3}}>{b.branch_name}</div></td>
                <td style={TD}>{b.city}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{b.cost_lines?.rent?.proposed??'â€”'}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{b.cost_lines?.utilities?.proposed??'â€”'}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{b.cost_lines?.people?.proposed??'â€”'}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{b.cost_lines?.other?.proposed??'â€”'}</td>
                <td style={{...TD,fontFamily:'monospace',fontWeight:700}}>{b.total_proposed_lakh||'â€”'}</td>
                <td style={{...TD,fontFamily:'monospace',color:b.cost_rev_pct>80?C.red:b.cost_rev_pct>50?C.amber:C.text}}>{b.cost_rev_pct!=null?`${b.cost_rev_pct}%`:'â€”'}</td>
                <td style={TD}>{pill(b.recommendation?.replace(/_/g,' '),recColors[b.recommendation]||'grey')}</td>
                <td style={TD}>
                  {(b.flags||[]).map((f,i)=><div key={i} style={{fontSize:9,color:C.amber,marginBottom:1}}>âš  {f.code}</div>)}
                  {!b.flags?.length && <span style={{fontSize:9,color:C.green}}>âœ“ Clean</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// â”€â”€â”€ Opening BS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function OBSTab({api}) {
  const [data, setData] = useState(null);
  const [approver, setApprover] = useState('');
  const [comment, setComment] = useState('');
  const [showForm, setShowForm] = useState(false);

  useEffect(()=>{ apiFetch('/api/fpa/step15/step15g/obs/sign-off-pack').then(setData).catch(console.error); },[]);
  if (!data) return <div style={{color:C.text2}}>Loadingâ€¦</div>;

  const submit = async () => {
    if (!approver.trim()) return alert('Approver name required');
    if (!window.confirm(`CONFIRM: Approve Opening Balance Sheet?\nTotal Assets: ${fmtL(data.total_assets_lakh)}\nDiff: ${fmtL(data.diff_lakh)}\nApprover: ${approver}`)) return;
    await api('/api/fpa/step15/step15f/obs/approve', 'POST', {approved_by:approver,comment:comment||data.diff_explanation});
    setShowForm(false);
  };

  return (
    <div>
      <SectionHead tag="9" title="Opening Balance Sheet â€” CFO Sign-Off Pack"/>
      <div style={{background:C.bg2,border:`1px solid ${data.status==='approved'?C.greenBorder:C.border}`,borderRadius:8,padding:20,marginBottom:16}}>
        <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:14,flexWrap:'wrap'}}>
          <div style={{fontSize:13,fontWeight:700,color:C.text}}>Opening Balance Sheet â€” {data.as_at}</div>
          {pill(data.status==='approved'?'APPROVED':'PENDING APPROVAL', data.status==='approved'?'green':'amber')}
          {data.approved_by && <span style={{fontSize:11,color:C.text2}}>by {data.approved_by}</span>}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12}}>
          {[
            {label:'Total Assets', val:data.total_assets_lakh, color:'blue'},
            {label:'Total E+L (model)', val:data.total_el_lakh, color:'blue'},
            {label:'Difference', val:data.diff_lakh, color:Math.abs(data.diff_lakh||0)<1?'green':'red'},
            {label:'Non-Current Assets', val:data.nc_assets_lakh},
            {label:'Current Assets', val:data.c_assets_lakh},
            {label:'Equity', val:data.equity_lakh, color:'purple'},
            {label:'NC Liabilities', val:data.nc_liab_lakh},
            {label:'Current Liabilities', val:data.c_liab_lakh},
            {label:'Borrowings (total)', val:data.borrowings},
            {label:'Lease Liabilities', val:data.lease_liab},
            {label:'ROU Assets', val:data.rou_asset},
            {label:'PPE (net)', val:data.ppe_net},
          ].map(r=>(
            <div key={r.label} style={{background:C.bg3,borderRadius:5,padding:'10px 12px'}}>
              <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:C.text3,marginBottom:3}}>{r.label}</div>
              <div style={{fontSize:14,fontWeight:700,fontFamily:'monospace',color:{blue:C.blue,green:C.green,red:C.red,purple:C.purple}[r.color]||C.text}}>{fmtL(r.val)}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:14,padding:12,background:C.bg3,borderRadius:6,fontSize:12,color:C.text2}}>
          <strong style={{color:C.text}}>Source:</strong> {data.source}<br/>
          <strong style={{color:C.text}}>Reconciliation:</strong> {data.diff_explanation}
        </div>
      </div>
      {data.status==='approved'
        ? <InfoBox variant="green">B3 CLEARED â€” Opening Balance Sheet approved by {data.approved_by}</InfoBox>
        : (
          <div>
            <InfoBox variant="amber">Action required: CFO must explicitly confirm the opening balance sheet before B3 blocker is cleared.</InfoBox>
            <button onClick={()=>setShowForm(f=>!f)} style={{background:C.green,color:'#000',border:'none',borderRadius:4,padding:'8px 18px',fontSize:12,fontWeight:700,cursor:'pointer'}}>APPROVE OPENING BALANCE SHEET</button>
            {showForm && (
              <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:6,padding:16,marginTop:12}}>
                <div style={{marginBottom:8}}><label style={{fontSize:11,fontWeight:600,color:C.text2}}>Approver Name <span style={{color:C.red}}>*</span></label><input value={approver} onChange={e=>setApprover(e.target.value)} style={{display:'block',marginTop:4,background:C.bg2,border:`1px solid ${C.border}`,borderRadius:4,color:C.text,padding:'6px 8px',fontSize:12,width:'100%'}}/></div>
                <div style={{marginBottom:10}}><label style={{fontSize:11,fontWeight:600,color:C.text2}}>Comment</label><textarea rows={2} value={comment} onChange={e=>setComment(e.target.value)} defaultValue={data.diff_explanation} style={{display:'block',marginTop:4,background:C.bg2,border:`1px solid ${C.border}`,borderRadius:4,color:C.text,padding:'6px 8px',fontSize:12,width:'100%',resize:'vertical'}}/></div>
                <button onClick={submit} style={{background:C.green,color:'#000',border:'none',borderRadius:4,padding:'8px 18px',fontSize:12,fontWeight:700,cursor:'pointer'}}>CONFIRM â€” APPROVE</button>
              </div>
            )}
          </div>
        )
      }
    </div>
  );
}

// â”€â”€â”€ Capacity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function CapacityTab({api}) {
  const [data, setData] = useState(null);
  useEffect(()=>{ apiFetch('/api/fpa/step15/step15g/capacity/completion').then(setData).catch(console.error); },[]);
  if (!data) return <div style={{color:C.text2}}>Loadingâ€¦</div>;

  return (
    <div>
      <SectionHead tag="10" title={`Branch Capacity â€” ${data.missing_count} Missing Branches`}/>
      <InfoBox variant="amber">{data.methodology_note}</InfoBox>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
          <thead><tr>{['Branch','City','Lease Matches','Ref Rent â‚¹L','Est Area (sqft)','Est Seats','Confidence','Source','Required Action'].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
          <tbody>
            {(data.branches||[]).map(b=>(
              <tr key={b.branch_id}>
                <td style={TD}><div>{b.branch_id}</div><div style={{fontSize:9,color:C.text3}}>{b.branch_name}</div></td>
                <td style={TD}>{b.city}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{b.lease_matches}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{fmtL(b.ref_rent_lakh)}</td>
                <td style={{...TD,fontFamily:'monospace',color:b.est_area_sqft?C.amber:C.text3}}>{b.est_area_sqft?fmtN(b.est_area_sqft):'â€”'}</td>
                <td style={{...TD,fontFamily:'monospace',color:b.est_seats?C.amber:C.text3}}>{b.est_seats||'â€”'}</td>
                <td style={TD}>{pill(b.est_confidence?.split(' ')[0]||'NO_DATA',b.est_confidence?.startsWith('LOW')?'amber':'red')}</td>
                <td style={{...TD,fontSize:10,color:C.text2}}>{b.est_source||'none'}</td>
                <td style={{...TD,fontSize:10,color:C.red}}>Manual input via CFO Approval Center â†’ Capacity tab</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// â”€â”€â”€ Ind AS 116 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function IBRTab({api}) {
  const [data, setData] = useState(null);
  useEffect(()=>{ apiFetch('/api/fpa/step15/step15g/lease/ibr-analysis').then(setData).catch(console.error); },[]);
  if (!data) return <div style={{color:C.text2}}>Loadingâ€¦</div>;

  return (
    <div>
      <SectionHead tag="11" title="Ind AS 116 â€” IBR Decision Support"/>
      <InfoBox variant="red"><strong>{data.ca_message}</strong></InfoBox>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(155px,1fr))',gap:10,marginBottom:16}}>
        <StatCard label="Total Leases" value={191}/>
        <StatCard label="Monthly Rent" value={fmtL(data.total_monthly_rent_lakh)}/>
        <StatCard label="ROU (Audited)" value={fmtL(data.rou_asset_audited_lakh)} color="blue"/>
        <StatCard label="Known Borrowing Rates" value={data.data_available?.rated_facilities||0} color={data.data_available?.rated_facilities>0?'amber':'red'}/>
        <StatCard label="IBR Set" value={data.current_ibr?`${data.current_ibr}%`:'NOT SET'} color={data.current_ibr?'green':'red'}/>
      </div>

      {/* Term distribution */}
      <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:6,padding:14,marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:600,color:C.text2,marginBottom:10}}>Lease Term Distribution (remaining)</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
          {[{l:'â‰¤ 1 Year',k:'le_1yr'},{l:'1â€“3 Years',k:'gt1_3yr'},{l:'3â€“5 Years',k:'gt3_5yr'},{l:'> 5 Years',k:'gt5yr'}].map(b=>(
            <div key={b.k} style={{background:C.bg3,borderRadius:5,padding:'10px 12px',textAlign:'center'}}>
              <div style={{fontSize:18,fontWeight:700,fontFamily:'monospace',color:C.blue}}>{data.term_distribution?.[b.k]?.count||0}</div>
              <div style={{fontSize:10,color:C.text3}}>{b.l}</div>
              <div style={{fontSize:10,color:C.text2,marginTop:2}}>{fmtL(data.term_distribution?.[b.k]?.monthly_rent)}/mo</div>
            </div>
          ))}
        </div>
      </div>

      {/* Borrowing rate evidence */}
      {(data.data_available?.rated_facilities||0) > 0 ? (
        <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:6,padding:14,marginBottom:16}}>
          <div style={{fontSize:11,fontWeight:600,color:C.text2,marginBottom:8}}>Borrowing Rate Evidence from Debt Schedule</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
            {[{l:'Min Rate',v:data.borrowing_rate_evidence?.min},{l:'Max Rate',v:data.borrowing_rate_evidence?.max},{l:'Median',v:data.borrowing_rate_evidence?.median},{l:'Weighted Avg',v:data.borrowing_rate_evidence?.weighted_avg}].map(r=>(
              <div key={r.l} style={{background:C.bg3,borderRadius:5,padding:'10px 12px',textAlign:'center'}}>
                <div style={{fontSize:18,fontWeight:700,fontFamily:'monospace',color:C.amber}}>{r.v!=null?`${r.v}%`:'â€”'}</div>
                <div style={{fontSize:10,color:C.text3}}>{r.l}</div>
              </div>
            ))}
          </div>
          <InfoBox style={{marginTop:10}}>These rates are from existing debt facilities and serve as EVIDENCE ONLY. The IBR must be specifically confirmed by the statutory auditor or CA as the incremental borrowing rate applicable to lease discounting as at 31-Mar-2026.</InfoBox>
        </div>
      ) : (
        <InfoBox variant="red">No borrowing rate evidence available in debt schedule. CA must provide IBR from independent sources.</InfoBox>
      )}

      {/* Options */}
      <div style={{fontSize:11,fontWeight:700,color:C.text,marginBottom:10}}>IBR Methodology Options (indicative only â€” CA confirmation required)</div>
      {(data.options||[]).map(opt=>(
        <div key={opt.method} style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:6,padding:14,marginBottom:10}}>
          <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:8}}>
            {pill(opt.method,'blue')}
            <span style={{fontWeight:600,color:C.text,fontSize:13}}>{opt.label}</span>
          </div>
          <div style={{fontSize:12,color:C.text2}}>{opt.note}</div>
          {opt.indicative_rate_pct && <div style={{marginTop:6,fontSize:12,color:C.amber}}>Indicative: {opt.indicative_rate_pct}% â€” <strong>CA CONFIRMATION REQUIRED</strong></div>}
          {opt.bands && (
            <div style={{marginTop:8,display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:6}}>
              {opt.bands.map(b=>(
                <div key={b.band} style={{background:C.bg3,borderRadius:4,padding:'8px 10px'}}>
                  <div style={{fontSize:10,fontWeight:700,color:C.text3}}>{b.band}</div>
                  <div style={{fontSize:12,fontFamily:'monospace',color:C.amber}}>{b.indicative_pct}%</div>
                  <div style={{fontSize:9,color:C.text3}}>{b.count} leases</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <InfoBox variant="red">CA / CFO APPROVAL REQUIRED. Navigate to CFO Approval Center (Step 15F â†’ Ind AS 116 tab) to enter the CA-confirmed rate.</InfoBox>
    </div>
  );
}

// â”€â”€â”€ Debt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function DebtTab({api}) {
  const [data, setData] = useState(null);
  useEffect(()=>{ apiFetch('/api/fpa/step15/step15g/debt/completion').then(setData).catch(console.error); },[]);
  if (!data) return <div style={{color:C.text2}}>Loadingâ€¦</div>;
  const statusColor = {COMPLETE:'green',PARTIALLY_COMPLETE:'amber',MANUAL_INPUT_REQUIRED:'red'};

  return (
    <div>
      <SectionHead tag="12" title="Debt Schedule â€” Auto-Completion Analysis"/>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
        <StatCard label="Total" value={data.summary?.total}/>
        <StatCard label="Complete" value={data.summary?.complete} color="green"/>
        <StatCard label="Partially Complete" value={data.summary?.partially_complete} color="amber"/>
        <StatCard label="Manual Required" value={data.summary?.manual_required} color="red"/>
      </div>
      <InfoBox variant="amber">DEB-001 (Molkem TL) can have EMI derived: bullet facility â†’ interest only = â‚¹{data.facilities?.[0]?.derived_fields?.find(f=>f.field==='monthly_interest_lakh')?.value||'â€”'}L/mo. All other 31 facilities require treasury input.</InfoBox>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
          <thead><tr>{['ID','Lender','Type','Principal â‚¹L','Rate %','Maturity','Status','Complete%','Missing'].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
          <tbody>
            {(data.facilities||[]).slice(0,15).map(f=>(
              <tr key={f.id}>
                <td style={{...TD,fontFamily:'monospace',fontSize:10}}>{f.id}</td>
                <td style={TD}>{f.lender||'â€”'}</td>
                <td style={TD}>{f.type||'â€”'}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{f.opening_principal||'â€”'}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{f.rate||f.interest_rate||'â€”'}</td>
                <td style={{...TD,fontFamily:'monospace',fontSize:10}}>{f.maturity||'â€”'}</td>
                <td style={TD}>{pill(f.status?.replace(/_/g,' '),statusColor[f.status]||'grey')}</td>
                <td style={{...TD,fontFamily:'monospace'}}>{f.complete_pct}%</td>
                <td style={{...TD,fontSize:10,color:C.red}}>{(f.missing_fields||[]).map(m=>m.field).join(', ')||'â€”'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(data.facilities?.length||0) > 15 && <div style={{marginTop:8,fontSize:11,color:C.text3}}>Showing 15 of {data.facilities?.length} facilities â€” remaining {data.facilities?.length-15} all require manual input.</div>}
    </div>
  );
}

// â”€â”€â”€ GL Mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function GLTab({api}) {
  const [data, setData] = useState(null);
  useEffect(()=>{ apiFetch('/api/fpa/step15/step15g/gl/materiality').then(setData).catch(console.error); },[]);
  if (!data) return <div style={{color:C.text2}}>Loadingâ€¦</div>;

  return (
    <div>
      <SectionHead tag="13" title="GL Mapping â€” Materiality Review"/>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))',gap:10,marginBottom:16}}>
        <StatCard label="Total GL Groups" value={data.summary?.total}/>
        <StatCard label="P1 Unresolved" value={data.summary?.p1_unresolved} color="red"/>
        <StatCard label="P2 Unresolved" value={data.summary?.p2_unresolved} color="amber"/>
        <StatCard label="P3 Unresolved" value={data.summary?.p3_count} color="grey"/>
        <StatCard label="Total Value" value={fmtL(data.summary?.total_value_lakh)} color="blue"/>
      </div>
      <InfoBox>P1 covers 80% of total GL value. Resolve P1 items first â€” they have the greatest impact on FPA line accuracy in Baseline V1. Use CFO Approval Center â†’ GL Mapping tab to CONFIRM/CHANGE/N/A each item.</InfoBox>

      {/* P1 */}
      <div style={{marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:C.red,marginBottom:8}}>P1 â€” MATERIAL ({data.summary?.p1_count} groups, first 80% of value)</div>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
            <thead><tr>{['Account','FPA Line','Statement','Value â‚¹L','Cum%','Status'].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
            <tbody>
              {(data.p1||[]).map(g=>(
                <tr key={g.account}>
                  <td style={TD}>{g.account}</td>
                  <td style={{...TD,fontFamily:'monospace',fontSize:10}}>{g.fpa_line||'â€”'}</td>
                  <td style={TD}>{g.statement||'â€”'}</td>
                  <td style={{...TD,fontFamily:'monospace'}}>{fmtL(g.value_lakh)}</td>
                  <td style={{...TD,fontFamily:'monospace'}}>{g.cum_pct}%</td>
                  <td style={TD}>{pill(g.current_status||'pending',g.resolved?'green':'amber')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// â”€â”€â”€ Quick Wins â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function QuickWinsTab({api}) {
  const [data, setData] = useState(null);
  useEffect(()=>{ apiFetch('/api/fpa/step15/step15g/quick-wins').then(setData).catch(console.error); },[]);
  if (!data) return <div style={{color:C.text2}}>Loadingâ€¦</div>;

  const riskColor = {LOW:'green',MEDIUM:'amber',HIGH:'red'};

  return (
    <div>
      <SectionHead tag="14" title="CFO Quick-Win Queue â€” Priority Actions"/>
      <InfoBox>Actions ranked by maximum model impact / minimum management effort. Completing actions in this order clears hard blockers fastest. {data.completed?.length>0 && `${data.completed.length} action(s) already complete.`}</InfoBox>

      {(data.wins||[]).map((w,i)=>(
        <div key={i} style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:6,padding:'14px 16px',marginBottom:10,borderLeft:`4px solid ${w.risk==='HIGH'?C.red:w.risk==='MEDIUM'?C.amber:C.green}`}}>
          <div style={{display:'flex',gap:12,alignItems:'flex-start',flexWrap:'wrap'}}>
            <div style={{fontSize:11,fontWeight:800,fontFamily:'monospace',color:C.text3,minWidth:20}}>#{w.priority}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:4}}>{w.action}</div>
              <div style={{fontSize:12,color:C.text2,marginBottom:8}}>{w.description}</div>
              <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
                {w.impact_lakh != null && <span style={{fontSize:11,fontFamily:'monospace',color:C.blue}}>â‚¹{Number(w.impact_lakh).toFixed(0)}L impact</span>}
                {w.records != null && <span style={{fontSize:11,color:C.text3}}>{fmtN(w.records)} records</span>}
                {w.est_minutes != null && <span style={{fontSize:11,color:C.text3}}>~{w.est_minutes} min</span>}
                {pill(`Risk: ${w.risk}`, riskColor[w.risk]||'grey')}
                {(w.unblocks||[]).map(u=><span key={u} style={{fontSize:10,color:C.purple}}>â†’ Unblocks: {u}</span>)}
              </div>
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:10,color:C.text3,marginBottom:4}}>{w.tab}</div>
            </div>
          </div>
        </div>
      ))}

      {data.completed?.length > 0 && (
        <div style={{marginTop:20}}>
          <div style={{fontSize:12,fontWeight:700,color:C.green,marginBottom:8}}>Completed Actions</div>
          {data.completed.map((w,i)=>(
            <div key={i} style={{background:C.greenBg,border:`1px solid ${C.greenBorder}`,borderRadius:6,padding:'10px 14px',marginBottom:8,fontSize:12,color:C.green}}>
              âœ“ {w.action}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// â”€â”€â”€ Readiness Simulator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function SimulatorTab({api}) {
  const [selected, setSelected] = useState([]);
  const [result, setResult] = useState(null);

  const OPTIONS = [
    {id:'obs',              label:'Approve Opening BS (B3)',    desc:'Clears B3 blocker immediately'},
    {id:'revenue_critical', label:'Approve CRITICAL Revenue (23)', desc:'23 mappings Â· â‚¹5,638L/mo'},
    {id:'revenue_high',     label:'Approve HIGH Revenue (34)',  desc:'34 mappings Â· â‚¹703L/mo'},
    {id:'revenue_bulk',     label:'Bulk-approve R3+R4 (593)',   desc:'All remaining revenue'},
    {id:'cost_all',         label:'Approve all 28 cost branches', desc:'â‚¹916L/mo Â· clears B2'},
    {id:'ibr',              label:'Set IBR (blended)',           desc:'Clears B4 â€” CA confirmation req'},
  ];

  const toggle = id => setSelected(s => s.includes(id) ? s.filter(x=>x!==id) : [...s, id]);

  const simulate = async () => {
    const d = await apiFetch('/api/fpa/step15/step15g/readiness-simulator', {
      method:'POST',
      body: JSON.stringify({approve:selected}),
      headers:{'Content-Type':'application/json'},
    });
    setResult(d);
  };

  return (
    <div>
      <SectionHead tag="15" title="Readiness Simulator â€” Non-Posting Projection"/>
      <InfoBox variant="red">SIMULATION ONLY. No data is written. No approval is recorded. This is a read-only projection to help prioritize management review effort.</InfoBox>

      <div style={{marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:600,color:C.text2,marginBottom:10}}>Select actions to simulate:</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))',gap:8}}>
          {OPTIONS.map(opt=>(
            <div key={opt.id} onClick={()=>toggle(opt.id)}
              style={{background:selected.includes(opt.id)?C.blueBg:C.bg2,border:`1px solid ${selected.includes(opt.id)?C.blue:C.border}`,borderRadius:6,padding:'12px 14px',cursor:'pointer',userSelect:'none'}}>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <div style={{width:14,height:14,borderRadius:3,background:selected.includes(opt.id)?C.blue:'none',border:`2px solid ${selected.includes(opt.id)?C.blue:C.text3}`,flexShrink:0}}/>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:C.text}}>{opt.label}</div>
                  <div style={{fontSize:11,color:C.text2}}>{opt.desc}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <button onClick={simulate} style={{background:C.blue,color:'#000',border:'none',borderRadius:4,padding:'8px 20px',fontSize:12,fontWeight:700,cursor:'pointer',marginBottom:20}}>
        RUN SIMULATION
      </button>

      {result && (
        <div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
            {[{label:'Current Gate',data:result.current},{label:'Simulated Gate',data:result.simulated}].map(({label,data})=>(
              <div key={label} style={{background:C.bg2,border:`1px solid ${data.gate==='GREEN'?C.greenBorder:data.gate==='AMBER'?C.amberBorder:C.redBorder}`,borderRadius:8,padding:16}}>
                <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:C.text3,marginBottom:8}}>{label}</div>
                <div style={{fontSize:24,fontWeight:800,fontFamily:'monospace',color:data.gate==='GREEN'?C.green:data.gate==='AMBER'?C.amber:C.red,marginBottom:10}}>{data.gate}</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,fontSize:11}}>
                  <div style={{color:C.text2}}>Hard Blockers</div><div style={{fontFamily:'monospace',color:C.text}}>{data.blockers}</div>
                  <div style={{color:C.text2}}>Rev Coverage</div><div style={{fontFamily:'monospace',color:C.text}}>{pct(data.revenue_coverage_pct)}</div>
                  <div style={{color:C.text2}}>CRITICAL Approved</div><div style={{fontFamily:'monospace',color:C.text}}>{data.critical_approved}/{23}</div>
                  <div style={{color:C.text2}}>Cost Approved</div><div style={{fontFamily:'monospace',color:C.text}}>{data.cost_approved}</div>
                  <div style={{color:C.text2}}>OBS</div><div>{data.obs_ok?pill('APPROVED','green'):pill('PENDING','red')}</div>
                  <div style={{color:C.text2}}>IBR</div><div>{data.ibr_ok?pill('SET','green'):pill('NOT SET','red')}</div>
                </div>
              </div>
            ))}
          </div>
          <InfoBox variant={result.gate_change.includes('GREEN')?'green':'blue'}>
            <strong>Gate change: {result.gate_change}</strong><br/>
            Actions simulated: {result.actions_simulated?.join(' Â· ')||'None'}
          </InfoBox>
        </div>
      )}
    </div>
  );
}

// ─── Contract Revenue Baseline (Step 15G.1) ──────────────────────────────────
function ContractRevTab({api}) {
  const [data, setData]    = React.useState(null);
  const [kpi,  setKpi]     = React.useState(null);
  const [src,  setSrc]     = React.useState(null);
  const [filter, setFilter] = React.useState('ALL');
  const [items, setItems]   = React.useState([]);
  const [loadingItems, setLI] = React.useState(false);

  React.useEffect(() => {
    apiFetch('/api/fpa/step15/step15g1/approval-groups').then(setData).catch(console.error);
    apiFetch('/api/fpa/step15/step15g1/quality-kpi').then(setKpi).catch(console.error);
    apiFetch('/api/fpa/step15/step15g1/sources-analysis').then(setSrc).catch(console.error);
  }, []);

  const loadItems = async (grp) => {
    setLI(true);
    try {
      const d = await apiFetch(`/api/fpa/step15/step15g1/contract-master?group=${grp}&size=30`);
      setItems(d.items || []);
    } finally { setLI(false); }
  };

  React.useEffect(() => {
    if (filter !== 'ALL') loadItems(filter);
    else setItems([]);
  }, [filter]);

  const [upStatus, setUpStatus] = React.useState(null);
  const [upMsg, setUpMsg]       = React.useState('');

  const downloadTemplate = async (tmpl, grp) => {
    try {
      const token = localStorage.getItem('da_token') || '';
      const BASE  = ``;
      const resp  = await fetch(`${BASE}/api/fpa/step15/step15g1/export-template?template=${tmpl}&group=${grp}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) throw new Error(`Server error ${resp.status}`);
      const blob = await resp.blob();
      const cd   = resp.headers.get('Content-Disposition') || '';
      const fname = cd.match(/filename="([^"]+)"/)?.[1] || `Template${tmpl}_Group${grp}.csv`;
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href = url; a.download = fname; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch(err) { alert('Download failed: ' + (err.message || err)); }
  };

  const handleCSVUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUpStatus('parsing'); setUpMsg('Reading CSV…');
    try {
      const text = await file.text();
      const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l=>l.trim());
      if (lines.length < 2) { setUpStatus('error'); setUpMsg('File is empty or has no data rows.'); return; }
      const parseRow = row => {
        const fields = []; let cur = '', inQ = false;
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          if (ch === '"' && !inQ)            { inQ = true; }
          else if (ch === '"' && inQ && row[i+1] === '"') { cur += '"'; i++; }
          else if (ch === '"' && inQ)        { inQ = false; }
          else if (ch === ',' && !inQ)       { fields.push(cur.trim()); cur = ''; }
          else                               { cur += ch; }
        }
        fields.push(cur.trim()); return fields;
      };
      const headers = parseRow(lines[0].replace(/^﻿/,''));
      const rows = lines.slice(1).map(l => {
        const vals = parseRow(l);
        const obj  = {};
        headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
        return obj;
      }).filter(r => r.mapping_id);
      if (rows.length === 0) { setUpStatus('error'); setUpMsg('No valid rows found. Check that mapping_id column is present.'); return; }
      setUpStatus('uploading'); setUpMsg(`Uploading ${rows.length} rows…`);
      const res = await apiFetch('/api/fpa/step15/step15g1/import-contracts', {
        method: 'POST', body: JSON.stringify({ rows }),
        headers: { 'Content-Type': 'application/json' },
      });
      setUpStatus('ok');
      setUpMsg(`✓ Import complete — ${res.created} new, ${res.updated} updated, ${res.skipped} skipped. Total in store: ${res.total_in_store}. Group cards will refresh.`);
      apiFetch('/api/fpa/step15/step15g1/approval-groups').then(setData);
      apiFetch('/api/fpa/step15/step15g1/quality-kpi').then(setKpi);
    } catch(err) {
      setUpStatus('error'); setUpMsg('Upload failed: ' + (err.message || String(err)));
    }
    e.target.value = '';
  };

  if (!data || !kpi) return React.createElement('div', {style:{color:C.text2}}, 'Loading…');

  const grpColors = {A:'green',B:'blue',C:'amber',D:'red'};
  const grpLabels = {
    A: 'GROUP A — Contract-backed (Level 1)',
    B: 'GROUP B — Recurring billing evidence (Level 2, 3+ months)',
    C: 'GROUP C — Historical proxy (Level 3, limited history)',
    D: 'GROUP D — Insufficient evidence (Level 4)',
  };

  return (
    <div>
      <SectionHead tag="15G.1" title="Contract-Based Revenue Baseline Reconstruction"/>

      {/* ── Download & Upload Toolbar ── */}
      <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:8,padding:'14px 18px',marginBottom:16}}>
        <div style={{fontSize:12,fontWeight:700,color:C.text,marginBottom:8}}>Step 1 — Download Pre-filled Template &nbsp;·&nbsp; Step 2 — Fill in Excel &nbsp;·&nbsp; Step 3 — Upload here</div>
        <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:10}}>
          <button onClick={()=>downloadTemplate('A','D')}
            style={{background:C.redBg,border:`1px solid ${C.redBorder}`,color:C.red,borderRadius:5,padding:'7px 13px',fontSize:11,fontWeight:700,cursor:'pointer'}}>
            📥 Template A — Group D (243 clients · ₹6,601L/mo)
          </button>
          <button onClick={()=>downloadTemplate('A','ALL')}
            style={{background:C.bg3,border:`1px solid ${C.border}`,color:C.text2,borderRadius:5,padding:'7px 13px',fontSize:11,cursor:'pointer'}}>
            📥 Template A — All 650 clients
          </button>
          <button onClick={()=>downloadTemplate('B','ALL')}
            style={{background:C.blueBg,border:`1px solid ${C.blueBorder}`,color:C.blue,borderRadius:5,padding:'7px 13px',fontSize:11,cursor:'pointer'}}>
            📥 Template B — Groups B+C Approval (407 rows)
          </button>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <label style={{background:C.greenBg,border:`1px solid ${C.greenBorder}`,color:C.green,borderRadius:5,padding:'7px 13px',fontSize:11,fontWeight:700,cursor:'pointer',display:'inline-block'}}>
            📤 Upload Filled Template A (.csv)
            <input type="file" accept=".csv,text/csv" onChange={handleCSVUpload} style={{display:'none'}} />
          </label>
          {upStatus && (
            <div style={{fontSize:11,color:{ok:C.green,error:C.red,parsing:C.amber,uploading:C.blue}[upStatus]||C.text2,flex:1}}>
              {upStatus==='parsing'?'Parsing CSV…':upStatus==='uploading'?'Uploading…':upMsg}
            </div>
          )}
        </div>
        <div style={{fontSize:10,color:C.text3,marginTop:8,lineHeight:1.7}}>
          <strong style={{color:C.text2}}>How:</strong> ① Click <em>Template A — Group D</em> to download a pre-filled CSV with all 243 client names, branch IDs, and current Zoho revenue. ② Open in Excel and fill the grey columns (contract_type, dates, seats, rate, etc.). ③ Save as CSV and click Upload. The group cards update automatically.
        </div>
      </div>

      <div style={{background:C.redBg,border:`2px solid ${C.redBorder}`,borderRadius:8,padding:'14px 18px',marginBottom:18}}>
        <div style={{fontFamily:'monospace',fontWeight:800,fontSize:13,color:C.red,marginBottom:6}}>CRITICAL FINDING — GROUP D = {kpi.by_value.level_4_pct?.toFixed(1)}% OF TOTAL MRR</div>
        <div style={{fontSize:12,color:C.text2,lineHeight:1.7}}>
          {data.groups.D.count} mappings representing <strong style={{color:C.red}}>{fmtL(data.groups.D.mrr_lakh)}/mo</strong> ({data.groups.D.pct_of_total?.toFixed(1)}% of total) have NO core invoice evidence in the processed invoice history. These are likely large enterprise Managed Space clients whose invoices have not been resolved to branch IDs in the revenue_actuals index.<br/>
          <strong>Management must confirm whether these are contracted relationships and provide: Contract Start/End, Seats, Rate, Lock-in, Notice Period.</strong>
        </div>
      </div>
      <InfoBox>
        <strong>Source Hierarchy applied:</strong> Level 1 (Signed Contracts) = 0 | Level 2 (3+ months consistent recurring billing) = Group B |
        Level 3 (1–2 months or variable billing) = Group C | Level 4 (no core invoice evidence) = Group D.
        Revenue amounts use <strong>mapping_revenue (Zoho-sourced)</strong> as authoritative amount.
      </InfoBox>
      <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:12,marginBottom:20}}>
        {['A','B','C','D'].map(g=>{
          const grp = data.groups[g];
          const col = grpColors[g];
          const bc  = {green:C.green,blue:C.blue,amber:C.amber,red:C.red}[col];
          const bbd = {green:C.greenBorder,blue:C.blueBorder,amber:C.amberBorder,red:C.redBorder}[col];
          return (
            <div key={g} onClick={()=>setFilter(filter===g?'ALL':g)}
              style={{background:C.bg2,border:`2px solid ${filter===g?bbd:C.border}`,borderLeft:`6px solid ${bbd}`,borderRadius:8,padding:'14px 16px',cursor:'pointer'}}>
              <div style={{fontSize:9,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',color:C.text3,marginBottom:6,fontFamily:'monospace'}}>{grpLabels[g]}</div>
              <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>
                <div><div style={{fontSize:22,fontWeight:800,fontFamily:'monospace',color:bc}}>{grp.count}</div><div style={{fontSize:10,color:C.text3}}>mappings</div></div>
                <div><div style={{fontSize:18,fontWeight:800,fontFamily:'monospace',color:bc}}>{fmtL(grp.mrr_lakh)}</div><div style={{fontSize:10,color:C.text3}}>MRR</div></div>
                <div><div style={{fontSize:18,fontWeight:800,fontFamily:'monospace',color:bc}}>{pct(grp.pct_of_total)}</div><div style={{fontSize:10,color:C.text3}}>of total</div></div>
              </div>
              {g==='D' && <div style={{marginTop:8,fontSize:11,color:C.red}}>⚠ Management input required before approval</div>}
              {g==='C' && <div style={{marginTop:8,fontSize:11,color:C.amber}}>⚠ HISTORICAL PROXY — explicit management approval required</div>}
              {g==='B' && <div style={{marginTop:8,fontSize:11,color:C.blue}}>Eligible for bulk review · Approver + comment required</div>}
              {g==='A' && <div style={{marginTop:8,fontSize:11,color:C.text3}}>No signed contracts in system. Level 1 = 0.</div>}
            </div>
          );
        })}
      </div>
      <div style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:7,padding:'14px 16px',marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:700,color:C.text,marginBottom:10}}>Revenue Quality KPI — % of MRR by Evidence Level</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8}}>
          {[
            {label:'Level 1 Contracts',  val:'0%',                                          valRs:'₹0L',                            color:'grey'},
            {label:'Level 2 Recurring',  val:`${kpi.by_value.level_2_pct?.toFixed(1)}%`,    valRs:fmtL(kpi.by_value.level_2_lakh), color:'blue'},
            {label:'Level 3 Proxy',      val:`${kpi.by_value.level_3_pct?.toFixed(1)}%`,    valRs:fmtL(kpi.by_value.level_3_lakh), color:'amber'},
            {label:'Level 4 No Evidence',val:`${kpi.by_value.level_4_pct?.toFixed(1)}%`,    valRs:fmtL(kpi.by_value.level_4_lakh), color:'red'},
          ].map(k=>(
            <div key={k.label} style={{background:C.bg3,borderRadius:5,padding:'10px 12px'}}>
              <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:C.text3,marginBottom:4}}>{k.label}</div>
              <div style={{fontSize:18,fontWeight:800,fontFamily:'monospace',color:{blue:C.blue,amber:C.amber,red:C.red,grey:C.text3}[k.color]}}>{k.val}</div>
              <div style={{fontSize:10,color:C.text2}}>{k.valRs}/mo</div>
            </div>
          ))}
        </div>
      </div>
      {kpi.invoice_coverage && (
        <div style={{background:C.amberBg,border:`1px solid ${C.amberBorder}`,borderRadius:6,padding:12,marginBottom:14,fontSize:12,color:C.amber}}>
          <strong>Invoice Gap Analysis:</strong> Core MRR from invoices = {fmtL(kpi.invoice_coverage.invoice_mrr_lakh)} vs Mapping MRR = {fmtL(kpi.invoice_coverage.mapping_mrr_lakh)}. Gap = <strong>{fmtL(kpi.invoice_coverage.gap_lakh)}</strong>. {kpi.invoice_coverage.note}
        </div>
      )}
      <div style={{fontSize:12,fontWeight:700,color:C.text,marginBottom:10}}>CFO Approval Sequence</div>
      {(data.approval_sequence||[]).map((step,i)=>(
        <div key={i} style={{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:6,padding:'12px 14px',marginBottom:8,display:'flex',gap:12}}>
          <div style={{fontSize:11,fontWeight:800,fontFamily:'monospace',color:C.text3,minWidth:20}}>#{step.step}</div>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:700,color:C.text,marginBottom:2}}>Group {step.group} — {step.action}</div>
            <div style={{fontSize:11,color:C.text2,marginBottom:4}}>{step.note}</div>
            <div style={{fontSize:11,fontFamily:'monospace',color:{B:C.blue,C:C.amber,D:C.red}[step.group]||C.text}}>{fmtL(step.mrr_lakh)}/mo · {pct(step.pct)} of total</div>
          </div>
        </div>
      ))}
      {filter !== 'ALL' && (
        <div style={{marginTop:16}}>
          <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:700,color:C.text}}>Group {filter} — Top 30 by Revenue</div>
            <button onClick={()=>setFilter('ALL')} style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:3,color:C.text2,padding:'3px 8px',fontSize:10,cursor:'pointer'}}>✕ Clear</button>
          </div>
          {loadingItems ? <div style={{color:C.text2,fontSize:12}}>Loading…</div> : (
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                <thead><tr>{['Branch','Months Core','Months Any','Invoice MRR','Mapping Rev','Gap%','Conf','Flags'].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
                <tbody>
                  {items.map(item=>(
                    <tr key={item.mapping_id}>
                      <td style={TD}><div style={{fontSize:10}}>{item.branch_id}</div><div style={{fontSize:9,color:C.text3}}>{item.zoho_customer_id?.slice(-8)}</div></td>
                      <td style={{...TD,fontFamily:'monospace'}}>{item.months_core_billing}</td>
                      <td style={{...TD,fontFamily:'monospace'}}>{item.months_any_billing}</td>
                      <td style={{...TD,fontFamily:'monospace'}}>{item.normalised_mrr_lakh>0?fmtL(item.normalised_mrr_lakh):'—'}</td>
                      <td style={{...TD,fontFamily:'monospace',fontWeight:700}}>{fmtL(item.mapping_revenue_lakh)}</td>
                      <td style={{...TD,fontFamily:'monospace',color:item.mrr_gap_pct!=null&&Math.abs(item.mrr_gap_pct)>40?C.amber:C.text}}>{item.mrr_gap_pct!=null?`${item.mrr_gap_pct?.toFixed(0)}%`:'—'}</td>
                      <td style={TD}>{pill(item.confidence,{A:'green',B:'blue',C:'amber',D:'red'}[item.confidence]||'grey')}</td>
                      <td style={TD}>{(item.flags||[]).map((f,i2)=><div key={i2} style={{fontSize:9,color:C.amber,marginBottom:1}}>⚠ {f.code}</div>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {src && (
        <div style={{marginTop:18}}>
          <div style={{fontSize:12,fontWeight:700,color:C.text,marginBottom:10}}>Data Sources Inspected</div>
          {(src.sources_inspected||[]).map((s,i2)=>(
            <div key={i2} style={{background:C.bg2,border:`1px solid ${s.status==='NOT_AVAILABLE'?C.redBorder:C.border}`,borderRadius:5,padding:'10px 14px',marginBottom:6,display:'flex',gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:600,color:C.text}}>{s.source}</div>
                <div style={{fontSize:10,color:C.text2}}>{s.type}{s.date_range?` · ${s.date_range}`:''}</div>
                <div style={{fontSize:10,color:C.text3,marginTop:3}}>{s.note}</div>
              </div>
              <div>{pill(s.status,s.status==='AVAILABLE'?'green':'red')}</div>
            </div>
          ))}
          {src.level_1_note && <div style={{background:C.redBg,border:`1px solid ${C.redBorder}`,borderRadius:6,padding:11,marginTop:8,fontSize:12,color:C.red}}><strong>No contracts in system:</strong> {src.level_1_note}</div>}
        </div>
      )}
    </div>
  );
}
