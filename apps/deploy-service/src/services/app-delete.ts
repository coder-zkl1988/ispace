import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { findApp, writeAudit, type Sql } from '@ispace/db';
import { siteLink, type StorageConfig } from '@ispace/storage';

/**
 * 删除页面。
 *
 * 抽成服务是为了让控制台（REST）与 AI（MCP）走同一条路——与 createBackend
 * 同一个理由：删除有次序要求（引用 → 版本 → 应用 → 磁盘 → 配额），
 * 两边各写一份的话，迟早有一边漏掉某一步，而漏掉的那步不会报错，
 * 只会留下垃圾（占着配额的产物、别人列表里点不开的入口）。
 *
 * ⚠️ 这是平台上少数**真正不可恢复**的操作：产物、历史版本、发布记录
 * 一并消失。「离职回收」有意做成只停用不删除，正是因为那类操作事后常常
 * 要还原；而这个是用户对自己页面的显式删除，语义就是"不要了"。
 * 所以调用方必须先让用户确认，服务层不替他决定。
 */

export interface DeleteAppDeps {
  sql: Sql;
  storage: StorageConfig;
  log?: { warn: (msg: string) => void };
}

export interface DeleteAppOutcome {
  slug: string;
  name: string;
  /** 一并删掉的历史版本数，回给用户看，让"删掉了什么"有个量感。 */
  releases: number;
  /** 释放的空间。删完配额要跟着降，否则用户删了半天用量纹丝不动。 */
  freedBytes: number;
  /** 磁盘产物是否真的清掉了。清不掉不阻断删除，但要如实说。 */
  filesRemoved: boolean;
}

export async function deleteApp(
  deps: DeleteAppDeps,
  input: { user: User; slug: string; source: 'console' | 'mcp' | 'cli'; clientIp?: string | null },
): Promise<DeleteAppOutcome> {
  const { sql, storage, log } = deps;
  const { user, slug } = input;

  const app = await findApp(sql, user.id, slug);
  if (!app) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到页面 /${slug}`);

  const [agg] = await sql<{ n: string; bytes: string }[]>`
    SELECT count(*)::text AS n, COALESCE(sum(size_bytes), 0)::text AS bytes
      FROM ispace.releases WHERE app_id = ${app.id}
  `;
  const releases = Number(agg?.n ?? 0);

  /*
    顺序有讲究，每一步都是"别人指向我"的引用：
    先断引用，再删版本，最后删应用本身。反过来会撞外键。
  */
  await sql`DELETE FROM ispace.app_installs WHERE app_id = ${app.id}`;
  await sql`DELETE FROM ispace.marketplace_listings WHERE app_id = ${app.id}`;
  await sql`DELETE FROM ispace.shares WHERE app_id = ${app.id}`;
  // 后端可以挂在页面名下。页面没了，那条关联要断开，但**不删后端**——
  // 它有自己的容器与访问地址，删页面不该顺手把它也停了。
  await sql`UPDATE ispace.backends SET app_id = NULL WHERE app_id = ${app.id}`;
  // apps.current_release_id 指着 releases，先解开再删版本
  await sql`UPDATE ispace.apps SET current_release_id = NULL WHERE id = ${app.id}`;
  await sql`DELETE FROM ispace.releases WHERE app_id = ${app.id}`;
  await sql`DELETE FROM ispace.apps WHERE id = ${app.id}`;

  /*
    磁盘产物。

    清不掉不回滚数据库：库里已经删了，再抛异常只会让用户看到"删除失败"，
    然后再点一次——而第二次会因为找不到应用而报 404，他就彻底困住了。
    如实记一笔告警，让管理员事后清理，比把用户卡死好。
  */
  let filesRemoved = true;
  for (const dir of [
    siteLink(storage, user.username, slug),
    join(storage.releasesRoot, user.username, slug),
  ]) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (e) {
      filesRemoved = false;
      log?.warn(`删除 ${dir} 失败，需要人工清理：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /*
    配额跟着降。不降的话用户删了半天，「配额与用量」纹丝不动——
    他会以为没删掉，然后再删一次。
    用 GREATEST 兜底：统计口径若有偏差，宁可少减也不能减成负数。
  */
  await sql`
    UPDATE ispace.quotas
       SET storage_bytes_used = GREATEST(storage_bytes_used - ${Number(agg?.bytes ?? 0)}, 0),
           updated_at = now()
     WHERE user_id = ${user.id}
  `;

  await writeAudit(sql, {
    actorId: user.id, action: 'app.delete', targetType: 'app', targetId: app.id,
    source: input.source, result: 'success',
    metadata: { slug, name: app.name, releases, filesRemoved },
    ip: input.clientIp ?? null,
  });

  return {
    slug,
    name: app.name,
    releases,
    freedBytes: Number(agg?.bytes ?? 0),
    filesRemoved,
  };
}
