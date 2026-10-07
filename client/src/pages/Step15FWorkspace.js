import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api';

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:        '#F9F9F9',
  bg2:       '#FFFFFF',
  bg3:       '#F2F2F2',
  border:    '#DFE7E3',
  text:      '#18191B',
  text2:     '#5D6C7B',
  text3:     '#9BA8B0',
  red:       '#DC2626',
  redBg:     '#FEF2F2',
  redBorder: '#FECACA',
  amber:     '#B45309',
  amberBg:   '#FFFBEB',
  amberBorder:'#FDE68A',
  green:     '#15803D',
  greenBg:   '#F0FDF4',
  greenBorder:'#BBF7D0',
  blue:      '#1C4942',
  blueBg:    '#EAF4EF',
  blueBorder:'#A7C4BC',
};

// ─── Shared helpers ───────────────────────────────────────────────────────────
const pill = (label, color) => {
  const cfg = {
    red:   { bg: C.redBg,   border: C.redBorder,   text: C.red   },
    amber: { bg: C.amberBg, border: C.amberBorder, text: C.amber },
    green: { bg: C.greenBg, border: C.greenBorder, text: C.green },
    blue:  { bg: C.blueBg,  border: C.blueBorder,  text: C.blue  },
    grey:  { bg: C.bg3,     border: C.border,       text: C.text2 },
  }[color] || { bg: C.bg3, border: C.border, text: C.text2 };
  return (
    <span style={{ display:'inline-block', padding:'2px 7px', borderRadius:3, fontSize:10, fontWeight:700, letterSpacing:'0.04em', whiteSpace:'nowrap', background:cfg.bg, border:`1px solid ${cfg.border}`, color:cfg.text }}>{label}</span>
  );
};

const fmtL = v => v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 })}L`;
const fmtN = v => v == null ? '—' : Number(v).toLocaleString('en-IN');

function StatCard({ label, value, sub, color }) {
  const textColor = color === 'red' ? C.red : color === 'amber' ? C.amber : color === 'green' ? C.green : color === 'blue' ? C.blue : C.text;
  return (
    <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:6, padding:'14px 16px' }}>
      <div style={{ fontSize:10, fontWeight:700, letterSpacing:'0.07em', textTransform:'uppercase', color:C.text3, marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:700, fontFamily:'monospace', color:textColor, fontVariantNumeric:'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:C.text2, marginTop:2 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, tag, children }) {
  return (
    <div style={{ marginBottom:28 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:14, borderBottom:`1px solid ${C.border}`, paddingBottom:8 }}>
        {tag && <span style={{ fontSize:10, fontWeight:700, letterSpacing:'0.1em', color:C.text3, fontFamily:'monospace', textTransform:'uppercase' }}>{tag}</span>}
        <span style={{ fontSize:15, fontWeight:700, color:C.text }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function InfoBox({ children, variant }) {
  const s = { red:{ bg:C.redBg, border:C.redBorder, color:C.red }, amber:{ bg:C.amberBg, border:C.amberBorder, color:C.amber }, green:{ bg:C.greenBg, border:C.greenBorder, color:C.green } }[variant] || { bg:C.bg2, border:C.border, color:C.text2 };
  return <div style={{ background:s.bg, border:`1px solid ${s.border}`, borderRadius:6, padding:'12px 16px', fontSize:12, color:s.color, lineHeight:1.6 }}>{children}</div>;
}

function ApprovalForm({ fields, onSubmit, submitLabel = 'Approve', variant = 'green' }) {
  const [vals, setVals] = useState({});
  const set = (k, v) => setVals(p => ({ ...p, [k]: v }));
  return (
    <div style={{ background:C.bg3, border:`1px solid ${C.border}`, borderRadius:6, padding:16, marginTop:12 }}>
      {fields.map(f => (
        <div key={f.key} style={{ marginBottom:10 }}>
          <label style={{ display:'block', fontSize:11, fontWeight:600, color:C.text2, marginBottom:4 }}>{f.label}{f.required && <span style={{ color:C.red }}> *</span>}</label>
          {f.type === 'textarea' ? (
            <textarea rows={2} value={vals[f.key] || f.default || ''} onChange={e => set(f.key, e.target.value)}
              style={{ width:'100%', background:C.bg2, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 8px', fontSize:12, resize:'vertical', boxSizing:'border-box' }} />
          ) : f.type === 'number' ? (
            <input type="number" step="0.01" value={vals[f.key] ?? ''} onChange={e => set(f.key, e.target.value)}
              placeholder={f.placeholder || ''}
              style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 8px', fontSize:12, width:'100%', boxSizing:'border-box' }} />
          ) : (
            <input type="text" value={vals[f.key] || f.default || ''} onChange={e => set(f.key, e.target.value)}
              placeholder={f.placeholder || ''}
              style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 8px', fontSize:12, width:'100%', boxSizing:'border-box' }} />
          )}
        </div>
      ))}
      <button onClick={() => onSubmit(vals)}
        style={{ background: variant==='red' ? C.red : variant==='amber' ? C.amber : C.green, color:'#000', border:'none', borderRadius:4, padding:'8px 18px', fontSize:12, fontWeight:700, cursor:'pointer', marginTop:4 }}>
        {submitLabel}
      </button>
    </div>
  );
}

// ─── Module gate pill ─────────────────────────────────────────────────────────
function GatePill({ green, label }) {
  return green ? pill(`GREEN — ${label}`, 'green') : pill(`BLOCKED — ${label}`, 'red');
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
const TABS = [
  { id:'overview',  label:'CFO Overview' },
  { id:'obs',       label:'B  Opening BS' },
  { id:'revenue',   label:'C  Revenue' },
  { id:'cost',      label:'D  Cost Master' },
  { id:'capacity',  label:'E  Capacity' },
  { id:'leases',    label:'F  Ind AS 116' },
  { id:'debt',      label:'G  Debt' },
  { id:'gl',        label:'H  GL Mapping' },
  { id:'readiness', label:'J  Readiness' },
  { id:'audit',     label:'Audit Trail' },
];

// ─── Main workspace ───────────────────────────────────────────────────────────
export default function Step15FWorkspace() {
  const [tab, setTab]       = useState('overview');
  const [state, setState]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg]       = useState(null);

  const showMsg = (m, ok) => { setMsg({ text:m, ok }); setTimeout(() => setMsg(null), 5000); };

  const loadState = useCallback(async () => {
    setLoading(true);
    try { const d = await apiFetch('/api/fpa/step15/step15f/state'); setState(d); }
    catch(e) { showMsg(e.message, false); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadState(); }, [loadState]);

  const api = async (path, method = 'GET', body) => {
    try {
      const d = await apiFetch(path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'Content-Type':'application/json' } : undefined });
      showMsg(d.message || d.ok || JSON.stringify(d), true);
      await loadState();
      return d;
    } catch(e) { showMsg(e.message, false); return null; }
  };

  const s = state;

  return (
    <div style={{ background:C.bg, minHeight:'100vh', color:C.text, fontFamily:'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ background:C.bg2, borderBottom:`1px solid ${C.border}`, padding:'14px 24px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:16, flexWrap:'wrap' }}>
          <div>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', color:C.text3, fontFamily:'monospace' }}>Dev Accelerator Ltd · Step 15F</div>
            <div style={{ fontSize:18, fontWeight:700, color:C.text, letterSpacing:'-0.01em' }}>CFO Approval Center — Baseline Input Closure</div>
          </div>
          {s && (
            <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:10 }}>
              {pill(`GATE: ${s.gate}`, s.gate==='GREEN'?'green':s.gate==='AMBER'?'amber':'red')}
              <span style={{ fontSize:11, color:C.text3 }}>{s.hard_blockers} hard blocker{s.hard_blockers!==1?'s':''}</span>
              <button onClick={loadState} style={{ background:C.bg3, border:`1px solid ${C.border}`, borderRadius:4, color:C.text2, padding:'5px 10px', fontSize:11, cursor:'pointer' }}>↻ Refresh</button>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {msg && (
        <div style={{ background: msg.ok ? C.greenBg : C.redBg, border:`1px solid ${msg.ok?C.greenBorder:C.redBorder}`, color: msg.ok?C.green:C.red, padding:'8px 24px', fontSize:12 }}>{msg.text}</div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, borderBottom:`1px solid ${C.border}`, overflowX:'auto', background:C.bg2 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ background:'none', border:'none', borderBottom: tab===t.id ? `2px solid ${C.blue}` : '2px solid transparent', color: tab===t.id ? C.blue : C.text2, padding:'10px 16px', fontSize:12, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding:'24px 28px', maxWidth:1100 }}>
        {loading && <div style={{ color:C.text2, fontSize:13 }}>Loading state…</div>}
        {!loading && tab === 'overview'  && <OverviewTab  s={s} api={api} />}
        {!loading && tab === 'obs'       && <OBSTab       s={s} api={api} />}
        {!loading && tab === 'revenue'   && <RevenueTab   s={s} api={api} />}
        {!loading && tab === 'cost'      && <CostTab      s={s} api={api} />}
        {!loading && tab === 'capacity'  && <CapacityTab  s={s} api={api} />}
        {!loading && tab === 'leases'    && <LeasesTab    s={s} api={api} />}
        {!loading && tab === 'debt'      && <DebtTab      s={s} />}
        {!loading && tab === 'gl'        && <GLTab        s={s} api={api} />}
        {!loading && tab === 'readiness' && <ReadinessTab s={s} />}
        {!loading && tab === 'audit'     && <AuditTab     api={api} />}
      </div>
    </div>
  );
}

// ─── A. Overview ──────────────────────────────────────────────────────────────
function OverviewTab({ s, api }) {
  if (!s) return null;
  const blocks = [
    { id:'B1', label:'Revenue', ok:!s.blockers?.B1_revenue, detail: `${s.revenue?.value_weighted_pct || 0}% value-weighted · CRITICAL ${s.revenue?.critical_approved}/${s.revenue?.critical_total}` },
    { id:'B2', label:'Cost Master', ok:!s.blockers?.B2_cost, detail:`${s.cost?.approved}/${s.cost?.total_branches} branches approved` },
    { id:'B3', label:'Opening BS', ok:!s.blockers?.B3_obs, detail:s.obs?.status },
    { id:'B4', label:'Ind AS 116', ok:!s.blockers?.B4_ind_as_116, detail:`${s.leases?.with_rate}/${s.leases?.total} rates · Blended IBR: ${s.leases?.blended_ibr || 'NOT SET'}` },
  ];
  const warns = [
    { label:'Branch Capacity', detail:`${s.capacity?.approved} approved · ${s.capacity?.proposed} proposed · ${s.capacity?.missing} missing` },
    { label:'Debt Schedule', detail:`${s.debt?.complete}/${s.debt?.total} complete` },
    { label:'GL Mapping', detail:`${s.gl?.pending} pending · ${fmtL(s.gl?.pending_value_lakh)}` },
  ];

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:10, marginBottom:24 }}>
        <StatCard label="Gate Status" value={s.gate} color={s.gate==='GREEN'?'green':s.gate==='AMBER'?'amber':'red'} sub={`${s.hard_blockers} hard blocker${s.hard_blockers!==1?'s':''}`} />
        <StatCard label="Revenue Approved" value={`${s.revenue?.value_weighted_pct || 0}%`} color={s.revenue?.value_weighted_pct >= 95 ? 'green' : 'red'} sub={`${fmtL(s.revenue?.approved_lakh)}/mo`} />
        <StatCard label="Cost Branches" value={`${s.cost?.approved}/${s.cost?.total_branches}`} color={s.cost?.approved > 0 ? 'amber' : 'red'} sub="approved" />
        <StatCard label="OBS" value={s.obs?.status === 'approved' ? 'APPROVED' : 'PENDING'} color={s.obs?.status === 'approved' ? 'green' : 'red'} sub={fmtL(s.obs?.total_assets)} />
        <StatCard label="Audit Entries" value={s.audit_entries || 0} sub="approvals recorded" />
      </div>

      <Section tag="Hard Blockers" title="4 Blockers to Clear Before Draft Baseline">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))', gap:10 }}>
          {blocks.map(b => (
            <div key={b.id} style={{ borderRadius:6, padding:'12px 14px', borderLeft:`4px solid ${b.ok?C.green:C.red}`, background: b.ok?C.greenBg:C.redBg }}>
              <div style={{ fontSize:10, fontWeight:700, letterSpacing:'0.07em', color: b.ok?C.green:C.red, textTransform:'uppercase', marginBottom:4 }}>{b.id} — {b.label}</div>
              <div style={{ fontSize:12, color:C.text2 }}>{b.detail}</div>
              <div style={{ marginTop:6 }}>{b.ok ? pill('CLEARED','green') : pill('BLOCKED','red')}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section tag="Warnings" title="Warnings — Not hard blockers but required for accuracy">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))', gap:10 }}>
          {warns.map(w => (
            <div key={w.label} style={{ borderRadius:6, padding:'12px 14px', borderLeft:`4px solid ${C.amber}`, background:C.amberBg }}>
              <div style={{ fontSize:10, fontWeight:700, letterSpacing:'0.07em', color:C.amber, textTransform:'uppercase', marginBottom:4 }}>{w.label}</div>
              <div style={{ fontSize:12, color:C.text2 }}>{w.detail}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section tag="Stop Condition" title="Active — No automatic progression">
        <InfoBox variant="red">
          <strong>STOP — MANAGEMENT ACTION REQUIRED</strong><br/>
          Draft Baseline V1 will NOT be computed automatically. No data has been modified beyond proposals.<br/>
          Complete all hard blockers in this Approval Center, then check the Readiness tab.<br/>
          Even when gate turns GREEN — DO NOT activate Baseline V1 without explicit CFO authorization.
        </InfoBox>
      </Section>
    </div>
  );
}

// ─── B. Opening BS ────────────────────────────────────────────────────────────
function OBSTab({ s, api }) {
  const [showForm, setShowForm] = useState(false);
  const already = s?.obs?.status === 'approved';
  return (
    <div>
      <Section tag="B3 — Hard Blocker" title="Opening Balance Sheet Approval">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:10, marginBottom:16 }}>
          <StatCard label="Total Assets" value={fmtL(s?.obs?.total_assets)} />
          <StatCard label="Balance Difference" value={fmtL(s?.obs?.diff_lakh)} color={Math.abs(s?.obs?.diff_lakh || 0) < 1 ? 'green' : 'red'} sub="rounding tolerance ₹0.01L" />
          <StatCard label="Approval Status" value={s?.obs?.status || 'pending'} color={already ? 'green' : 'amber'} />
        </div>
        <InfoBox>
          Reconciliation: <strong>ROUNDING_DIFFERENCE</strong> — The ₹{Math.abs(s?.obs?.diff_lakh || 0).toFixed(2)}L difference is within presentation/rounding tolerance.
          Source: Audited Standalone FS FY 2025-26. Do NOT modify the BS to eliminate the rounding difference.
        </InfoBox>
        {already ? (
          <div style={{ marginTop:12 }}><InfoBox variant="green">Opening Balance Sheet APPROVED. B3 blocker cleared.</InfoBox></div>
        ) : (
          <div style={{ marginTop:12 }}>
            <button onClick={() => setShowForm(f => !f)}
              style={{ background:C.green, color:'#000', border:'none', borderRadius:4, padding:'8px 18px', fontSize:12, fontWeight:700, cursor:'pointer' }}>
              APPROVE OPENING BALANCE SHEET
            </button>
            {showForm && (
              <ApprovalForm
                fields={[
                  { key:'approved_by', label:'Approver Name', required:true, placeholder:'e.g. Parthiv Panchal' },
                  { key:'comment', label:'Approval Comment', type:'textarea', default:'Opening Balance Sheet reviewed against audited financial statements. Residual difference of approximately ₹0.01 lakh is considered rounding/presentation difference.' },
                ]}
                submitLabel="CONFIRM — APPROVE OPENING BS"
                onSubmit={async vals => {
                  if (!vals.approved_by?.trim()) return alert('Approver Name is required');
                  await api('/api/fpa/step15/step15f/obs/approve', 'POST', { approved_by: vals.approved_by, comment: vals.comment });
                  setShowForm(false);
                }}
              />
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── C. Revenue ───────────────────────────────────────────────────────────────
function RevenueTab({ s, api }) {
  const [batches, setBatches] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [approver, setApprover] = useState('');
  const [comment, setComment]   = useState('');

  useEffect(() => {
    apiFetch('/api/fpa/step15/step15f/revenue/batches').then(setBatches).catch(console.error);
  }, [s]);

  const approveBatch = async (bk) => {
    if (!approver.trim()) return alert('Approver name required');
    if (!window.confirm(`CONFIRM: Approve all ${batches.batches[bk]?.count} mappings in Batch ${bk}?\nMonthly: ${fmtL(batches.batches[bk]?.monthly_lakh)}\nAnnualised: ${fmtL(batches.batches[bk]?.annual_lakh)}\n\nThis action is recorded in the audit trail.`)) return;
    await api('/api/fpa/step15/step15f/revenue/approve-batch', 'POST', { batch_id:bk, approved_by:approver, comment: comment || `Batch ${bk} approval` });
    apiFetch('/api/fpa/step15/step15f/revenue/batches').then(setBatches);
  };

  const batchColors = { R1:'red', R2:'amber', R3:'grey', R4:'grey', R5:'grey' };
  const coverage = s?.revenue?.value_weighted_pct || 0;

  return (
    <div>
      <Section tag="B1 — Hard Blocker" title="Revenue Approval — Value-Weighted Coverage">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:10, marginBottom:16 }}>
          <StatCard label="Value-Weighted Coverage" value={`${coverage}%`} color={coverage>=95?'green':'red'} sub="Gate: ≥95% required" />
          <StatCard label="Approved / Total" value={`${s?.revenue?.approved_count || 0} / ${s?.revenue?.total_mappings}`} />
          <StatCard label="CRITICAL Resolved" value={`${s?.revenue?.critical_approved}/${s?.revenue?.critical_total}`} color={s?.revenue?.critical_approved===s?.revenue?.critical_total?'green':'red'} sub="must be 100%" />
          <StatCard label="HIGH Resolved" value={`${s?.revenue?.high_approved}/${s?.revenue?.high_total}`} color={s?.revenue?.high_approved===s?.revenue?.high_total?'green':'amber'} sub="must be 100%" />
        </div>

        {/* Coverage bar */}
        <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:6, padding:'12px 16px', marginBottom:16 }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:C.text2, marginBottom:6 }}>
            <span>Value-Weighted Revenue Coverage</span>
            <span style={{ fontFamily:'monospace', color: coverage>=95?C.green:C.red }}>{coverage.toFixed(1)}% of ₹{fmtN(s?.revenue?.total_ref_lakh)}L</span>
          </div>
          <div style={{ height:8, background:C.bg3, borderRadius:99, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${Math.min(coverage,100)}%`, background: coverage>=95?C.green:coverage>=50?C.amber:C.red, borderRadius:99 }} />
          </div>
          <div style={{ marginTop:6, fontSize:11, color:C.text3 }}>Gate requires ≥95%. Gap: {Math.max(0,95-coverage).toFixed(1)}% (₹{(Math.max(0,(95-coverage)/100*(s?.revenue?.total_ref_lakh||0))).toFixed(2)}L/mo)</div>
        </div>

        {/* Approver input */}
        <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
          <input value={approver} onChange={e => setApprover(e.target.value)} placeholder="Your name (for all batch approvals)"
            style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 10px', fontSize:12, flex:1, minWidth:200 }} />
          <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional comment"
            style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 10px', fontSize:12, flex:2, minWidth:200 }} />
        </div>

        <InfoBox variant="amber">
          <strong>NOTE:</strong> All 650 mappings have 1 month of actuals. avg_6m = avg_3m = latest_actual for all. Confidence is LOW across the board.
          CRITICAL (23 mappings) and HIGH (34 mappings) must be individually reviewed before bulk approval.
          Revenue proposals are NEVER auto-approved — explicit CONFIRM APPROVAL required per batch.
        </InfoBox>
      </Section>

      {/* Batch cards */}
      {batches && Object.entries(batches.batches).map(([bk, b]) => {
        const pct = b.approved / Math.max(b.count,1) * 100;
        const isOpen = expanded === bk;
        return (
          <div key={bk} style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:6, marginBottom:10 }}>
            <div style={{ padding:'12px 16px', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
              {pill(bk, batchColors[bk])}
              <span style={{ fontWeight:600, color:C.text, fontSize:13 }}>{b.label}</span>
              <span style={{ fontFamily:'monospace', fontSize:12, color:C.text2 }}>{b.count} mappings</span>
              <span style={{ fontFamily:'monospace', fontSize:12, color:C.blue }}>{fmtL(b.monthly_lakh)}/mo</span>
              <span style={{ fontFamily:'monospace', fontSize:12, color:C.text3 }}>{fmtL(b.annual_lakh)}/yr</span>
              <span style={{ fontFamily:'monospace', fontSize:12, color:C.text3 }}>{b.pct_of_total.toFixed(1)}% of total</span>
              <span style={{ marginLeft:'auto' }}>{b.approved}/{b.count} approved</span>
              <div style={{ width:80, height:6, background:C.bg3, borderRadius:99, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${pct}%`, background:pct>=100?C.green:pct>0?C.amber:C.red, borderRadius:99 }} />
              </div>
              <button onClick={() => setExpanded(isOpen?null:bk)}
                style={{ background:C.bg3, border:`1px solid ${C.border}`, borderRadius:4, color:C.text2, padding:'4px 8px', fontSize:11, cursor:'pointer' }}>
                {isOpen?'Collapse':'Details'}
              </button>
              {b.pending > 0 && (
                <button onClick={() => approveBatch(bk)}
                  style={{ background: bk==='R1'||bk==='R2' ? C.amber : C.green, color:'#000', border:'none', borderRadius:4, padding:'4px 10px', fontSize:11, fontWeight:700, cursor:'pointer' }}>
                  APPROVE BATCH {bk}
                </button>
              )}
              {b.pending === 0 && pill('COMPLETE','green')}
            </div>
            {isOpen && (
              <div style={{ borderTop:`1px solid ${C.border}`, overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                  <thead>
                    <tr style={{ background:C.bg3 }}>
                      <th style={TH}>Branch</th><th style={TH}>Zoho Customer</th><th style={TH}>Materiality</th><th style={TH}>avg_6m (₹)</th><th style={TH}>Months Data</th><th style={TH}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(b.mappings || []).map(m => (
                      <tr key={m.mapping_id} style={{ borderBottom:`1px solid ${C.border}` }}>
                        <td style={TD}>{m.branch_id}</td>
                        <td style={{ ...TD, fontFamily:'monospace' }}>{m.zoho_customer_id}</td>
                        <td style={TD}>{pill(m.materiality, m.materiality==='CRITICAL'?'red':m.materiality==='HIGH'?'amber':'grey')}</td>
                        <td style={{ ...TD, fontFamily:'monospace' }}>₹{(m.avg_6m/100000).toFixed(2)}L</td>
                        <td style={{ ...TD, fontFamily:'monospace' }}>{m.months_with_data}</td>
                        <td style={TD}>{pill(m.status, m.status==='approved'?'green':m.status==='rejected'?'red':'grey')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── D. Cost Master ───────────────────────────────────────────────────────────
function CostTab({ s, api }) {
  const [batches, setBatches] = useState(null);
  const [approver, setApprover] = useState('');

  useEffect(() => {
    apiFetch('/api/fpa/step15/step15f/cost/batches').then(setBatches).catch(console.error);
  }, [s]);

  const approveBranch = async (branch_id) => {
    if (!approver.trim()) return alert('Approver name required');
    if (!window.confirm(`Approve cost assumptions for ${branch_id}?`)) return;
    await api('/api/fpa/step15/step15f/cost/approve', 'POST', { branch_id, action:'approve', approved_by:approver });
    apiFetch('/api/fpa/step15/step15f/cost/batches').then(setBatches);
  };

  const bulkApproveProposed = async () => {
    if (!approver.trim()) return alert('Approver name required');
    const proposed = (batches?.branches || []).filter(b => b.status === 'PROPOSED').map(b => b.branch_id);
    if (!window.confirm(`Bulk approve ${proposed.length} proposed branch cost assumptions?\nTotal proposed: ${fmtL(batches?.summary?.total_proposed_lakh)}/mo\nThis is recorded in the audit trail.`)) return;
    await api('/api/fpa/step15/step15f/cost/bulk-approve', 'POST', { branch_ids: proposed, approved_by: approver, comment: 'Bulk approval of proposed cost assumptions' });
    apiFetch('/api/fpa/step15/step15f/cost/batches').then(setBatches);
  };

  return (
    <div>
      <Section tag="B2 — Hard Blocker" title="Cost Master — Branch Cost Approval">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:10, marginBottom:16 }}>
          <StatCard label="Total Proposed/mo" value={fmtL(batches?.summary?.total_proposed_lakh)} color="blue" />
          <StatCard label="Proposed" value={batches?.summary?.proposed || 0} sub="from 6M bill averages" />
          <StatCard label="Approved" value={batches?.summary?.approved || 0} color={batches?.summary?.approved>0?'green':'red'} />
          <StatCard label="Missing Data" value={batches?.summary?.missing || 0} color={batches?.summary?.missing>0?'amber':'green'} sub="no ref bills available" />
        </div>

        <InfoBox variant="amber">
          Cost proposals are derived from Zoho bills 6M average. Flag potential distortions: advance rent, security deposits coded as expense, annual contracts billed in single months, CAPEX misclassified as opex.
          Review each branch individually for high-variance lines before bulk approval.
        </InfoBox>

        <div style={{ display:'flex', gap:10, marginTop:14, marginBottom:14, flexWrap:'wrap' }}>
          <input value={approver} onChange={e => setApprover(e.target.value)} placeholder="Approver name"
            style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 10px', fontSize:12, flex:1, minWidth:160 }} />
          {(batches?.summary?.proposed || 0) > 0 && (
            <button onClick={bulkApproveProposed}
              style={{ background:C.amber, color:'#000', border:'none', borderRadius:4, padding:'6px 14px', fontSize:12, fontWeight:700, cursor:'pointer' }}>
              BULK APPROVE ALL {batches?.summary?.proposed} PROPOSED
            </button>
          )}
        </div>

        {batches && (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead>
                <tr style={{ background:C.bg3 }}>
                  <th style={TH}>Branch</th><th style={TH}>City</th><th style={TH}>Rent ₹L</th><th style={TH}>Util ₹L</th><th style={TH}>People ₹L</th><th style={TH}>Other ₹L</th><th style={TH}>Total ₹L</th><th style={TH}>Status</th><th style={TH}>Action</th>
                </tr>
              </thead>
              <tbody>
                {(batches.branches || []).map(b => (
                  <tr key={b.branch_id} style={{ borderBottom:`1px solid ${C.border}` }}>
                    <td style={TD}><div style={{ fontSize:11 }}>{b.branch_id}</div><div style={{ fontSize:10, color:C.text3 }}>{b.branch_name}</div></td>
                    <td style={TD}>{b.city}</td>
                    <td style={{ ...TD, fontFamily:'monospace' }}>{b.cost_lines?.rent?.proposed ?? b.ref?.rent ?? '—'}</td>
                    <td style={{ ...TD, fontFamily:'monospace' }}>{b.cost_lines?.utilities?.proposed ?? b.ref?.util ?? '—'}</td>
                    <td style={{ ...TD, fontFamily:'monospace' }}>{b.cost_lines?.people?.proposed ?? b.ref?.people ?? '—'}</td>
                    <td style={{ ...TD, fontFamily:'monospace' }}>{b.cost_lines?.other?.proposed ?? b.ref?.other ?? '—'}</td>
                    <td style={{ ...TD, fontFamily:'monospace' }}><strong>{b.total_proposed_lakh ?? '—'}</strong></td>
                    <td style={TD}>{pill(b.status, b.status==='APPROVED'?'green':b.status==='PROPOSED'?'amber':'red')}</td>
                    <td style={TD}>
                      {b.status === 'PROPOSED' && (
                        <button onClick={() => approveBranch(b.branch_id)}
                          style={{ background:C.green, color:'#000', border:'none', borderRadius:3, padding:'3px 8px', fontSize:10, fontWeight:700, cursor:'pointer' }}>
                          Approve
                        </button>
                      )}
                      {b.status === 'NO_PROPOSAL' && <span style={{ color:C.red, fontSize:10 }}>MGMT INPUT REQ</span>}
                      {b.status === 'APPROVED' && pill('Done','green')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── E. Capacity ──────────────────────────────────────────────────────────────
function CapacityTab({ s, api }) {
  const [branches, setBranches] = useState(null);
  const [approver, setApprover]   = useState('');
  const [inputMode, setInputMode] = useState(null);
  const [manualVals, setManualVals] = useState({});

  useEffect(() => {
    apiFetch('/api/fpa/step15/step15f/cost/batches')
      .then(d => setBranches(d.branches))
      .catch(console.error);
  }, [s]);

  const approveCap = async (branch_id) => {
    if (!approver.trim()) return alert('Approver name required');
    if (!window.confirm(`Approve capacity for ${branch_id}?`)) return;
    await api('/api/fpa/step15/step15f/capacity/approve', 'POST', { branch_id, approved_by: approver });
    apiFetch('/api/fpa/step15/step15f/cost/batches').then(d => setBranches(d.branches));
  };

  return (
    <div>
      <Section tag="E — Amber Warning" title="Branch Capacity — 30 Branches">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:10, marginBottom:16 }}>
          <StatCard label="Proposed (Lease Ref)" value={s?.capacity?.proposed || 0} color="amber" sub="area & seats from lease data" />
          <StatCard label="CFO Approved" value={s?.capacity?.approved || 0} color={s?.capacity?.approved>0?'green':'red'} />
          <StatCard label="Missing Data" value={s?.capacity?.missing || 0} color={s?.capacity?.missing>0?'red':'green'} sub="no ref data — manual entry needed" />
        </div>
        <InfoBox>Seats estimated at 1 seat per 80 sqft. Revenue capacity = 85% of total area. These are REFERENCE PROPOSALS — none are management-approved. BR-AMD-001 area (307K sqft) requires validation against lease documents.</InfoBox>

        <div style={{ marginTop:14, marginBottom:12 }}>
          <input value={approver} onChange={e => setApprover(e.target.value)} placeholder="Approver name"
            style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 10px', fontSize:12, width:240 }} />
        </div>

        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead>
              <tr style={{ background:C.bg3 }}>
                <th style={TH}>Branch</th><th style={TH}>City</th><th style={TH}>Area (sqft)</th><th style={TH}>Rev Capacity</th><th style={TH}>Seats</th><th style={TH}>Source</th><th style={TH}>Capacity Status</th><th style={TH}>Action</th>
              </tr>
            </thead>
            <tbody>
              {(branches || []).map(b => (
                <tr key={b.branch_id} style={{ borderBottom:`1px solid ${C.border}` }}>
                  <td style={TD}><div>{b.branch_id}</div><div style={{ fontSize:10, color:C.text3 }}>{b.branch_name}</div></td>
                  <td style={TD}>{b.city}</td>
                  <td style={{ ...TD, fontFamily:'monospace' }}>{b.has_ref_data ? fmtN(b.ref?.rent && '--') : '—'}</td>
                  <td style={{ ...TD, fontFamily:'monospace' }}>—</td>
                  <td style={{ ...TD, fontFamily:'monospace' }}>—</td>
                  <td style={TD}>{b.has_ref_data ? 'lease_ref' : pill('MISSING','red')}</td>
                  <td style={TD}>{pill(b.status==='APPROVED'?'APPROVED':b.has_ref_data?'PROPOSED':'NO DATA', b.status==='APPROVED'?'green':b.has_ref_data?'amber':'red')}</td>
                  <td style={TD}>
                    {b.has_ref_data && (
                      <button onClick={() => approveCap(b.branch_id)}
                        style={{ background:C.green, color:'#000', border:'none', borderRadius:3, padding:'3px 8px', fontSize:10, fontWeight:700, cursor:'pointer', marginRight:4 }}>
                        Approve
                      </button>
                    )}
                    {!b.has_ref_data && (
                      <button onClick={() => setInputMode(b.branch_id)}
                        style={{ background:C.amber, color:'#000', border:'none', borderRadius:3, padding:'3px 8px', fontSize:10, fontWeight:700, cursor:'pointer' }}>
                        Enter Data
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {inputMode && (
          <div style={{ marginTop:14 }}>
            <div style={{ fontWeight:700, marginBottom:8, color:C.amber }}>Manual Input: {inputMode}</div>
            <ApprovalForm
              fields={[
                { key:'approved_by', label:'Approver Name', required:true },
                { key:'total_area_sqft', label:'Total Area (sqft)', type:'number', required:true },
                { key:'revenue_capacity_sqft', label:'Revenue Capacity (sqft)' },
                { key:'total_seats', label:'Total Seats', type:'number' },
                { key:'opening_date', label:'Opening Date (YYYY-MM-DD)' },
                { key:'comment', label:'Comment', type:'textarea' },
              ]}
              submitLabel="CONFIRM MANUAL INPUT"
              variant="amber"
              onSubmit={async vals => {
                await api('/api/fpa/step15/step15f/capacity/manual-input', 'POST', { branch_id: inputMode, ...vals });
                setInputMode(null);
                apiFetch('/api/fpa/step15/step15f/cost/batches').then(d => setBranches(d.branches));
              }}
            />
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── F. Ind AS 116 ────────────────────────────────────────────────────────────
function LeasesTab({ s, api }) {
  const [pack, setPack]   = useState(null);
  const [method, setMethod] = useState('APPROVE_BLENDED_IBR');
  const [rate, setRate]     = useState('');
  const [approver, setApprover] = useState('');
  const [comment, setComment]   = useState('');

  useEffect(() => {
    apiFetch('/api/fpa/step15/step15f/lease/ibr-pack').then(setPack).catch(console.error);
  }, [s]);

  const submit = async () => {
    if (!approver.trim()) return alert('Approver name required');
    if (method === 'APPROVE_BLENDED_IBR' && !rate) return alert('Blended IBR % required');
    if (!window.confirm(`CONFIRM: Approve IBR methodology: ${method}\nRate: ${rate}%\nThis will apply to ALL 191 leases.\nApprover: ${approver}`)) return;
    await api('/api/fpa/step15/step15f/lease/approve-ibr', 'POST', { method, blended_rate_pct: rate ? Number(rate) : null, approved_by: approver, comment });
  };

  const already = s?.leases?.blended_ibr != null;

  return (
    <div>
      <Section tag="B4 — Hard Blocker" title="Ind AS 116 — Lease Discount Rate (IBR) Decision">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:10, marginBottom:16 }}>
          <StatCard label="Total Leases" value={s?.leases?.total || 0} />
          <StatCard label="Rates Set" value={`${s?.leases?.with_rate || 0}/${s?.leases?.total}`} color={s?.leases?.with_rate===s?.leases?.total?'green':'red'} />
          <StatCard label="Blended IBR" value={s?.leases?.blended_ibr ? `${s.leases.blended_ibr}%` : 'NOT SET'} color={s?.leases?.blended_ibr?'green':'red'} />
          <StatCard label="ROU Asset Balance" value="₹19,225.26L" sub="per audited FS FY26" />
        </div>

        {pack && (
          <div style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:6, padding:14, marginBottom:14 }}>
            <div style={{ fontWeight:600, color:C.text2, marginBottom:10, fontSize:12 }}>Lease Term Distribution (remaining as of today)</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
              {[
                { label:'≤ 1 Year', val: pack.term_distribution?.le_1yr?.count },
                { label:'1–3 Years', val: pack.term_distribution?.gt1_3yr?.count },
                { label:'3–5 Years', val: pack.term_distribution?.gt3_5yr?.count },
                { label:'> 5 Years', val: pack.term_distribution?.gt5yr?.count },
              ].map(b => (
                <div key={b.label} style={{ background:C.bg3, borderRadius:5, padding:'10px 12px', textAlign:'center' }}>
                  <div style={{ fontSize:18, fontWeight:700, fontFamily:'monospace', color:C.blue }}>{b.val}</div>
                  <div style={{ fontSize:10, color:C.text3 }}>{b.label}</div>
                </div>
              ))}
            </div>
            {pack.known_borrowing_rates?.length > 0 && (
              <div style={{ marginTop:12, fontSize:12, color:C.text2 }}>
                <strong>Known Borrowing Rates from Debt Schedule:</strong>{' '}
                {pack.known_borrowing_rates.map(r => `${r.label} @ ${r.rate_pct}%`).join(' · ')}
              </div>
            )}
            <div style={{ marginTop:10, fontSize:11, color:C.amber }}>{pack.recommendation}</div>
          </div>
        )}

        {already ? (
          <InfoBox variant="green">B4 CLEARED — Blended IBR set: {s.leases.blended_ibr}%. Applied to all {s?.leases?.total} leases.</InfoBox>
        ) : (
          <div>
            <InfoBox variant="red">CA INPUT REQUIRED — Do NOT assign arbitrary discount rates. Enter only auditor-confirmed or management-approved IBR.</InfoBox>
            <div style={{ marginTop:14, background:C.bg2, border:`1px solid ${C.border}`, borderRadius:6, padding:16 }}>
              <div style={{ marginBottom:10 }}>
                <label style={{ fontSize:11, fontWeight:600, color:C.text2 }}>Method</label>
                <select value={method} onChange={e => setMethod(e.target.value)}
                  style={{ display:'block', marginTop:4, background:C.bg3, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 8px', fontSize:12, width:'100%' }}>
                  <option value="APPROVE_BLENDED_IBR">APPROVE BLENDED IBR (single rate for all leases)</option>
                  <option value="APPROVE_TERM_BANDED_IBR">APPROVE TERM-BANDED IBR (rates by term band)</option>
                </select>
              </div>
              {method === 'APPROVE_BLENDED_IBR' && (
                <div style={{ marginBottom:10 }}>
                  <label style={{ fontSize:11, fontWeight:600, color:C.text2 }}>Blended IBR % <span style={{ color:C.red }}>*</span></label>
                  <input type="number" step="0.01" value={rate} onChange={e => setRate(e.target.value)} placeholder="e.g. 11.5"
                    style={{ display:'block', marginTop:4, background:C.bg3, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 8px', fontSize:12, width:160 }} />
                  <div style={{ fontSize:10, color:C.text3, marginTop:4 }}>Must be auditor-confirmed Incremental Borrowing Rate</div>
                </div>
              )}
              <div style={{ marginBottom:10 }}>
                <label style={{ fontSize:11, fontWeight:600, color:C.text2 }}>Approver Name <span style={{ color:C.red }}>*</span></label>
                <input value={approver} onChange={e => setApprover(e.target.value)} placeholder="CFO name"
                  style={{ display:'block', marginTop:4, background:C.bg3, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 8px', fontSize:12, width:'100%' }} />
              </div>
              <div style={{ marginBottom:12 }}>
                <label style={{ fontSize:11, fontWeight:600, color:C.text2 }}>Comment</label>
                <textarea rows={2} value={comment} onChange={e => setComment(e.target.value)}
                  style={{ display:'block', marginTop:4, background:C.bg3, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 8px', fontSize:12, width:'100%', resize:'vertical', boxSizing:'border-box' }} />
              </div>
              <button onClick={submit}
                style={{ background:C.amber, color:'#000', border:'none', borderRadius:4, padding:'8px 18px', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                CONFIRM — APPROVE IBR METHODOLOGY
              </button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── G. Debt ──────────────────────────────────────────────────────────────────
function DebtTab({ s }) {
  return (
    <div>
      <Section tag="G — Amber Warning" title="Debt Schedule — 32 Facilities">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:10, marginBottom:16 }}>
          <StatCard label="Total Facilities" value={s?.debt?.total || 32} />
          <StatCard label="Complete" value={s?.debt?.complete || 0} color={s?.debt?.complete===s?.debt?.total?'green':'amber'} sub="with repayment schedules" />
          <StatCard label="BS Gap" value="₹3,185L" color="amber" sub="loan register vs audited BS" />
        </div>
        <InfoBox variant="amber">
          Debt schedule incompleteness is a WARNING, not a hard blocker. Missing schedules → finance cost = ₹0 in draft P&amp;L (understated).
          All 32 facilities are missing: repayment_start_date and emi_lakh. Use the Baseline Closure → Debt Review tab to upload schedules.<br/><br/>
          <strong>DEB-001 (Molkem 2Cr TL):</strong> Opening principal ₹200L @ 15% p.a., maturity 2027-07-15. Missing: repayment start, EMI.<br/>
          <strong>Remaining 31 facilities:</strong> All fields missing — treasury to provide complete loan register.
        </InfoBox>
      </Section>
    </div>
  );
}

// ─── H. GL Mapping ────────────────────────────────────────────────────────────
function GLTab({ s, api }) {
  const [items, setItems] = useState(null);
  const [approver, setApprover] = useState('');

  useEffect(() => {
    apiFetch('/api/fpa/step15/step15f/gl/prioritized').then(setItems).catch(console.error);
  }, [s]);

  const resolve = async (account, action) => {
    if (!approver.trim()) return alert('Approver name required');
    await api('/api/fpa/step15/step15f/gl/resolve', 'POST', { account, action, approved_by: approver });
    apiFetch('/api/fpa/step15/step15f/gl/prioritized').then(setItems);
  };

  return (
    <div>
      <Section tag="H — Amber Warning" title="GL Mapping — ₹837.38L Unresolved">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:10, marginBottom:16 }}>
          <StatCard label="Total GL Items" value={items?.total || 0} />
          <StatCard label="Pending" value={items?.items?.length || 0} color="amber" />
          <StatCard label="Resolved" value={items?.resolved || 0} color="green" />
          <StatCard label="Pending ₹ Value" value={fmtL(items?.pending_value_lakh)} color="amber" />
        </div>
        <div style={{ marginBottom:12 }}>
          <input value={approver} onChange={e => setApprover(e.target.value)} placeholder="Reviewer name"
            style={{ background:C.bg2, border:`1px solid ${C.border}`, borderRadius:4, color:C.text, padding:'6px 10px', fontSize:12, width:200 }} />
        </div>
        {items && (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
              <thead>
                <tr style={{ background:C.bg3 }}>
                  <th style={TH}>Priority</th><th style={TH}>Account</th><th style={TH}>FPA Line</th><th style={TH}>Statement</th><th style={TH}>₹ Value</th><th style={TH}>Cum%</th><th style={TH}>Status</th><th style={TH}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(items.items || []).map(g => (
                  <tr key={g.account} style={{ borderBottom:`1px solid ${C.border}` }}>
                    <td style={TD}>{pill(g.priority?.replace('_',' '), g.priority==='P1_MATERIAL'?'red':g.priority==='P2_MODERATE'?'amber':'grey')}</td>
                    <td style={TD}>{g.account}</td>
                    <td style={{ ...TD, fontFamily:'monospace', fontSize:10 }}>{g.fpa_line}</td>
                    <td style={TD}>{g.statement}</td>
                    <td style={{ ...TD, fontFamily:'monospace' }}>{fmtL(g.value_lakh)}</td>
                    <td style={{ ...TD, fontFamily:'monospace' }}>{g.cum_pct}%</td>
                    <td style={TD}>{pill(g.current_status || 'pending','amber')}</td>
                    <td style={TD}>
                      <div style={{ display:'flex', gap:4 }}>
                        <button onClick={() => resolve(g.account, 'confirm')} style={BtnSmall(C.green)}>CONFIRM</button>
                        <button onClick={() => resolve(g.account, 'n/a')}    style={BtnSmall(C.amber)}>N/A</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── J. Readiness ─────────────────────────────────────────────────────────────
function ReadinessTab({ s }) {
  const [gate, setGate] = useState(null);
  useEffect(() => {
    apiFetch('/api/fpa/step15/step15f/readiness').then(setGate).catch(console.error);
  }, [s]);

  if (!gate) return <div style={{ color:C.text2, fontSize:13 }}>Loading readiness…</div>;
  const gColor = gate.gate === 'GREEN' ? 'green' : gate.gate === 'AMBER' ? 'amber' : 'red';

  return (
    <div>
      <Section tag="J" title="Step 15F Final Readiness Gate">
        <div style={{ background: gate.gate==='GREEN'?C.greenBg:gate.gate==='AMBER'?C.amberBg:C.redBg, border:`2px solid ${gate.gate==='GREEN'?C.greenBorder:gate.gate==='AMBER'?C.amberBorder:C.redBorder}`, borderRadius:8, padding:'16px 20px', marginBottom:20 }}>
          <div style={{ fontFamily:'monospace', fontSize:16, fontWeight:700, color:gate.gate==='GREEN'?C.green:gate.gate==='AMBER'?C.amber:C.red }}>{gate.stop_message}</div>
          <div style={{ marginTop:8, fontSize:12, color:C.text2 }}>Hard blockers remaining: {gate.hard_blockers.join(', ') || 'None'}</div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))', gap:10 }}>
          {Object.entries(gate.modules || {}).map(([key, mod]) => (
            <div key={key} style={{ borderRadius:6, padding:'12px 14px', borderLeft:`4px solid ${mod.green?C.green:C.red}`, background:mod.green?C.greenBg:C.redBg }}>
              <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:mod.green?C.green:C.red, marginBottom:4 }}>{key.replace(/_/g,' ')}</div>
              <div style={{ fontSize:12, color:C.text2 }}>{mod.detail}</div>
              <div style={{ marginTop:6 }}>{mod.green ? pill('CLEARED','green') : pill('BLOCKED','red')}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop:20 }}>
          <InfoBox variant={gate.gate === 'GREEN' ? 'green' : 'red'}>
            {gate.gate === 'GREEN'
              ? 'All prerequisites met. Draft Baseline V1 can be computed. STOP — do not compute automatically. Wait for explicit CFO authorization.'
              : `Gate is ${gate.gate}. ${gate.hard_blockers.length} hard blocker(s) must be resolved: ${gate.hard_blockers.join(', ')}. Return to the relevant tabs to complete approvals.`}
          </InfoBox>
        </div>
      </Section>
    </div>
  );
}

// ─── Audit Trail ─────────────────────────────────────────────────────────────
function AuditTab({ api }) {
  const [trail, setTrail] = useState(null);
  useEffect(() => {
    apiFetch('/api/fpa/step15/step15f/audit-trail').then(setTrail).catch(console.error);
  }, []);

  return (
    <div>
      <Section title="Approval Audit Trail">
        <div style={{ marginBottom:10, fontSize:12, color:C.text2 }}>Total entries: {trail?.total || 0}</div>
        {trail?.entries?.length === 0 && <InfoBox>No approvals recorded yet.</InfoBox>}
        {trail?.entries?.length > 0 && (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
              <thead>
                <tr style={{ background:C.bg3 }}>
                  <th style={TH}>Time</th><th style={TH}>Module</th><th style={TH}>Action</th><th style={TH}>Record</th><th style={TH}>₹ Value</th><th style={TH}>Approved By</th><th style={TH}>Comment</th>
                </tr>
              </thead>
              <tbody>
                {(trail.entries || []).map((e, i) => (
                  <tr key={i} style={{ borderBottom:`1px solid ${C.border}` }}>
                    <td style={{ ...TD, fontFamily:'monospace', fontSize:10 }}>{e.recorded_at?.slice(0,19).replace('T',' ')}</td>
                    <td style={TD}>{pill(e.module,'blue')}</td>
                    <td style={TD}>{e.action}</td>
                    <td style={{ ...TD, fontFamily:'monospace', fontSize:10 }}>{e.record || e.batch_id || e.mapping_id || '—'}</td>
                    <td style={{ ...TD, fontFamily:'monospace' }}>{e.value_lakh != null ? fmtL(e.value_lakh) : '—'}</td>
                    <td style={TD}>{e.approved_by}</td>
                    <td style={{ ...TD, fontSize:10, color:C.text3 }}>{e.comment || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── Style helpers ────────────────────────────────────────────────────────────
const TH = { padding:'7px 10px', fontSize:10, fontWeight:700, letterSpacing:'0.07em', textTransform:'uppercase', color:'#4a5a78', whiteSpace:'nowrap', textAlign:'left', borderBottom:`1px solid #252e44` };
const TD = { padding:'7px 10px', color:'#e2e8f4', verticalAlign:'top' };
const BtnSmall = (bg) => ({ background:bg, color:'#000', border:'none', borderRadius:3, padding:'2px 7px', fontSize:10, fontWeight:700, cursor:'pointer' });
