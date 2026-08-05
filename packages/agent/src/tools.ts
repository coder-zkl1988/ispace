import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';
import type { ToolDef } from './engine.js';

/**
 * Agent 可用的工具（技术方案 §6.4）。
 *
 * ┌─ 与方案 §6.2 的实质偏离，须知悉 ────────────────────────────────────┐
 * │ 方案原设计是「每位开发者一个 Docker 沙箱工作区，Codex 以              │
 * │ sandbox: workspace-write + approval-policy: never 在容器内运行」。   │
 * │                                                                      │
 * │ 本实现不给 Agent 任意 shell，改为**受控文件工具集**：读目录、读文件、 │
 * │ 写文件、删文件，全部限定在该用户的工作区内，路径经 resolve 后必须     │
 * │ 仍在工作区下，否则拒绝。                                             │
 * │                                                                      │
 * │ 理由：给 Agent 沙箱要么给 deploy-service 挂 docker socket（等于开一个 │
 * │ 容器逃逸的口子），要么再起一套容器编排。而实际需要的能力只是「改这个  │
 * │ 项目的文件、然后走平台的发布链路」——受控文件工具完全覆盖，攻击面     │
 * │ 小一个数量级。                                                        │
 * │                                                                      │
 * │ 代价：Agent 不能自己跑 npm install 或测试。构建与校验发生在平台的     │
 * │ 发布链路里（扫描、base path 校验、合成流水线），失败会回给 Agent，    │
 * │ 它据此改代码——这条反馈回路是通的，只是比"能跑任意命令"慢一些。       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 部署二次确认仍按方案 §6.2：审批收在平台层而非模型层——手机端确认后
 * 签发一次性 token，requestDeploy 校验 token 方可执行。比模型层审批更硬。
 */

export interface WorkspaceContext {
  /** 该用户工作区的绝对路径。所有文件操作限定在此之下。 */
  root: string;
  username: string;
}

/** 单文件读写上限。防止 Agent 一次读进一个几十 MB 的文件把上下文撑爆。 */
const MAX_FILE_BYTES = 256 * 1024;
/** 目录列举上限。 */
const MAX_ENTRIES = 300;

/**
 * 把 Agent 给的相对路径解析为绝对路径，并确保仍在工作区内。
 *
 * 这是整个工具集的安全边界。resolve 之后必须仍以 root 开头——
 * 这一条挡住 ../、绝对路径、以及符号链接之外的所有越界形式。
 */
function safePath(ws: WorkspaceContext, rel: string): string {
  const abs = resolve(ws.root, rel);
  if (abs !== ws.root && !abs.startsWith(ws.root + sep)) {
    throw new IspaceError(
      ERROR_CODES.FORBIDDEN,
      `路径越界：${rel} 不在你的工作区内。只能操作 ${ws.username} 自己的项目文件。`,
    );
  }
  return abs;
}

export const FILE_TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    description: '列出工作区里某个目录下的文件与子目录。path 省略则列根目录。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的目录路径' } },
    },
  },
  {
    name: 'read_file',
    description: '读取工作区里某个文件的内容。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '写入（覆盖）工作区里的某个文件。父目录会自动创建。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        content: { type: 'string', description: '完整的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: '删除工作区里的某个文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作区的文件路径' } },
      required: ['path'],
    },
  },
];

export const PLATFORM_TOOLS: ToolDef[] = [
  {
    name: 'get_quota',
    description: '查询当前用户的空间、后端与数据行用量。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_apps',
    description: '列出当前用户已部署的全部应用及其状态。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'request_deploy',
    description:
      '请求把当前工作区发布到用户空间。需要用户在手机上二次确认——调用后会返回一个待确认状态，' +
      '不会立即发布。这是有意的：发布是对外可见的动作，必须由人点头。',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '发布到的路径，如 zhoubao' },
        summary: { type: 'string', description: '本次改动的一句话摘要，会显示在确认卡上' },
      },
      required: ['site', 'summary'],
    },
  },
];

export const ALL_TOOLS: ToolDef[] = [...FILE_TOOLS, ...PLATFORM_TOOLS];

export interface ToolContext {
  ws: WorkspaceContext;
  /** 平台侧回调。由 agent-service 注入，包内不直接碰数据库。 */
  platform: {
    getQuota(): Promise<string>;
    listApps(): Promise<string>;
    /** 返回一次性确认 token，交给手机端。 */
    requestDeploy(site: string, summary: string): Promise<{ confirmToken: string }>;
  };
}

/** 执行一次工具调用。返回给模型看的文本结果。 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'list_files': {
      const dir = safePath(ctx.ws, String(args.path ?? '.'));
      if (!existsSync(dir)) return `目录不存在：${args.path ?? '.'}`;
      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .slice(0, MAX_ENTRIES)
        .map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${relative(ctx.ws.root, join(dir, e.name)) || e.name}`);
      return lines.length ? lines.join('\n') : '（空目录）';
    }

    case 'read_file': {
      const f = safePath(ctx.ws, String(args.path));
      if (!existsSync(f)) return `文件不存在：${args.path}`;
      const buf = await readFile(f);
      if (buf.byteLength > MAX_FILE_BYTES) {
        return `文件过大（${Math.round(buf.byteLength / 1024)} KB），超过 ${MAX_FILE_BYTES / 1024} KB 上限，未读取。`;
      }
      return buf.toString('utf8');
    }

    case 'write_file': {
      const f = safePath(ctx.ws, String(args.path));
      const content = String(args.content ?? '');
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
        throw new IspaceError(
          ERROR_CODES.INVALID_INPUT,
          `写入内容超过 ${MAX_FILE_BYTES / 1024} KB 上限`,
        );
      }
      await mkdir(join(f, '..'), { recursive: true });
      await writeFile(f, content, 'utf8');
      return `已写入 ${args.path}（${Buffer.byteLength(content)} 字节）`;
    }

    case 'delete_file': {
      const f = safePath(ctx.ws, String(args.path));
      if (!existsSync(f)) return `文件不存在：${args.path}`;
      await rm(f, { force: true });
      return `已删除 ${args.path}`;
    }

    case 'get_quota':
      return ctx.platform.getQuota();

    case 'list_apps':
      return ctx.platform.listApps();

    case 'request_deploy': {
      const r = await ctx.platform.requestDeploy(String(args.site), String(args.summary));
      return (
        `已提交发布请求，等待用户在手机上二次确认。\n` +
        `确认令牌：${r.confirmToken}\n` +
        `发布不会自动进行——这是平台层的硬性审批，不由你决定。`
      );
    }

    default:
      throw new IspaceError(ERROR_CODES.NOT_IMPLEMENTED, `未知工具：${name}`);
  }
}

export { safePath };
