import { createHash } from 'node:crypto';

const REFRESH_MS = 15 * 60 * 1000;
class AfdianUnavailable extends Error {}
const unavailable = () => { throw new AfdianUnavailable('爱发电订单暂时无法同步'); };
export const afdianDonationsConfigured = env => Boolean(env.AFDIAN_USER_ID?.trim() && env.AFDIAN_API_TOKEN?.trim());

function amountCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? ''));
  if (!match) unavailable();
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) unavailable();
  return cents;
}

// Query orders, rather than a sponsor's all_sum_amount, so shop purchases cannot
// contribute to this badge. Always check ownership even if upstream filters it.
export async function fetchAfdianDonationCents(env, subject, fetcher = fetch, now = Date.now()) {
  if (!afdianDonationsConfigured(env)) unavailable();
  const creator = env.AFDIAN_USER_ID.trim(), token = env.AFDIAN_API_TOKEN.trim();
  const orders = new Map(), signal = AbortSignal.timeout(10000);
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const params = JSON.stringify({ page, user_id: subject });
    const ts = Math.floor(now / 1000);
    const sign = createHash('md5').update(`${token}params${params}ts${ts}user_id${creator}`).digest('hex');
    let payload;
    try {
      const response = await fetcher('https://ifdian.net/api/open/query-order', {
        method: 'POST', redirect: 'manual', signal,
        headers: { 'content-type': 'application/json', 'user-agent': 'Nexa-Donation-Badge/1.0' },
        body: JSON.stringify({ user_id: creator, params, ts, sign })
      });
      if (!response.ok) unavailable();
      payload = await response.json();
    } catch { unavailable(); }
    const data = payload?.data;
    if (payload?.ec !== 200 || !Array.isArray(data?.list)) unavailable();
    const totalPages = Number(data.total_page);
    // Never commit a partial history if upstream fails or exceeds the request budget.
    if (!Number.isSafeInteger(totalPages) || totalPages < 0 || totalPages > 100 || (totalPages === 0 && data.list.length)) unavailable();
    pages = Math.max(pages, totalPages);
    if (page < pages && !data.list.length) unavailable();
    for (const order of data.list) {
      if (order?.user_id !== subject) continue;
      if (![0, '0'].includes(order.product_type) || ![2, '2'].includes(order.status)) continue;
      if (typeof order.out_trade_no !== 'string' || !order.out_trade_no.trim()) unavailable();
      const cents = amountCents(order.show_amount);
      const previous = orders.get(order.out_trade_no);
      if (previous !== undefined && previous !== cents) unavailable();
      orders.set(order.out_trade_no, cents);
    }
  }
  let total = 0;
  for (const cents of orders.values()) {
    total += cents;
    if (!Number.isSafeInteger(total)) unavailable();
  }
  return total;
}

export async function syncAfdianDonations(env, userId, fetcher = fetch, now = Date.now()) {
  if (!afdianDonationsConfigured(env)) return;
  const row = await env.DB.prepare("SELECT subject,connected_at,donation_attempted_at FROM external_connections WHERE user_id=? AND provider='afdian'").bind(userId).first();
  if (!row || (row.donation_attempted_at !== null && now - row.donation_attempted_at < REFRESH_MS)) return;
  // A conditional claim also prevents concurrent refreshes and throttles retries.
  const claimed = await env.DB.prepare(`UPDATE external_connections SET donation_attempted_at=?
    WHERE user_id=? AND provider='afdian' AND subject=? AND connected_at=? AND donation_attempted_at IS ?`)
    .bind(now, userId, row.subject, row.connected_at, row.donation_attempted_at).run();
  if (!claimed.meta.changes) return;
  let total;
  try { total = await fetchAfdianDonationCents(env, row.subject, fetcher, now); }
  catch (error) {
    if (!(error instanceof AfdianUnavailable)) throw error;
    await env.DB.prepare(`UPDATE external_connections SET donation_error=1
      WHERE user_id=? AND provider='afdian' AND subject=? AND connected_at=? AND donation_attempted_at=?`)
      .bind(userId, row.subject, row.connected_at, now).run();
    return;
  }
  // A request in flight cannot restore a removed binding or credit a new account.
  await env.DB.prepare(`UPDATE external_connections SET donation_cents=?,donation_checked_at=?,donation_error=0
    WHERE user_id=? AND provider='afdian' AND subject=? AND connected_at=? AND donation_attempted_at=?`)
    .bind(total, new Date(now).toISOString(), userId, row.subject, row.connected_at, now).run();
}
