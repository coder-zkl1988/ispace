import { channelNameFor } from '@ispace/contracts';
import { switchToUserChannel, type LoadPhase } from './channel';
import { deviceId } from './bridge';

/**
 * 串门：临时切到他人通道使用其应用（设计稿第 12/13 屏）。
 *
 * 机制上只是「换一次通道」——全员同一个壳、runtimeVersion 一致，
 * 所以任何人的页面包在任何人的壳上都装得上。这正是双层壳架构带来的
 * 额外好处：不需要为分享做任何特殊设计。
 *
 * 三条约束都来自设计稿，且都必须在代码里体现：
 *   1. 「打开会临时切到她的应用，约 3 秒；退出即回到你自己的」
 *      → 退出必须能可靠回到自己的通道，因此进入前先记住自己是谁
 *   2. 「你在里面的使用数据，存在她的数据空间」
 *      → 串门期间应用连的是对方的 Supabase schema，这由页面包自身的
 *        配置决定，壳不干预；壳只保证顶部来源条不被页面盖住
 *   3. 「她随时可以收回分享」
 *      → 每次进入都要向平台校验分享是否仍有效，不能只在首次校验
 */

export interface VisitTarget {
  username: string;
  displayName: string;
}

export interface VisitState {
  /** 正在串门的对象。null 表示在自己的空间。 */
  visiting: VisitTarget | null;
  /** 自己的用户名，退出串门时切回这个通道。 */
  self: string;
}

/**
 * 进入他人空间。
 *
 * @returns 成功则返回 true（此时即将 reload，后续代码不保证执行）
 */
export async function enterVisit(
  self: string,
  target: VisitTarget,
  apiBase: string,
  token: string,
  onPhase?: (p: LoadPhase) => void,
): Promise<{ ok: boolean; reason?: string }> {
  // 每次进入都校验分享仍有效——设计稿明确「她随时可以收回分享」。
  // 只在首次校验的话，被收回后对方仍能继续进入。
  const res = await fetch(`${apiBase}/deploy/api/shares/check?owner=${encodeURIComponent(target.username)}`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);

  if (!res || !res.ok) {
    return { ok: false, reason: '这个分享已被收回，或你还没有接受它。' };
  }

  const id = await deviceId();
  const switched = await switchToUserChannel({
    username: target.username,
    deviceId: id,
    ...(onPhase ? { onPhase } : {}),
  });

  // switchToUserChannel 返回 false 表示"无需更新"——对串门来说这不是失败，
  // 说明本机已缓存过对方的包。此时仍算进入成功。
  void switched;
  void self;
  return { ok: true };
}

/** 退出串门，切回自己的通道。 */
export async function exitVisit(
  self: string,
  onPhase?: (p: LoadPhase) => void,
): Promise<void> {
  const id = await deviceId();
  await switchToUserChannel({
    username: self,
    deviceId: id,
    ...(onPhase ? { onPhase } : {}),
  });
}

/** 当前壳加载的是谁的通道。用于启动时判断是否处在串门状态。 */
export async function currentChannelOwner(): Promise<string | null> {
  const Updates = await import('expo-updates');
  const ch = Updates.channel;
  if (!ch) return null;
  const m = /^u-(.+?)(?:-preview)?$/.exec(ch);
  return m?.[1] ?? null;
}

export function isVisiting(self: string, channelOwner: string | null): boolean {
  return channelOwner !== null && channelOwner !== self;
}

export { channelNameFor };
