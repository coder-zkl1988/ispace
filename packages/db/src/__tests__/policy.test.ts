import { describe, expect, it } from 'vitest';
import { parseEmailDomains } from '../repos.js';

/**
 * 可注册的邮箱后缀。
 *
 * 这一条直接决定谁能在平台上开出一个空间——解析松一格就等于把门开了。
 * 它原本写死在环境变量里，改成管理员可在界面输入之后，输入什么样的
 * 脏数据都可能发生：带 @、带空格、大小写混着、末尾多个逗号。
 */

describe('正常输入', () => {
  it('逗号分隔', () => {
    expect(parseEmailDomains('example.com,corp.example.com')).toEqual(['example.com', 'corp.example.com']);
  });

  it('容忍空格', () => {
    expect(parseEmailDomains(' example.com ,  corp.example.com ')).toEqual(['example.com', 'corp.example.com']);
  });

  it('统一小写——邮箱域名大小写不敏感，不统一会漏掉 @SOYOUNG.COM', () => {
    expect(parseEmailDomains('Example.COM')).toEqual(['example.com']);
  });

  it('容忍写成 @后缀 的形式', () => {
    // 界面上提示的是"example.com"，但人很自然会连 @ 一起打
    expect(parseEmailDomains('@example.com, @corp.example.com'))
      .toEqual(['example.com', 'corp.example.com']);
  });
});

describe('脏输入不能变成"放行一切"', () => {
  it('空串得到空数组', () => {
    // 空数组在调用方是"不限后缀"；这里只保证不会冒出一个空字符串项
    expect(parseEmailDomains('')).toEqual([]);
    expect(parseEmailDomains(null)).toEqual([]);
    expect(parseEmailDomains(undefined)).toEqual([]);
  });

  it('只有逗号与空白，不会产出空项', () => {
    // 产出 [''] 是最危险的一种错：某个域名恰好为空时就成了万能钥匙
    expect(parseEmailDomains(', ,,  ,')).toEqual([]);
  });

  it('末尾多余的逗号不产生空项', () => {
    expect(parseEmailDomains('example.com,')).toEqual(['example.com']);
  });

  it('结果里绝不含空字符串', () => {
    for (const raw of ['a.com,,b.com', ' , a.com', '@,@a.com', ',']) {
      expect(parseEmailDomains(raw).every((d) => d.length > 0), raw).toBe(true);
    }
  });
});
