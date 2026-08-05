import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 合成流水线的原生依赖白名单，必须与壳的实际依赖一致。
 *
 * 白名单存在的意义是：页面包只能用壳已经预置的原生能力。壳里没有的，
 * 引入后 runtimeVersion 就变了，那个更新永远不会被已装的壳接受
 * （技术方案 §5.7）。
 *
 * 两边各写一份，就一定会漂：给壳加原生模块的人不会想起来还有个白名单，
 * 于是新能力在页面包里被判为"未经允许的原生依赖"而构建失败——报错信息
 * 还指向一个看起来完全正确的依赖。这组用例让漂移在 CI 里先炸。
 *
 * 和 reserved.test.ts 同一个套路：读真实文件比对，不复制常量。
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../..');

/** 从 compose-bundle.mjs 里抠出白名单，而不是引入它（那是 ESM 脚本，有副作用）。 */
function readAllowlist(): Set<string> {
  const src = readFileSync(resolve(REPO_ROOT, 'tools/compose-bundle.mjs'), 'utf8');
  const m = /const NATIVE_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (!m) throw new Error('compose-bundle.mjs 里找不到 NATIVE_ALLOWLIST');
  return new Set([...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
}

function readShellDeps(): Set<string> {
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'apps/mobile-shell/package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  return new Set(Object.keys(pkg.dependencies ?? {}));
}

/** 只比对可能含原生代码的那些。@ispace/* 是纯 TS，不在此列。 */
const isNativeish = (name: string) =>
  name.startsWith('expo') || name.startsWith('react-native') || name === 'react';

describe('原生依赖白名单与壳保持一致', () => {
  const allow = readAllowlist();
  const deps = readShellDeps();

  it('壳里的每个原生依赖都在白名单里', () => {
    const missing = [...deps].filter((d) => isNativeish(d) && !allow.has(d));
    expect(missing, `给壳加了原生模块就要同步 tools/compose-bundle.mjs 的白名单：${missing.join('、')}`)
      .toEqual([]);
  });

  it('白名单里没有壳其实没装的包', () => {
    // 反向也要查：白名单里留着一个壳已经删掉的包，会让页面包引用一个
    // 运行时根本不存在的模块，且构建期一路绿灯，直到用户打开页面白屏。
    const stale = [...allow].filter((a) => isNativeish(a) && !deps.has(a));
    expect(stale, `白名单里这些壳已经没有了：${stale.join('、')}`).toEqual([]);
  });

  it('语音走录音 + 服务端转写，不依赖设备识别包', () => {
    // 录音能力必须在：语音输入靠它采集音频
    expect(deps.has('expo-av'), 'expo-av 是录音能力的来源').toBe(true);
    expect(allow.has('expo-av')).toBe(true);
    // 设备识别包已移除。留着它等于给页面包一条我们不再维护的路，
    // 而各家 ROM 的识别服务行为不一致正是当初放弃它的原因。
    expect(deps.has('expo-speech-recognition')).toBe(false);
    expect(allow.has('expo-speech-recognition')).toBe(false);
  });
});
