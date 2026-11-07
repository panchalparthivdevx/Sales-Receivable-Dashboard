/**
 * The bill workflow — the same for email and ERP uploads:
 *   ingest → read (extract) → company → vendor → duplicates → category → accounts & GST → branch/TDS
 *   → category fields → issues → status → (draft in Zoho, when allowed) → review tracking.
 *
 * Network work (reading the file, Zoho look-ups) happens outside the store lock; each result is then
 * applied in one short transaction. Choices the team made by hand (source 'manual') are kept on every
 * re-evaluation; suggestions are recomputed. Every step leaves an entry in the bill's audit trail.
 */

'use strict';

const C = require('./config');
const T = require('./text');
const M = require('./match');
const A = require('./accounts');
const D = require('./duplicates');
const V = require('./validate');
const DR = require('./draft');
const EX = require('./extract');

const AUDIT_MAX = 200;
const ACTIVE_ZOHO = new Set(['draft', 'pending_approval']);

function create({ store, zc, lookups, files, extractFn = EX.extract, log = console }) {
  const now = () => new Date().toISOString();
  const audit = (b, by, action, detail) => {
    b.audit = [...(b.audit || []), { at: now(), by: by || 'system', action, detail: String(detail || '').slice(0, 1000) }].slice(-AUDIT_MAX);
  };
  const config = async () => C.merge((await store.snapshot()).doc('bb_config'));

  // ── Queue (one bill at a time: OCR and Claude calls are heavy) ─────────────
  const queue = [];
  const queued = new Set();
  let running = null;
  function enqueue(id) {
    if (!queued.has(id)) { queued.add(id); queue.push(id); }
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }
  async function drain() {
    while (queue.length) {
      const id = queue.shift();
      queued.delete(id);
      try { await processBill(id); } catch (e) { log.error(`[bill-booking] ${id}: ${e.message}`); }
    }
  }
  const idle = () => running || Promise.resolve();

  // ── Ingest ──────────────────────────────────────────────────────────────────
  /**
   * input: { buffer, name, mime, source: 'email'|'erp_upload', source_ref, member_id, company, by }
   * → { id, existed }
   */
  async function ingest(input) {
    const mime = files.mimeOf(input.name, input.mime);
    if (!files.ACCEPTED.has(mime)) throw Object.assign(new Error(`${input.name}: only PDF and image files can be read`), { status: 400 });
    const sha = files.sha256(input.buffer);
    const r = await store.tx(async t => {
      if (input.source === 'email' && input.source_ref?.message_id) {
        const same = t.bills().find(b => b.source_ref?.message_id === input.source_ref.message_id && b.file?.sha256 === sha);
        if (same) return { id: same.id, existed: true };
      }
      const cfg = C.merge(t.doc('bb_config'));
      cfg.seq = (cfg.seq || 0) + 1;
      t.setDoc('bb_config', cfg);
      const at = now();
      const id = `BB-${at.slice(2, 4)}${at.slice(5, 7)}-${String(cfg.seq).padStart(5, '0')}`;
      const fileName = await files.save(id, input.name, input.buffer, mime);
      const b = {
        id, created_at: at, updated_at: at, status: 'received',
        source: input.source, source_ref: { ...(input.source_ref || {}), attachment_name: files.fixName(input.name) },
        member_id: input.member_id || '', company: input.company || '', company_source: input.company ? 'manual' : '',
        file: { name: fileName, size: input.buffer.length, type: mime, sha256: sha },
        fields: {}, lines: [], issues: [], acks: [], cat_fields: {}, audit: [],
      };
      audit(b, input.by, 'received', input.source === 'email'
        ? `Email from ${input.source_ref?.from || '?'} to ${input.source_ref?.mailbox || '?'}: "${input.source_ref?.subject || ''}" — ${b.source_ref.attachment_name}`
        : `ERP upload by ${input.by || '?'}: ${b.source_ref.attachment_name}${input.source_ref?.erp_ref ? ` (ERP ref ${input.source_ref.erp_ref})` : ''}`);
      t.putBill(b);
      return { id, existed: false };
    });
    if (!r.existed) enqueue(r.id);
    return r;
  }

  // ── Read the document ──────────────────────────────────────────────────────
  async function processBill(id, { force = false } = {}) {
    const b0 = await store.bill(id);
    if (!b0 || V.STICKY.has(b0.status)) return;
    if (!b0.extraction || force) {
      const cfg = await config();
      const companies = await runtimeCompanies(cfg);
      const own = new Set(companies.flatMap(M.companyGstins));
      const ownPans = new Set(companies.flatMap(M.companyPans));
      let r, error = null;
      try {
        const buf = await files.read(id, b0.file.name);
        if (!buf) throw new Error('The stored file could not be read');
        r = await extractFn(buf, b0.file.type, {
          companies, ownGstins: own, ownPans, fileName: b0.source_ref?.attachment_name,
          email: b0.source === 'email' ? { from: b0.source_ref.from, subject: b0.source_ref.subject, body: b0.source_ref.body_preview } : null,
        });
      } catch (e) { error = e.message; }
      await store.tx(async t => {
        const b = t.bill(id);
        if (!b) return;
        if (error) {
          b.processing_error = error;
          audit(b, 'system', 'failed', `Reading failed: ${error}`);
        } else {
          delete b.processing_error;
          b.extraction = {
            engine: r.engine, at: now(), text_method: r.text_method, pages: r.pages, confidence: r.confidence,
            notes: r.notes, unreadable: r.unreadable, warnings: r.warnings, usage: r.usage || null,
            text_sample: String(r.text || '').slice(0, 6000),
          };
          b.doc_type = r.doc_type;
          b.fields = { ...r.fields };
          b.field_source = {};
          b.lines = (r.lines.length ? r.lines : (r.fields.sub_total || r.fields.description)
            ? [{ description: r.fields.description, hsn_sac: '', quantity: 1, rate: r.fields.sub_total, amount: r.fields.sub_total, tax_rate: null, tax_amount: r.fields.tax_total }] : [])
            .map((l, i) => ({ id: `l${i + 1}`, ...l, account: null, tax: null }));
          b.company = b.company_source === 'manual' ? b.company : '';
          b.vendor = null; b.category = null; b.cat_fields = {}; b.bill_level = {}; b.duplicate = b.duplicate?.dismissed ? { dismissed: b.duplicate.dismissed } : null;
          b.not_bill = null; delete b.evaluated_at;
          audit(b, 'system', 'extracted', `${r.engine === 'claude' ? 'Read by Claude' : r.text_method === 'ocr' ? 'Read by OCR' : 'Read from the PDF text'}: ${EX.DOC_TYPE_LABEL[r.doc_type.value] || r.doc_type.value}, invoice ${r.fields.invoice_number || '?'} dated ${r.fields.invoice_date || '?'}, total ${r.fields.total ?? '?'}, ${r.lines.length} line(s), confidence ${r.confidence}`);
        }
        b.status = V.status(b);
        b.updated_at = now();
        t.putBill(b);
      });
    }
    try {
      return await evaluate(id);
    } catch (e) {
      // Never leave a bill silently half-done: Failed with the reason (Retry runs the checks again)
      await store.tx(async t => {
        const b = t.bill(id);
        if (!b || V.STICKY.has(b.status)) return;
        b.processing_error = `Checking the bill failed: ${e.message}`;
        audit(b, 'system', 'failed', b.processing_error);
        b.status = V.status(b);
        t.putBill(b);
      });
      throw e;
    }
  }

  async function runtimeCompanies(cfg) {
    const out = [];
    for (const c of cfg.companies) {
      let auto = [];
      try { auto = await lookups.ownGstins(c.org_id); } catch (_) {}
      out.push({ ...c, gstins_auto: auto });
    }
    return out;
  }

  // ── Evaluate (everything after reading) ────────────────────────────────────
  async function evaluate(id, { by = 'system' } = {}) {
    const b0 = await store.bill(id);
    if (!b0 || !b0.extraction || b0.processing_error || V.STICKY.has(b0.status)) return b0;
    const cfg = await config();
    const companies = await runtimeCompanies(cfg);
    const member = cfg.team.find(m => m.id === b0.member_id);

    // Company
    let company = b0.company_source === 'manual' ? { id: b0.company, basis: b0.company_basis, sure: true }
      : M.detectCompany({ fields: b0.fields, text: b0.extraction.text_sample, member, companies });
    const co = cfg.companies.find(c => c.id === company.id);
    const org = co?.org_id;

    // Look-ups (outside the lock)
    const notes = [];
    let vendors = [], hist = { bills: [], rows: [] }, taxes = [], zohoBills = [];
    if (co) {
      try { vendors = M.vendorIndex(await lookups.vendors(co.id)); } catch (e) { notes.push(`Zoho vendors could not be loaded: ${e.message}`); }
      try { zohoBills = await lookups.zohoBills(co.id); } catch (_) {}
    }
    let vendor = b0.vendor?.match === 'manual' ? b0.vendor
      : (co ? M.matchVendor({ fields: b0.fields, fromEmail: b0.source_ref?.from_address || '', vendors }) : null);
    // Quotations, statements … (unless the team said it is a bill) need no account history: saves Zoho calls
    const setAside = b0.not_bill?.manual || (!b0.not_bill?.overridden && V.notBill(b0));
    if (co && vendor?.id && !setAside) {
      const snap = await store.snapshot();
      const ours = new Set(snap.bills.filter(x => x.status === 'draft_created' && x.zoho?.bill_id).map(x => x.zoho.bill_id));
      try {
        hist = await lookups.vendorHistory({ companyId: co.id, org, vendorId: vendor.id, days: cfg.settings.history_days, maxBills: cfg.settings.history_max_bills, excludeBillIds: ours });
      } catch (e) { notes.push(`Earlier Zoho bills could not be read (${e.message}) — accounts need the team or a retry`); }
      try { taxes = await lookups.taxes(org); } catch (e) { notes.push(`Zoho taxes could not be loaded: ${e.message}`); }
    }

    return store.tx(async t => {
      const b = t.bill(id);
      if (!b || V.STICKY.has(b.status)) return b;
      const before = summary(b);
      b.company = company.id || '';
      b.company_basis = company.basis;
      b.company_sure = company.sure !== false;
      b.vendor = vendor;
      if (vendor?.id) {
        const vz = vendors.find(v => v.id === vendor.id);
        if (vz) b.vendor.zoho_category = vz.zoho_category;
      }

      // Duplicates
      const dismissed = b.duplicate?.dismissed || [];
      const dup = D.check(b, t.bills(), zohoBills);
      b.duplicate = dup ? { ...dup, dismissed, at: now() } : (dismissed.length ? { dismissed } : null);

      // Category
      const categories = cfg.categories.filter(c => c.active !== false);
      if (b.category?.source !== 'manual') {
        const vendorHistory = vendor?.id ? t.bills().filter(x => x.id !== b.id && x.company === b.company && x.vendor?.id === vendor.id && x.category?.id
          && (x.category.source === 'manual' || x.status === 'reviewed' || x.status === 'draft_created')).map(x => ({ category_id: x.category.id })) : [];
        const cat = M.categorise({ bill: b, categories, member, vendorHistory, vendorZohoCategory: b.vendor?.zoho_category, minScore: cfg.settings.category_min_score });
        b.category = cat;
      } else if (!categories.some(c => c.id === b.category.id)) {
        b.category = { id: '', name: '', source: '', basis: `Category "${b.category.name}" is no longer active — choose another` };
      }
      const catDef = cfg.categories.find(c => c.id === b.category?.id);

      // Accounts and GST per line
      const mappings = t.doc('bb_mappings') || [];
      const threshold = cfg.settings.similarity_threshold;
      for (const l of b.lines) {
        if (l.account?.source !== 'manual') {
          l.account = null; l.account_issue = ''; l.account_options = [];
          if (vendor?.id && co) {
            const m = A.mappingFor(l, { mappings, company: b.company, vendorId: vendor.id, categoryId: b.category?.id, threshold });
            if (m) {
              l.account = { id: m.m.account_id, name: m.m.account_name, source: 'mapping', confidence: m.vendorWide ? 'medium' : 'high',
                basis: m.vendorWide ? `Confirmed for all bills of this vendor by ${m.m.updated_by || m.m.created_by}` : `Confirmed mapping by ${m.m.updated_by || m.m.created_by}: "${m.m.description.slice(0, 60)}" (${Math.round(m.s * 100)}% similar)`,
                ref: { mapping_id: m.m.id } };
            } else {
              const h = A.fromHistory(l, hist.bills, threshold);
              if (h.account) l.account = h.account;
              else l.account_issue = h.basis + (h.status === 'inconsistent' ? ' — choose the account' : ' — choose the expense account');
              l.account_options = h.alternatives.slice(0, 6);
            }
          } else l.account_issue = 'Choose the vendor first — the account comes from its earlier bills';
        }
        if (l.tax?.source !== 'manual') {
          l.tax = null; l.tax_issue = ''; l.tax_needed = false;
          if (l.account?.id) {
            const s = A.suggestTax(l, l.account.id, { fields: b.fields, taxes, mappings, company: b.company, vendorId: vendor?.id, historyBills: hist.bills });
            l.tax = s.tax; l.tax_needed = s.needed; l.tax_issue = s.issue;
          } else {
            const bt = A.billTax(l, b.fields);
            l.tax_needed = bt.kind !== 'none' && bt.rate !== 0;
          }
        } else l.tax_needed = true;
      }

      // Branch / TDS from the vendor's consistent history (kept when chosen by hand)
      const bl = A.billLevel(hist.bills, hist.rows);
      b.bill_level = {
        branch: b.bill_level?.branch?.source === 'manual' ? b.bill_level.branch : bl.branch || null,
        tds: b.bill_level?.tds?.source === 'manual' ? b.bill_level.tds : bl.tds || null,
      };
      b.bill_level_notes = [...notes];
      if (!b.bill_level.tds && bl.tds_note) b.bill_level_notes.push(bl.tds_note);
      if (vendor?.id && !hist.bills.length && !notes.length) b.bill_level_notes.push(`No bills of this vendor in Zoho in the last ${cfg.settings.history_days} days — accounts come from mappings or the team`);

      // Category-specific fields
      b.cat_field_state = {};
      if (catDef) {
        const auto = autoFieldValues(catDef, b, hist.bills, mappings);
        for (const def of catDef.fields) b.cat_field_state[def.id] = V.fieldValue(def, b, auto);
      }

      // Not a bill?
      const nb = V.notBill(b);
      if (b.not_bill?.overridden) { /* the team said it is a bill */ }
      else if (b.not_bill?.manual) { /* the team said it is not */ }
      else b.not_bill = nb ? { reason: nb.reason } : null;

      b.issues = V.issues(b, { category: catDef, acks: b.acks || [] });
      b.evaluated_at = now();
      b.status = V.status(b);
      b.updated_at = now();
      const after = summary(b);
      if (after !== before) audit(b, by, 'evaluated', after);
      t.putBill(b);
      return b;
    }).then(async b => {
      if (b && b.status === 'ready' && !inFlight.has(id) && cfg.settings.auto_create_drafts && cfg.settings.draft_capability?.[org]?.verified) {
        try { await createDraft(id, { by: 'system (auto)' }); } catch (e) { log.error(`[bill-booking] auto draft ${id}: ${e.message}`); }
      }
      return store.bill(id);
    });
  }

  function summary(b) {
    const parts = [
      `status ${C.STATUSES[b.status] || b.status}`,
      b.company ? `company ${b.company}` : 'company ?',
      b.vendor?.id ? `vendor ${b.vendor.name} (${b.vendor.match})` : 'vendor ?',
      b.category?.id ? `category ${b.category.name} (${b.category.source || 'suggested'})` : 'category ?',
      ...b.lines.map((l, i) => `line ${i + 1}: ${l.account?.name ? `${l.account.name} [${l.account.source}]` : 'account ?'}${l.tax?.name ? `, ${l.tax.name} [${l.tax.source}]` : l.tax_needed ? ', tax ?' : ''}`),
    ];
    if (b.duplicate?.certainty) parts.push(`duplicate: ${b.duplicate.reason}`);
    const blocks = (b.issues || []).filter(i => i.severity === 'block' && !i.acked).length;
    if (blocks) parts.push(`${blocks} open issue(s)`);
    return parts.join('; ');
  }

  function autoFieldValues(catDef, b, histBills, mappings) {
    const auto = {};
    for (const def of catDef.fields) {
      if (def.source === 'extraction' && def.extraction_key) {
        const v = b.fields[def.extraction_key];
        if (v) auto[def.id] = { value: v, source: 'extraction' };
      } else if (def.source === 'history') {
        if (def.type === 'reference' && def.reference === 'zoho_branch' && b.bill_level?.branch?.id) {
          auto[def.id] = { value: { id: b.bill_level.branch.id, name: b.bill_level.branch.name }, source: 'history' };
        } else if (def.zoho?.target === 'bill_custom_field' && histBills.length) {
          const vals = new Set(histBills.map(h => (h.custom_fields || []).find(c => c.api_name === def.zoho.key)?.value ?? ''));
          if (vals.size === 1 && [...vals][0] !== '') auto[def.id] = { value: [...vals][0], source: 'history' };
        }
      } else if (def.source === 'mapping' && b.vendor?.id) {
        const m = mappings.find(x => x.kind === 'field' && x.active !== false && x.company === b.company && x.vendor_id === b.vendor.id && x.field_id === def.id && (!x.category_id || x.category_id === catDef.id));
        if (m) auto[def.id] = { value: m.value, source: 'mapping' };
      }
    }
    return auto;
  }

  // ── Edits by the team ──────────────────────────────────────────────────────
  const EDITABLE = ['vendor_name', 'vendor_gstin', 'buyer_gstin', 'invoice_number', 'invoice_date', 'due_date', 'currency', 'exchange_rate',
    'sub_total', 'cgst', 'sgst', 'igst', 'cess', 'tax_total', 'round_off', 'total', 'description', 'po_number', 'place_of_supply',
    'service_period_from', 'service_period_to', 'reverse_charge'];
  const NUMERIC = new Set(['exchange_rate', 'sub_total', 'cgst', 'sgst', 'igst', 'cess', 'tax_total', 'round_off', 'total']);
  const DATES = new Set(['invoice_date', 'due_date', 'service_period_from', 'service_period_to']);

  /**
   * changes: { fields, company, vendor: {id}, category_id, lines: [{ id?, description, hsn_sac, amount, account_id, tax_id }],
   *            bill_level: { branch_id, tds_tax_id }, cat_fields: { id: value }, remember: { accounts, fields: [ids] }, acks: [keys] }
   * look: { accounts, taxes, branches, vendors } of the bill's organisation (names for the chosen ids)
   */
  async function edit(id, changes, user, look = {}) {
    const by = user.name || user.username;
    const r = await store.tx(async t => {
      const b = t.bill(id);
      if (!b) throw Object.assign(new Error('Bill not found'), { status: 404 });
      if (V.STICKY.has(b.status)) throw Object.assign(new Error('This bill is already a Zoho draft — change it in Zoho'), { status: 409 });
      const cfg = C.merge(t.doc('bb_config'));
      const log = [];
      const at = now();
      b.field_source = b.field_source || {};

      for (const [k, v0] of Object.entries(changes.fields || {})) {
        if (!EDITABLE.includes(k)) continue;
        let v = v0;
        if (NUMERIC.has(k)) v = v0 === '' || v0 == null ? null : T.round2(Number(v0));
        else if (DATES.has(k)) { v = v0 ? T.parseDate(v0) : ''; if (v0 && !v) throw Object.assign(new Error(`${k.replace(/_/g, ' ')}: not a date`), { status: 400 }); }
        else if (k === 'reverse_charge') v = !!v0;
        else v = String(v0 ?? '').trim();
        if (k === 'vendor_gstin' || k === 'buyer_gstin') { v = String(v).toUpperCase(); if (v && !T.isGstin(v)) throw Object.assign(new Error(`${v} is not a valid GSTIN`), { status: 400 }); }
        if (NUMERIC.has(k) && v != null && !Number.isFinite(v)) throw Object.assign(new Error(`${k.replace(/_/g, ' ')}: not a number`), { status: 400 });
        if (b.fields[k] === v || (b.fields[k] == null && v === '')) continue;
        log.push(`${k}: "${b.fields[k] ?? ''}" → "${v ?? ''}"`);
        b.fields[k] = v;
        b.field_source[k] = 'manual';
      }
      if (changes.fields && ['cgst', 'sgst', 'igst', 'cess'].some(k => k in changes.fields) && !('tax_total' in changes.fields)) {
        b.fields.tax_total = T.round2((b.fields.cgst || 0) + (b.fields.sgst || 0) + (b.fields.igst || 0) + (b.fields.cess || 0));
      }

      if (changes.company !== undefined && changes.company !== b.company) {
        if (changes.company && !cfg.companies.some(c => c.id === changes.company)) throw Object.assign(new Error('Unknown company'), { status: 400 });
        log.push(`company: ${b.company || '—'} → ${changes.company || '—'}`);
        b.company = changes.company; b.company_source = changes.company ? 'manual' : '';
        b.company_basis = changes.company ? `Chosen by ${by}` : '';
        if (b.vendor?.match === 'manual') b.vendor = null;   // another organisation's vendor list
      }
      if (changes.vendor !== undefined) {
        const vid = changes.vendor?.id || '';
        if (vid !== (b.vendor?.id || '')) {
          const v = (look.vendors || []).find(x => x.id === vid);
          if (vid && !v) throw Object.assign(new Error('Vendor not found in this organisation'), { status: 400 });
          log.push(`vendor: ${b.vendor?.name || '—'} → ${v?.name || '—'}`);
          b.vendor = vid ? { id: v.id, name: v.name, match: 'manual', confidence: 'high', basis: `Chosen by ${by}`, candidates: [], by, at } : null;
          // accounts suggested for the old vendor no longer apply
          b.lines.forEach(l => { if (l.account?.source !== 'manual') l.account = null; if (l.tax?.source !== 'manual') l.tax = null; });
        }
      }
      if (changes.category_id !== undefined && changes.category_id !== (b.category?.id || '')) {
        const c = cfg.categories.find(x => x.id === changes.category_id);
        if (changes.category_id && !c) throw Object.assign(new Error('Unknown category'), { status: 400 });
        log.push(`category: ${b.category?.name || '—'} → ${c?.name || '—'}`);
        b.category = c ? { id: c.id, name: c.name, source: 'manual', confidence: 'high', basis: `Chosen by ${by}`, by, at, previous: b.category?.id ? { id: b.category.id, basis: b.category.basis } : null } : null;
      }

      const newMappings = [];
      if (Array.isArray(changes.lines)) {
        const accounts = new Map((look.accounts || []).map(a => [a.id, a]));
        const taxes = new Map((look.taxes || []).map(x => [x.id, x]));
        const oldById = new Map(b.lines.map(l => [l.id, l]));
        const next = [];
        changes.lines.forEach((cl, i) => {
          const old = oldById.get(cl.id) || {};
          const amount = cl.amount === '' || cl.amount == null ? null : T.round2(Number(cl.amount));
          if (amount != null && !Number.isFinite(amount)) throw Object.assign(new Error(`Line ${i + 1}: amount is not a number`), { status: 400 });
          const l = { ...old, id: old.id || `l${Date.now().toString(36)}${i}`, description: String(cl.description ?? old.description ?? '').trim(), hsn_sac: String(cl.hsn_sac ?? old.hsn_sac ?? '').replace(/\D/g, '').slice(0, 8), amount };
          if (old.amount !== amount || old.description !== l.description) { l.quantity = 1; l.rate = amount; }
          if (cl.account_id !== undefined && cl.account_id !== (old.account?.id || '')) {
            if (cl.account_id) {
              const a = accounts.get(cl.account_id);
              if (!a) throw Object.assign(new Error(`Line ${i + 1}: account not found in Zoho`), { status: 400 });
              l.account = { id: a.id, name: a.name, source: 'manual', confidence: 'high', basis: `Chosen by ${by}`, by, at, suggested: old.account ? { id: old.account.id, name: old.account.name, source: old.account.source } : null };
              log.push(`line ${i + 1} account: ${old.account?.name || '—'} → ${a.name}`);
              if (changes.remember?.accounts) newMappings.push(l);
            } else { l.account = null; log.push(`line ${i + 1} account cleared`); }
          } else if (cl.account_id && old.account?.id === cl.account_id && changes.remember?.accounts && old.account.source !== 'mapping') newMappings.push(l);
          if (cl.tax_id !== undefined && cl.tax_id !== (old.tax?.id || '')) {
            if (cl.tax_id) {
              const x = taxes.get(cl.tax_id);
              if (!x) throw Object.assign(new Error(`Line ${i + 1}: tax not found in Zoho`), { status: 400 });
              l.tax = { id: x.id, name: x.name, source: 'manual', basis: `Chosen by ${by}`, by, at };
              log.push(`line ${i + 1} tax: ${old.tax?.name || '—'} → ${x.name}`);
              if (changes.remember?.accounts && l.account?.id && !newMappings.includes(l)) newMappings.push(l);
            } else { l.tax = null; log.push(`line ${i + 1} tax cleared`); }
          }
          next.push(l);
        });
        if (next.length !== b.lines.length) log.push(`lines: ${b.lines.length} → ${next.length}`);
        else next.forEach((l, i) => { const o = b.lines[i]; if (o && (o.amount !== l.amount || o.description !== l.description)) log.push(`line ${i + 1}: "${o.description}" ${o.amount} → "${l.description}" ${l.amount}`); });
        b.lines = next;
      }

      if (changes.bill_level) {
        b.bill_level = b.bill_level || {};
        if ('branch_id' in changes.bill_level) {
          const br = (look.branches || []).find(x => x.id === changes.bill_level.branch_id);
          if (changes.bill_level.branch_id && !br) throw Object.assign(new Error('Branch not found in Zoho'), { status: 400 });
          if ((b.bill_level.branch?.id || '') !== (changes.bill_level.branch_id || '')) {
            log.push(`branch: ${b.bill_level.branch?.name || '—'} → ${br?.name || '—'}`);
            b.bill_level.branch = br ? { id: br.id, name: br.name, source: 'manual', basis: `Chosen by ${by}`, by, at } : { id: '', name: '', source: 'manual', basis: `Cleared by ${by}` };
          }
        }
        if ('tds_tax_id' in changes.bill_level) {
          const tdsId = changes.bill_level.tds_tax_id || '';
          if ((b.bill_level.tds?.id || '') !== tdsId) {
            log.push(`TDS: ${b.bill_level.tds?.name || '—'} → ${changes.bill_level.tds_name || tdsId || '—'}`);
            b.bill_level.tds = tdsId ? { id: tdsId, name: String(changes.bill_level.tds_name || tdsId).slice(0, 80), source: 'manual', basis: `Chosen by ${by}`, by, at } : { id: '', name: '', source: 'manual', basis: `No TDS — ${by}` };
          }
        }
      }

      if (changes.cat_fields) {
        b.cat_fields = b.cat_fields || {};
        for (const [fid, v] of Object.entries(changes.cat_fields)) {
          const prev = b.cat_fields[fid]?.value ?? b.cat_field_state?.[fid]?.value ?? '';
          const same = JSON.stringify(prev) === JSON.stringify(v);
          if (same && b.cat_fields[fid]?.source === 'manual') continue;
          b.cat_fields[fid] = { value: v, source: 'manual', by, at };
          if (!same) log.push(`field ${fid}: "${typeof prev === 'object' ? prev?.name || '' : prev}" → "${typeof v === 'object' ? v?.name || '' : v}"`);
        }
      }

      if (Array.isArray(changes.acks)) {
        const add = changes.acks.filter(k => !(b.acks || []).includes(k));
        if (add.length) { b.acks = [...(b.acks || []), ...add]; log.push(`confirmed: ${add.join(', ')}`); }
      }

      // Confirmed mappings (company + vendor + category + description → account / tax)
      if (newMappings.length && b.vendor?.id && b.company) {
        const list = [...(t.doc('bb_mappings') || [])];
        for (const l of newMappings) {
          if (!l.account?.id) continue;
          const existing = list.find(m => m.kind !== 'field' && m.company === b.company && m.vendor_id === b.vendor.id && (m.category_id || '') === (b.category?.id || '') && m.description && T.similarity(m.description, l.description) >= 0.9);
          const rec = existing || { id: C.newId('map'), kind: 'account', company: b.company, vendor_id: b.vendor.id, created_by: by, created_at: at, uses: 0 };
          Object.assign(rec, { vendor_name: b.vendor.name, category_id: b.category?.id || '', category_name: b.category?.name || '', description: l.description,
            account_id: l.account.id, account_name: l.account.name, tax_id: l.tax?.id || '', tax_name: l.tax?.name || '', updated_by: by, updated_at: at, active: true, from_bill: b.id });
          if (!existing) list.push(rec);
          log.push(`mapping saved: "${l.description.slice(0, 50)}" → ${l.account.name}${l.tax?.name ? ` / ${l.tax.name}` : ''}`);
        }
        t.setDoc('bb_mappings', list);
      }
      if (Array.isArray(changes.remember?.fields) && b.vendor?.id && b.company) {
        const list = [...(t.doc('bb_mappings') || [])];
        for (const fid of changes.remember.fields) {
          const v = b.cat_fields?.[fid]?.value;
          if (v === undefined || v === '') continue;
          const ex = list.find(m => m.kind === 'field' && m.company === b.company && m.vendor_id === b.vendor.id && m.field_id === fid);
          const rec = ex || { id: C.newId('map'), kind: 'field', company: b.company, vendor_id: b.vendor.id, field_id: fid, created_by: by, created_at: at };
          Object.assign(rec, { vendor_name: b.vendor.name, category_id: b.category?.id || '', category_name: b.category?.name || '', value: v, updated_by: by, updated_at: at, active: true, from_bill: b.id });
          if (!ex) list.push(rec);
          log.push(`field mapping saved: ${fid}`);
        }
        t.setDoc('bb_mappings', list);
      }

      if (log.length) audit(b, by, 'edited', log.join('; '));
      if (log.length && b.zoho?.error) delete b.zoho.error;   // the team changed something: Failed → re-checked
      b.updated_at = at;
      t.putBill(b);
      return log.length;
    });
    await evaluate(id, { by: user.name || user.username });
    return { changed: r, bill: await store.bill(id) };
  }

  // ── Other actions ──────────────────────────────────────────────────────────
  async function action(id, act, payload, user) {
    const by = user.name || user.username;
    let reprocess = false;
    await store.tx(async t => {
      const b = t.bill(id);
      if (!b) throw Object.assign(new Error('Bill not found'), { status: 404 });
      if (V.STICKY.has(b.status) && act !== 'note') throw Object.assign(new Error('This bill is already a Zoho draft'), { status: 409 });
      if (act === 'not_bill') {
        b.not_bill = { reason: String(payload?.reason || 'Marked as not a bill').slice(0, 300), manual: true, by, at: now() };
        audit(b, by, 'not_bill', b.not_bill.reason);
      } else if (act === 'is_bill') {
        b.not_bill = { overridden: true, by, at: now() };
        b.acks = [...new Set([...(b.acks || []), 'doc_type_unclear'])];
        audit(b, by, 'is_bill', 'Confirmed as a bill');
      } else if (act === 'dismiss_duplicate') {
        const d = b.duplicate;
        if (!d?.certainty) throw Object.assign(new Error('No duplicate match to dismiss'), { status: 400 });
        const key = d.of || (d.zoho_bill_id ? `zoho:${d.zoho_bill_id}` : null);
        b.duplicate = { dismissed: [...(d.dismissed || []), key].filter(Boolean) };
        audit(b, by, 'not_duplicate', `Not a duplicate of ${key}: ${d.reason}${payload?.reason ? ` — ${payload.reason}` : ''}`);
      } else if (act === 'confirm_duplicate') {
        const d = b.duplicate;
        if (!d?.certainty) throw Object.assign(new Error('No duplicate match to confirm'), { status: 400 });
        b.duplicate = { ...d, certainty: d.certainty === 'possible' || d.certainty === 'revised' ? 'likely' : d.certainty, confirmed_by: by, confirmed_at: now() };
        audit(b, by, 'duplicate', `Confirmed duplicate: ${d.reason}`);
      } else if (act === 'ack') {
        const key = String(payload?.key || '');
        if (!key) throw Object.assign(new Error('Nothing to confirm'), { status: 400 });
        b.acks = [...new Set([...(b.acks || []), key])];
        if (key === 'zoho_deleted' && b.zoho) delete b.zoho.deleted_at;
        audit(b, by, 'confirmed', key);
      } else if (act === 'reprocess') {
        b.status = 'received';
        delete b.processing_error;
        b.extraction = null; b.acks = []; b.cat_fields = {}; b.vendor = null; b.category = null; b.not_bill = null;
        if (b.zoho && !b.zoho.bill_id) delete b.zoho.error;
        audit(b, by, 'reprocess', 'Read again from the original file (earlier changes discarded)');
        reprocess = true;
      } else if (act === 'retry') {
        delete b.processing_error;
        if (b.zoho) delete b.zoho.error;
        audit(b, by, 'retry', 'Retry');
        reprocess = !b.extraction;
      } else if (act === 'note') {
        const text = String(payload?.text || '').trim().slice(0, 1000);
        if (!text) throw Object.assign(new Error('Write a note'), { status: 400 });
        audit(b, by, 'note', text);
      } else throw Object.assign(new Error('Unknown action'), { status: 400 });
      b.status = V.status(b);
      b.updated_at = now();
      t.putBill(b);
    });
    if (reprocess) { await processBill(id, { force: true }); }
    else await evaluate(id, { by });
    return store.bill(id);
  }

  // ── Zoho draft ─────────────────────────────────────────────────────────────
  const inFlight = new Set();

  async function createDraft(id, user) {
    const by = user.name || user.username || user.by || 'system';
    if (inFlight.has(id)) throw Object.assign(new Error('A draft is already being created for this bill'), { status: 409 });
    inFlight.add(id);
    try {
      // A retry starts clean: the previous Zoho error is re-checked by this attempt
      await store.tx(async t => { const x = t.bill(id); if (x?.zoho?.error) { delete x.zoho.error; t.putBill(x); } });
      const b = await evaluate(id, { by });
      if (!b) throw Object.assign(new Error('Bill not found'), { status: 404 });
      if (b.zoho?.bill_id) throw Object.assign(new Error(`Already a Zoho draft (${b.zoho.bill_number || b.zoho.bill_id})`), { status: 409 });
      if (b.status !== 'ready') throw Object.assign(new Error(`Not ready for a draft (${C.STATUSES[b.status]}) — resolve the open issues first`), { status: 409 });
      const cfg = await config();
      const co = cfg.companies.find(c => c.id === b.company);
      const org = co.org_id;
      if (!cfg.settings.draft_capability?.[org]?.verified) {
        throw Object.assign(new Error(`Draft creation is not yet verified for ${co.name} — run the Zoho draft test in Settings first`), { status: 409 });
      }
      const catDef = cfg.categories.find(c => c.id === b.category.id);
      const attemptAt = now();
      await store.tx(async t => { const x = t.bill(id); x.zoho = { ...(x.zoho || {}), attempt: { at: attemptAt, by } }; delete x.zoho.error; t.putBill(x); });

      const finish = async (fn) => store.tx(async t => { const x = t.bill(id); fn(x); x.updated_at = now(); t.putBill(x); return x; });

      // Live check right before creating: the same vendor + bill number already in Zoho?
      let existing = [];
      try { existing = (await zc.findBill(org, b.vendor.id, b.fields.invoice_number)).filter(z => z.status !== 'void' && T.normInvoice(z.bill_number) === T.normInvoice(b.fields.invoice_number)); }
      catch (e) {
        await finish(x => { x.zoho.error = `Could not check Zoho for an existing bill: ${zc.errText(e)}`; delete x.zoho.attempt; x.issues = V.issues(x, { acks: x.acks }); x.status = V.status(x); audit(x, by, 'draft_failed', x.zoho.error); });
        throw Object.assign(new Error(`Could not check Zoho for an existing bill: ${zc.errText(e)}`), { status: 502 });
      }
      if (existing.length) {
        const z = existing[0];
        const x = await finish(x => {
          x.duplicate = { certainty: 'zoho', of: null, zoho_bill_id: z.bill_id, reason: `Already in Zoho: bill ${z.bill_number} dated ${z.date} (${z.status})`, dismissed: x.duplicate?.dismissed || [], at: now() };
          delete x.zoho.attempt;
          x.status = V.status(x);
          audit(x, by, 'duplicate', `Not created — ${x.duplicate.reason}`);
        });
        return x;
      }

      // Custom field ids from this organisation's bills (api_name → customfield_id)
      const customFieldIds = {};
      try {
        const doc = await store.zohoCache(org);
        for (const d of Object.values(doc.details || {})) for (const c of d.custom_fields || []) if (c.api_name && c.customfield_id) customFieldIds[c.api_name] = c.customfield_id;
      } catch (_) {}
      const payload = DR.buildPayload(b, { category: catDef, customFieldIds, note: `Prepared by Bill Collection & Booking (${b.id})` });

      let created;
      try { created = await zc.createBill(org, payload); }
      catch (e) {
        const msg = zc.errText(e);
        await finish(x => { x.zoho.error = `Draft not created — ${msg}`; delete x.zoho.attempt; x.issues = V.issues(x, { acks: x.acks }); x.status = V.status(x); audit(x, by, 'draft_failed', msg); });
        throw Object.assign(new Error(`Draft not created — ${msg}`), { status: 502 });
      }

      const isDraft = ACTIVE_ZOHO.has(created.status);
      let attachNote = 'attached';
      if (['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(b.file.type)) {
        try { await zc.attach(org, created.bill_id, await files.read(id, b.file.name), b.source_ref.attachment_name || b.file.name, b.file.type); }
        catch (e) { attachNote = `not attached (${zc.errText(e)}) — attach the original in Zoho`; }
      } else attachNote = 'not attached (Zoho accepts PDF and common images only) — attach the original in Zoho';
      try { await zc.send('post', org, `/bills/${created.bill_id}/comments`, { data: { description: DR.reviewComment(b) } }); } catch (_) {}

      const x = await finish(x => {
        delete x.zoho.attempt;
        x.zoho = {
          bill_id: created.bill_id, bill_number: created.bill_number, status: created.status, url: zc.billUrl(org, created.bill_id),
          org, created_at: now(), created_by: by, attachment: attachNote, last_checked: now(),
          total: created.total, sub_total: created.sub_total,
        };
        if (!isDraft) x.zoho.not_draft = true;
        if (created.sub_total != null && x.fields.sub_total != null && Math.abs(created.sub_total - x.fields.sub_total) > 1) {
          x.zoho.check = `Zoho's taxable value ${created.sub_total} differs from the bill's ${x.fields.sub_total} — check the draft`;
        }
        x.status = 'draft_created';
        audit(x, by, 'draft_created', `Zoho ${isDraft ? 'draft' : `bill (status "${created.status}" — NOT a draft)`} ${created.bill_number} (${created.bill_id}); original ${attachNote}${x.zoho.check ? `; ${x.zoho.check}` : ''}`);
      });
      if (!isDraft) {
        // Zoho did not keep it as a draft: stop all further drafting for this organisation until checked
        await store.tx(async t => {
          const c = C.merge(t.doc('bb_config'));
          c.settings.draft_capability = { ...c.settings.draft_capability, [org]: { verified: false, status: created.status, checked_at: now(), by, detail: `Bill ${created.bill_number} was created with status "${created.status}" instead of draft` } };
          c.settings.auto_create_drafts = false;
          t.setDoc('bb_config', c);
        });
        await store.audit({ by, action: 'draft_not_respected', detail: `${co.name}: bill ${created.bill_number} (${created.bill_id}) came back "${created.status}". Automatic drafts switched off.` });
      }
      return x;
    } finally {
      inFlight.delete(id);
    }
  }

  /**
   * Draft test for one organisation (Settings, by an admin): creates a ₹1 draft bill for the chosen
   * vendor and account, reads its status, deletes it. Verified only if Zoho kept it as a draft.
   */
  async function draftTest(companyId, { vendor_id, account_id }, user) {
    const by = user.name || user.username;
    const cfg = await config();
    const co = cfg.companies.find(c => c.id === companyId);
    if (!co) throw Object.assign(new Error('Unknown company'), { status: 400 });
    if (!vendor_id || !account_id) throw Object.assign(new Error('Choose a vendor and an expense account for the test bill'), { status: 400 });
    const org = co.org_id;
    const number = `BB-DRAFT-TEST-${Date.now().toString(36).toUpperCase()}`;
    let created, deleted = false, detail;
    try {
      created = await zc.createBill(org, {
        vendor_id, bill_number: number, date: new Date().toISOString().slice(0, 10), is_draft: true,
        notes: 'Bill Collection & Booking — draft capability test. Deleted automatically.',
        line_items: [{ account_id, description: 'Draft capability test (deleted automatically)', rate: 1, quantity: 1 }],
      });
    } catch (e) { throw Object.assign(new Error(`Test bill not created — ${zc.errText(e)}`), { status: 502 }); }
    try { await zc.deleteBill(org, created.bill_id); deleted = true; } catch (e) { detail = `could not delete it (${zc.errText(e)}) — delete bill ${number} in Zoho by hand`; }
    const verified = ACTIVE_ZOHO.has(created.status);
    const result = {
      verified, status: created.status, checked_at: now(), by, bill_number: number, deleted,
      detail: verified
        ? `Zoho kept the test bill as "${created.status}"${deleted ? ' and it was deleted again' : `; ${detail}`}`
        : `Zoho created the test bill as "${created.status}" (not a draft)${deleted ? ' — it was deleted again' : `; ${detail}`}. Drafts cannot be created this way: see the note in Settings.`,
    };
    await store.tx(async t => {
      const c = C.merge(t.doc('bb_config'));
      c.settings.draft_capability = { ...c.settings.draft_capability, [org]: result };
      if (!verified) c.settings.auto_create_drafts = false;
      t.setDoc('bb_config', c);
    });
    await store.audit({ by, action: 'draft_test', detail: `${co.name}: ${result.detail}` });
    return result;
  }

  // ── Review tracking ────────────────────────────────────────────────────────
  /** Checks Zoho drafts: opened/approved → Reviewed; deleted → back to the team. */
  async function refreshZoho({ ids = null, limit = 60, by = 'system' } = {}) {
    const snap = await store.snapshot();
    const drafts = snap.bills.filter(b => b.status === 'draft_created' && b.zoho?.bill_id && (!ids || ids.includes(b.id)))
      .sort((a, b) => String(a.zoho.last_checked || '').localeCompare(String(b.zoho.last_checked || ''))).slice(0, limit);
    const results = [];
    for (const d of drafts) {
      let z, err = null;
      try { z = await zc.getBill(d.zoho.org || orgOf(snap, d), d.zoho.bill_id); } catch (e) { err = zc.errText(e); }
      results.push({ id: d.id, status: err ? 'error' : z ? z.status : 'deleted' });
      await store.tx(async t => {
        const b = t.bill(d.id);
        if (!b || b.status !== 'draft_created') return;
        b.zoho.last_checked = now();
        if (err) { b.zoho.check_error = err; }
        else if (!z) {
          b.zoho = { previous: { bill_id: b.zoho.bill_id, bill_number: b.zoho.bill_number, created_at: b.zoho.created_at }, deleted_at: now() };
          b.status = 'needs_input';
          b.acks = (b.acks || []).filter(k => k !== 'zoho_deleted');
          audit(b, by, 'zoho_deleted', 'The draft no longer exists in Zoho (deleted there)');
          b.issues = V.issues(b, { acks: b.acks });
        } else if (z.status !== b.zoho.status) {
          const prev = b.zoho.status;
          b.zoho.status = z.status;
          delete b.zoho.check_error;
          if (!ACTIVE_ZOHO.has(z.status)) {
            b.status = 'reviewed';
            b.reviewed = { at: now(), zoho_status: z.status, by: z.last_modified_by || '' };
            audit(b, by, 'reviewed', `Zoho status ${prev} → ${z.status}${z.last_modified_by ? ` (last changed by ${z.last_modified_by})` : ''}`);
          } else audit(b, by, 'zoho_status', `Zoho status ${prev} → ${z.status}`);
        }
        b.updated_at = now();
        t.putBill(b);
      });
    }
    return results;
  }
  const orgOf = (snap, b) => C.merge(snap.doc('bb_config')).companies.find(c => c.id === b.company)?.org_id;

  /** Bills left unprocessed by a previous run (server restart) */
  async function resume() {
    const snap = await store.snapshot();
    for (const b of snap.bills) if (b.status === 'received' && !b.processing_error) enqueue(b.id);
    return idle();
  }

  return { ingest, processBill, evaluate, edit, action, createDraft, draftTest, refreshZoho, resume, enqueue, idle, config };
}

module.exports = { create };
