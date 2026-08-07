import type { App, AppGroup, Quota, User } from '@ispace/contracts';

/**
 * portal 的 API 客户端。
 *
 * 全部走 same-origin cookie —— portal 与 deploy-service 在同一域名下
 * （规格 D7 单域名 + 路径），无需处理跨域与 token 存储。
 */

const BASE = '/deploy/api';

export interface ApiError {
  code: string;
  message: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' });
  const body = (await res.json()) as T & Partial<ApiError>;
  if (!res.ok) {
    throw Object.assign(new Error(body.message ?? '请求失败'), { code: body.code });
  }
  return body as T;
}

async function post<T>(path: string, data?: unknown): Promise<T> {
  // 没有 body 就不声明 content-type：服务端会拿空字符串去解析 JSON 而抛，
  // 而「退出登录」这类 POST 本来就没有 body。详见 apps/console/src/api.ts。
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    ...(data === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  });
  const body = (await res.json()) as T & Partial<ApiError>;
  if (!res.ok) {
    throw Object.assign(new Error(body.message ?? '请求失败'), { code: body.code });
  }
  return body as T;
}

/**
 * 除 GET/POST 外还需要 PATCH 与 DELETE：可见范围是改一个既有资源的属性，
 * 取消分享是删一条关系。用 POST 冒充它们会让审计日志里的动作看不出方向。
 */
async function send<T>(method: string, path: string, data?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'same-origin',
    ...(data === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  });
  const body = (await res.json()) as T & Partial<ApiError>;
  if (!res.ok) {
    throw Object.assign(new Error(body.message ?? '请求失败'), { code: body.code });
  }
  return body as T;
}
const patch = <T>(path: string, data?: unknown) => send<T>('PATCH', path, data);
const del = <T>(path: string) => send<T>('DELETE', path);

export interface MeResponse {
  user: User;
  quota: Quota;
  spaceUrl: string;
}

export interface SharePeerInfo {
  shareId: string;
  username: string;
  displayName: string;
  status: 'pending' | 'accepted';
}

export interface AppsResponse {
  groups: AppGroup[];
  apps: App[];
  total: number;
}

export interface PendingShare {
  id: string;
  appId: string;
  status: string;
  createdAt: string;
  app: App;
  fromUser: { id: string; username: string; displayName: string };
}

export interface Listing {
  id: string; app_id: string; published_at: string; install_count: number;
  slug: string; name: string; description: string | null; icon_letter: string;
  cover_path: string | null;
  type: string; status: string;
  owner_username: string; owner_name: string;
  installed: boolean; mine: boolean;
  /**
   * 做出这个页面的那段提示词（apps.source_prompt）。
   *
   * 只有经 MCP deploy 且带了 prompt 的页面才有，老页面与手工上传的都是 null——
   * 所以「做同款」是个**可选**入口，不能假定每条 listing 都能点。
   */
  source_prompt: string | null;
}

export interface InstalledApp {
  source: 'share' | 'marketplace';
  id: string; slug: string; name: string; description: string | null;
  icon_letter: string; cover_path: string | null;
  type: string; status: string; updated_at: string;
  owner_username: string; owner_name: string;
}

export interface AuthPolicy {
  emailDomains: string[];
  passwordMin: number;
  /** 配了 OIDC_* 时为真，登录页会多给一个 SSO 入口。 */
  ssoEnabled: boolean;
}

/**
 * 安卓安装包的版本信息，由 infra/scripts/14-publish-apk.sh 写到 /srv/dist。
 *
 * 字段与那份脚本生成的 JSON 一一对应；改了这里必须同步改脚本，反之亦然。
 */
export interface ApkRelease {
  version: string;
  versionCode: number;
  platform: string;
  file: string;
  /** 站内绝对路径，如 /dist/ispace.apk。二维码要的是补上 origin 的完整地址。 */
  url: string;
  sizeBytes: number;
  sha256: string;
  /** APK 的构建时刻（UTC，带 Z）。 */
  builtAt: string;
  publishedAt: string;
}

/**
 * 读安装包的版本信息。
 *
 * 不走 /deploy/api：这是 Caddy 直出的静态文件，中间没有应用进程，
 * 发版脚本 rsync 完就生效。因此也不带 credentials——/dist 整段刻意免登录，
 * 同事装 App 的那一刻还没有会话。
 *
 * cache: 'no-store' 是必须的：文件名固定为 version.json，不带 hash，
 * 浏览器缓存住之后发了新版也还是显示旧版本号，而用户下到的却是新包。
 */
async function apkRelease(): Promise<ApkRelease> {
  const res = await fetch('/dist/version.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`拿不到版本信息（HTTP ${res.status}）`);
  return (await res.json()) as ApkRelease;
}

export const api = {
  apkRelease,
  authPolicy: () => get<AuthPolicy>('/auth/policy'),
  login: (email: string, password: string) =>
    post<{ user: User; token: string }>('/auth/login', { email, password }),
  /** 用管理员发的一次性链接设新密码。不需要会话——令牌本身就是身份证明。 */
  resetPassword: (token: string, password: string) =>
    post<{ ok: boolean }>('/auth/reset', { token, password }),
  register: (input: {
    email: string; password: string; displayName: string; username?: string;
  }) => post<{ user: User; token: string; spaceUrl: string }>('/auth/register', input),

  me: () => get<MeResponse>('/me'),
  apps: () => get<AppsResponse>('/apps'),
  pendingShares: () => get<{ shares: PendingShare[] }>('/shares/pending'),
  /** 把某个页面分享给同事。对方接受后能在自己的主页看到。 */
  share: (appId: string, toUsername: string) =>
    post<{ share: unknown }>('/shares', { appId, toUsername }),
  respondShare: (id: string, accept: boolean) =>
    post<{ ok: boolean }>(`/shares/${id}/respond`, { accept }),
  /** 这个页面已分享给谁。分享弹窗打开时用它填那排 chip。 */
  appShares: (appId: string) => get<{ peers: SharePeerInfo[] }>(`/apps/${appId}/shares`),
  revokeShareTo: (appId: string, username: string) =>
    del<{ ok: boolean }>(`/apps/${appId}/shares/${encodeURIComponent(username)}`),
  /** 切换可见范围。改成「仅自己」会连带收回分享，revoked 是收回条数。 */
  setVisibility: (appId: string, visibility: 'private' | 'public' | 'shared') =>
    patch<{ visibility: string; revoked: number }>(`/apps/${appId}/visibility`, { visibility }),
  logout: () => post<{ ok: boolean }>('/auth/logout'),
  /** 铸一个手机扫码登录的一次性码。60 秒过期，用一次即毁。 */
  mintQrCode: () => post<{ code: string; expiresIn: number }>('/auth/native/code'),

  marketplace: () => get<{ listings: Listing[] }>('/marketplace'),
  installFromMarket: (appId: string) =>
    post<{ ok: boolean }>(`/marketplace/${appId}/install`),
  uninstallFromMarket: (appId: string) =>
    fetch(`/deploy/api/marketplace/${appId}/install`, { method: 'DELETE', credentials: 'same-origin' })
      .then((r) => r.json() as Promise<{ ok: boolean }>),
  publishToMarket: (appId: string) => post<{ listing: unknown }>('/marketplace', { appId }),
  unpublishFromMarket: (appId: string) =>
    fetch(`/deploy/api/marketplace/${appId}`, { method: 'DELETE', credentials: 'same-origin' })
      .then((r) => r.json() as Promise<{ ok: boolean }>),
  installed: () => get<{ installed: InstalledApp[] }>('/installed'),
  /** 把别人的页面从我的空间移除。分享来的与市场装的都走这一个。 */
  removeInstalled: (appId: string) => del<{ ok: boolean }>(`/installed/${appId}`),
  /** 管理员下架别人上架的内容。只下架，不删应用。 */
  adminUnlist: (appId: string) => del<{ ok: boolean }>(`/admin/marketplace/${appId}`),
  loginUrl: (redirect: string) =>
    `${BASE}/auth/login?redirect=${encodeURIComponent(redirect)}`,
};

/** 从当前路径解析出空间归属者。`/` 表示还没落到具体空间。 */
export function ownerFromPath(): string | null {
  const seg = location.pathname.split('/').filter(Boolean);
  return seg[0] ?? null;
}
