import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../utils/api';
import { formatINR, formatDate } from '../utils/format';
import { VCS } from './PurchaseDashboard';

// ─── Recurring Expense Comparison Report ──────────────────────────────────────
// Two periods side by side — month on month, quarter on quarter, half year to half year or any
// custom months — per expense head (main row) and branch (sub row): Basic amount of both periods,
// the change, the % change and the reason for the change. The reasons are worked out on the server
// (server/recurring-comparison.js) from the bills and their item lines; lines marked ⚠ and the bills
// behind them need attention.

const MIN_MONTH = '2025-04';                   // FY 2025-26 is the oldest year the report reads
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MODES = [
  ['mom', 'Month on Month'], ['qoq', 'Quarter on Quarter'], ['hoh', 'Half Year to Half Year'], ['custom', 'Select Custom Months'],
];

const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const addM = (mk, n) => {
  let [y, m] = mk.split('-').map(Number);
  m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const monLabel = mk => { const [y, m] = mk.split('-').map(Number); return `${MON3[m - 1]}-${String(y).slice(2)}`; };
const fyStart = mk => { const [y, m] = mk.split('-').map(Number); return m >= 4 ? y : y - 1; };
const fyShort = sy => `${String(sy).slice(2)}-${String(sy + 1).slice(2)}`;
const monthsFrom = (from, to) => { const out = []; for (let k = from; k <= to; k = addM(k, 1)) out.push(k); return out; };

// Quarters / halves of the FYs from FY 2025-26 to now: { key, from, to, label, prev: { from, to } }
function quarterList(now) {
  const out = [];
  for (let sy = 2025; sy <= fyStart(now); sy++) {
    for (let q = 1; q <= 4; q++) {
      const from = addM(`${sy}-04`, (q - 1) * 3), to = addM(from, 2);
      if (from > now) continue;
      const pFrom = addM(from, -3);
      if (pFrom < MIN_MONTH) continue;
      out.push({ key: `${sy}-Q${q}`, from, to, label: `Q-${q} FY ${fyShort(sy)} (${monLabel(from)} to ${monLabel(to)})`, prev: { from: pFrom, to: addM(pFrom, 2) } });
    }
  }
  return out.reverse();
}
function halfList(now) {
  const out = [];
  for (let sy = 2025; sy <= fyStart(now); sy++) {
    for (let hh = 1; hh <= 2; hh++) {
      const from = hh === 1 ? `${sy}-04` : `${sy}-10`, to = addM(from, 5);
      if (from > now) continue;
      const pFrom = addM(from, -6);
      if (pFrom < MIN_MONTH) continue;
      out.push({ key: `${sy}-H${hh}`, from, to, label: `H-${hh} FY ${fyShort(sy)} (${monLabel(from)} to ${monLabel(to)})`, prev: { from: pFrom, to: addM(pFrom, 5) } });
    }
  }
  return out.reverse();
}

const signINR = v => `${v < 0 ? '−' : '+'}${formatINR(Math.abs(v))}`;
const pctText = p => (p == null ? '—' : `${p < 0 ? '−' : '+'}${Math.abs(p).toFixed(1)}%`);
const chgColor = v => (v > 0.5 ? '#DC2626' : v < -0.5 ? '#15803D' : '#9BA8B0');
const RED = '#B91C1C';

export default function RecurringComparisonReport({ headColors = {}, reloadKey = 0, onBillsClick }) {
  const now = useMemo(() => thisMonth(), []);
  const months   = useMemo(() => monthsFrom(MIN_MONTH, now).reverse(), [now]);
  const quarters = useMemo(() => quarterList(now), [now]);
  const halves   = useMemo(() => halfList(now), [now]);

  const [mode,    setMode]    = useState('mom');
  const [momPick, setMomPick] = useState(now);
  const [qPick,   setQPick]   = useState(quarters[0]?.key || '');
  const [hPick,   setHPick]   = useState(halves[0]?.key || '');
  const [custom,  setCustom]  = useState({ curFrom: now, curTo: now, prevFrom: addM(now, -1), prevTo: addM(now, -1) });
  const [branch,  setBranch]  = useState('All Branches');
  const [head,    setHead]    = useState('all');
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [openHeads, setOpenHeads] = useState({});
  const [detail,  setDetail]  = useState(null);
  const reqId = useRef(0);

  // The two periods asked for (a "to" after this month is cut at this month by the server)
  let range = null;
  if (mode === 'mom') range = { curFrom: momPick, curTo: momPick, prevFrom: addM(momPick, -1), prevTo: addM(momPick, -1) };
  else if (mode === 'qoq') { const q = quarters.find(x => x.key === qPick); if (q) range = { curFrom: q.from, curTo: q.to, prevFrom: q.prev.from, prevTo: q.prev.to }; }
  else if (mode === 'hoh') { const h = halves.find(x => x.key === hPick); if (h) range = { curFrom: h.from, curTo: h.to, prevFrom: h.prev.from, prevTo: h.prev.to }; }
  else range = custom;
  const rangeKey = range ? `${range.curFrom}|${range.curTo}|${range.prevFrom}|${range.prevTo}` : '';

  useEffect(() => {
    if (!rangeKey) return;
    const [curFrom, curTo, prevFrom, prevTo] = rangeKey.split('|');
    const id = ++reqId.current;
    setLoading(true); setError(null);
    api.purRecurExpenseComparison({ cur_from: curFrom, cur_to: curTo, prev_from: prevFrom, prev_to: prevTo })
      .then(d => { if (id === reqId.current) setData(d); })
      .catch(e => { if (id === reqId.current) { setError(e.response?.data?.error || e.message); setData(null); } })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  }, [rangeKey, reloadKey]);

  const setCustomField = (k, v) => setCustom(c => {
    const n = { ...c, [k]: v };
    if (k === 'curFrom' && n.curTo < v) n.curTo = v;
    if (k === 'curTo' && n.curFrom > v) n.curFrom = v;
    if (k === 'prevFrom' && n.prevTo < v) n.prevTo = v;
    if (k === 'prevTo' && n.prevFrom > v) n.prevFrom = v;
    return n;
  });

  const allRows  = data?.rows || [];
  const heads    = data?.heads || [];
  const branches = data?.all_branches || ['All Branches'];
  const rows = allRows.filter(r => (branch === 'All Branches' || r.branch === branch) && (head === 'all' || r.head_key === head));

  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.key === r.head_key) last.rows.push(r);
    else groups.push({ key: r.head_key, label: r.head_label, rows: [r] });
  }
  const sumRows = list => {
    const cur = list.reduce((s, r) => s + r.cur, 0), prev = list.reduce((s, r) => s + r.prev, 0);
    return { cur, prev, change: cur - prev, pct: prev > 0.5 ? (cur - prev) / prev * 100 : null, attention: list.reduce((s, r) => s + r.attention, 0) };
  };
  const headSummary = list => {
    const top = [...list].filter(r => Math.abs(r.change) >= 1).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 3);
    return top.length ? `Biggest changes: ${top.map(r => `${r.branch} ${signINR(r.change)}`).join(' · ')}` : 'No change';
  };

  const openByDefault = groups.length === 1 || branch !== 'All Branches';
  const isOpen    = k => (k in openHeads ? openHeads[k] : openByDefault);
  const toggle    = k => setOpenHeads(p => ({ ...p, [k]: !isOpen(k) }));
  const setAll    = open => setOpenHeads(p => { const n = { ...p }; for (const g of groups) n[g.key] = open; return n; });
  const openCount = groups.filter(g => isOpen(g.key)).length;

  const curLbl  = data?.cur?.label || '';
  const prevLbl = data?.prev?.label || '';
  const grand   = sumRows(rows);
  const anyFilter = branch !== 'All Branches' || head !== 'all';

  // ── Exports ──
  const exportLines = () => {
    const out = [];
    for (const g of groups) {
      const s = sumRows(g.rows);
      out.push({ kind: 'head', label: g.label, ...s, reason: headSummary(g.rows) });
      for (const r of g.rows) out.push({ kind: 'branch', label: r.branch, ...r, reason: r.reasons.map(x => `${x.attn ? '⚠ ' : ''}${x.level ? '  - ' : ''}${x.text}`).join('\n') });
    }
    out.push({ kind: 'grand', label: 'GRAND TOTAL', ...grand, reason: '' });
    return out;
  };
  const fileBase = `recurring-expense-comparison-${curLbl}-vs-${prevLbl}`.replace(/[^\w-]+/g, '-');
  const exportCSV = () => {
    const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = [['Expense Head / Branch', `${data?.cur?.long} Basic Amt.`, `${data?.prev?.long} Basic Amt.`, 'Change', '%', 'Reason for Change'].map(esc).join(',')];
    for (const l of exportLines()) {
      lines.push([esc(l.kind === 'branch' ? `   ${l.label}` : l.label), l.cur.toFixed(2), l.prev.toFixed(2), l.change.toFixed(2), l.pct == null ? '' : l.pct.toFixed(1), esc(l.reason)].join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${fileBase}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };
  const exportPDF = () => {
    const h = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = exportLines().map(l => {
      const cls = l.kind === 'head' ? 'gh' : l.kind === 'grand' ? 'gt' : '';
      const label = l.kind === 'branch' ? `&nbsp;&nbsp;↳ ${h(l.label)}` : h(l.label);
      const reason = h(l.reason).replace(/\n/g, '<br>').replace(/⚠/g, '<b style="color:#B91C1C">⚠</b>');
      return `<tr class="${cls}"><td>${label}</td><td class="n">${h(formatINR(l.cur))}</td><td class="n">${h(formatINR(l.prev))}</td><td class="n">${h(signINR(l.change))}</td><td class="n">${pctText(l.pct)}</td><td class="r">${reason}</td></tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recurring Expense Comparison — ${h(curLbl)} vs ${h(prevLbl)}</title><style>
      body{font-family:Arial,sans-serif;font-size:8px;margin:12px;color:#18191B}
      h2{font-size:12px;margin:0 0 3px}p{font-size:8px;color:#5D6C7B;margin:0 0 8px}
      table{border-collapse:collapse;width:100%}
      th{background:#1C4942;color:#fff;padding:3px 5px;text-align:left;font-size:8px;border:1px solid #2D6B62}
      td{padding:3px 5px;border-bottom:1px solid #e2e8f0;vertical-align:top}
      td.n{text-align:right;white-space:nowrap}td.r{font-size:7.5px;line-height:1.35}
      tr.gh td{background:#EAF4EF;color:#1C4942;font-weight:700}
      tr.gt td{background:#1C4942;color:#fff;font-weight:700}
      @media print{@page{size:A4 landscape;margin:8mm}body{margin:0}}
    </style></head><body>
    <h2>Recurring Expense Comparison Report — ${h(data?.cur?.long)} vs ${h(data?.prev?.long)}</h2>
    <p>Basic Amt. = amount the bills posted to the expense head · Change = current less previous · % = change ÷ previous · ⚠ = needs attention · Generated: ${new Date().toLocaleString('en-IN')}${branch !== 'All Branches' ? ' · Branch: ' + h(branch) : ''}${head !== 'all' ? ' · Head: ' + h(heads.find(x => x.key === head)?.label || head) : ''}</p>
    <table><thead><tr><th>Expense Head / Branch</th><th>${h(curLbl)} Basic Amt.</th><th>${h(prevLbl)} Basic Amt.</th><th>Change</th><th>%</th><th>Reason for Change</th></tr></thead><tbody>${body}</tbody></table>
    </body></html>`;
    const w = window.open('', '_blank', 'width=1300,height=850');
    w.document.write(html); w.document.close();
    w.addEventListener('load', () => w.print());
  };

  const numCell = { ...VCS.td, ...VCS.num, verticalAlign: 'top' };
  const clickable = (v, onClick) => (Math.abs(v) >= 0.5
    ? { onClick, title: 'Click to see the bills', style: { cursor: 'pointer' } }
    : {});
  const showBills = (r, side) => {
    const list = r.bills[side];
    if (list.length) onBillsClick?.(`${r.head_label} — ${r.branch} — ${side === 'cur' ? data.cur.long : data.prev.long}`, list);
  };

  const reasonCell = r => {
    const MAX = 6;
    const shown = r.reasons.slice(0, MAX);
    return (
      <div style={{ fontSize: '0.76rem', lineHeight: 1.45, color: '#18191B' }}>
        {shown.map((x, i) => (
          <div key={i} style={{
            paddingLeft: x.level ? '0.9rem' : 0, color: x.attn ? RED : x.info ? '#5D6C7B' : '#18191B',
            fontWeight: x.level ? 400 : 600, fontStyle: x.info ? 'italic' : 'normal',
          }}>
            {x.attn ? '⚠ ' : x.level ? '· ' : ''}{x.text}
          </div>
        ))}
        <button onClick={() => setDetail(r)} style={S.linkBtn}>
          {r.reasons.length > MAX ? `+ ${r.reasons.length - MAX} more — ` : ''}details &amp; bills ›
        </button>
      </div>
    );
  };

  const notices = [];
  if (data?.cur?.running) notices.push(`${data.cur.long} is still running — bills for it are still coming in, so it will look lower than a full period.`);
  const pend = (data?.bills_pending?.cur || 0) + (data?.bills_pending?.prev || 0);
  if (pend) notices.push(`${pend} bill${pend !== 1 ? 's' : ''} of FY 2025-26 ${pend !== 1 ? 'are' : 'is'} still being read from Zoho and not in the figures yet. Refresh in a few minutes.`);
  if (data?.items_pending > 0) notices.push(`Reading the item lines (quantity, rate) of ${data.items_pending} bill${data.items_pending !== 1 ? 's' : ''} from Zoho — the reasons get more detailed as they arrive. Refresh in a few minutes.`);
  if (data?.details_pending > 0) notices.push(`Exact GST and payment dates are still being read for ${data.details_pending} bill${data.details_pending !== 1 ? 's' : ''}; the Basic amounts are already exact.`);
  const ledgerMissing = (data?.ledger || []).filter(l => l.missing > 0);

  return (
    <div style={VCS.card}>
      <div style={VCS.hdr}>
        <h2 style={VCS.title}>Recurring Expense Comparison Report</h2>
        {data && rows.length > 0 && (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={exportCSV} title="Download as CSV (opens in Excel)" style={{ ...VCS.exportBtn, background: '#F0FBF4', color: '#15803D', borderColor: '#BBF7D0' }}>⬇ Excel</button>
            <button onClick={exportPDF} title="Open printable PDF view" style={{ ...VCS.exportBtn, background: '#FFF7ED', color: '#C2410C', borderColor: '#FED7AA' }}>⬇ PDF</button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div style={VCS.filterRow}>
        <span style={VCS.filterLbl}>Comparison:</span>
        <select value={mode} onChange={e => setMode(e.target.value)} style={{ ...VCS.select, minWidth: 190, color: '#1C4942', fontWeight: 600 }}>
          {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {mode === 'mom' && (
          <>
            <select value={momPick} onChange={e => setMomPick(e.target.value)} style={{ ...VCS.select, minWidth: 100 }} aria-label="Current month">
              {months.filter(m => addM(m, -1) >= MIN_MONTH).map(m => <option key={m} value={m}>{monLabel(m)}</option>)}
            </select>
            <span style={S.vs}>vs {monLabel(addM(momPick, -1))}</span>
          </>
        )}
        {mode === 'qoq' && (
          <>
            <select value={qPick} onChange={e => setQPick(e.target.value)} style={{ ...VCS.select, minWidth: 250 }} aria-label="Current quarter">
              {quarters.map(q => <option key={q.key} value={q.key}>{q.label}</option>)}
            </select>
            <span style={S.vs}>vs previous quarter</span>
          </>
        )}
        {mode === 'hoh' && (
          <>
            <select value={hPick} onChange={e => setHPick(e.target.value)} style={{ ...VCS.select, minWidth: 250 }} aria-label="Current half year">
              {halves.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
            <span style={S.vs}>vs previous half year</span>
          </>
        )}
        {mode === 'custom' && (
          <span style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={S.vs}>Current</span>
            {['curFrom', 'curTo'].map((k, i) => (
              <React.Fragment key={k}>
                {i === 1 && <span style={S.vs}>to</span>}
                <select value={custom[k]} onChange={e => setCustomField(k, e.target.value)} style={VCS.select} aria-label={k}>
                  {months.map(m => <option key={m} value={m}>{monLabel(m)}</option>)}
                </select>
              </React.Fragment>
            ))}
            <span style={S.vs}>vs Previous</span>
            {['prevFrom', 'prevTo'].map((k, i) => (
              <React.Fragment key={k}>
                {i === 1 && <span style={S.vs}>to</span>}
                <select value={custom[k]} onChange={e => setCustomField(k, e.target.value)} style={VCS.select} aria-label={k}>
                  {months.map(m => <option key={m} value={m}>{monLabel(m)}</option>)}
                </select>
              </React.Fragment>
            ))}
          </span>
        )}
      </div>
      <div style={VCS.filterRow}>
        <span style={VCS.filterLbl}>Filters:</span>
        <select value={branch} onChange={e => setBranch(e.target.value)} style={{ ...VCS.select, minWidth: 150, color: branch !== 'All Branches' ? '#1C4942' : '#18191B' }} aria-label="Branch">
          {branches.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={head} onChange={e => setHead(e.target.value)} style={{ ...VCS.select, minWidth: 200, color: head !== 'all' ? headColors[head] || '#18191B' : '#18191B' }} aria-label="Expense head">
          <option value="all">All Expense Heads</option>
          {heads.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        {anyFilter && <button onClick={() => { setBranch('All Branches'); setHead('all'); }} style={VCS.clearBtn}>Clear</button>}
      </div>

      {!loading && notices.map((t, i) => <div key={i} style={VCS.notice}>{t}</div>)}
      {!loading && ledgerMissing.length > 0 && (
        <div style={{ ...VCS.notice, background: '#FEF2F2', borderColor: '#FECACA', color: '#991B1B' }}>
          Zoho's ledger could not be read for {ledgerMissing.map(l => `${l.missing} expense head${l.missing !== 1 ? 's' : ''} of ${l.fy}`).join(', ')}, so they are missing below. Try again in a few minutes.
        </div>
      )}

      {loading && <div style={VCS.empty}>Loading comparison… (the first time a month of FY 2025-26 is used, Zoho's ledger for that year is read — about a minute)</div>}
      {!loading && error && <div style={{ ...VCS.empty, color: '#B91C1C' }}>Could not load the comparison: {error}</div>}
      {!loading && !error && data && rows.length === 0 && <div style={VCS.empty}>No recurring expense bills in these periods for the selected filters.</div>}

      {!loading && !error && data && rows.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ color: '#5D6C7B', fontSize: '0.75rem' }}>
              {openCount} of {groups.length} expense head{groups.length !== 1 ? 's' : ''} expanded · click an expense head name to open or close it · click an amount to see its bills · ⚠ = needs attention
            </span>
            <button onClick={() => setAll(true)} disabled={openCount === groups.length} style={{ ...VCS.clearBtn, opacity: openCount === groups.length ? 0.5 : 1 }}>Expand all</button>
            <button onClick={() => setAll(false)} disabled={openCount === 0} style={{ ...VCS.clearBtn, opacity: openCount === 0 ? 0.5 : 1 }}>Collapse all</button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem', minWidth: 1100 }}>
              <thead>
                <tr>
                  <th rowSpan={2} style={{ ...VCS.th, minWidth: 240, verticalAlign: 'bottom' }}>Expense Head / Branch</th>
                  <th style={{ ...VCS.th, textAlign: 'center', color: '#18191B', borderLeft: '1px solid #DFE7E3' }} title={data.cur.long}>{curLbl}</th>
                  <th style={{ ...VCS.th, textAlign: 'center', color: '#18191B', borderLeft: '1px solid #DFE7E3' }} title={data.prev.long}>{prevLbl}</th>
                  <th rowSpan={2} style={{ ...VCS.th, textAlign: 'right', verticalAlign: 'bottom', borderLeft: '1px solid #DFE7E3' }}>Change</th>
                  <th rowSpan={2} style={{ ...VCS.th, textAlign: 'right', verticalAlign: 'bottom' }}>%</th>
                  <th rowSpan={2} style={{ ...VCS.th, verticalAlign: 'bottom', minWidth: 460, borderLeft: '1px solid #DFE7E3' }}>Reason for Change</th>
                </tr>
                <tr>
                  <th style={{ ...VCS.th, textAlign: 'right', minWidth: 110, borderLeft: '1px solid #DFE7E3' }}>Basic Amt.</th>
                  <th style={{ ...VCS.th, textAlign: 'right', minWidth: 110, borderLeft: '1px solid #DFE7E3' }}>Basic Amt.</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(g => {
                  const s = sumRows(g.rows);
                  const color = headColors[g.key] || '#64748b';
                  const open = isOpen(g.key);
                  return (
                    <React.Fragment key={g.key}>
                      <tr style={VCS.grpRow}>
                        <td role="button" tabIndex={0} aria-expanded={open} onClick={() => toggle(g.key)}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(g.key); } }}
                          title={open ? 'Click to collapse' : 'Click to expand'}
                          style={{ ...VCS.td, fontWeight: 700, color, whiteSpace: 'nowrap', cursor: 'pointer', verticalAlign: 'top' }}>
                          <span style={{ display: 'inline-block', width: 14, color: '#475569', fontSize: '0.7rem' }}>{open ? '▼' : '▶'}</span>
                          <span style={{ ...VCS.dot, background: color }} />{g.label}
                          <span style={VCS.count}>({g.rows.length} branch{g.rows.length !== 1 ? 'es' : ''})</span>
                        </td>
                        <td style={{ ...numCell, fontWeight: 700 }}>{formatINR(s.cur)}</td>
                        <td style={{ ...numCell, fontWeight: 700 }}>{formatINR(s.prev)}</td>
                        <td style={{ ...numCell, fontWeight: 700, color: chgColor(s.change) }}>{Math.abs(s.change) >= 0.5 ? signINR(s.change) : '—'}</td>
                        <td style={{ ...numCell, fontWeight: 700, color: chgColor(s.change) }}>{pctText(s.pct)}</td>
                        <td style={{ ...VCS.td, fontSize: '0.76rem', color: '#5D6C7B', verticalAlign: 'top' }}>
                          {headSummary(g.rows)}
                          {s.attention > 0 && <span style={{ color: RED, fontWeight: 600 }}> · ⚠ {s.attention} point{s.attention !== 1 ? 's' : ''} need attention</span>}
                        </td>
                      </tr>
                      {open && g.rows.map((r, i) => (
                        <tr key={`${g.key}|||${r.branch}`} style={VCS.vendRow(i)}>
                          <td style={{ ...VCS.td, paddingLeft: '1.75rem', color: '#5D6C7B', fontSize: '0.82rem', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                            ↳ {r.branch}
                            {r.attention > 0 && <span title="Needs attention" style={{ color: RED, marginLeft: 6 }}>⚠ {r.attention}</span>}
                          </td>
                          <td {...clickable(r.cur, () => showBills(r, 'cur'))} style={{ ...numCell, fontSize: '0.82rem', color: r.cur ? '#18191B' : '#9BA8B0', ...(Math.abs(r.cur) >= 0.5 ? { cursor: 'pointer' } : {}) }}>
                            {Math.abs(r.cur) >= 0.5 ? formatINR(r.cur) : '—'}
                          </td>
                          <td {...clickable(r.prev, () => showBills(r, 'prev'))} style={{ ...numCell, fontSize: '0.82rem', color: r.prev ? '#18191B' : '#9BA8B0', ...(Math.abs(r.prev) >= 0.5 ? { cursor: 'pointer' } : {}) }}>
                            {Math.abs(r.prev) >= 0.5 ? formatINR(r.prev) : '—'}
                          </td>
                          <td style={{ ...numCell, fontSize: '0.82rem', color: chgColor(r.change) }}>{Math.abs(r.change) >= 0.5 ? signINR(r.change) : '—'}</td>
                          <td style={{ ...numCell, fontSize: '0.82rem', color: chgColor(r.change) }}>{r.pct == null ? (r.cur > 0.5 ? 'New' : '—') : pctText(r.pct)}</td>
                          <td style={{ ...VCS.td, verticalAlign: 'top' }}>{reasonCell(r)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #DFE7E3' }}>
                  <td style={{ ...VCS.td, fontWeight: 700, paddingTop: '0.75rem' }}>GRAND TOTAL</td>
                  <td style={{ ...numCell, fontWeight: 700, paddingTop: '0.75rem' }}>{formatINR(grand.cur)}</td>
                  <td style={{ ...numCell, fontWeight: 700, paddingTop: '0.75rem' }}>{formatINR(grand.prev)}</td>
                  <td style={{ ...numCell, fontWeight: 700, paddingTop: '0.75rem', color: chgColor(grand.change) }}>{signINR(grand.change)}</td>
                  <td style={{ ...numCell, fontWeight: 700, paddingTop: '0.75rem', color: chgColor(grand.change) }}>{pctText(grand.pct)}</td>
                  <td style={{ ...VCS.td, paddingTop: '0.75rem', fontSize: '0.76rem', color: grand.attention ? RED : '#5D6C7B' }}>
                    {grand.attention ? `⚠ ${grand.attention} point${grand.attention !== 1 ? 's' : ''} need attention across the branches shown` : ''}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p style={{ color: '#5D6C7B', fontSize: '0.72rem', margin: '0.75rem 0 0', lineHeight: 1.5 }}>
            {data.cur.long} vs {data.prev.long}. Basic Amt. = amount the bills posted to the expense head (same as the report above) · Change = current less previous · % = change ÷ previous.
            {' '}Reasons compare the two periods vendor by vendor and item by item from the bill lines: quantity effect = change in quantity × previous rate, rate effect = change in rate × current quantity; lump-sum lines (quantity 1) are compared by amount.
            {' '}⚠ marks possible duplicates, rate rises above 10%, a vendor that billed last period but not this one, and big increases the bill lines do not explain.
          </p>
        </>
      )}

      {detail && <ComparisonDetail row={detail} data={data} onClose={() => setDetail(null)} />}
    </div>
  );
}

// ─── Pop-up: one branch of one expense head — reasons, item comparison and the bills of both periods ──
function ComparisonDetail({ row: r, data, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fq = n => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const f2 = n => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const BillTable = ({ title, bills }) => (
    <div style={{ marginTop: '1rem' }}>
      <p style={S.secTitle}>{title} — {bills.length} bill{bills.length !== 1 ? 's' : ''}, {formatINR(bills.reduce((s, b) => s + (b.basic || 0), 0))}</p>
      {bills.length === 0 ? <p style={{ fontSize: '0.8rem', color: '#9BA8B0', margin: 0 }}>No bills.</p> : (
        <table style={S.tbl}>
          <thead><tr>{['Vendor', 'Bill No.', 'Bill Date', 'Basic Amt.', 'Item lines (this expense head)', 'Attention'].map(x => <th key={x} style={{ ...VCS.th, ...(x === 'Basic Amt.' ? { textAlign: 'right' } : {}) }}>{x}</th>)}</tr></thead>
          <tbody>
            {bills.map(b => (
              <tr key={b.bill_id} style={{ background: b.attn ? '#FEF2F2' : 'transparent' }}>
                <td style={S.td}>{b.vendor_name}</td>
                <td style={S.td}>{b.bill_number}</td>
                <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{formatDate(b.date)}</td>
                <td style={{ ...S.td, ...VCS.num }}>{formatINR(b.basic)}{b.part != null && <span style={{ color: '#5D6C7B', fontSize: '0.7rem' }}> ({b.part}% of bill)</span>}</td>
                <td style={{ ...S.td, fontSize: '0.74rem', color: '#5D6C7B' }}>
                  {b.items == null ? <i>being read from Zoho…</i>
                    : b.items.length === 0 ? '—'
                    : b.items.map((l, i) => <div key={i}>{l[0]}: {Math.abs(l[1] - 1) > 1e-9 ? `${fq(l[1])} × ${f2(l[2])} = ` : ''}{formatINR(l[3])}</div>)}
                </td>
                <td style={{ ...S.td, color: RED, fontSize: '0.74rem' }}>{(b.attn || []).map((t, i) => <div key={i}>⚠ {t}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()} role="dialog" aria-label="Comparison details">
        <div style={S.mHeader}>
          <h3 style={{ margin: 0, fontSize: '1.02rem', color: '#18191B' }}>{r.head_label} — {r.branch}: {data.cur.long} vs {data.prev.long}</h3>
          <button onClick={onClose} style={S.closeBtn} aria-label="Close"><X size={18} /></button>
        </div>
        <div style={S.mBody}>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            {[[`${data.cur.label} Basic`, formatINR(r.cur), '#18191B'], [`${data.prev.label} Basic`, formatINR(r.prev), '#18191B'],
              ['Change', Math.abs(r.change) >= 0.5 ? signINR(r.change) : '—', chgColor(r.change)], ['%', r.pct == null ? (r.cur > 0.5 ? 'New' : '—') : pctText(r.pct), chgColor(r.change)]]
              .map(([l, v, c]) => (
                <div key={l} style={S.kpi}><div style={S.kpiLbl}>{l}</div><div style={{ ...S.kpiVal, color: c }}>{v}</div></div>
              ))}
          </div>

          <p style={S.secTitle}>Reason for change</p>
          <div style={{ fontSize: '0.82rem', lineHeight: 1.55 }}>
            {r.reasons.map((x, i) => (
              <div key={i} style={{ paddingLeft: x.level ? '1rem' : 0, color: x.attn ? RED : x.info ? '#5D6C7B' : '#18191B', fontWeight: x.level ? 400 : 600, fontStyle: x.info ? 'italic' : 'normal' }}>
                {x.attn ? '⚠ ' : x.level ? '· ' : ''}{x.text}
              </div>
            ))}
          </div>

          {r.items_cmp.length > 0 && (
            <div style={{ marginTop: '1rem' }}>
              <p style={S.secTitle}>Item comparison (vendors billed in both periods)</p>
              <table style={S.tbl}>
                <thead>
                  <tr>
                    <th style={VCS.th}>Vendor</th><th style={VCS.th}>Item</th>
                    {[`${data.prev.label} Qty`, `${data.prev.label} Rate`, `${data.prev.label} Amount`, `${data.cur.label} Qty`, `${data.cur.label} Rate`, `${data.cur.label} Amount`, 'Change']
                      .map(x => <th key={x} style={{ ...VCS.th, textAlign: 'right' }}>{x}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {r.items_cmp.map((it, i) => (
                    <tr key={i}>
                      <td style={S.td}>{it.vendor}</td><td style={S.td}>{it.item}</td>
                      <td style={{ ...S.td, ...VCS.num }}>{it.qb ? fq(it.qb) : '—'}</td>
                      <td style={{ ...S.td, ...VCS.num }}>{it.qb ? f2(it.rb) : '—'}</td>
                      <td style={{ ...S.td, ...VCS.num }}>{it.ab ? formatINR(it.ab) : '—'}</td>
                      <td style={{ ...S.td, ...VCS.num }}>{it.qa ? fq(it.qa) : '—'}</td>
                      <td style={{ ...S.td, ...VCS.num, color: it.qa && it.qb && it.rb > 0 && it.ra > it.rb * 1.1 ? RED : undefined }}>{it.qa ? f2(it.ra) : '—'}</td>
                      <td style={{ ...S.td, ...VCS.num }}>{it.aa ? formatINR(it.aa) : '—'}</td>
                      <td style={{ ...S.td, ...VCS.num, color: chgColor(it.change) }}>{Math.abs(it.change) >= 0.5 ? signINR(it.change) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <BillTable title={`${data.cur.long} bills`} bills={r.bills.cur} />
          <BillTable title={`${data.prev.long} bills`} bills={r.bills.prev} />
        </div>
      </div>
    </div>
  );
}

const S = {
  vs:       { color: '#5D6C7B', fontSize: '0.8rem' },
  linkBtn:  { background: 'none', border: 'none', color: '#1C4942', fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer', padding: '2px 0 0', textDecoration: 'underline' },
  overlay:  { position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' },
  modal:    { background: '#FFFFFF', borderRadius: 12, width: '100%', maxWidth: 1300, maxHeight: '88vh', display: 'flex', flexDirection: 'column', border: '1px solid #DFE7E3', boxShadow: '0 8px 40px rgba(0,18,20,0.15)' },
  mHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', padding: '1rem 1.5rem', borderBottom: '1px solid #DFE7E3', flexShrink: 0 },
  mBody:    { overflow: 'auto', padding: '1rem 1.5rem 1.25rem' },
  closeBtn: { background: 'none', border: 'none', color: '#5D6C7B', cursor: 'pointer', padding: 4, borderRadius: 6 },
  kpi:      { background: '#F9F9F9', border: '1px solid #DFE7E3', borderRadius: 8, padding: '0.5rem 0.9rem', minWidth: 140 },
  kpiLbl:   { color: '#5D6C7B', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  kpiVal:   { fontSize: '1.05rem', fontWeight: 700, marginTop: 2, fontVariantNumeric: 'tabular-nums' },
  secTitle: { color: '#1C4942', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 0.4rem' },
  tbl:      { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' },
  td:       { padding: '0.4rem 0.75rem', borderBottom: '1px solid #F2F2F2', color: '#18191B', verticalAlign: 'top' },
};
