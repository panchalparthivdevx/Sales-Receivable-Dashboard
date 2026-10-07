import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, withToken, stageUploads } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = `/api`;

const BILL_TYPES = [
  { value: 'project_bill',   label: 'Project Bill' },
  { value: 'recurring_bill', label: 'Recurring Bill' },
  { value: 'broker_bill',    label: 'Broker Bill' },
];

const RECURRING_TYPES = [
  { value: 'internet',     label: 'Internet Bill' },
  { value: 'electricity',  label: 'Electricity Bill' },
  { value: 'housekeeping', label: 'Housekeeping Bill' },
  { value: 'hk_material',  label: 'Housekeeping Material Bill' },
  { value: 'tc_machine',   label: 'Tea & Coffee Machine Bill' },
  { value: 'tc_coffee',    label: 'Tea & Coffee Bill' },
  { value: 'gardner',      label: 'Gardner Bill' },
  { value: 'plumber',      label: 'Plumber Bill' },
  { value: 'electrician',  label: 'Electrician Bill' },
  { value: 'repairs',      label: 'Repairs & Maintenance Bill' },
  { value: 'others',       label: 'Others (Please specify)' },
];

const REQUEST_TYPES = [
  { value: 'security_deposit_pay',    label: 'Request for Security Deposit Pay to Developer' },
  { value: 'balance_vendor',          label: 'Balance Confirmation to Vendor' },
  { value: 'balance_customer',        label: 'Balance Confirmation to Customer' },
  { value: 'security_deposit_refund', label: 'Request for Security Deposit Refund to Customer' },
  { value: 'vendor_payment',          label: 'Request for Payment' },
];

const VENDOR_CATEGORIES = [
  'Landlord', 'Recurring', 'Project Vendor', 'IT Related Vendors',
  'Maintenance Vendor', 'AMC (Annual Maintenance Contract)', 'Brokerage',
  'Insurance', 'Professional/Consultancy Service', 'Electricity', 'Others',
];

const INIT_FORM = {
  submission_type: '', bill_type: '', recurring_type: '', others_mention: '',
  request_type: '', vendor_name: '', bill_date: '', bill_amount: '',
  project_name: '', broker_name: '', client_name: '',
  property_city: '', property_address: '', developer_name: '',
  sqft: '', months_security: '', month_deposit_amt: '', total_deposit_amt: '',
  company_name: '', customer_name: '', refund_amount: '', expected_date: '',
  vendor_category: '', payment_source: '', zoho_doc_type: '',
  zoho_vendor_id: '', zoho_vendor_name: '', zoho_doc_id: '', zoho_doc_number: '',
  payment_amount: '',
};

// ── Styles ────────────────────────────────────────────────────────────────────

const S = {
  page:       { padding: '1.5rem', maxWidth: 1200, margin: '0 auto' },
  hdr:        { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' },
  title:      { fontSize: '1.25rem', fontWeight: 700, color: '#18191B', margin: 0 },
  sub:        { fontSize: '0.78rem', color: '#5D6C7B', marginTop: 3 },
  tabs:       { display: 'flex', gap: 4, marginBottom: '1.5rem', borderBottom: '1px solid #DFE7E3' },
  tab:        (a) => ({ padding: '0.5rem 1.25rem', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.85rem', fontWeight: a ? 600 : 400, color: a ? '#1C4942' : '#5D6C7B', borderBottom: a ? '2px solid #1C4942' : '2px solid transparent', marginBottom: -1 }),
  card:       { background: '#FFFFFF', borderRadius: 12, padding: '1.5rem', marginBottom: '1.5rem' },
  cardSm:     { background: '#F9F9F9', borderRadius: 10, padding: '1rem', marginBottom: '1rem' },
  secLabel:   { fontSize: '0.68rem', fontWeight: 700, color: '#5D6C7B', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.85rem' },
  grid2:      { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' },
  grid3:      { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 },
  fg:         { display: 'flex', flexDirection: 'column', gap: 4 },
  lbl:        { fontSize: '0.73rem', fontWeight: 500, color: '#9BA8B0' },
  req:        { color: '#DC2626', marginLeft: 2 },
  inp:        { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, color: '#18191B', padding: '0.5rem 0.75rem', fontSize: '0.83rem', outline: 'none', width: '100%', boxSizing: 'border-box' },
  sel:        { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, color: '#18191B', padding: '0.5rem 0.75rem', fontSize: '0.83rem', outline: 'none', width: '100%', boxSizing: 'border-box' },
  ro:         { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 8, color: '#5D6C7B', padding: '0.5rem 0.75rem', fontSize: '0.83rem', outline: 'none', width: '100%', boxSizing: 'border-box' },
  fileBox:    { border: '1px dashed #DFE7E3', borderRadius: 8, padding: '0.65rem 0.75rem', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: '#FFFFFF' },
  divider:    { height: 1, background: '#DFE7E3', margin: '1.25rem 0' },
  btnPrimary: { background: '#1C4942', color: '#fff', border: 'none', borderRadius: 8, padding: '0.6rem 1.5rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' },
  btnSec:     { background: 'transparent', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.55rem 1.1rem', fontSize: '0.82rem', cursor: 'pointer' },
  btnSm:      (color) => ({ background: 'transparent', color, border: `1px solid ${color}40`, borderRadius: 6, padding: '3px 10px', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer', opacity: 0.9 }),
  table:      { width: '100%', borderCollapse: 'collapse' },
  th:         { textAlign: 'left', padding: '0.5rem 0.75rem', fontSize: '0.68rem', color: '#5D6C7B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid #DFE7E3' },
  td:         { padding: '0.7rem 0.75rem', fontSize: '0.8rem', color: '#18191B', borderBottom: '1px solid #DFE7E3', verticalAlign: 'middle' },
  badge:      (s) => {
    const m = { pending: ['#451a03','#fbbf24'], in_progress: ['#0c1a3a','#60a5fa'], completed: ['#052e16','#34d399'], rejected: ['#450a0a','#f87171'] };
    const [bg, c] = m[s] || ['#FFFFFF','#9BA8B0'];
    return { background: bg, color: c, borderRadius: 20, padding: '2px 10px', fontSize: '0.68rem', fontWeight: 700, whiteSpace: 'nowrap' };
  },
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '2rem 1rem', overflowY: 'auto' },
  modal:      { background: '#FFFFFF', borderRadius: 14, padding: '1.75rem', maxWidth: 680, width: '100%', position: 'relative', marginTop: 'auto', marginBottom: 'auto' },
  typeBtn:    (a) => ({ padding: '0.75rem 1rem', borderRadius: 10, border: `2px solid ${a ? '#1C4942' : '#DFE7E3'}`, background: a ? '#EAF4EF' : '#FFFFFF', cursor: 'pointer', flex: 1, textAlign: 'center' }),
  typeBtnLbl: (a) => ({ fontSize: '0.82rem', fontWeight: 600, color: a ? '#1C4942' : '#9BA8B0', margin: 0 }),
  alert:      (type) => ({ background: type === 'success' ? '#EAF4EF' : '#FEF2F2', border: `1px solid ${type === 'success' ? '#A7C4BC' : '#DC2626'}`, color: type === 'success' ? '#15803D' : '#DC2626', borderRadius: 8, padding: '0.65rem 1rem', fontSize: '0.82rem', marginBottom: '1rem' }),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}
function fmtAmt(n) {
  return n ? '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—';
}
function typeLabel(s) {
  if (s.submission_type === 'tax_bill') {
    const bt = BILL_TYPES.find(b => b.value === s.bill_type)?.label || s.bill_type;
    const rt = s.bill_type === 'recurring_bill' ? ` → ${RECURRING_TYPES.find(r => r.value === s.recurring_type)?.label || s.recurring_type}` : '';
    return `Tax Bill · ${bt}${rt}`;
  }
  if (s.submission_type === 'request') {
    return `Request · ${REQUEST_TYPES.find(r => r.value === s.request_type)?.label || s.request_type}`;
  }
  return '—';
}
function keyDetail(s) {
  if (s.submission_type === 'tax_bill') return [s.vendor_name, s.bill_date ? fmtDate(s.bill_date) : '', s.bill_amount ? fmtAmt(s.bill_amount) : ''].filter(Boolean).join(' · ');
  if (s.request_type === 'security_deposit_pay') return `${s.developer_name || ''} · ${s.property_city || ''} · ${fmtAmt(s.total_deposit_amt)}`;
  if (s.request_type === 'balance_vendor')   return `${s.company_name || ''} · ${s.vendor_name || ''}`;
  if (s.request_type === 'balance_customer') return `${s.company_name || ''} · ${s.customer_name || ''}`;
  if (s.request_type === 'security_deposit_refund') return `${s.customer_name || ''} · ${fmtAmt(s.refund_amount)}`;
  if (s.request_type === 'vendor_payment')   return `${s.vendor_name || s.zoho_vendor_name || ''} · ${fmtAmt(s.payment_amount)}`;
  return '—';
}

// ── Field wrapper ──────────────────────────────────────────────────────────────

function Fl({ label, required, children, span }) {
  return (
    <div style={{ ...S.fg, gridColumn: span ? `span ${span}` : undefined }}>
      <label style={S.lbl}>{label}{required && <span style={S.req}>*</span>}</label>
      {children}
    </div>
  );
}

// ── Detail Modal ──────────────────────────────────────────────────────────────

function DetailModal({ sub, onClose, onUpdate, isAdmin }) {
  const [notes, setNotes]     = useState(sub.notes || '');
  const [busy, setBusy]       = useState(false);
  const [msg, setMsg]         = useState('');
  const { user }              = useAuth();

  async function action(status) {
    setBusy(true);
    try {
      await api.portalUpdate(sub.id, {
        status,
        notes,
        confirmed_by: user.username,
        confirmed_by_name: user.name || user.username,
      });
      setMsg('Updated successfully');
      setTimeout(() => { onUpdate(); onClose(); }, 800);
    } catch (e) {
      setMsg('Error: ' + (e.response?.data?.error || e.message));
    } finally { setBusy(false); }
  }

  const Row = ({ l, v }) => v && String(v) !== '0' ? (
    <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: '0.73rem', color: '#5D6C7B', minWidth: 170 }}>{l}</span>
      <span style={{ fontSize: '0.8rem', color: '#18191B' }}>{v}</span>
    </div>
  ) : null;

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#18191B' }}>{sub.id}</div>
            <div style={{ fontSize: '0.75rem', color: '#5D6C7B', marginTop: 2 }}>{typeLabel(sub)}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={S.badge(sub.status)}>{sub.status?.replace('_', ' ').toUpperCase()}</span>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>×</button>
          </div>
        </div>

        {msg && <div style={S.alert(msg.startsWith('Error') ? 'error' : 'success')}>{msg}</div>}

        <div style={S.cardSm}>
          <div style={S.secLabel}>Submission Details</div>
          <Row l="Submitted By"    v={sub.submitted_by_name || sub.submitted_by} />
          <Row l="Submitted At"    v={fmtDate(sub.submitted_at) + ' ' + (sub.submitted_at ? new Date(sub.submitted_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '')} />
          <Row l="Vendor Name"     v={sub.vendor_name} />
          <Row l="Bill Date"       v={sub.bill_date ? fmtDate(sub.bill_date) : ''} />
          <Row l="Bill Amount"     v={sub.bill_amount ? fmtAmt(sub.bill_amount) : ''} />
          <Row l="Project Name"    v={sub.project_name} />
          <Row l="Broker Name"     v={sub.broker_name} />
          <Row l="Client Name"     v={sub.client_name} />
          {sub.recurring_type === 'others' && <Row l="Others (specify)" v={sub.others_mention} />}
          <Row l="Property City"   v={sub.property_city} />
          <Row l="Property Address" v={sub.property_address} />
          <Row l="Developer/Owner" v={sub.developer_name} />
          <Row l="Sqft"            v={sub.sqft ? String(sub.sqft) : ''} />
          <Row l="Months SD"       v={sub.months_security ? String(sub.months_security) : ''} />
          <Row l="One Month SD Amt" v={sub.month_deposit_amt ? fmtAmt(sub.month_deposit_amt) : ''} />
          <Row l="Total SD Amount" v={sub.total_deposit_amt ? fmtAmt(sub.total_deposit_amt) : ''} />
          <Row l="Company Name"    v={sub.company_name} />
          <Row l="Customer Name"   v={sub.customer_name} />
          <Row l="Refund Amount"   v={sub.refund_amount ? fmtAmt(sub.refund_amount) : ''} />
          <Row l="Expected Date"   v={sub.expected_date ? fmtDate(sub.expected_date) : ''} />
          <Row l="Vendor Category" v={sub.vendor_category} />
          <Row l="Payment Source"  v={sub.payment_source === 'zoho' ? 'Fetch from Zoho Books' : sub.payment_source === 'upload' ? 'I have Bill/PO' : sub.payment_source} />
          <Row l="Zoho Vendor"     v={sub.zoho_vendor_name} />
          <Row l="Doc Type"        v={sub.zoho_doc_type === 'purchase_order' ? 'Purchase Order' : sub.zoho_doc_type === 'bill' ? 'Bill' : ''} />
          <Row l="Doc #"           v={sub.zoho_doc_number} />
          <Row l="Payment Amount"  v={sub.payment_amount ? fmtAmt(sub.payment_amount) : ''} />
        </div>

        {sub.files && sub.files.length > 0 && (
          <div style={{ ...S.cardSm, marginTop: '0.75rem' }}>
            <div style={S.secLabel}>Attachments</div>
            {sub.files.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: '0.75rem', color: '#9BA8B0', flex: 1 }}>{f.original || f.filename}</span>
                <a
                  href={withToken(`${BASE}/portal/file/${sub.id}/${encodeURIComponent(f.filename)}`)}
                  target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: '0.72rem', color: '#1C4942', textDecoration: 'none', background: '#EAF4EF', padding: '2px 8px', borderRadius: 4 }}
                >View</a>
                <a
                  href={withToken(`${BASE}/portal/file/${sub.id}/${encodeURIComponent(f.filename)}`)}
                  download={f.original || f.filename}
                  style={{ fontSize: '0.72rem', color: '#15803D', textDecoration: 'none', background: '#EAF4EF', padding: '2px 8px', borderRadius: 4 }}
                >Download</a>
              </div>
            ))}
          </div>
        )}

        {sub.confirmed_by && (
          <div style={{ ...S.cardSm, marginTop: '0.75rem' }}>
            <div style={S.secLabel}>Accounts Team</div>
            <Row l="Assigned To"   v={sub.assigned_to} />
            <Row l="Confirmed By"  v={sub.confirmed_by_name || sub.confirmed_by} />
            <Row l="Confirmed At"  v={sub.confirmed_at ? fmtDate(sub.confirmed_at) : ''} />
            <Row l="Notes"         v={sub.notes} />
          </div>
        )}

        {isAdmin && !['completed', 'rejected'].includes(sub.status) && (
          <div style={{ marginTop: '1.25rem' }}>
            <div style={S.secLabel}>Accounts Team Action</div>
            <div style={{ ...S.fg, marginBottom: 12 }}>
              <label style={S.lbl}>Notes / Remarks</label>
              <textarea
                rows={3}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Add notes for this request..."
                style={{ ...S.inp, resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {sub.status === 'pending' && (
                <button onClick={() => action('in_progress')} disabled={busy} style={{ ...S.btnSm('#1C4942'), padding: '6px 16px', fontSize: '0.8rem' }}>
                  Mark In Progress
                </button>
              )}
              <button onClick={() => action('completed')} disabled={busy} style={{ ...S.btnSm('#15803D'), padding: '6px 16px', fontSize: '0.8rem' }}>
                Mark as Booked / Completed
              </button>
              <button onClick={() => action('rejected')} disabled={busy} style={{ ...S.btnSm('#DC2626'), padding: '6px 16px', fontSize: '0.8rem' }}>
                Reject
              </button>
            </div>
          </div>
        )}

        {isAdmin && ['completed', 'rejected'].includes(sub.status) && (
          <div style={{ marginTop: '1.25rem' }}>
            <div style={S.secLabel}>Re-open</div>
            <button onClick={() => action('pending')} disabled={busy} style={{ ...S.btnSm('#B45309'), padding: '6px 16px', fontSize: '0.8rem' }}>
              Reopen as Pending
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function FinancePortal() {
  const { user }                      = useAuth();
  const isAdmin                       = user?.role === 'admin';

  const [tab, setTab]                 = useState('list');
  const [form, setForm]               = useState(INIT_FORM);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading]         = useState(false);
  const [submitting, setSubmitting]   = useState(false);
  const [filterStatus, setFilter]     = useState('all');
  const [selected, setSelected]       = useState(null);
  const [msg, setMsg]                 = useState(null); // { type, text }

  // Zoho vendor state (for payment request)
  const [zohoVendors, setZohoVendors]   = useState([]);
  const [vendorSearch, setVendorSearch] = useState('');
  const [zohoDocs, setZohoDocs]         = useState([]);
  const [zohoLoading, setZohoLoading]   = useState(false);

  // File refs
  const billFileRef      = useRef();
  const loiFileRef       = useRef();
  const stmtFileRef      = useRef();
  const payFileRef       = useRef();

  // Selected file names for display
  const [fileNames, setFileNames] = useState({});

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Auto-calc total SD
  useEffect(() => {
    const m   = parseFloat(form.months_security) || 0;
    const amt = parseFloat(form.month_deposit_amt) || 0;
    if (m && amt) setF('total_deposit_amt', String(m * amt));
    else setF('total_deposit_amt', '');
  }, [form.months_security, form.month_deposit_amt]);

  // Load Zoho vendors when vendor_payment is selected
  useEffect(() => {
    if (form.request_type === 'vendor_payment' && form.payment_source === 'zoho' && zohoVendors.length === 0) {
      api.portalVendors('').then(d => setZohoVendors(Array.isArray(d) ? d : [])).catch(() => {});
    }
  }, [form.request_type, form.payment_source]);

  // Fetch POs/Bills when Zoho vendor is selected
  useEffect(() => {
    if (!form.zoho_vendor_id || !form.zoho_doc_type) { setZohoDocs([]); return; }
    setZohoLoading(true);
    const fn = form.zoho_doc_type === 'purchase_order' ? api.portalPOs : api.portalBills;
    fn(form.zoho_vendor_id)
      .then(d => { setZohoDocs(Array.isArray(d) ? d : []); })
      .catch(() => setZohoDocs([]))
      .finally(() => setZohoLoading(false));
  }, [form.zoho_vendor_id, form.zoho_doc_type]);

  const loadSubmissions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.portalList(filterStatus !== 'all' ? { status: filterStatus } : {});
      setSubmissions(Array.isArray(data) ? data : []);
    } catch (_) { setSubmissions([]); }
    finally { setLoading(false); }
  }, [filterStatus]);

  useEffect(() => { if (tab === 'list') loadSubmissions(); }, [tab, loadSubmissions]);

  function resetForm() {
    setForm(INIT_FORM);
    setFileNames({});
    setZohoDocs([]);
    setVendorSearch('');
    if (billFileRef.current)  billFileRef.current.value  = '';
    if (loiFileRef.current)   loiFileRef.current.value   = '';
    if (stmtFileRef.current)  stmtFileRef.current.value  = '';
    if (payFileRef.current)   payFileRef.current.value   = '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setMsg(null);

    // Validation
    if (!form.submission_type) return setMsg({ type: 'error', text: 'Please select Tax Bill or Request.' });
    if (form.submission_type === 'tax_bill') {
      if (!form.bill_type) return setMsg({ type: 'error', text: 'Please select a bill type.' });
      if (!form.vendor_name) return setMsg({ type: 'error', text: 'Vendor Name is required.' });
      if (!form.bill_date)   return setMsg({ type: 'error', text: 'Bill Date is required.' });
      if (!form.bill_amount) return setMsg({ type: 'error', text: 'Bill Amount is required.' });
      if (!billFileRef.current?.files?.length) return setMsg({ type: 'error', text: 'Bill Attachment is required.' });
      if (form.bill_type === 'recurring_bill' && !form.recurring_type) return setMsg({ type: 'error', text: 'Please select recurring bill type.' });
      if (form.bill_type === 'recurring_bill' && form.recurring_type === 'others' && !form.others_mention) return setMsg({ type: 'error', text: 'Please specify the bill type.' });
    }
    if (form.submission_type === 'request') {
      if (!form.request_type) return setMsg({ type: 'error', text: 'Please select a request type.' });
      if (form.request_type === 'security_deposit_pay') {
        if (!form.property_city || !form.property_address || !form.developer_name || !form.sqft || !form.months_security || !form.month_deposit_amt)
          return setMsg({ type: 'error', text: 'Please fill all security deposit fields.' });
        if (!loiFileRef.current?.files?.length) return setMsg({ type: 'error', text: 'Term Sheet / LOI attachment is required.' });
      }
      if (form.request_type === 'balance_vendor' && !form.vendor_name) return setMsg({ type: 'error', text: 'Vendor Name is required.' });
      if (form.request_type === 'balance_customer' && !form.customer_name) return setMsg({ type: 'error', text: 'Customer Name is required.' });
      if (form.request_type === 'security_deposit_refund') {
        if (!form.customer_name || !form.refund_amount || !form.expected_date)
          return setMsg({ type: 'error', text: 'Please fill all refund fields.' });
      }
      if (form.request_type === 'vendor_payment') {
        if (!form.vendor_category || (!form.vendor_name && !form.zoho_vendor_id)) return setMsg({ type: 'error', text: 'Vendor Category and Vendor Name are required.' });
        if (!form.payment_source) return setMsg({ type: 'error', text: 'Please choose Bill/PO source.' });
        if (form.payment_source === 'upload' && !payFileRef.current?.files?.length) return setMsg({ type: 'error', text: 'Please attach the Bill or PO document.' });
        if (form.payment_source === 'zoho' && !form.zoho_doc_id) return setMsg({ type: 'error', text: 'Please select a PO or Bill from Zoho.' });
        if (!form.payment_amount) return setMsg({ type: 'error', text: 'Payment Amount is required.' });
      }
    }

    setSubmitting(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v || ''));
      fd.append('submitted_by',      user.username  || '');
      fd.append('submitted_by_name', user.name || user.username || '');

      const attachments = {
        bill_attachment:      billFileRef.current?.files?.[0],
        loi_attachment:       loiFileRef.current?.files?.[0],
        statement_attachment: stmtFileRef.current?.files?.[0],
        payment_attachment:   payFileRef.current?.files?.[0],
      };
      // Online (Vercel) the attachments go up one per request first; on the office PC with the form
      const staged = await stageUploads('/api/portal', attachments, { Authorization: `Bearer ${localStorage.getItem('da_token')}` });
      if (staged) {
        fd.append('uploadSession', staged.session);
        fd.append('uploadToken', staged.token);
        fd.append('uploadedFiles', JSON.stringify(Object.values(staged.files)));
      } else {
        Object.entries(attachments).forEach(([k, f]) => { if (f) fd.append(k, f); });
      }

      const res = await api.portalSubmit(fd);
      setMsg({ type: 'success', text: `Submitted successfully! Reference: ${res.id}` });
      resetForm();
      setTimeout(() => { setTab('list'); setMsg(null); }, 2000);
    } catch (e) {
      setMsg({ type: 'error', text: e.response?.data?.error || e.message });
    } finally { setSubmitting(false); }
  }

  // Filtered vendors for dropdown
  const filteredVendors = zohoVendors.filter(v =>
    !vendorSearch || v.name.toLowerCase().includes(vendorSearch.toLowerCase())
  );

  // ── Form render ─────────────────────────────────────────────────────────────

  function renderForm() {
    const isTaxBill = form.submission_type === 'tax_bill';
    const isRequest = form.submission_type === 'request';
    const rt = form.request_type;

    return (
      <form onSubmit={handleSubmit}>
        {msg && <div style={S.alert(msg.type)}>{msg.text}</div>}

        {/* Step 1: Category */}
        <div style={S.card}>
          <div style={S.secLabel}>What are you submitting?</div>
          <div style={{ display: 'flex', gap: 12 }}>
            <button type="button" style={S.typeBtn(isTaxBill)} onClick={() => { setF('submission_type','tax_bill'); setF('request_type',''); setF('bill_type',''); }}>
              <div style={{ fontSize: '1.4rem', marginBottom: 6 }}>🧾</div>
              <p style={S.typeBtnLbl(isTaxBill)}>Tax Bill</p>
              <p style={{ fontSize: '0.7rem', color: '#5D6C7B', margin: '4px 0 0' }}>Project, Recurring or Broker bill for booking</p>
            </button>
            <button type="button" style={S.typeBtn(isRequest)} onClick={() => { setF('submission_type','request'); setF('bill_type',''); setF('recurring_type',''); }}>
              <div style={{ fontSize: '1.4rem', marginBottom: 6 }}>📋</div>
              <p style={S.typeBtnLbl(isRequest)}>Request</p>
              <p style={{ fontSize: '0.7rem', color: '#5D6C7B', margin: '4px 0 0' }}>Security Deposit, Balance Confirmation or Payment</p>
            </button>
          </div>
        </div>

        {/* Step 2a: Bill Type */}
        {isTaxBill && (
          <div style={S.card}>
            <div style={S.secLabel}>Bill Category</div>
            <div style={S.grid3}>
              {BILL_TYPES.map(bt => (
                <button key={bt.value} type="button" style={S.typeBtn(form.bill_type === bt.value)} onClick={() => setF('bill_type', bt.value)}>
                  <p style={{ ...S.typeBtnLbl(form.bill_type === bt.value), fontSize: '0.78rem' }}>{bt.label}</p>
                </button>
              ))}
            </div>

            {/* Project Bill */}
            {form.bill_type === 'project_bill' && (
              <>
                <div style={S.divider} />
                <div style={S.grid2}>
                  <Fl label="Project Name" required>
                    <input type="text" value={form.project_name} onChange={e => setF('project_name', e.target.value)} style={S.inp} placeholder="e.g. Arvind – IT Park" />
                  </Fl>
                  <Fl label="Vendor Name" required>
                    <input type="text" value={form.vendor_name} onChange={e => setF('vendor_name', e.target.value)} style={S.inp} placeholder="Enter vendor name" />
                  </Fl>
                  <Fl label="Bill Date" required>
                    <input type="date" value={form.bill_date} onChange={e => setF('bill_date', e.target.value)} style={S.inp} />
                  </Fl>
                  <Fl label="Bill Amount (₹)" required>
                    <input type="number" value={form.bill_amount} onChange={e => setF('bill_amount', e.target.value)} style={S.inp} placeholder="0.00" min="0" step="0.01" />
                  </Fl>
                </div>
                <Fl label="Bill Attachment" required>
                  <div style={S.fileBox} onClick={() => billFileRef.current.click()}>
                    <span style={{ fontSize: '1rem' }}>📎</span>
                    <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>{fileNames.bill || 'Click to attach bill (PDF/image, max 25MB)'}</span>
                  </div>
                  <input ref={billFileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" style={{ display: 'none' }} onChange={e => setFileNames(n => ({ ...n, bill: e.target.files[0]?.name }))} />
                </Fl>
              </>
            )}

            {/* Recurring Bill */}
            {form.bill_type === 'recurring_bill' && (
              <>
                <div style={S.divider} />
                <div style={{ marginBottom: '1rem' }}>
                  <div style={S.secLabel}>Recurring Bill Type</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
                    {RECURRING_TYPES.map(rt => (
                      <button key={rt.value} type="button" style={{ ...S.typeBtn(form.recurring_type === rt.value), padding: '0.5rem 0.75rem' }} onClick={() => setF('recurring_type', rt.value)}>
                        <p style={{ ...S.typeBtnLbl(form.recurring_type === rt.value), fontSize: '0.75rem' }}>{rt.label}</p>
                      </button>
                    ))}
                  </div>
                </div>
                {form.recurring_type === 'others' && (
                  <Fl label="Please specify" required>
                    <input type="text" value={form.others_mention} onChange={e => setF('others_mention', e.target.value)} style={S.inp} placeholder="Describe the bill type" />
                  </Fl>
                )}
                {form.recurring_type && (
                  <div style={{ ...S.grid2, marginTop: '1rem' }}>
                    <Fl label="Vendor Name" required>
                      <input type="text" value={form.vendor_name} onChange={e => setF('vendor_name', e.target.value)} style={S.inp} placeholder="Enter vendor name" />
                    </Fl>
                    <Fl label="Bill Date" required>
                      <input type="date" value={form.bill_date} onChange={e => setF('bill_date', e.target.value)} style={S.inp} />
                    </Fl>
                    <Fl label="Bill Amount (₹)" required>
                      <input type="number" value={form.bill_amount} onChange={e => setF('bill_amount', e.target.value)} style={S.inp} placeholder="0.00" min="0" step="0.01" />
                    </Fl>
                    <Fl label="Bill Attachment" required>
                      <div style={S.fileBox} onClick={() => billFileRef.current.click()}>
                        <span style={{ fontSize: '1rem' }}>📎</span>
                        <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>{fileNames.bill || 'Click to attach bill'}</span>
                      </div>
                      <input ref={billFileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" style={{ display: 'none' }} onChange={e => setFileNames(n => ({ ...n, bill: e.target.files[0]?.name }))} />
                    </Fl>
                  </div>
                )}
              </>
            )}

            {/* Broker Bill */}
            {form.bill_type === 'broker_bill' && (
              <>
                <div style={S.divider} />
                <div style={S.grid2}>
                  <Fl label="Broker Name" required>
                    <input type="text" value={form.broker_name} onChange={e => setF('broker_name', e.target.value)} style={S.inp} placeholder="Enter broker name" />
                  </Fl>
                  <Fl label="Client Name" required>
                    <input type="text" value={form.client_name} onChange={e => setF('client_name', e.target.value)} style={S.inp} placeholder="Enter client name" />
                  </Fl>
                  <Fl label="Vendor Name" required>
                    <input type="text" value={form.vendor_name} onChange={e => setF('vendor_name', e.target.value)} style={S.inp} placeholder="Enter vendor name" />
                  </Fl>
                  <Fl label="Bill Date" required>
                    <input type="date" value={form.bill_date} onChange={e => setF('bill_date', e.target.value)} style={S.inp} />
                  </Fl>
                  <Fl label="Bill Amount (₹)" required>
                    <input type="number" value={form.bill_amount} onChange={e => setF('bill_amount', e.target.value)} style={S.inp} placeholder="0.00" min="0" step="0.01" />
                  </Fl>
                  <Fl label="Bill Attachment" required>
                    <div style={S.fileBox} onClick={() => billFileRef.current.click()}>
                      <span style={{ fontSize: '1rem' }}>📎</span>
                      <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>{fileNames.bill || 'Click to attach bill'}</span>
                    </div>
                    <input ref={billFileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" style={{ display: 'none' }} onChange={e => setFileNames(n => ({ ...n, bill: e.target.files[0]?.name }))} />
                  </Fl>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 2b: Request Type */}
        {isRequest && (
          <div style={S.card}>
            <div style={S.secLabel}>Request Type</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: form.request_type ? '1.25rem' : 0 }}>
              {REQUEST_TYPES.map(r => (
                <button key={r.value} type="button"
                  style={{ textAlign: 'left', padding: '0.65rem 1rem', borderRadius: 8, border: `1px solid ${form.request_type === r.value ? '#1C4942' : '#DFE7E3'}`, background: form.request_type === r.value ? '#EAF4EF' : '#FFFFFF', cursor: 'pointer' }}
                  onClick={() => { setF('request_type', r.value); setF('payment_source',''); setF('zoho_doc_type',''); setF('zoho_vendor_id',''); setF('zoho_doc_id',''); }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: form.request_type === r.value ? '#1C4942' : '#9BA8B0' }}>{r.label}</span>
                </button>
              ))}
            </div>

            {/* Security Deposit Pay */}
            {rt === 'security_deposit_pay' && (
              <>
                <div style={S.divider} />
                <div style={S.grid2}>
                  <Fl label="Property City" required>
                    <input type="text" value={form.property_city} onChange={e => setF('property_city', e.target.value)} style={S.inp} placeholder="e.g. Ahmedabad" />
                  </Fl>
                  <Fl label="Developer / Owner Name" required>
                    <input type="text" value={form.developer_name} onChange={e => setF('developer_name', e.target.value)} style={S.inp} placeholder="Enter name" />
                  </Fl>
                  <Fl label="Property Address" required span={2}>
                    <input type="text" value={form.property_address} onChange={e => setF('property_address', e.target.value)} style={S.inp} placeholder="Full address" />
                  </Fl>
                  <Fl label="Area (Sqft)" required>
                    <input type="number" value={form.sqft} onChange={e => setF('sqft', e.target.value)} style={S.inp} placeholder="0" min="0" />
                  </Fl>
                  <Fl label="No. of Months (Security Deposit)" required>
                    <input type="number" value={form.months_security} onChange={e => setF('months_security', e.target.value)} style={S.inp} placeholder="e.g. 3" min="0" />
                  </Fl>
                  <Fl label="One Month Security Deposit Amount (₹)" required>
                    <input type="number" value={form.month_deposit_amt} onChange={e => setF('month_deposit_amt', e.target.value)} style={S.inp} placeholder="0.00" min="0" step="0.01" />
                  </Fl>
                  <Fl label="Total Security Deposit Amount (₹)" required>
                    <input type="number" value={form.total_deposit_amt} readOnly style={S.ro} placeholder="Auto-calculated" />
                  </Fl>
                </div>
                <Fl label="Term Sheet / LOI Attachment" required>
                  <div style={S.fileBox} onClick={() => loiFileRef.current.click()}>
                    <span style={{ fontSize: '1rem' }}>📎</span>
                    <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>{fileNames.loi || 'Click to attach Term Sheet / LOI (PDF)'}</span>
                  </div>
                  <input ref={loiFileRef} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }} onChange={e => setFileNames(n => ({ ...n, loi: e.target.files[0]?.name }))} />
                </Fl>
              </>
            )}

            {/* Balance Confirmation Vendor */}
            {rt === 'balance_vendor' && (
              <>
                <div style={S.divider} />
                <div style={S.grid2}>
                  <Fl label="Company Name" required>
                    <input type="text" value={form.company_name} onChange={e => setF('company_name', e.target.value)} style={S.inp} placeholder="Your company name" />
                  </Fl>
                  <Fl label="Vendor Name" required>
                    <input type="text" value={form.vendor_name} onChange={e => setF('vendor_name', e.target.value)} style={S.inp} placeholder="Enter vendor name" />
                  </Fl>
                </div>
                <Fl label="Vendor Statement Attachment (optional)">
                  <div style={S.fileBox} onClick={() => stmtFileRef.current.click()}>
                    <span style={{ fontSize: '1rem' }}>📎</span>
                    <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>{fileNames.stmt || 'Attach vendor statement if available'}</span>
                  </div>
                  <input ref={stmtFileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls" style={{ display: 'none' }} onChange={e => setFileNames(n => ({ ...n, stmt: e.target.files[0]?.name }))} />
                </Fl>
              </>
            )}

            {/* Balance Confirmation Customer */}
            {rt === 'balance_customer' && (
              <>
                <div style={S.divider} />
                <div style={S.grid2}>
                  <Fl label="Company Name" required>
                    <input type="text" value={form.company_name} onChange={e => setF('company_name', e.target.value)} style={S.inp} placeholder="Your company name" />
                  </Fl>
                  <Fl label="Customer Name" required>
                    <input type="text" value={form.customer_name} onChange={e => setF('customer_name', e.target.value)} style={S.inp} placeholder="Enter customer name" />
                  </Fl>
                </div>
                <Fl label="Customer Statement Attachment (optional)">
                  <div style={S.fileBox} onClick={() => stmtFileRef.current.click()}>
                    <span style={{ fontSize: '1rem' }}>📎</span>
                    <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>{fileNames.stmt || 'Attach customer statement if available'}</span>
                  </div>
                  <input ref={stmtFileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls" style={{ display: 'none' }} onChange={e => setFileNames(n => ({ ...n, stmt: e.target.files[0]?.name }))} />
                </Fl>
              </>
            )}

            {/* Security Deposit Refund */}
            {rt === 'security_deposit_refund' && (
              <>
                <div style={S.divider} />
                <div style={S.grid2}>
                  <Fl label="Customer Name" required>
                    <input type="text" value={form.customer_name} onChange={e => setF('customer_name', e.target.value)} style={S.inp} placeholder="Enter customer name" />
                  </Fl>
                  <Fl label="Security Deposit Refund Amount (₹)" required>
                    <input type="number" value={form.refund_amount} onChange={e => setF('refund_amount', e.target.value)} style={S.inp} placeholder="0.00" min="0" step="0.01" />
                  </Fl>
                  <Fl label="Expected Last Date to Pay" required>
                    <input type="date" value={form.expected_date} onChange={e => setF('expected_date', e.target.value)} style={S.inp} />
                  </Fl>
                </div>
              </>
            )}

            {/* Request for Payment */}
            {rt === 'vendor_payment' && (
              <>
                <div style={S.divider} />
                <div style={S.grid2}>
                  <Fl label="Vendor Category" required>
                    <select value={form.vendor_category} onChange={e => setF('vendor_category', e.target.value)} style={S.sel}>
                      <option value="">— Select Category —</option>
                      {VENDOR_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Fl>
                  <Fl label="Vendor Name" required>
                    <input type="text" value={form.vendor_name} onChange={e => setF('vendor_name', e.target.value)} style={S.inp} placeholder="Enter vendor name" />
                  </Fl>
                </div>

                <div style={{ marginTop: '1rem', marginBottom: '0.75rem' }}>
                  <div style={S.secLabel}>Do you have a Bill / Purchase Order?</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button type="button" style={S.typeBtn(form.payment_source === 'upload')} onClick={() => { setF('payment_source','upload'); setF('zoho_doc_type',''); setF('zoho_vendor_id',''); setF('zoho_doc_id',''); }}>
                      <p style={{ ...S.typeBtnLbl(form.payment_source === 'upload'), fontSize: '0.78rem' }}>📎 I have Bill / Purchase Order</p>
                      <p style={{ fontSize: '0.68rem', color: '#5D6C7B', margin: '4px 0 0' }}>Upload the document</p>
                    </button>
                    <button type="button" style={S.typeBtn(form.payment_source === 'zoho')} onClick={() => setF('payment_source','zoho')}>
                      <p style={{ ...S.typeBtnLbl(form.payment_source === 'zoho'), fontSize: '0.78rem' }}>🔗 Fetch from Zoho Books</p>
                      <p style={{ fontSize: '0.68rem', color: '#5D6C7B', margin: '4px 0 0' }}>Select existing PO or Bill</p>
                    </button>
                  </div>
                </div>

                {form.payment_source === 'upload' && (
                  <Fl label="Bill / PO Attachment" required>
                    <div style={S.fileBox} onClick={() => payFileRef.current.click()}>
                      <span style={{ fontSize: '1rem' }}>📎</span>
                      <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>{fileNames.pay || 'Click to attach Bill or PO document'}</span>
                    </div>
                    <input ref={payFileRef} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }} onChange={e => setFileNames(n => ({ ...n, pay: e.target.files[0]?.name }))} />
                  </Fl>
                )}

                {form.payment_source === 'zoho' && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={S.grid2}>
                      <Fl label="Document Type" required>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {[{ v:'purchase_order', l:'Purchase Order' }, { v:'bill', l:'Bill' }].map(opt => (
                            <button key={opt.v} type="button"
                              style={{ ...S.typeBtn(form.zoho_doc_type === opt.v), flex: 1, padding: '0.5rem' }}
                              onClick={() => { setF('zoho_doc_type', opt.v); setF('zoho_doc_id',''); setF('zoho_doc_number',''); setZohoDocs([]); }}>
                              <p style={{ ...S.typeBtnLbl(form.zoho_doc_type === opt.v), fontSize: '0.75rem', margin: 0 }}>{opt.l}</p>
                            </button>
                          ))}
                        </div>
                      </Fl>
                      <Fl label="Search Zoho Vendor" required>
                        <input type="text" value={vendorSearch} onChange={e => { setVendorSearch(e.target.value); setF('zoho_vendor_id',''); setF('zoho_doc_id',''); setZohoDocs([]); }} style={S.inp} placeholder="Type vendor name to search..." />
                      </Fl>
                    </div>
                    {vendorSearch.length >= 2 && (
                      <Fl label="Select Vendor from Zoho">
                        <select value={form.zoho_vendor_id} onChange={e => { const v = zohoVendors.find(x => x.id === e.target.value); setF('zoho_vendor_id', e.target.value); setF('zoho_vendor_name', v?.name || ''); setF('zoho_doc_id',''); setF('zoho_doc_number',''); }} style={S.sel}>
                          <option value="">— Select vendor —</option>
                          {filteredVendors.map(v => <option key={v.id} value={v.id}>{v.name}{v.category ? ` (${v.category})` : ''}</option>)}
                        </select>
                      </Fl>
                    )}
                    {form.zoho_vendor_id && form.zoho_doc_type && (
                      <div style={{ marginTop: '0.75rem' }}>
                        <Fl label={`Select ${form.zoho_doc_type === 'purchase_order' ? 'Purchase Order' : 'Bill'}`} required>
                          {zohoLoading ? (
                            <div style={{ ...S.inp, color: '#5D6C7B' }}>Loading…</div>
                          ) : (
                            <select value={form.zoho_doc_id}
                              onChange={e => { const d = zohoDocs.find(x => x.id === e.target.value); setF('zoho_doc_id', e.target.value); setF('zoho_doc_number', d?.number || ''); }}
                              style={S.sel}>
                              <option value="">— Select —</option>
                              {zohoDocs.map(d => (
                                <option key={d.id} value={d.id}>
                                  {d.number} — {fmtDate(d.date)} — {fmtAmt(d.total || d.balance)} ({d.status})
                                </option>
                              ))}
                            </select>
                          )}
                          {!zohoLoading && zohoDocs.length === 0 && form.zoho_vendor_id && (
                            <div style={{ fontSize: '0.72rem', color: '#5D6C7B', marginTop: 4 }}>No open {form.zoho_doc_type === 'purchase_order' ? 'purchase orders' : 'bills'} found for this vendor.</div>
                          )}
                        </Fl>
                      </div>
                    )}
                  </div>
                )}

                {form.payment_source && (
                  <Fl label="Amount to Pay (₹)" required>
                    <input type="number" value={form.payment_amount} onChange={e => setF('payment_amount', e.target.value)} style={S.inp} placeholder="0.00" min="0" step="0.01" />
                  </Fl>
                )}
              </>
            )}
          </div>
        )}

        {/* Submit */}
        {form.submission_type && (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={resetForm} style={S.btnSec} disabled={submitting}>Clear Form</button>
            <button type="submit" style={S.btnPrimary} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit Request →'}
            </button>
          </div>
        )}
      </form>
    );
  }

  // ── List render ─────────────────────────────────────────────────────────────

  function renderList() {
    const counts = { all: submissions.length };
    ['pending','in_progress','completed','rejected'].forEach(s => { counts[s] = submissions.filter(x => x.status === s).length; });

    const shown = filterStatus === 'all' ? submissions : submissions.filter(s => s.status === filterStatus);

    return (
      <>
        <div style={{ display: 'flex', gap: 8, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {[['all','All'],['pending','Pending'],['in_progress','In Progress'],['completed','Completed'],['rejected','Rejected']].map(([v,l]) => (
            <button key={v} onClick={() => setFilter(v)} style={{ ...S.btnSec, color: filterStatus === v ? '#1C4942' : '#5D6C7B', borderColor: filterStatus === v ? '#1C4942' : '#DFE7E3', fontSize: '0.75rem', padding: '4px 12px' }}>
              {l} <span style={{ opacity: 0.7 }}>({counts[v] || 0})</span>
            </button>
          ))}
          <button onClick={loadSubmissions} style={{ ...S.btnSec, marginLeft: 'auto', fontSize: '0.75rem', padding: '4px 10px' }}>↻ Refresh</button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: '#5D6C7B' }}>Loading submissions…</div>
        ) : shown.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: '#9BA8B0' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📥</div>
            <div style={{ fontSize: '0.9rem', color: '#5D6C7B' }}>No submissions found</div>
            <button onClick={() => setTab('form')} style={{ ...S.btnPrimary, marginTop: 16, fontSize: '0.8rem' }}>Submit New Request</button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Ref #</th>
                  <th style={S.th}>Date</th>
                  <th style={S.th}>Type</th>
                  <th style={S.th}>Details</th>
                  <th style={S.th}>Submitted By</th>
                  <th style={S.th}>Attachments</th>
                  <th style={S.th}>Status</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {shown.map(s => (
                  <tr key={s.id} style={{ cursor: 'pointer' }} onMouseEnter={e => e.currentTarget.style.background = '#F9F9F9'} onMouseLeave={e => e.currentTarget.style.background = ''}>
                    <td style={{ ...S.td, fontWeight: 600, color: '#1C4942', whiteSpace: 'nowrap' }}>{s.id}</td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{fmtDate(s.submitted_at)}</td>
                    <td style={{ ...S.td, fontSize: '0.72rem', color: '#9BA8B0', maxWidth: 200 }}>{typeLabel(s)}</td>
                    <td style={{ ...S.td, fontSize: '0.75rem', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{keyDetail(s)}</td>
                    <td style={{ ...S.td, fontSize: '0.75rem', color: '#9BA8B0' }}>{s.submitted_by_name || s.submitted_by || '—'}</td>
                    <td style={S.td}>
                      {s.files?.length > 0 ? (
                        <span style={{ fontSize: '0.72rem', color: '#1C4942' }}>📎 {s.files.length} file{s.files.length > 1 ? 's' : ''}</span>
                      ) : <span style={{ color: '#9BA8B0', fontSize: '0.72rem' }}>—</span>}
                    </td>
                    <td style={S.td}><span style={S.badge(s.status)}>{(s.status || 'pending').replace('_', ' ').toUpperCase()}</span></td>
                    <td style={S.td}>
                      <button onClick={() => setSelected(s)} style={{ ...S.btnSm('#9BA8B0'), padding: '4px 12px' }}>View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.hdr}>
        <div>
          <h1 style={S.title}>Finance Request Portal</h1>
          <p style={S.sub}>Centralised bill & request submission — no bill goes missing</p>
        </div>
        {tab === 'list' && (
          <button onClick={() => { setMsg(null); resetForm(); setTab('form'); }} style={S.btnPrimary}>+ New Submission</button>
        )}
        {tab === 'form' && (
          <button onClick={() => { setMsg(null); setTab('list'); }} style={S.btnSec}>← Back to Submissions</button>
        )}
      </div>

      <div style={S.tabs}>
        <button style={S.tab(tab === 'form')} onClick={() => { setMsg(null); setTab('form'); }}>New Submission</button>
        <button style={S.tab(tab === 'list')} onClick={() => setTab('list')}>All Submissions</button>
      </div>

      <div style={S.card}>
        {tab === 'form' ? renderForm() : renderList()}
      </div>

      {selected && (
        <DetailModal
          sub={selected}
          isAdmin={isAdmin}
          onClose={() => setSelected(null)}
          onUpdate={loadSubmissions}
        />
      )}
    </div>
  );
}
