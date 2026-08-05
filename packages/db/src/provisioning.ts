import type { Sql } from 'postgres';
import { ERROR_CODES, IspaceError, schemaNameFor } from '@ispace/contracts';

/**
 * 用户数据 schema 的开通与回收。
 *
 * ┌─ 顺序不可调换（计划 1 实测复现）────────────────────────────────────┐
 * │ 若把尚不存在的 schema 名写进 pgrst.db_schemas，PostgREST 加载       │
 * │ schema 缓存时报 3F000 "schema does not exist"，随即进入             │
 * │ 「重连 → 重载 → 再失败」循环，此期间 /rest/v1/* 对 **全部用户**     │
 * │ 返回 503。                                                          │
 * │                                                                     │
 * │ 即：一个新用户开通失败会打挂所有存量用户的数据接口。                 │
 * │ 因此 provisionUserSchema 必须先建 schema 并校验存在，再改配置；      │
 * │ deprovision 则完全相反。                                            │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 用库内配置（ALTER ROLE authenticator SET pgrst.db_schemas）而非
 * PGRST_DB_SCHEMAS 环境变量：后者要重启容器才生效，会打断所有存量用户的
 * 连接。库内配置 + NOTIFY 实测零重启（RestartCount 保持 0）。
 *
 * 两个 NOTIFY 通道职责不同，缺一不可：
 *   reload config —— 重读 pgrst.* 配置，决定暴露哪些 schema
 *   reload schema —— 重建 schema 缓存，决定认得哪些表
 * 只发前者，表查询会返回 PGRST205 "Could not find the table in the schema cache"。
 *
 * 详见 infra/dokploy/supabase.notes.md 第二节。
 */

const BASE_SCHEMAS = 'public,graphql_public';
const PGRST_ROLE = 'authenticator';

/** 读取当前 pgrst.db_schemas。未设置时返回基础值。 */
export async function currentExposedSchemas(sql: Sql): Promise<string[]> {
  const rows = await sql<{ v: string }[]>`
    SELECT split_part(s, '=', 2) AS v
      FROM pg_db_role_setting r
      JOIN pg_roles ro ON ro.oid = r.setrole
      CROSS JOIN LATERAL unnest(r.setconfig) AS s
     WHERE ro.rolname = ${PGRST_ROLE}
       AND s LIKE 'pgrst.db_schemas=%'
     LIMIT 1
  `;
  const raw = rows[0]?.v ?? BASE_SCHEMAS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function setExposedSchemas(sql: Sql, schemas: string[]): Promise<void> {
  // ALTER ROLE 不支持参数绑定，值必须内联。schemas 全部由 schemaNameFor()
  // 从已通过 usernameSchema 校验的用户名派生（仅 [a-z0-9_]），无注入面。
  // 这里再做一次形态断言，避免将来有人绕过 contracts 直接调用本函数。
  for (const s of schemas) {
    if (!/^[a-z_][a-z0-9_]*$/.test(s)) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        `非法 schema 名：${s}`,
      );
    }
  }
  await sql.unsafe(
    `ALTER ROLE ${PGRST_ROLE} SET pgrst.db_schemas = '${schemas.join(',')}'`,
  );
}

/** 双通道热加载。顺序无所谓，但两条都要发。 */
async function reloadPostgrest(sql: Sql): Promise<void> {
  await sql`NOTIFY pgrst, 'reload config'`;
  await sql`NOTIFY pgrst, 'reload schema'`;
}

/**
 * 开通一位用户的数据 schema。幂等：重复调用不报错、不重复追加。
 *
 * @returns 该用户的 schema 名
 */
export async function provisionUserSchema(sql: Sql, username: string): Promise<string> {
  const schema = schemaNameFor(username);

  // ── 1. 先建 schema 与授权 ────────────────────────────────────────
  // sql.unsafe 用于 DDL（标识符不能参数化）。schema 由已校验的用户名派生。
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated, service_role`);
  await sql.unsafe(
    `GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO anon, authenticated, service_role`,
  );
  await sql.unsafe(
    `GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO anon, authenticated, service_role`,
  );
  // 默认权限：用户之后新建的表自动可被 REST 访问，不必每次手工授权
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO anon, authenticated, service_role`,
  );
  await sql.unsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON SEQUENCES TO anon, authenticated, service_role`,
  );

  // ── 2. 校验存在。不通过就中止——继续下去会打挂全站 ──────────────
  const verify = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM information_schema.schemata
     WHERE schema_name = ${schema}
  `;
  if (verify[0]?.n !== 1) {
    throw new IspaceError(
      ERROR_CODES.PROVISION_VERIFY_FAILED,
      `schema ${schema} 创建后校验失败，已中止；继续修改 pgrst.db_schemas 会导致 PostgREST 对全部用户返回 503`,
      { schema },
    );
  }

  // ── 3. 追加进暴露列表（保留既有值，不可覆盖）──────────────────────
  const exposed = await currentExposedSchemas(sql);
  if (!exposed.includes(schema)) {
    await setExposedSchemas(sql, [...exposed, schema]);
  }

  // ── 4. 双通道热加载 ──────────────────────────────────────────────
  await reloadPostgrest(sql);

  return schema;
}

/**
 * 回收一位用户的数据 schema。顺序与开通完全相反。
 *
 * @param drop true 则物理删除 schema；false 只从暴露列表移除（冻结）。
 *   离职回收流程（规格 §6）默认冻结而非删除——导出后再删由管理员另行决定。
 */
export async function deprovisionUserSchema(
  sql: Sql,
  username: string,
  drop = false,
): Promise<void> {
  const schema = schemaNameFor(username);

  // ── 1. 先从暴露列表移除并重载配置 ────────────────────────────────
  // 必须先于 DROP。若先删 schema，PostgREST 会因 db_schemas 指向不存在的
  // schema 而进入重连循环，全站 503。
  const exposed = await currentExposedSchemas(sql);
  if (exposed.includes(schema)) {
    await setExposedSchemas(sql, exposed.filter((s) => s !== schema));
    await sql`NOTIFY pgrst, 'reload config'`;
  }

  // ── 2. 此时才可以删 ──────────────────────────────────────────────
  if (drop) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }

  await sql`NOTIFY pgrst, 'reload schema'`;
}

/** 统计用户 schema 下的总行数，用于配额。 */
export async function countUserRows(sql: Sql, username: string): Promise<number> {
  const schema = schemaNameFor(username);
  // 用 pg_class.reltuples 的估算值而非逐表 count(*)：后者在表多、行多时
  // 会拖慢控制台。配额是软限制，估算精度足够。
  const rows = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(GREATEST(c.reltuples, 0)), 0)::bigint AS total
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relkind = 'r'
  `;
  return Number(rows[0]?.total ?? 0);
}
