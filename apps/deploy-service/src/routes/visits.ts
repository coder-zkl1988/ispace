import type { FastifyInstance } from 'fastify';
import { API_BASE } from '@ispace/contracts';
import type { Sql } from '@ispace/db';

/**
 * 页面访问量的记录端点。
 *
 * 只有这一种页面需要它：静态页由 Caddy 直出文件（技术方案 §4.2），中间
 * 不经过本服务，没有天然能计数的地方。shell.js（平台注入进每个用户页面
 * 的 chrome）在页面加载时打这一下——一次页面加载正好一次调用，语义干净。
 *
 * 后端服务不走这条路：/svc 代理本就是每个请求都会经过的 Node 代码
 * （routes/svc-proxy.ts），在那边直接计数即可，不需要客户端配合。
 *
 * 故意不要求登录：访问者可能是没登录就被 403/302 挡下的人，也可能是
 * 「全公司」页面上任何一个同事——这一下只是数个数，不是鉴权判断，
 * 该不该看这个页面由 authz.ts 那条早就管了。
 */
export function registerVisitRoutes(
  app: FastifyInstance,
  deps: { sql: Sql },
): void {
  const { sql } = deps;

  app.post(`${API_BASE}/visits/app`, async (req, reply) => {
    const body = (req.body ?? {}) as { owner?: string; slug?: string };
    const { owner, slug } = body;
    if (!owner || !slug) {
      return reply.status(400).send({ code: 'INVALID_INPUT', message: '缺少 owner 或 slug' });
    }

    /*
      静默失败而不是抛错：调用方是 shell.js 里一次 fire-and-forget 的
      fetch，页面本身完全不关心这一下成不成功——页面不存在、已停用、
      owner 拼错，都不该在用户毫无感知的地方制造一条错误日志。
    */
    await sql`
      UPDATE ispace.apps a
         SET visit_count = visit_count + 1
        FROM ispace.users u
       WHERE a.owner_id = u.id AND u.username = ${owner} AND a.slug = ${slug}
         AND a.status <> 'stopped'
    `.catch(() => undefined);

    return { ok: true };
  });
}
