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
  verified?: SessionClaims | null;
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


describe('intranet link sharing', () => {
  it('allows anonymous static resources only from configured company networks and revokes immediately', async () => {
    vi.stubEnv('ISPACE_INTRANET_CIDRS', '192.0.2.0/24');
    vi.stubEnv('ISPACE_TRUSTED_PROXY_CIDRS', '10.10.0.1/32');
    const options = { visibility: 'link', verified: null };
    const app = await fixture(options);
    try {
      const headers = { 'x-forwarded-uri': '/owner/page/assets/app.js' };
      expect((await app.inject({ url: '/deploy/api/authz/page', headers, remoteAddress: '192.0.2.5' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/deploy/api/authz/page', headers: { ...headers, 'x-forwarded-for': '192.0.2.5' }, remoteAddress: '203.0.113.5' })).statusCode).toBe(403);
      options.visibility = 'private';
      expect((await app.inject({ url: '/deploy/api/authz/page', headers, remoteAddress: '192.0.2.5' })).statusCode).toBe(302);
    } finally { await app.close(); }
  });

  it('denies anonymous access when no network allowlist was deployed', async () => {
    vi.stubEnv('ISPACE_INTRANET_CIDRS', '');
    const app = await fixture({ visibility: 'link', verified: null });
    try {
      expect((await app.inject({ url: '/deploy/api/authz/page', headers: { 'x-forwarded-uri': '/owner/page/' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/svc/owner/backend/' })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it.each([true, false])('supports explicitly link-shared backend exposed=%s, never other private services', async exposed => {
    vi.stubEnv('ISPACE_INTRANET_CIDRS', '192.0.2.0/24');
    vi.stubEnv('ISPACE_TRUSTED_PROXY_CIDRS', '');
    const upstream = createServer((_req, res) => res.end('anonymous application response'));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as { port: number }).port;
    const options = { visibility: 'link', exposed, verified: null, port };
    const app = await fixture(options);
    try {
      const response = await app.inject({ url: '/svc/owner/backend/data', remoteAddress: '192.0.2.5' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('anonymous application response');
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await app.inject({ url: '/svc/owner/backend/data', remoteAddress: '203.0.113.5' })).statusCode).toBe(403);
      options.visibility = 'private';
      expect((await app.inject({ url: '/svc/owner/backend/data', remoteAddress: '192.0.2.5' })).statusCode).toBe(401);
    } finally { await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
  });
});


describe('review regressions for resource access', () => {
  it('accepts link URLs without a trailing slash when a query string is present', async () => {
    vi.stubEnv('ISPACE_INTRANET_CIDRS', '192.0.2.0/24');
    const app = await fixture({ visibility: 'link', verified: null });
    try {
      const r = await app.inject({ url: '/deploy/api/authz/page', remoteAddress: '192.0.2.5',
        headers: { 'x-forwarded-uri': '/owner/page?tab=one' } });
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
