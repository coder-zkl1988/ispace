import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { IspaceError } from '@ispace/contracts';
import {
  COOKIE_NAME,
  SessionService,
  clearSessionCookie,
  sessionCookie,
} from '../session.js';

/**
 * 会话签发与校验。
 *
 * 这是整个平台的信任根：三个入口（浏览器 / CLI / MCP）都靠它换身份。
 * 下面的用例盯的是那些"错了也不会报错、只会悄悄放行"的地方——
 * 换密钥仍能验通、篡改 payload 仍能验通、别人签的 JWT 被当成自家的。
 */

const SECRET = 'x'.repeat(32);
const CLAIMS = {
  uid: '00000000-0000-4000-8000-000000000001',
  username: 'lixiao',
  role: 'employee',
  identity: 'developer',
} as const;

describe('SessionService 构造', () => {
  it('密钥短于 32 字符直接拒绝', () => {
    // HS256 下短密钥显著削弱签名强度，而且这类问题上线后几乎不可能被发现
    expect(() => new SessionService('short')).toThrow(/32/);
    expect(() => new SessionService('x'.repeat(31))).toThrow();
    expect(() => new SessionService('x'.repeat(32))).not.toThrow();
  });
});

describe('签发与校验', () => {
  it('自己签的自己认', async () => {
    const s = new SessionService(SECRET);
    expect(await s.verify(await s.issue(CLAIMS))).toMatchObject(CLAIMS);
  });

  it('换一把密钥就认不出来', async () => {
    const a = new SessionService(SECRET);
    const b = new SessionService('y'.repeat(32));
    await expect(b.verify(await a.issue(CLAIMS))).rejects.toThrow(IspaceError);
  });

  it('篡改任意一段都会失败', async () => {
    const s = new SessionService(SECRET);
    const token = await s.issue(CLAIMS);
    const [h, p, sig] = token.split('.');

    // 改 payload：把自己提权成 admin
    const tampered = JSON.parse(Buffer.from(p!, 'base64url').toString());
    tampered.role = 'admin';
    const forged = `${h}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${sig}`;
    await expect(s.verify(forged)).rejects.toThrow(IspaceError);

    // 改签名
    await expect(s.verify(`${h}.${p}.${'A'.repeat(sig!.length)}`)).rejects.toThrow(IspaceError);
  });

  it('过期即失效', async () => {
    const s = new SessionService(SECRET, -1); // 签发即过期
    await expect(s.verify(await s.issue(CLAIMS))).rejects.toThrow(IspaceError);
  });

  it('issuer / audience 不符的令牌不接受', async () => {
    // 同一个密钥若被别处复用，光验签名是不够的
    const key = new TextEncoder().encode(SECRET);
    const foreign = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('someone-else')
      .setAudience('another-app')
      .setExpirationTime('1h')
      .sign(key);
    await expect(new SessionService(SECRET).verify(foreign)).rejects.toThrow(IspaceError);
  });

  it('签名有效但 claims 形状不对，一样拒绝', async () => {
    // 比如 role 写了个表里没有的值。jose 只管签名，形状得自己把关。
    const key = new TextEncoder().encode(SECRET);
    const weird = await new SignJWT({ ...CLAIMS, role: 'superadmin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('ispace')
      .setAudience('ispace-platform')
      .setExpirationTime('1h')
      .sign(key);
    await expect(new SessionService(SECRET).verify(weird)).rejects.toThrow(IspaceError);
  });

  it('乱七八糟的输入抛的是 IspaceError 而不是裸异常', async () => {
    // 错误码要能被 Fastify 的错误映射认出来，否则会变成 500
    const s = new SessionService(SECRET);
    for (const bad of ['', 'not-a-jwt', 'a.b.c']) {
      await expect(s.verify(bad)).rejects.toThrow(IspaceError);
    }
  });
});

describe('extract：三个入口的携带方式', () => {
  const s = new SessionService(SECRET);

  it('Authorization: Bearer', () => {
    expect(s.extract({ authorization: 'Bearer abc.def.ghi' })).toBe('abc.def.ghi');
  });

  it('cookie', () => {
    expect(s.extract({ cookie: `${COOKIE_NAME}=tok123` })).toBe('tok123');
  });

  it('cookie 里混着别的键也能挑出来', () => {
    expect(s.extract({ cookie: `theme=dark; ${COOKIE_NAME}=tok123; lang=zh` })).toBe('tok123');
  });

  it('cookie 值被 URL 编码过要还原', () => {
    // 令牌里不会有 +/= 之外的字符，但 cookie 写入时统一编码了，读也要统一解
    expect(s.extract({ cookie: `${COOKIE_NAME}=${encodeURIComponent('a+b=c')}` })).toBe('a+b=c');
  });

  it('Authorization 优先于 cookie', () => {
    expect(s.extract({ authorization: 'Bearer from-header', cookie: `${COOKIE_NAME}=from-cookie` }))
      .toBe('from-header');
  });

  it('都没有就返回 null', () => {
    expect(s.extract({})).toBeNull();
    expect(s.extract({ cookie: 'theme=dark' })).toBeNull();
    // 不带 Bearer 前缀的不认——避免把别的方案的凭据当会话令牌
    expect(s.extract({ authorization: 'Basic dXNlcjpwYXNz' })).toBeNull();
  });
});

describe('cookie 属性', () => {
  it('HttpOnly 与 SameSite=Lax 一个都不能少', () => {
    const c = sessionCookie('tok', 3600);
    expect(c).toContain('HttpOnly');       // 挡住 JS 读取
    expect(c).toContain('SameSite=Lax');   // Strict 会让分享出去的页面显示未登录
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=3600');
  });

  it('secure 开关控制 Secure 属性', () => {
    // 内网 HTTP 阶段不能带 Secure，否则 cookie 根本不会被写入；
    // 上 HTTPS 时必须带上，否则明文链路上会泄露。
    expect(sessionCookie('tok', 3600, false)).not.toContain('Secure');
    expect(sessionCookie('tok', 3600, true)).toContain('Secure');
  });

  it('清除用的是 Max-Age=0 且值为空', () => {
    const c = clearSessionCookie();
    expect(c).toContain(`${COOKIE_NAME}=;`);
    expect(c).toContain('Max-Age=0');
  });

  it('令牌值经过编码，不会撑破 cookie 语法', () => {
    expect(sessionCookie('a;b=c', 60)).toContain(encodeURIComponent('a;b=c'));
  });
});
