import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Sql } from '@ispace/db';
import { consumeLogin, startLogin } from '../services/oauth-state.js';

function fixture() {
  const rows = new Map<string, { browser: string; provider: string; context: unknown; expires: number }>();
  const fn = async (parts: TemplateStringsArray, ...v: any[]) => {
    const q = parts.join('?');
    if (q.includes('INSERT INTO')) { rows.set(v[0], { browser: v[1], provider: v[2], context: v[3], expires: Date.now() + 600_000 }); return []; }
    if (q.includes('RETURNING context')) {
      const row = rows.get(v[0]);
      if (!row || row.browser !== v[1] || row.provider !== v[2] || row.expires <= Date.now()) return [];
      rows.delete(v[0]); return [{ context: row.context }];
    }
    return [];
  };
  const sql = Object.assign(fn, { json: (v: unknown) => v }) as unknown as Sql;
  return { sql, rows };
}
describe('browser-bound OAuth state', () => {
  it('stores only hashes and consumes the exact provider/browser binding once', async () => {
    const { sql, rows } = fixture();
    const context = { redirect: '/mine', bindUserId: 'user', pairing: 'phone' };
    const attempt = await startLogin(sql, 'feishu', context);
    expect(rows.has(attempt.state)).toBe(false);
    await expect(consumeLogin(sql, 'oidc', attempt.state, attempt.browser)).rejects.toThrow('登录请求');
    await expect(consumeLogin(sql, 'feishu', attempt.state, 'a'.repeat(43))).rejects.toThrow('登录请求');
    expect(await consumeLogin(sql, 'feishu', attempt.state, attempt.browser)).toEqual(context);
    await expect(consumeLogin(sql, 'feishu', attempt.state, attempt.browser)).rejects.toThrow('登录请求');
  });
  it('rejects expired, missing and client-constructed redirect states', async () => {
    const { sql, rows } = fixture();
    const attempt = await startLogin(sql, 'feishu', { redirect: '/' });
    rows.get(createHash('sha256').update(attempt.state).digest('hex'))!.expires = 0;
    await expect(consumeLogin(sql, 'feishu', attempt.state, attempt.browser)).rejects.toThrow();
    await expect(consumeLogin(sql, 'feishu')).rejects.toThrow();
    await expect(consumeLogin(sql, 'feishu', Buffer.from('{"redirect":"/"}').toString('base64url'), attempt.browser)).rejects.toThrow();
  });
});
