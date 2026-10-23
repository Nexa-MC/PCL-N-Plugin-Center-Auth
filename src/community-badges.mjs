import { bilibiliBindingConfigured, trustedProfile } from './bilibili-binding.mjs';

export const NEXACL_REPOSITORY = 'Nexa-MC/NexaCL';
const BILIBILI_REFRESH_MS = 15 * 60000;
const GITHUB_REFRESH_MS = 60 * 60000;
const RETRY_MS = 15 * 60000;

// Refresh public facts only. Ownership remains the result of the signature challenge.
export async function syncBilibiliBadgeProfile(env, userId, now = Date.now()) {
  if (!bilibiliBindingConfigured(env)) return;
  const row = await env.DB.prepare("SELECT subject,connected_at,ownership_verified_at,profile_attempted_at FROM external_connections WHERE user_id=? AND provider='bilibili'").bind(userId).first();
  if (!row?.ownership_verified_at || row.profile_attempted_at !== null && now - row.profile_attempted_at < BILIBILI_REFRESH_MS) return;
  const state = await env.DB.prepare('SELECT blocked_until FROM bilibili_provider_state WHERE id=1').first();
  if ((state?.blocked_until ?? 0) > now) return;
  const claimed = await env.DB.prepare(`UPDATE external_connections SET profile_attempted_at=?
    WHERE user_id=? AND provider='bilibili' AND subject=? AND connected_at=? AND ownership_verified_at=? AND profile_attempted_at IS ?`)
    .bind(now, userId, row.subject, row.connected_at, row.ownership_verified_at, row.profile_attempted_at).run();
  if (!claimed.meta.changes) return;
  const guard = [userId, row.subject, row.connected_at, row.ownership_verified_at, now];
  let profile;
  try {
    // Share the binding/preview service budget; a user cannot bypass it by refreshing badges.
    const quota = await env.DB.prepare(`INSERT INTO rate_limits(key,count,expires) VALUES('bilibili-verify-global',1,?)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
      expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING count`).bind(now + 60000, now, now).first();
    if (quota.count > 30) throw Object.assign(new Error('busy'), { status: 429 });
    profile = await trustedProfile(env, row.subject);
  } catch (error) {
    if (!error.status) throw error;
    await env.DB.prepare(`UPDATE external_connections SET profile_error=1
      WHERE user_id=? AND provider='bilibili' AND subject=? AND connected_at=? AND ownership_verified_at=? AND profile_attempted_at=?`).bind(...guard).run();
    return;
  }
  // An in-flight result cannot recreate an unlinked account or overwrite a new binding.
  await env.DB.prepare(`UPDATE external_connections SET display_name=?,avatar_url=?,profile_level=?,followers=?,checked_at=?,profile_source=?,profile_error=0
    WHERE user_id=? AND provider='bilibili' AND subject=? AND connected_at=? AND ownership_verified_at=? AND profile_attempted_at=?`)
    .bind(profile.name, profile.avatar, profile.level, profile.followers, profile.checkedAt, profile.source, ...guard).run();
}

export class GithubContributorsUnavailable extends Error {}
const unavailable = () => { throw new GithubContributorsUnavailable('GitHub贡献记录暂时无法同步'); };

// Match GitHub's stable numeric user ID, never a supplied username, email or commit author string.
export async function fetchNexaContributors(fetcher = fetch) {
  const contributors = new Map(), signal = AbortSignal.timeout(10000);
  for (let page = 1; page <= 10; page++) {
    let data;
    try {
      const response = await fetcher(`https://api.github.com/repos/${NEXACL_REPOSITORY}/contributors?anon=false&per_page=100&page=${page}`, {
        redirect: 'manual', signal, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Nexa-Community-Badges/1.0' }
      });
      if (!response.ok) unavailable();
      const raw = await response.text();
      if (raw.length > 1048576) unavailable();
      data = JSON.parse(raw);
    } catch { unavailable(); }
    if (!Array.isArray(data) || data.length > 100) unavailable();
    for (const person of data) {
      if (!person || !['User', 'Bot'].includes(person.type) || !Number.isSafeInteger(person.id) || person.id <= 0 || !Number.isSafeInteger(person.contributions) || person.contributions < 1) unavailable();
      if (person.type === 'User') contributors.set(String(person.id), person.contributions);
    }
    if (data.length < 100) return [...contributors].map(([id, contributions]) => ({ id, contributions }));
  }
  // Never replace a known snapshot with a truncated contributor list.
  unavailable();
}

export async function syncNexaContributors(env, userId, fetcher = fetch, now = Date.now()) {
  const identity = await env.DB.prepare("SELECT subject FROM oauth_identities WHERE user_id=? AND provider='github'").bind(userId).first();
  if (!identity) return;
  await env.DB.prepare('INSERT OR IGNORE INTO github_contributor_snapshots(repository) VALUES(?)').bind(NEXACL_REPOSITORY).run();
  const row = await env.DB.prepare('SELECT attempted_at,error FROM github_contributor_snapshots WHERE repository=?').bind(NEXACL_REPOSITORY).first();
  if (row.attempted_at !== null && now - row.attempted_at < (row.error ? RETRY_MS : GITHUB_REFRESH_MS)) return;
  const claimed = await env.DB.prepare('UPDATE github_contributor_snapshots SET attempted_at=? WHERE repository=? AND attempted_at IS ?').bind(now, NEXACL_REPOSITORY, row.attempted_at).run();
  if (!claimed.meta.changes) return;
  let contributors;
  try { contributors = await fetchNexaContributors(fetcher); }
  catch (error) {
    if (!(error instanceof GithubContributorsUnavailable)) throw error;
    await env.DB.prepare('UPDATE github_contributor_snapshots SET error=1 WHERE repository=? AND attempted_at=?').bind(NEXACL_REPOSITORY, now).run();
    return;
  }
  await env.DB.prepare('UPDATE github_contributor_snapshots SET contributors_json=?,checked_at=?,error=0 WHERE repository=? AND attempted_at=?')
    .bind(JSON.stringify(contributors), new Date(now).toISOString(), NEXACL_REPOSITORY, now).run();
}
