import type { Engine, EngineMessage, ToolDef } from './engine.js';
import { ALL_TOOLS, runTool, type ToolContext } from './tools.js';

/**
 * 会话循环（技术方案 §6.1 的「线程语义恰好对应会话」）。
 *
 * 一轮 = 模型输出文本 + 可能发起若干工具调用 → 执行工具 → 把结果回灌
 * → 模型继续。直到模型不再调用工具，或达到轮次上限。
 *
 * 轮次上限是必需的：模型可能在两个工具之间来回打转（读文件→写文件→
 * 再读→再写），没有上限就是一个能烧光配额的死循环。上限到达时明确
 * 告知用户，而不是假装完成了。
 */

const SYSTEM_PROMPT = `你是 ispace 内部平台的编码助手，帮助员工修改他们自己的网页应用。

工作方式：
- 用户用自然语言描述想改什么，你读代码、改代码，然后请求发布。
- 你只能操作该用户自己的工作区文件，不能执行任意命令。
- 发布必须经用户在手机上二次确认，你无权直接发布。

平台约束（AGENTS.md 的等价约束，违反会在构建期被拒）：
- 不得引入新的原生依赖——会改变 runtimeVersion，导致更新不被壳接受。
- 前端资源引用必须用相对路径（./assets/x.js），不能用根绝对路径
  （/assets/x.js）——应用部署在子路径下，绝对路径会 404。
- 不要把密钥硬编码进代码。发布链路会扫描并阻断，Supabase 的
  service_role key 尤其禁止出现在前端。
- app.json 的 tabBar.activeColor 必须是 #RRGGBB 形式。

回答用中文，简短直接。改动完成后用一句话说清楚改了什么。`;

export interface SessionOptions {
  engine: Engine;
  toolCtx: ToolContext;
  /** 轮次上限。默认 12——够完成"读几个文件、改两处、请求发布"，又不至于跑飞。 */
  maxTurns?: number;
  tools?: ToolDef[];
  onEvent?: (e: SessionEvent) => void;
  signal?: AbortSignal;
}

export type SessionEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'turn'; index: number }
  | { type: 'done'; turns: number; stopReason: 'complete' | 'max_turns' | 'error' }
  | { type: 'error'; message: string };

export class AgentSession {
  readonly messages: EngineMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  constructor(private readonly opts: SessionOptions) {}

  /** 追加一条用户消息（可带截图）并跑到收敛。 */
  async send(
    text: string,
    images: { mimeType: string; dataBase64: string }[] = [],
  ): Promise<{ stopReason: 'complete' | 'max_turns' | 'error'; turns: number }> {
    const emit = this.opts.onEvent ?? (() => {});
    const tools = this.opts.tools ?? ALL_TOOLS;
    const maxTurns = this.opts.maxTurns ?? 12;

    this.messages.push(
      images.length ? { role: 'user', content: text, images } : { role: 'user', content: text },
    );

    for (let turn = 0; turn < maxTurns; turn++) {
      emit({ type: 'turn', index: turn });

      let assistantText = '';
      const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
      let errored = false;

      const runOpts = this.opts.signal
        ? { messages: this.messages, tools, signal: this.opts.signal }
        : { messages: this.messages, tools };

      for await (const ev of this.opts.engine.run(runOpts)) {
        if (ev.type === 'text') {
          assistantText += ev.delta;
          emit({ type: 'text', delta: ev.delta });
        } else if (ev.type === 'tool_call') {
          calls.push(ev.call);
        } else if (ev.type === 'error') {
          emit({ type: 'error', message: ev.message });
          errored = true;
        }
      }

      if (errored) {
        emit({ type: 'done', turns: turn + 1, stopReason: 'error' });
        return { stopReason: 'error', turns: turn + 1 };
      }

      this.messages.push(
        calls.length
          ? { role: 'assistant', content: assistantText, toolCalls: calls }
          : { role: 'assistant', content: assistantText },
      );

      // 没有工具调用 = 模型认为说完了
      if (!calls.length) {
        emit({ type: 'done', turns: turn + 1, stopReason: 'complete' });
        return { stopReason: 'complete', turns: turn + 1 };
      }

      for (const call of calls) {
        emit({ type: 'tool_start', name: call.name, args: call.arguments });
        let result: string;
        try {
          result = await runTool(this.opts.toolCtx, call.name, call.arguments);
        } catch (e) {
          // 工具失败要回灌给模型而非中断——模型据此改正是正常流程的一部分，
          // 比如路径写错了、文件不存在。直接中断会让用户看到"没反应"。
          result = `工具执行失败：${e instanceof Error ? e.message : String(e)}`;
        }
        emit({ type: 'tool_result', name: call.name, result });
        this.messages.push({ role: 'tool', content: result, toolCallId: call.id });
      }
    }

    // 到上限要说清楚，不能假装完成
    emit({ type: 'done', turns: maxTurns, stopReason: 'max_turns' });
    return { stopReason: 'max_turns', turns: maxTurns };
  }
}
