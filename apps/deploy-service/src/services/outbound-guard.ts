import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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
 *   3. 每次请求前**重新校验**，不只在登记时校验一次（DNS 重绑定）
 *   4. 不跟随重定向 —— 否则一个公网主机 302 到 127.0.0.1 就绕过了前三道
 *
 * 第 3 条与实际连接之间仍有一个 TOCTOU 窗口：校验用的解析结果与随后 fetch
 * 自己的解析是两次独立的 DNS 查询。彻底消除它要自己实现 socket 层的
 * lookup 钩子并把连接钉死到已校验的 IP 上。当前的取舍是：内部平台、调用者
 * 必须是已登录员工、每次调用留审计，这个窗口的收益与实现复杂度不成比例。
 * 如果哪天要对外开放，这里必须先补上。
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
