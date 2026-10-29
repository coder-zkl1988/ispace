import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { createDb, createUser, runMigrations, provisionUserSchema, deprovisionUserSchema, currentExposedSchemas, type Sql } from '@ispace/db';
import { SessionService } from '@ispace/auth';
import { ERROR_CODES, IspaceError, schemaNameFor, type User } from '@ispace/contracts';
import { resolveFeishuAccount } from '../services/feishu-account.js';
import { setAppVisibility } from '../services/visibility.js';
import { registerMcp } from '../mcp/server.js';
import { registerShareRoutes } from '../routes/shares.js';
import { registerBackendRoutes } from '../routes/backends.js';
import { fileURLToPath } from 'node:url';

// Like the existing native integration suites, use an isolated disposable DB only.
const dsn = process.env.ISPACE_TEST_PG;
describe.skipIf(!dsn)('Feishu and link sharing on real PostgreSQL connections', () => {
  let sql: Sql;
  let app: ReturnType<typeof Fastify>;
  let owner: User;
  let colleague: User;
  let appId: string;
  let bearer: string;
  const ownerHeaders = { 'x-test-user': 'owner' };
  beforeAll(async () => {
    const url = new URL(dsn!);
    sql = createDb({ host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), max: 12 });
    await sql.unsafe('DROP SCHEMA IF EXISTS ispace CASCADE');
    await runMigrations(sql, fileURLToPath(new URL('../../../../packages/db/migrations/', import.meta.url)));
    // Match the Supabase roles needed by provisioning, without depending on a running PostgREST.
    await sql.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator; END IF;
    END $$;`);
    owner = await createUser(sql, { username: 'review-owner', displayName: 'Owner', ssoSubject: 'test|owner' });
    colleague = await createUser(sql, { username: 'review-colleague', displayName: 'Colleague', ssoSubject: 'test|colleague' });
    const [row] = await sql`INSERT INTO ispace.apps(owner_id,slug,name,icon_letter,type)
      VALUES(${owner.id},'review-page','Review','R','static') RETURNING id`;
    appId = row!.id;
    vi.stubEnv('ISPACE_INTRANET_CIDRS', '192.0.2.0/24');
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => err instanceof IspaceError
      ? reply.status(err.httpStatus).send(err.toJSON()) : reply.status(500).send({ message: err.message }));
    const requireAuth = async (req: FastifyRequest) => {
      if (req.headers['x-test-user'] === 'owner') return owner;
      if (req.headers['x-test-user'] === 'colleague') return colleague;
      throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
    };
    registerShareRoutes(app, { sql, requireAuth });
    registerBackendRoutes(app, { sql, requireAuth, orchestrator: {} as never, publicHost: 'space.example' });
    const sessions = new SessionService('native-review-session-secret-32-chars-long');
    bearer = await sessions.issue({ uid: owner.id, username: owner.username, role: owner.role, identity: owner.identity, epoch: 0 });
    await registerMcp(app, { sql, sessions, publicBase: 'https://space.example', deployService: {} as never,
      orchestrator: {} as never, storage: { sitesRoot: '/unused', releasesRoot: '/unused' }, bundleRoot: '/unused' });
    await app.ready();
  }, 30_000);
  afterAll(async () => { await app?.close(); await sql?.end(); vi.unstubAllEnvs(); });

  async function mcp(name: string, args: Record<string, unknown>) {
    const r = await app.inject({ method: 'POST', url: '/deploy/mcp', headers: { authorization: `Bearer ${bearer}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    return r.json();
  }
  it('handles concurrent first logins without duplicate users or spaces', async () => {
    const claims = { sub: 'feishu|app|tenant|concurrent', name: 'Concurrent', raw: {} };
    const users = await Promise.all(Array.from({ length: 8 }, () => resolveFeishuAccount(sql, claims)));
    expect(new Set(users.map(u => u.id)).size).toBe(1);
    expect((await sql`SELECT 1 FROM ispace.users WHERE sso_subject=${claims.sub}`).length).toBe(1);
    expect((await sql`SELECT 1 FROM ispace.external_identities WHERE subject=${claims.sub}`).length).toBe(1);
  });
  it('serializes shared schema-list changes across Feishu, manual onboarding and deprovisioning', async () => {
    await provisionUserSchema(sql, 'review-retired');
    const claims = { sub: 'feishu|app|tenant|mixed-concurrency', name: 'Concurrent', raw: {} };
    const [user] = await Promise.all([
      resolveFeishuAccount(sql, claims),
      ...Array.from({ length: 6 }, (_, n) => provisionUserSchema(sql, `review-manual-${n}`)),
      deprovisionUserSchema(sql, 'review-retired', true),
    ]);
    const schemas = await currentExposedSchemas(sql);
    expect(schemas).toContain(schemaNameFor((user as User).username));
    for (let n = 0; n < 6; n++) expect(schemas).toContain(schemaNameFor(`review-manual-${n}`));
    expect(schemas).not.toContain(schemaNameFor('review-retired'));
  });
  it('MCP colleague sharing matches the partial unique index, is repeatable, and keeps link access', async () => {
    await setAppVisibility(sql, { user: owner, appId, visibility: 'link', source: 'console' });
    const args = { site: 'review-page', toUsername: colleague.username };
    for (let n = 0; n < 2; n++) {
      const r = await mcp('share-with', args);
      expect(r.error).toBeUndefined(); expect(r.result?.isError).not.toBe(true);
      expect(r.result.content[0].text).toContain('已分享');
    }
    // 邀请叠加在「知道链接的任何人」之上，不会把链接关掉
    expect((await sql`SELECT visibility FROM ispace.apps WHERE id=${appId}`)[0]?.visibility).toBe('link');
    expect((await sql`SELECT 1 FROM ispace.shares WHERE app_id=${appId} AND status='pending'`).length).toBe(1);
  });
  it('HTTP colleague sharing narrows private to shared, keeps link, and enforces ownership and active recipients', async () => {
    await setAppVisibility(sql, { user: owner, appId, visibility: 'link', source: 'console' });
    const request = { method: 'POST' as const, url: '/deploy/api/shares', payload: { appId, toUsername: colleague.username } };
    expect((await app.inject({ ...request, headers: ownerHeaders })).statusCode).toBe(200);
    expect((await sql`SELECT visibility FROM ispace.apps WHERE id=${appId}`)[0]?.visibility).toBe('link');
    await setAppVisibility(sql, { user: owner, appId, visibility: 'private', source: 'console' });
    expect((await app.inject({ ...request, headers: ownerHeaders })).statusCode).toBe(200);
    expect((await sql`SELECT visibility FROM ispace.apps WHERE id=${appId}`)[0]?.visibility).toBe('shared');
    expect((await app.inject({ ...request, headers: { 'x-test-user': 'colleague' } })).statusCode).toBe(403);
    await sql`UPDATE ispace.users SET status='pending' WHERE id=${colleague.id}`;
    expect((await app.inject({ ...request, headers: ownerHeaders })).statusCode).toBe(404);
    await sql`UPDATE ispace.users SET status='active' WHERE id=${colleague.id}`;
  });
  it('MCP respects the same peer-sharing policy as HTTP', async () => {
    await sql`UPDATE ispace.platform_policy SET allow_peer_share=false`;
    try {
      const r = await mcp('share-with', { site: 'review-page', toUsername: colleague.username });
      expect(r.error?.message ?? r.result?.content?.[0]?.text).toContain('关闭');
    } finally { await sql`UPDATE ispace.platform_policy SET allow_peer_share=true`; }
  });
  it('backend visibility updates remove market entries, keep colleagues and issue a link token', async () => {
    const [b] = await sql`INSERT INTO ispace.backends(owner_id,name,url_path,exposed,visibility)
      VALUES(${owner.id},'review-backend','/svc/review-owner/review-backend',true,'public') RETURNING id`;
    await sql`INSERT INTO ispace.marketplace_listings(backend_id,published_by) VALUES(${b!.id},${owner.id})`;
    await sql`INSERT INTO ispace.backend_shares(backend_id,to_user_id) VALUES(${b!.id},${colleague.id})`;
    const r = await app.inject({ method: 'PATCH', url: `/deploy/api/backends/${b!.id}`, headers: ownerHeaders, payload: { visibility: 'link' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().backend.visibility).toBe('link');
    expect(r.json().linkPath).toMatch(/^\/svc\/review-owner\/review-backend\/\?lk=[0-9a-f]{48}$/);
    expect((await sql`SELECT 1 FROM ispace.marketplace_listings WHERE backend_id=${b!.id}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM ispace.backend_shares WHERE backend_id=${b!.id}`).length).toBe(1);
    const reset = await app.inject({ method: 'POST', url: `/deploy/api/backends/${b!.id}/link/reset`, headers: ownerHeaders });
    expect(reset.json().linkPath).not.toBe(r.json().linkPath);
    await app.inject({ method: 'PATCH', url: `/deploy/api/backends/${b!.id}`, headers: ownerHeaders, payload: { visibility: 'private' } });
    expect((await sql`SELECT link_token FROM ispace.backends WHERE id=${b!.id}`)[0]?.link_token).toBeNull();
    expect((await sql`SELECT 1 FROM ispace.backend_shares WHERE backend_id=${b!.id}`).length).toBe(0);
  });
  it('backend colleague shares keep link access and honor the sharing policy', async () => {
    const [b] = await sql`INSERT INTO ispace.backends(owner_id,name,url_path,exposed,visibility)
      VALUES(${owner.id},'peer-backend','/svc/review-owner/peer-backend',true,'link') RETURNING id`;
    const request = { method: 'POST' as const, url: `/deploy/api/backends/${b!.id}/shares`,
      headers: ownerHeaders, payload: { toUsername: colleague.username } };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await sql`SELECT visibility FROM ispace.backends WHERE id=${b!.id}`)[0]?.visibility).toBe('link');
    await sql`UPDATE ispace.platform_policy SET allow_peer_share=false`;
    try { expect((await app.inject(request)).statusCode).toBe(403); }
    finally { await sql`UPDATE ispace.platform_policy SET allow_peer_share=true`; }
  });
  it('rolls back accepting a share when creating its install reference fails', async () => {
    await setAppVisibility(sql, { user: owner, appId, visibility: 'shared', source: 'console' });
    const invite = await app.inject({ method: 'POST', url: '/deploy/api/shares', headers: ownerHeaders,
      payload: { appId, toUsername: colleague.username } });
    const shareId = invite.json().share.id;
    await sql.unsafe(`CREATE FUNCTION ispace.test_fail_install() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional test installation failure'; END $$;
      CREATE TRIGGER test_fail_install BEFORE INSERT ON ispace.app_installs
      FOR EACH ROW EXECUTE FUNCTION ispace.test_fail_install();`);
    try {
      const response = await app.inject({ method: 'POST', url: `/deploy/api/shares/${shareId}/respond`,
        headers: { 'x-test-user': 'colleague' }, payload: { accept: true } });
      expect(response.statusCode).toBe(500);
      expect((await sql`SELECT status FROM ispace.shares WHERE id=${shareId}`)[0]?.status).toBe('pending');
      expect((await sql`SELECT 1 FROM ispace.app_installs WHERE app_id=${appId} AND user_id=${colleague.id}`).length).toBe(0);
    } finally {
      await sql.unsafe('DROP TRIGGER test_fail_install ON ispace.app_installs; DROP FUNCTION ispace.test_fail_install();');
    }
  });
  it('does not leave an install reference when private revocation races an accepted share', async () => {
    await sql.unsafe(`CREATE FUNCTION ispace.test_delay_install() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$;
      CREATE TRIGGER test_delay_install BEFORE INSERT ON ispace.app_installs
      FOR EACH ROW EXECUTE FUNCTION ispace.test_delay_install();`);
    try {
      for (const visibility of ['private'] as const) {
        await setAppVisibility(sql, { user: owner, appId, visibility: 'shared', source: 'console' });
        const invite = await app.inject({ method: 'POST', url: '/deploy/api/shares', headers: ownerHeaders,
          payload: { appId, toUsername: colleague.username } });
        const accepting = app.inject({ method: 'POST', url: `/deploy/api/shares/${invite.json().share.id}/respond`,
          headers: { 'x-test-user': 'colleague' }, payload: { accept: true } });
        // Wait until the INSERT is actually in progress on another connection.
        let inserting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const active = await sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND query ILIKE '%INSERT INTO ispace.app_installs%' AND wait_event='PgSleep'`;
          if (active.length) { inserting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        if (!inserting) { await accepting; throw new Error('Concurrent INSERT barrier was not reached'); }
        const [, accepted] = await Promise.all([
          setAppVisibility(sql, { user: owner, appId, visibility, source: 'console' }), accepting,
        ]);
        expect(accepted.statusCode).toBe(200);
        expect((await sql`SELECT visibility FROM ispace.apps WHERE id=${appId}`)[0]?.visibility).toBe(visibility);
        expect((await sql`SELECT 1 FROM ispace.app_installs WHERE app_id=${appId}`).length).toBe(0);
        expect((await sql`SELECT 1 FROM ispace.shares WHERE app_id=${appId} AND status IN ('pending','accepted')`).length).toBe(0);
      }
    } finally {
      await sql.unsafe('DROP TRIGGER test_delay_install ON ispace.app_installs; DROP FUNCTION ispace.test_delay_install();');
      await setAppVisibility(sql, { user: owner, appId, visibility: 'shared', source: 'console' });
    }
  });
  it('enables secret links without a company network allowlist and returns the link over HTTP and MCP', async () => {
    vi.stubEnv('ISPACE_INTRANET_CIDRS', '');
    try {
      const r = await app.inject({ method: 'PATCH', url: `/deploy/api/apps/${appId}/visibility`, headers: ownerHeaders,
        payload: { visibility: 'link' } });
      expect(r.statusCode).toBe(200);
      expect(r.json().linkPath).toMatch(/^\/review-owner\/review-page\/\?lk=[0-9a-f]{48}$/);
      expect((await app.inject({ url: `/deploy/api/apps/${appId}/link`, headers: ownerHeaders })).json().linkPath).toBe(r.json().linkPath);
      expect((await app.inject({ url: `/deploy/api/apps/${appId}/link`, headers: { 'x-test-user': 'colleague' } })).statusCode).toBe(403);
      const m = await mcp('set-visibility', { site: 'review-page', visibility: 'link' });
      expect(m.result.content[0].text).toContain(`https://space.example${r.json().linkPath}`);
    } finally { vi.stubEnv('ISPACE_INTRANET_CIDRS', '192.0.2.0/24'); }
  });
});
