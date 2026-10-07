import React, { useEffect, useState, useCallback } from 'react';
import { api, withToken } from '../utils/api';

const BASE = `/api`;

const FIELDS = [
  { key: 'no_of_seats',            label: 'No. of Seats',               type: 'number' },
  { key: 'super_built_up_area',    label: 'Super Built-Up Area (sq ft)', type: 'text'   },
  { key: 'carpet_area',            label: 'Carpet Area (sq ft)',          type: 'text'   },
  { key: 'rate_per_seat',          label: 'Rate per Seat (₹)',            type: 'number' },
  { key: 'amount_excl_gst',        label: 'Amount excl. GST (₹)',         type: 'number' },
  { key: 'start_date',             label: 'Start / Rent Commencement Date', type: 'date' },
  { key: 'end_date',               label: 'End Date',                    type: 'date',  hint: 'Leave blank to auto-calculate from Start + Agreement Term' },
  { key: 'lock_in_date',           label: 'Lock-in Date',                type: 'date',  hint: 'Leave blank to auto-calculate from Start + Lock-in Term' },
  { key: 'agreement_term',         label: 'Agreement Period / Term',     type: 'text',  placeholder: 'e.g. 12 months, 2 years' },
  { key: 'lock_in_term',           label: 'Lock-in Term / Period',       type: 'text',  placeholder: 'e.g. 6 months' },
  { key: 'notice_period',          label: 'Notice Period / Term',        type: 'text',  placeholder: 'e.g. 30 days' },
  { key: 'credit_period',          label: 'Credit Period / Due Date',    type: 'text',  placeholder: 'e.g. 7 days from invoice' },
  { key: 'security_deposit_months',label: 'No. of Months Security Deposit', type: 'number' },
  { key: 'security_deposit_amount',label: 'Security Deposit Amount (₹)', type: 'number' },
  { key: 'interest_rate',          label: 'Interest % on Delay Payment', type: 'text',  placeholder: 'e.g. 18% p.a.' },
  { key: 'annual_increment',       label: 'Annual Increment in Fees',    type: 'text',  placeholder: 'e.g. 5% or ₹500/seat' },
  { key: 'membership_plan',        label: 'Membership Plan / Category',  type: 'text',  placeholder: 'e.g. Dedicated Desk, Private Cabin' },
  { key: 'shift_timing',           label: 'Shift Timing',                type: 'text',  placeholder: 'e.g. 9 AM – 9 PM, 24/7' },
  { key: 'invoicing_legal_name',   label: 'Client Legal Name (Invoicing)', type: 'text' },
  { key: 'gst_number',             label: 'Client GST Number',           type: 'text'   },
  { key: 'billing_address',        label: 'Client Billing Address',      type: 'textarea' },
  { key: 'notes',                  label: 'Notes',                       type: 'textarea' },
];

// Amendment entry fields (subset of main fields)
const AMD_FIELDS = [
  { key: 'amendment_type', label: 'Amendment Type', type: 'text', placeholder: 'e.g. 1st Amendment, Deed of Variation, Renewal' },
  { key: 'amendment_date', label: 'Amendment Date', type: 'date' },
  ...FIELDS.filter(f => !['invoicing_legal_name','gst_number','billing_address','notes'].includes(f.key)),
  { key: 'amendment_notes', label: 'Amendment Notes', type: 'textarea' },
];

function fmt(n) { return n != null ? '₹' + Number(n).toLocaleString('en-IN') : '—'; }
function fmtDate(d) { if (!d) return '—'; const [y,m,day] = d.split('-'); return `${day}/${m}/${y}`; }

function addTerm(startStr, term) {
  if (!startStr || !term) return null;
  const m = String(term).match(/(\d+)\s*(month|year|day)/i);
  if (!m) return null;
  try {
    const d = new Date(startStr);
    if (isNaN(d.getTime())) return null;
    const n = parseInt(m[1]);
    const u = m[2].toLowerCase();
    if (u === 'month') d.setMonth(d.getMonth() + n);
    else if (u === 'year') d.setFullYear(d.getFullYear() + n);
    else d.setDate(d.getDate() + n);
    d.setDate(d.getDate() - 1);
    return d.toISOString().substring(0, 10);
  } catch (_) { return null; }
}

function resolveDate(explicit, start, term) { return explicit || addTerm(start, term) || null; }

// ── Edit Modal ────────────────────────────────────────────────────────────────
function EditModal({ state, branch, client, initial, onSave, onClose }) {
  const [form, setForm] = useState(initial || {});
  const [amendments, setAmendments] = useState(initial?.amendments || []);
  const [saving, setSaving] = useState(false);
  const [amdOpen, setAmdOpen] = useState(null); // index of open amendment form

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const setAmd = (i, k, v) => setAmendments(p => p.map((a, idx) => idx === i ? { ...a, [k]: v } : a));

  const addAmendment = () => setAmendments(p => [...p, { amendment_type: '', amendment_date: '' }]);
  const removeAmendment = (i) => setAmendments(p => p.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    await api.agreementSave({ state, branch, client, data: { ...form, amendments } });
    setSaving(false);
    onSave();
    onClose();
  };

  return (
    <div style={M.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={M.box}>
        <div style={M.header}>
          <div>
            <p style={M.headerSub}>{branch}</p>
            <h3 style={M.headerTitle}>{client}</h3>
          </div>
          <button style={M.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={M.body}>
          {/* Main agreement fields */}
          <p style={M.sectionLabel}>Main Agreement Details</p>
          <div style={M.grid}>
            {FIELDS.map(f => (
              <div key={f.key} style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : {}}>
                <label style={M.label}>{f.label}</label>
                {f.hint && <p style={M.hint}>{f.hint}</p>}
                {f.type === 'textarea'
                  ? <textarea style={M.textarea} rows={2} value={form[f.key] || ''} placeholder={f.placeholder || ''} onChange={e => set(f.key, e.target.value)} />
                  : <input style={M.input} type={f.type || 'text'} value={form[f.key] || ''} placeholder={f.placeholder || ''} onChange={e => set(f.key, e.target.value)} />
                }
              </div>
            ))}
          </div>

          {/* Amendments */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.5rem' }}>
            <p style={M.sectionLabel}>Amendments / Renewals ({amendments.length})</p>
            <button style={M.addAmdBtn} onClick={addAmendment}>+ Add Amendment</button>
          </div>

          {amendments.map((amd, i) => (
            <div key={i} style={M.amdCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                onClick={() => setAmdOpen(amdOpen === i ? null : i)}>
                <span style={{ color: '#94a3b8', fontSize: '0.85rem', fontWeight: 600 }}>
                  {amd.amendment_type || `Amendment ${i + 1}`}
                  {amd.amendment_date ? ` — ${fmtDate(amd.amendment_date)}` : ''}
                </span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <span style={{ color: '#64748b', fontSize: '0.8rem' }}>{amdOpen === i ? '▴' : '▾'}</span>
                  <button style={M.removeBtn} onClick={e => { e.stopPropagation(); removeAmendment(i); }}>✕</button>
                </div>
              </div>
              {amdOpen === i && (
                <div style={{ ...M.grid, marginTop: '0.75rem' }}>
                  {AMD_FIELDS.map(f => (
                    <div key={f.key} style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : {}}>
                      <label style={M.label}>{f.label}</label>
                      {f.type === 'textarea'
                        ? <textarea style={M.textarea} rows={2} value={amd[f.key] || ''} placeholder={f.placeholder || ''} onChange={e => setAmd(i, f.key, e.target.value)} />
                        : <input style={M.input} type={f.type || 'text'} value={amd[f.key] || ''} placeholder={f.placeholder || ''} onChange={e => setAmd(i, f.key, e.target.value)} />
                      }
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={M.footer}>
          <button style={M.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={{ ...M.saveBtn, opacity: saving ? 0.7 : 1 }} disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save Agreement Data'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function AgreementMaster() {
  const [structure, setStructure] = useState(null);
  const [agData, setAgData]       = useState({});
  const [loading, setLoading]     = useState(true);
  const [branch, setBranch]       = useState('All');
  const [search, setSearch]       = useState('');
  const [dateStatus, setDateStatus] = useState('All');
  const [editTarget, setEditTarget] = useState(null); // { state, branch, client }
  const [expanded, setExpanded]   = useState({});
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState(null);
  const [ocring, setOcring] = useState(false);
  const [ocrStatus, setOcrStatus] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.agreementStructure(), api.agreementData()])
      .then(([s, d]) => { setStructure(s); setAgData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const runExtract = () => {
    setExtracting(true);
    setExtractResult(null);
    api.agreementExtract()
      .then(r => { setExtractResult(r); load(); })
      .catch(e => { setExtractResult({ error: e.message }); })
      .finally(() => setExtracting(false));
  };

  const runOcr = () => {
    setOcring(true);
    setOcrStatus({ running: true, done: 0, total: 0 });
    api.agreementOcrExtract().catch(() => {});
    // Poll for progress every 3 seconds
    const poll = setInterval(async () => {
      try {
        const s = await api.agreementOcrStatus();
        setOcrStatus(s);
        if (!s.running) {
          clearInterval(poll);
          setOcring(false);
          load(); // reload data when done
        }
      } catch (_) {}
    }, 3000);
  };

  useEffect(() => { load(); }, [load]);

  // Flatten structure into rows
  const allRows = [];
  if (structure) {
    for (const [br, bData] of Object.entries(structure)) {
      for (const [cl, cData] of Object.entries(bData.clients)) {
        const saved = agData[bData.state]?.[br]?.[cl] || {};
        const endDate    = resolveDate(saved.end_date,     saved.start_date, saved.agreement_term);
        const lockInDate = resolveDate(saved.lock_in_date, saved.start_date, saved.lock_in_term);
        allRows.push({
          state: bData.state, branch: br, client: cl,
          files: cData.files || [],
          saved, endDate, lockInDate,
          amendments: saved.amendments || [],
        });
      }
    }
  }

  const branches = ['All', ...new Set(allRows.map(r => r.branch))];

  const getDateStatus = (endDate) => {
    if (!endDate) return 'none';
    if (endDate < today) return 'Expired';
    const diff = (new Date(endDate) - new Date(today)) / 86400000;
    return diff <= 90 ? 'Expiring Soon' : 'Active';
  };

  const filtered = allRows.filter(r => {
    if (branch !== 'All' && r.branch !== branch) return false;
    if (search && !r.client.toLowerCase().includes(search.toLowerCase())) return false;
    if (dateStatus !== 'All' && getDateStatus(r.endDate) !== dateStatus) return false;
    return true;
  });

  const toggleExpand = (key) => setExpanded(p => ({ ...p, [key]: !p[key] }));
  const hasData = (r) => r.saved && Object.keys(r.saved).length > 0;

  const today = new Date().toISOString().substring(0, 10);
  const statusColor = (d) => {
    if (!d) return '#475569';
    if (d < today) return '#ef4444';
    const diff = (new Date(d) - new Date(today)) / 86400000;
    if (diff <= 90) return '#f59e0b';
    return '#22c55e';
  };

  if (loading) return (
    <div style={S.section}>
      <h3 style={S.title}>Client Agreement Master Report</h3>
      <div style={{ color: '#64748b', padding: '2rem', textAlign: 'center' }}>Loading agreement data…</div>
    </div>
  );

  return (
    <div style={S.section}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <h3 style={S.title}>Client Agreement Master Report</h3>
          <p style={S.sub}>{filtered.length} clients · click a row to expand amendments · click Edit to enter/edit data</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.4rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button style={{ ...S.extractBtn, opacity: extracting ? 0.6 : 1 }} onClick={runExtract} disabled={extracting || ocring}>
              {extracting ? 'Extracting…' : 'Extract (Text PDFs)'}
            </button>
            <button style={{ ...S.ocrBtn, opacity: ocring ? 0.6 : 1 }} onClick={runOcr} disabled={ocring || extracting}>
              {ocring ? `OCR… ${ocrStatus?.done || 0}/${ocrStatus?.total || '?'}` : 'Extract via OCR (Scanned PDFs)'}
            </button>
          </div>
          {extractResult && !extractResult.error && (
            <span style={{ fontSize: '0.72rem', color: '#22c55e' }}>
              Text extract: {extractResult.extracted} extracted · {extractResult.scanned} scanned · {extractResult.errors} errors
            </span>
          )}
          {ocrStatus && !ocrStatus.running && ocrStatus.done > 0 && (
            <span style={{ fontSize: '0.72rem', color: '#a78bfa' }}>
              OCR done: {ocrStatus.log?.filter(l=>l.fields>0).length || 0} clients extracted · {ocrStatus.errors} errors
            </span>
          )}
          {ocring && ocrStatus && (
            <span style={{ fontSize: '0.72rem', color: '#a78bfa' }}>
              OCR running: {ocrStatus.done}/{ocrStatus.total} clients processed…
            </span>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={S.filters}>
        <div style={S.filterGroup}>
          <label style={S.filterLabel}>Branch</label>
          <select style={S.select} value={branch} onChange={e => setBranch(e.target.value)}>
            {branches.map(b => <option key={b}>{b}</option>)}
          </select>
        </div>
        <div style={S.filterGroup}>
          <label style={S.filterLabel}>Search Client</label>
          <input style={S.searchInput} placeholder="Type client name…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={S.filterGroup}>
          <label style={S.filterLabel}>Date Status</label>
          <div style={S.statusBtns}>
            {['All', 'Active', 'Expiring Soon', 'Expired'].map(opt => (
              <button key={opt} style={{ ...S.statusBtn, ...(dateStatus === opt ? S.statusBtnActive(opt) : {}) }}
                onClick={() => setDateStatus(opt)}>
                {opt === 'Active' ? 'Active (>90 days)' : opt === 'Expiring Soon' ? 'Expiring Soon (≤90 days)' : opt}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', color: '#64748b', fontSize: '0.78rem', alignSelf: 'flex-end' }}>
          {filtered.filter(hasData).length} / {filtered.length} records with data entered
        </div>
      </div>

      {/* Table */}
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              {['', 'Branch', 'Client', 'Seats', 'Rate/Seat', 'Amt excl. GST', 'Start Date', 'End Date', 'Lock-in Date', 'Term', 'Lock-in', 'Notice', 'Files', 'Actions'].map(h => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, ri) => {
              const key = `${row.branch}||${row.client}`;
              const isExp = expanded[key];
              const origFiles = row.files.filter(f => !f.is_amendment);
              const amdFiles  = row.files.filter(f => f.is_amendment);
              return (
                <React.Fragment key={key}>
                  {/* Main row */}
                  <tr style={ri % 2 === 0 ? S.trEven : S.trOdd}>
                    <td style={S.td}>
                      {(row.amendments.length > 0 || amdFiles.length > 0) && (
                        <span style={S.expandBtn} onClick={() => toggleExpand(key)}>
                          {isExp ? '▾' : '▸'}
                        </span>
                      )}
                    </td>
                    <td style={S.td}><span style={S.branchBadge}>{row.branch}</span></td>
                    <td style={{ ...S.td, fontWeight: 600, color: '#e2e8f0', maxWidth: 200 }}>{row.client}</td>
                    <td style={S.tdNum}>{row.saved.no_of_seats ?? '—'}</td>
                    <td style={S.tdNum}>{row.saved.rate_per_seat ? fmt(row.saved.rate_per_seat) : '—'}</td>
                    <td style={S.tdNum}>{row.saved.amount_excl_gst ? fmt(row.saved.amount_excl_gst) : '—'}</td>
                    <td style={S.td}>{fmtDate(row.saved.start_date)}</td>
                    <td style={{ ...S.td, color: statusColor(row.endDate) }}>{fmtDate(row.endDate)}</td>
                    <td style={{ ...S.td, color: statusColor(row.lockInDate) }}>{fmtDate(row.lockInDate)}</td>
                    <td style={S.td}>{row.saved.agreement_term || '—'}</td>
                    <td style={S.td}>{row.saved.lock_in_term || '—'}</td>
                    <td style={S.td}>{row.saved.notice_period || '—'}</td>
                    <td style={S.td}>
                      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                        {origFiles.map((f, fi) => (
                          <a key={fi} href={withToken(`${BASE}/agreements/file/${f.url.replace('/api/agreements/file/', '')}`)} target="_blank" rel="noreferrer" style={S.fileLink} title={f.name}>
                            📄
                          </a>
                        ))}
                      </div>
                    </td>
                    <td style={S.td}>
                      <button style={hasData(row) ? S.editBtn : S.addBtn}
                        onClick={() => setEditTarget({ state: row.state, branch: row.branch, client: row.client, initial: row.saved })}>
                        {hasData(row) ? 'Edit' : '+ Add'}
                      </button>
                    </td>
                  </tr>

                  {/* Invoicing / extra detail row (shown when data exists) */}
                  {hasData(row) && (
                    <tr style={{ background: '#0a1628' }}>
                      <td colSpan={14} style={{ padding: '0.35rem 1rem 0.5rem 3.5rem' }}>
                        <div style={S.detailRow}>
                          {row.saved.invoicing_legal_name && <span><b>Legal Name:</b> {row.saved.invoicing_legal_name}</span>}
                          {row.saved.gst_number          && <span><b>GST:</b> {row.saved.gst_number}</span>}
                          {row.saved.membership_plan     && <span><b>Plan:</b> {row.saved.membership_plan}</span>}
                          {row.saved.shift_timing        && <span><b>Shift:</b> {row.saved.shift_timing}</span>}
                          {row.saved.security_deposit_amount && <span><b>Security:</b> {fmt(row.saved.security_deposit_amount)} ({row.saved.security_deposit_months || '—'} mo)</span>}
                          {row.saved.interest_rate       && <span><b>Interest:</b> {row.saved.interest_rate}% p.a.</span>}
                          {row.saved.annual_increment    && <span><b>Increment:</b> {row.saved.annual_increment}</span>}
                          {row.saved.credit_period       && <span><b>Credit:</b> {row.saved.credit_period}</span>}
                          {row.saved.billing_address     && <span><b>Address:</b> {row.saved.billing_address}</span>}
                          {row.saved._extraction_note    && <span style={{ color: '#22c55e', marginLeft: 'auto', fontSize: '0.68rem' }}>
                            {row.saved._extraction_note}
                          </span>}
                          {row.saved._extraction_note?.includes('scanned') && <span style={{ color: '#f59e0b', marginLeft: 'auto', fontSize: '0.68rem' }}>
                            ⚠ {row.saved._extraction_note}
                          </span>}
                        </div>
                      </td>
                    </tr>
                  )}

                  {/* Amendment sub-rows */}
                  {isExp && (
                    <>
                      {/* Amendment data rows */}
                      {row.amendments.map((amd, ai) => {
                        const aEndDate    = resolveDate(amd.end_date,     amd.start_date || row.saved.start_date, amd.agreement_term);
                        const aLockInDate = resolveDate(amd.lock_in_date, amd.start_date || row.saved.start_date, amd.lock_in_term);
                        return (
                          <tr key={ai} style={{ background: '#0f1f38', borderLeft: '3px solid #3b82f6' }}>
                            <td style={S.td}></td>
                            <td style={{ ...S.td, color: '#3b82f6', fontSize: '0.75rem', paddingLeft: '2rem' }} colSpan={2}>
                              ↳ {amd.amendment_type || `Amendment ${ai + 1}`}
                              {amd.amendment_date ? ` (${fmtDate(amd.amendment_date)})` : ''}
                            </td>
                            <td style={S.tdNum}>{amd.no_of_seats ?? '—'}</td>
                            <td style={S.tdNum}>{amd.rate_per_seat ? fmt(amd.rate_per_seat) : '—'}</td>
                            <td style={S.tdNum}>{amd.amount_excl_gst ? fmt(amd.amount_excl_gst) : '—'}</td>
                            <td style={S.td}>{fmtDate(amd.start_date)}</td>
                            <td style={{ ...S.td, color: statusColor(aEndDate) }}>{fmtDate(aEndDate)}</td>
                            <td style={{ ...S.td, color: statusColor(aLockInDate) }}>{fmtDate(aLockInDate)}</td>
                            <td style={S.td}>{amd.agreement_term || '—'}</td>
                            <td style={S.td}>{amd.lock_in_term || '—'}</td>
                            <td style={S.td}>{amd.notice_period || '—'}</td>
                            <td style={S.td} colSpan={2}>
                              {amd.amendment_notes && <span style={{ color: '#64748b', fontSize: '0.75rem' }}>{amd.amendment_notes}</span>}
                            </td>
                          </tr>
                        );
                      })}
                      {/* Amendment files from folder */}
                      {amdFiles.length > 0 && (
                        <tr style={{ background: '#0a1628' }}>
                          <td colSpan={14} style={{ padding: '0.35rem 1rem 0.5rem 3.5rem' }}>
                            <span style={{ color: '#64748b', fontSize: '0.75rem', marginRight: '0.5rem' }}>Amendment files:</span>
                            {amdFiles.map((f, fi) => (
                              <a key={fi} href={withToken(`${BASE}/agreements/file/${f.url.replace('/api/agreements/file/', '')}`)} target="_blank" rel="noreferrer" style={S.amdFileLink} title={f.name}>
                                📄 {f.name}
                              </a>
                            ))}
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div style={S.legend}>
        <span style={S.legendTitle}>Date Status:</span>
        {[['#22c55e','Active (>90 days)'],['#f59e0b','Expiring soon (≤90 days)'],['#ef4444','Expired']].map(([c,l]) => (
          <span key={l} style={{ display:'flex', alignItems:'center', gap:'0.3rem', color:'#94a3b8', fontSize:'0.75rem' }}>
            <span style={{ width:8, height:8, borderRadius:'50%', background:c, flexShrink:0 }} />{l}
          </span>
        ))}
      </div>

      {/* Edit Modal */}
      {editTarget && (
        <EditModal
          state={editTarget.state}
          branch={editTarget.branch}
          client={editTarget.client}
          initial={editTarget.initial}
          onSave={load}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}

const S = {
  section: { background: '#1e293b', borderRadius: '10px', border: '1px solid #334155', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' },
  title: { margin: 0, color: '#f1f5f9', fontSize: '0.95rem', fontWeight: 600 },
  sub: { margin: '4px 0 0', color: '#64748b', fontSize: '0.78rem' },
  filters: { display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' },
  filterGroup: { display: 'flex', flexDirection: 'column', gap: '0.3rem' },
  filterLabel: { color: '#64748b', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase' },
  select: { background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '0.4rem 0.7rem', borderRadius: 6, fontSize: '0.83rem', cursor: 'pointer' },
  searchInput: { background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '0.4rem 0.7rem', borderRadius: 6, fontSize: '0.83rem', width: 220 },
  tableWrap: { overflowX: 'auto', borderRadius: 8, border: '1px solid #334155' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
  th: { padding: '0.55rem 0.75rem', textAlign: 'left', color: '#94a3b8', fontWeight: 600, fontSize: '0.72rem', background: '#0f172a', borderBottom: '1px solid #334155', whiteSpace: 'nowrap' },
  td: { padding: '0.5rem 0.75rem', color: '#cbd5e1', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  tdNum: { padding: '0.5rem 0.75rem', textAlign: 'right', color: '#cbd5e1', verticalAlign: 'middle' },
  trEven: { background: '#0f172a' },
  trOdd: { background: '#1a2540' },
  expandBtn: { cursor: 'pointer', color: '#64748b', fontSize: '0.7rem', userSelect: 'none' },
  branchBadge: { background: '#1e3a5f', color: '#60a5fa', padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap' },
  fileLink: { display: 'inline-block', fontSize: '1rem', textDecoration: 'none', cursor: 'pointer', title: 'View agreement' },
  amdFileLink: { display: 'inline-block', marginRight: '0.75rem', color: '#3b82f6', fontSize: '0.75rem', textDecoration: 'none', cursor: 'pointer' },
  editBtn: { background: '#334155', border: 'none', color: '#94a3b8', padding: '3px 10px', borderRadius: 5, fontSize: '0.75rem', cursor: 'pointer' },
  addBtn:  { background: '#1e3a5f', border: 'none', color: '#60a5fa', padding: '3px 10px', borderRadius: 5, fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 },
  extractBtn: { background: '#0f2d1f', border: '1px solid #22c55e', color: '#22c55e', padding: '0.4rem 1rem', borderRadius: 6, fontSize: '0.82rem', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' },
  ocrBtn: { background: '#1a0f2e', border: '1px solid #a78bfa', color: '#a78bfa', padding: '0.4rem 1rem', borderRadius: 6, fontSize: '0.82rem', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' },
  statusBtns: { display: 'flex', gap: '0.35rem' },
  statusBtn: { background: '#0f172a', border: '1px solid #334155', color: '#64748b', padding: '0.35rem 0.7rem', borderRadius: 6, fontSize: '0.78rem', cursor: 'pointer', whiteSpace: 'nowrap' },
  statusBtnActive: (opt) => ({
    background: opt === 'Active' ? '#052e16' : opt === 'Expiring Soon' ? '#2d1b00' : opt === 'Expired' ? '#2d0a0a' : '#1e3a5f',
    border: `1px solid ${opt === 'Active' ? '#22c55e' : opt === 'Expiring Soon' ? '#f59e0b' : opt === 'Expired' ? '#ef4444' : '#60a5fa'}`,
    color: opt === 'Active' ? '#22c55e' : opt === 'Expiring Soon' ? '#f59e0b' : opt === 'Expired' ? '#ef4444' : '#60a5fa',
    fontWeight: 600,
  }),
  detailRow: { display: 'flex', flexWrap: 'wrap', gap: '1rem', color: '#64748b', fontSize: '0.75rem' },
  legend: { display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid #1e293b' },
  legendTitle: { color: '#64748b', fontSize: '0.75rem', fontWeight: 600 },
};

const M = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '2rem', overflowY: 'auto' },
  box: { background: '#1e293b', border: '1px solid #334155', borderRadius: 12, width: '100%', maxWidth: 820, display: 'flex', flexDirection: 'column', maxHeight: '90vh' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '1.25rem 1.5rem', borderBottom: '1px solid #334155' },
  headerSub: { margin: 0, color: '#64748b', fontSize: '0.75rem' },
  headerTitle: { margin: '4px 0 0', color: '#f1f5f9', fontSize: '1rem', fontWeight: 600 },
  closeBtn: { background: 'none', border: 'none', color: '#64748b', fontSize: '1.1rem', cursor: 'pointer', padding: '0.25rem' },
  body: { flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem' },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.5rem', borderTop: '1px solid #334155' },
  sectionLabel: { margin: '0 0 0.75rem', color: '#3b82f6', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' },
  label: { display: 'block', color: '#94a3b8', fontSize: '0.72rem', fontWeight: 600, marginBottom: '0.25rem' },
  hint: { margin: '-0.1rem 0 0.25rem', color: '#475569', fontSize: '0.68rem' },
  input: { width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '0.45rem 0.65rem', borderRadius: 6, fontSize: '0.83rem', boxSizing: 'border-box' },
  textarea: { width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '0.45rem 0.65rem', borderRadius: 6, fontSize: '0.83rem', resize: 'vertical', boxSizing: 'border-box' },
  addAmdBtn: { background: '#1e3a5f', border: '1px solid #3b82f6', color: '#60a5fa', padding: '4px 12px', borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer' },
  amdCard: { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '0.5rem' },
  removeBtn: { background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.8rem', padding: '0 4px' },
  cancelBtn: { background: '#334155', border: 'none', color: '#94a3b8', padding: '0.5rem 1.25rem', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' },
  saveBtn: { background: '#3b82f6', border: 'none', color: '#fff', padding: '0.5rem 1.5rem', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 },
};
