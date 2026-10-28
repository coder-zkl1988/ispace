import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser, type Sql } from '@ispace/db';
import { COOKIE_NAME, SessionService } from '@ispace/auth';
import { pgliteSql } from './pglite-sql.js';
import { OAUTH_COOKIE } from '../services/oauth-state.js';

const secret = 'route-test-only-session-secret-at-least-32';
let db: PGlite;
let sql: Sql;
let app: Awaited<ReturnType<typeof import('../server.js')['buildServer']>>;
let directory: string;
let fetchMock: ReturnType<typeof vi.fn>;
let tenant = 'company';
let tokenFailure = false;

beforeAll(async () => {
  vi.stubEnv('FEISHU_APP_ID', 'test-app');
  vi.stubEnv('FEISHU_APP_SECRET', 'test-secret');
  vi.stubEnv('FEISHU_TENANT_KEY', 'company');
  vi.stubEnv('ISPACE_PUBLIC_BASE', 'https://space.example');
  vi.stubEnv('SESSION_SECRET', secret);
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DOKPLOY_URL', '');
  vi.stubEnv('DOKPLOY_TOKEN', '');
  directory = await mkdtemp(join(tmpdir(), 'ispace-feishu-routes-'));
  for (const key of ['ISPACE_SITES_ROOT', 'ISPACE_RELEASES_ROOT', 'ISPACE_WORKSPACE_ROOT']) vi.stubEnv(key, directory);
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator;');
  const dir = new URL('../../../../packages/db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  }
  const { buildServer } = await import('../server.js');
  sql = pgliteSql(db);
  app = await buildServer({ sql, skipMigrations: true });
  await app.ready();
}, 30_000);

beforeEach(() => {
  tenant = 'company'; tokenFailure = false;
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/oauth/token')) {
      if (tokenFailure) return new Response(JSON.stringify({ code: 20064, error: 'invalid_grant', error_description: 'sensitive-upstream-detail' }), { status: 400 });
      const code = JSON.parse(String(init.body)).code;
      return new Response(JSON.stringify({ code: 0, access_token: code }));
    }
    if (url.endsWith('/user_info')) {
      const openId = (init.headers as Record<string, string>).authorization.slice(7);
      return new Response(JSON.stringify({ code: 0, data: { tenant_key: tenant, open_id: openId, name: '测试员工' } }));
    }
    throw new Error('Unexpected outbound request');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterAll(async () => {
  await app?.close(); await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

async function start(query = '', cookie?: string) {
  const response = await app.inject({ url: `/deploy/api/auth/login${query}`, headers: cookie ? { cookie } : {} });
  expect(response.statusCode).toBe(302);
  const location = new URL(response.headers.location!);
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? '');
  const browser = cookies.find(c => c.startsWith(`${OAUTH_COOKIE}=`))!;
  expect(browser).toContain('HttpOnly'); expect(browser).toContain('Secure');
  expect(location.searchParams.get('redirect_uri')).toBe('https://space.example/deploy/api/auth/callback');
  return { state: location.searchParams.get('state')!, cookie: browser.split(';')[0]!, response };
}
async function callback(attempt: Awaited<ReturnType<typeof start>>, code: string, extraCookie = '') {
  return app.inject({ url: `/deploy/api/auth/callback?${new URLSearchParams({ state: attempt.state, code })}`,
    headers: { cookie: attempt.cookie + (extraCookie ? `; ${extraCookie}` : '') } });
}
function sessionCookie(response: Awaited<ReturnType<typeof callback>>) {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? '');
  const session = cookies.find(c => c.startsWith(`${COOKIE_NAME}=`));
  expect(session).toContain('HttpOnly'); expect(session).toContain('Secure');
  expect(cookies.some(c => c.startsWith(`${OAUTH_COOKIE}=`) && c.includes('Max-Age=0'))).toBe(true);
  return session!.split(';')[0]!;
}

describe('full Feishu browser login routes with database and mocked Feishu', () => {
  it('reports the configured provider without exposing app credentials', async () => {
    const r = await app.inject('/deploy/api/auth/policy');
    expect(r.json()).toMatchObject({ ssoEnabled: true, ssoProvider: 'feishu' });
    expect(r.body).not.toContain('test-secret');
  });
  it('registers a first employee, sets usable secure cookies, and preserves the destination', async () => {
    const response = await callback(await start('?redirect=%2Fmine%3Ftab%3Dmade'), 'first-employee');
    expect(response.statusCode).toBe(302); expect(response.headers.location).toBe('/mine?tab=made');
    const me = await app.inject({ url: '/deploy/api/me', headers: { cookie: sessionCookie(response) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ role: 'employee', status: 'active' });
    const binding = await app.inject({ url: '/deploy/api/auth/feishu-binding', headers: { cookie: sessionCookie(response) } });
    expect(binding.json()).toEqual({ enabled: true, bound: true });
  });
  it('reuses the account and rejects callback replay before contacting Feishu', async () => {
    const attempt = await start();
    const response = await callback(attempt, 'first-employee');
    expect(response.statusCode).toBe(302);
    const count = await db.query<{ n: number }>('SELECT count(*)::int n FROM ispace.users');
    const calls = fetchMock.mock.calls.length;
    expect((await callback(attempt, 'first-employee')).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM ispace.users')).rows).toEqual(count.rows);
  });
  it('rejects absent/mismatched browser cookies without consuming the legitimate attempt', async () => {
    const attempt = await start();
    const url = `/deploy/api/auth/callback?code=cookie-check&state=${attempt.state}`;
    expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { cookie: `${OAUTH_COOKIE}=${'z'.repeat(43)}` } })).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await callback(attempt, 'cookie-check')).statusCode).toBe(302);
  });
  it('rejects expired state and handles authorization cancellation', async () => {
    const expired = await start();
    await db.exec("UPDATE ispace.oauth_states SET expires_at=now()-interval '1 second'");
    expect((await callback(expired, 'expired')).statusCode).toBe(401);
    const cancel = await start();
    const r = await app.inject({ url: `/deploy/api/auth/callback?state=${cancel.state}&error=access_denied`, headers: { cookie: cancel.cookie } });
    expect(r.statusCode).toBe(401); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not redirect a successful login to an external site', async () => {
    const r = await callback(await start('?redirect=https%3A%2F%2Fevil.example%2F'), 'redirect-check');
    expect(r.statusCode).toBe(302); expect(r.headers.location).toMatch(/^\/[a-z0-9-]+\/$/);
  });
  it('rejects browser-normalized external redirects too', async () => {
    const r = await callback(await start(`?redirect=${encodeURIComponent('/\\evil.example')}`), 'backslash-redirect');
    expect(r.statusCode).toBe(302);
    expect(new URL(r.headers.location!, 'https://space.example').origin).toBe('https://space.example');
  });
  it('preserves mobile pairing and delivers its token only once', async () => {
    const pair = await app.inject({ method: 'POST', url: '/deploy/api/auth/native/pair' });
    const id = pair.json().pairingId;
    const r = await callback(await start(`?pairing=${id}`), 'mobile-pairing');
    expect(r.statusCode).toBe(200);
    const poll = await app.inject(`/deploy/api/auth/native/poll?id=${id}`);
    expect(poll.json().status).toBe('ok');
    expect((await app.inject({ url: '/deploy/api/me', headers: { authorization: `Bearer ${poll.json().token}` } })).statusCode).toBe(200);
    expect((await app.inject(`/deploy/api/auth/native/poll?id=${id}`)).json().status).toBe('expired');
    expect((await app.inject('/deploy/api/auth/login?pairing=unregistered')).statusCode).toBe(401);
  });
  it('keeps native deep-link codes single use without putting a session token into the URL', async () => {
    const r = await callback(await start('?redirect=ispace%3A%2F%2Fauth'), 'mobile-deep-link');
    const url = new URL(r.headers.location!);
    expect(url.protocol).toBe('ispace:'); expect(url.searchParams.has('token')).toBe(false);
    const request = { method: 'POST' as const, url: '/deploy/api/auth/native/exchange', payload: { code: url.searchParams.get('code') } };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(401);
  });
  it('returns 403 for another tenant and never creates an account', async () => {
    tenant = 'foreign-tenant';
    const before = await db.query('SELECT id FROM ispace.users');
    const r = await callback(await start(), 'foreign-employee');
    expect(r.statusCode).toBe(403);
    expect((await db.query('SELECT id FROM ispace.users')).rows).toEqual(before.rows);
  });
  it('returns an authentication error for an invalid grant instead of a platform 500', async () => {
    tokenFailure = true;
    const r = await callback(await start(), 'bad-code');
    expect(r.statusCode).toBe(401); expect(r.body).not.toContain('sensitive-upstream-detail');
  });
  it('returns 502 for an upstream transport failure without leaking its message', async () => {
    fetchMock.mockRejectedValue(new Error('upstream contains test-secret'));
    const r = await callback(await start(), 'offline');
    expect(r.statusCode).toBe(502); expect(r.body).not.toContain('test-secret');
  });
  it('requires a current account to start a binding', async () => {
    expect((await app.inject('/deploy/api/auth/login?bind=1')).statusCode).toBe(401);
  });
  it('binds an existing account and refuses an account switch during authorization', async () => {
    const legacy = await createUser(sql, { ssoSubject: 'email|legacy-route', username: 'legacy-route', displayName: '旧账号' });
    await sql`INSERT INTO ispace.apps(owner_id,slug,name,icon_letter,type) VALUES(${legacy.id},'old-page','旧项目','旧','static')`;
    const sessions = new SessionService(secret);
    const token = await sessions.issue({ uid: legacy!.id, username: 'legacy-route', role: 'employee', identity: 'user', epoch: 0 });
    const original = `${COOKIE_NAME}=${token}`;
    const attempt = await start('?bind=1&redirect=%2Fmine', original);
    expect((await callback(attempt, 'bind-route')).statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    const valid = await callback(await start('?bind=1', original), 'bind-route', original);
    expect(valid.statusCode).toBe(302);
    const me = await app.inject({ url: '/deploy/api/me', headers: { cookie: sessionCookie(valid) } });
    expect(me.statusCode).toBe(200); expect(me.json().user.username).toBe('legacy-route');
    expect((await sql`SELECT owner_id FROM ispace.apps WHERE slug='old-page'`)[0]?.owner_id).toBe(legacy.id);
    const [identity] = (await db.query<{ user_id: string }>("SELECT user_id FROM ispace.external_identities WHERE subject LIKE '%bind-route'")).rows;
    expect(identity?.user_id).toBe(legacy!.id);
  });
});
