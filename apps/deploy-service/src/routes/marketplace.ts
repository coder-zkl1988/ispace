import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE, ERROR_CODES, IspaceError, marketplaceCategorySchema, type User,
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
             a.source_prompt,
             u.username AS owner_username, u.display_name AS owner_name,
             EXISTS (
               SELECT 1 FROM ispace.app_installs i
                WHERE i.app_id = m.app_id AND i.user_id = ${me.id}
             ) AS installed,
             (a.owner_id = ${me.id}) AS mine
        FROM ispace.marketplace_listings m
        JOIN ispace.apps  a ON a.id = m.app_id
        JOIN ispace.users u ON u.id = a.owner_id
       WHERE a.status <> 'stopped'
       ORDER BY m.install_count DESC, m.published_at DESC
    `;
    return { listings: rows };
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
    const rows = await sql`
      INSERT INTO ispace.marketplace_listings (app_id, published_by)
      VALUES (${appId}, ${me.id})
      ON CONFLICT (app_id) DO UPDATE SET published_at = now()
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
    // 计数物化，避免列表页每行都做一次 count
    await sql`
      UPDATE ispace.marketplace_listings m
         SET install_count = (SELECT count(*) FROM ispace.app_installs i WHERE i.app_id = m.app_id)
       WHERE m.app_id = ${appId}
    `;
    return { ok: true };
  });

  app.delete(`${API_BASE}/marketplace/:appId/install`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    await sql`
      DELETE FROM ispace.app_installs
       WHERE app_id = ${appId} AND user_id = ${me.id} AND source = 'marketplace'
    `;
    await sql`
      UPDATE ispace.marketplace_listings m
         SET install_count = (SELECT count(*) FROM ispace.app_installs i WHERE i.app_id = m.app_id)
       WHERE m.app_id = ${appId}
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
    await sql`
      UPDATE ispace.marketplace_listings m
         SET install_count = (SELECT count(*) FROM ispace.app_installs i WHERE i.app_id = m.app_id)
       WHERE m.app_id = ${appId}
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
}
