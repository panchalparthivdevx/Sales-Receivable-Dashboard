import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api';

const STAGE_LABELS = {
  1: 'Stage 1 — Master Data',
  2: 'Stage 2 — Primary Transactions',
  3: 'Stage 3 — Settlements & Adjustments',
  4: 'Stage 4 — Status Views & Derived',
};

const MODE_LABELS = {
  normal:       'Sync Data',
  recheck:      'Recheck Data',
  full:         'Full Sync Data',
  full_refresh: 'Full Data Refresh',
};

const TRIGGER_LABELS = {
  scheduled: 'Scheduled',
  manual:    'Manual',
  entity:    'Individual Entity',
  retry:     'Retry',
  initial:   'Initial',
  full_resync: 'Manual',
};

const S = {
  page: { padding: '1.5rem 2rem', minHeight: '100vh', background: '#F9F9F9', fontFamily: 'Figtree, Inter, system-ui, sans-serif' },
  header: { marginBottom: '1.5rem' },
  h1: { color: '#18191B', fontSize: '1.2rem', fontWeight: 700, margin: 0 },
  sub: { color: '#9BA8B0', fontSize: '0.8rem', marginTop: 4 },
  row: { display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' },
  card: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '1rem 1.25rem', flex: '1 1 260px', minWidth: 240, boxShadow: '0 1px 3px rgba(0,18,20,0.06)' },
  cardLabel: { color: '#5D6C7B', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 },
  cardVal: { color: '#18191B', fontSize: '1.4rem', fontWeight: 700 },
  cardSub: { color: '#5D6C7B', fontSize: '0.72rem', marginTop: 4 },
  statusDot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6 },
  entityGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0.75rem', marginBottom: '1rem' },
  entityCard: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '0.9rem 1.1rem', boxShadow: '0 1px 3px rgba(0,18,20,0.06)', display: 'flex', flexDirection: 'column' },
  entityName: { color: '#18191B', fontSize: '0.82rem', fontWeight: 600, marginBottom: 6 },
  entityMeta: { color: '#5D6C7B', fontSize: '0.74rem', lineHeight: 1.6, flex: 1 },
  val: { color: '#18191B', fontVariantNumeric: 'tabular-nums' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 600, whiteSpace: 'nowrap' },
  btn: { padding: '0.5rem 1rem', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 },
  btnPrimary: { background: '#1C4942', color: '#fff' },
  btnSecondary: { background: '#334155', color: '#fff' },
  btnAmber: { background: '#B45309', color: '#fff' },
  btnDanger: { background: '#DC2626', color: '#fff' },
  btnGhost: { background: '#FFFFFF', color: '#5D6C7B', border: '1px solid #DFE7E3' },
  btnSmall: { fontSize: '0.72rem', padding: '3px 8px' },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' },
  th: { padding: '0.5rem 0.75rem', textAlign: 'left', color: '#5D6C7B', fontWeight: 600, borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap', background: '#F9F9F9' },
  td: { padding: '0.5rem 0.75rem', color: '#18191B', borderBottom: '1px solid #F2F2F2', verticalAlign: 'top', whiteSpace: 'nowrap' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  section: { marginBottom: '1.75rem' },
  sectionTitle: { color: '#5D6C7B', fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.75rem' },
  stageTitle: { color: '#5D6C7B', fontSize: '0.72rem', fontWeight: 600, marginBottom: '0.5rem' },
  panel: { background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 10, padding: '1rem 1.25rem', marginBottom: '1.5rem', boxShadow: '0 1px 3px rgba(0,18,20,0.06)' },
  confirmBox: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '1rem 1.25rem', marginBottom: '1rem' },
  confirmText: { color: '#DC2626', fontSize: '0.83rem', marginBottom: '0.75rem', lineHeight: 1.5 },
  btnRow: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  errBox: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6, padding: '0.5rem 0.6rem', marginTop: 6, color: '#991B1B', fontSize: '0.72rem', lineHeight: 1.55 },
};

function statusColor(s) {
  if (s === 'success' || s === 'completed' || s === 'match') return '#16a34a';
  if (s === 'in_progress' || s === 'running') return '#d97706';
  if (s === 'failed') return '#dc2626';
  if (s === 'partial' || s === 'review') return '#ea580c';
  return '#64748b';
}

function statusBg(s) {
  if (s === 'success' || s === 'completed' || s === 'match') return '#16a34a1a';
  if (s === 'failed') return '#ef44441a';
  if (s === 'in_progress' || s === 'running') return '#f59e0b22';
  if (s === 'partial' || s === 'review') return '#f973161a';
  return '#4755691a';
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });
  } catch { return iso; }
}

function fmtAge(iso) {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtMs(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 120000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

const n = v => (v == null ? '—' : Number(v).toLocaleString('en-IN'));

function Badge({ status, children }) {
  const col = statusColor(status);
  return (
    <span style={{ ...S.badge, background: statusBg(status), color: col }}>
      <span style={{ ...S.statusDot, background: col }} />
      {children || String(status || '').replace('_', ' ')}
    </span>
  );
}

function ErrorDetail({ err }) {
  if (!err) return null;
  return (
    <div style={S.errBox}>
      <div><b>Entity:</b> {err.entity}</div>
      <div><b>Zoho endpoint:</b> {err.endpoint}</div>
      <div><b>Error type:</b> {err.error_type}{err.http_status ? ` (HTTP ${err.http_status})` : ''}</div>
      <div><b>Message:</b> {err.message}</div>
      <div><b>Time:</b> {fmtTime(err.timestamp)}</div>
      <div><b>Completed before failure:</b> {n(err.pages_completed)} pages, {n(err.records_fetched)} records</div>
      <div><b>Retry:</b> {err.retry_status}</div>
      <div><b>Mode:</b> {MODE_LABELS[err.mode] || err.mode}</div>
      <div style={{ marginTop: 4, color: '#5D6C7B' }}>Previously cached data is still being served.</div>
    </div>
  );
}

function ProgressPanel({ progress, running }) {
  if (!progress) return null;
  const ents = Object.entries(progress.entities || {});
  const sum = progress.summary;
  const title = `${progress.mode_label || MODE_LABELS[progress.mode] || progress.mode} — ${running ? 'Running' : (progress.status === 'success' ? 'Completed' : progress.status)}`;
  return (
    <div style={S.panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ ...S.entityName, marginBottom: 0 }}>{title}</div>
        <div style={{ color: '#5D6C7B', fontSize: '0.72rem' }}>
          {TRIGGER_LABELS[progress.trigger] || progress.trigger} · started {fmtTime(progress.started_at)}
        </div>
      </div>
      <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.76rem', lineHeight: 1.75 }}>
        {ents.map(([key, e]) => {
          const col = statusColor(e.state);
          let detail = '';
          if (e.state === 'completed') detail = `Completed — ${n(e.record_count)} records (+${n(e.added)} / ~${n(e.updated)} / −${n(e.removed)})`;
          else if (e.state === 'running') detail = `Running${e.pages ? ` — ${e.pages} pages, ${n(e.fetched)} fetched` : ''}`;
          else if (e.state === 'failed') detail = `Failed — ${e.error}`;
          else detail = e.state === 'skipped' ? 'Skipped (already running)' : 'Pending';
          return (
            <div key={key} style={{ display: 'flex', gap: 8 }}>
              <span style={{ minWidth: 230, color: '#18191B', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                {e.label} {'.'.repeat(Math.max(2, 26 - (e.label || '').length))}
              </span>
              <span style={{ color: col }}>{detail}</span>
            </div>
          );
        })}
      </div>
      {sum && (
        <div style={{ ...S.btnRow, marginTop: 10, gap: '1.25rem', fontSize: '0.76rem', color: '#5D6C7B' }}>
          <span>Entities: <b style={S.val}>{n(sum.entities_processed)}</b></span>
          <span>Checked: <b style={S.val}>{n(sum.records_checked)}</b></span>
          <span>Added: <b style={S.val}>{n(sum.added)}</b></span>
          <span>Updated: <b style={S.val}>{n(sum.updated)}</b></span>
          <span>Removed: <b style={S.val}>{n(sum.removed)}</b></span>
          <span>Unchanged: <b style={S.val}>{n(sum.unchanged)}</b></span>
          <span>Failed: <b style={{ ...S.val, color: sum.failed ? '#dc2626' : '#18191B' }}>{n(sum.failed)}</b></span>
          <span>Duration: <b style={S.val}>{fmtMs(sum.duration_ms)}</b></span>
        </div>
      )}
    </div>
  );
}

function ValidationPanel({ v, entities }) {
  if (!v) return null;
  const rows = Object.entries(v.entities || {});
  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>Last Full Data Refresh — Reconciliation ({fmtTime(v.completed_at)})</div>
      <div style={{ ...S.panel, padding: 0, overflow: 'hidden' }}>
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                {['Entity', 'Zoho Count', 'Cached Before', 'Difference', 'Missing (added)', 'Changed', 'Removed in Zoho', 'Status'].map(h => (
                  <th key={h} style={{ ...S.th, ...(h === 'Entity' || h === 'Status' ? {} : S.num) }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, r]) => {
                const ok = r.difference === 0 && !r.duplicates_from_zoho;
                return (
                  <tr key={key}>
                    <td style={S.td}>{entities[key]?.label || key}</td>
                    <td style={{ ...S.td, ...S.num }}>{n(r.zoho_count)}</td>
                    <td style={{ ...S.td, ...S.num }}>{n(r.cached_before)}</td>
                    <td style={{ ...S.td, ...S.num, color: r.difference ? '#ea580c' : '#18191B' }}>{r.difference > 0 ? '+' : ''}{n(r.difference)}</td>
                    <td style={{ ...S.td, ...S.num }}>{n(r.missing_in_cache)}</td>
                    <td style={{ ...S.td, ...S.num }}>{n(r.changed)}</td>
                    <td style={{ ...S.td, ...S.num }}>{n(r.removed_from_zoho)}</td>
                    <td style={S.td}><Badge status={ok ? 'match' : 'review'}>{ok ? 'in sync' : 'repaired'}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {(v.key_totals || []).map((k, i) => (
        <div key={i} style={{ ...S.panel, padding: '0.75rem 1rem', fontSize: '0.76rem', color: '#5D6C7B' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <b style={{ color: '#18191B' }}>{k.check}</b>
            <Badge status={k.status} />
          </div>
          {k.zoho_total != null && (
            <div style={{ marginTop: 4 }}>
              Zoho: <b style={S.val}>₹{n(k.zoho_total)}</b> · Cache: <b style={S.val}>₹{n(k.cached_total)}</b> · Difference: <b style={S.val}>₹{n(k.difference)}</b>
            </div>
          )}
          {k.note && <div style={{ marginTop: 2 }}>{k.note}</div>}
        </div>
      ))}
      {v.msme && (
        <div style={{ ...S.panel, padding: '0.75rem 1rem', fontSize: '0.76rem', color: '#5D6C7B' }}>
          <b style={{ color: '#18191B' }}>MSME Sector → Major Activity</b>
          <div style={{ marginTop: 4 }}>
            MSME vendors: <b style={S.val}>{n(v.msme.msme_vendors)}</b> · With MSME Sector: <b style={S.val}>{n(v.msme.with_msme_sector)}</b> ·
            Blank in Zoho: <b style={S.val}>{n(v.msme.blank_msme_sector)}</b> ·
            Zoho populated but cache blank: <b style={{ ...S.val, color: v.msme.sector_in_zoho_but_blank ? '#dc2626' : '#16a34a' }}>{n(v.msme.sector_in_zoho_but_blank)}</b> ·
            Unrecognised values: <b style={S.val}>{n((v.msme.unrecognised || []).length)}</b>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SyncMonitor() {
  const [status, setStatus]         = useState(null);
  const [loading, setLoading]       = useState(true);
  const [progress, setProgress]     = useState(null);
  const [running, setRunning]       = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const [lastAction, setLastAction] = useState(null);
  const [error, setError]           = useState(null);
  const [openErr, setOpenErr]       = useState({});
  const [openRun, setOpenRun]       = useState(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await api.syncStatus();
      setStatus(data);
      setProgress(data.progress || null);
      setRunning(!!data.running);
      wasRunning.current = !!data.running;
      setError(null);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh status every 15 s
  useEffect(() => {
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  // While a run is active, poll progress every 2 s; reload full status when it finishes
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(async () => {
      try {
        const p = await api.syncProgress();
        setProgress(p.progress);
        if (!p.running) {
          setRunning(false);
          const s = p.progress?.summary;
          setLastAction({
            ok: p.progress?.status === 'success',
            msg: `${p.progress?.mode_label || 'Sync'} ${p.progress?.status === 'success' ? 'completed' : p.progress?.status}` +
              (s ? ` — ${n(s.entities_processed)} entities, ${n(s.records_checked)} checked, +${n(s.added)} added, ${n(s.updated)} updated, ${n(s.removed)} removed, ${n(s.failed)} failed in ${fmtMs(s.duration_ms)}` : ''),
          });
          load();
        }
      } catch (_) { /* transient — keep polling */ }
    }, 2000);
    return () => clearInterval(id);
  }, [running, load]);

  const start = async (mode, entity) => {
    setLastAction(null);
    setConfirmRefresh(false);
    try {
      await api.syncRun(mode, entity, mode === 'full_refresh');
      setRunning(true);
      const p = await api.syncProgress();
      setProgress(p.progress);
    } catch (e) {
      setLastAction({ ok: false, msg: e?.response?.data?.error || e.message });
    }
  };

  const retry = async (entity) => {
    setLastAction(null);
    try {
      await api.syncRetry(entity);
      setRunning(true);
    } catch (e) {
      setLastAction({ ok: false, msg: e?.response?.data?.error || e.message });
    }
  };

  if (loading) return (
    <div style={S.page}>
      <div style={{ color: '#475569', marginTop: 40, textAlign: 'center' }}>Loading sync status…</div>
    </div>
  );

  const entities = status?.entities || {};
  const lastRun  = status?.last_system_run || status?.last_run;
  const runLog   = status?.run_log || [];
  const staleH   = status?.stale_hours ?? 4;

  const entList      = Object.values(entities);
  const successCount = entList.filter(e => e.status === 'success').length;
  const failCount    = entList.filter(e => e.status === 'failed').length;
  const neverCount   = entList.filter(e => e.status === 'never_synced').length;
  const totalRecords = entList.reduce((s, e) => s + (e.record_count || 0), 0);

  const byStage = {};
  for (const [key, ent] of Object.entries(entities)) (byStage[ent.stage || 4] = byStage[ent.stage || 4] || []).push([key, ent]);

  const busy = running;
  const btn = (style) => ({ ...S.btn, ...style, opacity: busy ? 0.55 : 1, cursor: busy ? 'not-allowed' : 'pointer' });

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.h1}>Sync Monitor</h1>
        <p style={S.sub}>
          Centralized data sync — scheduled at 1 PM, 3 PM, 6 PM, 9 PM IST (incremental Sync Data) · Stale threshold: {staleH}h
        </p>
      </div>

      {error && (
        <div style={{ background: '#ef44441a', border: '1px solid #ef4444', borderRadius: 8, padding: '0.75rem 1rem', color: '#b91c1c', fontSize: '0.82rem', marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {lastAction && (
        <div style={{ background: lastAction.ok ? '#16a34a1a' : '#ef44441a', border: `1px solid ${lastAction.ok ? '#22c55e' : '#ef4444'}`, borderRadius: 8, padding: '0.6rem 1rem', color: lastAction.ok ? '#15803d' : '#b91c1c', fontSize: '0.8rem', marginBottom: '1rem' }}>
          {lastAction.msg}
        </div>
      )}

      {/* KPI cards */}
      <div style={S.row}>
        <div style={S.card}>
          <div style={S.cardLabel}>Last Run</div>
          <div style={S.cardVal} title={lastRun?.started_at}>
            {lastRun ? fmtAge(lastRun.started_at) : '—'}
          </div>
          {lastRun && (
            <div style={S.cardSub}>
              Trigger: {TRIGGER_LABELS[lastRun.trigger] || lastRun.trigger} · {MODE_LABELS[lastRun.mode] || (lastRun.trigger === 'full_resync' ? 'Full Re-Sync' : 'Sync')}
              <br />{fmtTime(lastRun.started_at)} · <Badge status={lastRun.status} />
            </div>
          )}
        </div>
        <div style={S.card}>
          <div style={S.cardLabel}>Entities OK / Total</div>
          <div style={S.cardVal}>{successCount} / {entList.length}</div>
          {failCount > 0 && <div style={{ ...S.cardSub, color: '#dc2626' }}>{failCount} failed</div>}
          {neverCount > 0 && <div style={S.cardSub}>{neverCount} never synced</div>}
        </div>
        <div style={S.card}>
          <div style={S.cardLabel}>Total Cached Records</div>
          <div style={S.cardVal}>{totalRecords.toLocaleString('en-IN')}</div>
          {lastRun && <div style={S.cardSub}>Last run: {fmtMs(lastRun.duration_ms)}</div>}
        </div>
        <div style={{ ...S.card, background: '#0f172a', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
          <div style={S.btnRow}>
            <button style={btn(S.btnPrimary)} onClick={() => start('normal')} disabled={busy}
              title="Incremental: new/changed records since the last sync (unlocked periods). Status views re-fetched.">
              {busy && progress?.mode === 'normal' ? 'Syncing…' : 'Sync Data'}
            </button>
            <button style={btn(S.btnAmber)} onClick={() => start('recheck')} disabled={busy}
              title="Incremental + ID reconciliation of the last 90 days — finds records present in Zoho but missing here.">
              {busy && progress?.mode === 'recheck' ? 'Rechecking…' : 'Recheck Data'}
            </button>
          </div>
          <div style={S.btnRow}>
            <button style={btn(S.btnSecondary)} onClick={() => start('full')} disabled={busy}
              title="Full re-fetch of every entity (all periods), diffed against the cache. Replaces the old Full Re-Sync.">
              {busy && progress?.mode === 'full' ? 'Syncing…' : 'Full Sync Data'}
            </button>
            <button style={btn(S.btnDanger)} onClick={() => setConfirmRefresh(true)} disabled={busy}
              title="Full Sync + count / total / MSME validation and cache repair. Requires confirmation.">
              Full Data Refresh
            </button>
          </div>
          <button style={{ ...S.btn, ...S.btnGhost }} onClick={load}>
            Refresh Status
          </button>
        </div>
      </div>

      {confirmRefresh && (
        <div style={S.confirmBox}>
          <div style={S.confirmText}>
            Full Data Refresh re-fetches every entity from Zoho Books across all periods, validates record counts,
            key totals and MSME Sector mapping, and repairs the central cache. It takes several minutes and uses
            roughly 150–250 Zoho API calls. Frozen MSME quarters / Form-1 half-years and POCM snapshots are not modified.
          </div>
          <div style={S.btnRow}>
            <button style={{ ...S.btn, ...S.btnDanger }} onClick={() => start('full_refresh')}>Yes, run Full Data Refresh</button>
            <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setConfirmRefresh(false)}>Cancel</button>
          </div>
        </div>
      )}

      {(running || (progress && progress.completed_at && Date.now() - new Date(progress.completed_at).getTime() < 10 * 60000)) && (
        <ProgressPanel progress={progress} running={running} />
      )}

      {/* Per-entity status, grouped by dependency stage */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Entity Status</div>
        {Object.keys(byStage).sort().map(stage => (
          <div key={stage}>
            <div style={S.stageTitle}>{STAGE_LABELS[stage] || `Stage ${stage}`}</div>
            <div style={S.entityGrid}>
              {byStage[stage].map(([key, ent]) => {
                const fresh = ent.last_synced_at && ((Date.now() - new Date(ent.last_synced_at).getTime()) / 3600000) < staleH;
                const st = ent.last_stats;
                const live = running && progress?.entities?.[key]?.state === 'running';
                return (
                  <div key={key} style={{ ...S.entityCard, borderColor: ent.status === 'failed' ? '#ef444466' : '#DFE7E3' }} title={ent.description}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, gap: 8 }}>
                      <div style={S.entityName}>{ent.label || key}</div>
                      <Badge status={live ? 'running' : ent.status} />
                    </div>
                    <div style={S.entityMeta}>
                      <div>Records: <span style={S.val}>{n(ent.record_count)}</span></div>
                      {ent.last_synced_at && <div>Last synced: <span style={{ color: fresh ? '#16a34a' : '#d97706' }}>{fmtAge(ent.last_synced_at)}</span> ({fmtTime(ent.last_synced_at)})</div>}
                      {ent.duration_ms != null && <div>Duration: <span style={S.val}>{fmtMs(ent.duration_ms)}</span></div>}
                      {ent.last_sync_type && (
                        <div>Last sync type: <span style={S.val}>{MODE_LABELS[ent.last_sync_type] || ent.last_sync_type}</span>
                          {ent.last_strategy && ent.last_strategy !== ent.last_sync_type ? <span> ({ent.last_strategy})</span> : null}
                        </div>
                      )}
                      {st && (
                        <div>
                          Added <span style={S.val}>{n(st.added)}</span> · Updated <span style={S.val}>{n(st.updated)}</span>
                          {st.removed ? <> · Removed <span style={S.val}>{n(st.removed)}</span></> : null}
                          {st.failed ? <> · <span style={{ color: '#dc2626' }}>Failed {n(st.failed)}</span></> : null}
                        </div>
                      )}
                      {ent.source && <div style={{ color: '#9BA8B0' }}>Zoho: {ent.source}</div>}
                      {ent.status === 'failed' && ent.error_detail && (
                        <div style={{ marginTop: 4 }}>
                          <span style={{ color: '#dc2626' }}>{ent.error_detail}</span>{' '}
                          {ent.error && (
                            <button style={{ ...S.btn, ...S.btnGhost, ...S.btnSmall, padding: '1px 6px' }}
                              onClick={() => setOpenErr(o => ({ ...o, [key]: !o[key] }))}>
                              {openErr[key] ? 'Hide details' : 'Details'}
                            </button>
                          )}
                          {openErr[key] && <ErrorDetail err={ent.error} />}
                        </div>
                      )}
                      {ent.locked && <div style={{ color: '#d97706', marginTop: 4 }}>In progress…</div>}
                    </div>
                    <div style={{ ...S.btnRow, marginTop: 8 }}>
                      <button style={{ ...btn(S.btnGhost), ...S.btnSmall }} onClick={() => start('normal', key)} disabled={busy}
                        title={ent.dependents?.length ? `Also refreshes: ${ent.dependents.map(d => entities[d]?.label || d).join(', ')}` : 'Sync only this entity'}>
                        {live ? 'Syncing…' : 'Sync Now'}
                      </button>
                      {ent.status === 'failed' && (
                        <button style={{ ...btn(S.btnDanger), ...S.btnSmall }} onClick={() => retry(key)} disabled={busy}>
                          Retry Failed Entity
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <ValidationPanel v={status?.last_validation} entities={entities} />

      {/* Run log */}
      <div style={S.section}>
        <div style={S.sectionTitle}>Recent Sync Runs (last {runLog.length})</div>
        {runLog.length === 0 ? (
          <div style={{ color: '#475569', fontSize: '0.82rem' }}>No sync runs recorded yet.</div>
        ) : (
          <div style={{ ...S.panel, padding: 0, overflow: 'hidden' }}>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {['Run ID', 'Trigger', 'Sync Type', 'Started (IST)', 'Completed', 'Duration', 'Entities', 'Checked', 'Added', 'Updated', 'Errors', 'Status'].map(h => (
                      <th key={h} style={{ ...S.th, ...(['Entities', 'Checked', 'Added', 'Updated', 'Errors'].includes(h) ? S.num : {}) }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runLog.map(run => {
                    const legacy = !run.mode;
                    const entCount = run.entities_processed ?? Object.keys(run.entities || {}).length;
                    const errs = run.failed_count || 0;
                    const isOpen = openRun === run.run_id;
                    return (
                      <React.Fragment key={run.run_id}>
                        <tr onClick={() => setOpenRun(isOpen ? null : run.run_id)} style={{ cursor: 'pointer' }}>
                          <td style={{ ...S.td, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.72rem' }}>{run.run_id}</td>
                          <td style={S.td}>{TRIGGER_LABELS[run.trigger] || run.trigger}</td>
                          <td style={S.td}>{legacy ? (run.trigger === 'full_resync' ? 'Full Re-Sync (legacy)' : 'Sync (legacy)') : (MODE_LABELS[run.mode] || run.mode)}</td>
                          <td style={S.td}>{fmtTime(run.started_at)}</td>
                          <td style={S.td}>{fmtTime(run.completed_at)}</td>
                          <td style={S.td}>{fmtMs(run.duration_ms)}</td>
                          <td style={{ ...S.td, ...S.num }}>{n(entCount)}</td>
                          <td style={{ ...S.td, ...S.num }}>{legacy ? n(run.total_records) : n(run.records_checked)}</td>
                          <td style={{ ...S.td, ...S.num }}>{legacy ? '—' : n(run.added)}</td>
                          <td style={{ ...S.td, ...S.num }}>{legacy ? '—' : n(run.updated)}</td>
                          <td style={{ ...S.td, ...S.num, color: errs ? '#dc2626' : '#9BA8B0' }}>{errs || '—'}</td>
                          <td style={S.td}><Badge status={run.status} /></td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={12} style={{ ...S.td, background: '#F9F9F9', whiteSpace: 'normal' }}>
                              <table style={{ ...S.table, fontSize: '0.74rem' }}>
                                <thead>
                                  <tr>{['Entity', 'Status', 'Strategy', 'Records', 'Checked', 'Added', 'Updated', 'Removed', 'Duration', 'Error'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
                                </thead>
                                <tbody>
                                  {Object.entries(run.entities || {}).map(([k, r]) => (
                                    <tr key={k}>
                                      <td style={S.td}>{entities[k]?.label || k}</td>
                                      <td style={S.td}><Badge status={r.status} /></td>
                                      <td style={S.td}>{r.strategy || '—'}</td>
                                      <td style={{ ...S.td, ...S.num }}>{n(r.record_count)}</td>
                                      <td style={{ ...S.td, ...S.num }}>{n(r.checked)}</td>
                                      <td style={{ ...S.td, ...S.num }}>{n(r.added)}</td>
                                      <td style={{ ...S.td, ...S.num }}>{n(r.updated)}</td>
                                      <td style={{ ...S.td, ...S.num }}>{n(r.removed)}</td>
                                      <td style={S.td}>{fmtMs(r.duration_ms)}</td>
                                      <td style={{ ...S.td, color: '#dc2626', whiteSpace: 'normal' }}>{r.error ? `${r.error_type || ''} ${r.error}` : ''}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
