/**
 * The module's screens must pass the code checker that the ONLINE build runs.
 *
 * On the office PC the checker is switched off for builds (client/.env: DISABLE_ESLINT_PLUGIN — that file is not in git); on Vercel
 * it is not. On 13 Nov 2026 a comment the checker rejects — "// eslint-disable-line" followed by a remark, which it reads as the
 * name of a rule — built fine here and failed the deployment. An error from the checker fails the online build; a warning does not.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLIENT = path.join(__dirname, '..', '..', '..', 'client');
const ESLINT = path.join(CLIENT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const installed = fs.existsSync(ESLINT);

test('the module\'s screens pass the code checker of the online build (an error there fails the deployment)', { skip: !installed && 'the client\'s packages are not installed here' }, () => {
  const r = spawnSync(process.execPath, [ESLINT, 'src/pages/Gstr2bReco.js', 'src/pages/gstr2b', '--format', 'json'], { cwd: CLIENT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const start = r.stdout.indexOf('[');
  assert.ok(start >= 0, `the checker did not answer: ${(r.stderr || r.stdout).slice(0, 300)}`);
  const files = JSON.parse(r.stdout.slice(start));
  const errors = files.flatMap(f => f.messages.filter(m => m.severity === 2).map(m => `${path.basename(f.filePath)}:${m.line} ${m.message}`));
  assert.deepEqual(errors, [], 'errors the online build would stop on');
  assert.ok(files.length >= 8, `every screen of the module was checked (${files.length} files)`);
});
