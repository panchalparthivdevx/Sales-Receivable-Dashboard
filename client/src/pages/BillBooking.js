import React, { useState, useEffect, useCallback } from 'react';
import { bb, errMsg } from './billbooking/bbApi';
import { S } from './billbooking/ui';
import ReportTab from './billbooking/ReportTab';
import UploadTab from './billbooking/UploadTab';
import TeamTab from './billbooking/TeamTab';
import CategoriesTab from './billbooking/CategoriesTab';
import MappingsTab from './billbooking/MappingsTab';
import SettingsTab from './billbooking/SettingsTab';

// ─── Bill Collection & Booking ────────────────────────────────────────────────
// Purchase bills from the finance team's mailboxes and ERP uploads → read → company, vendor, category,
// expense accounts and GST (from the vendor's earlier Zoho bills or confirmed mappings) → checks →
// Zoho Books DRAFT bill → the team reviews and opens it in Zoho. Server: server/bill-booking/.

const TABS = [
  { id: 'report', label: 'Bill Collection Report' },
  { id: 'upload', label: 'Upload ERP Bills', right: 'review' },
  { id: 'team', label: 'Team & Mailboxes' },
  { id: 'categories', label: 'Categories & Fields' },
  { id: 'mappings', label: 'Account Mappings' },
  { id: 'settings', label: 'Settings & Integrations' },
];

export default function BillBooking() {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(() => { try { return sessionStorage.getItem('bb_tab') || 'report'; } catch (_) { return 'report'; } });
  const [stamp, setStamp] = useState(0);

  const loadMeta = useCallback(() => bb.meta().then(m => { setMeta(m); setError(''); }).catch(e => setError(errMsg(e))), []);
  useEffect(() => { loadMeta(); }, [loadMeta]);
  const go = id => { setTab(id); try { sessionStorage.setItem('bb_tab', id); } catch (_) {} };

  if (!meta) {
    return <div style={S.page}><h2 style={S.pageTitle}>Bill Collection &amp; Booking</h2>{error ? <div style={{ ...S.error, marginTop: 12 }}>{error}</div> : <div style={S.center}>Loading…</div>}</div>;
  }
  const tabs = TABS.filter(t => !t.right || meta.rights[t.right]);
  const current = tabs.some(t => t.id === tab) ? tab : 'report';

  return (
    <div style={S.page}>
      <div style={S.topBar}>
        <div>
          <h2 style={S.pageTitle}>Bill Collection &amp; Booking</h2>
          <p style={S.pageSub}>Purchase bills from team mailboxes and ERP uploads, prepared as Zoho Books drafts for review</p>
        </div>
      </div>
      <div style={S.tabs}>
        {tabs.map(t => <button key={t.id} style={S.tab(current === t.id)} onClick={() => go(t.id)}>{t.label}</button>)}
      </div>
      {current === 'report' && <ReportTab key={stamp} meta={meta} onChanged={loadMeta} />}
      {current === 'upload' && <UploadTab meta={meta} onDone={() => setStamp(s => s + 1)} />}
      {current === 'team' && <TeamTab meta={meta} reloadMeta={loadMeta} />}
      {current === 'categories' && <CategoriesTab meta={meta} reloadMeta={loadMeta} />}
      {current === 'mappings' && <MappingsTab meta={meta} />}
      {current === 'settings' && <SettingsTab meta={meta} reloadMeta={loadMeta} />}
    </div>
  );
}
