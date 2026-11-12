/**
 * Automatic sync online: the scheduled tick (GET /api/cron/gstr2b), the way it is wired into the dashboard, and the GitHub job that
 * calls it. Uses a fake Zoho and a temporary store. SYNTHETIC data.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');
const express = require('express');
const { tempDir, rm } = require('./helpers');
const F = require('./fakeZoho');
const store = require('../lib/store');
const files = require('../lib/files');
const books = require('../lib/booksStore');
const AUD = require('../lib/audit');

const ROOT = path.join(__dirname, '..', '..', '..');
const COMPANY = { id: 'devx', name: 'Test Co', short: 'T', org_id: F.ORG, active: true, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number',
  registrations: [{ gstin: F.REC_A, label: 'GJ', branch_ids: ['br_a'], active: true }, { gstin: F.REC_B, label: 'MH', branch_ids: ['br_b'], active: true }] };
const later = s => new Date(Date.now() + s * 1000).toISOString().replace(/\.\d+Z$/, '+0000');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(companies = [COMPANY], sync = {}) {
  const dir = tempDir();
  store.configure({ dir: dir + '/data', useDb: false });
  files.configure({ dir: dir + '/files', blob: null });
  const router = require('../index');
  const zr = F.makeFake();
  Object.assign(zr, { listOrganizations: async () => [], listBranches: async () => F.BRANCHES, checkAccess: async () => ({ ok: true, results: [] }) });
  await store.write('config', { companies, sync: { pace_ms: 0, daily_budget: 1000, slice_seconds: 60, ...sync } });
  const ctx = router.init({ zr, loadUsers: async () => [], log: { error() {} } });
  zr.put('bills', F.bill({ id: 'b1', no: 'INV/1', date: '2026-10-12', taxable: 1000 }));
  zr.put('bills', F.bill({ id: 'b2', no: 'INV/2', date: '2026-10-14', taxable: 2000, tax: 'inter', gst: F.SUP_MH, branch: 'br_b', dest: 'MH' }));
  zr.put('credits', F.credit({ id: 'c1', no: 'CN/1', date: '2026-10-18' }));
  return { dir, zr, router, sync: ctx.sync, close: () => { router.stopScheduler(); rm(dir); } };
}
const entries = async () => (await AUD.month(new Date().toISOString().slice(0, 7))).filter(e => !!e);
const firstSync = sync => sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10', by: 'user' });

test('the tick leaves a company alone until it has had its first sync — no Zoho call, nothing recorded', async () => {
  const t = await boot();
  try {
    const out = await t.router.cronTick();
    assert.deepEqual(out, { ok: true, mode: 'incremental', more: false, results: [{ company: 'devx', status: 'needs_first_sync' }] });
    assert.equal(t.zr.calls.total, 0, 'not a single Zoho call');
    assert.equal((await t.sync.loadState('devx')).runs.length, 0);
  } finally { t.close(); }
});

test('the tick reads what changed (a new and an edited bill), fetches their amounts, reconciles, and is recorded as a scheduled run', async () => {
  const t = await boot();
  try {
    assert.equal((await firstSync(t.sync)).status, 'completed');
    const auditBefore = (await entries()).length, runsBefore = (await t.sync.loadState('devx')).runs.length;
    t.zr.put('bills', F.bill({ id: 'b1', no: 'INV/1', date: '2026-10-12', taxable: 1500, lmt: later(5) }));       // edited
    t.zr.put('bills', F.bill({ id: 'b9', no: 'INV/9', date: '2026-11-03', taxable: 300, lmt: later(6) }));        // new
    const out = await t.router.cronTick();
    assert.equal(out.more, false); assert.equal(out.results.length, 1);
    assert.equal(out.results[0].status, 'completed'); assert.equal(out.results[0].fetched, 2);
    const st = await t.sync.loadState('devx');
    assert.equal(st.runs.length, runsBefore + 1); assert.equal(st.runs[0].by, 'schedule');
    assert.equal((await books.all('devx')).find(d => d.zoho_id === 'b1').amounts.taxable, 150000);
    const after = await entries();
    assert.ok(after.length > auditBefore); assert.ok(after.some(e => e.action === 'sync.incremental' && e.by === 'schedule'));
    assert.ok(after.some(e => e.action === 'recon.run' && e.by === 'schedule'), 'the work was reconciled');
    assert.equal(st.last_auto.quiet, false); assert.equal(st.last_auto.mode, 'incremental');
  } finally { t.close(); }
});

test('a tick that finds nothing is not written to the history or the audit trail, but the page still shows when it ran', async () => {
  const t = await boot();
  try {
    await firstSync(t.sync);
    await t.router.cronTick();                                                      // settle: nothing changed since the first sync
    const runs = (await t.sync.loadState('devx')).runs.length, audit = (await entries()).length;
    for (let i = 0; i < 5; i++) { const out = await t.router.cronTick(); assert.equal(out.results[0].status, 'completed'); assert.equal(out.results[0].fetched, 0); assert.equal(out.more, false); }
    const st = await t.sync.loadState('devx');
    assert.equal(st.runs.length, runs, 'five idle ticks add nothing to "Recent sync runs"');
    assert.equal((await entries()).length, audit, 'and nothing to the audit trail');
    assert.equal(st.last_auto.quiet, true); assert.ok(Date.now() - Date.parse(st.last_auto.at) < 5000);
    const status = await t.sync.status('devx');
    assert.equal(status.auto_last.quiet, true); assert.equal(status.auto_last.status, 'completed');
    assert.ok(status.budget.used > 0, 'an idle tick still costs its few list calls, counted in the day\'s budget');
  } finally { t.close(); }
});

test('a user\'s own run is recorded as before; a scheduled run that does work is recorded; the user\'s idle run is not "quiet"', async () => {
  const t = await boot();
  try {
    await firstSync(t.sync);
    const runs = (await t.sync.loadState('devx')).runs.length;
    const r = await t.sync.run({ company: 'devx', mode: 'incremental', by: 'Admin' });
    assert.equal(r.status, 'completed'); assert.equal(r.quiet, false);
    assert.equal((await t.sync.loadState('devx')).runs.length, runs + 1, 'a manual run with nothing new is still shown');
    assert.equal((await t.sync.loadState('devx')).last_auto, undefined, 'and is not taken for an automatic run');
  } finally { t.close(); }
});

test('a step that ends at its time slice says there is more to do, and is not reconciled yet; the next step continues', async () => {
  const t = await boot();
  try {
    await firstSync(t.sync);
    for (let i = 0; i < 6; i++) t.zr.put('bills', F.bill({ id: `n${i}`, no: `NEW/${i}`, date: '2026-11-05', taxable: 100 + i, lmt: later(10 + i) }));
    const reconBefore = (await entries()).filter(e => e.action === 'recon.run').length;
    const a = await t.router.cronTick({ maxMs: 1 });
    assert.equal(a.results[0].status, 'partial'); assert.equal(a.more, true);
    assert.equal((await entries()).filter(e => e.action === 'recon.run').length, reconBefore, 'no reconciliation after a partial step');
    let steps = 1, out = a;
    while (out.more && steps < 12) { out = await t.router.cronTick({ maxMs: 1 }); steps++; }
    const last = await t.router.cronTick();                                          // a normal-length step finishes whatever is left
    assert.equal(last.more, false); assert.equal(last.results[0].status, 'completed');
    assert.equal((await books.stats('devx')).pending, 0, 'every new bill has its amounts');
    assert.ok((await entries()).filter(e => e.action === 'recon.run').length > reconBefore, 'reconciled once the work was done');
  } finally { t.close(); }
});

test('the daily budget stops the work for the day without asking the caller to come back at once', async () => {
  const t = await boot([COMPANY], { daily_budget: 6 });
  try {
    await firstSync(t.sync);                                                         // uses the small budget up
    for (let i = 0; i < 4; i++) t.zr.put('bills', F.bill({ id: `q${i}`, no: `Q/${i}`, date: '2026-11-05', taxable: 100, lmt: later(20 + i) }));
    const out = await t.router.cronTick();
    assert.ok(['paused_budget', 'completed'].includes(out.results[0].status));
    assert.equal(out.more, false, 'a pause for the budget is not "more to do now"');
  } finally { t.close(); }
});

test('the night tick is a re-check: a bill deleted in Zoho is found', async () => {
  const t = await boot();
  try {
    await firstSync(t.sync);
    t.zr.remove('bills', 'b1');
    assert.equal((await t.router.cronTick()).results[0].fetched, 0, 'the change feed cannot see a deletion');
    const out = await t.router.cronTick({ mode: 'recheck' });
    assert.equal(out.mode, 'recheck'); assert.equal(out.results[0].status, 'completed');
    const b1 = (await books.all('devx')).find(d => d.zoho_id === 'b1');
    assert.equal(b1.deleted, true);
    assert.equal((await t.sync.loadState('devx')).last_auto.mode, 'recheck');
  } finally { t.close(); }
});

test('only companies that are set up, switched on and have a GSTIN switched on are visited; a run in progress is respected', async () => {
  const demo = { ...COMPANY, id: 'demo', demo: true }, off = { ...COMPANY, id: 'off', active: false }, noGstin = { ...COMPANY, id: 'nog', registrations: COMPANY.registrations.map(r => ({ ...r, active: false })) };
  const t = await boot([demo, off, noGstin, COMPANY]);
  try {
    assert.deepEqual((await t.router.cronTick()).results.map(r => r.company), ['devx']);
    // a sync already running (a person's click or an earlier step) is not started twice
    const slow = fn => async (...a) => { await sleep(15); return fn(...a); };
    t.zr.get = slow(t.zr.get.bind(t.zr)); t.zr.list = slow(t.zr.list.bind(t.zr));
    const running = firstSync(t.sync);
    await sleep(40);
    assert.deepEqual((await t.router.cronTick()).results, [{ company: 'devx', status: 'busy' }]);
    await running;
  } finally { t.close(); }
});

test('the endpoint answers in the shape the GitHub job reads, takes the mode from the query, and reports a failure as an error', async () => {
  const t = await boot();
  try {
    await firstSync(t.sync);
    const app = express(); app.get('/api/cron/gstr2b', t.router.cron);
    const server = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/cron/gstr2b`;
      const a = await fetch(base); const aj = await a.json();
      assert.equal(a.status, 200); assert.equal(aj.ok, true); assert.equal(aj.mode, 'incremental'); assert.equal(aj.more, false);
      assert.match(JSON.stringify(aj), /"more":false/, 'compact JSON: the job greps for "more":true');
      assert.equal((await (await fetch(`${base}?mode=recheck`)).json()).mode, 'recheck');
      assert.equal((await (await fetch(`${base}?mode=anything`)).json()).mode, 'incremental', 'only "recheck" is accepted as a mode');
      t.router.cronTick = async () => { throw new Error('boom'); };
      const bad = await fetch(base); assert.equal(bad.status, 500); assert.equal((await bad.json()).ok, false);
    } finally { server.closeAllConnections && server.closeAllConnections(); await new Promise(r => server.close(r)); }
  } finally { t.close(); }
});

test('wiring: the route is in the dashboard server behind the same Bearer check as the other cron routes, and is let through the login gate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/cron\/gstr2b', cronAuth, gstr2b\.cron\);/);
  assert.match(src, /'GET \/api\/cron\/gstr2b',/);
  assert.match(src, /function cronAuth\(req, res, next\) \{\s*const secret = process\.env\.CRON_SECRET;\s*if \(!secret \|\| req\.headers\.authorization !== `Bearer \$\{secret\}`\) return res\.status\(401\)/, 'without CRON_SECRET the route always answers 401');
});

// ── The GitHub job ──────────────────────────────────────────────────────────────
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'gstr2b-sync.yml');
const workflowText = () => fs.readFileSync(WORKFLOW, 'utf8');
const scriptOf = () => {
  const lines = workflowText().split(/\r?\n/);
  const i = lines.findIndex(l => /^\s+run: \|\s*$/.test(l));
  const indent = lines[i + 1].match(/^ */)[0].length;
  const out = [];
  for (let k = i + 1; k < lines.length && (lines[k].trim() === '' || lines[k].startsWith(' '.repeat(indent))); k++) out.push(lines[k].slice(indent));
  return out.join('\n');
};

test('the GitHub job: a run every 15 minutes in the working day, a night re-check, a manual button, the existing secrets — and minutes that miss the other syncs', () => {
  const y = workflowText();
  const crons = [...y.matchAll(/- cron: '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(crons, ['7,22,37,52 3-17 * * *', '30 19 * * *']);
  const [mins, hours] = crons[0].split(' ');
  assert.equal(mins.split(',').length, 4, 'four runs an hour');
  // India time = UTC + 5:30: the dashboard's own Zoho sync starts at :30 and the office PC at :00 / :10 / :20 — none of ours may coincide
  for (const m of mins.split(',').map(Number)) assert.ok(![0, 10, 20, 30].includes((m + 30) % 60), `minute ${m} UTC = :${(m + 30) % 60} IST`);
  assert.equal(hours, '3-17', '8:37 AM to 11:22 PM IST');
  assert.ok(!hours.split('-').some(h => Number(h) === 19), 'the night run is not also a daytime run');
  assert.match(y, /workflow_dispatch:/); assert.match(y, /secrets\.APP_URL/); assert.match(y, /secrets\.CRON_SECRET/); assert.match(y, /\/api\/cron\/gstr2b\?mode=\$mode/);
  assert.match(y, /if: env\.APP_URL != ''/, 'does nothing until APP_URL is set');
  assert.match(y, /concurrency:\s*\n\s+group: gstr2b-sync\s*\n\s+cancel-in-progress: false/, 'runs queue; they never overlap');
  assert.match(y, /permissions:\s*\n\s+contents: read/);
  assert.match(y, /timeout-minutes: 170/);
});

// The job's own script is run against a local stand-in for the dashboard (needs bash: Git Bash on Windows, any Linux / Mac)
const hasBash = (() => { try { return spawnSync('bash', ['-c', 'exit 0']).status === 0; } catch (_) { return false; } })();
async function runJob({ drain = '', schedule = '', status = 200, moreFor = 0, secret = 'good' } = {}) {
  const seen = [];
  const server = await new Promise(r => { const s = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer good') { res.writeHead(401); return res.end('{"error":"Unauthorized"}'); }
    if (status !== 200) { res.writeHead(status); return res.end('{"ok":false}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: 'incremental', more: seen.length <= moreFor, results: [] }));
  }).listen(0, '127.0.0.1', () => r(s)); });
  const dir = tempDir();
  try {
    const file = path.join(dir, 'job.sh'); fs.writeFileSync(file, scriptOf());
    const child = spawn('bash', [file], { cwd: dir, env: { ...process.env, APP_URL: `http://127.0.0.1:${server.address().port}/`, CRON_SECRET: secret, SCHEDULE: schedule, DRAIN: drain, STEP_PAUSE: '0' } });      // the real job pauses 5 s between steps
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    const code = await new Promise(r => child.on('close', r));
    return { code, out, seen };
  } finally { server.closeAllConnections && server.closeAllConnections(); await new Promise(r => server.close(r)); rm(dir); }
}

test('the job script: one call when there is nothing more, at most 3 steps on a schedule, until done when drained, and the night run asks for a re-check', { skip: !hasBash && 'bash is not available here' }, async () => {
  const idle = await runJob();
  assert.equal(idle.code, 0); assert.equal(idle.seen.length, 1); assert.equal(idle.seen[0].url, '/api/cron/gstr2b?mode=incremental'); assert.equal(idle.seen[0].auth, 'Bearer good');
  const night = await runJob({ schedule: '30 19 * * *' });
  assert.equal(night.seen[0].url, '/api/cron/gstr2b?mode=recheck');
  const backlog = await runJob({ moreFor: 100 });
  assert.equal(backlog.code, 0); assert.equal(backlog.seen.length, 3, 'a scheduled run takes at most 3 steps');
  const drain = await runJob({ drain: 'true', moreFor: 6 });
  assert.equal(drain.code, 0); assert.equal(drain.seen.length, 7, 'the manual run keeps going until the dashboard says there is no more');
  assert.match(drain.out, /step 7: \{"ok":true,"mode":"incremental","more":false/);
});

test('the job script: a wrong CRON_SECRET fails loudly; a dashboard that is down or slow is a warning, not a failed run', { skip: !hasBash && 'bash is not available here' }, async () => {
  const wrong = await runJob({ secret: 'bad' });
  assert.equal(wrong.code, 1); assert.match(wrong.out, /::error::The dashboard refused the CRON_SECRET \(401\)/);
  const down = await runJob({ status: 500 });
  assert.equal(down.code, 0); assert.match(down.out, /::warning::step 1: HTTP 500/); assert.equal(down.seen.length, 1, 'it does not hammer a failing dashboard');
});
