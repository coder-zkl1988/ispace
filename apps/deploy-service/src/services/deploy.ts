import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Sql } from '@ispace/db';
import {
  activateRelease,
  findApp,
  nextVersion,
  recordActiveRelease,
  recordBlockedRelease,
  refreshStorageUsage,
  setAppStatus,
  upsertApp,
  writeAudit,
} from '@ispace/db';
import {
  ERROR_CODES,
  IspaceError,
  type App,
  type Release,
  type User,
} from '@ispace/contracts';
import {
  collectFiles,
  extractCover,
  dirSize,
  extractZip,
  injectShellScript,
  makeStamp,
  releaseDir,
  resolveArtifactRoot,
  siteLink,
  switchSymlink,
  listReleaseStamps,
  pruneReleases,
  type StorageConfig,
} from '@ispace/storage';
import { assertScanClean, checkBasePath, gitleaksScan, scanFiles } from '@ispace/scanner';
import { coverShotAvailable, screenshotCover } from './cover-shot.js';

/**
 * 发布链路（技术方案 §4.5、规格 §9）。
 *
 *   接收产物 → 解压到临时目录 → 密钥/XSS 扫描 → base path 校验
 *            → 注入 shell.js → 移入 releases/{ts} → 原子切换软链
 *            → 写库与审计 → 刷新配额
 *
 * 扫描放在移入 releases 之前：被阻断的产物不应在磁盘上留下可访问的副本。
 */

/** 保留的历史版本数。超出的自动清理，防止 releases 目录吃满磁盘。 */
const KEEP_RELEASES = 10;

/** 自动截图落地的文件名。前缀 __ispace 避免撞用户产物里的同名文件。 */
const AUTO_COVER_FILE = '__ispace_cover.png';

export interface DeployInput {
  user: User;
  slug: string;
  zipPath: string;
  name?: string | undefined;
  description?: string | undefined;
  /** 「做同款」的提示词，随发布带上；省略时保留该应用已有的。 */
  sourcePrompt?: string | undefined;
  type?: 'static' | 'static_backend' | 'h5';
  source: 'mcp' | 'cli' | 'agent' | 'console';
  /**
   * 调用方 IP，写进审计。
   *
   * 发布是平台上后果最大的动作，「谁在什么时候从哪儿发的」这三样缺一不可——
   * 设计稿「审计与安全」那张表里，发布记录正是带 IP 的那几行。
   * 可选：CLI 之外还有定时任务等无请求上下文的调用方。
   */
  clientIp?: string | undefined;
}

export interface DeployOutcome {
  app: App;
  release: Release;
  url: string;
}

export class DeployService {
  constructor(
    private readonly sql: Sql,
    private readonly storage: StorageConfig,
    private readonly publicBase: string,
  ) {}

  appUrl(username: string, slug: string): string {
    return `${this.publicBase}/${username}/${slug}/`;
  }

  async deploy(input: DeployInput): Promise<DeployOutcome> {
    const { user, slug } = input;

    const app = await upsertApp(this.sql, {
      ownerId: user.id,
      slug,
      name: input.name ?? slug,
      description: input.description ?? null,
      sourcePrompt: input.sourcePrompt ?? null,
      type: input.type ?? 'static',
    });

    const version = await nextVersion(this.sql, app.id);
    const stamp = makeStamp(new Date(), version);
    const staging = mkdtempSync(join(tmpdir(), `ispace-deploy-${slug}-`));

    try {
      // ── 解压到临时目录 ──────────────────────────────────────────
      await extractZip(input.zipPath, staging);
      const root = await resolveArtifactRoot(staging);

      // ── 扫描。在移入 releases 之前，被阻断的产物不落地 ──────────
      const files = await collectFiles(root);
      const scan = scanFiles(files, root);

      // 第二道：gitleaks 深度扫描。内置规则已经跑过，这里补覆盖面。
      // 不可用时静默降级——二进制缺失或超时不该阻断发布，内置规则仍在。
      const gl = await gitleaksScan(root);
      if (gl.findings.length) {
        scan.findings.push(...gl.findings);
        scan.ok = false;
      }

      if (!scan.ok) {
        const reason = `${scan.findings[0]!.rule} @ ${scan.findings[0]!.file}:${scan.findings[0]!.line}`;
        const blocked = await recordBlockedRelease(this.sql, {
          appId: app.id, version, source: input.source, publishedBy: user.id, reason,
        });
        await setAppStatus(this.sql, app.id, app.currentReleaseId ? 'running' : 'stopped');
        await writeAudit(this.sql, {
          actorId: user.id, action: 'app.deploy', targetType: 'app', targetId: app.id,
          source: input.source, result: 'blocked', ip: input.clientIp ?? null,
          metadata: { slug, version, findings: scan.findings.slice(0, 20) },
        });
        void blocked;
        assertScanClean(scan); // 抛 SECRET_DETECTED / XSS_DETECTED
      }

      // ── base path 校验 ──────────────────────────────────────────
      const indexPath = join(root, 'index.html');
      const html = await readFile(indexPath, 'utf8');
      const bp = checkBasePath(html);
      if (!bp.ok) {
        await setAppStatus(this.sql, app.id, app.currentReleaseId ? 'running' : 'stopped');
        throw new IspaceError(
          ERROR_CODES.INVALID_BASE_PATH,
          `产物引用了根绝对路径，在 /${user.username}/${slug}/ 下会 404：${bp.offenders.slice(0, 3).join('、')}。` +
            `请把构建配置的 base 设为 './' 或 '/${user.username}/${slug}/'。`,
          { offenders: bp.offenders },
        );
      }

      // ── 注入平台 chrome ─────────────────────────────────────────
      await injectShellScript(indexPath);

      // ── 落地并切换 ──────────────────────────────────────────────
      const dest = releaseDir(this.storage, user.username, slug, stamp);
      await moveDir(root, dest);
      // mkdtemp 建的暂存目录是 0700，rename 会原样保留权限位，导致发布出来的
      // 版本目录只有创建者可读——Caddy 以其他 uid 运行时会 403/404。
      // 移入后统一放开为可读。
      await chmodRecursive(dest);
      const sizeBytes = dirSize(dest);
      await switchSymlink(siteLink(this.storage, user.username, slug), dest);

      const release = await recordActiveRelease(this.sql, {
        appId: app.id, version, source: input.source,
        sizeBytes, path: stamp, publishedBy: user.id,
      });

      // ── 封面 ────────────────────────────────────────────────────
      // 从产物里取声明的封面（og:image / cover.png），存进 apps.cover_path，
      // 卡片据此显示 banner。html 是注入平台脚本前读的原文，meta 不受影响。
      // 取不到就写 null——覆盖旧版本可能声明过、这版删掉了的情况，让卡片
      // 干净地回落到字母块，而不是挂着一张上个版本的图。
      const rootFiles = files
        .map((f) => f.slice(root.length + 1))
        .filter((rel) => !rel.includes('/'));
      const cover = extractCover(html, rootFiles, `/${user.username}/${slug}/`);
      await this.sql`UPDATE ispace.apps SET cover_path = ${cover} WHERE id = ${app.id}`;

      // 没声明封面 → 后台自动截一张兜底（方案 B）。**不 await**：截图要几秒、
      // 且是锦上添花，不该让发布响应等它。截好后单独回写 cover_path，下次卡片
      // 刷新就有图；失败则维持 null，卡片回落字母块。
      if (!cover && coverShotAvailable()) {
        const outPng = join(dest, AUTO_COVER_FILE);
        void screenshotCover(join(dest, 'index.html'), outPng)
          .then(async (ok) => {
            if (!ok) return;
            // 回写前再确认没有新版本抢先声明了封面：并发发布时后完成的截图
            // 不该盖掉更晚那次的声明。只在仍为 null 时落。
            await this.sql`
              UPDATE ispace.apps SET cover_path = ${`/${user.username}/${slug}/${AUTO_COVER_FILE}`}
               WHERE id = ${app.id} AND cover_path IS NULL
            `;
          })
          .catch(() => { /* best-effort，吞掉 */ });
      }

      await refreshStorageUsage(this.sql, user.id);
      await pruneReleases(this.storage, user.username, slug, KEEP_RELEASES, stamp);
      await writeAudit(this.sql, {
        actorId: user.id, action: 'app.deploy', targetType: 'app', targetId: app.id,
        source: input.source, result: 'success', ip: input.clientIp ?? null,
        metadata: { slug, version, sizeBytes },
      });

      return { app: { ...app, status: 'running', currentReleaseId: release.id, sizeBytes, coverUrl: cover }, release, url: this.appUrl(user.username, slug) };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * 回滚。软链切回旧目录，秒级生效。
   *
   * 磁盘与库必须同时改：若只切软链不改库，控制台显示的当前版本会与实际
   * 服务的内容不符；若只改库不切软链则反之。这里先切软链再改库——软链
   * 切换失败可直接抛错，而库改完再切软链失败则会留下不一致。
   */
  async rollback(user: User, slug: string, toVersion?: number, clientIp?: string): Promise<Release> {
    const app = await findApp(this.sql, user.id, slug);
    if (!app) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到应用 /${slug}`);

    const stamps = listReleaseStamps(this.storage, user.username, slug);
    if (stamps.length < 2 && toVersion === undefined) {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有可回滚的历史版本');
    }

    const rows = await this.sql<{ version: number; path: string }[]>`
      SELECT version, path FROM ispace.releases
       WHERE app_id = ${app.id} AND status IN ('active','superseded')
       ORDER BY version DESC
    `;
    const target = toVersion !== undefined
      ? rows.find((r) => r.version === toVersion)
      : rows[1]; // rows[0] 是当前 active

    if (!target) {
      throw new IspaceError(
        ERROR_CODES.NOT_FOUND,
        toVersion !== undefined ? `版本 v${toVersion} 不存在` : '没有上一个版本',
      );
    }

    // 库里有记录不代表磁盘上还在：pruneReleases 会清理超出保留数的旧版本，
    // 运维也可能手工清过。不校验就会把软链指向不存在的路径，表现为整个
    // 应用 404，且回滚"成功"了——比直接报错糟得多。
    const targetDir = releaseDir(this.storage, user.username, slug, target.path);
    if (!existsSync(targetDir)) {
      throw new IspaceError(
        ERROR_CODES.NOT_FOUND,
        `v${target.version} 的文件已不在磁盘上（超出保留份数或已被清理），无法回滚到该版本。` +
          `可回滚的版本请看发布记录中标注仍可用的那些。`,
        { version: target.version },
      );
    }

    await switchSymlink(siteLink(this.storage, user.username, slug), targetDir);
    const release = await activateRelease(this.sql, app.id, target.version);

    // 封面按回滚到的那个版本重算——cover_path 是应用级的，不跟着软链走。
    // 不重算的话，回滚到一个更旧、当时没截图/没声明封面的版本后，卡片仍挂着
    // 现已切走的那版的封面路径，指向一个 404。读目标目录里实际有什么：
    // 声明的 og:image/cover.* 优先，其次那版当时自动截的 __ispace_cover.png。
    await this.recomputeCover(app.id, user.username, slug, targetDir);

    await writeAudit(this.sql, {
      actorId: user.id, action: 'app.rollback', targetType: 'app', targetId: app.id,
      source: 'console', result: 'success', metadata: { slug, toVersion: target.version },
      ip: clientIp ?? null,
    });
    return release;
  }

  /**
   * 给存量页面补封面。
   *
   * 封面是后来才加的功能，在那之前发布的页面 cover_path 一直是 null。但它们的
   * 产物还在磁盘上（/srv/releases/{user}/{app}/{当前版本}），所以能就地回填，
   * 不必让用户重新发一遍——那对非技术用户就是一道坎。
   *
   * 每个页面走一遍和发布时同样的判断：先看它有没有声明封面（有些老页面本就
   * 写了 og:image），没有再自动截一张。只处理 cover_path 仍为 null 的，已有
   * 封面的不动。全程 best-effort，单个失败不影响其余。
   *
   * 由管理员在控制台触发；也可重复跑（上次截图失败的这次再试）。
   */
  async backfillCovers(): Promise<{ scanned: number; filled: number }> {
    const { readdirSync } = await import('node:fs');
    const rows = await this.sql<
      { id: string; slug: string; username: string; stamp: string }[]
    >`
      SELECT a.id, a.slug, u.username, r.path AS stamp
        FROM ispace.apps a
        JOIN ispace.users u    ON u.id = a.owner_id
        JOIN ispace.releases r ON r.id = a.current_release_id
       WHERE a.cover_path IS NULL AND a.status = 'running'
       ORDER BY a.updated_at DESC
    `;
    let filled = 0;
    for (const row of rows) {
      try {
        const dir = releaseDir(this.storage, row.username, row.slug, row.stamp);
        const indexPath = join(dir, 'index.html');
        if (!existsSync(indexPath)) continue;
        const html = await readFile(indexPath, 'utf8');
        const base = `/${row.username}/${row.slug}/`;
        let cover = extractCover(html, readdirSync(dir), base);
        if (!cover && coverShotAvailable()) {
          const ok = await screenshotCover(indexPath, join(dir, AUTO_COVER_FILE));
          if (ok) cover = `${base}${AUTO_COVER_FILE}`;
        }
        if (cover) {
          // 只在仍为 null 时落：跑的过程中用户可能正好重新发布并声明了封面
          await this.sql`
            UPDATE ispace.apps SET cover_path = ${cover}
             WHERE id = ${row.id} AND cover_path IS NULL
          `;
          filled += 1;
        }
      } catch {
        // 单个页面读不了/截不了就跳过，不拖累整批
      }
    }
    return { scanned: rows.length, filled };
  }

  /**
   * 按某个 release 目录里实际存在的文件，重算并落库 cover_path。
   *
   * 用在回滚：优先该版本声明的封面（读它自己的 index.html），其次那版当时
   * 自动截的 __ispace_cover.png，都没有就置 null 回落字母块。只读磁盘、不再
   * 截图——回滚要秒级生效，不该等一个可能几秒的 chromium。
   */
  private async recomputeCover(
    appId: string, username: string, slug: string, dir: string,
  ): Promise<void> {
    const { readdirSync } = await import('node:fs');
    let cover: string | null = null;
    try {
      const html = await readFile(join(dir, 'index.html'), 'utf8');
      const rootFiles = readdirSync(dir);
      cover = extractCover(html, rootFiles, `/${username}/${slug}/`);
      if (!cover && rootFiles.includes(AUTO_COVER_FILE)) {
        cover = `/${username}/${slug}/${AUTO_COVER_FILE}`;
      }
    } catch {
      cover = null; // 读不到就干净地回落，不让回滚因为封面失败
    }
    await this.sql`UPDATE ispace.apps SET cover_path = ${cover} WHERE id = ${appId}`;
  }
}

/**
 * 跨目录移动。rename 在同一文件系统上是原子的；临时目录与 /srv 可能不同挂载点，
 * 此时退化为复制后删除。
 */
async function moveDir(src: string, dest: string): Promise<void> {
  const { rename, mkdir, cp } = await import('node:fs/promises');
  const { dirname } = await import('node:path');

  // 拒绝覆盖已存在的目标。EXDEV 分支用的 cp 是"合并覆盖"语义，若目标已存在
  // 会静默盖掉前一个版本的文件——版本目录名撞车时这就是数据丢失。
  // 目录名已含版本号本不该撞，这里是第二道防线：宁可发布失败也不能悄悄毁掉历史版本。
  if (existsSync(dest)) {
    throw new IspaceError(
      ERROR_CODES.INTERNAL,
      `版本目录 ${dest} 已存在，拒绝覆盖。这通常意味着版本号分配出了问题。`,
      { dest },
    );
  }

  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (e) {
    // 容器内 /tmp 与 /srv 常是不同挂载点，rename 跨设备会抛 EXDEV
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

/**
 * 递归放开读权限。
 *
 * 目录 755、文件 644。静态托管容器可能以任意 uid 运行（caddy 官方镜像默认
 * root，但换镜像或加 user 指令后就不是），依赖"恰好同 uid"是脆弱的。
 * 这些内容本来就要对外公开提供，放开读权限不引入额外暴露面。
 */
async function chmodRecursive(dir: string): Promise<void> {
  const { chmod, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await chmod(dir, 0o755);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await chmodRecursive(p);
    else if (e.isFile()) await chmod(p, 0o644);
  }
}
