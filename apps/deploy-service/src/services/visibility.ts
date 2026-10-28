import { findUserByUsername, getPlatformPolicy, writeAudit, type Sql } from '@ispace/db';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { createIntranetPolicy } from './intranet.js';

export function requireLinkConfiguration(): void {
  if (!process.env.ISPACE_INTRANET_CIDRS?.trim()) {
    throw new IspaceError(ERROR_CODES.FORBIDDEN, '管理员尚未配置公司网络白名单，暂不能开启免登录链接访问');
  }
  createIntranetPolicy(process.env.ISPACE_INTRANET_CIDRS, process.env.ISPACE_TRUSTED_PROXY_CIDRS);
}

/** HTTP and MCP must apply the same policy and revoke discovery entries atomically. */
export async function setAppVisibility(sql: Sql, input: {
  user: User; appId: string; visibility: 'private' | 'public' | 'shared' | 'link';
  source: 'console' | 'mcp'; ip?: string; category?: string;
}): Promise<{ visibility: string; revoked: number }> {
  const { user, appId, visibility: vis } = input;
  if (vis === 'link') requireLinkConfiguration();
  return sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    const [owned] = await tx<{ name: string }[]>`SELECT name FROM ispace.apps WHERE id = ${appId} AND owner_id = ${user.id} FOR UPDATE`;
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
      if (vis === 'private' || vis === 'link') {
        await tx`DELETE FROM ispace.app_installs WHERE app_id = ${appId}`;
        const rows = await tx`UPDATE ispace.shares SET status = 'revoked', responded_at = now()
          WHERE app_id = ${appId} AND status IN ('pending', 'accepted') RETURNING id`;
        revoked = rows.length;
      } else {
        await tx`DELETE FROM ispace.app_installs WHERE app_id = ${appId} AND source = 'marketplace'`;
      }
    }
    await tx`UPDATE ispace.apps SET visibility = ${vis}, updated_at = now() WHERE id = ${appId}`;
    await writeAudit(tx, { actorId: user.id, action: 'app.share', targetType: 'app', targetId: appId,
      source: input.source, result: 'success', metadata: { visibility: vis, app: owned.name, revoked }, ip: input.ip });
    return { visibility: vis, revoked };
  });
}

/** Creating a colleague share also closes anonymous link access. Both entry points use this transaction. */
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
      WHERE id = ${input.appId} AND visibility IN ('private', 'link')`;
    await writeAudit(tx, { actorId: input.user.id, action: 'app.share', targetType: 'app', targetId: input.appId,
      source: input.source, result: 'success', metadata: { to: to.username, app: app.name }, ip: input.ip });
    return { share, target: to, appName: app.name };
  });
}
