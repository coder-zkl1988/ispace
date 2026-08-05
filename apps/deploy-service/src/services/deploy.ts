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

      await refreshStorageUsage(this.sql, user.id);
      await pruneReleases(this.storage, user.username, slug, KEEP_RELEASES, stamp);
      await writeAudit(this.sql, {
        actorId: user.id, action: 'app.deploy', targetType: 'app', targetId: app.id,
        source: input.source, result: 'success', ip: input.clientIp ?? null,
        metadata: { slug, version, sizeBytes },
      });

      return { app: { ...app, status: 'running', currentReleaseId: release.id, sizeBytes }, release, url: this.appUrl(user.username, slug) };
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

    await writeAudit(this.sql, {
      actorId: user.id, action: 'app.rollback', targetType: 'app', targetId: app.id,
      source: 'console', result: 'success', metadata: { slug, toVersion: target.version },
      ip: clientIp ?? null,
    });
    return release;
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
