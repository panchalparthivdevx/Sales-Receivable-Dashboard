import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';

const BASE = `/api`;

const fmt = (n, dec = 2) =>
  n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtL = n => fmt(n, 2);
const fmtR = n => fmt(n, 0);

function monthLabel(ym) {
  const [yr, mo] = ym.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[parseInt(mo) - 1]} ${yr}`;
}

export default function BudgetVsActual() {
  const [tab, setTab] = useState('assumptions');
  const [config, setConfig] = useState(null);
  const [assumptions, setAssumptions] = useState({});
  const [actuals, setActuals] = useState({});
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [selectedBranch, setSelectedBranch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [entryData, setEntryData] = useState({});
  const [msg, setMsg] = useState({ text: '', type: 'ok' });

  // Bills cache — all months × all branches pre-computed
  const [billsCache, setBillsCache] = useState(null);     // full cache object { computed, syncedAt, lastBillDate }
  const [billsSyncing, setBillsSyncing] = useState(false);
  const [billsSyncProg, setBillsSyncProg] = useState(null);
  const [branchFetching, setBranchFetching] = useState(false);
  // Per-branch bills sync with P&L cross-verification
  const [branchSyncing, setBranchSyncing] = useState(false);
  const [branchSyncProg, setBranchSyncProg] = useState(null);
  const [branchSyncResult, setBranchSyncResult] = useState(null);
  const [showBranchLog, setShowBranchLog] = useState(false);
  // Recalibrate cache from account_transactions
  const [recalibrateRunning, setRecalibrateRunning] = useState(false);
  const [recalibrateLog, setRecalibrateLog] = useState([]);
  const [billDrilldown, setBillDrilldown] = useState(null); // { itemId, itemLabel, month, bills: [] }
  // Legacy per-selection actuals (used when cache miss)
  const [billsActuals, setBillsActuals] = useState({});
  const [billsLoading, setBillsLoading] = useState(false);
  const [billsMeta, setBillsMeta] = useState(null);

  // Per-branch FY25-26 actuals (for Budget column)
  const [branchFyActuals, setBranchFyActuals] = useState({});
  const [branchFyMeta, setBranchFyMeta] = useState(null);
  const [fetchingBranchFy, setFetchingBranchFy] = useState(false);
  const [fyProgress, setFyProgress] = useState(null); // live fetch progress

  // Manual per-branch FY25-26 monthly avg overrides (editable)
  const [branchFyManual, setBranchFyManual] = useState({});
  // { branchId, itemId } | null — tracks which cell is being edited
  const [editingFyCell, setEditingFyCell] = useState(null);
  const [editingFyValue, setEditingFyValue] = useState('');

  // CRM field team expense submissions
  const [crmActuals, setCrmActuals] = useState({});
  const [crmHover, setCrmHover] = useState(null); // { lines: [], x, y }

  // COA mapping
  const [mappings, setMappings] = useState({});
  const [coaList, setCoaList] = useState([]);
  const [coaLoading, setCoaLoading] = useState(false);
  const [showMapModal, setShowMapModal] = useState(false);
  const [activeMapItem, setActiveMapItem] = useState(null);
  const [coaSearch, setCoaSearch] = useState('');
  const [coaTypeFilter, setCoaTypeFilter] = useState('');
  const [savingMap, setSavingMap] = useState(false);

  const flash = (text, type = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: 'ok' }), 3000);
  };

  // Load config
  useEffect(() => {
    axios.get(`${BASE}/budget/config`).then(r => {
      setConfig(r.data);
      if (r.data.branches?.length) setSelectedBranch(r.data.branches[0].id);
    }).catch(console.error);
  }, []);

  // Load assumptions
  const loadAssumptions = useCallback(() => {
    axios.get(`${BASE}/budget/assumptions`).then(r => {
      setAssumptions(r.data.assumptions || {});
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadAssumptions(); }, [loadAssumptions]);

  // Load actuals for selected month
  const loadActuals = useCallback(() => {
    if (!selectedMonth) return;
    axios.get(`${BASE}/budget/actuals/${selectedMonth}`).then(r => {
      setActuals(r.data || {});
    }).catch(() => setActuals({}));
  }, [selectedMonth]);

  useEffect(() => { loadActuals(); }, [loadActuals]);

  // Load per-branch FY25-26 actuals (for Budget column)
  useEffect(() => {
    axios.get(`${BASE}/budget/branch-fy-actuals`).then(r => {
      if (r.data?.branchActuals) {
        setBranchFyActuals(r.data.branchActuals);
        setBranchFyMeta({ fetchedAt: r.data.fetchedAt, from: r.data.from, to: r.data.to });
      }
    }).catch(() => {});
  }, []);

  // Load manual FY25-26 overrides
  useEffect(() => {
    axios.get(`${BASE}/budget/fy-manual`).then(r => {
      setBranchFyManual(r.data || {});
    }).catch(() => {});
  }, []);

  // Load CRM actuals
  useEffect(() => {
    axios.get(`${BASE}/crm/actuals`).then(r => {
      setCrmActuals(r.data || {});
    }).catch(() => {});
  }, []);

  const saveFyManual = async (branchId, itemId, value) => {
    const numVal = value === '' ? null : parseFloat(String(value).replace(/,/g, ''));
    await axios.put(`${BASE}/budget/fy-manual`, { branchId, itemId, value: numVal });
    setBranchFyManual(prev => ({
      ...prev,
      [branchId]: { ...(prev[branchId] || {}), [itemId]: numVal },
    }));
  };

  // Load full bills cache on mount (all months × branches, instant display)
  useEffect(() => {
    axios.get(`${BASE}/budget/bills-cache`).then(r => {
      if (r.data?.computed && Object.keys(r.data.computed).length > 0) {
        setBillsCache(r.data);
      }
    }).catch(() => {});
  }, []);

  // When month/branch changes, populate billsActuals: branch cache takes priority over all-branches cache
  useEffect(() => {
    if (!selectedMonth || !selectedBranch) return;
    // Priority 1: branch-specific synced cache (most accurate, branch-filtered)
    if (branchSyncResult && branchSyncResult.branchId === selectedBranch) {
      const totals = branchSyncResult.monthlyTotals?.[selectedMonth];
      if (totals) {
        setBillsActuals(totals);
        setBillsMeta({ source: 'branch_bills_cache', syncedAt: branchSyncResult.syncedAt });
        return;
      }
    }
    // Priority 2: all-branches cache
    if (billsCache?.computed) {
      const cached = billsCache.computed[selectedMonth]?.[selectedBranch];
      if (cached) {
        setBillsActuals(cached);
        setBillsMeta({ source: 'bills_cache', syncedAt: billsCache.syncedAt });
        return;
      }
    }
    setBillsActuals({});
  }, [branchSyncResult, billsCache, selectedMonth, selectedBranch]);

  // Auto-detect if a fetch is already running on the server (e.g. started before page load)
  useEffect(() => {
    let pollInterval = null;
    const startPolling = () => {
      pollInterval = setInterval(async () => {
        try {
          const p = await axios.get(`${BASE}/budget/fetch-progress`);
          const prog = p.data;
          setFyProgress(prog);
          if (prog.status === 'done' || prog.status === 'error') {
            clearInterval(pollInterval);
            setFetchingBranchFy(false);
            if (prog.status === 'done') {
              flash(`FY25-26 data ready! ${prog.totalBills} bills · ${prog.branchesProcessed} branches`);
              const r2 = await axios.get(`${BASE}/budget/branch-fy-actuals`);
              if (r2.data?.branchActuals) {
                setBranchFyActuals(r2.data.branchActuals);
                setBranchFyMeta({ fetchedAt: r2.data.fetchedAt, from: r2.data.from, to: r2.data.to });
              }
            }
          }
        } catch (_) {}
      }, 5000);
    };
    axios.get(`${BASE}/budget/fetch-progress`).then(r => {
      if (r.data?.status === 'running') {
        setFetchingBranchFy(true);
        setFyProgress(r.data);
        startPolling();
      }
    }).catch(() => {});
    return () => { if (pollInterval) clearInterval(pollInterval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-fill entry form from stored actuals
  useEffect(() => {
    setEntryData(selectedBranch && actuals[selectedBranch] ? { ...actuals[selectedBranch] } : {});
  }, [selectedBranch, actuals]);

  // Load COA mappings on mount
  useEffect(() => {
    axios.get(`${BASE}/budget/mappings`).then(r => setMappings(r.data || {})).catch(() => {});
  }, []);

  const openMapModal = async () => {
    setShowMapModal(true);
    if (coaList.length === 0) {
      setCoaLoading(true);
      try {
        const r = await axios.get(`${BASE}/budget/coa`);
        setCoaList(r.data || []);
      } catch (e) {
        flash('Failed to load Chart of Accounts: ' + e.message, 'err');
      } finally {
        setCoaLoading(false);
      }
    }
  };

  const handleToggleAccount = (accountId) => {
    if (!activeMapItem) return;
    setMappings(prev => {
      const cur = prev[activeMapItem] || [];
      const next = cur.includes(accountId) ? cur.filter(id => id !== accountId) : [...cur, accountId];
      return { ...prev, [activeMapItem]: next };
    });
  };

  const handleRemoveAccount = (itemId, accountId) => {
    setMappings(prev => ({
      ...prev,
      [itemId]: (prev[itemId] || []).filter(id => id !== accountId),
    }));
  };

  const handleSaveMappings = async () => {
    setSavingMap(true);
    try {
      await axios.put(`${BASE}/budget/mappings`, mappings);
      flash('Account mappings saved!');
    } catch (e) {
      flash('Error saving mappings: ' + e.message, 'err');
    } finally {
      setSavingMap(false);
    }
  };

  // ── Sync all bills to local cache (full or incremental) ──────────────────────
  const handleSyncAllBills = async () => {
    if (billsSyncing) return;
    setBillsSyncing(true);
    setBillsSyncProg({ status: 'running', pct: 0, phase: 'pl_fetch', totalTasks: 0, doneTasks: 0 });
    const isIncremental = !!(billsCache?.syncedAt);
    flash(isIncremental ? 'Incremental P&L sync starting…' : 'Full P&L sync started — fetching actuals for all branches × all months from Zoho P&L…', 'info');
    try {
      const r = await axios.post(`${BASE}/budget/sync-bills-cache`, {}, { timeout: 30000 });
      if (!r.data?.ok) {
        const ra = r.data?.retry_after_seconds;
        const waitMin = ra ? Math.ceil(ra / 60) : null;
        flash(waitMin
          ? `Zoho is rate-limited. Please try again in ~${waitMin} minutes.`
          : (r.data?.message || 'Sync failed to start'), 'err');
        setBillsSyncing(false);
        setBillsSyncProg(null);
        return;
      }
    } catch (e) {
      flash('Sync failed to start: ' + (e.response?.data?.message || e.message), 'err');
      setBillsSyncing(false);
      setBillsSyncProg(null);
      return;
    }
    // Poll progress every 4 seconds
    const pollInterval = setInterval(async () => {
      try {
        const p = await axios.get(`${BASE}/budget/bills-sync-progress`);
        const prog = p.data;
        setBillsSyncProg(prog);
        if (prog.status === 'done' || prog.status === 'error') {
          clearInterval(pollInterval);
          setBillsSyncing(false);
          if (prog.status === 'done') {
            flash(`P&L actuals cache ready! ${prog.monthsSeen?.length || '?'} months across ${prog.totalTasks ? Math.round(prog.totalTasks / (prog.monthsSeen?.length || 1)) : '?'} branches`);
            const r2 = await axios.get(`${BASE}/budget/bills-cache`);
            if (r2.data?.computed) {
              setBillsCache(r2.data);
            }
          } else {
            const errMsg = prog.error || 'unknown';
            const isRateLimit = errMsg.includes('429') || errMsg.includes('rate');
            flash(isRateLimit
              ? 'Zoho rate-limited during sync. Data saved so far is preserved. Try again in ~60 minutes.'
              : 'Sync error: ' + errMsg, 'err');
          }
        }
      } catch (_) {}
    }, 4000);
  };

  // ── Quick fetch: all months for the currently selected branch only (~5 calls, ~10s) ──
  const handleQuickFetchBranch = async () => {
    if (!selectedBranch || branchFetching || billsSyncing) return;
    setBranchFetching(true);
    const branchName = branches.find(b => b.id === selectedBranch)?.name || selectedBranch;
    flash(`Fetching all FY months for ${branchName}… (~10 seconds)`, 'info');
    try {
      const r = await axios.post(`${BASE}/budget/quick-fetch-branch`, { branchId: selectedBranch }, { timeout: 120000 });
      if (r.data?.ok) {
        flash(`✓ ${branchName} cached for ${r.data.fetchedMonths?.length || '?'} months — data now instant`);
        const r2 = await axios.get(`${BASE}/budget/bills-cache`);
        if (r2.data?.computed) setBillsCache(r2.data);
      } else {
        const ra = r.data?.retry_after_seconds;
        flash(ra
          ? `Zoho is rate-limited. Please try again in ~${Math.ceil(ra / 60)} minutes.`
          : ('Quick fetch failed: ' + (r.data?.message || 'unknown error')), 'err');
      }
    } catch (e) {
      const ra = e.response?.data?.retry_after_seconds;
      flash(ra
        ? `Zoho is rate-limited. Please try again in ~${Math.ceil(ra / 60)} minutes.`
        : ('Quick fetch error: ' + (e.response?.data?.message || e.message)), 'err');
    }
    setBranchFetching(false);
  };

  // ── Sync bills for a single branch + P&L cross-verification ─────────────────
  const handleSyncBranchBills = async () => {
    if (branchSyncing || billsSyncing) return;
    const targetId = selectedBranch || 'amd_the_first_c_2nd';
    const targetName = branches.find(b => b.id === targetId)?.name || targetId;
    setBranchSyncing(true);
    setBranchSyncProg({ status: 'running', pct: 0, phase: 'bill_list', branchName: targetName, log: [] });
    setBranchSyncResult(null);
    flash(`Starting branch bills sync for ${targetName}…`, 'info');
    try {
      const nowYm = new Date().toISOString().slice(0, 7);
      const r = await axios.post(`${BASE}/budget/sync-branch-bills`, {
        branchId: targetId, fromMonth: '2026-04', toMonth: nowYm,
      }, { timeout: 30000 });
      if (!r.data?.ok) {
        setBranchSyncing(false);
        flash(r.data?.message || 'Branch sync failed to start', 'err');
        return;
      }
      const poll = setInterval(async () => {
        try {
          const p = await axios.get(`${BASE}/budget/branch-bills-progress`);
          setBranchSyncProg(p.data);
          if (p.data.status === 'done' || p.data.status === 'error') {
            clearInterval(poll);
            setBranchSyncing(false);
            if (p.data.status === 'done') {
              flash(`✓ ${targetName}: ${p.data.summary?.totalBillsFetched || 0} bills synced & verified`);
              const r2 = await axios.get(`${BASE}/budget/branch-bills-data?branchId=${targetId}`);
              if (r2.data?.ok) setBranchSyncResult(r2.data);
            } else {
              flash('Branch sync error: ' + (p.data.error || 'unknown'), 'err');
            }
          }
        } catch (_) {}
      }, 3000);
    } catch (e) {
      setBranchSyncing(false);
      flash('Branch sync failed: ' + e.message, 'err');
    }
  };

  // ── Recalibrate all branch caches from account_transactions (exact Zoho P&L match) ──
  const handleRecalibrateCache = async () => {
    if (recalibrateRunning || branchSyncing || billsSyncing) return;
    setRecalibrateRunning(true);
    setRecalibrateLog([]);
    flash('Starting recalibration from Zoho account_transactions…', 'info');
    try {
      const resp = await fetch(`${BASE}/budget/recalibrate-cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('da_token')}` },
        body: JSON.stringify({}),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (value) {
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              setRecalibrateLog(prev => [...prev.slice(-49), obj.msg]);
              if (obj.done) {
                flash('Recalibration complete — all branch caches now match Zoho P&L', 'ok');
                window.location.reload();
              }
            } catch (_) {}
          }
        }
      }
    } catch (e) {
      flash('Recalibrate error: ' + e.message, 'err');
    }
    setRecalibrateRunning(false);
  };

  // Auto-detect if bills sync is already running on server
  useEffect(() => {
    let interval = null;
    axios.get(`${BASE}/budget/bills-sync-progress`).then(r => {
      if (r.data?.status === 'running') {
        setBillsSyncing(true);
        setBillsSyncProg(r.data);
        interval = setInterval(async () => {
          try {
            const p = await axios.get(`${BASE}/budget/bills-sync-progress`);
            setBillsSyncProg(p.data);
            if (p.data.status === 'done' || p.data.status === 'error') {
              clearInterval(interval);
              setBillsSyncing(false);
              if (p.data.status === 'done') {
                const r2 = await axios.get(`${BASE}/budget/bills-cache`);
                if (r2.data?.computed) setBillsCache(r2.data);
              }
            }
          } catch (_) {}
        }, 4000);
      }
    }).catch(() => {});
    return () => { if (interval) clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-detect if branch sync is already running; also load any cached result on mount
  useEffect(() => {
    let interval = null;
    axios.get(`${BASE}/budget/branch-bills-progress`).then(r => {
      if (r.data?.status === 'running') {
        setBranchSyncing(true);
        setBranchSyncProg(r.data);
        interval = setInterval(async () => {
          try {
            const p = await axios.get(`${BASE}/budget/branch-bills-progress`);
            setBranchSyncProg(p.data);
            if (p.data.status === 'done' || p.data.status === 'error') {
              clearInterval(interval);
              setBranchSyncing(false);
              if (p.data.status === 'done' && p.data.branchId) {
                const r2 = await axios.get(`${BASE}/budget/branch-bills-data?branchId=${p.data.branchId}`);
                if (r2.data?.ok) setBranchSyncResult(r2.data);
              }
            }
          } catch (_) {}
        }, 3000);
      }
    }).catch(() => {});
    return () => { if (interval) clearInterval(interval); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-load branch bills cache whenever selectedBranch changes
  useEffect(() => {
    if (!selectedBranch) return;
    axios.get(`${BASE}/budget/branch-bills-data?branchId=${selectedBranch}`).then(r => {
      if (r.data?.ok) setBranchSyncResult(r.data);
      else setBranchSyncResult(null);
    }).catch(() => setBranchSyncResult(null));
  }, [selectedBranch]);

  const items         = config?.items    || [];
  const branches      = config?.branches || [];
  const totalSqft     = config?.totalSqft || 1;
  const directItems   = items.filter(it => it.section === 'direct');
  const indirectItems = items.filter(it => it.section === 'indirect');
  const CRM_AMOUNT_IDS = new Set(['elec_util','hk_materials','hk_service','internet','pantry','repairs','security','tea_coffee','subscr','travel']);

  const getCrmTooltipLines = (itemId, crmRow) => {
    const n = (v, suffix = '') => v != null ? `${v}${suffix}` : '—';
    const r = (v) => v != null ? `₹${Number(v).toLocaleString('en-IN')}` : '—';
    if (itemId === 'elec_util') return [
      `Units Consumed: ${n(crmRow.elec_units, ' kWh')}`,
      `Rate per Unit: ${r(crmRow.elec_rate)}`,
    ].filter(l => !l.endsWith('—'));
    if (itemId === 'hk_service') return [
      `HK Persons: ${n(crmRow.hk_persons)}`,
      `Supervisors: ${n(crmRow.hk_supervisors)}`,
    ].filter(l => !l.endsWith('—'));
    if (itemId === 'internet') return [
      `Speed: ${n(crmRow.internet_mbps, ' Mbps')}`,
    ].filter(l => !l.endsWith('—'));
    if (itemId === 'security') return [
      `Security Persons: ${n(crmRow.security_persons)}`,
    ].filter(l => !l.endsWith('—'));
    if (itemId === 'tea_coffee') {
      const lines = [];
      if (crmRow.tea_cups != null || crmRow.tea_cup_rate != null)
        lines.push(`Cups: ${n(crmRow.tea_cups)} × ${r(crmRow.tea_cup_rate)}`);
      if (crmRow.tea_bag_packets != null || crmRow.tea_bag_rate != null)
        lines.push(`Tea Bags: ${n(crmRow.tea_bag_packets)} pkts × ${r(crmRow.tea_bag_rate)}`);
      if (crmRow.coffee_packets != null || crmRow.coffee_rate != null)
        lines.push(`Coffee Beans: ${n(crmRow.coffee_packets)} pkts × ${r(crmRow.coffee_rate)}`);
      if (crmRow.stirrer_packets != null || crmRow.stirrer_rate != null)
        lines.push(`Stirrer: ${n(crmRow.stirrer_packets)} pkts × ${r(crmRow.stirrer_rate)}`);
      return lines;
    }
    return [];
  };

  const handleFetchBranchFy = async () => {
    if (fetchingBranchFy) return; // already polling
    setFetchingBranchFy(true);
    setFyProgress({ status: 'running', pct: 0, phase: 'starting', currentBranch: null, branchesProcessed: 0, totalBranches: 0 });
    flash('Fetching FY25-26 branch-wise data from Zoho… this may take 10-20 minutes.', 'info');
    try {
      await axios.post(`${BASE}/budget/fetch-branch-fy2526`, {}, { timeout: 30000 });
    } catch (e) {
      if (!e.response?.data?.ok) {
        flash('Branch FY fetch failed to start: ' + (e.response?.data?.error || e.message), 'err');
        setFetchingBranchFy(false);
        setFyProgress(null);
        return;
      }
    }
  };

  // Monthly budget for a branch (₹):
  // If branch FY25-26 data is available, use branch-specific annual total / 12 × (1 + growth%).
  // Fallback: org-wide lastYrAnnual prorated by sqft (less accurate).
  const monthlyBranchBudget = useCallback((itemId, branchId) => {
    const a = assumptions[itemId] || {};
    const growthFactor = 1 + (a.growthPct || 0) / 100;
    const branchFy = branchFyActuals[branchId];
    if (branchFy && branchFy[itemId] != null) {
      return (branchFy[itemId] / 12) * growthFactor;
    }
    // Fallback: org-wide sqft proration
    if (!a.lastYrAnnual) return 0;
    const branch = branches.find(b => b.id === branchId);
    if (!branch) return 0;
    return (a.lastYrAnnual * 100000 * growthFactor) / (12 * totalSqft) * branch.sqft;
  }, [assumptions, branchFyActuals, branches, totalSqft]);

  // Month list: FY26-27 + FY25-26
  const monthOptions = useMemo(() => {
    const out = [];
    // FY26-27: Apr 2026 - Mar 2027
    for (let m = 4; m <= 12; m++) out.push(`2026-${String(m).padStart(2, '0')}`);
    for (let m = 1; m <= 3; m++) out.push(`2027-${String(m).padStart(2, '0')}`);
    // FY25-26: Apr 2025 - Mar 2026
    for (let m = 4; m <= 12; m++) out.push(`2025-${String(m).padStart(2, '0')}`);
    for (let m = 1; m <= 3; m++) out.push(`2026-${String(m).padStart(2, '0')}`);
    return [...new Set(out)];
  }, []);

  const handleAssumptionChange = (itemId, field, value) => {
    setAssumptions(prev => ({
      ...prev,
      [itemId]: { ...(prev[itemId] || {}), [field]: parseFloat(value) || 0 },
    }));
  };

  const handleSaveAssumptions = async () => {
    setSaving(true);
    try {
      await axios.put(`${BASE}/budget/assumptions`, { assumptions });
      flash('Assumptions saved!');
    } catch (e) {
      flash('Error saving: ' + e.message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const handleFetchLastYr = async () => {
    setFetching(true);
    flash('Fetching FY25-26 data from Zoho… this may take several minutes.', 'info');
    try {
      const r = await axios.post(`${BASE}/budget/fetch-fy2526`, {}, { timeout: 600000 });
      const computed = r.data.computed || {};
      setAssumptions(prev => {
        const updated = { ...prev };
        for (const [itemId, val] of Object.entries(computed)) {
          updated[itemId] = { ...(updated[itemId] || { growthPct: 0 }), lastYrAnnual: val };
        }
        return updated;
      });
      flash('FY25-26 actuals loaded! Please set Growth % and save.');
    } catch (e) {
      flash('Fetch failed: ' + (e.response?.data?.error || e.message), 'err');
    } finally {
      setFetching(false);
    }
  };

  const fetchBillsActuals = async () => {
    if (!selectedBranch || !selectedMonth) return;
    setBillsLoading(true);
    setBillsMeta(null);
    flash(`Fetching bill actuals for ${monthLabel(selectedMonth)}… this may take a moment.`, 'info');
    try {
      const r = await axios.get(`${BASE}/budget/bills-actuals`, {
        params: { ym: selectedMonth, branchId: selectedBranch },
        timeout: 300000,
      });
      setBillsActuals(r.data.computed || {});
      setBillsMeta({
        source: r.data.source,
        branchName: r.data.branchName,
        from: r.data.from, to: r.data.to,
        billsMatched: r.data.billsMatched,
        billsTotal: r.data.billsTotal
      });
      flash(`Actuals fetched from Zoho Bills for "${r.data.branchName}": ${r.data.billsMatched}/${r.data.billsTotal} bills matched (${r.data.from} → ${r.data.to}).`);
    } catch (e) {
      flash('Bills fetch failed: ' + (e.response?.data?.error || e.message), 'err');
    } finally {
      setBillsLoading(false);
    }
  };

  const handleEntryChange = (itemId, field, value) => {
    setEntryData(prev => ({
      ...prev,
      [itemId]: { ...(prev[itemId] || {}), [field]: parseFloat(value) || 0 },
    }));
  };

  const handleSaveEntry = async () => {
    setSaving(true);
    try {
      const updated = { ...actuals, [selectedBranch]: entryData };
      await axios.put(`${BASE}/budget/actuals/${selectedMonth}`, updated);
      flash('Actuals saved!');
      loadActuals();
    } catch (e) {
      flash('Error: ' + e.message, 'err');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={S.page}>
        <div style={{ color: '#5D6C7B', padding: '4rem', textAlign: 'center' }}>Loading…</div>
      </div>
    );
  }

  const msgStyle = msg.type === 'err' ? S.msgErr : msg.type === 'info' ? S.msgInfo : S.msgOk;

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <div style={S.h1}>Budget vs. Actual</div>
          <div style={S.sub}>Branch-wise P&amp;L Tracking &nbsp;·&nbsp; FY 2026-27</div>
        </div>
        {msg.text && <div style={msgStyle}>{msg.text}</div>}
      </div>

      {/* Tabs */}
      <div style={S.tabBar}>
        {[
          { id: 'assumptions', label: 'Section A — Budget Assumptions' },
          { id: 'tracking',    label: 'Section B — Monthly P&L Tracking' },
          { id: 'entry',       label: 'Data Entry (CRM)' },
        ].map(t => (
          <button
            key={t.id}
            style={{ ...S.tab, ...(tab === t.id ? S.tabActive : {}) }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Section A: Budget Assumptions ── */}
      {tab === 'assumptions' && (
        <div style={S.section}>
          <div style={S.sectionHdr}>
            <div style={{ color: '#5D6C7B', fontSize: '0.81rem' }}>
              Base Year: FY 2025-26&nbsp;&nbsp;|&nbsp;&nbsp;
              Total Super Built-Up Area: <strong style={{ color: '#9BA8B0' }}>{totalSqft.toLocaleString('en-IN', { maximumFractionDigits: 0 })} sq.ft.</strong>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.btnMap} onClick={openMapModal}>
                Map COA Accounts
              </button>
              <button style={S.btnSecondary} onClick={handleFetchLastYr} disabled={fetching}>
                {fetching ? 'Fetching from Zoho…' : 'Load FY25-26 from Zoho'}
              </button>
              <button style={S.btnPrimary} onClick={handleSaveAssumptions} disabled={saving}>
                {saving ? 'Saving…' : 'Save Assumptions'}
              </button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Line Item &amp; Accounts</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Last Yr Annual (₹ Lakhs)</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Monthly Avg (₹ Lakhs)</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Per SqFt (₹/month)</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Growth %</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Budget/SqFt (₹/month)</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Annual Budget (₹ Lakhs)</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: 'Direct Expenses',   group: directItems },
                  { label: 'Indirect Expenses', group: indirectItems },
                ].map(({ label, group }) => (
                  <React.Fragment key={label}>
                    <tr>
                      <td colSpan={7} style={{ padding: '0.45rem 0.75rem', background: '#EAF4EF', color: '#1C4942', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.07em', borderBottom: '1px solid #DFE7E3' }}>
                        {label}
                      </td>
                    </tr>
                    {group.map((item, i) => {
                      const a = assumptions[item.id] || { lastYrAnnual: 0, growthPct: 0 };
                      const lyAnn     = a.lastYrAnnual || 0;
                      const lyMon     = lyAnn / 12;
                      const lyPerSqFt = lyAnn * 100000 / 12 / totalSqft;
                      const growth    = (a.growthPct || 0) / 100;
                      const bPerSqFt  = lyPerSqFt * (1 + growth);
                      const annBudget = lyAnn * (1 + growth);
                      const mappedIds = mappings[item.id] || [];
                      return (
                        <tr key={item.id} style={{ background: i % 2 === 0 ? '#F9F9F9' : 'transparent' }}>
                          <td style={S.td}>
                            <div style={{ fontWeight: 500, color: '#9BA8B0' }}>{item.label}</div>
                            {mappedIds.length > 0
                              ? <div style={{ marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                                  {mappedIds.map(aid => {
                                    const acc = coaList.find(a => a.account_id === aid);
                                    return acc ? <span key={aid} style={S.mapChip}>{acc.account_name}</span> : null;
                                  })}
                                </div>
                              : <div style={S.mapBadgeEmpty}>no accounts mapped — click "Map COA Accounts"</div>
                            }
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', padding: '4px 6px' }}>
                            <input type="number" value={lyAnn || ''} placeholder="0"
                              onChange={e => handleAssumptionChange(item.id, 'lastYrAnnual', e.target.value)}
                              style={S.numInput} step="0.01" />
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#5D6C7B' }}>{fmtL(lyMon)}</td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#5D6C7B' }}>{fmt(lyPerSqFt, 3)}</td>
                          <td style={{ ...S.td, textAlign: 'right', padding: '4px 6px' }}>
                            <input type="number" value={a.growthPct || ''} placeholder="0"
                              onChange={e => handleAssumptionChange(item.id, 'growthPct', e.target.value)}
                              style={{ ...S.numInput, width: 70 }} step="0.5" />
                          </td>
                          <td style={{ ...S.td, textAlign: 'right' }}>{fmt(bPerSqFt, 3)}</td>
                          <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#1C4942' }}>{fmtL(annBudget)}</td>
                        </tr>
                      );
                    })}
                    <tr style={{ background: '#EAF4EF' }}>
                      <td style={{ ...S.td, fontWeight: 600, color: '#1C4942' }}>Total {label}</td>
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#1C4942' }}>
                        {fmtL(group.reduce((s, it) => s + (assumptions[it.id]?.lastYrAnnual || 0), 0))}
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', color: '#5D6C7B' }}>
                        {fmtL(group.reduce((s, it) => s + (assumptions[it.id]?.lastYrAnnual || 0) / 12, 0))}
                      </td>
                      <td style={S.td} /><td style={S.td} /><td style={S.td} />
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#1C4942' }}>
                        {fmtL(group.reduce((s, it) => {
                          const a = assumptions[it.id] || {};
                          return s + (a.lastYrAnnual || 0) * (1 + (a.growthPct || 0) / 100);
                        }, 0))}
                      </td>
                    </tr>
                  </React.Fragment>
                ))}
                {/* Grand Total */}
                <tr style={{ background: '#FFFFFF' }}>
                  <td style={{ ...S.td, fontWeight: 700, color: '#18191B' }}>Total</td>
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#18191B' }}>
                    {fmtL(items.reduce((s, it) => s + (assumptions[it.id]?.lastYrAnnual || 0), 0))}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#9BA8B0' }}>
                    {fmtL(items.reduce((s, it) => s + (assumptions[it.id]?.lastYrAnnual || 0) / 12, 0))}
                  </td>
                  <td style={S.td} /><td style={S.td} /><td style={S.td} />
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#1C4942' }}>
                    {fmtL(items.reduce((s, it) => {
                      const a = assumptions[it.id] || {};
                      return s + (a.lastYrAnnual || 0) * (1 + (a.growthPct || 0) / 100);
                    }, 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: '1.5rem', padding: '0.75rem 1rem', background: '#F9F9F9', borderRadius: 6, border: '1px solid #DFE7E3', color: '#5D6C7B', fontSize: '0.78rem' }}>
            <strong style={{ color: '#5D6C7B' }}>How it works:</strong>&nbsp;
            Last Yr Annual ÷ 12 = Monthly Avg &nbsp;·&nbsp;
            Monthly Avg ÷ Total SqFt = Per SqFt &nbsp;·&nbsp;
            Per SqFt × (1 + Growth%) = Budget/SqFt &nbsp;·&nbsp;
            Budget/SqFt × Branch SqFt = Branch Monthly Budget
          </div>
        </div>
      )}

      {/* ── COA Mapping Modal ── */}
      {showMapModal && (() => {
        const allTypes = [...new Set(coaList.map(a => a.account_type))].sort();
        const filtered = coaList.filter(a => {
          const matchSearch = !coaSearch || a.account_name.toLowerCase().includes(coaSearch.toLowerCase()) || a.account_code.toLowerCase().includes(coaSearch.toLowerCase());
          const matchType   = !coaTypeFilter || a.account_type === coaTypeFilter;
          return matchSearch && matchType;
        });
        const activeItem = items.find(it => it.id === activeMapItem);
        const activeMapped = mappings[activeMapItem] || [];
        return (
          <div style={S.modalOverlay} onClick={() => setShowMapModal(false)}>
            <div style={S.modalBox} onClick={e => e.stopPropagation()}>
              {/* Modal Header */}
              <div style={S.modalHdr}>
                <div>
                  <div style={{ color: '#18191B', fontWeight: 700, fontSize: '1rem' }}>Map Chart of Accounts</div>
                  <div style={{ color: '#5D6C7B', fontSize: '0.75rem', marginTop: 3 }}>
                    Select a line item on the left → click accounts on the right to map them
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={handleSaveMappings} disabled={savingMap} style={S.btnPrimary}>
                    {savingMap ? 'Saving…' : 'Save Mappings'}
                  </button>
                  <button onClick={() => setShowMapModal(false)} style={S.modalClose}>✕ Close</button>
                </div>
              </div>

              <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* Left: Budget line items */}
                <div style={S.modalLeft}>
                  <div style={{ padding: '0.6rem 1rem', color: '#5D6C7B', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #DFE7E3' }}>
                    Budget Line Items
                  </div>
                  {items.map(it => {
                    const cnt = (mappings[it.id] || []).length;
                    const isActive = activeMapItem === it.id;
                    return (
                      <div
                        key={it.id}
                        onClick={() => setActiveMapItem(it.id)}
                        style={{
                          padding: '0.7rem 1rem', cursor: 'pointer', borderBottom: '1px solid #DFE7E3',
                          background: isActive ? '#EAF4EF' : 'transparent',
                          borderLeft: isActive ? '3px solid #1C4942' : '3px solid transparent',
                        }}
                      >
                        <div style={{ color: isActive ? '#1C4942' : '#9BA8B0', fontWeight: isActive ? 600 : 400, fontSize: '0.82rem' }}>
                          {it.label}
                        </div>
                        {(mappings[it.id] || []).length > 0 ? (
                          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                            {(mappings[it.id] || []).map(aid => {
                              const acc = coaList.find(a => a.account_id === aid);
                              return acc ? (
                                <span key={aid} style={{ ...S.mapChip, fontSize: '0.65rem', display: 'flex', alignItems: 'center', gap: 3 }}>
                                  {acc.account_name}
                                  <span
                                    onClick={e => { e.stopPropagation(); handleRemoveAccount(it.id, aid); }}
                                    style={{ cursor: 'pointer', color: '#DC2626', marginLeft: 1, fontWeight: 700 }}
                                  >×</span>
                                </span>
                              ) : null;
                            })}
                          </div>
                        ) : (
                          <div style={{ marginTop: 2, color: '#9BA8B0', fontSize: '0.68rem' }}>No accounts mapped</div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Right: COA account list */}
                <div style={S.modalRight}>
                  <div style={{ padding: '0.65rem 1rem', borderBottom: '1px solid #DFE7E3', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    <input
                      placeholder="Search accounts…"
                      value={coaSearch}
                      onChange={e => setCoaSearch(e.target.value)}
                      style={{ ...S.numInput, width: '100%', textAlign: 'left', fontSize: '0.8rem', padding: '4px 10px' }}
                      autoFocus
                    />
                    <select value={coaTypeFilter} onChange={e => setCoaTypeFilter(e.target.value)} style={{ ...S.select, flexShrink: 0, fontSize: '0.75rem' }}>
                      <option value="">All Types</option>
                      {allTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  {!activeMapItem && (
                    <div style={{ padding: '2rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.82rem' }}>
                      ← Select a line item first
                    </div>
                  )}
                  {activeMapItem && coaLoading && (
                    <div style={{ padding: '2rem', textAlign: 'center', color: '#5D6C7B', fontSize: '0.82rem' }}>Loading Chart of Accounts…</div>
                  )}
                  {activeMapItem && !coaLoading && (
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                      {filtered.length === 0 && (
                        <div style={{ padding: '1.5rem', textAlign: 'center', color: '#9BA8B0', fontSize: '0.8rem' }}>No accounts match</div>
                      )}
                      {filtered.map(acc => {
                        const isMapped = activeMapped.includes(acc.account_id);
                        return (
                          <div
                            key={acc.account_id}
                            onClick={() => handleToggleAccount(acc.account_id)}
                            style={{
                              padding: '0.5rem 1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                              background: isMapped ? '#EAF4EF' : 'transparent',
                              borderBottom: '1px solid #DFE7E3',
                            }}
                          >
                            <span style={{
                              width: 16, height: 16, borderRadius: 3, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: isMapped ? '#1C4942' : 'transparent',
                              border: `1px solid ${isMapped ? '#1C4942' : '#DFE7E3'}`,
                              fontSize: 11, color: '#fff',
                            }}>{isMapped ? '✓' : ''}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ color: isMapped ? '#1C4942' : '#9BA8B0', fontSize: '0.8rem', fontWeight: isMapped ? 600 : 400 }}>
                                {acc.account_name}
                              </div>
                              <div style={{ color: '#9BA8B0', fontSize: '0.68rem' }}>{acc.account_type}{acc.account_code ? ` · ${acc.account_code}` : ''}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Section B: Monthly P&L Tracking ── */}
      {tab === 'tracking' && (
        <div style={S.section}>
          <div style={S.sectionHdr}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={S.label}>Month:</label>
              <select style={S.select} value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}>
                {monthOptions.map(ym => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
              </select>
              <label style={S.label}>Branch:</label>
              <select style={S.select} value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)}>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {selectedBranch && (() => {
                const br = branches.find(b => b.id === selectedBranch);
                return br ? <span style={{ color: '#5D6C7B', fontSize: '0.8rem' }}>SqFt: {br.sqft.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span> : null;
              })()}
              <button style={{ ...S.btnSecondary, background: fetchingBranchFy ? '#EAF4EF' : '#EAF4EF' }} onClick={handleFetchBranchFy} disabled={fetchingBranchFy}>
                {fetchingBranchFy ? 'Fetching Budget Base…' : 'Fetch Budget (FY25-26)'}
              </button>
              {fetchingBranchFy && fyProgress && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 260 }}>
                  {/* Progress bar */}
                  <div style={{ background: '#F2F2F2', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${fyProgress.pct || 0}%`, background: 'linear-gradient(90deg,#1C4942,#2D6E67)', transition: 'width 0.5s ease', borderRadius: 4 }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#5D6C7B' }}>
                    <span>
                      {fyProgress.phase === 'bill_list' ? `Loading bill list…` :
                       fyProgress.currentBranch ? `${fyProgress.currentBranch} (${fyProgress.currentBranchBillsDone || 0}/${fyProgress.currentBranchBills || 0} bills)` :
                       'Starting…'}
                    </span>
                    <span style={{ color: '#1C4942', fontWeight: 600 }}>
                      {fyProgress.branchesProcessed || 0}/{fyProgress.totalBranches || '?'} branches · {fyProgress.pct || 0}%
                    </span>
                  </div>
                  {fyProgress.branchLog && fyProgress.branchLog.length > 0 && (
                    <span style={{ fontSize: '0.7rem', color: '#4ade80' }}>
                      ✓ {fyProgress.branchLog[fyProgress.branchLog.length - 1].branch} done
                    </span>
                  )}
                </div>
              )}
              {!fetchingBranchFy && branchFyMeta && (
                <span style={{ color: '#86efac', fontSize: '0.74rem' }}>
                  ✓ Budget base: FY25-26 · {new Date(branchFyMeta.fetchedAt).toLocaleDateString('en-IN')}
                </span>
              )}
              {selectedBranch && (
                <button
                  style={{ ...S.btnSecondary, background: branchFetching ? '#EAF4EF' : '#FFF8E6', color: '#B45309', border: '1px solid #B45309' }}
                  onClick={handleQuickFetchBranch}
                  disabled={branchFetching || billsSyncing}
                  title={`Fetch all FY months for this branch only (~5 calls, ~10 seconds)`}
                >
                  {branchFetching ? 'Fetching…' : '⚡ Fetch This Branch'}
                </button>
              )}
              <button
                style={{ ...S.btnSecondary, background: billsSyncing ? '#EAF4EF' : (billsCache?.complete ? '#EAF4EF' : '#F9F9F9') }}
                onClick={handleSyncAllBills}
                disabled={billsSyncing}
                title={billsCache?.syncedAt ? `Last synced: ${new Date(billsCache.syncedAt).toLocaleString('en-IN')}` : 'No cache yet'}
              >
                {billsSyncing ? 'Syncing Bills…' : billsCache?.complete ? '↻ Sync All (Incremental)' : '⬇ Sync All Branches (Full)'}
              </button>
              <button
                style={{ ...S.btnSecondary, background: branchSyncing ? '#EAF4EF' : '#F0FBF4', color: '#15803D', border: '1px solid #15803D' }}
                onClick={handleSyncBranchBills}
                disabled={branchSyncing || billsSyncing}
                title={`Sync bills for ${selectedBranch ? (branches.find(b => b.id === selectedBranch)?.name || selectedBranch) : 'Amd_The First_C_2Nd Floor'} and cross-verify against P&L`}
              >
                {branchSyncing ? '⏳ Syncing Branch…' : '🔍 Sync & Verify Branch'}
              </button>
              <button
                style={{ ...S.btnSecondary, background: recalibrateRunning ? '#FFFDF0' : '#FFFFFF', color: recalibrateRunning ? '#B45309' : '#1C4942', border: '1px solid #DFE7E3' }}
                onClick={handleRecalibrateCache}
                disabled={recalibrateRunning || branchSyncing || billsSyncing}
                title="Recalibrate ALL branch caches using account_transactions — gives exact Zoho P&L match"
              >
                {recalibrateRunning ? '⏳ Recalibrating…' : '📊 Fix All Totals (Match Zoho P&L)'}
              </button>
              {recalibrateRunning && recalibrateLog.length > 0 && (
                <div style={{ fontSize: '0.7rem', color: '#fbbf24', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {recalibrateLog[recalibrateLog.length - 1]}
                </div>
              )}
              {!branchSyncing && branchSyncResult?.syncedAt && (
                <span style={{ fontSize: '0.72rem', color: '#4ade80' }}>
                  ✓ {branchSyncResult.branchName} · {branchSyncResult.totalBillsFetched} bills · {new Date(branchSyncResult.syncedAt).toLocaleDateString('en-IN')}
                </span>
              )}
              {!billsSyncing && billsCache?.complete && (
                <span style={{ color: '#15803D', fontSize: '0.74rem' }}>
                  ✓ Cache ready · {Object.keys(billsCache.computed || {}).length} months · {new Date(billsCache.syncedAt).toLocaleDateString('en-IN')}
                </span>
              )}
              {!billsSyncing && !billsCache?.complete && (
                <span style={{ color: '#f59e0b', fontSize: '0.74rem' }}>
                  {selectedBranch ? 'Use "Fetch This Branch" for instant data, or Sync All for all branches' : 'Select a branch to fetch its data, or Sync All Branches'}
                </span>
              )}
              {billsSyncing && billsSyncProg && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 240 }}>
                  <div style={{ background: '#F2F2F2', borderRadius: 4, height: 7, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${billsSyncProg.pct || 0}%`, background: 'linear-gradient(90deg,#f59e0b,#ef4444)', transition: 'width 0.5s ease', borderRadius: 4 }} />
                  </div>
                  <span style={{ fontSize: '0.71rem', color: '#9BA8B0' }}>
                    {`${billsSyncProg.doneTasks || 0} / ${billsSyncProg.totalTasks || '?'} · ${billsSyncProg.pct || 0}%`}
                    {billsSyncProg.currentMonth ? ` · ${billsSyncProg.currentMonth}` : ''}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── Prominent FY25-26 Fetch Progress Panel ── */}
          {fetchingBranchFy && fyProgress && (
            <div style={{ margin: '0 0 12px 0', padding: '14px 18px', background: '#EAF4EF', border: '1px solid #A7C4BC', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ color: '#1C4942', fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.05em' }}>
                  FY 25-26 BUDGET DATA FETCH IN PROGRESS
                </span>
                <span style={{ color: '#1C4942', fontWeight: 700, fontSize: '1.1rem' }}>
                  {fyProgress.pct || 0}%
                </span>
              </div>
              {/* Main progress bar */}
              <div style={{ background: '#F2F2F2', borderRadius: 6, height: 12, overflow: 'hidden', marginBottom: 10 }}>
                <div style={{ height: '100%', width: `${fyProgress.pct || 0}%`, background: 'linear-gradient(90deg,#1C4942,#2D6E67)', transition: 'width 0.6s ease', borderRadius: 6 }} />
              </div>
              {/* Stats row */}
              <div style={{ display: 'flex', gap: 24, fontSize: '0.78rem', marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ color: '#5D6C7B' }}>Phase: <span style={{ color: '#1C4942' }}>{fyProgress.phase === 'bill_list' ? 'Loading bill list' : fyProgress.phase === 'bill_details' ? 'Processing bill details' : fyProgress.phase || 'Starting…'}</span></span>
                <span style={{ color: '#5D6C7B' }}>Total Bills: <span style={{ color: '#18191B' }}>{(fyProgress.totalBills || 0).toLocaleString('en-IN')}</span></span>
                <span style={{ color: '#5D6C7B' }}>Branches: <span style={{ color: '#18191B' }}>{fyProgress.branchesProcessed || 0} / {fyProgress.totalBranches || '?'}</span></span>
              </div>
              {/* Current branch mini bar */}
              {fyProgress.currentBranch && fyProgress.currentBranchBills > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: '#5D6C7B', marginBottom: 4 }}>
                    <span>Current: <span style={{ color: '#fbbf24' }}>{fyProgress.currentBranch}</span></span>
                    <span style={{ color: '#9BA8B0' }}>{fyProgress.currentBranchBillsDone || 0} / {fyProgress.currentBranchBills} bills</span>
                  </div>
                  <div style={{ background: '#F2F2F2', borderRadius: 4, height: 5, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.round(((fyProgress.currentBranchBillsDone || 0) / fyProgress.currentBranchBills) * 100)}%`, background: '#f59e0b', transition: 'width 0.4s ease', borderRadius: 4 }} />
                  </div>
                </div>
              )}
              {/* Branch log */}
              {fyProgress.branchLog && fyProgress.branchLog.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {fyProgress.branchLog.map((bl, i) => (
                    <span key={i} style={{ fontSize: '0.68rem', background: '#F0FBF4', border: '1px solid #15803D', color: '#15803D', borderRadius: 4, padding: '2px 7px' }}>
                      ✓ {bl.branch}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Bills Cache Sync Progress Panel ── */}
          {billsSyncing && billsSyncProg && (
            <div style={{ margin: '0 0 12px 0', padding: '14px 18px', background: '#FFFDF0', border: '1px solid #B45309', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.05em' }}>
                  {billsSyncProg.isIncremental ? 'INCREMENTAL P&L SYNC' : 'FULL P&L SYNC IN PROGRESS'}
                </span>
                <span style={{ color: '#f59e0b', fontWeight: 700, fontSize: '1.1rem' }}>{billsSyncProg.pct || 0}%</span>
              </div>
              <div style={{ background: '#F2F2F2', borderRadius: 6, height: 12, overflow: 'hidden', marginBottom: 10 }}>
                <div style={{ height: '100%', width: `${billsSyncProg.pct || 0}%`, background: 'linear-gradient(90deg,#d97706,#ef4444)', transition: 'width 0.6s ease', borderRadius: 6 }} />
              </div>
              <div style={{ display: 'flex', gap: 24, fontSize: '0.78rem', marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ color: '#5D6C7B' }}>Tasks: <span style={{ color: '#18191B' }}>{(billsSyncProg.doneTasks || 0)} / {(billsSyncProg.totalTasks || 0)} branch-months</span></span>
                <span style={{ color: '#5D6C7B' }}>Now: <span style={{ color: '#fbbf24' }}>{billsSyncProg.currentMonth || '…'} · {billsSyncProg.currentBranch || '…'}</span></span>
                <span style={{ color: '#5D6C7B' }}>Range: <span style={{ color: '#9BA8B0' }}>{billsSyncProg.fetchFrom} → {billsSyncProg.fetchTo}</span></span>
              </div>
              {billsSyncProg.monthsSeen?.length > 0 && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                  {billsSyncProg.monthsSeen.map((m, i) => (
                    <span key={i} style={{ fontSize: '0.68rem', background: '#FFF8E6', border: '1px solid #B45309', color: '#B45309', borderRadius: 4, padding: '2px 7px' }}>
                      {m}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Branch Bills Sync Progress Panel ── */}
          {(branchSyncing && branchSyncProg) && (
            <div style={{ margin: '0 0 12px 0', padding: '14px 18px', background: '#F0FBF4', border: '1px solid #15803D', borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ color: '#4ade80', fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.05em' }}>
                  BRANCH BILLS SYNC — {branchSyncProg.branchName || '…'}
                </span>
                <span style={{ color: '#15803D', fontWeight: 700, fontSize: '1.1rem' }}>{branchSyncProg.pct || 0}%</span>
              </div>
              <div style={{ background: '#F2F2F2', borderRadius: 6, height: 12, overflow: 'hidden', marginBottom: 10 }}>
                <div style={{ height: '100%', width: `${branchSyncProg.pct || 0}%`, background: 'linear-gradient(90deg,#16a34a,#4ade80)', transition: 'width 0.6s ease', borderRadius: 6 }} />
              </div>
              <div style={{ display: 'flex', gap: 24, fontSize: '0.78rem', marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ color: '#5D6C7B' }}>Phase: <span style={{ color: '#4ade80' }}>
                  {branchSyncProg.phase === 'bill_list' ? 'Scanning bill list' :
                   branchSyncProg.phase === 'bill_details' ? 'Fetching bill details' :
                   branchSyncProg.phase === 'rate_limit_wait' ? '⚠ Rate limited — waiting…' :
                   branchSyncProg.phase === 'aggregate' ? 'Aggregating by category' :
                   branchSyncProg.phase === 'verify' ? 'Cross-verifying vs P&L' :
                   branchSyncProg.phase === 'save' ? 'Saving cache' :
                   branchSyncProg.phase || 'Starting…'}
                </span></span>
                <span style={{ color: '#5D6C7B' }}>Bills: <span style={{ color: '#18191B' }}>{branchSyncProg.billsDone || 0} / {branchSyncProg.totalBills || '?'}</span></span>
                {branchSyncProg.listPagesScanned > 0 && (
                  <span style={{ color: '#5D6C7B' }}>List pages: <span style={{ color: '#18191B' }}>{branchSyncProg.listPagesScanned}</span></span>
                )}
                <span style={{ color: '#5D6C7B' }}>Range: <span style={{ color: '#9BA8B0' }}>{branchSyncProg.fetchFrom} → {branchSyncProg.fetchTo}</span></span>
              </div>
              {branchSyncProg.currentAction && (
                <div style={{ fontSize: '0.74rem', color: '#86efac', marginBottom: 6, fontStyle: 'italic' }}>
                  {branchSyncProg.currentAction}
                </div>
              )}
              {branchSyncProg.log?.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowBranchLog(v => !v)}
                    style={{ fontSize: '0.72rem', color: '#5D6C7B', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 4 }}
                  >
                    {showBranchLog ? '▲ Hide log' : `▼ Show log (${branchSyncProg.log.length} lines)`}
                  </button>
                  {showBranchLog && (
                    <div style={{ background: '#000', borderRadius: 4, padding: '8px 10px', maxHeight: 180, overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.68rem' }}>
                      {branchSyncProg.log.map((line, i) => (
                        <div key={i} style={{ color: line.includes('✗') ? '#f87171' : line.includes('✓') ? '#4ade80' : line.includes('⚠') ? '#fbbf24' : '#94a3b8' }}>
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Branch Bills Verification Table (shown after sync completes) ── */}
          {!branchSyncing && branchSyncResult?.monthlyTotals && (() => {
            const _vNow = new Date();
            const _fyStartYM = `${_vNow.getMonth() >= 3 ? _vNow.getFullYear() : _vNow.getFullYear() - 1}-04`;
            const _currentYM = _vNow.toISOString().slice(0, 7);
            const verMonths = branchSyncResult.months?.filter(m => m >= _fyStartYM && m <= _currentYM) || [];
            const verItems = branchSyncResult.verification
              ? Object.keys(Object.values(branchSyncResult.verification)[0] || {})
              : Object.keys(branchSyncResult.monthlyTotals?.[verMonths[0]] || {}).filter(k => {
                  const vals = verMonths.map(m => branchSyncResult.monthlyTotals?.[m]?.[k] || 0);
                  return vals.some(v => v > 0);
                });
            const hasVerification = !!branchSyncResult.verification;
            const allPassed = hasVerification && verMonths.every(m =>
              verItems.every(k => branchSyncResult.verification?.[m]?.[k]?.match !== false)
            );
            return (
              <div style={{ margin: '0 0 16px 0', padding: '14px 18px', background: '#F9F9F9', border: `1px solid ${allPassed ? '#15803D' : '#DC2626'}`, borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <span style={{ color: '#4ade80', fontWeight: 700, fontSize: '0.85rem' }}>
                      P&L VERIFICATION — {branchSyncResult.branchName}
                    </span>
                    <span style={{ marginLeft: 12, fontSize: '0.72rem', color: '#5D6C7B' }}>
                      {branchSyncResult.totalBillsFetched} bills · {new Date(branchSyncResult.syncedAt).toLocaleString('en-IN')}
                    </span>
                  </div>
                  {hasVerification && (
                    <span style={{ fontWeight: 700, fontSize: '0.85rem', color: allPassed ? '#4ade80' : '#f87171' }}>
                      {allPassed ? '✓ All Match' : '✗ Mismatches Found'}
                    </span>
                  )}
                </div>

                {/* Sync log toggle (after sync) */}
                {branchSyncProg?.log?.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <button
                      onClick={() => setShowBranchLog(v => !v)}
                      style={{ fontSize: '0.72rem', color: '#5D6C7B', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 4 }}
                    >
                      {showBranchLog ? '▲ Hide sync log' : `▼ Show sync log (${branchSyncProg.log.length} lines)`}
                    </button>
                    {showBranchLog && (
                      <div style={{ background: '#000', borderRadius: 4, padding: '8px 10px', maxHeight: 160, overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.68rem' }}>
                        {branchSyncProg.log.map((line, i) => (
                          <div key={i} style={{ color: line.includes('✗') ? '#f87171' : line.includes('✓') ? '#4ade80' : line.includes('⚠') ? '#fbbf24' : '#94a3b8' }}>
                            {line}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ overflowX: 'auto' }}>
                  <table style={{ ...S.table, fontSize: '0.76rem' }}>
                    <thead>
                      <tr>
                        <th style={{ ...S.th, minWidth: 160 }}>Category</th>
                        {verMonths.map(ym => (
                          <th key={ym} colSpan={hasVerification ? 3 : 1} style={{ ...S.th, textAlign: 'center', color: '#1C4942' }}>
                            {monthLabel(ym)}
                          </th>
                        ))}
                      </tr>
                      {hasVerification && (
                        <tr>
                          <th style={S.th}></th>
                          {verMonths.map(ym => (
                            <React.Fragment key={ym}>
                              <th style={{ ...S.th, textAlign: 'right', color: '#1C4942', fontSize: '0.67rem' }}>P&L (₹)</th>
                              <th style={{ ...S.th, textAlign: 'right', color: '#f59e0b', fontSize: '0.67rem' }}>Bills (₹)</th>
                              <th style={{ ...S.th, textAlign: 'center', fontSize: '0.67rem' }}>Match</th>
                            </React.Fragment>
                          ))}
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {verItems.map((itemId, idx) => {
                        const label = items.find(i => i.id === itemId)?.label || itemId;
                        return (
                          <tr key={itemId} style={{ background: idx % 2 === 0 ? '#F9F9F9' : 'transparent' }}>
                            <td style={{ ...S.td, fontWeight: 500 }}>{label}</td>
                            {verMonths.map(ym => {
                              const v = branchSyncResult.verification?.[ym]?.[itemId];
                              const actual = branchSyncResult.monthlyTotals?.[ym]?.[itemId] || 0;
                              if (hasVerification && v) {
                                return (
                                  <React.Fragment key={ym}>
                                    <td style={{ ...S.td, textAlign: 'right', color: '#1C4942', fontVariantNumeric: 'tabular-nums' }}>{fmt(v.expected)}</td>
                                    <td style={{ ...S.td, textAlign: 'right', color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>{fmt(v.actual)}</td>
                                    <td style={{ ...S.td, textAlign: 'center' }}>
                                      {v.match
                                        ? <span style={{ color: '#4ade80', fontWeight: 700 }}>✓</span>
                                        : <span style={{ color: '#DC2626', fontSize: '0.68rem' }}>✗ {v.diff > 0 ? '+' : ''}{fmt(v.diff, 0)}</span>
                                      }
                                    </td>
                                  </React.Fragment>
                                );
                              }
                              return (
                                <td key={ym} style={{ ...S.td, textAlign: 'right', color: actual > 0 ? '#f59e0b' : '#9BA8B0', fontVariantNumeric: 'tabular-nums' }}>
                                  {fmt(actual)}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Bill count warning if 0 bills found */}
                {branchSyncResult.totalBillsFetched === 0 && (
                  <div style={{ marginTop: 10, padding: '8px 12px', background: '#FFF8E6', border: '1px solid #B45309', borderRadius: 6, fontSize: '0.78rem', color: '#B45309' }}>
                    ⚠ No bills found for this branch. Expenses may be recorded as journal entries in Zoho (not bills). The bills API only returns vendor bills, not journal entries.
                  </div>
                )}
              </div>
            );
          })()}

          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Line Item</th>
                  <th style={{ ...S.th, textAlign: 'right', color: '#86efac' }}>FY25-26 Avg (₹)</th>
                  <th style={{ ...S.th, textAlign: 'right', color: '#a78bfa' }}>Growth %</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Budget (₹)</th>
                  <th style={{ ...S.th, textAlign: 'right', color: '#5D6C7B' }}>Per Sqft (₹)</th>
                  <th style={{ ...S.th, textAlign: 'right', color: '#38bdf8' }}>As per CRM Team</th>
                  <th style={{ ...S.th, textAlign: 'right', color: '#f59e0b' }}>Actual Bills (₹)</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Variance (₹)</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Var %</th>
                  <th style={S.th}>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: 'Direct Expenses',   group: directItems },
                  { label: 'Indirect Expenses', group: indirectItems },
                ].map(({ label, group }) => (
                  <React.Fragment key={label}>
                    <tr>
                      <td colSpan={10} style={{ padding: '0.45rem 0.75rem', background: '#EAF4EF', color: '#1C4942', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.07em', borderBottom: '1px solid #DFE7E3' }}>
                        {label}
                      </td>
                    </tr>
                    {group.map((item, i) => {
                      const branch    = branches.find(b => b.id === selectedBranch);
                      const brSqft    = branch?.sqft || 0;
                      // FY25-26 monthly average: manual override takes priority over Zoho actuals
                      const manualBr  = branchFyManual[selectedBranch] || {};
                      const fyData    = branchFyActuals[selectedBranch];
                      const hasManual = manualBr[item.id] != null;
                      const fyAvg     = hasManual
                                        ? manualBr[item.id]
                                        : (fyData && fyData[item.id] != null ? fyData[item.id] / 12 : null);
                      // Growth % from assumptions
                      const growthPct = (assumptions[item.id] || {}).growthPct || 0;
                      // Budget = FY25-26 avg × (1 + growth%) — no fallback to sqft proration
                      const budget    = fyAvg != null ? fyAvg * (1 + growthPct / 100) : null;
                      const billsAmt  = billsActuals[item.id];
                      const hasBills  = billsAmt != null && billsAmt !== 0;
                      // Variance: budget vs actual bills (primary comparison)
                      const variance  = hasBills && budget ? budget - billsAmt : null;
                      const varPct    = variance != null && budget ? (variance / budget * 100) : null;
                      const brAct     = actuals[selectedBranch] || {};
                      const units     = brAct[item.id]?.units;
                      const persons   = brAct[item.id]?.persons;
                      const remarks   = item.id === 'elec_util' && units ? `${units} units`
                                      : item.id === 'hk_service' && persons ? `${persons} persons`
                                      : '';
                      const isEditing = editingFyCell?.branchId === selectedBranch && editingFyCell?.itemId === item.id;
                      const isCrmItem = CRM_AMOUNT_IDS.has(item.id);
                      const crmRow = (crmActuals[selectedBranch] || {})[selectedMonth] || {};
                      const crmVal = isCrmItem && crmRow[item.id] != null ? crmRow[item.id] : null;
                      const crmTipLines = crmVal != null ? getCrmTooltipLines(item.id, crmRow) : [];
                      return (
                        <tr key={item.id} style={{ background: i % 2 === 0 ? '#F9F9F9' : 'transparent' }}>
                          <td style={S.td}>{item.label}</td>
                          <td
                            style={{ ...S.td, textAlign: 'right', color: fyAvg ? (hasManual ? '#B45309' : '#86efac') : '#9BA8B0', cursor: 'pointer', position: 'relative' }}
                            title="Click to edit"
                            onClick={() => {
                              if (isEditing) return;
                              setEditingFyCell({ branchId: selectedBranch, itemId: item.id });
                              setEditingFyValue(fyAvg != null ? String(Math.round(fyAvg)) : '');
                            }}
                          >
                            {isEditing ? (
                              <input
                                autoFocus
                                type="number"
                                value={editingFyValue}
                                onChange={e => setEditingFyValue(e.target.value)}
                                onBlur={async () => {
                                  await saveFyManual(selectedBranch, item.id, editingFyValue);
                                  setEditingFyCell(null);
                                }}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') e.target.blur();
                                  if (e.key === 'Escape') { setEditingFyCell(null); }
                                }}
                                style={{ width: '100%', background: '#F0FBF4', color: '#B45309', border: '1px solid #15803D', borderRadius: 3, padding: '2px 4px', textAlign: 'right', fontSize: 'inherit' }}
                              />
                            ) : (
                              <span title={hasManual ? 'Manual override (click to edit)' : 'From Zoho (click to override)'}>
                                {fyAvg ? fmtR(fyAvg) : '—'}
                                {hasManual && <span style={{ marginLeft: 4, fontSize: '0.65rem', color: '#fbbf24', opacity: 0.7 }}>✎</span>}
                              </span>
                            )}
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', color: growthPct !== 0 ? '#a78bfa' : '#9BA8B0' }}>
                            {growthPct !== 0 ? `${growthPct > 0 ? '+' : ''}${growthPct}%` : '—'}
                          </td>
                          <td style={{ ...S.td, textAlign: 'right' }}>{budget ? fmtR(budget) : '—'}</td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#5D6C7B' }}>
                            {budget && brSqft ? fmt(budget / brSqft, 2) : '—'}
                          </td>
                          <td
                            style={{ ...S.td, textAlign: 'right', color: crmVal != null ? '#38bdf8' : '#9BA8B0', cursor: crmTipLines.length ? 'help' : 'default' }}
                            onMouseEnter={crmTipLines.length ? e => setCrmHover({ lines: crmTipLines, x: e.clientX, y: e.clientY }) : undefined}
                            onMouseMove={crmTipLines.length ? e => setCrmHover(h => h ? { ...h, x: e.clientX, y: e.clientY } : null) : undefined}
                            onMouseLeave={crmTipLines.length ? () => setCrmHover(null) : undefined}
                          >
                            {crmVal != null ? fmtR(crmVal) : '—'}
                            {crmTipLines.length > 0 && <span style={{ marginLeft: 4, fontSize: '0.6rem', opacity: 0.6 }}>ⓘ</span>}
                          </td>
                          <td
                            style={{ ...S.td, textAlign: 'right', color: hasBills ? '#f59e0b' : '#9BA8B0', cursor: hasBills ? 'pointer' : 'default', textDecoration: hasBills ? 'underline dotted' : 'none' }}
                            title={hasBills ? 'Click to see bills' : ''}
                            onClick={() => {
                              if (!hasBills) return;
                              const drillBills = branchSyncResult?.monthlyBillsByItem?.[selectedMonth]?.[item.id] || [];
                              setBillDrilldown({ itemId: item.id, itemLabel: item.label, month: selectedMonth, bills: drillBills });
                            }}
                          >
                            {hasBills ? fmtR(billsAmt) : '—'}
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', color: variance != null ? (variance >= 0 ? '#4ade80' : '#f87171') : '#9BA8B0' }}>
                            {variance != null ? fmtR(variance) : '—'}
                          </td>
                          <td style={{ ...S.td, textAlign: 'right', color: varPct != null ? (varPct >= 0 ? '#4ade80' : '#f87171') : '#9BA8B0' }}>
                            {varPct != null ? `${varPct >= 0 ? '+' : ''}${fmt(varPct, 1)}%` : '—'}
                          </td>
                          <td style={{ ...S.td, color: '#5D6C7B', fontSize: '0.78rem' }}>{remarks}</td>
                        </tr>
                      );
                    })}
                    <tr style={{ background: '#EAF4EF' }}>
                      <td style={{ ...S.td, fontWeight: 600, color: '#1C4942' }}>Total {label}</td>
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#86efac' }}>
                        {(() => {
                          const manBr = branchFyManual[selectedBranch] || {};
                          const fyD   = branchFyActuals[selectedBranch];
                          const tot = group.reduce((s, it) => {
                            const v = manBr[it.id] != null ? manBr[it.id]
                                    : (fyD && fyD[it.id] != null ? fyD[it.id] / 12 : 0);
                            return s + v;
                          }, 0);
                          return tot ? fmtR(tot) : '—';
                        })()}
                      </td>
                      <td style={S.td} />
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#1C4942' }}>
                        {(() => {
                          const manBr = branchFyManual[selectedBranch] || {};
                          const fyD   = branchFyActuals[selectedBranch];
                          const tot = group.reduce((s, it) => {
                            const avg = manBr[it.id] != null ? manBr[it.id]
                                      : (fyD && fyD[it.id] != null ? fyD[it.id] / 12 : null);
                            if (avg == null) return s;
                            const g = (assumptions[it.id] || {}).growthPct || 0;
                            return s + avg * (1 + g / 100);
                          }, 0);
                          return tot ? fmtR(tot) : '—';
                        })()}
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#5D6C7B' }}>
                        {(() => {
                          const br = branches.find(b => b.id === selectedBranch);
                          const sq = br?.sqft || 0;
                          const manBr = branchFyManual[selectedBranch] || {};
                          const fyD   = branchFyActuals[selectedBranch];
                          if (!sq) return '—';
                          const tot = group.reduce((s, it) => {
                            const avg = manBr[it.id] != null ? manBr[it.id]
                                      : (fyD && fyD[it.id] != null ? fyD[it.id] / 12 : null);
                            if (avg == null) return s;
                            const g = (assumptions[it.id] || {}).growthPct || 0;
                            return s + avg * (1 + g / 100);
                          }, 0);
                          return tot ? fmt(tot / sq, 2) : '—';
                        })()}
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#38bdf8' }}>
                        {(() => {
                          const crmBr = (crmActuals[selectedBranch] || {})[selectedMonth] || {};
                          const tot = group.reduce((s, it) => CRM_AMOUNT_IDS.has(it.id) ? s + (crmBr[it.id] || 0) : s, 0);
                          return tot ? fmtR(tot) : '—';
                        })()}
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', fontWeight: 600, color: '#B45309' }}>
                        {(() => {
                          const tot = group.reduce((s, it) => s + (billsActuals[it.id] || 0), 0);
                          return tot ? fmtR(tot) : '—';
                        })()}
                      </td>
                      <td style={S.td} colSpan={3} />
                    </tr>
                  </React.Fragment>
                ))}
                {/* Grand Total */}
                <tr style={{ background: '#FFFFFF' }}>
                  <td style={{ ...S.td, fontWeight: 700, color: '#18191B' }}>Total</td>
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#86efac' }}>
                    {(() => {
                      const manBr = branchFyManual[selectedBranch] || {};
                      const fyD   = branchFyActuals[selectedBranch];
                      const tot = items.reduce((s, it) => {
                        const v = manBr[it.id] != null ? manBr[it.id]
                                : (fyD && fyD[it.id] != null ? fyD[it.id] / 12 : 0);
                        return s + v;
                      }, 0);
                      return tot ? fmtR(tot) : '—';
                    })()}
                  </td>
                  <td style={S.td} />
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#18191B' }}>
                    {(() => {
                      const manBr = branchFyManual[selectedBranch] || {};
                      const fyD   = branchFyActuals[selectedBranch];
                      const tot = items.reduce((s, it) => {
                        const avg = manBr[it.id] != null ? manBr[it.id]
                                  : (fyD && fyD[it.id] != null ? fyD[it.id] / 12 : null);
                        if (avg == null) return s;
                        const g = (assumptions[it.id] || {}).growthPct || 0;
                        return s + avg * (1 + g / 100);
                      }, 0);
                      return tot ? fmtR(tot) : '—';
                    })()}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#5D6C7B' }}>
                    {(() => {
                      const br = branches.find(b => b.id === selectedBranch);
                      const sq = br?.sqft || 0;
                      const manBr = branchFyManual[selectedBranch] || {};
                      const fyD   = branchFyActuals[selectedBranch];
                      if (!sq) return '—';
                      const tot = items.reduce((s, it) => {
                        const avg = manBr[it.id] != null ? manBr[it.id]
                                  : (fyD && fyD[it.id] != null ? fyD[it.id] / 12 : null);
                        if (avg == null) return s;
                        const g = (assumptions[it.id] || {}).growthPct || 0;
                        return s + avg * (1 + g / 100);
                      }, 0);
                      return tot ? fmt(tot / sq, 2) : '—';
                    })()}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#38bdf8' }}>
                    {(() => {
                      const crmBr = (crmActuals[selectedBranch] || {})[selectedMonth] || {};
                      const tot = items.reduce((s, it) => CRM_AMOUNT_IDS.has(it.id) ? s + (crmBr[it.id] || 0) : s, 0);
                      return tot ? fmtR(tot) : '—';
                    })()}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#f59e0b' }}>
                    {(() => {
                      const tot = items.reduce((s, it) => s + (billsActuals[it.id] || 0), 0);
                      return tot ? fmtR(tot) : '—';
                    })()}
                  </td>
                  <td style={S.td} colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CRM hover tooltip */}
      {crmHover && (
        <div style={{
          position: 'fixed',
          left: crmHover.x + 14,
          top: crmHover.y - 12,
          background: '#FFFFFF',
          border: '1px solid #38bdf8',
          borderRadius: 8,
          padding: '10px 14px',
          zIndex: 9999,
          fontSize: '0.78rem',
          color: '#18191B',
          lineHeight: 1.8,
          pointerEvents: 'none',
          boxShadow: '0 4px 20px rgba(0,18,20,0.15)',
          minWidth: 200,
          whiteSpace: 'nowrap',
        }}>
          <div style={{ fontSize: '0.68rem', color: '#38bdf8', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>CRM Details</div>
          {crmHover.lines.map((l, i) => (
            <div key={i} style={{ color: '#18191B' }}>{l}</div>
          ))}
        </div>
      )}

      {/* ── Data Entry (CRM) ── */}
      {tab === 'entry' && (
        <div style={S.section}>
          <div style={S.sectionHdr}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={S.label}>Month:</label>
              <select style={S.select} value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}>
                {monthOptions.map(ym => <option key={ym} value={ym}>{monthLabel(ym)}</option>)}
              </select>
              <label style={S.label}>Branch:</label>
              <select style={S.select} value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)}>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <button style={S.btnPrimary} onClick={handleSaveEntry} disabled={saving}>
              {saving ? 'Saving…' : 'Save Actuals'}
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Line Item</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Budget (₹)</th>
                  <th style={S.th}>Actual Amount (₹)</th>
                  <th style={S.th}>No. of Electricity Units</th>
                  <th style={S.th}>No. of HK Persons</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: 'Direct Expenses',   group: directItems },
                  { label: 'Indirect Expenses', group: indirectItems },
                ].map(({ label, group }) => (
                  <React.Fragment key={label}>
                    <tr>
                      <td colSpan={5} style={{ padding: '0.45rem 0.75rem', background: '#EAF4EF', color: '#1C4942', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.07em', borderBottom: '1px solid #DFE7E3' }}>
                        {label}
                      </td>
                    </tr>
                    {group.map((item, i) => {
                      const budget = monthlyBranchBudget(item.id, selectedBranch);
                      const entry  = entryData[item.id] || {};
                      return (
                        <tr key={item.id} style={{ background: i % 2 === 0 ? '#F9F9F9' : 'transparent' }}>
                          <td style={S.td}>{item.label}</td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#5D6C7B' }}>{budget ? fmtR(budget) : '—'}</td>
                          <td style={S.td}>
                            <input type="number" value={entry.amount || ''} placeholder="Enter amount"
                              onChange={e => handleEntryChange(item.id, 'amount', e.target.value)}
                              style={S.numInput} step="1" />
                          </td>
                          <td style={S.td}>
                            {item.id === 'elec_util' ? (
                              <input type="number" value={entry.units || ''} placeholder="Units"
                                onChange={e => handleEntryChange(item.id, 'units', e.target.value)}
                                style={{ ...S.numInput, width: 90 }} step="1" />
                            ) : <span style={{ color: '#9BA8B0' }}>—</span>}
                          </td>
                          <td style={S.td}>
                            {item.id === 'hk_service' ? (
                              <input type="number" value={entry.persons || ''} placeholder="Persons"
                                onChange={e => handleEntryChange(item.id, 'persons', e.target.value)}
                                style={{ ...S.numInput, width: 90 }} step="1" />
                            ) : <span style={{ color: '#9BA8B0' }}>—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bill Drill-Down Modal */}
      {billDrilldown && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setBillDrilldown(null)}>
          <div style={{ background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12, width: '94vw', maxWidth: 1050, maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,18,20,0.15)' }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '1rem', color: '#18191B' }}>{billDrilldown.itemLabel}</div>
                <div style={{ color: '#5D6C7B', fontSize: '0.79rem', marginTop: 2 }}>
                  {monthLabel(billDrilldown.month)} — {billDrilldown.bills.length} bill line{billDrilldown.bills.length !== 1 ? 's' : ''} from Zoho Books
                </div>
              </div>
              <button style={{ background: 'none', border: '1px solid #DFE7E3', color: '#9BA8B0', borderRadius: 6, padding: '0.3rem 0.85rem', cursor: 'pointer', fontSize: '0.8rem' }}
                onClick={() => setBillDrilldown(null)}>Close ✕</button>
            </div>
            {/* Table */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1.25rem 1.25rem' }}>
              {billDrilldown.bills.length === 0 ? (
                <div style={{ color: '#5D6C7B', padding: '2rem', textAlign: 'center', fontSize: '0.85rem' }}>
                  No individual bill records available. Run "Sync &amp; Verify Branch" to populate drill-down data.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.81rem' }}>
                  <thead>
                    <tr style={{ background: '#F9F9F9' }}>
                      {['Date', 'Vendor / Supplier', 'Account (COA)', 'Line Amount (₹)', 'Bill Total (₹)', 'Bill ID'].map(h => (
                        <th key={h} style={{ padding: '0.5rem 0.75rem', textAlign: h.includes('₹') ? 'right' : 'left', color: '#5D6C7B', fontWeight: 600, borderBottom: '1px solid #DFE7E3', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {billDrilldown.bills.map((b, idx) => (
                      <tr key={idx} style={{ background: idx % 2 === 0 ? '#F9F9F9' : 'transparent', borderBottom: '1px solid #DFE7E3' }}>
                        <td style={{ padding: '0.45rem 0.75rem', color: '#9BA8B0', whiteSpace: 'nowrap' }}>{b.date || '—'}</td>
                        <td style={{ padding: '0.45rem 0.75rem', color: '#18191B' }}>{b.vendor || '—'}</td>
                        <td style={{ padding: '0.45rem 0.75rem', color: '#1C4942', fontSize: '0.76rem' }}>{b.account_name || '—'}</td>
                        <td style={{ padding: '0.45rem 0.75rem', textAlign: 'right', color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>{fmtR(b.line_item_total)}</td>
                        <td style={{ padding: '0.45rem 0.75rem', textAlign: 'right', color: '#5D6C7B', fontVariantNumeric: 'tabular-nums' }}>{fmtR(b.bill_total)}</td>
                        <td style={{ padding: '0.45rem 0.75rem', color: '#9BA8B0', fontSize: '0.72rem', fontFamily: 'monospace' }}>{b.bill_id || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#EAF4EF', borderTop: '2px solid #DFE7E3' }}>
                      <td colSpan={3} style={{ padding: '0.5rem 0.75rem', fontWeight: 700, color: '#1C4942' }}>Total</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 700, color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtR(billDrilldown.bills.reduce((s, b) => s + (b.line_item_total || 0), 0))}
                      </td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { background: '#F9F9F9', minHeight: '100vh', color: '#18191B', fontFamily: "'Figtree', system-ui, -apple-system, sans-serif" },
  header: {
    padding: '1.4rem 2rem 0.8rem',
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    borderBottom: '1px solid #DFE7E3',
  },
  h1: { fontSize: '1.3rem', fontWeight: 700, color: '#18191B', letterSpacing: '-0.02em' },
  sub: { color: '#5D6C7B', fontSize: '0.79rem', marginTop: 4 },
  tabBar: { display: 'flex', padding: '0 2rem', borderBottom: '1px solid #DFE7E3' },
  tab: {
    background: 'none', border: 'none', borderBottom: '2px solid transparent',
    padding: '0.6rem 1.1rem', color: '#5D6C7B', cursor: 'pointer',
    fontSize: '0.82rem', fontWeight: 500, transition: 'all 0.12s',
  },
  tabActive: { color: '#1C4942', borderBottom: '2px solid #1C4942' },
  section: { padding: '1.4rem 2rem' },
  sectionHdr: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: '1rem', flexWrap: 'wrap', gap: 8,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th: {
    background: '#F9F9F9', color: '#5D6C7B', fontWeight: 600,
    padding: '0.55rem 0.75rem', textAlign: 'left',
    borderBottom: '1px solid #DFE7E3',
    fontSize: '0.72rem', letterSpacing: '0.04em', textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '0.45rem 0.75rem', color: '#9BA8B0',
    borderBottom: '1px solid #DFE7E3', verticalAlign: 'middle',
  },
  numInput: {
    background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 4,
    color: '#18191B', padding: '3px 8px', width: '120px',
    textAlign: 'right', fontSize: '0.81rem', outline: 'none',
  },
  btnPrimary: {
    background: '#1C4942', border: 'none', color: '#fff',
    padding: '0.42rem 1rem', borderRadius: 6, cursor: 'pointer',
    fontSize: '0.81rem', fontWeight: 600,
  },
  btnSecondary: {
    background: 'transparent', border: '1px solid #DFE7E3', color: '#1C4942',
    padding: '0.42rem 1rem', borderRadius: 6, cursor: 'pointer',
    fontSize: '0.81rem',
  },
  label: { color: '#5D6C7B', fontSize: '0.81rem', fontWeight: 500 },
  select: {
    background: '#FFFFFF', border: '1px solid #DFE7E3', color: '#18191B',
    padding: '0.38rem 0.65rem', borderRadius: 6, fontSize: '0.81rem', cursor: 'pointer',
  },
  msgOk:   { color: '#15803D', fontSize: '0.8rem', padding: '0.4rem 0.85rem', background: '#F0FBF4', borderRadius: 5, border: '1px solid #15803D' },
  msgErr:  { color: '#DC2626', fontSize: '0.8rem', padding: '0.4rem 0.85rem', background: '#FFF5F5', borderRadius: 5, border: '1px solid #DC2626' },
  msgInfo: { color: '#1C4942', fontSize: '0.8rem', padding: '0.4rem 0.85rem', background: '#EAF4EF', borderRadius: 5, border: '1px solid #A7C4BC' },
  btnMap: {
    background: 'transparent', border: '1px solid #DFE7E3', color: '#1C4942',
    padding: '0.38rem 0.9rem', borderRadius: 6, cursor: 'pointer',
    fontSize: '0.79rem', fontWeight: 500,
  },
  mapChip: {
    display: 'inline-flex', alignItems: 'center', background: '#EAF4EF',
    border: '1px solid #A7C4BC', color: '#1C4942',
    borderRadius: 4, padding: '1px 6px', fontSize: '0.7rem', fontWeight: 500,
  },
  mapBadgeEmpty: { color: '#9BA8B0', fontSize: '0.7rem', marginTop: 2, fontStyle: 'italic' },
  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,18,20,0.5)',
    zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  modalBox: {
    background: '#FFFFFF', border: '1px solid #DFE7E3', borderRadius: 12,
    width: '92vw', maxWidth: 1100, height: '82vh',
    display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,18,20,0.15)',
    overflow: 'hidden',
  },
  modalHdr: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    padding: '1rem 1.25rem', borderBottom: '1px solid #DFE7E3', flexShrink: 0,
  },
  modalClose: {
    background: 'none', border: '1px solid #DFE7E3', color: '#5D6C7B',
    borderRadius: 6, padding: '0.3rem 0.75rem', cursor: 'pointer',
    fontSize: '0.78rem',
  },
  modalLeft: {
    width: 340, flexShrink: 0, borderRight: '1px solid #DFE7E3',
    overflowY: 'auto', display: 'flex', flexDirection: 'column',
  },
  modalRight: {
    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
};
