import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validReturnUrl } from '../src/index.mjs';

test('OAuth return URLs only reach explicitly configured website origins', () => {
  const env = { WEB_ORIGIN: 'https://pcln.top', MANAGE_ORIGIN: 'https://manage.pcln.top' };
  assert.equal(validReturnUrl('/account?section=website', env), 'https://pcln.top/account?section=website');
  assert.equal(validReturnUrl('https://manage.pcln.top/manage/users', env), 'https://manage.pcln.top/manage/users');
  for (const url of ['https://evil.test/manage', '//evil.test', '/\\evil.test', 'https://manage.pcln.top.evil.test', 'https://user@manage.pcln.top/', 'javascript:alert(1)', 'https://manage.pcln.top:8443/', '/\nLocation: evil']) assert.equal(validReturnUrl(url, env), null, url);
  assert.equal(validReturnUrl('https://manage.pcln.top/manage', { WEB_ORIGIN: env.WEB_ORIGIN }), null);
});

test('publisher origins restore sessions without trusting arbitrary subdomains', async () => {
  const env = { WEB_ORIGIN: 'https://pcln.top', MANAGE_ORIGIN: 'https://manage.pcln.top' };
  for (const origin of ['https://dev.consol.pcln.top', 'https://creator.consol.pcln.top']) {
    const r = await worker.fetch(new Request('https://auth.pcln.top/auth/v1/tokens', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-nexa-request' } }), env);
    assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), origin); assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(validReturnUrl(origin + '/publisher/sidecars', env), origin + '/publisher/sidecars');
  }
  for (const origin of ['https://evil.pcln.top', 'https://dev.consol.pcln.top.evil.test', 'http://dev.consol.pcln.top', 'https://dev.consol.pcln.top:444']) {
    const r = await worker.fetch(new Request('https://auth.pcln.top/auth/v1/tokens', { method: 'OPTIONS', headers: { origin } }), env);
    assert.equal(r.status, 403); assert.equal(validReturnUrl(origin, env), null);
  }
});
