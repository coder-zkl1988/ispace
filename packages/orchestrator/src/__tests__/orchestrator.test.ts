import { describe, expect, it } from 'vitest';
import { DEFAULT_QUOTAS } from '@ispace/contracts';
import { MockOrchestrator, backendUrlPath, createOrchestrator, DokployOrchestrator } from '../index.js';

describe('后端应用路径', () => {
  it('形如 /svc/{user}/{app}', () => {
    expect(backendUrlPath('lixiao', 'paiban-api')).toBe('/svc/lixiao/paiban-api');
  });
});

describe('限额必须在建应用时强制写入', () => {
  it('createBackendApp 内部即写限额，不依赖调用方', async () => {
    // 这是技术方案 §4.4 的硬要求：单机 Dokploy 无强多租户隔离，
    // 限额是资源兜底的唯一手段。若交给调用方，一次漏调就意味着
    // 一个没有任何上限的后端能拖垮同机其他服务。
    const o = new MockOrchestrator();
    const ref = await o.createBackendApp({ username: 'lixiao', name: 'api' });
    const rec = o.apps.get(ref.id)!;
    expect(rec.limits).toEqual({
      cpu: DEFAULT_QUOTAS.backendCpuLimit,
      memoryMb: DEFAULT_QUOTAS.backendMemLimitMb,
    });
  });

  it('限额值与设计稿一致', () => {
    expect(DEFAULT_QUOTAS.backendCpuLimit).toBe(0.5);
    expect(DEFAULT_QUOTAS.backendMemLimitMb).toBe(512);
  });
});

describe('Mock 编排器', () => {
  it('绑定路径后可查', async () => {
    const o = new MockOrchestrator();
    const ref = await o.createBackendApp({ username: 'a', name: 'b' });
    await o.bindPath(ref, 'ispace.example.com', '/svc/a/b', 3000);
    expect(o.apps.get(ref.id)!.bindings).toEqual(['ispace.example.com/svc/a/b']);
  });

  it('操作不存在的应用会明确报错而非静默', async () => {
    const o = new MockOrchestrator();
    await expect(o.setLimits({ id: 'nope', urlPath: '/x' }, { cpu: 1, memoryMb: 1 }))
      .rejects.toThrow(/不存在/);
  });

  it('remove 后状态查询返回 failed 而非抛错', async () => {
    const o = new MockOrchestrator();
    const ref = await o.createBackendApp({ username: 'a', name: 'b' });
    await o.remove(ref);
    expect(await o.getStatus(ref)).toBe('failed');
  });
});

describe('实现选择', () => {
  it('有 Dokploy 配置时用 Dokploy', () => {
    const o = createOrchestrator({ DOKPLOY_URL: 'http://x', DOKPLOY_TOKEN: 't' } as NodeJS.ProcessEnv);
    expect(o).toBeInstanceOf(DokployOrchestrator);
  });

  it('缺配置时回落 Mock——本地开发无需额外设置', () => {
    expect(createOrchestrator({} as NodeJS.ProcessEnv)).toBeInstanceOf(MockOrchestrator);
  });
});
