/**
 * Financial Reporting — the account mapping built from a FINAL workbook's trial-balance sheet (e.g. "TB S26" in
 * DevX Standalone FS FY 2026-27_Q-2_Final Set): every ledger → statement line, note item and the workbook's allocation rule.
 *
 * How:
 *   1. The trial-balance sheet is found by its header row (Account · Opening · Debit · Credit · Closing · OBE · In Lacs · Grouping).
 *   2. Every balance-sheet line (current column) and P&L line (year-to-date column of the SEBI results) the importer reads, and every
 *      note item, is traced through the workbook's formulas (wbtrace.js) to the ledgers it adds up — signs, groupings,
 *      current/non-current splits and subtotals are the workbook's own.
 *   3. Per ledger: the lines and note items it lands in, with the coefficient (sign and share). A ledger in two lines is a split;
 *      a typed amount that moves part of a balance from one line to another (current maturities, MSME dues, lease split) is kept
 *      as an ALLOCATION carried with the line. Opening balances typed from the comparative column (other equity, deferred tax) are
 *      carried for the same financial year. Everything else typed in the current column (fixed-asset register, FD classification,
 *      one-off figures) and the OBE column are WORKBOOK-ONLY adjustments: listed, never carried into live figures.
 *   4. A ledger the formulas never reach (its line comes from a schedule) is placed by its grouping: the line the other ledgers of
 *      that grouping use, else a rule (FA → PPE, CWIP → CWIP, Fixed Deposit → the workbook's current / non-current split pro rata),
 *      and flagged "inferred — review". Zoho's computed Retained Earnings is excluded: the carried opening balance replaces it.
 *   5. Income and expense ledgers reach other equity only through total comprehensive income; that is checked and then kept as a
 *      rule (other equity = carried opening + equity movements + total comprehensive income for the year to date).
 *   6. Ledgers are matched to Zoho accounts by name (the parent name decides a duplicate).
 * Self-check: the mapping evaluated on the trial-balance sheet itself, plus the workbook-only parts, must give every workbook figure.
 */

'use strict';

const XLSX = require('xlsx');
const crypto = require('crypto');
const X = require('./extract');
const L = require('./lines');
const P = require('./periods');
const { makeTracer } = require('./wbtrace');

const LEAF_PL = ['pl.rev', 'pl.oth_inc', 'pl.exp_ops', 'pl.exp_emp', 'pl.exp_fin', 'pl.exp_dep', 'pl.exp_oth', 'pl.exceptional', 'pl.share_assoc',
  'pl.tax_cur', 'pl.tax_def', 'pl.tax_prior', 'pl.oci_nr', 'pl.oci_nr_tax', 'pl.oci_r', 'pl.oci_r_tax'];
const LEAF_BS = L.BS.filter(l => !l.sum && !l.calc && !l.cons).map(l => l.id);
const LEAF = new Set([...LEAF_PL, ...LEAF_BS]);
const r2 = v => Math.round(v * 100) / 100;
const r6 = v => Math.round(v * 1e6) / 1e6;
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const CODES = ['close', 'open', 'dr', 'cr'];

function findTbSheet(wb, prefer) {
  const hidden = n => !!(wb.Workbook?.Sheets || []).find(s => s.name === n && s.Hidden);
  const cands = [];
  for (const name of wb.SheetNames) {
    if (prefer && name.trim() !== prefer.trim()) continue;
    if (!prefer && !/^tb\b/i.test(name.trim())) continue;
    const ws = wb.Sheets[name];
    if (!ws['!ref']) continue;
    const R = XLSX.utils.decode_range(ws['!ref']);
    for (let r = R.s.r; r <= Math.min(R.s.r + 15, R.e.r); r++) {
      const hdr = {};
      for (let c = R.s.c; c <= Math.min(R.e.c, 20); c++) { const v = ws[XLSX.utils.encode_cell({ r, c })]?.v; if (typeof v === 'string') hdr[XLSX.utils.encode_col(c)] = v.trim(); }
      const find = re => Object.entries(hdr).find(([, v]) => re.test(v))?.[0];
      const name0 = find(/^account/i), group = find(/group/i), close = find(/closing/i);
      if (!name0 || !group || !close) continue;
      const cols = { name: name0, open: find(/opening/i), dr: find(/^debit/i), cr: find(/^credit/i), close, obe: find(/^obe\b|adjust/i), lakh: find(/lac|lakh/i), group };
      let last = r + 1;
      for (let rr = r + 1; rr <= R.e.r; rr++) if (String(ws[`${cols.name}${rr + 1}`]?.v ?? '').trim()) last = rr + 1;
      cands.push({ name, hidden: hidden(name), headerRow: r + 1, firstRow: r + 2, lastRow: last, cols });
      break;
    }
  }
  return cands.sort((a, b) => (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0))[0] || null;
}

const ytdPeriodOf = end => { const m = +end.slice(5, 7); const fy = P.fyOf(end); return m === 6 ? `FY${fy}-Q1` : m === 9 ? `FY${fy}-H1` : m === 12 ? `FY${fy}-9M` : m === 3 ? `FY${fy}-FY` : null; };

// a ledger the formulas never reach: placed by its grouping when the workbook builds that line from a schedule
const GROUP_RULES = [
  { re: /^fa$|fixed assets?|property,? plant/, line: name => (/software|intangible|trade ?mark|website|licen[cs]e/i.test(name) ? 'bs.intang' : 'bs.ppe'), sign: 1, why: 'fixed-asset ledgers: the workbook takes property, plant and equipment from its fixed-asset register' },
  { re: /^cwip$|capital work/, line: name => (/intangible|software/i.test(name) ? 'bs.intang_dev' : 'bs.cwip'), sign: 1, why: 'capital work-in-progress ledgers: the workbook takes CWIP from its fixed-asset register' },
  { re: /^fixed deposits?$/, split: true, why: 'fixed deposits: the workbook classifies each deposit by maturity (Fixed Deposit - Classification); the live split follows that classification pro rata' },
  { re: /^equity$/, line: () => 'bs.share_cap', sign: -1, why: 'share capital ledgers' },
  { re: /^lease liab/, line: () => 'bs.ncl_lease', sign: -1, why: 'lease liability ledgers' },
  { re: /^borrowings?$/, line: () => 'bs.ncl_borrow', sign: -1, why: 'borrowing ledgers' },
  { re: /dta/, line: () => 'bs.dta', sign: 1, why: 'deferred tax ledgers' },
];

// names that say where a ledger belongs whatever its grouping
const NAME_RULES = [
  { re: /diminution|impairment.*invest/i, line: 'bs.nc_inv', why: 'a provision against investments (by its name)' },
];

/**
 * buildMapping({ buf, name, accounts, tbSheet }) — accounts: Zoho chart of accounts { id: { n, t, pn } } (from the ledger sync)
 */
function buildMapping({ buf, name, accounts = {}, tbSheet = null, user = null }) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const x = X.extractWorkbook(buf, { name });
  const end = x.reportingDate;
  if (!end) throw Object.assign(new Error(`"${name}": the reporting date could not be read from the statements.`), { status: 400 });
  const ytd = ytdPeriodOf(end);
  const bsP = `BS-${end}`;
  const periodStart = P.fromId(ytd)?.start || `${+end.slice(0, 4) - (+end.slice(5, 7) >= 4 ? 0 : 1)}-04-01`;
  const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellNF: true });
  const tbi = findTbSheet(wb, tbSheet);
  if (!tbi) throw Object.assign(new Error(`"${name}" has no trial-balance sheet with a Grouping column${tbSheet ? ` named "${tbSheet}"` : ''}.`), { status: 400 });
  const T = makeTracer(wb, { tbSheet: tbi.name, periodStart, periodEnd: end, firstRow: tbi.firstRow, lastRow: tbi.lastRow, cols: tbi.cols });

  // ── the ledgers on the trial-balance sheet, with their section (Assets / Liabilities / Equities / Income / Expense) and parent ──
  const ledgers = {};
  let section = null;
  const parents = [];
  for (let r = tbi.firstRow; r <= tbi.lastRow; r++) {
    if (!T.isTbAccountRow(r)) continue;
    const raw = String(wb.Sheets[tbi.name][`${tbi.cols.name}${r}`].v);
    const a = T.account(r);
    const numeric = ['open', 'dr', 'cr', 'close'].some(k => tbi.cols[k] && typeof wb.Sheets[tbi.name][`${tbi.cols[k]}${r}`]?.v === 'number');
    if (!numeric && /^(assets?|liabilit(y|ies)|equit(y|ies)|income|expenses?)$/i.test(raw.trim())) { section = raw.trim().toLowerCase().replace(/ies$/, 'y').replace(/s$/, ''); parents.length = 0; continue; }
    const depth = Math.round((raw.match(/^\s*/)[0].length) / 10);
    while (parents.length && parents[parents.length - 1].depth >= depth) parents.pop();
    const parent = parents[parents.length - 1]?.name || null;
    parents.push({ depth, name: raw.trim() });
    ledgers[r] = { row: r, name: raw.trim(), depth, parent, section, group: a.group, tb: { open: a.open, dr: a.dr, cr: a.cr, close: a.close, obe: a.obe }, lines: {}, notes: {} };
  }
  const isPLSection = l => l && (l.section === 'income' || l.section === 'expense');

  // ── statement lines and note items to trace ──
  const lineCells = [];
  const seen = new Set();
  const visible = x.statements.filter(s => !s.hidden);
  const bsSheets = visible.filter(s => s.stmt === 'BS');
  const plSheets = [...visible.filter(s => s.type === 'SEBI'), ...visible.filter(s => s.stmt === 'PL' && s.type !== 'SEBI')];
  const noteLines = {};
  for (const s of [...bsSheets, ...plSheets]) {
    const want = s.stmt === 'BS' ? bsP : ytd;
    for (const row of s.rows) {
      if (row.noteRef && /^\d+(\.\d+)?$/.test(row.noteRef) && !row.id.includes('.x.')) (noteLines[row.noteRef] = noteLines[row.noteRef] || new Set()).add(row.id);
      if (seen.has(row.id)) continue;
      const fig = row.figs.find(g => g.pc.period === want && g.f.c);
      if (!fig) continue;
      seen.add(row.id);
      lineCells.push({ line: row.id, label: row.label, sheet: s.sheet, cell: fig.f.c, v: fig.f.v, stmt: s.stmt === 'BS' ? 'BS' : 'PL' });
    }
  }
  const lines = {};
  const parts = {};    // line → const parts (for allocation pairing)
  for (const lc of lineCells) {
    const chk = T.check(lc.sheet, lc.cell);
    lines[lc.line] = { line: lc.line, label: L.BY_ID[lc.line]?.label || lc.label, stmt: lc.stmt, sheet: lc.sheet, cell: lc.cell, wb: chk.cached, ok: chk.ok, traced: r6(chk.got), leaf: LEAF.has(lc.line),
      ledgers: 0, carried: [], dropped: [], obe: 0, opaque: chk.lin.op.map(o => ({ sheet: o.sheet, addr: o.addr, why: o.why, amount: r2(o.v * o.coef) })) };
    if (!LEAF.has(lc.line)) continue;
    parts[lc.line] = chk.lin.k;
    for (const [key, coef] of chk.lin.t) {
      const [row, code] = key.split(':');
      const led = ledgers[row];
      if (!led) continue;
      if (code === 'obe') { lines[lc.line].obe += coef * led.tb.obe; (led.obeLines = led.obeLines || {})[lc.line] = coef; continue; }
      const slot = led.lines[lc.line] = led.lines[lc.line] || {};
      slot[code] = (slot[code] || 0) + coef;                       // rupees → ₹ lakh: normally ±1/100000
    }
  }

  // notes: every item of every visible note in the current columns
  const noteItems = {};
  for (const n of x.notes.filter(nn => !nn.hidden)) {
    let nl = noteLines[n.num] ? [...noteLines[n.num]] : (L.lineForNoteTitle(n.title) ? [L.lineForNoteTitle(n.title)] : []);
    if (nl.some(x => x === 'bs.cl_tp_msme' || x === 'bs.cl_tp_other')) nl = [...new Set([...nl, 'bs.cl_tp_msme', 'bs.cl_tp_other'])];
    for (const it of n.items) {
      if (it.subhead) continue;
      const fig = it.figs.find(g => (g.p === bsP || g.p === ytd) && g.c);
      if (!fig) continue;
      const key = `${n.sheet}!${fig.c}`;
      if (noteItems[key]) continue;
      const chk = T.check(n.sheet, fig.c);
      // an item summed in rupees inside a note kept in lakh (a missing /100000): read as lakh
      let scale = 1;
      for (const c of chk.lin.t.values()) if (Math.abs(c) >= 1e-3) scale = 1e-5;
      noteItems[key] = { key, num: n.num, title: n.title, sheet: n.sheet, cell: fig.c, label: it.label, total: !!it.total, lines: nl, period: fig.p, wb: chk.cached, ok: chk.ok, ledgers: 0, consts: r2(chk.lin.constVal()),
        parts: chk.lin.k.filter(c => c.kind !== 'rounding' && Math.abs(c.v * c.coef) >= 0.005).map(c => ({ kind: c.kind, sheet: c.sheet, addr: c.addr, amount: r2(c.v * c.coef * scale) })), ...(scale !== 1 ? { rupees: true } : {}) };
      for (const [k, coef] of chk.lin.t) {
        const [row, code] = k.split(':');
        const led = ledgers[row];
        if (!led || code === 'obe') continue;
        const slot = led.notes[key] = led.notes[key] || {};
        slot[code] = (slot[code] || 0) + coef * scale;
        noteItems[key].ledgers++;
      }
    }
  }

  // ── income and expense ledgers reach other equity only through total comprehensive income ──
  const tciRule = { line: 'bs.oth_eq', checked: 0, mismatches: [] };
  const tciTrace = lineCells.find(c => c.line === 'pl.tci') ? T.traceCell(lineCells.find(c => c.line === 'pl.tci').sheet, lineCells.find(c => c.line === 'pl.tci').cell) : null;
  for (const led of Object.values(ledgers)) {
    if (!isPLSection(led)) continue;
    const viaEq = led.lines['bs.oth_eq'];
    if (!viaEq) continue;
    const want = tciTrace ? (tciTrace.t.get(`${led.row}:close`) || 0) : null;
    tciRule.checked++;
    if (want != null && Math.abs((viaEq.close || 0) - want) > 1e-9) tciRule.mismatches.push({ row: led.row, name: led.name, inOtherEquity: viaEq.close, inTci: want });
    delete led.lines['bs.oth_eq'];
  }
  tciRule.ok = tciRule.mismatches.length === 0;

  // ── allocations: a typed amount that moves part of a balance between two lines ──
  for (const kind of ['BS', 'PL']) {
    const byKey = new Map();
    for (const [line, ks] of Object.entries(parts)) {
      if (lines[line].stmt !== kind) continue;
      for (const c of ks) {
        if (c.kind === 'rounding') continue;
        const k = `${c.sheet}!${c.addr}`;
        const m = byKey.get(k) || new Map();
        m.set(line, (m.get(line) || 0) + c.v * c.coef);
        byKey.set(k, m);
        if (c.kind === 'opening') { /* carried */ }
      }
    }
    for (const [line, ks] of Object.entries(parts)) {
      if (lines[line].stmt !== kind) continue;
      const agg = new Map();
      for (const c of ks) {
        if (c.kind === 'rounding') continue;
        const k = `${c.sheet}!${c.addr}`;
        const a = agg.get(k) || { kind: c.kind, sheet: c.sheet, addr: c.addr, amount: 0 };
        a.amount += c.v * c.coef;
        agg.set(k, a);
      }
      for (const a of agg.values()) {
        if (Math.abs(a.amount) < 0.005) continue;
        const across = byKey.get(`${a.sheet}!${a.addr}`);
        const others = [...across.entries()].filter(([l2, v]) => l2 !== line && Math.abs(v) >= 0.005);
        const net = [...across.values()].reduce((s, v) => s + v, 0);
        const item = { kind: a.kind, sheet: a.sheet, addr: a.addr, amount: r2(a.amount) };
        if (a.kind === 'opening') lines[line].carried.push({ ...item, rule: 'opening' });
        else if (others.length && Math.abs(net) < 0.01) lines[line].carried.push({ ...item, rule: 'allocation', with: others.map(([l2]) => l2) });
        else lines[line].dropped.push(item);
      }
    }
  }

  // ── coefficient signs on balance-sheet lines ──
  const SEC_SIGN = id => { const sec = L.BY_ID[id]?.sec; return sec === 'nca' || sec === 'ca' ? 1 : sec === 'eq' || sec === 'ncl' || sec === 'cl' ? -1 : 0; };
  const signIssues = [];
  for (const l of Object.values(ledgers)) {
    if (isPLSection(l)) continue;
    for (const [line, slot] of Object.entries(l.lines)) {
      const want = SEC_SIGN(line);
      const c = slot.close || 0;
      if (!want || !c || Math.sign(c) === want) continue;
      const shown = l.tb.close / 1e5;
      // the typed figure equal to this balance, in another line of the balance sheet
      let fix = null;
      for (const [line2, ln2] of Object.entries(lines)) {
        if (line2 === line || !ln2.leaf || ln2.stmt !== 'BS') continue;
        const hit = ln2.dropped.find(d => !d.explainedBy && (d.kind === 'period' || d.kind === 'literal') && Math.abs(Math.abs(d.amount) - Math.abs(shown)) < 0.006);
        if (hit) { fix = { line2, hit }; break; }
      }
      if (fix) {
        const counter = lines[line].dropped.find(d => !d.explainedBy && d.sheet === fix.hit.sheet && d.addr === fix.hit.addr);
        fix.hit.explainedBy = l.row; if (counter) counter.explainedBy = l.row;
        delete l.lines[line];
        l.lines[fix.line2] = { close: SEC_SIGN(fix.line2) * 1e-5 };
        l.repaired = { from: line, to: fix.line2, why: `the workbook's formula adds this ledger to "${L.BY_ID[line]?.label || line}" with the wrong sign and cancels it with the typed figure at ${fix.hit.sheet}!${fix.hit.addr}` };
        signIssues.push({ row: l.row, name: l.name, line, to: fix.line2, typed: `${fix.hit.sheet}!${fix.hit.addr}`, amount: r2(Math.abs(shown)) });
      } else if (Math.abs(l.tb.close) < 0.5) {
        // no effect in the workbook (nil balance at its date) but it would show a later balance with the wrong sign: normalised
        slot.close = want * Math.abs(c);
        l.repaired = { from: line, to: line, why: 'the workbook formula has the wrong sign for this ledger (nil at its date, so invisible there) — normalised' };
        signIssues.push({ row: l.row, name: l.name, line, amount: 0, note: 'sign normalised (nil balance at the workbook date)' });
      } else signIssues.push({ row: l.row, name: l.name, line, amount: r2(c * l.tb.close), note: 'coefficient sign opposite to the line — left as the workbook has it' });
    }
  }

  // ── ledgers the formulas never reach: by grouping, then by rule ──
  const reached = l => Object.keys(l.lines).length > 0;
  const byGroup = {};
  for (const l of Object.values(ledgers)) if (reached(l) && l.group) (byGroup[norm(l.group)] = byGroup[norm(l.group)] || []).push(l);
  let fdSplitMemo;
  const fdSplitOf = () => {
    if (fdSplitMemo !== undefined) return fdSplitMemo;
    const amt = {};
    for (const [line, ln] of Object.entries(lines)) for (const d of ln.dropped) if (/fixed deposit/i.test(d.sheet) && !d.explainedBy) amt[line] = (amt[line] || 0) + d.amount;
    const tot = Object.values(amt).reduce((t, v) => t + v, 0);
    fdSplitMemo = tot > 0 ? Object.fromEntries(Object.entries(amt).map(([l, v]) => [l, v / tot])) : null;
    return fdSplitMemo;
  };
  // lines the workbook rolls forward from an opening balance (other equity, deferred tax): a ledger it never reads is not added
  const rollForward = new Set(Object.entries(lines).filter(([, ln]) => ln.carried.some(c => c.rule === 'opening')).map(([k]) => k));
  const place = (l, line, coef0, why, extra = {}) => {
    const coef = line.startsWith('bs.') && SEC_SIGN(line) ? SEC_SIGN(line) * 1e-5 : coef0;
    if (rollForward.has(line)) { l.status = 'excluded'; l.zohoLine = { line, coef }; l.rule = `not read by the workbook: it builds "${L.BY_ID[line]?.label || line}" as the opening balance plus the year's movement — used only in the Zoho-only view (${why})`; return; }
    l.lines[line] = { close: coef }; l.status = 'inferred'; l.rule = why; Object.assign(l, extra);
    if (!l.inferredBy) l.inferredBy = 'grouping';
  };
  for (const pass of ['typed', 'rest']) for (const l of Object.values(ledgers)) {
    if (l.status && l.status !== 'pending') continue;
    const hasAmount = ['open', 'dr', 'cr', 'close'].some(k => Math.abs(l.tb[k]) >= 0.005);
    if (reached(l)) { l.status = 'traced'; continue; }
    if (Object.keys(l.notes).length) {
      const nl = Object.keys(l.notes).map(k => noteItems[k]?.lines?.[0]).find(Boolean);
      l.status = 'traced'; l.nil = true; l.rule = 'in a note, offset to nil in the statement by a formula (e.g. fully provided) — the Zoho-only view shows its balance';
      if (nl) l.zohoLine = { line: nl, coef: (/^(liabilit|equit)/.test(l.section || '') ? -1 : 1) * 1e-5 };
      continue;
    }
    if (/^retained earnings$/i.test(l.name)) { l.status = 'excluded'; l.rule = "Zoho's computed retained earnings (prior years) — replaced by the opening other equity carried from the workbook"; continue; }
    if (!hasAmount) { l.status = 'zero'; continue; }
    const g = norm(l.group);
    const shown = l.tb.close / 1e5;
    // a figure typed in a schedule that equals this ledger's balance (e.g. a loan's current maturity typed as its whole balance)
    let typed = null;
    for (const [line, ln] of Object.entries(lines)) {
      if (!ln.leaf || ln.stmt !== (isPLSection(l) ? 'PL' : 'BS') || Math.abs(shown) < 0.01) continue;
      const hit = ln.dropped.find(d => !d.explainedBy && (d.kind === 'period' || d.kind === 'literal') && Math.abs(Math.abs(d.amount) - Math.abs(shown)) < 0.006);
      if (hit) { typed = { line, hit, coef: Math.sign(hit.amount) * Math.sign(shown) * 1e-5 }; break; }
    }
    if (typed) { typed.hit.explainedBy = l.row; l.inferredBy = 'typed'; place(l, typed.line, typed.coef, `the workbook types this ledger's balance (${r2(Math.abs(shown))} lakh) in ${typed.hit.sheet}!${typed.hit.addr}`); continue; }
    if (pass === 'typed') { l.status = 'pending'; continue; }
    const fdSplit = fdSplitOf();
    const byName = NAME_RULES.find(rr => rr.re.test(l.name));
    if (byName) { place(l, byName.line, SEC_SIGN(byName.line) * 1e-5, byName.why); continue; }
    const rule = GROUP_RULES.find(rr => rr.re.test(g));
    if (rule) {
      if (rule.split && fdSplit) {
        for (const [line, f] of Object.entries(fdSplit)) l.lines[line] = { close: r6(f) * 1e-5 };
        l.status = 'inferred'; l.inferredBy = 'schedule'; l.split = Object.fromEntries(Object.entries(fdSplit).map(([k, v]) => [k, r6(v)])); l.rule = rule.why; continue;
      }
      if (!rule.split) { l.inferredBy = 'schedule'; place(l, rule.line(l.name), rule.sign * 1e-5, rule.why); continue; }
    }
    const peers = g ? byGroup[g] : null;
    if (peers && peers.length) {
      // the line (and note item) most of the grouping's balance goes to, with the same sign
      const tally = new Map();
      const stmtOfL = isPLSection(l) ? 'PL' : 'BS';
      for (const p of peers) for (const [line, slot] of Object.entries(p.lines)) { if (lines[line]?.stmt !== stmtOfL) continue; const w = Math.abs(p.tb.close) + Math.abs(p.tb.dr) + 1; const e = tally.get(line) || { w: 0, coef: slot.close || slot.dr || -(slot.cr || 0) }; e.w += w; tally.set(line, e); }
      const best = [...tally.entries()].sort((a, b) => b[1].w - a[1].w)[0];
      if (best) {
        const share = best[1].w / [...tally.values()].reduce((t, e) => t + e.w, 0);
        const nt = new Map();
        for (const p of peers) for (const [k, slot] of Object.entries(p.notes)) { const e = nt.get(k) || { w: 0, coef: slot.close || 0 }; e.w += Math.abs(p.tb.close) + 1; nt.set(k, e); }
        const bestNote = [...nt.entries()].sort((a, b) => b[1].w - a[1].w)[0];
        place(l, best[0], Math.sign(best[1].coef || 1) * 1e-5, `grouping "${l.group}": the line the other ${peers.length} ledger(s) of this grouping are in${share < 0.8 ? ` (only ${Math.round(share * 100)}% of the grouping goes there — check)` : ''}`, share < 0.8 ? { ambiguous: true } : {});
        if (l.status === 'inferred' && bestNote) l.notes[bestNote[0]] = { close: Math.sign(bestNote[1].coef || 1) * 1e-5 };
        continue;
      }
    }
    if (isPLSection(l)) { place(l, l.section === 'income' ? 'pl.oth_inc' : 'pl.exp_oth', (l.section === 'income' ? -1 : 1) * 1e-5, `no grouping the workbook uses — placed by its trial-balance section (${l.section}); review`, { ambiguous: true }); continue; }
    l.status = 'unmapped';
  }
  // the schedule figures those ledgers replace (fixed-asset register, fixed-deposit classification) are not workbook-only adjustments:
  // the difference between the schedule and Zoho's ledgers is reported per line instead
  const SCHEDULE_SHEETS = { 'bs.ppe': /^fa\b|fixed asset/i, 'bs.cwip': /^fa\b|fixed asset/i, 'bs.intang': /^fa\b|fixed asset/i, 'bs.intang_dev': /^fa\b|fixed asset/i, 'bs.obank': /fixed deposit/i, 'bs.nc_ofa': /fixed deposit/i };
  for (const [line, re] of Object.entries(SCHEDULE_SHEETS)) {
    const ln = lines[line];
    if (!ln) continue;
    const viaRule = Object.values(ledgers).filter(l => l.status === 'inferred' && l.lines[line] && GROUP_RULES.some(rr => rr.re.test(norm(l.group))));
    if (!viaRule.length) continue;
    const consts = ln.dropped.filter(d => !d.explainedBy && re.test(d.sheet.trim()));
    for (const d of consts) d.explainedBy = 'schedule';
    ln.schedule = { sheet: [...new Set(consts.map(d => d.sheet.trim()))].join(', '), workbook: r2(consts.reduce((t, d) => t + d.amount, 0)), ledgers: viaRule.length };
  }
  // ── note items follow the line rules ──
  const allocKeys = new Set(), explained = new Map();
  for (const ln of Object.values(lines)) {
    for (const c of ln.carried) if (c.rule === 'allocation') allocKeys.add(`${c.sheet}!${c.addr}`);
    for (const d of ln.dropped) if (typeof d.explainedBy === 'number' || /^\d+$/.test(String(d.explainedBy || ''))) explained.set(`${d.sheet}!${d.addr}`, +d.explainedBy);
  }
  for (const it of Object.values(noteItems)) {
    it.carried = it.parts.filter(p => allocKeys.has(`${p.sheet}!${p.addr}`)).map(p => ({ ...p, rule: 'allocation' }));
    for (const p of it.parts) {
      const row = explained.get(`${p.sheet}!${p.addr}`);
      const led = row != null ? ledgers[row] : null;
      if (!led || !led.tb.close) continue;
      led.notes[it.key] = { close: Math.sign(p.amount) * Math.sign(led.tb.close) * 1e-5 };
      it.ledgers++;
    }
  }
  // a ledger placed by a schedule rule (fixed deposits) goes to the note item that holds that schedule's figures
  for (const l of Object.values(ledgers)) {
    if (l.status !== 'inferred' || Object.keys(l.notes).length) continue;
    for (const [line, slot] of Object.entries(l.lines)) {
      const re = SCHEDULE_SHEETS[line];
      if (!re) continue;
      const cands = Object.values(noteItems).filter(it => !it.total && it.lines.includes(line)).map(it => ({ it, amt: it.parts.filter(p => re.test(p.sheet.trim())).reduce((t, p) => t + Math.abs(p.amount), 0) })).filter(x => x.amt > 0).sort((a, b) => b.amt - a.amt);
      if (cands.length) { l.notes[cands[0].it.key] = { close: slot.close }; cands[0].it.ledgers++; for (const t of Object.values(noteItems).filter(x => x.total && x.lines.includes(line) && x.sheet === cands[0].it.sheet && x.num === cands[0].it.num)) l.notes[t.key] = { close: slot.close }; }
    }
  }
  // a ledger re-pointed by the sign rule leaves the note items of the line it left
  for (const l of Object.values(ledgers)) {
    if (!l.repaired || l.repaired.from === l.repaired.to) continue;
    for (const k of Object.keys(l.notes)) if (noteItems[k]?.lines.includes(l.repaired.from)) delete l.notes[k];
  }
  // split ledgers (more than one line) without an allocation are listed as splits
  for (const l of Object.values(ledgers)) if (Object.keys(l.lines).length > 1 && !l.split) l.split = Object.fromEntries(Object.entries(l.lines).map(([k, s]) => [k, r6((s.close || s.dr || -(s.cr || 0)) / 1e-5)]));

  // ── Zoho accounts by name (parent name decides a duplicate) ──
  const zByName = new Map();
  for (const [id, a] of Object.entries(accounts)) { if (!a?.n) continue; const k = norm(a.n); if (!zByName.has(k)) zByName.set(k, []); zByName.get(k).push({ id, ...a }); }
  for (const l of Object.values(ledgers)) {
    const c = zByName.get(norm(l.name)) || [];
    let z = c[0];
    if (c.length > 1) { const byParent = c.filter(a => norm(a.pn) === norm(l.parent)); z = byParent.length === 1 ? byParent[0] : null; l.zohoCandidates = c.map(a => ({ id: a.id, name: a.n, parent: a.pn })); }
    l.zoho = z ? { id: z.id, name: z.n, type: z.t || null, parent: z.pn || null } : null;
    l.match = z ? (c.length > 1 ? 'parent' : 'name') : c.length > 1 ? 'ambiguous' : 'none';
  }

  // ── self-check: the mapping on the trial-balance sheet + workbook-only parts = the workbook figure ──
  const sim = {};
  for (const l of Object.values(ledgers)) for (const [line, slot] of Object.entries(l.lines)) for (const code of CODES) if (slot[code]) sim[line] = (sim[line] || 0) + slot[code] * l.tb[code];
  for (const [line, ln] of Object.entries(lines)) {
    if (!ln.leaf) continue;
    ln.ledgers = Object.values(ledgers).filter(l => l.lines[line]).length;
    const carried = ln.carried.reduce((s, c) => s + c.amount, 0), dropped = ln.dropped.filter(d => !d.explainedBy).reduce((s, c) => s + c.amount, 0), op = ln.opaque.reduce((s, c) => s + c.amount, 0);
    let tci = 0;
    if (line === 'bs.oth_eq' && tciTrace) for (const [k, coef] of tciTrace.t) { const [row, code] = k.split(':'); if (ledgers[row] && code !== 'obe' && isPLSection(ledgers[row])) tci += coef * ledgers[row].tb[code]; }
    ln.mapped = r2((sim[line] || 0) + carried + tci);
    ln.obe = r2(ln.obe);
    ln.inferredPart = r2(Object.values(ledgers).filter(l => (l.status === 'inferred' || l.repaired) && l.lines[line]).reduce((s, l) => s + CODES.reduce((t, code) => t + (l.lines[line][code] || 0) * l.tb[code], 0), 0));
    // workbook = traced ledgers + carried + workbook-only (dropped consts, OBE) + opaque; inferred ledgers replace dropped schedule values
    // workbook = mapped (ledgers + carried) + workbook-only parts; what is left is a schedule that differs from Zoho's ledgers
    ln.workbookOnly = r2(dropped + ln.obe + op);
    ln.notInWorkbook = r2(Object.values(ledgers).filter(l => l.status === 'inferred' && l.inferredBy === 'grouping' && l.lines[line]).reduce((t, l) => t + CODES.reduce((u, code) => u + (l.lines[line][code] || 0) * l.tb[code], 0), 0));
    ln.residual = r2(ln.wb - (ln.mapped - ln.notInWorkbook) - ln.workbookOnly);
    if (ln.schedule) ln.schedule.ledgerAmount = r2(ln.inferredPart);
  }
  const counts = { ledgers: 0, traced: 0, inferred: 0, excluded: 0, unmapped: 0, zero: 0, zohoMatched: 0, zohoMissing: 0, ambiguous: 0 };
  for (const l of Object.values(ledgers)) {
    counts.ledgers++; counts[l.status]++;
    if (l.zoho) counts.zohoMatched++; else if (l.status !== 'zero' && l.status !== 'excluded') counts.zohoMissing++;
    if (l.ambiguous || l.match === 'ambiguous') counts.ambiguous++;
  }
  return {
    meta: { file: name, sha256, sheet: tbi.name, cols: tbi.cols, firstRow: tbi.firstRow, lastRow: tbi.lastRow, reportingDate: end, ytdPeriod: ytd, bsPeriod: bsP, periodStart,
      basis: x.basis, builtAt: new Date().toISOString(), builtBy: user, signIssues, anomalies: T.anomalies.filter((a, i, all) => all.findIndex(b => b.sheet === a.sheet && b.addr === a.addr) === i), counts, tciRule },
    lines, noteItems, ledgers: Object.values(ledgers),
  };
}

module.exports = { buildMapping, findTbSheet, LEAF_PL, LEAF_BS, ytdPeriodOf };
