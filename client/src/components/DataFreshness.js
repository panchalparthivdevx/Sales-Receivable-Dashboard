import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';

// "Data as of …" line for dashboards backed by the central sync cache.
// Shows the OLDEST last-synced time among the given entities (the report is only as
// fresh as its stalest input). Renders nothing if freshness can't be loaded.
export default function DataFreshness({ entities, style }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let alive = true;
    api.syncFreshness()
      .then(r => {
        if (!alive) return;
        const rows = entities.map(k => r.entities?.[k]).filter(Boolean);
        const times = rows.map(e => e.last_synced_at).filter(Boolean).sort();
        setInfo({ asOf: times[0] || null, staleH: r.stale_hours ?? 4, failed: rows.some(e => e.status === 'failed') });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [entities.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return null;
  if (!info.asOf) return <span style={{ color: '#9BA8B0', fontSize: '0.74rem', ...style }}>Data: live from Zoho (not yet synced)</span>;
  const ageH = (Date.now() - new Date(info.asOf).getTime()) / 3600000;
  const stale = ageH >= info.staleH;
  const label = new Date(info.asOf).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return (
    <span style={{ color: stale || info.failed ? '#d97706' : '#5D6C7B', fontSize: '0.74rem', ...style }}
      title={stale ? `Older than ${info.staleH}h — reports fall back to live Zoho where needed` : 'Central sync cache'}>
      Data as of: {label}{stale ? ' (stale)' : ''}{info.failed ? ' · last sync had errors' : ''}
    </span>
  );
}
