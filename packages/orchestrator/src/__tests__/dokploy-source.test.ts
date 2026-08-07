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
