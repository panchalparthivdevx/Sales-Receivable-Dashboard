'use strict';

// The chart of accounts: Zoho's paging quirk (pages overlap unless sorted by name), more than 2,000 accounts, and
// the cut-short list cached by older versions being dropped.

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const ZC = require('../lib/zohoClient');
const LK = require('../lib/lookups');

const ORDER = ['other_current_asset', 'other_current_liability', 'other_liability', 'income', 'expense'];

/** A Zoho stand-in for /chartofaccounts like DevX's: 2,560 active accounts, expenses last in the default order, whose
 *  default-order pages overlap (each page after the first repeats 40 rows of the one before) */
function fakeChart(n = 2560) {
  const rows = Array.from({ length: n }, (_, i) => {
    const type = ORDER[Math.min(ORDER.length - 1, Math.floor(i / (n / ORDER.length)))];
    return { account_id: `a${i}`, account_name: `${type === 'expense' ? 'Exp' : 'Acc'} ${String((i * 7919) % n).padStart(4, '0')}`, account_type: type, account_code: '' };
  });
  const queries = [];
  return {
    queries,
    async zohoGet(path, params) {
      assert.equal(path, '/chartofaccounts');
      queries.push(params);
      const per = params.per_page, p = params.page;
      if (params.sort_column === 'account_name') {
        const sorted = [...rows].sort((a, b) => a.account_name.localeCompare(b.account_name));
        return { chartofaccounts: sorted.slice((p - 1) * per, p * per), page_context: { has_more_page: p * per < n } };
      }
      const start = Math.max(0, (p - 1) * (per - 40));
      return { chartofaccounts: rows.slice(start, start + per), page_context: { has_more_page: start + per < n } };
    },
  };
}

test('chart of accounts: every active account, read by name so the pages do not overlap, past 2,000', async () => {
  const z = fakeChart();
  const list = await ZC.create({ zoho: z }).chartOfAccounts('60027116474');
  assert.equal(list.length, 2560);
  assert.equal(new Set(list.map(a => a.id)).size, 2560, 'no account twice');
  assert.equal(list.filter(a => a.type === 'expense').length, 512, 'the expense accounts at the end are there');
  assert.ok(z.queries.every(q => q.sort_column === 'account_name' && q.filter_by === 'AccountType.Active' && q.organization_id === '60027116474'));
  assert.equal(z.queries.length, 13);
});

test('chart of accounts: the cut-short list cached by older versions is dropped and read again in full', async () => {
  H.tempDirs();
  const z = fakeChart();
  const zc = ZC.create({ zoho: z });
  const store = require('../lib/store');
  const lk = LK.create({ store, zc, readSynced: async () => null });
  const doc = await store.zohoCache('60027116474');
  doc.accounts = { at: new Date().toISOString(), data: [{ id: 'old', name: 'Old', type: 'expense' }] };   // fresh, but cut short
  await store.saveZohoCache('60027116474');
  const list = await lk.accounts('60027116474');
  assert.equal(list.length, 2560);
  const saved = await store.zohoCache('60027116474');
  assert.equal(saved.accounts, undefined);
  assert.equal(saved.coa_full.data.length, 2560);
  const calls = z.queries.length;
  await lk.accounts('60027116474');
  assert.equal(z.queries.length, calls, 'then kept for 12 hours');
});
