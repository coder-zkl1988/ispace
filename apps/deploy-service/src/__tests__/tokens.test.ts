import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from '@ispace/db';
import { findUserByAccessToken, hashToken } from '../routes/tokens.js';

/**
 * 个人访问令牌的校验路径。
 *
 * 这条路径是「同事接上 MCP 就能用」的全部依赖：MCP 客户端没有浏览器会话，
 * 只能靠请求头里的 isp_ 令牌换身份。它错了，所有非浏览器入口一起失效。
 *
 * 用假的 sql 标签函数，不连库——要验的是前缀闸门、失败语义与 fire-and-forget
 * 这几条判断逻辑，跟 Postgres 没关系。
 */

/** 造一个 sql 标签函数：记录每次调用的 SQL 文本，按顺序吐出预置结果。 */
function fakeSql(results: unknown[][], opts: { updateRejects?: boolean } = {}) {
  const calls: string[] = [];
  let i = 0;
  const sql = ((strings: TemplateStringsArray, ..._v: unknown[]) => {
    const text = strings.join('?');
    calls.push(text);
    if (/UPDATE/i.test(text)) {
      const p = opts.updateRejects
        ? Promise.reject(new Error('连接断了'))
        : Promise.resolve([]);
      // 未处理的 rejection 会让 Node 整个退出，所以这里必须是个真 promise
      return p;
    }
    return Promise.resolve(results[i++] ?? []);
  }) as unknown as Sql;
  return { sql, calls };
}

describe('hashToken', () => {
  it('是 sha256 十六进制，且同输入同输出', () => {
    const plain = 'isp_abc';
    expect(hashToken(plain)).toBe(createHash('sha256').update(plain).digest('hex'));
    expect(hashToken(plain)).toBe(hashToken(plain));
    expect(hashToken(plain)).toHaveLength(64);
  });

  it('不同令牌不会撞到一起', () => {
    expect(hashToken('isp_a')).not.toBe(hashToken('isp_b'));
  });

  it('哈希里不含明文——这正是只存哈希的意义', () => {
    const plain = 'isp_SuperSecretValue';
    expect(hashToken(plain)).not.toContain('SuperSecretValue');
  });
});

describe('findUserByAccessToken', () => {
  it('前缀不对时直接拒绝，一条 SQL 都不发', async () => {
    // 会话 JWT 也会经过这个函数。让它们去查令牌表既浪费，
    // 又把一个可被外部字符串驱动的查询暴露出来。
    const { sql, calls } = fakeSql([[{ id: 't1', user_id: 'u1' }]]);
    expect(await findUserByAccessToken(sql, 'eyJhbGciOiJIUzI1NiJ9.xxx')).toBeNull();
    expect(await findUserByAccessToken(sql, '')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('查不到就是 null，不抛异常', async () => {
    const { sql } = fakeSql([[]]);
    expect(await findUserByAccessToken(sql, 'isp_nonexistent')).toBeNull();
  });

  it('命中时返回 userId，并顺带更新 last_used_at', async () => {
    const { sql, calls } = fakeSql([[{ id: 'tok-1', user_id: 'user-9' }]]);
    expect(await findUserByAccessToken(sql, 'isp_good')).toEqual({ userId: 'user-9' });

    const [select, update] = calls;
    expect(select).toMatch(/SELECT id, user_id FROM ispace\.access_tokens/);
    // 撤销与过期必须在 SQL 里就挡掉，不能靠调用方记得判断
    expect(select).toMatch(/revoked_at IS NULL/);
    expect(select).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
    expect(update).toMatch(/UPDATE ispace\.access_tokens SET last_used_at/);
  });

  it('last_used_at 更新失败不影响鉴权结果', async () => {
    // 这是刻意的 fire-and-forget：记录"最近使用"是个便利功能，
    // 它挂了不该让同事的 MCP 调用整个失败。
    const { sql } = fakeSql([[{ id: 'tok-1', user_id: 'user-9' }]], { updateRejects: true });
    await expect(findUserByAccessToken(sql, 'isp_good')).resolves.toEqual({ userId: 'user-9' });
    // 给被吞掉的 rejection 一个 tick，确认它没有冒成未处理拒绝
    const onUnhandled = vi.fn();
    process.once('unhandledRejection', onUnhandled);
    await new Promise((r) => setImmediate(r));
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it('查询用的是哈希而不是明文', async () => {
    const { sql, calls } = fakeSql([[]]);
    await findUserByAccessToken(sql, 'isp_plaintext');
    expect(calls[0]).toMatch(/token_hash = /);
    expect(calls.join('')).not.toContain('isp_plaintext');
  });
});
