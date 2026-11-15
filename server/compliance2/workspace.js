/**
 * Workspace routes (V2 updates, V3 TDS section-wise, V7 reports, V8 reconciliation inputs, V9 trends, V10 payroll imports
 * and tax-audit working papers) — mounted on the Compliance v2 router by index.js (same login, rights, spaces and audit).
 *
 * Rights: entering figures = prepare (or file); reviewing someone else's figures = review / approve (never the preparer —
 * checked in lib/*); master lists = rules; feed settings = admin. Auditors read only.
 * Illustrative (demo seed) records live only in the demo space and are reported as their own dataset.
 */

'use strict';

const U = require('./lib/util');
const S = require('./lib/service');
const AC = require('./lib/access');
const DOC = require('./lib/documents');
const AT = require('./lib/attachments');
const P = require('./lib/payments');
const TDS = require('./lib/tds');
const R = require('./lib/recon');
const MI = require('./lib/memberImports');
const TA = require('./lib/taxAudit');
const UP = require('./lib/updates');
const REP = require('./lib/reports');
const RU = require('./lib/rules');
const BL = require('./lib/blobs');
const CAT = require('./lib/catalogue');

function mount(router, h) {
  const { gate, wrap, audit, upload, store, MAX_MB, derivedTasks, slim, isVercel } = h;
  const writer = req => { if (!AC.canWrite(req.c2.actor)) throw U.httpError(403, 'Read-only (auditor) access'); };
  const seeEntity = (req, id) => { if (!AC.canSeeEntity(req.c2.actor, id)) throw U.httpError(404, 'Not found'); };
  const visible = req => id => AC.canSeeEntity(req.c2.actor, id);
  const list = v => (v === undefined || v === '' ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean));
  const illustrativeOf = req => req.c2.sp === 'demo' && req.query.dataset !== 'recorded';
  const tx = fn => store.transaction(fn);
  const load = (src, req, names) => S.load(src, req.c2.sp, names);
  const save = (t, req, name, value) => S.set(t, req.c2.sp, name, value);

  // ── Constants ───────────────────────────────────────────────────────────────
  router.get('/ws/meta', gate(), wrap(async (req, res) => {
    res.json({
      payment_sections: P.SECTIONS, payable_sections: P.PAYABLE, payment_components: P.COMPONENTS, file_kinds: AT.KINDS,
      tds: { acts: TDS.ACTS, itns: TDS.ITNS, deductee: TDS.DEDUCTEE, components: TDS.COMPONENTS, max_281n: TDS.MAX_281N_CODES },
      recon: { types: R.TYPES, reg_of: R.REG_OF, statuses: R.STATUSES, grid: R.GRID, fields: R.FIELDS, gst_heads: R.GST_HEADS },
      imports: { funds: MI.FUNDS, map_keys: MI.MAP_KEYS, map_labels: MI.MAP_LABELS, statuses: MI.STATUSES },
      taxaudit: { kinds: TA.KINDS }, updates: { topics: UP.TOPICS, kinds: UP.KINDS, statuses: UP.STATUSES, impact: UP.IMPACT, official: UP.OFFICIAL },
      report_pages: REP.RECON_PAGES, datasets: req.c2.sp === 'demo' ? ['illustrative', 'recorded'] : ['recorded'],
    });
  }));

  // ── Build prompt (the specification this module is built from) ──────────────
  // It names people and companies, so it is never part of the code: it lives in the store (an administrator uploads it) or,
  // on the office PC, in the git-ignored data folder as build_prompt.txt. Shown as plain text only.
  const promptClean = t => String(t || '').replace(/^﻿/, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 300000);
  router.get('/ws/prompt', gate(), wrap(async (req, res) => {
    let p = await store.read('build_prompt', null);
    if (!p?.text) {
      try { const text = require('fs').readFileSync(require('path').join(store.dataDir(), 'build_prompt.txt'), 'utf8'); p = { text: promptClean(text), source: 'data folder (build_prompt.txt)' }; } catch (_) { p = null; }
    }
    res.json(p ? { text: p.text, source: p.source || `uploaded by ${p.uploaded_by} on ${U.istText(p.at)} IST`, sha256: U.sha256(p.text).slice(0, 16), length: p.text.length } : { text: null });
  }));
  router.put('/ws/prompt', gate('admin'), upload.single('file'), wrap(async (req, res) => {
    const text = promptClean(req.file?.buffer ? req.file.buffer.toString('utf8') : req.body?.text);
    if (text.trim().length < 50) throw U.httpError(400, 'Upload the build prompt as a .txt file');
    await tx(async t => { t.set('build_prompt', { text, uploaded_by: req.c2.actor.name, at: U.nowIso() }); await audit(t, req, { action: 'build_prompt_uploaded', object_type: 'settings', object_id: 'build_prompt', summary: `Build prompt replaced (${text.length} characters, sha256 ${U.sha256(text).slice(0, 12)}…)` }); });
    res.json({ ok: true, length: text.length });
  }));

  // ── Evidence files for workspace records ────────────────────────────────────
  const ATTACH = {
    payment: { doc: 'payments', find: (d, id) => d.payments.find(x => x.id === id), list: x => x.evidence, locked: x => (x.status === 'reversed' ? 'This payment is reversed' : null) },
    tds_challan: { doc: 'tds', find: (d, id) => d.challans.find(x => x.id === id), list: x => x.evidence, locked: x => (x.status === 'reversed' ? 'This challan is reversed' : x.review.status === 'reviewed' ? 'The challan is reviewed and locked' : null) },
    recon: { doc: 'recon', find: (d, id) => d.records.find(x => x.id === id), list: x => x.evidence, locked: x => (x.status !== 'draft' ? 'Only a draft takes new evidence — return it to draft first' : null) },
    taxaudit_payment: { doc: 'taxaudit', find: (d, id) => d.payments.find(x => x.id === id), list: x => x.proof, locked: x => (x.verified ? 'A verified payment is locked' : x.status === 'reversed' ? 'This payment is reversed' : null) },
    import_batch: { doc: 'imports', find: (d, id) => d.batches.find(x => x.id === id), list: x => x.proof, locked: () => null },
  };
  router.post('/files', gate(['prepare', 'file']), upload.single('file'), wrap(async (req, res) => {
    writer(req);
    const { sp, actor, settings } = req.c2;
    const entityId = String(req.body?.entity_id || '');
    seeEntity(req, entityId);
    const kind = String(req.body?.kind || 'other');
    if (!AT.KINDS[kind]) throw U.httpError(400, `File kind must be one of: ${Object.keys(AT.KINDS).join(', ')}`);
    const module = req.body?.module ? String(req.body.module) : null;
    if (module && !ATTACH[module]) throw U.httpError(400, 'Unknown record type');
    const prepared = await DOC.prepare(sp, req.file, { maxMb: Math.min(MAX_MB(), settings.max_upload_mb || 25) });
    const out = await tx(async t => {
      const { org, files } = await load(t, req, ['org', 'files']);
      if (!org.entities.some(e => e.id === entityId)) throw U.httpError(400, 'Choose the company');
      let rec = null, holder = null;
      if (module) {
        const a = ATTACH[module];
        holder = (await load(t, req, [a.doc]))[a.doc];
        rec = a.find(holder, String(req.body.record_id || ''));
        if (!rec || rec.entity_id !== entityId) throw U.httpError(404, 'Record not found for this company');
        const why = a.locked(rec);
        if (why) throw U.httpError(400, why);
      }
      const f = AT.add(files, { prepared, entity_id: entityId, kind, actor, sample: sp === 'demo', link: module ? { module, id: rec.id } : null });
      if (rec) { const arr = ATTACH[module].list(rec); if (!arr.includes(f.id)) arr.push(f.id); if (module === 'recon') rec.rev += 1; save(t, req, ATTACH[module].doc, holder); }
      save(t, req, 'files', files);
      await audit(t, req, { action: 'evidence_file_added', object_type: module || 'file', object_id: rec?.id || f.id, entity_id: entityId, summary: `${AT.KINDS[kind]} "${prepared.original_name}" (sha256 ${prepared.sha.slice(0, 12)}…, scan ${prepared.scan.status})${f.reused ? ' — same content already stored, reused' : ''}` });
      return f;
    });
    res.json({ file: AT.summary(out), reused: !!out.reused });
  }));

  router.get('/files', gate(), wrap(async (req, res) => {
    const { files } = await load(store, req, ['files']);
    const ids = list(req.query.ids);
    const out = files.files.filter(f => AC.canSeeEntity(req.c2.actor, f.entity_id) && (!ids.length || ids.includes(f.id)) && (!req.query.entity_id || f.entity_id === req.query.entity_id))
      .map(f => ({ ...AT.summary(f), entity_id: f.entity_id, links: f.links, uploaded_by: f.uploaded_by, at: f.at }));
    res.json({ files: out.slice(0, 3000) });
  }));

  router.post('/files/:id/link-url', gate(), wrap(async (req, res) => {
    const { files } = await load(store, req, ['files']);
    const f = files.files.find(x => x.id === req.params.id);
    if (!f || !AC.canSeeEntity(req.c2.actor, f.entity_id)) throw U.httpError(404, 'File not found');
    const ttl = Math.min(600, Math.max(30, Number(req.c2.settings.link_ttl_seconds) || 120));
    const token = DOC.signLink({ space: req.c2.sp, doc_id: `F:${f.id}`, v: 0, user_id: req.c2.actor.user_id }, ttl * 1000);
    await tx(t => audit(t, req, { action: 'evidence_link_issued', object_type: 'file', object_id: f.id, entity_id: f.entity_id, summary: `Download link (valid ${ttl} s)` }));
    res.json({ url: `/api/compliance2/dl/${token}`, expires_in: ttl });
  }));

  // ── Payment register (V7) ───────────────────────────────────────────────────
  router.get('/payments', gate(), wrap(async (req, res) => {
    const { payments } = await load(store, req, ['payments']);
    const ill = illustrativeOf(req);
    res.json({ payments: payments.payments.filter(p => !!p.illustrative === ill && AC.canSeeEntity(req.c2.actor, p.entity_id)), illustrative: ill });
  }));
  router.post('/payments', gate(['prepare', 'file']), wrap(async (req, res) => {
    writer(req);
    seeEntity(req, String(req.body?.entity_id || ''));
    const out = await tx(async t => {
      const { org, payments, files } = await load(t, req, ['org', 'payments', 'files']);
      const p = P.add(payments, req.body || {}, { org, actor: req.c2.actor, illustrative: false });
      if (Array.isArray(req.body?.evidence) && req.body.evidence.length) { p.evidence = AT.linkAll(files, req.body.evidence, p.entity_id, { module: 'payment', id: p.id }); save(t, req, 'files', files); }
      save(t, req, 'payments', payments);
      await audit(t, req, { action: 'payment_recorded', object_type: 'payment', object_id: p.id, entity_id: p.entity_id, after: p, summary: `${p.section} ${p.liability_month}: ${p.reference} principal ${p.principal}, interest ${p.interest}, fee ${p.fee} (paid ${p.paid_date})` });
      return p;
    });
    res.json({ payment: out });
  }));
  router.post('/payments/:id/reverse', gate(['file', 'approve']), wrap(async (req, res) => {
    writer(req);
    const out = await tx(async t => {
      const { payments } = await load(t, req, ['payments']);
      const p0 = payments.payments.find(x => x.id === req.params.id);
      if (!p0) throw U.httpError(404, 'Payment not found');
      seeEntity(req, p0.entity_id);
      const r = P.reverse(payments, req.params.id, req.body?.reason, req.c2.actor);
      save(t, req, 'payments', payments);
      await audit(t, req, { action: 'payment_reversed', object_type: 'payment', object_id: p0.id, entity_id: p0.entity_id, reason: req.body?.reason, summary: `Reversal ${r.reversal.id} recorded (original kept)` });
      return r;
    });
    res.json(out);
  }));

  // ── TDS Section-wise (V3) ───────────────────────────────────────────────────
  const tdsView = async req => {
    const { tds, recon, org } = await load(store, req, ['tds', 'recon', 'org']);
    const ill = illustrativeOf(req);
    const vis = visible(req);
    const own = { ...tds, challans: tds.challans.filter(c => !!c.illustrative === ill), allocations: tds.allocations.filter(a => tds.challans.some(c => c.id === a.challan_id && !!c.illustrative === ill)) };
    const { all } = await derivedTasks(req, { fys: [] });
    const liabilities = recon.records.filter(r => r.type === 'TDS' && !!r.illustrative === ill);
    const f = { entity_ids: list(req.query.entity_ids), registration_ids: list(req.query.registration_ids), months: list(req.query.months), payment_months: list(req.query.payment_months), section: req.query.section || '' };
    const rows = TDS.monthlyRows(own, { liabilities, tasks: all, visible: vis, filter: f });
    return {
      illustrative: ill, sections: tds.sections,
      challans: own.challans.filter(c => vis(c.entity_id)).map(c => ({ ...c, balance: TDS.balance(own, c) })), allocations: own.allocations.filter(a => vis(a.entity_id)),
      queue: TDS.queue(own, vis).map(q => ({ challan_id: q.challan.id, entity_id: q.challan.entity_id, tan: q.challan.tan, paid_date: q.challan.paid_date, total: q.challan.total, reasons: q.reasons, principal_unallocated: q.principal_unallocated })),
      rows, pivot: TDS.pivot(rows), tans: org.registrations.filter(r => r.type === 'TAN' && vis(r.entity_id)).map(r => ({ id: r.id, entity_id: r.entity_id, number: r.number })),
    };
  };
  router.get('/tds', gate(), wrap(async (req, res) => res.json(await tdsView(req))));

  router.post('/tds/sections', gate('rules'), wrap(async (req, res) => {
    writer(req);
    const s = await tx(async t => { const { tds } = await load(t, req, ['tds']); const x = TDS.addSection(tds, req.body || {}, req.c2.actor); save(t, req, 'tds', tds); await audit(t, req, { action: 'tds_section_added', object_type: 'tds_section', object_id: x.id, after: x, summary: `${TDS.ACTS[x.act]} ${x.code} (${x.nature}) — requires verification` }); return x; });
    res.json({ section: s });
  }));
  router.post('/tds/sections/:id/verify', gate(['rules', 'approve']), wrap(async (req, res) => {
    writer(req);
    const s = await tx(async t => { const { tds } = await load(t, req, ['tds']); const x = TDS.verifySection(tds, req.params.id, req.body || {}, req.c2.actor); save(t, req, 'tds', tds); await audit(t, req, { action: 'tds_section_verified', object_type: 'tds_section', object_id: x.id, summary: `${x.code} verified against: ${x.source}` }); return x; });
    res.json({ section: s });
  }));
  router.post('/tds/challans', gate(['prepare', 'file']), wrap(async (req, res) => {
    writer(req);
    seeEntity(req, String(req.body?.entity_id || ''));
    const c = await tx(async t => {
      const { org, tds, files } = await load(t, req, ['org', 'tds', 'files']);
      const x = TDS.addChallan(tds, req.body || {}, { org, actor: req.c2.actor });
      if (Array.isArray(req.body?.evidence) && req.body.evidence.length) { x.evidence = AT.linkAll(files, req.body.evidence, x.entity_id, { module: 'tds_challan', id: x.id }); save(t, req, 'files', files); }
      save(t, req, 'tds', tds);
      await audit(t, req, { action: 'tds_challan_recorded', object_type: 'tds_challan', object_id: x.id, entity_id: x.entity_id, after: x, summary: `TAN ${x.tan} ${x.itns} BSR ${x.bsr_code} serial ${x.challan_serial} ${x.paid_date}: total ${x.total} (tax ${x.components.tax})` });
      return x;
    });
    res.json({ challan: c });
  }));
  const challanOp = (path, right, fn, action) => router.post(path, gate(right), wrap(async (req, res) => {
    writer(req);
    const out = await tx(async t => {
      const { tds } = await load(t, req, ['tds']);
      const c0 = tds.challans.find(x => x.id === req.params.id);
      if (!c0) throw U.httpError(404, 'Challan not found');
      seeEntity(req, c0.entity_id);
      const before = U.clone(c0);
      const x = fn(tds, req);
      save(t, req, 'tds', tds);
      await audit(t, req, { action: typeof action === 'function' ? action(req) : action, object_type: 'tds_challan', object_id: c0.id, entity_id: c0.entity_id, before, after: c0, reason: req.body?.note || req.body?.reason || '', summary: `${c0.tan} ${c0.paid_date} serial ${c0.challan_serial}` });
      return x;
    });
    res.json({ result: out });
  }));
  challanOp('/tds/challans/:id/reverse', ['file', 'approve'], (d, req) => TDS.reverseChallan(d, req.params.id, req.body?.reason, req.c2.actor), 'tds_challan_reversed');
  router.post('/tds/challans/:id/review', gate(), wrap(async (req, res, next) => {
    const a = String(req.body?.action || '');
    const need = a === 'submit' ? ['prepare', 'file'] : ['review', 'approve'];
    if (!need.some(r => req.c2.actor.rights[r])) throw U.httpError(403, a === 'submit' ? 'Submitting needs the prepare or file right' : 'Reviewing needs the review or approve right');
    next();
  }));
  challanOp('/tds/challans/:id/review', [], (d, req) => TDS.review(d, req.params.id, String(req.body?.action || ''), req.body?.note, req.c2.actor), req => `tds_challan_review_${req.body?.action}`);

  const allocOp = editing => wrap(async (req, res) => {
    writer(req);
    const out = await tx(async t => {
      const { tds, files } = await load(t, req, ['tds', 'files']);
      const ch = tds.challans.find(x => x.id === (editing ? tds.allocations.find(a => a.id === req.params.id)?.challan_id : req.body?.challan_id));
      if (!ch) throw U.httpError(404, 'Challan not found');
      seeEntity(req, ch.entity_id);
      const before = editing ? U.clone(tds.allocations.find(a => a.id === req.params.id)) : null;
      const a = TDS.allocate(tds, { ...(req.body || {}), challan_id: ch.id }, { actor: req.c2.actor, editId: editing ? req.params.id : null });
      for (const id of a.evidence) { const f = files.files.find(x => x.id === id); if (f) AT.addLink(f, { module: 'tds_allocation', id: a.id }); }
      save(t, req, 'tds', tds); save(t, req, 'files', files);
      await audit(t, req, { action: editing ? 'tds_allocation_edited' : 'tds_allocation_added', object_type: 'tds_allocation', object_id: a.id, entity_id: a.entity_id, before, after: a,
        summary: `${a.act === '2025' ? '2025 Act' : '1961 Act'} ${a.section_code} ${a.liability_month}: principal ${a.principal} on challan ${ch.challan_serial} (${a.mapping === 'verified' ? 'verified mapping' : 'mapping requires verification'})` });
      return a;
    });
    res.json({ allocation: out });
  });
  router.post('/tds/allocations', gate(['prepare', 'file']), allocOp(false));
  router.put('/tds/allocations/:id', gate(['prepare', 'file']), allocOp(true));
  router.post('/tds/allocations/:id/reverse', gate(['prepare', 'file', 'approve']), wrap(async (req, res) => {
    writer(req);
    const out = await tx(async t => {
      const { tds } = await load(t, req, ['tds']);
      const a0 = tds.allocations.find(x => x.id === req.params.id);
      if (!a0) throw U.httpError(404, 'Allocation not found');
      seeEntity(req, a0.entity_id);
      const a = TDS.reverseAllocation(tds, req.params.id, req.body?.reason, req.c2.actor);
      save(t, req, 'tds', tds);
      await audit(t, req, { action: 'tds_allocation_reversed', object_type: 'tds_allocation', object_id: a.id, entity_id: a.entity_id, reason: req.body?.reason, summary: `${a.section_code} ${a.liability_month} ${a.principal} reversed (kept in history)` });
      return a;
    });
    res.json({ allocation: out });
  }));

  // ── Reconciliation inputs (V8) ──────────────────────────────────────────────
  router.get('/recon', gate(), wrap(async (req, res) => {
    const { recon, tds } = await load(store, req, ['recon', 'tds']);
    const ill = illustrativeOf(req);
    const types = list(req.query.types);
    const recs = recon.records.filter(r => !!r.illustrative === ill && AC.canSeeEntity(req.c2.actor, r.entity_id) && (!types.length || types.includes(r.type)))
      .map(r => ({ ...r, missing: R.missing(r), calc: R.calc(r, { tdsDoc: tds }) }));
    res.json({ records: recs, illustrative: ill });
  }));
  router.get('/recon/:id', gate(), wrap(async (req, res) => {
    const { recon, tds, files } = await load(store, req, ['recon', 'tds', 'files']);
    const r = recon.records.find(x => x.id === req.params.id);
    if (!r || !AC.canSeeEntity(req.c2.actor, r.entity_id)) throw U.httpError(404, 'Record not found');
    res.json({ record: { ...r, missing: R.missing(r), calc: R.calc(r, { tdsDoc: tds }), files: r.evidence.map(id => AT.summary(files.files.find(f => f.id === id))).filter(Boolean) } });
  }));
  const reconSave = editing => wrap(async (req, res) => {
    writer(req);
    seeEntity(req, String(req.body?.entity_id || ''));
    const out = await tx(async t => {
      const { org, recon, tds } = await load(t, req, ['org', 'recon', 'tds']);
      const before = editing ? U.clone(recon.records.find(x => x.id === req.params.id)) : null;
      if (editing && before) seeEntity(req, before.entity_id);
      if (editing && before?.illustrative) throw U.httpError(400, 'Illustrative records are not edited — add your own record (it is kept in the recorded dataset)');
      const r = R.save(recon, req.body || {}, { org, actor: req.c2.actor, id: editing ? req.params.id : null, rev: req.body?.rev, illustrative: false });
      save(t, req, 'recon', recon);
      await audit(t, req, { action: editing ? 'recon_edited' : 'recon_created', object_type: 'recon', object_id: r.id, entity_id: r.entity_id, before, after: r, summary: `${R.TYPES[r.type]} ${r.registration_number} ${r.month} (draft, version ${r.version})` });
      return { ...r, missing: R.missing(r), calc: R.calc(r, { tdsDoc: tds }) };
    });
    res.json({ record: out });
  });
  router.post('/recon', gate('prepare'), reconSave(false));
  router.put('/recon/:id', gate('prepare'), reconSave(true));
  router.post('/recon/:id/:action(submit|review|return)', gate(), wrap(async (req, res) => {
    writer(req);
    const a = req.params.action;
    const need = a === 'submit' ? ['prepare'] : ['review', 'approve'];
    if (!need.some(x => req.c2.actor.rights[x])) throw U.httpError(403, a === 'submit' ? 'Submitting needs the prepare right' : 'Reviewing needs the review right');
    const out = await tx(async t => {
      const { org, recon, tds } = await load(t, req, ['org', 'recon', 'tds']);
      const r0 = recon.records.find(x => x.id === req.params.id);
      if (!r0) throw U.httpError(404, 'Record not found');
      seeEntity(req, r0.entity_id);
      const r = R.transition(recon, req.params.id, a, { org, actor: req.c2.actor, note: req.body?.note, rev: req.body?.rev });
      save(t, req, 'recon', recon);
      await audit(t, req, { action: `recon_${a}`, object_type: 'recon', object_id: r.id, entity_id: r.entity_id, reason: req.body?.note || '', summary: `${R.TYPES[r.type]} ${r.registration_number} ${r.month} → ${R.STATUSES[r.status]}` });
      return { ...r, missing: R.missing(r), calc: R.calc(r, { tdsDoc: tds }) };
    });
    res.json({ record: out });
  }));
  router.get('/recon-template/:type.csv', gate(), wrap(async (req, res) => {
    const rows = R.templateRows(req.params.type);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Compliance_${req.params.type}_reconciliation_template.csv"`);
    res.end(`﻿${rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n')}`);
  }));
  router.post('/recon-import/:type', gate('prepare'), upload.single('file'), wrap(async (req, res) => {
    if (!req.file?.buffer?.length) throw U.httpError(400, 'Choose the completed template CSV');
    if (req.file.buffer.length > 2 * 1024 * 1024) throw U.httpError(413, 'The CSV must be at most 2 MB');
    res.json({ rows: R.importGrid(req.params.type, req.file.buffer.toString('utf8')) });
  }));

  // ── Payroll imports (V10) ───────────────────────────────────────────────────
  const readStored = async (req, fileId, entityId) => {
    const { files } = await load(store, req, ['files']);
    const f = files.files.find(x => x.id === fileId);
    if (!f || f.entity_id !== entityId) throw U.httpError(400, 'Source file not found for this company — upload it again');
    const buf = await BL.read(req.c2.sp, f.sha256);
    if (!buf) throw U.httpError(404, 'The stored source file is missing');
    return { f, buf };
  };
  router.post('/imports/parse', gate('prepare'), upload.single('file'), wrap(async (req, res) => {
    writer(req);
    const { sp, actor, settings } = req.c2;
    const entityId = String(req.body?.entity_id || '');
    seeEntity(req, entityId);
    const side = req.body?.side === 'returns' ? 'returns' : 'payroll';
    const fund = String(req.body?.fund || 'PF');
    const prepared = await DOC.prepare(sp, req.file, { maxMb: Math.min(MAX_MB(), settings.max_upload_mb || 25) });
    const isText = prepared.type === 'txt';
    if (side === 'returns' && isText && fund !== 'PF') throw U.httpError(400, 'A native ECR text file is PF only; use XLSX / CSV for the ESIC member list');
    if (!['xlsx', 'xls', 'csv', 'txt'].includes(prepared.type)) throw U.httpError(415, 'Upload the salary / member file as XLSX, XLS or CSV (or the ECR as TXT). PDF / image challans are evidence only — attach them as proof.');
    const buf = await BL.read(sp, prepared.sha);
    let parsed;
    if (isText) {
      if (side !== 'returns') throw U.httpError(400, 'The salary file must be XLSX / XLS / CSV');
      parsed = { format: 'ecr_txt', rows: MI.parseEcr(buf.toString('utf8')) };
    } else parsed = { format: 'mapped', sheets: MI.preview(MI.readSheets(buf, prepared.type)) };
    const f = await tx(async t => {
      const { files, org } = await load(t, req, ['files', 'org']);
      if (!org.entities.some(e => e.id === entityId)) throw U.httpError(400, 'Choose the company');
      const x = AT.add(files, { prepared, entity_id: entityId, kind: side === 'payroll' ? 'payroll_source' : fund === 'PF' ? 'ecr_source' : 'esic_source', actor, sample: sp === 'demo' });
      save(t, req, 'files', files);
      await audit(t, req, { action: 'import_source_uploaded', object_type: 'file', object_id: x.id, entity_id: entityId, summary: `${side === 'payroll' ? 'Salary' : fund === 'PF' ? 'ECR' : 'ESIC member'} file "${prepared.original_name}" (sha256 ${prepared.sha.slice(0, 12)}…)` });
      return x;
    });
    res.json({ file: AT.summary(f), ...parsed });
  }));
  router.post('/imports/map', gate('prepare'), wrap(async (req, res) => {
    const entityId = String(req.body?.entity_id || '');
    seeEntity(req, entityId);
    const { f, buf } = await readStored(req, String(req.body?.file_id || ''), entityId);
    const out = MI.applyMapping(MI.readSheets(buf, f.type), req.body || {});
    res.json({ ...out, rows: out.rows.slice(0, 500), row_count: out.rows.length });
  }));
  const sideRows = async (req, entityId, spec, isReturn, fund) => {
    const { f, buf } = await readStored(req, String(spec?.file_id || ''), entityId);
    if (isReturn && f.type === 'txt') { if (fund !== 'PF') throw U.httpError(400, 'ECR text is PF only'); return { file_id: f.id, name: f.original_name, sha256: f.sha256, format: 'ecr_txt', rows: MI.parseEcr(buf.toString('utf8')) }; }
    const m = MI.applyMapping(MI.readSheets(buf, f.type), spec || {});
    return { file_id: f.id, name: f.original_name, sha256: f.sha256, format: 'mapped', sheet: m.sheet, header_row: m.header_row, mapping: m.mapping, headers: m.headers, rows: m.rows };
  };
  router.post('/imports/batches', gate('prepare'), wrap(async (req, res) => {
    writer(req);
    const b = req.body || {};
    const entityId = String(b.entity_id || '');
    seeEntity(req, entityId);
    const payroll = await sideRows(req, entityId, b.payroll, false, b.fund);         // rows always re-read from the stored files (lineage)
    const returns = await sideRows(req, entityId, b.returns, true, b.fund);
    const out = await tx(async t => {
      const { org, imports, files } = await load(t, req, ['org', 'imports', 'files']);
      const x = MI.create(imports, { ...b, payroll, returns, proof: [] }, { org, actor: req.c2.actor });
      if (Array.isArray(b.proof) && b.proof.length) x.proof = AT.linkAll(files, b.proof, entityId, { module: 'import_batch', id: x.id });
      for (const id of [payroll.file_id, returns.file_id]) { const fl = files.files.find(y => y.id === id); if (fl) AT.addLink(fl, { module: 'import_batch', id: x.id }); }
      save(t, req, 'imports', imports); save(t, req, 'files', files);
      const s = MI.summary(x);
      await audit(t, req, { action: 'import_batch_created', object_type: 'import_batch', object_id: x.id, entity_id: entityId, summary: `${x.fund} ${x.month} (${x.kind}): payroll ${s.members.payroll} rows, return ${s.members.returns} rows, ${s.exceptions} exception(s)` });
      return x;
    });
    res.json({ batch: { ...out, summary: MI.summary(out) } });
  }));
  router.get('/imports/batches', gate(), wrap(async (req, res) => {
    const { imports } = await load(store, req, ['imports']);
    const ill = illustrativeOf(req);
    res.json({ batches: imports.batches.filter(b => !!b.illustrative === ill && AC.canSeeEntity(req.c2.actor, b.entity_id)).map(b => ({ ...b, payroll: { ...b.payroll, rows: undefined, row_count: b.payroll.rows.length }, returns: { ...b.returns, rows: undefined, row_count: b.returns.rows.length }, summary: MI.summary(b) })) });
  }));
  router.post('/imports/batches/:id/to-recon', gate('prepare'), wrap(async (req, res) => {
    writer(req);
    const out = await tx(async t => {
      const { org, imports, recon } = await load(t, req, ['org', 'imports', 'recon']);
      const b = imports.batches.find(x => x.id === req.params.id);
      if (!b || b.status === 'withdrawn') throw U.httpError(404, 'Batch not found');
      seeEntity(req, b.entity_id);
      const rows = MI.toReconRows(b);
      const existing = recon.records.find(r => r.type === b.fund && r.entity_id === b.entity_id && r.registration_id === b.registration_id && r.month === b.month && !!r.illustrative === !!b.illustrative);
      const input = { type: b.fund, entity_id: b.entity_id, registration_id: b.registration_id, month: b.month, rows, values: { ...(existing?.values || {}), payrollRef: b.payroll.name, reference: existing?.values?.reference || '' },
        notes: `Imported batch ${b.id} (${b.kind}). Return inclusion is not proof of payment.${existing?.notes ? `\n${existing.notes}` : ''}` };
      const r = R.save(recon, input, { org, actor: req.c2.actor, id: existing?.id, illustrative: !!b.illustrative });
      for (const id of [b.payroll.file_id, b.returns.file_id, ...b.proof]) if (id && !r.evidence.includes(id)) r.evidence.push(id);
      b.recon_id = r.id;
      b.history.push({ at: U.nowIso(), by: req.c2.actor.name, action: 'sent to reconciliation', recon_id: r.id });
      save(t, req, 'imports', imports); save(t, req, 'recon', recon);
      await audit(t, req, { action: 'import_sent_to_recon', object_type: 'import_batch', object_id: b.id, entity_id: b.entity_id, summary: `${rows.length} employee rows → ${R.TYPES[b.fund]} ${b.month} (${r.id}, draft)` });
      return r;
    });
    res.json({ record: out });
  }));
  router.post('/imports/batches/:id/withdraw', gate('prepare'), wrap(async (req, res) => {
    writer(req);
    await tx(async t => {
      const { imports } = await load(t, req, ['imports']);
      const b = imports.batches.find(x => x.id === req.params.id);
      if (!b) throw U.httpError(404, 'Batch not found');
      seeEntity(req, b.entity_id);
      if (String(req.body?.reason || '').trim().length < 5) throw U.httpError(400, 'A reason is required');
      b.status = 'withdrawn';
      b.history.push({ at: U.nowIso(), by: req.c2.actor.name, action: 'withdrawn', note: req.body.reason });
      save(t, req, 'imports', imports);
      await audit(t, req, { action: 'import_batch_withdrawn', object_type: 'import_batch', object_id: b.id, entity_id: b.entity_id, reason: req.body.reason, summary: `${b.fund} ${b.month} batch withdrawn (source files kept)` });
    });
    res.json({ ok: true });
  }));

  // ── Tax audit (V10) ─────────────────────────────────────────────────────────
  router.get('/taxaudit', gate(), wrap(async (req, res) => {
    const { taxaudit, meta } = await load(store, req, ['taxaudit', 'meta']);
    const prevStart = U.fyStartYear(U.fyOf(S.todayFor(req.c2.sp, meta))) - 1;          // default: the year whose audit is being prepared
    const fy = U.validFy(req.query.fy) ? req.query.fy : `${prevStart}-${String((prevStart + 1) % 100).padStart(2, '0')}`;
    const asOf = U.isDate(req.query.as_of) ? req.query.as_of : S.todayFor(req.c2.sp, meta);
    const vis = visible(req);
    const ent = list(req.query.entity_ids), regs = list(req.query.registration_ids);
    res.json({
      fy, as_of: asOf, schedules: TA.schedules(taxaudit, { fy, entityIds: ent, registrationIds: regs, asOf, visible: vis }),
      lots: taxaudit.lots.filter(l => vis(l.entity_id) && (!ent.length || ent.includes(l.entity_id))).map(l => ({ ...l, allocated: TA.allocatedTo(taxaudit, l.id) })),
      payments: TA.allocationView(taxaudit, { entityIds: ent, visible: vis }), settings: Object.values(taxaudit.settings).filter(s => vis(s.entity_id)),
    });
  }));
  const taOp = (method, path, right, fn, action) => router[method](path, gate(right), wrap(async (req, res) => {
    writer(req);
    const out = await tx(async t => {
      const { org, taxaudit, files } = await load(t, req, ['org', 'taxaudit', 'files']);
      const x = fn({ taxaudit, org, files, req });
      seeEntity(req, x.entity_id);
      save(t, req, 'taxaudit', taxaudit); save(t, req, 'files', files);
      await audit(t, req, { action, object_type: 'taxaudit', object_id: x.id || `${x.entity_id}|${x.fy}`, entity_id: x.entity_id, after: x, reason: req.body?.reason || '', summary: `${action.replace(/_/g, ' ')}${x.kind ? `: ${x.kind} ${x.month}` : x.reference ? `: ${x.reference}` : ''}` });
      return x;
    });
    res.json({ result: out });
  }));
  taOp('post', '/taxaudit/lots', 'prepare', ({ taxaudit, org, req }) => { seeEntity(req, String(req.body?.entity_id || '')); return TA.saveLot(taxaudit, req.body || {}, { org, actor: req.c2.actor }); }, 'taxaudit_lot_created');
  taOp('put', '/taxaudit/lots/:id', 'prepare', ({ taxaudit, org, req }) => { const l = taxaudit.lots.find(x => x.id === req.params.id); if (l) seeEntity(req, l.entity_id); return TA.saveLot(taxaudit, req.body || {}, { org, actor: req.c2.actor, id: req.params.id }); }, 'taxaudit_lot_edited');
  taOp('post', '/taxaudit/lots/:id/approve', ['review', 'approve'], ({ taxaudit, req }) => TA.approveLot(taxaudit, req.params.id, req.c2.actor), 'taxaudit_classification_approved');
  const linkProof = (files, p, req) => { if (Array.isArray(req.body?.proof)) p.proof = AT.linkAll(files, req.body.proof, p.entity_id, { module: 'taxaudit_payment', id: p.id }); };
  taOp('post', '/taxaudit/payments', ['prepare', 'file'], ({ taxaudit, org, files, req }) => { seeEntity(req, String(req.body?.entity_id || '')); const p = TA.savePayment(taxaudit, { ...(req.body || {}), proof: [] }, { org, actor: req.c2.actor }); linkProof(files, p, req); return p; }, 'taxaudit_payment_recorded');
  taOp('put', '/taxaudit/payments/:id', ['prepare', 'file'], ({ taxaudit, org, files, req }) => { const p0 = taxaudit.payments.find(x => x.id === req.params.id); if (p0) seeEntity(req, p0.entity_id); const p = TA.savePayment(taxaudit, { ...(req.body || {}), proof: p0?.proof }, { org, actor: req.c2.actor, id: req.params.id }); linkProof(files, p, req); return p; }, 'taxaudit_payment_edited');
  taOp('post', '/taxaudit/payments/:id/verify', ['review', 'verify', 'approve'], ({ taxaudit, req }) => TA.verifyPayment(taxaudit, req.params.id, req.body?.verified !== false, req.c2.actor), 'taxaudit_payment_verification');
  taOp('post', '/taxaudit/payments/:id/reverse', ['file', 'approve'], ({ taxaudit, req }) => TA.reversePayment(taxaudit, req.params.id, req.body?.reason, req.c2.actor), 'taxaudit_payment_reversed');
  taOp('put', '/taxaudit/settings', ['prepare', 'review', 'approve'], ({ taxaudit, req }) => { seeEntity(req, String(req.body?.entity_id || '')); return TA.saveSettings(taxaudit, req.body || {}, req.c2.actor); }, 'taxaudit_cutoff_saved');

  // ── Compliance Updates (V2) ─────────────────────────────────────────────────
  router.get('/updates', gate(), wrap(async (req, res) => {
    const { updates } = await load(store, req, ['updates']);
    const items = UP.list(updates, { userId: req.c2.actor.user_id || req.c2.actor.id, filter: req.query, canSeeEntity: visible(req) });
    const all = UP.list(updates, { userId: req.c2.actor.user_id || req.c2.actor.id, filter: {}, canSeeEntity: visible(req) });
    res.json({
      updates: items, sources: UP.sourceStatus(updates), runs: updates.runs.slice(-10).reverse(), settings: updates.settings, live_feed: req.c2.sp === 'live' && !!updates.settings.enabled && !isVercel,
      counts: { total: all.length, unread: all.filter(u => !u.read).length, saved: all.filter(u => u.saved).length, queue: all.filter(u => ['candidate', 'in_review'].includes(u.status)).length, open_actions: updates.actions.filter(a => a.status === 'open').length },
      curated_only: req.c2.sp === 'demo',
    });
  }));
  const upOp = (path, right, fn, action, { method = 'post', perUser = false } = {}) => router[method](path, gate(right), wrap(async (req, res) => {
    if (!perUser) writer(req);
    const out = await tx(async t => {
      const { updates, org } = await load(t, req, ['updates', 'org']);
      const x = await fn({ updates, org, req, t });
      save(t, req, 'updates', updates);
      if (action) await audit(t, req, { action: typeof action === 'function' ? action(req) : action, object_type: 'update', object_id: x?.id || req.params.id || 'updates', reason: req.body?.note || '', summary: x?.title ? `${x.title}` : String(action) });
      return x;
    });
    res.json({ result: out });
  }));
  upOp('/updates/settings', 'admin', ({ updates, req }) => {
    const b = req.body || {};
    if (b.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time))) throw U.httpError(400, 'Time must be HH:MM (Indian time)');
    if (b.enabled && req.c2.sp === 'demo') throw U.httpError(400, 'The demo shows curated reference entries only — the monitor runs in the live space');
    if (b.extra_domains !== undefined) {
      const d = (Array.isArray(b.extra_domains) ? b.extra_domains : String(b.extra_domains).split(',')).map(x => String(x).trim().toLowerCase()).filter(Boolean);
      if (d.some(x => !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(gov\.in|nic\.in|org\.in)$/.test(x))) throw U.httpError(400, 'Extra domains must be official .gov.in / .nic.in / .org.in domains');
      updates.settings.extra_domains = U.uniq(d);
    }
    if (b.enabled !== undefined) updates.settings.enabled = !!b.enabled;
    if (b.time !== undefined) updates.settings.time = b.time;
    return { id: 'settings', title: `Monitor ${updates.settings.enabled ? 'on' : 'off'} at ${updates.settings.time} IST` };
  }, 'update_monitor_settings', { method: 'put' });
  upOp('/updates/sources', 'admin', ({ updates, req }) => {
    const b = req.body || {};
    const url = UP.officialUrl(b.url, updates.settings.extra_domains);
    if (!url) throw U.httpError(400, 'The source must be an https link on an official domain');
    if (!UP.TOPICS.includes(b.topic)) throw U.httpError(400, 'Choose the topic');
    const s = { id: U.uid('SRC-'), name: UP.plain(b.name, 120) || url, authority: UP.plain(b.authority, 120) || '—', topic: b.topic, url, kind: 'page', enabled: true, state: null, last_success: null, last_failure: null, last_error: null, failures: 0, next_retry: null, seen: [], baseline_at: null, created_at: U.nowIso() };
    updates.sources.push(s);
    return { id: s.id, title: `Source added: ${s.name}` };
  }, 'update_source_added');
  upOp('/updates/sources/:id', 'admin', ({ updates, req }) => {
    const s = updates.sources.find(x => x.id === req.params.id);
    if (!s) throw U.httpError(404, 'Source not found');
    if (req.body?.enabled !== undefined) s.enabled = !!req.body.enabled;
    if (req.body?.url !== undefined) { const url = UP.officialUrl(req.body.url, updates.settings.extra_domains); if (!url) throw U.httpError(400, 'The source must be an https link on an official domain'); if (url !== s.url) Object.assign(s, { url, seen: [], baseline_at: null }); }
    return { id: s.id, title: `Source ${s.name}: ${s.enabled ? 'enabled' : 'disabled'}` };
  }, 'update_source_changed', { method: 'put' });
  upOp('/updates', 'rules', ({ updates, org, req }) => UP.add(updates, req.body || {}, { org, actor: req.c2.actor }), 'update_recorded');
  upOp('/updates/:id', 'rules', ({ updates, org, req }) => UP.edit(updates, req.params.id, req.body || {}, { org, actor: req.c2.actor }), 'update_corrected', { method: 'put' });
  upOp('/updates/:id/decide', ['approve', 'rules'], ({ updates, req }) => UP.decide(updates, req.params.id, String(req.body?.action || ''), { actor: req.c2.actor, note: req.body?.note, supersededBy: req.body?.superseded_by }), req => `update_${req.body?.action}`);
  upOp('/updates/:id/note', [], ({ updates, req }) => UP.addNote(updates, req.params.id, req.body?.text, req.c2.actor), 'update_note');
  upOp('/updates/:id/mark', [], ({ updates, req }) => UP.mark(updates, req.c2.actor.user_id || req.c2.actor.id, req.params.id, req.body?.what, req.body?.on !== false), null, { perUser: true });
  upOp('/updates/actions', ['prepare', 'rules', 'approve'], ({ updates, req }) => UP.addAction(updates, req.body || {}, { actor: req.c2.actor, users: req.c2.users }), 'update_action_added');
  upOp('/updates/actions/:id', [], ({ updates, req }) => UP.setAction(updates, req.params.id, req.body?.status, req.c2.actor), 'update_action_status');
  /** A verified update can start a rule change: it creates a DRAFT rule version (never live) that goes through verify → impact preview → approval */
  upOp('/updates/:id/propose-rule', 'rules', async ({ updates, req, t }) => {
    if (req.c2.actor.entities !== null) throw U.httpError(403, 'Entity-limited users cannot change group rules');
    const u = updates.updates.find(x => x.id === req.params.id);
    if (!u) throw U.httpError(404, 'Update not found');
    if (u.status !== 'verified') throw U.httpError(400, 'Only a verified update can propose a rule change');
    const { rules } = await load(t, req, ['rules']);
    const v = RU.newDraft(rules, String(req.body?.rule_id || ''), { effective_from: req.body?.effective_from || undefined, note: `Proposed from update ${u.id}: ${u.title}` }, req.c2.actor);
    RU.editDraft(rules, String(req.body.rule_id), v.version, { source_url: u.source_url || '', notification_no: u.reference || '', notification_date: u.published || '', retrieved_at: u.retrieved_at?.slice(0, 10) || '' }, req.c2.actor);
    u.rule_links.push({ rule_id: String(req.body.rule_id), version: v.version, at: U.nowIso(), by: req.c2.actor.name });
    u.history.push({ at: U.nowIso(), by: req.c2.actor.name, action: 'rule draft proposed', note: `${req.body.rule_id} v${v.version}` });
    save(t, req, 'rules', rules);
    return { ...u, rule_version: v.version };
  }, 'update_rule_draft_proposed');
  router.post('/updates/run', gate('admin'), wrap(async (req, res) => {
    if (req.c2.sp === 'demo') throw U.httpError(400, 'The demo shows curated reference entries only — the source monitor runs in the live space');
    res.json({ run: await runMonitorNow(req.c2.actor, 'manual') });
  }));

  // ── Reports (V7, V8, V9, V10) ───────────────────────────────────────────────
  const reportFilter = req => ({ fy: U.validFy(req.query.fy) ? req.query.fy : null, basis: req.query.basis === 'liability' ? 'liability' : 'payment', entity_ids: list(req.query.entity_ids), registration_ids: list(req.query.registration_ids),
    section: req.query.section || '', month: /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : '', status: req.query.status || '', illustrative: illustrativeOf(req), metric: req.query.metric, period: req.query.period });
  const paymentRows = async req => { const { payments, tds, org } = await load(store, req, ['payments', 'tds', 'org']); return { rows: REP.dataset({ payments, tds, org, illustrative: illustrativeOf(req) }), org }; };
  router.get('/reports/payments', gate(), wrap(async (req, res) => {
    const f = reportFilter(req);
    const { rows, org } = await paymentRows(req);
    const scoped = REP.filterRows(rows, f, visible(req));
    res.json({ filter: f, ...REP.payments(scoped, f, { entities: org.entities }) });
  }));
  router.get('/reports/trends', gate(), wrap(async (req, res) => {
    const f = reportFilter(req);
    if (!f.fy) throw U.httpError(400, 'Choose the financial year');
    const { meta } = await load(store, req, ['meta']);
    const { rows } = await paymentRows(req);
    res.json({ filter: f, ...REP.trends(rows, f, { today: S.todayFor(req.c2.sp, meta), visible: visible(req) }) });
  }));
  router.get('/reports/tasks', gate(), wrap(async (req, res) => {
    const f = S.parseFilters(req.query);
    const { all, today, dbt } = await derivedTasks(req, f);
    const listed = S.filter(all, f, req.c2.actor);
    const out = REP.tasks(listed, { today, docsByTask: dbt, categories: CAT.CATEGORIES });
    const pick = ids => ids.map(id => listed.find(t => t.id === id)).filter(Boolean).map(slim);
    res.json({ today, ...out, overdue: pick(out.overdue_ids), upcoming: pick(out.upcoming_ids), unscheduled: pick(out.unscheduled_ids), exception_tasks: pick(out.exception_ids) });
  }));
  router.get('/reports/recon/:page', gate(), wrap(async (req, res) => {
    if (!REP.RECON_PAGES[req.params.page]) throw U.httpError(404, 'Unknown report');
    const f = reportFilter(req);
    const { recon, tds } = await load(store, req, ['recon', 'tds']);
    res.json({ filter: f, ...REP.recon(req.params.page, recon.records, f, { tdsDoc: tds, visible: visible(req) }) });
  }));

  // ── Source monitor scheduler (office PC; on Vercel there is no long-running process — said on the screen) ──
  let monitorTimer = null, running = false;
  async function runMonitorNow(actor, trigger) {
    if (running) throw U.httpError(409, 'A check is already running');
    running = true;
    try {
      const doc = await store.read(S.keys('live').updates, S.DEF.updates());
      if (!doc.sources.length) UP.seedSources(doc);
      const work = U.clone(doc);
      const run = await UP.runMonitor(work, { fetcher: h.fetcher || defaultFetch, actor, trigger });
      await store.transaction(async t => {
        const cur = await t.get(S.keys('live').updates, S.DEF.updates());
        // merge: sources state + new candidates + run log (user read/saved state and edits made meanwhile are kept)
        for (const s of work.sources) { const c = cur.sources.find(x => x.id === s.id); if (c) Object.assign(c, { state: s.state, last_success: s.last_success, last_failure: s.last_failure, last_error: s.last_error, failures: s.failures, next_retry: s.next_retry, seen: s.seen, baseline_at: s.baseline_at }); else cur.sources.push(s); }
        for (const u of work.updates) if (!cur.updates.some(x => x.id === u.id || x.content_hash === u.content_hash)) cur.updates.push(u);
        cur.runs.push(run); cur.runs = cur.runs.slice(-60);
        t.set(S.keys('live').updates, cur);
        await require('./lib/audit').append(t, 'live', { actor, action: 'update_monitor_run', object_type: 'updates', object_id: run.id, summary: `Source check (${trigger}): ${run.ok} ok, ${run.failed} failed, ${run.results.reduce((a, r) => a + (r.new || 0), 0)} new candidate(s) for review` });
      });
      return run;
    } finally { running = false; }
  }
  async function defaultFetch(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'DevX-Compliance-Monitor/1.0 (daily check of official notices)', Accept: 'text/html,application/rss+xml,application/xml;q=0.9' } });
      const finalUrl = UP.officialUrl(r.url || url);
      if (!finalUrl) return { ok: false, status: 'redirected off the official domain' };
      const text = (await r.text()).slice(0, 3 * 1024 * 1024);
      return { ok: r.ok, status: r.status, text };
    } finally { clearTimeout(timer); }
  }
  router.startUpdatesTimer = () => {
    if (isVercel || monitorTimer) return;
    monitorTimer = setInterval(() => {
      (async () => {
        const doc = await store.read(S.keys('live').updates, null);
        if (doc && UP.due(doc)) await runMonitorNow({ id: 'scheduler', name: 'Update monitor (09:00 IST job)' }, 'schedule');
      })().catch(e => console.error('[compliance2] update monitor:', e.message));
    }, 5 * 60000);
    if (monitorTimer.unref) monitorTimer.unref();
  };
  router.runMonitorNow = runMonitorNow;
  router.startUpdatesTimer();
}

module.exports = { mount };
