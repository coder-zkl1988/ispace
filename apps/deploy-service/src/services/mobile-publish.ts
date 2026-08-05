import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, readFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ERROR_CODES, IspaceError, channelNameFor, previewChannelNameFor, type User,
} from '@ispace/contracts';
import { writeAudit, type Sql } from '@ispace/db';
import { collectFiles, extractZip } from '@ispace/storage';
import { assertScanClean, scanFiles } from '@ispace/scanner';

/**
 * 移动端页面包的发布。
 *
 * 抽成服务是为了让 REST（CI 走 multipart）与 MCP（模型走 base64）共用同一条
 * 链路——与 createBackend、deleteApp 同一个理由：这里的次序有硬要求
 * （扫描 → 落盘 → 算哈希 → 写库 → 移指针），两处各写一份迟早会漂，
 * 而漂掉的那一步不会报错，只会让某一条路发出去的包客户端拿不到。
 *
 * ┌─ 为什么 MCP 也该能发 ────────────────────────────────────────────────┐
 * │ 原先 MCP 的 publish-app 直接抛 NOT_IMPLEMENTED，理由写的是"页面包     │
 * │ 数十 MB，JSON-RPC 传不动"。但那个前提是错的：数十 MB 是 APK/IPA 的    │
 * │ 体积，而 OTA 页面包只有 JS bundle + 资源，通常几 MB。                 │
 * │ 真正的障碍是服务端的 bodyLimit 只有 1 MB——那是配置问题，不是传输     │
 * │ 语义问题，已单独放开（见 mcp/server.ts 的 MCP_BODY_LIMIT）。          │
 * └──────────────────────────────────────────────────────────────────────┘
 */

export interface PublishBundleInput {
  user: User;
  /** 页面包 zip 的本地路径。调用方负责落盘与清理。 */
  zipPath: string;
  runtimeVersion: string;
  rolloutPercent: number;
  /** 预览通道：只影响开发者自己的设备，不动主通道指针。 */
  preview: boolean;
  notes?: string | undefined;
  source: 'cli' | 'mcp' | 'console';
  clientIp?: string | null;
}

export interface PublishBundleOutcome {
  releaseId: string;
  bundleVersion: number;
  runtimeVersion: string;
  rolloutPercent: number;
  channel: string;
  assets: number;
}

export async function publishMobileBundle(
  deps: { sql: Sql; bundleRoot: string; publicBase: string },
  input: PublishBundleInput,
): Promise<PublishBundleOutcome> {
  const { sql, bundleRoot, publicBase } = deps;
  const me = input.user;

  /** 确保用户有通道。开通时未建的话在首次发布时补上。 */
  const ensureChannel = async (userId: string, channelName: string): Promise<string> => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO ispace.mobile_channels (user_id, channel_name)
      VALUES (${userId}, ${channelName})
      ON CONFLICT (user_id) DO UPDATE SET channel_name = EXCLUDED.channel_name
      RETURNING id
    `;
    return rows[0]!.id;
  };

  const staging = join(tmpdir(), `ispace-mobile-${randomUUID()}`);
  try {
    const extractDir = join(staging, 'out');
    await mkdir(staging, { recursive: true });
    await extractZip(input.zipPath, extractDir);

    // 页面包也过扫描。移动端产物同样可能带上硬编码密钥，
    // 而且它比网页更难事后撤回——已经装到设备上了。
    const files = await collectFiles(extractDir);
    const scan = scanFiles(files, extractDir);
    if (!scan.ok) {
      await writeAudit(sql, {
        actorId: me.id, action: 'mobile.publish', targetType: 'mobile_release',
        targetId: null, source: input.source, result: 'blocked',
        metadata: { findings: scan.findings.slice(0, 20) },
        ip: input.clientIp ?? null,
      });
      assertScanClean(scan);
    }

    // 版本号按用户单调递增
    const vRows = await sql<{ v: number | null }[]>`
      SELECT MAX(bundle_version) AS v FROM ispace.mobile_releases WHERE user_id = ${me.id}
    `;
    const bundleVersion = (vRows[0]?.v ?? 0) + 1;

    const channelName = input.preview
      ? previewChannelNameFor(me.username)
      : channelNameFor(me.username);
    const relDir = join(bundleRoot, me.username, String(bundleVersion));
    await mkdir(relDir, { recursive: true });

    // 落盘并算哈希。expo-updates 的 manifest 要求每个资源带 hash，
    // 客户端据此校验完整性。
    const assets: { key: string; contentType: string; url: string; hash: string }[] = [];
    let launchAsset: (typeof assets)[number] | null = null;

    for (const abs of files) {
      const rel = abs.slice(extractDir.length + 1);
      const dest = join(relDir, rel);
      await mkdir(join(dest, '..'), { recursive: true });
      await cp(abs, dest);
      const buf = await readFile(abs);
      const hash = createHash('sha256').update(buf).digest('base64url');
      const entry = {
        key: rel,
        contentType: rel.endsWith('.js') || rel.endsWith('.bundle')
          ? 'application/javascript'
          : 'application/octet-stream',
        url: `${publicBase}/updates/assets/${me.username}/${bundleVersion}/${rel}`,
        hash,
      };
      // Expo 约定入口 bundle 单独作为 launchAsset，其余进 assets
      if (!launchAsset && /(^|\/)(index|bundle)[^/]*\.(js|hbc|bundle)$/.test(rel)) {
        launchAsset = entry;
      } else {
        assets.push(entry);
      }
    }

    if (!launchAsset) {
      throw new IspaceError(
        ERROR_CODES.INVALID_ARTIFACT,
        '页面包里找不到入口 bundle（应为 index*.js 或 *.bundle）。请确认上传的是 expo export 的产物。',
      );
    }

    const manifest = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      runtimeVersion: input.runtimeVersion,
      launchAsset,
      assets,
      metadata: {},
      extra: {
        ispace: { username: me.username, bundleVersion, notes: input.notes ?? '' },
      },
    };

    const relRows = await sql<{ id: string }[]>`
      INSERT INTO ispace.mobile_releases
        (user_id, bundle_version, runtime_version, manifest, rollout_percent, status)
      VALUES (${me.id}, ${bundleVersion}, ${input.runtimeVersion},
              ${sql.json(manifest as never)}, ${input.rolloutPercent}, 'active')
      RETURNING id
    `;
    const releaseId = relRows[0]!.id;

    // 移通道指针 —— 「发布即移动指针」。预览通道不动主指针，
    // 否则开发者出个预览就把使用者的版本换掉了。
    if (!input.preview) {
      const channelId = await ensureChannel(me.id, channelName);
      await sql`
        UPDATE ispace.mobile_channels SET current_release_id = ${releaseId} WHERE id = ${channelId}
      `;
      // 旧版本降级为 superseded，但**不删文件**：回滚要用
      await sql`
        UPDATE ispace.mobile_releases SET status = 'superseded'
         WHERE user_id = ${me.id} AND id <> ${releaseId} AND status = 'active'
      `;
    }

    await writeAudit(sql, {
      actorId: me.id, action: 'mobile.publish', targetType: 'mobile_release',
      targetId: releaseId, source: input.source, result: 'success',
      metadata: {
        bundleVersion, runtimeVersion: input.runtimeVersion,
        channel: channelName, preview: input.preview,
      },
      ip: input.clientIp ?? null,
    });

    return {
      releaseId,
      bundleVersion,
      runtimeVersion: input.runtimeVersion,
      rolloutPercent: input.rolloutPercent,
      channel: channelName,
      assets: assets.length + 1,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
