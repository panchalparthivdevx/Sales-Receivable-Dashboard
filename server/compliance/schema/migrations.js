/**
 * Schema migrations for the compliance data document.
 *
 * The data document carries `schema_version`. On every load, any migration with a higher
 * version runs in order and the result is saved (inside the same transaction, after an
 * automatic backup). To change the data shape later: append a migration — never edit an
 * old one. See SCHEMA.md for the field list.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const SEED_FILE = path.join(__dirname, '..', 'config', 'seed.json');

function emptyState() {
  return {
    schema_version: 0,
    companies: [],
    compliances: [],
    applicability: [],
    tasks: [],
    documents: [],
    folders: [],
    user_roles: [],
  };
}

const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema; load seed companies, compliances (GST, Payroll, TDS) and applicability',
    up(state, { now }) {
      const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      const stamp = { created_at: now, created_by: 'system (seed)', updated_at: now, updated_by: 'system (seed)' };
      if (!state.companies.length) state.companies = seed.companies.map(c => ({ ...c, ...stamp }));
      if (!state.compliances.length) state.compliances = seed.compliances.map(c => ({ ...c, active: c.active !== false, ...stamp }));
      if (!state.applicability.length && seed.applicability_default_rows === 'all-yes') {
        for (const co of state.companies) for (const cm of state.compliances) {
          state.applicability.push({ company_id: co.id, compliance_id: cm.id, applicable: 'Yes', responsible: '', reviewer: '', remarks: '', ...stamp });
        }
      }
      return state;
    },
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Apply pending migrations in place. Returns the list of versions applied. */
function migrate(state, { now = new Date().toISOString() } = {}) {
  const s = state || emptyState();
  for (const k of Object.keys(emptyState())) if (s[k] === undefined) s[k] = emptyState()[k];
  const applied = [];
  for (const m of MIGRATIONS) {
    if ((s.schema_version || 0) < m.version) {
      m.up(s, { now });
      s.schema_version = m.version;
      applied.push(m.version);
    }
  }
  return { state: s, applied };
}

module.exports = { emptyState, migrate, MIGRATIONS, LATEST_VERSION };
