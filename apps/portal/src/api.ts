import type {
  App, AppGroup, Quota, User,
  AuthorProfile, Comment, CommentSort, Interest,
  EventFile, EventJudgeResponse, EventResponse, EventScreeningResponse,
  IdeaInput, ScoreInput, WorkInput,
} from '@ispace/contracts';

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
  avatarUrl: string | null;
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
  fromUser: { id: string; username: string; displayName: string; avatarUrl: string | null };
}

export interface Listing {
  id: string; app_id: string; published_at: string; install_count: number;
  slug: string; name: string; description: string | null; icon_letter: string;
  cover_path: string | null;
  type: string; status: string;
  owner_username: string; owner_name: string;
  /** 作者头像地址（带内容指纹），没传过为 null，卡片回落到首字底板 */
  owner_avatar: string | null;
  installed: boolean; mine: boolean;
  category: string | null;
  /** 页面被打开过多少次（shell.js 每次加载打一下，不去重）。 */
  visit_count: number;
  /** 喜欢数与评论数（物化在 apps 上），以及我自己点过没有。 */
  like_count: number;
  comment_count: number;
  liked: boolean;
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

/**
 * 后端在市场里的一条 listing。
 *
 * 与 Listing（页面）分成两个类型而不是共用一个大而全的接口：后端没有
 * slug/type/source_prompt，封面是 has_cover 布尔位 + 固定地址，不是
 * cover_path 直链——共用一个类型会让一半字段对另一半永远是 null，
 * 门户拼列表时按 kind 区分渲染即可。
 */
export interface BackendListing {
  id: string; backend_id: string; published_at: string; install_count: number;
  category: string | null; name: string; status: string; has_cover: boolean;
  owner_username: string; owner_name: string;
  installed: boolean; mine: boolean;
  /** 根路径被 GET 过多少次（svc-proxy 每次代理成功打一下，不去重）。 */
  visit_count: number;
}

export interface InstalledBackend {
  id: string; name: string; status: string; url_path: string; has_cover: boolean;
  owner_username: string; owner_name: string;
}

export interface ExposedBackend {
  id: string; name: string; urlPath: string; status: string;
  visibility: 'private' | 'shared' | 'public' | 'link'; exposed: boolean; hasCover: boolean;
}

export interface AuthPolicy {
  emailDomains: string[];
  passwordMin: number;
  /** 配了 OIDC_* 时为真，登录页会多给一个 SSO 入口。 */
  ssoEnabled: boolean;
  ssoProvider?: string | null;
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
  feishuBinding: () => get<{ enabled: boolean; bound: boolean }>('/auth/feishu-binding'),
  /**
   * 忘记密码：本人发起一条申请，管理员在控制台放行。
   *
   * 返回的 message 与邮箱存不存在无关——服务端刻意不区分，免得这个免登录
   * 接口变成「谁开了账号」的探测器。所以前端也别自作聪明去判断成功与否。
   */
  forgotPassword: (email: string) =>
    post<{ ok: boolean; message: string }>('/auth/forgot', { email }),
  login: (email: string, password: string) =>
    post<{ user: User; token: string }>('/auth/login', { email, password }),
  /** 用管理员发的一次性链接设新密码。不需要会话——令牌本身就是身份证明。 */
  resetPassword: (token: string, password: string) =>
    post<{ ok: boolean }>('/auth/reset', { token, password }),
  register: (input: {
    email: string; password: string; displayName: string; username?: string;
  }) => post<{ user: User; token: string; spaceUrl: string }>('/auth/register', input),

  me: () => get<MeResponse>('/me'),

  /** 改显示名。返回改完的 user，调用方直接拿去刷新本地状态。 */
  updateProfile: (displayName: string) =>
    patch<{ user: User }>('/auth/profile', { displayName }),
  /**
   * 传头像。和附件上传同理：走 multipart，不手写 content-type，
   * 让浏览器自己带 boundary。
   *
   * 收 Blob 不收 File：调用方传进来的是 canvas 缩完图后导出的 Blob，
   * 它没有文件名，所以这里补一个——服务端只看 mimetype，名字不重要，
   * 但 FormData 不给名字的话有些服务端解析器会把它当普通字段。
   */
  uploadAvatar: async (blob: Blob): Promise<User> => {
    const form = new FormData();
    form.append('file', blob, 'avatar');
    const res = await fetch(`${BASE}/auth/avatar`, {
      method: 'POST', credentials: 'same-origin', body: form,
    });
    const body = (await res.json()) as { user: User } & Partial<ApiError>;
    if (!res.ok) throw Object.assign(new Error(body.message ?? '上传失败'), { code: body.code });
    return body.user;
  },
  removeAvatar: () => del<{ user: User }>('/auth/avatar'),
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
  /**
   * 切换可见范围。改成「仅自己」会连带收回分享，revoked 是收回条数。
   * 改成 link 时 linkPath 是私密链接的路径部分（/{owner}/{slug}/?lk=…）。
   */
  setVisibility: (appId: string, visibility: 'private' | 'public' | 'shared' | 'link') =>
    patch<{ visibility: string; revoked: number; linkPath: string | null }>(`/apps/${appId}/visibility`, { visibility }),
  logout: () => post<{ ok: boolean }>('/auth/logout'),
  /** 铸一个手机扫码登录的一次性码。60 秒过期，用一次即毁。 */
  mintQrCode: () => post<{ code: string; expiresIn: number }>('/auth/native/code'),

  marketplace: () => get<{ listings: Listing[] }>('/marketplace'),
  installFromMarket: (appId: string) =>
    post<{ ok: boolean }>(`/marketplace/${appId}/install`),
  uninstallFromMarket: (appId: string) =>
    fetch(`/deploy/api/marketplace/${appId}/install`, { method: 'DELETE', credentials: 'same-origin' })
      .then((r) => r.json() as Promise<{ ok: boolean }>),
  publishToMarket: (appId: string, category?: string) =>
    post<{ listing: unknown }>('/marketplace', category ? { appId, category } : { appId }),
  setListingCategory: (appId: string, category: string) =>
    patch<{ ok: boolean }>(`/marketplace/${appId}/category`, { category }),
  unpublishFromMarket: (appId: string) =>
    fetch(`/deploy/api/marketplace/${appId}`, { method: 'DELETE', credentials: 'same-origin' })
      .then((r) => r.json() as Promise<{ ok: boolean }>),
  installed: () => get<{ installed: InstalledApp[] }>('/installed'),
  backends: () => get<{ backends: ExposedBackend[] }>('/backends'),
  /* 后端的分享与页面同一套：三档可见性 + 指定同事名单。服务端路由早在
     「露出到空间」时就建好了，这里只补 portal 侧的客户端方法。后端没有
     「待接受」流程，授权即时生效，所以名单里的人一律当已接受。 */
  backendShares: (id: string) =>
    get<{ shares: { username: string; displayName: string; avatarUrl: string | null }[] }>(
      `/backends/${id}/shares`,
    ),
  setBackendVisibility: (id: string, visibility: 'private' | 'public' | 'shared' | 'link') =>
    patch<{ ok: boolean }>(`/backends/${id}`, { visibility }),
  shareBackend: (id: string, toUsername: string) =>
    post<{ ok: boolean }>(`/backends/${id}/shares`, { toUsername }),
  revokeBackendShareTo: (id: string, username: string) =>
    del<{ ok: boolean }>(`/backends/${id}/shares/${encodeURIComponent(username)}`),
  /* 后端的市场列表/安装/分类是单独一组端点（见 marketplace.ts 里那条注释：
     形状和页面差太多，UNION 对齐列类型不如两次请求，门户拼列表时合并）。 */
  backendMarketplace: () => get<{ listings: BackendListing[] }>('/marketplace/backends'),
  installBackendFromMarket: (backendId: string) =>
    post<{ ok: boolean }>(`/marketplace/backends/${backendId}/install`),
  uninstallBackendFromMarket: (backendId: string) =>
    del<{ ok: boolean }>(`/marketplace/backends/${backendId}/install`),
  setBackendListingCategory: (backendId: string, category: string) =>
    patch<{ ok: boolean }>(`/marketplace/backends/${backendId}/category`, { category }),
  installedBackends: () => get<{ installed: InstalledBackend[] }>('/installed/backends'),
  removeInstalledBackend: (backendId: string) => del<{ ok: boolean }>(`/installed/backends/${backendId}`),
  adminUnlistBackend: (backendId: string) => del<{ ok: boolean }>(`/admin/marketplace/backends/${backendId}`),
  /** 把别人的页面从我的空间移除。分享来的与市场装的都走这一个。 */
  removeInstalled: (appId: string) => del<{ ok: boolean }>(`/installed/${appId}`),
  /** 管理员下架别人上架的内容。只下架，不删应用。 */
  adminUnlist: (appId: string) => del<{ ok: boolean }>(`/admin/marketplace/${appId}`),
  loginUrl: (redirect: string) =>
    `${BASE}/auth/login?redirect=${encodeURIComponent(redirect)}`,

  // ── 社交面（改版稿）──────────────────────────────────────────────
  /*
    喜欢是两个动词而不是一个 toggle，服务端那边也是——手快点两下，toggle
    会互相抵消成「点了没反应」。返回的 likeCount 是服务端重算的真数，
    前端拿它覆盖本地那个 +1，别人同时点的那几下才不会被我这一下抹掉。
  */
  like: (appId: string) =>
    post<{ liked: boolean; likeCount: number }>(`/apps/${appId}/like`),
  unlike: (appId: string) =>
    del<{ liked: boolean; likeCount: number }>(`/apps/${appId}/like`),
  comments: (appId: string, sort: CommentSort = 'new') =>
    get<{ comments: Comment[] }>(`/apps/${appId}/comments?sort=${sort}`),
  likeComment: (id: string) =>
    post<{ liked: boolean; likeCount: number }>(`/comments/${id}/like`),
  unlikeComment: (id: string) =>
    del<{ liked: boolean; likeCount: number }>(`/comments/${id}/like`),
  addComment: (appId: string, body: string) =>
    post<{ comment: Comment; commentCount: number }>(`/apps/${appId}/comments`, { body }),
  deleteComment: (id: string) =>
    del<{ ok: boolean; commentCount: number }>(`/comments/${id}`),
  /** 作者主页一次把资料和他公开的作品都拿回来，这一屏不分两次闪。 */
  author: (username: string) =>
    get<{ profile: AuthorProfile; apps: Listing[] }>(`/authors/${encodeURIComponent(username)}`),
  follow: (username: string) =>
    post<{ following: boolean }>(`/authors/${encodeURIComponent(username)}/follow`),
  unfollow: (username: string) =>
    del<{ following: boolean }>(`/authors/${encodeURIComponent(username)}/follow`),
  // ── 创建（Agent）────────────────────────────────────────────────
  /*
    /agent/ask 是 SSE，不走这里的 JSON 辅助函数——它要逐字读 body，见
    create.tsx 的 streamAsk。这里只放它周边那几条普通请求。
  */
  agentStatus: () => get<{
    configured: boolean;
    model: string;
    /** 平台配了哪几条模型通道（AGENT_MODELS）。只有一条时创建屏不画下拉。 */
    models: { id: string; label: string; mult?: string }[];
    /** 平台认不认思考档位（AGENT_EFFORT）。不认就不画那个分段。 */
    effort: boolean;
    /** 生图通道（AGENT_IMAGE_MODELS）。空数组 = 平台不会生图。 */
    imageModels: { id: string; label: string; mult?: string }[];
  }>('/agent/status'),
  /**
   * 开一条新会话、一个新工作区（docs/specs/2026-10-21-agent-harness.md §1）。
   *
   * 创建屏一进来就要：预览和设计扇出都在第一句对话之前，它们得知道往哪个
   * 工作区里看、往哪个工作区里写。
   */
  agentSession: () => post<{ sessionId: string }>('/agent/session'),
  /**
   * 撤回这一步：工作区退回这一轮开始前的样子，对话也截回那一刻。
   * label 是那一轮用户说的话——放回输入框，人改两个字就能重说。
   */
  agentUndo: (sessionId: string) =>
    post<{ label: string; written: number; removed: number; left: number }>('/agent/undo', { sessionId }),
  /** 我最近的会话（左上角「历史版本」）。一句话都没说过的不列。 */
  agentSessions: () => get<{
    items: { id: string; title: string; slug: string | null; updatedAt: number }[];
  }>('/agent/sessions'),
  /** 一条会话的对话流（给人看的那份），点开历史会话时摆回工作台。 */
  agentSessionView: (id: string) => get<{
    id: string; slug: string | null; title: string; updatedAt: number;
    says: { me: boolean; text: string; files?: { name: string; mimeType: string; size: number; path: string }[] }[];
  }>(`/agent/session/${encodeURIComponent(id)}`),
  /** 复制为新页面：文件拷进新工作区，对话从头开始。 */
  agentFork: (id: string) => post<{ sessionId: string }>(`/agent/session/${encodeURIComponent(id)}/fork`, {}),
  /** 这条会话的每一步快照（右上角「版本记录」），新的在前。 */
  agentVersions: (sessionId: string) => get<{ items: { seq: number; label: string; at: number }[] }>(
    `/agent/versions?sessionId=${encodeURIComponent(sessionId)}`,
  ),
  /** 退回到第 seq 步之前：文件与对话一起退，之后的步骤作废。 */
  agentRestore: (sessionId: string, seq: number) =>
    post<{ label: string; written: number; removed: number; left: number }>('/agent/restore', { sessionId, seq }),
  /** 「更多 → 导出代码」的下载地址。同源、带登录态，直接给 <a download>。 */
  workspaceZipUrl: (sessionId: string, name: string) =>
    `${BASE}/agent/workspace/zip?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`,
  /**
   * 把已有的代码包导进工作区接着改。
   *
   * 走 multipart 而不是 base64：代码包可以到几十 MB，base64 会再胀三分之一，
   * 而且要整份进内存。
   */
  workspaceImport: async (sessionId: string, file: File) => {
    const fd = new FormData();
    fd.append('sessionId', sessionId);
    fd.append('file', file, file.name);
    const res = await fetch(`${BASE}/agent/workspace/import`, {
      method: 'POST', credentials: 'same-origin', body: fd,
    });
    const body = (await res.json()) as { files: number; bytes: number } & Partial<ApiError>;
    if (!res.ok) throw Object.assign(new Error(body.message ?? '导入失败'), { code: body.code });
    return body;
  },
  /** 工作区文件树（工作台「代码」页）。扁平路径表，前端自己摞成树。 */
  workspaceTree: (sessionId?: string | null) => get<{ entries: { path: string; dir: boolean; size: number }[] }>(
    `/agent/workspace${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
  ),
  /** 单个文件的内容。二进制与超大文件只给标记，不送内容。 */
  workspaceFile: (path: string, sessionId?: string | null) => get<{
    path: string; size: number; text: string; binary?: boolean; tooBig?: boolean;
  }>(`/agent/workspace/file?path=${encodeURIComponent(path)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  /** Agent 发起的待确认发布。token 是一次性的，用掉即失效。 */
  agentPending: () =>
    get<{ items: { confirmToken: string; site: string; summary: string; createdAt: number }[] }>(
      '/agent/pending',
    ),
  /** 确认并真的发布：核销 token，把工作区走一遍正规发布链路。手机壳与外部 AI 那条路用。 */
  agentPublish: (confirmToken: string, name?: string) =>
    post<{ app: App; url: string; summary: string }>('/agent/publish', { confirmToken, name }),
  /**
   * iDo 工作台的发布：发这段对话的工作区，不要令牌——人在界面前点这一下就是确认。
   * 地址被自己另一个页面占着时回 ALREADY_EXISTS，明说 overwrite 才覆盖。
   */
  agentPublishSession: (body: {
    sessionId: string; site?: string; name?: string; overwrite?: boolean; device?: 'phone' | 'pc';
  }) =>
    post<{ app: App; url: string }>('/agent/publish-session', body),

  /**
   * 开一个工作区实时预览（docs/specs/2026-10-20-preview-runtime.md）。
   *
   * `url` 是同源相对路径，直接塞进 iframe 的 src。`token` **不要**拼进地址
   * ——它是给沙箱里的页面取数用的，经 postMessage 递进去，印在地址里等于
   * 截个图就泄露了。
   */
  previewOpen: (sessionId?: string | null) => post<{
    previewId: string;
    token: string;
    url: string;
    expiresAt: number;
    idleMs: number;
  }>('/preview-session', sessionId ? { sessionId } : undefined),
  /**
   * 这个工作区能不能直接伺服出来看。
   *
   * 每次刷新前都问一遍——工作区一直在变，上一轮是个单页面、这一轮加了个
   * server.js，判定就该跟着变。
   */
  /**
   * 换一张试玩令牌，换到的地址直接塞进 iframe 的 src。
   *
   * 为什么不能直接用 /{owner}/{slug}/：预览 iframe 没有 allow-same-origin，
   * 里面是 opaque origin，它发出的子资源请求被浏览器当作跨站，SameSite=Lax
   * 的会话 cookie 不带——而那条路径下连 CSS 都要鉴权，于是只剩一页裸 HTML。
   * 令牌在路径里，相对路径的子资源天然继承它。
   */
  playOpen: (owner: string, slug: string) => post<{
    token: string;
    url: string;
    expiresAt: number;
    idleMs: number;
  }>('/play-session', { owner, slug }),

  previewKind: (previewId: string) => get<{
    kind: 'static' | 'server' | 'build' | 'empty';
    why: string;
    signals: string[];
  }>(`/preview-session/${encodeURIComponent(previewId)}/kind`),

  /** 「选方向」。为你推荐那一屏按它加权排序。 */
  interests: () => get<{ interests: Interest[] }>('/me/interests'),
  setInterests: (interests: Interest[]) =>
    send<{ interests: Interest[] }>('PUT', '/me/interests', { interests }),

  // ── 1024 程序员节 ──────────────────────────────────────────────
  /**
   * 活动详情。**不要求登录**——没有会话时服务端返回的 `me` 是 null，
   * 页面照常显示，只是不知道「我」交没交创意。
   */
  event: (slug: string) => get<EventResponse>(`/events/${slug}`),
  putIdea: (slug: string, input: IdeaInput) =>
    send<{ ok: boolean; ideaId: string }>('PUT', `/events/${slug}/idea`, input),
  putWork: (slug: string, input: WorkInput) =>
    send<{
      ok: boolean; workId: string; appVersion: number | null;
      /**
       * 交页面作品时服务端顺手做的两件事：设成全公司可见、上架到创意市场。
       * 交硬件作品（kind='other'）时是 null。
       */
      shared: { madePublic: boolean; listed: boolean } | null;
    }>('PUT', `/events/${slug}/work`, input),
  /** 投票是开关：投过再点就是撤回。remaining 是服务端算的真实剩余票数。 */
  toggleVote: (slug: string, ideaId: string) =>
    post<{ ok: boolean; voted: boolean; remaining: number }>(`/events/${slug}/votes/${ideaId}`),
  judgeBoard: (slug: string) => get<EventJudgeResponse>(`/events/${slug}/judge`),
  /** 初筛投票：评委挑出他认为该入围的创意。 */
  screeningBoard: (slug: string) =>
    get<EventScreeningResponse>(`/events/${slug}/judge/screening`),
  /** 投/撤一票。开关语义，和人气奖那颗按钮一致。 */
  screeningVote: (slug: string, ideaId: string) =>
    post<{ ok: boolean; voted: boolean; remaining: number }>(
      `/events/${slug}/judge/screening/${ideaId}`,
    ),
  /** 交卷。投满 8 票才收，服务端会再数一遍。 */
  submitScreening: (slug: string) =>
    post<{ ok: boolean; submitted: boolean }>(`/events/${slug}/judge/screening/submit`),
  /** 撤回交卷，票重新可改。 */
  unsubmitScreening: (slug: string) =>
    del<{ ok: boolean; submitted: boolean }>(`/events/${slug}/judge/screening/submit`),
  putScore: (slug: string, ideaId: string, input: ScoreInput) =>
    send<{ ok: boolean; total: number; submitted: boolean }>('PUT', `/events/${slug}/scores/${ideaId}`, input),
  /**
   * 附件上传。走 multipart，不能用上面那几个 JSON 辅助函数。
   * 故意不设 content-type：浏览器会自己带上 multipart 的 boundary，
   * 手写会把 boundary 弄丢，服务端解析不出字段。
   */
  uploadEventFile: async (slug: string, file: File): Promise<EventFile> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE}/events/${slug}/files`, {
      method: 'POST', credentials: 'same-origin', body: form,
    });
    const body = (await res.json()) as { file: EventFile } & Partial<ApiError>;
    if (!res.ok) throw Object.assign(new Error(body.message ?? '上传失败'), { code: body.code });
    return body.file;
  },
};

/** 从当前路径解析出空间归属者。`/` 表示还没落到具体空间。 */
export function ownerFromPath(): string | null {
  const seg = location.pathname.split('/').filter(Boolean);
  return seg[0] ?? null;
}
