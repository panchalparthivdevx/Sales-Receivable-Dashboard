import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, withToken } from '../utils/api';

const STATUS_META = {
  pending_legal:     { label: 'Pending Legal',     color: '#f59e0b', bg: '#fef3c7' },
  pending_accounts:  { label: 'Pending Accounts',  color: '#3b82f6', bg: '#dbeafe' },
  legal_rejected:    { label: 'Legal Rejected',    color: '#ef4444', bg: '#fee2e2' },
  accounts_rejected: { label: 'Accounts Rejected', color: '#ef4444', bg: '#fee2e2' },
  completed:         { label: 'Completed',         color: '#10b981', bg: '#d1fae5' },
};

export default function VendorRegistrations() {
  const [list, setList]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail]     = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [tab, setTab]           = useState('all');
  const [modal, setModal]       = useState(null); // { type: 'legal'|'accounts', action: 'approve'|'reject' }
  const [reviewNote, setReviewNote]   = useState('');
  const [reviewerName, setReviewerName] = useState('');
  const [existingZohoId, setExistingZohoId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [copyMsg, setCopyMsg] = useState('');

  // Zoho vendor search state
  const [zohoMode, setZohoMode]       = useState(null); // 'link' | 'new' | null
  const [zohoSearch, setZohoSearch]   = useState('');
  const [zohoResults, setZohoResults] = useState([]);
  const [zohoSearching, setZohoSearching] = useState(false);
  const [selectedZoho, setSelectedZoho]   = useState(null); // { contact_id, contact_name, company_name }
  const searchTimer = useRef(null);

  const localUrl  = `${window.location.protocol}//${window.location.hostname}:${window.location.port || 3002}/vendor-register`;
  const [publicUrl, setPublicUrl] = useState(null);
  const formLink = publicUrl || localUrl;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listData, urlData] = await Promise.allSettled([
        api.vendorRegistrationList(),
        fetch('/api/vendor-registration/public-url').then(r => r.json()),
      ]);
      if (listData.status === 'fulfilled') setList(listData.value);
      if (urlData.status === 'fulfilled' && urlData.value?.publicUrl) setPublicUrl(urlData.value.publicUrl + '/vendor-register');
    } catch (_) {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function openDetail(id) {
    setSelected(id);
    setLoadingDetail(true);
    setDetail(null);
    try { setDetail(await api.vendorRegistrationDetail(id)); } catch (_) {}
    setLoadingDetail(false);
  }

  function closeDetail() { setSelected(null); setDetail(null); }

  function openModal(type, action) {
    setModal({ type, action });
    setReviewNote('');
    setReviewerName('');
    setExistingZohoId('');
    setZohoMode(null);
    setZohoSearch('');
    setZohoResults([]);
    setSelectedZoho(null);
  }

  function handleZohoSearch(q) {
    setZohoSearch(q);
    setZohoResults([]);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q || q.length < 2) { setZohoSearching(false); return; }
    setZohoSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await api.vendorZohoSearch(q);
        setZohoResults(res.vendors || []);
      } catch (_) {}
      setZohoSearching(false);
    }, 400);
  }

  function selectZohoVendor(v) {
    setSelectedZoho(v);
    setExistingZohoId(v.contact_id);
    setZohoResults([]);
    setZohoSearch('');
  }

  function clearZohoSelection() {
    setSelectedZoho(null);
    setExistingZohoId('');
    setZohoSearch('');
    setZohoResults([]);
  }

  async function submitReview() {
    if (!reviewerName.trim()) { alert('Please enter your name.'); return; }
    if (modal.type === 'accounts' && modal.action === 'approve' && !zohoMode) {
      alert('Please choose: link to an existing Zoho vendor or create a new one.'); return;
    }
    if (modal.type === 'accounts' && modal.action === 'approve' && zohoMode === 'link' && !selectedZoho) {
      alert('Please search and select an existing Zoho Books vendor.'); return;
    }
    setSubmitting(true);
    try {
      let result;
      if (modal.type === 'legal') {
        result = await api.vendorRegistrationLegal(selected, modal.action, reviewNote, reviewerName);
      } else {
        result = await api.vendorRegistrationAccounts(selected, modal.action, reviewNote, reviewerName, existingZohoId);
      }
      setModal(null);
      await load();
      await openDetail(selected);
      if (result?.zohoSyncError) {
        alert(`✓ Approval saved, but Zoho Books sync failed:\n\n${result.zohoSyncError}\n\nUse "Retry Zoho Sync" in the detail panel to try again.`);
      }
    } catch (err) {
      alert(err?.response?.data?.error || err.message || 'Error submitting review');
    }
    setSubmitting(false);
  }

  async function retryZohoSync(id, zohoContactId) {
    try {
      const result = await api.vendorRegistrationRetryZoho(id, zohoContactId);
      if (result?.zohoSyncError) {
        alert(`Zoho sync still failing:\n\n${result.zohoSyncError}`);
      } else {
        alert('Zoho sync successful!');
      }
      await load();
      await openDetail(id);
    } catch (err) {
      alert(err?.response?.data?.error || err.message || 'Retry failed');
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(formLink).then(() => {
      setCopyMsg('Copied!');
      setTimeout(() => setCopyMsg(''), 2000);
    });
  }

  const tabs = [
    { id: 'all',      label: 'All' },
    { id: 'pending_legal',    label: 'Pending Legal' },
    { id: 'pending_accounts', label: 'Pending Accounts' },
    { id: 'completed',        label: 'Completed' },
    { id: 'rejected',         label: 'Rejected' },
  ];

  const filtered = list.filter(r => {
    if (tab === 'all') return true;
    if (tab === 'rejected') return r.status === 'legal_rejected' || r.status === 'accounts_rejected';
    return r.status === tab;
  });

  return (
    <div style={S.page}>
      <div style={S.topBar}>
        <div>
          <h2 style={S.pageTitle}>Vendor Registrations</h2>
          <p style={S.pageSub}>Review and approve incoming vendor registration requests</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
            <div style={S.linkBox}>
              <span style={S.linkText}>{formLink}</span>
              <button onClick={copyLink} style={S.copyBtn}>{copyMsg || 'Copy Link'}</button>
            </div>
            {!publicUrl && (
              <span style={{ fontSize: '0.7rem', color: '#f59e0b', fontWeight: 500 }}>
                ⚠ Local URL — set VENDOR_FORM_PUBLIC_URL in .env for public access
              </span>
            )}
            {publicUrl && (
              <span style={{ fontSize: '0.7rem', color: '#10b981', fontWeight: 500 }}>
                ✓ Public URL configured
              </span>
            )}
          </div>
          <button onClick={load} style={S.refreshBtn}>↻ Refresh</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabRow}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ ...S.tabBtn, ...(tab === t.id ? S.tabBtnActive : {}) }}>
            {t.label}
            <span style={{ ...S.tabCount, ...(tab === t.id ? { background: '#1C4942', color: '#fff' } : {}) }}>
              {t.id === 'all' ? list.length :
               t.id === 'rejected' ? list.filter(r => r.status.includes('rejected')).length :
               list.filter(r => r.status === t.id).length}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div style={S.empty}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={S.empty}>No registrations found</div>
      ) : (
        <div style={S.table}>
          <div style={S.thead}>
            <div style={{ ...S.th, flex: 2 }}>Vendor Name</div>
            <div style={S.th}>Type</div>
            <div style={S.th}>Sector</div>
            <div style={S.th}>Submitted</div>
            <div style={S.th}>Status</div>
            <div style={S.th}>Action</div>
          </div>
          {filtered.map(r => {
            const sm = STATUS_META[r.status] || { label: r.status, color: '#9BA8B0', bg: '#FFFFFF' };
            return (
              <div key={r.id} style={S.trow}>
                <div style={{ ...S.td, flex: 2, fontWeight: 600, color: '#18191B' }}>{r.vendorLegalName || '—'}</div>
                <div style={S.td}>{r.typeOfVendor || '—'}</div>
                <div style={S.td}>{r.companySector || '—'}</div>
                <div style={S.td}>{r.submittedAt ? new Date(r.submittedAt).toLocaleDateString('en-IN') : '—'}</div>
                <div style={S.td}>
                  <span style={{ ...S.badge, background: sm.bg, color: sm.color }}>{sm.label}</span>
                </div>
                <div style={S.td}>
                  <button onClick={() => openDetail(r.id)} style={S.viewBtn}>View</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Detail Panel ──────────────────────────────────────────────────── */}
      {selected && (
        <div style={S.overlay} onClick={closeDetail}>
          <div style={S.panel} onClick={e => e.stopPropagation()}>
            <div style={S.panelHeader}>
              <span style={S.panelTitle}>{detail?.data?.vendorLegalName || 'Loading…'}</span>
              <button onClick={closeDetail} style={S.closeBtn}>✕</button>
            </div>

            {loadingDetail ? (
              <div style={{ padding: '2rem', color: '#9BA8B0', textAlign: 'center' }}>Loading…</div>
            ) : detail ? (
              <div style={S.panelBody}>
                {/* Status */}
                <div style={S.statusRow}>
                  {(() => { const sm = STATUS_META[detail.status] || { label: detail.status, color: '#9BA8B0', bg: '#FFFFFF' };
                    return <span style={{ ...S.badge, background: sm.bg, color: sm.color, fontSize: '0.82rem' }}>{sm.label}</span>; })()}
                  {detail.zohoContactId && (
                    <span style={S.zohoTag}>Zoho ID: {detail.zohoContactId}</span>
                  )}
                </div>

                {/* Data sections */}
                <DetailSection title="Vendor Details">
                  <DetailRow label="Legal Name"         val={detail.data?.vendorLegalName} />
                  <DetailRow label="Date of Registration" val={detail.data?.dateOfRegistration} />
                  <DetailRow label="Type of Vendor"     val={detail.data?.typeOfVendor} />
                  <DetailRow label="Organization Type"  val={detail.data?.typeOfOrganization} />
                  <DetailRow label="Industry"           val={detail.data?.companyIndustry} />
                  <DetailRow label="Sector"             val={detail.data?.companySector} />
                  <DetailRow label="Vendor Criteria"    val={detail.data?.vendorCriteria} />
                  <DetailRow label="Website"            val={detail.data?.websiteUrl} />
                  <DetailRow label="Description" val={detail.data?.descriptionOfServices} full />
                </DetailSection>

                <DetailSection title="Registered Address">
                  <DetailRow label="Address" val={[detail.data?.regOfficeAddress1, detail.data?.regOfficeAddress2].filter(Boolean).join(', ')} />
                  <DetailRow label="City / State / PIN" val={`${detail.data?.regCity}, ${detail.data?.regState} — ${detail.data?.regPinCode}`} />
                  <DetailRow label="Country" val={detail.data?.regCountry} />
                </DetailSection>

                <DetailSection title="Invoicing & GST">
                  <DetailRow label="Has GST"             val={detail.data?.hasGstNumber} />
                  <DetailRow label="GST (Reg. Office)"   val={detail.data?.gstNumberRegOffice} />
                  <DetailRow label="Head Office GST"     val={detail.data?.headOfficeGstNumber} />
                  <DetailRow label="GST for Bill"        val={detail.data?.gstNumberForBill} />
                  <DetailRow label="Turnover (Prev FY)"  val={detail.data?.turnoverPreviousFY ? `₹ ${Number(detail.data.turnoverPreviousFY).toLocaleString('en-IN')}` : ''} />
                  <DetailRow label="Turnover (Curr FY)"  val={detail.data?.turnoverCurrentFY ? `₹ ${Number(detail.data.turnoverCurrentFY).toLocaleString('en-IN')}` : ''} />
                </DetailSection>

                <DetailSection title="Statutory">
                  <DetailRow label="Org Reg. No."    val={detail.data?.orgRegistrationNumber} />
                  <DetailRow label="PAN"             val={detail.data?.orgPan} />
                  <DetailRow label="TAN"             val={detail.data?.tanNumber} />
                  <DetailRow label="MSME No."        val={detail.data?.msmeUdyamNumber} />
                  <DetailRow label="MSME Category"   val={detail.data?.msmeCategory} />
                  <DetailRow label="PT No."          val={detail.data?.ptNumber} />
                  <DetailRow label="PF No."          val={detail.data?.pfNumber} />
                  <DetailRow label="ESI No."         val={detail.data?.esiNumber} />
                </DetailSection>

                <DetailSection title="Authorized Signatory">
                  <DetailRow label="Name"        val={detail.data?.signatoryName} />
                  <DetailRow label="Designation" val={detail.data?.signatoryDesignation} />
                  <DetailRow label="Mobile"      val={detail.data?.signatoryMobile ? '+91 ' + detail.data.signatoryMobile : ''} />
                  <DetailRow label="Email"       val={detail.data?.signatoryEmail} />
                  <DetailRow label="Aadhar No."  val={detail.data?.signatoryAadharNumber} />
                  <DetailRow label="PAN"         val={detail.data?.signatoryPanNumber} />
                </DetailSection>

                <DetailSection title="Finance Team">
                  <DetailRow label="Primary Contact" val={detail.data?.primaryFinanceContactName} />
                  <DetailRow label="Primary Email"   val={detail.data?.primaryFinanceEmail} />
                  <DetailRow label="Primary Mobile"  val={detail.data?.primaryFinanceMobile ? '+91 ' + detail.data.primaryFinanceMobile : ''} />
                  <DetailRow label="Secondary Contact" val={detail.data?.secondaryFinanceContactName} />
                  <DetailRow label="Secondary Email"   val={detail.data?.secondaryFinanceEmail} />
                </DetailSection>

                <DetailSection title="Bank Account">
                  <DetailRow label="Bank"           val={detail.data?.bankName} />
                  <DetailRow label="IFSC"           val={detail.data?.ifscCode} />
                  <DetailRow label="Branch"         val={detail.data?.branchName} />
                  <DetailRow label="Account Type"   val={detail.data?.accountType} />
                  <DetailRow label="Account No."    val={detail.data?.accountNumber} />
                  <DetailRow label="MICR"           val={detail.data?.micrCode} />
                  <DetailRow label="Swift"          val={detail.data?.swiftCode} />
                </DetailSection>

                {/* Uploaded Files */}
                {detail.files && Object.keys(detail.files).length > 0 && (
                  <DetailSection title="Uploaded Documents">
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                      {Object.entries(detail.files).map(([field, fname]) => fname && (
                        <a key={field} href={withToken(`/api/vendor-registrations/${detail.id}/file/${field}`)}
                          target="_blank" rel="noreferrer" style={S.fileLink}>
                          {FIELD_LABELS[field] || field}
                        </a>
                      ))}
                    </div>
                  </DetailSection>
                )}

                {/* Review History */}
                {(detail.legalReviewedAt || detail.accountsReviewedAt) && (
                  <DetailSection title="Review History">
                    {detail.legalReviewedAt && (
                      <div style={S.historyItem}>
                        <span style={S.histLabel}>Legal Review</span>
                        <span>{detail.legalReviewedBy} · {new Date(detail.legalReviewedAt).toLocaleString('en-IN')}</span>
                        {detail.legalNote && <span style={S.histNote}>"{detail.legalNote}"</span>}
                      </div>
                    )}
                    {detail.accountsReviewedAt && (
                      <div style={S.historyItem}>
                        <span style={S.histLabel}>Accounts Review</span>
                        <span>{detail.accountsReviewedBy} · {new Date(detail.accountsReviewedAt).toLocaleString('en-IN')}</span>
                        {detail.accountsNote && <span style={S.histNote}>"{detail.accountsNote}"</span>}
                      </div>
                    )}
                  </DetailSection>
                )}

                {/* Zoho sync error banner */}
                {detail.zohoSyncError && (
                  <div style={{ background: '#2d1010', border: '1px solid #7f1d1d', borderRadius: 6, padding: '0.65rem 0.85rem', marginBottom: '0.75rem', fontSize: '0.8rem', color: '#fca5a5' }}>
                    <strong>Zoho Sync Failed:</strong> {detail.zohoSyncError}
                  </div>
                )}

                {/* Action Buttons */}
                <div style={S.actionRow}>
                  {detail.status === 'pending_legal' && <>
                    <button onClick={() => openModal('legal', 'approve')} style={S.approveBtn}>✓ Legal Approve</button>
                    <button onClick={() => openModal('legal', 'reject')}  style={S.rejectBtn}>✗ Legal Reject</button>
                  </>}
                  {detail.status === 'pending_accounts' && <>
                    <button onClick={() => openModal('accounts', 'approve')} style={S.approveBtn}>✓ Accounts Approve &amp; Sync to Zoho</button>
                    <button onClick={() => openModal('accounts', 'reject')}  style={S.rejectBtn}>✗ Accounts Reject</button>
                  </>}
                  {detail.status === 'completed' && (
                    <button onClick={() => retryZohoSync(detail.id, detail.zohoContactId || detail.existingZohoContactId)} style={S.approveBtn}>↺ Sync to Zoho Books</button>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ padding: '2rem', color: '#DC2626', textAlign: 'center' }}>Failed to load details.</div>
            )}
          </div>
        </div>
      )}

      {/* ── Review Modal ──────────────────────────────────────────────────── */}
      {modal && (
        <div style={S.overlay} onClick={() => setModal(null)}>
          <div style={{ ...S.panel, maxWidth: 480, maxHeight: '80vh' }} onClick={e => e.stopPropagation()}>
            <div style={S.panelHeader}>
              <span style={S.panelTitle}>
                {modal.type === 'legal' ? 'Legal' : 'Accounts'} — {modal.action === 'approve' ? 'Approve' : 'Reject'}
              </span>
              <button onClick={() => setModal(null)} style={S.closeBtn}>✕</button>
            </div>
            <div style={{ padding: '1.25rem' }}>
              <div style={S.formGroup}>
                <label style={S.mLabel}>Your Name *</label>
                <input value={reviewerName} onChange={e => setReviewerName(e.target.value)}
                  style={S.mInput} placeholder="Enter your name" />
              </div>
              <div style={S.formGroup}>
                <label style={S.mLabel}>Note / Remarks</label>
                <textarea value={reviewNote} onChange={e => setReviewNote(e.target.value)}
                  rows={3} style={S.mTextarea} placeholder="Optional note or reason" />
              </div>
              {modal.type === 'accounts' && modal.action === 'approve' && (
                <div style={S.formGroup}>
                  <label style={S.mLabel}>Zoho Books — What would you like to do?</label>
                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <button
                      onClick={() => { setZohoMode('link'); clearZohoSelection(); }}
                      style={{ ...S.modeBtn, ...(zohoMode === 'link' ? S.modeBtnActive : {}) }}>
                      🔗 Link to existing vendor
                    </button>
                    <button
                      onClick={() => { setZohoMode('new'); clearZohoSelection(); }}
                      style={{ ...S.modeBtn, ...(zohoMode === 'new' ? S.modeBtnActiveNew : {}) }}>
                      ＋ Create new vendor
                    </button>
                  </div>

                  {zohoMode === 'link' && (
                    selectedZoho ? (
                      <div style={S.selectedVendor}>
                        <div>
                          <div style={{ color: '#18191B', fontWeight: 600, fontSize: '0.88rem' }}>{selectedZoho.contact_name || selectedZoho.company_name}</div>
                          {selectedZoho.company_name && selectedZoho.company_name !== selectedZoho.contact_name && (
                            <div style={{ color: '#9BA8B0', fontSize: '0.75rem' }}>{selectedZoho.company_name}</div>
                          )}
                          <div style={{ color: '#5D6C7B', fontSize: '0.72rem', marginTop: 2 }}>Zoho ID: {selectedZoho.contact_id}</div>
                        </div>
                        <button onClick={clearZohoSelection} style={S.clearBtn}>✕ Change</button>
                      </div>
                    ) : (
                      <div style={{ position: 'relative' }}>
                        <input
                          value={zohoSearch}
                          onChange={e => handleZohoSearch(e.target.value)}
                          style={S.mInput}
                          placeholder="Type vendor name to search Zoho Books…"
                          autoFocus
                        />
                        {zohoSearching && (
                          <div style={{ color: '#5D6C7B', fontSize: '0.78rem', marginTop: 4 }}>Searching…</div>
                        )}
                        {zohoResults.length > 0 && (
                          <div style={S.resultsDropdown}>
                            {zohoResults.map(v => {
                              const displayName = v.contact_name || v.company_name || '(No name)';
                              return (
                                <div key={v.contact_id} onClick={() => selectZohoVendor(v)} style={S.resultItem}
                                  onMouseEnter={e => e.currentTarget.style.background='#EAF4EF'}
                                  onMouseLeave={e => e.currentTarget.style.background=''}>
                                  <div style={{ color: '#18191B', fontWeight: 600, fontSize: '0.85rem' }}>{displayName}</div>
                                  <div style={{ color: '#5D6C7B', fontSize: '0.72rem' }}>ID: {v.contact_id}{v.email ? ` · ${v.email}` : ''}</div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {!zohoSearching && zohoSearch.length >= 2 && zohoResults.length === 0 && (
                          <div style={{ color: '#DC2626', fontSize: '0.78rem', marginTop: 4 }}>No vendors found. Try a different name.</div>
                        )}
                      </div>
                    )
                  )}

                  {zohoMode === 'new' && (
                    <div style={{ background: '#EAF4EF', border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.6rem 0.8rem', fontSize: '0.8rem', color: '#1C4942' }}>
                      A new vendor contact will be created in Zoho Books on approval.
                    </div>
                  )}
                </div>
              )}
              {modal.action === 'approve' && (
                <div style={{ background: '#EAF4EF', border: '1px solid #A7C4BC', borderRadius: 6, padding: '0.65rem 0.85rem', marginBottom: '1rem', fontSize: '0.8rem', color: '#15803D' }}>
                  {modal.type === 'legal'
                    ? 'This will move the registration to Accounts team for final review.'
                    : zohoMode === 'link' && selectedZoho
                      ? `This will update "${selectedZoho.contact_name}" in Zoho Books with the form data.`
                      : zohoMode === 'new'
                        ? 'This will create a new vendor in Zoho Books with the form data.'
                        : 'Select an option above before approving.'}
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button onClick={() => setModal(null)} style={S.cancelBtn}>Cancel</button>
                <button onClick={submitReview} disabled={submitting}
                  style={modal.action === 'approve' ? S.approveBtn : S.rejectBtn}>
                  {submitting ? 'Processing…' : modal.action === 'approve' ? 'Confirm Approve' : 'Confirm Reject'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailSection({ title, children }) {
  return (
    <div style={{ marginBottom: '1.1rem' }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#1C4942', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.4rem' }}>{title}</div>
      <div style={{ background: '#F9F9F9', borderRadius: 6, padding: '0.7rem 0.9rem' }}>{children}</div>
    </div>
  );
}

function DetailRow({ label, val, full }) {
  if (!val) return null;
  return (
    <div style={{ display: full ? 'block' : 'flex', gap: '0.5rem', padding: '0.25rem 0', borderBottom: '1px solid #DFE7E3', fontSize: '0.82rem' }}>
      <span style={{ color: '#5D6C7B', minWidth: 150, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#18191B', wordBreak: 'break-word' }}>{val}</span>
    </div>
  );
}

const FIELD_LABELS = {
  regOfficeGstCertificate:   'GST Cert (Reg. Office)',
  gstCertificateForBill:     'GST Cert (Bill)',
  orgRegistrationProof:      'Org Registration Proof',
  orgPanCard:                'Org PAN Card',
  tanCertificate:            'TAN Certificate',
  msmeCertificate:           'MSME Certificate',
  ptCertificate:             'PT Certificate',
  pfCertificate:             'PF Certificate',
  esiCertificate:            'ESIC Certificate',
  boardResolution:           'Board Resolution',
  signatoryAadharCard:       'Signatory Aadhar',
  signatoryPanCard:          'Signatory PAN',
  cancelledCheque:           'Cancelled Cheque',
  esignAadharPdf:            'E-Sign Aadhar PDF',
};

const S = {
  page: { padding: '1.5rem 2rem', background: '#F9F9F9', minHeight: '100vh' },
  topBar: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.25rem', gap: '1rem', flexWrap: 'wrap' },
  pageTitle: { color: '#18191B', fontSize: '1.3rem', fontWeight: 700, margin: 0 },
  pageSub: { color: '#5D6C7B', fontSize: '0.82rem', margin: '0.2rem 0 0' },
  linkBox: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 7, padding: '0.45rem 0.75rem', maxWidth: 420, overflow: 'hidden' },
  linkText: { color: '#1C4942', fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  copyBtn: { flexShrink: 0, padding: '0.25rem 0.65rem', fontSize: '0.75rem', background: '#1C4942', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' },
  refreshBtn: { padding: '0.45rem 0.9rem', fontSize: '0.82rem', background: '#FFFFFF', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 6, cursor: 'pointer' },
  tabRow: { display: 'flex', gap: '0.25rem', marginBottom: '1rem', flexWrap: 'wrap' },
  tabBtn: { padding: '0.4rem 0.9rem', fontSize: '0.8rem', background: 'transparent', color: '#5D6C7B', border: '1px solid #DFE7E3', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem' },
  tabBtnActive: { background: '#EAF4EF', color: '#18191B', borderColor: '#1C4942' },
  tabCount: { fontSize: '0.7rem', background: '#DFE7E3', color: '#5D6C7B', padding: '1px 6px', borderRadius: 8 },
  table: { background: '#FFFFFF', borderRadius: 8, overflow: 'hidden', border: '1px solid #DFE7E3' },
  thead: { display: 'flex', background: '#F9F9F9', padding: '0.55rem 1rem', borderBottom: '1px solid #DFE7E3' },
  th: { flex: 1, fontSize: '0.72rem', fontWeight: 700, color: '#5D6C7B', textTransform: 'uppercase', letterSpacing: '0.05em' },
  trow: { display: 'flex', padding: '0.7rem 1rem', borderBottom: '1px solid #DFE7E3', alignItems: 'center', ':hover': { background: '#F9F9F9' } },
  td: { flex: 1, fontSize: '0.82rem', color: '#9BA8B0' },
  badge: { padding: '2px 8px', borderRadius: 10, fontSize: '0.72rem', fontWeight: 600 },
  viewBtn: { padding: '0.3rem 0.75rem', fontSize: '0.75rem', background: '#EAF4EF', color: '#1C4942', border: '1px solid #DFE7E3', borderRadius: 5, cursor: 'pointer' },
  empty: { color: '#5D6C7B', textAlign: 'center', padding: '3rem', fontSize: '0.9rem' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 500, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end' },
  panel: { width: 620, maxWidth: '96vw', height: '100vh', background: '#FFFFFF', display: 'flex', flexDirection: 'column', overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,0.4)' },
  panelHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3', background: '#F9F9F9', position: 'sticky', top: 0, zIndex: 10 },
  panelTitle: { color: '#18191B', fontWeight: 700, fontSize: '1rem' },
  closeBtn: { background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', fontSize: '1rem', padding: '0.25rem' },
  panelBody: { padding: '1.25rem', flex: 1 },
  statusRow: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.1rem', flexWrap: 'wrap' },
  zohoTag: { fontSize: '0.75rem', background: '#0d2d1d', color: '#86efac', border: '1px solid #14532d', borderRadius: 5, padding: '2px 8px' },
  actionRow: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', paddingTop: '0.75rem', borderTop: '1px solid #DFE7E3', marginTop: '1rem' },
  approveBtn: { padding: '0.5rem 1.25rem', fontSize: '0.85rem', fontWeight: 600, background: '#14532d', color: '#86efac', border: '1px solid #166534', borderRadius: 6, cursor: 'pointer' },
  rejectBtn:  { padding: '0.5rem 1.25rem', fontSize: '0.85rem', fontWeight: 600, background: '#450a0a', color: '#fca5a5', border: '1px solid #7f1d1d', borderRadius: 6, cursor: 'pointer' },
  historyItem: { display: 'flex', flexDirection: 'column', gap: 2, padding: '0.4rem 0', borderBottom: '1px solid #DFE7E3', fontSize: '0.8rem', color: '#9BA8B0' },
  histLabel: { color: '#1C4942', fontWeight: 600, fontSize: '0.75rem' },
  histNote: { color: '#18191B', fontStyle: 'italic' },
  fileLink: { padding: '0.3rem 0.65rem', fontSize: '0.75rem', background: '#F9F9F9', color: '#1C4942', border: '1px solid #DFE7E3', borderRadius: 5, textDecoration: 'none' },
  formGroup: { marginBottom: '0.85rem' },
  mLabel: { display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#9BA8B0', marginBottom: 4 },
  mInput: { width: '100%', padding: '0.5rem 0.75rem', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 5, color: '#18191B', fontSize: '0.85rem', boxSizing: 'border-box' },
  mTextarea: { width: '100%', padding: '0.5rem 0.75rem', background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 5, color: '#18191B', fontSize: '0.85rem', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' },
  cancelBtn: { padding: '0.45rem 1rem', fontSize: '0.82rem', background: '#FFFFFF', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 5, cursor: 'pointer' },
  modeBtn: { flex: 1, padding: '0.5rem 0.75rem', fontSize: '0.8rem', fontWeight: 600, background: '#F9F9F9', color: '#5D6C7B', border: '1px solid #DFE7E3', borderRadius: 6, cursor: 'pointer', textAlign: 'center' },
  modeBtnActive: { background: '#0d2d1d', color: '#86efac', border: '1px solid #166534' },
  modeBtnActiveNew: { background: '#EAF4EF', color: '#1C4942', border: '1px solid #DFE7E3' },
  selectedVendor: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#EAF4EF', border: '1px solid #A7C4BC', borderRadius: 6, padding: '0.6rem 0.85rem' },
  clearBtn: { padding: '0.25rem 0.6rem', fontSize: '0.75rem', background: '#FFFFFF', color: '#9BA8B0', border: '1px solid #DFE7E3', borderRadius: 4, cursor: 'pointer', flexShrink: 0 },
  resultsDropdown: { position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 2, background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 6, zIndex: 20, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' },
  resultItem: { padding: '0.6rem 0.85rem', cursor: 'pointer', borderBottom: '1px solid #DFE7E3' },
};
