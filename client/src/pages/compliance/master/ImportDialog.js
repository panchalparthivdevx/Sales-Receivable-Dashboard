import React, { useState } from 'react';
import { Upload, Download, CheckCircle2, FileSpreadsheet } from 'lucide-react';
import { T } from '../../../theme';
import { capi, errSync, errText } from '../complianceApi';
import { S, Btn, Modal, Note, saveBlob } from '../ui';

// Two-step Excel import: Preview (writes nothing) → Confirm (backup first, one write).
export default function ImportDialog({ meta, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const doPreview = async () => {
    setBusy('preview'); setErr(''); setPreview(null);
    try { setPreview(await capi.importPreview(file)); } catch (e) { setErr(errSync(e)); }
    finally { setBusy(''); }
  };
  const doConfirm = async () => {
    setBusy('confirm'); setErr('');
    try { const r = await capi.importConfirm(preview.token); setDone(r); onImported(); } catch (e) { setErr(errSync(e)); }
    finally { setBusy(''); }
  };
  const errorReport = async () => {
    try { const r = await capi.importErrors(preview.token); saveBlob(r.data, 'Import_Error_Report.xlsx'); } catch (e) { setErr(await errText(e)); }
  };

  const problems = preview ? [...preview.errors, ...preview.skipped] : [];
  const sheetLabel = Object.fromEntries(meta.columns.sheet_order.map(k => [k, meta.columns.sheets[k].sheet]));

  return (
    <Modal title="Import Excel" subtitle="Step 1: Preview — nothing is saved. Step 2: Confirm — a backup is taken first, then all valid rows are saved together." width={860} onClose={onClose}
      footer={done ? <Btn variant="primary" onClick={onClose}>Close</Btn> : (
        <>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          {problems.length > 0 && <Btn icon={Download} onClick={errorReport}>Download Error Report</Btn>}
          {!preview
            ? <Btn variant="primary" icon={Upload} onClick={doPreview} disabled={!file || busy === 'preview'}>{busy === 'preview' ? 'Checking…' : 'Preview'}</Btn>
            : <Btn variant="primary" icon={CheckCircle2} onClick={doConfirm} disabled={!preview.action_total || busy === 'confirm'}>
                {busy === 'confirm' ? 'Importing…' : `Confirm Import (${preview.action_total} change${preview.action_total === 1 ? '' : 's'})`}
              </Btn>}
        </>
      )}>
      {err && <Note kind="error" style={{ marginBottom: 10 }}>{err}</Note>}

      {done ? (
        <Note kind="success">
          <strong>Import complete.</strong> {done.applied} change(s) saved. {done.errors.length ? `${done.errors.length} row(s) had errors and were skipped. ` : ''}{done.skipped.length ? `${done.skipped.length} duplicate row(s) skipped. ` : ''}
          Backup taken before saving: <code>{done.backup}</code>
        </Note>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <FileSpreadsheet size={18} color={T.primary} />
            <input type="file" accept=".xlsx,.xls" onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null); }} style={{ ...S.control, width: 'auto', padding: '0.3rem' }} />
            <span style={S.faint}>Use the downloaded template. Blank cell = unchanged · #CLEAR = empty · rows starting with # are ignored.</span>
          </div>

          {preview && (
            <>
              <div style={{ fontSize: '0.8rem', marginBottom: 8 }}>File <strong>{preview.file}</strong> — sheets found: {preview.sheets.join(', ') || 'none'}</div>
              <table style={{ ...S.table, marginBottom: 12 }}>
                <thead><tr><th style={S.th}>Sheet</th>{['New', 'Updated', 'No change', 'Skipped (duplicate)', 'Errors'].map(h => <th key={h} style={{ ...S.th, textAlign: 'right' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {Object.entries(preview.counts).map(([k, c]) => (
                    <tr key={k}>
                      <td style={S.td}>{k}</td>
                      <td style={S.num}>{c.create}</td><td style={S.num}>{c.update}</td><td style={S.num}>{c.nochange}</td>
                      <td style={{ ...S.num, color: c.skipped ? T.warning : T.text }}>{c.skipped}</td>
                      <td style={{ ...S.num, color: c.error ? T.danger : T.text }}>{c.error}</td>
                    </tr>
                  ))}
                  {!Object.keys(preview.counts).length && <tr><td style={S.td} colSpan={6}>No data rows found.</td></tr>}
                </tbody>
              </table>

              {preview.action_total > 0 && (
                <Note kind="success" style={{ marginBottom: 10 }}>
                  {preview.action_total} row(s) will be saved: {preview.actions.slice(0, 12).map(a => `${a.action === 'create' ? '+' : '✎'} ${a.id}`).join(' · ')}{preview.action_total > 12 ? ' …' : ''}
                </Note>
              )}
              {preview.warnings?.length > 0 && <Note kind="warning" style={{ marginBottom: 10 }}>{preview.warnings.map(w => `${w.sheet}: ${w.error}`).join(' ')}</Note>}

              {problems.length > 0 && (
                <>
                  <div style={{ ...S.label, marginTop: 6 }}>Rows that will NOT be saved ({problems.length})</div>
                  <div className="cmp-scroll" style={{ maxHeight: 300, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 8 }}>
                    <table style={S.table}>
                      <thead><tr>{meta.columns.error_report.map(c => <th key={c.key} style={S.th}>{c.header}</th>)}</tr></thead>
                      <tbody>
                        {problems.map((p, i) => (
                          <tr key={i}>
                            <td style={S.td}>{sheetLabel[p.sheet] || p.sheet}</td><td style={S.num}>{p.row}</td><td style={S.td}>{p.field}</td>
                            <td style={{ ...S.td, color: preview.skipped.includes(p) ? T.warning : T.danger }}>{p.error}</td><td style={{ ...S.td, ...S.muted }}>{p.fix}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {preview.action_total === 0 && <Note kind="warning" style={{ marginTop: 10 }}>Nothing to import. Fix the errors in Excel and preview again.</Note>}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
