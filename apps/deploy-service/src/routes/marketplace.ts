import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE, ERROR_CODES, IspaceError, avatarUrlFor, marketplaceCategorySchema, type User,
} from '@ispace/contracts';
import { getPlatformPolicy, writeAudit, type Sql } from '@ispace/db';
import { z } from 'zod';

/**
 * 创意市场（设计稿顶部第二个 tab）。
 *
 * 「同事选择『分享到全公司』的页面都在这里，添加即用」。
 *
 * 与「分享给个人」的区别：
 *   分享给个人 —— 定向推送，对方要接受，出现在待接受卡
 *   创意市场   —— 主动上架，谁都能看到并自助添加，不需要对方同意
 *
 * 添加同样只建立引用而非复制：原作者更新，使用者下次打开就是新版；
 * 原作者下架，引用随之失效。这与设计稿手机端「她回滚版本，你下次进来
 * 也跟着回」是同一套语义。
 */

const publishSchema = z.object({ appId: z.string().uuid(), category: marketplaceCategorySchema.optional() });

export function registerMarketplaceRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; requireAuth: (req: FastifyRequest) => Promise<User> },
): void {
  const { sql, requireAuth } = deps;

  // ── 市场列表 ──────────────────────────────────────────────────────
  app.get(`${API_BASE}/marketplace`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql`
      SELECT m.id, m.app_id, m.published_at, m.install_count, a.category,
             a.slug, a.name, a.description, a.icon_letter, a.cover_path, a.type, a.status,
             a.source_prompt, a.visit_count, a.like_count, a.comment_count,
             u.username AS owner_username, u.display_name AS owner_name,
             av.etag AS owner_avatar_etag,
             EXISTS (
               SELECT 1 FROM ispace.app_installs i
                WHERE i.app_id = m.app_id AND i.user_id = ${me.id}
             ) AS installed,
             -- 探索墙上每张卡的心形要知道自己是不是实心的。放在列表里一次
             -- 查出来，而不是让前端对着几十张卡各问一次。
             EXISTS (
               SELECT 1 FROM ispace.app_likes l
                WHERE l.app_id = m.app_id AND l.user_id = ${me.id}
             ) AS liked,
             -- 「M 人正在用」：presence 表 90 秒窗口内的去重访客
             -- （shell.js 每 30 秒心跳）。子查询一张卡算一次，几十张卡
             -- 的墙也只是一次索引扫，量级无虞。
             (SELECT count(*) FROM ispace.app_presence p
               WHERE p.app_id = m.app_id
                 AND p.last_seen_at > now() - interval '90 seconds') AS live_count,
             (a.owner_id = ${me.id}) AS mine
        FROM ispace.marketplace_listings m
        JOIN ispace.apps  a ON a.id = m.app_id
        JOIN ispace.users u ON u.id = a.owner_id
        LEFT JOIN ispace.user_avatars av ON av.user_id = u.id
       WHERE a.status <> 'stopped'
       ORDER BY m.install_count DESC, m.published_at DESC
    `;
    /*
     * 后端 listing 一起端上来（探索墙混排的另一半）。
     *
     * 只收 **exposed** 的后端：探索是一面能点开看的墙，纯 API 服务没有
     * 可打开的页面，硬摆上去只会收获一张点不开的卡——那类后端仍然留在
     * 控制台「后端与数据」（D10 的边界对它们继续成立）。exposed 全栈
     * 项目有真实可用的页面，点开 = url_path（/svc/{user}/{name}），
     * 「点开看」这一条对它们是成立的。
     *
     * 在市场上架（listing 存在）本身意味着 visibility='public'——上架
     * 与公开在可见范围切换里是同一次事务的两面，这里不用再筛。
     */
    const backendRows = await sql`
      SELECT m.id, m.backend_id, m.published_at, m.install_count,
             -- 与页面同一窗口的「M 人正在用」（svc 代理请求流的心跳）
             (SELECT count(*) FROM ispace.backend_presence p
               WHERE p.backend_id = m.backend_id
                 AND p.last_seen_at > now() - interval '90 seconds') AS live_count,
             b.category, b.name, b.status, b.visit_count,
             b.url_path, (b.cover IS NOT NULL) AS has_cover,
             u.username AS owner_username, u.display_name AS owner_name,
             av.etag AS owner_avatar_etag,
             EXISTS (
               SELECT 1 FROM ispace.backend_installs i
                WHERE i.backend_id = m.backend_id AND i.user_id = ${me.id}
             ) AS installed,
             (b.owner_id = ${me.id}) AS mine
        FROM ispace.marketplace_listings m
        JOIN ispace.backends b ON b.id = m.backend_id
        JOIN ispace.users u ON u.id = b.owner_id
        LEFT JOIN ispace.user_avatars av ON av.user_id = u.id
       WHERE b.status <> 'stopped' AND b.exposed
       ORDER BY m.install_count DESC, m.published_at DESC
    `;

    // 卡片左下角的作者头像。etag 只用来拼地址，不往外送
    return {
      listings: rows.map(({ owner_avatar_etag, ...r }) => ({
        ...r,
        owner_avatar: avatarUrlFor(r.owner_username as string, owner_avatar_etag as string | null),
      })),
      backendListings: backendRows.map(({ owner_avatar_etag, ...r }) => ({
        ...r,
        owner_avatar: avatarUrlFor(r.owner_username as string, owner_avatar_etag as string | null),
        // 封面直用既有端点（免登录 PNG，墙的观看者本就在登录态内）
        cover_url: r.has_cover ? `${API_BASE}/backends/${r.backend_id}/cover` : null,
      })),
    };
  });

  // ── 上架 ──────────────────────────────────────────────────────────
  app.post(`${API_BASE}/marketplace`, async (req) => {
    const me = await requireAuth(req);
    const { appId, category } = publishSchema.parse(req.body);

    const { allowPublicShare } = await getPlatformPolicy(sql);
    if (!allowPublicShare) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '平台已关闭「全公司」共享，创意市场暂不接受上架。');
    }

    const owned = await sql<{ name: string }[]>`
      SELECT name FROM ispace.apps WHERE id = ${appId} AND owner_id = ${me.id}
    `;
    if (!owned[0]) throw new IspaceError(ERROR_CODES.NOT_OWNER, '只能上架自己的页面');

    // 幂等：重复上架不报错，只刷新时间
    if (category) {
      await sql`UPDATE ispace.apps SET category = ${category} WHERE id = ${appId}`;
    }
    /*
     * 上架即按事实初始化/校正复用数。0038 的触发器只盯 app_installs 的
     * 写——listing 自己插入时它不会醒来，而一个先被分享给三个人、再上架
     * 的页面若从默认 0 起算，卡片会硬说「0 人复用」。重新上架（DO UPDATE
     * 分支）顺手重放一遍，把任何残余漂移也抹平。
     */
    const rows = await sql`
      INSERT INTO ispace.marketplace_listings (app_id, published_by, install_count)
      VALUES (${appId}, ${me.id},
              (SELECT count(*) FROM ispace.app_installs i WHERE i.app_id = ${appId}))
      ON CONFLICT (app_id) DO UPDATE SET published_at = now(),
        install_count = (SELECT count(*) FROM ispace.app_installs i WHERE i.app_id = ${appId})
      RETURNING *
    `;
    await sql`UPDATE ispace.apps SET visibility = 'public' WHERE id = ${appId}`;
    await writeAudit(sql, {
      actorId: me.id, action: 'app.share', targetType: 'app', targetId: appId,
      source: 'console', result: 'success', metadata: { marketplace: true, app: owned[0].name },
      ip: req.ip,
    });
    return { listing: rows[0] };
  });

  // ── 改分类 ────────────────────────────────────────────────────────
  app.patch(`${API_BASE}/marketplace/:appId/category`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    const { category } = z.object({ category: marketplaceCategorySchema }).parse(req.body);
    const owned = await sql`SELECT 1 FROM ispace.apps WHERE id = ${appId} AND owner_id = ${me.id}`;
    if (!owned[0]) throw new IspaceError(ERROR_CODES.NOT_OWNER, '只能改自己的页面。');
    await sql`UPDATE ispace.apps SET category = ${category} WHERE id = ${appId}`;
    return { ok: true };
  });

  // ── 下架 ──────────────────────────────────────────────────────────
  app.delete(`${API_BASE}/marketplace/:appId`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    const rows = await sql`
      DELETE FROM ispace.marketplace_listings
       WHERE app_id = ${appId} AND published_by = ${me.id}
      RETURNING id
    `;
    if (!rows[0]) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这个页面不在市场里');
    // 下架同时清掉别人的引用，否则对方列表里留着一个点不开的入口
    await sql`
      DELETE FROM ispace.app_installs WHERE app_id = ${appId} AND source = 'marketplace'
    `;
    await sql`
      UPDATE ispace.apps SET visibility = 'private'
       WHERE id = ${appId} AND NOT EXISTS (
         SELECT 1 FROM ispace.shares s WHERE s.app_id = ${appId} AND s.status = 'accepted'
       )
    `;
    return { ok: true };
  });

  // ── 添加到我的 ────────────────────────────────────────────────────
  app.post(`${API_BASE}/marketplace/:appId/install`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };

    const listed = await sql`
      SELECT 1 FROM ispace.marketplace_listings WHERE app_id = ${appId}
    `;
    if (!listed.length) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这个页面已不在市场里');

    await sql`
      INSERT INTO ispace.app_installs (app_id, user_id, source)
      VALUES (${appId}, ${me.id}, 'marketplace')
      ON CONFLICT (app_id, user_id) DO NOTHING
    `;
    // install_count 由 0038 的增量触发器 ±1 维护（见迁移头注释：为什么
    // 不在这里显式重算——count(*) 在并发等锁后会写回旧快照值）。
    return { ok: true };
  });

  app.delete(`${API_BASE}/marketplace/:appId/install`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    await sql`
      DELETE FROM ispace.app_installs
       WHERE app_id = ${appId} AND user_id = ${me.id} AND source = 'marketplace'
    `;
    return { ok: true };
  });

  /** 我添加过的（含分享来的与市场来的），用于聚合页展示。 */
  /**
   * 把别人的页面从我的空间里移除。
   *
   * 不区分它是分享来的还是市场装的：对用户而言都是「我这儿不要它了」，
   * 而市场那个卸载端点带 source='marketplace' 过滤，分享来的删不掉。
   *
   * 只动 app_installs，不碰 shares：分享关系归对方管——他没收回，
   * 我以后想再要还能从主页的入口卡重新接受。
   */
  app.delete(`${API_BASE}/installed/:appId`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    await sql`
      DELETE FROM ispace.app_installs WHERE app_id = ${appId} AND user_id = ${me.id}
    `;
    return { ok: true };
  });

  app.get(`${API_BASE}/installed`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql`
      SELECT i.source, a.id, a.slug, a.name, a.description, a.icon_letter, a.cover_path,
             a.type, a.status, a.updated_at,
             u.username AS owner_username, u.display_name AS owner_name
        FROM ispace.app_installs i
        JOIN ispace.apps  a ON a.id = i.app_id
        JOIN ispace.users u ON u.id = a.owner_id
       WHERE i.user_id = ${me.id}
       ORDER BY i.created_at DESC
    `;
    return { installed: rows };
  });

  /*
   * ── 后端的市场列表 / 安装 / 分类 ─────────────────────────────────────
   *
   * 后端和页面在市场里的数据形状差太多（没有 slug/type/source_prompt，
   * 封面存 bytea 不是 URL），与其在一条查询里 UNION 再对齐两边的列类型，
   * 不如单开一组端点——门户把两次请求的结果在客户端拼成一个列表渲染，
   * 分类侧边栏、搜索、排序都在那一层统一算。
   */

  // ── 市场列表（后端）──────────────────────────────────────────────────
  app.get(`${API_BASE}/marketplace/backends`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql`
      SELECT m.id, m.backend_id, m.published_at, m.install_count,
             b.category, b.name, b.status, b.visit_count, (b.cover IS NOT NULL) AS has_cover,
             u.username AS owner_username, u.display_name AS owner_name,
             EXISTS (
               SELECT 1 FROM ispace.backend_installs i
                WHERE i.backend_id = m.backend_id AND i.user_id = ${me.id}
             ) AS installed,
             -- 与页面同款：svc 代理请求流的 90 秒窗口在线数
             (SELECT count(*) FROM ispace.backend_presence p
               WHERE p.backend_id = m.backend_id
                 AND p.last_seen_at > now() - interval '90 seconds') AS live_count,
             (b.owner_id = ${me.id}) AS mine
        FROM ispace.marketplace_listings m
        JOIN ispace.backends b ON b.id = m.backend_id
        JOIN ispace.users   u ON u.id = b.owner_id
       WHERE b.status <> 'stopped'
       ORDER BY m.install_count DESC, m.published_at DESC
    `;
    return { listings: rows };
  });

  // ── 改分类（后端）────────────────────────────────────────────────────
  app.patch(`${API_BASE}/marketplace/backends/:backendId/category`, async (req) => {
    const me = await requireAuth(req);
    const { backendId } = req.params as { backendId: string };
    const { category } = z.object({ category: marketplaceCategorySchema }).parse(req.body);
    const owned = await sql`SELECT 1 FROM ispace.backends WHERE id = ${backendId} AND owner_id = ${me.id}`;
    if (!owned[0]) throw new IspaceError(ERROR_CODES.NOT_OWNER, '只能改自己的后端。');
    await sql`UPDATE ispace.backends SET category = ${category} WHERE id = ${backendId}`;
    return { ok: true };
  });

  // ── 添加到我的（后端）────────────────────────────────────────────────
  app.post(`${API_BASE}/marketplace/backends/:backendId/install`, async (req) => {
    const me = await requireAuth(req);
    const { backendId } = req.params as { backendId: string };

    const listed = await sql`
      SELECT 1 FROM ispace.marketplace_listings WHERE backend_id = ${backendId}
    `;
    if (!listed.length) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这个后端已不在市场里');

    await sql`
      INSERT INTO ispace.backend_installs (backend_id, user_id)
      VALUES (${backendId}, ${me.id})
      ON CONFLICT (backend_id, user_id) DO NOTHING
    `;
    // 计数由 0038 增量触发器维护，不再显式重算（同上）。
    return { ok: true };
  });

  app.delete(`${API_BASE}/marketplace/backends/:backendId/install`, async (req) => {
    const me = await requireAuth(req);
    const { backendId } = req.params as { backendId: string };
    await sql`
      DELETE FROM ispace.backend_installs
       WHERE backend_id = ${backendId} AND user_id = ${me.id}
    `;
    return { ok: true };
  });

  // ── 我添加过的后端（聚合页「已安装」区用）────────────────────────────
  app.get(`${API_BASE}/installed/backends`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql`
      SELECT b.id, b.name, b.status, b.url_path, (b.cover IS NOT NULL) AS has_cover,
             u.username AS owner_username, u.display_name AS owner_name
        FROM ispace.backend_installs i
        JOIN ispace.backends b ON b.id = i.backend_id
        JOIN ispace.users   u ON u.id = b.owner_id
       WHERE i.user_id = ${me.id}
       ORDER BY i.created_at DESC
    `;
    return { installed: rows };
  });

  app.delete(`${API_BASE}/installed/backends/:backendId`, async (req) => {
    const me = await requireAuth(req);
    const { backendId } = req.params as { backendId: string };
    await sql`
      DELETE FROM ispace.backend_installs WHERE backend_id = ${backendId} AND user_id = ${me.id}
    `;
    return { ok: true };
  });
}
