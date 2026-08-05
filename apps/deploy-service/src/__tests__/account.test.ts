import { describe, expect, it } from 'vitest';
import { usernameFromEmail } from '../routes/account.js';

/**
 * 从邮箱推导空间标识。
 *
 * 这个值会成为员工长期对外的地址（ispace.example.com/lixiao/），
 * 注册那一刻定下来就很难改——发出去的链接、同事的收藏、手机上的通道名
 * 全跟着它。所以宁可推不出来让用户自己填，也不能推出个奇怪的东西。
 */

describe('常见邮箱', () => {
  it('简单本地部分直接用', () => {
    expect(usernameFromEmail('lixiao@example.com')).toBe('lixiao');
  });

  it('点、下划线、加号统一成连字符', () => {
    expect(usernameFromEmail('li.xiao@example.com')).toBe('li-xiao');
    expect(usernameFromEmail('li_xiao@example.com')).toBe('li-xiao');
    // 加号后缀是邮箱别名的常见写法，不该带进路径
    expect(usernameFromEmail('lixiao+test@example.com')).toBe('lixiao-test');
  });

  it('大写转小写——路径大小写敏感，不统一会出两个空间', () => {
    expect(usernameFromEmail('LiXiao@example.com')).toBe('lixiao');
  });

  it('连续分隔符收敛成一个，首尾的去掉', () => {
    expect(usernameFromEmail('li..xiao@example.com')).toBe('li-xiao');
    expect(usernameFromEmail('_lixiao_@example.com')).toBe('lixiao');
  });

  it('数字可以留在中间和结尾', () => {
    expect(usernameFromEmail('lixiao01@example.com')).toBe('lixiao01');
  });
});

describe('推不出来时返回 null，让用户自己填', () => {
  it('纯中文或纯符号的本地部分', () => {
    // 不自动生成 user1 这类替代品：路径长期对外，机器起的名字很难改回来
    expect(usernameFromEmail('李骁@example.com')).toBeNull();
    expect(usernameFromEmail('...@example.com')).toBeNull();
  });

  it('数字开头的不合法——空间标识必须字母开头', () => {
    expect(usernameFromEmail('01lixiao@example.com')).toBeNull();
  });

  it('太短的不合法', () => {
    expect(usernameFromEmail('a@example.com')).toBeNull();
  });

  it('太长的不合法', () => {
    expect(usernameFromEmail(`${'a'.repeat(40)}@example.com`)).toBeNull();
  });

  it('保留路径要挡住——console、admin 这些不能变成某个人的空间', () => {
    // usernameSchema 内含保留字校验，推导时就会拒绝
    expect(usernameFromEmail('console@example.com')).toBeNull();
    expect(usernameFromEmail('admin@example.com')).toBeNull();
    expect(usernameFromEmail('deploy@example.com')).toBeNull();
  });

  it('畸形输入不抛异常', () => {
    for (const bad of ['', '@', 'no-at-sign', '@example.com']) {
      expect(() => usernameFromEmail(bad)).not.toThrow();
    }
  });
});
