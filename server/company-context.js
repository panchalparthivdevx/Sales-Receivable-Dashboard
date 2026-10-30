// ─── MSME multi-company context ────────────────────────────────────────────────
// DevX is the existing setup and stays exactly as it is: outside a company context every wrapper
// below passes straight through to the original object.
//
// Another company (Neddle) runs the SAME MSME code inside an AsyncLocalStorage context
// { company }. Requests under /api/c/<company>/… and that company's own sync engine run in it,
// and only there the wrappers switch:
//   • Zoho      → the company's organization_id (writes to Zoho are refused)
//   • storage   → its own keys (Neon: "c_<company>__<key>") / files (server/companies/<company>/…)
//   • cache     → its own NodeCache keys
//   • syncEngine→ its own engine instance (own entities, checkpoints, run log, schedule)
// Nothing falls back to DevX data: a company with no data of its own simply has none yet.
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const fs   = require('fs');

const COMPANIES = {
  neddle: { id: 'neddle', name: 'Neddle And Thread Designs LLP', short: 'Neddle', orgId: '60007894213', scheduleMinute: 10 },
};
const SERVER_DIR = __dirname;
const als = new AsyncLocalStorage();

// Company of the running request / sync; null = DevX (the default, untouched path)
function current() { return als.getStore()?.company || null; }
function run(company, fn) { return als.run({ company }, fn); }

// ── Storage ───────────────────────────────────────────────────────────────────
function keyFor(company, key) { return `c_${company}__${key}`; }
function fileFor(company, file) {
  if (!file) return file;
  const rel = path.relative(SERVER_DIR, file);
  return path.join(SERVER_DIR, 'companies', company, rel.startsWith('..') ? path.basename(file) : rel);
}
function _ensureDir(file) {
  // Optional on Vercel: its disk is read-only and the data lives in Neon there
  try { if (file) fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
}
// Storage for one company: same db, own keys and files
function scopedDb(baseDb, company) {
  return {
    ...baseDb,
    readJSON: (key, file, def) => baseDb.readJSON(keyFor(company, key), fileFor(company, file), def),
    writeJSON: (key, file, data) => {
      const f = fileFor(company, file);
      _ensureDir(f);
      return baseDb.writeJSON(keyFor(company, key), f, data);
    },
  };
}
// Storage that follows the running context (used by index.js)
function contextDb(baseDb) {
  const scoped = {};
  const forCo = co => scoped[co] || (scoped[co] = scopedDb(baseDb, co));
  return {
    ...baseDb,
    readJSON:  (...a) => { const co = current(); return co ? forCo(co).readJSON(...a)  : baseDb.readJSON(...a); },
    writeJSON: (...a) => { const co = current(); return co ? forCo(co).writeJSON(...a) : baseDb.writeJSON(...a); },
  };
}

// ── NodeCache ─────────────────────────────────────────────────────────────────
function contextCache(base) {
  const pre = co => `${co}::`;
  const k = key => { const co = current(); return co ? pre(co) + key : key; };
  return {
    get: key => base.get(k(key)),
    set: (key, ...rest) => base.set(k(key), ...rest),
    has: key => base.has(k(key)),
    del: keys => base.del(Array.isArray(keys) ? keys.map(k) : k(keys)),
    keys: () => {
      const co = current();
      return co ? base.keys().filter(x => x.startsWith(pre(co))).map(x => x.slice(pre(co).length)) : base.keys();
    },
    flushAll: () => {
      const co = current();
      if (!co) return base.flushAll();
      base.del(base.keys().filter(x => x.startsWith(pre(co))));
    },
  };
}

// ── Zoho ──────────────────────────────────────────────────────────────────────
function _withOrg(company, params) {
  return params?.organization_id ? params : { ...(params || {}), organization_id: COMPANIES[company].orgId };
}
// Zoho calls fixed to one company's organisation (its sync engine)
function companyZoho(zoho, company) {
  return {
    zohoGet:    (p, params, ...rest) => zoho.zohoGet(p, _withOrg(company, params), ...rest),
    zohoGetAll: (p, listKey, params, ...rest) => zoho.zohoGetAll(p, listKey, _withOrg(company, params), ...rest),
  };
}
// Zoho calls that follow the running context (used by index.js). The MSME module only reads from
// Zoho; in a company context writes are refused so its Zoho Books is never modified from here.
function contextZoho(zoho) {
  const refuse = name => (...a) => {
    if (current()) return Promise.reject(new Error(`${name} is not allowed for company "${current()}"`));
    return zoho[name](...a);
  };
  return {
    zohoGet:    (p, params, ...rest) => { const co = current(); return zoho.zohoGet(p, co ? _withOrg(co, params) : params, ...rest); },
    zohoGetAll: (p, listKey, params, ...rest) => { const co = current(); return zoho.zohoGetAll(p, listKey, co ? _withOrg(co, params) : params, ...rest); },
    zohoPost: refuse('zohoPost'),
    zohoPut:  refuse('zohoPut'),
  };
}

// ── Sync engine ───────────────────────────────────────────────────────────────
// A company's engine is a separate copy of sync-engine.js (own module state: entities,
// checkpoints, run log, progress, schedule) configured through global.__syncEngineCfg while it
// loads. The DevX engine is the normal require('./sync-engine') and gets no config.
function loadCompanyEngine(company, { baseDb, entities }) {
  const file = require.resolve('./sync-engine');
  const devx = require.cache[file];
  delete require.cache[file];
  global.__syncEngineCfg = { company, db: scopedDb(baseDb, company), entities, scheduleMinute: COMPANIES[company].scheduleMinute };
  let engine;
  try { engine = require(file); }
  finally {
    delete global.__syncEngineCfg;
    if (devx) require.cache[file] = devx; else delete require.cache[file];
  }
  // Everything the engine starts (runs, scheduler timers, derived entities that call back into the
  // MSME code) runs inside the company context
  return new Proxy(engine, {
    get(target, prop) {
      const v = target[prop];
      return typeof v === 'function' ? (...a) => run(company, () => v(...a)) : v;
    },
  });
}
// syncEngine as seen by index.js: the DevX engine, or the running company's engine
function contextEngine(devxEngine, companyEngines) {
  return new Proxy(devxEngine, {
    get(target, prop) {
      const co = current();
      const eng = co ? companyEngines[co] : target;
      if (!eng) throw new Error(`No sync engine for company "${co}"`);
      return eng[prop];
    },
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
// Only the MSME module (and its sync controls) is reachable under /api/c/<company>/…
const COMPANY_ROUTES = [
  /^\/purchase\/msme-report$/,
  /^\/msme-interest\//,
  /^\/msme-form1\//,
  /^\/admin\/sync\/(run|retry|progress|status|log)$/,
  /^\/sync\/freshness$/,
];
function isCompanyRoute(p) { return COMPANY_ROUTES.some(re => re.test(p)); }

// Express middleware: /api/c/<company>/<route> → /api/<route> inside the company context.
// The JSON body is read first: stream events don't carry the async context, so entering it only
// after parsing keeps it for every later middleware and handler (their own parsers then skip).
const _companyJson = require('express').json({ limit: '10mb' });
function companyRouter(req, res, next) {
  const m = req.url.match(/^\/api\/c\/([a-z0-9_-]+)(\/[^?]*)(\?.*)?$/);
  if (!m) return next();
  const co = COMPANIES[m[1]];
  if (!co || !isCompanyRoute(m[2])) return res.status(404).json({ error: 'Not found' });
  _companyJson(req, res, err => {
    if (err) return next(err);
    req.url = '/api' + m[2] + (m[3] || '');
    req.company = co.id;
    run(co.id, next);
  });
}

module.exports = {
  COMPANIES, current, run, keyFor, fileFor, scopedDb, contextDb, contextCache,
  companyZoho, contextZoho, loadCompanyEngine, contextEngine, companyRouter, isCompanyRoute,
};
