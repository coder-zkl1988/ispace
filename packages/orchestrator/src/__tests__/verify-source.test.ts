import { describe, expect, it } from 'vitest';
import { verifySource } from '../index.js';

/**
 * 这些用例来自一次真实故障：用户填 `zongkelong/myapp`，平台判成 Docker
 * 镜像照单全收，Dokploy 报 `pull access denied … repository does not exist`，
 * 界面上只剩「启动失败」四个字。
 *
 * 预检的价值全在报错文案上——所以断言的是「有没有说清下一步怎么办」，
 * 而不只是 ok 为 false。
 */

/** 假 registry：给定存在的仓库集合，其余一律 404。 */
function fakeHub(exists: string[]) {
  return async (url: string | URL | Request) => {
    const u = String(url);
    const path = u.replace('https://hub.docker.com/v2/repositories/', '');
    return { ok: exists.includes(path), status: exists.includes(path) ? 200 : 404 } as Response;
  };
}

describe('verifySource', () => {
  it('Docker Hub 上没有的 owner/repo：拦下并告诉他 GitHub 该怎么填', async () => {
    const r = await verifySource('zongkelong/myapp', fakeHub([]));
    expect(r.ok).toBe(false);
    // 必须给出可照抄的正确写法，否则用户只知道"错了"不知道"怎么改"
    expect(r.message).toContain('https://github.com/zongkelong/myapp.git');
  });

  it('真实存在的公开镜像放行', async () => {
    const r = await verifySource('nginx:alpine', fakeHub(['library/nginx']));
    expect(r.ok).toBe(true);
  });

  it('官方镜像的单段名会补 library/ 前缀去查', async () => {
    let asked = '';
    await verifySource('redis', async (url) => {
      asked = String(url);
      return { ok: true, status: 200 } as Response;
    });
    expect(asked).toContain('/library/redis');
  });

  it('带私有 registry 主机名的不去 Docker Hub 问，直接放行', async () => {
    let called = false;
    const r = await verifySource('ghcr.io/org/app:v1', async () => {
      called = true;
      return { ok: false, status: 404 } as Response;
    });
    expect(r.ok).toBe(true);
    expect(called).toBe(false);
  });

  it('GitHub 网页地址（/tree/）拦下并给出可克隆地址', async () => {
    const r = await verifySource(
      'https://github.com/GodzillaHe/azusa/tree/codex/image-generator-byok/image-generator',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('https://github.com/GodzillaHe/azusa.git');
  });

  it('正常的 git 地址放行，且不去问 registry', async () => {
    let called = false;
    const r = await verifySource('https://github.com/org/repo.git', async () => {
      called = true;
      return { ok: false, status: 404 } as Response;
    });
    expect(r.ok).toBe(true);
    expect(called).toBe(false);
  });

  it('registry 不可达时放行——预检不能变成新的单点故障', async () => {
    const r = await verifySource('whatever/image', async () => {
      throw new Error('ENOTFOUND');
    });
    expect(r.ok).toBe(true);
  });
});
