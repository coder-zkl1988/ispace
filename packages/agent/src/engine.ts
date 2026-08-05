import { ERROR_CODES, IspaceError } from '@ispace/contracts';

/**
 * Agent 引擎抽象（技术方案 §6.6）。
 *
 * ┌─ 为什么必须有这一层，以及它已经救过一次 ────────────────────────────┐
 * │ 方案 §6.1 原本定的是 OpenAI Codex + Codex SDK。实测在一个兼容        │
 * │ OpenAI 协议的网关上，codex 专用模型（gpt-5.3-codex-spark）发起工具    │
 * │ 调用时 arguments 恒为空字符串——它走的不是标准 chat completions 的     │
 * │ 工具调用协议。同一请求换 gpt-5.6 / gpt-5.4 / MiniMax-M3 则全部正常     │
 * │ 返回参数，说明网关没问题，是那个模型的协议不同。                       │
 * │                                                                       │
 * │ 因为有这层抽象，换实现只改本文件的一个类，会话管理、工具注册、配额、   │
 * │ 手机端全部不动。                                                       │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * 接口只暴露方案 §6.6 要求的四件事：会话创建/续接、消息与事件流、
 * 工具注册、配额。不出现任何厂商专有概念。
 */

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema。引擎负责转成各自的格式。 */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type EngineEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number } }
  | { type: 'error'; message: string };

export interface EngineMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role='assistant' 且发起了工具调用时携带。 */
  toolCalls?: ToolCall[];
  /** role='tool' 时指明回应哪次调用。 */
  toolCallId?: string;
  /** 多模态：截图随 prompt 传入（方案 §6.5）。 */
  images?: { mimeType: string; dataBase64: string }[];
}

export interface Engine {
  readonly name: string;
  readonly model: string;
  /**
   * 跑一轮。返回事件流。
   * 工具调用的执行由调用方负责——引擎只负责"模型想调什么"，
   * 不碰平台状态，这样单测里可以完全不起真实工具。
   */
  run(input: {
    messages: EngineMessage[];
    tools: ToolDef[];
    signal?: AbortSignal;
  }): AsyncGenerator<EngineEvent>;
}

// ── OpenAI 兼容实现 ───────────────────────────────────────────────────

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单轮最大输出 token。防止一次跑飞把配额烧光。 */
  maxTokens?: number;
  timeoutMs?: number;
}

export class OpenAiCompatibleEngine implements Engine {
  readonly name = 'openai-compatible';
  readonly model: string;

  constructor(private readonly cfg: OpenAiCompatibleConfig) {
    this.model = cfg.model;
  }

  async *run(input: {
    messages: EngineMessage[];
    tools: ToolDef[];
    signal?: AbortSignal;
  }): AsyncGenerator<EngineEvent> {
    const body = {
      model: this.cfg.model,
      messages: input.messages.map(toWireMessage),
      ...(input.tools.length
        ? {
            tools: input.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      stream: true,
      max_tokens: this.cfg.maxTokens ?? 2048,
    };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 120_000);
    input.signal?.addEventListener('abort', () => ctl.abort());

    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      yield { type: 'error', message: `模型服务不可达：${e instanceof Error ? e.message : String(e)}` };
      return;
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const text = await res.text().catch(() => '');
      yield { type: 'error', message: `模型返回 ${res.status}：${text.slice(0, 200)}` };
      return;
    }

    // 工具调用在流式响应里是**分片到达**的：name 可能只在第一片出现，
    // arguments 逐字拼接。必须按 index 累积，不能每片当成独立调用。
    const pending = new Map<number, { id: string; name: string; args: string }>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          let chunk: WireChunk;
          try {
            chunk = JSON.parse(payload) as WireChunk;
          } catch {
            continue; // 半截 JSON，等下一片
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) yield { type: 'text', delta: delta.content };

          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const cur = pending.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            pending.set(idx, cur);
          }
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }

    for (const cur of pending.values()) {
      if (!cur.name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = cur.args ? (JSON.parse(cur.args) as Record<string, unknown>) : {};
      } catch {
        // 参数不是合法 JSON 说明模型输出坏了。给出可诊断的错误而非静默丢弃——
        // 静默丢弃会表现为"模型说要做但什么都没发生"。
        yield {
          type: 'error',
          message: `模型返回的工具参数不是合法 JSON（工具 ${cur.name}）：${cur.args.slice(0, 120)}`,
        };
        continue;
      }
      yield { type: 'tool_call', call: { id: cur.id || `call_${cur.name}`, name: cur.name, arguments: args } };
    }

    yield { type: 'done' };
  }
}

interface WireChunk {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
}

function toWireMessage(m: EngineMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  if (m.images?.length) {
    // 多模态：截图随 prompt 传入（方案 §6.5）
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content },
        ...m.images.map((i) => ({
          type: 'image_url',
          image_url: { url: `data:${i.mimeType};base64,${i.dataBase64}` },
        })),
      ],
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * 按环境变量构造引擎。
 *
 * 默认模型不用 codex-spark：实测该模型在本网关上工具调用的 arguments
 * 恒为空，无法驱动 Agent。详见文件头部说明。
 */
export function createEngine(env: NodeJS.ProcessEnv = process.env): Engine {
  const baseUrl = env.AGENT_BASE_URL;
  const apiKey = env.AGENT_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new IspaceError(
      ERROR_CODES.ORCHESTRATOR_UNAVAILABLE,
      'Agent 未配置：需要 AGENT_BASE_URL 与 AGENT_API_KEY',
    );
  }
  return new OpenAiCompatibleEngine({
    baseUrl,
    apiKey,
    model: env.AGENT_MODEL ?? 'gpt-5.6',
    maxTokens: Number(env.AGENT_MAX_TOKENS ?? 2048),
    timeoutMs: Number(env.AGENT_TIMEOUT_MS ?? 120_000),
  });
}
