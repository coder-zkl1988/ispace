import type { Sql } from '@ispace/db';

/**
 * 「这个人能不能看 /{owner}/{slug}/」——全平台唯一的一份判定。
 *
 * 两处在用：
 *   routes/authz.ts  Caddy forward_auth 的落点（真人直接访问页面）
 *   routes/play.ts   详情页与为你推荐里那个 iframe 换令牌的时候
 *
 * ┌─ 为什么非抽出来不可 ────────────────────────────────────────────────┐
 * │ 这是访问控制。两份实现意味着迟早有一份落后——而落后的那一份不会报错，│
 * │ 它只是**多放进来一些人**，并且没有任何迹象。                        │
 * │ 新增一档可见性、改一次 status 语义，都只该改这一个函数。            │
 * └──────────────────────────────────────────────────────────────────────┘
 */

export type AppAccess =
  | { kind: 'ok'; appId: string; ownerId: string }
  /** 没登录。页面那条路会跳登录页，换令牌那条路回 401。 */
  | { kind: 'login' }
  /** 登录了，但这个页面没共享给他。 */
  | { kind: 'forbidden'; reason?: 'network' }
  /** 不存在、已停用、或者作者已归档。 */
  | { kind: 'notfound' };

interface Row {
  app_id: string;
  owner_id: string;
  visibility: string;
  status: string;
}

export async function resolveAppAccess(
  sql: Sql,
  owner: string,
  slug: string,
  claims: { uid: string; role: string } | null,
  intranet = false,
): Promise<AppAccess> {
  const [row] = await sql<Row[]>`
    SELECT a.id AS app_id, a.owner_id, a.visibility, a.status
      FROM ispace.apps a
      JOIN ispace.users u ON u.id = a.owner_id
     WHERE u.username = ${owner} AND a.slug = ${slug}
       AND u.status = 'active'
  `;

  /*
    库里没有这个页面：可能是刚被回收、也可能是有人在猜路径。
    一律 notfound，不区分——区分了就等于告诉对方"这个路径是存在的"。
  */
  if (!row || row.status === 'stopped') return { kind: 'notfound' };

  // Link access is never a login bypass for private/shared/public resources.
  if (row.visibility === 'link') return intranet
    ? { kind: 'ok', appId: row.app_id, ownerId: row.owner_id }
    : { kind: 'forbidden', reason: 'network' };

  if (!claims) return { kind: 'login' };

  // 本人 / 管理员
  if (claims.uid === row.owner_id || claims.role === 'admin') {
    return { kind: 'ok', appId: row.app_id, ownerId: row.owner_id };
  }

  /*
    全公司可见：任何登录用户都能看。
    仍要求登录——平台是内网的，但"登录过"至少让访问可追溯到人。
  */
  if (row.visibility === 'public') {
    return { kind: 'ok', appId: row.app_id, ownerId: row.owner_id };
  }

  // 指定同事：得有一条已接受的分享
  if (row.visibility === 'shared') {
    const [share] = await sql`
      SELECT 1 FROM ispace.shares
       WHERE app_id = ${row.app_id} AND to_user_id = ${claims.uid} AND status = 'accepted'
       LIMIT 1
    `;
    if (share) return { kind: 'ok', appId: row.app_id, ownerId: row.owner_id };
  }

  return { kind: 'forbidden' };
}
