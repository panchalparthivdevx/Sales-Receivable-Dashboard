import React, { useState, useEffect } from 'react';
import { stageUploads } from '../utils/api';

/* ─── Static data ─────────────────────────────────────────────────────────── */
const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab',
  'Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand',
  'West Bengal','Andaman and Nicobar Islands','Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu','Delhi','Jammu and Kashmir',
  'Ladakh','Lakshadweep','Puducherry',
];
const INDUSTRIES = [
  'Banking','Financial Services','Insurance','Fintech','Outsourcing','Medical Tourism',
  'Real Estate','Technology','Manufacturing','Retail','Education','Healthcare',
  'Hospitality','Construction','Logistics','Media & Entertainment','Agriculture','Other',
];
const SECTORS = [
  'BFSI','Healthcare','ITES','IT and BPM','FMCG','Real Estate','Manufacturing',
  'Education','Retail','Logistics','Media','Agriculture','Construction','Other',
];
const MSME_CATS  = ['Micro','Small','Medium'];
const MSME_SECS  = ['Manufacturing','Services'];

const STEPS = [
  { num: 1, label: 'Company Info'    },
  { num: 2, label: 'Address & GST'  },
  { num: 3, label: 'Statutory'      },
  { num: 4, label: 'Signatory'      },
  { num: 5, label: 'Finance Team'   },
  { num: 6, label: 'Bank Account'   },
  { num: 7, label: 'E-Sign & Terms' },
];

const INIT = {
  vendorLegalName:'', tradeName:'', dateOfRegistration:'', typeOfVendor:'', typeOfOrganization:'',
  companyIndustry:'', companySector:'', noOfEmployees:'', descriptionOfServices:'', vendorCriteria:'',
  websiteUrl:'', hasBrochure:'',
  regOfficeAddress1:'', regOfficeAddress2:'', regCity:'', regState:'', regPinCode:'', regCountry:'India',
  billingInfoSameAsReg:'', billingAddress1:'', billingAddress2:'', billingCity:'',
  billingState:'', billingPinCode:'', billingCountry:'India',
  hasGstNumber:'', gstRegistrationStatus:'', gstNumberRegOffice:'', headOfficeGstNumber:'', gstNumberForBill:'',
  additionalGstRegistrations:[],
  turnoverPreviousFY:'', turnoverCurrentFY:'',
  orgRegistrationNumber:'', orgPan:'',
  hasTanNumber:'', tanNumber:'', hasMultipleTanNumbers:'', additionalTanNumbers:[],
  registerUnderMsme:'', msmeUdyamNumber:'', msmeCategory:'', msmeSector:'', msmeFY:'',
  hasProfessionalTax:'', ptNumber:'',
  hasProvidentFund:'', pfNumber:'',
  hasEsi:'', esiNumber:'',
  shopsEstLicenseNumber:'', shopsEstState:'',
  signatoryName:'', signatoryDesignation:'', signatoryMobile:'', signatoryAlternateMobile:'',
  signatoryEmail:'', signatoryAadharNumber:'', signatoryPanSameAsOrg:'', signatoryPanNumber:'',
  signatoryDIN:'',
  primaryFinanceContactName:'', primaryFinanceDesignation:'', primaryFinanceMobile:'', primaryFinanceEmail:'',
  secondaryFinanceContactName:'', secondaryFinanceDesignation:'', secondaryFinanceMobile:'', secondaryFinanceEmail:'',
  bankName:'', ifscCode:'', branchName:'', swiftCode:'', accountType:'', micrCode:'', accountNumber:'',
  confirmAccountNumber:'',
  esignSignerName:'', esignSignerEmail:'', acceptedTerms:false, suggestions:'',
};

/* ─── CSS injection ───────────────────────────────────────────────────────── */
const CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  .vrf-body { font-family: 'Figtree', 'Inter', 'Segoe UI', system-ui, sans-serif; background: #eef2f7; min-height: 100vh; margin: 0; }
  .vrf-in {
    width: 100%; padding: 11px 14px; font-size: 14px; color: #18191B;
    background: #fff; border: 1.5px solid #dde3ec; border-radius: 8px;
    transition: border-color .18s, box-shadow .18s; font-family: inherit;
  }
  .vrf-in:focus { outline: none; border-color: #1C4942; box-shadow: 0 0 0 3.5px rgba(28,73,66,.12); }
  .vrf-in:hover:not(:focus) { border-color: #9BA8B0; }
  .vrf-in::placeholder { color: #c1c9d6; }
  .vrf-btn-next {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 28px; font-size: 14px; font-weight: 600;
    background: #1C4942; color: #fff;
    border: none; border-radius: 9px; cursor: pointer;
    box-shadow: 0 2px 8px rgba(28,73,66,.32);
    transition: transform .12s, box-shadow .12s;
  }
  .vrf-btn-next:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(28,73,66,.38); }
  .vrf-btn-next:active { transform: translateY(0); }
  .vrf-btn-next:disabled { opacity:.6; cursor:not-allowed; transform:none; }
  .vrf-btn-prev {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 22px; font-size: 14px; font-weight: 500;
    background: #fff; color: #5D6C7B; border: 1.5px solid #dde3ec;
    border-radius: 9px; cursor: pointer; transition: background .12s, border-color .12s;
  }
  .vrf-btn-prev:hover { background: #f8fafc; border-color: #9BA8B0; }
  .vrf-btn-submit {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 32px; font-size: 14px; font-weight: 700;
    background: linear-gradient(135deg,#15803d,#16a34a); color: #fff;
    border: none; border-radius: 9px; cursor: pointer;
    box-shadow: 0 2px 8px rgba(22,163,74,.32);
    transition: transform .12s, box-shadow .12s;
  }
  .vrf-btn-submit:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(22,163,74,.4); }
  .vrf-btn-submit:disabled { opacity:.6; cursor:not-allowed; transform:none; }
  .vrf-file-zone {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border: 1.5px dashed #C8D6D0; border-radius: 8px;
    cursor: pointer; background: #f8fafc; transition: border-color .15s, background .15s;
    position: relative; overflow: hidden;
  }
  .vrf-file-zone:hover { border-color: #1C4942; background: #EAF4EF; }
  .vrf-file-zone input[type=file] { position:absolute; inset:0; opacity:0; cursor:pointer; width:100%; height:100%; }
  .vrf-radio-group { display: flex; gap: 16px; flex-wrap: wrap; padding-top: 4px; }
  .vrf-radio-opt {
    display: flex; align-items: center; gap: 7px;
    padding: 8px 14px; border: 1.5px solid #dde3ec; border-radius: 8px;
    cursor: pointer; font-size: 13.5px; color: #5D6C7B; font-weight: 500;
    transition: border-color .15s, background .15s, color .15s;
  }
  .vrf-radio-opt:hover { border-color: #1C4942; background: #EAF4EF; color: #1C4942; }
  .vrf-radio-opt.active { border-color: #1C4942; background: #EAF4EF; color: #1C4942; font-weight: 600; }
  .vrf-radio-opt input { accent-color: #1C4942; }
  .vrf-check-wrap {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 14px 16px; background: #f0fdf4; border: 1.5px solid #bbf7d0;
    border-radius: 10px; cursor: pointer; transition: background .12s;
  }
  .vrf-check-wrap:hover { background: #dcfce7; }
  .vrf-check-wrap input { accent-color: #16a34a; width: 17px; height: 17px; flex-shrink: 0; margin-top: 1px; }
  .vrf-tan-row { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid #DFE7E3; }
  .vrf-add-row {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 14px; font-size: 13px; font-weight: 500;
    border: 1.5px dashed #1C4942; border-radius: 7px; color: #1C4942;
    background: transparent; cursor: pointer; transition: background .12s;
  }
  .vrf-add-row:hover { background: #EAF4EF; }
  .vrf-rm { padding: 5px 10px; font-size: 12px; border: 1px solid #fca5a5; border-radius: 5px; background: #fff1f2; color: #dc2626; cursor: pointer; }
  .vrf-success { text-align: center; padding: 4rem 2rem; }
  @media (max-width: 640px) {
    .vrf-grid-2 { grid-template-columns: 1fr !important; }
    .vrf-stepper-label { display: none; }
  }
`;

/* ─── Main Component ─────────────────────────────────────────────────────── */
export default function VendorRegistrationForm() {
  const [step, setStep]         = useState(1);
  const [form, setForm]         = useState(INIT);
  const [files, setFiles]       = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [error, setError]           = useState(null);

  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = CSS;
    document.head.appendChild(el);
    return () => document.head.removeChild(el);
  }, []);

  const set  = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setF = (k, f) => setFiles(p => ({ ...p, [k]: f }));

  function addTan()        { set('additionalTanNumbers', [...form.additionalTanNumbers, { tanNumber:'' }]); }
  function updateTan(i, v) { const a=[...form.additionalTanNumbers]; a[i]={tanNumber:v}; set('additionalTanNumbers',a); }
  function removeTan(i)    { set('additionalTanNumbers', form.additionalTanNumbers.filter((_,j)=>j!==i)); }

  function addGstReg() { set('additionalGstRegistrations', [...form.additionalGstRegistrations, { gstNumber: '', state: '' }]); }
  function updateGstReg(i, field, val) { const a = [...form.additionalGstRegistrations]; a[i] = { ...a[i], [field]: val }; set('additionalGstRegistrations', a); }
  function removeGstReg(i) { set('additionalGstRegistrations', form.additionalGstRegistrations.filter((_,j) => j !== i)); }

  async function handleSubmit() {
    if (!form.acceptedTerms) { setError('Please accept the Terms and Conditions.'); return; }
    if (form.accountNumber !== form.confirmAccountNumber) { setError('Account number and Confirm Account Number do not match.'); return; }
    setError(null); setSubmitting(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => {
        if (k === 'additionalTanNumbers') fd.append(k, JSON.stringify(v));
        else if (k === 'additionalGstRegistrations') fd.append(k, JSON.stringify(v));
        else if (typeof v === 'boolean')  fd.append(k, v ? 'Yes' : 'No');
        else fd.append(k, v);
      });
      // Online (Vercel) the attachments go up one per request first; on the office PC with the form
      const staged = await stageUploads('/api/vendor-registration', files);
      if (staged) {
        fd.append('uploadSession', staged.session);
        fd.append('uploadToken', staged.token);
        fd.append('uploadedFiles', JSON.stringify(Object.fromEntries(Object.entries(staged.files).map(([k, v]) => [k, v.filename]))));
      } else {
        Object.entries(files).forEach(([k, v]) => { if (v) fd.append(k, v); });
      }
      const res = await fetch('/api/vendor-registration/submit', { method:'POST', body:fd });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error||'Submission failed'); }
      setSubmitted(true);
    } catch(e) { setError(e.message); } finally { setSubmitting(false); }
  }

  /* ── Success Screen ── */
  if (submitted) return (
    <div className="vrf-body">
      <style>{CSS}</style>
      <Header />
      <div style={{ maxWidth:560, margin:'4rem auto', background:'#fff', borderRadius:16, boxShadow:'0 8px 32px rgba(0,0,0,.1)', padding:'3rem 2rem', textAlign:'center' }}>
        <div style={{ width:72, height:72, borderRadius:'50%', background:'#dcfce7', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 1.25rem', fontSize:32 }}>✓</div>
        <h2 style={{ fontSize:'1.4rem', fontWeight:700, color:'#15803d', margin:'0 0 .6rem' }}>Registration Submitted!</h2>
        <p style={{ color:'#64748b', lineHeight:1.7, margin:0 }}>
          Thank you for registering with Dev Accelerator Limited.<br/>
          Your application is under review by our Legal team.<br/>
          We will contact you once the review is complete.
        </p>
      </div>
    </div>
  );

  return (
    <div className="vrf-body">
      <Header />
      <div style={{ maxWidth:860, margin:'0 auto', padding:'2rem 1rem 4rem' }}>

        {/* Step Progress */}
        <StepBar current={step} total={STEPS.length} />

        {/* Form Card */}
        <div style={{ background:'#fff', borderRadius:16, boxShadow:'0 4px 24px rgba(0,0,0,.08)', overflow:'hidden' }}>

          {/* Step Header */}
          <div style={{ background:'#1C4942', padding:'1.4rem 2rem' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'0.85rem' }}>
              <div style={{ width:38, height:38, borderRadius:'50%', background:'rgba(255,255,255,.18)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'1rem', fontWeight:700, color:'#fff', flexShrink:0 }}>
                {step}
              </div>
              <div>
                <div style={{ color:'rgba(255,255,255,.65)', fontSize:'0.72rem', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.08em' }}>Step {step} of {STEPS.length}</div>
                <div style={{ color:'#fff', fontSize:'1.1rem', fontWeight:700 }}>{STEPS[step-1].label}</div>
              </div>
            </div>
          </div>

          {/* Form Body */}
          <div style={{ padding:'2rem' }}>
            {step===1 && <Step1 form={form} set={set} files={files} setF={setF} />}
            {step===2 && <Step2 form={form} set={set} files={files} setF={setF} addGstReg={addGstReg} updateGstReg={updateGstReg} removeGstReg={removeGstReg} />}
            {step===3 && <Step3 form={form} set={set} files={files} setF={setF} addTan={addTan} updateTan={updateTan} removeTan={removeTan} />}
            {step===4 && <Step4 form={form} set={set} files={files} setF={setF} />}
            {step===5 && <Step5 form={form} set={set} />}
            {step===6 && <Step6 form={form} set={set} files={files} setF={setF} />}
            {step===7 && <Step7 form={form} set={set} files={files} setF={setF} error={error} />}
          </div>

          {/* Navigation */}
          <div style={{ padding:'1.25rem 2rem', borderTop:'1px solid #f1f5f9', background:'#fafbfc', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ color:'#9BA8B0', fontSize:'13px' }}>{step < 7 ? `${7-step} step${7-step>1?'s':''} remaining` : 'Final step'}</div>
            <div style={{ display:'flex', gap:'0.75rem', alignItems:'center' }}>
              {step > 1 && <button className="vrf-btn-prev" onClick={() => setStep(s=>s-1)}>← Previous</button>}
              {step < 7
                ? <button className="vrf-btn-next" onClick={() => setStep(s=>s+1)}>Next →</button>
                : <button className="vrf-btn-submit" onClick={handleSubmit} disabled={submitting}>
                    {submitting ? 'Submitting…' : '✓ Submit Registration'}
                  </button>
              }
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

/* ─── Header ─────────────────────────────────────────────────────────────── */
function Header() {
  return (
    <div style={{ background:'#fff', borderBottom:'3px solid #16a34a', boxShadow:'0 1px 6px rgba(0,0,0,.07)', position:'sticky', top:0, zIndex:100 }}>
      <div style={{ maxWidth:860, margin:'0 auto', padding:'0.85rem 1rem', display:'flex', alignItems:'center', gap:'0.85rem' }}>
        <div style={{ width:40, height:40, borderRadius:10, background:'linear-gradient(135deg,#3b82f6,#8b5cf6)', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:800, fontSize:'0.9rem', flexShrink:0 }}>DA</div>
        <div>
          <div style={{ fontWeight:700, fontSize:'0.95rem', color:'#18191B', lineHeight:1.2 }}>Dev Accelerator Limited</div>
          <div style={{ fontSize:'0.72rem', color:'#5D6C7B' }}>Finance Suite</div>
        </div>
        <div style={{ flex:1 }} />
        <div style={{ fontWeight:600, fontSize:'0.88rem', color:'#16a34a', background:'#f0fdf4', border:'1px solid #bbf7d0', padding:'5px 12px', borderRadius:20 }}>
          Vendor Registration
        </div>
      </div>
    </div>
  );
}

/* ─── Step Bar ───────────────────────────────────────────────────────────── */
function StepBar({ current, total }) {
  return (
    <div style={{ display:'flex', alignItems:'center', marginBottom:'1.5rem', padding:'0 0.25rem' }}>
      {STEPS.map((s, i) => {
        const done   = current > s.num;
        const active = current === s.num;
        return (
          <React.Fragment key={s.num}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:5, flexShrink:0 }}>
              <div style={{
                width:34, height:34, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
                fontWeight:700, fontSize:'0.8rem',
                background: done ? '#15803D' : active ? '#1C4942' : '#fff',
                color: done||active ? '#fff' : '#9BA8B0',
                border: done ? '2px solid #15803D' : active ? '2px solid #1C4942' : '2px solid #dde3ec',
                boxShadow: active ? '0 0 0 4px rgba(28,73,66,.15)' : 'none',
                transition: 'all .2s',
              }}>
                {done ? '✓' : s.num}
              </div>
              <div className="vrf-stepper-label" style={{ fontSize:'0.68rem', fontWeight:active?600:400, color:active?'#1C4942':done?'#15803D':'#9BA8B0', whiteSpace:'nowrap' }}>
                {s.label}
              </div>
            </div>
            {i < total-1 && (
              <div style={{ flex:1, height:2, margin:'0 4px', marginBottom:20, background: done ? '#15803D' : '#dde3ec', transition:'background .3s' }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ─── Shared field primitives ─────────────────────────────────────────────── */
function Grid({ cols=2, children }) {
  return (
    <div className="vrf-grid-2" style={{ display:'grid', gridTemplateColumns:`repeat(${cols},1fr)`, gap:'1.1rem 1.4rem' }}>
      {children}
    </div>
  );
}
function F({ label, required, children, span }) {
  return (
    <div style={{ gridColumn: span ? `span ${span}` : undefined }}>
      <label style={{ display:'block', fontSize:'0.78rem', fontWeight:600, color:'#18191B', marginBottom:5, letterSpacing:'0.01em' }}>
        {label}{required && <span style={{ color:'#dc2626', marginLeft:2 }}>*</span>}
      </label>
      {children}
    </div>
  );
}
function In({ val, onChange, type='text', placeholder, maxLen, required }) {
  return <input className="vrf-in" type={type} value={val} onChange={e=>onChange(e.target.value)} placeholder={placeholder} maxLength={maxLen} required={required} />;
}
function Sel({ val, onChange, opts, required }) {
  return (
    <select className="vrf-in" value={val} onChange={e=>onChange(e.target.value)} required={required} style={{ cursor:'pointer' }}>
      <option value="">— Select —</option>
      {opts.map(o=><option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function Radio({ val, onChange, opts, required }) {
  return (
    <div className="vrf-radio-group">
      {opts.map(o=>(
        <label key={o} className={`vrf-radio-opt${val===o?' active':''}`}>
          <input type="radio" value={o} checked={val===o} onChange={()=>onChange(o)} required={required&&!val} style={{ display:'none' }} />
          {val===o ? '● ' : '○ '}{o}
        </label>
      ))}
    </div>
  );
}
function PhoneIn({ val, onChange, required }) {
  return (
    <div style={{ display:'flex' }}>
      <span style={{ padding:'11px 12px', background:'#f8fafc', border:'1.5px solid #dde3ec', borderRight:'none', borderRadius:'8px 0 0 8px', fontSize:13, color:'#5D6C7B', whiteSpace:'nowrap', fontWeight:500 }}>+91</span>
      <input className="vrf-in" type="tel" value={val} onChange={e=>onChange(e.target.value)} maxLength={10} required={required}
        style={{ borderRadius:'0 8px 8px 0', borderLeft:'none' }} placeholder="10-digit mobile" />
    </div>
  );
}
function FileUp({ label, fieldKey, files, setF, accept='.pdf,.jpg,.jpeg,.png', hint }) {
  const file = files[fieldKey];
  return (
    <div>
      <label className="vrf-file-zone">
        <input type="file" accept={accept} onChange={e=>{ const f=e.target.files[0]; if(f) setF(fieldKey,f); }} />
        <div style={{ width:32, height:32, borderRadius:7, background:'#EAF4EF', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, flexShrink:0 }}>📎</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:500, color: file?'#1C4942':'#5D6C7B', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {file ? file.name : label || 'Click to upload'}
          </div>
          <div style={{ fontSize:11, color:'#9BA8B0', marginTop:1 }}>{hint || 'PDF, JPG or PNG'}</div>
        </div>
        {file && <span style={{ color:'#15803D', fontSize:18, flexShrink:0 }}>✓</span>}
      </label>
    </div>
  );
}
function SectionDivider({ label }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', margin:'1.5rem 0 1rem' }}>
      <div style={{ height:1, flex:1, background:'#e2e8f0' }} />
      <span style={{ fontSize:'0.72rem', fontWeight:700, color:'#5D6C7B', textTransform:'uppercase', letterSpacing:'0.08em', whiteSpace:'nowrap' }}>{label}</span>
      <div style={{ height:1, flex:1, background:'#e2e8f0' }} />
    </div>
  );
}
function InfoBox({ children }) {
  return (
    <div style={{ background:'#EAF4EF', border:'1px solid #DFE7E3', borderRadius:9, padding:'10px 14px', fontSize:12.5, color:'#1C4942', lineHeight:1.6, marginBottom:'1rem' }}>
      ℹ️ {children}
    </div>
  );
}

/* ─── Step 1: Company Information ─────────────────────────────────────────── */
function Step1({ form, set, files, setF }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1.1rem' }}>
      <Grid>
        <F label="Vendor Legal Name" required>
          <In val={form.vendorLegalName} onChange={v=>set('vendorLegalName',v)} placeholder="As per government documents" required />
        </F>
        <F label="Trade Name / DBA (if different from Legal Name)">
          <In val={form.tradeName} onChange={v=>set('tradeName',v)} placeholder="Trade name or DBA" />
        </F>
        <F label="Date of Registration" required>
          <In type="date" val={form.dateOfRegistration} onChange={v=>set('dateOfRegistration',v)} required />
        </F>
        <F label="Type of Vendor">
          <Sel val={form.typeOfVendor} onChange={v=>set('typeOfVendor',v)}
            opts={['Rent/Maint. Vendors','Recurring Vendors','Consultants Vendors','Project Vendors','Other Vendors','Client']} />
        </F>
        <F label="Type of Organization" required>
          <Sel val={form.typeOfOrganization} onChange={v=>set('typeOfOrganization',v)}
            opts={[
              'Individual / Sole Proprietorship',
              'HUF (Hindu Undivided Family)',
              'Partnership Firm',
              'LLP (Limited Liability Partnership)',
              'Private Limited Company',
              'Public Limited Company',
              'Section 8 Company',
              'Trust / NGO',
              'AOP / BOI',
              'Foreign Company',
              'Government Entity',
            ]} required />
        </F>
        <F label="Company Industry" required>
          <Sel val={form.companyIndustry} onChange={v=>set('companyIndustry',v)} opts={INDUSTRIES} required />
        </F>
        <F label="Company Sector" required>
          <Sel val={form.companySector} onChange={v=>set('companySector',v)} opts={SECTORS} required />
        </F>
        <F label="Number of Employees">
          <In type="number" val={form.noOfEmployees} onChange={v=>set('noOfEmployees',v)} placeholder="e.g. 50" />
        </F>
        <F label="Description of Products / Services" required span={2}>
          <textarea className="vrf-in" value={form.descriptionOfServices} onChange={e=>set('descriptionOfServices',e.target.value)}
            rows={3} required placeholder="Briefly describe what you offer…" style={{ resize:'vertical', fontFamily:'inherit' }} />
        </F>
        <F label="Vendor Criteria" required>
          <Radio val={form.vendorCriteria} onChange={v=>set('vendorCriteria',v)} opts={['Goods','Services','Both']} required />
        </F>
        <F label="Website URL">
          <In val={form.websiteUrl} onChange={v=>set('websiteUrl',v)} placeholder="https://example.com" />
        </F>
        <F label="Do you have a brochure / catalogue?" required span={2}>
          <Radio val={form.hasBrochure} onChange={v=>set('hasBrochure',v)} opts={['Yes','No']} required />
        </F>
        {form.hasBrochure === 'Yes' && (
          <F label="Upload Company Brochure / Catalogue" span={2}>
            <FileUp fieldKey="brochureFile" files={files} setF={setF} label="Company Brochure / Catalogue" />
          </F>
        )}
      </Grid>
    </div>
  );
}

/* ─── Step 2: Address & GST ───────────────────────────────────────────────── */
function Step2({ form, set, files, setF, addGstReg, updateGstReg, removeGstReg }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1.1rem' }}>
      <SectionDivider label="Registered Office Address" />
      <Grid>
        <F label="Address Line 1" required>
          <In val={form.regOfficeAddress1} onChange={v=>set('regOfficeAddress1',v)} required />
        </F>
        <F label="Address Line 2">
          <In val={form.regOfficeAddress2} onChange={v=>set('regOfficeAddress2',v)} />
        </F>
        <F label="City" required>
          <In val={form.regCity} onChange={v=>set('regCity',v)} required />
        </F>
        <F label="State" required>
          <Sel val={form.regState} onChange={v=>set('regState',v)} opts={INDIAN_STATES} required />
        </F>
        <F label="Pin Code" required>
          <In val={form.regPinCode} onChange={v=>set('regPinCode',v)} maxLen={6} placeholder="6-digit PIN" required />
        </F>
        <F label="Country" required>
          <In val={form.regCountry} onChange={v=>set('regCountry',v)} required />
        </F>
      </Grid>

      <SectionDivider label="Billing Address" />
      <F label="Is billing address same as registered office?" required>
        <Radio val={form.billingInfoSameAsReg} onChange={v=>set('billingInfoSameAsReg',v)} opts={['Yes','No']} required />
      </F>
      {form.billingInfoSameAsReg === 'No' && (
        <Grid>
          <F label="Billing Address Line 1" required><In val={form.billingAddress1} onChange={v=>set('billingAddress1',v)} required /></F>
          <F label="Line 2"><In val={form.billingAddress2} onChange={v=>set('billingAddress2',v)} /></F>
          <F label="City" required><In val={form.billingCity} onChange={v=>set('billingCity',v)} required /></F>
          <F label="State" required><Sel val={form.billingState} onChange={v=>set('billingState',v)} opts={INDIAN_STATES} required /></F>
          <F label="Pin Code" required><In val={form.billingPinCode} onChange={v=>set('billingPinCode',v)} maxLen={6} required /></F>
          <F label="Country" required><In val={form.billingCountry} onChange={v=>set('billingCountry',v)} required /></F>
        </Grid>
      )}

      <SectionDivider label="GST & Turnover" />
      <F label="Do you have a GST Number?" required>
        <Radio val={form.hasGstNumber} onChange={v=>set('hasGstNumber',v)} opts={['Yes','No']} required />
      </F>
      {form.hasGstNumber === 'Yes' && (
        <>
          <F label="GST Registration Type" required>
            <Radio val={form.gstRegistrationStatus} onChange={v=>set('gstRegistrationStatus',v)} opts={['Regular','Composition','SEZ Unit','SEZ Developer']} required />
          </F>
          <Grid>
            <F label="GST Number (Registered Office)">
              <In val={form.gstNumberRegOffice} onChange={v=>set('gstNumberRegOffice',v)} placeholder="27AAAAA0000A1Z5" />
            </F>
            <F label="Head Office GST Number">
              <In val={form.headOfficeGstNumber} onChange={v=>set('headOfficeGstNumber',v)} />
            </F>
            <F label="Upload Registered Office GST Certificate">
              <FileUp fieldKey="regOfficeGstCertificate" files={files} setF={setF} label="GST Certificate" />
            </F>
            <F label="GST Number for Bill (if different)">
              <In val={form.gstNumberForBill} onChange={v=>set('gstNumberForBill',v)} />
            </F>
            <F label="Upload GST Certificate for Bill">
              <FileUp fieldKey="gstCertificateForBill" files={files} setF={setF} label="GST Cert (Bill)" />
            </F>
          </Grid>

          <SectionDivider label="Additional GST Registrations" />
          <div style={{ background:'#f8fafc', borderRadius:9, padding:'1rem', border:'1px solid #e2e8f0' }}>
            <div style={{ fontSize:12.5, fontWeight:600, color:'#5D6C7B', marginBottom:8 }}>Additional GST Registrations (if applicable)</div>
            {form.additionalGstRegistrations.map((row, i) => (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr 1fr auto auto', gap:'10px', alignItems:'center', padding:'8px 0', borderBottom:'1px solid #f1f5f9' }}>
                <input
                  className="vrf-in"
                  value={row.gstNumber}
                  onChange={e => updateGstReg(i, 'gstNumber', e.target.value)}
                  placeholder="GST Number"
                />
                <select
                  className="vrf-in"
                  value={row.state}
                  onChange={e => updateGstReg(i, 'state', e.target.value)}
                  style={{ cursor:'pointer' }}
                >
                  <option value="">— State —</option>
                  {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <div style={{ minWidth:160 }}>
                  <FileUp fieldKey={`additionalGstCert_${i}`} files={files} setF={setF} label="GST Certificate" hint="PDF, JPG or PNG" />
                </div>
                <button type="button" className="vrf-rm" onClick={() => removeGstReg(i)}>Remove</button>
              </div>
            ))}
            <button type="button" className="vrf-add-row" onClick={addGstReg} style={{ marginTop:8 }}>+ Add GST Registration</button>
          </div>
        </>
      )}
      <Grid>
        <F label="Turnover — Previous Financial Year (₹)" required>
          <In type="number" val={form.turnoverPreviousFY} onChange={v=>set('turnoverPreviousFY',v)} placeholder="0.00" required />
        </F>
        <F label="Turnover — Current Financial Year (₹)" required>
          <In type="number" val={form.turnoverCurrentFY} onChange={v=>set('turnoverCurrentFY',v)} placeholder="0.00" required />
        </F>
      </Grid>
    </div>
  );
}

/* ─── Step 3: Statutory Details ───────────────────────────────────────────── */
function Step3({ form, set, files, setF, addTan, updateTan, removeTan }) {
  const org = form.typeOfOrganization || '';
  let regLabel = 'Registration Number / CIN / LLPIN';
  if (org === 'Private Limited Company' || org === 'Public Limited Company') {
    regLabel = 'CIN (Corporate Identification Number)';
  } else if (org === 'LLP (Limited Liability Partnership)') {
    regLabel = 'LLPIN (LLP Identification Number)';
  } else if (org === 'Individual / Sole Proprietorship') {
    regLabel = 'Registration Number (if any)';
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1.1rem' }}>
      <SectionDivider label="Organization Identity" />
      <Grid>
        <F label={regLabel}>
          <In val={form.orgRegistrationNumber} onChange={v=>set('orgRegistrationNumber',v)} placeholder="CIN / LLPIN or other unique ID" />
        </F>
        <F label="Upload Registration Proof">
          <FileUp fieldKey="orgRegistrationProof" files={files} setF={setF} label="Registration Document" />
        </F>
        <F label="Organization PAN" required>
          <In val={form.orgPan} onChange={v=>set('orgPan',v.toUpperCase())} maxLen={10} placeholder="AAAAA0000A" required />
        </F>
        <F label="Upload Organization PAN Card" required>
          <FileUp fieldKey="orgPanCard" files={files} setF={setF} label="PAN Card" />
        </F>
      </Grid>

      <SectionDivider label="TAN Details" />
      <F label="Do you have a TAN Number?" required>
        <Radio val={form.hasTanNumber} onChange={v=>set('hasTanNumber',v)} opts={['Yes','No']} required />
      </F>
      {form.hasTanNumber === 'Yes' && (
        <>
          <Grid>
            <F label="Organization TAN Number">
              <In val={form.tanNumber} onChange={v=>set('tanNumber',v)} placeholder="AAAA00000A" />
            </F>
            <F label="Upload TAN Certificate">
              <FileUp fieldKey="tanCertificate" files={files} setF={setF} label="TAN Letter / Certificate" />
            </F>
          </Grid>
          <F label="Does the company have multiple TAN numbers?">
            <Radio val={form.hasMultipleTanNumbers} onChange={v=>set('hasMultipleTanNumbers',v)} opts={['Yes','No']} />
          </F>
          {form.hasMultipleTanNumbers === 'Yes' && (
            <div style={{ background:'#f8fafc', borderRadius:9, padding:'1rem', border:'1px solid #e2e8f0' }}>
              <div style={{ fontSize:12.5, fontWeight:600, color:'#5D6C7B', marginBottom:8 }}>Additional TAN Numbers</div>
              {form.additionalTanNumbers.map((row,i)=>(
                <div key={i} className="vrf-tan-row">
                  <input className="vrf-in" value={row.tanNumber} onChange={e=>updateTan(i,e.target.value)} placeholder="TAN Number" style={{ flex:1 }} />
                  <button type="button" className="vrf-rm" onClick={()=>removeTan(i)}>Remove</button>
                </div>
              ))}
              <button type="button" className="vrf-add-row" onClick={addTan} style={{ marginTop:8 }}>+ Add TAN</button>
            </div>
          )}
        </>
      )}

      <SectionDivider label="MSME / UDYAM" />
      <F label="Do you register under MSME / UDYAM?" required>
        <Radio val={form.registerUnderMsme} onChange={v=>set('registerUnderMsme',v)} opts={['Yes','No']} required />
      </F>
      {form.registerUnderMsme === 'Yes' && (
        <Grid>
          <F label="MSME / UDYAM Number"><In val={form.msmeUdyamNumber} onChange={v=>set('msmeUdyamNumber',v)} /></F>
          <F label="MSME Category"><Sel val={form.msmeCategory} onChange={v=>set('msmeCategory',v)} opts={MSME_CATS} /></F>
          <F label="MSME Sector"><Sel val={form.msmeSector} onChange={v=>set('msmeSector',v)} opts={MSME_SECS} /></F>
          <F label="FY of latest MSME Renewal Certificate"><In val={form.msmeFY} onChange={v=>set('msmeFY',v)} placeholder="e.g. 2025-2026" /></F>
          <F label="Upload MSME Certificate" span={2}><FileUp fieldKey="msmeCertificate" files={files} setF={setF} label="MSME Certificate" /></F>
        </Grid>
      )}

      <SectionDivider label="Other Registrations" />
      <Grid>
        <F label="Do you have Professional Tax Number?" required>
          <Radio val={form.hasProfessionalTax} onChange={v=>set('hasProfessionalTax',v)} opts={['Yes','No']} required />
        </F>
        {form.hasProfessionalTax === 'Yes' && (
          <F label="PT Number"><In val={form.ptNumber} onChange={v=>set('ptNumber',v)} /></F>
        )}
        {form.hasProfessionalTax === 'Yes' && (
          <F label="Upload PT Certificate"><FileUp fieldKey="ptCertificate" files={files} setF={setF} label="PT Certificate" /></F>
        )}
      </Grid>
      <Grid>
        <F label="Do you have Provident Fund Number?" required>
          <Radio val={form.hasProvidentFund} onChange={v=>set('hasProvidentFund',v)} opts={['Yes','No']} required />
        </F>
        {form.hasProvidentFund === 'Yes' && (
          <F label="PF Number"><In val={form.pfNumber} onChange={v=>set('pfNumber',v)} /></F>
        )}
        {form.hasProvidentFund === 'Yes' && (
          <F label="Upload PF Certificate"><FileUp fieldKey="pfCertificate" files={files} setF={setF} label="PF Certificate" /></F>
        )}
      </Grid>
      <Grid>
        <F label="Do you have ESI Number?" required>
          <Radio val={form.hasEsi} onChange={v=>set('hasEsi',v)} opts={['Yes','No']} required />
        </F>
        {form.hasEsi === 'Yes' && (
          <F label="ESI Number"><In val={form.esiNumber} onChange={v=>set('esiNumber',v)} /></F>
        )}
        {form.hasEsi === 'Yes' && (
          <F label="Upload ESIC Certificate"><FileUp fieldKey="esiCertificate" files={files} setF={setF} label="ESIC Certificate" /></F>
        )}
      </Grid>

      <SectionDivider label="Shops & Establishment" />
      <Grid>
        <F label="Shops & Establishment License Number">
          <In val={form.shopsEstLicenseNumber} onChange={v=>set('shopsEstLicenseNumber',v)} placeholder="License number (if applicable)" />
        </F>
        {form.shopsEstLicenseNumber && (
          <F label="State of Registration">
            <Sel val={form.shopsEstState} onChange={v=>set('shopsEstState',v)} opts={INDIAN_STATES} />
          </F>
        )}
        {form.shopsEstLicenseNumber && (
          <F label="Upload S&E Certificate" span={2}>
            <FileUp fieldKey="shopsEstCertificate" files={files} setF={setF} label="Shops & Establishment Certificate" />
          </F>
        )}
      </Grid>
    </div>
  );
}

/* ─── Step 4: Authorized Signatory ───────────────────────────────────────── */
function Step4({ form, set, files, setF }) {
  const org = form.typeOfOrganization || '';
  const showDin = org.includes('Private Limited') || org.includes('Public Limited') || org.includes('LLP');

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1.1rem' }}>
      <InfoBox>Please mention details of the person who shall sign agreements and official letters on your company's behalf.</InfoBox>
      <SectionDivider label="Personal Details" />
      <Grid>
        <F label="Full Name" required><In val={form.signatoryName} onChange={v=>set('signatoryName',v)} required /></F>
        <F label="Designation" required><In val={form.signatoryDesignation} onChange={v=>set('signatoryDesignation',v)} required /></F>
        <F label="Mobile Number" required>
          <PhoneIn val={form.signatoryMobile} onChange={v=>set('signatoryMobile',v)} required />
        </F>
        <F label="Alternate Number">
          <PhoneIn val={form.signatoryAlternateMobile} onChange={v=>set('signatoryAlternateMobile',v)} />
        </F>
        <F label="Email Address" required span={2}>
          <In type="email" val={form.signatoryEmail} onChange={v=>set('signatoryEmail',v)} required placeholder="signatory@company.com" />
        </F>
        {showDin && (
          <F label="Director Identification Number (DIN)" span={2}>
            <In val={form.signatoryDIN} onChange={v=>set('signatoryDIN',v)} maxLen={8} placeholder="8-digit DIN" />
          </F>
        )}
      </Grid>

      <SectionDivider label="Identity Documents" />
      <Grid>
        <F label="Aadhar Card Number" required>
          <In val={form.signatoryAadharNumber} onChange={v=>set('signatoryAadharNumber',v.replace(/\D/g,''))} maxLen={12} placeholder="12-digit Aadhar number" required />
        </F>
        <F label="Upload Self-attested Aadhar Card" required>
          <FileUp fieldKey="signatoryAadharCard" files={files} setF={setF} label="Aadhar Card" />
        </F>
        <F label="Is PAN same as Statutory (Organization) PAN?" required>
          <Radio val={form.signatoryPanSameAsOrg} onChange={v=>set('signatoryPanSameAsOrg',v)} opts={['Yes','No']} required />
        </F>
        <F label="PAN Card Number" required>
          <In val={form.signatoryPanNumber} onChange={v=>set('signatoryPanNumber',v.toUpperCase())} maxLen={10} placeholder="AAAAA0000A" required />
        </F>
        <F label="Upload Self-attested PAN Card" required>
          <FileUp fieldKey="signatoryPanCard" files={files} setF={setF} label="PAN Card" />
        </F>
        <F label="Upload Board Resolution" required>
          <FileUp fieldKey="boardResolution" files={files} setF={setF} label="Board Resolution (authorizing signatory)" />
        </F>
      </Grid>
    </div>
  );
}

/* ─── Step 5: Finance Team ─────────────────────────────────────────────────── */
function Step5({ form, set }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1.1rem' }}>
      <InfoBox>In case of only one finance member, mention the SPOC / Admin person in secondary contact details. This person should have full knowledge of the present deal with DevX.</InfoBox>

      <SectionDivider label="Primary Finance Contact" />
      <Grid>
        <F label="Full Name" required><In val={form.primaryFinanceContactName} onChange={v=>set('primaryFinanceContactName',v)} required /></F>
        <F label="Designation" required><In val={form.primaryFinanceDesignation} onChange={v=>set('primaryFinanceDesignation',v)} required /></F>
        <F label="Mobile Number" required>
          <PhoneIn val={form.primaryFinanceMobile} onChange={v=>set('primaryFinanceMobile',v)} required />
        </F>
        <F label="Email Address" required>
          <In type="email" val={form.primaryFinanceEmail} onChange={v=>set('primaryFinanceEmail',v)} required placeholder="finance@company.com" />
        </F>
      </Grid>

      <SectionDivider label="Secondary Finance Contact (Optional)" />
      <Grid>
        <F label="Full Name"><In val={form.secondaryFinanceContactName} onChange={v=>set('secondaryFinanceContactName',v)} /></F>
        <F label="Designation"><In val={form.secondaryFinanceDesignation} onChange={v=>set('secondaryFinanceDesignation',v)} /></F>
        <F label="Mobile Number">
          <PhoneIn val={form.secondaryFinanceMobile} onChange={v=>set('secondaryFinanceMobile',v)} />
        </F>
        <F label="Email Address">
          <In type="email" val={form.secondaryFinanceEmail} onChange={v=>set('secondaryFinanceEmail',v)} placeholder="backup@company.com" />
        </F>
      </Grid>
    </div>
  );
}

/* ─── Step 6: Bank Account ─────────────────────────────────────────────────── */
function Step6({ form, set, files, setF }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1.1rem' }}>
      <InfoBox>Please mention the bank account details where deposits / payments need to be transferred.</InfoBox>
      <Grid>
        <F label="Bank Name" required><In val={form.bankName} onChange={v=>set('bankName',v)} required placeholder="e.g. HDFC Bank" /></F>
        <F label="IFSC Code" required><In val={form.ifscCode} onChange={v=>set('ifscCode',v.toUpperCase())} maxLen={11} required placeholder="HDFC0001234" /></F>
        <F label="Branch Name" required><In val={form.branchName} onChange={v=>set('branchName',v)} required /></F>
        <F label="Swift Code (for international)"><In val={form.swiftCode} onChange={v=>set('swiftCode',v.toUpperCase())} maxLen={11} placeholder="Optional" /></F>
        <F label="Account Type" required>
          <Sel val={form.accountType} onChange={v=>set('accountType',v)} opts={['Savings Account','Current Account','NRI Account']} required />
        </F>
        <F label="MICR Code"><In val={form.micrCode} onChange={v=>set('micrCode',v)} maxLen={9} placeholder="9-digit code" /></F>
        <F label="Account Number" required><In val={form.accountNumber} onChange={v=>set('accountNumber',v)} required /></F>
        <F label="Confirm Account Number" required><In val={form.confirmAccountNumber} onChange={v=>set('confirmAccountNumber',v)} required placeholder="Re-enter account number" /></F>
        <F label="Upload Cancelled Cheque" required>
          <FileUp fieldKey="cancelledCheque" files={files} setF={setF} label="Cancelled Cheque" hint="PDF, JPG or PNG only" />
        </F>
      </Grid>
    </div>
  );
}

/* ─── Step 7: E-Sign & Terms ──────────────────────────────────────────────── */
function Step7({ form, set, files, setF, error }) {
  const TERMS = [
    'We/I hereby declare that we are compliant with all applicable laws, legislation, rules, and regulations and have obtained all necessary licenses and approvals to carry out our business and shall keep the same valid throughout the term of the transaction with Dev Accelerator Limited.',
    'We hereby declare that neither any past or ongoing legal proceedings have been initiated against us nor have we received any notice or letter that would directly or indirectly impact Dev Accelerator Limited.',
    'We hereby declare that we shall be bound to inform Dev Accelerator Limited immediately in the event any such proceeding or legal notice as mentioned above is initiated or received by us.',
    'We hereby declare that we shall inform Dev Accelerator Limited promptly if we intend to initiate winding-up processes or insolvency proceedings in any court of law, statutory authority or tribunal.',
    'We hereby declare that all the information provided above is true and correct.',
  ];
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1.25rem' }}>
      <SectionDivider label="E-Sign Details" />
      <InfoBox>Please provide the details of the person filling this form for the Aadhar e-Sign process. The e-sign link will be sent to the email address provided below.</InfoBox>
      <Grid>
        <F label="Signer Name"><In val={form.esignSignerName} onChange={v=>set('esignSignerName',v)} /></F>
        <F label="Signer Email (e-sign link will be sent here)">
          <In type="email" val={form.esignSignerEmail} onChange={v=>set('esignSignerEmail',v)} />
        </F>
        <F label="Upload Aadhar PDF for E-Sign" span={2}>
          <FileUp fieldKey="esignAadharPdf" files={files} setF={setF} label="Aadhar PDF (max 10 MB)" accept=".pdf" hint="PDF only, max 10 MB" />
        </F>
      </Grid>

      <SectionDivider label="Terms & Conditions" />
      <div style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:10, padding:'1.1rem 1.25rem' }}>
        <ul style={{ margin:0, paddingLeft:'1.2rem', display:'flex', flexDirection:'column', gap:'0.6rem' }}>
          {TERMS.map((t,i)=>(
            <li key={i} style={{ fontSize:13, color:'#5D6C7B', lineHeight:1.65 }}>{t}</li>
          ))}
        </ul>
      </div>

      <label className="vrf-check-wrap">
        <input type="checkbox" checked={form.acceptedTerms} onChange={e=>set('acceptedTerms',e.target.checked)} />
        <span style={{ fontSize:13.5, fontWeight:600, color:'#15803d', lineHeight:1.5 }}>
          We hereby accept all terms and conditions mentioned above
        </span>
      </label>

      <F label="Suggestions / Questions (Optional)">
        <textarea className="vrf-in" value={form.suggestions} onChange={e=>set('suggestions',e.target.value)}
          rows={3} placeholder="Any feedback or queries…" style={{ resize:'vertical', fontFamily:'inherit' }} />
      </F>

      {error && (
        <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:8, padding:'10px 14px', color:'#dc2626', fontSize:13.5 }}>
          ⚠️ {error}
        </div>
      )}
    </div>
  );
}
