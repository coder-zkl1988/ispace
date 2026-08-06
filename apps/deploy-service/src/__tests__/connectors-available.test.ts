import { describe, expect, it } from 'vitest';
import {
  availableFromRows, describeForModel, type ConnectorRow,
} from '../services/connectors-available.js';

/**
 * 这一组测的不是字符串拼接，是「模型会不会去编一个域名」。
 * 平台自带 Agent 的系统提示与 MCP 的 initialize.instructions 都走这里。
 */
const row = (o: Partial<ConnectorRow> = {}): ConnectorRow => ({
  slug: 'erp', name: '公司 ERP', catalog_id: null, user_id: 'u1', ...o,
});

describe('availableFromRows', () => {
  it('免密钥的内置目录条目不用登记也算可用', () => {
    const list = availableFromRows([]);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.shared)).toBe(true);
    // 让模型为了一个天气页面先催用户去登记，是纯多余的一步
    expect(list.map((c) => c.slug)).toContain('open-meteo');
  });

  it('已登记的会覆盖同名内置条目，不重复出现', () => {
    const list = availableFromRows([row({ slug: 'open-meteo', catalog_id: 'open-meteo' })]);
    expect(list.filter((c) => c.slug === 'open-meteo')).toHaveLength(1);
  });

  it('挂上目录的连接器带出实测过的响应结构', () => {
    const c = availableFromRows([row({ slug: 'w', catalog_id: 'open-meteo' })])
      .find((x) => x.slug === 'w');
    expect(c?.returns).toContain('temperature_2m');
  });

  it('自建连接器没有目录，直说不掌握响应结构而不是让模型猜', () => {
    const c = availableFromRows([row()]).find((x) => x.slug === 'erp');
    expect(c?.returns).toContain('先小规模试调一次');
  });

  it('user_id 为 null 即全员共享', () => {
    expect(availableFromRows([row({ user_id: null })])
      .find((c) => c.slug === 'erp')?.shared).toBe(true);
  });
});

describe('describeForModel', () => {
  const list = availableFromRows([row({ slug: 'w', catalog_id: 'open-meteo' })]);

  it('调用地址是同源相对路径，模型照抄即可', () => {
    expect(describeForModel(list)).toContain("fetch('/deploy/api/connect/w/forecast?");
  });

  it('反复强调代码里不出现 key', () => {
    expect(describeForModel(list)).toContain('不出现任何 key');
  });

  it('明确禁止硬套最接近的那条——那种错页面能跑但数字是错的', () => {
    expect(describeForModel(list)).toContain('不要硬套最接近的那条');
  });

  it('一条都没有时也不留白，明说别凭记忆写地址', () => {
    expect(describeForModel([])).toContain('不要凭记忆写第三方 API');
    expect(describeForModel([])).toContain('create-connector');
  });
});
