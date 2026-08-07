import { z } from 'zod';
import { appSlugSchema, usernameSchema } from './reserved.js';

/**
 * 平台元数据库的 12 张表。用户的业务数据不在这里——那些落在各自的
 * `u_{username}` schema 中（见 05-provision-user-schema.sh）。
 *
 * 命名与取值全部来自设计稿的实际界面，不是臆造：
 * 「我的页面」屏的类型/状态列、「发布记录」屏的入口列、「配额与用量」屏的四项配额。
 */

const id = z.string().uuid();
const ts = z.coerce.date();

// ── users ────────────────────────────────────────────────────────────
/** 平台角色：决定控制台呈现员工视角还是管理员视角。 */
export const userRoleSchema = z.enum(['employee', 'admin']);
/**
 * 身份维度：取自 SSO 档案，决定移动端首页形态与 Agent 功能可见性。
 * 与 role 正交——管理员可以是使用者，普通员工可以是开发者。
 */
export const userIdentitySchema = z.enum(['user', 'developer']);
/**
 * pending 是「注册了但还没开通」。迁移 0003 已把它加进库约束，
 * 契约这边当时漏了——两处不一致会让 pending 的用户在 API 层被判为
 * 非法数据而整条请求失败。
 */
export const userStatusSchema = z.enum(['pending', 'active', 'archived']);

export const userSchema = z.object({
  id,
  ssoSubject: z.string().min(1),
  username: usernameSchema,
  displayName: z.string().min(1).max(64),
  email: z.string().email().nullable(),
  role: userRoleSchema,
  identity: userIdentitySchema,
  status: userStatusSchema,
  createdAt: ts,
  archivedAt: ts.nullable(),
});
export type User = z.infer<typeof userSchema>;

// ── app_groups ───────────────────────────────────────────────────────
/** 设计稿「我的页面」聚合页的分组：常用 / 日常 / 客户跟进 / 小工具。 */
export const appGroupSchema = z.object({
  id,
  ownerId: id,
  name: z.string().min(1).max(24),
  sortOrder: z.number().int().nonnegative(),
  createdAt: ts,
});
export type AppGroup = z.infer<typeof appGroupSchema>;

// ── apps ─────────────────────────────────────────────────────────────
/**
 * 设计稿「我的页面」屏的类型列。
 * h5 与 static 的区别在移动端：h5 在壳内 webview 打开、可嵌为 tab、**不切通道**。
 */
export const appTypeSchema = z.enum(['static', 'static_backend', 'h5']);
/** 设计稿状态列。building 是异步发布的中间态，不可省略。 */
export const appStatusSchema = z.enum(['running', 'building', 'stopped']);
/**
 * private  仅自己可见
 * shared   已分享给特定同事（shares 表）
 * public   已上架创意市场（marketplace_listings 表）
 */
export const appVisibilitySchema = z.enum(['private', 'shared', 'public']);

/**
 * 创意市场的分类。固定一小组、三端共用——分类的价值在「大家用同一套词」，
 * 让它可自由填就退化成一堆近义词（"工具/小工具/效率"），侧边栏就没法聚合了。
 * 默认「其他」：没归类的页面照样上架，只是先落在这一格，作者可随时改。
 */
export const MARKETPLACE_CATEGORIES = [
  '效率工具', '数据看板', '表单问卷', '游戏娱乐', '官网展示', '生活服务', '其他',
] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];
export const marketplaceCategorySchema = z.enum(MARKETPLACE_CATEGORIES);

export const appSchema = z.object({
  id,
  ownerId: id,
  slug: appSlugSchema,
  name: z.string().min(1).max(32),
  description: z.string().max(200).nullable(),
  /** 设计稿卡片左上角的单字图标底板。没有封面时卡片显示它。 */
  iconLetter: z.string().min(1).max(2),
  /**
   * 卡片封面图。发布时从产物里取（og:image 或 cover.png），
   * 是 <img src> 直接能用的地址；没有则为 null，卡片回落到 iconLetter。
   */
  coverUrl: z.string().nullable(),
  type: appTypeSchema,
  status: appStatusSchema,
  currentReleaseId: id.nullable(),
  groupId: id.nullable(),
  sortOrder: z.number().int().nonnegative(),
  visibility: appVisibilitySchema,
  sizeBytes: z.number().int().nonnegative(),
  lastAccessedAt: ts.nullable(),
  createdAt: ts,
  updatedAt: ts,
  /**
   * 做出这个页面的提示词，供创意市场的「做同款」使用。
   * 上架后对全公司可见——发布方要为里面的内容负责（工具描述里已警示）。
   */
  sourcePrompt: z.string().max(4000).nullable().default(null),
});
export type App = z.infer<typeof appSchema>;

// ── releases ─────────────────────────────────────────────────────────
/** 设计稿「发布记录」屏的入口列：MCP / CLI / 手机 Agent / 控制台。 */
export const releaseSourceSchema = z.enum(['mcp', 'cli', 'agent', 'console']);
/** blocked 表示被密钥或 XSS 扫描拦下，设计稿「发布记录」屏有「已阻断」状态与计数。 */
export const releaseStatusSchema = z.enum(['building', 'active', 'superseded', 'blocked']);

export const releaseSchema = z.object({
  id,
  appId: id,
  /** 单调递增的整数版本号，对外显示为 v12。 */
  version: z.number().int().positive(),
  source: releaseSourceSchema,
  status: releaseStatusSchema,
  sizeBytes: z.number().int().nonnegative(),
  /** releases 目录下的时间戳目录名，回滚即切软链到它。 */
  path: z.string().min(1),
  publishedBy: id,
  publishedAt: ts,
  /** 仅当 status=blocked 时有值，记录命中的规则。 */
  blockedReason: z.string().nullable(),
});
export type Release = z.infer<typeof releaseSchema>;

// ── shares ───────────────────────────────────────────────────────────
/** 设计稿 PC 顶部分享卡与手机第 14 屏待接受卡。 */
export const shareStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'revoked']);

export const shareSchema = z.object({
  id,
  appId: id,
  fromUserId: id,
  toUserId: id,
  status: shareStatusSchema,
  createdAt: ts,
  respondedAt: ts.nullable(),
});
export type Share = z.infer<typeof shareSchema>;

// ── app_installs ─────────────────────────────────────────────────────
/** 「添加到我的」的结果。来源区分是分享还是创意市场。 */
export const installSourceSchema = z.enum(['share', 'marketplace']);

export const appInstallSchema = z.object({
  id,
  appId: id,
  userId: id,
  source: installSourceSchema,
  createdAt: ts,
});
export type AppInstall = z.infer<typeof appInstallSchema>;

// ── marketplace_listings ─────────────────────────────────────────────
/** 创意市场。一期建表、契约完整，UI 二期实现（规格 D10）。 */
export const marketplaceListingSchema = z.object({
  id,
  appId: id,
  publishedBy: id,
  publishedAt: ts,
  /** 设计稿「23 人在用」。由 app_installs 计数物化而来，避免列表页 N+1。 */
  installCount: z.number().int().nonnegative(),
});
export type MarketplaceListing = z.infer<typeof marketplaceListingSchema>;

// ── backends ─────────────────────────────────────────────────────────
export const backendStatusSchema = z.enum([
  'creating',
  'running',
  'stopped',
  'failed',
]);

export const backendSchema = z.object({
  id,
  ownerId: id,
  appId: id.nullable(),
  name: z.string().min(1).max(32),
  sourceRepo: z.string().nullable(),
  /** 由平台在建应用时强制写入，不依赖用户自觉（规格 §5.3）。 */
  cpuLimit: z.number().positive(),
  memLimitMb: z.number().int().positive(),
  status: backendStatusSchema,
  /** 形如 /svc/{user}/{app}。 */
  urlPath: z.string().min(1),
  /** 容器内监听端口，鉴权代理据此连容器。 */
  port: z.number().int().positive(),
  /** 是否作为应用露出到「我的空间」。false=纯 API 服务，只对控制台与 AI 可见。 */
  exposed: z.boolean(),
  /** 露出后的访问范围，与页面同义。 */
  visibility: appVisibilitySchema,
  /** 编排器侧的应用标识（Dokploy applicationId）。 */
  orchestratorRef: z.string().nullable(),
  createdAt: ts,
});
export type Backend = z.infer<typeof backendSchema>;

// ── quotas ───────────────────────────────────────────────────────────
/** 默认值取自设计稿「配额与用量」屏。 */
export const DEFAULT_QUOTAS = {
  storageBytesLimit: 500 * 1024 * 1024,
  backendCountLimit: 2,
  backendCpuLimit: 0.5,
  backendMemLimitMb: 512,
  dbRowsLimit: 50_000,
} as const;

export const quotaSchema = z.object({
  userId: id,
  storageBytesUsed: z.number().int().nonnegative(),
  storageBytesLimit: z.number().int().positive(),
  backendCountUsed: z.number().int().nonnegative(),
  backendCountLimit: z.number().int().nonnegative(),
  dbRowsUsed: z.number().int().nonnegative(),
  dbRowsLimit: z.number().int().positive(),
  updatedAt: ts,
});
export type Quota = z.infer<typeof quotaSchema>;

// ── audit_logs ───────────────────────────────────────────────────────
export const auditActionSchema = z.enum([
  'user.provision',
  'user.archive',
  'user.password_change',
  'user.password_reset',
  'user.qr_login',
  'app.create',
  'app.deploy',
  'app.rollback',
  'app.delete',
  'app.share',
  'app.share_respond',
  'backend.create',
  'backend.restart',
  'quota.grant',
  'quota.request',
  'quota.decide',
  'policy.update',
  'backup.report',
  'users.export',
  'audit.export',
  'mobile.publish',
]);
export const auditResultSchema = z.enum(['success', 'blocked', 'failed']);

export const auditLogSchema = z.object({
  id,
  actorId: id,
  action: auditActionSchema,
  targetType: z.string().min(1),
  targetId: z.string().nullable(),
  source: releaseSourceSchema,
  result: auditResultSchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
  /** 来源 IP。定时任务与内部调用没有请求上下文，故可空。 */
  ip: z.string().nullable().default(null),
  createdAt: ts,
});
export type AuditLog = z.infer<typeof auditLogSchema>;

/** 设计稿「发布记录」屏：保留 12 个月。 */
export const AUDIT_RETENTION_MONTHS = 12;
/** 设计稿「配额与用量」屏：90 天无访问先通知后归档。 */
export const IDLE_ARCHIVE_DAYS = 90;

// ── mobile_channels / mobile_releases ────────────────────────────────
/** 三期实现，一期建表并定义契约（规格 D1）。 */
export const mobileChannelSchema = z.object({
  id,
  userId: id,
  /** expo-updates 请求头中的通道名，形如 u-lixiao。 */
  channelName: z.string().min(1),
  currentReleaseId: id.nullable(),
  createdAt: ts,
});
export type MobileChannel = z.infer<typeof mobileChannelSchema>;

export const mobileReleaseStatusSchema = z.enum([
  'building',
  'active',
  'superseded',
  'blocked',
]);

export const mobileReleaseSchema = z.object({
  id,
  userId: id,
  bundleVersion: z.number().int().positive(),
  /** 与壳的 runtimeVersion 协议级匹配，不符则服务端不下发。 */
  runtimeVersion: z.string().min(1),
  manifest: z.record(z.string(), z.unknown()),
  /** 设计稿「更新通道」屏的放量：10 / 50 / 100。 */
  rolloutPercent: z.number().int().min(0).max(100),
  status: mobileReleaseStatusSchema,
  publishedAt: ts,
});
export type MobileRelease = z.infer<typeof mobileReleaseSchema>;
