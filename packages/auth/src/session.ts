import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';

/**
 * 平台会话。
 *
 * 用无状态 JWT 而非服务端会话表：CLI 与 MCP 都需要携带凭据调用 REST，
 * 无状态令牌让三个入口（浏览器 / CLI / MCP）共用一套鉴权，不必为 CLI
 * 另做一套 token 体系。
 *
 * 代价是撤销需要等过期。对内部平台可接受；真要立即失效，配合
 * users.status='archived' 的检查即可——鉴权中间件每次都会查用户状态。
 */

export const sessionClaimsSchema = z.object({
  /** 平台 users.id */
  uid: z.string().uuid(),
  username: z.string(),
  role: z.enum(['employee', 'admin']),
  identity: z.enum(['user', 'developer']),
});
export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

const ISSUER = 'ispace';
const AUDIENCE = 'ispace-platform';

export class SessionService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds = 60 * 60 * 12,
  ) {
    if (secret.length < 32) {
      // 短密钥在 HS256 下会显著削弱签名强度，且这类问题上线后极难发现
      throw new Error('SESSION_SECRET 至少需要 32 个字符');
    }
    this.key = new TextEncoder().encode(secret);
  }

  /**
   * 签发会话。
   *
   * ttlSeconds 可以按次覆盖：有效期是管理员在「平台设置」里配的
   * （platform_policy.session_days），而那是个能随时改的值，
   * 不能在构造服务时定死——定死的话改完设置要重启服务才生效，
   * 而"改了没用"是设置类功能最难查的一种坏法。
   *
   * 令牌的 exp 在签发那一刻就写死了，所以改设置只影响之后的登录，
   * 已经登录的人不受影响。这一点在设置页上有说明。
   */
  async issue(claims: SessionClaims, ttlSeconds = this.ttlSeconds): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<SessionClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      return sessionClaimsSchema.parse(payload);
    } catch (e) {
      throw new IspaceError(
        ERROR_CODES.UNAUTHENTICATED,
        '登录状态无效或已过期，请重新登录',
        { reason: e instanceof Error ? e.message : String(e) },
      );
    }
  }

  /** 从 Authorization 头或 cookie 取 token。三个入口的携带方式不同。 */
  extract(headers: {
    authorization?: string | undefined;
    cookie?: string | undefined;
  }): string | null {
    const auth = headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);

    const cookie = headers.cookie;
    if (cookie) {
      for (const part of cookie.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
      }
    }
    return null;
  }
}

export const COOKIE_NAME = 'ispace_session';

/**
 * 会话 cookie。
 *
 * SameSite=Lax 而非 Strict：用户的应用页面（/{user}/{app}/）会加载
 * /platform/shell.js，shell.js 需要读登录态渲染 header。Strict 在从外部
 * 链接跳入时不发送 cookie，会让分享出去的页面上 header 显示未登录。
 *
 * 未设 Secure：内网阶段以 HTTP 运行（规格 §12）。上 HTTPS 时必须补上，
 * 否则 cookie 会在明文链路上暴露。
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure = false): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
