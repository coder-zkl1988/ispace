import * as Updates from 'expo-updates';
import { channelNameFor, previewChannelNameFor } from '@ispace/contracts';
import { API_BASE } from '../config';

/**
 * 回报这台设备的加载结果。
 *
 * 更新服务只知道"这台设备来问过更新"，不知道下发的包最后有没有跑起来：
 * 解压失败、runtimeVersion 对不上、包本身白屏，在它看来都是正常下发。
 * 控制台「更新通道」屏的到端设备与加载失败设备，只能由壳自己说。
 *
 * 不 await、不抛错：这是一条统计上报，失败了也绝不能影响加载本身。
 */
function reportDevice(input: {
  channelName: string;
  deviceId?: string | undefined;
  bundleVersion?: number | undefined;
  error?: string | undefined;
}): void {
  if (!input.deviceId) return;
  void fetch(`${API_BASE}/deploy/api/mobile/devices/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).catch(() => undefined);
}

/** 当前正在跑的页面包版本，取自 manifest 里平台自己塞的 extra。 */
function currentBundleVersion(): number | undefined {
  const m = Updates.manifest as { extra?: { ispace?: { bundleVersion?: number } } } | null;
  return m?.extra?.ispace?.bundleVersion;
}

/**
 * 通道切换（技术方案 §5.2）。
 *
 * 用户完成 SSO 登录后，壳把更新请求头中的通道名改写为该用户的专属通道，
 * 随后 checkForUpdateAsync → fetchUpdateAsync → reloadAsync，完成
 * "下载该用户的 bundle 并热重载"。
 *
 * ┌─ 一条必须写入规范的禁令（技术方案 §5.2）────────────────────────────┐
 * │ expo-updates 另有近亲 API setUpdateURLAndRequestHeadersOverride()，  │
 * │ 允许连更新 URL 一起改写，但要求构建时开启 disableAntiBrickingMeasures│
 * │ ——该标志禁用内嵌更新的回滚保护，一旦加载的更新崩溃将无法自动恢复，   │
 * │ 用户只能卸载重装。Expo 官方明确建议仅用于预览构建。                  │
 * │                                                                      │
 * │ 本平台**禁止在生产壳中使用改写 URL 的 API**。更新服务器地址一律      │
 * │ 构建期固化在 app.json 的 updates.url 里，不给"变砖"留任何入口。      │
 * │                                                                      │
 * │ 本文件只使用 setUpdateRequestHeadersOverride —— 仅改请求头，         │
 * │ 不需要任何构建标志，官方允许在生产构建中使用。                        │
 * └──────────────────────────────────────────────────────────────────────┘
 */

export type LoadPhase =
  | { kind: 'idle' }
  | { kind: 'switching' }
  | { kind: 'checking' }
  | { kind: 'downloading' }
  | { kind: 'reloading' }
  | { kind: 'up-to-date' }
  | { kind: 'incompatible'; requiredRuntime: string; currentRuntime: string }
  | { kind: 'failed'; message: string };

export interface SwitchOptions {
  username: string;
  /** 开发者预览：切到 u-{user}-preview 通道（技术方案 §6.5）。 */
  preview?: boolean;
  /** 「回到上一个版本」。经请求头实现，不触碰 URL 改写红线。 */
  preferPrevious?: boolean;
  deviceId?: string;
  onPhase?: (p: LoadPhase) => void;
}

/**
 * 切到某用户的通道并加载其页面包。
 *
 * 返回 true 表示已触发 reload（调用后当前 JS 上下文即将被替换，
 * 后续代码不保证执行）；false 表示无需更新或失败。
 */
export async function switchToUserChannel(opts: SwitchOptions): Promise<boolean> {
  const phase = opts.onPhase ?? (() => {});
  const channel = opts.preview
    ? previewChannelNameFor(opts.username)
    : channelNameFor(opts.username);

  try {
    phase({ kind: 'switching' });

    // 只改请求头。配置立即生效，不需要重启壳。
    const headers: Record<string, string> = { 'expo-channel-name': channel };
    if (opts.deviceId) headers['expo-device-id'] = opts.deviceId;
    if (opts.preferPrevious) headers['x-prefer'] = 'previous';

    await Updates.setUpdateRequestHeadersOverride(headers);

    phase({ kind: 'checking' });
    const check = await Updates.checkForUpdateAsync();

    if (!check.isAvailable) {
      phase({ kind: 'up-to-date' });
      return false;
    }

    phase({ kind: 'downloading' });
    const fetched = await Updates.fetchUpdateAsync();
    if (!fetched.isNew) {
      phase({ kind: 'up-to-date' });
      return false;
    }

    phase({ kind: 'reloading' });
    /*
      在 reload 之前上报，不是之后：reloadAsync 会换掉整个 JS 上下文，
      之后的代码不保证执行。这里报的是"包已下载并即将启用"——
      真正跑挂了的情况由下面的 catch 覆盖。
    */
    reportDevice({
      channelName: channel,
      deviceId: opts.deviceId,
      bundleVersion: currentBundleVersion(),
    });
    await Updates.reloadAsync();
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reportDevice({ channelName: channel, deviceId: opts.deviceId, error: msg.slice(0, 300) });

    // runtimeVersion 不匹配时服务端返回 204（不下发），客户端通常表现为
    // isAvailable=false 而非报错。此处的分支覆盖 SDK 内部另有校验的情况，
    // 对应设计稿第 11 屏「这个版本装不上」。
    if (/runtime\s*version/i.test(msg)) {
      phase({
        kind: 'incompatible',
        requiredRuntime: '未知',
        currentRuntime: Updates.runtimeVersion ?? '未知',
      });
      return false;
    }

    phase({ kind: 'failed', message: msg });
    return false;
  }
}

/**
 * 后台静默检查（设计稿第 09 屏）。
 * 只检查不下载——下载时机由用户在壳设置里控制（自动接收 / 仅 Wi-Fi）。
 */
export async function checkQuietly(): Promise<{ available: boolean }> {
  try {
    const r = await Updates.checkForUpdateAsync();
    return { available: r.isAvailable };
  } catch {
    // 网络不通时静默失败：更新检查失败不该打断用户正在做的事
    return { available: false };
  }
}

/** 下载并重载。设计稿更新卡片「立即重载」的落点。 */
export async function applyUpdate(onPhase?: (p: LoadPhase) => void): Promise<void> {
  const phase = onPhase ?? (() => {});
  phase({ kind: 'downloading' });
  await Updates.fetchUpdateAsync();
  phase({ kind: 'reloading' });
  await Updates.reloadAsync();
}

/**
 * 回到上一个版本（设计稿壳设置里的「回到上一个版本」）。
 * 同样只改请求头，服务端按 x-prefer: previous 返回上一指针对应的 manifest。
 */
export async function rollbackToPrevious(username: string, deviceId?: string): Promise<boolean> {
  return switchToUserChannel({ username, preferPrevious: true, ...(deviceId ? { deviceId } : {}) });
}

/** 壳与页面包的版本信息，供设置页「关于」展示。 */
export function versionInfo() {
  return {
    runtimeVersion: Updates.runtimeVersion ?? '未知',
    updateId: Updates.updateId ?? null,
    channel: Updates.channel ?? null,
    isEmbedded: Updates.isEmbeddedLaunch,
    createdAt: Updates.createdAt ?? null,
  };
}
