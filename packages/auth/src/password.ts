import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * 密码哈希。
 *
 * 用 scrypt 而不是 bcrypt/argon2：它在 Node 标准库里，不引第三方原生依赖。
 * 密码这块的依赖越少越好——一个需要编译的原生模块，在换 Node 版本、换 CPU
 * 架构、跑 CI 时都可能装不上，而它坏掉的后果是全平台登不进去。
 *
 * ┌─ 参数取值 ─────────────────────────────────────────────────────────┐
 * │ N=2^16 (65536), r=8, p=1 —— 约 64 MB 内存、单次 ~100ms。            │
 * │ OWASP 对 scrypt 的最低建议是 N=2^17/r=8/p=1，但那要 128 MB；        │
 * │ 本平台与 Supabase 挤在同一台 32 GB 的机器上，登录高峰若干个并发     │
 * │ 就会把内存吃掉。降一档到 64 MB，配合下面的登录限流，是这台机器上    │
 * │ 的合理取舍。换更大的机器后可以调回去——格式里带了参数，旧哈希不受   │
 * │ 影响。                                                              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 存储格式：`scrypt$N$r$p$salt$hash`，salt 与 hash 都是 base64url。
 * 参数写进字符串，将来调参时旧密码仍能验通，用户无感。
 */
const N = 65536;
const R = 8;
const P = 1;
const KEYLEN = 32;
/** scrypt 的内存上限要显式给：默认 32 MB，装不下 N=2^16。 */
const MAXMEM = 128 * 1024 * 1024;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(plain.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/**
 * 校验密码。
 *
 * 任何解析失败都返回 false，绝不抛——这个函数在登录路径上，抛异常会变成
 * 500，而 500 与 401 的区别足以告诉攻击者"这个账号存在但数据坏了"。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64!, 'base64url');
    const expected = Buffer.from(hashB64!, 'base64url');
    const actual = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
    });
    // 定长比较。用 === 比较会因为提前返回而泄露前缀匹配长度。
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * 密码强度要求。
 *
 * 只管长度，不强制"大小写+数字+符号"那一套：那类规则被反复证明会把用户
 * 推向 `Password1!` 这种可预测的模式，而长度才是真正拉开破解成本的维度。
 * 12 位是 NIST SP 800-63B 之后的普遍共识下限。
 */
export const PASSWORD_MIN = 12;

/**
 * 绝对下限。平台设置可以把要求调低到这个数，但不能再低。
 *
 * 与迁移 0006 的 CHECK (password_min_length BETWEEN 8 AND 64) 对齐——
 * 两处不一致会让管理员在界面上存下一个服务端根本不接受的值。
 */
export const PASSWORD_FLOOR = 8;
export const PASSWORD_MAX = 128;

export function checkPasswordStrength(plain: string, minLength = PASSWORD_MIN): string | null {
  const s = plain.normalize('NFKC');
  // 下限由平台设置给出（管理员可在控制台调），PASSWORD_MIN 只是默认值
  if (s.length < minLength) return `密码至少 ${minLength} 位。长度比大小写数字混搭更管用。`;
  if (s.length > PASSWORD_MAX) return `密码最长 ${PASSWORD_MAX} 位`;
  // 整串同一个字符（aaaaaaaaaaaa）能过长度检查，但毫无强度
  if (new Set(s).size < 4) return '密码太单调了，换几个不同的字符';
  return null;
}
