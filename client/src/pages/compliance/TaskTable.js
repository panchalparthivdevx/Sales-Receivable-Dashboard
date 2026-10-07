import React, { useMemo, useState, useEffect } from 'react';
import { Download, Paperclip, ArrowUp, ArrowDown, ListChecks } from 'lucide-react';
import { T } from '../../theme';
import { S, Btn, StatusBadge, Empty, fmtDate, exportXlsx } from './ui';

// Task table. Columns come from the server's single column list (meta.columns.task_view),
// the same list used for Excel exports, so the screen and the export never drift apart.

const PAGE = 100;

function sortValue(r, key) {
  if (key === 'period') return `${r.fy}${String(r.month_label)}`;
  if (key === 'doc_count') return r.doc_count;
  return String(r[key] ?? '').toLowerCase();
}

function Cell({ col, r, colors }) {
  switch (col.key) {
    case 'task_id':
      return <span style={{ fontFamily: T.mono, fontSize: '0.75rem', color: T.primary, fontWeight: 600 }}>{r.task_id}</span>;
    case 'company_name':
      return <div style={{ minWidth: 120, maxWidth: 220 }}>{r.company_name}</div>;
    case 'compliance_name':
      return <div style={{ minWidth: 150, maxWidth: 260 }}><div style={{ fontWeight: 600 }}>{r.compliance_name}</div>{r.form_name && <div style={S.faint}>{r.form_name}{r.statutory ? '' : ' · internal'}</div>}</div>;
    case 'period':
      return (
        <div style={{ whiteSpace: 'nowrap' }}>
          <div>{r.frequency === 'Monthly' ? r.month_label : r.period_label}</div>
          <div style={S.faint}>{r.frequency === 'Monthly' ? `${r.quarter} · ${r.half}` : `${r.month_label} · ${r.quarter} · ${r.half}`}</div>
        </div>
      );
    case 'due_date': {
      const late = r.display_status === 'Overdue';
      return (
        <div style={{ whiteSpace: 'nowrap' }}>
          <div>{fmtDate(r.due_date)}</div>
          {r.display_status !== 'Completed' && r.display_status !== 'N/A' && r.days_left !== null && (
            <div style={{ fontSize: '0.7rem', color: late ? T.danger : r.days_left <= 7 ? T.warning : T.textFaint }}>
              {late ? `${-r.days_left} day(s) late` : r.days_left === 0 ? 'due today' : `in ${r.days_left} day(s)`}
            </div>
          )}
          {r.display_status === 'Completed' && r.completion_date && <div style={S.faint}>done {fmtDate(r.completion_date)}</div>}
        </div>
      );
    }
    case 'display_status':
      return <StatusBadge status={r.display_status} colors={colors} late={r.completed_late} />;
    case 'doc_count':
      return r.doc_count ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: T.primary, fontWeight: 600 }}><Paperclip size={12} />{r.doc_count}</span> : <span style={S.faint}>0</span>;
    default:
      return r[col.key] ? <span>{r[col.key]}</span> : <span style={S.faint}>—</span>;
  }
}

export default function TaskTable({ meta, rows, colors, onOpen, title, subtitle, toolbar, exportName }) {
  const uiCols = meta.columns.task_view.filter(c => c.ui);
  const exportCols = meta.columns.task_view.filter(c => c.export);
  const [sort, setSort] = useState({ key: 'due_date', dir: 1 });
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [rows]);

  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
    return (x < y ? -1 : x > y ? 1 : a.task_id.localeCompare(b.task_id)) * sort.dir;
  }), [rows, sort]);

  const doExport = () => exportXlsx(exportName || 'Compliance_Tasks.xlsx', 'Tasks', exportCols, sorted, (r, c) => (c.type === 'date' ? fmtDate(r[c.key]) : r[c.key] ?? ''));
  const head = key => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }));

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <ListChecks size={15} color={T.primary} />
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={S.cardTitle}>{title} <span style={{ ...S.faint, fontWeight: 400 }}>· {rows.length} task{rows.length !== 1 ? 's' : ''}</span></div>
          {subtitle && <div style={S.cardSub}>{subtitle}</div>}
        </div>
        <Btn size="sm" icon={Download} onClick={doExport} disabled={!rows.length} title="Export exactly the rows listed below">Export</Btn>
      </div>
      {toolbar && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0.6rem 1.1rem', borderBottom: `1px solid ${T.border}`, alignItems: 'center', background: T.page }}>{toolbar}</div>}
      {rows.length === 0 ? <Empty icon={ListChecks} title="No tasks to show">Change the filters above, or create tasks in Master › Task Data › Generate Tasks.</Empty> : (
        <>
          <div className="cmp-scroll">
            <table style={S.table}>
              <thead><tr>
                {uiCols.map(c => (
                  <th key={c.key} style={{ ...S.th, cursor: 'pointer', textAlign: c.key === 'doc_count' ? 'center' : 'left' }} onClick={() => head(c.key)} title={c.help || `Sort by ${c.header}`}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>{c.header}{sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}</span>
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {sorted.slice(0, shown).map(r => (
                  <tr key={r.task_id} className="cmp-row" onClick={() => onOpen(r.task_id)} style={{ cursor: 'pointer', background: r.display_status === 'Overdue' ? 'rgba(220,38,38,0.035)' : undefined }}>
                    {uiCols.map(c => <td key={c.key} style={{ ...S.td, textAlign: c.key === 'doc_count' ? 'center' : 'left' }}><Cell col={c} r={r} colors={colors} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sorted.length > shown && (
            <div style={{ padding: '0.6rem 1.1rem', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={S.faint}>Showing {shown} of {sorted.length}</span>
              <Btn size="sm" variant="ghost" onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, sorted.length - shown)} more</Btn>
              <Btn size="sm" variant="ghost" onClick={() => setShown(sorted.length)}>Show all</Btn>
            </div>
          )}
        </>
      )}
    </div>
  );
}
