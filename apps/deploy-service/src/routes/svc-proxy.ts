import { request as httpRequest } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Sql } from '@ispace/db';
import { COOKIE_NAME, type SessionClaims } from '@ispace/auth';
import { readResourceSession } from '../services/resource-session.js';
import {
  LINK_COOKIE, appIdFromGrantCookie, isLinkCookie, linkCookie, linkNetworkAllowed, linkTokenMatches,
  splitLinkParam,
} from '../services/link-access.js';

/**
 * 后端服务的鉴权代理（/svc/{user}/{name}/...）。
 *
 * ┌─ 为什么由 iSpace 代理，而不是 Dokploy 直连 ─────────────────────────┐
 * │ 后端一直有 /svc 地址，但那是 Dokploy 生成 Traefik 路由文件、直连     │
 * │ 容器的——绕过页面那套 forward_auth，「知道 URL 就能访问」。而 Dokploy │
 * │ 的路由文件是自动生成的，手改会被下次部署覆盖，也没有挂中间件的口子。 │
 * │ 所以把 /svc 从 Dokploy 手里接管过来：Caddy 把 /svc 转给本服务，本服务 │
 * │ 先按页面同一套三档可见性鉴权，再按库里存的 container_name:port 代到   │
 * │ 容器。container_name 就是 swarm 里可路由的服务名（实测能连通）。      │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 鉴权分两种后端：
 *   - exposed=false（纯 API 服务）：给自己的页面用。只要求登录（任何本公司
 *     用户）——因为调它的页面被登录用户打开，分享出去的页面也要能调到。
 *   - exposed=true（全栈项目）：按 visibility 三档，与页面完全一致。
 *
 * 三档都已落地：private（仅本人/管理员）、shared（backend_shares 里有授权的
 * 同事）、public（任何登录用户）。加上 API-only 那种共四种判定。
 *
 * link（知道链接的任何人）在这之上再放进两类匿名访客：
 *   - 露出的后端：带着它自己的私密链接（?lk= 或 Path=/svc/{owner}/{name} 的 Cookie）
 *   - 纯 API 后端：打开了**同一作者**某个链接分享页面的人。页面那边的 authz
 *     会顺手下发一张 Path=/svc/{owner} 的 Cookie，这里认它——否则匿名访客
 *     打开了页面，页面里的 fetch 却全是 401。
 */

/**
 * 转发时必须丢掉的头。
 *   - 逐跳头：会和代理自己的连接语义打架。
 *   - host：原样转给容器的是 127.0.0.1:3100，很多框架据此判定非法请求直接 400。
 *     丢掉后由 node 按 container_name:port 自动设成对的 Host。
 *   - content-length：body 会被重新序列化，长度可能变，交给 node 重算。
 */
const DROP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'content-length',
]);

interface BackendRow {
  id: string;
  owner_id: string;
  exposed: boolean;
  visibility: string;
  status: string;
  container_name: string | null;
  port: number;
  link_token: string | null;
}

export function registerSvcProxy(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    verifySession: (token: string) => Promise<SessionClaims | null>;
    /** 链接访问 Cookie 是否加 Secure（线上 https）。 */
    secureCookies?: boolean;
  },
): void {
  const { sql, verifySession } = deps;

  // 路由放进封装插件，好在**只在这个作用域内**换 body 解析器。
  //
  // 代理要原样转发任意内容类型——文件上传、multipart 表单、二进制。默认的
  // JSON 解析器会把 body 解析成对象，再序列化回去就毁了二进制（stirling-pdf
  // 这类上传应用首当其冲）。先清掉继承来的所有解析器（否则 application/json
  // 仍会被解析），再挂一个把一切都当 buffer 的解析器。app 其余 JSON 路由不受
  // 影响，因为这是封装的子作用域。
  void app.register(async (scoped) => {
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scoped.all('/svc/:user/:name', handler);
    scoped.all('/svc/:user/:name/*', handler);
  });

  async function handler(req: FastifyRequest, reply: FastifyReply) {
    const { user, name, '*': subpath } = req.params as { user: string; name: string; '*'?: string };

    const [row] = await sql<BackendRow[]>`
      SELECT b.id, b.owner_id, b.exposed, b.visibility, b.status, b.container_name, b.port, b.link_token
        FROM ispace.backends b
        JOIN ispace.users u ON u.id = b.owner_id
       WHERE u.username = ${user} AND b.name = ${name} AND u.status = 'active'
    `;

    // 不存在 / 已停：一律 404，不区分——区分了就等于告诉对方这个路径是真的。
    if (!row || row.status === 'stopped' || row.status === 'failed') {
      return reply.status(404).send({ code: 'NOT_FOUND', message: '没有这个后端服务。' });
    }
    if (!row.container_name) {
      return reply.status(503).send({ code: 'SERVICE_UNAVAILABLE', message: '后端还在部署中。' });
    }

    // ── 鉴权 ────────────────────────────────────────────────────────
    const claims = await readResourceSession(req, sql, verifySession);
    const { token: fromUrl, clean } = splitLinkParam(req.url);
    const viaLink = row.visibility === 'link' && linkNetworkAllowed(req)
      && await hasLinkGrant(row, fromUrl ?? req.cookies?.[LINK_COOKIE], req.cookies ?? {});
    /*
      露出的后端第一次带着 ?lk= 打开（浏览器导航）：与页面一样换成 Cookie，
      回到不带令牌的地址。只对 GET 做——别的方法跳转会丢 body。
    */
    if (viaLink && fromUrl && req.method === 'GET' && linkTokenMatches(row.link_token, fromUrl)) {
      return reply.status(302)
        .header('set-cookie', linkCookie(LINK_COOKIE, fromUrl, `/svc/${user}/${name}`, deps.secureCookies ?? false))
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'no-store')
        .header('location', clean)
        .send();
    }
    const allowed = viaLink ? 'ok' : await isAllowed(row, claims);
    if (allowed === 'login') {
      // 页面调 /svc 是 fetch，302 没意义；这里直接 401，让页面自己处理
      return reply.status(401).send({ code: 'UNAUTHENTICATED', message: '请先登录。' });
    }
    if (allowed === 'deny') {
      return reply.status(403).send({ code: 'FORBIDDEN', message: '你没有访问这个服务的权限。' });
    }

    /*
      访问量计数：只算落在根路径的 GET。
      /svc/{user}/{name}/... 是整个后端的原样代理，一次页面打开背后可能
      跟着几十个子路径请求（接口、静态资源）——按每个请求计数，数字会与
      静态页那边（shell.js 每次加载打一下，语义是"一次页面打开"）完全不
      是一个量级，两种卡片摆在同一个市场网格里却没法比。根路径的一次 GET
      是"打开这个服务"最接近的近似。fire-and-forget，慢不得代理本身。
    */
    if (req.method === 'GET' && !subpath) {
      void sql`UPDATE ispace.backends SET visit_count = visit_count + 1 WHERE id = ${row.id}`
        .catch(() => undefined);
    }

    // ── 代理 ────────────────────────────────────────────────────────
    // **不剥前缀**，原样把 /svc/{user}/{name}/... 转给容器。
    //
    // 曾经剥掉前缀（容器侧当自己在根），结果带前台的后端全废：它们生成的是
    // 绝对链接（/login、/assets/x.js），浏览器会拿平台根去解析 → 打到
    // workspace.sy.soyoung.com/login 而不是这个后端。所以后端的公开基址就是
    // /svc/{user}/{name}，它必须在这个前缀下服务（Spring 的 SYSTEM_ROOTURIPATH、
    // 或认 X-Forwarded-Prefix 的框架都能自适应）。原样转发才对，也正是切换前
    // Dokploy 的行为（stripPath=false）。纯 API 后端由页面同源相对调用，同样成立。
    const upstreamPath = req.url;

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      // Platform authentication terminates here, never at a user container.
      if (k === 'authorization' || k === 'cookie') continue;
      if (v !== undefined && !DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    // Preserve application cookies verbatim, but remove every platform-session occurrence.
    const appCookies = req.headers.cookie?.split(';')
      .map((part) => part.trim())
      .filter((part) => {
        const cookieName = part.split('=', 1)[0]?.trim() ?? '';
        return part && cookieName !== COOKIE_NAME && !isLinkCookie(cookieName);
      })
      .join('; ');
    if (appCookies) headers.cookie = appCookies;
    // 在 loop 之后设，确保 prefix 一定是我算的值。让认这些头的框架
    // （Spring forward-headers、多数 Node 中间件）自己拼出正确的绝对链接，
    // backend 不必写死自己的 base path。
    headers['x-forwarded-prefix'] = `/svc/${user}/${name}`;
    headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] as string) ?? 'https';

    // 缓冲上游响应再用 Fastify 托管地回。
    //
    // 试过直接写 reply.raw（配 reply.hijack）做真流式，但和 Fastify 的响应
    // 生命周期打架：raw socket 出一点岔子，Fastify 的 clientError 兜底就补发一个
    // {"message":"Client Error"} 的 400，盖掉真实响应。缓冲让 Fastify 全程托管，
    // 稳。代价是大响应会整个进内存——后端返的是 API/页面，体量可控；真要传大
    // 文件那种流式后端，是另一件事。
    const result = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const up = httpRequest(
        { host: row.container_name!, port: row.port, method: req.method, path: upstreamPath, headers },
        (upRes) => {
          const chunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => chunks.push(c));
          upRes.on('end', () => resolve({
            status: upRes.statusCode ?? 502,
            headers: upRes.headers,
            body: Buffer.concat(chunks),
          }));
          upRes.on('error', reject);
        },
      );
      up.setTimeout(30_000, () => up.destroy(new Error('上游超时')));
      up.on('error', reject);
      // body 是原始 Buffer（上面的 buffer 解析器保证），原样转发，不碰内容
      if (req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length) {
        up.end(req.body);
      } else {
        up.end();
      }
    }).catch(() => null);

    if (!result) {
      return reply.status(502).send({ code: 'UPSTREAM_ERROR', message: '后端服务无响应。' });
    }
    // content-length / transfer-encoding / connection 交给 Fastify 按 buffer 重算，
    // 其余（含 content-type、content-encoding）原样透传，浏览器才能正确解码。
    for (const [k, v] of Object.entries(result.headers)) {
      if (v !== undefined && !DROP_HEADERS.has(k.toLowerCase())) reply.header(k, v);
    }
    if (row.visibility === 'link') reply.header('cache-control', 'no-store');
    return reply.status(result.status).send(result.body);
  }

  /**
   * 能不能访问。返回 'ok' | 'login'（未登录）| 'deny'（登录了但无权）。
   */
  /**
   * 匿名访客凭链接能不能进：后端自己的令牌，或者（纯 API 后端）同一作者
   * 某个仍在链接分享中的页面发的那张 Cookie。
   */
  async function hasLinkGrant(
    row: BackendRow, own: string | undefined | null, cookies: Record<string, string | undefined>,
  ): Promise<boolean> {
    if (linkTokenMatches(row.link_token, own)) return true;
    if (row.exposed) return false;
    // 最多看 8 张，挡住塞一堆 Cookie 逼服务端逐个查库
    const grants = Object.entries(cookies)
      .map(([k, v]) => [appIdFromGrantCookie(k), v] as const)
      .filter((g): g is readonly [string, string] => Boolean(g[0] && g[1]))
      .slice(0, 8);
    for (const [appId, token] of grants) {
      const [app] = await sql<{ link_token: string | null }[]>`
        SELECT link_token FROM ispace.apps
         WHERE id = ${appId} AND owner_id = ${row.owner_id}
           AND visibility = 'link' AND status <> 'stopped'
      `;
      if (linkTokenMatches(app?.link_token, token)) return true;
    }
    return false;
  }

  async function isAllowed(
    row: BackendRow, claims: SessionClaims | null,
  ): Promise<'ok' | 'login' | 'deny'> {
    if (!claims) return 'login';
    // 本人 / 管理员：直接放行
    if (claims.uid === row.owner_id || claims.role === 'admin') return 'ok';
    // 纯 API 服务：任何登录用户可调——调它的页面本就被登录用户打开
    if (!row.exposed) return 'ok';
    // 露出的按 visibility 三档
    if (row.visibility === 'public') return 'ok';
    // shared：得有一条授权记录。link 档同样认被授权的同事
    if (row.visibility === 'shared' || row.visibility === 'link') {
      const [grant] = await sql`
        SELECT 1 FROM ispace.backend_shares
         WHERE backend_id = ${row.id} AND to_user_id = ${claims.uid} LIMIT 1
      `;
      if (grant) return 'ok';
    }
    return 'deny';
  }
}
