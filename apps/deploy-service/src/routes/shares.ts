import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE,
  ERROR_CODES,
  IspaceError,
  createShareRequestSchema,
  respondShareRequestSchema,
  type User,
} from '@ispace/contracts';
import { findUserByUsername, getPlatformPolicy, writeAudit, type Sql } from '@ispace/db';

/**
 * 分享给个人（规格 D10，一期实现）。
 *
 * 设计稿的语义：
 *   - 发起方在自己的应用上点「分享」，输入同事标识
 *   - 接收方的聚合页顶部出现待接受卡
 *   - 接受后成为常驻入口，「用起来和自己的页面一样」；拒绝则卡片消失
 *
 * 注意分享**不复制内容**，只建立引用：对方访问的仍是原作者空间下的 URL。
 * 因此原作者回滚或停用，对方看到的也随之变化——这与设计稿手机端第 13 屏
 * 「她回滚版本，你下次进来也跟着回」的说明一致。
 */
export function registerShareRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; requireAuth: (req: FastifyRequest) => Promise<User> },
): void {
  const { sql, requireAuth } = deps;

  // ── 我收到的待接受分享 ────────────────────────────────────────────
  app.get(`${API_BASE}/shares/pending`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql`
      SELECT s.id, s.app_id, s.status, s.created_at,
             a.id AS a_id, a.owner_id, a.slug, a.name, a.description, a.icon_letter,
             a.type, a.status AS a_status, a.current_release_id, a.group_id,
             a.sort_order, a.visibility, a.size_bytes, a.last_accessed_at,
             a.created_at AS a_created, a.updated_at AS a_updated,
             u.id AS u_id, u.username, u.display_name
        FROM ispace.shares s
        JOIN ispace.apps  a ON a.id = s.app_id
        JOIN ispace.users u ON u.id = s.from_user_id
       WHERE s.to_user_id = ${me.id} AND s.status = 'pending'
       ORDER BY s.created_at DESC
    `;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    return {
      shares: rows.map((r: any) => ({
        id: r.id,
        appId: r.app_id,
        status: r.status,
        createdAt: r.created_at,
        app: {
          id: r.a_id, ownerId: r.owner_id, slug: r.slug, name: r.name,
          description: r.description, iconLetter: r.icon_letter, type: r.type,
          status: r.a_status, currentReleaseId: r.current_release_id,
          groupId: r.group_id, sortOrder: r.sort_order, visibility: r.visibility,
          sizeBytes: Number(r.size_bytes), lastAccessedAt: r.last_accessed_at,
          createdAt: r.a_created, updatedAt: r.a_updated,
        },
        fromUser: { id: r.u_id, username: r.username, displayName: r.display_name },
      })),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  // ── 校验我是否仍可访问某人的空间（移动端串门每次进入都要查）──────
  //
  // 设计稿明确「她随时可以收回分享」。只在首次校验的话，被收回后对方
  // 仍能继续进入——因此这个端点必须每次进入都调，不能缓存结果。
  app.get(`${API_BASE}/shares/check`, async (req, reply) => {
    const me = await requireAuth(req);
    const { owner } = req.query as { owner?: string };
    if (!owner) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '缺少 owner 参数');

    if (owner === me.username) return { ok: true, reason: 'self' };

    const rows = await sql`
      SELECT 1
        FROM ispace.app_installs i
        JOIN ispace.apps a ON a.id = i.app_id
        JOIN ispace.users u ON u.id = a.owner_id
        JOIN ispace.shares s ON s.app_id = a.id AND s.to_user_id = ${me.id}
       WHERE i.user_id = ${me.id} AND u.username = ${owner}
         AND s.status = 'accepted'
       LIMIT 1
    `;
    if (!rows.length) {
      return reply.status(403).send({
        code: ERROR_CODES.FORBIDDEN,
        message: '这个分享已被收回，或你还没有接受它。',
      });
    }
    return { ok: true };
  });

  /**
   * 设置可见范围（设计稿分享弹窗的「谁能打开」三档，切换即生效）。
   *
   * 三档不只是一个标记位，各自都有实际动作：
   *   仅自己   下架市场、收回全部分享——「仅自己」若还留着别人的入口就是谎话
   *   全公司   上架创意市场
   *   指定同事 只改标记，具体给谁由 chip 那排增删
   *
   * 收回分享是不可逆的（对方要重新接受），所以把收回条数返回给前端说清楚，
   * 而不是静默执行。
   */
  app.patch(`${API_BASE}/apps/:appId/visibility`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    const body = (req.body ?? {}) as { visibility?: string };
    const vis = body.visibility;
    if (vis !== 'private' && vis !== 'public' && vis !== 'shared') {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, 'visibility 只能是 private / public / shared');
    }

    const [owned] = await sql<{ name: string }[]>`
      SELECT name FROM ispace.apps WHERE id = ${appId} AND owner_id = ${me.id}
    `;
    if (!owned) throw new IspaceError(ERROR_CODES.NOT_OWNER, '只能改自己页面的可见范围');

    /*
      平台可以关掉某一档共享。挡在服务端而不是只在界面上隐藏——
      隐藏只挡住了点按钮的人，直接调接口的照样能设。
      「仅自己」永远允许：那是收紧，任何策略下都不该被拦住。
    */
    const policy = await getPlatformPolicy(sql);
    if (vis === 'public' && !policy.allowPublicShare) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '平台已关闭「全公司」共享，请改用「指定同事」。');
    }
    if (vis === 'shared' && !policy.allowPeerShare) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '平台已关闭点对点分享。');
    }

    let revoked = 0;
    if (vis === 'private') {
      await sql`DELETE FROM ispace.marketplace_listings WHERE app_id = ${appId}`;
      await sql`DELETE FROM ispace.app_installs WHERE app_id = ${appId}`;
      const rows = await sql<{ id: string }[]>`
        UPDATE ispace.shares SET status = 'revoked', responded_at = now()
         WHERE app_id = ${appId} AND status IN ('pending','accepted')
        RETURNING id
      `;
      revoked = rows.length;
    } else if (vis === 'public') {
      await sql`
        INSERT INTO ispace.marketplace_listings (app_id, published_by)
        VALUES (${appId}, ${me.id})
        ON CONFLICT (app_id) DO UPDATE SET published_at = now()
      `;
    } else {
      // 指定同事：从市场撤下，但保留已有的点对点分享
      await sql`DELETE FROM ispace.marketplace_listings WHERE app_id = ${appId}`;
      await sql`
        DELETE FROM ispace.app_installs WHERE app_id = ${appId} AND source = 'marketplace'
      `;
    }

    await sql`UPDATE ispace.apps SET visibility = ${vis}, updated_at = now() WHERE id = ${appId}`;
    await writeAudit(sql, {
      actorId: me.id, action: 'app.share', targetType: 'app', targetId: appId,
      source: 'console', result: 'success',
      metadata: { visibility: vis, app: owned.name, revoked },
      ip: req.ip,
    });
    return { visibility: vis, revoked };
  });

  /**
   * 某个应用已分享给谁（设计稿分享弹窗里那排人名 chip）。
   *
   * 弹窗打开时要立刻显示现状——没有这个接口，用户每次打开都看到空列表，
   * 于是重复分享给同一个人，然后困惑于"为什么点了没反应"
   * （服务端会按 UNIQUE 拒掉重复分享）。
   */
  app.get(`${API_BASE}/apps/:appId/shares`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };

    const peers = await sql<
      { id: string; username: string; display_name: string; status: string }[]
    >`
      SELECT s.id, u.username, u.display_name, s.status
        FROM ispace.shares s
        JOIN ispace.users u ON u.id = s.to_user_id
        JOIN ispace.apps  a ON a.id = s.app_id
       WHERE s.app_id = ${appId}
         AND a.owner_id = ${me.id}
         AND s.status IN ('pending','accepted')
       ORDER BY s.created_at
    `;
    return {
      peers: peers.map((p) => ({
        shareId: p.id,
        username: p.username,
        displayName: p.display_name,
        status: p.status as 'pending' | 'accepted',
      })),
    };
  });

  /**
   * 按人取消分享。
   *
   * 已有按 shareId 的收回接口，但弹窗那排 chip 手里只有用户名——
   * 让前端先查一遍 id 再调收回，就多了一次可能失败的往返，
   * 而这两步之间列表还可能变。
   */
  app.delete(`${API_BASE}/apps/:appId/shares/:username`, async (req) => {
    const me = await requireAuth(req);
    const { appId, username } = req.params as { appId: string; username: string };

    const rows = await sql<{ id: string; to_user_id: string }[]>`
      UPDATE ispace.shares s
         SET status = 'revoked', responded_at = now()
        FROM ispace.users u, ispace.apps a
       WHERE s.to_user_id = u.id
         AND s.app_id = a.id
         AND u.username = ${username}
         AND s.app_id = ${appId}
         AND a.owner_id = ${me.id}
         AND s.status IN ('pending','accepted')
      RETURNING s.id, s.to_user_id
    `;
    const row = rows[0];
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有找到对这个人的分享');

    // 与按 id 收回一致：连引用一起删，否则对方列表里留着一个点不开的入口
    await sql`
      DELETE FROM ispace.app_installs
       WHERE app_id = ${appId} AND user_id = ${row.to_user_id} AND source = 'share'
    `;
    await writeAudit(sql, {
      actorId: me.id, action: 'app.share_respond', targetType: 'share', targetId: row.id,
      source: 'console', result: 'success', metadata: { revoked: true, username },
      ip: req.ip,
    });
    return { ok: true };
  });

  // ── 收回分享 ──────────────────────────────────────────────────────
  app.post(`${API_BASE}/shares/:id/revoke`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await sql<{ app_id: string; to_user_id: string }[]>`
      UPDATE ispace.shares SET status = 'revoked', responded_at = now()
       WHERE id = ${id} AND from_user_id = ${me.id} AND status IN ('pending','accepted')
      RETURNING app_id, to_user_id
    `;
    const row = rows[0];
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '分享不存在或已收回');
    // 同时移除引用，否则对方列表里还留着一个点不开的入口
    await sql`
      DELETE FROM ispace.app_installs
       WHERE app_id = ${row.app_id} AND user_id = ${row.to_user_id} AND source = 'share'
    `;
    await writeAudit(sql, {
      actorId: me.id, action: 'app.share_respond', targetType: 'share', targetId: id,
      source: 'console', result: 'success', metadata: { revoked: true },
      ip: req.ip,
    });
    return { ok: true };
  });

  // ── 发起分享 ──────────────────────────────────────────────────────
  app.post(`${API_BASE}/shares`, async (req) => {
    const me = await requireAuth(req);
    const input = createShareRequestSchema.parse(req.body);

    const { allowPeerShare } = await getPlatformPolicy(sql);
    if (!allowPeerShare) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '平台已关闭点对点分享。');
    }

    // 只能分享自己的应用。不校验会让任何人把别人的应用推给第三方，
    // 制造出"看起来是 A 分享的"的假象。
    const owned = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM ispace.apps WHERE id = ${input.appId} AND owner_id = ${me.id}
    `;
    const appRow = owned[0];
    if (!appRow) {
      throw new IspaceError(ERROR_CODES.NOT_OWNER, '只能分享自己空间下的页面');
    }

    const to = await findUserByUsername(sql, input.toUsername);
    if (!to || to.status !== 'active') {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到同事 ${input.toUsername}`);
    }
    if (to.id === me.id) {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, '不用分享给自己');
    }

    // shares_one_pending 部分唯一索引保证同一应用对同一人只有一条待处理，
    // 这里用 ON CONFLICT 把重复分享变成幂等而非报错——用户重复点「分享」
    // 是常见操作，不该看到错误。
    const rows = await sql`
      INSERT INTO ispace.shares (app_id, from_user_id, to_user_id, status)
      VALUES (${input.appId}, ${me.id}, ${to.id}, 'pending')
      ON CONFLICT (app_id, to_user_id) WHERE status = 'pending'
      DO UPDATE SET created_at = now()
      RETURNING *
    `;
    await sql`
      UPDATE ispace.apps SET visibility = 'shared'
       WHERE id = ${input.appId} AND visibility = 'private'
    `;
    await writeAudit(sql, {
      actorId: me.id, action: 'app.share', targetType: 'app', targetId: input.appId,
      source: 'console', result: 'success',
      metadata: { to: to.username, app: appRow.name },
      ip: req.ip,
    });
    return { share: rows[0] };
  });

  // ── 接受 / 拒绝 ───────────────────────────────────────────────────
  app.post(`${API_BASE}/shares/:id/respond`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const { accept } = respondShareRequestSchema.parse(req.body ?? {});

    // 只有接收方能回应。用 to_user_id 约束而非仅按 id 查——否则知道 id
    // 的人可以替别人接受。
    const rows = await sql<{ app_id: string }[]>`
      UPDATE ispace.shares
         SET status = ${accept ? 'accepted' : 'rejected'}, responded_at = now()
       WHERE id = ${id} AND to_user_id = ${me.id} AND status = 'pending'
      RETURNING app_id
    `;
    const row = rows[0];
    if (!row) {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, '这条分享不存在或已处理过');
    }

    if (accept) {
      // 建立引用而非复制内容：对方访问的仍是原作者空间下的 URL，
      // 原作者回滚或停用，接收方看到的也随之变化
      await sql`
        INSERT INTO ispace.app_installs (app_id, user_id, source)
        VALUES (${row.app_id}, ${me.id}, 'share')
        ON CONFLICT (app_id, user_id) DO NOTHING
      `;
    }

    await writeAudit(sql, {
      actorId: me.id, action: 'app.share_respond', targetType: 'share', targetId: id,
      source: 'console', result: 'success', metadata: { accept },
      ip: req.ip,
    });
    return { ok: true, accepted: accept };
  });
}
