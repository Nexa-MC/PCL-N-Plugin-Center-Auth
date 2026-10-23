import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchAfdianDonationCents } from '../src/afdian-donations.mjs';

const env = { AFDIAN_USER_ID: 'creator', AFDIAN_API_TOKEN: 'private-api-token' };
const order = (id, amount, extra = {}) => ({ out_trade_no: id, user_id: 'linked', product_type: 0, status: 2, show_amount: amount, ...extra });
const payload = (list, total_page = 1) => Response.json({ ec: 200, data: { list, total_page } });

test('signed paginated orders count only completed sponsorships by the bound account, once per order', async () => {
  const pages = [
    [order('first', '600.00'), order('shop', '99999', { product_type: 1 }), order('other', '99999', { user_id: 'other' }), order('pending', '99999', { status: 1 })],
    [order('first', '600.00'), order('second', '400.01', { product_type: '0', status: '2' }), order('refunded', '99999', { status: 3 }), order('unknown-type', '99999', { product_type: null })]
  ];
  let calls = 0;
  const total = await fetchAfdianDonationCents(env, 'linked', async (url, init) => {
    assert.equal(url, 'https://ifdian.net/api/open/query-order');
    assert.equal(init.redirect, 'manual');
    const request = JSON.parse(init.body), params = JSON.parse(request.params);
    assert.equal(request.user_id, 'creator'); assert.equal(params.user_id, 'linked');
    assert.equal(params.page, ++calls); assert.equal(request.ts, 1000);
    assert.equal(request.sign, createHash('md5').update(`private-api-tokenparams${request.params}ts1000user_idcreator`).digest('hex'));
    assert.ok(!init.body.includes('private-api-token'));
    return payload(pages[params.page - 1], 2);
  }, 1000000);
  assert.equal(total, 100001); assert.equal(calls, 2);
});

test('empty order histories synchronize to zero', async () => {
  assert.equal(await fetchAfdianDonationCents(env, 'linked', async () => payload([], 0)), 0);
});

test('malformed amounts, contradictory duplicates and incomplete histories cannot become verified totals', async () => {
  for (const amount of ['100.001', '-1', '', null, '90071992547409910']) {
    await assert.rejects(fetchAfdianDonationCents(env, 'linked', async () => payload([order('bad', amount)])), /暂时无法同步/);
  }
  for (const response of [
    () => payload([order('duplicate', '1'), order('duplicate', '2')]),
    () => payload([], 2),
    () => payload([order('first', '1001')], 101),
    () => Response.json({ ec: 400, em: 'upstream private error' }),
    () => Response.json({ ec: 200, data: { total_page: 1 } }),
    () => new Response('not JSON'),
    () => new Response('private upstream error', { status: 503 })
  ]) await assert.rejects(fetchAfdianDonationCents(env, 'linked', async () => response()), /暂时无法同步/);
  let calls = 0;
  await assert.rejects(fetchAfdianDonationCents(env, 'linked', async () => {
    if (++calls === 1) return payload([order('first', '1001')], 2);
    throw new Error('private network details');
  }), /暂时无法同步/);
});
