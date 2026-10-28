import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuAuthProvider } from '../feishu.js';
import { createAuthProvider } from '../provider.js';
const provider = new FeishuAuthProvider({ appId: 'test-app', appSecret: 'test-secret', tenantKey: 'company' });
const redirectUri = 'https://space.example/deploy/api/auth/callback';
afterEach(() => vi.unstubAllGlobals());
function responses(...values: unknown[]) {
  const fn = vi.fn();
  for (const v of values) fn.mockResolvedValueOnce(new Response(JSON.stringify(v)));
  vi.stubGlobal('fetch', fn); return fn;
}
describe('Feishu enterprise login', () => {
  it('constructs the official authorization URL without a secret', () => {
    const url = new URL(provider.authorizeUrl({ state: 'nonce', redirectUri }));
    expect(url.origin).toBe('https://accounts.feishu.cn');
    expect(url.searchParams.get('state')).toBe('nonce');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.toString()).not.toContain('test-secret');
  });
  it('exchanges server-side and accepts only configured tenant identity', async () => {
    const fetch = responses({ code: 0, access_token: 'user-token' }, { code: 0, data: {
      tenant_key: 'company', open_id: 'employee', name: '员工', enterprise_email: 'staff@company.example',
      role: 'admin', email: 'personal@example.com',
    } });
    const claims = await provider.exchange({ code: 'once', redirectUri });
    expect(claims.sub).toBe('feishu|test-app|company|employee');
    expect(claims.email).toBe('staff@company.example');
    expect(claims.role).toBe('employee');
    expect(fetch.mock.calls[0]![0]).toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token');
    expect(JSON.parse(fetch.mock.calls[0]![1].body).redirect_uri).toBe(redirectUri);
    expect(fetch.mock.calls[1]![1].headers.authorization).toBe('Bearer user-token');
  });
  it.each(['other-company', undefined])('rejects foreign/missing tenant %s', async (tenant) => {
    responses({ code: 0, access_token: 'token' }, { code: 0, data: { tenant_key: tenant, open_id: 'employee' } });
    await expect(provider.exchange({ code: 'once', redirectUri })).rejects.toThrow('本公司');
  });
  it('does not require mailbox permission to auto-register', async () => {
    responses({ code: 0, access_token: 'token' }, { code: 0, data: { tenant_key: 'company', open_id: 'employee', name: '员工' } });
    expect((await provider.exchange({ code: 'once', redirectUri })).email).toBeUndefined();
  });
  it('rejects missing identity and upstream errors without exposing tokens', async () => {
    responses({ code: 0, access_token: 'token' }, { code: 0, data: { tenant_key: 'company' } });
    await expect(provider.exchange({ code: 'once', redirectUri })).rejects.toThrow('用户标识');
    responses({ code: 999, error: 'private-token' });
    await expect(provider.exchange({ code: 'once', redirectUri })).rejects.toThrow('授权码交换失败');
  });
  it('fails closed on incomplete configuration and prioritizes Feishu', () => {
    expect(() => createAuthProvider({ FEISHU_APP_ID: 'test' })).toThrow('同时配置');
    expect(createAuthProvider({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', FEISHU_TENANT_KEY: 'company',
      ISPACE_DEV_LOGIN: '1' })?.name).toBe('feishu');
    expect(createAuthProvider({})).toBeNull();
  });
});
