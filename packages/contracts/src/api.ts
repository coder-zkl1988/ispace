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

/**
 * 头像的读取地址。放在 API_BASE 旁边，而不是 entities.ts 里 User 的旁边：
 * 那边放就得把 '/deploy/api' 再抄一遍（entities 不能 import 本文件，会循环）。
 *
 * `v` 是内容的 md5：换了头像地址就变，浏览器立刻取新的；没换就一直命中
 * 缓存。没有它的话要么每次都重新下载，要么换了头像半天不生效。
 */
export function avatarUrlFor(username: string, etag: string | null | undefined): string | null {
  return etag ? `${API_BASE}/users/${username}/avatar?v=${etag}` : null;
}

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
  /** 不给就保持这个页面原来的类型（新建时是 static）。给了 default 的话，每次不带 type 的重发都会把手机页面冲回电脑。 */
  type: appTypeSchema.optional(),
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
// ── 个人资料 ──────────────────────────────────────────────────────────
/**
 * 自己能改的资料。
 *
 * ┌─ 为什么只有显示名 ────────────────────────────────────────────────┐
 * │ username 是空间地址 `/{username}/`，所有已发布页面的链接都挂在     │
 * │ 上面——改名等于把同事收藏的、分享出去的、嵌在别处的地址一起弄断。  │
 * │ email 是登录和密码重置认的那一个，而平台没有邮件服务，验证不了新   │
 * │ 地址；能随手改邮箱，等于多了一条绕过管理员的改身份的路。          │
 * │                                                                    │
 * │ 这两项不是「不能改」，是「不该自助改」：找管理员在控制台改。      │
 * └────────────────────────────────────────────────────────────────────┘
 */
export const updateProfileRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
});
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

/**
 * 管理员替别人改资料。
 *
 * ┌─ 为什么没有 username ──────────────────────────────────────────────┐
 * │ 用户名不只是个显示用的名字，它派生出三样东西：                      │
 * │   1. Postgres schema `u_{username}`，里面是这个人自己建的数据表     │
 * │   2. /srv/sites/{username}/ 下已发布的站点目录                      │
 * │   3. 所有对外链接 /{username}/{app}/ ——同事的收藏、分享出去的地址、 │
 * │      手机壳里的通道，全挂在上面                                     │
 * │                                                                    │
 * │ 改名要把这三样一起搬，而搬 schema 得动 pgrst.db_schemas——          │
 * │ 05-provision-user-schema.sh 自己写着那一步搞砸会让 PostgREST 对     │
 * │ **所有人** 返回 503。这不是一个 UPDATE 能完成的事，做成一个按钮     │
 * │ 只会让人以为它是。                                                 │
 * │                                                                    │
 * │ 真要改名，今天的答案是：新开一个账号，把东西搬过去，归档旧的。      │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 两个字段都是可选的，只传要改的那个。
 */
export const adminUpdateUserRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  /** 传 null 表示清空邮箱——那样这个人就只能靠管理员发链接登录了。 */
  email: z.string().trim().toLowerCase().email('邮箱格式不对').max(160).nullable().optional(),
}).refine((v) => v.displayName !== undefined || v.email !== undefined, {
  message: '没有要改的字段',
});
export type AdminUpdateUserRequest = z.infer<typeof adminUpdateUserRequestSchema>;

/**
 * 管理员直接给别人设一个新密码。
 *
 * ⚠️ 这条路和「发重置链接」并列，不是替代。区别在于事后能不能归因：
 * 发链接的话密码只有本人知道，之后这个账号做的事就是这个人做的；而直接
 * 设密码意味着管理员也知道，出了事没法说清是谁。
 *
 * 所以界面上把发链接摆在前面，这条留给「人就在跟前、立刻要用」的场合。
 * 两条都写审计。
 */
export const adminSetPasswordRequestSchema = z.object({
  password: z.string().min(1).max(200),
});
export type AdminSetPasswordRequest = z.infer<typeof adminSetPasswordRequestSchema>;

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
  visibility: z.enum(['private', 'shared', 'public', 'link']).optional(),
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
      fromUser: userSchema.pick({
        id: true, username: true, displayName: true, avatarUrl: true,
      }),
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
