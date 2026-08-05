import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RESERVED_PATHS,
  appSlugSchema,
  isReservedPath,
  schemaNameFor,
  usernameSchema,
} from '../reserved.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../..');

describe('RESERVED_PATHS 与 Caddyfile 的一致性', () => {
  /**
   * 这条断言是 D6（无 @ 前缀）能安全成立的机制保障。
   *
   * 网关的排除列表若少一项，该平台路径会被当作用户空间处理，Caddy 会去
   * /srv/sites/{那个路径}/ 找文件；若多一项，对应用户名会被静默劫持。
   * 两种情况都不会报错，只会表现为「某个路径莫名其妙 404 或返回别人的页面」。
   *
   * 因此宁可让这条测试失败，也不能靠人记得同步两处。
   */
  it('Caddyfile 的排除列表必须与 RESERVED_PATHS 完全一致', () => {
    const caddyfile = readFileSync(resolve(REPO_ROOT, 'infra/caddy/Caddyfile'), 'utf8');

    const match = caddyfile.match(/not path_regexp \^\/\(([^)]+)\)/);
    expect(
      match,
      'Caddyfile 中未找到保留路径排除规则（not path_regexp ^/(...)）',
    ).not.toBeNull();

    const inCaddy = match![1]!.split('|').map((s) => s.trim()).sort();
    const inCode = [...RESERVED_PATHS].sort();

    expect(inCaddy).toEqual(inCode);
  });
});

describe('用户名校验', () => {
  it('接受合法标识', () => {
    for (const ok of ['lixiao', 'wang-mengqi', 'zhou3', 'ab']) {
      expect(usernameSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('拒绝保留字', () => {
    for (const bad of RESERVED_PATHS) {
      const r = usernameSchema.safeParse(bad);
      expect(r.success, `保留字 ${bad} 不应通过`).toBe(false);
    }
  });

  it('保留字判断不区分大小写', () => {
    expect(isReservedPath('Console')).toBe(true);
    expect(isReservedPath('DEPLOY')).toBe(true);
  });

  it('拒绝非法字符与形态', () => {
    const bad = [
      'A',            // 大写
      '1abc',         // 数字开头：schema 名 u_1abc 在 Postgres 中不宜
      'ab_cd',        // 下划线不在 URL 规则内
      'ab--cd',       // 连续连字符，URL 中易混淆
      'ab-',          // 尾部连字符
      '-ab',          // 首部连字符
      'a',            // 太短
      'a'.repeat(32), // 太长
      'a b',          // 空格
      '张三',          // 非 ASCII
    ];
    for (const b of bad) {
      expect(usernameSchema.safeParse(b).success, `${b} 不应通过`).toBe(false);
    }
  });

  it('应用名规则与用户名一致，但不受保留字限制', () => {
    // /lixiao/console/ 是合法的——保留字只约束首段
    expect(appSlugSchema.safeParse('console').success).toBe(true);
    expect(appSlugSchema.safeParse('1abc').success).toBe(false);
  });
});

describe('schema 名派生', () => {
  it('连字符转下划线', () => {
    expect(schemaNameFor('wang-mengqi')).toBe('u_wang_mengqi');
    expect(schemaNameFor('lixiao')).toBe('u_lixiao');
  });

  it('派生结果是合法的 Postgres 标识符（无需引号）', () => {
    for (const u of ['lixiao', 'wang-mengqi', 'a-b-c-d']) {
      expect(schemaNameFor(u)).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });
});
