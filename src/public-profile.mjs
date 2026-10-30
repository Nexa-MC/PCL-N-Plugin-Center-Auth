import { loadProgression } from './progression.mjs';

// Same verified GitHub subject used by the existing owner-maintenance workflow.
// A mutable display name or handle cannot confer the site-owner label.
const SITE_OWNER_GITHUB_SUBJECT = '196047672';
export async function publicAccountProfile(env, user) {
  const [progression, owner] = await Promise.all([
    loadProgression(env, { id: user.userId, staff: user.staff }),
    env.DB.prepare("SELECT 1 AS found FROM oauth_identities WHERE user_id=? AND provider='github' AND subject=?")
      .bind(user.userId, SITE_OWNER_GITHUB_SUBJECT).first()
  ]);
  return {
    accountId: user.userId,
    level: progression.level,
    display: progression.display,
    badges: progression.badges.filter(b => b.earned).map(({ id, name, replacesLevel }) => ({ id, name, replacesLevel })),
    roles: { admin: Boolean(user.staff), developer: Boolean(user.developer), trustedDeveloper: Boolean(user.trustedDeveloper), creator: Boolean(user.creator), siteOwner: Boolean(owner) }
  };
}
