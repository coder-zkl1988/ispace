import { findUserByUsername, getPlatformPolicy, writeAudit, type Sql } from '@ispace/db';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { newLinkToken } from './link-access.js';

/**
 * HTTP and MCP must apply the same policy and revoke discovery entries atomically.
 *
 * link（知道链接的任何人）是加在邀请之上的：受邀同事保留，另外持私密链接的人
 * 免登录可看。令牌只在 link 档存在——从别的档切进来换一个新的，切走就清掉，
 * 所以「关掉再打开」等于重置链接。
 */
export async function setAppVisibility(sql: Sql, input: {
  user: User; appId: string; visibility: 'private' | 'public' | 'shared' | 'link';
  source: 'console' | 'mcp'; ip?: string; category?: string;
}): Promise<{ visibility: string; revoked: number; linkToken: string | null }> {
  const { user, appId, visibility: vis } = input;
  return sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    const [owned] = await tx<{ name: string; visibility: string; link_token: string | null }[]>`
      SELECT name, visibility, link_token FROM ispace.apps WHERE id = ${appId} AND owner_id = ${user.id} FOR UPDATE`;
    if (!owned) throw new IspaceError(ERROR_CODES.NOT_OWNER, '只能改自己页面的可见范围');
    const policy = await getPlatformPolicy(tx);
    if (vis === 'public' && !policy.allowPublicShare) throw new IspaceError(ERROR_CODES.FORBIDDEN, '平台已关闭「全公司」共享');
    if (vis === 'shared' && !policy.allowPeerShare) throw new IspaceError(ERROR_CODES.FORBIDDEN, '平台已关闭点对点分享');
    let revoked = 0;
    if (vis === 'public') {
      if (input.category) await tx`UPDATE ispace.apps SET category = ${input.category} WHERE id = ${appId}`;
      await tx`INSERT INTO ispace.marketplace_listings (app_id, published_by) VALUES (${appId}, ${user.id})
        ON CONFLICT (app_id) DO UPDATE SET published_at = now()`;
    } else {
      await tx`DELETE FROM ispace.marketplace_listings WHERE app_id = ${appId}`;
      if (vis === 'private') {
        await tx`DELETE FROM ispace.app_installs WHERE app_id = ${appId}`;
        const rows = await tx`UPDATE ispace.shares SET status = 'revoked', responded_at = now()
          WHERE app_id = ${appId} AND status IN ('pending', 'accepted') RETURNING id`;
        revoked = rows.length;
      } else {
        await tx`DELETE FROM ispace.app_installs WHERE app_id = ${appId} AND source = 'marketplace'`;
      }
    }
    const linkToken = vis !== 'link' ? null
      : owned.visibility === 'link' && owned.link_token ? owned.link_token : newLinkToken();
    await tx`UPDATE ispace.apps SET visibility = ${vis}, link_token = ${linkToken}, updated_at = now() WHERE id = ${appId}`;
    await writeAudit(tx, { actorId: user.id, action: 'app.share', targetType: 'app', targetId: appId,
      source: input.source, result: 'success', metadata: { visibility: vis, app: owned.name, revoked }, ip: input.ip });
    return { visibility: vis, revoked, linkToken };
  });
}

/**
 * 当前的私密链接令牌（仅作者本人可取）。不是 link 档时为 null。
 */
export async function getAppLinkToken(sql: Sql, user: User, appId: string): Promise<string | null> {
  const [row] = await sql<{ visibility: string; link_token: string | null }[]>`
    SELECT visibility, link_token FROM ispace.apps WHERE id = ${appId} AND owner_id = ${user.id}`;
  if (!row) throw new IspaceError(ERROR_CODES.NOT_OWNER, '只能查看自己页面的分享链接');
  return row.visibility === 'link' ? row.link_token : null;
}

/** 重置链接：换一个令牌，旧链接与已发出的访问 Cookie 立即失效。 */
export async function resetAppLink(sql: Sql, input: {
  user: User; appId: string; source: 'console' | 'mcp'; ip?: string;
}): Promise<string> {
  const token = newLinkToken();
  const rows = await sql<{ name: string }[]>`
    UPDATE ispace.apps SET link_token = ${token}, updated_at = now()
     WHERE id = ${input.appId} AND owner_id = ${input.user.id} AND visibility = 'link'
    RETURNING name`;
  if (!rows[0]) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '这个页面没有开启「知道链接的任何人」');
  await writeAudit(sql, { actorId: input.user.id, action: 'app.link_reset', targetType: 'app', targetId: input.appId,
    source: input.source, result: 'success', metadata: { app: rows[0].name }, ip: input.ip });
  return token;
}

/** Creating a colleague share narrows private to shared; link and public keep their wider access. Both entry points use this transaction. */
export async function shareAppWith(sql: Sql, input: {
  user: User; appId: string; toUsername: string; source: 'console' | 'mcp'; ip?: string;
}) {
  return sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    const [app] = await tx<{ name: string }[]>`
      SELECT name FROM ispace.apps WHERE id = ${input.appId} AND owner_id = ${input.user.id} FOR UPDATE`;
    if (!app) throw new IspaceError(ERROR_CODES.NOT_OWNER, '只能分享自己空间下的页面');
    const { allowPeerShare } = await getPlatformPolicy(tx);
    if (!allowPeerShare) throw new IspaceError(ERROR_CODES.FORBIDDEN, '平台已关闭点对点分享');
    const to = await findUserByUsername(tx, input.toUsername);
    if (!to || to.status !== 'active') throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到同事 ${input.toUsername}`);
    if (to.id === input.user.id) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '不用分享给自己');
    const [share] = await tx`
      INSERT INTO ispace.shares (app_id, from_user_id, to_user_id, status)
      VALUES (${input.appId}, ${input.user.id}, ${to.id}, 'pending')
      ON CONFLICT (app_id, to_user_id) WHERE status = 'pending'
      DO UPDATE SET created_at = now() RETURNING *`;
    await tx`UPDATE ispace.apps SET visibility = 'shared', updated_at = now()
      WHERE id = ${input.appId} AND visibility = 'private'`;
    await writeAudit(tx, { actorId: input.user.id, action: 'app.share', targetType: 'app', targetId: input.appId,
      source: input.source, result: 'success', metadata: { to: to.username, app: app.name }, ip: input.ip });
    return { share, target: to, appName: app.name };
  });
}
