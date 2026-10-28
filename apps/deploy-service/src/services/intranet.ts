import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

function normalized(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}
function networks(value: string): BlockList {
  const list = new BlockList();
  const entries = value.split(',').map(s => s.trim()).filter(Boolean);
  if (value.trim() && !entries.length) throw new Error('公司网络 CIDR 不能为空列表');
  for (const entry of entries) {
    const parts = entry.split('/');
    const ip = parts[0]!;
    const family = isIP(ip);
    const bits = parts[1] === undefined ? (family === 4 ? 32 : 128) : Number(parts[1]);
    if (parts.length > 2 || !family || !/^\d+$/.test(String(parts[1] ?? bits)) || !Number.isInteger(bits)
      || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new Error(`无效的内网/代理 CIDR 配置：${entry}`);
    if (bits === 0) throw new Error('公司网络与可信代理 CIDR 不允许配置为全网');
    list.addSubnet(ip, bits, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}
function contains(list: BlockList, ip: string): boolean {
  const addr = normalized(ip);
  const family = isIP(addr);
  return Boolean(family) && list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

/** Trust only known proxy peers, walking right-to-left until the first untrusted hop. */
export function createIntranetPolicy(allowedCidrs: string, trustedProxyCidrs = '') {
  const allowed = networks(allowedCidrs);
  const proxies = networks(trustedProxyCidrs);
  return (peer: string | undefined, forwarded?: string | string[]): boolean => {
    if (!peer || !isIP(normalized(peer))) return false;
    let client = peer;
    if (contains(proxies, client)) {
      if (typeof forwarded !== 'string') return false;
      const hops = forwarded.split(',').map(s => s.trim());
      if (!hops.length || hops.length > 32 || hops.some(ip => !isIP(normalized(ip)))) return false;
      while (contains(proxies, client)) {
        const next = hops.pop();
        if (!next) return false;
        client = next;
      }
    }
    return contains(allowed, client);
  };
}

let cached: { key: string; check: ReturnType<typeof createIntranetPolicy> } | undefined;
export function isIntranetRequest(req: FastifyRequest): boolean {
  const allowed = process.env.ISPACE_INTRANET_CIDRS ?? '';
  const trusted = process.env.ISPACE_TRUSTED_PROXY_CIDRS ?? '';
  const key = `${allowed}|${trusted}`;
  if (cached?.key !== key) cached = { key, check: createIntranetPolicy(allowed, trusted) };
  return cached.check(req.socket.remoteAddress, req.headers['x-forwarded-for']);
}
