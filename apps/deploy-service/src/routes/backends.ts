import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE, DEFAULT_QUOTAS, ERROR_CODES, IspaceError,
  createBackendRequestSchema, type User,
} from '@ispace/contracts';
import { getPlatformPolicy, getQuota, writeAudit, type Sql } from '@ispace/db';
import { createBackend, toBackend } from '../services/backend.js';
import { backendUrlPath, type Orchestrator } from '@ispace/orchestrator';

/**
 * 自定义后端（技术方案 §4.4）。
 *
 * 纯网页不需要后端。需要长连接、定时任务、Python 服务时才申请；
 * 每人默认上限 2 个，单个 0.5 vCPU / 512 MB，**由平台在建应用时强制写入**
 * ——限额写入发生在 orchestrator.createBackendApp 内部，不在这里，
 * 因为一次漏调就意味着一个没有上限的后端能拖垮同机其他服务。
 */
export function registerBackendRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    orchestrator: Orchestrator;
    publicHost: string;
    requireAuth: (req: FastifyRequest) => Promise<User>;
  },
): void {
  const { sql, orchestrator, publicHost, requireAuth } = deps;

  // ── 列表 ──────────────────────────────────────────────────────────
  app.get(`${API_BASE}/backends`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql`
      SELECT * FROM ispace.backends WHERE owner_id = ${me.id} ORDER BY created_at
    `;
    const backends = rows.map((r) => toBackend(r as Record<string, unknown>));

    // 状态从编排器实时取。库里的 status 只是最后一次已知值，容器可能
    // 已经挂了——控制台显示"运行中"而实际不可用，比显示"未知"更糟。
    // 关联页面的 slug 一起带出来，前端才显示得出"服务于 /paiban"
    const linked = await sql<{ id: string; slug: string }[]>`
      SELECT a.id, a.slug FROM ispace.apps a WHERE a.owner_id = ${me.id}
    `;
    const slugOf = new Map(linked.map((a) => [a.id, a.slug]));

    const withStatus = await Promise.all(
      backends.map(async (b) => {
        const appSlug = b.appId ? slugOf.get(b.appId) ?? null : null;
        if (!b.orchestratorRef) return { ...b, appSlug };
        const live = await orchestrator
          .getStatus({ id: b.orchestratorRef, urlPath: b.urlPath })
          .catch(() => 'failed' as const);
        /*
          刚创建的那几十秒里，编排器可能还报 idle（部署任务尚未开始），
          而 idle 映射过来是 stopped——于是新建的后端会先闪一下"已停止"，
          再变成"构建中"。用户看到的是"刚建好就停了"，会去点重启。

          创建后 2 分钟内不接受 stopped：这段时间以我们自己的 creating 为准。
          真的部署失败会走 error → failed，不受这条影响。
        */
        const justCreated = Date.now() - new Date(b.createdAt).getTime() < 2 * 60_000;
        const effective = live === 'stopped' && justCreated && b.status === 'creating'
          ? 'creating' as const
          : live;

        if (effective !== b.status) {
          await sql`UPDATE ispace.backends SET status = ${effective} WHERE id = ${b.id}`;
        }
        return { ...b, status: effective, appSlug: b.appId ? slugOf.get(b.appId) ?? null : null };
      }),
    );

    // 限额取自库里的平台策略，不是常量——管理员改过之后这里要跟着变，
    // 否则员工看到的上限和实际强制写入的对不上。
    const policy = await getPlatformPolicy(sql);
    return {
      backends: withStatus,
      limits: {
        cpu: Number(policy.backendCpuLimit),
        memoryMb: Math.round(policy.backendMemoryBytes / 1024 / 1024),
        count: policy.backendCountLimit,
      },
      orchestrator: orchestrator.name,
    };
  });

  // ── 创建 ──────────────────────────────────────────────────────────
  app.post(`${API_BASE}/backends`, async (req) => {
    const me = await requireAuth(req);
    const input = createBackendRequestSchema.parse(req.body);

    return createBackend(
      { sql, orchestrator, publicHost, urlPathFor: backendUrlPath },
      {
        user: me, name: input.name, sourceRepo: input.sourceRepo,
        port: input.port, appSlug: input.appSlug,
        source: 'console', clientIp: req.ip,
      },
    );
  });

  // ── 重启 ──────────────────────────────────────────────────────────
  /**
   * 重新配置源并部署。
   *
   * 存在的理由很具体：修复"创建时从没配过源、从没触发过部署"这个 bug 之前
   * 建出来的后端，在编排器里是个空壳——永远停在 idle，重启也没用
   * （没有源，重启什么呢）。删了重建会丢掉访问地址，而那个地址可能已经
   * 发给别人了。这条路让它们就地救回来。
   *
   * 平时也用得上：改了镜像 tag、推了新代码，重新部署一次即可。
   */
  app.post(`${API_BASE}/backends/:id/redeploy`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await sql`
      SELECT * FROM ispace.backends WHERE id = ${id} AND owner_id = ${me.id}
    `;
    const b = rows[0] ? toBackend(rows[0] as Record<string, unknown>) : null;
    if (!b) throw new IspaceError(ERROR_CODES.NOT_FOUND, '后端应用不存在');
    if (!b.orchestratorRef) {
      throw new IspaceError(ERROR_CODES.ORCHESTRATOR_UNAVAILABLE, '该后端尚未创建成功，请删除后重建');
    }
    if (!b.sourceRepo) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        '这个后端没有记录源（Git 仓库或镜像），没法部署。请删除后重建。',
      );
    }

    await orchestrator.deploySource({ id: b.orchestratorRef, urlPath: b.urlPath }, b.sourceRepo);
    await sql`UPDATE ispace.backends SET status = 'creating' WHERE id = ${id}`;
    await writeAudit(sql, {
      actorId: me.id, action: 'backend.restart', targetType: 'backend', targetId: id,
      source: 'console', result: 'success',
      metadata: { name: b.name, redeploy: true, source: b.sourceRepo },
      ip: req.ip,
    });
    return { ok: true, status: 'creating' };
  });

  /**
   * 最近一次部署的日志。
   *
   * 用户建后端撞上「启动失败」时，界面上除了这四个字什么都没有——
   * 真正的原因（镜像拉不到、构建报错、端口不对）只有这里能看到。
   * 只给本人看：日志里可能带仓库地址、构建参数等他自己的东西。
   */
  app.get(`${API_BASE}/backends/:id/logs`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await sql`
      SELECT * FROM ispace.backends WHERE id = ${id} AND owner_id = ${me.id}
    `;
    const b = rows[0] ? toBackend(rows[0] as Record<string, unknown>) : null;
    if (!b) throw new IspaceError(ERROR_CODES.NOT_FOUND, '后端应用不存在');
    if (!b.orchestratorRef) return { log: null, reason: '这个后端没建成功，编排器里没有对应记录。' };

    const log = await orchestrator.deployLog(
      { id: b.orchestratorRef, urlPath: b.urlPath }, 60,
    );
    return { log, reason: log ? null : '暂时拿不到部署日志，稍后再试或联系管理员。' };
  });

  app.post(`${API_BASE}/backends/:id/restart`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await sql`
      SELECT * FROM ispace.backends WHERE id = ${id} AND owner_id = ${me.id}
    `;
    const b = rows[0] ? toBackend(rows[0] as Record<string, unknown>) : null;
    if (!b) throw new IspaceError(ERROR_CODES.NOT_FOUND, '后端应用不存在');
    if (!b.orchestratorRef) {
      throw new IspaceError(ERROR_CODES.ORCHESTRATOR_UNAVAILABLE, '该后端尚未创建成功，无法重启');
    }
    await orchestrator.restart({ id: b.orchestratorRef, urlPath: b.urlPath });
    await writeAudit(sql, {
      actorId: me.id, action: 'backend.restart', targetType: 'backend', targetId: id,
      source: 'console', result: 'success', metadata: { name: b.name },
      ip: req.ip,
    });
    return { ok: true };
  });

  // ── 删除 ──────────────────────────────────────────────────────────
  app.delete(`${API_BASE}/backends/:id`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await sql`
      SELECT * FROM ispace.backends WHERE id = ${id} AND owner_id = ${me.id}
    `;
    const b = rows[0] ? toBackend(rows[0] as Record<string, unknown>) : null;
    if (!b) throw new IspaceError(ERROR_CODES.NOT_FOUND, '后端应用不存在');

    if (b.orchestratorRef) {
      // 编排器删除失败不阻断库记录清理：容器可能已被手工删掉，
      // 此时若因为编排器报错就拒绝清库，用户会永远占着一个配额名额。
      await orchestrator
        .remove({ id: b.orchestratorRef, urlPath: b.urlPath })
        .catch(() => { app.log.warn(`编排器删除 ${b.orchestratorRef} 失败，继续清理库记录`); });
    }
    await sql`DELETE FROM ispace.backends WHERE id = ${id}`;
    await sql`
      UPDATE ispace.quotas
         SET backend_count_used = GREATEST(backend_count_used - 1, 0), updated_at = now()
       WHERE user_id = ${me.id}
    `;
    return { ok: true };
  });
}
