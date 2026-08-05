import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';

export type { Sql };

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** 平台元数据所在 schema。用户业务数据在各自的 u_* schema，不受此影响。 */
  schema?: string;
  max?: number;
}

/**
 * 从环境变量读配置。生产环境的值来自目标机 `~/.ispace/supabase.env`，
 * 由 systemd/compose 注入，不写进仓库。
 */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const required = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`缺少环境变量 ${k}`);
    return v;
  };
  return {
    host: env.PGHOST ?? 'supabase-db',
    port: Number(env.PGPORT ?? 5432),
    database: env.PGDATABASE ?? 'postgres',
    user: env.PGUSER ?? 'postgres',
    password: required('POSTGRES_PASSWORD'),
    schema: env.ISPACE_SCHEMA ?? 'ispace',
    max: Number(env.PGPOOL_MAX ?? 10),
  };
}

export function createDb(cfg: DbConfig): Sql {
  return postgres({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    username: cfg.user,
    password: cfg.password,
    max: cfg.max ?? 10,
    // 平台自己的表在 ispace schema；provisioning 操作用户 schema 时
    // 一律写全限定名，不依赖 search_path。
    connection: { search_path: `${cfg.schema ?? 'ispace'},public` },
    // 与 authenticator 角色上的 statement_timeout=8s 保持同量级，
    // 避免控制台的聚合查询长时间占住连接
    idle_timeout: 30,
    onnotice: () => {},
  });
}

/**
 * 执行 migrations 目录下尚未应用的 .sql 文件。
 *
 * 有意做得很简单：单向、按文件名排序、记录在 ispace.schema_migrations。
 * 不支持回滚——回滚一个已经承载数据的 schema 变更靠脚本是不可靠的，
 * 真出问题应从备份恢复（规格 §14 已有每日异机备份要求）。
 */
export async function runMigrations(sql: Sql, migrationsDir: string): Promise<string[]> {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ispace`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ispace.schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM ispace.schema_migrations`).map((r) => r.name),
  );

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const content = readFileSync(join(migrationsDir, file), 'utf8');
    // 整个迁移在一个事务里，失败则整体回滚，不留半成品状态
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO ispace.schema_migrations (name) VALUES (${file})`;
    });
    ran.push(file);
  }
  return ran;
}
