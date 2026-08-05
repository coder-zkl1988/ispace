import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * 回归：表单字段的布尔解析。
 *
 * multipart/form-data 的字段全是字符串。用 z.coerce.boolean() 解析会走
 * Boolean(值)，而 Boolean('false') === true——任何非空字符串都是真。
 *
 * 实测后果：移动端发布的 preview 标志恒为真，所有发布都进了预览通道、
 * 主通道指针从不移动，客户端只看到 204「无更新」，完全查不到原因。
 */
const formBool = z
  .union([z.boolean(), z.string()])
  .default(false)
  .transform((v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(v.trim())));

describe('表单布尔解析', () => {
  it('z.coerce.boolean 对 "false" 会得到 true——这就是那个坑', () => {
    expect(z.coerce.boolean().parse('false')).toBe(true);
  });

  it('正确的解析把 "false" 判为 false', () => {
    for (const v of ['false', 'False', 'FALSE', '0', 'no', 'off', '', '  ']) {
      expect(formBool.parse(v), v).toBe(false);
    }
  });

  it('真值形式都识别', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
      expect(formBool.parse(v), v).toBe(true);
    }
  });

  it('原生布尔照常通过', () => {
    expect(formBool.parse(true)).toBe(true);
    expect(formBool.parse(false)).toBe(false);
  });

  it('缺省为 false', () => {
    expect(formBool.parse(undefined)).toBe(false);
  });
});
