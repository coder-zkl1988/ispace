import type { Sql } from '@ispace/db';
import { linkTokenMatches } from './link-access.js';

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
  /** via = 'link'：凭私密链接放进来的（authz 据此下发访问 Cookie）。 */
  | { kind: 'ok'; appId: string; ownerId: string; via?: 'link' }
  /** 没登录。页面那条路会跳登录页，换令牌那条路回 401。 */
  | { kind: 'login' }
  /**
   * 登录了但没共享给他；或者出示了私密链接但不算数：
   *   network  令牌对，但管理员要求公司网络，而请求不在公司网络内
   *   link     令牌不对（链接被重置过，或者根本不是这个页面的）
   */
  | { kind: 'forbidden'; reason?: 'network' | 'link' }
  /** 不存在、已停用、或者作者已归档。 */
  | { kind: 'notfound' };

interface Row {
  app_id: string;
  owner_id: string;
  visibility: string;
  status: string;
  link_token: string | null;
}

/** 访客出示的私密链接凭据（?lk= 或访问 Cookie），以及这次请求的网络条件。 */
export interface LinkPresented {
  token: string | null | undefined;
  network: boolean;
}

export async function resolveAppAccess(
  sql: Sql,
  owner: string,
  slug: string,
  claims: { uid: string; role: string } | null,
  link?: LinkPresented,
): Promise<AppAccess> {
  const [row] = await sql<Row[]>`
    SELECT a.id AS app_id, a.owner_id, a.visibility, a.status, a.link_token
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

  /*
    私密链接只对 link 档生效：private/shared/public 的页面带着一个令牌来，
    照样走登录那套——令牌不是通用的免登录票。
    令牌不对时不立刻拒绝，往下走：作者本人、管理员、受邀同事登录后照常能看。
  */
  let badLink = false;
  if (row.visibility === 'link' && link?.token) {
    if (linkTokenMatches(row.link_token, link.token)) {
      return link.network
        ? { kind: 'ok', appId: row.app_id, ownerId: row.owner_id, via: 'link' }
        : { kind: 'forbidden', reason: 'network' };
    }
    badLink = true;
  }

  if (!claims) return badLink ? { kind: 'forbidden', reason: 'link' } : { kind: 'login' };

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

  // 指定同事：得有一条已接受的分享。link 档同样认受邀同事——链接是加在邀请之上的
  if (row.visibility === 'shared' || row.visibility === 'link') {
    const [share] = await sql`
      SELECT 1 FROM ispace.shares
       WHERE app_id = ${row.app_id} AND to_user_id = ${claims.uid} AND status = 'accepted'
       LIMIT 1
    `;
    if (share) return { kind: 'ok', appId: row.app_id, ownerId: row.owner_id };
  }

  return { kind: 'forbidden' };
}
