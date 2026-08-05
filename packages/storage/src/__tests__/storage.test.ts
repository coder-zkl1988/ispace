import { mkdtempSync, readFileSync, readlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTRACT_LIMITS,
  dirSize,
  injectShellScript,
  makeStamp,
  resolveArtifactRoot,
  switchSymlink,
} from '../index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ispace-storage-'));

describe('版本目录名', () => {
  it('含时间戳与版本号', () => {
    expect(makeStamp(new Date('2026-07-30T14:22:05.123Z'), 12)).toBe('20260730142205-v12');
  });

  it('字符串排序即时间排序——listReleaseStamps 依赖这一点', () => {
    const earlier = makeStamp(new Date('2026-07-30T14:22:04.000Z'), 1);
    const later = makeStamp(new Date('2026-07-30T14:22:05.000Z'), 2);
    expect(earlier < later).toBe(true);
  });

  it('同一秒内的两次发布必须得到不同目录名', () => {
    // 这条回归的是一个真实的数据丢失 bug：秒级时间戳在快速连续发布时撞名，
    // 而 EXDEV 路径下的 cp 会静默覆盖前一版本，使其永久丢失且回滚拿到错内容。
    const t = new Date('2026-07-30T14:22:05.000Z');
    expect(makeStamp(t, 1)).not.toBe(makeStamp(t, 2));
  });
});

describe('原子软链切换', () => {
  it('切换后指向新目标', async () => {
    const root = tmp();
    const v1 = join(root, 'v1');
    const v2 = join(root, 'v2');
    mkdirSync(v1); mkdirSync(v2);
    const link = join(root, 'current');

    await switchSymlink(link, v1);
    expect(readlinkSync(link)).toBe(v1);

    // 关键：链已存在时再次切换不能失败。「删旧链+建新链」的实现在这里会
    // 留下一个 404 窗口；rename 覆盖则是原子的。
    await switchSymlink(link, v2);
    expect(readlinkSync(link)).toBe(v2);
  });

  it('可回滚回旧版本', async () => {
    const root = tmp();
    const v1 = join(root, 'v1'); const v2 = join(root, 'v2');
    mkdirSync(v1); mkdirSync(v2);
    const link = join(root, 'current');
    await switchSymlink(link, v1);
    await switchSymlink(link, v2);
    await switchSymlink(link, v1);
    expect(readlinkSync(link)).toBe(v1);
  });
});

describe('产物根目录解析', () => {
  it('根下有 index.html 时直接用', async () => {
    const root = tmp();
    writeFileSync(join(root, 'index.html'), '<html></html>');
    expect(await resolveArtifactRoot(root)).toBe(root);
  });

  it('顶层只有一个目录且其中有 index.html 时下钻——避免用户因打包层级失败', async () => {
    const root = tmp();
    const inner = join(root, 'dist');
    mkdirSync(inner);
    writeFileSync(join(inner, 'index.html'), '<html></html>');
    expect(await resolveArtifactRoot(root)).toBe(inner);
  });

  it('找不到 index.html 时报明确的错', async () => {
    const root = tmp();
    writeFileSync(join(root, 'readme.txt'), 'x');
    await expect(resolveArtifactRoot(root)).rejects.toThrow(/index\.html/);
  });
});

describe('shell.js 注入', () => {
  it('插入到 </head> 前', async () => {
    const root = tmp();
    const f = join(root, 'index.html');
    writeFileSync(f, '<html><head><title>x</title></head><body>hi</body></html>');
    expect(await injectShellScript(f)).toBe(true);
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('/platform/shell.js');
    expect(out.indexOf('/platform/shell.js')).toBeLessThan(out.indexOf('</head>'));
  });

  it('没有 head 时退到 body 开头', async () => {
    const root = tmp();
    const f = join(root, 'index.html');
    writeFileSync(f, '<html><body>hi</body></html>');
    await injectShellScript(f);
    expect(readFileSync(f, 'utf8')).toContain('/platform/shell.js');
  });

  it('幂等——回滚后再发布不会重复注入', async () => {
    const root = tmp();
    const f = join(root, 'index.html');
    writeFileSync(f, '<html><head></head><body></body></html>');
    expect(await injectShellScript(f)).toBe(true);
    expect(await injectShellScript(f)).toBe(false);
    const out = readFileSync(f, 'utf8');
    expect(out.split('/platform/shell.js').length - 1).toBe(1);
  });
});

describe('目录大小统计', () => {
  it('递归累加', () => {
    const root = tmp();
    writeFileSync(join(root, 'a.txt'), 'x'.repeat(100));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'b.txt'), 'y'.repeat(50));
    expect(dirSize(root)).toBe(150);
  });

  it('目录不存在返回 0 而非抛错', () => {
    expect(dirSize('/nonexistent/path/xyz')).toBe(0);
  });
});

describe('解压限额默认值', () => {
  it('单包上限低于用户空间配额——单个包不应接近整个配额', () => {
    expect(DEFAULT_EXTRACT_LIMITS.maxTotalBytes).toBeLessThan(500 * 1024 * 1024);
    expect(DEFAULT_EXTRACT_LIMITS.maxEntries).toBeGreaterThan(1000);
  });
});
