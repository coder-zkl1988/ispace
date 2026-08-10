import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE, ERROR_CODES, IspaceError, marketplaceCategorySchema, type User,
} from '@ispace/contracts';
import { provisionUserSchema, writeAudit, type Sql } from '@ispace/db';
import type { Orchestrator } from '@ispace/orchestrator';
import { z } from 'zod';
import { offboardUser, restoreUser } from '../services/offboard.js';

/**
 * 管理员视角（设计稿管理员 5 屏：平台总览、员工与开通、资源与配额、
 * 审计与安全、平台巡检）。
 *
 * 所有端点都经 requireAdmin。员工与管理员共用同一个控制台入口，
 * 由角色决定渲染哪套导航——这是设计稿的「员工视角 / 管理员」开关。
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    requireAdmin: (req: FastifyRequest) => Promise<User>;
    /** 离职回收要停掉这个人的后端容器。 */
    orchestrator: Orchestrator;
  },
): void {
  const { sql, requireAdmin, orchestrator } = deps;

  // ── 平台总览 ──────────────────────────────────────────────────────
  app.get(`${API_BASE}/admin/overview`, async (req) => {
    await requireAdmin(req);

    const [counts] = await sql<
      { users: string; new_users: string; apps: string; backends: string }[]
    >`
      SELECT
        (SELECT count(*) FROM ispace.users WHERE status='active')::text AS users,
        (SELECT count(*) FROM ispace.users
          WHERE status='active' AND created_at > now() - interval '7 days')::text AS new_users,
        (SELECT count(*) FROM ispace.apps WHERE status <> 'stopped')::text AS apps,
        (SELECT count(*) FROM ispace.backends WHERE status='running')::text AS backends
    `;

    const [deploys] = await sql<{ this_week: string; last_week: string }[]>`
      SELECT
        count(*) FILTER (WHERE published_at > now() - interval '7 days')::text  AS this_week,
        count(*) FILTER (WHERE published_at > now() - interval '14 days'
                           AND published_at <= now() - interval '7 days')::text AS last_week
        FROM ispace.releases WHERE status <> 'blocked'
    `;

    // 近 14 天发布趋势。用 generate_series 补齐没有发布的日子，
    // 否则前端画图时 x 轴会出现跳空。
    const trend = await sql<{ date: string; count: string }[]>`
      SELECT to_char(d.day, 'MM-DD') AS date,
             COALESCE(count(r.id), 0)::text AS count
        FROM generate_series(
               (now() - interval '13 days')::date, now()::date, interval '1 day'
             ) AS d(day)
        LEFT JOIN ispace.releases r
               ON r.published_at::date = d.day AND r.status <> 'blocked'
       GROUP BY d.day ORDER BY d.day
    `;

    const topSpaces = await sql<
      { username: string; display_name: string; bytes: string }[]
    >`
      SELECT u.username, u.display_name,
             COALESCE(SUM(a.size_bytes), 0)::text AS bytes
        FROM ispace.users u
        LEFT JOIN ispace.apps a ON a.owner_id = u.id
       WHERE u.status = 'active'
       GROUP BY u.id, u.username, u.display_name
       ORDER BY SUM(a.size_bytes) DESC NULLS LAST
       LIMIT 5
    `;

    const thisWeek = Number(deploys?.this_week ?? 0);
    const lastWeek = Number(deploys?.last_week ?? 0);

    return {
      userCount: Number(counts?.users ?? 0),
      userCountDelta: Number(counts?.new_users ?? 0),
      appCount: Number(counts?.apps ?? 0),
      backendCount: Number(counts?.backends ?? 0),
      weeklyDeployCount: thisWeek,
      // 上周为 0 时百分比无意义，返回 0 而非 Infinity——前端拿到 Infinity
      // 会渲染成 "Infinity%"
      weeklyDeployDeltaPercent: lastWeek === 0 ? 0 : Math.round(((thisWeek - lastWeek) / lastWeek) * 1000) / 10,
      deployTrend: trend.map((t) => ({ date: t.date, count: Number(t.count) })),
      topSpaces: topSpaces.map((s) => ({
        username: s.username, displayName: s.display_name, bytes: Number(s.bytes),
      })),
    };
  });

  // ── 员工与开通 ────────────────────────────────────────────────────
  app.get(`${API_BASE}/admin/users`, async (req) => {
    await requireAdmin(req);

    // 设计稿这一屏顶部有四个计数。在 SQL 里一次算完，
    // 而不是把全表拉到前端再 filter——员工数会长，这四个数字不该跟着变慢。
    const [summary] = await sql<
      { active: string; pending: string; cooling: string; near_limit: string }[]
    >`
      SELECT
        count(*) FILTER (WHERE u.status = 'active')::text  AS active,
        count(*) FILTER (WHERE u.status = 'pending')::text AS pending,
        -- 冷冻期：归档 30 天内。期间一键可恢复，之后才进入可清理状态。
        count(*) FILTER (
          WHERE u.status = 'archived' AND u.archived_at > now() - interval '30 days'
        )::text AS cooling,
        count(*) FILTER (
          WHERE u.status = 'active' AND q.storage_bytes_limit > 0
            AND q.storage_bytes_used::float / q.storage_bytes_limit > 0.85
        )::text AS near_limit
        FROM ispace.users u
        LEFT JOIN ispace.quotas q ON q.user_id = u.id
    `;

    const rows = await sql`
      SELECT u.id, u.username, u.display_name, u.email, u.role, u.identity,
             u.status, u.created_at, u.archived_at,
             COALESCE(q.storage_bytes_used, 0) AS storage_used,
             COALESCE(q.storage_bytes_limit, 0) AS storage_limit,
             (SELECT count(*) FROM ispace.apps a WHERE a.owner_id = u.id) AS app_count,
             (SELECT count(*) FROM ispace.backends b
               WHERE b.owner_id = u.id AND b.status <> 'stopped') AS backend_count
        FROM ispace.users u
        LEFT JOIN ispace.quotas q ON q.user_id = u.id
       ORDER BY u.created_at DESC
    `;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    return {
      summary: {
        active: Number(summary?.active ?? 0),
        pending: Number(summary?.pending ?? 0),
        cooling: Number(summary?.cooling ?? 0),
        nearLimit: Number(summary?.near_limit ?? 0),
      },
      users: rows.map((r: any) => ({
        id: r.id, username: r.username, displayName: r.display_name,
        email: r.email, role: r.role, identity: r.identity, status: r.status,
        createdAt: r.created_at, archivedAt: r.archived_at,
        storageUsed: Number(r.storage_used), storageLimit: Number(r.storage_limit),
        appCount: Number(r.app_count), backendCount: Number(r.backend_count),
      })),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  /** 归档而非删除。规格 §6：离职回收是归档，发布历史与审计必须留存。 */
  /**
   * 离职回收。执行设计稿的四步，不只是把状态改成 archived。
   *
   * 四步都不删东西——回收之后常常紧跟着「她那个周报工具还得用」，
   * 删了就真的回不来了。详见 services/offboard.ts。
   */
  app.post(`${API_BASE}/admin/users/:id/archive`, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    if (id === admin.id) {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, '不能回收自己');
    }
    const [target] = await sql<{ role: string; status: string }[]>`
      SELECT role, status FROM ispace.users WHERE id = ${id}
    `;
    if (!target) throw new IspaceError(ERROR_CODES.NOT_FOUND, '用户不存在');
    if (target.status === 'archived') {
      throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, '这个账号已经回收过了');
    }
    // 与降级同理：回收掉最后一个管理员会让平台永久失去管理面
    if (target.role === 'admin') {
      const [others] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM ispace.users
         WHERE role = 'admin' AND status = 'active' AND id <> ${id}
      `;
      if (Number(others?.n ?? 0) === 0) {
        throw new IspaceError(
          ERROR_CODES.INVALID_INPUT,
          '这是最后一位管理员。请先设立另一位管理员再回收这个账号。',
        );
      }
    }

    return offboardUser({
      sql, orchestrator, adminId: admin.id, userId: id,
      clientIp: req.ip, log: app.log,
    });
  });

  /**
   * 撤销回收。
   *
   * 冷冻期的存在本身就意味着这件事可逆——设计稿写的是「90 天冷冻期」，
   * 不是「90 天后删除」。人没走成、走了又回来、当初点错了人，
   * 都需要这条路径；没有它就只能上服务器改库，而那一步顺序错了
   * 会让全平台的数据接口挂掉。
   */
  app.post(`${API_BASE}/admin/users/:id/restore`, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    return restoreUser({ sql, adminId: admin.id, userId: id, clientIp: req.ip, log: app.log });
  });

  /** 某个人的回收记录。失败的步骤可以按这里的 runId 重跑。 */
  app.get(`${API_BASE}/admin/users/:id/offboard`, async (req) => {
    await requireAdmin(req);
    const { id } = req.params as { id: string };
    const runs = await sql`
      SELECT id, steps, status, path_frozen_until, started_at, finished_at
        FROM ispace.offboard_runs WHERE user_id = ${id}
       ORDER BY started_at DESC LIMIT 10
    `;
    return { runs };
  });

  /**
   * 重跑一次回收。
   *
   * 上一次可能只走通了一半（编排器抽风、磁盘满）。重跑是幂等的：
   * 每一步都是"确保处于停用/冻结状态"，已经做过的再做一次没有副作用。
   */
  app.post(`${API_BASE}/admin/users/:id/offboard/retry`, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    return offboardUser({
      sql, orchestrator, adminId: admin.id, userId: id,
      clientIp: req.ip, log: app.log,
    });
  });

  // ── 平台巡检 ──────────────────────────────────────────────────────
  /**
   * 设计稿「待处理」列表。
   *
   * 有意只返回"能自动判定"的项，不编造。当前能判定的三类：
   * 存储接近上限、闲置待归档、被阻断的发布。
   * 后端内存告警等需要编排器接入后才有数据源（计划 8）。
   */
  app.get(`${API_BASE}/admin/inspection`, async (req) => {
    await requireAdmin(req);
    const items: { severity: 'warn' | 'info'; text: string; hint: string }[] = [];

    const nearLimit = await sql<{ username: string; used: string; lim: string }[]>`
      SELECT u.username, q.storage_bytes_used::text AS used, q.storage_bytes_limit::text AS lim
        FROM ispace.quotas q JOIN ispace.users u ON u.id = q.user_id
       WHERE q.storage_bytes_limit > 0
         AND q.storage_bytes_used::float / q.storage_bytes_limit > 0.85
    `;
    for (const r of nearLimit) {
      items.push({
        severity: 'warn',
        text: `${r.username} 的静态空间已用 ${Math.round((Number(r.used) / Number(r.lim)) * 100)}%`,
        hint: '接近上限，超限后将拒绝发布',
      });
    }

    const idle = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ispace.apps
       WHERE status='running'
         AND COALESCE(last_accessed_at, created_at) < now() - interval '90 days'
    `;
    if (Number(idle[0]?.n ?? 0) > 0) {
      items.push({
        severity: 'info',
        text: `${idle[0]!.n} 个页面 90 天无访问，待通知归档`,
        hint: '先通知后归档，可自助恢复',
      });
    }

    /**
     * SSO 未接。
     *
     * 这是平台最要紧的未完成项，却最不容易被发现：mock 登录页看起来
     * 也能登进去，界面一切正常，只有点开才发现是一份用户列表、
     * 谁都能选任何身份进来。放在巡检里，管理员一眼能看到。
     */
    if (!process.env.OIDC_ISSUER) {
      items.push({
        severity: 'warn',
        text: '还在用开发登录，公司 SSO 未接入',
        hint: '当前任何人都能从列表里选身份登入。配置 OIDC_ISSUER / CLIENT_ID / CLIENT_SECRET 后该页自动失效，见 docs/runbooks/sso-setup.md',
      });
    }

    const blocked = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ispace.audit_logs
       WHERE result='blocked' AND created_at > now() - interval '7 days'
    `;
    if (Number(blocked[0]?.n ?? 0) > 0) {
      items.push({
        severity: 'warn',
        text: `近 7 天有 ${blocked[0]!.n} 次发布被扫描阻断`,
        hint: '多为硬编码密钥，建议提醒相关同事',
      });
    }

    return { items };
  });

  // ── 改角色（设/取消管理员）────────────────────────────────────────
  /**
   * 此前完全没有这个能力：第二个管理员只能靠直接改库产生。
   *
   * 两条护栏：
   *   不能改自己——一个人手滑把自己降级，就再也没人能把他升回来
   *   不能降掉最后一个管理员——那会让整个平台永久失去管理面
   */
  app.patch(`${API_BASE}/admin/users/:id/role`, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    const { role } = (req.body ?? {}) as { role?: string };
    if (role !== 'admin' && role !== 'employee') {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, 'role 只能是 admin 或 employee');
    }
    if (id === admin.id) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        '不能改自己的角色。找另一位管理员操作，或先把别人升为管理员。',
      );
    }

    if (role === 'employee') {
      const [others] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM ispace.users
         WHERE role = 'admin' AND status = 'active' AND id <> ${id}
      `;
      if (Number(others?.n ?? 0) === 0) {
        throw new IspaceError(
          ERROR_CODES.INVALID_INPUT,
          '这是最后一位管理员，降级后平台将没有任何人能进管理面。请先设立另一位管理员。',
        );
      }
    }

    const [row] = await sql<{ username: string }[]>`
      UPDATE ispace.users SET role = ${role} WHERE id = ${id} AND status <> 'archived'
      RETURNING username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '用户不存在或已归档');

    await writeAudit(sql, {
      actorId: admin.id, action: 'policy.update', targetType: 'user', targetId: id,
      source: 'console', result: 'success',
      metadata: { username: row.username, roleChangedTo: role },
      ip: req.ip,
    });
    return { ok: true, role };
  });

  // ── 通过待开通的注册 ──────────────────────────────────────────────
  /**
   * 「需管理员批准」打开时，自助注册的人落在 pending，空间还没开。
   * 这里补上开通那一步，走的是与手工开通完全相同的链路。
   */
  app.post(`${API_BASE}/admin/users/:id/approve`, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };

    const [u] = await sql<{ username: string }[]>`
      SELECT username FROM ispace.users WHERE id = ${id} AND status = 'pending'
    `;
    if (!u) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这条待开通的注册');

    // 先开空间再改状态：反过来的话，开通中途失败会留下一个
    // 状态是 active 但没有 schema 的账号，登进来处处报错
    await provisionUserSchema(sql, u.username);
    await sql`UPDATE ispace.users SET status = 'active' WHERE id = ${id}`;

    await writeAudit(sql, {
      actorId: admin.id, action: 'user.provision', targetType: 'user', targetId: id,
      source: 'console', result: 'success',
      metadata: { username: u.username, approved: true },
      ip: req.ip,
    });
    return { ok: true };
  });

  // ── 访问令牌治理 ──────────────────────────────────────────────────
  /**
   * 全平台的 MCP / CLI 令牌。
   *
   * 此前管理员看不到任何人的令牌，也无法吊销——人离职时只能把账号归档，
   * 而令牌本身没有被明确收回。归档确实会让鉴权失败（requireAuth 会查
   * 用户状态），但"我们收回了他的访问权"这件事没有任何地方能证实，
   * 也没法处理"某个令牌泄露了但人还在职"。
   *
   * 只给前缀不给哈希：前缀足够让人对上自己那条记录，而哈希哪怕泄露
   * 也无法反推令牌，列出来只是徒增暴露面。
   */
  app.get(`${API_BASE}/admin/tokens`, async (req) => {
    await requireAdmin(req);
    const rows = await sql`
      SELECT t.id, t.name, t.token_prefix, t.created_at, t.last_used_at, t.expires_at,
             u.username, u.display_name, u.status AS user_status
        FROM ispace.access_tokens t
        JOIN ispace.users u ON u.id = t.user_id
       WHERE t.revoked_at IS NULL
       ORDER BY t.last_used_at DESC NULLS LAST, t.created_at DESC
       LIMIT 500
    `;
    return { tokens: rows };
  });

  app.post(`${API_BASE}/admin/tokens/:id/revoke`, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    const [row] = await sql<{ name: string; username: string }[]>`
      UPDATE ispace.access_tokens t SET revoked_at = now()
        FROM ispace.users u
       WHERE t.user_id = u.id AND t.id = ${id} AND t.revoked_at IS NULL
      RETURNING t.name, u.username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '令牌不存在或已吊销');

    await writeAudit(sql, {
      actorId: admin.id, action: 'policy.update', targetType: 'token', targetId: id,
      source: 'console', result: 'success',
      metadata: { revokedToken: row.name, owner: row.username, byAdmin: true },
      ip: req.ip,
    });
    return { ok: true };
  });

  // ── 创意市场：管理员下架 ──────────────────────────────────────────
  /**
   * 市场自带的下架接口只认 published_by = 自己，管理员管不了别人上架的东西。
   * 内部平台上这条一定会用到：有人上架了不该全公司可见的内容，
   * 而作者可能正在休假。
   *
   * 只下架，不删应用：内容归属者仍是作者，管理员该做的是收窄可见范围。
   */
  app.delete(`${API_BASE}/admin/marketplace/:appId`, async (req) => {
    const admin = await requireAdmin(req);
    const { appId } = req.params as { appId: string };

    const [row] = await sql<{ name: string; username: string }[]>`
      DELETE FROM ispace.marketplace_listings m
       USING ispace.apps a, ispace.users u
       WHERE m.app_id = a.id AND a.owner_id = u.id AND m.app_id = ${appId}
      RETURNING a.name, u.username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这个页面不在市场里');

    await sql`
      DELETE FROM ispace.app_installs WHERE app_id = ${appId} AND source = 'marketplace'
    `;
    // 还有点对点分享的话保留 shared，否则退回 private
    await sql`
      UPDATE ispace.apps SET visibility = CASE
        WHEN EXISTS (SELECT 1 FROM ispace.shares s
                      WHERE s.app_id = ${appId} AND s.status IN ('pending','accepted'))
        THEN 'shared' ELSE 'private' END
       WHERE id = ${appId}
    `;
    await writeAudit(sql, {
      actorId: admin.id, action: 'app.share', targetType: 'app', targetId: appId,
      source: 'console', result: 'success',
      metadata: { unlistedByAdmin: true, app: row.name, owner: row.username },
      ip: req.ip,
    });
    return { ok: true };
  });

  // ── 创意市场：管理员下架（后端）────────────────────────────────────
  // 与上面页面那条同构，只是落到 backends / backend_installs / backend_shares。
  app.delete(`${API_BASE}/admin/marketplace/backends/:backendId`, async (req) => {
    const admin = await requireAdmin(req);
    const { backendId } = req.params as { backendId: string };

    const [row] = await sql<{ name: string; username: string }[]>`
      DELETE FROM ispace.marketplace_listings m
       USING ispace.backends b, ispace.users u
       WHERE m.backend_id = b.id AND b.owner_id = u.id AND m.backend_id = ${backendId}
      RETURNING b.name, u.username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这个后端不在市场里');

    await sql`DELETE FROM ispace.backend_installs WHERE backend_id = ${backendId}`;
    // 还有点对点分享的话保留 shared，否则退回 private
    await sql`
      UPDATE ispace.backends SET visibility = CASE
        WHEN EXISTS (SELECT 1 FROM ispace.backend_shares s WHERE s.backend_id = ${backendId})
        THEN 'shared' ELSE 'private' END
       WHERE id = ${backendId}
    `;
    await writeAudit(sql, {
      actorId: admin.id, action: 'backend.update', targetType: 'backend', targetId: backendId,
      source: 'console', result: 'success',
      metadata: { unlistedByAdmin: true, name: row.name, owner: row.username },
      ip: req.ip,
    });
    return { ok: true };
  });

  // ── 全部作品：合规巡查 ────────────────────────────────────────────
  /**
   * 市场列表只看得到别人**主动上架**的东西——大多数页面/后端从没上过市场，
   * 出了合规问题（内容违规、员工离职前的遗留内容）之前完全看不见，只能
   * 挨个去问"你发布过什么"。这里给一份全平台清单，不按可见范围过滤——
   * 管理员本来就该能看到全部，这正是这一屏存在的理由。
   */
  app.get(`${API_BASE}/admin/apps`, async (req) => {
    await requireAdmin(req);
    const rows = await sql`
      SELECT a.id, a.slug, a.name, a.description, a.category, a.visibility, a.status,
             a.cover_path, a.size_bytes, a.created_at, a.updated_at,
             u.username AS owner_username, u.display_name AS owner_name,
             (ml.id IS NOT NULL) AS listed
        FROM ispace.apps a
        JOIN ispace.users u ON u.id = a.owner_id
        LEFT JOIN ispace.marketplace_listings ml ON ml.app_id = a.id
       ORDER BY a.updated_at DESC
    `;
    return { apps: rows };
  });

  app.get(`${API_BASE}/admin/backends`, async (req) => {
    await requireAdmin(req);
    const rows = await sql`
      SELECT b.id, b.name, b.url_path, b.category, b.visibility, b.status, b.created_at,
             u.username AS owner_username, u.display_name AS owner_name,
             (ml.id IS NOT NULL) AS listed
        FROM ispace.backends b
        JOIN ispace.users u ON u.id = b.owner_id
        LEFT JOIN ispace.marketplace_listings ml ON ml.backend_id = b.id
       ORDER BY b.created_at DESC
    `;
    return { backends: rows };
  });

  const adminCategorySchema = z.object({ category: marketplaceCategorySchema });

  /** 分类本来只有作者能改（marketplace.ts 那条 PATCH 认 owner_id）——这条给管理员开一个不受所有权限制的旁路，同一件事，跟别人的分类。 */
  app.patch(`${API_BASE}/admin/apps/:appId/category`, async (req) => {
    const admin = await requireAdmin(req);
    const { appId } = req.params as { appId: string };
    const { category } = adminCategorySchema.parse(req.body);
    const [row] = await sql<{ name: string; username: string }[]>`
      UPDATE ispace.apps a SET category = ${category}
       FROM ispace.users u
       WHERE a.id = ${appId} AND a.owner_id = u.id
      RETURNING a.name, u.username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个页面');
    await writeAudit(sql, {
      actorId: admin.id, action: 'app.category_change', targetType: 'app', targetId: appId,
      source: 'console', result: 'success',
      metadata: { category, byAdmin: true, app: row.name, owner: row.username },
      ip: req.ip,
    });
    return { ok: true };
  });

  app.patch(`${API_BASE}/admin/backends/:backendId/category`, async (req) => {
    const admin = await requireAdmin(req);
    const { backendId } = req.params as { backendId: string };
    const { category } = adminCategorySchema.parse(req.body);
    const [row] = await sql<{ name: string; username: string }[]>`
      UPDATE ispace.backends b SET category = ${category}
       FROM ispace.users u
       WHERE b.id = ${backendId} AND b.owner_id = u.id
      RETURNING b.name, u.username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个后端');
    await writeAudit(sql, {
      actorId: admin.id, action: 'backend.category_change', targetType: 'backend', targetId: backendId,
      source: 'console', result: 'success',
      metadata: { category, byAdmin: true, name: row.name, owner: row.username },
      ip: req.ip,
    });
    return { ok: true };
  });

  const takedownBodySchema = z.object({ reason: z.string().trim().max(200).optional() });

  /**
   * 下架（强制停用）。与上面「创意市场：管理员下架」不同——那条只摘市场
   * listing，页面自己还在跑，知道直链或分享过的人照样能打开。这条真正
   * 掐断访问：把 status 改成 stopped，authz 网关那道 404 gate（见
   * authz.ts）立刻生效，不管访问者是不是从市场进来的。顺手把市场 listing
   * 和别人的引用一并清掉，一次操作把"能不能被发现"和"能不能被打开"一起收掉。
   *
   * 只停用不删除：内容仍属于作者，管理员做的是收权限，不是替作者销毁数据——
   * 跟「离职回收」同一个判断，也是为什么有对应的 restore。
   */
  app.post(`${API_BASE}/admin/apps/:appId/takedown`, async (req) => {
    const admin = await requireAdmin(req);
    const { appId } = req.params as { appId: string };
    const { reason } = takedownBodySchema.parse(req.body ?? {});
    const [row] = await sql<{ name: string; username: string }[]>`
      UPDATE ispace.apps a SET status = 'stopped'
       FROM ispace.users u
       WHERE a.id = ${appId} AND a.owner_id = u.id
      RETURNING a.name, u.username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个页面');
    await sql`DELETE FROM ispace.marketplace_listings WHERE app_id = ${appId}`;
    await sql`DELETE FROM ispace.app_installs WHERE app_id = ${appId} AND source = 'marketplace'`;
    await writeAudit(sql, {
      actorId: admin.id, action: 'app.takedown', targetType: 'app', targetId: appId,
      source: 'console', result: 'success',
      metadata: { app: row.name, owner: row.username, reason: reason ?? null },
      ip: req.ip,
    });
    return { ok: true };
  });

  app.post(`${API_BASE}/admin/apps/:appId/restore`, async (req) => {
    const admin = await requireAdmin(req);
    const { appId } = req.params as { appId: string };
    const [row] = await sql<{ name: string; username: string }[]>`
      UPDATE ispace.apps a SET status = 'running'
       FROM ispace.users u
       WHERE a.id = ${appId} AND a.owner_id = u.id
      RETURNING a.name, u.username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个页面');
    await writeAudit(sql, {
      actorId: admin.id, action: 'app.restore', targetType: 'app', targetId: appId,
      source: 'console', result: 'success',
      metadata: { app: row.name, owner: row.username },
      ip: req.ip,
    });
    return { ok: true };
  });

  // 后端同构：status='stopped' 时 svc-proxy.ts 同样一律 404（'failed' 也是，
  // 但那是编排器自己报的故障态，不是下架该设的值）。不调用编排器——
  // 跟「创意市场：管理员下架（后端）」一样是轻量 DB 操作，容器本身不动，
  // restore 时原样能起来；真要连容器一起收回资源，走的是离职回收那条重路径。
  app.post(`${API_BASE}/admin/backends/:backendId/takedown`, async (req) => {
    const admin = await requireAdmin(req);
    const { backendId } = req.params as { backendId: string };
    const { reason } = takedownBodySchema.parse(req.body ?? {});
    const [row] = await sql<{ name: string; username: string }[]>`
      UPDATE ispace.backends b SET status = 'stopped'
       FROM ispace.users u
       WHERE b.id = ${backendId} AND b.owner_id = u.id
      RETURNING b.name, u.username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个后端');
    await sql`DELETE FROM ispace.marketplace_listings WHERE backend_id = ${backendId}`;
    await sql`DELETE FROM ispace.backend_installs WHERE backend_id = ${backendId}`;
    await writeAudit(sql, {
      actorId: admin.id, action: 'backend.takedown', targetType: 'backend', targetId: backendId,
      source: 'console', result: 'success',
      metadata: { name: row.name, owner: row.username, reason: reason ?? null },
      ip: req.ip,
    });
    return { ok: true };
  });

  app.post(`${API_BASE}/admin/backends/:backendId/restore`, async (req) => {
    const admin = await requireAdmin(req);
    const { backendId } = req.params as { backendId: string };
    const [row] = await sql<{ name: string; username: string }[]>`
      UPDATE ispace.backends b SET status = 'running'
       FROM ispace.users u
       WHERE b.id = ${backendId} AND b.owner_id = u.id
      RETURNING b.name, u.username
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个后端');
    await writeAudit(sql, {
      actorId: admin.id, action: 'backend.restore', targetType: 'backend', targetId: backendId,
      source: 'console', result: 'success',
      metadata: { name: row.name, owner: row.username },
      ip: req.ip,
    });
    return { ok: true };
  });

  // ── 阻断复核 ──────────────────────────────────────────────────────
  /**
   * 被密钥扫描拦下的发布。
   *
   * 此前只能在审计日志里翻——而审计是按时间倒序的全量流水，
   * 一天几百条正常发布里夹着一条 blocked，实际没有人会发现。
   * 这里把它们单独拎出来，并带上命中的规则，让管理员能判断
   * 是真泄露还是误报（误报要调扫描规则，真泄露要通知本人换密钥）。
   */
  app.get(`${API_BASE}/admin/blocked`, async (req) => {
    await requireAdmin(req);
    const rows = await sql`
      SELECT l.id, l.created_at, l.target_type, l.target_id, l.metadata,
             u.username, u.display_name
        FROM ispace.audit_logs l
        JOIN ispace.users u ON u.id = l.actor_id
       WHERE l.result = 'blocked'
       ORDER BY l.created_at DESC
       LIMIT 100
    `;
    return { items: rows };
  });
}
