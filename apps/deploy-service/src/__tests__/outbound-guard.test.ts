import { describe, expect, it } from 'vitest';
import {
  assertOutboundAllowed, isBlockedAddress, OutboundBlocked, resolveTarget,
} from '../services/outbound-guard.js';

/**
 * 这一组测试守的是连接器唯一的真风险：出站代理别变成内网扫描器。
 * 每一条都对应一种真实的绕过手法，删任何一条之前先想清楚它挡的是什么。
 */

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', '回环'],
    ['0.0.0.0', '本网络'],
    ['10.1.2.3', '私有 A'],
    ['172.16.0.1', '私有 B 下界'],
    ['172.31.255.254', '私有 B 上界'],
    ['192.168.1.1', '私有 C'],
    ['169.254.169.254', '云厂商元数据服务'],
    ['100.64.0.1', 'CGNAT'],
    ['224.0.0.1', '组播'],
    ['::1', 'IPv6 回环'],
    ['fe80::1', 'IPv6 链路本地'],
    ['fd00::1', 'IPv6 唯一本地'],
    ['::ffff:127.0.0.1', 'IPv4 映射回环——单看 IPv6 规则会漏'],
  ])('拦掉 %s（%s）', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['172.32.0.1'], ['2400:3200::1']])(
    '放行公网地址 %s', (ip) => { expect(isBlockedAddress(ip)).toBe(false); },
  );

  it('172.15 与 172.32 不在私有段里，别把整个 172/8 都拦了', () => {
    expect(isBlockedAddress('172.15.0.1')).toBe(false);
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
  });

  it('不是 IP 的一律拒绝', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertOutboundAllowed', () => {
  it('拒绝非 http(s) 协议', async () => {
    await expect(assertOutboundAllowed('file:///etc/passwd')).rejects.toThrow(OutboundBlocked);
    await expect(assertOutboundAllowed('gopher://x/1')).rejects.toThrow(OutboundBlocked);
  });

  it('拒绝字面内网 IP', async () => {
    await expect(assertOutboundAllowed('http://127.0.0.1:3000/api')).rejects.toThrow(/内网/);
    await expect(assertOutboundAllowed('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(/内网/);
  });

  it('拒绝地址里内嵌的用户名密码', async () => {
    await expect(assertOutboundAllowed('https://user:pw@example.com')).rejects.toThrow(/用户名密码/);
  });

  it('allowPrivate 打开时才放行内网——这个口子必须是显式的', async () => {
    await expect(assertOutboundAllowed('http://192.168.1.10/erp')).rejects.toThrow();
    await expect(assertOutboundAllowed('http://192.168.1.10/erp', { allowPrivate: true }))
      .resolves.toBeInstanceOf(URL);
  });

  it('地址格式不对时给的是人能看懂的话', async () => {
    await expect(assertOutboundAllowed('随便写的')).rejects.toThrow(/形如 https/);
  });
});

describe('resolveTarget', () => {
  const base = 'https://api.example.com/v3';

  it('把子路径接在 base 后面', () => {
    expect(resolveTarget(base, 'weather/now', '?city=110000').toString())
      .toBe('https://api.example.com/v3/weather/now?city=110000');
  });

  it('空子路径就打 base 本身', () => {
    expect(resolveTarget(base, '', '').toString()).toBe('https://api.example.com/v3');
  });

  it('拦掉 .. —— URL 构造函数会把 /v3/../admin 规范化成 /admin，等于替攻击者完成穿越', () => {
    expect(() => resolveTarget(base, '../admin', '')).toThrow(OutboundBlocked);
    expect(() => resolveTarget(base, 'a/../../admin', '')).toThrow(OutboundBlocked);
  });

  it('不能跑到同一台主机的别的路径下', () => {
    // 登记了 /v3 的人不该能打 /internal
    expect(resolveTarget(base, 'x', '').pathname.startsWith('/v3')).toBe(true);
  });

  it('base 末尾有没有斜杠结果一样', () => {
    expect(resolveTarget('https://api.example.com/v3/', 'a', '').toString())
      .toBe('https://api.example.com/v3/a');
  });

  it('协议相对地址 //evil.com 也换不掉主机', () => {
    expect(resolveTarget(base, '//evil.example.net/x', '').host).toBe('api.example.com');
    expect(resolveTarget('https://api.example.com', '//evil.example.net/x', '').host)
      .toBe('api.example.com');
  });

  it('子路径里的绝对地址不会把目标换成别的主机', () => {
    const t = resolveTarget(base, 'https://evil.example.net/x', '');
    expect(t.host).toBe('api.example.com');
  });
});
