import { z } from 'zod';

/**
 * Coding Agent 子系统契约。四期实现，一期定义。
 *
 * 有意定义为「引擎无关」：方案 §6.6 要求 Agent 服务定义一层窄接口，Codex SDK
 * 为默认实现，若国内通道问题无解或未来更换引擎（如 Claude Agent SDK），仅替换
 * 引擎适配层，手机端与工作区体系不动。因此这里不出现任何 Codex 专有字段。
 */

export const agentSessionStatusSchema = z.enum([
  'idle',
  'thinking',
  'editing',
  'building',
  'awaiting_confirm',
  'failed',
]);

export const agentSessionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  /** 引擎侧的线程标识。Codex SDK 为 thread id；换引擎时语义不变。 */
  engineThreadId: z.string().nullable(),
  status: agentSessionStatusSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

/** 多模态输入：文字、截图、语音（语音经服务端 STT 转文字后进入，方案 §6.5）。 */
export const agentInputSchema = z.object({
  sessionId: z.string().uuid(),
  text: z.string().max(4000),
  images: z
    .array(z.object({ mimeType: z.string(), dataBase64: z.string() }))
    .max(4)
    .default([]),
});

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: agentSessionStatusSchema }),
  z.object({ type: z.literal('message'), text: z.string() }),
  /** 手机端展示的改动摘要，不是 diff 原文——屏幕太小。 */
  z.object({
    type: z.literal('change_summary'),
    summary: z.string(),
    files: z.array(z.string()),
  }),
  z.object({ type: z.literal('preview_ready'), channel: z.string(), bundleVersion: z.number().int() }),
  z.object({
    type: z.literal('deploy_requested'),
    /** 部署二次确认由手机端签发一次性 token，部署工具校验后方可执行（方案 §6.2）。 */
    confirmToken: z.string(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

/**
 * 平台经内部 MCP 提供给 Agent 的动作（方案 §6.4）。
 * 注意 requestDeploy 需携带二次确认 token——审批收在平台层而非模型层，
 * 比模型层审批更硬。
 */
export const AGENT_PLATFORM_TOOLS = [
  'triggerPreviewBuild',
  'getBuildStatus',
  'readSampleData',
  'requestDeploy',
] as const;
export type AgentPlatformTool = (typeof AGENT_PLATFORM_TOOLS)[number];
