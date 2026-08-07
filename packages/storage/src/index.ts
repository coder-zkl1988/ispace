import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';

/**
 * 静态产物的落盘、原子切换与回滚（技术方案 §4.2）。
 *
 * 目录约定（规格 §3.2 —— 比 v1.2 多一层 app，因为一位用户有多个应用）：
 *   /srv/sites/{user}/{app}      → 指向某个 release 的软链
 *   /srv/releases/{user}/{app}/{ts}/  历史版本实体
 *
 * 发布即"解压到 releases + 原子切换软链"，回滚即切回旧目录，秒级完成。
 */

export interface StorageConfig {
  sitesRoot: string;
  releasesRoot: string;
}

export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  return {
    sitesRoot: env.ISPACE_SITES_ROOT ?? '/srv/sites',
    releasesRoot: env.ISPACE_RELEASES_ROOT ?? '/srv/releases',
  };
}

export function releaseDir(cfg: StorageConfig, user: string, app: string, stamp: string): string {
  return join(cfg.releasesRoot, user, app, stamp);
}

export function siteLink(cfg: StorageConfig, user: string, app: string): string {
  return join(cfg.sitesRoot, user, app);
}

/**
 * 版本目录名：`{yyyymmddhhmmss}-v{version}`。
 *
 * ⚠️ 必须带版本号。只用秒级时间戳曾造成过数据丢失：两次快速发布（CI 重复触发、
 * 用户连点、Agent 重试）落在同一秒，得到相同目录名；而容器内 /tmp 与 /srv
 * 常是不同挂载点，moveDir 走 EXDEV 分支用 cp -r，于是**静默覆盖**前一个版本
 * ——该版本永久丢失，回滚到它会拿到后一个版本的内容，且毫无报错。
 *
 * 版本号在 (app_id, version) 上有唯一约束，因此加上它即可保证目录名唯一。
 * 前缀仍是可排序时间戳，listReleaseStamps 的字典序排序依旧等于时间序。
 */
export function makeStamp(now: Date, version: number): string {
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${ts}-v${version}`;
}

/**
 * 解压 zip 到目标目录。
 *
 * 三项防护，都针对恶意或畸形 zip：
 *   - 路径穿越（entry 名含 ../ 或绝对路径）→ 直接拒绝整个包
 *   - 解压后总大小超限 → 拒绝（zip bomb）
 *   - 条目数超限 → 拒绝
 *
 * 不用 unzip 命令：起子进程后要自己解析其错误输出，且路径穿越防护要依赖
 * 具体实现的行为，不如在这里显式控制。
 */
export interface ExtractLimits {
  maxTotalBytes: number;
  maxEntries: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  // 与单用户 500 MB 配额同量级；单个包不应接近整个空间配额
  maxTotalBytes: 200 * 1024 * 1024,
  maxEntries: 20_000,
};

export async function extractZip(
  zipPath: string,
  destDir: string,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<{ files: string[]; totalBytes: number }> {
  mkdirSync(destDir, { recursive: true });
  const destReal = resolve(destDir);

  return new Promise((resolveP, rejectP) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        rejectP(new IspaceError(ERROR_CODES.INVALID_ARTIFACT, '产物不是合法的 zip 文件'));
        return;
      }

      const files: string[] = [];
      let totalBytes = 0;
      let entries = 0;

      const fail = (e: IspaceError) => {
        zip.close();
        rejectP(e);
      };

      zip.on('entry', (entry: yauzl.Entry) => {
        entries++;
        if (entries > limits.maxEntries) {
          fail(new IspaceError(ERROR_CODES.INVALID_ARTIFACT,
            `产物条目数超过上限 ${limits.maxEntries}`));
          return;
        }

        // ── 路径穿越防护 ──────────────────────────────────────────
        // 归一化后必须仍位于目标目录内。这一条挡住 ../../etc/passwd
        // 以及 Windows 风格的 ..\ 与绝对路径。
        const normalized = normalize(entry.fileName).replace(/^(\.\.(\/|\\|$))+/, '');
        const target = resolve(destReal, normalized);
        if (target !== destReal && !target.startsWith(destReal + sep)) {
          fail(new IspaceError(ERROR_CODES.INVALID_ARTIFACT,
            `产物含越界路径：${entry.fileName}`));
          return;
        }

        if (/\/$/.test(entry.fileName)) {
          mkdirSync(target, { recursive: true });
          zip.readEntry();
          return;
        }

        totalBytes += entry.uncompressedSize;
        if (totalBytes > limits.maxTotalBytes) {
          fail(new IspaceError(ERROR_CODES.INVALID_ARTIFACT,
            `产物解压后超过上限 ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB`));
          return;
        }

        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) {
            fail(new IspaceError(ERROR_CODES.INVALID_ARTIFACT, `无法读取条目 ${entry.fileName}`));
            return;
          }
          mkdirSync(dirname(target), { recursive: true });
          pipeline(stream, createWriteStream(target))
            .then(() => {
              files.push(target);
              zip.readEntry();
            })
            .catch(() => fail(new IspaceError(ERROR_CODES.INVALID_ARTIFACT,
              `写入失败：${entry.fileName}`)));
        });
      });

      zip.on('end', () => resolveP({ files, totalBytes }));
      zip.on('error', () => fail(new IspaceError(ERROR_CODES.INVALID_ARTIFACT, '解压失败')));
      zip.readEntry();
    });
  });
}

/**
 * 有些构建工具产出的 zip 顶层带一个目录（如 dist/）。
 * 若解压后根目录没有 index.html 而恰好只有一个子目录且其中有，则以它为根。
 * 这能避免用户因为「zip 了整个 dist 文件夹还是 dist 里的内容」而失败。
 */
export async function resolveArtifactRoot(dir: string): Promise<string> {
  if (existsSync(join(dir, 'index.html'))) return dir;
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1 && entries.length === 1) {
    const inner = join(dir, dirs[0]!.name);
    if (existsSync(join(inner, 'index.html'))) return inner;
  }
  throw new IspaceError(
    ERROR_CODES.INVALID_ARTIFACT,
    '产物根目录下没有 index.html。请确认打包的是构建输出（通常是 dist 目录）的内容。',
  );
}

/**
 * 原子切换软链。
 *
 * 关键在于 rename 是原子的，而「删除旧链 + 新建链」不是——后者存在一个
 * 窗口期，此刻访问会 404。先在同目录建临时链再 rename 覆盖，可保证
 * 任一时刻软链要么指向旧版本要么指向新版本，不存在中间态。
 */
export async function switchSymlink(linkPath: string, targetDir: string): Promise<void> {
  mkdirSync(dirname(linkPath), { recursive: true });

  // 若目标位置是真实目录而非软链，rename 会失败并抛 EISDIR。
  // 平台自身永远只在这里创建软链，出现真实目录说明有人手工放过文件——
  // 此时报明确的错，绝不静默删除：那个目录可能装着无备份的内容。
  const existing = lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    throw new IspaceError(
      ERROR_CODES.INTERNAL,
      `${linkPath} 是真实${existing.isDirectory() ? '目录' : '文件'}而非软链，` +
        `无法切换版本。这通常是手工放置文件造成的。请先确认其内容可弃用，再手工移除后重试。`,
      { path: linkPath },
    );
  }

  const tmp = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  await symlink(targetDir, tmp);
  try {
    await rename(tmp, linkPath);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** 列出某应用的历史版本目录，按时间倒序。 */
export function listReleaseStamps(cfg: StorageConfig, user: string, app: string): string[] {
  const base = join(cfg.releasesRoot, user, app);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** 只保留最近 N 个版本，其余删除。防止 releases 目录无限增长吃满磁盘。 */
export async function pruneReleases(
  cfg: StorageConfig,
  user: string,
  app: string,
  keep: number,
  activeStamp: string,
): Promise<string[]> {
  const stamps = listReleaseStamps(cfg, user, app);
  const removed: string[] = [];
  for (const s of stamps.slice(keep)) {
    // 绝不删当前生效的版本，即使它排在 keep 之外（例如回滚到很旧的版本后）
    if (s === activeStamp) continue;
    await rm(join(cfg.releasesRoot, user, app, s), { recursive: true, force: true });
    removed.push(s);
  }
  return removed;
}

/** 递归统计目录大小。用于写入 apps.size_bytes 与配额。 */
export function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += statSync(p).size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}

/**
 * 从产物里认出一张封面图，返回卡片 <img src> 能直接用的地址；认不出返回 null。
 *
 * 两种声明方式，按优先级：
 *   1. index.html 里的 <meta property="og:image" content="…">（web 标准，
 *      AI 本来就会写；也兼容 name="og:image" 和 name="cover" 两种写法）
 *   2. 产物根目录放一张 cover.png / .jpg / .jpeg / .webp
 *
 * 只认这两种、且只接受 http(s) 绝对地址或站内相对路径——把结果拼进 <img src>
 * 时若混进 javascript:/data: 就是一个 XSS 面。相对地址一律挂到 siteBase 之下
 * （/{user}/{slug}/），因为产物部署在子路径，根绝对路径会 404，跟 base path
 * 那条约束同一个道理。
 *
 * siteBase 传进来时应以 / 结尾，如 "/zhangming/zhoubao/"。
 * rootFiles 是产物根目录下的文件名（不含子目录，小写比较）。
 */
const COVER_FILES = ['cover.png', 'cover.jpg', 'cover.jpeg', 'cover.webp'];

export function extractCover(
  indexHtml: string,
  rootFiles: readonly string[],
  siteBase: string,
): string | null {
  const base = siteBase.endsWith('/') ? siteBase : `${siteBase}/`;

  // 站内相对地址 → 挂到 base 下；http(s) 绝对地址原样用；其余（javascript:/
  // data:/ 协议相对//…）一律拒绝，宁可没有封面也不往 img src 里塞可疑东西。
  const resolve = (raw: string): string | null => {
    const v = raw.trim();
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    if (/^(javascript|data|vbscript):/i.test(v) || v.startsWith('//')) return null;
    return base + v.replace(/^\.?\//, '');
  };

  // meta 标签属性顺序不定，content 可能在 property 前，所以先框出每个 <meta>
  // 再各自取 property/name 与 content，别用一条大正则去赌顺序
  for (const tag of indexHtml.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (key !== 'og:image' && key !== 'cover') continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    const url = content ? resolve(content) : null;
    if (url) return url;
  }

  const hit = COVER_FILES.find((f) => rootFiles.some((r) => r.toLowerCase() === f));
  return hit ? base + hit : null;
}

/**
 * 向 index.html 注入平台 chrome（技术方案 §4.7）。
 *
 * 选择发布期注入而非网关运行期改写：后者需给 Caddy 引入响应体重写插件，
 * 且对流式响应与缓存均有干扰。注入收在这里，与 base path 校验同环节。
 *
 * 幂等：已注入过则不重复插入（回滚后再发布会再次经过此函数）。
 */
export const SHELL_SCRIPT_SRC = '/platform/shell.js';
const SHELL_MARKER = 'data-ispace-shell';

export async function injectShellScript(indexHtmlPath: string): Promise<boolean> {
  const html = await readFile(indexHtmlPath, 'utf8');
  if (html.includes(SHELL_MARKER)) return false;

  const tag = `<script ${SHELL_MARKER} src="${SHELL_SCRIPT_SRC}" defer></script>`;
  let out: string;
  if (/<\/head>/i.test(html)) {
    out = html.replace(/<\/head>/i, `  ${tag}\n</head>`);
  } else if (/<body[^>]*>/i.test(html)) {
    out = html.replace(/(<body[^>]*>)/i, `$1\n  ${tag}`);
  } else {
    // 没有 head 也没有 body 的裸片段，直接前置
    out = `${tag}\n${html}`;
  }
  await writeFile(indexHtmlPath, out, 'utf8');
  return true;
}

/** 收集目录下所有文件的绝对路径，供扫描器使用。 */
export async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

export { relative as relativePath, stat as statAsync, rmSync };
