import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTAS,
  appJsonSchema,
  appSchema,
  releaseSchema,
} from '../index.js';
import { ERROR_HTTP_STATUS, ERROR_CODES, IspaceError } from '../errors.js';
import { MCP_TOOL_DESCRIPTIONS, MCP_TOOL_INPUTS, MCP_TOOL_NAMES } from '../mcp.js';

const uuid = '00000000-0000-4000-8000-000000000000';

describe('app schema', () => {
  const base = {
    id: uuid,
    ownerId: uuid,
    slug: 'zhoubao',
    name: '周报助手',
    description: '随手记几句，周五自动汇总。',
    iconLetter: '周',
    coverUrl: null,
    type: 'static' as const,
    status: 'running' as const,
    currentReleaseId: uuid,
    groupId: null,
    sortOrder: 0,
    visibility: 'private' as const,
    sizeBytes: 1_800_000,
    lastAccessedAt: null,
    createdAt: '2026-07-30T14:22:00Z',
    updatedAt: '2026-07-30T14:22:00Z',
  };

  it('接受设计稿中的真实取值', () => {
    expect(appSchema.safeParse(base).success).toBe(true);
  });

  it('三种应用类型都合法', () => {
    for (const t of ['static', 'static_backend', 'h5']) {
      expect(appSchema.safeParse({ ...base, type: t }).success, t).toBe(true);
    }
  });

  it('building 是合法状态——异步发布必须有中间态', () => {
    expect(appSchema.safeParse({ ...base, status: 'building' }).success).toBe(true);
  });

  it('拒绝保留字以外的非法 slug', () => {
    expect(appSchema.safeParse({ ...base, slug: 'Zhou Bao' }).success).toBe(false);
  });
});

describe('release schema', () => {
  it('blocked 状态需要携带原因', () => {
    const r = releaseSchema.safeParse({
      id: uuid,
      appId: uuid,
      version: 12,
      source: 'mcp',
      status: 'blocked',
      sizeBytes: 0,
      path: '20260730142200',
      publishedBy: uuid,
      publishedAt: '2026-07-30T14:22:00Z',
      blockedReason: 'gitleaks: aws-access-token in src/config.js:12',
    });
    expect(r.success).toBe(true);
  });

  it('四种发布入口与设计稿一致', () => {
    for (const s of ['mcp', 'cli', 'agent', 'console']) {
      const r = releaseSchema.safeParse({
        id: uuid, appId: uuid, version: 1, source: s, status: 'active',
        sizeBytes: 1, path: 'p', publishedBy: uuid,
        publishedAt: '2026-07-30T14:22:00Z', blockedReason: null,
      });
      expect(r.success, s).toBe(true);
    }
  });
});

describe('默认配额与设计稿「配额与用量」屏一致', () => {
  it('数值逐项核对', () => {
    expect(DEFAULT_QUOTAS.storageBytesLimit).toBe(500 * 1024 * 1024);
    expect(DEFAULT_QUOTAS.backendCountLimit).toBe(2);
    expect(DEFAULT_QUOTAS.backendCpuLimit).toBe(0.5);
    expect(DEFAULT_QUOTAS.backendMemLimitMb).toBe(512);
    expect(DEFAULT_QUOTAS.dbRowsLimit).toBe(50_000);
  });
});

describe('错误码', () => {
  it('每个错误码都有 HTTP 映射——漏一个会在运行期得到 undefined 状态码', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(ERROR_HTTP_STATUS[code], code).toBeTypeOf('number');
    }
  });

  it('IspaceError 序列化后可直接作为响应体', () => {
    const e = new IspaceError(ERROR_CODES.SECRET_DETECTED, '发现硬编码密钥', {
      rule: 'aws-access-token',
    });
    expect(e.httpStatus).toBe(422);
    expect(e.toJSON()).toEqual({
      code: 'SECRET_DETECTED',
      message: '发现硬编码密钥',
      details: { rule: 'aws-access-token' },
    });
  });
});

describe('MCP 工具契约', () => {
  /*
    原先这条断言写死了"就这 7 个工具"。它挡住的是漂移，但也挡住了扩充——
    而工具集本来就该随着"让 AI 能自己走完一轮"的目标增长。
    改成盯真正不能变的两件事：设计稿「接入指引」屏列出的那几个必须在，
    以及命名风格统一（模型靠名字猜用途，风格一乱就调错）。
  */
  it('设计稿「接入指引」屏列出的工具必须都在', () => {
    for (const n of ['deploy', 'rollback', 'releases', 'provision', 'create-backend', 'quota']) {
      expect(MCP_TOOL_NAMES, n).toContain(n);
    }
  });

  it('工具名统一用小写连字符——模型靠名字猜用途，风格混着会调错', () => {
    for (const n of MCP_TOOL_NAMES) {
      expect(n, n).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it('没有重名', () => {
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
  });

  it('会改动数据的工具必须要求确认——"帮我清理一下"不能被理解成全删', () => {
    for (const n of ['delete-app', 'delete-backend'] as const) {
      const shape = (MCP_TOOL_INPUTS[n] as unknown as { shape: Record<string, unknown> }).shape;
      expect(shape.confirm, `${n} 缺少 confirm`).toBeDefined();
    }
  });

  it('每个工具都有入参 schema 与描述', () => {
    for (const n of MCP_TOOL_NAMES) {
      expect(MCP_TOOL_INPUTS[n], n).toBeDefined();
      expect(MCP_TOOL_DESCRIPTIONS[n]?.length, n).toBeGreaterThan(10);
    }
  });
});

describe('app.json（移动端页面包声明）', () => {
  it('接受设计稿 01 屏的导航型配置', () => {
    const r = appJsonSchema.safeParse({
      home: 'nav',
      tabBar: {
        visible: true,
        activeColor: '#1c1f23',
        items: [
          { label: '首页', icon: 'home', route: '/' },
          { label: '排班', icon: 'calendar', route: '/paiban' },
          { label: '日报', icon: 'chart', route: '/ribao' },
          { label: '我的', icon: 'user', route: '/me' },
        ],
      },
      shellEntry: { edge: 'right', collapsed: true },
    });
    expect(r.success).toBe(true);
  });

  it('接受设计稿 02 屏的单功能页配置——tabBar 缺省即不显示', () => {
    const r = appJsonSchema.safeParse({ home: 'page' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.tabBar).toBeUndefined();
  });

  it('拒绝非法 activeColor——构建期就要拦下，不能留到壳运行期', () => {
    const r = appJsonSchema.safeParse({
      home: 'nav',
      tabBar: { visible: true, activeColor: 'orange', items: [{ label: 'a', icon: 'b', route: '/' }] },
    });
    expect(r.success).toBe(false);
  });

  it('tabBar 最多 5 项', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      label: `t${i}`, icon: 'i', route: `/${i}`,
    }));
    const r = appJsonSchema.safeParse({
      home: 'nav', tabBar: { visible: true, activeColor: '#000000', items },
    });
    expect(r.success).toBe(false);
  });
});
