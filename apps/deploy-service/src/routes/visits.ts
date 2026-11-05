import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE } from '@ispace/contracts';
import type { User } from '@ispace/contracts';
import type { Sql } from '@ispace/db';

/**
 * 页面访问量的记录端点 + 在线人数（presence）心跳端点。
 *
 * 访问量：只有静态页需要它——静态页由 Caddy 直出文件（技术方案 §4.2），
 * 中间不经过本服务，没有天然能计数的地方。shell.js（平台注入进每个用户
 * 页面的 chrome）在页面加载时打这一下——一次页面加载正好一次调用，语义
 * 干净。
 *
 * 后端服务不走这条路：/svc 代理本就是每个请求都会经过的 Node 代码
 * （routes/svc-proxy.ts），在那边直接计数即可，不需要客户端配合。
 *
 * 故意不要求登录：访问者可能是没登录就被 403/302 挡下的人，也可能是
 * 「全公司」页面上任何一个同事——这一下只是数个数，不是鉴权判断，
 * 该不该看这个页面由 authz.ts 那条早就管了。presence 同理：私密链接
 * 「知道链接的任何人」的访问是真访问，匿名访客用浏览器本地生成的随机
 * ID 区分（拿不到就按 IP 兜底）。
 *
 * 「正在用」没有主动告别（pagehide 告别会误删多标签共享的那一行，bfcache
 * 进出还会让告别错发）：离开就停止心跳，行随 90 秒窗口自然过期——探索墙
 * 45 秒一轮询，退出侧最多滞后两轮，对一面墙足够实时。
 *
 * 防刷：这个端点无凭据也能打，谁都可以 POST 一堆编造的 visitor 把
 * 「M 人正在用」刷上去（实测 5000 次 200 全成功）。两道便宜的闸：
 *   1. 匿名 key 按 IP 固定窗口限流——登录用户的心跳有会话背书，不限；
 *      匿名的每分钟每 IP 超过 40 次直接丢弃。攻击者要保持 N 个假行在线
 *      每分钟至少得打 N×(60/90) 次，40/min 的预算把假在线人数压在 ~60；
 *   2. 单页面 90 秒窗口内最多 256 行——上限兜底，防止无界写库撑爆计数。
 */

/** 在线窗口：shell.js 心跳 30s 一跳，后台标签页被限流到约 60s，都能接住。 */
export const PRESENCE_WINDOW_SECONDS = 90;

/** 单页面同时在窗口内的行数上限。内网平台真实并发远够用，防无界写库。 */
const PRESENCE_ROWS_CAP = 256;

/** 匿名心跳每分钟每 IP 的预算。登录心跳不限。 */
const ANON_PER_IP_PER_MIN = 40;

/** localStorage 里的访客 ID 是不可信输入：只放行安全字符，截到 64。 */
function sanitizeVisitor(v: unknown): string {
  return String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

/** 匿名心跳的固定窗口限流：ip → {窗口起点, 计数}。进程内存即可。 */
const anonBuckets = new Map<string, { start: number; count: number }>();

function anonAllowed(ip: string): boolean {
  const now = Date.now();
  const b = anonBuckets.get(ip);
  if (!b || now - b.start >= 60_000) {
    anonBuckets.set(ip, { start: now, count: 1 });
    return true;
  }
  b.count += 1;
  return b.count <= ANON_PER_IP_PER_MIN;
}

export function registerVisitRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; optionalAuth: (req: FastifyRequest) => Promise<User | null> },
): void {
  const { sql, optionalAuth } = deps;

  app.post(`${API_BASE}/visits/app`, async (req, reply) => {
    const body = (req.body ?? {}) as { owner?: string; slug?: string };
    const { owner, slug } = body;
    if (!owner || !slug) {
      return reply.status(400).send({ code: 'INVALID_INPUT', message: '缺少 owner 或 slug' });
    }

    /*
     * 静默失败而不是抛错：调用方是 shell.js 里一次 fire-and-forget 的
     * fetch，页面本身完全不关心这一下成不成功——页面不存在、已停用、
     * owner 拼错，都不该在用户毫无感知的地方制造一条错误日志。
     */
    await sql`
      UPDATE ispace.apps a
         SET visit_count = visit_count + 1, last_accessed_at = now()
        FROM ispace.users u
       WHERE a.owner_id = u.id AND u.username = ${owner} AND a.slug = ${slug}
         AND a.status <> 'stopped'
    `.catch(() => undefined);

    return { ok: true };
  });

  // ── 在线心跳 ───────────────────────────────────────────────────────
  // 与访问量同款静默策略：心跳失败不重试不报错，最坏情况只是那一跳没算
  // 上，90 秒窗口里的下一跳自然补齐。
  //
  // visitor_key 的优先级：登录身份 > 客户端随机 ID > IP。前两者让
  // 「换网络不换人」「同 IP 多个访客」都数对；第三者只是 localStorage
  // 被禁时的兜底，宁可粗一点也不想让心跳报错。
  app.post(`${API_BASE}/presence/app`, async (req) => {
    const body = (req.body ?? {}) as { owner?: string; slug?: string; visitor?: string };
    const { owner, slug } = body;
    if (!owner || !slug) return { ok: true };

    const me = await optionalAuth(req).catch(() => null);
    const key = me ? `u:${me.id}` : `a:${sanitizeVisitor(body.visitor) || `ip:${req.ip}`}`;
    if (!me && !anonAllowed(req.ip)) return { ok: true }; // 限流丢跳，静默

    /*
     * INSERT..SELECT 而不是 INSERT..VALUES：行数上限要在同一条语句里判，
     * 免得「查一下够不够再插」两步之间被人塞满。冲突路径（老访客的
     * 日常心跳）不受上限影响——只拦新行。
     */
    await sql`
      INSERT INTO ispace.app_presence (app_id, visitor_key, last_seen_at)
      SELECT a.id, ${key}, now()
        FROM ispace.apps a
        JOIN ispace.users u ON u.id = a.owner_id
       WHERE u.username = ${owner} AND a.slug = ${slug}
         AND a.status <> 'stopped'
         AND (SELECT count(*) FROM ispace.app_presence p
               WHERE p.app_id = a.id
                 AND p.last_seen_at > now() - interval '90 seconds') < ${PRESENCE_ROWS_CAP}
      ON CONFLICT (app_id, visitor_key) DO UPDATE SET last_seen_at = now()
    `.catch(() => undefined);

    return { ok: true };
  });
}
