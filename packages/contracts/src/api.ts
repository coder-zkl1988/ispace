import { z } from 'zod';
import {
  appGroupSchema,
  appSchema,
  appTypeSchema,
  auditLogSchema,
  backendSchema,
  quotaSchema,
  releaseSchema,
  shareSchema,
  userSchema,
} from './entities.js';
import { appSlugSchema, usernameSchema } from './reserved.js';

/**
 * deploy-service 的 REST 契约。挂载于 `/deploy/api`。
 * 所有端点要求平台 SSO 签发的 token；全量操作进审计日志。
 */

export const API_BASE = '/deploy/api';

// ── 通用 ──────────────────────────────────────────────────────────────
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

/** 当前登录者。所有需要"我是谁"的界面从这里取。 */
export const meResponseSchema = z.object({
  user: userSchema,
  quota: quotaSchema,
  /** 用户空间地址，形如 ispace.example.com/lixiao */
  spaceUrl: z.string(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// ── 部署 ──────────────────────────────────────────────────────────────
/**
 * 上传前端构建产物。
 * 产物为 zip，multipart 上传；元信息随表单字段传。
 * 服务端顺序：接收 → 密钥扫描 → XSS 扫描 → base path 校验 → 注入 shell.js
 *            → 解压至 releases/{ts} → 原子切换软链 → 写库与审计。
 */
export const deployRequestSchema = z.object({
  slug: appSlugSchema,
  /** 首次部署时用于建应用；后续可省略，保持原值。 */
  name: z.string().min(1).max(32).optional(),
  description: z.string().max(200).optional(),
  type: appTypeSchema.default('static'),
  source: z.enum(['mcp', 'cli', 'agent', 'console']),
});
export type DeployRequest = z.infer<typeof deployRequestSchema>;

export const deployResponseSchema = z.object({
  app: appSchema,
  release: releaseSchema,
  url: z.string(),
});
export type DeployResponse = z.infer<typeof deployResponseSchema>;

export const rollbackRequestSchema = z.object({
  /** 省略则回滚到上一个 active 之前的版本。 */
  toVersion: z.number().int().positive().optional(),
});

export const releaseListResponseSchema = z.object({
  releases: z.array(releaseSchema),
  total: z.number().int().nonnegative(),
});

// ── 应用与分组 ────────────────────────────────────────────────────────
export const appListQuerySchema = paginationSchema.extend({
  status: z.enum(['all', 'running', 'building', 'stopped']).default('all'),
  type: z.enum(['all', 'static', 'static_backend', 'h5']).default('all'),
  q: z.string().max(64).optional(),
});

/** 聚合页与控制台「我的页面」共用。分组与应用一并返回，避免两次往返。 */
export const appListResponseSchema = z.object({
  groups: z.array(appGroupSchema),
  apps: z.array(appSchema),
  total: z.number().int().nonnegative(),
});
export type AppListResponse = z.infer<typeof appListResponseSchema>;

export const updateAppRequestSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  description: z.string().max(200).nullable().optional(),
  groupId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

// ── 开通 ──────────────────────────────────────────────────────────────
/**
 * 开通一位员工：建静态目录 + 建 Supabase schema + 登记用户路径 + 初始化配额。
 *
 * ⚠️ Supabase schema 部分的执行顺序不可调换（计划 1 实测）：
 *    建 schema → 校验存在 → 改 pgrst.db_schemas → NOTIFY reload config
 *    → NOTIFY reload schema。若先改配置而 schema 不存在，PostgREST 会进入
 *    重连循环，/rest/v1/* 对全部用户返回 503。
 */
export const provisionRequestSchema = z.object({
  username: usernameSchema,
  displayName: z.string().min(1).max(64),
  email: z.string().email().optional(),
  role: z.enum(['employee', 'admin']).default('employee'),
  identity: z.enum(['user', 'developer']).default('user'),
});
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;

export const provisionResponseSchema = z.object({
  user: userSchema,
  schemaName: z.string(),
  spaceUrl: z.string(),
});

// ── 后端应用 ──────────────────────────────────────────────────────────
export const createBackendRequestSchema = z.object({
  name: z.string().min(1).max(32),
  appSlug: appSlugSchema.optional(),
  sourceRepo: z.string().min(1),
  /**
   * 容器内监听的端口。
   *
   * 必须能填。默认 3000 对 Node 应用合适，但换成 nginx（80）、
   * Python 那套（8000）就全错——而错的表现是访问地址 502：
   * 容器明明起来了、平台显示"运行中"，就是打不开。
   * 那是最难自己想明白的一种坏法。
   */
  port: z.number().int().min(1).max(65535).default(3000),
  /** 全栈项目（带前台、要露出到空间）置 true；纯 API 服务默认 false。 */
  exposed: z.boolean().default(false),
});

/** 改后端的露出/可见性。只这两项可改，别的（源、端口）走重建。 */
export const updateBackendSchema = z.object({
  exposed: z.boolean().optional(),
  visibility: z.enum(['private', 'shared', 'public']).optional(),
});

export const backendListResponseSchema = z.object({
  backends: z.array(backendSchema),
});

// ── 配额 ──────────────────────────────────────────────────────────────
export const quotaResponseSchema = z.object({
  quota: quotaSchema,
  /** 后端限额是每个应用的上限，不随用户变化，单独给前端展示用。 */
  backendCpuLimit: z.number(),
  backendMemLimitMb: z.number().int(),
});

// ── 分享 ──────────────────────────────────────────────────────────────
export const createShareRequestSchema = z.object({
  appId: z.string().uuid(),
  /** 按用户名分享，与界面里输入同事标识的交互一致。 */
  toUsername: usernameSchema,
});

export const respondShareRequestSchema = z.object({
  accept: z.boolean(),
});

/** 聚合页顶部的待接受卡列表。 */
export const pendingSharesResponseSchema = z.object({
  shares: z.array(
    shareSchema.extend({
      app: appSchema,
      fromUser: userSchema.pick({ id: true, username: true, displayName: true }),
    }),
  ),
});
export type PendingSharesResponse = z.infer<typeof pendingSharesResponseSchema>;

// ── 审计 ──────────────────────────────────────────────────────────────
export const auditListQuerySchema = paginationSchema.extend({
  result: z.enum(['all', 'success', 'blocked', 'failed']).default('all'),
});

export const auditListResponseSchema = z.object({
  logs: z.array(
    auditLogSchema.extend({
      actor: userSchema.pick({ id: true, username: true, displayName: true }),
    }),
  ),
  total: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
});

// ── 管理员 ────────────────────────────────────────────────────────────
/** 设计稿管理员「平台总览」屏。 */
export const platformOverviewResponseSchema = z.object({
  userCount: z.number().int().nonnegative(),
  userCountDelta: z.number().int(),
  appCount: z.number().int().nonnegative(),
  backendCount: z.number().int().nonnegative(),
  weeklyDeployCount: z.number().int().nonnegative(),
  weeklyDeployDeltaPercent: z.number(),
  /** 近 14 天每日发布次数，用于趋势图。 */
  deployTrend: z.array(z.object({ date: z.string(), count: z.number().int() })),
  /** 占用最多的员工空间，设计稿显示前 5。 */
  topSpaces: z.array(
    z.object({ username: z.string(), displayName: z.string(), bytes: z.number().int() }),
  ),
});

/** 路由清单：前后端共用，避免两处手写字符串漂移。 */
export const ROUTES = {
  me: `${API_BASE}/me`,
  apps: `${API_BASE}/apps`,
  app: (slug: string) => `${API_BASE}/apps/${slug}`,
  deploy: (slug: string) => `${API_BASE}/apps/${slug}/deploy`,
  rollback: (slug: string) => `${API_BASE}/apps/${slug}/rollback`,
  releases: (slug: string) => `${API_BASE}/apps/${slug}/releases`,
  groups: `${API_BASE}/groups`,
  provision: `${API_BASE}/provision`,
  backends: `${API_BASE}/backends`,
  quota: `${API_BASE}/quota`,
  shares: `${API_BASE}/shares`,
  share: (id: string) => `${API_BASE}/shares/${id}`,
  pendingShares: `${API_BASE}/shares/pending`,
  audit: `${API_BASE}/audit`,
  adminOverview: `${API_BASE}/admin/overview`,
  health: `${API_BASE}/health`,
} as const;
