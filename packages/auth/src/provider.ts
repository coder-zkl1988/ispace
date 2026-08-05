import { z } from 'zod';

/**
 * OIDC 抽象层（规格 D5）。
 *
 * 公司 IdP 尚未确定。这一层的意义在于：接真实 IdP 时只改环境变量，不改代码。
 * 因此接口只暴露 OIDC 标准语义，不出现任何厂商专有概念（企业微信的 corpid、
 * 钉钉的 agentid 之类一律留在具体 provider 实现内部）。
 */

/** 从 IdP 拿到的身份断言。字段取 OIDC 标准 claim，非标准字段进 raw。 */
export const identityClaimsSchema = z.object({
  /** OIDC sub，是平台侧 users.sso_subject 的唯一依据。不可用邮箱代替——邮箱会变。 */
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().optional(),
  preferredUsername: z.string().optional(),
  /**
   * 身份维度（使用者/开发者）取自 SSO 档案。不同 IdP 放的位置不同，
   * 由各 provider 实现负责映射到这里。
   */
  identity: z.enum(['user', 'developer']).optional(),
  role: z.enum(['employee', 'admin']).optional(),
  raw: z.record(z.string(), z.unknown()).default({}),
});
export type IdentityClaims = z.infer<typeof identityClaimsSchema>;

export interface AuthProvider {
  readonly name: string;
  /** 构造跳转到 IdP 的授权地址。 */
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  /** 用授权码换取身份断言。 */
  exchange(input: { code: string; redirectUri: string }): Promise<IdentityClaims>;
}

/**
 * 开发期 mock provider。
 *
 * 不是玩具：它必须能切换身份（使用者/开发者）与角色（员工/管理员），
 * 否则本地无法验证控制台的双视角与移动端的身份门控——那是设计稿里占比很大的
 * 一部分，留到接真实 IdP 才能测就太晚了。
 *
 * 授权地址返回一个本地页面，页面上选身份后带 code 回跳；code 直接编码了
 * 所选身份，无需服务端会话存储。
 */
export class MockAuthProvider implements AuthProvider {
  readonly name = 'mock';

  constructor(private readonly loginPagePath = '/deploy/api/auth/mock') {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const u = new URLSearchParams({ state, redirect_uri: redirectUri });
    return `${this.loginPagePath}?${u.toString()}`;
  }

  async exchange({ code }: { code: string }): Promise<IdentityClaims> {
    // code 形如 mock:{username}:{identity}:{role}
    const parts = code.split(':');
    if (parts[0] !== 'mock' || parts.length !== 4) {
      throw new Error(`mock provider 收到非法 code：${code}`);
    }
    const [, username, identity, role] = parts as [string, string, string, string];
    return identityClaimsSchema.parse({
      sub: `mock|${username}`,
      name: username,
      email: `${username}@example.com`,
      preferredUsername: username,
      identity: identity === 'developer' ? 'developer' : 'user',
      role: role === 'admin' ? 'admin' : 'employee',
      raw: { provider: 'mock' },
    });
  }

  /** 供 mock 登录页构造 code。真实 provider 无此方法。 */
  static makeCode(
    username: string,
    identity: 'user' | 'developer' = 'user',
    role: 'employee' | 'admin' = 'employee',
  ): string {
    return `mock:${username}:${identity}:${role}`;
  }
}

/**
 * 标准 OIDC provider。接公司 IdP 时启用，只需环境变量：
 * OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET。
 *
 * 一期不走这条路径（D5），但接口与 discovery 逻辑先落地，避免届时改动调用方。
 */
export class OidcAuthProvider implements AuthProvider {
  readonly name = 'oidc';

  constructor(
    private readonly cfg: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
    },
  ) {}

  private discoveryCache?: { authorization_endpoint: string; token_endpoint: string };

  private async discover() {
    if (this.discoveryCache) return this.discoveryCache;
    const res = await fetch(`${this.cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery 失败：${res.status}`);
    this.discoveryCache = (await res.json()) as typeof this.discoveryCache;
    return this.discoveryCache!;
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    // discovery 是异步的，而本方法同步。实践中 issuer 的 authorize 端点
    // 可由 issuer 推导，避免为了拿一个 URL 就把调用方改成异步。
    const base = `${this.cfg.issuer.replace(/\/$/, '')}/protocol/openid-connect/auth`;
    const u = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      scope: this.cfg.scope ?? 'openid profile email',
      state,
    });
    return `${base}?${u.toString()}`;
  }

  async exchange({ code, redirectUri }: { code: string; redirectUri: string }): Promise<IdentityClaims> {
    const { token_endpoint } = await this.discover();
    const res = await fetch(token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`OIDC token 交换失败：${res.status}`);
    const tokens = (await res.json()) as { id_token: string };

    // id_token 的签名校验由调用方用 jose + JWKS 完成（见 session.ts）。
    // 这里只做解码取 claim——签名校验与 claim 提取分开，便于单测。
    const payload = JSON.parse(
      Buffer.from(tokens.id_token.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    return identityClaimsSchema.parse({
      sub: payload.sub,
      name: payload.name ?? payload.preferred_username ?? payload.sub,
      email: payload.email,
      preferredUsername: payload.preferred_username,
      identity: payload.ispace_identity,
      role: payload.ispace_role,
      raw: payload,
    });
  }
}

/**
 * 选用哪个身份提供方。
 *
 * ⚠️ 这里原本是「没配 OIDC 就回落 mock」，那是一个会一直开着的后门。
 *
 * 当时的假设是「上线前一定会接真实 SSO，接上 mock 就自动关」。但平台后来
 * 改成了邮箱 + 密码自助注册，OIDC 很可能**永远不会**被配置——于是那个
 * 「任何人选个身份就能以管理员进来」的开发登录页在生产上长期敞着，
 * 而且没有任何东西会提醒你。实测确认过：线上 /deploy/api/auth/mock 可直接打开。
 *
 * 现在改成必须显式开：ISPACE_DEV_LOGIN=1。忘了配等于关着，
 * 而不是忘了配等于开着——默认值要站在安全那一边。
 *
 * 返回 null 表示「没有第三方登录」，这在今天是完全正常的状态：
 * 邮箱密码那条路（routes/account.ts）不经过 AuthProvider。
 */
export function createAuthProvider(env: NodeJS.ProcessEnv = process.env): AuthProvider | null {
  if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
    return new OidcAuthProvider({
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      scope: env.OIDC_SCOPE,
    });
  }
  if (env.ISPACE_DEV_LOGIN === '1') return new MockAuthProvider();
  return null;
}
