import { createServer } from 'node:http';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, } from 'vitest';
import { vi } from 'vitest';
afterEach(() => vi.unstubAllEnvs());
import type { Sql } from '@ispace/db';
import type { SessionClaims } from '@ispace/auth';
import { registerAuthzRoutes } from '../routes/authz.js';
import { registerSvcProxy } from '../routes/svc-proxy.js';

const claims: SessionClaims = {
  uid: 'visitor', username: 'visitor', role: 'admin', identity: 'user',
};

async function fixture(options: {
  status?: string; role?: string; missing?: boolean; tokenEpoch?: number; visibility?: string;
  owner?: string; exposed?: boolean; shared?: boolean; port?: number;
  verified?: SessionClaims | null; linkToken?: string | null;
} = {}) {
  const sql = (async (parts: TemplateStringsArray) => {
    const query = parts.join('?');
    if (query.includes('FROM ispace.users')) return options.missing ? [] : [{
      id: claims.uid, username: claims.username, role: options.role ?? 'employee',
      identity: 'user', status: options.status ?? 'active', token_epoch: options.tokenEpoch ?? 0,
    }];
    if (query.includes('FROM ispace.shares') || query.includes('FROM ispace.backend_shares')) {
      return options.shared ? [{}] : [];
    }
    return [{
      id: 'resource', app_id: 'resource', owner_id: options.owner ?? 'owner',
      visibility: options.visibility ?? 'private', status: 'running',
      exposed: options.exposed ?? true, container_name: '127.0.0.1', port: options.port ?? 1,
      link_token: options.linkToken ?? null,
    }];
  }) as unknown as Sql;
  const app = Fastify();
  await app.register(cookie);
  const verifySession = async () => options.verified === undefined ? claims : options.verified;
  registerAuthzRoutes(app, { sql, verifySession, publicBase: 'http://localhost' });
  registerSvcProxy(app, { sql, verifySession });
  return app;
}

describe('resource access uses current account state', () => {
  it.each(['archived', 'pending', 'disabled'])('rejects %s accounts on both routes', async (status) => {
    const app = await fixture({ status, visibility: 'public' });
    try {
      const headers = { cookie: 'ispace_session=synthetic', 'x-forwarded-uri': '/owner/page/' };
      expect((await app.inject({ url: '/deploy/api/authz/page', headers })).statusCode).toBe(302);
      expect((await app.inject({ url: '/svc/owner/backend/data', headers })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it.each([{ missing: true }, { verified: null }])('rejects missing users and invalid sessions', async (options) => {
    const app = await fixture(options);
    try {
      const headers = { authorization: 'Bearer synthetic', 'x-forwarded-uri': '/owner/page/' };
      expect((await app.inject({ url: '/deploy/api/authz/page', headers })).statusCode).toBe(302);
      expect((await app.inject({ url: '/svc/owner/backend/data', headers })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it('does not trust the admin role in an old JWT', async () => {
    const app = await fixture();
    try {
      const headers = { cookie: 'ispace_session=synthetic', 'x-forwarded-uri': '/owner/page/' };
      expect((await app.inject({ url: '/deploy/api/authz/page', headers })).statusCode).toBe(403);
      expect((await app.inject({ url: '/svc/owner/backend/data', headers })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('denies ungranted shares and requests without a session', async () => {
    const app = await fixture({ visibility: 'shared' });
    try {
      const headers = { cookie: 'ispace_session=synthetic', 'x-forwarded-uri': '/owner/page/' };
      expect((await app.inject({ url: '/deploy/api/authz/page', headers })).statusCode).toBe(403);
      expect((await app.inject({ url: '/svc/owner/backend/data', headers })).statusCode).toBe(403);
      expect((await app.inject({ url: '/deploy/api/authz/page', headers: { 'x-forwarded-uri': '/owner/page/' } })).statusCode).toBe(302);
      expect((await app.inject({ url: '/svc/owner/backend/data' })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it.each([
    { role: 'admin' }, { owner: claims.uid }, { visibility: 'public' },
    { visibility: 'shared', shared: true },
  ])('retains authorized access: %j', async (options) => {
    const upstream = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as { port: number }).port;
    const app = await fixture({ ...options, port });
    try {
      const headers = { cookie: 'ispace_session=synthetic', 'x-forwarded-uri': '/owner/page/' };
      expect((await app.inject({ url: '/deploy/api/authz/page', headers })).statusCode).toBe(200);
      expect((await app.inject({ url: '/svc/owner/backend/data', headers })).body).toBe('ok');
    } finally {
      await app.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

describe('proxy credential boundary', () => {
  it.each([
    'ispace_session=synthetic; app_session=own; ispace_session=duplicate',
    'ispace_session=synthetic',
    undefined,
  ])('does not forward platform credentials (%s)', async (cookies) => {
    const upstream = createServer((req, res) => res.end(JSON.stringify({
      cookie: req.headers.cookie, authorization: req.headers.authorization, url: req.url,
    })));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const app = await fixture({ visibility: 'public', port: (upstream.address() as { port: number }).port });
    try {
      const response = await app.inject({ url: '/svc/owner/backend/data?q=1', headers: {
        ...(cookies ? { cookie: cookies } : {}), authorization: 'Bearer synthetic',
      } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ...(cookies?.includes('app_session') ? { cookie: 'app_session=own' } : {}),
        url: '/svc/owner/backend/data?q=1',
      });
    } finally {
      await app.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});


const TOKEN = 'a'.repeat(48);
const GRANT = 'ispace_link_' + '0123456789abcdef'.repeat(2);

describe('secret link sharing (anyone with the link)', () => {
  it('trades ?lk= for path-scoped cookies, then serves subresources from the cookie alone', async () => {
    const options = { visibility: 'link', verified: null, linkToken: TOKEN as string | null };
    const app = await fixture(options);
    try {
      const page = (uri: string, cookie?: string) => app.inject({
        url: '/deploy/api/authz/page', headers: { 'x-forwarded-uri': uri, ...(cookie ? { cookie } : {}) },
      });
      // 原地址是猜得到的，不带令牌不算数
      expect((await page('/owner/page/')).statusCode).toBe(302);
      expect((await page('/owner/page/')).headers.location).toContain('/?redirect=');

      const traded = await page(`/owner/page/?tab=one&lk=${TOKEN}`);
      expect(traded.statusCode).toBe(302);
      expect(traded.headers.location).toBe('/owner/page/?tab=one');
      const cookies = ([] as string[]).concat(traded.headers['set-cookie'] ?? []);
      expect(cookies).toEqual([
        expect.stringMatching(new RegExp(`^ispace_link=${TOKEN}; Path=/owner/page; HttpOnly; SameSite=Lax`)),
        expect.stringMatching(/^ispace_link_resource=|^ispace_link_/),
      ]);
      expect(cookies[1]).toContain('Path=/svc/owner');

      expect((await page('/owner/page/assets/app.js', `ispace_link=${TOKEN}`)).statusCode).toBe(200);
      const stale = await page('/owner/page/', `ispace_link=${'b'.repeat(48)}`);
      expect(stale.statusCode).toBe(403);
      expect(stale.body).toContain('链接已经失效');

      // 重置 / 关闭后旧 Cookie 立即失效
      options.linkToken = 'c'.repeat(48);
      expect((await page('/owner/page/', `ispace_link=${TOKEN}`)).statusCode).toBe(403);
      options.visibility = 'private'; options.linkToken = TOKEN;
      expect((await page(`/owner/page/?lk=${TOKEN}`)).statusCode).toBe(302);
      expect((await page(`/owner/page/?lk=${TOKEN}`)).headers.location).toContain('/?redirect=');
    } finally { await app.close(); }
  });

  it('works without a company network allowlist, and adds it as a second condition when configured', async () => {
    const headers = { 'x-forwarded-uri': '/owner/page/', cookie: `ispace_link=${TOKEN}` };
    const open = await fixture({ visibility: 'link', verified: null, linkToken: TOKEN });
    try {
      expect((await open.inject({ url: '/deploy/api/authz/page', headers, remoteAddress: '203.0.113.5' })).statusCode).toBe(200);
    } finally { await open.close(); }
    vi.stubEnv('ISPACE_INTRANET_CIDRS', '192.0.2.0/24');
    const gated = await fixture({ visibility: 'link', verified: null, linkToken: TOKEN });
    try {
      expect((await gated.inject({ url: '/deploy/api/authz/page', headers, remoteAddress: '192.0.2.5' })).statusCode).toBe(200);
      const outside = await gated.inject({ url: '/deploy/api/authz/page', headers, remoteAddress: '203.0.113.5' });
      expect(outside.statusCode).toBe(403);
      expect(outside.body).toContain('公司网络');
    } finally { await gated.close(); }
  });

  it('still lets the signed-in owner open a link page without the token', async () => {
    const app = await fixture({ visibility: 'link', owner: claims.uid, linkToken: TOKEN });
    try {
      const r = await app.inject({ url: '/deploy/api/authz/page',
        headers: { cookie: 'ispace_session=synthetic', 'x-forwarded-uri': '/owner/page/' } });
      expect(r.statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('serves an exposed link backend from its own token and strips link cookies before proxying', async () => {
    let seenCookie: string | undefined;
    const upstream = createServer((req, res) => { seenCookie = req.headers.cookie; res.end('anonymous application response'); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as { port: number }).port;
    const options = { visibility: 'link', exposed: true, verified: null, port, linkToken: TOKEN };
    const app = await fixture(options);
    try {
      const traded = await app.inject({ url: `/svc/owner/backend/?lk=${TOKEN}` });
      expect(traded.statusCode).toBe(302);
      expect(traded.headers.location).toBe('/svc/owner/backend/');
      expect(String(traded.headers['set-cookie'])).toContain('Path=/svc/owner/backend');

      const r = await app.inject({ url: '/svc/owner/backend/data', headers: { cookie: `ispace_link=${TOKEN}; app=1; ${GRANT}=x` } });
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe('anonymous application response');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(seenCookie).toBe('app=1');

      expect((await app.inject({ url: '/svc/owner/backend/data' })).statusCode).toBe(401);
      // 露出的后端不认页面那张授权 Cookie——它有自己的链接
      expect((await app.inject({ url: '/svc/owner/backend/data', headers: { cookie: `${GRANT}=${TOKEN}` } })).statusCode).toBe(401);
      options.visibility = 'private';
      expect((await app.inject({ url: '/svc/owner/backend/data', headers: { cookie: `ispace_link=${TOKEN}` } })).statusCode).toBe(401);
    } finally { await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
  });

  it('lets visitors of a link-shared page call the same owner\'s link API backend', async () => {
    const upstream = createServer((_req, res) => res.end('api'));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as { port: number }).port;
    const app = await fixture({ visibility: 'link', exposed: false, verified: null, port, linkToken: TOKEN });
    try {
      expect((await app.inject({ url: '/svc/owner/backend/data', headers: { cookie: `${GRANT}=${TOKEN}` } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/svc/owner/backend/data', headers: { cookie: `${GRANT}=${'d'.repeat(48)}` } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/svc/owner/backend/data', headers: { cookie: `ispace_link_nothex=${TOKEN}` } })).statusCode).toBe(401);
    } finally { await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
  });
});


describe('review regressions for resource access', () => {
  it('accepts link URLs without a trailing slash when a query string is present', async () => {
    const app = await fixture({ visibility: 'link', verified: null, linkToken: TOKEN });
    try {
      const r = await app.inject({ url: '/deploy/api/authz/page',
        headers: { 'x-forwarded-uri': '/owner/page?tab=one', cookie: `ispace_link=${TOKEN}` } });
      expect(r.statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it('rejects revoked sessions for private resources even when the JWT signature still verifies', async () => {
    const app = await fixture({ owner: claims.uid, tokenEpoch: 1 });
    try {
      const headers = { cookie: 'ispace_session=synthetic', 'x-forwarded-uri': '/owner/page/' };
      expect((await app.inject({ url: '/deploy/api/authz/page', headers })).statusCode).toBe(302);
      expect((await app.inject({ url: '/svc/owner/backend/', headers })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
