import { describe, expect, it } from 'vitest';
import { MockOrchestrator, detectSourceKind } from '../index.js';

/**
 * 「Git 仓库或镜像」的判定，以及"创建后一定配了源并触发了部署"。
 *
 * 这是一个真实故障的回归测试：平台此前只在编排器里建应用记录、绑域名、
 * 写限额，**从没配置过源，也从没触发过部署**。于是应用永远停在 idle，
 * 界面显示"已停止"（那其实是准的），而提示写着"容器正在拉起"。
 *
 * 判定错的后果同样隐蔽：把 git 地址当镜像去拉，Dokploy 不会立刻报错，
 * 只是拉不到、一直起不来。
 */

describe('镜像', () => {
  it('裸镜像名与带 tag 的', () => {
    for (const s of ['nginx', 'nginx:alpine', 'node:22-slim', 'redis:7']) {
      expect(detectSourceKind(s), s).toBe('image');
    }
  });

  it('带 registry 前缀的', () => {
    for (const s of [
      'ghcr.io/org/app:v1',
      'registry.cn-hangzhou.aliyuncs.com/team/api:latest',
      'docker.io/library/postgres:16',
    ]) {
      expect(detectSourceKind(s), s).toBe('image');
    }
  });

  it('registry 里带域名也不能被误判成 git', () => {
    // ghcr.io 里有点、有斜杠，长得和域名很像——这正是容易判错的地方
    expect(detectSourceKind('ghcr.io/example/zhoubao-api')).toBe('image');
  });
});

describe('Git', () => {
  it('http(s) 地址', () => {
    for (const s of [
      'https://github.com/org/repo',
      'https://github.com/org/repo.git',
      'http://gitlab.internal/team/api.git',
    ]) {
      expect(detectSourceKind(s), s).toBe('git');
    }
  });

  it('ssh 形式', () => {
    for (const s of ['git@github.com:org/repo.git', 'ssh://git@host/org/repo']) {
      expect(detectSourceKind(s), s).toBe('git');
    }
  });

  it('.git 结尾一律当 git', () => {
    expect(detectSourceKind('gitlab.internal/team/api.git')).toBe('git');
  });

  it('前后空格不影响判定', () => {
    expect(detectSourceKind('  https://github.com/a/b  ')).toBe('git');
  });
});

describe('创建之后必须真的配了源并触发部署', () => {
  it('deploySource 会记下源并把状态推进到构建中', async () => {
    // 盯住的正是线上漏掉的那一步：只 create 不 deploy，
    // 应用会永远停在"没在跑"，而且不报错
    const o = new MockOrchestrator();
    const ref = await o.createBackendApp({ username: 'lixiao', name: 'api' });
    const before = o.apps.get(ref.id)!;
    expect(before.source, '创建时还不该有源').toBeUndefined();

    await o.deploySource(ref, 'ghcr.io/org/api:v1');
    const after = o.apps.get(ref.id)!;
    expect(after.source).toEqual({ kind: 'image', value: 'ghcr.io/org/api:v1' });
    // 部署是异步的，触发后应该是"构建中"而不是立刻"运行中"
    expect(after.status).toBe('creating');
  });

  it('git 源也走同一条路', async () => {
    const o = new MockOrchestrator();
    const ref = await o.createBackendApp({ username: 'lixiao', name: 'web' });
    await o.deploySource(ref, 'https://github.com/org/web.git');
    expect(o.apps.get(ref.id)!.source?.kind).toBe('git');
  });

  it('对不存在的应用报错，不静默成功', async () => {
    const o = new MockOrchestrator();
    await expect(
      o.deploySource({ id: 'nope', urlPath: '/svc/x/y' }, 'nginx'),
    ).rejects.toThrow();
  });
});
