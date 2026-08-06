import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import {
  availableFromRows, type ConnectorRow,
} from '../services/connectors-available.js';
import { getQuota, listAppsByOwner, writeAudit, type Sql } from '@ispace/db';
import {
  AgentSession, createEngine,
  type AvailableConnector, type SessionEvent, type ToolContext,
} from '@ispace/agent';
import { z } from 'zod';

/**
 * Coding Agent 子系统（技术方案 §6）。
 *
 * 开发者身份的 App 首页即对话页：描述需求 → Agent 改代码 → 预览 → 二次确认部署。
 *
 * 三处与方案的实质差异，都有理由：
 *
 * 1. 引擎不是 Codex SDK。实测公司网关上 gpt-5.3-codex-spark 的工具调用
 *    arguments 恒为空，无法驱动 Agent；换 gpt-5.6 正常。方案 §6.6 要求的
 *    引擎抽象层正是为此存在，换实现不动上层。
 *
 * 2. 没有 Docker 沙箱，改为受控文件工具集。给 Agent 沙箱要么给本服务挂
 *    docker socket（开一个容器逃逸的口子），要么再起一套编排；而实际需要
 *    的能力只是"改这个项目的文件、走平台发布链路"，受控文件工具完全覆盖。
 *
 * 3. 会话存内存而非数据库。当前是单实例部署，重启丢会话可接受——用户重新
 *    描述一次即可，而为此引入会话持久化会带来消息裁剪、并发写等一堆问题。
 *    多实例部署时必须改，已在下方 NOTE 标明。
 *
 * 部署二次确认严格按方案 §6.2：审批收在平台层，手机端确认后签发一次性
 * token，部署工具校验 token 方可执行。比模型层审批更硬。
 */

const askSchema = z.object({
  sessionId: z.string().uuid().optional(),
  /**
   * 这次对话在改哪个页面（手机端底部「做点什么」顶部那条选的）。
   *
   * 不给的话模型只能从话里猜：用户说「把标题改大一点」，它得先想清楚
   * 是哪一个页面，猜错就把改动发布成了另一个 slug——用户看到的是
   * "我的页面变成两个了"。给了就没有歧义，也保证发布是覆盖而非新建。
   */
  targetSlug: z.string().max(64).optional(),
  text: z.string().min(1).max(4000),
  images: z
    .array(z.object({ mimeType: z.string(), dataBase64: z.string() }))
    .max(4)
    .default([]),
});

interface PendingDeploy {
  userId: string;
  site: string;
  summary: string;
  createdAt: number;
}

/** 确认 token 的有效期。过期即失效，避免旧 token 被翻出来用。 */
const CONFIRM_TTL_MS = 10 * 60 * 1000;

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    workspaceRoot: string;
    requireAuth: (req: FastifyRequest) => Promise<User>;
  },
): void {
  const { sql, workspaceRoot, requireAuth } = deps;

  // NOTE(多实例)：会话与待确认 token 都在内存。横向扩容时必须外置到
  // Redis 或数据库，否则用户的下一个请求打到另一个实例就找不到会话了。
  const sessions = new Map<string, { session: AgentSession; userId: string; touched: number }>();

  /**
   * 这个人能用的连接器，喂给模型的系统提示。
   *
   * 为什么是系统提示而不是再加一个工具：见 packages/agent/src/session.ts 里
   * buildSystemPrompt 的说明。拼装与 MCP 共用 services/connectors-available.ts
   * ——两处说法不一致时，模型会在"我记得的"和"我刚查到的"之间摇摆。
   */
  async function availableConnectors(userId: string): Promise<AvailableConnector[]> {
    const rows = await sql<ConnectorRow[]>`
      SELECT slug, name, catalog_id, user_id FROM ispace.connectors
       WHERE user_id = ${userId} OR user_id IS NULL
       ORDER BY user_id IS NULL, slug
    `;
    return availableFromRows(rows);
  }

  const pending = new Map<string, PendingDeploy>();

  /** 定期清理过期会话与 token，防止内存无限增长。 */
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.touched > 60 * 60 * 1000) sessions.delete(k);
    for (const [k, v] of pending) if (now - v.createdAt > CONFIRM_TTL_MS) pending.delete(k);
  }, 5 * 60 * 1000).unref();

  const makeToolCtx = (user: User, clientIp: string): ToolContext => ({
    ws: { root: join(workspaceRoot, user.username), username: user.username },
    platform: {
      async getQuota() {
        const q = await getQuota(sql, user.id);
        return [
          `静态空间 ${(q.storageBytesUsed / 1048576).toFixed(1)} MB / ${(q.storageBytesLimit / 1048576).toFixed(0)} MB`,
          `后端应用 ${q.backendCountUsed} / ${q.backendCountLimit} 个`,
          `数据行数 ${q.dbRowsUsed} / ${q.dbRowsLimit}`,
        ].join('\n');
      },
      async listApps() {
        const apps = await listAppsByOwner(sql, user.id);
        if (!apps.length) return '还没有已部署的应用。';
        return apps.map((a) => `${a.slug}  ${a.name}  ${a.status}`).join('\n');
      },
      async requestDeploy(site, summary) {
        // clientIp 由外层请求处理器捕获——这个闭包是给 Agent 工具集用的，
        // 调用时早已脱离 Fastify 的请求上下文。
        const confirmToken = randomBytes(16).toString('base64url');
        pending.set(confirmToken, { userId: user.id, site, summary, createdAt: Date.now() });
        await writeAudit(sql, {
          actorId: user.id, action: 'app.deploy', targetType: 'app', targetId: null,
          source: 'agent', result: 'success',
          metadata: { requested: true, site, summary },
          ip: clientIp,
        });
        return { confirmToken };
      },
    },
  });

  // ── 对话（SSE 流式）──────────────────────────────────────────────
  app.post(`${API_BASE}/agent/ask`, async (req, reply) => {
    const user = await requireAuth(req);
    /*
      原先这里按 identity 拦「非开发者」，配套的是壳设置里那个身份开关。
      现在手机端不再区分身份（对话是底部栏的一个 tab，人人可见），
      再拦就成了"点进去、打了字、发不出去"——用户没有任何办法自救，
      因为那个开关已经不存在了。

      能力边界仍在，只是换了把关的地方：Agent 的每个工具都以调用者身份
      执行，配额、归属、审计一个不少（见 makeToolCtx），发布还必须由人
      再点一次确认。
    */
    const input = askSchema.parse(req.body);

    let engine;
    try {
      engine = createEngine();
    } catch {
      throw new IspaceError(
        ERROR_CODES.ORCHESTRATOR_UNAVAILABLE,
        'Agent 未配置模型通道，请联系平台管理员。',
      );
    }

    const wsRoot = join(workspaceRoot, user.username);
    await mkdir(wsRoot, { recursive: true });

    const sid = input.sessionId ?? crypto.randomUUID();
    let entry = sessions.get(sid);
    if (entry && entry.userId !== user.id) {
      // 会话 id 是 uuid，猜中概率极低，但仍要校验——否则知道 id 的人
      // 能读到别人的对话历史
      throw new IspaceError(ERROR_CODES.NOT_OWNER, '这个会话不属于你');
    }
    if (!entry) {
      entry = {
        session: new AgentSession({
          engine, toolCtx: makeToolCtx(user, req.ip),
          connectors: await availableConnectors(user.id),
        }),
        userId: user.id,
        touched: Date.now(),
      };
      sessions.set(sid, entry);
    }
    entry.touched = Date.now();

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // 关掉网关缓冲，否则 SSE 会被攒着一起发，前端看不到逐字输出
      'x-accel-buffering': 'no',
    });
    const send = (e: SessionEvent | { type: 'session'; id: string }) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    send({ type: 'session', id: sid });

    // 重建 session 以带上本次的事件回调
    const session = new AgentSession({
      engine,
      toolCtx: makeToolCtx(user, req.ip),
      connectors: await availableConnectors(user.id),
      onEvent: send,
    });
    // 继承历史（除 system，构造时已有）
    session.messages.push(...entry.session.messages.slice(1));

    /*
      把对象作为一句前缀交给模型，而不是塞进 system。
      塞 system 会让整段历史都带着它，用户中途换了对象时，旧的那句还在
      上下文里跟新的打架。作为本轮的前缀，换了就自然只有新的生效。
    */
    const text = input.targetSlug
      ? `【本次要修改的是我已发布的页面 /${user.username}/${input.targetSlug}/，`
        + `发布时请沿用 site="${input.targetSlug}" 覆盖它，不要新建页面。】\n${input.text}`
      : input.text;

    try {
      await session.send(text, input.images);
      entry.session.messages.length = 0;
      entry.session.messages.push(...session.messages);
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  // ── 二次确认：手机端点「部署上线」后调这里 ────────────────────────
  app.post(`${API_BASE}/agent/confirm`, async (req) => {
    const user = await requireAuth(req);
    const { confirmToken } = z.object({ confirmToken: z.string().min(1) }).parse(req.body);

    const p = pending.get(confirmToken);
    if (!p) {
      throw new IspaceError(
        ERROR_CODES.NOT_FOUND,
        '确认令牌无效或已过期（有效期 10 分钟）。请让 Agent 重新发起发布请求。',
      );
    }
    if (p.userId !== user.id) {
      throw new IspaceError(ERROR_CODES.NOT_OWNER, '这个发布请求不属于你');
    }
    // 一次性：用掉即删，防止重放
    pending.delete(confirmToken);

    await writeAudit(sql, {
      actorId: user.id, action: 'app.deploy', targetType: 'app', targetId: null,
      source: 'agent', result: 'success',
      metadata: { confirmed: true, site: p.site, summary: p.summary },
      ip: req.ip,
    });

    return {
      ok: true,
      site: p.site,
      summary: p.summary,
      next: `已确认。请用 ai-deploy up 或 MCP 的 deploy 工具把工作区发布到 /${p.site}。`,
    };
  });

  // ── 待确认列表（手机端拉取）──────────────────────────────────────
  app.get(`${API_BASE}/agent/pending`, async (req) => {
    const user = await requireAuth(req);
    const items = [...pending.entries()]
      .filter(([, v]) => v.userId === user.id)
      .map(([token, v]) => ({ confirmToken: token, site: v.site, summary: v.summary, createdAt: v.createdAt }));
    return { items };
  });

  app.get(`${API_BASE}/agent/status`, async () => {
    let configured = true;
    let model = '';
    try { model = createEngine().model; } catch { configured = false; }
    return { configured, model, activeSessions: sessions.size };
  });
}
