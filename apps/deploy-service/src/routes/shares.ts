import { setAppVisibility, shareAppWith } from '../services/visibility.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE,
  ERROR_CODES,
  IspaceError,
  avatarUrlFor,
  createShareRequestSchema,
  respondShareRequestSchema,
  type User,
} from '@ispace/contracts';
import { writeAudit, type Sql } from '@ispace/db';

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
             a.id AS a_id, a.owner_id, a.slug, a.name, a.description, a.icon_letter, a.cover_path,
             a.type, a.status AS a_status, a.current_release_id, a.group_id,
             a.sort_order, a.visibility, a.size_bytes, a.last_accessed_at,
             a.created_at AS a_created, a.updated_at AS a_updated,
             u.id AS u_id, u.username, u.display_name, av.etag AS u_avatar
        FROM ispace.shares s
        JOIN ispace.apps  a ON a.id = s.app_id
        JOIN ispace.users u ON u.id = s.from_user_id
        LEFT JOIN ispace.user_avatars av ON av.user_id = u.id
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
          description: r.description, iconLetter: r.icon_letter,
          coverUrl: r.cover_path ?? null, type: r.type,
          status: r.a_status, currentReleaseId: r.current_release_id,
          groupId: r.group_id, sortOrder: r.sort_order, visibility: r.visibility,
          sizeBytes: Number(r.size_bytes), lastAccessedAt: r.last_accessed_at,
          createdAt: r.a_created, updatedAt: r.a_updated,
        },
        fromUser: {
          id: r.u_id, username: r.username, displayName: r.display_name,
          avatarUrl: avatarUrlFor(r.username, r.u_avatar),
        },
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
    if (vis !== 'private' && vis !== 'public' && vis !== 'shared' && vis !== 'link') {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, 'visibility 只能是 private / public / shared / link');
    }

    return setAppVisibility(sql, { user: me, appId, visibility: vis, source: 'console', ip: req.ip });
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
      { id: string; username: string; display_name: string; status: string; avatar: string | null }[]
    >`
      SELECT s.id, u.username, u.display_name, s.status, av.etag AS avatar
        FROM ispace.shares s
        JOIN ispace.users u ON u.id = s.to_user_id
        JOIN ispace.apps  a ON a.id = s.app_id
        LEFT JOIN ispace.user_avatars av ON av.user_id = u.id
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
        avatarUrl: avatarUrlFor(p.username, p.avatar),
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

    const { share } = await shareAppWith(sql, { user: me, appId: input.appId,
      toUsername: input.toUsername, source: 'console', ip: req.ip });
    return { share };
  });

  // ── 接受 / 拒绝 ───────────────────────────────────────────────────
  app.post(`${API_BASE}/shares/:id/respond`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const { accept } = respondShareRequestSchema.parse(req.body ?? {});

    await sql.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      // Use the same app-first lock order as visibility changes. The grant, install
      // reference and audit record must commit together, before a revoke can proceed.
      const [visible] = await tx`
        SELECT a.id FROM ispace.apps a JOIN ispace.shares s ON s.app_id = a.id
        WHERE s.id = ${id} AND s.to_user_id = ${me.id} AND a.visibility IN ('shared', 'public')
        FOR UPDATE OF a`;
      if (!visible) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这条分享不存在或已收回');
      // 只有接收方能回应。用 to_user_id 约束而非仅按 id 查——否则知道 id
      // 的人可以替别人接受。
      const rows = await tx<{ app_id: string }[]>`
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
        await tx`
          INSERT INTO ispace.app_installs (app_id, user_id, source)
          VALUES (${row.app_id}, ${me.id}, 'share')
          ON CONFLICT (app_id, user_id) DO NOTHING
        `;
      }

      await writeAudit(tx, {
        actorId: me.id, action: 'app.share_respond', targetType: 'share', targetId: id,
        source: 'console', result: 'success', metadata: { accept },
        ip: req.ip,
      });
    });
    return { ok: true, accepted: accept };
  });
}
