import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE } from '@ispace/contracts';
import type { SessionClaims } from '@ispace/auth';
import type { Sql } from '@ispace/db';

/**
 * 静态页面的访问鉴权（Caddy forward_auth 的落点）。
 *
 * ┌─ 这个端点补的是一个真实存在过的越权 ────────────────────────────────┐
 * │ Caddy 此前是 root + file_server 直出 /srv/sites/{user}/{app}/，      │
 * │ 中间没有任何鉴权。也就是说：**任何能访问这个域名的人，不用登录，**   │
 * │ **只要知道 URL 就能打开别人的任意页面**——实测不带任何 cookie 请求   │
 * │ 一个 visibility=private 的页面，返回 200。                          │
 * │                                                                      │
 * │ apps.visibility 那三档（仅自己/全公司/指定同事）当时只影响创意市场    │
 * │ 与聚合页的**展示**，从没参与过访问判定。分享弹窗上写着"可随时改回     │
 * │ 仅自己"，而改回去其实什么也没挡住。                                  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Caddy 每个请求（含每个静态资源）都会打到这里，所以它必须便宜：
 * 一次 JWT 验签 + 一条带索引的查询，没有别的。
 *
 * 返回约定（Caddy 会把非 2xx 的响应原样回给浏览器）：
 *   200  放行
 *   302  没登录 → 跳登录页，登完回原地
 *   403  登录了但没权限
 *   404  页面不存在或已停用
 */

export function registerAuthzRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    publicBase: string;
    /** 只验签，不查库——查库那步由本模块自己按需要做。 */
    verifySession: (token: string) => Promise<SessionClaims | null>;
  },
): void {
  const { sql, publicBase, verifySession } = deps;

  app.get(`${API_BASE}/authz/page`, async (req, reply) => {
    /*
      Caddy 的 forward_auth 把原始请求信息放在 X-Forwarded-* 里，
      原始 URI 在 X-Forwarded-Uri。不能用 req.url——那是本端点自己的路径。
    */
    const uri = (req.headers['x-forwarded-uri'] as string | undefined) ?? '';
    const m = /^\/([a-z0-9][a-z0-9-]{0,30})\/([a-z0-9][a-z0-9-]{0,30})(?:\/|$)/.exec(uri);
    if (!m) {
      /*
        ⚠️ 认不出路径必须**拒绝**，不能放行。

        这条原本写的是 return 200（"匹配不上就交给 Caddy 去 404"），
        结果正好把门开着：Caddy 的 try_files 会先把 URI 削成 `/`，
        鉴权拿到的 X-Forwarded-Uri 里没有 {user}/{app}，于是每个请求
        都走这条分支被放行——加了鉴权却等于没加，而且看不出来。
        （Caddy 那边已改用 route 保持顺序，但默认值本身也必须是拒绝：
        安全判定拿不准时唯一正确的选择是不放行。）
      */
      return reply.status(404).type('text/html; charset=utf-8').send(page404());
    }
    const [, owner, slug] = m as unknown as [string, string, string];

    const [row] = await sql<
      { app_id: string; owner_id: string; visibility: string; status: string }[]
    >`
      SELECT a.id AS app_id, a.owner_id, a.visibility, a.status
        FROM ispace.apps a
        JOIN ispace.users u ON u.id = a.owner_id
       WHERE u.username = ${owner} AND a.slug = ${slug}
         AND u.status <> 'archived'
    `;

    // 库里没有这个页面：可能是刚被回收、也可能是有人在猜路径。
    // 一律 404，不区分——区分了就等于告诉对方"这个路径是存在的"。
    if (!row || row.status === 'stopped') {
      return reply.status(404).type('text/html; charset=utf-8').send(page404());
    }

    const claims = await readSession(req);

    // 没登录：跳登录页，带上 redirect 让人登完回到原地。
    // 直接 401 会让同事点开分享链接时看到一片空白，不知道该干什么。
    if (!claims) {
      const back = encodeURIComponent(uri || `/${owner}/${slug}/`);
      return reply.status(302).header('location', `${publicBase}/?redirect=${back}`).send();
    }

    // 本人 / 管理员：直接放行
    if (claims.uid === row.owner_id || claims.role === 'admin') {
      return reply.status(200).send();
    }

    /*
      全公司可见：任何登录用户都能看。
      仍要求登录——平台是内网的，但"登录过"至少让访问可追溯到人。
    */
    if (row.visibility === 'public') return reply.status(200).send();

    // 指定同事：得有一条已接受的分享
    if (row.visibility === 'shared') {
      const [share] = await sql`
        SELECT 1 FROM ispace.shares
         WHERE app_id = ${row.app_id} AND to_user_id = ${claims.uid} AND status = 'accepted'
         LIMIT 1
      `;
      if (share) return reply.status(200).send();
    }

    return reply.status(403).type('text/html; charset=utf-8').send(page403(owner));
  });

  /** 从 cookie 或 Authorization 头取会话。取不到返回 null，不抛。 */
  async function readSession(req: FastifyRequest): Promise<SessionClaims | null> {
    const cookie = req.cookies?.ispace_session;
    const auth = req.headers.authorization;
    const token = cookie ?? (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
    if (!token) return null;
    try {
      return await verifySession(token);
    } catch {
      return null;
    }
  }
}

/**
 * 拒绝页面直接返回 HTML 而不是 JSON。
 *
 * 这两个响应是给**浏览器里的人**看的，不是给程序看的——他大概率是点了
 * 一条别人发来的链接。一串 JSON 只会让他去问"这是什么意思"。
 */
const shell = (title: string, body: string) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fcfcf8;
       color:#1c1f23;font:16px/1.7 -apple-system,"PingFang SC",system-ui,sans-serif}
  .box{max-width:420px;padding:32px;text-align:center}
  h1{font-size:20px;margin:0 0 10px}
  p{margin:0 0 20px;color:#545659;font-size:14px}
  a{display:inline-block;padding:9px 18px;border-radius:8px;background:#1c1f23;
    color:#fff;text-decoration:none;font-size:14px}
</style>
<div class="box">${body}</div>`;

const page403 = (owner: string) => shell('没有访问权限', `
  <h1>这个页面没有共享给你</h1>
  <p>它属于 ${owner}，可见范围是「仅自己」或「指定同事」。
     需要的话找 ${owner} 把你加进去，或请他改成「全公司」。</p>
  <a href="/">回我的空间</a>`);

const page404 = () => shell('页面不存在', `
  <h1>没有这个页面</h1>
  <p>地址可能打错了，或者这个页面已经被作者停用、回收。</p>
  <a href="/">回我的空间</a>`);
