import { schemaNameFor } from '@ispace/contracts';
import { writeAudit, type Sql } from '@ispace/db';
import type { Orchestrator } from '@ispace/orchestrator';

/**
 * 离职回收（设计稿「员工与开通」的四步）。
 *
 * 此前那个「离职回收」按钮只把 users.status 改成 archived，四步一步没做：
 * 页面还在跑、后端容器还在吃 CPU、数据 schema 还挂在 PostgREST 上、
 * 空间路径可以立刻被分配给新人（于是新人接手了别人页面的 URL）。
 *
 * 设计稿的四步：
 *   1. 静态页面归档   —— 停止对外服务，产物保留
 *   2. 后端应用停止   —— 解除资源占用
 *   3. 数据空间冻结   —— 从 PostgREST 摘除，schema 保留只读
 *   4. 空间路径冷冻   —— 冷冻期内不可重新分配
 *
 * ⚠️ 这四步都**不删任何东西**。离职回收常常紧跟着"她那个周报工具还得用，
 * 能不能恢复"，删了就真的回不来了。回收 = 停用 + 冻结，不是删除。
 */

export type OffboardStep = 'apps' | 'backends' | 'data' | 'path';

export interface StepResult {
  step: OffboardStep;
  ok: boolean;
  note: string;
}

/** 路径冷冻多少天。与设计稿「进入 90 天冷冻期，到期后可重新分配」一致。 */
export const PATH_FREEZE_DAYS = 90;

export async function offboardUser(deps: {
  sql: Sql;
  orchestrator: Orchestrator;
  adminId: string;
  userId: string;
  clientIp?: string | null;
  log?: { warn: (msg: string) => void };
}): Promise<{ runId: string; steps: StepResult[]; status: string }> {
  const { sql, orchestrator, adminId, userId, clientIp, log } = deps;

  const [user] = await sql<{ username: string; status: string }[]>`
    SELECT username, status FROM ispace.users WHERE id = ${userId}
  `;
  if (!user) throw new Error('用户不存在');

  const [run] = await sql<{ id: string }[]>`
    INSERT INTO ispace.offboard_runs (user_id, started_by) VALUES (${userId}, ${adminId})
    RETURNING id
  `;
  const runId = run!.id;
  const steps: StepResult[] = [];

  /**
   * 每一步单独 try。
   *
   * 一步失败不该让后面的都不做：停容器失败（编排器抽风）不影响冻结数据空间，
   * 而"CPU 还被占着"和"数据还对外可读"是两个独立的风险。
   * 全或无在这里是错的选择——它会让一次网络抖动变成"什么都没回收"。
   */
  const run1 = async (step: OffboardStep, fn: () => Promise<string>) => {
    try {
      steps.push({ step, ok: true, note: await fn() });
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      steps.push({ step, ok: false, note });
      log?.warn(`离职回收 ${user.username} 的 ${step} 步失败：${note}`);
    }
    await sql`
      UPDATE ispace.offboard_runs SET steps = ${sql.json(steps as never)} WHERE id = ${runId}
    `;
  };

  // ── 1. 静态页面归档 ────────────────────────────────────────────────
  await run1('apps', async () => {
    const rows = await sql<{ id: string }[]>`
      UPDATE ispace.apps SET status = 'stopped', updated_at = now()
       WHERE owner_id = ${userId} AND status <> 'stopped'
      RETURNING id
    `;
    // 同时从市场撤下并清掉别人的引用，否则同事列表里留着点不开的入口
    await sql`
      DELETE FROM ispace.marketplace_listings
       WHERE app_id IN (SELECT id FROM ispace.apps WHERE owner_id = ${userId})
    `;
    await sql`
      DELETE FROM ispace.app_installs
       WHERE app_id IN (SELECT id FROM ispace.apps WHERE owner_id = ${userId})
    `;
    await sql`
      UPDATE ispace.shares SET status = 'revoked', responded_at = now()
       WHERE from_user_id = ${userId} AND status IN ('pending','accepted')
    `;
    return `${rows.length} 个页面已停用，产物保留可恢复`;
  });

  // ── 2. 后端应用停止 ────────────────────────────────────────────────
  await run1('backends', async () => {
    const backends = await sql<{ id: string; orchestrator_ref: string | null; url_path: string }[]>`
      SELECT id, orchestrator_ref, url_path FROM ispace.backends
       WHERE owner_id = ${userId} AND status = 'running'
    `;
    let stopped = 0;
    for (const b of backends) {
      if (b.orchestrator_ref) {
        // remove 而不是 restart：目的是把资源还回去
        await orchestrator.remove({ id: b.orchestrator_ref, urlPath: b.url_path });
      }
      await sql`UPDATE ispace.backends SET status = 'stopped' WHERE id = ${b.id}`;
      stopped++;
    }
    await sql`
      UPDATE ispace.quotas SET backend_count_used = 0, updated_at = now()
       WHERE user_id = ${userId}
    `;
    return stopped ? `${stopped} 个后端已停止并解绑` : '没有运行中的后端';
  });

  // ── 3. 数据空间冻结 ────────────────────────────────────────────────
  await run1('data', async () => {
    const schema = schemaNameFor(user.username);

    /*
      ⚠️ 顺序不能反：必须**先**把 schema 从 PostgREST 的暴露列表里摘掉，
      再动权限。反过来做的话，PostgREST 会指着一个读不了的 schema，
      整个平台的数据接口一起 500——所有人的应用同时挂掉。
      这条在 05-provision-user-schema.sh 里也写着，是同一个坑的两端。

      ⚠️ 必须从 pg_db_role_setting 读，不能读 pg_settings。
      pgrst.db_schemas 是挂在 authenticator **角色**上的设置，
      而 pg_settings 反映的是**当前会话**的值——服务端连的是 postgres，
      那里查不到这一条，返回空。拿空列表回写就等于把所有人的 schema
      一起摘掉，全平台的数据接口同时挂掉。实测确认过：pg_settings 这条查询
      在服务端连接下返回 0 行。
    */
    const [cur] = await sql<{ v: string | null }[]>`
      SELECT split_part(c, '=', 2) AS v
        FROM pg_db_role_setting s
        JOIN pg_roles r ON r.oid = s.setrole,
             unnest(s.setconfig) AS c
       WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%'
       LIMIT 1
    `;
    const list = (cur?.v ?? '')
      .split(',').map((x) => x.trim()).filter((x) => x && x !== schema);

    /*
      读不到就直接放弃这一步，不写回。
      "读不到" 只可能是查询写错了或权限变了，而在这种状态下回写
      等于把暴露列表清空——宁可这一步失败留给管理员处理，
      也不能把全平台的数据接口弄挂。
    */
    if (!cur?.v) {
      throw new Error(
        '读不到 authenticator 的 pgrst.db_schemas，已跳过摘除以免误清空列表。'
        + '请在服务器上手工确认后再重跑。',
      );
    }

    await sql.unsafe(
      `ALTER ROLE authenticator SET pgrst.db_schemas = '${list.join(', ')}'`,
    );
    await sql`SELECT pg_notify('pgrst', 'reload config')`;
    await sql`SELECT pg_notify('pgrst', 'reload schema')`;

    // 摘除之后再收权限。schema 本身与数据一律保留——回收不是删除。
    await sql.unsafe(`REVOKE ALL ON SCHEMA "${schema}" FROM PUBLIC`);
    await sql.unsafe(
      `REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM "role_${user.username.replace(/-/g, '_')}"`,
    ).catch(() => undefined);

    return `${schema} 已从数据接口摘除，表与数据完整保留`;
  });

  // ── 4. 空间路径冷冻 ────────────────────────────────────────────────
  const frozenUntil = await sql<{ t: Date }[]>`
    SELECT (now() + ${`${PATH_FREEZE_DAYS} days`}::interval) AS t
  `;
  await run1('path', async () => {
    await sql`
      UPDATE ispace.users SET status = 'archived', archived_at = now() WHERE id = ${userId}
    `;
    await sql`
      UPDATE ispace.offboard_runs SET path_frozen_until = ${frozenUntil[0]!.t} WHERE id = ${runId}
    `;
    return `/${user.username} 冷冻 ${PATH_FREEZE_DAYS} 天，期间不可重新分配`;
  });

  const okCount = steps.filter((x) => x.ok).length;
  const status = okCount === steps.length ? 'done' : okCount === 0 ? 'failed' : 'partial';
  await sql`
    UPDATE ispace.offboard_runs
       SET status = ${status}, finished_at = now(), steps = ${sql.json(steps as never)}
     WHERE id = ${runId}
  `;

  await writeAudit(sql, {
    actorId: adminId, action: 'user.archive', targetType: 'user', targetId: userId,
    source: 'console', result: status === 'done' ? 'success' : 'failed',
    metadata: { username: user.username, steps, runId },
    ip: clientIp ?? null,
  });

  return { runId, steps, status };
}

/**
 * 这个空间标识现在能不能分配给新人。
 *
 * 冷冻期存在的理由很具体：老员工发出去的链接（企微里的、别人收藏的）
 * 还指着 /{username}/。冷冻期一过就把它分给新人，那些链接会静默地
 * 指向另一个人的页面——没有报错，只是内容变了，最难被发现。
 */
export async function isPathFrozen(
  sql: Sql,
  username: string,
): Promise<{ frozen: boolean; until: Date | null }> {
  const [row] = await sql<{ until: Date | null }[]>`
    SELECT r.path_frozen_until AS until
      FROM ispace.offboard_runs r
      JOIN ispace.users u ON u.id = r.user_id
     WHERE u.username = ${username}
       AND r.path_frozen_until IS NOT NULL
       AND r.path_frozen_until > now()
     ORDER BY r.path_frozen_until DESC
     LIMIT 1
  `;
  return { frozen: Boolean(row), until: row?.until ?? null };
}

/**
 * 撤销回收，把人放回来。
 *
 * 冷冻期的存在本身就意味着这件事是可逆的——设计稿写「90 天冷冻期」，
 * 而不是「90 天后删除」。实际最常见的场景是：人还没走成、走了又回来、
 * 或者当初点错了人。没有这条路径的话，唯一的补救是上服务器改库，
 * 而那一步顺序错了会让全平台的数据接口挂掉。
 *
 * 与回收一样：每一步单独 try，一步失败不拖累其余。
 */
export async function restoreUser(deps: {
  sql: Sql;
  adminId: string;
  userId: string;
  clientIp?: string | null;
  log?: { warn: (msg: string) => void };
}): Promise<{ steps: StepResult[]; status: string }> {
  const { sql, adminId, userId, clientIp, log } = deps;

  const [user] = await sql<{ username: string; status: string }[]>`
    SELECT username, status FROM ispace.users WHERE id = ${userId}
  `;
  if (!user) throw new Error('用户不存在');

  const steps: StepResult[] = [];
  const run1 = async (step: OffboardStep, fn: () => Promise<string>) => {
    try { steps.push({ step, ok: true, note: await fn() }); }
    catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      steps.push({ step, ok: false, note });
      log?.warn(`恢复 ${user.username} 的 ${step} 步失败：${note}`);
    }
  };

  // 顺序与回收相反：先放开账号，再恢复数据接口，最后才是页面。
  // 反过来的话，页面已经在跑了但数据还读不到，用户看到的是一片报错。
  await run1('path', async () => {
    await sql`
      UPDATE ispace.users SET status = 'active', archived_at = NULL WHERE id = ${userId}
    `;
    await sql`
      UPDATE ispace.offboard_runs SET path_frozen_until = NULL
       WHERE user_id = ${userId} AND path_frozen_until IS NOT NULL
    `;
    return `/${user.username} 解冻，账号可再次登录`;
  });

  await run1('data', async () => {
    const schema = schemaNameFor(user.username);
    const role = `role_${user.username.replace(/-/g, '_')}`;

    await sql.unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`).catch(() => undefined);
    await sql.unsafe(
      `GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    ).catch(() => undefined);

    // 同回收：必须读角色级设置，不能读 pg_settings（那是会话级的，查不到）
    const [cur] = await sql<{ v: string | null }[]>`
      SELECT split_part(c, '=', 2) AS v
        FROM pg_db_role_setting s
        JOIN pg_roles r ON r.oid = s.setrole,
             unnest(s.setconfig) AS c
       WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%'
       LIMIT 1
    `;
    if (!cur?.v) throw new Error('读不到 authenticator 的 pgrst.db_schemas，已跳过以免写坏列表');

    const list = cur.v.split(',').map((x) => x.trim()).filter(Boolean);
    if (!list.includes(schema)) list.push(schema);
    await sql.unsafe(`ALTER ROLE authenticator SET pgrst.db_schemas = '${list.join(', ')}'`);
    await sql`SELECT pg_notify('pgrst', 'reload config')`;
    await sql`SELECT pg_notify('pgrst', 'reload schema')`;
    return `${schema} 已重新接入数据接口`;
  });

  /*
    页面只恢复到 stopped → running 这一步，后端不自动重建。
    重建后端要重新拉镜像、重新绑路径，可能失败也会立刻开始吃资源；
    人回来了未必还要那个后端。让本人自己在控制台点，比替他决定好。
  */
  await run1('apps', async () => {
    const rows = await sql<{ id: string }[]>`
      UPDATE ispace.apps SET status = 'running', updated_at = now()
       WHERE owner_id = ${userId} AND status = 'stopped'
      RETURNING id
    `;
    return `${rows.length} 个页面已恢复。后端需要本人自己重建——`
      + '重建会立刻开始占资源，未必还需要。';
  });

  const okCount = steps.filter((x) => x.ok).length;
  const status = okCount === steps.length ? 'done' : okCount === 0 ? 'failed' : 'partial';

  await writeAudit(sql, {
    actorId: adminId, action: 'user.provision', targetType: 'user', targetId: userId,
    source: 'console', result: status === 'done' ? 'success' : 'failed',
    metadata: { username: user.username, restored: true, steps },
    ip: clientIp ?? null,
  });

  return { steps, status };
}
