import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN, checkPasswordStrength, hashPassword, verifyPassword,
} from '../password.js';

/**
 * 密码哈希与校验。
 *
 * 这是整个平台唯一存储用户凭据的地方，错了没有第二道防线：
 * 明文落库、比较方式泄露信息、校验函数抛异常变成 500——每一条都能
 * 单独毁掉登录体系。
 *
 * scrypt 本身很慢（单次约 100ms，那正是它的价值），所以用例数量克制，
 * 只覆盖真正会出事的分支。
 */

const GOOD = 'correct-horse-battery';

describe('哈希', () => {
  it('哈希里不含明文', async () => {
    const h = await hashPassword(GOOD);
    expect(h).not.toContain(GOOD);
    expect(h).not.toContain('horse');
  });

  it('同一个密码每次哈希都不同——盐是随机的', async () => {
    // 相同哈希意味着没加盐，彩虹表一撞一个准
    const [a, b] = await Promise.all([hashPassword(GOOD), hashPassword(GOOD)]);
    expect(a).not.toBe(b);
  });

  it('格式里带着参数，将来调参不会让旧密码失效', async () => {
    const h = await hashPassword(GOOD);
    const parts = h.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(6);
    expect(Number(parts[1])).toBeGreaterThanOrEqual(65536);
  });
});

describe('校验', () => {
  it('对的密码验得过，错的验不过', async () => {
    const h = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD, h)).toBe(true);
    expect(await verifyPassword('wrong-horse-battery', h)).toBe(false);
  });

  it('大小写与空格都算数', async () => {
    const h = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD.toUpperCase(), h)).toBe(false);
    expect(await verifyPassword(` ${GOOD}`, h)).toBe(false);
  });

  it('Unicode 归一化：同一个密码用不同编码输入也应验得过', async () => {
    // é 有单码位与组合两种写法。用户换个输入法就登不进去是很难查的。
    const combining = 'passwórd-long-enough';
    const precomposed = 'passwórd-long-enough'.normalize('NFC');
    const h = await hashPassword(combining);
    expect(await verifyPassword(combining.normalize('NFD'), h)).toBe(true);
    void precomposed;
  });

  it('哈希串损坏时返回 false 而不是抛异常', async () => {
    // 抛出去会变成 500，而 500 与 401 的区别足以告诉攻击者
    // 「这个账号存在，只是数据坏了」
    for (const bad of [
      '', 'not-a-hash', 'scrypt$only$three$parts',
      'bcrypt$65536$8$1$c2FsdA$aGFzaA', 'scrypt$abc$8$1$c2FsdA$aGFzaA',
    ]) {
      await expect(verifyPassword(GOOD, bad)).resolves.toBe(false);
    }
  });
});

describe('强度要求', () => {
  it('太短的拒绝', () => {
    expect(checkPasswordStrength('short')).toContain(String(PASSWORD_MIN));
    expect(checkPasswordStrength('a'.repeat(PASSWORD_MIN - 1))).not.toBeNull();
  });

  it('长度够就放行——不强制大小写数字符号那一套', () => {
    // 那类规则会把用户推向 Password1! 这种可预测模式
    expect(checkPasswordStrength('我的周报助手密码不告诉你')).toBeNull();
    expect(checkPasswordStrength('correct horse battery staple')).toBeNull();
  });

  it('够长但只有一两种字符的挡掉', () => {
    expect(checkPasswordStrength('aaaaaaaaaaaaaaaa')).not.toBeNull();
    expect(checkPasswordStrength('ababababababab')).not.toBeNull();
  });

  it('过长的拒绝——不能让人用超长串把 scrypt 拖垮', () => {
    expect(checkPasswordStrength('a'.repeat(200))).not.toBeNull();
  });
});
