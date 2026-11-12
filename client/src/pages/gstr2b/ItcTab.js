import React, { useEffect, useState } from 'react';
import { g, errMsg } from './gApi';
import { S, Tag, dt } from './ui';

// The ITC register is Phase 2 — this screen says so, and shows the statutory rules (with their official sources) that the
// register will use, kept as data so they can be reviewed with the tax advisor.
export default function ItcTab({ meta }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { g.itc().then(setD).catch(e => setError(errMsg(e))); }, []);
  if (error) return <div style={S.error}>{error}</div>;
  if (!d) return <div style={S.center}>Loading…</div>;
  return (
    <div>
      <div style={S.notice}><b>Phase 2 — not built yet.</b> {d.message}</div>
      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>What the ITC register will do</span></div>
        <div style={S.cardBody}><ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem', lineHeight: 1.7 }}>{d.planned.map(x => <li key={x}>{x}</li>)}</ul></div>
      </div>
      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Statutory rules, effective-dated (verified {meta.rules.as_of})</span><span style={S.small}>Sources: CBIC tax repository and GST portal advisories. Not legal advice — confirm with your tax advisor.</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>Rule</th><th style={S.th}>In force from</th><th style={S.th}>Used in</th><th style={S.th}>What it says</th><th style={S.th}>Source</th></tr></thead>
            <tbody>{meta.rules.sections.map(r => (
              <tr key={r.id}><td style={{ ...S.td, fontWeight: 600, minWidth: 200 }}>{r.title}</td><td style={S.td}>{dt(r.effective_from)}</td><td style={S.td}><Tag tone={r.used_in.startsWith('Phase 1') ? 'green' : 'grey'}>{r.used_in}</Tag></td>
                <td style={{ ...S.td, minWidth: 340, lineHeight: 1.5 }}>{r.text}{r.note && <div style={{ ...S.muted, marginTop: 4 }}>{r.note}</div>}</td><td style={{ ...S.td, ...S.muted, minWidth: 220 }}>{r.source}</td></tr>))}</tbody>
          </table>
        </div>
      </div>
      <div style={S.card}>
        <div style={S.cardHead}><span style={S.cardTitle}>Recommended but not in force — never applied</span></div>
        <div style={S.cardBody}>{meta.rules.pending.map(p => (
          <div key={p.id} style={{ padding: '6px 0', borderBottom: '1px solid #F0F2F1' }}>
            <div style={{ fontWeight: 600, fontSize: '0.82rem' }}>{p.title} <Tag tone="amber">{p.status}</Tag></div>
            <div style={S.muted}>{p.detail}</div><div style={S.small}>{p.source}</div>
          </div>))}
          <p style={{ ...S.muted, marginBottom: 0 }}>These stay switched off until they are notified; the rule set is data, so turning one on later does not need a code change.</p>
        </div>
      </div>
    </div>
  );
}
