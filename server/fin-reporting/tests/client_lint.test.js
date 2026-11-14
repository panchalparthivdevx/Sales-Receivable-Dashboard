/**
 * The online build (Vercel) runs ESLint and fails on any ESLint error — the office-PC build does not.
 * Lint the Financial Statements page and its tabs here so an error is caught before a push.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const CLIENT = path.join(__dirname, '..', '..', '..', 'client');
const ESLINT = path.join(CLIENT, 'node_modules', 'eslint', 'bin', 'eslint.js');

test('client files have no ESLint errors', { skip: !fs.existsSync(ESLINT) && 'client dependencies not installed', timeout: 180000 }, () => {
  let out = '';
  try {
    out = execFileSync(process.execPath, [ESLINT, '-f', 'json', 'src/pages/FinancialStatements.js', 'src/pages/finstmt/'], { cwd: CLIENT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch (e) { out = e.stdout || ''; }
  const results = JSON.parse(out.slice(out.indexOf('[')));
  const errors = results.flatMap(r => r.messages.filter(m => m.severity === 2).map(m => `${path.basename(r.filePath)}:${m.line} ${m.ruleId} ${m.message}`));
  assert.deepStrictEqual(errors, []);
});
