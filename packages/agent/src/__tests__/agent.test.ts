import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSession, buildSystemPrompt, type AvailableConnector } from '../session.js';
import { runTool, safePath, type ToolContext } from '../tools.js';
import type { Engine, EngineEvent, ToolCall } from '../engine.js';

const ws = () => {
  const root = mkdtempSync(join(tmpdir(), 'ispace-ws-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(root, 'src', 'app.js'), 'console.log(1)');
  return { root, username: 'lixiao' };
};

const platform: ToolContext['platform'] = {
  getQuota: async () => '静态空间 1 MB / 500 MB',
  listApps: async () => 'zhoubao (running)',
  requestDeploy: async () => ({ confirmToken: 'tok-123' }),
};

describe('工作区边界——整个工具集的安全边界', () => {
  it('拒绝 ../ 越界', () => {
    const w = ws();
    expect(() => safePath(w, '../../etc/passwd')).toThrow(/越界/);
  });

  it('拒绝绝对路径', () => {
    const w = ws();
    expect(() => safePath(w, '/etc/passwd')).toThrow(/越界/);
  });

  it('拒绝绕一圈回到外面', () => {
    const w = ws();
    expect(() => safePath(w, 'src/../../../tmp')).toThrow(/越界/);
  });

  it('放行区内路径', () => {
    const w = ws();
    expect(safePath(w, 'src/app.js')).toBe(join(w.root, 'src/app.js'));
    expect(safePath(w, './index.html')).toBe(join(w.root, 'index.html'));
  });
});

describe('文件工具', () => {
  it('读写删都在区内生效', async () => {
    const w = ws();
    const ctx: ToolContext = { ws: w, platform };
    expect(await runTool(ctx, 'read_file', { path: 'index.html' })).toContain('hi');
    await runTool(ctx, 'write_file', { path: 'src/new.js', content: 'export const x=1' });
    expect(readFileSync(join(w.root, 'src/new.js'), 'utf8')).toBe('export const x=1');
    await runTool(ctx, 'delete_file', { path: 'src/new.js' });
    expect(existsSync(join(w.root, 'src/new.js'))).toBe(false);
  });

  it('列目录跳过 node_modules 与隐藏文件', async () => {
    const w = ws();
    mkdirSync(join(w.root, 'node_modules'));
    writeFileSync(join(w.root, '.env'), 'SECRET=x');
    const out = await runTool({ ws: w, platform }, 'list_files', {});
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('.env');
    expect(out).toContain('index.html');
  });

  it('读不存在的文件返回提示而非抛错——模型据此改正是正常流程', async () => {
    const out = await runTool({ ws: ws(), platform }, 'read_file', { path: 'nope.js' });
    expect(out).toContain('不存在');
  });
});

describe('发布必须经二次确认', () => {
  it('request_deploy 只返回待确认令牌，不直接发布', async () => {
    const out = await runTool({ ws: ws(), platform }, 'request_deploy', {
      site: 'zhoubao', summary: '改了标题',
    });
    expect(out).toContain('等待用户在手机上二次确认');
    expect(out).toContain('tok-123');
    expect(out).toContain('不由你决定');
  });
});

/** 假引擎：按脚本产出事件，不碰网络。 */
class ScriptedEngine implements Engine {
  readonly name = 'scripted';
  readonly model = 'test';
  constructor(private readonly script: EngineEvent[][]) {}
  private turn = 0;
  async *run(): AsyncGenerator<EngineEvent> {
    const evs = this.script[this.turn++] ?? [{ type: 'done' as const }];
    for (const e of evs) yield e;
  }
}

const call = (name: string, args: Record<string, unknown>): ToolCall =>
  ({ id: `c-${name}`, name, arguments: args });

describe('会话循环', () => {
  it('无工具调用即视为说完', async () => {
    const s = new AgentSession({
      engine: new ScriptedEngine([[{ type: 'text', delta: '好的' }, { type: 'done' }]]),
      toolCtx: { ws: ws(), platform },
    });
    const r = await s.send('你好');
    expect(r.stopReason).toBe('complete');
    expect(r.turns).toBe(1);
  });

  it('工具结果回灌后继续下一轮', async () => {
    const w = ws();
    const s = new AgentSession({
      engine: new ScriptedEngine([
        [{ type: 'tool_call', call: call('read_file', { path: 'index.html' }) }, { type: 'done' }],
        [{ type: 'text', delta: '读到了' }, { type: 'done' }],
      ]),
      toolCtx: { ws: w, platform },
    });
    const r = await s.send('看看首页');
    expect(r.stopReason).toBe('complete');
    expect(r.turns).toBe(2);
    // tool 结果确实进了对话历史
    expect(s.messages.some((m) => m.role === 'tool' && m.content.includes('hi'))).toBe(true);
  });

  it('轮次上限到达时明确告知，不假装完成', async () => {
    // 一个永远调工具的模型——没有上限就是能烧光配额的死循环
    const loop: EngineEvent[] = [
      { type: 'tool_call', call: call('list_files', {}) },
      { type: 'done' },
    ];
    const s = new AgentSession({
      engine: new ScriptedEngine(Array.from({ length: 20 }, () => loop)),
      toolCtx: { ws: ws(), platform },
      maxTurns: 3,
    });
    const r = await s.send('一直看');
    expect(r.stopReason).toBe('max_turns');
    expect(r.turns).toBe(3);
  });

  it('工具失败回灌给模型而非中断会话', async () => {
    const s = new AgentSession({
      engine: new ScriptedEngine([
        [{ type: 'tool_call', call: call('write_file', { path: '../evil', content: 'x' }) }, { type: 'done' }],
        [{ type: 'text', delta: '换个路径' }, { type: 'done' }],
      ]),
      toolCtx: { ws: ws(), platform },
    });
    const r = await s.send('写文件');
    expect(r.stopReason).toBe('complete');
    expect(s.messages.some((m) => m.role === 'tool' && m.content.includes('越界'))).toBe(true);
  });

  it('引擎报错时中止并标记 error', async () => {
    const s = new AgentSession({
      engine: new ScriptedEngine([[{ type: 'error', message: '模型不可达' }]]),
      toolCtx: { ws: ws(), platform },
    });
    const r = await s.send('你好');
    expect(r.stopReason).toBe('error');
  });
});

/**
 * 系统提示里的连接器清单。
 *
 * 这几条测的不是字符串拼接，是「模型会不会去编一个域名」这件事——
 * 有清单时它该看见调用方式和响应结构，没清单时该被明确告知别自己编。
 */
describe('buildSystemPrompt 里的可用连接器', () => {
  const one: AvailableConnector = {
    slug: 'open-meteo', name: '天气预报', what: '任意经纬度的实况与未来天气',
    example: '/forecast?latitude=39.9&longitude=116.4&current=temperature_2m',
    returns: 'data.current.temperature_2m → 摄氏度数字',
    shared: false,
  };

  it('把调用地址拼成同源相对路径，模型照抄即可', () => {
    const p = buildSystemPrompt([one]);
    expect(p).toContain("fetch('/deploy/api/connect/open-meteo/forecast?latitude=39.9");
  });

  it('带上响应结构——少了它模型只能猜取值路径', () => {
    expect(buildSystemPrompt([one])).toContain('data.current.temperature_2m');
  });

  it('标出共享连接器，个人的不标', () => {
    expect(buildSystemPrompt([{ ...one, shared: true }])).toContain('（全员共享）');
    expect(buildSystemPrompt([one])).not.toContain('（全员共享）');
  });

  it('一条都没有时，明确禁止自己编域名，而不是留白', () => {
    const p = buildSystemPrompt([]);
    expect(p).toMatch(/不要凭记忆写一个第三方\s*\n?API 地址/);
    expect(p).toContain('还没有可用的连接器');
  });

  it('有清单时同样禁止硬套最接近的那条', () => {
    expect(buildSystemPrompt([one])).toContain('不要硬套一个最接近的');
  });

  it('原有的平台约束不能被挤掉', () => {
    for (const p of [buildSystemPrompt([]), buildSystemPrompt([one])]) {
      expect(p).toContain('不得引入新的原生依赖');
      expect(p).toContain('不要把密钥硬编码进代码');
    }
  });
});
