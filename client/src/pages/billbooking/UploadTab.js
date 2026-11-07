import React, { useState, useRef } from 'react';
import { Upload, FileText, X } from 'lucide-react';
import { bb, errMsg } from './bbApi';
import { S, Field, Msg } from './ui';

// ─── Manual upload of bills downloaded from the ERP ───────────────────────────
// Same workflow as email bills. Until the ERP can be fetched directly, the team uploads its PDFs here.

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.bmp,.webp,.tif,.tiff';

export default function UploadTab({ meta, onDone }) {
  const [list, setList] = useState([]);
  const [company, setCompany] = useState('');
  const [member, setMember] = useState(() => meta.team.find(m => m.dashboard_user && m.dashboard_user === meta.me.username)?.id || '');
  const [erpRef, setErpRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const input = useRef(null);
  const vercel = meta.integrations.vercel;
  const maxMb = vercel ? 4 : 25;

  const add = files => {
    const next = [...list];
    for (const f of files) if (!next.some(x => x.name === f.name && x.size === f.size)) next.push(f);
    setList(next);
  };

  async function send() {
    setBusy(true); setError(''); setResult(null);
    const out = [];
    try {
      // Vercel accepts about 4 MB per request: one file per request there; the office PC takes them together
      const batches = vercel ? list.map(f => [f]) : [list];
      let n = 0;
      for (const batch of batches) {
        const form = new FormData();
        form.append('company', company);
        form.append('member_id', member);
        form.append('erp_ref', erpRef);
        for (const f of batch) form.append('files', f, f.name);
        const r = await bb.upload(form, e => setProgress(`${n + 1}/${batches.length} · ${e.total ? Math.round((e.loaded / e.total) * 100) : 0}%`));
        out.push(...r.files);
        n++;
      }
      setResult(out);
      setList([]);
      onDone?.();
    } catch (e) { setError(errMsg(e)); setResult(out.length ? out : null); } finally { setBusy(false); setProgress(''); }
  }

  const tooBig = list.filter(f => f.size > maxMb * 1024 * 1024);
  return (
    <div style={{ maxWidth: 900 }}>
      <Msg error={error} onClose={() => setError('')} />
      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Upload bills from the ERP</span><span style={S.small}>PDF or image · up to {maxMb} MB each</span></div>
        <div style={S.cardBody}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
            <Field label="Company (optional)">
              <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} value={company} onChange={e => setCompany(e.target.value)}>
                <option value="">Find from the bill</option>
                {meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Responsible team member">
              <select style={{ ...S.select, width: '100%', maxWidth: 'none' }} value={member} onChange={e => setMember(e.target.value)}>
                <option value="">—</option>
                {meta.team.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
            <Field label="ERP reference (optional)">
              <input style={{ ...S.input, width: '100%' }} value={erpRef} onChange={e => setErpRef(e.target.value)} placeholder="e.g. ERP batch / document no." />
            </Field>
          </div>
          <div
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); add(e.dataTransfer.files); }}
            onClick={() => input.current?.click()}
            style={{ border: '2px dashed #A7C4BC', borderRadius: 10, padding: '2rem', textAlign: 'center', cursor: 'pointer', background: '#F6FAF8', color: '#1C4942' }}>
            <Upload size={22} />
            <div style={{ fontWeight: 600, marginTop: 6 }}>Drop bill files here, or click to choose</div>
            <div style={S.small}>Each file is read, checked for duplicates and matched exactly like an email bill.</div>
            <input ref={input} type="file" multiple accept={ACCEPT} style={{ display: 'none' }} onChange={e => { add(e.target.files); e.target.value = ''; }} />
          </div>
          {list.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {list.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', padding: '4px 0', borderBottom: '1px solid #F2F2F2' }}>
                  <FileText size={13} color="#5D6C7B" /><span style={{ flex: 1 }}>{f.name}</span>
                  <span style={{ ...S.small, color: f.size > maxMb * 1024 * 1024 ? '#B91C1C' : undefined }}>{Math.round(f.size / 1024)} KB</span>
                  <button style={{ ...S.ghost, padding: 3 }} onClick={() => setList(list.filter((_, j) => j !== i))}><X size={12} /></button>
                </div>
              ))}
              {tooBig.length > 0 && <div style={{ ...S.error, marginTop: 8 }}>{tooBig.length} file(s) are larger than {maxMb} MB — remove them first.</div>}
              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                <button style={S.primary} disabled={busy || tooBig.length > 0} onClick={send}><Upload size={13} /> {busy ? `Uploading… ${progress}` : `Upload ${list.length} file(s)`}</button>
                <button style={S.ghost} disabled={busy} onClick={() => setList([])}>Clear</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {result && (
        <div style={S.card}>
          <div style={S.cardHead}><span style={S.cardTitle}>Uploaded</span><span style={S.small}>Reading runs in the background — follow them in the report</span></div>
          <div style={S.cardBody}>
            {result.map((r, i) => (
              <div key={i} style={{ fontSize: '0.8rem', padding: '3px 0', color: r.error ? '#B91C1C' : '#18191B' }}>
                {r.error ? '✕' : '✓'} {r.name} {r.id ? <span style={S.small}>→ {r.id}</span> : <span>— {r.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
