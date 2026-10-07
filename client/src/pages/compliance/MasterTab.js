import React, { useState } from 'react';
import { Download, Upload, Plus, FileSpreadsheet, Building2, ListChecks, GitMerge, ClipboardList, FolderTree, SlidersHorizontal, Users, History, BookOpen } from 'lucide-react';
import { capi, errText } from './complianceApi';
import { S, Btn, Note, saveBlob } from './ui';
import Companies from './master/Companies';
import Compliances from './master/Compliances';
import Applicability from './master/Applicability';
import TaskData from './master/TaskData';
import FolderSetup from './master/FolderSetup';
import SettingsLists from './master/SettingsLists';
import UsersRoles from './master/UsersRoles';
import AuditTrail from './master/AuditTrail';
import Instructions from './master/Instructions';
import ImportDialog from './master/ImportDialog';
import TaskEntryModal from './master/TaskEntryModal';

// Sub-sections of the Master tab. `need` = permission flag required to open it.
export const MASTER_SECTIONS = [
  { id: 'companies',     label: 'Company Master',        icon: Building2 },
  { id: 'compliances',   label: 'Compliance Master',     icon: ListChecks },
  { id: 'applicability', label: 'Company Applicability', icon: GitMerge },
  { id: 'tasks',         label: 'Task Data',             icon: ClipboardList },
  { id: 'folders',       label: 'Folder Setup',          icon: FolderTree, need: 'edit_master' },
  { id: 'settings',      label: 'Lists / Settings',      icon: SlidersHorizontal, need: 'admin' },
  { id: 'users',         label: 'Users and Roles',       icon: Users, need: 'admin' },
  { id: 'audit',         label: 'Audit Trail',           icon: History, need: 'admin' },
  { id: 'instructions',  label: 'Instructions',          icon: BookOpen },
];

export default function MasterTab({ meta, colors, section, onSection, onMetaChange }) {
  const [showImport, setShowImport] = useState(false);
  const [showEntry, setShowEntry] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const can = meta.me.flags;
  const sections = MASTER_SECTIONS.filter(s => !s.need || can[s.need]);
  const current = sections.some(s => s.id === section) ? section : sections[0].id;
  const changed = () => { setRefreshKey(k => k + 1); onMetaChange(); };

  const download = async (kind) => {
    setBusy(kind); setMsg(null);
    try {
      const r = kind === 'template' ? await capi.template() : await capi.exportMaster(meta.current.fy_default);
      saveBlob(r.data, kind === 'template' ? 'Compliance_Import_Template.xlsx' : `Compliance_Master_Data_FY${meta.current.fy_default}.xlsx`);
    } catch (e) { setMsg({ kind: 'error', text: await errText(e) }); }
    finally { setBusy(''); }
  };

  const props = { meta, colors, refreshKey, onChanged: changed };

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '0.9rem', alignItems: 'center' }}>
        <Btn icon={Download} onClick={() => download('template')} disabled={busy === 'template'} title="Empty Excel template with example rows and instructions">
          {busy === 'template' ? 'Preparing…' : 'Download Excel Template'}
        </Btn>
        {can.import && <Btn icon={Upload} onClick={() => setShowImport(true)} title="Preview first — nothing is saved until you confirm">Import Excel</Btn>}
        {can.edit_master && <Btn variant="primary" icon={Plus} onClick={() => setShowEntry(true)} title="Add one task by hand">Manual Entry</Btn>}
        <span style={{ flex: 1 }} />
        {can.edit_master && !meta.me.companies.length && (
          <Btn variant="ghost" icon={FileSpreadsheet} onClick={() => download('export')} disabled={busy === 'export'} title={`All masters + FY ${meta.current.fy_default} tasks — edit and re-import to bulk update`}>
            {busy === 'export' ? 'Preparing…' : 'Export Master Data'}
          </Btn>
        )}
      </div>
      {msg && <Note kind={msg.kind} style={{ marginBottom: 10 }}>{msg.text}</Note>}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: '1rem' }}>
        {sections.map(s => (
          <button key={s.id} onClick={() => onSection(s.id)} style={S.subTab(current === s.id)}>
            <s.icon size={13} /> {s.label}
          </button>
        ))}
      </div>

      {current === 'companies'     && <Companies {...props} />}
      {current === 'compliances'   && <Compliances {...props} />}
      {current === 'applicability' && <Applicability {...props} />}
      {current === 'tasks'         && <TaskData {...props} onManualEntry={() => setShowEntry(true)} />}
      {current === 'folders'       && <FolderSetup {...props} />}
      {current === 'settings'      && <SettingsLists {...props} />}
      {current === 'users'         && <UsersRoles {...props} />}
      {current === 'audit'         && <AuditTrail {...props} />}
      {current === 'instructions'  && <Instructions {...props} />}

      {showImport && <ImportDialog meta={meta} onClose={() => setShowImport(false)} onImported={changed} />}
      {showEntry && <TaskEntryModal meta={meta} onClose={() => setShowEntry(false)} onSaved={text => { changed(); setMsg({ kind: 'success', text }); }} />}
    </>
  );
}
