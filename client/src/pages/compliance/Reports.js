import React, { useMemo, useState } from 'react';
import { Download, ChevronDown, ChevronRight, CalendarClock, AlertTriangle, Building2, Layers, GitBranch, CheckCircle2 } from 'lucide-react';
import { T } from '../../theme';
import { S, Card, Btn, PctBar, StatusBadge, Empty, fmtDate, exportXlsx } from './ui';

// ── KPI cards ─────────────────────────────────────────────────────────────────
export function KpiGrid({ kpis, active, onPick, colors }) {
  const cards = [
    { id: 'total',       label: 'Total Tasks',     value: kpis.total,       color: T.primary },
    { id: 'completed',   label: 'Completed',       value: kpis.completed,   color: colors.Completed },
    { id: 'pending',     label: 'Pending',         value: kpis.pending,     color: T.textMuted, title: 'Everything not Completed and not N/A' },
    { id: 'overdue',     label: 'Overdue',         value: kpis.overdue,     color: colors.Overdue, title: 'Calculated: not completed and past the due date' },
    { id: 'due_soon',    label: 'Due Soon',        value: kpis.due_soon,    color: colors['Due Soon'], title: 'Calculated: not completed, due within the Due Soon window' },
    { id: 'in_progress', label: 'In Progress',     value: kpis.in_progress, color: colors['In Progress'] },
    { id: 'na',          label: 'Not Applicable',  value: kpis.na,          color: colors['N/A'], title: 'From Company Applicability = No. Never counts against compliance.' },
    { id: 'applicable',  label: 'Compliance %',    value: kpis.compliance_pct == null ? '—' : `${kpis.compliance_pct}%`, color: T.primary,
      title: 'Completed ÷ (Total − N/A). Click to list all applicable tasks.' },
  ];
  return (
    <div className="cmp-kpis">
      {cards.map(k => {
        const on = active === k.id || (k.id === 'total' && !active);
        return (
          <button key={k.id} className="cmp-kpi" onClick={() => onPick(k.id === 'total' ? null : k.id)} title={k.title || `Show ${k.label} in the task table`}
            style={{ background: `${k.color}10`, border: `${on ? 2 : 1}px solid ${on ? k.color : `${k.color}30`}`, borderRadius: 8, padding: on ? '0.55rem 0.85rem' : '0.6rem 0.9rem', textAlign: 'center', cursor: 'pointer', fontFamily: T.font }}>
            <div style={{ fontSize: '1.2rem', fontWeight: 700, color: k.color, fontFamily: T.mono, lineHeight: 1.3 }}>{k.value}</div>
            <div style={{ fontSize: '0.68rem', color: T.textMuted, marginTop: 2, whiteSpace: 'nowrap' }}>{k.label}</div>
          </button>
        );
      })}
    </div>
  );
}

// ── Company-wise / Module-wise summary ────────────────────────────────────────
export function SummaryCard({ title, subtitle, icon, rows, columns, activeKey, onRowClick, fileName }) {
  const doExport = () => exportXlsx(fileName, title, columns, rows, (r, c) => (c.key === 'compliance_pct' ? (r.compliance_pct ?? '') : r[c.key]));
  return (
    <Card title={title} subtitle={subtitle} icon={icon}
      right={<Btn size="sm" icon={Download} onClick={doExport} disabled={!rows.length}>Export</Btn>}>
      {rows.length === 0 ? <Empty>No tasks in this period.</Empty> : (
        <div className="cmp-scroll">
          <table style={S.table}>
            <thead><tr>{columns.map(c => <th key={c.key} style={{ ...S.th, textAlign: c.key === 'label' ? 'left' : c.key === 'compliance_pct' ? 'left' : 'right' }}>{c.header}</th>)}</tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} className="cmp-row" onClick={() => onRowClick(r.key)} style={{ cursor: 'pointer', background: activeKey === r.key ? T.primarySoft : undefined }} title="Click to show these tasks below">
                  {columns.map(c => c.key === 'label'
                    ? <td key={c.key} style={{ ...S.td, fontWeight: 600 }}>{r.label}</td>
                    : c.key === 'compliance_pct'
                      ? <td key={c.key} style={S.td}><PctBar pct={r.compliance_pct} /></td>
                      : <td key={c.key} style={{ ...S.num, color: c.key === 'overdue' && r.overdue ? T.danger : T.text }}>{r[c.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const DUE_COLS = [
  { key: 'due_date', header: 'Due Date', type: 'date', width: 12 },
  { key: 'days', header: 'Days', width: 8 },
  { key: 'task_id', header: 'Task ID', width: 30 },
  { key: 'compliance_name', header: 'Compliance', width: 30 },
  { key: 'company_name', header: 'Company', width: 28 },
  { key: 'responsible', header: 'Responsible', width: 18 },
  { key: 'display_status', header: 'Status', width: 12 },
];

function DueList({ rows, colors, onOpen, overdue }) {
  if (!rows.length) return <Empty icon={CheckCircle2}>{overdue ? 'Nothing overdue in this period.' : 'Nothing due in this window.'}</Empty>;
  return (
    <div className="cmp-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
      <table style={S.table}>
        <thead><tr>
          <th style={S.th}>Due</th><th style={{ ...S.th, textAlign: 'right' }}>{overdue ? 'Days late' : 'Days left'}</th><th style={S.th}>Compliance</th><th style={S.th}>Company</th><th style={S.th}>Responsible</th><th style={S.th}>Status</th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.task_id} className="cmp-row" onClick={() => onOpen(r.task_id)} style={{ cursor: 'pointer' }} title={r.task_id}>
              <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{fmtDate(r.due_date)}</td>
              <td style={{ ...S.num, color: overdue ? T.danger : r.days_left <= 3 ? T.warning : T.text, fontWeight: 700 }}>{overdue ? -r.days_left : r.days_left}</td>
              <td style={S.td}><div style={{ fontWeight: 600 }}>{r.compliance_name}</div><div style={S.faint}>{r.period_label}</div></td>
              <td style={S.td}>{r.company_short || r.company_name}</td>
              <td style={S.td}>{r.responsible || <span style={S.faint}>—</span>}</td>
              <td style={S.td}><StatusBadge status={r.display_status} colors={colors} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UpcomingCard({ data, rowsById, windows, colors, onOpen }) {
  const [win, setWin] = useState(windows[0]);
  const rows = (data.upcoming[win] || []).map(id => rowsById.get(id)).filter(Boolean);
  const exp = () => exportXlsx(`Upcoming_Compliances_${win}_days.xlsx`, `Upcoming ${win} days`, DUE_COLS, rows.map(r => ({ ...r, days: r.days_left })));
  return (
    <Card title="Upcoming Compliances" icon={CalendarClock} subtitle="Not completed, due within the window (selected period only)"
      right={<div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {windows.map(w => <button key={w} onClick={() => setWin(w)} style={S.subTab(win === w)}>{w} days <span style={{ opacity: 0.7 }}>({(data.upcoming[w] || []).length})</span></button>)}
        <Btn size="sm" icon={Download} onClick={exp} disabled={!rows.length}>Export</Btn>
      </div>}>
      <DueList rows={rows} colors={colors} onOpen={onOpen} />
    </Card>
  );
}

export function OverdueCard({ data, rowsById, colors, onOpen }) {
  const rows = data.overdue.map(id => rowsById.get(id)).filter(Boolean);
  const exp = () => exportXlsx('Overdue_Compliances.xlsx', 'Overdue', DUE_COLS, rows.map(r => ({ ...r, days: -r.days_left })));
  return (
    <Card title={`Overdue Report (${rows.length})`} icon={AlertTriangle} subtitle="Not completed and past the due date (selected period only)"
      right={<Btn size="sm" icon={Download} onClick={exp} disabled={!rows.length}>Export</Btn>}>
      <DueList rows={rows} colors={colors} onOpen={onOpen} overdue />
    </Card>
  );
}

// ── Drilldown: Company → Module → Compliance → Task ───────────────────────────
function counts(rows) {
  const done = rows.filter(r => r.display_status === 'Completed').length;
  const na = rows.filter(r => r.display_status === 'N/A').length;
  const overdue = rows.filter(r => r.display_status === 'Overdue').length;
  const base = rows.length - na;
  return { total: rows.length, done, overdue, na, pct: base ? Math.round((done / base) * 1000) / 10 : null };
}

function group(rows, key, label) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], { key: r[key], label: r[label], rows: [] });
    m.get(r[key]).rows.push(r);
  }
  return [...m.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

function Node({ depth, id, label, rs, onLabel, children, leafIcon, open, toggle, colors }) {
  const c = counts(rs);
  const isOpen = !!open[id];
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.38rem 1.1rem', paddingLeft: `${1.1 + depth * 1.2}rem`, borderBottom: `1px solid ${T.border}`, background: depth === 0 ? T.card : undefined }} className="cmp-row">
        <button onClick={() => toggle(id)} aria-label={isOpen ? 'Collapse' : 'Expand'} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textMuted, display: 'inline-flex', padding: 0 }}>
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {leafIcon}
        <button onClick={onLabel} title="Show these tasks in the task table" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', flex: 1, minWidth: 0, color: T.text, fontWeight: depth === 0 ? 700 : 600, fontSize: '0.8rem', fontFamily: T.font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </button>
        <span style={{ ...S.faint, whiteSpace: 'nowrap' }}>{c.done}/{c.total - c.na} done{c.na ? ` · ${c.na} N/A` : ''}</span>
        {c.overdue > 0 && <span style={{ fontSize: '0.7rem', color: colors.Overdue, fontWeight: 700, whiteSpace: 'nowrap' }}>{c.overdue} overdue</span>}
        <div style={{ width: 150 }}><PctBar pct={c.pct} /></div>
      </div>
      {isOpen && children}
    </>
  );
}


export function DrillTree({ rows, colors, onFilter, onOpen }) {
  const [open, setOpen] = useState({});
  const toggle = k => setOpen(o => ({ ...o, [k]: !o[k] }));
  const tree = useMemo(() => group(rows, 'company_id', 'company_name').map(c => ({
    ...c, modules: group(c.rows, 'module', 'module').map(m => ({ ...m, compliances: group(m.rows, 'compliance_id', 'compliance_name') })),
  })), [rows]);

  if (!rows.length) return <Card title="Drilldown" icon={GitBranch}><Empty>No tasks in this period.</Empty></Card>;
  return (
    <Card title="Drilldown — Company → Module → Compliance → Task" icon={GitBranch} subtitle="Expand with the arrow. Click a name to filter the task table; click a task to open it.">
      {tree.map(c => (
        <Node open={open} toggle={toggle} colors={colors} key={c.key} depth={0} id={c.key} label={c.label} rs={c.rows} leafIcon={<Building2 size={13} color={T.primary} />} onLabel={() => onFilter({ company_id: c.key })}>
          {c.modules.map(m => (
            <Node open={open} toggle={toggle} colors={colors} key={m.key} depth={1} id={`${c.key}|${m.key}`} label={m.label} rs={m.rows} leafIcon={<Layers size={13} color={T.textMuted} />} onLabel={() => onFilter({ company_id: c.key, module: m.key })}>
              {m.compliances.map(cm => (
                <Node open={open} toggle={toggle} colors={colors} key={cm.key} depth={2} id={`${c.key}|${m.key}|${cm.key}`} label={cm.label} rs={cm.rows} onLabel={() => onFilter({ company_id: c.key, module: m.key, compliance_id: cm.key })}>
                  {cm.rows.slice().sort((a, b) => a.due_date.localeCompare(b.due_date)).map(t => (
                    <div key={t.task_id} className="cmp-row" onClick={() => onOpen(t.task_id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0.32rem 1.1rem', paddingLeft: '5rem', borderBottom: `1px solid ${T.border}`, cursor: 'pointer', fontSize: '0.78rem' }}>
                      <span style={{ fontFamily: T.mono, color: T.primary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.task_id}</span>
                      <span style={S.faint}>due {fmtDate(t.due_date)}</span>
                      <StatusBadge status={t.display_status} colors={colors} late={t.completed_late} />
                    </div>
                  ))}
                </Node>
              ))}
            </Node>
          ))}
        </Node>
      ))}
    </Card>
  );
}
