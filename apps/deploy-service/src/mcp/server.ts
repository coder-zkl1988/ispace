import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  CONNECTOR_CATALOG,
  ERROR_CODES,
  IspaceError,
  schemaNameFor,
  MCP_DEFERRED_TOOLS,
  MCP_TOOL_DESCRIPTIONS,
  MCP_TOOL_INPUTS,
  MCP_TOOL_NAMES,
  type McpToolName,
} from '@ispace/contracts';
import {
  createUser,
  findApp,
  findUserById,
  findUserByUsername,
  getQuota,
  listAppsByOwner,
  listReleases,
  provisionUserSchema,
  refreshStorageUsage,
  writeAudit,
  type Sql,
} from '@ispace/db';
import type { SessionService } from '@ispace/auth';
import { backendUrlPath } from '@ispace/orchestrator';
import type { StorageConfig } from '@ispace/storage';
import { findUserByAccessToken } from '../routes/tokens.js';
import { ConnectorKeyMissing, encryptSecret } from '../services/connector-secret.js';
import { assertOutboundAllowed, OutboundBlocked } from '../services/outbound-guard.js';
import { createBackend } from '../services/backend.js';
import { publishMobileBundle } from '../services/mobile-publish.js';
import {
  availableFromRows, describeForModel, type ConnectorRow,
} from '../services/connectors-available.js';
import { deleteApp } from '../services/app-delete.js';
import type { Orchestrator } from '@ispace/orchestrator';
import type { DeployService } from '../services/deploy.js';

/**
 * MCP server。与 deploy-service 同进程发布，鉴权复用 SSO token（技术方案 §4.5）。
 *
 * 这是平台推广的关键：员工在 Claude 里说「把这个项目部署到我的空间」即可完成发布。
 *
 * 传输用 Streamable HTTP（挂在 /deploy/mcp）。所有工具复用调用者身份，
 * 只能操作本人空间；每次调用进审计日志。
 *
 * 实现上没有用 MCP SDK 的 Server 类，而是直接处理 JSON-RPC：
 * SDK 的传输层假定长连接会话，而这里每个请求都要独立鉴权（token 在 header 里），
 * 用无状态的请求-响应更直接，也更容易在 Fastify 的错误处理里统一映射错误码。
 */

interface McpDeps {
  sql: Sql;
  deployService: DeployService;
  sessions: SessionService;
  publicBase: string;
  /** create-backend 要用。与 REST 共用同一个实例。 */
  orchestrator: Orchestrator;
  /** delete-app 要清磁盘产物。 */
  storage: StorageConfig;
  /** publish-app 要把页面包落到这里。 */
  bundleRoot: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2025-06-18';

export async function registerMcp(app: FastifyInstance, deps: McpDeps): Promise<void> {
  const { sql, deployService, sessions } = deps;

  /**
   * MCP 的凭据。优先认个人访问令牌（isp_ 前缀）——那才是 MCP 的正常用法：
   * 会话 JWT 12 小时就过期，让同事每天重配一次 MCP 是不可接受的。
   */
  const authenticate = async (authHeader?: string) => {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new IspaceError(
        ERROR_CODES.UNAUTHENTICATED,
        'MCP 调用需要携带访问令牌。到控制台「接入指引」页创建一个，' +
        '页面上会给出可直接粘贴的 claude mcp add 命令。',
      );
    }
    const raw = authHeader.slice(7);
    let userId: string;
    if (raw.startsWith('isp_')) {
      const found = await findUserByAccessToken(sql, raw);
      if (!found) {
        throw new IspaceError(
          ERROR_CODES.UNAUTHENTICATED,
          '访问令牌无效、已撤销或已过期。请到控制台「接入指引」重新创建。',
        );
      }
      userId = found.userId;
    } else {
      userId = (await sessions.verify(raw)).uid;
    }
    const user = await findUserById(sql, userId);
    if (!user || user.status !== 'active') {
      throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '账号不可用');
    }
    return user;
  };

  const toolList = MCP_TOOL_NAMES.map((name) => ({
    name,
    description: MCP_TOOL_DESCRIPTIONS[name],
    inputSchema: zodToJsonSchema(name),
  }));

  /**
   * MCP 端点。
   *
   * ⚠️ 必须单独放开 bodyLimit。
   *
   * 全局是 1 MB（REST 的产物走 multipart，正文本身不大），而 MCP 没有文件
   * 上传语义，产物只能 base64 塞进 JSON——体积还要涨 1/3。结果是平台的招牌
   * 功能「一句话部署」碰到任何真实前端构建都 413：实测一个 1.1 MB 的 zip
   * （很普通的 React 产物）直接被拒，而错误只说"内容太大了"，
   * 既不讲上限也不给替代路径。
   *
   * 48 MB 够放约 36 MB 的 zip，覆盖绝大多数前端构建与移动端页面包。
   * 不设更大：请求体是整个缓冲在内存里的，而这台机器还跑着 Supabase。
   * 真有超大产物，走 CLI 的 multipart 上传（ai-deploy up），那条路 200 MB。
   */
  const MCP_BODY_LIMIT = 48 * 1024 * 1024;


  /**
   * 这个人能用的连接器，拼成一段给模型读的说明。
   *
   * 两处用它：initialize.instructions（外部 agent 的"系统提示"）与
   * list-connectors 的返回。拼装逻辑在 services/connectors-available.ts，
   * 与平台自带 Agent 共用同一份——两边说法不一致时模型会摇摆。
   */
  async function connectorBrief(userId: string): Promise<string> {
    const rows = await sql<ConnectorRow[]>`
      SELECT slug, name, catalog_id, user_id FROM ispace.connectors
       WHERE user_id = ${userId} OR user_id IS NULL
       ORDER BY user_id IS NULL, slug
    `;
    return describeForModel(availableFromRows(rows));
  }

  app.post('/deploy/mcp', { bodyLimit: MCP_BODY_LIMIT }, async (req, reply) => {
    const body = req.body as JsonRpcRequest;
    const respond = (result: unknown) =>
      reply.send({ jsonrpc: '2.0', id: body.id ?? null, result });
    const fail = (code: number, message: string, data?: unknown) =>
      reply.send({ jsonrpc: '2.0', id: body.id ?? null, error: { code, message, data } });

    try {
      switch (body.method) {
        case 'initialize': {
          /*
            带上 instructions：客户端会把它交给模型当上下文，模型不必先想到
            去调 list-connectors 就已经知道有哪些数据源可用。见 connectorBrief。

            这里的鉴权失败**不能**让握手失败——没带令牌也应该连得上（只是拿不到
            个性化清单），否则用户看到的是一个连不上的 MCP，而不是一句"请登录"。
          */
          let instructions = 'iSpace 内部应用平台。用这些工具把页面发布到公司域名下。';
          try {
            const user = await authenticate(req.headers.authorization);
            instructions += `\n\n当前身份：${user.displayName}（${user.username}）\n\n`
              + `## 外部数据：可用的连接器\n\n${await connectorBrief(user.id)}`;
          } catch {
            instructions += '\n\n（未通过鉴权，连接器清单不可用；请检查访问令牌。）';
          }
          return respond({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'ispace', version: '0.1.0' },
            instructions,
          });
        }

        case 'notifications/initialized':
          return reply.status(202).send();

        case 'tools/list':
          return respond({ tools: toolList });

        case 'tools/call': {
          const user = await authenticate(req.headers.authorization);
          const name = body.params?.name as McpToolName;
          const args = (body.params?.arguments ?? {}) as Record<string, unknown>;

          if (!MCP_TOOL_NAMES.includes(name)) {
            return fail(-32601, `未知工具：${name}`);
          }
          /*
            参数校验失败要把**缺了什么**说清楚。

            原先直接 .parse()，zod 抛出的 ZodError 落到最外层的 catch，
            变成一句"服务内部错误"——模型看到这句话完全无法自我纠正，
            只会原样转述给用户，而用户更看不懂。
            对模型来说，一条能读的错误就等于一次能自动修复的重试。
          */
          const check = MCP_TOOL_INPUTS[name].safeParse(args);
          if (!check.success) {
            const detail = check.error.issues
              .map((i) => `${i.path.join('.') || '参数'}：${i.message}`)
              .join('；');
            return fail(-32602, `${name} 的参数不对——${detail}`);
          }
          const text = await runTool(name, check.data as Record<string, unknown>, user, deps, req.ip);
          return respond({ content: [{ type: 'text', text }] });
        }

        default:
          return fail(-32601, `不支持的方法：${body.method}`);
      }
    } catch (e) {
      if (e instanceof IspaceError) {
        // MCP 的错误要让模型能理解并转述给用户，因此把业务 message 原样带上
        return fail(-32000, e.message, e.toJSON());
      }
      app.log.error(e);
      return fail(-32603, '服务内部错误');
    }
  });

  /** GET 用于能力探测，部分客户端会先探一下。 */
  app.get('/deploy/mcp', async (_req, reply) =>
    reply.send({ name: 'ispace', version: '0.1.0', protocolVersion: PROTOCOL_VERSION }),
  );

  async function runTool(
    name: McpToolName,
    args: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    user: any,
    d: McpDeps,
    /** 调用方 IP，写进审计。MCP 走 HTTP，拿得到；由 trustProxy 还原真实来源。 */
    clientIp: string,
  ): Promise<string> {
    switch (name) {
      case 'deploy': {
        const { site, zip, ...rest } = args as
          { site: string; zip: string; name?: string; description?: string; prompt?: string; category?: string };
        // zip 由客户端读取后以 base64 传入；MCP 没有文件上传语义
        const dir = await mkdtemp(join(tmpdir(), 'ispace-mcp-'));
        const zipPath = join(dir, 'artifact.zip');
        try {
          await writeFile(zipPath, Buffer.from(zip, 'base64'));
          const out = await deployService.deploy({
            user, slug: site, zipPath, source: 'mcp',
            name: rest.name, description: rest.description,
            sourcePrompt: rest.prompt, category: rest.category, clientIp,
          });
          return `已发布 ${out.app.name} v${out.release.version}\n访问地址：${out.url}\n大小：${fmtBytes(out.release.sizeBytes)}`;
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }

      case 'rollback': {
        const { site, version } = args as { site: string; version?: number };
        const rel = await deployService.rollback(user, site, version, clientIp);
        return `已回滚 /${site} 到 v${rel.version}，访问地址：${d.publicBase}/${user.username}/${site}/`;
      }

      case 'releases': {
        const { site } = args as { site: string };
        const a = await findApp(sql, user.id, site);
        if (!a) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到应用 /${site}`);
        const rs = await listReleases(sql, a.id);
        if (!rs.length) return `/${site} 还没有发布记录`;
        return rs
          .map((r) => {
            const flag = r.status === 'active' ? ' ← 当前' : r.status === 'blocked' ? ' （已阻断）' : '';
            return `v${r.version}  ${r.publishedAt.toISOString().slice(0, 16).replace('T', ' ')}  ${r.source}  ${fmtBytes(r.sizeBytes)}${flag}`;
          })
          .join('\n');
      }

      case 'provision': {
        if (user.role !== 'admin') {
          throw new IspaceError(ERROR_CODES.FORBIDDEN, '开通新用户需要管理员权限');
        }
        const { username, displayName } = args as { username: string; displayName: string };
        if (await findUserByUsername(sql, username)) {
          throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, `空间标识 ${username} 已被占用`);
        }
        const u = await createUser(sql, {
          ssoSubject: `manual|${username}`, username, displayName,
        });
        await provisionUserSchema(sql, u.username);
        await writeAudit(sql, {
          actorId: user.id, action: 'user.provision', targetType: 'user', targetId: u.id,
          source: 'mcp', result: 'success', metadata: { username },
          ip: clientIp,
        });
        return `已开通 ${displayName}，空间地址：${d.publicBase}/${username}/`;
      }

      case 'create-backend': {
        // 与 REST 走同一个服务层（services/backend.ts）。两处各写一份的话，
        // 「先落库再调编排器」这类次序要求迟早会在一边漂掉。
        const { name: bname, sourceRepo, port, site, exposed } = args as
          { name: string; sourceRepo: string; port?: number; site?: string; exposed?: boolean };
        const out = await createBackend(
          {
            sql,
            orchestrator: d.orchestrator,
            publicHost: new URL(d.publicBase).host,
            urlPathFor: backendUrlPath,
          },
          { user, name: bname, sourceRepo, port, appSlug: site, exposed, source: 'mcp', clientIp },
        );
        return [
          `已创建后端 ${out.backend.name}`,
          `访问地址：${out.url}`,
          `限额：${out.backend.cpuLimit} vCPU / ${out.backend.memLimitMb} MB（平台强制写入）`,
          site ? `已关联到页面 /${site}` : '',
          exposed ? '已作为全栈应用露出到「我的页面」，可分享。' : '（纯 API 服务，不在空间露出——要露出改 exposed=true）',
          '',
          '状态是 creating，拉镜像并启动通常一两分钟。用 list-backends 查是否就绪。',
          '若一直起不来，多半是端口填错了（要填容器内实际监听的那个）或源拉不下来。',
        ].filter(Boolean).join('\n');
      }


      // ── 看现状 ────────────────────────────────────────────────────
      /*
        这三个是整套工具的地基。没有它们模型是瞎的：不知道用户已有什么，
        于是会重名、会重复建、答不了"我有哪些页面"——而非技术用户恰恰
        最爱问这种问题，也最容易在"你先去控制台看一下"这句话前放弃。
      */
      case 'list-apps': {
        const apps = await listAppsByOwner(sql, user.id);
        if (!apps.length) {
          return '还没有发布过页面。用 deploy 工具把构建产物发上来即可。';
        }
        const cur = await sql<{ app_id: string; version: number }[]>`
          SELECT r.app_id, r.version FROM ispace.releases r
            JOIN ispace.apps a ON a.id = r.app_id
           WHERE a.owner_id = ${user.id} AND r.id = a.current_release_id
        `;
        const vmap = new Map(cur.map((r) => [r.app_id, r.version]));
        const vis = { private: '仅自己', public: '全公司', shared: '指定同事' } as const;
        return apps.map((a) => [
          `/${a.slug}`,
          a.name,
          `${d.publicBase}/${user.username}/${a.slug}/`,
          vmap.get(a.id) ? `v${vmap.get(a.id)}` : '未发布',
          a.status === 'running' ? '运行中' : a.status === 'building' ? '构建中' : '已停用',
          vis[a.visibility as keyof typeof vis] ?? a.visibility,
          fmtBytes(a.sizeBytes),
        ].join('  ')).join('\n');
      }

      case 'list-backends': {
        const rows = await sql<Record<string, unknown>[]>`
          SELECT name, url_path, source_repo, status, cpu_limit, mem_limit_mb
            FROM ispace.backends WHERE owner_id = ${user.id} ORDER BY created_at
        `;
        const q = await getQuota(sql, user.id);
        if (!rows.length) {
          return `还没有后端应用。配额 ${q.backendCountLimit} 个。\n`
            + '纯网页不需要后端——要存数据的话先看 data-connection，'
            + '那条路不占后端配额。';
        }
        const label = { creating: '构建中', running: '运行中', stopped: '已停止', failed: '失败' };
        return [
          rows.map((b) => [
            b.name,
            `${d.publicBase}${b.url_path as string}`,
            b.source_repo ?? '（无源）',
            label[b.status as keyof typeof label] ?? b.status,
            `${b.cpu_limit} vCPU / ${b.mem_limit_mb} MB`,
          ].join('  ')).join('\n'),
          `\n已用 ${rows.length} / ${q.backendCountLimit} 个`,
          '这些地址与该用户所有页面同域名同源，任何页面都能直接 fetch，不用配 CORS——',
          '要给新页面提供接口，用已有的这个就行，通常不必再建。',
        ].join('\n');
      }

      case 'app-status': {
        const { site } = args as { site: string };
        const a = await findApp(sql, user.id, site);
        if (!a) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到应用 /${site}`);
        const peers = await sql<{ username: string; status: string }[]>`
          SELECT u.username, s.status FROM ispace.shares s
            JOIN ispace.users u ON u.id = s.to_user_id
           WHERE s.app_id = ${a.id} AND s.status IN ('pending','accepted')
        `;
        const rs = await listReleases(sql, a.id);
        const cur = rs.find((r) => r.status === 'active');
        const vis = { private: '仅自己', public: '全公司（已上架创意市场）', shared: '指定同事' } as const;
        return [
          `${a.name}  /${site}`,
          `地址    ${d.publicBase}/${user.username}/${site}/`,
          `状态    ${a.status === 'running' ? '运行中' : a.status === 'building' ? '构建中' : '已停用'}`,
          `当前版本 ${cur ? `v${cur.version}（${cur.source} 发布于 ${cur.publishedAt.toISOString().slice(0, 16).replace('T', ' ')}）` : '未发布'}`,
          `大小    ${fmtBytes(a.sizeBytes)}`,
          `可见范围 ${vis[a.visibility as keyof typeof vis] ?? a.visibility}`,
          peers.length
            ? `已分享给 ${peers.map((x) => `${x.username}${x.status === 'pending' ? '（待接受）' : ''}`).join('、')}`
            : '',
          `历史版本 ${rs.length} 个`,
        ].filter(Boolean).join('\n');
      }

      // ── 数据 ──────────────────────────────────────────────────────
      /*
        这条是全栈应用的核心一环。缺了它，模型写不出读写数据的代码，
        只能让用户自己去控制台复制连接信息——那一步就把非技术用户挡住了。
        所以返回的不只是几个值，还有"怎么用"，让模型能直接写对。
      */
      case 'data-connection': {
        const schema = schemaNameFor(user.username);
        const anon = process.env.SUPABASE_ANON_KEY ?? '';
        return [
          `REST 地址  ${d.publicBase}/supabase/rest/v1`,
          `匿名公钥   ${anon || '（服务端未配置，去控制台「数据空间」页取）'}`,
          `schema     ${schema}`,
          '',
          '接入要点：',
          `1. 用 @supabase/supabase-js，建客户端时**必须**带 { db: { schema: '${schema}' } }，`,
          '   漏了会去查 public，那里什么都没有',
          '2. 这个公钥本就设计为发到前端，可以写进代码；数据库密码平台不下发',
          '3. 建表时给每张表开 RLS 并按登录用户加策略——同一张表里不同终端用户的',
          '   数据不该互相看见',
          '4. 存数据**不需要**创建后端应用，这条路不占后端配额',
        ].join('\n');
      }

      case 'list-tables': {
        const schema = schemaNameFor(user.username);
        const rows = await sql<{ name: string; rows: string; rls: boolean }[]>`
          SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint::text AS rows,
                 c.relrowsecurity AS rls
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ${schema} AND c.relkind = 'r'
           ORDER BY c.relname
        `;
        if (!rows.length) return `${schema} 里还没有表。应用第一次写数据时建即可。`;
        return rows.map((r) =>
          `${r.name}  约 ${Number(r.rows).toLocaleString()} 行  行级隔离${r.rls ? '已开' : '**未开**'}`,
        ).join('\n') + '\n\n（行数是统计估算值，不是精确计数）';
      }

      // ── 外部 API ──────────────────────────────────────────────────
      /*
        与 data-connection 同一个道理：不给模型这条路，它面对"要 key 的接口"
        只会把 key 写进前端代码——然后被发布链路阻断，用户看到的是一次失败的
        发布和一句他看不懂的 SECRET_DETECTED。返回里因此不只是清单，
        还有"下一步该怎么写"。
      */
      case 'list-connectors': {
        // 与 initialize.instructions 用同一段文本——两处说法不一致会让模型
        // 在"我记得的"和"我刚查到的"之间摇摆
        const brief = await connectorBrief(user.id);
        const needKey = CONNECTOR_CATALOG
          .filter((c) => c.authKind !== 'none')
          .map((c) => `- ${c.id}  ${c.name}\n  ${c.what}\n  申请 key：${c.apply ?? '见官网'}`);
        return [
          brief, '',
          '需要自备 key 的内置目录（用 create-connector 登记后同样只调相对路径）：',
          ...needKey, '',
          '页面要分享给同事的话用「全员共享」那些——个人连接器只在你自己打开时有效。',
        ].join('\n');
      }

      case 'create-connector': {
        const input = args as {
          slug: string; name: string; baseUrl: string;
          authKind?: 'none' | 'header' | 'query' | 'bearer';
          authName?: string; secret?: string; catalogId?: string;
        };
        const authKind = input.authKind ?? 'none';
        try {
          await assertOutboundAllowed(input.baseUrl, {
            allowPrivate: process.env.ISPACE_CONNECTOR_ALLOW_PRIVATE === '1',
          });
        } catch (e) {
          if (e instanceof OutboundBlocked) {
            throw new IspaceError(ERROR_CODES.INVALID_INPUT, e.message);
          }
          throw e;
        }
        let secretEnc: Buffer | null = null;
        if (input.secret) {
          try { secretEnc = encryptSecret(input.secret); } catch (e) {
            if (e instanceof ConnectorKeyMissing) {
              throw new IspaceError(ERROR_CODES.NOT_IMPLEMENTED, e.message);
            }
            throw e;
          }
        }
        const dup = await sql<{ id: string }[]>`
          SELECT id FROM ispace.connectors
           WHERE slug = ${input.slug} AND (user_id = ${user.id} OR user_id IS NULL)
        `;
        if (dup.length) {
          throw new IspaceError(
            ERROR_CODES.ALREADY_EXISTS,
            `已经有一个叫「${input.slug}」的连接器了（可能是全员共享的）。`
            + '先用 list-connectors 看一眼，能直接用就别新建。',
          );
        }
        const rows = await sql<{ id: string }[]>`
          INSERT INTO ispace.connectors
            (user_id, slug, name, base_url, auth_kind, auth_name, secret_enc, catalog_id, created_by)
          VALUES (${user.id}, ${input.slug}, ${input.name}, ${input.baseUrl},
                  ${authKind}, ${input.authName ?? null}, ${secretEnc},
                  ${input.catalogId ?? null}, ${user.id})
          RETURNING id
        `;
        await writeAudit(sql, {
          actorId: user.id, action: 'connector.create', targetType: 'connector',
          targetId: rows[0]!.id, source: 'mcp', result: 'success',
          metadata: { slug: input.slug, baseUrl: input.baseUrl },
          ip: clientIp,
        });
        return [
          `连接器「${input.name}」登记好了。`,
          '',
          `页面里这样调：fetch('/deploy/api/connect/${input.slug}/{上游路径}')`,
          `实际会打到：${input.baseUrl}/{上游路径}`,
          input.secret ? '凭据已加密保管，之后任何接口都读不回来，页面代码里也不要写。' : '',
          '',
          '注意：这是个人连接器，只在你自己打开页面时有效。要给同事用的页面，',
          '请管理员在控制台发布一个全员共享的连接器。',
        ].filter(Boolean).join('\n');
      }

      // ── 前端 ──────────────────────────────────────────────────────
      case 'delete-app': {
        // 与 REST 走同一个服务层（services/app-delete.ts）。删除有次序要求
        // （引用 → 版本 → 应用 → 磁盘 → 配额），两处各写一份迟早漏掉某一步，
        // 而漏掉的那步不报错，只留下垃圾。
        const { site } = args as { site: string; confirm: true };
        const out = await deleteApp(
          { sql, storage: d.storage },
          { user, slug: site, source: 'mcp', clientIp },
        );
        return [
          `已删除 ${out.name}（/${out.slug}）`,
          `连同 ${out.releases} 个历史版本，释放 ${fmtBytes(out.freedBytes)}`,
          out.filesRemoved ? '' : '⚠ 磁盘产物没清干净，已记录告警，需要管理员处理',
          '这个操作不可恢复。',
        ].filter(Boolean).join('\n');
      }

      // ── 后端 ──────────────────────────────────────────────────────
      case 'redeploy-backend': {
        const { name: bn } = args as { name: string };
        const [b] = await sql<Record<string, unknown>[]>`
          SELECT * FROM ispace.backends WHERE owner_id = ${user.id} AND name = ${bn}
        `;
        if (!b) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到后端 ${bn}`);
        if (!b.orchestrator_ref) {
          throw new IspaceError(ERROR_CODES.ORCHESTRATOR_UNAVAILABLE, '该后端创建未成功，请删除后重建');
        }
        if (!b.source_repo) {
          throw new IspaceError(ERROR_CODES.INVALID_INPUT, '该后端没有记录源，没法部署，请删除后重建');
        }
        await d.orchestrator.deploySource(
          { id: b.orchestrator_ref as string, urlPath: b.url_path as string },
          b.source_repo as string,
        );
        await sql`UPDATE ispace.backends SET status = 'creating' WHERE id = ${b.id as string}`;
        return `${bn} 正在重新拉取并启动，通常一两分钟。用 list-backends 看状态。`;
      }

      case 'delete-backend': {
        const { name: bn } = args as { name: string; confirm: true };
        const [b] = await sql<Record<string, unknown>[]>`
          SELECT * FROM ispace.backends WHERE owner_id = ${user.id} AND name = ${bn}
        `;
        if (!b) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到后端 ${bn}`);
        if (b.orchestrator_ref) {
          await d.orchestrator
            .remove({ id: b.orchestrator_ref as string, urlPath: b.url_path as string })
            .catch(() => undefined);
        }
        await sql`DELETE FROM ispace.backends WHERE id = ${b.id as string}`;
        await sql`
          UPDATE ispace.quotas
             SET backend_count_used = GREATEST(backend_count_used - 1, 0), updated_at = now()
           WHERE user_id = ${user.id}
        `;
        return `已删除后端 ${bn}，容器与路由已移除。`;
      }

      // ── 分享 ──────────────────────────────────────────────────────
      case 'set-visibility': {
        const { site, visibility, category } = args as { site: string; visibility: 'private' | 'public' | 'shared'; category?: string };
        const a = await findApp(sql, user.id, site);
        if (!a) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到应用 /${site}`);

        let revoked = 0;
        if (visibility === 'private') {
          await sql`DELETE FROM ispace.marketplace_listings WHERE app_id = ${a.id}`;
          await sql`DELETE FROM ispace.app_installs WHERE app_id = ${a.id}`;
          const r = await sql<{ id: string }[]>`
            UPDATE ispace.shares SET status = 'revoked', responded_at = now()
             WHERE app_id = ${a.id} AND status IN ('pending','accepted') RETURNING id
          `;
          revoked = r.length;
        } else if (visibility === 'public') {
          if (category) await sql`UPDATE ispace.apps SET category = ${category} WHERE id = ${a.id}`;
          await sql`
            INSERT INTO ispace.marketplace_listings (app_id, published_by)
            VALUES (${a.id}, ${user.id})
            ON CONFLICT (app_id) DO UPDATE SET published_at = now()
          `;
        } else {
          await sql`DELETE FROM ispace.marketplace_listings WHERE app_id = ${a.id}`;
        }
        await sql`UPDATE ispace.apps SET visibility = ${visibility}, updated_at = now() WHERE id = ${a.id}`;
        await writeAudit(sql, {
          actorId: user.id, action: 'app.share', targetType: 'app', targetId: a.id,
          source: 'mcp', result: 'success', metadata: { visibility, revoked }, ip: clientIp,
        });
        const label = { private: '仅自己', public: '全公司', shared: '指定同事' }[visibility];
        return `/${site} 的可见范围已设为「${label}」`
          + (revoked ? `，同时收回了 ${revoked} 个分享` : '')
          + (visibility === 'public' ? '，已上架创意市场' : '');
      }

      case 'share-with': {
        const { site, toUsername } = args as { site: string; toUsername: string };
        const a = await findApp(sql, user.id, site);
        if (!a) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有找到应用 /${site}`);
        const to = await findUserByUsername(sql, toUsername);
        if (!to) throw new IspaceError(ERROR_CODES.NOT_FOUND, `没有这位同事：${toUsername}`);
        if (to.id === user.id) {
          throw new IspaceError(ERROR_CODES.INVALID_INPUT, '不用分享给自己');
        }
        await sql`
          INSERT INTO ispace.shares (app_id, from_user_id, to_user_id, status)
          VALUES (${a.id}, ${user.id}, ${to.id}, 'pending')
          ON CONFLICT (app_id, to_user_id) DO UPDATE SET status = 'pending', responded_at = NULL
        `;
        // 可见范围仍是"仅自己"的话，分享出去对方也打不开——顺手收紧到 shared
        if (a.visibility === 'private') {
          await sql`UPDATE ispace.apps SET visibility = 'shared' WHERE id = ${a.id}`;
        }
        await writeAudit(sql, {
          actorId: user.id, action: 'app.share', targetType: 'app', targetId: a.id,
          source: 'mcp', result: 'success', metadata: { to: toUsername }, ip: clientIp,
        });
        return `已分享 ${a.name} 给 ${to.displayName}（${toUsername}），`
          + '对方主页会出现待接受卡，接受后即可访问。';
      }

      case 'quota': {
        await refreshStorageUsage(sql, user.id);
        const q = await getQuota(sql, user.id);
        return [
          `静态空间  ${fmtBytes(q.storageBytesUsed)} / ${fmtBytes(q.storageBytesLimit)}`,
          `后端应用  ${q.backendCountUsed} / ${q.backendCountLimit} 个`,
          `数据行数  ${q.dbRowsUsed.toLocaleString()} / ${q.dbRowsLimit.toLocaleString()} 行`,
        ].join('\n');
      }

      // ── 手机端页面包 ──────────────────────────────────────────────
      case 'publish-app': {
        /*
          与 REST 的 /mobile/publish 走同一个服务层。

          原先这里直接抛 NOT_IMPLEMENTED，理由写的是"页面包数十 MB，
          JSON-RPC 传不动"——那个前提是错的：数十 MB 是 APK/IPA 的体积，
          OTA 页面包只有 JS bundle 加资源，通常几 MB。真正卡住的是服务端
          bodyLimit 只有 1 MB，那是配置问题，已单独放开。
        */
        const { bundle, runtimeVersion, rolloutPercent, preview, notes } = args as {
          bundle: string; runtimeVersion: string;
          rolloutPercent: number; preview: boolean; notes?: string;
        };
        const dir = await mkdtemp(join(tmpdir(), 'ispace-mcp-bundle-'));
        const zipPath = join(dir, 'bundle.zip');
        try {
          await writeFile(zipPath, Buffer.from(bundle, 'base64'));
          const out = await publishMobileBundle(
            { sql, bundleRoot: d.bundleRoot, publicBase: d.publicBase },
            {
              user, zipPath, runtimeVersion, rolloutPercent, preview,
              notes, source: 'mcp', clientIp,
            },
          );
          return [
            `已发布页面包 v${out.bundleVersion}（runtimeVersion ${out.runtimeVersion}）`,
            `通道 ${out.channel}，${out.assets} 个文件，放量 ${out.rolloutPercent}%`,
            preview
              ? '这是预览通道，只影响你自己的设备。'
              : '装了 App 的设备下次打开即可拿到。用 mobile-channel 看到端情况。',
          ].join('\n');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }

      case 'mobile-channel': {
        const [chan] = await sql<Record<string, unknown>[]>`
          SELECT c.channel_name, r.bundle_version, r.runtime_version, r.rollout_percent
            FROM ispace.mobile_channels c
            LEFT JOIN ispace.mobile_releases r ON r.id = c.current_release_id
           WHERE c.user_id = ${user.id}
        `;
        const [dev] = await sql<{ active: string; failed: string }[]>`
          SELECT count(*) FILTER (WHERE last_seen_at > now() - interval '7 days')::text AS active,
                 count(*) FILTER (WHERE last_error IS NOT NULL)::text AS failed
            FROM ispace.mobile_devices WHERE user_id = ${user.id}
        `;
        const rels = await sql<Record<string, unknown>[]>`
          SELECT bundle_version, runtime_version, rollout_percent, status
            FROM ispace.mobile_releases WHERE user_id = ${user.id}
           ORDER BY bundle_version DESC LIMIT 10
        `;
        if (!chan?.channel_name && !rels.length) {
          return '还没有发过页面包。通道会在第一次发布时自动建。\n'
            + '流程：compose-bundle 合成 → expo export → 产物打成 zip → publish-app';
        }
        return [
          `通道 ${chan?.channel_name ?? '（未建）'}`,
          chan?.bundle_version
            ? `当前到端 v${chan.bundle_version}（runtimeVersion ${chan.runtime_version}，放量 ${chan.rollout_percent}%）`
            : '当前没有生效的版本',
          `活跃设备 ${dev?.active ?? 0} 台，加载失败 ${dev?.failed ?? 0} 台`,
          '',
          '历史版本：',
          ...rels.map((r) => {
            const flag = r.status === 'active' ? ' ← 当前'
              : r.status === 'blocked' ? ' （已阻断）' : '';
            return `  v${r.bundle_version}  runtimeVersion ${r.runtime_version}  `
              + `放量 ${r.rollout_percent}%${flag}`;
          }),
        ].join('\n');
      }

      case 'mobile-rollback': {
        const { version } = args as { version?: number };
        const rows = await sql<{ id: string; bundle_version: number }[]>`
          SELECT id, bundle_version FROM ispace.mobile_releases
           WHERE user_id = ${user.id} AND status IN ('active','superseded')
           ORDER BY bundle_version DESC
        `;
        const target = version
          ? rows.find((r) => r.bundle_version === version)
          : rows[1];
        if (!target) {
          throw new IspaceError(
            ERROR_CODES.NOT_FOUND,
            version ? `版本 v${version} 不存在` : '只有一个版本，没有上一个可回滚',
          );
        }
        await sql`
          UPDATE ispace.mobile_releases SET status = 'superseded'
           WHERE user_id = ${user.id} AND status = 'active'
        `;
        await sql`UPDATE ispace.mobile_releases SET status = 'active' WHERE id = ${target.id}`;
        await sql`
          UPDATE ispace.mobile_channels SET current_release_id = ${target.id}
           WHERE user_id = ${user.id}
        `;
        await writeAudit(sql, {
          actorId: user.id, action: 'mobile.publish', targetType: 'mobile_release',
          targetId: target.id, source: 'mcp', result: 'success',
          metadata: { rollbackTo: target.bundle_version }, ip: clientIp,
        });
        return `已回滚到 v${target.bundle_version}。回滚是服务端切指针，`
          + '1 分钟内全部设备回到这一版。';
      }

      case 'set-rollout': {
        const { version, rolloutPercent } = args as { version: number; rolloutPercent: number };
        const rows = await sql`
          UPDATE ispace.mobile_releases SET rollout_percent = ${rolloutPercent}
           WHERE user_id = ${user.id} AND bundle_version = ${version}
          RETURNING bundle_version
        `;
        if (!rows[0]) throw new IspaceError(ERROR_CODES.NOT_FOUND, `版本 v${version} 不存在`);
        return `v${version} 的放量已调至 ${rolloutPercent}%。`
          + '未被放量的设备完全无感——它们收到的是 204，不会看到更新提示。';
      }

      default:
        throw new IspaceError(ERROR_CODES.NOT_IMPLEMENTED, `${name} 尚未实现`);
    }
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * zod → JSON Schema 的最小转换。
 *
 * 只处理 MCP 工具入参用到的形态（object / string / number / optional / default /
 * describe）。不引入 zod-to-json-schema：那个库会产出大量 $ref 与 definitions，
 * 部分 MCP 客户端解析不佳，而这里的入参都很扁平。
 *
 * ⚠ 依赖 zod v3 的内部字段 `_def.typeName`。zod v4 把它去掉了，届时这里不会
 * 报错，而是静默退化成「所有字段都是 string、都是必填」——工具照样列得出来，
 * 但模型永远填不对参数。__tests__/mcp-schema.test.ts 钉住了每个工具的产出，
 * 升级 zod 时那组用例会先红。
 *
 * 导出仅为可测：它是纯函数，测试直接调比起一整套 Fastify + 数据库要划算得多。
 */
export function zodToJsonSchema(name: McpToolName): Record<string, unknown> {
  const schema = MCP_TOOL_INPUTS[name];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def;
  const shape = typeof def.shape === 'function' ? def.shape() : def.shape ?? {};

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let v: any = value;
    let optional = false;
    let description: string | undefined = v._def?.description;

    while (v?._def?.typeName === 'ZodOptional' || v?._def?.typeName === 'ZodDefault') {
      optional = true;
      description ??= v._def.description;
      v = v._def.innerType;
    }
    description ??= v?._def?.description;

    const t = v?._def?.typeName;
    const jsonType =
      t === 'ZodNumber' ? 'number' : t === 'ZodBoolean' ? 'boolean' : 'string';

    properties[key] = description ? { type: jsonType, description } : { type: jsonType };
    if (!optional) required.push(key);
  }

  return required.length
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}
