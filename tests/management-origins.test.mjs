import test from 'node:test';
import assert from 'node:assert/strict';
import { validReturnUrl } from '../src/index.mjs';

test('OAuth return URLs only reach explicitly configured website origins', () => {
  const env = { WEB_ORIGIN: 'https://pcln.top', MANAGE_ORIGIN: 'https://manage.pcln.top' };
  assert.equal(validReturnUrl('/account?section=website', env), 'https://pcln.top/account?section=website');
  assert.equal(validReturnUrl('https://manage.pcln.top/manage/users', env), 'https://manage.pcln.top/manage/users');
  for (const url of ['https://evil.test/manage', '//evil.test', '/\\evil.test', 'https://manage.pcln.top.evil.test', 'https://user@manage.pcln.top/', 'javascript:alert(1)', 'https://manage.pcln.top:8443/', '/\nLocation: evil']) assert.equal(validReturnUrl(url, env), null, url);
  assert.equal(validReturnUrl('https://manage.pcln.top/manage', { WEB_ORIGIN: env.WEB_ORIGIN }), null);
});
