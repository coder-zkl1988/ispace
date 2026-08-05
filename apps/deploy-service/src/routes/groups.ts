import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import type { Sql } from '@ispace/db';
import { z } from 'zod';

/**
 * 页面分组（设计稿聚合页的 常用 / 日常 / 客户跟进 / 小工具）。
 *
 * 分组只影响展示顺序，不影响访问——删掉分组不会影响其中应用的可访问性，
 * 应用只是回到未分组。这一点在 SQL 层由 app_groups 的
 * ON DELETE SET NULL 保证，而非靠应用层记得清理。
 */
const createGroupSchema = z.object({ name: z.string().min(1).max(24) });
const renameGroupSchema = z.object({ name: z.string().min(1).max(24) });
const assignSchema = z.object({
  groupId: z.string().uuid().nullable(),
  sortOrder: z.number().int().nonnegative().optional(),
});

export function registerGroupRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; requireAuth: (req: FastifyRequest) => Promise<User> },
): void {
  const { sql, requireAuth } = deps;

  app.get(`${API_BASE}/groups`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql`
      SELECT g.*, (SELECT count(*) FROM ispace.apps a WHERE a.group_id = g.id) AS app_count
        FROM ispace.app_groups g WHERE g.owner_id = ${me.id}
       ORDER BY g.sort_order, g.created_at
    `;
    return { groups: rows };
  });

  app.post(`${API_BASE}/groups`, async (req) => {
    const me = await requireAuth(req);
    const { name } = createGroupSchema.parse(req.body);
    const max = await sql<{ n: number | null }[]>`
      SELECT MAX(sort_order) AS n FROM ispace.app_groups WHERE owner_id = ${me.id}
    `;
    try {
      const rows = await sql`
        INSERT INTO ispace.app_groups (owner_id, name, sort_order)
        VALUES (${me.id}, ${name}, ${(max[0]?.n ?? -1) + 1})
        RETURNING *
      `;
      return { group: rows[0] };
    } catch (e) {
      // (owner_id, name) 上有唯一约束
      if (String(e).includes('duplicate key')) {
        throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, `你已有同名分组「${name}」`);
      }
      throw e;
    }
  });

  app.patch(`${API_BASE}/groups/:id`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const { name } = renameGroupSchema.parse(req.body);
    const rows = await sql`
      UPDATE ispace.app_groups SET name = ${name}
       WHERE id = ${id} AND owner_id = ${me.id} RETURNING *
    `;
    if (!rows[0]) throw new IspaceError(ERROR_CODES.NOT_FOUND, '分组不存在');
    return { group: rows[0] };
  });

  app.delete(`${API_BASE}/groups/:id`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await sql`
      DELETE FROM ispace.app_groups WHERE id = ${id} AND owner_id = ${me.id} RETURNING id
    `;
    if (!rows[0]) throw new IspaceError(ERROR_CODES.NOT_FOUND, '分组不存在');
    // 组内应用由外键 ON DELETE SET NULL 自动回到未分组，无需在此处理
    return { ok: true };
  });

  /** 把应用移入/移出分组，或调整组内顺序。 */
  app.patch(`${API_BASE}/apps/:slug/group`, async (req) => {
    const me = await requireAuth(req);
    const { slug } = req.params as { slug: string };
    const { groupId, sortOrder } = assignSchema.parse(req.body);

    if (groupId) {
      // 只能移入自己的分组。不校验则任何人可把应用挂到别人的分组 id 下，
      // 造成对方列表里出现不属于自己的应用。
      const own = await sql`
        SELECT 1 FROM ispace.app_groups WHERE id = ${groupId} AND owner_id = ${me.id}
      `;
      if (!own.length) throw new IspaceError(ERROR_CODES.NOT_FOUND, '分组不存在');
    }

    const rows = await sql`
      UPDATE ispace.apps
         SET group_id = ${groupId},
             sort_order = ${sortOrder ?? sql`sort_order`},
             updated_at = now()
       WHERE owner_id = ${me.id} AND slug = ${slug}
      RETURNING *
    `;
    if (!rows[0]) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到应用 /${slug}`);
    return { app: rows[0] };
  });
}
