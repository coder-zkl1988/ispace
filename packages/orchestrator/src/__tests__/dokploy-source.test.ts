import { afterEach, describe, expect, it, vi } from 'vitest';
import { IspaceError } from '@ispace/contracts';
import { DokployOrchestrator } from '../index.js';

afterEach(() => vi.unstubAllGlobals());

describe('Dokploy 错误', () => {
  it('保留 Dokploy 的结构化错误，不在字段名前截断', async () => {
    const fullTail = `完整错误尾部-${'x'.repeat(9_000)}`;
    const payload = {
      message: 'Input validation failed',
      data: {
        zodError: {
          fieldErrors: {
            customGitBranch: ['Expected string, received null'],
            customGitBuildPath: [fullTail],
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));
    const o = new DokployOrchestrator({ baseUrl: 'http://dokploy', token: 'token' });

    let caught: unknown;
    try {
      await o.deploySource(
        { id: 'app-1', urlPath: '/svc/me/app' },
        'https://github.com/org/repo.git',
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IspaceError);
    const error = caught as IspaceError;
    expect(error.message).toContain('customGitBranch: Expected string, received null');
    expect(error.details?.upstream).toBe(JSON.stringify(payload));
    expect(error.details?.upstream).toContain(fullTail);
  });
});

describe('Dokploy 建应用', () => {
  /** 按 procedure 回不同的响应，记下每次调用。 */
  function fakeDokploy(created: Record<string, unknown>) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      if (u.includes('/api/project.all')) {
        return json([{ name: 'ispace-backends', environments: [{ environmentId: 'env-1' }] }]);
      }
      if (u.includes('/api/application.create')) return json(created);
      if (u.includes('/api/application.one')) {
        return json({ applicationId: 'app-1', appName: 'ispace-me-tools-q1w2e3' });
      }
      return json(true);
    }));
    return calls;
  }

  it('容器名取 Dokploy 实际生成的 appName（带随机后缀），不用自己拼的', async () => {
    // Dokploy 会给 appName 追加后缀，swarm 服务名用的是追加后的；存成自己拼的
    // ispace-me-tools，/svc 代理按它连容器会 bad address → 502
    fakeDokploy({ applicationId: 'app-1', appName: 'ispace-me-tools-hwcnjx' });
    const o = new DokployOrchestrator({ baseUrl: 'http://dokploy', token: 'token' });
    const ref = await o.createBackendApp({ username: 'me', name: 'tools' });
    expect(ref.containerName).toBe('ispace-me-tools-hwcnjx');
  });

  it('创建响应里没有 appName 时回查 application.one', async () => {
    const calls = fakeDokploy({ applicationId: 'app-1' });
    const o = new DokployOrchestrator({ baseUrl: 'http://dokploy', token: 'token' });
    const ref = await o.createBackendApp({ username: 'me', name: 'tools' });
    expect(ref.containerName).toBe('ispace-me-tools-q1w2e3');
    expect(calls.some((u) => u.includes('/api/application.one'))).toBe(true);
  });
});
