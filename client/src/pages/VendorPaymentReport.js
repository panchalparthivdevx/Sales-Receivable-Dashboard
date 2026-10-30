import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { RefreshCw, Download, Search, AlertTriangle, Info, ChevronLeft, ChevronRight, ChevronDown, Paperclip, Upload, Pencil, X } from 'lucide-react';
import { api, withToken } from '../utils/api';
import { formatINR, formatDate } from '../utils/format';

// ─── Vendor Payment Report ────────────────────────────────────────────────────
// Payments against bills vs advances against POs. The rows are built by the report's own sync
// (server/vendor-payment-report.js: built once, then only what changed in Zoho); this page filters
// them. The whole current FY is loaded once, so the period buttons filter in the browser; Custom
// reaches back to the start of the previous FY. Nothing on this page calls Zoho except Refresh,
// which asks the server to check Zoho for changes.
// The purchase team uploads the bill of an advance and both teams write remarks (rights per user in
// User Settings). Once Accounts books that bill in Zoho and adjusts the advance against it, the next
// sync shows the payment as Against Bill (applyUploads).

const TYPES = {
  bill:   { label: 'Against Bill',         color: '#15803D', bg: '#F0FDF4', border: '#BBF7D0' },
  adv_po: { label: 'Advance – Against PO', color: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  adv:    { label: 'Advance – Without PO', color: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },
  mixed:  { label: 'Bill + Advance',       color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
};
const TYPE_ORDER = ['bill', 'adv_po', 'adv', 'mixed'];
const STATUS = { unadjusted: 'Unadjusted', partly: 'Partly Adjusted', adjusted: 'Fully Adjusted', refunded: 'Refunded', settled: 'Advance adjusted' };
const ALL = '__all';
const NONE = '__none';       // payments without Project_Details
const ADVANCES = '__adv';    // every type except Against Bill
const PAGE = 100;
const SORTS = {
  date: r => r.date, number: r => r.number, vendor: r => r.vendor.toLowerCase(),
  amount: r => r.amount, unused: r => r.unused,
};

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// The current FY's periods (April–March)
function fyPeriods(now = new Date()) {
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    fy: `FY ${y}-${String(y + 1).slice(2)}`,
    list: [
      { key: 'q1',  label: 'Q-1', hint: 'Apr–Jun', from: `${y}-04-01`, to: `${y}-06-30` },
      { key: 'q2',  label: 'Q-2', hint: 'Jul–Sep', from: `${y}-07-01`, to: `${y}-09-30` },
      { key: 'h1',  label: 'H-1', hint: 'Apr–Sep', from: `${y}-04-01`, to: `${y}-09-30` },
      { key: 'q3',  label: 'Q-3', hint: 'Oct–Dec', from: `${y}-10-01`, to: `${y}-12-31` },
      { key: 'q4',  label: 'Q-4', hint: 'Jan–Mar', from: `${y + 1}-01-01`, to: `${y + 1}-03-31` },
      { key: 'h2',  label: 'H-2', hint: 'Oct–Mar', from: `${y}-10-01`, to: `${y + 1}-03-31` },
      { key: 'ytd', label: 'Year to Date', hint: 'Apr–today', from: `${y}-04-01`, to: ymd(now) },
      { key: 'custom', label: 'Custom', hint: 'Pick dates' },
    ],
  };
}

// Excel serial date (no time-zone shift)
const xlDate = s => {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
};
const prettyStatus = s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const amt = n => (n > 0.5 ? formatINR(n) : '—');
const OLD_SERVER = 'The dashboard server is running an older version without this report. Restart the dashboard server to load it.';
const LISTS = ['payments', 'pos', 'bills'];
const when = s => (s ? new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const plural = (n, w) => `${n.toLocaleString('en-IN')} ${w}${n === 1 ? '' : 's'}`;
// "3 new, 1 changed" across the report's lists (payments, purchase orders, previous-FY bills)
function changeText(lc) {
  const c = lc?.changes || {};
  const sum = f => LISTS.reduce((s, k) => s + (c[k]?.[f] || 0), 0);
  const parts = [[sum('added'), 'new'], [sum('updated'), 'changed'], [sum('removed'), 'removed']].filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
  return parts.length ? parts.join(', ') : 'no changes';
}
const loadError = e => (e.response?.status === 404 ? OLD_SERVER : e.response?.data?.error || e.message);
const apiError = e => e.response?.data?.error || e.message;
const FILE_URL = '/api/purchase/vendor-payment-report/file';
const BILL_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,.heic,.heif,.csv,.xls,.xlsx,.doc,.docx';

// A payment whose bill was uploaded here and which Accounts has since adjusted against a bill in Zoho
// (it is an advance only because that bill is dated after the payment): Against Bill once nothing is
// left unused, Bill + Advance while part still is. `was` keeps the type it had.
function applyUploads(rows, notes) {
  return rows.map(r => {
    if (r.type === 'bill' || !r.bills || !notes[r.id]?.bills?.length) return r;
    const type = r.unused > 0.5 ? 'mixed' : 'bill';
    return type === r.type ? r : { ...r, type, was: r.type, status: type === 'bill' ? 'settled' : r.status };
  });
}

// Project_Details filter: several projects at once (none ticked = all)
function ProjectPicker({ options, counts, value, onChange }) {
  const [open, setOpen] = useState(null);   // where the list opens (fixed: the report card clips overflow)
  const [q, setQ] = useState('');
  const box = useRef(null);
  const pop = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const inside = e => box.current?.contains(e.target) || pop.current?.contains(e.target);
    const away = e => { if (!inside(e)) setOpen(null); };
    const esc = e => { if (e.key === 'Escape') setOpen(null); };
    const moved = e => { if (!pop.current?.contains(e.target)) setOpen(null); };   // page scrolled: the list would float off
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open]);
  const toggleOpen = () => {
    if (open) { setOpen(null); return; }
    const r = box.current.getBoundingClientRect();
    setOpen({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 348)) });
  };
  const label = p => (p === NONE ? '(No Project_Details)' : p);
  const qq = q.trim().toLowerCase();
  const list = qq ? options.filter(p => label(p).toLowerCase().includes(qq)) : options;
  const sel = new Set(value);
  const toggle = p => onChange(sel.has(p) ? value.filter(x => x !== p) : [...value, p]);
  const text = !value.length ? 'All Project_Details' : value.length === 1 ? label(value[0]) : `${value.length} projects selected`;
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button style={{ ...S.select, ...S.pickerBtn, color: value.length ? '#1C4942' : '#18191B' }}
        onClick={toggleOpen} title={value.length ? value.map(label).join('\n') : 'Choose one or more projects'}>
        <span style={S.pickerTxt}>{text}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div ref={pop} style={{ ...S.pop, top: open.top, left: open.left }}>
          <div style={S.popSearch}>
            <Search size={12} color="#9BA8B0" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search projects…" style={{ ...S.searchInput, width: '100%' }} />
          </div>
          <div style={S.popActions}>
            <span style={{ color: '#9BA8B0' }}>{value.length ? `${value.length} selected` : 'None ticked = all projects'}</span>
            <span style={{ display: 'flex', gap: 10 }}>
              {qq && list.length > 0 && <button style={S.linkBtn} onClick={() => onChange([...new Set([...value, ...list])])}>Tick all shown</button>}
              {value.length > 0 && <button style={S.linkBtn} onClick={() => onChange([])}>Clear</button>}
            </span>
          </div>
          <div style={S.popList}>
            {list.map(p => (
              <label key={p} style={S.popItem}>
                <input type="checkbox" checked={sel.has(p)} onChange={() => toggle(p)} style={{ accentColor: '#1C4942' }} />
                <span style={{ flex: 1, color: p === NONE ? '#9BA8B0' : '#18191B' }}>{label(p)}</span>
                <span style={S.popCount}>{(counts.get(p) || 0).toLocaleString('en-IN')}</span>
              </label>
            ))}
            {!list.length && <div style={S.popEmpty}>No project matches “{q}”</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// Bill Attachment: the uploaded bill(s), who uploaded each and when; purchase team users can upload
function BillCell({ id, note, rights, onNote }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef(null);
  const bills = note?.bills || [];
  const upload = e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    setErr('');
    api.purVendorPaymentReportUploadBill(id, f)
      .then(d => onNote(id, d.note))
      .catch(x => setErr(apiError(x)))
      .finally(() => setBusy(false));
  };
  const remove = b => {
    if (!window.confirm(`Remove the bill “${b.name}” from this payment?`)) return;
    setBusy(true);
    setErr('');
    api.purVendorPaymentReportRemoveBill(id, b.id)
      .then(d => onNote(id, d.note))
      .catch(x => setErr(apiError(x)))
      .finally(() => setBusy(false));
  };
  return (
    <div style={{ minWidth: 170, maxWidth: 240 }}>
      {bills.map(b => (
        <div key={b.id} style={S.fileRow}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <a href={withToken(`${FILE_URL}/${id}/${encodeURIComponent(b.id)}`)} target="_blank" rel="noopener noreferrer" style={S.fileLink} title={`Open ${b.name}`}>
              <Paperclip size={11} style={{ flexShrink: 0 }} /><span style={S.fileName}>{b.name}</span>
            </a>
            {(rights.admin || (rights.purchase && b.by?.id === rights.user_id)) && (
              <button style={S.xBtn} onClick={() => remove(b)} disabled={busy} title="Remove this bill"><X size={11} /></button>
            )}
          </div>
          <div style={S.sub}>Uploaded by {b.by?.name || '—'} · {when(b.at)}</div>
        </div>
      ))}
      {rights.purchase && (
        <>
          <input ref={input} type="file" accept={BILL_ACCEPT} style={{ display: 'none' }} onChange={upload} />
          <button style={S.miniBtn} onClick={() => input.current?.click()} disabled={busy}>
            <Upload size={11} /> {busy ? 'Saving…' : bills.length ? 'Add another bill' : 'Upload bill'}
          </button>
        </>
      )}
      {!bills.length && !rights.purchase && <span style={{ color: '#9BA8B0' }}>—</span>}
      {err && <div style={S.errTxt}>{err}</div>}
    </div>
  );
}

// Purchase Team Remarks / Accounts Team Remarks: the remark, who wrote it and when; editable by that team
function RemarkCell({ id, team, remark, canEdit, onNote }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const start = () => { setText(remark?.text || ''); setErr(''); setEdit(true); };
  const save = () => {
    setBusy(true);
    setErr('');
    api.purVendorPaymentReportRemark(id, team, text)
      .then(d => { onNote(id, d.note); setEdit(false); })
      .catch(x => setErr(apiError(x)))
      .finally(() => setBusy(false));
  };
  if (edit) {
    return (
      <div style={{ width: 240 }}>
        <textarea value={text} onChange={e => setText(e.target.value)} maxLength={2000} rows={3} autoFocus style={S.textarea}
          placeholder={team === 'purchase' ? 'Purchase team remark…' : 'Accounts team remark…'}
          onKeyDown={e => { if (e.key === 'Escape') setEdit(false); else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button style={S.saveBtn} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button style={S.cancelBtn} onClick={() => setEdit(false)} disabled={busy}>Cancel</button>
        </div>
        {err && <div style={S.errTxt}>{err}</div>}
      </div>
    );
  }
  return (
    <div style={{ minWidth: 150, maxWidth: 260 }}>
      {remark ? (
        <>
          <div style={S.remarkText} title={remark.text}>{remark.text}</div>
          <div style={S.sub}>— {remark.by?.name || '—'}, {when(remark.at)}</div>
        </>
      ) : !canEdit && <span style={{ color: '#9BA8B0' }}>—</span>}
      {canEdit && (
        <button style={S.miniBtn} onClick={start}><Pencil size={11} /> {remark ? 'Edit' : 'Add remark'}</button>
      )}
    </div>
  );
}

// First build: how far each list has been read (each page is saved as it arrives)
function BuildProgress({ sync, onStart }) {
  const active = sync && (sync.running || sync.queued);
  if (!sync || sync.state === 'not_started') {
    return (
      <div style={S.center}>
        {active ? 'Starting the one-time build of this report…' : (
          <>
            This report has not been built yet. It is built once — a few minutes — and from then on only the changes are fetched from Zoho.
            <div style={{ marginTop: 10 }}><button style={S.loadBtn} onClick={onStart}>Build now</button></div>
          </>
        )}
      </div>
    );
  }
  return (
    <div style={S.build}>
      <div style={S.buildTitle}>One-time setup — reading the Zoho data into the dashboard</div>
      <div style={S.buildNote}>
        Each page is saved as soon as it arrives; if anything interrupts the read it carries on from where it stopped.
        Once it is complete, every sync fetches only what changed.
      </div>
      {LISTS.map(k => {
        const l = sync.lists?.[k];
        if (!l) return null;
        const pct = l.done ? 100 : l.total ? Math.min(99, Math.round((l.records / l.total) * 100)) : 0;
        return (
          <div key={k} style={S.buildRow}>
            <span style={S.buildLbl}>{l.label}</span>
            <span style={S.track}><span style={{ ...S.fill, width: `${pct}%` }} /></span>
            <span style={S.buildTxt}>
              {l.done ? `${(l.count ?? l.records).toLocaleString('en-IN')} records ✓`
                : l.started_at ? `page ${Math.min(l.pages, l.pages_total || l.pages)} of ${l.pages_total || '…'} · ${l.records.toLocaleString('en-IN')} of ${(l.total || 0).toLocaleString('en-IN')} records${l.reached ? ` · back to ${formatDate(l.reached)}` : ''}`
                : 'waiting'}
            </span>
          </div>
        );
      })}
      {sync.last_check?.error && <div style={S.buildErr}>The last attempt stopped: {sync.last_check.error}</div>}
      {sync.last_check?.stopped && <div style={S.buildErr}>Paused by Zoho: {sync.last_check.stopped} — progress is saved.</div>}
      {sync.error && <div style={S.buildErr}>Paused: {sync.error.message} — progress is saved.</div>}
      {!active && <div style={{ marginTop: 10 }}><button style={S.btn} onClick={onStart}><RefreshCw size={13} /> Continue now</button></div>}
    </div>
  );
}

export default function VendorPaymentReport() {
  const periods = useMemo(() => fyPeriods(), []);
  const ytd = periods.list.find(p => p.key === 'ytd');
  const fy = useMemo(() => ({ from: periods.list.find(p => p.key === 'q1').from, to: periods.list.find(p => p.key === 'q4').to }), [periods]);
  const [period, setPeriod]     = useState('ytd');
  const [custom, setCustom]     = useState({ from: ytd.from, to: ytd.to });
  const [range, setRange]       = useState({ from: ytd.from, to: ytd.to });   // the period on screen
  const [data, setData]         = useState(null);    // rows from the server's synced copy, for data.from – data.to
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [sync, setSync]         = useState(null);    // the report's sync state
  const [refreshAt, setRefreshAt] = useState(0);     // Refresh clicked: waiting for its check of Zoho
  const [note, setNote]         = useState('');      // outcome of the last Refresh
  const syncRef = useRef(null);
  const [notes, setNotes]       = useState({});      // bill uploads and remarks, by payment
  const [rights, setRights]     = useState({});      // what this user may change (User Settings)
  const [projects, setProjects] = useState([]);      // Project_Details ticked (none = all; NONE = not tagged)
  const [vcat, setVcat]         = useState(ALL);
  const [type, setType]         = useState(ALL);
  const [openOnly, setOpenOnly] = useState(false);
  const [billsOnly, setBillsOnly] = useState(false);
  const [q, setQ]               = useState('');
  const [view, setView]         = useState('register');
  const [page, setPage]         = useState(0);
  const [sort, setSort]         = useState({ key: 'date', dir: -1 });
  const [showRules, setShowRules] = useState(false);

  // Rows come from the server's synced copy. The whole current FY is loaded at once, so a period inside
  // what is loaded is only filtered here; a wider Custom period loads once more. Neither calls Zoho.
  const load = useCallback((from, to) => {
    setLoading(true);
    setError('');
    return api.purVendorPaymentReport(from, to)
      .then(d => {
        if (!d || typeof d !== 'object' || !('ready' in d)) throw new Error(OLD_SERVER);   // old server: its fallback web page
        setData(d);
        setNotes(d.notes || {});
        setRights(d.rights || {});
        syncRef.current = d.status || null;
        setSync(d.status || null);
      })
      .catch(e => setError(loadError(e)))
      .finally(() => setLoading(false));
  }, []);
  const loadFor = useCallback(r => {
    const ends = [r.from, r.to, fy.from, fy.to, ...(data?.ready ? [data.from, data.to] : [])].sort();
    return load(ends[0], ends[ends.length - 1]);
  }, [load, fy, data]);
  const show = r => {
    setRange({ from: r.from, to: r.to });
    setPage(0);
    if (!(data?.ready && r.from >= data.from && r.to <= data.to)) loadFor(r);
  };
  const choosePeriod = p => {
    setPeriod(p.key);
    if (p.key !== 'custom') show(p);
  };
  const withReset = setter => v => { setter(v); setPage(0); };

  // Refresh: the server checks Zoho for what changed since the last sync (a sync run of this report);
  // the page follows its status and reloads the rows when the check is done
  const refresh = () => {
    if (!data) { show(range); return; }
    setNote('');
    setError('');
    const at = Date.now();
    api.purVendorPaymentReportRefresh()
      .then(r => {
        if (r?.status === 'started') setRefreshAt(at);
        else if (r?.status === 'busy') setNote('A sync is already running — the report updates when it finishes. If it does not, click Refresh again in a minute.');
        else if (r?.status === 'building') setNote('The report is still being built — it updates on its own.');
        return api.purVendorPaymentReportStatus().then(s => { syncRef.current = s; setSync(s); });
      })
      .catch(e => setError(loadError(e)));
  };

  // While the report builds, a sync runs or a Refresh is checking Zoho, its status is polled (a small
  // local read — no rows, no Zoho); the rows reload when it is done
  useEffect(() => {
    const s0 = sync;
    if (!data || !(refreshAt || !data.ready || s0?.running || s0?.queued)) return undefined;
    const slow = data.ready && !refreshAt && s0?.background && !s0?.queued;   // only the detail backlog
    const id = setInterval(() => {
      api.purVendorPaymentReportStatus().then(s => {
        const prev = syncRef.current;
        syncRef.current = s;
        setSync(s);
        if (refreshAt) {
          const checked = s.last_check?.at && Date.parse(s.last_check.at) >= refreshAt;
          if ((checked && !s.queued && (!s.running || s.background)) || Date.now() - refreshAt > 180000) {
            setRefreshAt(0);
            if (checked) setNote(`Checked Zoho at ${when(s.last_check.at)} — ${changeText(s.last_check)}${s.last_check.error ? ` (stopped: ${s.last_check.error})` : ''}.`);
            loadFor(range);
          }
        } else if (!data.ready && s.state === 'ready') loadFor(range);                              // first rows published
        else if (prev && (prev.running || prev.queued) && !s.running && !s.queued) loadFor(range);   // a sync or the backlog finished
      }).catch(() => {});
    }, slow ? 20000 : 4000);
    return () => clearInterval(id);
  }, [data, sync?.running, sync?.queued, sync?.background, refreshAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!data?.ready;
  const rows = useMemo(() => (data?.ready ? applyUploads(data.rows.filter(r => r.date >= range.from && r.date <= range.to), notes) : []), [data, range, notes]);
  // Projects in the period (plus any still ticked from another period), with their payment counts
  const projCounts = useMemo(() => {
    const m = new Map();
    for (const r of rows) { const k = r.project || NONE; m.set(k, (m.get(k) || 0) + 1); }
    return m;
  }, [rows]);
  const projOptions = useMemo(() => {
    const named = [...new Set([...projCounts.keys(), ...projects])].filter(p => p !== NONE).sort((a, b) => a.localeCompare(b));
    return projCounts.has(NONE) || projects.includes(NONE) ? [NONE, ...named] : named;
  }, [projCounts, projects]);
  const vcats = useMemo(() => [...new Set(rows.map(r => r.vendor_category))].sort((a, b) => a.localeCompare(b)), [rows]);
  const onNote = useCallback((id, note) => setNotes(n => ({ ...n, [id]: note })), []);

  // Every filter except Payment Type (the summary boxes show the split by type)
  const base = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const pick = new Set(projects);
    return rows.filter(r => {
      const n = notes[r.id];
      return (!pick.size || pick.has(r.project || NONE)) &&
        (vcat === ALL || r.vendor_category === vcat) &&
        (!openOnly || r.unused > 0.5) &&
        (!billsOnly || !!n?.bills?.length) &&
        (!qq || [r.vendor, r.number, r.po_number, r.bills, r.reference, r.project, r.paid_through,
          n?.purchase_remark?.text, n?.accounts_remark?.text, ...(n?.bills || []).map(b => b.name)]
          .some(s => (s || '').toLowerCase().includes(qq)));
    });
  }, [rows, notes, projects, vcat, openOnly, billsOnly, q]);

  const shown = useMemo(() => {
    const list = type === ALL ? base : base.filter(r => (type === ADVANCES ? r.type !== 'bill' : r.type === type));
    const key = SORTS[sort.key] || SORTS.date;
    return [...list].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  }, [base, type, sort]);

  const kpi = useMemo(() => {
    const k = { all: { n: 0, amt: 0, unused: 0 } };
    for (const t of TYPE_ORDER) k[t] = { n: 0, amt: 0, unused: 0 };
    for (const r of base) for (const t of ['all', r.type]) { k[t].n++; k[t].amt += r.amount; k[t].unused += r.unused; }
    return k;
  }, [base]);

  // Advance-type payments by Project_Details
  const byProject = useMemo(() => {
    const m = new Map();
    for (const r of base) {
      if (r.type === 'bill') continue;
      const key = r.project || '';
      const e = m.get(key) || { project: key, n: 0, adv_po: 0, adv: 0, mixed: 0, unused: 0, pos: new Set() };
      e.n++;
      e[r.type] += r.amount;
      e.unused += r.unused;
      if (r.po_number) e.pos.add(r.po_number);
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => b.unused - a.unused || (b.adv_po + b.adv + b.mixed) - (a.adv_po + a.adv + a.mixed));
  }, [base]);

  const mismatches = useMemo(() => base.filter(r => r.project_mismatch).length, [base]);
  const shownTotals = useMemo(() => shown.reduce((s, r) => ({ amount: s.amount + r.amount, unused: s.unused + r.unused }), { amount: 0, unused: 0 }), [shown]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const pg = Math.min(page, pages - 1);
  const pageRows = shown.slice(pg * PAGE, pg * PAGE + PAGE);
  const anyFilter = projects.length > 0 || vcat !== ALL || type !== ALL || openOnly || billsOnly || q;
  const clearFilters = () => { setProjects([]); setVcat(ALL); setType(ALL); setOpenOnly(false); setBillsOnly(false); setQ(''); setPage(0); };
  const sortBy = key => { setSort(s => ({ key, dir: s.key === key ? -s.dir : (key === 'vendor' || key === 'number' ? 1 : -1) })); setPage(0); };
  const openProject = p => { setProjects([p || NONE]); setType(ADVANCES); setView('register'); setPage(0); };

  const exportExcel = () => {
    const head = ['Payment Date', 'Payment Number', 'Vendor Name', 'Payment Type', 'Advance Status', 'Payment Mode',
      'Amount', 'Unused Amount (BCY)', 'Adjusted Against Bills', 'Refunded', 'Paid Through', 'Purchase Order No', 'PO Source',
      'PO Status', 'Bill No', 'Bill Date(s)', 'Project_Details', 'Project_Details Source', "PO's Project_Details",
      'Project Sub Category', 'Sub-Category', 'Vendor Category', 'Reference Number', 'Branch',
      'Bill Attachment', 'Bill Uploaded By', 'Purchase Team Remarks', 'Purchase Remarks By', 'Accounts Team Remarks', 'Accounts Remarks By'];
    const by = x => (x ? `${x.by?.name || ''}, ${when(x.at)}` : null);
    const body = shown.map(r => {
      const n = notes[r.id] || {};
      const files = n.bills || [];
      return [
        xlDate(r.date), r.number, r.vendor, TYPES[r.type]?.label || r.type, STATUS[r.status] || null, r.mode,
        r.amount, r.unused, r.adjusted, r.refunded || 0, r.paid_through, r.po_number || null,
        r.po_src === 'bill' ? 'Via bill' : r.po_src === 'payment' ? 'Payment' : null,
        prettyStatus(r.po_status) || null, r.bills || null, r.bill_dates || null, r.project || null,
        r.project_src === 'po' ? 'From PO' : r.project_src === 'payment' ? 'Payment' : null, r.po_project || null,
        r.proj_sub_category || null, r.sub_category || null, r.vendor_category, r.reference || null, r.branch || null,
        files.map(b => b.name).join('; ') || null, files.map(by).join('; ') || null,
        n.purchase_remark?.text || null, by(n.purchase_remark), n.accounts_remark?.text || null, by(n.accounts_remark),
      ];
    });
    const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
    for (let i = 1; i <= body.length; i++) {
      const d = ws[XLSX.utils.encode_cell({ r: i, c: 0 })];
      if (d && d.t === 'n') d.z = 'dd-mm-yyyy';
      for (const c of [6, 7, 8, 9]) { const cell = ws[XLSX.utils.encode_cell({ r: i, c })]; if (cell) cell.z = '#,##0.00'; }
    }
    ws['!cols'] = [12, 20, 34, 22, 16, 14, 14, 16, 16, 12, 30, 20, 11, 16, 30, 24, 34, 14, 34, 30, 26, 22, 26, 26,
      30, 30, 40, 26, 40, 26].map(wch => ({ wch }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: body.length, c: head.length - 1 } }) };

    const ph = ['Project_Details', 'Advance Payments', 'Advance – Against PO', 'Advance – Without PO', 'Bill + Advance', 'Unused (still open)', 'POs'];
    const pb = byProject.map(e => [e.project || '(Not tagged)', e.n, e.adv_po, e.adv, e.mixed, e.unused, e.pos.size]);
    const ws2 = XLSX.utils.aoa_to_sheet([ph, ...pb]);
    for (let i = 1; i <= pb.length; i++) for (const c of [2, 3, 4, 5]) { const cell = ws2[XLSX.utils.encode_cell({ r: i, c })]; if (cell) cell.z = '#,##0.00'; }
    ws2['!cols'] = [40, 16, 20, 20, 16, 20, 8].map(wch => ({ wch }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Payments');
    XLSX.utils.book_append_sheet(wb, ws2, 'Advances by Project');
    XLSX.writeFile(wb, `Vendor_Payment_Report_${range.from}_to_${range.to}.xlsx`);
  };

  const sortHead = (key, label, extra = {}) => (
    <th style={{ ...S.th, cursor: 'pointer', ...extra }} onClick={() => sortBy(key)} title="Sort">
      {label}{sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div style={S.wrap}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <span style={S.title}>Vendor Payment Report</span>
          <span style={S.badge}>
            {ready
              ? `${rows.length.toLocaleString('en-IN')} payments · ${formatDate(range.from)} – ${formatDate(range.to)}`
              : 'Payments against bills vs advances against purchase orders'}
          </span>
          {sync && sync.state !== 'not_started' && (
            <div style={{ ...S.syncLine, color: sync.last_check?.error || sync.error ? '#B45309' : '#5D6C7B' }}>
              {refreshAt ? 'Checking Zoho for changes…'
                : sync.state !== 'ready' ? 'Building the report’s own copy of the Zoho data (one time)…'
                : <>
                    Last synced with Zoho: {when(sync.last_check?.at || data?.built_at)}
                    {sync.last_check && ` · ${changeText(sync.last_check)}`}
                    {sync.last_check?.error && ` · last sync stopped: ${sync.last_check.error}`}
                    {sync.background && ' · filling in details in the background'}
                  </>}
            </div>
          )}
          {note && <div style={S.syncNote}>{note}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {ready && shown.length > 0 && (
            <button onClick={exportExcel} style={S.excelBtn} title="Download the filtered payments as Excel">
              <Download size={13} /> Excel
            </button>
          )}
          <button onClick={refresh} disabled={loading || !!refreshAt} style={S.btn}
            title={data ? 'Check Zoho for payments, POs and bills changed since the last sync' : 'Load the report'}>
            <RefreshCw size={13} style={{ opacity: loading || refreshAt ? 0.5 : 1 }} />
            {refreshAt ? 'Checking Zoho…' : loading ? 'Loading…' : data ? 'Refresh' : 'Load Report'}
          </button>
        </div>
      </div>

      {/* Period */}
      <div style={S.bar}>
        <span style={S.barLbl}>Period</span>
        {periods.list.map(p => (
          <button key={p.key} onClick={() => choosePeriod(p)} style={S.pill(period === p.key)} title={p.from ? `${formatDate(p.from)} – ${formatDate(p.to)}` : 'Choose your own dates'}>
            {p.label}
            <span style={S.pillHint(period === p.key)}>{p.hint}</span>
          </button>
        ))}
        <span style={{ ...S.badge, marginLeft: 4 }}>{periods.fy}</span>
        {period === 'custom' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
            <input type="date" value={custom.from} min={data?.window_from} max={custom.to || undefined}
              onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} style={S.input} />
            <span style={S.badge}>to</span>
            <input type="date" value={custom.to} min={custom.from || undefined}
              onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} style={S.input} />
            <button onClick={() => custom.from && custom.to && show(custom)} disabled={!custom.from || !custom.to || loading} style={S.applyBtn}>
              Apply
            </button>
          </span>
        )}
      </div>

      {/* Filters */}
      {ready && (
        <div style={S.bar}>
          <span style={S.barLbl}>Filter</span>
          <ProjectPicker options={projOptions} counts={projCounts} value={projects} onChange={withReset(setProjects)} />
          <select value={vcat} onChange={e => withReset(setVcat)(e.target.value)} style={{ ...S.select, color: vcat !== ALL ? '#1C4942' : '#18191B' }}>
            <option value={ALL}>All Vendor Categories</option>
            {vcats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={type} onChange={e => withReset(setType)(e.target.value)} style={{ ...S.select, color: type !== ALL ? '#1C4942' : '#18191B' }}>
            <option value={ALL}>All Payment Types</option>
            <option value={ADVANCES}>All Advances</option>
            {TYPE_ORDER.map(t => <option key={t} value={t}>{TYPES[t].label}</option>)}
          </select>
          <label style={S.check}>
            <input type="checkbox" checked={openOnly} onChange={e => withReset(setOpenOnly)(e.target.checked)} />
            Only with unused amount
          </label>
          <label style={S.check}>
            <input type="checkbox" checked={billsOnly} onChange={e => withReset(setBillsOnly)(e.target.checked)} />
            Only with uploaded bill
          </label>
          <span style={S.searchBox}>
            <Search size={13} color="#9BA8B0" />
            <input value={q} onChange={e => withReset(setQ)(e.target.value)} placeholder="Vendor, payment, PO, bill, remark…" style={S.searchInput} />
          </span>
          {anyFilter && <button onClick={clearFilters} style={S.clearBtn}>Clear</button>}
        </div>
      )}

      {/* States */}
      {loading && <div style={S.center}>Loading payments…</div>}
      {error && !loading && (
        <div style={{ ...S.center, color: '#DC2626' }}>
          {error === OLD_SERVER ? error : `Failed to load: ${error}`} <button onClick={() => loadFor(range)} style={S.retryBtn}>Retry</button>
        </div>
      )}
      {!loading && !error && !data && (
        <div style={S.center}>
          <button onClick={() => show(range)} style={S.loadBtn}>Load Report</button>
        </div>
      )}
      {!loading && !error && data && !data.ready && <BuildProgress sync={sync} onStart={refresh} />}

      {!loading && ready && (
        <>
          {/* Summary by payment type — click to filter */}
          <div style={S.kpiStrip}>
            {[['all', 'All Payments', '#18191B'], ...TYPE_ORDER.map(t => [t, TYPES[t].label, TYPES[t].color])].map(([key, label, color]) => {
              const k = kpi[key];
              const active = key === 'all' ? type === ALL : type === key;
              return (
                <div key={key} style={S.kpiBox(active, color)} onClick={() => withReset(setType)(key === 'all' ? ALL : (type === key ? ALL : key))}>
                  <div style={{ ...S.kpiVal, color }}>{formatINR(k.amt)}</div>
                  <div style={S.kpiLbl}>{label}</div>
                  <div style={S.kpiSub}>
                    {k.n.toLocaleString('en-IN')} payment{k.n !== 1 ? 's' : ''}
                    {k.unused > 0.5 && <> · <span style={{ color: '#B45309' }}>{formatINR(k.unused)} unused</span></>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Notices */}
          {data.window_from && range.from < data.window_from && (
            <div style={S.notice}>Payment data starts on {formatDate(data.window_from)} — earlier payments are not included.</div>
          )}
          {data.complete_from && data.window_from && data.complete_from > data.window_from && range.from < data.complete_from && (
            <div style={S.notice}>Payments before {formatDate(data.complete_from)} appear once last year’s bills have been read (first build only — in progress).</div>
          )}
          {data.pending?.total > 0 && (
            <div style={S.notice}>
              Project Sub Category is still being fetched from Zoho for {plural(data.pending.total, 'record')} (shown as “…”). This one-time backlog fills in by itself in the background{sync?.background ? ' — running now' : ''}.
            </div>
          )}
          {mismatches > 0 && (
            <div style={S.notice}>
              <AlertTriangle size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              {mismatches} payment{mismatches !== 1 ? 's have' : ' has'} a Project_Details different from the linked PO's (marked ⚠ — hover to see the PO's project).
            </div>
          )}

          {/* View tabs */}
          <div style={S.tabsRow}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={S.tab(view === 'register')} onClick={() => setView('register')}>Payment Register</button>
              <button style={S.tab(view === 'projects')} onClick={() => setView('projects')}>Advances by Project</button>
            </div>
            <button style={S.linkBtn} onClick={() => setShowRules(s => !s)}>
              <Info size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />How payments are classified
            </button>
          </div>
          {showRules && (
            <div style={S.rules}>
              <div><b style={{ color: TYPES.bill.color }}>Against Bill</b> — paid against bill(s) dated on or before the payment date. Also an advance whose bill was uploaded in this report and which Accounts has booked in Zoho and adjusted the advance against (marked “Advance adjusted”; adjusted only in part, it shows as Bill + Advance) — it moves here at the next sync or Refresh.</div>
              <div><b style={{ color: TYPES.adv_po.color }}>Advance – Against PO</b> — paid before the bill: nothing adjusted yet, or adjusted later against a bill dated after the payment. The PO is the payment's “Purchase Order No” (or, if blank, the PO the later bill was raised from — shown “via bill”).</div>
              <div><b style={{ color: TYPES.adv.color }}>Advance – Without PO</b> — paid before the bill, with no PO.</div>
              <div><b style={{ color: TYPES.mixed.color }}>Bill + Advance</b> — part paid bill(s) that already existed; the rest was extra (still unused, or adjusted against a later bill).</div>
              <div><b>Advance Status</b> — Unadjusted (nothing used yet) · Partly Adjusted · Fully Adjusted · Refunded (returned by the vendor).</div>
              <div><b>Bill Attachment</b> — uploaded by the purchase team, with who uploaded it and when. <b>Purchase Team Remarks</b> / <b>Accounts Team Remarks</b> — written by each team. Who may upload or write is set per user in User Settings.</div>
              <div><b>Project_Details</b> — from the payment; if blank or only “Other” there, from its PO (marked “from PO”). ⚠ marks a payment whose project differs from its PO's. <b>Sub-Category</b> and <b>Project Sub Category</b> — from the PO, else from the bill(s) paid. <b>Vendor Category</b> — from the vendor master.</div>
            </div>
          )}

          {view === 'register' && (
            shown.length === 0
              ? <div style={S.center}>No payments match the selected period and filters.</div>
              : (
                <>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={S.table}>
                      <thead>
                        <tr>
                          {sortHead('date', 'Payment Date')}
                          {sortHead('number', 'Payment Number')}
                          {sortHead('vendor', 'Vendor Name')}
                          <th style={S.th}>Payment Type</th>
                          <th style={S.th}>Payment Mode</th>
                          {sortHead('amount', 'Amount', { textAlign: 'right' })}
                          {sortHead('unused', 'Unused Amount (BCY)', { textAlign: 'right' })}
                          <th style={S.th}>Paid Through</th>
                          <th style={S.th}>Purchase Order No</th>
                          <th style={S.th}>Bill No</th>
                          <th style={S.th}>Project_Details</th>
                          <th style={S.th}>Project Sub Category</th>
                          <th style={S.th}>Sub-Category</th>
                          <th style={S.th}>Vendor Category</th>
                          <th style={S.th}>Bill Attachment</th>
                          <th style={S.th}>Purchase Team Remarks</th>
                          <th style={S.th}>Accounts Team Remarks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((r, i) => {
                          const t = TYPES[r.type] || TYPES.bill;
                          const billList = r.bills ? r.bills.split(', ') : [];
                          return (
                            <tr key={r.id} style={{ background: i % 2 ? '#FBFCFB' : '#FFFFFF' }}>
                              <td style={S.td}>{formatDate(r.date)}</td>
                              <td style={{ ...S.td, color: '#1C4942', fontWeight: 500 }}>{r.number}</td>
                              <td style={{ ...S.td, ...S.clip(220) }} title={r.vendor}>{r.vendor}</td>
                              <td style={S.td}>
                                <span style={{ ...S.chip, color: t.color, background: t.bg, border: `1px solid ${t.border}` }}>{t.label}</span>
                                {r.status && <div style={S.sub}>{STATUS[r.status]}</div>}
                              </td>
                              <td style={S.td}>{r.mode || '—'}</td>
                              <td style={{ ...S.td, ...S.num }} title={r.currency ? `${r.currency} payment — amount shown in INR (BCY)` : undefined}>
                                {formatINR(r.amount)}{r.currency && <div style={S.sub}>{r.currency}</div>}
                              </td>
                              <td style={{ ...S.td, ...S.num, color: r.unused > 0.5 ? '#B45309' : '#9BA8B0', fontWeight: r.unused > 0.5 ? 600 : 400 }}>
                                {amt(r.unused)}
                                {r.refunded > 0 && <div style={S.sub}>Refunded {formatINR(r.refunded)}</div>}
                              </td>
                              <td style={{ ...S.td, ...S.clip(190) }} title={r.paid_through}>{r.paid_through || '—'}</td>
                              <td style={S.td}>
                                {r.po_number ? (
                                  <>
                                    <div>{r.po_number}</div>
                                    <div style={S.sub}>
                                      {[r.po_src === 'bill' ? 'via bill' : '', prettyStatus(r.po_status), r.po_missing ? 'not found in Zoho' : ''].filter(Boolean).join(' · ')}
                                    </div>
                                  </>
                                ) : <span style={{ color: '#9BA8B0' }}>—</span>}
                              </td>
                              <td style={{ ...S.td, ...S.clip(200) }} title={billList.length ? r.bills : undefined}>
                                {billList.length === 0 ? <span style={{ color: '#9BA8B0' }}>—</span>
                                  : billList.length <= 2 ? r.bills
                                  : <>{billList.slice(0, 2).join(', ')} <span style={S.more}>+{billList.length - 2}</span></>}
                              </td>
                              <td style={{ ...S.td, ...S.clip(240) }} title={r.project_mismatch ? `PO's Project_Details: ${r.po_project}` : r.project}>
                                {r.project_mismatch && <AlertTriangle size={12} color="#D97706" style={{ verticalAlign: '-2px', marginRight: 4 }} />}
                                {r.project || <span style={{ color: '#9BA8B0' }}>—</span>}
                                {r.project_src === 'po' && <span style={S.tag}>from PO</span>}
                              </td>
                              <td style={{ ...S.td, ...S.clip(200) }} title={r.proj_sub_category}>
                                {r.proj_sub_category || (r.sub_pending
                                  ? <span style={{ color: '#9BA8B0' }} title="Being fetched from Zoho">…</span>
                                  : <span style={{ color: '#9BA8B0' }}>—</span>)}
                              </td>
                              <td style={{ ...S.td, ...S.clip(200) }} title={r.sub_category}>{r.sub_category || <span style={{ color: '#9BA8B0' }}>—</span>}</td>
                              <td style={{ ...S.td, ...S.clip(180) }} title={r.vendor_category}>{r.vendor_category}</td>
                              <td style={S.tdWrap}><BillCell id={r.id} note={notes[r.id]} rights={rights} onNote={onNote} /></td>
                              <td style={S.tdWrap}>
                                <RemarkCell id={r.id} team="purchase" remark={notes[r.id]?.purchase_remark} canEdit={!!rights.purchase} onNote={onNote} />
                              </td>
                              <td style={S.tdWrap}>
                                <RemarkCell id={r.id} team="accounts" remark={notes[r.id]?.accounts_remark} canEdit={!!rights.accounts} onNote={onNote} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={5} style={S.tf}>Total ({shown.length.toLocaleString('en-IN')} payment{shown.length !== 1 ? 's' : ''})</td>
                          <td style={{ ...S.tf, ...S.num }}>{formatINR(shownTotals.amount)}</td>
                          <td style={{ ...S.tf, ...S.num, color: '#B45309' }}>{amt(shownTotals.unused)}</td>
                          <td colSpan={10} style={S.tf} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {pages > 1 && (
                    <div style={S.pager}>
                      <span>Showing {(pg * PAGE + 1).toLocaleString('en-IN')}–{Math.min(shown.length, pg * PAGE + PAGE).toLocaleString('en-IN')} of {shown.length.toLocaleString('en-IN')}</span>
                      <button style={S.pageBtn} disabled={pg === 0} onClick={() => setPage(pg - 1)}><ChevronLeft size={14} /></button>
                      <span>Page {pg + 1} of {pages}</span>
                      <button style={S.pageBtn} disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}><ChevronRight size={14} /></button>
                    </div>
                  )}
                </>
              )
          )}

          {view === 'projects' && (
            byProject.length === 0
              ? <div style={S.center}>No advance payments in the selected period and filters.</div>
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        <th style={S.th}>Project_Details</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Advance Payments</th>
                        <th style={{ ...S.th, textAlign: 'right', color: TYPES.adv_po.color }}>Advance – Against PO</th>
                        <th style={{ ...S.th, textAlign: 'right', color: TYPES.adv.color }}>Advance – Without PO</th>
                        <th style={{ ...S.th, textAlign: 'right', color: TYPES.mixed.color }}>Bill + Advance</th>
                        <th style={{ ...S.th, textAlign: 'right', color: '#B45309' }}>Unused (still open)</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>POs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byProject.map((e, i) => (
                        <tr key={e.project || NONE} style={{ background: i % 2 ? '#FBFCFB' : '#FFFFFF', cursor: 'pointer' }}
                          onClick={() => openProject(e.project)} title="Show these payments in the register">
                          <td style={{ ...S.td, fontWeight: 600, color: e.project ? '#18191B' : '#9BA8B0' }}>{e.project || '(No Project_Details)'}</td>
                          <td style={{ ...S.td, ...S.num }}>{e.n.toLocaleString('en-IN')}</td>
                          <td style={{ ...S.td, ...S.num }}>{amt(e.adv_po)}</td>
                          <td style={{ ...S.td, ...S.num }}>{amt(e.adv)}</td>
                          <td style={{ ...S.td, ...S.num }}>{amt(e.mixed)}</td>
                          <td style={{ ...S.td, ...S.num, color: e.unused > 0.5 ? '#B45309' : '#9BA8B0', fontWeight: 600 }}>{amt(e.unused)}</td>
                          <td style={{ ...S.td, ...S.num }}>{e.pos.size || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td style={S.tf}>Total ({byProject.length} project{byProject.length !== 1 ? 's' : ''})</td>
                        <td style={{ ...S.tf, ...S.num }}>{byProject.reduce((s, e) => s + e.n, 0).toLocaleString('en-IN')}</td>
                        {['adv_po', 'adv', 'mixed', 'unused'].map(k => (
                          <td key={k} style={{ ...S.tf, ...S.num, color: k === 'unused' ? '#B45309' : undefined }}>{amt(byProject.reduce((s, e) => s + e[k], 0))}</td>
                        ))}
                        <td style={S.tf} />
                      </tr>
                    </tfoot>
                  </table>
                  <div style={S.footNote}>Amounts are full payment amounts; “Unused” is what is still open with the vendor. Click a project to see its payments.</div>
                </div>
              )
          )}
        </>
      )}
    </div>
  );
}

const S = {
  wrap: {
    background: '#FFFFFF', borderRadius: 12, border: '1px solid #DFE7E3',
    overflow: 'hidden', marginBottom: '1.5rem', boxShadow: '0 1px 3px rgba(0,18,20,0.06)',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3', flexWrap: 'wrap', gap: 8,
  },
  title: { color: '#18191B', fontWeight: 700, fontSize: '0.95rem', marginRight: 10 },
  badge: { color: '#9BA8B0', fontSize: '0.75rem' },
  btn: {
    display: 'flex', alignItems: 'center', gap: 4,
    background: '#EAF4EF', border: '1px solid #A7C4BC', color: '#1C4942',
    borderRadius: 6, padding: '0.35rem 0.85rem', fontSize: '0.78rem', cursor: 'pointer',
  },
  excelBtn: {
    display: 'flex', alignItems: 'center', gap: 4,
    background: '#F0FBF4', border: '1px solid #BBF7D0', color: '#15803D',
    borderRadius: 6, padding: '0.35rem 0.85rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600,
  },
  bar: {
    display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    padding: '0.65rem 1.25rem', borderBottom: '1px solid #F2F2F2',
  },
  barLbl: {
    color: '#5D6C7B', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.04em', minWidth: 52,
  },
  pill: active => ({
    display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.2,
    padding: '0.28rem 0.7rem', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600,
    border: `1px solid ${active ? '#1C4942' : '#DFE7E3'}`,
    background: active ? '#1C4942' : '#FFFFFF', color: active ? '#FFFFFF' : '#18191B',
  }),
  pillHint: active => ({ fontSize: '0.62rem', fontWeight: 400, color: active ? '#CFE3DC' : '#9BA8B0' }),
  input: {
    background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B',
    borderRadius: 6, padding: '0.3rem 0.5rem', fontSize: '0.78rem', fontFamily: 'inherit',
  },
  applyBtn: {
    background: '#1C4942', color: '#FFFFFF', border: 'none', borderRadius: 6,
    padding: '0.38rem 0.85rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600,
  },
  select: {
    background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B', maxWidth: 260,
    borderRadius: 6, padding: '0.35rem 0.6rem', fontSize: '0.78rem', cursor: 'pointer',
  },
  check: { display: 'flex', alignItems: 'center', gap: 5, color: '#5D6C7B', fontSize: '0.78rem', cursor: 'pointer' },
  searchBox: {
    display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #DFE7E3', borderRadius: 6,
    padding: '0.25rem 0.55rem', background: '#FFFFFF',
  },
  searchInput: { border: 'none', outline: 'none', fontSize: '0.78rem', width: 230, color: '#18191B', fontFamily: 'inherit' },
  clearBtn: {
    background: 'transparent', border: '1px solid #DFE7E3', color: '#5D6C7B',
    borderRadius: 6, padding: '0.35rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer',
  },
  center: { padding: '2rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.85rem' },
  syncLine: { marginTop: 3, fontSize: '0.74rem' },
  syncNote: { marginTop: 2, fontSize: '0.74rem', color: '#1C4942' },
  build: { padding: '1.1rem 1.5rem 1.3rem', fontSize: '0.8rem', color: '#18191B' },
  buildTitle: { fontWeight: 700, fontSize: '0.85rem', marginBottom: 4 },
  buildNote: { color: '#5D6C7B', fontSize: '0.76rem', marginBottom: 12, maxWidth: 760 },
  buildRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '0.3rem 0', flexWrap: 'wrap' },
  buildLbl: { width: 140, fontWeight: 600, color: '#18191B' },
  track: { position: 'relative', width: 220, height: 8, borderRadius: 4, background: '#EEF2F0', overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4, background: '#1C4942' },
  buildTxt: { color: '#5D6C7B', fontSize: '0.76rem', fontVariantNumeric: 'tabular-nums' },
  buildErr: { marginTop: 8, color: '#B45309', fontSize: '0.76rem' },
  loadBtn: {
    background: '#1C4942', color: '#fff', border: 'none', borderRadius: 7,
    padding: '0.5rem 1.25rem', fontSize: '0.82rem', cursor: 'pointer', fontWeight: 600,
  },
  retryBtn: {
    background: 'none', border: '1px solid #DC2626', color: '#DC2626',
    borderRadius: 6, padding: '0.3rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer', marginLeft: 8,
  },
  kpiStrip: { display: 'flex', borderBottom: '1px solid #DFE7E3', flexWrap: 'wrap' },
  kpiBox: (active, color) => ({
    flex: 1, minWidth: 170, padding: '0.8rem 1.1rem', borderRight: '1px solid #DFE7E3', cursor: 'pointer',
    background: active ? '#F7FAF8' : '#FFFFFF', boxShadow: active ? `inset 0 -3px 0 ${color}` : 'none',
  }),
  kpiVal: { fontSize: '1.2rem', fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
  kpiLbl: { color: '#5D6C7B', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 3 },
  kpiSub: { color: '#9BA8B0', fontSize: '0.72rem', marginTop: 2 },
  notice: {
    background: '#FFFBEB', borderBottom: '1px solid #FDE68A', color: '#92400E',
    padding: '0.45rem 1.25rem', fontSize: '0.76rem',
  },
  tabsRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    padding: '0.65rem 1.25rem', borderBottom: '1px solid #F2F2F2',
  },
  tab: active => ({
    padding: '0.32rem 0.95rem', borderRadius: 20, fontSize: '0.78rem', cursor: 'pointer', border: 'none', fontWeight: 600,
    background: active ? '#1C4942' : '#F2F2F2', color: active ? '#FFFFFF' : '#5D6C7B',
  }),
  linkBtn: { background: 'none', border: 'none', color: '#1C4942', fontSize: '0.76rem', cursor: 'pointer', fontWeight: 600 },
  rules: {
    background: '#F9F9F9', borderBottom: '1px solid #DFE7E3', padding: '0.75rem 1.25rem',
    fontSize: '0.78rem', color: '#18191B', display: 'grid', gap: 5, lineHeight: 1.45,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
  th: {
    padding: '0.5rem 0.7rem', color: '#5D6C7B', fontWeight: 600, fontSize: '0.68rem',
    textTransform: 'uppercase', letterSpacing: '0.03em', background: '#F9F9F9',
    borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', textAlign: 'left', userSelect: 'none',
  },
  td: { padding: '0.5rem 0.7rem', color: '#18191B', borderBottom: '1px solid #F2F2F2', whiteSpace: 'nowrap', verticalAlign: 'top' },
  tf: { padding: '0.6rem 0.7rem', color: '#18191B', fontWeight: 700, borderTop: '2px solid #DFE7E3', background: '#F9F9F9', whiteSpace: 'nowrap' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  clip: w => ({ maxWidth: w, overflow: 'hidden', textOverflow: 'ellipsis' }),
  chip: { display: 'inline-block', borderRadius: 4, padding: '1px 7px', fontSize: '0.7rem', fontWeight: 600 },
  sub: { color: '#9BA8B0', fontSize: '0.68rem', marginTop: 2 },
  tag: {
    marginLeft: 6, background: '#F2F2F2', color: '#5D6C7B', borderRadius: 4,
    padding: '0 5px', fontSize: '0.64rem', fontWeight: 600,
  },
  more: {
    background: '#EAF4EF', color: '#1C4942', borderRadius: 4,
    padding: '0 5px', fontSize: '0.66rem', fontWeight: 600,
  },
  pager: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10,
    padding: '0.6rem 1.25rem', color: '#5D6C7B', fontSize: '0.76rem',
  },
  pageBtn: {
    display: 'flex', alignItems: 'center', background: '#FFFFFF', border: '1px solid #DFE7E3',
    borderRadius: 6, padding: '0.2rem 0.4rem', cursor: 'pointer', color: '#18191B',
  },
  footNote: { color: '#9BA8B0', fontSize: '0.72rem', padding: '0.6rem 1.25rem' },
  // Project_Details picker
  pickerBtn: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 200, justifyContent: 'space-between', fontFamily: 'inherit' },
  pickerTxt: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 },
  pop: {
    position: 'fixed', zIndex: 60, width: 340, background: '#FFFFFF', border: '1px solid #DFE7E3',
    borderRadius: 8, boxShadow: '0 10px 30px rgba(0,18,20,0.14)', fontSize: '0.78rem',
  },
  popSearch: { display: 'flex', alignItems: 'center', gap: 6, padding: '0.5rem 0.65rem', borderBottom: '1px solid #F2F2F2' },
  popActions: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
    padding: '0.35rem 0.65rem', borderBottom: '1px solid #F2F2F2', fontSize: '0.72rem',
  },
  popList: { maxHeight: 300, overflowY: 'auto', padding: '0.25rem 0' },
  popItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '0.3rem 0.65rem', cursor: 'pointer' },
  popCount: { color: '#9BA8B0', fontSize: '0.7rem', fontVariantNumeric: 'tabular-nums' },
  popEmpty: { color: '#9BA8B0', padding: '0.6rem 0.65rem' },
  // Bill Attachment / remarks
  tdWrap: { padding: '0.5rem 0.7rem', color: '#18191B', borderBottom: '1px solid #F2F2F2', verticalAlign: 'top', fontSize: '0.76rem' },
  fileRow: { marginBottom: 6 },
  fileLink: { display: 'flex', alignItems: 'center', gap: 4, color: '#1C4942', fontWeight: 600, textDecoration: 'none', minWidth: 0 },
  fileName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 190 },
  xBtn: {
    display: 'flex', alignItems: 'center', background: 'none', border: 'none', color: '#9BA8B0',
    cursor: 'pointer', padding: 2, borderRadius: 4,
  },
  miniBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4, background: '#FFFFFF', border: '1px solid #DFE7E3',
    color: '#1C4942', borderRadius: 5, padding: '0.15rem 0.5rem', fontSize: '0.7rem', cursor: 'pointer', marginTop: 3,
    fontWeight: 600, whiteSpace: 'nowrap',
  },
  errTxt: { color: '#DC2626', fontSize: '0.7rem', marginTop: 3, whiteSpace: 'normal' },
  remarkText: {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '4.4em', overflow: 'hidden', lineHeight: 1.45,
  },
  textarea: {
    width: '100%', boxSizing: 'border-box', border: '1px solid #A7C4BC', borderRadius: 6, padding: '0.35rem 0.45rem',
    fontSize: '0.76rem', fontFamily: 'inherit', resize: 'vertical', color: '#18191B', outline: 'none',
  },
  saveBtn: {
    background: '#1C4942', color: '#FFFFFF', border: 'none', borderRadius: 5,
    padding: '0.22rem 0.7rem', fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600,
  },
  cancelBtn: {
    background: '#FFFFFF', color: '#5D6C7B', border: '1px solid #DFE7E3', borderRadius: 5,
    padding: '0.22rem 0.7rem', fontSize: '0.72rem', cursor: 'pointer',
  },
};
