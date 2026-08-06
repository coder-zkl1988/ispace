import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  API_BASE, CONNECTOR_CATALOG, createConnectorSchema, ERROR_CODES, IspaceError,
  type AuthKind, type ConnectorView, type User,
} from '@ispace/contracts';
import { writeAudit, type Sql } from '@ispace/db';
import {
  ConnectorKeyMissing, decryptSecret, encryptSecret, secretStorageReady,
} from '../services/connector-secret.js';
import {
  assertOutboundAllowed, guardedRequest, OutboundBlocked, resolveTarget,
} from '../services/outbound-guard.js';

/**
 * 连接器：页面调外部 API 的统一入口（见 migrations/0008_connectors.sql）。
 *
 * ┌─ 一条要讲清楚的限制 ────────────────────────────────────────────────┐
 * │ 代理按**调用者**解析连接器：先找他自己的，再回落到平台共享的。       │
 * │ 于是「用了个人连接器的页面分享给同事」会在同事那边失败。             │
 * │                                                                      │
 * │ 换成"按页面所有者解析"能解决这个，但要先回答"这次请求是从谁的哪个    │
 * │ 页面发起的"——Referer 可伪造，把 owner 写进路径同样可伪造，真做对    │
 * │ 需要给每个页面签发一个作用域令牌。那是另一件事。                      │
 * │                                                                      │
 * │ 现在的规矩简单且能讲：**要给同事用的页面，用管理员发布的共享连接器**。│
 * │ 失败时的报错直接把这句话说出来，而不是甩一个 404。                    │
 * └──────────────────────────────────────────────────────────────────────┘
 */

interface Row {
  id: string; user_id: string | null; slug: string; name: string;
  base_url: string; auth_kind: AuthKind; auth_name: string | null;
  secret_enc: Buffer | null; catalog_id: string | null;
  call_count: string; last_used_at: Date | null; created_at: Date;
}

function toView(r: Row): ConnectorView {
  return {
    id: r.id, slug: r.slug, name: r.name, baseUrl: r.base_url,
    authKind: r.auth_kind, authName: r.auth_name,
    hasSecret: r.secret_enc !== null,
    catalogId: r.catalog_id,
    shared: r.user_id === null,
    callCount: Number(r.call_count),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

/** 上游响应里不能原样回吐的头。 */
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  // 上游的 CORS 头会覆盖我们自己的同源语义，且可能比我们更宽松
  'access-control-allow-origin', 'access-control-allow-credentials',
  'set-cookie', 'strict-transport-security',
]);

/** 允许透传到上游的请求头。白名单而不是黑名单——漏一个黑名单项就是一次凭据泄漏。 */
const PASS_REQUEST_HEADERS = new Set(['accept', 'content-type', 'accept-language']);

export function registerConnectorRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    requireAuth: (req: FastifyRequest) => Promise<User>;
    requireAdmin: (req: FastifyRequest) => Promise<User>;
  },
): void {
  const { sql, requireAuth, requireAdmin } = deps;

  /**
   * 内网目标是否放行。默认关闭。
   *
   * 公司内部 ERP 长在 192.168 段里是常态，所以这个口子有真实需求；但它一旦
   * 默认开着，任何登录用户都能拿平台去打 Dokploy 控制台和数据库。
   * 只能由管理员在服务器上显式打开，且写在 .env.example 里带着后果说明。
   */
  const allowPrivate = process.env.ISPACE_CONNECTOR_ALLOW_PRIVATE === '1';

  // ── 目录 ────────────────────────────────────────────────────────
  // 静态数据，但仍走接口而不是让前端各打包一份：将来管理员要能增删条目。
  app.get(`${API_BASE}/connectors/catalog`, async (req) => {
    await requireAuth(req);
    return { catalog: CONNECTOR_CATALOG, secretStorageReady: secretStorageReady() };
  });

  // ── 我能用的连接器 ──────────────────────────────────────────────
  app.get(`${API_BASE}/connectors`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql<Row[]>`
      SELECT * FROM ispace.connectors
       WHERE user_id = ${me.id} OR user_id IS NULL
       ORDER BY user_id IS NULL, slug
    `;
    return { connectors: rows.map(toView) };
  });

  // ── 新建 ────────────────────────────────────────────────────────
  app.post(`${API_BASE}/connectors`, async (req, reply) => {
    const me = await requireAuth(req);
    const input = createConnectorSchema.parse(req.body);

    if (input.shared && me.role !== 'admin') {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '只有管理员能发布全员共享的连接器。');
    }
    // 登记时就校验一次：让人在填表当场知道这个地址不行，
    // 而不是等页面上线之后才发现每次调用都失败。
    try {
      await assertOutboundAllowed(input.baseUrl, { allowPrivate });
    } catch (e) {
      if (e instanceof OutboundBlocked) {
        throw new IspaceError(ERROR_CODES.INVALID_INPUT, e.message);
      }
      throw e;
    }

    let secretEnc: Buffer | null = null;
    if (input.secret) {
      try {
        secretEnc = encryptSecret(input.secret);
      } catch (e) {
        if (e instanceof ConnectorKeyMissing) {
          throw new IspaceError(ERROR_CODES.NOT_IMPLEMENTED, e.message);
        }
        throw e;
      }
    }

    const owner = input.shared ? null : me.id;
    const dup = await sql<{ id: string }[]>`
      SELECT id FROM ispace.connectors
       WHERE slug = ${input.slug}
         AND user_id IS NOT DISTINCT FROM ${owner}
    `;
    if (dup.length) {
      throw new IspaceError(
        ERROR_CODES.ALREADY_EXISTS,
        `已经有一个叫「${input.slug}」的连接器了。换个名字，或先删掉旧的。`,
      );
    }

    const rows = await sql<Row[]>`
      INSERT INTO ispace.connectors
        (user_id, slug, name, base_url, auth_kind, auth_name, secret_enc, catalog_id, created_by)
      VALUES (${owner}, ${input.slug}, ${input.name}, ${input.baseUrl},
              ${input.authKind}, ${input.authName ?? null}, ${secretEnc},
              ${input.catalogId ?? null}, ${me.id})
      RETURNING *
    `;
    await writeAudit(sql, {
      actorId: me.id, action: 'connector.create', targetType: 'connector',
      targetId: rows[0]!.id, source: 'console', result: 'success',
      // 记地址不记凭据。出了事要能回答"谁开了一条通往哪里的口子"。
      metadata: { slug: input.slug, baseUrl: input.baseUrl, shared: input.shared },
      ip: req.ip,
    });
    return reply.status(201).send({ connector: toView(rows[0]!) });
  });

  // ── 删除 ────────────────────────────────────────────────────────
  app.delete(`${API_BASE}/connectors/:id`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await sql<Row[]>`SELECT * FROM ispace.connectors WHERE id = ${id}`;
    const c = rows[0];
    if (!c) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个连接器。');
    if (c.user_id === null && me.role !== 'admin') {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '共享连接器只有管理员能删。');
    }
    if (c.user_id !== null && c.user_id !== me.id) {
      throw new IspaceError(ERROR_CODES.NOT_OWNER, '这不是你的连接器。');
    }
    await sql`DELETE FROM ispace.connectors WHERE id = ${id}`;
    await writeAudit(sql, {
      actorId: me.id, action: 'connector.delete', targetType: 'connector',
      targetId: id, source: 'console', result: 'success',
      metadata: { slug: c.slug }, ip: req.ip,
    });
    return { ok: true };
  });

  // ── 代理 ────────────────────────────────────────────────────────
  /**
   * 页面实际调用的就是这个。`/connect/{slug}/剩下的路径?查询`。
   *
   * 三道关卡：
   *   1. 解析连接器（个人优先于共享）
   *   2. 目标必须落在 base_url 前缀内（挡路径穿越与"同主机换个路径"）
   *   3. 地址合法性在 socket 的 lookup 钩子里判——判过的地址就是连过去的
   *      那一个，没有"先检查后使用"的缝。见 outbound-guard.ts。
   */
  app.all(`${API_BASE}/connect/:slug/*`, connectHandler);
  // 没有子路径的形态：/connect/{slug} 直接打 base_url 本身
  app.all(`${API_BASE}/connect/:slug`, connectHandler);

  async function connectHandler(req: FastifyRequest, reply: FastifyReply) {
    const me = await requireAuth(req);
    const { slug } = req.params as { slug: string };
    const rest = (req.params as Record<string, string>)['*'] ?? '';

    // 个人优先。ORDER BY user_id IS NULL 把非空排在前面（false < true）
    const rows = await sql<Row[]>`
      SELECT * FROM ispace.connectors
       WHERE slug = ${slug} AND (user_id = ${me.id} OR user_id IS NULL)
       ORDER BY user_id IS NULL
       LIMIT 1
    `;
    /*
      查不到登记记录时，回落到内置目录里**免密钥**的那些。

      为什么必须有这条回落：免密钥的接口本来就不需要任何凭据，"登记"对它们
      只是一次仪式。而 agent 写页面时没法替用户去点那一下——它只能在提示里
      写"请先去控制台登记一个天气连接器"，用户的一句"做个天气页面"就此变成
      一趟往返。既然平台已经实测过这些接口连得通，就该让它们开箱可用。

      只回落 authKind === 'none'：需要 key 的必须登记，因为 key 得有人填。
    */
    const builtin = CONNECTOR_CATALOG.find((x) => x.id === slug && x.authKind === 'none');
    const c: Pick<Row, 'id' | 'base_url' | 'auth_kind' | 'auth_name' | 'secret_enc'> | undefined =
      rows[0] ?? (builtin
        ? {
            id: builtin.id, base_url: builtin.baseUrl,
            auth_kind: 'none' as AuthKind, auth_name: null, secret_enc: null,
          }
        : undefined);
    if (!c) {
      throw new IspaceError(
        ERROR_CODES.NOT_FOUND,
        `你这边没有叫「${slug}」的连接器。`
        + '如果这个页面是别人分享给你的，那它用的是作者的个人连接器——'
        + '个人连接器只在作者自己打开时有效。请页面作者改用管理员发布的共享连接器。',
      );
    }
    // 回落进来的没有数据库行，用量统计里也就没有它。审计仍然照记
    const isBuiltin = !rows[0];

    const qs = req.raw.url?.includes('?') ? `?${req.raw.url.split('?').slice(1).join('?')}` : '';
    let target: URL;
    try {
      // 只校验路径前缀。地址合法性不在这里判——放在 socket 的 lookup 钩子里，
      // 那才是"判过的地址就是连过去的地址"，见 outbound-guard.ts 的说明。
      target = resolveTarget(c.base_url, rest, qs);
    } catch (e) {
      if (e instanceof OutboundBlocked) {
        await writeAudit(sql, {
          actorId: me.id, action: 'connector.call', targetType: 'connector',
          ...(isBuiltin ? {} : { targetId: c.id }), source: 'console', result: 'blocked',
          metadata: { slug, reason: e.message }, ip: req.ip,
        });
        throw new IspaceError(ERROR_CODES.INVALID_INPUT, e.message);
      }
      throw e;
    }

    // 凭据注入。到这一步为止，请求里还完全没有凭据的影子。
    const headers: Record<string, string> = { 'user-agent': 'iSpace-Connector/1.0' };
    for (const [k, v] of Object.entries(req.headers)) {
      if (PASS_REQUEST_HEADERS.has(k) && typeof v === 'string') headers[k] = v;
    }
    if (c.secret_enc) {
      const secret = decryptSecret(c.secret_enc);
      if (c.auth_kind === 'bearer') headers.authorization = `Bearer ${secret}`;
      else if (c.auth_kind === 'header' && c.auth_name) headers[c.auth_name.toLowerCase()] = secret;
      else if (c.auth_kind === 'query' && c.auth_name) target.searchParams.set(c.auth_name, secret);
    }

    const method = req.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD' && req.body !== undefined;

    let upstream;
    try {
      upstream = await guardedRequest(target, {
        method, headers, allowPrivate,
        ...(hasBody
          ? { body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body) }
          : {}),
      });
    } catch (e) {
      // 被闸门拦下与上游本身出问题，是两件事，给用户的话也不一样
      const blocked = e instanceof OutboundBlocked;
      await writeAudit(sql, {
        actorId: me.id, action: 'connector.call', targetType: 'connector',
        ...(isBuiltin ? {} : { targetId: c.id }),
        source: 'console', result: blocked ? 'blocked' : 'failed',
        metadata: { slug, host: target.host, ...(blocked ? { reason: e.message } : {}) },
        ip: req.ip,
      });
      if (blocked) throw new IspaceError(ERROR_CODES.INVALID_INPUT, e.message);
      throw new IspaceError(
        ERROR_CODES.UPSTREAM_ERROR,
        `连接 ${target.host} 失败：${e instanceof Error ? e.message : String(e)}。`
        + '可能是对方挂了、这台服务器访问不到它，或者超时。',
      );
    }

    // 计数不阻塞返回：统计写不进去不该让用户的请求跟着失败。
    // 回落到内置目录的没有数据库行，跳过——c.id 那时是目录 id 不是 uuid，
    // 拿它去 WHERE id = 会直接抛类型错误。
    if (!isBuiltin) {
      void sql`
        UPDATE ispace.connectors
           SET call_count = call_count + 1, last_used_at = now()
         WHERE id = ${c.id}
      `.catch(() => { /* 用量统计而已，丢一次无所谓 */ });
    }
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (v !== undefined && !DROP_RESPONSE_HEADERS.has(k.toLowerCase())) reply.header(k, v);
    }
    reply.status(upstream.status);
    return reply.send(upstream.body);
  }

  // ── 管理员：谁开了哪些口子 ──────────────────────────────────────
  app.get(`${API_BASE}/admin/connectors`, async (req) => {
    await requireAdmin(req);
    const rows = await sql<(Row & { owner: string | null })[]>`
      SELECT c.*, u.username AS owner
        FROM ispace.connectors c
        LEFT JOIN ispace.users u ON u.id = c.user_id
       ORDER BY c.user_id IS NULL DESC, c.call_count DESC
    `;
    return {
      connectors: rows.map((r) => ({ ...toView(r), owner: r.owner })),
      allowPrivate,
    };
  });
}
