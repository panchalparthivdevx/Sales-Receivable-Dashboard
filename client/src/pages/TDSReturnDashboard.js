import React, { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  CheckCircle2, AlertTriangle, Clock, Calendar,
  FileText, Download, AlertCircle, Info,
  ShieldCheck, UserX, FileClock, FileCheck2,
} from 'lucide-react';
import KPICard from '../components/KPICard';
import ChartCard from '../components/ChartCard';

// ─── Return type definitions ──────────────────────────────────────────────────
const RETURN_TYPES = [
  { form: '24Q', label: 'Salary (Section 192)',         color: '#8b5cf6', quarters: ['Q1','Q2','Q3','Q4'] },
  { form: '26Q', label: 'Non-Salary (194C/J/H/I/A)',   color: '#3b82f6', quarters: ['Q1','Q2','Q3','Q4'] },
  { form: '27Q', label: 'Non-Residents (Section 195)', color: '#06b6d4', quarters: ['Q1','Q2','Q3','Q4'] },
  { form: '27EQ', label: 'TCS Collections',            color: '#10b981', quarters: ['Q1','Q2','Q3','Q4'] },
];

const QUARTERS = [
  { label: 'Q1', period: 'Apr – Jun', dueFiling: '31 Jul', dueCert: '15 Aug' },
  { label: 'Q2', period: 'Jul – Sep', dueFiling: '31 Oct', dueCert: '15 Nov' },
  { label: 'Q3', period: 'Oct – Dec', dueFiling: '31 Jan', dueCert: '15 Feb' },
  { label: 'Q4', period: 'Jan – Mar', dueFiling: '31 May', dueCert: '30 May' },
];

const FY_OPTIONS = ['FY 2024-25', 'FY 2025-26'];

const EMPTY_QUARTER_BARS = QUARTERS.map(q => ({ name: q.label, returns: 0, corrections: 0 }));

// ─── Reusable: Form badge ─────────────────────────────────────────────────────
function FormBadge({ form }) {
  const meta = RETURN_TYPES.find(r => r.form === form);
  const c = meta?.color || '#64748b';
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700, background: `${c}15`, color: c, border: `1px solid ${c}35`, whiteSpace: 'nowrap' }}>
      {form}
    </span>
  );
}

// ─── Reusable: Filing status badge ───────────────────────────────────────────
const FSTATUS = {
  filed:       { label: 'Filed',        color: '#10b981', Icon: CheckCircle2  },
  pending:     { label: 'Pending',      color: '#f59e0b', Icon: Clock         },
  overdue:     { label: 'Overdue',      color: '#ef4444', Icon: AlertTriangle  },
  correction:  { label: 'Correction',   color: '#f97316', Icon: FileClock     },
  not_due:     { label: 'Not Due',      color: '#9BA8B0', Icon: Calendar      },
};

function FilingBadge({ status }) {
  const m = FSTATUS[status] || { label: status, color: '#64748b', Icon: Info };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 600, background: `${m.color}12`, color: m.color, border: `1px solid ${m.color}30` }}>
      <m.Icon size={10} />
      {m.label}
    </span>
  );
}

// ─── Reusable: Certificate status badge ──────────────────────────────────────
const CSTATUS = {
  issued:  { label: 'Issued',   color: '#10b981' },
  pending: { label: 'Pending',  color: '#f59e0b' },
  overdue: { label: 'Overdue',  color: '#ef4444' },
  na:      { label: 'N/A',      color: '#9BA8B0' },
};
function CertBadge({ status }) {
  const m = CSTATUS[status] || CSTATUS.na;
  return (
    <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 600, background: `${m.color}12`, color: m.color, border: `1px solid ${m.color}30`, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  );
}

// ─── Custom tooltip ──────────────────────────────────────────────────────────
function DarkTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 7, padding: '0.6rem 0.85rem', fontSize: '0.8rem' }}>
      <div style={{ color: '#9BA8B0', marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: 'monospace' }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Compliance card ─────────────────────────────────────────────────────────
function DueCard({ title, desc, dueDate, daysLeft, status }) {
  const urgency = daysLeft <= 0 ? '#ef4444' : daysLeft <= 7 ? '#f97316' : '#1C4942';
  return (
    <div style={{ background: '#FFFFFF', border: `1px solid ${urgency}30`, borderLeft: `3px solid ${urgency}`, borderRadius: 8, padding: '0.85rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ flex: 1 }}>
        <div style={{ color: '#18191B', fontWeight: 600, fontSize: '0.84rem', marginBottom: 3 }}>{title}</div>
        <div style={{ color: '#5D6C7B', fontSize: '0.75rem' }}>{desc}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontFamily: 'monospace', fontWeight: 700, color: urgency, fontSize: '0.85rem' }}>{dueDate}</div>
        <div style={{ color: daysLeft <= 0 ? '#ef4444' : '#5D6C7B', fontSize: '0.7rem', marginTop: 2, fontWeight: daysLeft <= 0 ? 700 : 400 }}>
          {daysLeft <= 0 ? 'Overdue' : `${daysLeft} days left`}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function TDSReturnDashboard() {
  const [tab, setTab]   = useState('overview');
  const [fy,  setFy]    = useState('FY 2025-26');
  const [formFil, setFormFil] = useState('All');

  const TABS = [
    { id: 'overview',   label: '📊 Overview'           },
    { id: 'filing',     label: '📋 Return Filing Status'},
    { id: 'certificates',label:'📄 Form 16A / 16B'     },
    { id: 'corrections',label: '🔄 Corrections'        },
  ];

  const DUE_ITEMS = [
    { title: '26Q — Q1 FY 2025-26', desc: 'Non-salary TDS return (Apr–Jun 2025)',                    dueDate: '31 Jul 2025', daysLeft: 34  },
    { title: '24Q — Q1 FY 2025-26', desc: 'Salary TDS return (Apr–Jun 2025)',                        dueDate: '31 Jul 2025', daysLeft: 34  },
    { title: 'Form 16A — Q4 FY 2024-25', desc: 'Issue TDS certificates to deductees',               dueDate: '15 Jun 2025', daysLeft: -12 },
    { title: '26Q — Q4 FY 2024-25', desc: 'Non-salary TDS return (Jan–Mar 2025) · Last quarter',    dueDate: '31 May 2025', daysLeft: -27 },
    { title: 'Form 16 — FY 2024-25', desc: 'Annual salary TDS certificate to employees',            dueDate: '15 Jun 2025', daysLeft: -12 },
  ];

  return (
    <div style={{ background: '#F9F9F9', minHeight: 'calc(100vh - 105px)', padding: '1.75rem 2rem', fontFamily: "'Figtree','Inter',-apple-system,sans-serif" }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, color: '#18191B', fontSize: '1.1rem', fontWeight: 700 }}>TDS Returns</h2>
          <p style={{ margin: '3px 0 0', color: '#5D6C7B', fontSize: '0.8rem' }}>Quarterly 24Q / 26Q filing, correction statements & Form 16A tracker · {fy}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', background: '#F9F9F9', borderRadius: 8, border: '1px solid #DFE7E3', padding: 3, gap: 2 }}>
            {FY_OPTIONS.map(f => (
              <button key={f} onClick={() => setFy(f)} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: fy === f ? '#1C4942' : 'none', color: fy === f ? '#fff' : '#5D6C7B', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 500, fontFamily: 'inherit' }}>
                {f}
              </button>
            ))}
          </div>
          <button style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, border: '1px solid #DFE7E3', background: '#FFFFFF', color: '#5D6C7B', cursor: 'pointer', fontSize: '0.8rem' }}>
            <Download size={13} /> Export
          </button>
        </div>
      </div>

      {/* Alert banner */}
      <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderLeft: '4px solid #ef4444', borderRadius: 8, padding: '0.65rem 1rem', marginBottom: '1.4rem', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.81rem' }}>
        <AlertTriangle size={15} color="#ef4444" style={{ flexShrink: 0 }} />
        <span style={{ color: '#DC2626', fontWeight: 600 }}>Overdue: </span>
        <span style={{ color: '#DC2626' }}>Form 16A (Q4) and 26Q (Q4) for FY 2024-25 are past due date. Connect data to verify actual status.</span>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.4rem' }}>
        <KPICard title="Returns Filed (FY)"       value="—" subValue="—" subLabel="Out of 4 quarters" icon={FileCheck2}  color="#10b981" />
        <KPICard title="Returns Pending"          value="—" subValue="—" subLabel="This FY"            icon={FileClock}   color="#f59e0b" />
        <KPICard title="Correction Statements"    value="—" subValue="—" subLabel="Filed this FY"      icon={AlertCircle} color="#f97316" />
        <KPICard title="PAN Mismatches"           value="—" subValue="—" subLabel="Needs correction"   icon={UserX}       color="#ef4444" />
        <KPICard title="Form 16A Pending"         value="—" subValue="—" subLabel="To be issued"       icon={FileText}    color="#8b5cf6" />
      </div>

      {/* Card with tabs */}
      <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, overflow: 'hidden' }}>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #DFE7E3', overflowX: 'auto' }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: '0.65rem 1.25rem', border: 'none', cursor: 'pointer', background: tab === t.id ? '#EAF4EF' : 'transparent', color: tab === t.id ? '#1C4942' : '#5D6C7B', fontWeight: tab === t.id ? 700 : 400, fontSize: '0.82rem', borderBottom: tab === t.id ? '2px solid #1C4942' : '2px solid transparent', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Tab: Overview ─────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div style={{ padding: '1.5rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>

              {/* Left: Filing summary by form */}
              <div>
                <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.88rem', marginBottom: '0.75rem' }}>Return Filing Summary — {fy}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  {RETURN_TYPES.map(rt => (
                    <div key={rt.form} style={{ background: '#FFFFFF', border: `1px solid ${rt.color}25`, borderLeft: `3px solid ${rt.color}`, borderRadius: 8, padding: '0.85rem 1rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <FormBadge form={rt.form} />
                          <span style={{ color: '#9BA8B0', fontSize: '0.78rem' }}>{rt.label}</span>
                        </div>
                        <span style={{ color: '#9BA8B0', fontSize: '0.75rem', fontFamily: 'monospace' }}>0/4 filed</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {QUARTERS.map(q => (
                          <div key={q.label} style={{ flex: 1, textAlign: 'center' }}>
                            <div style={{ fontSize: '0.68rem', color: '#5D6C7B', marginBottom: 3 }}>{q.label}</div>
                            <FilingBadge status="pending" />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Right: Due dates + chart */}
              <div>
                <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.88rem', marginBottom: '0.75rem' }}>Upcoming & Overdue Deadlines</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '1.25rem' }}>
                  {DUE_ITEMS.map((d, i) => <DueCard key={i} {...d} />)}
                </div>

                <ChartCard title="Filing Activity by Quarter">
                  <div style={{ color: '#9BA8B0', fontSize: '0.75rem', marginBottom: 6 }}>Connect data to populate</div>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={EMPTY_QUARTER_BARS} barSize={18} barGap={4}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#DFE7E3" />
                      <XAxis dataKey="name" tick={{ fill: '#5D6C7B', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#5D6C7B', fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip content={<DarkTooltip />} />
                      <Bar dataKey="returns"    name="Returns Filed"     fill="#3b82f6" radius={[2,2,0,0]} />
                      <Bar dataKey="corrections"name="Corrections Filed" fill="#f97316" radius={[2,2,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
            </div>
          </div>
        )}

        {/* ── Tab: Return Filing Status ────────────────────────────────────── */}
        {tab === 'filing' && (
          <div style={{ padding: '1.25rem 1.5rem' }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ color: '#5D6C7B', fontSize: '0.8rem' }}>Form:</span>
              <select value={formFil} onChange={e => setFormFil(e.target.value)} style={F.sel}>
                <option value="All">All Forms</option>
                {RETURN_TYPES.map(r => <option key={r.form} value={r.form}>{r.form} — {r.label}</option>)}
              </select>
            </div>

            {/* Filing status table */}
            {RETURN_TYPES.filter(r => formFil === 'All' || r.form === formFil).map(rt => (
              <div key={rt.form} style={{ marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.6rem' }}>
                  <FormBadge form={rt.form} />
                  <span style={{ color: '#9BA8B0', fontSize: '0.82rem', fontWeight: 600 }}>{rt.label}</span>
                </div>
                <div style={{ border: '1px solid #DFE7E3', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={T.table}>
                    <thead><tr>
                      <th style={T.th}>Quarter</th>
                      <th style={T.th}>Period</th>
                      <th style={{ ...T.th, textAlign: 'center' }}>Filing Due</th>
                      <th style={{ ...T.th, textAlign: 'center' }}>Filed On</th>
                      <th style={{ ...T.th, textAlign: 'right' }}>TDS Amount (₹)</th>
                      <th style={{ ...T.th, textAlign: 'center' }}>Deductees</th>
                      <th style={{ ...T.th, textAlign: 'center' }}>PRN / Ack. No.</th>
                      <th style={{ ...T.th, textAlign: 'center' }}>Status</th>
                    </tr></thead>
                    <tbody>
                      {QUARTERS.map((q, i) => (
                        <tr key={q.label} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)' }}>
                          <td style={{ ...T.td, fontWeight: 700, color: '#18191B' }}>{q.label}</td>
                          <td style={{ ...T.td, color: '#5D6C7B', fontSize: '0.8rem' }}>{q.period}</td>
                          <td style={{ ...T.td, textAlign: 'center', fontFamily: 'monospace', fontSize: '0.78rem', color: '#5D6C7B' }}>{q.dueFiling}</td>
                          <td style={{ ...T.td, textAlign: 'center', fontFamily: 'monospace', fontSize: '0.78rem', color: '#5D6C7B' }}>—</td>
                          <td style={{ ...T.td, textAlign: 'right', fontFamily: 'monospace', color: '#9BA8B0' }}>—</td>
                          <td style={{ ...T.td, textAlign: 'center', fontFamily: 'monospace', color: '#5D6C7B' }}>—</td>
                          <td style={{ ...T.td, textAlign: 'center', fontFamily: 'monospace', fontSize: '0.78rem', color: '#9BA8B0' }}>—</td>
                          <td style={{ ...T.td, textAlign: 'center' }}><FilingBadge status="pending" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {/* Late filing penalty reference */}
            <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.85rem 1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <Info size={14} color="#5D6C7B" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: '0.78rem', color: '#5D6C7B', lineHeight: 1.5 }}>
                <strong style={{ color: '#9BA8B0' }}>Late filing fee u/s 234E:</strong> ₹200 per day of default until the return is filed (capped at the TDS amount). A minimum penalty of ₹10,000 may also apply under Section 271H if return is not filed within one year of the due date.
              </div>
            </div>
          </div>
        )}

        {/* ── Tab: Form 16A / 16B ───────────────────────────────────────────── */}
        {tab === 'certificates' && (
          <div style={{ padding: '1.25rem 1.5rem' }}>
            <div style={{ background: '#EAF4EF', border: '1px solid #DFE7E3', borderRadius: 7, padding: '0.65rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.79rem', color: '#1C4942' }}>
              <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Form 16A is issued by us (as deductor) to vendors. It must be generated from TRACES and issued within 15 days after the due date of filing quarterly returns. Form 16 is issued to employees annually.</span>
            </div>

            {/* Quarter-wise certificate tracker */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
              {QUARTERS.map(q => (
                <div key={q.label} style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 9, padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.85rem' }}>{q.label} <span style={{ color: '#5D6C7B', fontWeight: 400, fontSize: '0.78rem' }}>— {q.period}</span></div>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: '#5D6C7B' }}>Due: {q.dueCert}</span>
                  </div>
                  {[
                    { form: 'Form 16A', desc: 'Non-salary deductees (194C/J/H/I)' },
                    { form: 'Form 16',  desc: 'Employees (192 — Q4 only)'          },
                  ].map(f => (
                    <div key={f.form} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem 0', borderBottom: '1px solid #DFE7E3' }}>
                      <div>
                        <div style={{ color: '#9BA8B0', fontSize: '0.8rem', fontWeight: 600 }}>{f.form}</div>
                        <div style={{ color: '#9BA8B0', fontSize: '0.7rem' }}>{f.desc}</div>
                      </div>
                      <CertBadge status={q.label === 'Q4' ? 'overdue' : 'pending'} />
                    </div>
                  ))}
                  <div style={{ marginTop: '0.6rem', display: 'flex', justifyContent: 'space-between', fontSize: '0.76rem' }}>
                    <span style={{ color: '#9BA8B0' }}>Deductees</span>
                    <span style={{ color: '#5D6C7B', fontFamily: 'monospace' }}>—</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Deductee-level table */}
            <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.88rem', marginBottom: '0.6rem' }}>Deductee-wise Certificate Status</div>
            <div style={{ border: '1px solid #DFE7E3', borderRadius: 8, overflow: 'hidden' }}>
              <table style={T.table}>
                <thead><tr>
                  <th style={T.th}>Deductee / Vendor</th>
                  <th style={T.th}>PAN</th>
                  <th style={{ ...T.th, textAlign: 'center' }}>Section</th>
                  <th style={{ ...T.th, textAlign: 'right' }}>Total TDS (₹)</th>
                  <th style={{ ...T.th, textAlign: 'center' }}>Quarters</th>
                  <th style={{ ...T.th, textAlign: 'center' }}>16A Status</th>
                  <th style={{ ...T.th, textAlign: 'center' }}>TRACES</th>
                </tr></thead>
                <tbody>
                  <tr>
                    <td colSpan={7} style={{ ...T.td, textAlign: 'center', color: '#9BA8B0', padding: '2rem', fontSize: '0.82rem' }}>
                      No deductee data available · Connect data source to populate
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Tab: Corrections ─────────────────────────────────────────────── */}
        {tab === 'corrections' && (
          <div style={{ padding: '1.25rem 1.5rem' }}>
            <div style={{ background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 7, padding: '0.65rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.79rem', color: '#fdba74' }}>
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Correction statements are filed on TRACES to rectify errors in original returns (wrong PAN, wrong amount, invalid challans). Each correction increments the statement version (C1, C2, …).</span>
            </div>

            {/* Correction type summary */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
              {[
                { label: 'PAN Corrections',       icon: UserX,      color: '#ef4444', count: '—' },
                { label: 'Challan Corrections',   icon: FileText,   color: '#f97316', count: '—' },
                { label: 'Deductee Corrections',  icon: AlertCircle,color: '#f59e0b', count: '—' },
                { label: 'Salary Corrections',    icon: ShieldCheck,color: '#8b5cf6', count: '—' },
              ].map(c => {
                const Icon = c.icon;
                return (
                  <div key={c.label} style={{ background: `${c.color}08`, border: `1px solid ${c.color}25`, borderRadius: 9, padding: '0.85rem 1rem', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 8, background: `${c.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Icon size={16} color={c.color} />
                    </div>
                    <div>
                      <div style={{ color: c.color, fontWeight: 700, fontFamily: 'monospace', fontSize: '1.1rem' }}>{c.count}</div>
                      <div style={{ color: '#5D6C7B', fontSize: '0.73rem', marginTop: 1 }}>{c.label}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Correction log table */}
            <div style={{ color: '#18191B', fontWeight: 700, fontSize: '0.88rem', marginBottom: '0.6rem' }}>Correction Statement Log</div>
            <div style={{ border: '1px solid #DFE7E3', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={T.table}>
                  <thead><tr>
                    <th style={T.th}>Form</th>
                    <th style={{ ...T.th, textAlign: 'center' }}>Quarter</th>
                    <th style={{ ...T.th, textAlign: 'center' }}>Version</th>
                    <th style={T.th}>Correction Type</th>
                    <th style={T.th}>Description</th>
                    <th style={{ ...T.th, textAlign: 'center' }}>Filed On</th>
                    <th style={{ ...T.th, textAlign: 'center' }}>PRN / Ack.</th>
                    <th style={{ ...T.th, textAlign: 'center' }}>Status</th>
                  </tr></thead>
                  <tbody>
                    <tr>
                      <td colSpan={8} style={{ ...T.td, textAlign: 'center', color: '#9BA8B0', padding: '2rem', fontSize: '0.82rem' }}>
                        No correction statements filed · Connect data source to populate
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Penalty reference footer */}
      <div style={{ marginTop: '1.25rem', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '1rem 1.25rem' }}>
        <div style={{ color: '#9BA8B0', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.6rem' }}>Penalty & Interest Reference</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.5rem' }}>
          {[
            { label: 'Late filing fee (u/s 234E)',         rate: '₹200 / day'      },
            { label: 'Non-filing penalty (u/s 271H)',      rate: '₹10,000 – ₹1L'  },
            { label: 'Wrong PAN in return',                rate: '₹1L penalty'     },
            { label: 'Late Form 16A issuance (u/s 272A)', rate: '₹100 / day'      },
          ].map(r => (
            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.79rem', padding: '0.3rem 0', borderBottom: '1px solid #DFE7E3' }}>
              <span style={{ color: '#5D6C7B' }}>{r.label}</span>
              <span style={{ color: '#ef4444', fontWeight: 600, fontFamily: 'monospace', flexShrink: 0 }}>{r.rate}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Shared table styles ──────────────────────────────────────────────────────
const T = {
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th:    { padding: '0.5rem 1rem', textAlign: 'left', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#9BA8B0', background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' },
  td:    { padding: '0.6rem 1rem', color: '#18191B', borderBottom: '1px solid #DFE7E3', verticalAlign: 'middle' },
};
const F = {
  sel: { background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#9BA8B0', borderRadius: 6, padding: '5px 10px', fontSize: '0.8rem', cursor: 'pointer', outline: 'none', fontFamily: 'inherit' },
};
