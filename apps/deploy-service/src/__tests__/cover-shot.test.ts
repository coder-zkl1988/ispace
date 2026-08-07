import { describe, expect, it } from 'vitest';
import { coverShotAvailable, screenshotCover } from '../services/cover-shot.js';

/**
 * B 的核心安全属性：截图是锦上添花，任何环境下都**绝不能**冒泡到发布。
 * 本机 CI 没有 chromium，正好覆盖"二进制缺失"这条最常见的路径。
 */
describe('cover-shot 安全降级', () => {
  it('二进制不存在时 coverShotAvailable 为 false', () => {
    // CI/本机镜像里没有 /usr/bin/chromium-browser
    const orig = process.env.ISPACE_CHROMIUM_PATH;
    process.env.ISPACE_CHROMIUM_PATH = '/definitely/not/here/chromium';
    try {
      expect(coverShotAvailable()).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.ISPACE_CHROMIUM_PATH;
      else process.env.ISPACE_CHROMIUM_PATH = orig;
    }
  });

  it('显式关掉时也为 false', () => {
    const orig = process.env.ISPACE_COVER_AUTOSHOT;
    process.env.ISPACE_COVER_AUTOSHOT = '0';
    try {
      expect(coverShotAvailable()).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.ISPACE_COVER_AUTOSHOT;
      else process.env.ISPACE_COVER_AUTOSHOT = orig;
    }
  });

  it('不可用时 screenshotCover 返回 false 而不是抛异常', async () => {
    const orig = process.env.ISPACE_CHROMIUM_PATH;
    process.env.ISPACE_CHROMIUM_PATH = '/definitely/not/here/chromium';
    try {
      await expect(screenshotCover('/tmp/whatever/index.html', '/tmp/out.png'))
        .resolves.toBe(false);
    } finally {
      if (orig === undefined) delete process.env.ISPACE_CHROMIUM_PATH;
      else process.env.ISPACE_CHROMIUM_PATH = orig;
    }
  });
});
