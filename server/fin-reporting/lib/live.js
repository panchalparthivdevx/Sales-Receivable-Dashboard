/**
 * Financial Reporting — statement figures from the Zoho Books ledger (gl.js) through the account mapping (acmap.js).
 *
 * Two kinds of Zoho figures, both kept apart from the imported (final) figures:
 *   role 'zoho'  "Provisional – Zoho Books": Zoho's own balances through the mapping, for every period the ledger covers (FY 2025-26
 *                onwards). Lines the workbook rolls forward from an opening balance (other equity, deferred tax) use Zoho's own
 *                balances here (share premium, Zoho's retained earnings, the deferred-tax ledger), so this balance sheet balances
 *                in Zoho's terms; its difference from the final figures is what Account Mapping → Reconciliation explains.
 *   role 'live'  the default view of an OPEN period (after the latest final workbook): the latest final figure rolled forward with
 *                Zoho's movement since — balance sheet = final balance sheet at the latest final date + Zoho's movement to the cut-off;
 *                nine months / year = final half year + Zoho's months after it; a quarter after the final one is Zoho's own.
 *                A later Zoho edit to a finalised period therefore never changes a reported figure (it shows under "Provisional").
 * Every Zoho figure carries the accounting cut-off date (the date the ledger was read to), kept apart from the sync time.
 * Accounts Zoho has that the mapping does not place are never dropped: they go on "awaiting mapping" lines so totals still add up.
 */

'use strict';

const P = require('./periods');
const L = require('./lines');
const G = require('./gl');
const { LEAF_PL, LEAF_BS } = require('./acmap');

const r2 = v => (v == null ? v : Math.round(v * 100) / 100);
const PL_TYPES = /^(income|other_income|expense|cost_of_goods_sold|other_expense)$/;
const ASSET_TYPES = /asset|bank|cash|receivable|stock|input_tax|payment_clearing/;
const AWAIT = {
  'bs.x.await_assets': { label: 'Accounts awaiting mapping — assets (Zoho)', sec: 'ca' },
  'bs.x.await_liab': { label: 'Accounts awaiting mapping — liabilities and equity (Zoho)', sec: 'cl' },
  'pl.x.await_inc': { label: 'Income accounts awaiting mapping (Zoho)' },
  'pl.x.await_exp': { label: 'Expense accounts awaiting mapping (Zoho)' },
};
const CF_LABELS = {
  'cf.A.x.oci': 'Remeasurement of defined benefit plans (OCI, non-cash)',
  'cf.A.x.wc_receivables': '(Increase)/decrease in trade receivables',
  'cf.A.x.wc_other_assets': '(Increase)/decrease in other assets',
  'cf.A.x.wc_payables': 'Increase/(decrease) in trade payables',
  'cf.A.x.wc_other_liab': 'Increase/(decrease) in other liabilities and provisions',
  'cf.A.x.deferred_tax': 'Deferred tax charge (non-cash)',
  'cf.B.x.fixed_deposits': '(Investment in) / redemption of fixed deposits (net)',
  'cf.Z.x.bs_cash': 'Cash and cash equivalents as per the balance sheet',
  'cf.Z.x.difference': 'Difference to the balance sheet (nil when every line is classified)',
};
const SEC_SIGN = id => { const sec = L.BY_ID[id]?.sec; return sec === 'nca' || sec === 'ca' ? 1 : sec === 'eq' || sec === 'ncl' || sec === 'cl' ? -1 : 0; };

/**
 * The mapping in force: the workbook mapping with the reviewer's edits on top.
 * edits: { [zohoId]: { line, sign, note, reviewed, by, at, comment, exclude } }
 */
function effectiveMapping(map, edits = {}, accounts = {}) {
  const byId = {};
  for (const l of map.ledgers) {
    if (!l.zoho?.id) continue;
    const prev = byId[l.zoho.id];
    if (prev) { prev.rows.push(l.row); continue; }
    byId[l.zoho.id] = { id: l.zoho.id, name: l.zoho.name, rows: [l.row], group: l.group, section: l.section, status: l.status, rule: l.rule || null, lines: l.lines, notes: l.notes,
      split: l.split || null, zohoLine: l.zohoLine || null, source: 'workbook', ambiguous: !!l.ambiguous, nil: !!l.nil, repaired: l.repaired || null };
  }
  for (const [id, e] of Object.entries(edits)) {
    const cur = byId[id] || { id, name: accounts[id]?.n || id, rows: [], group: null, section: null, lines: {}, notes: {}, source: 'edit' };
    if (e.exclude) Object.assign(cur, { lines: {}, notes: {}, zohoLine: null, status: 'excluded', rule: `excluded by ${e.by || 'a reviewer'}${e.comment ? ` — ${e.comment}` : ''}`, source: 'edit' });
    else if (e.line) {
      const coef = (e.sign === -1 ? -1 : e.sign === 1 ? 1 : (SEC_SIGN(e.line) || (/^pl\.(rev|oth_inc|oci)/.test(e.line) ? -1 : 1))) * 1e-5;
      Object.assign(cur, { lines: { [e.line]: { close: coef } }, notes: e.note ? { [e.note]: { close: coef } } : {}, zohoLine: null, status: 'edited', rule: `set by ${e.by || 'a reviewer'}${e.comment ? ` — ${e.comment}` : ''}`, split: null, source: 'edit' });
    }
    if (e.reviewed) cur.reviewed = { by: e.by, at: e.at };
    byId[id] = cur;
  }
  return byId;
}

function createLive({ map, edits, ds, version, finalCtx, M }) {
  const st = ds.state;
  const accounts = st.accounts;
  const byId = effectiveMapping(map, edits, accounts);
  const mapFy = P.fyOf(map.meta.reportingDate);
  const cutoff = ds.cutoff;
  const windowStart = `${st.windowFrom || G.WINDOW_FROM}-01`;
  const typeOf = id => accounts[id]?.t || ds.typeOf(id) || null;
  const isPL = id => { const t = typeOf(id); if (t) return PL_TYPES.test(t); const m = byId[id]; return m ? m.section === 'income' || m.section === 'expense' : false; };
  const rollForward = new Set(Object.entries(map.lines).filter(([, ln]) => ln.leaf && ln.carried.some(c => c.rule === 'opening')).map(([k]) => k));
  const ymOf = d => d.slice(0, 7);

  // ── suggestions for accounts the mapping does not place (parent account, else most siblings) ──
  const sugMemo = new Map();
  const childrenOf = new Map();
  for (const [id, a] of Object.entries(accounts)) if (a.p) { if (!childrenOf.has(a.p)) childrenOf.set(a.p, []); childrenOf.get(a.p).push(id); }
  const placed = m => (m && Object.keys(m.lines).length && m.status !== 'excluded' ? m : null);
  function suggest(id) {
    if (sugMemo.has(id)) return sugMemo.get(id);
    const a = accounts[id];
    let out = null;
    if (a?.p) {
      const parent = placed(byId[a.p]);
      if (parent) out = { from: `parent account "${accounts[a.p]?.n || a.p}"`, lines: parent.lines, notes: parent.notes };
      else {
        const sibs = (childrenOf.get(a.p) || []).filter(x => x !== id).map(x => placed(byId[x])).filter(Boolean);
        if (sibs.length) {
          const tally = {};
          for (const sb of sibs) { const k = Object.keys(sb.lines).sort().join('+'); (tally[k] = tally[k] || []).push(sb); }
          const best = Object.values(tally).sort((x, y) => y.length - x.length)[0];
          if (best.length / sibs.length >= 0.8) out = { from: `${best.length} of ${sibs.length} other accounts under "${a.pn || accounts[a.p]?.n}"`, lines: best[0].lines, notes: best[0].notes };
        }
      }
    }
    sugMemo.set(id, out);
    return out;
  }

  // ── balances ──
  const balMemo = new Map();
  function bsBalances(date) {
    if (balMemo.has(`B|${date}`)) return balMemo.get(`B|${date}`);
    let out = null;
    const snap = ds.tbs[date];
    const open = ds.opening(date);
    const mv = open ? ds.range(G.fyStartOf(date).slice(0, 7), ymOf(date)) : null;
    if (open && mv) {
      const vals = new Map();
      for (const [id, net] of Object.entries(open.acc)) if (!isPL(id)) vals.set(id, { close: net, open: net, dr: 0, cr: 0 });
      for (const [id, [dr, cr]] of mv) { if (isPL(id)) continue; const o = vals.get(id) || { close: 0, open: 0, dr: 0, cr: 0 }; o.close += dr - cr; o.dr += dr; o.cr += cr; vals.set(id, o); }
      // Zoho's retained earnings at the start of the year: its own figure + last year's income and expense (closed on 1 April)
      let reOpen = open.re;
      for (const [id, net] of Object.entries(open.acc)) if (isPL(id)) reOpen += net;
      out = { vals, reOpen, plFytd: null };
    } else if (snap) {
      // a trial balance held for exactly this date (the earliest opening balance): balances as they are, income and expense = the year
      const vals = new Map(), pl = new Map();
      for (const [id, net] of Object.entries(snap.acc)) { if (isPL(id)) pl.set(id, { close: net, open: 0, dr: Math.max(net, 0), cr: Math.max(-net, 0) }); else vals.set(id, { close: net, open: net, dr: 0, cr: 0 }); }
      out = { vals, reOpen: snap.re, plFytd: pl };
    }
    balMemo.set(`B|${date}`, out);
    return out;
  }
  function flows(fromYm, toYm) {
    const k = `F|${fromYm}|${toYm}`;
    if (balMemo.has(k)) return balMemo.get(k);
    const mv = ds.range(fromYm, toYm);
    let out = null;
    if (mv) { const vals = new Map(); for (const [id, [dr, cr]] of mv) if (isPL(id)) vals.set(id, { close: dr - cr, open: 0, dr, cr }); out = { vals }; }
    balMemo.set(k, out);
    return out;
  }

  // ── statement lines from balances ──
  const ev = (slot, v) => { let x = 0; for (const code of ['close', 'open', 'dr', 'cr']) if (slot[code]) x += slot[code] * (v[code] || 0); return x; };
  // in Zoho's own terms a line rolled forward by the workbook takes the ledger's closing balance (opening + debits − credits)
  const closeCoef = slot => slot.close || slot.dr || (slot.cr ? -slot.cr : 0) || slot.open || 0;
  function apply(vals, kind, { date, tciFytd = 0, reOpen = null } = {}) {
    const lines = {}, notes = {}, awaiting = [];
    const add = (line, x) => { lines[line] = (lines[line] || 0) + x; };
    for (const [id, v] of vals) {
      let m = byId[id];
      if (m && m.status === 'zero' && !Object.keys(m.lines).length) m = null;      // a workbook ledger that had no amount then
      let sug = null;
      if (!m || (!Object.keys(m.lines).length && m.status !== 'excluded' && !m.zohoLine)) { sug = suggest(id); if (sug) m = { lines: sug.lines, notes: sug.notes, status: 'suggested' }; }
      if (!m || (!Object.keys(m.lines).length && !m.zohoLine && m.status !== 'excluded')) {
        if (Math.abs(v.close) < 0.5 && Math.abs(v.dr) < 0.5 && Math.abs(v.cr) < 0.5) continue;
        const t = typeOf(id) || '';
        const line = kind === 'PL' ? (/income/.test(t) ? 'pl.x.await_inc' : 'pl.x.await_exp') : (ASSET_TYPES.test(t) || (!t && v.close > 0) ? 'bs.x.await_assets' : 'bs.x.await_liab');
        const val = (kind === 'PL' ? (line === 'pl.x.await_inc' ? -v.close : v.close) : (line === 'bs.x.await_assets' ? v.close : -v.close)) / 1e5;
        add(line, val);
        awaiting.push({ id, name: accounts[id]?.n || id, type: t || null, line, amount: r2(val), first: accounts[id]?.first || null, created: accounts[id]?.created || null });
        continue;
      }
      if (kind === 'BS' && m.zohoLine && !Object.keys(m.lines).length) { add(m.zohoLine.line, (SEC_SIGN(m.zohoLine.line) || Math.sign(m.zohoLine.coef)) * 1e-5 * v.close); continue; }
      const fd = /fixed deposits?/i.test(m.group || '');
      for (const [line, slot] of Object.entries(m.lines)) {
        if ((line.startsWith('pl.') ? 'PL' : 'BS') !== kind) continue;
        let x;
        if (kind === 'BS' && rollForward.has(line)) { if (isPL(id)) continue; x = closeCoef(slot) * v.close; }
        else x = ev(slot, v);
        add(line, x);
        if (fd) add(`${line}#fd`, x);
      }
      for (const [key, slot] of Object.entries(m.notes || {})) notes[key] = (notes[key] || 0) + (kind === 'BS' && map.noteItems[key]?.lines.some(l => rollForward.has(l)) ? closeCoef(slot) * v.close : ev(slot, v));
      if (sug) awaiting.push({ id, name: accounts[id]?.n || id, type: typeOf(id), suggested: sug.from, line: Object.keys(sug.lines)[0], amount: r2(Object.values(sug.lines).reduce((t, sl) => t + ev(sl, v), 0)), first: accounts[id]?.first || null, created: accounts[id]?.created || null });
    }
    if (kind === 'BS') {
      // other equity in Zoho's terms: its equity ledgers + Zoho's retained earnings at the start of the year + profit for the year to date
      if (rollForward.has('bs.oth_eq')) add('bs.oth_eq', (reOpen != null ? -reOpen / 1e5 : 0) + tciFytd);
      // a split typed in the workbook between two lines (current maturities, MSME dues, lease split) is as at its date: its year only
      if (P.fyOf(date) === mapFy) for (const [line, ln] of Object.entries(map.lines)) if (ln.leaf && ln.stmt === 'BS') for (const c of ln.carried) if (c.rule === 'allocation') add(line, c.amount);
    }
    return { lines, notes, awaiting };
  }

  const mapLeaf = new Set(Object.keys(map.lines).filter(l => map.lines[l].leaf));
  function totals(lines, kind) {
    const v = { ...lines };
    for (const l of (kind === 'PL' ? LEAF_PL : LEAF_BS)) if (mapLeaf.has(l) && v[l] == null) v[l] = 0;
    const g = id => v[id] || 0;
    if (kind === 'PL') {
      v['pl.tot_inc'] = g('pl.rev') + g('pl.oth_inc') + g('pl.x.await_inc');
      v['pl.exp_tot'] = g('pl.exp_ops') + g('pl.exp_emp') + g('pl.exp_fin') + g('pl.exp_dep') + g('pl.exp_oth') + g('pl.x.await_exp');
      v['pl.pbe'] = v['pl.tot_inc'] - v['pl.exp_tot'];
      v['pl.pbt'] = v['pl.pbe'] - g('pl.exceptional') + g('pl.share_assoc');
      v['pl.tax_tot'] = g('pl.tax_cur') + g('pl.tax_def') + g('pl.tax_prior');
      v['pl.pat'] = v['pl.pbt'] - v['pl.tax_tot'];
      v['pl.oci_tot'] = g('pl.oci_nr') + g('pl.oci_nr_tax') + g('pl.oci_r') + g('pl.oci_r_tax');
      v['pl.tci'] = v['pl.pat'] + v['pl.oci_tot'];
    } else {
      for (const l of L.BS) if (l.sum && !l.cons && !['bs.ta', 'bs.tel', 'bs.eq_tot'].includes(l.id)) v[l.id] = l.sum.reduce((t, id) => t + g(id), 0) + (l.id === 'bs.ca_tot' ? g('bs.x.await_assets') : 0) + (l.id === 'bs.cl_tot' ? g('bs.x.await_liab') : 0);
      v['bs.ta'] = g('bs.nca_tot') + g('bs.ca_tot');
      v['bs.eq_tot'] = g('bs.share_cap') + g('bs.oth_eq');
      v['bs.tel'] = g('bs.eq_tot') + g('bs.ncl_tot') + g('bs.cl_tot');
    }
    return v;
  }

  // ── Zoho figures for a period ──
  const memo = new Map();
  function plFor(period) {
    const key = `PL|${period.start}|${period.end}`;
    if (memo.has(key)) return memo.get(key);
    let out = null;
    if (period.start <= cutoff && period.start >= windowStart) {
      const f = flows(ymOf(period.start), ymOf(period.end > cutoff ? cutoff : period.end));
      if (f) { const a = apply(f.vals, 'PL'); out = { lines: totals(a.lines, 'PL'), notes: a.notes, awaiting: a.awaiting, asAt: period.end > cutoff ? cutoff : null }; }
    }
    memo.set(key, out);
    return out;
  }
  function bsFor(date) {
    const asAt = date > cutoff ? cutoff : date;
    const key = `BS|${date}`;
    if (memo.has(key)) return memo.get(key);
    let out = null;
    const b = bsBalances(asAt);
    if (b) {
      let tci = 0;
      if (b.plFytd) tci = totals(apply(b.plFytd, 'PL').lines, 'PL')['pl.tci'];
      else { const pl = plFor({ start: G.fyStartOf(asAt), end: asAt }); tci = pl ? pl.lines['pl.tci'] : 0; }
      const a = apply(b.vals, 'BS', { date: asAt, tciFytd: tci, reOpen: b.reOpen });
      out = { lines: totals(a.lines, 'BS'), notes: a.notes, awaiting: a.awaiting, asAt: asAt !== date ? asAt : null };
    }
    memo.set(key, out);
    return out;
  }

  // ── which periods ──
  const fyNow = P.fyOf(cutoff);
  const fyFirst = P.fyOf(`${windowStart.slice(0, 7)}-28`);
  const flowIds = [], bsIds = [];
  for (let fy = fyFirst; fy <= fyNow; fy++) {
    for (const s of ['Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2', '9M', 'FY']) { const p = P.fromId(`FY${fy}-${s}`); if (p && p.start <= cutoff && p.start >= windowStart) flowIds.push(p.id); }
    for (const q of [`${fy - 1}-06-30`, `${fy - 1}-09-30`, `${fy - 1}-12-31`, `${fy}-03-31`]) if (q <= cutoff) bsIds.push(`BS-${q}`);
  }
  const openBs = G.dayBefore(windowStart);
  if (ds.tbs[openBs]) bsIds.unshift(`BS-${openBs}`);
  if (!bsIds.includes(`BS-${fyNow}-03-31`)) bsIds.push(`BS-${fyNow}-03-31`);   // the year's closing column, at the cut-off date until year end

  // ── final figures (imported workbooks only) ──
  const finalVal = (l, p) => { if (!finalCtx) return null; const c = M.cell(finalCtx, 'SA', l, p); return c && c.v != null ? c.v : c && c.blank ? 0 : null; };
  let finalEnd = '0000-00-00', latestFinalBs = null;
  for (const fc of version.facts) {
    if (fc.zoho || fc.role === 'working' || fc.st !== 'ok' || fc.b !== 'SA') continue;
    const p = P.fromId(fc.p);
    if (!p) continue;
    if (p.end > finalEnd) finalEnd = p.end;
    if (fc.s === 'BS' && (!latestFinalBs || p.end > latestFinalBs)) latestFinalBs = p.end;
  }

  const facts = [];
  const flags = {};
  const flag = (k, t) => { (flags[k] = flags[k] || []).push(t); };
  const push = (s, l, p, v, role, extra = {}) => {
    if (v == null || !Number.isFinite(v) || l.includes('#')) return;
    facts.push({ b: 'SA', s, l, p, v: Math.round(v * 1e6) / 1e6, st: 'ok', u: L.BY_ID[l]?.unit === 'inr' ? 'inr' : 'lakh', f: -1, sh: role === 'live' ? 'Zoho Books (rolled forward from the final figures)' : 'Zoho Books', c: '', role, k: 'ZOHO', zoho: 1, lbl: L.BY_ID[l]?.label || AWAIT[l]?.label || CF_LABELS[l] || l, ...extra });
  };
  const plLines = [...LEAF_PL, 'pl.tot_inc', 'pl.exp_tot', 'pl.pbe', 'pl.pbt', 'pl.tax_tot', 'pl.pat', 'pl.oci_tot', 'pl.tci', 'pl.x.await_inc', 'pl.x.await_exp'];
  const bsLines = [...LEAF_BS, ...L.BS.filter(l => l.sum && !l.cons).map(l => l.id), 'bs.x.await_assets', 'bs.x.await_liab'];
  const eqIds = Object.values(byId).filter(m => /^equity share capital$/i.test((m.name || '').trim())).map(m => m.id);
  const paidUp = date => { const b = bsBalances(date > cutoff ? cutoff : date); if (!b || !eqIds.length) return null; return eqIds.reduce((t, id) => t - (b.vals.get(id)?.close || 0), 0) / 1e5; };
  function epsFacts(lines, pid, role, asAt) {
    const per = P.fromId(pid);
    const pu = paidUp(per.end);
    if (!pu || lines['pl.pat'] == null) return;
    const eps = lines['pl.pat'] * 1e5 / (pu * 1e5 / 2);            // shares of ₹2 in issue at the period end — not the weighted average
    for (const l of ['pl.eps_basic', 'pl.eps_diluted']) push('PL', l, pid, Math.round(eps * 1e4) / 1e4, role, { u: 'inr', ...(asAt ? { asAt } : {}), pending: 'Uses the shares in issue at the period end; the weighted average number of shares is a management input.' });
    push('PL', 'pl.paidup', pid, pu, role);
  }

  // pure Zoho figures
  const zoho = { PL: {}, BS: {} };
  for (const pid of flowIds) {
    const r = plFor(P.fromId(pid));
    if (!r) continue;
    zoho.PL[pid] = r;
    for (const l of plLines) if (r.lines[l] != null) push('PL', l, pid, r.lines[l], 'zoho', r.asAt ? { asAt: r.asAt } : {});
    epsFacts(r.lines, pid, 'zoho', r.asAt);
  }
  for (const pid of bsIds) {
    const r = bsFor(P.fromId(pid).end);
    if (!r) continue;
    zoho.BS[pid] = r;
    for (const l of bsLines) if (r.lines[l] != null) push('BS', l, pid, r.lines[l], 'zoho', r.asAt ? { asAt: r.asAt } : {});
  }

  // open periods: final figures rolled forward with Zoho's movement since the latest final date
  const live = { PL: {}, BS: {} };
  if (finalEnd > '0000') {
    for (const pid of flowIds) {
      const per = P.fromId(pid);
      if (per.end <= finalEnd) continue;
      const z = zoho.PL[pid];
      if (!z) continue;
      let lines;
      if (per.start > finalEnd) lines = z.lines;
      else {
        const finalP = ['Q1', 'H1', '9M'].map(s => P.fromId(`FY${per.fy}-${s}`)).find(p => p.end === finalEnd && p.start === per.start);
        const after = plFor({ start: `${G.addMonths(finalEnd.slice(0, 7), 1)}-01`, end: per.end });
        if (!finalP || !after) continue;
        const leaf = {};
        for (const l of [...LEAF_PL, 'pl.x.await_inc', 'pl.x.await_exp']) { const fv = finalVal(l, finalP.id); leaf[l] = (fv != null ? fv : (zoho.PL[finalP.id]?.lines[l] || 0)) + (after.lines[l] || 0); }
        lines = totals(leaf, 'PL');
        flag(`PL|${pid}`, `${finalP.short} as finally reported + Zoho Books ${P.fromId(`FY${per.fy}-Q${({ 6: 2, 9: 3, 12: 4 })[+finalEnd.slice(5, 7)] || 4}`)?.short || 'months'} onwards to ${z.asAt || per.end}.`);
      }
      live.PL[pid] = { lines, asAt: z.asAt };
      for (const l of plLines) if (lines[l] != null) push('PL', l, pid, lines[l], 'live', z.asAt ? { asAt: z.asAt } : {});
      epsFacts(lines, pid, 'live', z.asAt);
    }
    if (latestFinalBs) {
      const base = bsFor(latestFinalBs);
      for (const pid of bsIds) {
        const end = P.fromId(pid).end;
        if (end <= finalEnd || !base) continue;
        const z = zoho.BS[pid];
        if (!z) continue;
        const leaf = {};
        for (const l of [...LEAF_BS, 'bs.x.await_assets', 'bs.x.await_liab']) { const fv = finalVal(l, `BS-${latestFinalBs}`); leaf[l] = (fv != null ? fv : (base.lines[l] || 0)) + ((z.lines[l] || 0) - (base.lines[l] || 0)); }
        for (const k of Object.keys(z.lines)) if (k.includes('#')) leaf[k] = z.lines[k];
        const t = totals(leaf, 'BS');
        live.BS[pid] = { lines: t, asAt: z.asAt, base: latestFinalBs };
        for (const l of bsLines) if (t[l] != null) push('BS', l, pid, t[l], 'live', { ...(z.asAt ? { asAt: z.asAt } : {}), base: latestFinalBs });
        flag(`BS|${pid}`, `Balance sheet as at ${P.fromId(`BS-${latestFinalBs}`).headerDate} as finally reported + Zoho Books movement to ${z.asAt || end}.`);
      }
    }
  }

  // lines Zoho usually gets only at the quarter end (depreciation, tax, Ind AS entries): nil in an open period → pending, not nil
  for (const [pid, r] of Object.entries(zoho.PL)) {
    if (!r.asAt) continue;
    const per = P.fromId(pid);
    const prevQ = P.fromId(per.type === 'Q' ? (per.q === 1 ? `FY${per.fy - 1}-Q4` : `FY${per.fy}-Q${per.q - 1}`) : null) || null;
    const ref = prevQ ? zoho.PL[prevQ.id] : null;
    if (!ref) continue;
    for (const l of ['pl.exp_dep', 'pl.tax_cur', 'pl.tax_def', 'pl.oci_nr', 'pl.oci_nr_tax', 'pl.exp_fin', 'pl.oth_inc', 'pl.exceptional']) {
      const now = r.lines[l] || 0, before = ref.lines[l] || 0;
      if (Math.abs(now) < 0.5 && Math.abs(before) >= 1) flag(`PENDING|${pid}|${l}`, `${L.BY_ID[l].label}: nil so far in ${per.short} (₹${r2(before)} lakh in ${prevQ.short}) — Zoho usually receives it at the quarter end; treat as pending.`);
    }
  }
  for (const f of facts) { const k = `PENDING|${f.p}|${f.l}`; if (flags[k]) f.pending = flags[k][0]; }
  // the 9M / year built on an open quarter inherit its pending lines
  for (const f of facts) if (!f.pending && f.asAt && f.s === 'PL') { const q = flowIds.find(id => P.fromId(id).type === 'Q' && P.fromId(id).end > cutoff && P.fromId(id).start <= cutoff); if (q && flags[`PENDING|${q}|${f.l}`]) f.pending = flags[`PENDING|${q}|${f.l}`][0]; }

  // ── cash flow (indirect method) for the half year, nine months and year, from the balance sheets at both ends ──
  function noteSum(pid, re, line) {
    const per = P.fromId(pid);
    const z = per ? plFor(per) : null;
    if (!z) return 0;
    let s = 0;
    for (const [key, v] of Object.entries(z.notes)) { const it = map.noteItems[key]; if (it && it.lines.includes(line) && re.test(it.label)) s += v; }
    return s;
  }
  function cashFlow(pl, o, c, zo, zc, pid) {
    const d = id => (c[id] || 0) - (o[id] || 0);
    const p = id => pl[id] || 0;
    const L2 = {};
    const fl = [];
    const intInc = noteSum(pid, /interest/i, 'pl.oth_inc');
    const leaseInt = noteSum(pid, /lease/i, 'pl.exp_fin');
    const dFdNc = (zc?.['bs.nc_ofa#fd'] || 0) - (zo?.['bs.nc_ofa#fd'] || 0);
    L2['cf.pbt'] = p('pl.pbt');
    L2['cf.dep'] = p('pl.exp_dep');
    L2['cf.fin_cost'] = p('pl.exp_fin');
    L2['cf.int_inc'] = -intInc;
    L2['cf.A.x.oci'] = p('pl.oci_nr') + p('pl.oci_r');
    L2['cf.op_bwc'] = L2['cf.pbt'] + L2['cf.dep'] + L2['cf.fin_cost'] + L2['cf.int_inc'] + L2['cf.A.x.oci'];
    L2['cf.A.x.wc_receivables'] = -d('bs.tr');
    L2['cf.A.x.wc_other_assets'] = -(d('bs.c_other') + d('bs.nc_other') + d('bs.c_ofa') + d('bs.inventories') + d('bs.x.await_assets') + d('bs.nc_ofa') - dFdNc);
    L2['cf.A.x.wc_payables'] = d('bs.cl_tp_msme') + d('bs.cl_tp_other');
    L2['cf.A.x.wc_other_liab'] = ['bs.cl_ofl', 'bs.ncl_ofl', 'bs.cl_other', 'bs.ncl_other', 'bs.cl_prov', 'bs.ncl_prov', 'bs.x.await_liab'].reduce((t, x) => t + d(x), 0);
    L2['cf.wc'] = L2['cf.A.x.wc_receivables'] + L2['cf.A.x.wc_other_assets'] + L2['cf.A.x.wc_payables'] + L2['cf.A.x.wc_other_liab'];
    L2['cf.cash_gen'] = L2['cf.op_bwc'] + L2['cf.wc'];
    L2['cf.tax_paid'] = -(p('pl.tax_cur') + p('pl.tax_prior')) - d('bs.cta') - d('bs.nc_ita') + d('bs.cl_ctl');
    // deferred tax: the charge in profit (and the tax effect on OCI, which reaches equity through total comprehensive income) against
    // the change in the deferred-tax balances — nil when the balances move only by those charges
    L2['cf.A.x.deferred_tax'] = -p('pl.tax_def') + p('pl.oci_nr_tax') + p('pl.oci_r_tax') - d('bs.dta') + d('bs.ncl_dtl');
    L2['cf.cfo'] = L2['cf.cash_gen'] + L2['cf.tax_paid'] + L2['cf.A.x.deferred_tax'];
    L2['cf.capex'] = -(d('bs.ppe') + d('bs.cwip') + d('bs.intang') + d('bs.intang_dev') + d('bs.goodwill') + d('bs.rou') + p('pl.exp_dep'));
    L2['cf.inv_buy'] = -(d('bs.nc_inv') + d('bs.c_inv'));
    L2['cf.loans_given'] = -(d('bs.nc_loans') + d('bs.c_loans'));
    L2['cf.int_recd'] = intInc;
    L2['cf.B.x.fixed_deposits'] = -(d('bs.obank') + dFdNc);
    L2['cf.cfi'] = L2['cf.capex'] + L2['cf.inv_buy'] + L2['cf.loans_given'] + L2['cf.int_recd'] + L2['cf.B.x.fixed_deposits'];
    L2['cf.borrow_in'] = d('bs.ncl_borrow') + d('bs.cl_borrow');
    L2['cf.int_paid'] = -(p('pl.exp_fin') - leaseInt);
    L2['cf.int_lease'] = -leaseInt;
    L2['cf.lease_principal'] = d('bs.ncl_lease') + d('bs.cl_lease');
    L2['cf.shares'] = d('bs.share_cap') + d('bs.oth_eq') - p('pl.tci');
    L2['cf.cff'] = L2['cf.borrow_in'] + L2['cf.int_paid'] + L2['cf.int_lease'] + L2['cf.lease_principal'] + L2['cf.shares'];
    L2['cf.net'] = L2['cf.cfo'] + L2['cf.cfi'] + L2['cf.cff'];
    L2['cf.open'] = o['bs.cash'] || 0;
    L2['cf.close'] = L2['cf.open'] + L2['cf.net'];
    L2['cf.Z.x.bs_cash'] = c['bs.cash'] || 0;
    L2['cf.Z.x.difference'] = L2['cf.close'] - L2['cf.Z.x.bs_cash'];
    fl.push('Needs a supporting schedule: purchase of PPE includes right-of-use additions (non-cash, Ind AS 116) and the lease line nets new leases with principal repaid — the lease schedule separates them.');
    fl.push('Needs a supporting schedule: investments move with the share of LLP profit and fair-value changes (non-cash) — the investment schedule separates them; interest received assumes interest income was received in the period.');
    fl.push('Needs a management input: borrowings are shown net (proceeds less repayments); the Loan Master / bank statements give the gross figures.');
    if (Math.abs(L2['cf.Z.x.difference']) >= 0.01) fl.push(`Closing cash per this cash flow differs from the balance sheet by ₹${r2(L2['cf.Z.x.difference'])} lakh.`);
    else fl.push('Closing cash and cash equivalents agree with the balance sheet.');
    return { lines: L2, flags: fl };
  }
  for (const [role, src] of [['zoho', zoho], ['live', live]]) {
    for (const pid of flowIds) {
      const per = P.fromId(pid);
      if (!['H', '9M', 'FY'].includes(per.type) || (per.type === 'H' && per.h === 2)) continue;
      if (role === 'live' && per.end <= finalEnd) continue;
      if (per.end > cutoff && !['9M', 'FY'].includes(per.type)) continue;
      const closeId = per.end > cutoff ? `BS-${fyNow}-03-31` : `BS-${per.end}`;
      const openId = `BS-${G.dayBefore(per.start)}`;
      const pl = src.PL[pid];
      const zc = zoho.BS[closeId], zo = zoho.BS[openId];
      const bc = role === 'live' ? live.BS[closeId] : zc;
      const bo = role === 'live' ? { lines: Object.fromEntries([...LEAF_BS, 'bs.x.await_assets', 'bs.x.await_liab'].map(l => [l, finalVal(l, openId) ?? zo?.lines[l] ?? 0])) } : zo;
      if (!pl || !bc || !bo) continue;
      const r = cashFlow(pl.lines, totals(bo.lines, 'BS'), bc.lines, zo?.lines, zc?.lines, pid);
      const asAt = per.end > cutoff ? cutoff : null;
      flags[`CF|${role}|${pid}`] = r.flags;
      for (const [l, v] of Object.entries(r.lines)) push('CF', l, pid, v, role, { ...(asAt ? { asAt } : {}), lbl: CF_LABELS[l] || L.BY_ID[l]?.label || l });
    }
  }

  // ── notes: each note item of the mapping workbook from the ledgers mapped to it ──
  const notesOut = (() => {
    const byNote = new Map();
    for (const it of Object.values(map.noteItems)) {
      const k = `${it.sheet}|${it.num}|${it.title}`;
      if (!byNote.has(k)) byNote.set(k, { b: 'SA', f: -1, sheet: 'Zoho Books', srcSheet: it.sheet, num: it.num, title: it.title, lines: it.lines, items: [], zoho: 1 });
      byNote.get(k).items.push({ label: it.label, key: it.key, total: it.total || undefined, v: {}, fromZoho: it.ledgers > 0 || (it.carried || []).length > 0, carried: (it.carried || []).reduce((t, c) => t + c.amount, 0) });
    }
    const add = (pid, notes, role, asAt, isBs) => {
      for (const n of byNote.values()) {
        if (n.lines.some(l => l.startsWith('bs.')) !== isBs) continue;
        // a note the workbook builds from its own working (deferred tax, other equity) has no Zoho-only version
        if (n.lines.some(l => rollForward.has(l))) continue;
        let tot = 0, any = false;
        for (const it of n.items) {
          if (it.total) continue;
          if (!it.fromZoho && notes[it.key] == null) continue;            // typed in the workbook (a schedule): not a Zoho figure
          const val = (notes[it.key] || 0) + (it.carried && P.fyOf(P.fromId(pid).end > cutoff ? cutoff : P.fromId(pid).end) === mapFy && isBs ? it.carried : 0);
          it.v[pid] = { v: val, st: 'ok', role, ...(asAt ? { asAt } : {}) };
          tot += val; any = true;
        }
        // the total row from its own ledgers (the workbook's total formula), else the sum of the items
        const t = n.items.filter(i => i.total).pop();
        if (t && any) {
          const own = t.fromZoho ? (notes[t.key] || 0) + (t.carried && P.fyOf(P.fromId(pid).end > cutoff ? cutoff : P.fromId(pid).end) === mapFy && isBs ? t.carried : 0) : null;
          t.v[pid] = { v: own != null ? own : tot, st: 'ok', role, ...(asAt ? { asAt } : {}) };
          for (const i of n.items) if (i.total && i !== t && i.fromZoho) i.v[pid] = { v: notes[i.key] || 0, st: 'ok', role, ...(asAt ? { asAt } : {}) };
        }
      }
    };
    for (const [pid, r] of Object.entries(zoho.PL)) add(pid, r.notes, 'zoho', r.asAt, false);
    for (const [pid, r] of Object.entries(zoho.BS)) add(pid, r.notes, 'zoho', r.asAt, true);
    const zNotes = [...byNote.values()].filter(n => n.items.some(i => Object.keys(i.v).length)).map(n => ({ ...n, role: 'zoho' }));

    // open periods: the final note rolled forward like its statement line (final item at the latest final date + Zoho's movement)
    const mapFile = version.files.findIndex(f => f.sha256 === map.meta.sha256 || f.name === map.meta.file);
    const finalItem = (key, pid) => {
      const it = map.noteItems[key];
      if (!it || mapFile < 0) return null;
      for (const n of version.notes) {
        if (n.f !== mapFile || n.sheet !== it.sheet) continue;
        const hit = n.items.find(x => x.v?.[it.period]?.c === it.cell);
        if (hit) { const c = hit.v[pid]; return c && (c.st === 'ok' || c.st === 'dash') ? Number(c.v) || 0 : null; }
      }
      return null;
    };
    const liveNotes = [...byNote.values()].map(n => ({ ...n, role: 'live', items: n.items.map(it => ({ ...it, v: {} })) }));
    const addLive = (pid, isBs, valueOf, asAt) => {
      for (const n of liveNotes) {
        if (n.lines.some(l => l.startsWith('bs.')) !== isBs) continue;
        let tot = 0, any = false;
        for (const it of n.items) {
          const val = valueOf(it.key);
          if (val == null) continue;
          it.v[pid] = { v: val, st: 'ok', role: 'live', ...(asAt ? { asAt } : {}) };
          if (!it.total) { tot += val; any = true; }
        }
        const t = n.items.filter(i => i.total).pop();
        if (t && any && !t.v[pid]) t.v[pid] = { v: tot, st: 'ok', role: 'live', ...(asAt ? { asAt } : {}) };
      }
    };
    if (latestFinalBs) {
      const baseId = `BS-${latestFinalBs}`;
      const base = bsFor(latestFinalBs);
      for (const pid of Object.keys(live.BS)) {
        const z = zoho.BS[pid];
        if (!z || !base) continue;
        addLive(pid, true, key => { const fv = finalItem(key, baseId); const zn = z.notes[key], zb = base.notes[key]; if (fv == null && zn == null) return null; return (fv != null ? fv : (zb || 0)) + ((zn || 0) - (zb || 0)); }, z.asAt);
      }
    }
    for (const pid of Object.keys(live.PL)) {
      const per = P.fromId(pid);
      const z = zoho.PL[pid];
      if (!z) continue;
      if (per.start > finalEnd) { addLive(pid, false, key => (z.notes[key] != null ? z.notes[key] : null), z.asAt); continue; }
      const finalP = ['Q1', 'H1', '9M'].map(x => P.fromId(`FY${per.fy}-${x}`)).find(p => p.end === finalEnd && p.start === per.start);
      const after = finalP ? plFor({ start: `${G.addMonths(finalEnd.slice(0, 7), 1)}-01`, end: per.end }) : null;
      if (!after) continue;
      addLive(pid, false, key => { const fv = finalItem(key, finalP.id); const za = after.notes[key]; if (fv == null && za == null) return null; return (fv || 0) + (za || 0); }, z.asAt);
    }
    return [...zNotes, ...liveNotes.filter(n => n.items.some(i => Object.keys(i.v).length))];
  })();

  // accounts awaiting mapping (or placed only by a suggestion) at the cut-off date
  const seen = new Set();
  const awaiting = [];
  for (const a of [...(zoho.BS[`BS-${fyNow}-03-31`]?.awaiting || []), ...(zoho.PL[`FY${fyNow}-FY`]?.awaiting || [])]) if (!seen.has(a.id)) { seen.add(a.id); awaiting.push(a); }
  awaiting.sort((x, y) => Math.abs(y.amount || 0) - Math.abs(x.amount || 0));

  return { facts, notes: notesOut, flags, zoho, live, flowIds, bsIds, cutoff, finalEnd, latestFinalBs, byId, awaiting, bsFor, plFor, totals, bsBalances, isPL, typeOf, rollForward };
}

module.exports = { createLive, effectiveMapping, AWAIT, CF_LABELS, SEC_SIGN };
