import { describe, expect, it } from 'vitest';
import { decideRedirect } from '../server.js';

/**
 * 登录回调的跳转判定。
 *
 * 这是个开放重定向的口子：state 由调用方构造。原样信任的话，攻击者能构造
 * 一条链接，让用户在公司 SSO 里正常登录完，然后被送到他自己的站点——而且
 * 是带着刚签发的会话跳过去的。
 *
 * 手机壳又必须能跳出站（ispace:// 深链），所以不能简单地「只许站内」。
 * 下面这组用例就是这个平衡点：放行两种，其余全部回落。
 */

const state = (redirect: unknown) =>
  Buffer.from(JSON.stringify({ redirect })).toString('base64url');

const FALLBACK = '/lixiao/';

describe('站内跳转', () => {
  it('相对路径原样放行', () => {
    expect(decideRedirect(state('/console'), FALLBACK)).toEqual({ kind: 'web', to: '/console' });
    expect(decideRedirect(state('/lixiao/zhoubao/'), FALLBACK))
      .toEqual({ kind: 'web', to: '/lixiao/zhoubao/' });
  });

  it('带查询串与 hash 的站内路径也放行', () => {
    expect(decideRedirect(state('/console#/quota?tab=1'), FALLBACK))
      .toEqual({ kind: 'web', to: '/console#/quota?tab=1' });
  });
});

describe('手机壳深链', () => {
  it('恰好等于 ispace://auth 才算', () => {
    expect(decideRedirect(state('ispace://auth'), FALLBACK)).toEqual({ kind: 'native' });
  });

  it('形似但不相等的一律不认', () => {
    // 前缀匹配会放行 ispace://auth.evil.com 这类，所以必须是全等
    for (const bad of [
      'ispace://auth/../elsewhere',
      'ispace://authx',
      'ispace://auth?next=https://evil.example',
      'ispace-evil://auth',
      'ISPACE://AUTH',
      ' ispace://auth',
    ]) {
      expect(decideRedirect(state(bad), FALLBACK), bad).toEqual({ kind: 'web', to: FALLBACK });
    }
  });
});

describe('开放重定向', () => {
  it('外站绝对 URL 一律回落', () => {
    for (const bad of [
      'https://evil.example/steal',
      'http://evil.example',
      'https://ispace.example.com.evil.example/',
    ]) {
      expect(decideRedirect(state(bad), FALLBACK), bad).toEqual({ kind: 'web', to: FALLBACK });
    }
  });

  it('协议相对 URL 回落——// 开头会跑到外站，看着却像站内路径', () => {
    expect(decideRedirect(state('//evil.example'), FALLBACK)).toEqual({ kind: 'web', to: FALLBACK });
    expect(decideRedirect(state('//evil.example/path'), FALLBACK)).toEqual({ kind: 'web', to: FALLBACK });
  });

  it('伪协议回落', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd']) {
      expect(decideRedirect(state(bad), FALLBACK), bad).toEqual({ kind: 'web', to: FALLBACK });
    }
  });
});

describe('畸形输入', () => {
  it('没有 state 就用回落值', () => {
    expect(decideRedirect(undefined, FALLBACK)).toEqual({ kind: 'web', to: FALLBACK });
    expect(decideRedirect('', FALLBACK)).toEqual({ kind: 'web', to: FALLBACK });
  });

  it('state 不是合法 base64/JSON 也不抛异常', () => {
    // 抛出去会变成 500，用户在登录最后一步看到服务器错误
    expect(decideRedirect('%%%not-base64%%%', FALLBACK)).toEqual({ kind: 'web', to: FALLBACK });
    expect(decideRedirect(Buffer.from('not json').toString('base64url'), FALLBACK))
      .toEqual({ kind: 'web', to: FALLBACK });
  });

  it('redirect 不是字符串时回落', () => {
    for (const bad of [123, null, { toString: () => '/console' }, ['/console']]) {
      expect(decideRedirect(state(bad), FALLBACK)).toEqual({ kind: 'web', to: FALLBACK });
    }
  });
});
