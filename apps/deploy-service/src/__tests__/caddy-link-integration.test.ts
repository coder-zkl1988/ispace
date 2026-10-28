import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import Fastify from 'fastify';
import type { Sql } from '@ispace/db';
import { registerAuthzRoutes } from '../routes/authz.js';

const binary = process.env.ISPACE_TEST_CADDY;
describe.skipIf(!binary)('real Caddy link directory routing', () => {
  it('authorizes before canonical redirect and preserves query strings and relative assets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ispace-caddy-review-'));
    const site = join(dir, 'sites', 'owner', 'page');
    await mkdir(site, { recursive: true });
    await writeFile(join(site, 'index.html'), '<h1>private fixture</h1><script src="./app.js"></script>');
    await writeFile(join(site, 'app.js'), 'window.fixtureLoaded = true;');
    const reserve = createServer();
    await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>(resolve => reserve.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    let visibility = 'link';
    const sql = (async () => [{ app_id: 'page', owner_id: 'owner', visibility, status: 'running' }]) as unknown as Sql;
    vi.stubEnv('ISPACE_INTRANET_CIDRS', '192.0.2.0/24');
    vi.stubEnv('ISPACE_TRUSTED_PROXY_CIDRS', '127.0.0.1/32');
    const app = Fastify();
    registerAuthzRoutes(app, { sql, publicBase: origin, verifySession: async () => null });
    const upstream = await app.listen({ port: 0, host: '127.0.0.1' });
    let config = await readFile(new URL('../../../../infra/caddy/Caddyfile', import.meta.url), 'utf8');
    config = config.replace(':8080 {', `:${port} {`)
      .replaceAll('ispace-deploy-service:3100', new URL(upstream).host)
      .replace('/srv/sites/{re.ua.1}/{re.ua.2}', JSON.stringify(join(dir, 'sites', '{re.ua.1}', '{re.ua.2}')))
      .replace('admin off', 'admin off\n\tpersist_config off\n\tgrace_period 1s');
    const filename = join(dir, 'Caddyfile');
    await writeFile(filename, config);
    const child = spawn(binary!, ['run', '--config', filename, '--adapter', 'caddyfile'], {
      env: { ...process.env, ISPACE_CADDY_TRUSTED_PROXIES: '127.0.0.1/32', XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics += String(chunk); });
    const headers = { 'x-forwarded-for': '192.0.2.10' };
    try {
      let ready = false;
      for (let n = 0; n < 50; n++) {
        try { ready = (await fetch(origin + '/owner/page/', { headers })).status === 200; } catch {}
        if (ready || child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(ready, diagnostics).toBe(true);
      for (const suffix of ['', '?tab=sample&n=1']) {
        const redirect = await fetch(origin + '/owner/page' + suffix, { headers, redirect: 'manual' });
        expect(redirect.status).toBe(308);
        const page = await fetch(origin + '/owner/page' + suffix, { headers });
        expect(page.status).toBe(200);
        expect(new URL(page.url).pathname).toBe('/owner/page/');
        expect(new URL(page.url).searchParams.get('tab')).toBe(suffix ? 'sample' : null);
        const asset = await fetch(new URL('./app.js', page.url), { headers });
        expect(asset.status).toBe(200);
        expect(await asset.text()).toContain('window.fixtureLoaded');
        expect(asset.headers.get('cache-control')).toBe('no-store');
      }
      expect((await fetch(origin + '/owner/page?tab=sample', {
        headers: { 'x-forwarded-for': '203.0.113.10' }, redirect: 'manual',
      })).status).toBe(403);
      visibility = 'private';
      expect((await fetch(origin + '/owner/page?tab=sample', { headers, redirect: 'manual' })).status).toBe(302);
      expect((await fetch(origin + '/owner/page/app.js', { headers, redirect: 'manual' })).status).toBe(302);
    } finally {
      if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
      await app.close(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
