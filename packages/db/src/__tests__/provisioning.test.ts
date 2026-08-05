import { describe, expect, it } from 'vitest';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';
import type { Sql } from 'postgres';
import {
  currentExposedSchemas,
  deprovisionUserSchema,
  provisionUserSchema,
} from '../provisioning.js';

/**
 * 开通 / 回收用户 schema 的**执行顺序**。
 *
 * 这是全仓后果最严重的一段代码。pgrst.db_schemas 一旦指向不存在的 schema，
 * PostgREST 会进入重连循环，/rest/v1/* 对**所有**用户返回 503——不只是出问题
 * 的那个用户。开通必须"先建后暴露"，回收必须"先撤暴露后删"，两边都不能反。
 *
 * 这类顺序错误在联调时通常撞不到（本地 schema 建得快、时序正好对上），
 * 所以只能靠断言执行顺序本身来防。
 */

/** 记录所有语句的假 sql。同时支持标签模板与 .unsafe()。 */
function recordingSql(opts: {
  exposed?: string | null;
  /** information_schema 校验返回的行数，默认 1（存在）。 */
  verifyCount?: number;
} = {}) {
  const log: string[] = [];

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    log.push(text);

    if (text.includes('pgrst.db_schemas=')) {
      const v = opts.exposed === undefined ? 'public,graphql_public' : opts.exposed;
      return Promise.resolve(v === null ? [] : [{ v }]);
    }
    if (text.includes('information_schema.schemata')) {
      return Promise.resolve([{ n: opts.verifyCount ?? 1 }]);
    }
    void values;
    return Promise.resolve([]);
  };

  const sql = Object.assign(tagged, {
    unsafe: (text: string) => {
      log.push(text.replace(/\s+/g, ' ').trim());
      return Promise.resolve([]);
    },
  }) as unknown as Sql<Record<string, unknown>>;

  return { sql, log };
}

/** 第一条匹配 re 的语句的下标，找不到返回 -1。 */
const at = (log: string[], re: RegExp) => log.findIndex((s) => re.test(s));

describe('provisionUserSchema：先建、再验、再暴露、最后重载', () => {
  it('四步顺序正确', async () => {
    const { sql, log } = recordingSql();
    const schema = await provisionUserSchema(sql, 'lixiao');
    expect(schema).toBe('u_lixiao');

    const create = at(log, /^CREATE SCHEMA IF NOT EXISTS u_lixiao/);
    const verify = at(log, /information_schema\.schemata/);
    const alter  = at(log, /^ALTER ROLE authenticator SET pgrst\.db_schemas/);
    const notify = at(log, /NOTIFY pgrst, 'reload config'/);

    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(verify);   // 先建才能验
    expect(verify).toBeLessThan(alter);    // 验过才敢改暴露列表
    expect(alter).toBeLessThan(notify);    // 改完才通知重载
  });

  it('校验不过就中止，绝不碰 pgrst.db_schemas', async () => {
    // 这是最关键的一条：schema 没建成还去改暴露列表，会把全站打挂。
    const { sql, log } = recordingSql({ verifyCount: 0 });
    await expect(provisionUserSchema(sql, 'lixiao')).rejects.toMatchObject({
      code: ERROR_CODES.PROVISION_VERIFY_FAILED,
    });
    expect(at(log, /ALTER ROLE authenticator/)).toBe(-1);
    expect(at(log, /NOTIFY pgrst/)).toBe(-1);
  });

  it('追加而不是覆盖——别人的 schema 不能被顶掉', async () => {
    const { sql, log } = recordingSql({ exposed: 'public,graphql_public,u_wangwu' });
    await provisionUserSchema(sql, 'lixiao');
    const alter = log.find((s) => s.startsWith('ALTER ROLE authenticator'));
    expect(alter).toContain('u_wangwu');
    expect(alter).toContain('u_lixiao');
    expect(alter).toContain('public');
  });

  it('幂等：已经在列表里就不再改 ALTER ROLE', async () => {
    const { sql, log } = recordingSql({ exposed: 'public,graphql_public,u_lixiao' });
    await provisionUserSchema(sql, 'lixiao');
    expect(at(log, /ALTER ROLE authenticator/)).toBe(-1);
    // 但重载还是要发：schema 里的表可能有变化
    expect(at(log, /NOTIFY pgrst, 'reload schema'/)).toBeGreaterThanOrEqual(0);
  });

  it('两条 NOTIFY 通道都要发', async () => {
    // 只发 reload schema 不会重读 db_schemas，新用户的 REST 依然 404
    const { sql, log } = recordingSql();
    await provisionUserSchema(sql, 'lixiao');
    expect(at(log, /NOTIFY pgrst, 'reload config'/)).toBeGreaterThanOrEqual(0);
    expect(at(log, /NOTIFY pgrst, 'reload schema'/)).toBeGreaterThanOrEqual(0);
  });
});

describe('deprovisionUserSchema：先撤暴露，再删', () => {
  it('DROP 一定发生在 ALTER ROLE 与 reload config 之后', async () => {
    // 顺序反了 PostgREST 会指向已不存在的 schema，进重连循环 → 全站 503
    const { sql, log } = recordingSql({ exposed: 'public,graphql_public,u_lixiao' });
    await deprovisionUserSchema(sql, 'lixiao', true);

    const alter  = at(log, /^ALTER ROLE authenticator/);
    const reload = at(log, /NOTIFY pgrst, 'reload config'/);
    const drop   = at(log, /^DROP SCHEMA IF EXISTS u_lixiao/);

    expect(alter).toBeGreaterThanOrEqual(0);
    expect(alter).toBeLessThan(reload);
    expect(reload).toBeLessThan(drop);
  });

  it('新的暴露列表里不再有该用户，其他人保持原样', async () => {
    const { sql, log } = recordingSql({ exposed: 'public,graphql_public,u_lixiao,u_wangwu' });
    await deprovisionUserSchema(sql, 'lixiao');
    const alter = log.find((s) => s.startsWith('ALTER ROLE authenticator'))!;
    expect(alter).not.toContain('u_lixiao');
    expect(alter).toContain('u_wangwu');
    expect(alter).toContain('graphql_public');
  });

  it('默认只冻结不删除', async () => {
    // 离职回收默认冻结：数据还在，导出后再由管理员决定要不要删
    const { sql, log } = recordingSql({ exposed: 'public,graphql_public,u_lixiao' });
    await deprovisionUserSchema(sql, 'lixiao');
    expect(at(log, /DROP SCHEMA/)).toBe(-1);
  });

  it('本来就不在列表里也不报错', async () => {
    const { sql, log } = recordingSql({ exposed: 'public,graphql_public' });
    await expect(deprovisionUserSchema(sql, 'lixiao')).resolves.toBeUndefined();
    expect(at(log, /ALTER ROLE authenticator/)).toBe(-1);
  });
});

describe('暴露列表的取值与守卫', () => {
  it('没设置过时回落到基础 schema', async () => {
    const { sql } = recordingSql({ exposed: null });
    expect(await currentExposedSchemas(sql)).toEqual(['public', 'graphql_public']);
  });

  it('去掉空白与空项', async () => {
    const { sql } = recordingSql({ exposed: 'public, graphql_public , u_a,' });
    expect(await currentExposedSchemas(sql)).toEqual(['public', 'graphql_public', 'u_a']);
  });

  it('形态不合法的 schema 名进不了 ALTER ROLE', async () => {
    // ALTER ROLE 不能参数化，值是内联进 SQL 的。上游 usernameSchema 已经校验过，
    // 这里是第二道闸——防的是将来有人绕过 contracts 直接调这个函数。
    const { sql, log } = recordingSql({ exposed: "public,u_x'; DROP DATABASE postgres; --" });
    await expect(provisionUserSchema(sql, 'lixiao')).rejects.toThrow(IspaceError);
    expect(at(log, /^ALTER ROLE authenticator/)).toBe(-1);
  });
});
