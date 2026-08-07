import { ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { findApp, getPlatformPolicy, getQuota, writeAudit, type Sql } from '@ispace/db';
import { verifySource, type Orchestrator } from '@ispace/orchestrator';

/**
 * 后端应用的创建链路。
 *
 * 抽成服务是为了让 REST 与 MCP 走同一条路。原先只有 REST 实现，MCP 侧抛
 * NOT_IMPLEMENTED 并让用户「去控制台建」——但 create-backend 在 MCP 的工具
 * 列表里是按可用功能描述的，模型会去调，然后撞 501。对同事而言那就是
 * 「这工具坏了」。
 *
 * 链路本身有次序要求，两边都必须一致，这也是不能各写一份的原因：
 *   1. 查配额（建完再查等于已经占了资源才发现超限）
 *   2. 先落库为 creating，再调编排器（反过来会留下平台不知道、没人能删的
 *      孤儿容器）
 *   3. 编排失败把库里那条标 failed 并留痕，不删记录——用户需要看到
 *      「我申请过但失败了」，静默消失会让人以为没点到
 */

export interface CreateBackendInput {
  user: User;
  name: string;
  sourceRepo?: string | undefined;
  /** 容器内监听端口。省略按 3000（Node 的惯例）。 */
  port?: number | undefined;
  /** 是否露出到「我的空间」。默认 false（纯 API 服务）。 */
  exposed?: boolean | undefined;
  /**
   * 主要服务于哪个页面。**可选的备注，不是使用前提。**
   *
   * ⚠️ 后端属于**用户**，不属于某个页面：它的地址是 /svc/{user}/{name}，
   * 与该用户所有页面同域名同源，任何一个页面都能直接 fetch，不用配 CORS。
   * 配额是每人 2 个，现实里就是"一个后端服务我做的所有东西"——
   * 共用才是常态，而不是每个页面配一个。
   *
   * 所以这个字段只用来在列表里标一句"主要给 /paiban 用"，
   * 不填是完全正常的，填了也不限制别的页面调用。
   */
  appSlug?: string | undefined;
  source: 'mcp' | 'cli' | 'agent' | 'console';
  clientIp?: string | undefined;
}

export interface CreateBackendDeps {
  sql: Sql;
  orchestrator: Orchestrator;
  publicHost: string;
  /** 由 backendUrlPath 生成，注入进来避免服务层再依赖路由模块。 */
  urlPathFor: (username: string, name: string) => string;
}

export interface Backend {
  id: string;
  ownerId: string;
  appId: string | null;
  name: string;
  sourceRepo: string | null;
  cpuLimit: number;
  memLimitMb: number;
  status: string;
  urlPath: string;
  port: number;
  /** 是否在「我的空间」露出。false=纯 API 服务，只对控制台与 AI 可见。 */
  exposed: boolean;
  /** 露出后的访问范围，与页面同义。exposed=false 时无意义。 */
  visibility: 'private' | 'shared' | 'public';
  containerName: string | null;
  orchestratorRef: string | null;
  createdAt: Date;
}

/** 行 → 对象。放在服务层，REST 与 MCP 共用同一份映射。 */
export function toBackend(r: Record<string, unknown>): Backend {
  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    appId: r.app_id as string | null,
    name: r.name as string,
    sourceRepo: r.source_repo as string | null,
    cpuLimit: Number(r.cpu_limit),
    memLimitMb: Number(r.mem_limit_mb),
    status: r.status as string,
    urlPath: r.url_path as string,
    port: Number(r.port ?? 3000),
    exposed: Boolean(r.exposed),
    visibility: (r.visibility as 'private' | 'shared' | 'public') ?? 'private',
    containerName: (r.container_name as string | null) ?? null,
    orchestratorRef: r.orchestrator_ref as string | null,
    createdAt: r.created_at as Date,
  };
}

export interface CreateBackendOutcome {
  backend: Backend;
  url: string;
}

export async function createBackend(
  deps: CreateBackendDeps,
  input: CreateBackendInput,
): Promise<CreateBackendOutcome> {
  const { sql, orchestrator, publicHost, urlPathFor } = deps;
  const { user } = input;

  // 限额取库中策略而非常量——管理员在「资源与配额」改过之后，
  // 这里写入编排器的值要跟着变，否则界面显示的和实际强制的对不上。
  const policy = await getPlatformPolicy(sql);
  const quota = await getQuota(sql, user.id);
  if (quota.backendCountUsed >= quota.backendCountLimit) {
    throw new IspaceError(
      ERROR_CODES.QUOTA_BACKEND_EXCEEDED,
      `你已用满 ${quota.backendCountLimit} 个后端应用。需要更多请在控制台「配额与用量」提申请。`,
      { used: quota.backendCountUsed, limit: quota.backendCountLimit },
    );
  }

  const dup = await sql`
    SELECT 1 FROM ispace.backends WHERE owner_id = ${user.id} AND name = ${input.name}
  `;
  if (dup.length) {
    throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, `你已有同名后端 ${input.name}`);
  }

  /*
    来源预检放在落库之前：拉不到的镜像不该先建出一条 creating 记录，
    再由用户去界面上盯着它变成「启动失败」。报错要在他还记得自己填了
    什么的那一刻给出来，并且直接说下一步怎么改。
  */
  if (input.sourceRepo) {
    const check = await verifySource(input.sourceRepo);
    if (!check.ok) {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, check.message ?? '这个来源用不了');
    }
  }

  const urlPath = urlPathFor(user.username, input.name);

  /*
    只接受本人的页面。不校验的话，填别人的 slug 会让这条备注指向别人的
    页面，对方列表里会冒出莫名其妙的东西。
    填了但找不到就当没填：这只是个备注，不该让整个创建失败。
  */
  let appId: string | null = null;
  if (input.appSlug) {
    const linked = await findApp(sql, user.id, input.appSlug);
    appId = linked?.id ?? null;
  }

  const rows = await sql`
    INSERT INTO ispace.backends
      (owner_id, app_id, name, source_repo, cpu_limit, mem_limit_mb, status, url_path, port, exposed)
    VALUES (${user.id}, ${appId}, ${input.name}, ${input.sourceRepo ?? null},
            ${Number(policy.backendCpuLimit)},
            ${Math.round(policy.backendMemoryBytes / 1024 / 1024)},
            'creating', ${urlPath}, ${input.port ?? 3000}, ${input.exposed ?? false})
    RETURNING *
  `;
  const row = toBackend(rows[0] as Record<string, unknown>);

  try {
    const ref = await orchestrator.createBackendApp({
      username: user.username,
      name: input.name,
      ...(input.sourceRepo ? { sourceRepo: input.sourceRepo } : {}),
    });
    /*
      不再让编排器（Dokploy）绑 /svc 域名。

      /svc 现在由 iSpace 自己接管：Caddy 把 /svc 转给 deploy-service 的鉴权代理，
      代理按库里存的 container_name:port 直连容器（见 routes/svc-proxy.ts）。
      容器在 dokploy-network 上以服务名可解析，不依赖 Traefik 有没有给它建路由，
      所以这里不再需要 bindPath。少了它，后端就不会有一条绕过鉴权的对外路由。

      publicHost 于是在本流程用不到了；保留形参是因为编排器接口仍暴露 bindPath
      （存量后端的迁移、以及别的编排器实现可能用得上）。
    */
    void publicHost;

    /*
      配置源并触发部署。

      这一步此前**完全没有**：平台只是在编排器里建了个应用记录、绑了域名、
      写了限额，从没告诉它要跑什么。于是应用永远停在 idle，列表里显示
      "已停止"（那其实是准的），而创建成功的提示写着"容器正在拉起"——
      用户看到的是一个自相矛盾的界面。

      放在 bindPath 之后：域名要先绑好，容器起来才有地方可访问。
    */
    if (input.sourceRepo) {
      await orchestrator.deploySource(ref, input.sourceRepo);
    }

    // container_name 是宿主上的资源采样任务认回这个后端的唯一线索
    // （见 infra/scripts/12-resource-sampler.sh）。漏写只会让「配额与用量」
    // 屏的 CPU / 内存永远显示"暂无数据"，不影响后端本身运行。
    await sql`
      UPDATE ispace.backends
         SET orchestrator_ref = ${ref.id}, container_name = ${ref.containerName ?? null}
       WHERE id = ${row.id}
    `;
    await sql`
      UPDATE ispace.quotas SET backend_count_used = backend_count_used + 1, updated_at = now()
       WHERE user_id = ${user.id}
    `;
    await writeAudit(sql, {
      actorId: user.id, action: 'backend.create', targetType: 'backend',
      targetId: row.id,
      source: input.source, result: 'success',
      metadata: { name: input.name, urlPath, orchestrator: orchestrator.name },
      ip: input.clientIp ?? null,
    });

    return {
      // 状态留在 creating：部署是异步的，这一刻容器确实还没起来。
      // 列表页会按编排器的实时状态刷新（见 routes/backends.ts）。
      backend: { ...row, orchestratorRef: ref.id, status: 'creating' },
      url: `http://${publicHost}${urlPath}`,
    };
  } catch (e) {
    await sql`UPDATE ispace.backends SET status = 'failed' WHERE id = ${row.id}`;
    await writeAudit(sql, {
      actorId: user.id, action: 'backend.create', targetType: 'backend',
      targetId: row.id,
      source: input.source, result: 'failed',
      metadata: { name: input.name, error: e instanceof Error ? e.message : String(e) },
      ip: input.clientIp ?? null,
    });
    throw e;
  }
}
