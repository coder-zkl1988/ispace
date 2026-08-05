import { describe, expect, it } from 'vitest';
import { MCP_TOOL_DESCRIPTIONS, MCP_TOOL_NAMES } from '@ispace/contracts';
import { zodToJsonSchema } from '../mcp/server.js';

/**
 * MCP 工具入参 schema 的产出。
 *
 * 这是同事的 MCP 客户端唯一能看到的参数契约——它错了，模型就永远填不对参数，
 * 而且不会有任何报错，只会表现为「这工具怎么老是调不通」。
 *
 * zodToJsonSchema 读的是 zod v3 的内部字段 `_def.typeName`。zod v4 移除了它，
 * 那时转换会静默退化成「全部 string、全部必填」。下面这些用例就是为了让那次
 * 升级先在 CI 里红掉，而不是等同事来报「MCP 用不了」。
 */

describe('MCP 工具入参 schema', () => {
  it('deploy：必填与选填分得清，且带上描述', () => {
    expect(zodToJsonSchema('deploy')).toEqual({
      type: 'object',
      properties: {
        site: { type: 'string', description: '应用路径，如 zhoubao' },
        zip: { type: 'string', description: '构建产物 zip 的路径，通常是 dist.zip' },
        name: { type: 'string', description: '应用显示名，首次部署时建议提供' },
        description: { type: 'string', description: '一句话说明这个页面做什么' },
        prompt: {
          type: 'string',
          description:
            '做出这个页面的需求描述（用户原话或你整理后的版本）。上架到创意市场后所有人可见，'
            + '别人点「做同款」会拿走它——请勿包含内部信息、密钥或客户数据。',
        },
      },
      required: ['site', 'zip'],
    });
  });

  it('rollback：optional 包着的 number 仍认得出是 number', () => {
    const s = zodToJsonSchema('rollback') as {
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(s.properties.version).toEqual({
      type: 'number',
      description: '回滚到的版本号，省略则回到上一个版本',
    });
    expect(s.required).toEqual(['site']);
  });

  it('publish-app：default 包着的字段算选填，类型不被 default 吃掉', () => {
    const s = zodToJsonSchema('publish-app') as {
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    // rolloutPercent 与 preview 都有 .default，对调用方是可省略的
    expect(s.properties.rolloutPercent?.type).toBe('number');
    expect(s.properties.preview?.type).toBe('boolean');
    /*
      必填只有这两个。原先断言的是 bundlePath——一个**客户端**路径，
      服务端根本读不到，而工具本身又抛 NOT_IMPLEMENTED，两头都不成立。
      现在改成 base64 内容（与 deploy 工具同一种传法）加 runtimeVersion，
      后者不能有默认值：填错会让服务端静默不下发，设备一直收不到更新，
      而那是最难查的一类"发布了但没生效"。
    */
    expect(s.required).toEqual(['bundle', 'runtimeVersion']);
  });

  it('quota：无参工具不带 required 键', () => {
    const s = zodToJsonSchema('quota');
    expect(s).toEqual({ type: 'object', properties: {} });
    expect(s).not.toHaveProperty('required');
  });

  it('每个工具都能转换，且没有字段被误判成 string', () => {
    // 全 string 是 zod 内部结构变化后的典型症状：类型探测全部落到兜底分支。
    const allTypes = MCP_TOOL_NAMES.flatMap((name) => {
      const s = zodToJsonSchema(name) as { properties: Record<string, { type: string }> };
      return Object.values(s.properties).map((p) => p.type);
    });
    expect(allTypes.length).toBeGreaterThan(0);
    expect(allTypes).toContain('number');
  });

  it('每个工具都有非空描述——描述直接决定模型选不选它', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(MCP_TOOL_DESCRIPTIONS[name]?.length ?? 0).toBeGreaterThan(10);
    }
  });
});
