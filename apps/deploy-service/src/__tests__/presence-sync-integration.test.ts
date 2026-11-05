import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Sql } from '@ispace/db';

/**
 * 0038 迁移（presence + install_count 触发器自愈）的集成测试：
 * **对着真的 Postgres 跑**，不配库整文件跳过（同 events-integration 的约定）：
 *
 *   docker run -d --name pg -e POSTGRES_PASSWORD=pgtest -p 55432:5432 postgres:16-alpine
 *   ISPACE_TEST_PG='postgres://postgres:pgtest@127.0.0.1:55432/postgres' \
 *     pnpm --filter @ispace/deploy-service test
 *
 * ⚠️ DROP SCHEMA ispace CASCADE，只指测试库。
 *
 * 被测的是纯 SQL 行为——触发器在什么路径下醒来、计数是否跟上、presence
 * 窗口怎么算。假 sql 会把写错的语句原样咽下去，这些只有真库能验。
 */

const DSN = process.env.ISPACE_TEST_PG;
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, '../../../../packages/db/migrations');

function parseDsn(dsn: string) {
  const u = new URL(dsn);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    max: 4,
  };
}

describe.skipIf(!DSN)('0038 presence 与 install_count 自愈（真实 Postgres）', () => {
  let sql: Sql;
  let seq = 0;

  beforeAll(async () => {
    sql = createDb(parseDsn(DSN!));
    await sql.unsafe('DROP SCHEMA IF EXISTS ispace CASCADE');
    const ran = await runMigrations(sql, MIGRATIONS);
    expect(ran).toContain('0038_presence_and_install_sync.sql');
  });

  afterAll(async () => {
    await sql.unsafe('DROP SCHEMA IF EXISTS ispace CASCADE');
    await sql.end({ timeout: 5 });
  });

  /* username 要过 CHECK（^[a-z][a-z0-9-]*$），加序号保证彼此唯一 */
  const mkUser = (tag: string) =>
    sql`INSERT INTO ispace.users (sso_subject, username, display_name, role)
        VALUES (${`t-${Date.now()}-${seq}`}, ${`u${seq++}${tag}`}, ${tag}, 'employee')
        RETURNING id`.then((r) => r[0].id as string);

  const mkApp = (owner: string) =>
    sql`INSERT INTO ispace.apps (owner_id, slug, name, status)
        VALUES (${owner}, ${`a${seq++}`}, 'App', 'running')
        RETURNING id`.then((r) => r[0].id as string);

  const mkBackend = (owner: string) =>
    sql`INSERT INTO ispace.backends (owner_id, name, url_path, status)
        VALUES (${owner}, ${`be${seq++}`}, ${`/be${seq}`}, 'running')
        RETURNING id`.then((r) => r[0].id as string);

  const listingCount = async (appId: string) => {
    const [row] = await sql<{ install_count: number }[]>`
      SELECT install_count FROM ispace.marketplace_listings WHERE app_id = ${appId}`;
    return row?.install_count ?? -1;
  };

  it('触发器：任何路径 INSERT app_installs 都会把 listing 计数带新', async () => {
    const owner = await mkUser('own');
    const u1 = await mkUser('usr');
    const app = await mkApp(owner);
    await sql`INSERT INTO ispace.marketplace_listings (app_id, published_by) VALUES (${app}, ${owner})`;
    // 直接插 installs——模拟绕过 marketplace.ts 的任何写路径（如分享接受）
    await sql`INSERT INTO ispace.app_installs (app_id, user_id, source) VALUES (${app}, ${u1}, 'share')`;
    expect(await listingCount(app)).toBe(1);
  });

  it('触发器：DELETE 同步减；ON CONFLICT DO NOTHING 不触发（计数不变）', async () => {
    const owner = await mkUser('own');
    const u1 = await mkUser('usr');
    const app = await mkApp(owner);
    await sql`INSERT INTO ispace.marketplace_listings (app_id, published_by) VALUES (${app}, ${owner})`;
    await sql`INSERT INTO ispace.app_installs (app_id, user_id, source) VALUES (${app}, ${u1}, 'marketplace')`;
    await sql`INSERT INTO ispace.app_installs (app_id, user_id, source) VALUES (${app}, ${u1}, 'marketplace')
              ON CONFLICT (app_id, user_id) DO NOTHING`;
    expect(await listingCount(app)).toBe(1); // 幂等插入没多算
    await sql`DELETE FROM ispace.app_installs WHERE app_id = ${app}`;
    expect(await listingCount(app)).toBe(0);
  });

  it('触发器：backend_installs 同款自愈', async () => {
    const owner = await mkUser('own');
    const u1 = await mkUser('usr');
    const be = await mkBackend(owner);
    await sql`INSERT INTO ispace.marketplace_listings (backend_id, published_by) VALUES (${be}, ${owner})`;
    await sql`INSERT INTO ispace.backend_installs (backend_id, user_id) VALUES (${be}, ${u1})`;
    const [row] = await sql<{ install_count: number }[]>`
      SELECT install_count FROM ispace.marketplace_listings WHERE backend_id = ${be}`;
    expect(row!.install_count).toBe(1);
    await sql`DELETE FROM ispace.backend_installs WHERE backend_id = ${be}`;
    const [row2] = await sql<{ install_count: number }[]>`
      SELECT install_count FROM ispace.marketplace_listings WHERE backend_id = ${be}`;
    expect(row2!.install_count).toBe(0);
  });

  it('触发器：增量语义——脏值不会自愈，只按 ±1 走（愈合靠上架 SQL/回填）', async () => {
    const owner = await mkUser('own');
    const u1 = await mkUser('usr');
    const app = await mkApp(owner);
    await sql`INSERT INTO ispace.marketplace_listings (app_id, published_by, install_count)
              VALUES (${app}, ${owner}, 999)`;
    await sql`INSERT INTO ispace.app_installs (app_id, user_id, source) VALUES (${app}, ${u1}, 'share')`;
    expect(await listingCount(app)).toBe(1000); // 999 + 1：增量不做全量纠正
    await sql`DELETE FROM ispace.app_installs WHERE app_id = ${app}`;
    expect(await listingCount(app)).toBe(999); // 1000 - 1
    // 上架 SQL 的初始化分支才是全量愈合（marketplace.ts / visibility.ts）
    await sql`UPDATE ispace.marketplace_listings
                 SET install_count = (SELECT count(*) FROM ispace.app_installs i
                                       WHERE i.app_id = ${app}) WHERE app_id = ${app}`;
    expect(await listingCount(app)).toBe(0);
  });

  it('offboard 快照往返：DELETE RETURNING 存 jsonb、restore 用 jsonb_to_recordset 放回', async () => {
    const owner = await mkUser('own');   // 引用的目标页面作者
    const gone = await mkUser('gone');   // 离职者
    const app = await mkApp(owner);
    await sql`INSERT INTO ispace.marketplace_listings (app_id, published_by) VALUES (${app}, ${owner})`;
    await sql`INSERT INTO ispace.app_installs (app_id, user_id, source) VALUES (${app}, ${gone}, 'share')`;
    expect(await listingCount(app)).toBe(1);
    // 回收：快照 + 删
    const removed = await sql<{ app_id: string; user_id: string; source: string }[]>`
      DELETE FROM ispace.app_installs WHERE user_id = ${gone}
      RETURNING app_id, user_id, source`;
    expect(await listingCount(app)).toBe(0);
    // 恢复：按快照放回（JOIN apps 保外键安全，ON CONFLICT 幂等）
    const back = await sql`
      INSERT INTO ispace.app_installs (app_id, user_id, source)
      SELECT j.app_id, j.user_id, j.source
        FROM jsonb_to_recordset(${sql.json(removed)}::jsonb) AS j(app_id uuid, user_id uuid, source text)
        JOIN ispace.apps a ON a.id = j.app_id
      ON CONFLICT (app_id, user_id) DO NOTHING
      RETURNING 1`;
    expect(back.length).toBe(1);
    expect(await listingCount(app)).toBe(1);
  });

  it('presence：窗口内计数、过期不计、upsert 去重', async () => {
    const owner = await mkUser('own');
    const app = await mkApp(owner);
    await sql`INSERT INTO ispace.app_presence (app_id, visitor_key, last_seen_at)
              VALUES (${app}, 'u:a', now()), (${app}, 'a:xyz', now()),
                      (${app}, 'u:old', now() - interval '10 minutes')`;
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ispace.app_presence
       WHERE app_id = ${app} AND last_seen_at > now() - interval '90 seconds'`;
    expect(Number(row!.n)).toBe(2);
    await sql`INSERT INTO ispace.app_presence (app_id, visitor_key, last_seen_at)
              VALUES (${app}, 'u:a', now())
              ON CONFLICT (app_id, visitor_key) DO UPDATE SET last_seen_at = now()`;
    const [row2] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ispace.app_presence WHERE app_id = ${app}`;
    expect(Number(row2!.n)).toBe(3); // 仍是三行：u:a / a:xyz / u:old
  });

  it('presence：外键随应用删除级联清空', async () => {
    const owner = await mkUser('own');
    const app = await mkApp(owner);
    await sql`INSERT INTO ispace.app_presence (app_id, visitor_key) VALUES (${app}, 'u:x')`;
    await sql`DELETE FROM ispace.apps WHERE id = ${app}`;
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ispace.app_presence WHERE app_id = ${app}`;
    expect(Number(row!.n)).toBe(0);
  });
});
