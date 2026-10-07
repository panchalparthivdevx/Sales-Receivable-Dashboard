import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Wand2, Plus, Trash2, Eye } from 'lucide-react';
import { T } from '../../../theme';
import { capi, errSync } from '../complianceApi';
import { S, Card, Btn, Note, Spinner, Empty, StatusBadge, fmtDate } from '../ui';
import FilterBar from '../FilterBar';
import TaskDetail from '../TaskDetail';
import { ALL, emptyFilters, toQuery, buildPeriodIndex, periodText } from '../filterLogic';

// Task Data: Generate Tasks (rules × companies × periods, never duplicates) + task list.
export default function TaskData({ meta, colors, refreshKey, onChanged, onManualEntry }) {
  const can = meta.me.flags.edit_master;
  const idx = useMemo(() => buildPeriodIndex(meta.period), [meta.period]);

  // ── Generate ──
  const [gen, setGen] = useState(() => emptyFilters(meta.current.fy_default));
  const [preview, setPreview] = useState(null);
  const [genMsg, setGenMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const genBody = () => ({ fy: gen.fy, half: gen.half, quarter: gen.quarter, month: gen.month,
    company_ids: gen.company === ALL ? [] : [gen.company], modules: gen.module === ALL ? [] : [gen.module] });
  useEffect(() => { setPreview(null); }, [gen]);

  const doPreview = async () => {
    setBusy(true); setGenMsg(null);
    try { setPreview(await capi.generate(genBody())); } catch (e) { setGenMsg({ kind: 'error', text: errSync(e) }); }
    finally { setBusy(false); }
  };
  const doGenerate = async () => {
    setBusy(true); setGenMsg(null);
    try {
      const r = await capi.generate({ ...genBody(), confirm: true });
      setGenMsg({ kind: r.errors.length ? 'warning' : 'success', text: `Created ${r.created} task(s). ${r.skipped} already existed and were skipped.${r.errors.length ? ` ${r.errors.length} could not be created: ${r.errors.slice(0, 3).map(e => `${e.task_id} (${e.error})`).join('; ')}` : ''}` });
      setPreview(null); loadList(); onChanged();
    } catch (e) { setGenMsg({ kind: 'error', text: errSync(e) }); }
    finally { setBusy(false); }
  };

  // ── List ──
  const [lf, setLf] = useState(() => ({ ...emptyFilters(meta.current.fy_default), month: meta.current.month, quarter: idx.monthByKey[meta.current.month].quarter, half: idx.monthByKey[meta.current.month].half }));
  const [list, setList] = useState(null);
  const [listMsg, setListMsg] = useState(null);
  const [open, setOpen] = useState(null);
  const lq = JSON.stringify(toQuery(lf));
  const loadList = useCallback(async () => {
    try { setList((await capi.dashboard(JSON.parse(lq))).rows); } catch (e) { setListMsg({ kind: 'error', text: errSync(e) }); }
  }, [lq]);
  useEffect(() => { loadList(); }, [loadList, refreshKey]);

  const remove = async r => {
    if (!window.confirm(`Delete task ${r.task_id}? Use this only for tasks created by mistake.`)) return;
    try { await capi.deleteTask(r.task_id); setListMsg({ kind: 'success', text: `${r.task_id} deleted.` }); loadList(); onChanged(); }
    catch (e) { setListMsg({ kind: 'error', text: errSync(e) }); }
  };

  return (
    <>
      {can && (
        <Card title="Generate Tasks" icon={Wand2} subtitle="Creates one task per company × active compliance × period from the Compliance Master. Existing tasks are never duplicated — run it again any time.">
          <div style={{ padding: '0.8rem 1.1rem 0' }}>
            <FilterBar meta={meta} filters={gen} onChange={setGen}>
              <Btn onClick={doPreview} disabled={busy}>Preview</Btn>
              <Btn variant="primary" icon={Wand2} onClick={doGenerate} disabled={busy || !preview || preview.create === 0}>
                {preview ? `Generate ${preview.create} task${preview.create === 1 ? '' : 's'}` : 'Generate'}
              </Btn>
            </FilterBar>
            {genMsg && <Note kind={genMsg.kind} style={{ marginBottom: 12 }}>{genMsg.text}</Note>}
            {preview && (
              <Note style={{ marginBottom: 12 }}>
                <strong>{periodText(idx, gen)}</strong>: {preview.create} new task(s) will be created, {preview.skipped} already exist.
                {preview.errors.length > 0 && <span style={{ color: T.danger }}> {preview.errors.length} cannot be created ({preview.errors[0].error}).</span>}
                {preview.sample.length > 0 && <div style={{ ...S.faint, marginTop: 4, maxHeight: 80, overflowY: 'auto', fontFamily: T.mono }}>
                  {preview.sample.map(s => `${s.task_id} (due ${fmtDate(s.due_date)}${s.applicable ? '' : ', N/A'})`).join(' · ')}{preview.create > preview.sample.length ? ' …' : ''}
                </div>}
              </Note>
            )}
          </div>
        </Card>
      )}

      <Card title="Task Data" icon={ClipboardList} subtitle="All tasks for the filters below. Click a task to edit it. Bulk changes: Export Master Data → edit in Excel → Import Excel."
        right={can && <Btn variant="primary" icon={Plus} onClick={onManualEntry}>Manual Entry</Btn>}>
        <div style={{ padding: '0.8rem 1.1rem 0' }}>
          <FilterBar meta={meta} filters={lf} onChange={setLf} />
          {listMsg && <Note kind={listMsg.kind} style={{ marginBottom: 12 }}>{listMsg.text}</Note>}
        </div>
        {!list ? <Spinner /> : list.length === 0 ? <Empty icon={ClipboardList}>No tasks for {periodText(idx, lf)}.</Empty> : (
          <div className="cmp-scroll" style={{ maxHeight: 600, overflowY: 'auto' }}>
            <table style={S.table}>
              <thead><tr>
                <th style={S.th}>Task ID</th><th style={S.th}>Compliance</th><th style={S.th}>Period</th><th style={S.th}>Due</th>
                <th style={S.th}>Responsible</th><th style={S.th}>Status</th><th style={{ ...S.th, textAlign: 'right' }}>Docs</th><th style={S.th} />
              </tr></thead>
              <tbody>
                {list.slice().sort((a, b) => a.task_id.localeCompare(b.task_id)).map(r => (
                  <tr key={r.task_id} className="cmp-row">
                    <td style={{ ...S.td, fontFamily: T.mono, fontSize: '0.75rem', color: T.primary, fontWeight: 600 }}>{r.task_id}</td>
                    <td style={S.td}>{r.compliance_name}</td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{r.period_label}</td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{fmtDate(r.due_date)}{r.due_date_source === 'manual' && <span style={S.faint}> · manual</span>}</td>
                    <td style={S.td}>{r.responsible || <span style={S.faint}>—</span>}</td>
                    <td style={S.td}><StatusBadge status={r.display_status} colors={colors} late={r.completed_late} /></td>
                    <td style={S.num}>{r.doc_count}</td>
                    <td style={{ ...S.td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <Btn size="sm" variant="ghost" icon={Eye} onClick={() => setOpen(r.task_id)}>Open</Btn>
                      {can && r.doc_count === 0 && <Btn size="sm" variant="danger" icon={Trash2} style={{ marginLeft: 4 }} title="Delete task (only without documents)" onClick={() => remove(r)} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list && <div style={{ ...S.faint, padding: '0.5rem 1.1rem' }}>{list.length} task(s)</div>}
      </Card>
      {open && <TaskDetail taskId={open} meta={meta} colors={colors} onClose={() => setOpen(null)} onChanged={() => { loadList(); }} />}
    </>
  );
}
