import { isIntranetRequest } from '../services/intranet.js';
import type { FastifyInstance } from 'fastify';
import { API_BASE } from '@ispace/contracts';
import type { SessionClaims } from '@ispace/auth';
import type { Sql } from '@ispace/db';
import { readResourceSession } from '../services/resource-session.js';
import { resolveAppAccess } from '../services/app-access.js';

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
 * JWT 验签后检查当前账号状态与角色，再判定资源权限。
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
    /** JWT 验签；账号状态与角色由 readResourceSession 查库。 */
    verifySession: (token: string) => Promise<SessionClaims | null>;
  },
): void {
  const { sql, publicBase, verifySession } = deps;

  app.get(`${API_BASE}/authz/page`, async (req, reply) => {
    /*
      Caddy 的 forward_auth 把原始请求信息放在 X-Forwarded-* 里，
      原始 URI 在 X-Forwarded-Uri。不能用 req.url——那是本端点自己的路径。
    */
    reply.header('cache-control', 'no-store');
    const uri = (req.headers['x-forwarded-uri'] as string | undefined) ?? '';
    const m = /^\/([a-z0-9][a-z0-9-]{0,30})\/([a-z0-9][a-z0-9-]{0,30})(?:\/|\?|$)/.exec(uri);
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

    /*
      判定本身在 services/app-access.ts —— 换令牌那条路（routes/play.ts）
      用的是同一个函数。访问控制有两份实现，迟早有一份落后，而落后的那份
      不会报错，它只是多放进来一些人。
    */
    const claims = await readResourceSession(req, sql, verifySession);
    const access = await resolveAppAccess(sql, owner, slug, claims, isIntranetRequest(req));

    if (access.kind === 'ok') return reply.status(200).send();
    if (access.kind === 'notfound') {
      return reply.status(404).type('text/html; charset=utf-8').send(page404());
    }
    if (access.kind === 'login') {
      // 跳登录页，带上 redirect 让人登完回到原地。直接 401 会让同事点开
      // 分享链接时看到一片空白，不知道该干什么。
      const back = encodeURIComponent(uri || `/${owner}/${slug}/`);
      return reply.status(302).header('location', `${publicBase}/?redirect=${back}`).send();
    }
    if (access.reason === 'network') {
      return reply.status(403).type('text/html; charset=utf-8').send(shell('仅限公司网络',
        '<h1>请连接公司网络或 VPN</h1><p>这个链接仅允许从公司网络访问，无需登录。连接后刷新页面即可。</p>'));
    }
    return reply.status(403).type('text/html; charset=utf-8').send(page403(owner));
  });

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
