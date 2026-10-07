// ─── Agreed (contractual) monthly rent from the "Rent Recurring Module" workbook ──
// The workbook in the project root lists one line per landlord × office × module
// period (Module Starts on → Module Ends on) with the agreed monthly Amount.
// Columns are located by header name, so inserted/reordered columns don't break it.
//
// A Zoho vendor can hold several offices in one branch (e.g. "… 206 & 207"), and
// one bill covers all of them — so the agreed figure for a month is the SUM over
// that vendor's offices of the module line covering the month.

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT    = path.join(__dirname, '..');
const FILE_RE = /^rent recurring module.*\.xlsx$/i;

// Excel branch names that differ from the Zoho branch (normalised keys).
// Some sites are split per floor in the workbook but booked as one Zoho branch.
const BRANCH_ALIASES = [
  [/^hyd_laxmi pinnacle_zomato$/,     'hyd_laxmi pinnacle_zomoto'],
  [/^pun_next gen\b.*$/,              'pun_next gen 4th & 5th floor'],
  [/^vad_ishan_block-f(_.*)?$/,       'vad_ishan_block-f'],
  [/^vad_notus_d_1[01]th floor$/,     'vad_notus_d_10th & 11th floor'],
];

function branchKey(name) {
  const k = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [re, to] of BRANCH_ALIASES) if (re.test(k)) return to;
  return k;
}

function vendorTokens(name) {
  return String(name || '').toLowerCase()
    .replace(/\s*[-–]\s*(rent|maintenance|renting)\s*$/i, '')   // strip -RENT suffix
    .replace(/\s*\(\s*[\w\s/&.,-]+\s*\)\s*$/g, '')              // strip trailing (405) / (1012 New)
    .replace(/\bprivate\b/g, 'pvt').replace(/\blimited\b/g, 'ltd')
    .split(/[^a-z0-9]+/)
    .filter(t => t && !/^(mr|mrs|ms|miss|smt|shri|dr|and)$/.test(t));
}
const vendorKey = name => vendorTokens(name).join('');

function officeKey(office) {
  if (office == null) return '';
  const s = String(office);
  const i = s.lastIndexOf('|');                                  // Zoho "Binori | 405"
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

function tokenMatch(a, b) {
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];   // initial: "B." ↔ "Bhavanbhai"
  const len = Math.min(a.length, b.length);
  return len >= 5 && editDistance(a, b) <= (len >= 8 ? 2 : 1);  // "Dipakbhai" ↔ "Dopakbhai"
}

// Share of the shorter name's words found in the longer one (word order ignored):
// "Shah Palak Priyalbhai" ↔ "Palak Priyalbhai Shah" = 1, "Nand Mangukia" ↔ "Nandish Dhirubhai Mangukia" = 0.5
function nameScore(a, b) {
  let [s, l] = [vendorTokens(a), vendorTokens(b)];
  if (s.length > l.length) [s, l] = [l, s];
  if (!s.length) return 0;
  const used = new Set();
  let hit = 0;
  for (const t of s) {
    const j = l.findIndex((u, k) => !used.has(k) && t === u);
    const k = j >= 0 ? j : l.findIndex((u, k2) => !used.has(k2) && tokenMatch(t, u));
    if (k >= 0) { used.add(k); hit++; }
  }
  return s.length < 2 ? (hit === 1 && s[0].length >= 5 ? 0.5 : 0) : hit / s.length;
}

// Excel serial, JS Date, "31/12/2031", "31-1-2029" or "2029-01-31" → "YYYY-MM"
function toMonth(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.]\d{1,2}$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^\d{1,2}[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  return null;
}

const HEADERS = {
  office:   'officeno',
  vendor:   'vendorname',
  branch:   'branch',
  agrStart: 'agreementstartfrom',
  agrEnd:   'agreementendson',
  modStart: 'modulestartson',
  modEnd:   'moduleendson',
  amount:   'amount',
};

function pickWorkbook() {
  const files = fs.readdirSync(ROOT)
    .filter(f => FILE_RE.test(f) && !f.startsWith('~$'))
    .map(f => ({ f, mtime: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0] : null;
}

let _cache = null;   // { file, mtime, entries }

// Returns { file, entries: [{ bkey, vkey, okey, vendor, branch, office, modStart, modEnd, amount }] }
// Re-reads only when the newest workbook or its mtime changes.
function loadAgreements() {
  const pick = pickWorkbook();
  if (!pick) return { file: null, entries: [] };
  if (_cache && _cache.file === pick.f && _cache.mtime === pick.mtime) return _cache;

  let wb;
  try {
    wb = XLSX.readFile(path.join(ROOT, pick.f));
  } catch (e) {
    if (_cache) return _cache;   // e.g. mid-save in Excel — keep the last good read
    throw e;
  }
  const ws   = wb.Sheets['Sheet1'] || wb.Sheets[wb.SheetNames.find(n => wb.Sheets[n]['!ref'])];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const head = (rows[0] || []).map(norm);
  const col  = {};
  for (const [k, h] of Object.entries(HEADERS)) col[k] = head.indexOf(h);
  const missing = Object.keys(HEADERS).filter(k => col[k] < 0 && k !== 'modEnd');
  if (missing.length) throw new Error(`${pick.f}: missing column(s) ${missing.map(k => HEADERS[k]).join(', ')}`);

  const entries = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const r = rows[ri];
    if (!r || !r[col.vendor] || !r[col.branch]) continue;   // blank / group-header rows
    const amount = typeof r[col.amount] === 'number' ? r[col.amount] : parseFloat(r[col.amount]);
    const modStart = toMonth(r[col.modStart]) || toMonth(r[col.agrStart]);
    const modEnd   = (col.modEnd >= 0 && toMonth(r[col.modEnd])) || toMonth(r[col.agrEnd]);
    if (!amount || !modStart || !modEnd || modEnd < modStart) continue;
    const vendor = String(r[col.vendor]).trim();
    const branch = String(r[col.branch]).trim();
    entries.push({
      bkey: branchKey(branch), vkey: vendorKey(vendor), okey: officeKey(r[col.office]),
      vendor, branch, office: r[col.office] == null ? '' : String(r[col.office]).trim(),
      modStart, modEnd, amount,
    });
  }

  // A continuation line with a blank Office No. belongs to the vendor's only office
  const offices = {};
  for (const e of entries) if (e.okey) (offices[`${e.bkey}|${e.vkey}`] ||= new Set()).add(e.okey);
  for (const e of entries) {
    const set = offices[`${e.bkey}|${e.vkey}`];
    if (!e.okey && set?.size === 1) e.okey = [...set][0];
  }

  _cache = { file: pick.f, mtime: pick.mtime, entries };
  return _cache;
}

// Agreed amount for one month: per landlord × office, the module line covering the
// month (latest start wins if two overlap), summed across them.
function agreedForMonth(entries, mkey) {
  const cover = {};
  for (const e of entries) {
    if (e.modStart > mkey || mkey > e.modEnd) continue;
    const k = `${e.vkey}|${e.okey}`;
    if (!cover[k] || e.modStart > cover[k].modStart) cover[k] = e;
  }
  const hits = Object.values(cover);
  return hits.length ? hits.reduce((s, e) => s + e.amount, 0) : null;
}

// Sets row.agreed_monthly / row.agreed_total on the report rows (branch × vendor ×
// sub-category). Each branch × vendor gets the agreed figure on ONE row only — its
// rental row when it has one — so rent isn't counted again on maintenance rows.
//
// Zoho vendors are matched to workbook landlords within the branch, in order:
//   1. same name;
//   2. same words in any order / initials / one-letter typos ("Shah Palak Priyalbhai"
//      ↔ "Palak Priyalbhai Shah"), and failing that a close name at the same office;
//   3. by office number, for workbook lines still unmatched: shared by the unmatched
//      rent vendors billing that office (new owner, or a joint agreement billed by the
//      co-owners separately) — or, if none, by the vendors already matched there
//      (the workbook splits the office over more owners than Zoho bills).
// When several Zoho vendors share lines, the agreed amount is split between them in
// proportion to their actual billing for the year, so the total equals the agreement.
// Office-number matching only applies to rent rows, never CAM / electricity vendors.
function attachAgreed(rows, monthKeys) {
  let book;
  try {
    book = loadAgreements();
  } catch (e) {
    console.warn('[rent] Agreed workbook read failed:', e.message);
    book = { file: null, entries: [] };
  }

  // Zoho side: branch × vendor groups, each with the row that carries the figure
  const rank   = r => /rent/i.test(r.sub_category) ? 0 : /maint/i.test(r.sub_category) ? 1 : 2;
  const groups = {};
  for (const row of rows) {
    row.agreed_monthly = Object.fromEntries(monthKeys.map(k => [k, null]));
    row.agreed_total   = 0;
    (groups[`${row.branch_full}|||${row.vendor}`] ||= { rows: [] }).rows.push(row);
  }
  const byBranch = {};
  for (const g of Object.values(groups)) {
    g.target = g.rows.slice().sort((a, b) => rank(a) - rank(b))[0];
    g.vendor = g.target.vendor;
    g.vkey   = vendorKey(g.vendor);
    g.okey   = officeKey(g.target.office);
    g.rent   = rank(g.target) === 0;
    g.actual = g.rows.reduce((s, r) => s + (r.total || 0), 0);
    (byBranch[branchKey(g.target.branch_full)] ||= { groups: [], landlords: {} }).groups.push(g);
  }

  // Workbook side: landlords per branch (only branches that appear in the report)
  for (const e of book.entries) {
    const b = byBranch[e.bkey];
    if (b) (b.landlords[e.vkey] ||= { vendor: e.vendor, entries: [] }).entries.push(e);
  }

  let pools = [];   // { groups: [...], entries: [...] }
  for (const b of Object.values(byBranch)) {
    const poolOf = new Map();   // landlord vkey → pool
    const link = (g, vk) => {
      g.linked = true;
      if (!poolOf.has(vk)) {
        const p = { groups: [], entries: b.landlords[vk].entries.slice() };
        poolOf.set(vk, p);
        pools.push(p);
      }
      poolOf.get(vk).groups.push(g);
    };
    const free     = () => Object.keys(b.landlords).filter(vk => !poolOf.has(vk));
    const atOffice = (vk, okey) => okey && b.landlords[vk].entries.some(e => e.okey === okey);

    // 1. same name
    for (const g of b.groups) if (b.landlords[g.vkey]) link(g, g.vkey);

    // 2. fuzzy name — all words match, preferring a landlord at the same office;
    //    else the closest name (≥ 60% of words) among landlords at the same office
    const fuzzy = [];
    for (const g of b.groups.filter(x => !x.linked)) {
      let cand = free().filter(vk => nameScore(g.vendor, b.landlords[vk].vendor) === 1);
      if (cand.length > 1) cand = cand.filter(vk => atOffice(vk, g.okey));
      if (!cand.length && g.okey && g.rent) {
        const scored = free().filter(vk => atOffice(vk, g.okey))
          .map(vk => ({ vk, s: nameScore(g.vendor, b.landlords[vk].vendor) }))
          .filter(x => x.s >= 0.6).sort((x, y) => y.s - x.s);
        if (scored.length && (scored.length === 1 || scored[0].s > scored[1].s)) cand = [scored[0].vk];
      }
      if (cand.length === 1) fuzzy.push([g, cand[0]]);
    }
    for (const [g, vk] of fuzzy) link(g, vk);

    // 3. still-unmatched workbook lines, by office number
    const freeAt = {};
    for (const vk of free()) for (const e of b.landlords[vk].entries) if (e.okey) (freeAt[e.okey] ||= []).push(e);
    for (const [okey, entries] of Object.entries(freeAt)) {
      const left = b.groups.filter(g => !g.linked && g.rent && g.okey === okey);
      if (left.length) {
        left.forEach(g => { g.linked = true; });
        pools.push({ groups: left, entries });
        continue;
      }
      const touching = [...new Set(poolOf.values())].filter(p => p.entries.some(e => e.okey === okey));
      if (!touching.length) continue;
      const [keep, ...rest] = touching;
      for (const p of rest) {
        keep.groups.push(...p.groups);
        keep.entries.push(...p.entries);
        p.merged = true;
        for (const [vk, q] of poolOf) if (q === p) poolOf.set(vk, keep);
      }
      keep.entries.push(...entries);
    }
  }
  pools = pools.filter(p => !p.merged);

  // Workbook landlords with a line in the report window that no Zoho vendor picked up
  const used = new Set(pools.flatMap(p => p.entries));
  const unmatched = [];
  for (const b of Object.values(byBranch)) {
    for (const l of Object.values(b.landlords)) {
      const live = l.entries.filter(e => !used.has(e) && monthKeys.some(m => e.modStart <= m && m <= e.modEnd));
      if (live.length) unmatched.push({ branch: live[0].branch, vendor: l.vendor, offices: [...new Set(live.map(e => e.office))] });
    }
  }

  let matched = 0;
  for (const p of pools) {
    const tot = p.groups.reduce((s, g) => s + g.actual, 0);
    for (const g of p.groups) {
      const share = tot > 0 ? g.actual / tot : 1 / p.groups.length;
      matched++;
      for (const mkey of monthKeys) {
        const agreed = agreedForMonth(p.entries, mkey);
        const v = agreed == null ? null : Math.round(agreed * share * 100) / 100;
        g.target.agreed_monthly[mkey] = v;
        if (v) g.target.agreed_total += v;
      }
    }
  }
  return { file: book.file, matched, groups: Object.keys(groups).length, unmatched };
}

module.exports = { attachAgreed, loadAgreements, agreedForMonth, branchKey, vendorKey, officeKey, nameScore, toMonth };
