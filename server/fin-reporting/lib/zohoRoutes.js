/**
 * Financial Reporting — routes for the Zoho Books ledger sync, the account mapping and its reconciliation.
 *
 *   GET  /gl/status            last successful run, next scheduled run, cut-off date, records added / changed, affected periods,
 *                              failures, accounts awaiting mapping (Sync Monitor and Account Mapping read this)
 *   POST /gl/run               { mode: 'initial' | 'hourly' | 'full' } — right "Import workbooks"
 *   GET  /mapping              the mapping in force: every ledger with its Zoho account, workbook head, statement line, note, rule,
 *                              balances (workbook trial balance, Zoho at the workbook date, Zoho at the cut-off)
 *   POST /mapping/build        build it from a final workbook's trial-balance sheet (folder on the office PC, or an upload)
 *   POST /mapping/edit         { id, line, sign, note, exclude, reviewed, comment } — right "Adjustments & source decisions"
 *   POST /mapping/review       { ids, reviewed } — mark reviewed
 *   GET  /mapping/recon        the mapped Zoho figures against the final workbook (balance sheet at its date, year-to-date P&L,
 *                              the quarter alone), differences explained by ledger; exceptions
 *   GET  /mapping/export       the same as an Excel workbook
 * The hourly schedule: on the office PC an in-process timer (minute 45 of every hour, India time); on Vercel the cron
 * /api/cron/fin-gl (vercel.json) calls cronRun().
 */

'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./periods');
const L = require('./lines');
const G = require('./gl');
const AC = require('./acmap');
const LV = require('./live');
const EX = require('./exporter');

const IST = 5.5 * 3600e3;
const RUN_MINUTE_IST = 45;
const scheduler = { next: null, timer: null, lastTick: null };
const r2 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
function nextRunAt(now = Date.now()) {
  const ist = new Date(now + IST);
  const base = now - (ist.getUTCSeconds() * 1000 + ist.getUTCMilliseconds());
  let mins = (RUN_MINUTE_IST - ist.getUTCMinutes() + 60) % 60;
  if (mins === 0) mins = 60;
  return base + mins * 60000;
}
const finalEndOf = version => { let e = null; for (const fc of version.facts) { if (fc.zoho || fc.role === 'working' || fc.st !== 'ok' || fc.b !== 'SA') continue; const p = P.fromId(fc.p); if (p && (!e || p.end > e)) e = p.end; } return e; };

function mount(router, d) {
  const { store, gl, active, liveState, need, wrap, bad, who, M, IS_VERCEL, DEFAULT_FOLDER, upload, xlsxOut } = d;

  async function scheduledRun(trigger, opts = {}) {
    const a = await active();
    const fe = a ? finalEndOf(a.version) : null;
    const openFrom = fe ? G.addMonths(fe.slice(0, 7), 1) : undefined;
    scheduler.lastTick = new Date().toISOString();
    const st = await gl.readState();
    if (!st.initial?.doneAt) return { status: 'skipped', message: 'The initial Zoho ledger sync has not been run yet.' };
    return gl.run({ mode: opts.mode || 'hourly', openFrom, trigger, budgetMs: opts.budgetMs, by: opts.by });
  }
  router.startScheduler = () => {
    if (IS_VERCEL || scheduler.timer) return;
    const arm = () => {
      scheduler.next = nextRunAt();
      scheduler.timer = setTimeout(async () => {
        try { const r = await scheduledRun('scheduled'); if (r.status !== 'ok' && r.status !== 'skipped') console.warn('[fin-gl] scheduled run:', r.status, r.error || r.message || ''); }
        catch (e) { console.error('[fin-gl] scheduled run failed:', e.message); }
        arm();
      }, Math.max(1000, scheduler.next - Date.now()));
      if (scheduler.timer.unref) scheduler.timer.unref();
    };
    arm();
  };
  router.cronRun = async (req, res) => {
    try { res.json(await scheduledRun('vercel-cron', { budgetMs: 240000 })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  };

  // ── sync status and runs ──
  router.get('/gl/status', wrap(async (req, res) => {
    const s = await gl.status();
    const a = await active();
    const lc = a ? await liveState(a).catch(() => null) : null;
    const map = await store.read('acmap', null);
    const fe = a ? finalEndOf(a.version) : null;
    res.json({ ...s, schedule: { minuteIst: RUN_MINUTE_IST, next: IS_VERCEL ? new Date(nextRunAt()).toISOString() : scheduler.next ? new Date(scheduler.next).toISOString() : null, onVercel: IS_VERCEL, armed: IS_VERCEL || !!scheduler.timer, lastTick: scheduler.lastTick },
      finalEnd: fe, openFrom: fe ? G.addMonths(fe.slice(0, 7), 1) : null,
      mapping: map ? { file: map.meta.file, sheet: map.meta.sheet, builtAt: map.meta.builtAt, builtBy: map.meta.builtBy, reportingDate: map.meta.reportingDate, counts: map.meta.counts } : null,
      awaitingCount: lc ? lc.lv.awaiting.length : null, awaiting: lc ? lc.lv.awaiting.slice(0, 300) : [], liveReady: !!lc });
  }));
  router.post('/gl/run', need('import'), wrap(async (req, res) => {
    const mode = ['initial', 'hourly', 'full'].includes(req.body?.mode) ? req.body.mode : 'hourly';
    const a = await active();
    const fe = a ? finalEndOf(a.version) : null;
    const openFrom = fe ? G.addMonths(fe.slice(0, 7), 1) : undefined;
    await store.audit({ action: 'gl-run', mode, by: who(req) });
    if (IS_VERCEL) return res.json(await gl.run({ mode, openFrom, trigger: 'manual', by: who(req), budgetMs: 240000 }));
    // the office PC: in the background — the page follows /gl/status
    const st = await gl.status();
    if (st.running) return res.json({ status: 'busy', message: 'A Zoho ledger sync is already running.' });
    gl.run({ mode, openFrom, trigger: 'manual', by: who(req) }).then(r => console.log(`[fin-gl] manual ${mode}: ${r.status}`)).catch(e => console.error('[fin-gl] manual run failed:', e.message));
    res.json({ status: 'started', mode });
  }));

  // ── the mapping ──
  const leafOptions = () => [...AC.LEAF_BS, ...AC.LEAF_PL].filter(id => !L.BY_ID[id]?.cons).map(id => ({ id, label: L.BY_ID[id].label, stmt: id.startsWith('bs.') ? 'BS' : 'PL', sec: L.BY_ID[id].sec || null }));
  async function mappingView() {
    const map = await store.read('acmap', null);
    if (!map) return null;
    const edits = await store.read('acmap_edits', { items: {}, at: null });
    const st = await gl.readState();
    const a = await active();
    const lc = a ? await liveState(a).catch(() => null) : null;
    const byId = LV.effectiveMapping(map, edits.items, st.accounts);
    const lv = lc?.lv;
    const bsMap = lv?.bsBalances(map.meta.reportingDate), bsNow = lv && lv.cutoff ? lv.bsBalances(lv.cutoff) : null;
    const ytd = P.fromId(map.meta.ytdPeriod);
    const ds = lc ? await gl.dataset() : null;
    const plRange = (fromYm, toYm) => (ds ? ds.range(fromYm, toYm) : null);
    const plYtd = plRange(ytd.start.slice(0, 7), ytd.end.slice(0, 7));
    const plNow = lv ? plRange(G.fyStartOf(lv.cutoff).slice(0, 7), lv.cutoff.slice(0, 7)) : null;
    const zAt = (id, isPl, which) => {
      if (isPl) { const r = (which === 'map' ? plYtd : plNow)?.get(id); return r ? r2(r[0] - r[1]) : 0; }
      const b = which === 'map' ? bsMap : bsNow;
      const v = b?.vals.get(id);
      return v ? r2(v.close) : 0;
    };
    const rows = [];
    const seen = new Set();
    for (const l of map.ledgers) {
      const id = l.zoho?.id || null;
      const m = id ? byId[id] : null;
      if (id) seen.add(id);
      const isPl = l.section === 'income' || l.section === 'expense';
      const lines = m ? m.lines : l.lines;
      const notes = m ? m.notes : l.notes;
      rows.push({ row: l.row, id, name: l.name, zohoName: l.zoho?.name || null, zohoType: l.zoho?.type || null, parent: l.parent, section: l.section, head: l.group,
        lines: Object.entries(lines).map(([line, slot]) => ({ line, coef: Math.round(((slot.close || slot.dr || -(slot.cr || 0) || slot.open || 0) / 1e-5) * 1e6) / 1e6, codes: Object.keys(slot) })),
        notes: Object.keys(notes || {}).map(k => ({ key: k, label: map.noteItems[k]?.label, num: map.noteItems[k]?.num, title: map.noteItems[k]?.title })),
        status: m?.status || l.status, rule: m?.rule || l.rule || null, split: l.split || null, repaired: l.repaired || null, ambiguous: !!(l.ambiguous || l.match === 'ambiguous'), match: l.match, nil: !!l.nil,
        source: m?.source || 'workbook', reviewed: edits.items[id]?.reviewed ? { by: edits.items[id].by, at: edits.items[id].at } : null, edit: id && edits.items[id] ? edits.items[id] : null,
        tb: { close: r2(l.tb.close / 1e5), obe: r2(l.tb.obe / 1e5) }, zMap: id && lv ? r2(zAt(id, isPl, 'map') / 1e5) : null, zNow: id && lv ? r2(zAt(id, isPl, 'now') / 1e5) : null });
    }
    // Zoho accounts the workbook does not have, with an amount at the cut-off date (new since the workbook, or never in it)
    const awaiting = lv ? lv.awaiting.filter(x => !seen.has(x.id)) : [];
    for (const x of awaiting) rows.push({ row: null, id: x.id, name: x.name, zohoName: x.name, zohoType: x.type, parent: st.accounts[x.id]?.pn || null, section: null, head: null,
      lines: x.suggested ? [{ line: x.line, coef: null, codes: ['close'] }] : [], notes: [], status: x.suggested ? 'suggested' : 'awaiting', rule: x.suggested ? `suggested from the ${x.suggested} — review` : 'new in Zoho / not in the workbook — awaiting mapping',
      source: edits.items[x.id] ? 'edit' : 'zoho', reviewed: edits.items[x.id]?.reviewed ? { by: edits.items[x.id].by, at: edits.items[x.id].at } : null, edit: edits.items[x.id] || null, tb: null, zMap: null, zNow: x.amount, first: x.first, created: x.created });
    const counts = rows.reduce((c, r) => { c[r.status] = (c[r.status] || 0) + 1; return c; }, {});
    return { meta: map.meta, counts, rows, lineOptions: leafOptions(), noteOptions: Object.values(map.noteItems).filter(i => !i.total).map(i => ({ key: i.key, label: i.label, num: i.num, title: i.title, lines: i.lines })),
      editsAt: edits.at, cutoff: lv?.cutoff || null, live: !!lv };
  }
  router.get('/mapping', wrap(async (req, res) => { const v = await mappingView(); if (!v) return bad(res, 404, 'No account mapping yet — build it from the final workbook (Account Mapping → Build from the Q2 final workbook).', { code: 'NO_MAPPING' }); res.json(v); }));

  function pickMappingWorkbook() {
    if (IS_VERCEL || !fs.existsSync(DEFAULT_FOLDER)) return null;
    // the newest final workbook with a trial-balance sheet (by its name's period: Q-2 after Q-1, a later year after an earlier one)
    const files = fs.readdirSync(DEFAULT_FOLDER).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$') && /standalone/i.test(f));
    const key = f => { const m = f.match(/FY\s*(\d{4})-(\d{2})(?:_Q-(\d))?/i); return m ? +m[1] * 10 + (m[3] ? +m[3] : 5) : 0; };
    return files.sort((x, y) => key(y) - key(x))[0] || null;
  }
  router.post('/mapping/build', need('import'), upload.single('file'), wrap(async (req, res) => {
    let buf = req.file?.buffer, name = req.file?.originalname;
    if (!buf) {
      name = req.body?.file || pickMappingWorkbook();
      if (!name) return bad(res, 400, IS_VERCEL ? 'Upload the final workbook (it must contain the trial-balance sheet, e.g. "TB S26").' : 'No final workbook found in the Financials folder.');
      if (name.includes('/') || name.includes('\\')) return bad(res, 400, 'File name only, please.');
      buf = fs.readFileSync(path.join(DEFAULT_FOLDER, name));
    }
    const st = await gl.readState();
    const map = AC.buildMapping({ buf, name, accounts: st.accounts, tbSheet: req.body?.sheet || null, user: who(req) });
    await store.write('acmap', map);
    await store.audit({ action: 'mapping-built', file: name, sheet: map.meta.sheet, counts: map.meta.counts, by: who(req) });
    res.json({ ok: true, meta: map.meta });
  }));
  router.post('/mapping/edit', need('adjust'), wrap(async (req, res) => {
    const { id, line, sign, note, exclude, reviewed, comment, clear } = req.body || {};
    if (!id || !/^\d+$/.test(String(id))) return bad(res, 400, 'Choose a Zoho account.');
    if (line && !L.BY_ID[line]) return bad(res, 400, 'Unknown statement line.');
    const at = new Date().toISOString();
    await store.update('acmap_edits', { items: {}, at: null }, e => {
      if (clear) delete e.items[id];
      else e.items[id] = { ...(e.items[id] || {}), ...(line !== undefined ? { line: line || null } : {}), ...(sign !== undefined ? { sign: sign === -1 ? -1 : sign === 1 ? 1 : null } : {}), ...(note !== undefined ? { note: note || null } : {}),
        ...(exclude !== undefined ? { exclude: !!exclude } : {}), ...(reviewed !== undefined ? { reviewed: !!reviewed } : {}), ...(comment !== undefined ? { comment: String(comment || '').slice(0, 500) } : {}), by: who(req), at };
      e.at = at;
    });
    await store.audit({ action: 'mapping-edit', id, line, sign, note, exclude, reviewed, clear: !!clear, by: who(req) });
    res.json({ ok: true });
  }));
  router.post('/mapping/review', need('adjust'), wrap(async (req, res) => {
    const ids = (req.body?.ids || []).filter(x => /^\d+$/.test(String(x))).slice(0, 5000);
    const at = new Date().toISOString();
    await store.update('acmap_edits', { items: {}, at: null }, e => { for (const id of ids) e.items[id] = { ...(e.items[id] || {}), reviewed: req.body?.reviewed !== false, by: who(req), at }; e.at = at; });
    await store.audit({ action: 'mapping-review', count: ids.length, reviewed: req.body?.reviewed !== false, by: who(req) });
    res.json({ ok: true, count: ids.length });
  }));

  // ── reconciliation: the mapped Zoho figures against the final workbook ──
  async function reconView() {
    const a = await active();
    if (!a) return { error: 'No workbooks imported.' };
    const lc = await liveState(a);
    if (!lc) return { error: 'Zoho figures are not available yet (initial sync and mapping needed).' };
    const { map, lv } = lc;
    const finalCtx = M.makeCtx(a.version, { ix: a.ix, mode: 'original' });
    const fin = (l, p) => { const c = M.cell(finalCtx, 'SA', l, p); return c.v != null ? c.v : c.blank ? 0 : null; };
    const bsP = map.meta.bsPeriod, ytdP = map.meta.ytdPeriod;
    const ds = await gl.dataset();
    const ytd = P.fromId(ytdP);
    const plY = ds.range(ytd.start.slice(0, 7), ytd.end.slice(0, 7));
    const bsV = lv.bsBalances(map.meta.reportingDate);
    const zVal = (id, isPl) => (isPl ? (plY?.get(id) ? plY.get(id)[0] - plY.get(id)[1] : 0) : (bsV?.vals.get(id)?.close || 0));
    const ledgerChanges = {};
    for (const l of map.ledgers) {
      if (!l.zoho?.id) continue;
      const isPl = l.section === 'income' || l.section === 'expense';
      const z = zVal(l.zoho.id, isPl);
      const d0 = z - l.tb.close;
      if (Math.abs(d0) < 1) continue;
      const m = lv.byId[l.zoho.id];
      for (const [line, slot] of Object.entries(m?.lines || l.lines)) {
        if (line.startsWith('bs.') && isPl) continue;
        const coef = lv.rollForward.has(line) ? (slot.close || slot.dr || (slot.cr ? -slot.cr : 0) || slot.open || 0) : (slot.close || 0);
        if (!coef) continue;
        (ledgerChanges[line] = ledgerChanges[line] || []).push({ id: l.zoho.id, name: l.name, head: l.group, workbook: r2(l.tb.close / 1e5), zoho: r2(z / 1e5), effect: r2(coef * d0) });
      }
    }
    const lineRows = (stmt, pid, zsrc) => {
      const ids = stmt === 'BS' ? [...AC.LEAF_BS, ...L.BS.filter(l => l.sum && !l.cons).map(l => l.id), 'bs.x.await_assets', 'bs.x.await_liab'] : [...AC.LEAF_PL, 'pl.tot_inc', 'pl.exp_tot', 'pl.pbe', 'pl.pbt', 'pl.tax_tot', 'pl.pat', 'pl.oci_tot', 'pl.tci', 'pl.x.await_inc', 'pl.x.await_exp'];
      return ids.filter(id => map.lines[id] || zsrc?.lines[id] || fin(id, pid) != null).map(id => {
        const ml = map.lines[id];
        const wb = fin(id, pid), z = zsrc?.lines[id] ?? null;
        const ch = (ledgerChanges[id] || []).sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect));
        const chg = r2(ch.reduce((t, x) => t + x.effect, 0));
        const total = wb != null && z != null ? r2(wb - z) : null;
        const wbOnly = ml?.leaf ? r2(ml.workbookOnly) : null, sched = ml?.leaf ? r2(ml.residual) : null;
        const other = total != null && ml?.leaf ? r2(total - (wbOnly || 0) - (sched || 0) + chg) : null;
        const notIn = ml?.leaf ? r2(-(ml.notInWorkbook || 0)) : null;
        return { id, label: L.BY_ID[id]?.label || LV.AWAIT[id]?.label || id, leaf: !!ml?.leaf, total: !ml?.leaf, workbook: r2(wb), mappedOnWorkbookTb: ml?.leaf ? r2(ml.mapped) : null, zoho: r2(z), difference: total,
          workbookOnly: wbOnly, schedule: sched, zohoChanges: chg ? r2(-chg) : 0, other, notInWorkbook: notIn, changes: ch.slice(0, 12), dropped: ml?.dropped?.filter(x => !x.explainedBy).map(x => ({ cell: `${x.sheet.trim()}!${x.addr}`, amount: x.amount, kind: x.kind })) || [], obe: ml?.obe || 0, scheduleInfo: ml?.schedule || null };
      });
    };
    const bsRows = lineRows('BS', bsP, lv.zoho.BS[bsP]);
    const plRows = lineRows('PL', ytdP, lv.zoho.PL[ytdP]);
    // the quarter alone: Zoho's months vs the final quarter (H1 − Q1), with what each side's difference comes from
    const qId = ytdP.replace(/-(H1|9M|FY)$/, m => ({ '-H1': '-Q2', '-9M': '-Q3', '-FY': '-Q4' })[m]);
    const prevCum = { '-Q2': '-Q1', '-Q3': '-H1', '-Q4': '-9M' }[qId.slice(qId.lastIndexOf('-'))];
    const prevId = prevCum ? qId.slice(0, qId.lastIndexOf('-')) + prevCum : null;
    const qRows = [...AC.LEAF_PL, 'pl.tot_inc', 'pl.exp_tot', 'pl.pbt', 'pl.tax_tot', 'pl.pat', 'pl.tci'].filter(id => map.lines[id] || lv.zoho.PL[qId]?.lines[id] != null).map(id => {
      const fq = fin(id, qId), fy = fin(id, ytdP), fp = prevId ? fin(id, prevId) : null;
      const zq = lv.zoho.PL[qId]?.lines[id] ?? null, zy = lv.zoho.PL[ytdP]?.lines[id] ?? null, zp = prevId ? lv.zoho.PL[prevId]?.lines[id] ?? null : null;
      return { id, label: L.BY_ID[id]?.label || id, finalQuarter: r2(fq), finalYtdLessPrevious: fy != null && fp != null ? r2(fy - fp) : null, zohoMonths: r2(zq), difference: zq != null && fq != null ? r2(zq - fq) : null,
        ytdDifference: zy != null && fy != null ? r2(zy - fy) : null, previousDifference: zp != null && fp != null ? r2(zp - fp) : null };
    });
    const bsCheck = d0 => { const z = lv.zoho.BS[`BS-${d0}`] || lv.bsFor(d0); return z ? { date: d0, assets: r2(z.lines['bs.ta']), equityAndLiabilities: r2(z.lines['bs.tel']), difference: r2(z.lines['bs.ta'] - z.lines['bs.tel']) } : null; };
    const fyNow = P.fyOf(lv.cutoff);
    const liveBs = lv.live.BS[`BS-${fyNow}-03-31`];
    // exceptions by ledger and amount
    const ex = {
      unmapped: map.ledgers.filter(l => l.status === 'unmapped' && (Math.abs(l.tb.close) >= 1 || (l.zoho?.id && Math.abs(zVal(l.zoho.id, false)) >= 1))).map(l => ({ row: l.row, name: l.name, head: l.group, workbook: r2(l.tb.close / 1e5), zoho: l.zoho?.id ? r2(zVal(l.zoho.id, l.section === 'income' || l.section === 'expense') / 1e5) : null })),
      ambiguous: map.ledgers.filter(l => l.ambiguous || l.match === 'ambiguous' || (l.split && l.status === 'inferred')).map(l => ({ row: l.row, name: l.name, head: l.group, lines: Object.keys(l.lines), split: l.split, rule: l.rule, workbook: r2(l.tb.close / 1e5) })),
      signRepairs: map.meta.signIssues || [],
      workbookOnlyByLedger: map.ledgers.filter(l => Math.abs(l.tb.obe) >= 1).map(l => ({ row: l.row, name: l.name, head: l.group, obe: r2(l.tb.obe / 1e5), lines: Object.keys(l.obeLines || l.lines), nowInZoho: l.zoho?.id ? r2((zVal(l.zoho.id, l.section === 'income' || l.section === 'expense') - l.tb.close) / 1e5) : null })),
      workbookOnlyByLine: Object.values(map.lines).filter(ln => ln.leaf).flatMap(ln => ln.dropped.filter(x => !x.explainedBy && Math.abs(x.amount) >= 0.01).map(x => ({ line: ln.line, label: ln.label, cell: `${x.sheet.trim()}!${x.addr}`, kind: x.kind, amount: x.amount }))),
      schedules: Object.values(map.lines).filter(ln => ln.schedule).map(ln => ({ line: ln.line, label: ln.label, schedule: ln.schedule.sheet, workbook: ln.schedule.workbook, ledgers: ln.schedule.ledgerAmount, difference: ln.residual })),
      excluded: map.ledgers.filter(l => l.status === 'excluded').map(l => ({ row: l.row, name: l.name, rule: l.rule, workbook: r2(l.tb.close / 1e5) })),
      awaiting: lv.awaiting,
      anomalies: map.meta.anomalies,
      tciRule: map.meta.tciRule,
    };
    return {
      mapping: { file: map.meta.file, sheet: map.meta.sheet, reportingDate: map.meta.reportingDate, ytdPeriod: ytdP, bsPeriod: bsP, builtAt: map.meta.builtAt, counts: map.meta.counts },
      cutoff: lv.cutoff, lastSuccess: lc.st.lastSuccess?.at || null, bs: bsRows, pl: plRows, quarter: { id: qId, previous: prevId, rows: qRows },
      checks: { zohoAtWorkbookDate: bsCheck(map.meta.reportingDate), zohoAtCutoff: bsCheck(lv.cutoff), provisionalClosing: liveBs ? { date: `${fyNow}-03-31`, asAt: lv.cutoff, assets: r2(liveBs.lines['bs.ta']), equityAndLiabilities: r2(liveBs.lines['bs.tel']), difference: r2(liveBs.lines['bs.ta'] - liveBs.lines['bs.tel']) } : null,
        cashFlow: lv.facts.filter(f => f.s === 'CF' && f.l === 'cf.Z.x.difference').map(f => ({ period: f.p, role: f.role, difference: r2(f.v) })),
        notes: notesCheck(lc, M) },
      exceptions: ex,
    };
  }
  function notesCheck(lc, M0) {
    // every note total against its statement line, for the Zoho periods (Zoho's own figures) and the provisional ones
    const out = [];
    const ctxZ = M0.makeCtx(lc.merged, { ix: lc.ix, mode: 'zoho' });
    const ctxF = M0.makeCtx(lc.merged, { ix: lc.ix, mode: 'original' });
    const fyNow = P.fyOf(lc.lv.cutoff);
    for (const n of lc.lv.notes) {
      const t = n.items.find(i => i.total);
      if (!t) continue;
      for (const [p, c] of Object.entries(t.v)) {
        if (!(p === `BS-${fyNow}-03-31` || p === lc.map.meta.bsPeriod || p === lc.map.meta.ytdPeriod || P.fromId(p)?.end > lc.lv.finalEnd)) continue;
        const ctx = n.role === 'live' ? ctxF : ctxZ;
        const st = n.lines.map(l => M0.cell(ctx, 'SA', l, p).v).reduce((s, v) => (v == null ? s : (s || 0) + v), null);
        if (st == null) continue;
        out.push({ note: `${n.num} ${n.title}`, period: p, role: n.role, noteTotal: r2(c.v), statement: r2(st), difference: r2(c.v - st) });
      }
    }
    return out;
  }
  router.get('/mapping/recon', wrap(async (req, res) => res.json(await reconView())));
  router.get('/mapping/export', wrap(async (req, res) => {
    const v = await mappingView();
    const r = await reconView();
    if (!v) return bad(res, 404, 'No account mapping yet.');
    const meta = EX.contextMeta({ basis: 'SA', periods: `${v.meta.bsPeriod} / ${v.meta.ytdPeriod}`, zoho: r.cutoff ? { cutoff: r.cutoff, lastSuccess: r.lastSuccess } : null, filters: `mapping from ${v.meta.file} › ${v.meta.sheet}` });
    const lab = id => L.BY_ID[id]?.label || id;
    const sheets = [
      { name: 'Ledger mapping', title: 'Account mapping — every ledger', meta, columns: [
        { label: 'Zoho account ID', key: 'id', width: 22 }, { label: 'Ledger (workbook)', key: 'name', width: 44 }, { label: 'Zoho account name', key: 'zohoName', width: 40 }, { label: 'Workbook account head (grouping)', key: 'head', width: 36 },
        { label: 'Statement line(s)', get: x => x.lines.map(l => `${lab(l.line)}${l.coef != null && Math.abs(Math.abs(l.coef) - 1) > 1e-6 ? ` × ${l.coef}` : ''}`).join('; '), width: 50 },
        { label: 'Note / subheading', get: x => x.notes.map(n => `Note ${n.num} ${n.title} › ${n.label}`).join('; '), width: 60 }, { label: 'Rule', get: x => x.repaired?.why || x.rule || '', width: 70 },
        { label: 'Status', key: 'status' }, { label: 'Reviewed', get: x => (x.reviewed ? `${x.reviewed.by} ${x.reviewed.at.slice(0, 10)}` : '') },
        { label: 'Workbook TB (₹ lakh)', get: x => x.tb?.close ?? '' }, { label: 'OBE (₹ lakh)', get: x => x.tb?.obe ?? '' }, { label: `Zoho at ${v.meta.reportingDate} (₹ lakh)`, key: 'zMap' }, { label: `Zoho at ${v.cutoff} (₹ lakh)`, key: 'zNow' }], rows: v.rows },
    ];
    if (!r.error) {
      const lineCols = [{ label: 'Line', key: 'label', width: 50 }, { label: 'Final workbook', key: 'workbook' }, { label: 'Mapping on the workbook TB', key: 'mappedOnWorkbookTb' }, { label: 'Zoho Books now', key: 'zoho' }, { label: 'Difference (final − Zoho)', key: 'difference' },
        { label: 'Workbook-only adjustments', key: 'workbookOnly' }, { label: 'Schedule vs ledgers', key: 'schedule' }, { label: 'Zoho changes after the workbook', key: 'zohoChanges' }, { label: 'Other (roll-forward, new accounts, rounding)', key: 'other' }];
      sheets.push({ name: 'BS reconciliation', title: `Balance sheet ${r.mapping.bsPeriod}: final vs mapped Zoho`, meta, columns: lineCols, rows: r.bs });
      sheets.push({ name: 'P&L reconciliation', title: `P&L ${r.mapping.ytdPeriod}: final vs mapped Zoho`, meta, columns: lineCols, rows: r.pl });
      sheets.push({ name: 'Quarter check', title: `${r.quarter.id}: Zoho months vs final quarter`, meta, columns: [{ label: 'Line', key: 'label', width: 50 }, { label: 'Final quarter', key: 'finalQuarter' }, { label: 'Final YTD − previous', key: 'finalYtdLessPrevious' }, { label: 'Zoho months', key: 'zohoMonths' }, { label: 'Difference', key: 'difference' }, { label: 'of which: YTD difference', key: 'ytdDifference' }, { label: 'less: previous-period difference', key: 'previousDifference' }], rows: r.quarter.rows });
      const exRows = [
        ...r.exceptions.unmapped.map(x => ({ type: 'Unmapped', ...x })), ...r.exceptions.ambiguous.map(x => ({ type: 'Ambiguous / split', ...x, detail: x.rule })),
        ...r.exceptions.workbookOnlyByLedger.map(x => ({ type: 'Workbook-only (OBE)', ...x, amount: x.obe, detail: `now in Zoho: ${x.nowInZoho}` })), ...r.exceptions.workbookOnlyByLine.map(x => ({ type: 'Workbook-only (typed)', name: x.label, detail: x.cell, amount: x.amount })),
        ...r.exceptions.schedules.map(x => ({ type: 'Schedule vs ledgers', name: x.label, detail: x.schedule, amount: x.difference })), ...r.exceptions.excluded.map(x => ({ type: 'Excluded', ...x, detail: x.rule })),
        ...r.exceptions.awaiting.map(x => ({ type: x.suggested ? 'New Zoho account — suggested' : 'New Zoho account — awaiting mapping', name: x.name, detail: x.suggested || x.line, amount: x.amount, zoho: x.amount })),
        ...r.exceptions.signRepairs.map(x => ({ type: 'Sign repaired', name: x.name, detail: x.note || `${x.line} → ${x.to} (${x.typed})`, amount: x.amount })),
      ];
      sheets.push({ name: 'Exceptions', title: 'Exceptions by ledger and amount (₹ lakh)', meta, columns: [{ label: 'Type', key: 'type', width: 30 }, { label: 'Ledger / line', key: 'name', width: 50 }, { label: 'Head', key: 'head', width: 30 }, { label: 'Amount', get: x => x.amount ?? x.workbook ?? '' }, { label: 'Zoho', get: x => x.zoho ?? '' }, { label: 'Detail', key: 'detail', width: 80 }], rows: exRows });
    }
    xlsxOut(res, 'Account_mapping_and_reconciliation.xlsx', EX.workbook(sheets));
  }));
}

module.exports = { mount, scheduler, nextRunAt, finalEndOf, RUN_MINUTE_IST };
