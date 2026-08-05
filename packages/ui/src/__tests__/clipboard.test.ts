import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../clipboard.js';

/**
 * 复制到剪贴板的降级路径。
 *
 * 这是一个真实故障的回归测试：平台以明文 HTTP 部署时（内网无证书的常见
 * 形态），剪贴板 API 只在**安全上下文**里存在。实测 navigator.clipboard
 * === undefined，
 * 于是 `navigator.clipboard.writeText(x)` 在读属性那一步就同步抛 TypeError，
 * 整个点击处理函数直接挂掉——全站 7 处复制按钮既不复制也不报错。
 *
 * 所以这里要盯住的不是"复制成功了吗"（那要真实用户手势，测不了），
 * 而是这几条：
 *   1. 没有 navigator.clipboard 时不能抛，要走回落
 *   2. 有的时候优先用标准 API
 *   3. 标准 API 被拒时仍然要回落，而不是直接算失败
 *   4. 无论如何都返回布尔值，让调用方能给出反馈
 */

/*
  用 vi.stubGlobal 而不是直接赋值：Node 22 里 globalThis.navigator 是
  只读的 getter，直接赋值会抛 "Cannot set property navigator"。
*/
const setNav = (v: unknown) => vi.stubGlobal('navigator', v);
const setDoc = (v: unknown) => vi.stubGlobal('document', v);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 够用的假 document：只实现 copyText 真正会碰的那几个方法。 */
function fakeDocument(execResult: boolean) {
  const exec = vi.fn(() => execResult);
  const el = {
    value: '', style: {} as Record<string, string>,
    setAttribute: vi.fn(), focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(),
  };
  return {
    exec,
    el,
    doc: {
      createElement: vi.fn(() => el),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      getSelection: vi.fn(() => ({ rangeCount: 0, removeAllRanges: vi.fn(), addRange: vi.fn() })),
      execCommand: exec,
    },
  };
}

describe('安全上下文缺失（线上就是这个情况）', () => {
  it('navigator.clipboard 为 undefined 时不抛，走 execCommand', async () => {
    const f = fakeDocument(true);
    setNav({});                 // 正是 HTTP 下的样子
    setDoc(f.doc);

    await expect(copyText('要复制的内容')).resolves.toBe(true);
    expect(f.exec).toHaveBeenCalledWith('copy');
    // 内容得真的放进 textarea，否则复制的是空
    expect(f.el.value).toBe('要复制的内容');
  });

  it('execCommand 返回 false 时如实返回 false，不假装成功', async () => {
    // 调用方据此提示"手动选中"。谎报成功比失败更糟：
    // 用户会去粘贴，粘出来是上一次剪贴板里的东西
    const f = fakeDocument(false);
    setNav({});
    setDoc(f.doc);
    await expect(copyText('x')).resolves.toBe(false);
  });

  it('用完把临时元素摘掉，不在页面上留垃圾', async () => {
    const f = fakeDocument(true);
    setNav({});
    setDoc(f.doc);
    await copyText('x');
    expect(f.doc.body.appendChild).toHaveBeenCalled();
    expect(f.doc.body.removeChild).toHaveBeenCalled();
  });
});

describe('有安全上下文时优先用标准 API', () => {
  it('直接走 clipboard.writeText', async () => {
    const write = vi.fn(async () => undefined);
    const f = fakeDocument(true);
    setNav({ clipboard: { writeText: write } });
    setDoc(f.doc);

    await expect(copyText('abc')).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith('abc');
    expect(f.exec).not.toHaveBeenCalled();   // 不该多此一举
  });

  it('标准 API 被拒（没权限/页面不在前台）时仍然回落', async () => {
    // 直接判失败的话，用户会在一个其实能复制的环境里被告知复制不了
    const f = fakeDocument(true);
    setNav({ clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    setDoc(f.doc);

    await expect(copyText('abc')).resolves.toBe(true);
    expect(f.exec).toHaveBeenCalledWith('copy');
  });
});

describe('拿不到 document 时也不能抛', () => {
  it('返回 false', async () => {
    setNav({});
    setDoc(undefined);
    await expect(copyText('x')).resolves.toBe(false);
  });
});
