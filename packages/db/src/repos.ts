import { isIP } from 'node:net';
import type { Sql } from 'postgres';
import {
  AUDIT_RETENTION_MONTHS,
  DEFAULT_QUOTAS,
  ERROR_CODES,
  IDLE_ARCHIVE_DAYS,
  IspaceError,
  type App,
  type AuditLog,
  type Quota,
  type Release,
  type User,
} from '@ispace/contracts';

/**
 * 数据访问层。
 *
 * 有意保持"薄"：只做 SQL 与行对象的映射，不含业务判断。配额检查、扫描阻断、
 * 发布编排等决策全在 apps/deploy-service 的服务层，便于单测时替换。
 *
 * 列名 snake_case → 属性名 camelCase 的转换在每个映射函数里显式写出，
 * 不用自动转换库——自动转换在遇到 `db_rows_used` 这类含缩写的列名时
 * 容易产生意外结果，且出错时难定位。
 */

// ── 行映射 ────────────────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
const toUser = (r: any): User => ({
  id: r.id,
  ssoSubject: r.sso_subject,
  username: r.username,
  displayName: r.display_name,
  email: r.email,
  role: r.role,
  identity: r.identity,
  status: r.status,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

const toApp = (r: any): App => ({
  id: r.id,
  ownerId: r.owner_id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  iconLetter: r.icon_letter,
  coverUrl: r.cover_path ?? null,
  type: r.type,
  status: r.status,
  currentReleaseId: r.current_release_id,
  groupId: r.group_id,
  sortOrder: r.sort_order,
  visibility: r.visibility,
  sizeBytes: Number(r.size_bytes),
  lastAccessedAt: r.last_accessed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  sourcePrompt: r.source_prompt ?? null,
});

const toRelease = (r: any): Release => ({
  id: r.id,
  appId: r.app_id,
  version: r.version,
  source: r.source,
  status: r.status,
  sizeBytes: Number(r.size_bytes),
  path: r.path,
  publishedBy: r.published_by,
  publishedAt: r.published_at,
  blockedReason: r.blocked_reason,
});

const toQuota = (r: any): Quota => ({
  userId: r.user_id,
  storageBytesUsed: Number(r.storage_bytes_used),
  storageBytesLimit: Number(r.storage_bytes_limit),
  backendCountUsed: r.backend_count_used,
  backendCountLimit: r.backend_count_limit,
  dbRowsUsed: Number(r.db_rows_used),
  dbRowsLimit: Number(r.db_rows_limit),
  updatedAt: r.updated_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── users ─────────────────────────────────────────────────────────────
export async function findUserByUsername(sql: Sql, username: string): Promise<User | null> {
  const rows = await sql`SELECT * FROM ispace.users WHERE username = ${username}`;
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserBySso(sql: Sql, ssoSubject: string): Promise<User | null> {
  const rows = await sql`SELECT * FROM ispace.users WHERE sso_subject = ${ssoSubject}`;
  return rows[0] ? toUser(rows[0]) : null;
}

export async function findUserById(sql: Sql, id: string): Promise<User | null> {
  const rows = await sql`SELECT * FROM ispace.users WHERE id = ${id}`;
  return rows[0] ? toUser(rows[0]) : null;
}

export async function createUser(
  sql: Sql,
  input: {
    ssoSubject: string;
    username: string;
    displayName: string;
    email?: string | null;
    role?: 'employee' | 'admin';
    identity?: 'user' | 'developer';
  },
): Promise<User> {
  const rows = await sql`
    INSERT INTO ispace.users (sso_subject, username, display_name, email, role, identity)
    VALUES (${input.ssoSubject}, ${input.username}, ${input.displayName},
            ${input.email ?? null}, ${input.role ?? 'employee'}, ${input.identity ?? 'user'})
    RETURNING *
  `;
  const user = toUser(rows[0]);
  // 配额行与用户同生共死，缺了会导致控制台读不到配额而报错
  await sql`
    INSERT INTO ispace.quotas (user_id, storage_bytes_limit, backend_count_limit, db_rows_limit)
    VALUES (${user.id}, ${DEFAULT_QUOTAS.storageBytesLimit},
            ${DEFAULT_QUOTAS.backendCountLimit}, ${DEFAULT_QUOTAS.dbRowsLimit})
    ON CONFLICT (user_id) DO NOTHING
  `;
  return user;
}

// ── apps ──────────────────────────────────────────────────────────────
export async function listAppsByOwner(sql: Sql, ownerId: string): Promise<App[]> {
  const rows = await sql`
    SELECT * FROM ispace.apps WHERE owner_id = ${ownerId}
    ORDER BY sort_order, created_at
  `;
  return rows.map(toApp);
}

export async function findApp(sql: Sql, ownerId: string, slug: string): Promise<App | null> {
  const rows = await sql`
    SELECT * FROM ispace.apps WHERE owner_id = ${ownerId} AND slug = ${slug}
  `;
  return rows[0] ? toApp(rows[0]) : null;
}

export async function upsertApp(
  sql: Sql,
  input: {
    ownerId: string;
    slug: string;
    name: string;
    description?: string | null;
    iconLetter?: string;
    type?: 'static' | 'static_backend' | 'h5';
    /** 「做同款」用的提示词。省略时保留已有的，不会被一次无提示词的发布抹掉。 */
    sourcePrompt?: string | null;
  },
): Promise<App> {
  const rows = await sql`
    INSERT INTO ispace.apps (owner_id, slug, name, description, icon_letter, type, status, source_prompt)
    VALUES (${input.ownerId}, ${input.slug}, ${input.name}, ${input.description ?? null},
            ${input.iconLetter ?? input.name.slice(0, 1)}, ${input.type ?? 'static'}, 'building',
            ${input.sourcePrompt ?? null})
    ON CONFLICT (owner_id, slug) DO UPDATE SET
      name          = EXCLUDED.name,
      description   = COALESCE(EXCLUDED.description, ispace.apps.description),
      source_prompt = COALESCE(EXCLUDED.source_prompt, ispace.apps.source_prompt),
      status        = 'building',
      updated_at    = now()
    RETURNING *
  `;
  return toApp(rows[0]);
}

export async function setAppStatus(
  sql: Sql,
  appId: string,
  status: 'running' | 'building' | 'stopped',
): Promise<void> {
  await sql`UPDATE ispace.apps SET status = ${status}, updated_at = now() WHERE id = ${appId}`;
}

// ── releases ──────────────────────────────────────────────────────────
export async function nextVersion(sql: Sql, appId: string): Promise<number> {
  const rows = await sql<{ v: number | null }[]>`
    SELECT MAX(version) AS v FROM ispace.releases WHERE app_id = ${appId}
  `;
  return (rows[0]?.v ?? 0) + 1;
}

export async function listReleases(sql: Sql, appId: string): Promise<Release[]> {
  const rows = await sql`
    SELECT * FROM ispace.releases WHERE app_id = ${appId} ORDER BY version DESC
  `;
  return rows.map(toRelease);
}

/**
 * 记录一次成功发布：把旧的 active 置为 superseded，插入新 active，更新应用。
 *
 * 三步必须在一个事务里。releases_one_active_per_app 是部分唯一索引，
 * 若分开执行，并发发布会在插入新 active 时撞索引；同一事务内先降级再插入
 * 则不会。索引本身也是防线——它保证库里不会出现两个 active 而软链只能
 * 指向一个的库磁不一致。
 */
export async function recordActiveRelease(
  sql: Sql,
  input: {
    appId: string;
    version: number;
    source: 'mcp' | 'cli' | 'agent' | 'console';
    sizeBytes: number;
    path: string;
    publishedBy: string;
  },
): Promise<Release> {
  return sql.begin(async (tx) => {
    await tx`
      UPDATE ispace.releases SET status = 'superseded'
       WHERE app_id = ${input.appId} AND status = 'active'
    `;
    const rows = await tx`
      INSERT INTO ispace.releases (app_id, version, source, status, size_bytes, path, published_by)
      VALUES (${input.appId}, ${input.version}, ${input.source}, 'active',
              ${input.sizeBytes}, ${input.path}, ${input.publishedBy})
      RETURNING *
    `;
    const rel = toRelease(rows[0]);
    await tx`
      UPDATE ispace.apps
         SET current_release_id = ${rel.id},
             status = 'running',
             size_bytes = ${input.sizeBytes},
             updated_at = now()
       WHERE id = ${input.appId}
    `;
    return rel;
  }) as Promise<Release>;
}

/** 记录一次被扫描阻断的发布。不产生 active 版本，但必须留痕。 */
export async function recordBlockedRelease(
  sql: Sql,
  input: {
    appId: string;
    version: number;
    source: 'mcp' | 'cli' | 'agent' | 'console';
    publishedBy: string;
    reason: string;
  },
): Promise<Release> {
  const rows = await sql`
    INSERT INTO ispace.releases (app_id, version, source, status, size_bytes, path, published_by, blocked_reason)
    VALUES (${input.appId}, ${input.version}, ${input.source}, 'blocked', 0, '', ${input.publishedBy}, ${input.reason})
    RETURNING *
  `;
  return toRelease(rows[0]);
}

/** 回滚：把目标版本置为 active，原 active 置为 superseded。 */
export async function activateRelease(
  sql: Sql,
  appId: string,
  version: number,
): Promise<Release> {
  return sql.begin(async (tx) => {
    const target = await tx`
      SELECT * FROM ispace.releases
       WHERE app_id = ${appId} AND version = ${version} AND status IN ('active','superseded')
    `;
    if (!target[0]) {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, `版本 v${version} 不存在或不可回滚`);
    }
    await tx`
      UPDATE ispace.releases SET status = 'superseded'
       WHERE app_id = ${appId} AND status = 'active'
    `;
    const rows = await tx`
      UPDATE ispace.releases SET status = 'active'
       WHERE app_id = ${appId} AND version = ${version}
      RETURNING *
    `;
    const rel = toRelease(rows[0]);
    await tx`
      UPDATE ispace.apps
         SET current_release_id = ${rel.id}, status = 'running',
             size_bytes = ${rel.sizeBytes}, updated_at = now()
       WHERE id = ${appId}
    `;
    return rel;
  }) as Promise<Release>;
}

// ── quotas ────────────────────────────────────────────────────────────
export async function getQuota(sql: Sql, userId: string): Promise<Quota> {
  const rows = await sql`SELECT * FROM ispace.quotas WHERE user_id = ${userId}`;
  if (!rows[0]) {
    throw new IspaceError(ERROR_CODES.NOT_FOUND, '配额记录不存在，用户可能未正确开通');
  }
  return toQuota(rows[0]);
}

/** 重算某用户的静态空间占用。以 apps.size_bytes 之和为准。 */
export async function refreshStorageUsage(sql: Sql, userId: string): Promise<void> {
  await sql`
    UPDATE ispace.quotas q
       SET storage_bytes_used = COALESCE(
             (SELECT SUM(size_bytes) FROM ispace.apps WHERE owner_id = ${userId}), 0),
           updated_at = now()
     WHERE q.user_id = ${userId}
  `;
}

// ── audit ─────────────────────────────────────────────────────────────
export async function writeAudit(
  sql: Sql,
  input: {
    actorId: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    source: 'mcp' | 'cli' | 'agent' | 'console';
    result: 'success' | 'blocked' | 'failed';
    metadata?: Record<string, unknown> | null;
    /**
     * 来源 IP。设计稿「审计与安全」有 IP 列——出了事要能回答"谁、从哪儿"。
     *
     * 可空：定时任务与内部调用没有请求上下文。传空串或非法值时写 NULL
     * 而不是让整条审计写入失败——审计记录不上去比 IP 缺失严重得多。
     */
    ip?: string | null;
  },
): Promise<void> {
  // 用 net.isIP 而不是手写正则：正则会放行 "1.2.3.4.5" 和 ":::::" 这类
  // 看着像 IP 的串，它们进到 ::inet 会让整条审计写入抛错——而这个函数的
  // 全部意义就是"宁可 IP 缺失，也不能让审计记录写不进去"。
  const ip = input.ip && isIP(input.ip) ? input.ip : null;
  await sql`
    INSERT INTO ispace.audit_logs (actor_id, action, target_type, target_id, source, result, metadata, ip)
    VALUES (${input.actorId}, ${input.action}, ${input.targetType}, ${input.targetId ?? null},
            ${input.source}, ${input.result},
            ${input.metadata ? sql.json(input.metadata as never) : null},
            ${ip}::inet)
  `;
}

export async function listAudit(
  sql: Sql,
  opts: { actorId?: string; limit: number; offset: number },
): Promise<{ logs: (AuditLog & { actorUsername: string })[]; total: number; blocked: number }> {
  const where = opts.actorId ? sql`WHERE a.actor_id = ${opts.actorId}` : sql``;
  const rows = await sql`
    SELECT a.*, u.username AS actor_username, host(a.ip) AS ip_text
      FROM ispace.audit_logs a
      JOIN ispace.users u ON u.id = a.actor_id
      ${where}
     ORDER BY a.created_at DESC
     LIMIT ${opts.limit} OFFSET ${opts.offset}
  `;
  const [counts] = await sql<{ total: string; blocked: string }[]>`
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE result = 'blocked')::text AS blocked
      FROM ispace.audit_logs a ${where}
  `;
  return {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    logs: rows.map((r: any) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      source: r.source,
      result: r.result,
      metadata: r.metadata,
      createdAt: r.created_at,
      actorUsername: r.actor_username,
      // host() 去掉 inet 类型自带的掩码后缀（10.1.2.3/32 → 10.1.2.3）
      ip: r.ip_text ?? null,
    })),
    total: Number(counts?.total ?? 0),
    blocked: Number(counts?.blocked ?? 0),
  };
}

// ── platform_policy ───────────────────────────────────────────────────
export interface PlatformPolicy {
  // ── 资源默认值 ──
  backendCpuLimit: string;
  backendMemoryBytes: number;
  backendCountLimit: number;
  storageBytesLimit: number;

  // ── 账号准入 ──
  /** 允许注册的邮箱后缀。空数组 = 不限后缀。 */
  emailDomains: string[];
  selfRegisterEnabled: boolean;
  requireApproval: boolean;
  passwordMinLength: number;
  sessionDays: number;

  // ── 生命周期 ──
  idleArchiveDays: number;
  auditRetentionMonths: number;
  /** 访问令牌有效期上限（天）。0 = 不限期。 */
  tokenMaxDays: number;

  // ── 分享范围 ──
  allowPublicShare: boolean;
  allowPeerShare: boolean;
}

/**
 * 各项的兜底值。
 *
 * 只在「表还没有这些列」时用得到——也就是迁移 0006 跑完之前那一小段窗口。
 * 与迁移里的 DEFAULT 保持一致；两处不同会让升级前后的行为悄悄变化。
 */
const POLICY_FALLBACK = {
  emailDomains: ['example.com'],
  selfRegisterEnabled: true,
  requireApproval: false,
  passwordMinLength: 12,
  sessionDays: 30,
  idleArchiveDays: IDLE_ARCHIVE_DAYS,
  auditRetentionMonths: AUDIT_RETENTION_MONTHS,
  tokenMaxDays: 0,
  allowPublicShare: true,
  allowPeerShare: true,
} as const;

/** 把逗号分隔的后缀串解析成数组，顺手去空白与空项。 */
export function parseEmailDomains(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * 平台默认配额策略。管理员在「资源与配额」屏可改。
 *
 * 之所以要从库里读而不是用 DEFAULT_QUOTAS 常量：设计稿上那四个数字旁边有个
 * 「编辑策略」按钮。如果创建后端时仍走常量，那个按钮就是个摆设——改了之后
 * 前端显示新值、后端仍按旧值强制写入，两边永远对不上。
 *
 * 表读不到时回落到常量（迁移未跑完的窗口期），而不是让创建后端整个失败。
 */
export async function getPlatformPolicy(sql: Sql): Promise<PlatformPolicy> {
  // 只在"表还不存在"时回落到常量（迁移未跑完的窗口期）。
  // 原先 catch 掉所有错误：连接抖动那一下会让后端被静默地按默认限额创建，
  // 管理员配的策略无声失效——那比直接报错难查得多。42P01 = undefined_table
  const rows = await sql<Record<string, unknown>[]>`
    SELECT * FROM ispace.platform_policy WHERE id = true
  `.catch((e: { code?: string }) => {
    if (e?.code === '42P01') return [] as Record<string, unknown>[];
    throw e;
  });
  const r = rows[0];
  if (!r) {
    return {
      backendCpuLimit: String(DEFAULT_QUOTAS.backendCpuLimit),
      backendMemoryBytes: DEFAULT_QUOTAS.backendMemLimitMb * 1024 * 1024,
      backendCountLimit: DEFAULT_QUOTAS.backendCountLimit,
      storageBytesLimit: DEFAULT_QUOTAS.storageBytesLimit,
      ...POLICY_FALLBACK,
      emailDomains: [...POLICY_FALLBACK.emailDomains],
    };
  }

  /*
    逐列 ?? 兜底，而不是整行有无。迁移 0006 给这张单行表**加列**，
    表本身早就存在——所以"表在但列还没加"是真实存在的中间态
    （服务先起来、迁移随后跑完的那几秒）。整行判断兜不住这一段。
  */
  const num = (v: unknown, d: number) => (v == null ? d : Number(v));
  const bool = (v: unknown, d: boolean) => (v == null ? d : Boolean(v));

  return {
    backendCpuLimit: String(r.backend_cpu_limit ?? DEFAULT_QUOTAS.backendCpuLimit),
    backendMemoryBytes: num(r.backend_memory_bytes, DEFAULT_QUOTAS.backendMemLimitMb * 1024 * 1024),
    backendCountLimit: num(r.backend_count_limit, DEFAULT_QUOTAS.backendCountLimit),
    storageBytesLimit: num(r.storage_bytes_limit, DEFAULT_QUOTAS.storageBytesLimit),

    emailDomains: r.email_domains == null
      ? [...POLICY_FALLBACK.emailDomains]
      : parseEmailDomains(String(r.email_domains)),
    selfRegisterEnabled: bool(r.self_register_enabled, POLICY_FALLBACK.selfRegisterEnabled),
    requireApproval: bool(r.require_approval, POLICY_FALLBACK.requireApproval),
    passwordMinLength: num(r.password_min_length, POLICY_FALLBACK.passwordMinLength),
    sessionDays: num(r.session_days, POLICY_FALLBACK.sessionDays),

    idleArchiveDays: num(r.idle_archive_days, POLICY_FALLBACK.idleArchiveDays),
    auditRetentionMonths: num(r.audit_retention_months, POLICY_FALLBACK.auditRetentionMonths),
    tokenMaxDays: num(r.token_max_days, POLICY_FALLBACK.tokenMaxDays),

    allowPublicShare: bool(r.allow_public_share, POLICY_FALLBACK.allowPublicShare),
    allowPeerShare: bool(r.allow_peer_share, POLICY_FALLBACK.allowPeerShare),
  };
}
