import { API_BASE } from '../config';

/**
 * 壳自身（APK）的更新检查。
 *
 * 与页面包更新是两件事，别混：
 *   页面包 —— expo-updates，几 MB，静默下载、点一下重载，用户无感
 *   壳     —— 整个 APK，近百 MB，必须用户确认安装，系统弹装机界面
 *
 * 此前只有一处被动提示：页面包的 runtimeVersion 与壳对不上时，
 * 界面让人「到内部分发页更新壳 App」。可那个条件很窄——壳的界面改了
 * 一大轮、runtimeVersion 却没变时，已装的人收不到任何信号，只能靠
 * 口头通知去重新扫码。
 *
 * ┌─ 对老壳必须安全降级 ─────────────────────────────────────────────┐
 * │ expo-application 是原生模块，只存在于装了它的那一版之后的 APK 里。│
 * │ 而本文件属于 JS 壳运行时，会随页面包 OTA 到**所有**设备，包括没有│
 * │ 这个模块的老 APK。顶层 import 会让老壳直接崩——正是"白屏闪退"那  │
 * │ 一类。所以用 require 包 try/catch：拿不到就当"查不了"，静默跳过。│
 * └──────────────────────────────────────────────────────────────────┘
 */

export interface ShellRelease {
  version: string;
  versionCode: number;
  /** 本机当前的构建号。文案要拿它跟新版对比——否则没法说清"新在哪"。 */
  installed: number;
  sizeBytes: number;
  url: string;
}

/** 本机安装的构建号。取不到（老壳没有这个模块）返回 null。 */
function installedBuild(): number | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const app = require('expo-application') as { nativeBuildVersion?: string | null };
    const raw = app?.nativeBuildVersion;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 有没有更新的壳。没有、查不了、网络不通一律返回 null——
 * 这是个锦上添花的提示，任何失败都不该让用户看见报错。
 */
export async function checkShellUpdate(): Promise<ShellRelease | null> {
  const mine = installedBuild();
  if (mine === null) return null;
  try {
    const res = await fetch(`${API_BASE}/dist/version.json`, {
      // 这个文件每次发版都会变，缓存住就等于永远查不到新版
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) return null;
    const r = (await res.json()) as Partial<ShellRelease>;
    if (typeof r.versionCode !== 'number' || r.versionCode <= mine) return null;
    return {
      version: r.version ?? '',
      versionCode: r.versionCode,
      installed: mine,
      sizeBytes: r.sizeBytes ?? 0,
      url: `${API_BASE}${r.url ?? '/dist/ispace.apk'}`,
    };
  } catch {
    return null;
  }
}
