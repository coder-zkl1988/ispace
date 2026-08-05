import { describe, expect, it } from 'vitest';
import { qrPath } from '../qr.js';

/**
 * 分享弹窗里的二维码。
 *
 * 值得单独测的原因：二维码错了的表现是"有些手机扫不出来"——
 * 开发时自己扫一次成功就会以为没问题，而实际可能只是纠错等级救回来了。
 * 这里盯住的是几条结构性的不变量，不是像素级比对。
 */

const URL = 'http://ispace.example.com/lixiao/zhoubao/';

describe('编码', () => {
  it('模块数是合法的版本尺寸', () => {
    const p = qrPath(URL);
    // 版本 v 的边长是 4v+17，即 21/25/29/33…
    expect(p).not.toBeNull();
    expect((p!.modules - 17) % 4).toBe(0);
    expect(p!.modules).toBeGreaterThanOrEqual(21);
  });

  it('内容长了会自动升版本，而不是塞进同一个尺寸', () => {
    const short = qrPath('http://a.cn/b')!;
    const long = qrPath(`${URL}?${'x'.repeat(300)}`)!;
    expect(long.modules).toBeGreaterThan(short.modules);
  });

  it('同一段文本每次编出来一样——否则二维码会在每次重渲染时跳', () => {
    expect(qrPath(URL)!.d).toBe(qrPath(URL)!.d);
  });

  it('不同文本编出来不一样', () => {
    expect(qrPath(URL)!.d).not.toBe(qrPath(`${URL}x`)!.d);
  });

  it('三个定位图案该有的黑块都在', () => {
    // 定位图案在三个角，每个 7×7。只验四角这一点就能挡住
    // "整张图偏了一格"和"行列写反了"这两类错——它们都会破坏这个特征。
    const p = qrPath(URL)!;
    const n = p.modules;
    const dark = new Set(p.d.match(/M(\d+) (\d+)h/g)?.map((m) => m.slice(1, -1)) ?? []);
    const at = (c: number, r: number) => dark.has(`${c} ${r}`);

    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]] as [number, number][]) {
      expect(at(ox, oy)).toBe(true);            // 外框左上角
      expect(at(ox + 6, oy + 6)).toBe(true);    // 外框右下角
      expect(at(ox + 1, oy + 1)).toBe(false);   // 内圈留白
      expect(at(ox + 3, oy + 3)).toBe(true);    // 中心 3×3 实心
    }
    // 右下角没有定位图案——有的话说明画成了四个角
    expect(at(n - 1, n - 1) && at(n - 7, n - 7) && !at(n - 6, n - 6)).toBe(false);
  });
});

describe('编不出来时返回 null 而不是抛异常', () => {
  it('空串', () => {
    expect(qrPath('')).toBeNull();
  });

  it('超过最大容量的内容', () => {
    // v40 + M 级纠错在字节模式下约 2331 字节，给足余量
    expect(qrPath('x'.repeat(5000))).toBeNull();
  });
});
