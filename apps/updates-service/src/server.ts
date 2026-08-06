import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, dbConfigFromEnv, type Sql } from '@ispace/db';
import { withCurrentOrigin } from './manifest-origin.js';
import { isRolledOut } from './rollout.js';

/**
 * 自托管 expo-updates 更新服务器（技术方案 §5.3）。
 *
 * expo-updates 的客户端-服务端协议是公开文档化规范，平台据此自建，
 * 不依赖 EAS 云服务。
 *
 * 职责：
 *   - 按请求头中的通道名与 runtimeVersion 返回该用户当前指向的 manifest
 *   - bundle 与资源由静态层提供（/updates/assets/...）
 *   - 每通道维护"当前版本"指针，发布即移动指针、回滚即指回旧版本，秒级生效
 *
 * 两个关键约束，都写进了实现：
 *
 *   1. runtimeVersion 不匹配则**不下发**（返回 204），而不是下发一个装不上的包。
 *      这是把"版本漂移"从人为约定升级为机制强制的关键——壳收到 204 会保持
 *      在当前版本，设计稿第 11 屏那个"这个版本装不上"的提示就是客户端在
 *      本地检测到不匹配时显示的。
 *
 *   2. 「回到上一个版本」经请求头 x-prefer: previous 实现，机制上仍是"只改
 *      header"，不触碰技术方案 §5.2 那条红线（禁止在生产壳中使用可改写
 *      更新 URL 的 API）。
 */

const PORT = Number(process.env.PORT ?? 3200);
/** 见 deploy-service 同名常量：默认值仅供本机开发（本进程监听口），部署必须显式设置。 */
const PUBLIC_BASE = process.env.ISPACE_PUBLIC_BASE ?? 'http://localhost:3200';
const BUNDLE_ROOT = process.env.ISPACE_BUNDLE_ROOT ?? '/srv/bundles';

/** expo-updates 的协议头。名称取自官方规范，不可自创。 */
const H = {
  channel: 'expo-channel-name',
  runtime: 'expo-runtime-version',
  platform: 'expo-platform',
  protocol: 'expo-protocol-version',
  deviceId: 'expo-device-id',
  prefer: 'x-prefer',
} as const;

export async function buildUpdatesServer(opts: { sql?: Sql } = {}): Promise<FastifyInstance> {
  const sql = opts.sql ?? createDb(dbConfigFromEnv());
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.get('/updates/health', async () => ({ ok: true, service: 'updates-service' }));

  /**
   * manifest 端点。壳的 checkForUpdateAsync 打到这里。
   *
   * 返回 200 + manifest 表示有可用更新；204 表示"没有适用于你的更新"
   * （包括：没发过版、未被灰度放量、runtimeVersion 不匹配）。
   * 三种情况对客户端行为一致——保持当前版本，因此不必区分。
   */
  app.get('/updates/manifest', async (req, reply) => {
    const channel = req.headers[H.channel] as string | undefined;
    const runtime = req.headers[H.runtime] as string | undefined;
    const deviceId = req.headers[H.deviceId] as string | undefined;
    const prefer = req.headers[H.prefer] as string | undefined;

    // 下发决策的全部输入。204 对客户端是静默的（保持现状），排查"该下发
    // 却没下发"时，只有这行日志能还原设备到底带了什么头。
    req.log.info({ channel, runtime, deviceId, prefer }, 'manifest 请求头');

    if (!channel || !runtime) {
      return reply.status(400).send({
        error: `缺少 ${H.channel} 或 ${H.runtime} 请求头`,
      });
    }

    const chan = await sql<{ user_id: string; current_release_id: string | null }[]>`
      SELECT user_id, current_release_id FROM ispace.mobile_channels
       WHERE channel_name = ${channel}
    `;
    const ch = chan[0];
    if (!ch) return reply.status(204).send();

    /**
     * 记一次设备心跳。
     *
     * 控制台「更新通道」屏的「活跃设备」就是这张表数出来的——不记的话
     * 那张卡永远只能显示占位。壳每次检查更新都会打到这里，频率足够，
     * 不需要另设上报端点。
     *
     * 不阻塞下发：库抖一下不该让所有人的更新检查跟着失败。这一行的
     * 全部价值是让一张统计卡有数，比不上正常发版重要。
     */
    if (deviceId) {
      void sql`
        INSERT INTO ispace.mobile_devices (user_id, device_id, last_seen_at)
        VALUES (${ch.user_id}, ${deviceId}, now())
        ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen_at = now()
      `.catch((e: unknown) => {
        req.log.warn({ err: e }, '设备心跳写入失败，不影响更新下发');
      });
    }

    // 只取与壳 runtimeVersion 匹配的版本。不匹配的直接不出现在候选里——
    // 这比"下发后让客户端拒绝"更早地阻断了版本漂移。
    const candidates = await sql<
      { id: string; bundle_version: number; manifest: unknown; rollout_percent: number }[]
    >`
      SELECT id, bundle_version, manifest, rollout_percent
        FROM ispace.mobile_releases
       WHERE user_id = ${ch.user_id}
         AND runtime_version = ${runtime}
         AND status = 'active'
       ORDER BY bundle_version DESC
       LIMIT 5
    `;
    if (candidates.length === 0) return reply.status(204).send();

    // x-prefer: previous —— 设计稿壳设置里的「回到上一个版本」。
    // 机制上只是换一个候选，不改更新 URL。
    const wantPrevious = prefer === 'previous';
    const target = wantPrevious ? candidates[1] : candidates[0];
    if (!target) return reply.status(204).send();

    // 灰度：未放量的设备完全无感，返回 204 而非旧 manifest——
    // 返回旧 manifest 会让壳认为"有更新"并重复下载同一个包。
    if (!wantPrevious && !isRolledOut(deviceId, target.id, target.rollout_percent)) {
      const fallback = candidates.find(
        (c) => c.id !== target.id && c.rollout_percent >= 100,
      );
      if (!fallback) return reply.status(204).send();
      reply.header('expo-protocol-version', '1');
      return reply.send(withCurrentOrigin(fallback.manifest, PUBLIC_BASE));
    }

    reply.header('expo-protocol-version', '1');
    reply.header('expo-sfv-version', '0');
    reply.header('cache-control', 'private, max-age=0');
    return reply.send(withCurrentOrigin(target.manifest, PUBLIC_BASE));
  });

  /**
   * bundle 与资源。
   *
   * 路径形如 /updates/assets/{user}/{bundleVersion}/{file}。
   * 用显式路径校验而非直接拼接——拼接会让 ../ 穿越到任意文件。
   */
  app.get('/updates/assets/*', async (req, reply) => {
    const rest = (req.params as { '*': string })['*'] ?? '';
    // 只允许 [a-z0-9_./-]，且不含 ..，从根上排除路径穿越
    if (!/^[a-zA-Z0-9_./-]+$/.test(rest) || rest.includes('..')) {
      return reply.status(400).send({ error: '非法资源路径' });
    }
    const file = join(BUNDLE_ROOT, rest);
    if (!file.startsWith(BUNDLE_ROOT) || !existsSync(file)) {
      return reply.status(404).send({ error: '资源不存在' });
    }
    const buf = await readFile(file);
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    if (file.endsWith('.js') || file.endsWith('.bundle')) {
      reply.type('application/javascript');
    }
    return reply.send(buf);
  });

  /** 供控制台「更新通道」屏读取。三期接入前该表为空，返回空列表而非报错。 */
  app.get('/updates/api/channels/:username', async (req) => {
    const { username } = req.params as { username: string };
    const rows = await sql`
      SELECT c.channel_name, c.current_release_id,
             r.bundle_version, r.runtime_version, r.rollout_percent, r.published_at
        FROM ispace.mobile_channels c
        JOIN ispace.users u ON u.id = c.user_id
        LEFT JOIN ispace.mobile_releases r ON r.id = c.current_release_id
       WHERE u.username = ${username}
    `;
    return { channels: rows };
  });

  app.addHook('onClose', async () => { await sql.end({ timeout: 5 }); });
  return app;
}

const isMain = process.argv[1]?.endsWith('server.js');
if (isMain) {
  const server = await buildUpdatesServer();
  await server.listen({ port: PORT, host: '0.0.0.0' });
  server.log.info(`updates-service 监听 :${PORT}，公开地址 ${PUBLIC_BASE}/updates`);
}
