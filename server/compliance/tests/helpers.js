'use strict';

// Shared test helpers — every test works on its own seeded copy of the data and a temp folder.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { migrate } = require('../schema/migrations');
const Settings = require('../lib/settings');

function tmpDir(prefix = 'cmp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fresh seeded state (companies, compliances, applicability from config/seed.json) */
function seededState() {
  return migrate(null, { now: '2026-04-01T00:00:00.000Z' }).state;
}

/** Effective settings with optional overrides */
function settings(over = {}) {
  return Settings.merge(over);
}

const USER = { id: 'test', username: 'tester', name: 'Tester' };

function ctx(extra = {}) {
  return { settings: settings(extra.settingsOver), user: USER, now: '2026-10-03T10:00:00.000Z', today: extra.today || '2026-10-03', ...extra };
}

module.exports = { tmpDir, seededState, settings, ctx, USER };
