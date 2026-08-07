import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import {
  API_BASE,
  ERROR_CODES,
  IspaceError,
  RESERVED_PATHS,
  appSlugSchema,
  provisionRequestSchema,
  schemaNameFor,
  usernameSchema,
} from '@ispace/contracts';
import {
  createDb,
  createUser,
  dbConfigFromEnv,
  findUserById,
  findUserBySso,
  findUserByUsername,
  getPlatformPolicy,
  getQuota,
  listAppsByOwner,
  listAudit,
  listReleases,
  findApp,
  provisionUserSchema,
  refreshStorageUsage,
  runMigrations,
  writeAudit,
  type Sql,
} from '@ispace/db';
import {
  MockAuthProvider,
  SessionService,
  clearSessionCookie,
  createAuthProvider,
  sessionCookie,
  type SessionClaims,
} from '@ispace/auth';
import { storageConfigFromEnv } from '@ispace/storage';
import { createOrchestrator } from '@ispace/orchestrator';
import { DeployService } from './services/deploy.js';
import { deleteApp } from './services/app-delete.js';
import { registerMcp } from './mcp/server.js';
import { registerShareRoutes } from './routes/shares.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerGovernanceRoutes } from './routes/governance.js';
import { registerBackendRoutes } from './routes/backends.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerMobileRoutes } from './routes/mobile.js';
import { startMaintenanceJobs } from './jobs/maintenance.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerTokenRoutes, findUserByAccessToken } from './routes/tokens.js';
import { registerMarketplaceRoutes } from './routes/marketplace.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { registerDataSpaceRoutes } from './routes/dataspace.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerOverviewRoutes } from './routes/overview.js';
import { registerAuthzRoutes } from './routes/authz.js';
import { registerSvcProxy } from './routes/svc-proxy.js';
import { registerConnectorRoutes } from './routes/connectors.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionClaims;
  }
}

/**
 * 平台对外的根地址，用于拼绝对 URL（重置链接、二维码、manifest 里的包地址）。
 *
 * 默认值只服务于本机开发——本进程自己的监听地址（本机没有网关，路径前缀
 * `/deploy/api` 由本进程自己注册，直连即可）。任何真实部署都必须显式设
 * `ISPACE_PUBLIC_BASE`，否则发出去的链接会指回 localhost。
 * 公网部署请用 https，见 `.env.example` 与 `docs/runbooks/deployment.md`。
 */
const PUBLIC_BASE = process.env.ISPACE_PUBLIC_BASE ?? 'http://localhost:3100';
/**
 * 会话有效期的**兜底值**。
 *
 * 真正生效的是管理员在「平台设置」里配的 platform_policy.session_days，
 * 由 sessionTtl() 现读。这个常量只在读不到策略时用（迁移未跑完的窗口期）。
 *
 * 原先这里写死 12 小时，而设置页上那一项存了也白存——同一类
 * "设置与实现脱节"，密码下限也栽过一次。
 */
const SESSION_TTL_FALLBACK = 60 * 60 * 12;

/**
 * 手机壳的深链回跳地址。写死而非从请求里取——它是唯一被允许的非站内跳转，
 * 可配置就等于把开放重定向又开回来。与 app.json 的 scheme 必须一致。
 */
const NATIVE_REDIRECT = 'ispace://auth';
/** 换取码有效期。够走完一次浏览器回跳，短到没什么被利用的余地。 */
const NATIVE_CODE_TTL_MS = 60_000;
/**
 * 配对有效期。人要在浏览器里完成一次公司 SSO，可能还要输密码、过二次验证，
 * 60 秒不够，5 分钟是个不会让人手忙脚乱又不至于长期挂着的值。
 */
const PAIRING_TTL_MS = 5 * 60_000;


/**
 * 登录成功后跳哪儿。
 *
 * 这是个开放重定向的口子：state 由调用方构造，若原样信任，
 * 攻击者能让用户在完成登录后被送到自己的站点（还带着刚设的 cookie）。
 * 因此只放行两种：
 *   1. 站内相对路径（/ 开头且不是 //，后者是协议相对 URL，会跑到外站）
 *   2. 手机壳那一个写死的深链，且只有它——放行任意 scheme 等于没防
 *
 * 其余一律回落到用户自己的空间。
 */
export type RedirectDecision =
  | { kind: 'web'; to: string }
  | { kind: 'native' };

/** 从 state 里取手机端的配对 id。解析失败一律当没有，不抛。 */

/**
 * 手机登录完成页。
 *
 * 停在这里而不是跳深链——深链会重建 App 的 Activity，把正在轮询的状态清掉。
 * App 会在一两秒内轮询到令牌并自己关掉这个浏览器窗口，所以这页只要
 * 在那一两秒里让人知道"成了、别乱点"就够了。
 */
function nativeDonePage(displayName: string): string {
  const safe = displayName.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录成功</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;
       background:#fcfcf8;color:#1c1f23;
       font:16px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif}
  .box{text-align:center;padding:24px}
  .ok{width:56px;height:56px;border-radius:50%;background:#e8f5ef;color:#00a365;
      display:grid;place-items:center;font-size:28px;margin:0 auto 16px}
  h1{font-size:20px;margin:0 0 6px}
  p{margin:0;color:#545659;font-size:14px}
</style>
<div class="box">
  <div class="ok">✓</div>
  <h1>已登录为 ${safe}</h1>
  <p>正在返回 App，这个页面会自动关闭</p>
</div>`;
}

export function readPairingId(state: string | undefined): string | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as {
      pairing?: unknown;
    };
    return typeof parsed.pairing === 'string' && parsed.pairing.length > 0 ? parsed.pairing : null;
  } catch {
    return null;
  }
}

export function decideRedirect(state: string | undefined, fallback: string): RedirectDecision {
  if (!state) return { kind: 'web', to: fallback };
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as {
      redirect?: unknown;
    };
    const r = parsed.redirect;
    if (typeof r !== 'string') return { kind: 'web', to: fallback };
    if (r === NATIVE_REDIRECT) return { kind: 'native' };
    if (r.startsWith('/') && !r.startsWith('//')) return { kind: 'web', to: r };
  } catch {
    // state 损坏（截断、被改过）就当没给
  }
  return { kind: 'web', to: fallback };
}

/**
 * 定位迁移目录。
 *
 * 源码运行时（tsx）与容器运行时（编译后的 dist）相对 import.meta.url 的层级
 * 不同：前者是 apps/deploy-service/src/，后者是 /app/dist/。写死相对层级会在
 * 其中一种下失败，且失败发生在启动瞬间——容器进入 restart 循环，日志刷屏，
 * 排查成本远高于这里多探几个候选路径。
 */
function resolveMigrationsDir(): string {
  if (process.env.ISPACE_MIGRATIONS_DIR) return process.env.ISPACE_MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'packages', 'db', 'migrations'),          // 容器：/app/dist → /app/packages
    join(here, '..', '..', '..', 'packages', 'db', 'migrations'), // 源码：apps/x/src → 仓库根
    join(here, '..', '..', '..', '..', 'packages', 'db', 'migrations'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `找不到迁移目录，尝试过：\n  ${candidates.join('\n  ')}\n可用 ISPACE_MIGRATIONS_DIR 显式指定。`,
    );
  }
  return found;
}

export interface BuildOptions {
  sql?: Sql;
  skipMigrations?: boolean;
}

export async function buildServer(opts: BuildOptions = {}): Promise<FastifyInstance> {
  /**
   * 一次性登录码 → 会话令牌。
   *
   * NOTE(多实例)：存在内存里。横向扩容时必须外置到 Redis，否则壳拿着码
   * 打到另一个实例会换不出来——表现为"登录了但又回到登录页"。
   * 单实例部署下（规格 §12）够用，且这些码 60 秒就过期，不会堆积。
   */
  const nativeCodes = new Map<string, { token: string; expiresAt: number }>();
  /**
   * 配对：手机自己生成的一次性 id → 登录成功后的令牌。
   *
   * 为什么不只靠深链回跳：实测荣耀机上 Chrome 送来的 intent 带
   * FLAG_ACTIVITY_CLEAR_TOP，配 singleTask 会重建 Activity，
   * openAuthSessionAsync 那个 Promise 直接消失——表现为"登录完又回到登录页"。
   * 各家 ROM 行为不一致，靠它不可靠。
   *
   * 改由手机主动轮询：无论深链有没有送达、Activity 有没有被重建，
   * 甚至用户手动切回 App，都能把令牌取到。
   */
  const pairings = new Map<string, { token?: string; expiresAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of nativeCodes) if (v.expiresAt < now) nativeCodes.delete(k);
    for (const [k, v] of pairings) if (v.expiresAt < now) pairings.delete(k);
  }, 60_000).unref();

  const sql = opts.sql ?? createDb(dbConfigFromEnv());
  const storage = storageConfigFromEnv();
  const deployService = new DeployService(sql, storage, PUBLIC_BASE);
  const authProvider = createAuthProvider();
  const orchestrator = createOrchestrator();
  const sessions = new SessionService(
    process.env.SESSION_SECRET ?? 'dev-only-secret-at-least-32-characters-long',
    SESSION_TTL_FALLBACK,
  );

  /**
   * 当前的会话有效期（秒）。每次签发都现读，不缓存——
   * 缓存的代价是管理员改完设置要等重启才生效。
   * 这是一次主键查询，比签一次 JWT 便宜得多。
   */
  const sessionTtl = async (): Promise<number> => {
    try {
      const { sessionDays } = await getPlatformPolicy(sql);
      return sessionDays * 86400;
    } catch {
      return SESSION_TTL_FALLBACK;
    }
  };

  if (!opts.skipMigrations) {
    const ran = await runMigrations(sql, resolveMigrationsDir());
    if (ran.length) console.log(`已应用迁移：${ran.join(', ')}`);
  }

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // 产物 zip 走 multipart，正文本身不大；但 multipart 插件的限制单独设
    bodyLimit: 1024 * 1024,
    /**
     * 只信任一跳代理。
     *
     * 本服务只经 Traefik 对外，req.ip 默认拿到的是 Traefik 在 docker 网络里的
     * 地址——每条审计都记成同一个 10.0.x.x，那一列等于没有。设为 1 后
     * Fastify 取 X-Forwarded-For 的最后一跳，即 Traefik 记下的真实客户端。
     *
     * 用 1 而不是 true：true 会一路信任整条 XFF 链，客户端自己伪造一个
     * X-Forwarded-For 头就能让审计记录里出现任意 IP。只信一跳则伪造无效——
     * Traefik 会把真实 socket 地址追加在链尾。
     */
    trustProxy: 1,
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  });

  /**
   * 空 body 的 JSON 请求当作 {} 处理。
   *
   * Fastify 默认的 JSON 解析器碰到「声明了 content-type: application/json
   * 但 body 是空的」会抛，最终变成 500。
   *
   * 而这正是浏览器端的常态：前端的 req()/post() 统一给所有请求带上
   * content-type，而「退出登录」「吊销令牌」「开通」「重跑回收」这类动作
   * 本来就没有 body——一整批 POST 端点因此全部 500，且因为前端把错误
   * catch 掉了，表现是"点了没反应"，没有任何线索指向 body 解析。
   * 退出登录就是这么坏的：cookie 从来没被清掉过。
   *
   * 客户端那边也一并改成没 body 就不发 content-type（那本来就是正确的
   * HTTP 语义），但服务端这一层也必须兜住：没有 body 的 POST 是完全合法的，
   * 不该由请求体解析决定一个业务动作成不成。
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (raw === '') return done(null, {});
      try {
        done(null, JSON.parse(raw) as unknown);
      } catch {
        done(new IspaceError(ERROR_CODES.INVALID_INPUT, '请求体不是合法的 JSON'), undefined);
      }
    },
  );

  // ── 统一错误处理 ────────────────────────────────────────────────
  // 让 REST、CLI、MCP 三个入口对同一个失败呈现一致的 code/message。
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof IspaceError) {
      return reply.status(err.httpStatus).send(err.toJSON());
    }
    // 正文超限。Fastify 默认把它当 500 抛，用户看到"服务内部错误"，
    // 完全看不出是自己传的东西太大——而这恰恰是他能自己解决的问题。
    const code = (err as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      /*
        说清**多大算大**和**改走哪条路**。
        原先只说"内容太大了"——用户（和模型）既不知道该压到多少，
        也不知道还有别的路可走，只能卡在那里。
      */
      const viaMcp = _req.url.startsWith('/deploy/mcp');
      return reply.status(413).send({
        code: ERROR_CODES.INVALID_INPUT,
        message: viaMcp
          ? '产物太大，超过 MCP 单次请求的 48 MB 上限（base64 编码后还要涨 1/3）。'
            + '请用命令行上传：ai-deploy up ./dist /你的路径 —— 那条路走 multipart，上限 200 MB。'
          : '内容太大，超过本接口的上限。产物上传请用 multipart（CLI 的 ai-deploy up）。',
      });
    }
    // zod 与 fastify schema 的校验错误统一映射成 INVALID_INPUT
    const maybe = err as { validation?: unknown; issues?: unknown; message?: string };
    if (maybe.validation || maybe.issues) {
      return reply.status(422).send({
        code: ERROR_CODES.INVALID_INPUT,
        message: maybe.message ?? '入参不合法',
      });
    }
    app.log.error(err);
    return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: '服务内部错误' });
  });

  // ── 鉴权 ────────────────────────────────────────────────────────
  /**
   * 认两种凭据：
   *   会话 JWT   —— 浏览器 cookie 或 Bearer，12 小时过期
   *   个人访问令牌 —— isp_ 前缀，供 MCP 与 CLI 用，可长期有效、可单独撤销
   *
   * 两种都走同一条用户状态检查，因此归档账号会立即失去全部访问权，
   * 不论用哪种凭据。
   */
  const requireAuth = async (req: FastifyRequest) => {
    const raw = sessions.extract({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    if (!raw) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');

    let userId: string;
    if (raw.startsWith('isp_')) {
      const found = await findUserByAccessToken(sql, raw);
      if (!found) {
        throw new IspaceError(
          ERROR_CODES.UNAUTHENTICATED,
          '访问令牌无效、已撤销或已过期。请在控制台「接入指引」重新创建。',
        );
      }
      userId = found.userId;
    } else {
      const claims = await sessions.verify(raw);
      req.session = claims;
      userId = claims.uid;
    }

    // 每次都查库：令牌无状态，靠这里的 status 检查实现即时冻结
    const user = await findUserById(sql, userId);
    if (!user || user.status !== 'active') {
      throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '账号不可用');
    }
    return user;
  };

  const requireAdmin = async (req: FastifyRequest) => {
    const user = await requireAuth(req);
    if (user.role !== 'admin') {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '需要管理员权限');
    }
    return user;
  };

  // ── 健康检查 ────────────────────────────────────────────────────
  app.get(`${API_BASE}/health`, async () => {
    await sql`SELECT 1`;
    return { ok: true, service: 'deploy-service' };
  });

  // ── 认证 ────────────────────────────────────────────────────────
  /**
   * 第三方登录（SSO）。
   *
   * 没有配置身份提供方时这两个端点直接 404 而不是回落到开发登录——
   * 平台的主路径是邮箱 + 密码（routes/account.ts），不经过这里。
   * 「没配就回落 mock」曾让一个任何人都能选管理员进来的页面
   * 在生产上长期敞着，见 packages/auth/src/provider.ts 的注释。
   */
  const requireProvider = (): NonNullable<typeof authProvider> => {
    if (!authProvider) {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, '本平台未启用第三方登录，请用邮箱和密码登录');
    }
    return authProvider;
  };

  app.get(`${API_BASE}/auth/login`, async (req, reply) => {
    const provider = requireProvider();
    const q = req.query as { redirect?: string; pairing?: string };
    // pairing 由手机端生成并带上，登录完成后令牌存到它名下供轮询取走
    const state = Buffer.from(
      JSON.stringify({ redirect: q.redirect ?? '/', pairing: q.pairing }),
    ).toString('base64url');
    const redirectUri = `${PUBLIC_BASE}${API_BASE}/auth/callback`;
    return reply.redirect(provider.authorizeUrl({ state, redirectUri }));
  });

  /**
   * mock 登录页。仅在未配置真实 OIDC 时可达。
   * 提供身份与角色选择——控制台双视角、移动端身份门控都要靠它本地验证。
   */
  app.get(`${API_BASE}/auth/mock`, async (req, reply) => {
    if (!(authProvider instanceof MockAuthProvider)) {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, '未启用 mock 登录');
    }
    const q = req.query as { state?: string; redirect_uri?: string };
    const cb = q.redirect_uri ?? `${PUBLIC_BASE}${API_BASE}/auth/callback`;
    const rows = await sql<{ username: string; display_name: string; role: string; identity: string }[]>`
      SELECT username, display_name, role, identity FROM ispace.users
       WHERE status = 'active' ORDER BY created_at LIMIT 20
    `;
    const options = rows
      .map(
        (r) =>
          `<li><a href="${cb}?state=${q.state ?? ''}&code=${MockAuthProvider.makeCode(r.username, r.identity as 'user', r.role as 'employee')}">
            ${r.display_name} <code>${r.username}</code> · ${r.role} · ${r.identity}</a></li>`,
      )
      .join('');
    return reply.type('text/html').send(`<!doctype html><meta charset="utf-8">
<title>ispace 开发登录</title>
<style>body{font:14px/1.6 system-ui;max-width:640px;margin:60px auto;padding:0 20px}
h1{font-size:20px}li{margin:8px 0}a{color:#1c1f23}code{background:#f3f3f3;padding:1px 5px;border-radius:4px}
.warn{background:#fff6ed;border:1px solid #fb923c;padding:10px 14px;border-radius:8px;margin:16px 0}</style>
<h1>开发登录</h1>
<div class="warn">
  <b>这是开发登录页，不是公司 SSO。</b><br>
  任何能打开这个地址的人都可以选任意身份进来（包括管理员），
  对外开放前必须接入真实 SSO。<br>
  配好 OIDC_ISSUER / CLIENT_ID / CLIENT_SECRET 后此页自动返回 404，
  无需另设开关。做法见仓库 <code>docs/runbooks/sso-setup.md</code>。
</div>
<p>选择要登录的身份：</p><ul>${options || '<li>还没有用户，请先调用 /provision 开通</li>'}</ul>`);
  });

  app.get(`${API_BASE}/auth/callback`, async (req, reply) => {
    const provider = requireProvider();
    const q = req.query as { code?: string; state?: string };
    if (!q.code) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '缺少授权码');

    const claims = await provider.exchange({
      code: q.code,
      redirectUri: `${PUBLIC_BASE}${API_BASE}/auth/callback`,
    });

    let user = await findUserBySso(sql, claims.sub);

    /**
     * 预开通账号的首次登录绑定。
     *
     * 管理员经 /provision 开通的账号，其 sso_subject 是占位值 `manual|{username}`
     * ——开通时并不知道该员工在 IdP 里的真实 sub。此人首次 SSO 登录时按用户名
     * 匹配到该占位账号，把真实 sub 绑上去。
     *
     * 安全约束：只绑定 sso_subject 仍是 `manual|` 前缀（即从未登录过）的账号。
     * 已绑定过的账号不会被再次改写，否则同名冲突会变成账号劫持。
     */
    if (!user && claims.preferredUsername) {
      const byName = await findUserByUsername(sql, claims.preferredUsername);
      if (byName?.ssoSubject.startsWith('manual|')) {
        await sql`
          UPDATE ispace.users SET sso_subject = ${claims.sub} WHERE id = ${byName.id}
        `;
        user = { ...byName, ssoSubject: claims.sub };
        app.log.info(`预开通账号 ${byName.username} 已绑定 SSO subject`);
      }
    }

    if (!user) {
      // 首次登录自动开通。用 preferredUsername 作为路径标识；冲突或非法则拒绝，
      // 由管理员经 /provision 指定一个合法标识——不自动加数字后缀，
      // 因为路径是要长期对外的，机器生成的 lixiao2 这类标识很难改回来。
      const candidate = claims.preferredUsername ?? claims.sub;
      const parsed = usernameSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new IspaceError(
          ERROR_CODES.RESERVED_NAME,
          `无法从 SSO 档案推导出合法的空间标识（${candidate}）。请联系管理员开通。`,
        );
      }
      if (await findUserByUsername(sql, parsed.data)) {
        throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, `空间标识 ${parsed.data} 已被占用`);
      }
      user = await createUser(sql, {
        ssoSubject: claims.sub,
        username: parsed.data,
        displayName: claims.name,
        email: claims.email ?? null,
        role: claims.role ?? 'employee',
        identity: claims.identity ?? 'user',
      });
      await provisionUserSchema(sql, user.username);
    }

    const ttl = await sessionTtl();
    const token = await sessions.issue({
      uid: user.id, username: user.username, role: user.role, identity: user.identity,
    }, ttl);
    // cookie 的 Max-Age 必须与令牌的 exp 一致：cookie 先过期会让人莫名
    // 被登出，令牌先过期则会让人拿着一个已失效的 cookie 一路 401
    reply.header('set-cookie', sessionCookie(token, ttl));

    const pairingId = readPairingId(q.state);
    if (pairingId) {
      // 令牌存下等手机来取，然后**停在网页上**，不跳深链。
      //
      // 实测：跳 ispace:// 时 Chrome 发出的 intent 带 FLAG_ACTIVITY_CLEAR_TOP，
      // 配 singleTask 会重建 MainActivity——正在轮询的 JS 状态连同 React 树
      // 一起被清掉，用户看到的是"登录完又回到登录页"。
      // 轮询本来就不需要深链，那就别跳，让 App 安安静静把令牌取走。
      pairings.set(pairingId, { token, expiresAt: Date.now() + PAIRING_TTL_MS });
      return reply.type('text/html; charset=utf-8').send(nativeDonePage(user.displayName));
    }

    const decision = decideRedirect(q.state, `/${user.username}/`);

    if (decision.kind === 'native') {
      /**
       * 手机壳走一次性换取码，而不是把会话令牌直接拼进深链。
       *
       * 安卓上任何应用都能注册 ispace:// 并抢先响应——令牌若在 URL 里，
       * 被劫持就等于拿到 12 小时的完整身份。换取码 60 秒过期、只能用一次，
       * 且必须由持有它的一方主动来换，被劫持的窗口小一个数量级。
       */
      const code = randomUUID();
      nativeCodes.set(code, { token, expiresAt: Date.now() + NATIVE_CODE_TTL_MS });
      return reply.redirect(`${NATIVE_REDIRECT}?code=${code}`);
    }
    return reply.redirect(decision.to);
  });

  /**
   * 用一次性码换会话令牌。仅手机壳使用。
   *
   * 无需鉴权——码本身就是凭据。取走即删，因此重放拿不到第二次。
   */
  /**
   * 轮询配对结果。手机端每隔一两秒问一次，直到拿到令牌。
   *
   * 取走即删，因此同一个 id 换不到第二次。没登录完就返回 pending，
   * 让手机端继续等——不能报错，否则用户还在浏览器里输密码，
   * App 这边已经先失败了。
   */
  app.get(`${API_BASE}/auth/native/poll`, async (req) => {
    const { id } = req.query as { id?: string };
    const entry = id ? pairings.get(id) : undefined;
    if (!entry || entry.expiresAt < Date.now()) {
      if (id) pairings.delete(id);
      return { status: 'expired' as const };
    }
    if (!entry.token) return { status: 'pending' as const };
    pairings.delete(id!);
    return { status: 'ok' as const, token: entry.token, expiresIn: await sessionTtl() };
  });

  /** 手机端开始登录前先登记，避免轮询打在一个服务端根本不认识的 id 上。 */
  app.post(`${API_BASE}/auth/native/pair`, async () => {
    const id = randomUUID();
    pairings.set(id, { expiresAt: Date.now() + PAIRING_TTL_MS });
    return { pairingId: id, expiresIn: Math.floor(PAIRING_TTL_MS / 1000) };
  });

  /**
   * 铸一个扫码登录用的一次性码（设计稿第 10 屏的「扫码登录」次要入口）。
   *
   * 流向与常见的"网页扫码"相反：这里是**已登录的桌面端**生成二维码，
   * **未登录的手机**扫它换会话——手机有摄像头、桌面有会话，各出各的。
   *
   * 安全边界（码等于 60 秒内的临时钥匙，被拍屏就是被偷）：
   *   - 60 秒过期（NATIVE_CODE_TTL_MS），弹窗里带倒计时
   *   - 用一次即毁（exchange 取走即删，先到先得）
   *   - 铸码进审计：谁在什么时候用哪个 IP 生成过登录码，事后能查
   *   - 码只对应铸码人自己的会话——扫到别人的码等于登成那个人，
   *     但那需要在 60 秒内拍到屏幕，与把密码念出来同级别的主动泄露
   */
  app.post(`${API_BASE}/auth/native/code`, async (req) => {
    const user = await requireAuth(req);
    const code = randomUUID();
    const ttl = await sessionTtl();
    const token = await sessions.issue({
      uid: user.id, username: user.username, role: user.role, identity: user.identity,
    }, ttl);
    nativeCodes.set(code, { token, expiresAt: Date.now() + NATIVE_CODE_TTL_MS });
    await writeAudit(sql, {
      actorId: user.id, action: 'user.qr_login', targetType: 'user', targetId: user.id,
      source: 'console', result: 'success',
      metadata: { minted: true }, ip: req.ip,
    });
    return { code, expiresIn: Math.floor(NATIVE_CODE_TTL_MS / 1000) };
  });

  app.post(`${API_BASE}/auth/native/exchange`, async (req) => {
    const { code } = (req.body ?? {}) as { code?: string };
    const entry = code ? nativeCodes.get(code) : undefined;
    if (entry) nativeCodes.delete(code!);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new IspaceError(
        ERROR_CODES.UNAUTHENTICATED,
        '登录码无效或已过期（60 秒内有效），请重新登录',
      );
    }
    return { token: entry.token, expiresIn: await sessionTtl() };
  });

  /**
   * 把手机 App 的会话交接给壳内的 WebView。
   *
   * 手机端要在 App 里以「类原生」的方式打开用户在电脑上做的静态页面，
   * 而那些页面受 Caddy forward_auth 保护，认的是浏览器 cookie。App 手里
   * 只有 Bearer 令牌，且 WebView 的自定义请求头只作用于首个请求，页面里的
   * js/css/图片一律裸奔——所以必须让 WebView 真正拿到 cookie。
   *
   * 复用扫码登录那套一次性码：App 用自己的令牌铸码（60 秒、用一次即毁），
   * WebView 加载本端点，服务端下发 Set-Cookie 后 302 到目标页。
   * 令牌本身始终不进 URL——码即使落进日志，事后也换不出任何东西。
   */
  app.get(`${API_BASE}/auth/native/handoff`, async (req, reply) => {
    const { code, to } = (req.query ?? {}) as { code?: string; to?: string };
    const entry = code ? nativeCodes.get(code) : undefined;
    if (entry) nativeCodes.delete(code!);

    // 只允许跳回本站内部路径。放开成任意 URL 等于送一个开放重定向，
    // 而这个端点会先把 cookie 发出去——那就是把会话送到站外。
    const target = to && /^\/[^/\\]/.test(to) ? to : '/';

    if (!entry || entry.expiresAt < Date.now()) {
      reply.status(401).type('text/html; charset=utf-8');
      return '<!doctype html><meta charset=utf-8><body style="font:16px/1.6 system-ui;padding:40px;color:#001217">'
        + '<h3>登录已过期</h3><p>请回到应用重新打开这个页面。</p></body>';
    }

    reply.header('set-cookie', sessionCookie(entry.token, await sessionTtl(), PUBLIC_BASE.startsWith('https://')));
    return reply.redirect(target, 302);
  });

  app.post(`${API_BASE}/auth/logout`, async (_req, reply) => {
    reply.header('set-cookie', clearSessionCookie());
    return { ok: true };
  });

  // ── 我 ──────────────────────────────────────────────────────────
  app.get(`${API_BASE}/me`, async (req) => {
    const user = await requireAuth(req);
    const quota = await getQuota(sql, user.id);
    return { user, quota, spaceUrl: `${PUBLIC_BASE}/${user.username}` };
  });

  // ── 应用 ────────────────────────────────────────────────────────
  app.get(`${API_BASE}/apps`, async (req) => {
    const user = await requireAuth(req);
    const apps = await listAppsByOwner(sql, user.id);
    const groups = await sql`
      SELECT * FROM ispace.app_groups WHERE owner_id = ${user.id} ORDER BY sort_order
    `;

    /**
     * 每个应用当前版本的版本号与入口（设计稿「我的页面」的 版本 / 入口 两列）。
     *
     * 一次 join 取回，不让前端按应用逐个查 releases——那是 N+1，
     * 页面一多列表就要等一串请求。之前这两列写死显示 "—" 就是因为
     * 这里没给数据。
     */
    const cur = await sql<{ app_id: string; version: number; source: string }[]>`
      SELECT r.app_id, r.version, r.source
        FROM ispace.releases r
        JOIN ispace.apps a ON a.id = r.app_id
       WHERE a.owner_id = ${user.id} AND r.id = a.current_release_id
    `;
    const byApp = new Map(cur.map((r) => [r.app_id, r]));

    // 哪些页面挂着后端。让列表能标出配套关系——否则「排班看板」和
    // 「paiban-api」在界面上是两个互不相干的东西。
    const withBackend = await sql<{ app_id: string; name: string }[]>`
      SELECT app_id, name FROM ispace.backends
       WHERE owner_id = ${user.id} AND app_id IS NOT NULL
    `;
    const backendOf = new Map(withBackend.map((b) => [b.app_id, b.name]));

    return {
      groups,
      apps: apps.map((a) => ({
        ...a,
        currentVersion: byApp.get(a.id)?.version ?? null,
        currentSource: byApp.get(a.id)?.source ?? null,
        backendName: backendOf.get(a.id) ?? null,
      })),
      total: apps.length,
    };
  });

  app.get(`${API_BASE}/apps/:slug/releases`, async (req) => {
    const user = await requireAuth(req);
    const { slug } = req.params as { slug: string };
    const a = await findApp(sql, user.id, slug);
    if (!a) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到应用 /${slug}`);
    const releases = await listReleases(sql, a.id);
    return { releases, total: releases.length };
  });

  // ── 部署 ────────────────────────────────────────────────────────
  app.post(`${API_BASE}/apps/:slug/deploy`, async (req) => {
    const user = await requireAuth(req);
    const { slug } = req.params as { slug: string };
    const parsedSlug = appSlugSchema.parse(slug);

    const file = await req.file();
    if (!file) throw new IspaceError(ERROR_CODES.INVALID_ARTIFACT, '缺少产物文件');

    const dir = await mkdtemp(join(tmpdir(), 'ispace-upload-'));
    const zipPath = join(dir, 'artifact.zip');
    try {
      await writeFile(zipPath, await file.toBuffer());
      const fields = file.fields as Record<string, { value?: string } | undefined>;
      return await deployService.deploy({
        user,
        slug: parsedSlug,
        zipPath,
        name: fields.name?.value,
        description: fields.description?.value,
        type: (fields.type?.value as 'static') ?? 'static',
        source: (fields.source?.value as 'cli') ?? 'cli',
        clientIp: req.ip,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  app.post(`${API_BASE}/apps/:slug/rollback`, async (req) => {
    const user = await requireAuth(req);
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as { toVersion?: number };
    const release = await deployService.rollback(user, slug, body.toVersion, req.ip);
    return { release, url: deployService.appUrl(user.username, slug) };
  });

  // 给存量页面补封面：封面功能之前发布的页面 cover_path 是 null，产物还在磁盘上，
  // 可就地回填，不必让用户重发。管理员在控制台触发，可重复跑。
  app.post(`${API_BASE}/admin/covers/backfill`, async (req) => {
    await requireAdmin(req);
    return deployService.backfillCovers();
  });

  /**
   * 删除页面。
   *
   * 此前完全没有这条路：控制台只能删分组，页面建了就删不掉——
   * 试错过的、名字起错的、临时试的，全都堆在列表里占着配额，
   * 还得找管理员上服务器清。
   *
   * 与 MCP 走同一个服务层，删除的次序要求只写一份。
   */
  app.delete(`${API_BASE}/apps/:slug`, async (req) => {
    const user = await requireAuth(req);
    const { slug } = req.params as { slug: string };
    return deleteApp(
      { sql, storage, log: app.log },
      { user, slug, source: 'console', clientIp: req.ip },
    );
  });

  // ── 配额 ────────────────────────────────────────────────────────
  app.get(`${API_BASE}/quota`, async (req) => {
    const user = await requireAuth(req);
    await refreshStorageUsage(sql, user.id);
    const quota = await getQuota(sql, user.id);

    /**
     * 后端 CPU / 内存的实测用量（设计稿「配额与用量」屏的第 3、4 条）。
     *
     * 数字来自宿主上的采样任务（infra/scripts/12-resource-sampler.sh），
     * 不是这里现算的——deploy-service 没有 docker.sock，也不该有。
     *
     * 采样超过 5 分钟没更新就当没有：显示一个十分钟前的用量比显示
     * "暂无数据"更糟，用户会照着它做扩容判断。
     */
    const usage = await sql<{ cpu: string; mem: string; stale: boolean }[]>`
      SELECT COALESCE(sum(u.cpu_cores), 0)::text                    AS cpu,
             COALESCE(sum(u.mem_mb), 0)::text                       AS mem,
             COALESCE(max(u.sampled_at) < now() - interval '5 minutes', true) AS stale
        FROM ispace.backends b
        LEFT JOIN ispace.backend_usage u ON u.backend_id = b.id
       WHERE b.owner_id = ${user.id} AND b.status = 'running'
    `;
    const u = usage[0];
    const measured = u && !u.stale;

    return {
      quota,
      backendCpuLimit: 0.5,
      backendMemLimitMb: 512,
      /** 该用户全部运行中后端的合计用量。null 表示还没采到数。 */
      backendCpuUsed: measured ? Number(u.cpu) : null,
      backendMemUsedMb: measured ? Number(u.mem) : null,
    };
  });

  // ── 开通 ────────────────────────────────────────────────────────
  app.post(`${API_BASE}/provision`, async (req) => {
    /**
     * 首次启动引导：库里一个用户都没有时，允许无鉴权创建第一个账号，
     * 并强制其为管理员。
     *
     * 没有这条路径就是死锁——开通需要管理员，而管理员只能被开通出来。
     * 窗口仅在"零用户"时存在，第一个账号建成后立即关闭；且引导创建的
     * 账号必然是管理员，避免有人抢先建一个普通账号把窗口关掉、导致
     * 平台永远没有管理员。
     */
    const countRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ispace.users
    `;
    const isBootstrap = (countRows[0]?.n ?? 0) === 0;

    const admin = isBootstrap ? null : await requireAdmin(req);
    const input = provisionRequestSchema.parse(
      isBootstrap ? { ...(req.body as object), role: 'admin' } : req.body,
    );
    if (isBootstrap) {
      app.log.warn(`首次启动引导：正在创建首个管理员账号 ${input.username}`);
    }

    if (await findUserByUsername(sql, input.username)) {
      throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, `空间标识 ${input.username} 已被占用`);
    }
    const user = await createUser(sql, {
      ssoSubject: `manual|${input.username}`,
      username: input.username,
      displayName: input.displayName,
      email: input.email ?? null,
      role: input.role,
      identity: input.identity,
    });
    // provisionUserSchema 内部严格遵守顺序：建 schema → 校验 → 改配置 → 双 NOTIFY
    await provisionUserSchema(sql, user.username);
    await writeAudit(sql, {
      // 引导时没有操作者，以被创建者自身作为 actor——审计不能有空缺，
      // metadata 里标注 bootstrap 便于事后辨认
      actorId: admin?.id ?? user.id,
      action: 'user.provision', targetType: 'user', targetId: user.id,
      source: 'console', result: 'success',
      metadata: { username: user.username, ...(isBootstrap ? { bootstrap: true } : {}) },
      ip: req.ip,
    });
    return { user, schemaName: schemaNameFor(user.username), spaceUrl: `${PUBLIC_BASE}/${user.username}` };
  });

  // ── 审计 ────────────────────────────────────────────────────────
  app.get(`${API_BASE}/audit`, async (req) => {
    const user = await requireAuth(req);
    const q = req.query as { limit?: string; offset?: string };
    // 员工只看自己的，管理员看全部
    return listAudit(sql, {
      ...(user.role === 'admin' ? {} : { actorId: user.id }),
      limit: Math.min(Number(q.limit ?? 50), 200),
      offset: Number(q.offset ?? 0),
    });
  });

  // ── 保留字（供前端注册表单即时校验，避免两处硬编码）──────────────
  app.get(`${API_BASE}/reserved-paths`, async () => ({ reserved: RESERVED_PATHS }));

  // ── 分享 ────────────────────────────────────────────────────────
  registerShareRoutes(app, { sql, requireAuth });

  // ── 管理员 ──────────────────────────────────────────────────────
  registerAdminRoutes(app, { sql, requireAdmin, orchestrator });

  // ── 治理面：单机负载、提额审批、策略、备份、探活、导出 ──────────
  registerGovernanceRoutes(app, {
    sql, requireAuth, requireAdmin,
    publicBase: PUBLIC_BASE,
    sitesRoot: process.env.ISPACE_SITES_ROOT ?? '/srv/sites',
  });

  // ── 后端应用与分组 ──────────────────────────────────────────────
  registerBackendRoutes(app, {
    sql, orchestrator, requireAuth,
    publicHost: new URL(PUBLIC_BASE).host,
  });
  registerGroupRoutes(app, { sql, requireAuth });

  // ── 个人访问令牌（MCP / CLI 凭据）──────────────────────────────
  registerTokenRoutes(app, { sql, requireAuth });

  // ── 创意市场 ────────────────────────────────────────────────────
  registerMarketplaceRoutes(app, { sql, requireAuth });

  // ── 语音转写 ────────────────────────────────────────────────────
  registerVoiceRoutes(app, { requireAuth });

  // ── 数据空间：表清单与连接信息 ──────────────────────────────────
  registerDataSpaceRoutes(app, { sql, requireAuth, publicBase: PUBLIC_BASE });

  // ── 连接器：外部 API 的凭据保管与出站代理 ──────────────────────
  // 与上面的数据空间是一对：那条给数据库，这条给外部 API。
  registerConnectorRoutes(app, { sql, requireAuth, requireAdmin });
  registerOverviewRoutes(app, { sql, requireAuth });

  // ── 静态页访问鉴权（Caddy forward_auth 的落点）────────────────────
  // 补的是一个真实存在过的越权：Caddy 此前直出文件，不带任何鉴权。
  registerAuthzRoutes(app, {
    sql,
    publicBase: PUBLIC_BASE,
    verifySession: (t) => sessions.verify(t).catch(() => null),
  });

  // 后端服务的鉴权代理（/svc/...）。Caddy 把 /svc 转过来，这里鉴权后代到容器。
  registerSvcProxy(app, {
    sql,
    verifySession: (t) => sessions.verify(t).catch(() => null),
  });

  // ── 邮箱密码注册与登录 ──────────────────────────────────────────
  registerAccountRoutes(app, {
    sql, requireAuth, requireAdmin,
    issueSession: async (u) => sessions.issue({
      uid: u.id, username: u.username, role: u.role, identity: u.identity,
    }, await sessionTtl()),
    setSessionCookie: async (reply, token) => {
      // 调用方会 await——见 account.ts 里那段注释：不 await 的话
      // header 会设在处理器 return 之后，cookie 根本不下发
      reply.header('set-cookie', sessionCookie(token, await sessionTtl()));
    },
    publicBase: PUBLIC_BASE,
  });

  // ── 移动端页面包发布 ────────────────────────────────────────────
  registerMobileRoutes(app, {
    sql, requireAuth,
    bundleRoot: process.env.ISPACE_BUNDLE_ROOT ?? '/srv/bundles',
    publicBase: PUBLIC_BASE,
  });

  // ── MCP ─────────────────────────────────────────────────────────
  await registerMcp(app, {
    sql, deployService, sessions, publicBase: PUBLIC_BASE, orchestrator, storage,
    bundleRoot: process.env.ISPACE_BUNDLE_ROOT ?? '/srv/bundles',
  });

  // ── Coding Agent ────────────────────────────────────────────────
  registerAgentRoutes(app, {
    sql, requireAuth,
    workspaceRoot: process.env.ISPACE_WORKSPACE_ROOT ?? '/srv/workspaces',
  });

  // ── 治理定时任务 ────────────────────────────────────────────────
  const stopJobs = startMaintenanceJobs(app, sql);

  app.addHook('onClose', async () => { stopJobs(); await sql.end({ timeout: 5 }); });
  return app;
}

/** 直接运行时启动。测试中 import buildServer 不会触发。 */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const server = await buildServer();
  const port = Number(process.env.PORT ?? 3100);
  await server.listen({ port, host: '0.0.0.0' });
  server.log.info(`deploy-service 监听 :${port}`);
}

export { randomUUID };
export type { FastifyReply };
