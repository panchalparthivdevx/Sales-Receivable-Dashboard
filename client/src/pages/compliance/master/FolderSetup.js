import React, { useCallback, useEffect, useState } from 'react';
import { FolderTree, FolderPlus, CheckCircle2, Circle } from 'lucide-react';
import { T } from '../../../theme';
import { capi, errSync } from '../complianceApi';
import { S, Card, Btn, Field, Select, Note } from '../ui';

// Folder Setup: ROOT / COMPANY / FY / MODULE / Qn / Month / Receipt | Challan | Other Data
// Creating is idempotent — existing folders are reported as "Already Exists", never duplicated.
export default function FolderSetup({ meta, onChanged }) {
  const [company, setCompany] = useState('ALL');
  const [fy, setFy] = useState(meta.current.fy_default);
  const [mods, setMods] = useState(meta.settings.folder_modules);
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const leaves = Object.values(meta.settings.folder_leaves || { receipt: 'Receipt', challan: 'Challan', other: 'Other Data' });

  const loadStatus = useCallback(async () => {
    try { setStatus(await capi.folderStatus({ company_id: company, fy })); } catch (e) { setMsg({ kind: 'error', text: errSync(e) }); }
  }, [company, fy]);
  useEffect(() => { setResult(null); loadStatus(); }, [loadStatus]);

  const create = async () => {
    setBusy(true); setMsg(null);
    try { setResult(await capi.createFolders({ company_id: company, fy, modules: mods })); loadStatus(); onChanged(); }
    catch (e) { setMsg({ kind: 'error', text: errSync(e) }); }
    finally { setBusy(false); }
  };
  const toggle = m => setMods(x => (x.includes(m) ? x.filter(y => y !== m) : [...x, m]));

  return (
    <>
      <Card title="Folder Setup" icon={FolderTree} subtitle="Creates the document folders for one Financial Year. Uploads are then filed automatically: Challan → Challan · any …Receipt → Receipt · everything else → Other Data.">
        <div style={{ padding: '0.9rem 1.1rem' }}>
          <div className="cmp-form3">
            <Field label="Company"><Select value={company} onChange={setCompany} options={[{ value: 'ALL', label: 'All active companies' }, ...meta.companies.map(c => ({ value: c.id, label: c.name }))]} /></Field>
            <Field label="Financial Year"><Select value={fy} onChange={setFy} options={meta.settings.fy_list.map(f => ({ value: f, label: `FY ${f}` }))} /></Field>
            <Field label="Storage Root" hint={meta.me.flags.admin ? 'Change it in Lists / Settings.' : 'Set by an admin in Lists / Settings.'}>
              <div style={{ ...S.control, background: T.page, fontFamily: T.mono, fontSize: '0.74rem', overflowWrap: 'anywhere' }}>{status?.root || meta.settings.storage_root || '—'}</div>
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <span style={S.label}>Modules</span>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {meta.settings.folder_modules.map(m => (
                <label key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={mods.includes(m)} onChange={() => toggle(m)} /> {m}
                </label>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn variant="primary" icon={FolderPlus} onClick={create} disabled={busy || !mods.length}>{busy ? 'Creating…' : 'Create Folder Structure'}</Btn>
            <span style={S.faint}>Path: ROOT / {company === 'ALL' ? 'COMPANY' : meta.companies.find(c => c.id === company)?.name} / {meta.settings.fy_folder_prefix ?? 'FY '}{fy} / MODULE / Q1 / April / {leaves.join(' | ')}</span>
          </div>
          {msg && <Note kind={msg.kind} style={{ marginTop: 12 }}>{msg.text}</Note>}

          {result && (
            <div style={{ marginTop: 14, padding: '0.8rem 1rem', border: `1px solid ${T.border}`, borderRadius: 8, background: T.page }}>
              <div style={{ fontWeight: 700, color: T.success, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <CheckCircle2 size={16} /> {result.results.every(r => r.modules.every(m => m.status === 'Already Exists')) ? 'Folder structure already exists' : 'Folder structure created'}
              </div>
              {result.results.map(r => (
                <div key={r.company_id} style={{ marginBottom: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.82rem' }}>{r.company_name} · FY {result.fy}</div>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.8rem' }}>
                    {r.modules.map(m => (
                      <span key={m.module} style={{ color: T.success }}>✓ {m.module} <span style={{ color: T.textMuted }}>— {m.status === 'Created' ? `created (${m.created} folders${m.existed ? `, ${m.existed} already there` : ''})` : 'Already Exists'}</span></span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {status && (
        <Card title={`Current folders · FY ${status.fy}`} icon={FolderTree} subtitle="Checked on disk just now.">
          <div className="cmp-scroll">
            <table style={S.table}>
              <thead><tr><th style={S.th}>Company</th>{meta.settings.folder_modules.map(m => <th key={m} style={S.th}>{m}</th>)}</tr></thead>
              <tbody>
                {status.companies.map(c => (
                  <tr key={c.company_id}>
                    <td style={{ ...S.td, fontWeight: 600 }}>{c.company_name}</td>
                    {c.modules.map(m => (
                      <td key={m.module} style={S.td}>
                        {m.complete ? <span style={{ color: T.success, display: 'inline-flex', gap: 4, alignItems: 'center' }}><CheckCircle2 size={13} /> Ready</span>
                          : m.present ? <span style={{ color: T.warning }}>{m.present}/{m.total} folders</span>
                          : <span style={{ color: T.textFaint, display: 'inline-flex', gap: 4, alignItems: 'center' }}><Circle size={13} /> Not created</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
