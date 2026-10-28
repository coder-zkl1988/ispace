import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { registerPlayRoutes } from '../routes/play.js';
import { PlaySessions } from '../services/play-session.js';
import { dropSelfBase } from '../services/static-serve.js';

/**
 * 已发布页面的试玩：换令牌与按令牌出文件。
 *
 * ┌─ 这一组守的是什么 ──────────────────────────────────────────────────┐
 * │ 核心那条是「**子资源不带 cookie 也要能出来**」。它看着像在测一个       │
 * │ 无关紧要的细节，其实是这次改动的全部理由：                            │
 * │                                                                      │
 * │ 沙箱 iframe 是 opaque origin，浏览器把它发出的子资源请求当跨站，      │
 * │ SameSite=Lax 的会话 cookie 不带。原先每个文件请求都 requireAuth，     │
 * │ 于是 CSS/JS/图片全部 302 去登录页——线上就是一页裸 HTML。            │
 * │                                                                      │
 * │ 所以如果哪天有人"顺手"在文件那条路上加回 requireAuth，这条用例必须    │
 * │ 当场红。                                                             │
 * └──────────────────────────────────────────────────────────────────────┘
 */
describe('试玩令牌', () => {
  let app: ReturnType<typeof Fastify>;
  let sites: string;
  let sessions: PlaySessions;

  const me = { id: 'u-me', username: 'lixiao', role: 'employee', status: 'active' } as User;
  const other = { id: 'u-other', username: 'wangkai', role: 'employee', status: 'active' } as User;
  const who: Record<string, User> = { me, other };

  /** 假 sql：按查询里出现的字段决定返回什么，够 resolveAppAccess 用。 */
  let tokenEpoch = 0;
  const rows: Record<string, unknown[]> = {
    app: [{ app_id: 'a-1', owner_id: 'u-me', visibility: 'private', status: 'running' }],
    share: [],
  };
  const fakeSql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join(' ');
      if (q.includes('u.token_epoch')) {
        const user = Object.values(who).find(u => u.id === values.at(-1));
        return user ? [{ id: user.id, username: user.username, role: user.role, status: user.status, identity: 'user', token_epoch: tokenEpoch }] : [];
      }
      if (q.includes('ispace.shares')) return rows.share;
      if (q.includes('ispace.apps')) return rows.app;
      return [];
    },
    { json: (v: unknown) => v },
  ) as never;

  beforeAll(async () => {
    sites = mkdtempSync(join(tmpdir(), 'ispace-sites-'));
    /*
      真实线上 /srv/sites/{user}/{slug} 是**指向 releases 的软链**。
      照着搭出来，才测得到 safeResolve 拿 root 的 realpath 去比这件事
      ——拿原样 root 比的话每个请求都会 403。
    */
    const release = join(sites, '_releases', 'lixiao-paiban-20261020');
    mkdirSync(join(release, 'assets'), { recursive: true });
    writeFileSync(join(release, 'index.html'),
      '<!doctype html><head><link rel=stylesheet href="./assets/a.css">'
      + '<script src="/platform/shell.js"></script></head><h1>排班表</h1>');
    writeFileSync(join(release, 'assets', 'a.css'), 'h1{color:red}');
    mkdirSync(join(sites, 'lixiao'), { recursive: true });
    symlinkSync(release, join(sites, 'lixiao', 'paiban'));
    // 工作区外面的秘密，用来验越界
    writeFileSync(join(sites, 'secret.txt'), 'SECRET');

    sessions = new PlaySessions();
    app = Fastify();
    app.setErrorHandler((err, _q, reply) => {
      if (err instanceof IspaceError) return reply.status(err.httpStatus).send(err.toJSON());
      const m = err as { validation?: unknown; issues?: unknown; message?: string };
      if (m.validation || m.issues) {
        return reply.status(422).send({ code: ERROR_CODES.INVALID_INPUT, message: m.message ?? '入参不合法' });
      }
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });
    registerPlayRoutes(app, {
      sql: fakeSql,
      requireAuth: async (req: FastifyRequest) => {
        const u = who[String(req.headers['x-test-user'] ?? '')];
        if (!u) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        return u;
      },
      sitesRoot: sites,
      sessions,
    });
    await app.ready();
  });

  afterAll(async () => { await app?.close(); });

  const mint = (user?: string, body: unknown = { owner: 'lixiao', slug: 'paiban' }) =>
    app.inject({
      method: 'POST', url: '/deploy/api/play-session',
      ...(user ? { headers: { 'x-test-user': user } } : {}),
      payload: body,
    });

  const fetchFile = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  it('换令牌要登录', async () => {
    expect((await mint()).statusCode).toBe(401);
  });

  it('本人换得到，令牌不是地址里那两段', async () => {
    const res = await mint('me');
    expect(res.statusCode).toBe(200);
    const b = res.json() as { token: string; url: string };
    expect(b.url).toBe(`/deploy/api/play/${b.token}/`);
    expect(b.token.length).toBeGreaterThan(30);
  });

  it('别人的私有页面换不到令牌', async () => {
    const res = await mint('other');
    expect(res.statusCode).toBe(403);
  });

  it('改成全公司可见之后，别人就换得到了', async () => {
    rows.app = [{ app_id: 'a-1', owner_id: 'u-me', visibility: 'public', status: 'running' }];
    expect((await mint('other')).statusCode).toBe(200);
    rows.app = [{ app_id: 'a-1', owner_id: 'u-me', visibility: 'private', status: 'running' }];
  });

  it('已停用的页面：404，而且和"不存在"同一句话', async () => {
    rows.app = [{ app_id: 'a-1', owner_id: 'u-me', visibility: 'public', status: 'stopped' }];
    const stopped = await mint('other');
    rows.app = [];
    const missing = await mint('other');
    expect(stopped.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(stopped.json().message).toBe(missing.json().message);
    rows.app = [{ app_id: 'a-1', owner_id: 'u-me', visibility: 'private', status: 'running' }];
  });

  it('owner/slug 不合法是 4xx，不会被拼进路径', async () => {
    for (const bad of [{ owner: '../etc', slug: 'x' }, { owner: 'lixiao', slug: '../..' }]) {
      const res = await mint('me', bad);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
  });

  // ── 下面这几条才是这次改动的理由 ────────────────────────────────
  it('**子资源不带任何 cookie 也要出得来**', async () => {
    const { token } = (await mint('me')).json() as { token: string };

    const html = await fetchFile(`/deploy/api/play/${token}/`);
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('排班表');

    /* 关键：没有 x-test-user、没有 cookie，CSS 照样 200 */
    const css = await fetchFile(`/deploy/api/play/${token}/assets/a.css`);
    expect(css.statusCode).toBe(200);
    expect(css.body).toBe('h1{color:red}');
    expect(css.headers['content-type']).toContain('text/css');
  });

  /*
    沙箱头让页面成为 opaque origin（Origin: null），而 Vite / VitePress 的入口
    是 `<script type="module" crossorigin>`、`<link rel=stylesheet crossorigin>`
    ——按 CORS 去取。响应里没有 ACAO，浏览器直接丢掉：React 应用空屏、样式全无。
    线上 zongkelong/voice-clone、ximengkai/life 就是这样（真 Chrome 里复现过）。
  */
  it('子资源带 Access-Control-Allow-Origin，沙箱里的模块脚本与带 crossorigin 的样式才取得到', async () => {
    const { token } = (await mint('me')).json() as { token: string };
    const css = await fetchFile(`/deploy/api/play/${token}/assets/a.css`, { origin: 'null' });
    expect(css.headers['access-control-allow-origin']).toBe('*');
    /* * 不许带凭据——放的只是"拿着这个地址的人本来就能取到的东西" */
    expect(css.headers['access-control-allow-credentials']).toBeUndefined();
  });

  /*
    dongfei/deepseek-harness-learn 的 <head> 里写死了
    `<base href="https://域名/dongfei/deepseek-harness-learn/">`：在试玩地址下它把
    所有相对路径都改指回正式地址，而那边要登录，于是只剩没样式的字。
  */
  it('指回这个页面正式地址的 <base href> 在试玩里摘掉，别的 base 不动', async () => {
    const docs = join(sites, 'lixiao', 'docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'index.html'),
      '<!doctype html><head><base href="https://ispace.example.com/lixiao/docs/">'
      + '<link rel=stylesheet href="./assets/s.css"></head><h1>文档</h1>');
    const { token } = (await mint('me', { owner: 'lixiao', slug: 'docs' })).json() as { token: string };
    const html = await fetchFile(`/deploy/api/play/${token}/`);
    expect(html.body).not.toContain('<base');
    expect(html.body).toContain('./assets/s.css');

    expect(dropSelfBase('<base href="/lixiao/docs/">', 'lixiao', 'docs')).toBe('');
    expect(dropSelfBase('<base href="https://cdn.example.com/x/">', 'lixiao', 'docs'))
      .toBe('<base href="https://cdn.example.com/x/">');
    expect(dropSelfBase('<base href="https://h/lixiao/docs-v2/">', 'lixiao', 'docs'))
      .toBe('<base href="https://h/lixiao/docs-v2/">');
  });

  it('软链出去的站点根也能正常伺服（realpath 要拿 root 的 realpath 比）', async () => {
    const { token } = (await mint('me')).json() as { token: string };
    // 站点根就是一条指向 releases 的软链，这条过了说明那道边界没误伤
    expect((await fetchFile(`/deploy/api/play/${token}/`)).statusCode).toBe(200);
  });

  it('试玩里摘掉平台 chrome——它在沙箱里调不到接口，只会显示一颗假的登录按钮', async () => {
    const { token } = (await mint('me')).json() as { token: string };
    const html = await fetchFile(`/deploy/api/play/${token}/`);
    expect(html.body).not.toContain('/platform/shell.js');
    // 发布产物本身一个字节没改
    expect(html.body).toContain('排班表');
  });

  it('响应带沙箱头与 no-referrer（令牌在地址里，外链不能把它捎出去）', async () => {
    const { token } = (await mint('me')).json() as { token: string };
    const html = await fetchFile(`/deploy/api/play/${token}/`);
    expect(html.headers['content-security-policy']).toBe('sandbox allow-scripts allow-forms allow-popups');
    expect(html.headers['referrer-policy']).toBe('no-referrer');
    expect(html.headers['cache-control']).toBe('no-store');
  });

  it('密码变更后旧试玩令牌失效，重新登录后的新令牌仍可正常使用', async () => {
    const oldToken = sessions.open(me.id, 'lixiao', 'paiban', tokenEpoch).token;
    tokenEpoch += 1;
    try {
      expect((await app.inject({ url: `/deploy/api/play/${oldToken}/` })).statusCode).toBe(403);
      const renewed = sessions.open(me.id, 'lixiao', 'paiban', tokenEpoch);
      expect(renewed.token).not.toBe(oldToken);
      expect((await app.inject({ url: `/deploy/api/play/${renewed.token}/` })).statusCode).toBe(200);
    } finally { tokenEpoch = 0; }
  });

  it('撤销分享后，已签发的试玩令牌不再提供文件', async () => {
    rows.app = [{ app_id: 'a-1', owner_id: 'u-me', visibility: 'public', status: 'running' }];
    const token = sessions.open(other.id, 'lixiao', 'demo').token;
    rows.app = [{ app_id: 'a-1', owner_id: 'u-me', visibility: 'private', status: 'running' }];
    const r = await app.inject({ url: `/deploy/api/play/${token}/` });
    expect(r.statusCode).toBe(403);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('令牌不对、过期的，一律 404', async () => {
    expect((await fetchFile('/deploy/api/play/not-a-real-token/')).statusCode).toBe(404);

    let clock = 0;
    const s = new PlaySessions(() => clock);
    const one = s.open(me.id, 'lixiao', 'paiban');
    clock = 31 * 60 * 1000;
    expect(s.get(one.token)).toBeNull();
  });

  it('越界拿不到站点外面的文件', async () => {
    const { token } = (await mint('me')).json() as { token: string };
    const res = await fetchFile(`/deploy/api/play/${token}/%2e%2e%2f%2e%2e%2fsecret.txt`);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('SECRET');
  });

  it('缺末尾斜杠要跳转，否则页面里的相对路径会少解析一级', async () => {
    const { token } = (await mint('me')).json() as { token: string };
    const res = await fetchFile(`/deploy/api/play/${token}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/deploy/api/play/${token}/`);
  });

  it('同一个人看同一个作品续用同一张令牌，不是每次都换', async () => {
    const s = new PlaySessions();
    const a = s.open(me.id, 'lixiao', 'paiban');
    const b = s.open(me.id, 'lixiao', 'paiban');
    expect(b.token).toBe(a.token);
    expect(s.size).toBe(1);
  });

  it('每人最多 16 张，超了淘汰最旧的', async () => {
    let clock = 0;
    const s = new PlaySessions(() => { clock += 1; return clock; });
    const first = s.open(me.id, 'lixiao', 'app0');
    for (let i = 1; i < 16; i += 1) s.open(me.id, 'lixiao', `app${i}`);
    expect(s.size).toBe(16);
    s.open(me.id, 'lixiao', 'app16');          // 第 17 张
    expect(s.size).toBe(16);
    expect(s.get(first.token)).toBeNull();     // 最旧的那张被挤掉
  });
});
