/**
 * Copies to Vercel what was added on this office PC and so exists only here:
 *  - Vendor Payment Report: the uploaded bills (files → private Blob storage) and each payment's
 *    attachments, Purchase / Accounts Team remarks and history (→ Neon)
 *  - Vendor registration documents (files → private Blob storage)
 *  - with --users: logins Vercel doesn't have, and the two Vendor Payment Report ticks
 * It only adds: nothing on Vercel is removed, and this PC's files are only read. Running it again
 * copies only what is new; a bill or remark copied once is not brought back after someone removes
 * it on Vercel.
 *
 *   PowerShell, in the dashboard folder:
 *   node server/push-pc-uploads-to-vercel.js            lists what Vercel is missing, then asks before copying
 *   node server/push-pc-uploads-to-vercel.js --dry-run  only lists
 *   add --yes to copy without asking, --users to include the logins
 *
 * It asks for two Vercel secrets (what you paste is not shown) unless they are already set:
 *   DATABASE_URL           Vercel → project → Settings → Environment Variables
 *   BLOB_READ_WRITE_TOKEN  Vercel → Storage → dashboard-files (starts with vercel_blob_rw_),
 *                          or BLOB_STORE_ID and VERCEL_OIDC_TOKEN from `vercel env pull`
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { BILL_TYPES } = require('./vendor-payment-report');

const ARGS  = new Set(process.argv.slice(2));
const DRY   = ARGS.has('--dry-run');
const YES   = ARGS.has('--yes');
const USERS = ARGS.has('--users');
const S = (...p) => path.join(__dirname, ...p);

// Same keys and folders as the app (vendor-payment-report.js, index.js, auth.js)
const NOTES_KEY   = 'vendor_payment_report_notes';
const ROWS_KEY    = 'vendor_payment_report';
const HISTORY_MAX = 50;
const VPR_TICKS   = { vpr_purchase_team: 'Purchase Team', vpr_accounts_team: 'Accounts Team' };
const BILL_DIR    = S('vpr-bill-uploads');
const VENDOR_DIR  = S('vendor-uploads');

const mb = n => (n / 1048576).toFixed(1) + ' MB';
const when = iso => (iso ? new Date(iso).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
}) : '—');
const readLocal = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const sizeOf = f => { try { return fs.statSync(f).size; } catch (_) { return -1; } };
const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// One line from the console; hidden: what is typed or pasted is not shown. One reader for the whole
// run, so lines pasted together are answered in turn.
let rl = null, lines = null, echo = null;
async function ask(question, hidden) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    rl.on('SIGINT', () => process.exit(130));
    lines = rl[Symbol.asyncIterator]();
    echo = rl._writeToOutput;
  }
  process.stdout.write(question);
  if (hidden) rl._writeToOutput = () => {};
  const { value, done } = await lines.next();
  rl._writeToOutput = echo;
  if (hidden) process.stdout.write('\n');
  return done ? '' : value.trim();
}

async function credentials() {
  // accepts the bare value, "value", or NAME="value" as copied from Vercel
  const clean = s => s.replace(/^\s*[A-Z_]+=/, '').trim().replace(/^["']|["']$/g, '');
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = clean(await ask('Paste DATABASE_URL (Vercel → Settings → Environment Variables): ', true));
  }
  if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL)) throw new Error('DATABASE_URL should start with postgres:// or postgresql://');
  if (!process.env.BLOB_READ_WRITE_TOKEN && !(process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN)) {
    process.env.BLOB_READ_WRITE_TOKEN = clean(await ask('Paste BLOB_READ_WRITE_TOKEN (Vercel → Storage → dashboard-files): ', true));
    if (!process.env.BLOB_READ_WRITE_TOKEN.startsWith('vercel_blob_rw_')) throw new Error('The Blob token should start with vercel_blob_rw_');
  }
}

// A document stored in Neon, null when there is none. A failed read stops the run, so it is never
// taken for "Vercel has nothing" (readJSON alone returns the default on errors).
async function readStored(db, key) {
  if (!(await db.listKeys(key)).some(r => r.key === key)) return null;
  const v = await db.readJSON(key, null, undefined);
  if (v === undefined) throw new Error(`could not read "${key}" from Neon`);
  return v;
}

// pathname → size of every file stored under a Blob folder
async function blobSizes(blob, prefix) {
  const out = new Map();
  let cursor;
  do {
    const r = await blob.list({ prefix, cursor, limit: 1000 });
    for (const b of r.blobs) out.set(b.pathname, b.size);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

// The same bill uploaded on Vercel again: same file name and size
const twinOf = (bills, b) => bills.find(x => x.id !== b.id && x.name === b.name && x.size === b.size);

// Vercel's notes plus what only this PC has. Vercel keeps its own bills and history; a remark is
// replaced only when this PC's is newer. inBlob(pathname) says whether a bill's file is stored —
// a bill is attached only then, so Vercel never lists a bill it cannot open.
function mergeNotes(pc, vc, inBlob) {
  const out = vc ? JSON.parse(JSON.stringify(vc)) : { v: pc.v, items: {} };
  const copied = new Set(out.copied_from_pc || []);
  const added = { bills: [], remarks: [], history: 0 };
  const kept = [];   // remarks left as they are: Vercel's is newer
  for (const [pid, p] of Object.entries(pc.items || {})) {
    const n = out.items[pid] || { bills: [], purchase_remark: null, accounts_remark: null, history: [] };
    const vBills = [...n.bills];
    let changed = false;
    for (const b of p.bills || []) {
      const key = `${pid}/${b.id}`;
      if (vBills.some(x => x.id === b.id) || twinOf(vBills, b) || copied.has(key) || !inBlob(`vpr-bill-uploads/${pid}/${b.id}`)) continue;
      n.bills.push(b); copied.add(key); added.bills.push({ pid, ...b }); changed = true;
    }
    n.bills.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const team of ['purchase', 'accounts']) {
      const k = `${team}_remark`, r = p[k], cur = n[k];
      const key = `${pid}/${team}/${r?.at}`;
      if (!r?.text || copied.has(key) || cur?.text === r.text) continue;
      if (cur && String(cur.at) > String(r.at)) { kept.push({ pid, team, vercel: cur, pc: r }); continue; }
      n[k] = r; copied.add(key); added.remarks.push({ pid, team, ...r }); changed = true;
    }
    const seen = new Set(n.history.map(h => `${h.at}|${h.by_id}|${h.action}`));
    for (const h of p.history || []) {
      if (seen.has(`${h.at}|${h.by_id}|${h.action}`)) continue;
      n.history.push(h); added.history++; changed = true;
    }
    n.history.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    n.history = n.history.slice(-HISTORY_MAX);
    if (changed) out.items[pid] = n;
  }
  out.copied_from_pc = [...copied];
  const changed = added.bills.length + added.remarks.length + added.history > 0;
  if (changed) out.updated_at = new Date().toISOString();
  return { notes: out, added, kept, changed };
}

// PC logins Vercel doesn't have (matched by id, then user name), and Vendor Payment Report ticks
// given on this PC that Vercel lacks. Nothing else about an existing Vercel login is changed.
function compareUsers(pcUsers, vUsers) {
  const fresh = [], ticks = [], purchaseOff = [];
  for (const u of pcUsers) {
    const v = vUsers.find(x => String(x.id) === String(u.id)) || vUsers.find(x => sameName(x.username, u.username));
    if (!v) { fresh.push(u); continue; }
    const want = Object.keys(VPR_TICKS).filter(k =>
      u.permissions?.purchase?.sections?.[k] === true && v.permissions?.purchase?.sections?.[k] !== true);
    if (!want.length) continue;
    ticks.push({ id: String(v.id), name: v.name || v.username, want });
    if (v.role !== 'admin' && !v.permissions?.purchase?.enabled) purchaseOff.push(v.name || v.username);
  }
  return { fresh, ticks, purchaseOff };
}
function mergeUsers(vUsers, diff) {
  const out = JSON.parse(JSON.stringify(vUsers));
  for (const t of diff.ticks) {
    const v = out.find(x => String(x.id) === t.id);
    const p = ((v.permissions ||= {}).purchase ||= { enabled: false, sections: {} });
    p.sections ||= {};
    for (const k of t.want) p.sections[k] = true;
  }
  return out.concat(diff.fresh);
}

async function check(db, blob) {
  const pcNotes = readLocal(S(`${NOTES_KEY}.json`), null);
  const pcRows  = new Map((readLocal(S('sync_data', `${ROWS_KEY}.json`), null)?.rows || []).map(r => [r.id, r]));
  const pcRegs  = readLocal(S('vendor_registrations.json'), []);
  const pcUsers = readLocal(S('users.json'), []);

  const [vNotes, vRows, vRegs, vUsers, billBlobs, docBlobs] = await Promise.all([
    readStored(db, NOTES_KEY), readStored(db, ROWS_KEY), readStored(db, 'vendor_registrations'), readStored(db, 'users'),
    blobSizes(blob, 'vpr-bill-uploads/'), blobSizes(blob, 'vendor-uploads/'),
  ]);

  // Bills: attach those whose file is stored or can be copied from this PC
  const pcBills = [];
  for (const [pid, n] of Object.entries(pcNotes?.items || {})) {
    for (const b of n.bills || []) {
      const blobPath = `vpr-bill-uploads/${pid}/${b.id}`;
      const file = path.join(BILL_DIR, pid, b.id);
      pcBills.push({ pid, b, blobPath, file, size: sizeOf(file), row: pcRows.get(pid) });
    }
  }
  const canStore = new Set(pcBills.filter(x => billBlobs.has(x.blobPath) || x.size >= 0).map(x => x.blobPath));
  const merge = pcNotes ? mergeNotes(pcNotes, vNotes, p => canStore.has(p)) : null;
  const attached = new Set(Object.entries(merge?.notes.items || {}).flatMap(([pid, n]) => n.bills.map(b => `vpr-bill-uploads/${pid}/${b.id}`)));
  const adding = new Set((merge?.added.bills || []).map(b => `vpr-bill-uploads/${b.pid}/${b.id}`));

  const files = [];
  const bills = { total: pcBills.length, onVercel: 0, toCopy: [], reuploaded: [], removedOnVercel: [], missingOnPc: [] };
  for (const x of pcBills) {
    if (!attached.has(x.blobPath) && twinOf(vNotes?.items?.[x.pid]?.bills || [], x.b)) {
      bills.onVercel++; bills.reuploaded.push(x);
      continue;
    }
    if (!attached.has(x.blobPath)) {
      (x.size < 0 && !billBlobs.has(x.blobPath) ? bills.missingOnPc : bills.removedOnVercel).push(x);
      continue;
    }
    const needFile = !billBlobs.has(x.blobPath);
    if (needFile) files.push({ blobPath: x.blobPath, file: x.file, size: x.size, type: x.b.type || BILL_TYPES[path.extname(x.b.id).toLowerCase()], bill: x });
    if (needFile || adding.has(x.blobPath)) bills.toCopy.push(x); else bills.onVercel++;
  }

  // Vendor registration documents of registrations Vercel has
  const docs = { total: 0, onVercel: 0, missingOnPc: [], regNotOnVercel: [] };
  for (const r of pcRegs) {
    const name = r.data?.vendorLegalName || r.id;
    const onVercel = (vRegs || []).some(x => x.id === r.id);
    for (const filename of Object.values(r.files || {})) {
      const blobPath = `vendor-uploads/${r.id}/${filename}`;
      const file = path.join(VENDOR_DIR, r.id, filename);
      docs.total++;
      if (docBlobs.has(blobPath)) docs.onVercel++;
      else if (!onVercel) docs.regNotOnVercel.push(`${name} — ${filename}`);
      else if (sizeOf(file) < 0) docs.missingOnPc.push(`${name} — ${filename}`);
      else files.push({ blobPath, file, size: sizeOf(file), type: BILL_TYPES[path.extname(filename).toLowerCase()], doc: `${name} — ${filename}` });
    }
  }

  const users = vUsers ? compareUsers(pcUsers, vUsers) : null;
  const vRowIds = new Set((vRows?.rows || []).map(r => r.id));
  const shown = Object.entries(pcNotes?.items || {})
    .filter(([, n]) => n.bills?.length || n.purchase_remark || n.accounts_remark).map(([pid]) => pid);
  return { pcNotes, merge, files, bills, docs, users, vRows, notInVercelRows: shown.filter(pid => !vRowIds.has(pid)), billBlobs, docBlobs };
}

function report(plan) {
  const { merge, files, bills, docs, users, vRows } = plan;
  const docFiles = files.filter(f => f.doc);
  const line = s => console.log(s);

  line('\nVendor Payment Report — bills uploaded on this PC');
  line(`  attached here: ${bills.total}   already on Vercel: ${bills.onVercel}   missing on Vercel: ${bills.toCopy.length}`);
  for (const x of bills.toCopy) {
    const where = x.row ? `${x.row.vendor} · ${x.row.number}` : `payment ${x.pid}`;
    line(`   ${when(x.b.at).padEnd(17)} ${where.slice(0, 52).padEnd(52)}  ${x.b.name}  — ${x.b.by?.name || '?'}`);
  }
  if (bills.reuploaded.length) line(`  already uploaded again on Vercel, not copied (no duplicates): ${bills.reuploaded.map(x => x.b.name).join(', ')}`);
  if (bills.removedOnVercel.length) line(`  not copied again (removed on Vercel after an earlier copy): ${bills.removedOnVercel.map(x => x.b.name).join(', ')}`);
  if (bills.missingOnPc.length) line(`  file missing on this PC too, cannot be copied: ${bills.missingOnPc.map(x => x.b.name).join(', ')}`);
  if (merge) {
    const by = t => merge.added.remarks.filter(r => r.team === t).length;
    line(`  remarks missing on Vercel: ${by('purchase')} Purchase Team, ${by('accounts')} Accounts Team; history entries: ${merge.added.history}`);
    for (const k of merge.kept) line(`  kept Vercel's newer ${k.team} remark on payment ${k.pid} ("${k.vercel.text.slice(0, 40)}"), not this PC's ("${k.pc.text.slice(0, 40)}")`);
  }
  if (!vRows) line("  Vercel hasn't built this report yet — the bills and remarks show there once its first sync of the report finishes.");
  else {
    line(`  Vercel's report data: ${vRows.rows.length.toLocaleString('en-IN')} payments, built ${when(vRows.built_at)}`);
    if (plan.notInVercelRows.length) line(`  ${plan.notInVercelRows.length} payment(s) with bills or remarks aren't in Vercel's report data yet; they show once it has them`);
  }

  line('\nVendor registration documents');
  line(`  on this PC: ${docs.total}   already on Vercel: ${docs.onVercel}   missing on Vercel: ${docFiles.length}`);
  for (const f of docFiles) line(`   ${f.doc}`);
  for (const d of docs.regNotOnVercel) line(`   not copied — this registration isn't on Vercel: ${d}`);
  for (const d of docs.missingOnPc) line(`   file missing on this PC too: ${d}`);

  if (users) {
    line('\nLogins');
    line(`  on this PC but not on Vercel: ${users.fresh.length ? users.fresh.map(u => u.name || u.username).join(', ') : 'none'}`);
    line(`  Vendor Payment Report ticks missing on Vercel: ${users.ticks.length ? users.ticks.map(t => `${t.name} (${t.want.map(k => VPR_TICKS[k]).join(' + ')})`).join(', ') : 'none'}`);
    if (users.purchaseOff.length) line(`  Purchase & Payables is switched off on Vercel for: ${users.purchaseOff.join(', ')} — tick it for them in User Settings there`);
    if ((users.fresh.length || users.ticks.length) && !USERS) line('  (not copied: add --users to copy these logins and ticks)');
  }
  line(`\nTo copy: ${files.length} file(s), ${mb(files.reduce((s, f) => s + f.size, 0))}` +
    `${merge?.changed ? ', plus the bill attachments, remarks and history' : ''}` +
    `${USERS && users && (users.fresh.length || users.ticks.length) ? ', plus the logins and ticks' : ''}`);
}

async function push(db, blob, fileStore, plan) {
  const failed = [];
  let done = 0;
  for (const f of plan.files) {
    try {
      const buf = fs.readFileSync(f.file);
      await fileStore.save(f.blobPath, buf, f.type);
      const h = await blob.head(f.blobPath);
      if (h.size !== buf.length) throw new Error(`stored ${h.size} bytes instead of ${buf.length}`);
      (f.bill ? plan.billBlobs : plan.docBlobs).set(f.blobPath, h.size);
      console.log(`  copied ${++done}/${plan.files.length}  ${f.bill ? f.bill.b.name : f.doc}`);
    } catch (e) {
      failed.push(`${f.bill ? f.bill.b.name : f.doc}: ${e.message}`);
    }
  }
  if (plan.pcNotes) {
    // merged again with Vercel's latest notes, so an edit made there meanwhile is kept
    const m = mergeNotes(plan.pcNotes, await readStored(db, NOTES_KEY), p => plan.billBlobs.has(p));
    if (m.changed) await db.writeJSON(NOTES_KEY, null, m.notes);
    console.log(`  Vendor Payment Report: ${m.added.bills.length} bill(s) attached, ${m.added.remarks.length} remark(s) and ${m.added.history} history entries added`);
  }
  if (USERS && plan.users && (plan.users.fresh.length || plan.users.ticks.length)) {
    const vUsers = await readStored(db, 'users');
    if (!vUsers?.length) throw new Error('Vercel has no logins stored — not copying any');
    const diff = compareUsers(readLocal(S('users.json'), []), vUsers);
    await db.writeJSON('users', null, mergeUsers(vUsers, diff));
    console.log(`  Logins: ${diff.fresh.length} added, Vendor Payment Report ticks given to ${diff.ticks.length}`);
  }
  if (failed.length) {
    console.log(`\n${failed.length} file(s) could not be copied (not attached on Vercel; run this again to retry):`);
    for (const f of failed) console.log(`  ${f}`);
  }
  return { copied: done, failed };
}

async function main() {
  await credentials();
  const db = require('./db');
  const blob = require('@vercel/blob');
  const fileStore = require('./file-store');

  console.log('Checking what Vercel is missing…');
  const plan = await check(db, blob);
  report(plan);

  const userWork = USERS && plan.users && (plan.users.fresh.length || plan.users.ticks.length);
  if (!plan.files.length && !plan.merge?.changed && !userWork) { console.log('\nNothing to copy — Vercel already has everything listed above.'); return; }
  if (DRY) { console.log('\nDry run — nothing copied.'); return; }
  if (!YES) {
    if (!process.stdin.isTTY) { console.log('\nNothing copied: run again with --yes to copy.'); return; }
    if ((await ask('\nCopy these to Vercel now? Type YES to copy: ')) !== 'YES') { console.log('Nothing copied.'); return; }
  }
  console.log('\nCopying…');
  const r = await push(db, blob, fileStore, plan);
  console.log(r.failed.length ? '\nFinished with errors (see above).' : '\nDone. Refresh the page on Vercel to see them.');
}

module.exports = { main, mergeNotes, compareUsers, mergeUsers };
if (require.main === module) {
  // a moment for the database / storage connections to settle first: exiting while they close
  // trips a libuv assertion on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)")
  const end = code => { if (rl) rl.close(); setTimeout(() => process.exit(code), 300); };
  main().then(() => end(0), e => { console.error('\nStopped:', e.message); end(1); });
}
