import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE, ERROR_CODES, IspaceError, channelNameFor, previewChannelNameFor,
  type User,
} from '@ispace/contracts';
import { writeAudit, type Sql } from '@ispace/db';
import { z } from 'zod';
import { publishMobileBundle } from '../services/mobile-publish.js';

/**
 * 移动端页面包的发布（技术方案 §5.3、§5.7）。
 *
 * 职责边界：
 *   CI（流水线）负责  compose-bundle 合成 → expo export → 打成 zip
 *   平台（本模块）负责 接收 zip → 扫描 → 落盘 → 生成 manifest → 写库 → 移通道指针
 *
 * 之所以这样切：expo export 需要完整的 Expo 工具链与原生构建环境，
 * 塞进 deploy-service 会让这个进程背上几百 MB 依赖，且构建失败会拖垮
 * 整个部署服务。CI 出包、平台只管分发，两边都简单。
 *
 * 「发布即移动指针、回滚即指回旧版本，秒级生效」——指针就是
 * mobile_channels.current_release_id，本模块只改这一个字段。
 */

const publishSchema = z.object({
  runtimeVersion: z.string().min(1),
  /** 灰度比例。设计稿「更新通道」屏是 10 / 50 / 100 三档。 */
  rolloutPercent: z.coerce.number().int().min(0).max(100).default(100),
  /**
   * 预览通道：开发者出预览时用，不影响使用者（技术方案 §6.5）。
   *
   * ⚠️ 不能用 z.coerce.boolean()：它走 Boolean(值)，而 Boolean('false') === true，
   * 任何非空字符串都会变成 true。multipart 字段全是字符串，用 coerce 会让
   * preview 恒为真——实测导致所有发布都进了预览通道、主通道指针从不移动，
   * 而客户端只会看到 204「无更新」，完全查不到原因。
   */
  preview: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(v.trim()))),
  notes: z.string().max(500).optional(),
});

const rolloutSchema = z.object({ rolloutPercent: z.number().int().min(0).max(100) });

export function registerMobileRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    bundleRoot: string;
    publicBase: string;
    requireAuth: (req: FastifyRequest) => Promise<User>;
  },
): void {
  const { sql, bundleRoot, publicBase, requireAuth } = deps;

  /**
   * 从通道名认出它属于谁，认不出来返回 null。
   *
   * 先查 mobile_channels，查不到再按命名规则（u-{username}）倒推用户，
   * 顺手把通道建上。这一步是必须的：通道行原本只在**首次发布页面包**时才创建，
   * 而设备心跳发生得更早——用户在手机上装好 App、登录，此刻还没发过任何包。
   * 只查表的话，这些设备会被静默丢弃，控制台「活跃设备」就永远是 0，
   * 直到第一次发版才突然有数。
   */
  async function resolveChannelOwner(channelName: string): Promise<string | null> {
    const [ch] = await sql<{ user_id: string }[]>`
      SELECT user_id FROM ispace.mobile_channels WHERE channel_name = ${channelName}
    `;
    if (ch) return ch.user_id;

    // 预览通道不单独建行：它与主通道同属一人，统计上也该算同一批设备
    const username = channelName.replace(/^u-/, '').replace(/-preview$/, '');
    if (username === channelName) return null;   // 不是本平台的通道名

    const [u] = await sql<{ id: string }[]>`
      SELECT id FROM ispace.users WHERE username = ${username} AND status = 'active'
    `;
    if (!u) return null;

    await ensureChannel(u.id, channelNameFor(username));
    return u.id;
  }

  /** 确保用户有通道。开通时未建的话在首次发布时补上。 */
  async function ensureChannel(userId: string, channelName: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO ispace.mobile_channels (user_id, channel_name)
      VALUES (${userId}, ${channelName})
      ON CONFLICT (user_id) DO UPDATE SET channel_name = EXCLUDED.channel_name
      RETURNING id
    `;
    return rows[0]!.id;
  }

  // ── 发布页面包 ────────────────────────────────────────────────────
  // 与 MCP 的 publish-app 走同一个服务层（services/mobile-publish.ts）。
  // 这里只负责把 multipart 的字节落到临时文件，其余交给服务层。
  app.post(`${API_BASE}/mobile/publish`, async (req) => {
    const me = await requireAuth(req);
    const file = await req.file();
    if (!file) throw new IspaceError(ERROR_CODES.INVALID_ARTIFACT, '缺少页面包文件');

    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const input = publishSchema.parse({
      runtimeVersion: fields.runtimeVersion?.value,
      rolloutPercent: fields.rolloutPercent?.value ?? '100',
      preview: fields.preview?.value ?? 'false',
      notes: fields.notes?.value,
    });

    const dir = await mkdtemp(join(tmpdir(), 'ispace-mobile-up-'));
    const zipPath = join(dir, 'bundle.zip');
    try {
      await writeFile(zipPath, await file.toBuffer());
      const out = await publishMobileBundle(
        { sql, bundleRoot, publicBase },
        {
          user: me, zipPath,
          runtimeVersion: input.runtimeVersion,
          rolloutPercent: input.rolloutPercent,
          preview: input.preview,
          notes: input.notes,
          source: 'cli', clientIp: req.ip,
        },
      );
      return {
        release: {
          id: out.releaseId, bundleVersion: out.bundleVersion,
          runtimeVersion: out.runtimeVersion, rolloutPercent: out.rolloutPercent,
        },
        channel: out.channel,
        assets: out.assets,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ── 通道与版本列表（控制台「更新通道」屏）──────────────────────────
  app.get(`${API_BASE}/mobile/channel`, async (req) => {
    const me = await requireAuth(req);
    const chan = await sql`
      SELECT c.channel_name, c.current_release_id,
             r.bundle_version, r.runtime_version, r.rollout_percent, r.published_at
        FROM ispace.mobile_channels c
        LEFT JOIN ispace.mobile_releases r ON r.id = c.current_release_id
       WHERE c.user_id = ${me.id}
    `;
    const releases = await sql`
      SELECT id, bundle_version, runtime_version, rollout_percent, status, published_at
        FROM ispace.mobile_releases WHERE user_id = ${me.id}
       ORDER BY bundle_version DESC LIMIT 20
    `;
    return {
      channel: chan[0] ?? null,
      channelName: channelNameFor(me.username),
      previewChannelName: previewChannelNameFor(me.username),
      releases,
    };
  });

  // ── 调整放量（设计稿的 10% / 50% / 100%）──────────────────────────
  app.patch(`${API_BASE}/mobile/releases/:id/rollout`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const { rolloutPercent } = rolloutSchema.parse(req.body);
    const rows = await sql`
      UPDATE ispace.mobile_releases SET rollout_percent = ${rolloutPercent}
       WHERE id = ${id} AND user_id = ${me.id} RETURNING bundle_version
    `;
    if (!rows[0]) throw new IspaceError(ERROR_CODES.NOT_FOUND, '版本不存在');
    return { ok: true, rolloutPercent };
  });

  // ── 回滚：指针指回旧版本 ──────────────────────────────────────────
  app.post(`${API_BASE}/mobile/rollback`, async (req) => {
    const me = await requireAuth(req);
    const body = (req.body ?? {}) as { toVersion?: number };

    const rows = await sql<{ id: string; bundle_version: number }[]>`
      SELECT id, bundle_version FROM ispace.mobile_releases
       WHERE user_id = ${me.id} AND status IN ('active','superseded')
       ORDER BY bundle_version DESC
    `;
    const target = body.toVersion
      ? rows.find((r) => r.bundle_version === body.toVersion)
      : rows[1];
    if (!target) {
      throw new IspaceError(
        ERROR_CODES.NOT_FOUND,
        body.toVersion ? `版本 v${body.toVersion} 不存在` : '没有上一个版本可回滚',
      );
    }

    await sql`
      UPDATE ispace.mobile_releases SET status = 'superseded'
       WHERE user_id = ${me.id} AND status = 'active'
    `;
    await sql`UPDATE ispace.mobile_releases SET status = 'active' WHERE id = ${target.id}`;
    const channelId = await ensureChannel(me.id, channelNameFor(me.username));
    await sql`
      UPDATE ispace.mobile_channels SET current_release_id = ${target.id} WHERE id = ${channelId}
    `;

    await writeAudit(sql, {
      actorId: me.id, action: 'mobile.publish', targetType: 'mobile_release',
      targetId: target.id, source: 'console', result: 'success',
      metadata: { rollbackTo: target.bundle_version },
      ip: req.ip,
    });
    return { bundleVersion: target.bundle_version };
  });

  /**
   * 壳上报"这个包我装上了/没装上"（设计稿「更新通道」屏的到端设备与加载失败）。
   *
   * 更新服务那边只知道"这台设备来问过更新"，不知道下发的包最后有没有跑起来。
   * 两者差别很大：下载完解压失败、runtimeVersion 对不上、包本身白屏，
   * 在更新服务看来全都是"正常下发"。到端与失败只能由壳自己说。
   *
   * 不要求鉴权：壳在切通道、加载新包的过程中可能还没有会话
   * （首次登录就是这个顺序）。上报只能改自己这台设备在自己通道下的一行，
   * 拿不到别人的数据，也改不了发布本身。
   */
  app.post(`${API_BASE}/mobile/devices/report`, async (req) => {
    const body = (req.body ?? {}) as {
      channelName?: string;
      deviceId?: string;
      bundleVersion?: number;
      error?: string;
    };
    if (!body.channelName || !body.deviceId) {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, '缺少 channelName 或 deviceId');
    }

    const userId = await resolveChannelOwner(body.channelName);
    // 认不出这个通道就安静收下：可能是已归档用户的旧设备，也可能是
    // 手工改过请求头。这不是壳该看到的错误，报错只会让登录流程显得坏了。
    if (!userId) return { ok: true };

    const [rel] = body.bundleVersion
      ? await sql<{ id: string }[]>`
          SELECT id FROM ispace.mobile_releases
           WHERE user_id = ${userId} AND bundle_version = ${body.bundleVersion}
        `
      : [];

    // 成功时清空 last_error：不清的话一台修好的设备会永远算在"加载失败"里。
    const err = body.error ?? null;
    await sql`
      INSERT INTO ispace.mobile_devices
        (user_id, device_id, current_release_id, last_seen_at, last_error, last_error_at)
      VALUES (${userId}, ${body.deviceId}, ${rel?.id ?? null}, now(),
              ${err}, ${err ? sql`now()` : null})
      ON CONFLICT (user_id, device_id) DO UPDATE SET
        current_release_id = COALESCE(EXCLUDED.current_release_id,
                                      ispace.mobile_devices.current_release_id),
        last_seen_at  = now(),
        last_error    = EXCLUDED.last_error,
        last_error_at = EXCLUDED.last_error_at
    `;

    /**
     * 记下这个版本第一次真正到端的时刻——设计稿「发布到端耗时」就是它
     * 减去 published_at。只在还没记过时写，所以是 IS NULL 条件而不是覆盖：
     * 第 100 台设备装上的时间不是"发布到端耗时"。
     */
    if (rel && !err) {
      await sql`
        UPDATE ispace.mobile_releases
           SET first_delivered_at = now()
         WHERE id = ${rel.id} AND first_delivered_at IS NULL
      `;
    }

    return { ok: true };
  });
}
