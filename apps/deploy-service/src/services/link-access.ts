import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { isIntranetRequest } from './intranet.js';

/**
 * 「知道链接的任何人」——visibility = 'link' 的凭据。
 *
 * ┌─ 为什么必须是令牌，不能是原地址 ────────────────────────────────────┐
 * │ 页面地址是 /{用户名}/{项目名}/，两段都是人起的名字，一猜一个准。      │
 * │ 「知道链接就能看」如果认的是原地址，等于把所有 link 页面公开了。     │
 * │ 所以分享出去的是 /{owner}/{slug}/?lk=<令牌>，令牌 192 位随机。       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 第一次带 ?lk= 打开时，服务端核对令牌，下发一张只对这个路径有效的
 * HttpOnly Cookie，再 302 回不带令牌的地址：页面里 ./app.js 这类子资源请求
 * 不带查询串，靠的是这张 Cookie；令牌也不会留在地址栏、历史记录和 Referer 里。
 *
 * Cookie 的值就是令牌本身。拿到 Cookie 的人本来就拿到了链接，不多给任何
 * 权限；而「重置链接」换掉库里的令牌，旧链接和所有旧 Cookie 同时失效，
 * 不需要另一份签名密钥来管吊销。
 */

/** 分享链接里令牌的查询参数名。取得短而少见，免得撞上页面自己的参数。 */
export const LINK_PARAM = 'lk';

/** 页面 / 露出后端自己那条路径上的访问 Cookie。 */
export const LINK_COOKIE = 'ispace_link';

/**
 * 页面调同一作者纯 API 后端时用的那张 Cookie 的前缀（Path=/svc/{owner}）。
 * 名字里带 app id：一个作者可能分享了好几个页面，各自一张，互不覆盖。
 */
export const LINK_GRANT_PREFIX = 'ispace_link_';

/** 30 天。真要收回靠「重置链接」，不靠等它过期。 */
const LINK_COOKIE_MAX_AGE = 30 * 24 * 3600;

export function newLinkToken(): string {
  return randomBytes(24).toString('hex');
}

/** 常数时间比较；任一侧为空都不算匹配。 */
export function linkTokenMatches(expected: string | null | undefined, presented: string | null | undefined): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 链接访问的网络条件。
 *
 * 配了 ISPACE_INTRANET_CIDRS 就额外要求来自公司网络（令牌 + 网段双重条件）；
 * 没配就只认令牌。以前没配网段时整个功能是关着的，管理员不配就没人能用。
 */
export function linkNetworkAllowed(req: FastifyRequest): boolean {
  if (!process.env.ISPACE_INTRANET_CIDRS?.trim()) return true;
  return isIntranetRequest(req);
}

export function linkCookie(name: string, token: string, path: string, secure: boolean): string {
  const parts = [`${name}=${token}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${LINK_COOKIE_MAX_AGE}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 页面调用作者后端时出示的那张 Cookie 名（app id 去掉连字符）。 */
export function linkGrantCookieName(appId: string): string {
  return LINK_GRANT_PREFIX + appId.replaceAll('-', '');
}

/** 反过来从 Cookie 名还原 app id；不是 32 位十六进制的一律不认。 */
export function appIdFromGrantCookie(name: string): string | null {
  const hex = name.slice(LINK_GRANT_PREFIX.length);
  if (!name.startsWith(LINK_GRANT_PREFIX) || !/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 平台自己的链接 Cookie 都不该转发给用户容器。 */
export function isLinkCookie(name: string): boolean {
  return name === LINK_COOKIE || name.startsWith(LINK_GRANT_PREFIX);
}

/**
 * 从原始 URI 里取出 ?lk=，并给出去掉它之后的地址（其余参数原样保留）。
 */
export function splitLinkParam(uri: string): { token: string | null; clean: string } {
  const q = uri.indexOf('?');
  if (q < 0) return { token: null, clean: uri };
  const params = new URLSearchParams(uri.slice(q + 1));
  const token = params.get(LINK_PARAM);
  if (token === null) return { token: null, clean: uri };
  params.delete(LINK_PARAM);
  const rest = params.toString();
  return { token, clean: uri.slice(0, q) + (rest ? `?${rest}` : '') };
}

/** 页面私密链接的路径部分。前端拼 location.origin，MCP 拼 PUBLIC_BASE。 */
export function pageLinkPath(owner: string, slug: string, token: string): string {
  return `/${owner}/${slug}/?${LINK_PARAM}=${token}`;
}

/** 后端私密链接的路径部分（urlPath 形如 /svc/{owner}/{name}）。 */
export function backendLinkPath(urlPath: string, token: string): string {
  return `${urlPath}/?${LINK_PARAM}=${token}`;
}
