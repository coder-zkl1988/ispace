import { createHash } from 'node:crypto';

/**
 * 灰度分桶（技术方案 §5.3）。
 *
 * 按设备维度实施：通道请求头附带稳定设备 ID，服务端按放量比例决定返回
 * 新旧 manifest。未被放量的设备完全无感——设计稿「更新通道」屏的
 * 「灰度期只有被放量的设备看到更新提示」就是这个意思。
 *
 * 用哈希分桶而非随机数，三个理由：
 *   1. 同一设备每次请求落到同一桶，不会时而收到新版时而收到旧版
 *      ——那会造成"更新提示忽隐忽现"，比不灰度更糟
 *   2. 不需要服务端记录哪些设备已放量，无状态
 *   3. 放量比例从 10% 提到 50% 时，原先被放量的设备仍在其中（桶号不变），
 *      不会出现"已升级的设备被踢回旧版"
 */

/** 把设备 ID 稳定映射到 [0,100) 的桶号。 */
export function bucketOf(deviceId: string, releaseId: string): number {
  // 混入 releaseId：不同版本的放量集合应互相独立，否则同一批"运气不好"的
  // 设备会永远排在最后，每次发版都最晚拿到。
  const h = createHash('sha256').update(`${deviceId}:${releaseId}`).digest();
  // 取前 4 字节做无符号整数，再取模。用整数运算避免浮点精度带来的边界抖动。
  const n = h.readUInt32BE(0);
  return n % 100;
}

/** 该设备是否在本次放量范围内。 */
export function isRolledOut(
  deviceId: string | undefined,
  releaseId: string,
  rolloutPercent: number,
): boolean {
  if (rolloutPercent >= 100) return true;
  if (rolloutPercent <= 0) return false;
  // 没有设备 ID 时保守处理：不放量。宁可让这台设备晚一点拿到新版，
  // 也不要让灰度失去意义。
  if (!deviceId) return false;
  return bucketOf(deviceId, releaseId) < rolloutPercent;
}
