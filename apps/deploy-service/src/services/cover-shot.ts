import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';

/**
 * 没声明封面时，给页面自动截一张当封面（方案 B，A 的兜底）。
 *
 * ┌─ 为什么用 chromium 的 --screenshot 命令行，而不是 puppeteer ──────────┐
 * │ 只要一张首屏截图，不需要点选、滚动、等 network idle 这些编排能力，    │
 * │ 那 puppeteer 那套 CDP 协议库与版本耦合就是纯负担。chromium 自带的     │
 * │ --headless --screenshot 直接把窗口截成 PNG，零 npm 依赖，镜像里        │
 * │ apk add chromium 就够。                                               │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 为什么截 file:// 而不是访问线上地址 ────────────────────────────────┐
 * │ 页面默认私有，走网关要带会话；而产物就在本容器挂着的 /srv/releases    │
 * │ 里，直接截 file:// 既不碰鉴权也不走网络。代价是根绝对路径的资源       │
 * │ （/platform/shell.js 之类）加载不到——但那只是平台 chrome，封面截的是  │
 * │ 页面首屏，相对路径的图和内联样式都在，够用。声明式封面才是精修那条路。│
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 全程 best-effort：截图是锦上添花，任何失败都只返回 false，绝不冒泡到发布。
 */

/** chromium 可执行文件。镜像里装在这个位置；本机 dev 没有就整个跳过。 */
const CHROMIUM = process.env.ISPACE_CHROMIUM_PATH ?? '/usr/bin/chromium-browser';

/** 16:9，与卡片 banner 同比例。给的是 CSS 像素，scale=1 出图即 1200×675。 */
const SHOT_W = 1200;
const SHOT_H = 675;

/** 同时最多两个 chromium。发版不频繁，这个上限只防"一串发布挤爆内存"。 */
const MAX_CONCURRENT = 2;
let running = 0;

/** 这台机器能不能自动截图。二进制不在（本机 dev）或被显式关掉就是不能。 */
export function coverShotAvailable(): boolean {
  if (process.env.ISPACE_COVER_AUTOSHOT === '0') return false;
  return existsSync(CHROMIUM);
}

/**
 * 截 indexHtmlPath 的首屏到 outPngPath。成功返回 true。
 *
 * outPngPath 会被 chmod 0644——Caddy 以别的 uid 提供静态文件，
 * 不放开权限它读不到，表现为封面 403/404。
 */
export async function screenshotCover(
  indexHtmlPath: string,
  outPngPath: string,
): Promise<boolean> {
  if (!coverShotAvailable()) return false;
  if (running >= MAX_CONCURRENT) return false;
  running += 1;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        CHROMIUM,
        [
          '--headless',
          '--no-sandbox', // 容器内非 root、无 user namespace，sandbox 起不来
          '--disable-gpu',
          '--disable-dev-shm-usage', // 容器 /dev/shm 很小，不加会因共享内存不足崩
          '--hide-scrollbars',
          '--force-device-scale-factor=1',
          `--window-size=${SHOT_W},${SHOT_H}`,
          // 给 JS/字体/动画一点落定时间再截，又不至于让它无限等
          '--virtual-time-budget=2500',
          `--screenshot=${outPngPath}`,
          `file://${indexHtmlPath}`,
        ],
        // 硬超时兜底：某些页面会让 chromium 挂住，30s 后连进程一起杀
        { timeout: 30_000, killSignal: 'SIGKILL' },
        (err) => (err ? reject(err) : resolve()),
      );
      child.on('error', reject);
    });
    if (!existsSync(outPngPath)) return false; // chromium 偶尔静默不出文件
    await chmod(outPngPath, 0o644);
    return true;
  } catch {
    return false;
  } finally {
    running -= 1;
  }
}
