import { request as httpRequest } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Sql } from '@ispace/db';
import type { SessionClaims } from '@ispace/auth';

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
}

export function registerSvcProxy(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    verifySession: (token: string) => Promise<SessionClaims | null>;
  },
): void {
  const { sql, verifySession } = deps;

  async function readSession(req: FastifyRequest): Promise<SessionClaims | null> {
    const cookie = (req.cookies as Record<string, string> | undefined)?.ispace_session;
    const auth = req.headers.authorization;
    const token = cookie ?? (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
    if (!token) return null;
    try {
      return await verifySession(token);
    } catch {
      return null;
    }
  }

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
    const { user, name } = req.params as { user: string; name: string; '*'?: string };

    const [row] = await sql<BackendRow[]>`
      SELECT b.id, b.owner_id, b.exposed, b.visibility, b.status, b.container_name, b.port
        FROM ispace.backends b
        JOIN ispace.users u ON u.id = b.owner_id
       WHERE u.username = ${user} AND b.name = ${name} AND u.status <> 'archived'
    `;

    // 不存在 / 已停：一律 404，不区分——区分了就等于告诉对方这个路径是真的。
    if (!row || row.status === 'stopped' || row.status === 'failed') {
      return reply.status(404).send({ code: 'NOT_FOUND', message: '没有这个后端服务。' });
    }
    if (!row.container_name) {
      return reply.status(503).send({ code: 'SERVICE_UNAVAILABLE', message: '后端还在部署中。' });
    }

    // ── 鉴权 ────────────────────────────────────────────────────────
    const claims = await readSession(req);
    const allowed = await isAllowed(row, claims);
    if (allowed === 'login') {
      // 页面调 /svc 是 fetch，302 没意义；这里直接 401，让页面自己处理
      return reply.status(401).send({ code: 'UNAUTHENTICATED', message: '请先登录。' });
    }
    if (allowed === 'deny') {
      return reply.status(403).send({ code: 'FORBIDDEN', message: '你没有访问这个服务的权限。' });
    }

    // ── 代理 ────────────────────────────────────────────────────────
    // 剥掉 /svc/{user}/{name} 前缀，容器侧监听的是自己的根。
    const rest = (req.params as Record<string, string>)['*'] ?? '';
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const upstreamPath = `/${rest}${qs}`;

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }

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
    return reply.status(result.status).send(result.body);
  }

  /**
   * 能不能访问。返回 'ok' | 'login'（未登录）| 'deny'（登录了但无权）。
   */
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
    // shared：得有一条授权记录
    if (row.visibility === 'shared') {
      const [grant] = await sql`
        SELECT 1 FROM ispace.backend_shares
         WHERE backend_id = ${row.id} AND to_user_id = ${claims.uid} LIMIT 1
      `;
      if (grant) return 'ok';
    }
    return 'deny';
  }
}
