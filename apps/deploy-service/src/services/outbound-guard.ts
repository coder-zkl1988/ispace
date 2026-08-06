import { lookup as lookupCb } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/**
 * 出站目标校验。连接器功能唯一的真风险就在这里。
 *
 * ┌─ 不做这件事会怎样 ──────────────────────────────────────────────────┐
 * │ 代理会变成一台内网扫描器：任何登录用户都能登记一个指向                │
 * │ http://127.0.0.1:3000 的连接器，然后经平台的身份去打 Dokploy 控制台； │
 * │ 或者指向 Supabase 的 Kong、指向云厂商的 169.254.169.254 元数据服务。 │
 * │ 这是 SSRF 的教科书形态，而平台服务恰好跑在能访问这一切的位置上。      │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 四道防线，缺一不可：
 *   1. 只允许 http/https —— 挡掉 file:// gopher:// 之类
 *   2. 解析主机名，拒绝一切解析到私有/回环/链路本地的地址
 *   3. 判定发生在 **socket 层的 lookup 钩子里**，不是请求前的一次预检
 *   4. 不跟随重定向 —— 否则一个公网主机 302 到 127.0.0.1 就绕过了前三道
 *
 * 第 3 条是关键，值得说清楚为什么非这样不可：
 *
 *   「请求前查一次 DNS，通过了再 fetch」看着够用，实则留着一个 TOCTOU 窗口
 *   ——校验用的那次解析和 fetch 自己发起的那次是**两次独立查询**，攻击者
 *   控制着权威 DNS 就能让第一次返回公网地址、第二次返回 127.0.0.1。这就是
 *   DNS 重绑定，它专门吃这种"先检查后使用"的写法。
 *
 *   所以判定挪进 net.connect 的 lookup 钩子：钩子返回哪个地址，内核就连哪个
 *   地址，中间没有第二次解析。一次解析、就地判定、连的就是判过的那一个。
 *   窗口不是被缩小了，是不存在了。
 *
 *   代价是不能再用 fetch —— 它不给传 lookup。改用 node:http/https 自己发，
 *   顺带把响应体大小上限也补上了（fetch 那版会老老实实把几个 G 缓进内存）。
 */

/** 私有、回环、链路本地、保留段——一律不许。 */
function isBlockedIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  const [a, b] = p as [number, number, number, number];
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 10) return true;                          // 私有
  if (a === 127) return true;                         // 回环
  if (a === 0) return true;                           // "本网络"
  if (a === 169 && b === 254) return true;            // 链路本地，云厂商元数据就在这
  if (a === 172 && b >= 16 && b <= 31) return true;   // 私有
  if (a === 192 && b === 168) return true;            // 私有
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  if (a >= 224) return true;                          // 组播与保留
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const s = ip.toLowerCase().split('%')[0] ?? '';
  if (s === '::' || s === '::1') return true;                    // 未指定 / 回环
  if (s.startsWith('fe80') || s.startsWith('fec0')) return true; // 链路/站点本地
  if (/^f[cd]/.test(s)) return true;                             // 唯一本地地址
  if (s.startsWith('ff')) return true;                           // 组播
  // IPv4 映射地址：::ffff:127.0.0.1 会绕过上面所有 IPv4 判断
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return true; // 认不出来的一律拒绝
}

export class OutboundBlocked extends Error {}

/**
 * 校验一个出站 URL 能不能打。
 *
 * `allowPrivate` 只给自建内网连接器留的口子——公司内部 ERP 就在
 * 192.168 段里是常态。它必须由管理员显式开启（环境变量），默认关闭：
 * 一旦默认开着，上面整段注释描述的攻击就全部成立。
 */
export async function assertOutboundAllowed(
  raw: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OutboundBlocked('地址格式不对，要形如 https://api.example.com/v1');
  }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new OutboundBlocked(`不支持的协议 ${u.protocol}，只能是 http 或 https`);
  }
  if (u.username || u.password) {
    throw new OutboundBlocked('地址里不要带用户名密码，凭据请填在「凭据」那一栏');
  }
  if (opts.allowPrivate) return u;

  // 字面 IP 直接判；主机名要解析后再判——example.com 完全可以解析到 127.0.0.1
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new OutboundBlocked(`不允许访问内网地址 ${host}`);
    }
    return u;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new OutboundBlocked(`解析不了主机名 ${host}，确认拼写以及这台服务器能不能访问它`);
  }
  if (!addrs.length) throw new OutboundBlocked(`解析不了主机名 ${host}`);
  // 全部地址都要过——只要有一个落在内网就拒绝，否则轮询解析能绕过
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      throw new OutboundBlocked(`${host} 解析到内网地址 ${a.address}，不允许访问`);
    }
  }
  return u;
}

/**
 * 给 net.connect 用的 lookup 钩子——真正的那道闸。
 *
 * 与 assertOutboundAllowed 的分工：那个用在**登记时**，为的是让人填表当场就
 * 知道地址不行；这个用在**每次连接时**，是安全上说了算的那一个。
 *
 * 三个细节都不是可选的：
 *   - 拿 all:true 把**所有**地址取回来判，只放行第一个合法的等于给轮询 DNS
 *     留后门（同一个域名交替返回公网与内网地址）
 *   - 回调的形状要跟调用方要的一致（options.all 决定给数组还是给单个），
 *     给错了 net 会静默连不上，表现成莫名其妙的超时
 *   - 出错时 address 传空串、family 传 0，不能省——net 会照着读
 */
export function guardedLookup(allowPrivate: boolean): LookupFunction {
  return ((hostname, options, callback) => {
    if (allowPrivate) {
      lookupCb(hostname, options as never, callback as never);
      return;
    }
    lookupCb(hostname, { ...(options as object), all: true }, (err, addresses) => {
      if (err) { (callback as (e: Error | null, a: string, f: number) => void)(err, '', 0); return; }
      const list = addresses as unknown as { address: string; family: number }[];
      for (const a of list) {
        if (isBlockedAddress(a.address)) {
          (callback as (e: Error | null, a: string, f: number) => void)(
            new OutboundBlocked(`${hostname} 解析到内网地址 ${a.address}，不允许访问`), '', 0,
          );
          return;
        }
      }
      const wantsAll = (options as { all?: boolean }).all === true;
      if (wantsAll) { (callback as unknown as (e: null, a: unknown) => void)(null, list); return; }
      const first = list[0];
      if (!first) {
        (callback as (e: Error | null, a: string, f: number) => void)(
          new OutboundBlocked(`解析不了主机名 ${hostname}`), '', 0,
        );
        return;
      }
      (callback as (e: Error | null, a: string, f: number) => void)(null, first.address, first.family);
    });
  }) as LookupFunction;
}

/** 上游响应体的上限。超过就掐断——代理不该能被一个巨大的响应拖垮整个进程。 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface GuardedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * 发一个受控的出站请求。
 *
 * 不跟随重定向：node:http 本来就不跟，3xx 原样交回调用方——这正是我们要的，
 * 跟随等于把前面所有校验作废（公网主机 302 到 127.0.0.1）。
 */
export function guardedRequest(
  target: URL,
  opts: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    allowPrivate: boolean;
    timeoutMs?: number;
  },
): Promise<GuardedResponse> {
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  return new Promise<GuardedResponse>((resolve, reject) => {
    const req = send(
      target,
      {
        method: opts.method,
        headers: opts.headers,
        lookup: guardedLookup(opts.allowPrivate),
        // TLS 的 servername 由 URL 的主机名决定（默认行为），不因为我们钉了 IP 而改变
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new OutboundBlocked(
              `上游返回超过 ${MAX_RESPONSE_BYTES / 1024 / 1024} MB，已中断。`
              + '连接器是拿数据的，不是下载文件的。',
            ));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`超过 ${timeoutMs / 1000} 秒没有响应`));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/**
 * 目标路径必须留在 base_url 的前缀之内。
 *
 * 不能只比较 origin：登记 `https://api.example.com/v3` 的人，不该能打到
 * 同一台主机的 `/admin`。而 `..` 必须在拼接**之前**就挡掉——URL 构造函数会
 * 帮你把 `/v3/../admin` 规范化成 `/admin`，等于自动完成穿越。
 */
export function resolveTarget(baseUrl: string, rest: string, search: string): URL {
  if (rest.includes('..')) throw new OutboundBlocked('路径里不允许出现 ..');
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const tail = rest ? `/${rest.replace(/^\/+/, '')}` : '';
  const target = new URL(`${base.origin}${basePath}${tail}${search}`);
  const prefix = `${base.origin}${basePath}`;
  if (!`${target.origin}${target.pathname}`.startsWith(prefix)) {
    throw new OutboundBlocked('目标超出了这个连接器允许的范围');
  }
  return target;
}
