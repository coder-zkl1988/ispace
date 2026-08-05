import { z } from 'zod';

/**
 * 全平台统一错误码。REST、CLI、MCP 三个入口共用同一套，
 * 使得同一个失败在三处呈现一致，便于用户与支持人员对照。
 */
export const ERROR_CODES = {
  // 认证与授权
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  /** 操作了他人空间。单独成码：这是同源架构下最需要审计的一类拒绝。 */
  NOT_OWNER: 'NOT_OWNER',

  // 资源
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  /** 用户名命中 RESERVED_PATHS。 */
  RESERVED_NAME: 'RESERVED_NAME',

  // 校验
  INVALID_INPUT: 'INVALID_INPUT',
  /** 产物中 index.html 用了根绝对路径引用，子路径部署下会 404。 */
  INVALID_BASE_PATH: 'INVALID_BASE_PATH',
  /** 上传的不是合法 zip，或解压后无 index.html。 */
  INVALID_ARTIFACT: 'INVALID_ARTIFACT',

  // 发布链路阻断
  /** gitleaks 命中硬编码密钥。 */
  SECRET_DETECTED: 'SECRET_DETECTED',
  /** 基础 XSS 规则命中。 */
  XSS_DETECTED: 'XSS_DETECTED',

  // 配额
  QUOTA_STORAGE_EXCEEDED: 'QUOTA_STORAGE_EXCEEDED',
  QUOTA_BACKEND_EXCEEDED: 'QUOTA_BACKEND_EXCEEDED',
  QUOTA_ROWS_EXCEEDED: 'QUOTA_ROWS_EXCEEDED',

  // 开通
  /** schema 建了但校验不通过。此时必须中止，继续改 db_schemas 会导致 PostgREST 全局 503。 */
  PROVISION_VERIFY_FAILED: 'PROVISION_VERIFY_FAILED',

  // 编排
  ORCHESTRATOR_UNAVAILABLE: 'ORCHESTRATOR_UNAVAILABLE',
  ORCHESTRATOR_FAILED: 'ORCHESTRATOR_FAILED',

  // 外部服务（模型通道、语音转写）失败。与 INTERNAL 分开：
  // 前者重试可能就好了，后者是平台自己的 bug，两种给用户的话不一样。
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',

  // 尚未实现（骨架中三四期的接口以此返回，而非静默成功）
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',

  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const errorCodeSchema = z.enum(
  Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]],
);

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  /** 结构化补充信息，如配额超限时的 used/limit。不放敏感内容——会进审计日志。 */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** HTTP 状态码映射。CLI 与 MCP 不用，但 REST 层需要一致的映射。 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_OWNER: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  RESERVED_NAME: 422,
  INVALID_INPUT: 422,
  INVALID_BASE_PATH: 422,
  INVALID_ARTIFACT: 422,
  SECRET_DETECTED: 422,
  XSS_DETECTED: 422,
  QUOTA_STORAGE_EXCEEDED: 429,
  QUOTA_BACKEND_EXCEEDED: 429,
  QUOTA_ROWS_EXCEEDED: 429,
  PROVISION_VERIFY_FAILED: 500,
  ORCHESTRATOR_UNAVAILABLE: 503,
  ORCHESTRATOR_FAILED: 502,
  UPSTREAM_ERROR: 502,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
};

export class IspaceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IspaceError';
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  toJSON(): ApiError {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}
