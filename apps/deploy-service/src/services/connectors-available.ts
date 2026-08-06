import { CONNECTOR_CATALOG } from '@ispace/contracts';
import type { AvailableConnector } from '@ispace/agent';

/**
 * 「这个人能用哪些外部数据源」——算一次，两处用。
 *
 * 两处指：平台自带 Coding Agent 的系统提示，和 MCP 的 initialize.instructions。
 * 它们服务的是同一件事——**让模型在开口之前就知道有什么可用**，而不是等它
 * 想起来去调一个工具。工具描述只在模型已经决定要找工具时才起作用，而"我需要
 * 外部数据、这个平台可能有现成的"这个念头，模型多半不会自己冒出来。
 *
 * 放在 service 层而不是各写一份：两边说法不一致时，模型会在"我记得的"和
 * "我刚查到的"之间摇摆，那种 bug 极难复现。
 */

/** 库里 connectors 表的形状，只取拼说明用得到的列。 */
export interface ConnectorRow {
  slug: string;
  name: string;
  catalog_id: string | null;
  /** null 表示全员共享。 */
  user_id: string | null;
}

/**
 * 把库里的登记记录 + 内置目录合成一份可用清单。
 *
 * 免密钥的目录条目即使没登记也算「可用」：它们本来就不需要凭据，让模型为了
 * 一个天气页面先催用户"去登记一下"，是纯粹多出来的一步。
 */
export function availableFromRows(rows: readonly ConnectorRow[]): AvailableConnector[] {
  const out: AvailableConnector[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const cat = CONNECTOR_CATALOG.find((c) => c.id === r.catalog_id);
    seen.add(r.slug);
    out.push({
      slug: r.slug,
      name: r.name,
      what: cat?.what ?? r.name,
      example: cat?.example ?? '/',
      // 自建连接器没有目录条目，响应结构无从得知。直说，好过让模型猜一个
      returns: cat?.returns ?? '（平台不掌握它的响应结构，先小规模试调一次再写取值路径）',
      shared: r.user_id === null,
    });
  }

  for (const c of CONNECTOR_CATALOG) {
    if (c.authKind !== 'none' || seen.has(c.id)) continue;
    out.push({
      slug: c.id, name: `${c.name}（内置，免登记）`, what: c.what,
      example: c.example, returns: c.returns, shared: true,
    });
  }
  return out;
}

/**
 * 拼成给模型读的一段。用于 MCP 的 instructions 与 list-connectors 的返回。
 *
 * 结尾那句「不要硬套最接近的」不是客套：模型在没有完全匹配项时的默认行为
 * 就是挑一个最像的硬用——用汇率接口去answer"股价是多少"，页面能跑，数字是错的。
 * 这种错比报错难发现得多。
 */
export function describeForModel(list: readonly AvailableConnector[]): string {
  if (!list.length) {
    return '这个空间目前没有可用的连接器。页面需要外部数据时不要凭记忆写第三方 API'
      + ' 地址——页面直接调外站会被跨域挡住，写死密钥会被发布链路阻断。'
      + '先用 create-connector 登记一个数据源。';
  }
  const lines = list.map((c) => [
    `- ${c.slug}${c.shared ? '（全员共享）' : ''}  ${c.name}`,
    `  用途：${c.what}`,
    `  调用：fetch('/deploy/api/connect/${c.slug}${c.example}')`,
    `  返回：${c.returns}`,
  ].join('\n'));

  return [
    '页面需要外部数据时**先看这份清单**，命中了直接用。调用一律是同源相对路径，',
    '凭据由平台在服务端注入，**你写的代码里不出现任何 key**。',
    '',
    ...lines,
    '',
    '没有一条命中时，不要硬套最接近的那条，也不要自己编一个域名——',
    '用 create-connector 登记一个，或者直接告诉用户平台上还没有这个数据源。',
  ].join('\n');
}
