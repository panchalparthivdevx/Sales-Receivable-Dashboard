import React, { useState, useEffect, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { RefreshCw, Download, Search, Mail, Upload, ExternalLink, Paperclip, AlertTriangle } from 'lucide-react';
import { bb, errMsg } from './bbApi';
import { S, StatusPill, Tag, STATUS_ORDER, STATUS_META, SOURCE_LABEL, money, dt, dtm, ymd, Msg } from './ui';
import BillDrawer from './BillDrawer';

// ─── Central bill collection report ───────────────────────────────────────────
// Every bill collected from the team's mailboxes or uploaded from the ERP, with what was read,
// what was suggested (and why), what is missing, and where it is in the workflow up to the Zoho draft.

const PAGE = 100;
const ALL = '';
const PERIODS = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: 'fy', label: 'This FY' },
  { key: 'all', label: 'All' },
  { key: 'custom', label: 'Custom' },
];

function periodRange(key, custom) {
  const now = new Date();
  if (key === 'all') return {};
  if (key === 'custom') return { from: custom.from || undefined, to: custom.to || undefined };
  if (key === 'fy') { const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; return { from: `${y}-04-01` }; }
  const p = PERIODS.find(x => x.key === key);
  return { from: ymd(new Date(now.getTime() - p.days * 86400000)) };
}

export default function ReportTab({ meta, onChanged }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [period, setPeriod] = useState('90');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [f, setF] = useState({ status: ALL, company: ALL, member: ALL, category: ALL, source: ALL, q: '', vendor: '', exceptions: false });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try { setRows((await bb.bills(periodRange(period, custom))).rows); } catch (e) { setError(errMsg(e)); setRows([]); }
  }, [period, custom]);
  useEffect(() => { load(); }, [load]);
  // Bills still being read refresh by themselves
  useEffect(() => {
    if (!rows?.some(r => r.status === 'received')) return undefined;
    const t = setTimeout(load, 8000);
    return () => clearTimeout(t);
  }, [rows, load]);

  const set = (k, v) => { setF(x => ({ ...x, [k]: v })); setPage(0); };
  const base = useMemo(() => (rows || []).filter(r =>
    (!f.company || r.company === f.company) && (!f.member || r.member_id === f.member) && (!f.category || (f.category === '__none' ? !r.category_id : r.category_id === f.category))
    && (!f.source || r.source === f.source)
    && (!f.vendor || `${r.vendor} ${r.vendor_gstin}`.toLowerCase().includes(f.vendor.toLowerCase()))
    && (!f.q || `${r.id} ${r.invoice_number} ${r.subject} ${r.from} ${r.file_name} ${r.description} ${r.zoho_bill_number}`.toLowerCase().includes(f.q.toLowerCase()))
    && (!f.exceptions || r.blocks > 0 || r.warns > 0)), [rows, f]);
  const counts = useMemo(() => { const c = {}; for (const r of base) c[r.status] = (c[r.status] || 0) + 1; return c; }, [base]);
  const shown = useMemo(() => base.filter(r => (f.status ? r.status === f.status : r.status !== 'not_bill')), [base, f.status]);
  const pageRows = shown.slice(page * PAGE, (page + 1) * PAGE);
  const automated = useMemo(() => {
    const drafted = base.filter(r => r.status === 'draft_created' || r.status === 'reviewed');
    return { drafted: drafted.length, bills: base.filter(r => !['not_bill', 'duplicate'].includes(r.status)).length };
  }, [base]);

  async function run(label, fn, done) {
    setBusy(label); setError(''); setNote('');
    try { const r = await fn(); if (done) setNote(done(r)); await load(); onChanged?.(); } catch (e) { setError(errMsg(e)); } finally { setBusy(''); }
  }

  function exportXlsx() {
    const st = meta.statuses;
    const data = shown.map(r => ({
      'Bill ID': r.id, Status: st[r.status] || r.status, Source: r.source === 'email' ? 'Email' : 'ERP upload',
      'Receiving mailbox': r.mailbox, 'Team member': r.member, 'Received': r.received_at ? new Date(r.received_at) : '',
      Sender: r.from, Subject: r.subject, 'Source reference': r.source_ref, 'Attachment': r.file_name,
      Vendor: r.vendor, 'Vendor GSTIN': r.vendor_gstin, Company: r.company_name, 'Zoho organisation': r.org_id,
      'Invoice no.': r.invoice_number, 'Invoice date': r.invoice_date, 'Due date': r.due_date, Description: r.description,
      'Basic amount': r.sub_total, GST: r.tax_total, 'Invoice total': r.total, Currency: r.currency,
      'Bill category': r.category, 'Category basis': r.category_basis, 'Suggested expense account': r.account,
      'Account basis': r.account_basis, 'Open issues': r.blocks, Warnings: r.warns, 'Exceptions / missing information': r.exceptions,
      'Duplicate warning': r.duplicate, 'Zoho bill no.': r.zoho_bill_number, 'Zoho bill ID': r.zoho_bill_id, 'Zoho status': r.zoho_status, 'Zoho link': r.zoho_url,
    }));
    const ws = XLSX.utils.json_to_sheet(data, { cellDates: true });
    ws['!cols'] = Object.keys(data[0] || { a: 1 }).map(k => ({ wch: Math.min(40, Math.max(10, k.length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Bills');
    XLSX.writeFile(wb, `Bill Collection ${ymd(new Date())}.xlsx`);
  }

  const r = meta.rights;
  return (
    <div>
      <Msg error={error} ok={note} onClose={() => { setError(''); setNote(''); }} />
      <div style={S.card}>
        <div style={S.cardHead}>
          <div>
            <span style={S.cardTitle}>Bill Collection Report</span>
            <span style={{ ...S.small, marginLeft: 10 }}>
              {rows ? `${shown.length} of ${rows.length} bills` : 'Loading…'}
              {automated.bills > 0 && ` · ${automated.drafted} of ${automated.bills} reached a Zoho draft`}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={S.ghost} onClick={load}><RefreshCw size={13} /> Refresh</button>
            {r.review && <button style={S.btn} disabled={!!busy} onClick={() => run('mail', () => bb.poll(), x => `Mailboxes checked: ${x.results.reduce((s, y) => s + y.ingested, 0)} new bill(s)${x.results.some(y => y.error) ? ' — some mailboxes reported an error (Team & Mailboxes)' : ''}${!x.results.length ? ' — no mailbox is connected yet' : ''}`)}>
              <Mail size={13} /> {busy === 'mail' ? 'Checking…' : 'Check mailboxes now'}</button>}
            {r.review && <button style={S.btn} disabled={!!busy} onClick={() => run('zoho', () => bb.refreshZoho(), x => `Zoho drafts checked: ${x.results.length}`)}>
              <RefreshCw size={13} /> {busy === 'zoho' ? 'Checking…' : 'Refresh Zoho status'}</button>}
            <button style={{ ...S.btn, background: '#F0FBF4', borderColor: '#BBF7D0', color: '#15803D' }} onClick={exportXlsx} disabled={!shown.length}><Download size={13} /> Excel</button>
          </div>
        </div>

        {/* Status strip */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0.7rem 1.1rem', borderBottom: '1px solid #F2F2F2' }}>
          <button onClick={() => set('status', ALL)} style={chip(!f.status, '#1C4942')}>All open <b>{base.filter(x => x.status !== 'not_bill').length}</b></button>
          {STATUS_ORDER.map(s => (
            <button key={s} onClick={() => set('status', f.status === s ? ALL : s)} style={chip(f.status === s, STATUS_META[s].color)}>
              {meta.statuses[s]} <b>{counts[s] || 0}</b>
            </button>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '0.65rem 1.1rem', borderBottom: '1px solid #F2F2F2' }}>
          <select style={S.select} value={period} onChange={e => { setPeriod(e.target.value); setPage(0); }}>
            {PERIODS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          {period === 'custom' && <>
            <input type="date" style={S.input} value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} />
            <input type="date" style={S.input} value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} />
          </>}
          <select style={S.select} value={f.company} onChange={e => set('company', e.target.value)}>
            <option value="">All companies</option>
            {meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select style={S.select} value={f.member} onChange={e => set('member', e.target.value)}>
            <option value="">All team members</option>
            {meta.team.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select style={S.select} value={f.category} onChange={e => set('category', e.target.value)}>
            <option value="">All categories</option>
            <option value="__none">No category yet</option>
            {meta.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select style={S.select} value={f.source} onChange={e => set('source', e.target.value)}>
            <option value="">Email + ERP</option><option value="email">Email</option><option value="erp_upload">ERP upload</option>
          </select>
          <input style={{ ...S.input, width: 170 }} placeholder="Vendor or GSTIN" value={f.vendor} onChange={e => set('vendor', e.target.value)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, border: '1px solid #DFE7E3', borderRadius: 6, padding: '0.25rem 0.5rem', background: '#fff' }}>
            <Search size={13} color="#9BA8B0" />
            <input style={{ border: 'none', outline: 'none', fontSize: '0.8rem', width: 190, fontFamily: 'inherit' }} placeholder="Invoice no, subject, bill ID…" value={f.q} onChange={e => set('q', e.target.value)} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, ...S.muted, cursor: 'pointer' }}>
            <input type="checkbox" checked={f.exceptions} onChange={e => set('exceptions', e.target.checked)} /> Only with exceptions
          </label>
        </div>

        {/* Table */}
        <div style={{ overflow: 'auto', maxHeight: '68vh' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1500 }}>
            <thead><tr>
              {['Received', 'Source', 'Bill', 'Vendor', 'Company', 'Invoice', 'Description', 'Basic', 'GST', 'Total', 'Category', 'Expense account', 'Exceptions', 'Status', 'Zoho'].map(h =>
                <th key={h} style={{ ...S.th, textAlign: ['Basic', 'GST', 'Total'].includes(h) ? 'right' : 'left' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {!rows && <tr><td colSpan={15} style={S.center}>Loading…</td></tr>}
              {rows && !shown.length && <tr><td colSpan={15} style={S.center}>{rows.length ? 'No bills match these filters.' : 'No bills yet — connect the team mailboxes or upload ERP bills.'}</td></tr>}
              {pageRows.map(x => (
                <tr key={x.id} onClick={() => setOpen(x.id)} style={{ cursor: 'pointer', background: open === x.id ? '#F3F8F6' : undefined }}>
                  <td style={S.td}><div>{dtm(x.received_at)}</div><div style={S.small}>{x.id}</div></td>
                  <td style={S.td}>
                    {x.source === 'email' ? <Tag tone="blue">Email</Tag> : <Tag tone="violet">ERP</Tag>}
                    <div style={{ ...S.small, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.source === 'email' ? `${x.from}\n${x.subject}` : x.source_ref}>
                      {x.member || x.mailbox || x.uploaded_by}{x.source === 'email' ? ` · ${x.from}` : x.source_ref ? ` · ${x.source_ref}` : ''}
                    </div>
                    {x.source === 'email' && <div style={{ ...S.small, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#5D6C7B' }} title={x.subject}>{x.subject}</div>}
                  </td>
                  <td style={S.td} onClick={e => e.stopPropagation()}>
                    <a href={bb.fileUrl(x.id)} target="_blank" rel="noreferrer" style={{ color: '#1C4942', display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.file_name}>
                      <Paperclip size={12} />{x.file_name}
                    </a>
                  </td>
                  <td style={S.td}><div style={{ fontWeight: 600, maxWidth: 200 }}>{x.vendor || '—'}</div><div style={S.small}>{x.vendor_gstin}</div></td>
                  <td style={S.td}><span style={S.muted}>{x.company_name || '—'}</span></td>
                  <td style={S.td}><div style={{ fontWeight: 600 }}>{x.invoice_number || '—'}</div><div style={S.small}>{dt(x.invoice_date)}{x.due_date ? ` · due ${dt(x.due_date)}` : ''}</div></td>
                  <td style={{ ...S.td, maxWidth: 220 }}><div style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }} title={x.description}>{x.description || '—'}</div></td>
                  <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(x.sub_total, x.currency)}</td>
                  <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(x.tax_total, x.currency)}</td>
                  <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>{money(x.total, x.currency)}</td>
                  <td style={S.td} title={x.category_basis}>{x.category ? <><div>{x.category}</div><Tag tone={x.category_source === 'manual' ? 'green' : 'grey'}>{SOURCE_LABEL[x.category_source] || 'Suggested'}</Tag></> : <span style={{ color: '#B45309' }}>—</span>}</td>
                  <td style={{ ...S.td, maxWidth: 200 }} title={x.account_basis}>
                    {x.account ? <><div>{x.account}</div><Tag tone={x.account_source === 'manual' ? 'green' : x.account_source === 'mapping' ? 'blue' : 'grey'}>{SOURCE_LABEL[x.account_source] || ''}</Tag></> : <span style={{ color: '#B45309' }}>—</span>}
                  </td>
                  <td style={{ ...S.td, maxWidth: 260 }}>
                    {x.duplicate && <div style={{ color: '#9F1239', fontSize: '0.72rem' }}>⧉ {x.duplicate}</div>}
                    {x.blocks > 0 && <div style={{ color: '#B45309', fontSize: '0.72rem', display: 'flex', gap: 4 }} title={x.exceptions}><AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />{x.blocks} to resolve: {x.exceptions.split(' | ')[0]}</div>}
                    {!x.blocks && x.warns > 0 && <div style={{ color: '#5D6C7B', fontSize: '0.72rem' }} title={x.exceptions}>{x.warns} note(s)</div>}
                  </td>
                  <td style={S.td}><StatusPill status={x.status} statuses={meta.statuses} />{x.not_draft && <div style={{ color: '#B91C1C', fontSize: '0.68rem' }}>Not a draft in Zoho!</div>}</td>
                  <td style={S.td} onClick={e => e.stopPropagation()}>
                    {x.zoho_url ? <a href={x.zoho_url} target="_blank" rel="noreferrer" style={{ color: '#1C4942', display: 'inline-flex', gap: 3, alignItems: 'center' }}>{x.zoho_bill_number || 'Open'} <ExternalLink size={11} /></a> : '—'}
                    {x.zoho_status && <div style={S.small}>{x.zoho_status}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length > PAGE && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '0.6rem 1.1rem', alignItems: 'center' }}>
            <span style={S.small}>{page * PAGE + 1}–{Math.min(shown.length, (page + 1) * PAGE)} of {shown.length}</span>
            <button style={S.ghost} disabled={!page} onClick={() => setPage(p => p - 1)}>Previous</button>
            <button style={S.ghost} disabled={(page + 1) * PAGE >= shown.length} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        )}
      </div>
      {!rows?.length && r.review && rows && (
        <div style={S.notice}><Upload size={13} style={{ verticalAlign: -2 }} /> Bills appear here as they are collected. Use <b>Upload ERP Bills</b> for bills downloaded from the ERP, and <b>Team &amp; Mailboxes</b> to connect the finance mailboxes.</div>
      )}
      {open && <BillDrawer id={open} meta={meta} onClose={() => setOpen(null)} onSaved={() => { load(); onChanged?.(); }} onOpen={setOpen} />}
    </div>
  );
}

const chip = (active, color) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0.28rem 0.65rem', borderRadius: 14, cursor: 'pointer', fontSize: '0.75rem',
  border: `1px solid ${active ? color : '#DFE7E3'}`, background: active ? color : '#FFFFFF', color: active ? '#FFFFFF' : '#18191B',
});
