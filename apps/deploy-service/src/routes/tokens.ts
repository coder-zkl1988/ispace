import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { getPlatformPolicy, writeAudit, type Sql } from '@ispace/db';
import { z } from 'zod';

/**
 * 个人访问令牌（MCP 与 CLI 用）。
 *
 * ┌─ 为什么必须有这个 ──────────────────────────────────────────────────┐
 * │ MCP 客户端通过 HTTP 头携带凭据，没有浏览器会话。原先只能让用户从     │
 * │ cookie 里抠 session token——既难操作，又因会话 12 小时过期而要反复    │
 * │ 重做。这直接导致「同事接上 MCP 就能用」这条验收过不了。              │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 只存哈希不存明文：库被读走时无法据此冒充用户。明文仅在创建时返回一次。
 */

const TOKEN_PREFIX = 'isp_';

export function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

const createSchema = z.object({
  name: z.string().min(1).max(48).default('MCP'),
  /** 有效期天数。省略即长期有效——内部平台的 MCP 配置不该每月失效一次。 */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export function registerTokenRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; requireAuth: (req: FastifyRequest) => Promise<User> },
): void {
  const { sql, requireAuth } = deps;

  app.get(`${API_BASE}/tokens`, async (req) => {
    const me = await requireAuth(req);
    const rows = await sql`
      SELECT id, name, token_prefix, last_used_at, expires_at, created_at
        FROM ispace.access_tokens
       WHERE user_id = ${me.id} AND revoked_at IS NULL
       ORDER BY created_at DESC
    `;
    return { tokens: rows };
  });

  app.post(`${API_BASE}/tokens`, async (req) => {
    const me = await requireAuth(req);
    const input = createSchema.parse(req.body ?? {});

    // 32 字节随机足够；base64url 无需转义，可直接放进 HTTP 头与命令行
    const plain = TOKEN_PREFIX + randomBytes(32).toString('base64url');

    /*
      平台可以给令牌设有效期上限（0 = 不限）。用户填的天数会被夹到上限内，
      没填则直接用上限——「不填就长期有效」在设了上限的平台上是个漏洞。
      只影响新建的令牌：追改已发出去的会让人在毫无预兆的情况下发布失败。
    */
    const { tokenMaxDays } = await getPlatformPolicy(sql);
    const days = tokenMaxDays > 0
      ? Math.min(input.expiresInDays ?? tokenMaxDays, tokenMaxDays)
      : input.expiresInDays;
    const expires = days ? new Date(Date.now() + days * 86400_000) : null;

    const rows = await sql`
      INSERT INTO ispace.access_tokens (user_id, name, token_hash, token_prefix, expires_at)
      VALUES (${me.id}, ${input.name}, ${hashToken(plain)}, ${plain.slice(0, 12)}, ${expires})
      RETURNING id, name, token_prefix, created_at, expires_at
    `;

    await writeAudit(sql, {
      actorId: me.id, action: 'user.provision', targetType: 'token',
      targetId: (rows[0] as { id: string }).id,
      source: 'console', result: 'success', metadata: { name: input.name, created: true },
      ip: req.ip,
    });

    return {
      token: rows[0],
      // 明文只返回这一次
      plaintext: plain,
      warning: '这串令牌只显示这一次，请立即复制保存。丢失只能重新创建。',
    };
  });

  app.delete(`${API_BASE}/tokens/:id`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await sql`
      UPDATE ispace.access_tokens SET revoked_at = now()
       WHERE id = ${id} AND user_id = ${me.id} AND revoked_at IS NULL
      RETURNING id
    `;
    if (!rows[0]) throw new IspaceError(ERROR_CODES.NOT_FOUND, '令牌不存在或已撤销');
    return { ok: true };
  });
}

/**
 * 用访问令牌换用户。供鉴权中间件在 session JWT 之外多认一种凭据。
 *
 * 顺带更新 last_used_at：用户需要知道哪个令牌还在被用、哪个可以撤销。
 * 更新用 fire-and-forget，不阻塞请求——它失败不该让 API 调用失败。
 */
export async function findUserByAccessToken(
  sql: Sql,
  plain: string,
): Promise<{ userId: string } | null> {
  if (!plain.startsWith(TOKEN_PREFIX)) return null;
  const rows = await sql<{ id: string; user_id: string }[]>`
    SELECT id, user_id FROM ispace.access_tokens
     WHERE token_hash = ${hashToken(plain)}
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
  `;
  const row = rows[0];
  if (!row) return null;
  void sql`UPDATE ispace.access_tokens SET last_used_at = now() WHERE id = ${row.id}`.catch(() => {});
  return { userId: row.user_id };
}
