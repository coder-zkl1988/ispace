import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, schemaNameFor, type User } from '@ispace/contracts';
import type { Sql } from '@ispace/db';

/**
 * 数据空间（设计稿「数据空间」屏）。
 *
 * 这一屏要回答两个具体问题：
 *   1. 我的数据在哪、怎么连上去？   → 连接信息
 *   2. 我用了多少、都有哪些表？     → 表清单与行数
 *
 * 没有这两块，那一屏就只剩"你的数据和同事隔离"两句说明，
 * 用户看不出它有什么用——实测反馈就是这个。
 */

export function registerDataSpaceRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    requireAuth: (req: FastifyRequest) => Promise<User>;
    publicBase: string;
  },
): void {
  const { sql, requireAuth, publicBase } = deps;

  /**
   * 表清单。
   *
   * 行数用 pg_class.reltuples（统计信息的估算值）而不是逐表 count(*)：
   * 后者在表多、行多时要全表扫描，一屏加载能拖到几秒。这里是"看个大概
   * 用了多少"的场景，估算值足够；配额判定另有 countUserRows 走精确路径。
   * reltuples 为 -1 表示还没 analyze 过，按 0 显示而不是显示 -1。
   */
  app.get(`${API_BASE}/data/tables`, async (req) => {
    const me = await requireAuth(req);
    const schema = schemaNameFor(me.username);

    const rows = await sql<
      { name: string; rows: string; rls: boolean; bytes: string; changed: Date | null }[]
    >`
      SELECT c.relname                                   AS name,
             GREATEST(c.reltuples, 0)::bigint::text      AS rows,
             c.relrowsecurity                            AS rls,
             pg_total_relation_size(c.oid)::text         AS bytes,
             GREATEST(s.last_autoanalyze, s.last_analyze) AS changed
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
       WHERE n.nspname = ${schema} AND c.relkind = 'r'
       ORDER BY c.relname
    `;

    return {
      schema,
      tables: rows.map((r) => ({
        name: r.name,
        rows: Number(r.rows),
        rowLevelSecurity: r.rls,
        bytes: Number(r.bytes),
        lastChangedAt: r.changed,
      })),
    };
  });

  /**
   * 连接信息。
   *
   * 只给 REST 端点与 schema 名，**不给数据库密码**。
   *
   * 用户的应用走 PostgREST（/supabase/rest/v1），凭据是 Supabase 的匿名
   * 公钥——那本来就是设计上要发到前端去的。真正的库密码留在服务端，
   * 一旦从这里发出去，任何人拿到就能跨 schema 读全平台的数据，
   * 而按 schema 的隔离全靠 PostgREST 那层在守。
   */
  app.get(`${API_BASE}/data/connection`, async (req) => {
    const me = await requireAuth(req);
    return {
      schema: schemaNameFor(me.username),
      restUrl: `${publicBase}/supabase/rest/v1`,
      anonKey: process.env.SUPABASE_ANON_KEY ?? null,
      /** 供前端拼一段可直接粘贴的初始化代码。 */
      note: '你的应用用这套信息读写自己的数据。库密码不下发——按 schema 的隔离靠这一层守着。',
    };
  });
}
