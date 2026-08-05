import { describe, expect, it } from 'vitest';
import { bucketOf, isRolledOut } from '../rollout.js';

describe('灰度分桶', () => {
  it('同一设备对同一版本永远落同一桶', () => {
    // 这条最重要：若分桶不稳定，同一台设备会时而收到更新提示时而收不到，
    // 表现为「更新提示忽隐忽现」，比不做灰度还糟。
    const a = bucketOf('device-abc', 'rel-1');
    for (let i = 0; i < 50; i++) {
      expect(bucketOf('device-abc', 'rel-1')).toBe(a);
    }
  });

  it('不同版本的放量集合互相独立', () => {
    // 若不混入 releaseId，同一批「运气不好」的设备会永远排在最后，
    // 每次发版都最晚拿到。
    const devices = Array.from({ length: 200 }, (_, i) => `d${i}`);
    const b1 = devices.map((d) => bucketOf(d, 'rel-1'));
    const b2 = devices.map((d) => bucketOf(d, 'rel-2'));
    const same = b1.filter((v, i) => v === b2[i]).length;
    // 完全独立时约有 1% 巧合相同；这里放宽到 10% 以内
    expect(same).toBeLessThan(devices.length * 0.1);
  });

  it('分桶大致均匀', () => {
    const devices = Array.from({ length: 2000 }, (_, i) => `dev-${i}`);
    const inTen = devices.filter((d) => isRolledOut(d, 'rel-x', 10)).length;
    // 10% 放量，2000 台里应在 150–250 之间
    expect(inTen).toBeGreaterThan(150);
    expect(inTen).toBeLessThan(250);
  });

  it('提高放量比例时，已放量的设备仍在其中', () => {
    // 否则会出现「已升级的设备被踢回旧版」——用户会看到应用内容倒退
    const devices = Array.from({ length: 500 }, (_, i) => `d${i}`);
    const at10 = devices.filter((d) => isRolledOut(d, 'rel-1', 10));
    const at50 = new Set(devices.filter((d) => isRolledOut(d, 'rel-1', 50)));
    for (const d of at10) {
      expect(at50.has(d), `${d} 在 10% 时已放量，50% 时不该被排除`).toBe(true);
    }
  });

  it('100% 放量对所有设备生效，含无设备 ID 的', () => {
    expect(isRolledOut('any', 'r', 100)).toBe(true);
    expect(isRolledOut(undefined, 'r', 100)).toBe(true);
  });

  it('0% 放量对任何设备都不生效', () => {
    expect(isRolledOut('any', 'r', 0)).toBe(false);
  });

  it('没有设备 ID 时保守处理为不放量', () => {
    // 宁可让这台设备晚点拿到新版，也不要让灰度失去意义
    expect(isRolledOut(undefined, 'r', 50)).toBe(false);
  });
});
