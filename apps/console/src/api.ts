import type { App, AppGroup, AuditLog, Quota, Release, User } from '@ispace/contracts';

const BASE = '/deploy/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  /*
    没有 body 就不要声明 content-type。

    以前无条件带上 application/json，而「退出登录」「吊销令牌」「开通」
    这类 POST 本来就没有 body——服务端拿空字符串去解析 JSON 直接抛，
    整批端点全部 500。前端又把错误 catch 掉了，表现是"点了没反应"，
    完全指不到请求体解析这一层。退出登录就是这么坏的：
    cookie 从来没被清掉过。

    声明一个自己并没有发送的 content-type，本来就是不对的。
  */
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers,
  });
  const body = (await res.json()) as T & { code?: string; message?: string };
  if (!res.ok) throw Object.assign(new Error(body.message ?? '请求失败'), { code: body.code });
  return body as T;
}

export interface Me { user: User; quota: Quota; spaceUrl: string }

/** 列表页要展示的当前版本与入口，由 /apps 一次 join 带回，避免逐个查。 */
export type AppRow = App & {
  currentVersion: number | null;
  currentSource: 'mcp' | 'cli' | 'agent' | 'console' | null;
  /** 挂在这个页面名下的后端名。null = 没有。 */
  backendName: string | null;
};

export interface SharePeerInfo {
  shareId: string;
  username: string;
  displayName: string;
  status: 'pending' | 'accepted';
}

/** 更新通道那四张卡的数据来源，见 routes/overview.ts。 */
export interface DeviceStats {
  activeDevices: number;
  failedDevices: number;
  totalDevices: number;
  /** 当前版本从发布到第一台设备装上的秒数。null = 还没到端。 */
  deliverySeconds: number | null;
  devicesByRelease: Record<string, number>;
}

export interface Backend {
  id: string; ownerId: string; appId: string | null; name: string;
  sourceRepo: string | null; cpuLimit: number; memLimitMb: number;
  status: 'creating' | 'running' | 'stopped' | 'failed';
  urlPath: string; orchestratorRef: string | null; createdAt: string;
  /** 服务于哪个页面。null = 没关联。 */
  appSlug?: string | null;
}

export interface AccessToken {
  id: string; name: string; token_prefix: string;
  last_used_at: string | null; expires_at: string | null; created_at: string;
}

export interface MobileRelease {
  id: string; bundle_version: number; runtime_version: string;
  rollout_percent: number; status: 'building' | 'active' | 'superseded' | 'blocked';
  published_at: string;
}

export interface MobileChannelInfo {
  channel: {
    channel_name: string; current_release_id: string | null;
    bundle_version: number | null; runtime_version: string | null;
    rollout_percent: number | null; published_at: string | null;
  } | null;
  channelName: string;
  previewChannelName: string;
  releases: MobileRelease[];
}

export interface AdminOverview {
  userCount: number; userCountDelta: number; appCount: number; backendCount: number;
  weeklyDeployCount: number; weeklyDeployDeltaPercent: number;
  deployTrend: { date: string; count: number }[];
  topSpaces: { username: string; displayName: string; bytes: number }[];
}

export interface AdminUser {
  id: string; username: string; displayName: string; email: string | null;
  role: 'employee' | 'admin'; identity: 'user' | 'developer'; status: string;
  createdAt: string; storageUsed: number; storageLimit: number; appCount: number;
  /** 归档时间。冷冻期（归档后 30 天）由它算，status 只区分三态。 */
  archivedAt: string | null;
  backendCount: number;
}

export interface AuditEntry extends AuditLog { actorUsername: string }


export interface HostLoad {
  cpu: { percent: number; cores: number };
  memory: { total: number; used: number; percent: number };
  disk: { total: number; used: number; percent: number };
}

/** GET /admin/policy 返回的库行，蛇形命名。 */
export interface PlatformPolicy {
  backend_cpu_limit: string;
  backend_memory_bytes: string;
  backend_count_limit: number;
  storage_bytes_limit: string;
  email_domains?: string;
  self_register_enabled?: boolean;
  require_approval?: boolean;
  password_min_length?: number;
  session_days?: number;
  idle_archive_days?: number;
  audit_retention_months?: number;
  token_max_days?: number;
  allow_public_share?: boolean;
  allow_peer_share?: boolean;
  updated_at: string;
}

/**
 * 库行 → 提交体。
 *
 * PUT 的语义是整体替换：少传一个字段就等于把它清成默认值。
 * 「资源与配额」屏只编辑四个资源字段，如果它按自己那四个字段提交，
 * 就会把管理员在「平台设置」里配的注册策略一起冲掉——
 * 所以两屏都先读全量、改自己那几项、再整体提交。
 */
export function toSettings(p: PlatformPolicy): PlatformSettings {
  return {
    backendCpuLimit: p.backend_cpu_limit,
    backendMemoryBytes: Number(p.backend_memory_bytes),
    backendCountLimit: p.backend_count_limit,
    storageBytesLimit: Number(p.storage_bytes_limit),
    emailDomains: p.email_domains ?? 'example.com',
    selfRegisterEnabled: p.self_register_enabled ?? true,
    requireApproval: p.require_approval ?? false,
    passwordMinLength: p.password_min_length ?? 12,
    sessionDays: p.session_days ?? 30,
    idleArchiveDays: p.idle_archive_days ?? 90,
    auditRetentionMonths: p.audit_retention_months ?? 12,
    tokenMaxDays: p.token_max_days ?? 0,
    allowPublicShare: p.allow_public_share ?? true,
    allowPeerShare: p.allow_peer_share ?? true,
  };
}

export interface QuotaRequest {
  id: string;
  user_id: string;
  resource: 'storage' | 'backends' | 'rows';
  current_used: string;
  current_limit: string;
  requested_limit: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
  /** 管理员列表带出，员工自己的列表没有 */
  username?: string;
  display_name?: string;
}

export interface BackupRun {
  id: string;
  kind: 'backup' | 'restore_drill';
  status: 'success' | 'failed';
  started_at: string;
  finished_at: string;
  size_bytes: string | null;
  note: string | null;
}

export interface ProbeResult {
  probed: string | null;
  ok: boolean | null;
  status?: number;
  ms?: number;
  note?: string;
}

export interface AdminUsersResponse {
  summary: { active: number; pending: number; cooling: number; nearLimit: number };
  users: AdminUser[];
}

export interface DataTable {
  name: string;
  /** 统计估算值，非精确计数——精确计数要全表扫描。 */
  rows: number;
  rowLevelSecurity: boolean;
  bytes: number;
  lastChangedAt: string | null;
}

export interface DataConnection {
  schema: string;
  restUrl: string;
  /** Supabase 匿名公钥。本就设计为下发到前端，库密码不在此列。 */
  anonKey: string | null;
  note: string;
}

/** 平台设置。字段与 platform_policy 一一对应。 */
export interface PlatformSettings {
  backendCpuLimit: string;
  backendMemoryBytes: number;
  backendCountLimit: number;
  storageBytesLimit: number;
  emailDomains: string;
  selfRegisterEnabled: boolean;
  requireApproval: boolean;
  passwordMinLength: number;
  sessionDays: number;
  idleArchiveDays: number;
  auditRetentionMonths: number;
  tokenMaxDays: number;
  allowPublicShare: boolean;
  allowPeerShare: boolean;
}

export interface AdminToken {
  id: string; name: string; token_prefix: string;
  created_at: string; last_used_at: string | null; expires_at: string | null;
  username: string; display_name: string; user_status: string;
}

export interface OffboardRun {
  id: string;
  steps: { step: 'apps' | 'backends' | 'data' | 'path'; ok: boolean; note: string }[];
  status: 'running' | 'done' | 'partial' | 'failed';
  path_frozen_until: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface JobHeartbeat {
  name: string;
  lastRunAt: string;
  ok: boolean;
  note: string | null;
  state: 'alive' | 'stale' | 'failing';
}

export interface BlockedItem {
  id: string; created_at: string; target_type: string; target_id: string | null;
  metadata: Record<string, unknown> | null;
  username: string; display_name: string;
}


/** 连接器：页面调外部 API 的登记项。注意**没有** secret 字段——服务端从不回传。 */
export interface ConnectorRow {
  id: string;
  slug: string;
  name: string;
  baseUrl: string;
  authKind: 'none' | 'header' | 'query' | 'bearer';
  authName: string | null;
  hasSecret: boolean;
  catalogId: string | null;
  shared: boolean;
  callCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/** 内置目录条目。每一条都在部署环境实测过连得通，见 contracts/connectors.ts。 */
export interface CatalogEntry {
  id: string;
  name: string;
  what: string;
  baseUrl: string;
  authKind: ConnectorRow['authKind'];
  authName?: string;
  apply?: string;
  example: string;
  tags: string[];
}

export const api = {
  dataTables: () => req<{ schema: string; tables: DataTable[] }>('/data/tables'),

  connectors: () => req<{ connectors: ConnectorRow[] }>('/connectors'),
  connectorCatalog: () =>
    req<{ catalog: CatalogEntry[]; secretStorageReady: boolean }>('/connectors/catalog'),
  createConnector: (body: {
    slug: string; name: string; baseUrl: string;
    authKind: ConnectorRow['authKind'];
    authName?: string; secret?: string; catalogId?: string; shared: boolean;
  }) => req<{ connector: ConnectorRow }>('/connectors', { method: 'POST', body: JSON.stringify(body) }),
  deleteConnector: (id: string) =>
    req<{ ok: true }>(`/connectors/${id}`, { method: 'DELETE' }),
  dataConnection: () => req<DataConnection>('/data/connection'),

  me: () => req<Me>('/me'),
  apps: () => req<{ groups: AppGroup[]; apps: AppRow[]; total: number }>('/apps'),
  /** 空间总览的「本月发布」。 */
  overview: () => req<{ publishedThisMonth: number; deltaVsLastMonth: number }>('/overview'),
  deviceStats: () => req<DeviceStats>('/mobile/devices/stats'),
  /** 数据空间的「已注册终端用户」。表名认不出来时 count 为 null。 */
  endUsers: () => req<{ table: string | null; count: number | null }>('/data/end-users'),
  releases: (slug: string) => req<{ releases: Release[]; total: number }>(`/apps/${slug}/releases`),
  /** 删除页面及其全部历史版本。不可恢复——调用处必须先确认。 */
  deleteApp: (slug: string) =>
    req<{ slug: string; name: string; releases: number; freedBytes: number; filesRemoved: boolean }>(
      `/apps/${slug}`, { method: 'DELETE' },
    ),
  rollback: (slug: string, toVersion?: number) =>
    req<{ release: Release; url: string }>(`/apps/${slug}/rollback`, {
      method: 'POST', body: JSON.stringify(toVersion ? { toVersion } : {}),
    }),
  quota: () => req<{
    quota: Quota;
    backendCpuLimit: number;
    backendMemLimitMb: number;
    /** 实测用量。null 表示宿主上的采样任务没在跑或数据已过期。 */
    backendCpuUsed: number | null;
    backendMemUsedMb: number | null;
  }>('/quota'),
  audit: (limit = 50) =>
    req<{ logs: AuditEntry[]; total: number; blockedCount: number }>(`/audit?limit=${limit}`),
  share: (appId: string, toUsername: string) =>
    req<{ share: unknown }>('/shares', { method: 'POST', body: JSON.stringify({ appId, toUsername }) }),
  appShares: (appId: string) => req<{ peers: SharePeerInfo[] }>(`/apps/${appId}/shares`),
  revokeShareTo: (appId: string, username: string) =>
    req<{ ok: boolean }>(`/apps/${appId}/shares/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  setVisibility: (appId: string, visibility: 'private' | 'public' | 'shared') =>
    req<{ visibility: string; revoked: number }>(`/apps/${appId}/visibility`, {
      method: 'PATCH', body: JSON.stringify({ visibility }),
    }),
  logout: () => req<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  // ── 管理端 ────────────────────────────────────────────────────────
  /** 生成一次性设密码链接。只返回一次，前端要立刻显示。 */
  resetPassword: (userId: string) =>
    req<{ url: string; expiresInHours: number; warning: string }>(
      `/admin/users/${userId}/reset-password`, { method: 'POST' },
    ),
  setRole: (userId: string, role: 'admin' | 'employee') =>
    req<{ ok: boolean; role: string }>(`/admin/users/${userId}/role`, {
      method: 'PATCH', body: JSON.stringify({ role }),
    }),
  approveUser: (userId: string) =>
    req<{ ok: boolean }>(`/admin/users/${userId}/approve`, { method: 'POST' }),
  offboardRuns: (userId: string) =>
    req<{ runs: OffboardRun[] }>(`/admin/users/${userId}/offboard`),
  /** 撤销回收。冷冻期内最常用——人没走成或点错了人。 */
  restoreUser: (userId: string) =>
    req<{ steps: OffboardRun['steps']; status: string }>(
      `/admin/users/${userId}/restore`, { method: 'POST' },
    ),
  offboardRetry: (userId: string) =>
    req<{ runId: string; steps: OffboardRun['steps']; status: string }>(
      `/admin/users/${userId}/offboard/retry`, { method: 'POST' },
    ),

  adminTokens: () => req<{ tokens: AdminToken[] }>('/admin/tokens'),
  adminRevokeToken: (id: string) =>
    req<{ ok: boolean }>(`/admin/tokens/${id}/revoke`, { method: 'POST' }),

  adminUnlist: (appId: string) =>
    req<{ ok: boolean }>(`/admin/marketplace/${appId}`, { method: 'DELETE' }),
  adminBlocked: () => req<{ items: BlockedItem[] }>('/admin/blocked'),
  adminJobs: () => req<{
    jobs: JobHeartbeat[];
    known: { name: string; label: string; every: string; install: string }[];
  }>('/admin/jobs'),

  backends: () => req<{
    backends: Backend[];
    limits: { cpu: number; memoryMb: number; count: number };
    orchestrator: string;
  }>('/backends'),
  createBackend: (name: string, sourceRepo: string, port = 3000, appSlug?: string) =>
    req<{ backend: Backend; url: string }>('/backends', {
      method: 'POST', body: JSON.stringify({ name, sourceRepo, port, appSlug }),
    }),
  restartBackend: (id: string) => req<{ ok: boolean }>(`/backends/${id}/restart`, { method: 'POST' }),
  /** 起不来时的真正原因。「启动失败」四个字对用户没有任何用处。 */
  backendLogs: (id: string) =>
    req<{ log: string | null; reason: string | null }>(`/backends/${id}/logs`),
  /** 重新配置源并部署。空壳后端（修复前建的）靠它就地救回，不用删了重建。 */
  redeployBackend: (id: string) =>
    req<{ ok: boolean; status: string }>(`/backends/${id}/redeploy`, { method: 'POST' }),
  deleteBackend: (id: string) => req<{ ok: boolean }>(`/backends/${id}`, { method: 'DELETE' }),

  groups: () => req<{ groups: { id: string; name: string; sortOrder: number; app_count: string }[] }>('/groups'),
  createGroup: (name: string) => req<{ group: unknown }>('/groups', { method: 'POST', body: JSON.stringify({ name }) }),
  renameGroup: (id: string, name: string) =>
    req<{ group: unknown }>(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteGroup: (id: string) => req<{ ok: boolean }>(`/groups/${id}`, { method: 'DELETE' }),
  assignGroup: (slug: string, groupId: string | null) =>
    req<{ app: unknown }>(`/apps/${slug}/group`, { method: 'PATCH', body: JSON.stringify({ groupId }) }),

  publishToMarket: (appId: string) =>
    req<{ listing: unknown }>('/marketplace', { method: 'POST', body: JSON.stringify({ appId }) }),
  unpublishFromMarket: (appId: string) =>
    req<{ ok: boolean }>(`/marketplace/${appId}`, { method: 'DELETE' }),

  tokens: () => req<{ tokens: AccessToken[] }>('/tokens'),
  createToken: (name: string) =>
    req<{ token: AccessToken; plaintext: string; warning: string }>('/tokens', {
      method: 'POST', body: JSON.stringify({ name }),
    }),
  revokeToken: (id: string) => req<{ ok: boolean }>(`/tokens/${id}`, { method: 'DELETE' }),

  mobileChannel: () => req<MobileChannelInfo>('/mobile/channel'),
  setRollout: (id: string, rolloutPercent: number) =>
    req<{ ok: boolean }>(`/mobile/releases/${id}/rollout`, {
      method: 'PATCH', body: JSON.stringify({ rolloutPercent }),
    }),
  mobileRollback: (toVersion?: number) =>
    req<{ bundleVersion: number }>('/mobile/rollback', {
      method: 'POST', body: JSON.stringify(toVersion ? { toVersion } : {}),
    }),

  adminOverview: () => req<AdminOverview>('/admin/overview'),
  adminUsers: () => req<AdminUsersResponse>('/admin/users'),
  adminInspection: () =>
    req<{ items: { severity: 'warn' | 'info'; text: string; hint: string }[] }>('/admin/inspection'),
  /** 离职回收。执行四步并逐步回报——任何一步都可能单独失败。 */
  adminArchive: (id: string) =>
    req<{ runId: string; steps: OffboardRun['steps']; status: string }>(
      `/admin/users/${id}/archive`, { method: 'POST' },
    ),

  adminHost: () => req<HostLoad>('/admin/host'),
  adminPolicy: () => req<{ policy: PlatformPolicy | null }>('/admin/policy'),
  /** 保存平台设置。整体提交——PUT 的语义是替换，缺字段等于把它清掉。 */
  saveAdminPolicy: (input: PlatformSettings) =>
    req<{ policy: PlatformPolicy; notes: string[] }>('/admin/policy', {
      method: 'PUT', body: JSON.stringify(input),
    }),

  quotaRequests: () => req<{ requests: QuotaRequest[] }>('/quota/requests'),
  requestQuota: (input: { resource: string; requestedLimit: number; reason: string }) =>
    req<{ request: QuotaRequest }>('/quota/requests', {
      method: 'POST', body: JSON.stringify(input),
    }),
  adminQuotaRequests: () => req<{ requests: QuotaRequest[] }>('/admin/quota-requests'),
  decideQuotaRequest: (id: string, approve: boolean, note?: string) =>
    req<{ ok: boolean }>(`/admin/quota-requests/${id}/decide`, {
      method: 'POST', body: JSON.stringify({ approve, note }),
    }),

  adminBackups: () => req<{ runs: BackupRun[] }>('/admin/backups'),
  adminProbe: () => req<ProbeResult>('/admin/probe', { method: 'POST' }),

  // 导出走浏览器直接下载：响应是 CSV 附件，不能用 fetch 后再解析
  exportUsersUrl: () => `${BASE}/admin/users/export`,
  exportAuditUrl: () => `${BASE}/admin/audit/export`,

  provision: (input: { username: string; displayName: string; email?: string; identity?: string }) =>
    req<{ user: User; schemaName: string; spaceUrl: string }>('/provision', {
      method: 'POST', body: JSON.stringify(input),
    }),
};
