import type { FastifyInstance } from 'fastify';
import { getPlatformPolicy, writeAudit, type Sql } from '@ispace/db';

/**
 * 治理定时任务（规格 §9）。
 *
 * 三项，都是「规格里写了但没人执行就等于没有」的那类：
 *   - 审计日志保留 12 个月
 *   - 90 天无访问的应用先通知后归档
 *   - 配额用量重算（磁盘可能被外部改动，库里的数不能只增不校）
 *
 * 用进程内定时器而非系统 cron：
 *   - 服务重启即重新调度，不会留下指向旧容器的 cron 条目
 *   - 与业务代码共用连接池与审计写入，不必再维护一套凭据分发
 *   - 单实例部署下没有重复执行问题；将来多实例时需要改成带锁的调度，
 *     这一点写在下面的 NOTE 里，不要默默多跑
 *
 * NOTE(多实例)：当前假定 deploy-service 只有一个实例。横向扩容时，
 * 必须改为基于 Postgres advisory lock 的抢占式调度，否则每个实例都会
 * 各跑一遍——归档会重复写审计，用量重算会互相覆盖。
 */

const HOUR = 60 * 60 * 1000;

export function startMaintenanceJobs(app: FastifyInstance, sql: Sql): () => void {
  const timers: NodeJS.Timeout[] = [];

  const every = (hours: number, name: string, fn: () => Promise<void>) => {
    const run = () => {
      void fn().catch((e: unknown) => {
        // 定时任务失败不能拖垮服务，但必须留下痕迹——静默失败的清理任务
        // 会让磁盘和库悄悄涨到出事那天
        app.log.error({ err: e, job: name }, `定时任务 ${name} 失败`);
      });
    };
    // 启动后延迟一小段再首跑，避免与服务启动、迁移抢连接
    timers.push(setTimeout(run, 30_000));
    timers.push(setInterval(run, hours * HOUR));
  };

  /*
    保留期与归档天数每轮现读，不在启动时读一次缓存下来。
    这两个任务 24 小时才跑一次，多一次主键查询的代价可以忽略；
    而缓存的代价是管理员改完设置后要等到下次重启才生效——
    那在界面上表现为"改了没用"。
  */

  // ── 审计日志保留期 ────────────────────────────────────────────────
  every(24, 'audit-retention', async () => {
    const { auditRetentionMonths } = await getPlatformPolicy(sql);
    const rows = await sql<{ n: string }[]>`
      WITH del AS (
        DELETE FROM ispace.audit_logs
         WHERE created_at < now() - (${auditRetentionMonths} || ' months')::interval
        RETURNING 1
      ) SELECT count(*)::text AS n FROM del
    `;
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) app.log.info(`审计日志清理：删除 ${n} 条超过 ${auditRetentionMonths} 个月的记录`);
  });

  // ── 闲置应用归档 ──────────────────────────────────────────────────
  // 「先通知后归档」：这里只做归档，通知渠道未定（方案未指定 IM 集成），
  // 因此归档前留 7 天缓冲，并在审计里留痕，让管理员在「平台巡检」看得到。
  every(24, 'idle-archive', async () => {
    const { idleArchiveDays } = await getPlatformPolicy(sql);
    const stale = await sql<{ id: string; slug: string; owner_id: string }[]>`
      SELECT id, slug, owner_id FROM ispace.apps
       WHERE status = 'running'
         AND COALESCE(last_accessed_at, created_at) < now() - (${idleArchiveDays + 7} || ' days')::interval
    `;
    for (const a of stale) {
      await sql`UPDATE ispace.apps SET status = 'stopped', updated_at = now() WHERE id = ${a.id}`;
      await writeAudit(sql, {
        actorId: a.owner_id, action: 'app.delete', targetType: 'app', targetId: a.id,
        source: 'console', result: 'success',
        metadata: { slug: a.slug, reason: 'idle-archive', idleDays: idleArchiveDays },
      });
    }
    if (stale.length) app.log.info(`闲置归档：${stale.length} 个应用已停用`);
  });

  // ── 配额用量重算 ──────────────────────────────────────────────────
  // 磁盘可能被运维手工改动，库里的累计值会与实际漂移。
  every(6, 'quota-recalc', async () => {
    await sql`
      UPDATE ispace.quotas q
         SET storage_bytes_used = COALESCE(
               (SELECT SUM(a.size_bytes) FROM ispace.apps a WHERE a.owner_id = q.user_id), 0),
             backend_count_used = COALESCE(
               (SELECT count(*) FROM ispace.backends b WHERE b.owner_id = q.user_id), 0),
             updated_at = now()
    `;
  });

  app.log.info('治理定时任务已启动：审计清理(24h) / 闲置归档(24h) / 配额重算(6h)');

  return () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } };
}
