// Only the default-off source is new. Reuse the existing SERVICE_TOKEN gate;
// never accept staff cookies or forward any console credential into a cron job.
export async function readStoreAccountSource(request, env, { fail, json }) {
  if (request.method !== 'GET') fail(405, '账户事件来源仅支持读取');
  const url = new URL(request.url), snapshot = url.pathname.endsWith('/snapshot');
  const allowed = snapshot ? ['after', 'limit'] : ['after', 'through', 'limit'];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key))) fail(400, '账户同步参数无效');
  const limit = Number(url.searchParams.get('limit') ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, '账户同步分页无效');
  const after = snapshot ? url.searchParams.get('after') || '' : Number(url.searchParams.get('after') ?? 0);
  const through = snapshot || !url.searchParams.has('through') ? null : Number(url.searchParams.get('through'));
  if (snapshot ? after.length > 200 : !Number.isSafeInteger(after) || after < 0 || (through !== null && (!Number.isSafeInteger(through) || through < after))) fail(400, '账户同步游标无效');
  const consent = "(SELECT id FROM account_deletion_requests r WHERE r.user_id=c.user_id AND r.state='finalized' AND r.publisher_forfeit_consent IS NOT NULL ORDER BY r.finalized_at DESC LIMIT 1) AS consent_request_id";
  const rows = snapshot
    ? env.DB.prepare('SELECT c.user_id,c.sequence,c.state,c.occurred_at,'+consent+' FROM account_lifecycle_current c WHERE c.user_id>? ORDER BY c.user_id LIMIT ?').bind(after,limit)
    : env.DB.prepare('SELECT c.user_id,c.sequence,c.state,c.occurred_at,'+consent+' FROM account_lifecycle_outbox c WHERE c.sequence>? AND c.sequence<=COALESCE(?,(SELECT COALESCE(max(sequence),0) FROM account_lifecycle_outbox)) ORDER BY c.sequence LIMIT ?').bind(after,through,limit);
  // Batch is one D1 transaction: head, consistency check and page share a snapshot.
  const [source, high, inconsistent, page] = await env.DB.batch([
    env.DB.prepare('SELECT epoch FROM account_lifecycle_source WHERE id=1'),
    env.DB.prepare('SELECT COALESCE(max(sequence),0) AS head FROM account_lifecycle_outbox'),
    env.DB.prepare(`SELECT 1 AS bad WHERE EXISTS(SELECT 1 FROM users u LEFT JOIN account_lifecycle_current c ON c.user_id=u.id
      WHERE u.id!='system:ghost' AND c.user_id IS NULL) OR EXISTS(SELECT 1 FROM account_lifecycle_current c LEFT JOIN users u ON u.id=c.user_id
      LEFT JOIN deletion_tombstones t ON t.subject_id=c.user_id WHERE c.state!=CASE WHEN t.subject_id IS NOT NULL OR u.id IS NULL THEN 'deleted' WHEN u.disabled=1 THEN 'disabled' ELSE 'active' END)`),
    rows
  ]);
  if (source.results.length !== 1 || inconsistent.results.length) fail(503, '账户事件来源需要对账修复');
  const head = high.results[0].head;
  if (!snapshot && (after > head || (through !== null && through > head))) fail(409, '账户事件游标与来源不匹配');
  const events = page.results.map(row => ({ userId: row.user_id, sequence: row.sequence, state: row.state, occurredAt: row.occurred_at, ...(row.state==='deleted' && row.consent_request_id ? { publisherForfeitConsent: { requestId: row.consent_request_id, policyVersion: 1 } } : {}) }));
  const common = { version: 1, epoch: source.results[0].epoch, head, events };
  if (snapshot) return json(env, { ...common, done: events.length < limit, nextAfter: events.at(-1)?.userId ?? after });
  const boundary = through ?? head, coveredThrough = events.length === limit ? events.at(-1).sequence : boundary;
  return json(env, { ...common, through: boundary, coveredThrough, done: coveredThrough === boundary });
}
