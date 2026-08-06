import { describe, expect, it } from 'vitest';
import { CONNECTOR_CATALOG } from '@ispace/contracts';
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
    expect(list.every((c) => c.scope === 'builtin')).toBe(true);
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

  it('三态区分开：个人 / 全员共享 / 平台内置', () => {
    const find = (rows: ConnectorRow[], slug: string) =>
      availableFromRows(rows).find((c) => c.slug === slug)?.scope;
    expect(find([row({ user_id: null })], 'erp')).toBe('shared');
    expect(find([row({ user_id: 'u1' })], 'erp')).toBe('personal');
    expect(find([], 'open-meteo')).toBe('builtin');
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

  it('有个人连接器时警告"分享给同事会空白"——这是文档点名的坑', () => {
    const withPersonal = availableFromRows([row({ user_id: 'u1' })]);
    expect(describeForModel(withPersonal)).toContain('只在你自己打开页面时有效');
  });

  it('没有个人连接器时不说那句警告——否则是噪音，还会让模型无谓犹豫', () => {
    expect(describeForModel(availableFromRows([]))).not.toContain('只在你自己打开');
  });

  it('一条都没有时也不留白，明说别凭记忆写地址', () => {
    expect(describeForModel([])).toContain('不要凭记忆写第三方 API');
    expect(describeForModel([])).toContain('create-connector');
  });
});

/**
 * 内置免密钥条目「免登记」这句话，必须在代理那一侧也成立。
 *
 * 上一版 instructions 已经告诉模型可以直接 fetch('/deploy/api/connect/open-meteo/...')，
 * 而代理只认数据库里的登记记录，实测返回 404——提示词承诺了代理兑现不了的事。
 * 这几条钉住两边的一致性。
 */
describe('内置免密钥条目：提示词说的与代理做的要一致', () => {
  it('清单里出现的免密钥条目，都能在目录里按 slug 找到且确实免密钥', () => {
    for (const c of availableFromRows([]).filter((x) => x.scope === 'builtin')) {
      const cat = CONNECTOR_CATALOG.find((x) => x.id === c.slug);
      expect(cat, `${c.slug} 出现在清单里却不在目录中`).toBeDefined();
      expect(cat?.authKind, `${c.slug} 需要凭据，不该标成免登记`).toBe('none');
    }
  });

  it('需要凭据的绝不进免登记清单——代理不会为它们回落', () => {
    const slugs = availableFromRows([]).map((c) => c.slug);
    for (const c of CONNECTOR_CATALOG.filter((x) => x.authKind !== 'none')) {
      expect(slugs, `${c.id} 要 key 却出现在免登记清单里`).not.toContain(c.id);
    }
  });

  it('提示里的调用路径与代理的路由形状对得上', () => {
    const c = availableFromRows([]).find((x) => x.slug === 'open-meteo');
    expect(describeForModel([c!])).toContain('/deploy/api/connect/open-meteo/forecast?');
  });
});
