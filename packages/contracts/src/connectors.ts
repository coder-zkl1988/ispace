import { z } from 'zod';

/**
 * 连接器：页面调用外部 API 的统一入口。
 *
 * 为什么需要它，见 migrations/0008_connectors.sql 的开头。一句话：平台正确地
 * 拦下了前端代码里的密钥，却没给替代路径，于是"需要 key 的 API"整类做不了。
 *
 * 这个文件定义两样东西：
 *   1. 连接器本身的形状（增删改查与代理都以它为准）
 *   2. 内置目录 —— 一份**在本平台实际部署环境里验证过连得通**的清单
 */

/** 凭据怎么带给上游。 */
export const authKindSchema = z.enum(['none', 'header', 'query', 'bearer']);
export type AuthKind = z.infer<typeof authKindSchema>;

/**
 * slug 规则与应用路径一致——用户已经在发页面时学过一遍，不该再学第二套。
 */
export const connectorSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, 'slug 只能用小写字母、数字和连字符，2-40 位');

export const createConnectorSchema = z
  .object({
    slug: connectorSlugSchema,
    name: z.string().min(1).max(60),
    /** 出站白名单前缀。必须是 https（或显式允许的内网 http，见 outbound-guard）。 */
    baseUrl: z.string().url(),
    authKind: authKindSchema.default('none'),
    /** header 名或 query 参数名。authKind 为 header/query 时必填。 */
    authName: z.string().min(1).max(64).optional(),
    /** 凭据明文。只在创建/更新时出现在请求体里，落库即加密，永不回传。 */
    secret: z.string().min(1).max(4096).optional(),
    /** 引用内置目录的哪一条。自建留空。 */
    catalogId: z.string().max(64).optional(),
    /** 管理员专用：发布为全员可用的共享连接器。 */
    shared: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if ((v.authKind === 'header' || v.authKind === 'query') && !v.authName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['authName'],
        message: `authKind 为 ${v.authKind} 时必须给出参数名（如 X-API-Key 或 key）`,
      });
    }
    if (v.authKind !== 'none' && !v.secret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['secret'],
        message: '选了带凭据的方式就必须给出凭据',
      });
    }
  });
export type CreateConnectorInput = z.infer<typeof createConnectorSchema>;

/**
 * 返回给客户端的形状。**没有 secret 字段**，这是刻意的：
 * 凭据一旦能读回来，"平台替你保管"就退化成"平台替你存了个明文"。
 * 忘了填什么只能重填，这个代价换的是密钥不会因为一次越权读取而整批泄漏。
 */
export const connectorViewSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  authKind: authKindSchema,
  authName: z.string().nullable(),
  /** 有没有存凭据。只说有无，不说是什么。 */
  hasSecret: z.boolean(),
  catalogId: z.string().nullable(),
  /** true = 平台共享（管理员发布），false = 自己的 */
  shared: z.boolean(),
  callCount: z.number(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ConnectorView = z.infer<typeof connectorViewSchema>;

/**
 * 内置目录。
 *
 * ⚠️ 这份清单里的每一条都在**本仓库部署的那台机器上实测过**（`curl` 返回 200
 * 或"凭据无效"级别的 4xx，而不是连不上）。这一点很重要：内网/国内环境下大量
 * 境外 API 根本不可达，抄一份网上的"公开 API 大全"进来，用户点开发现一半是
 * 死的，比没有目录更糟。
 *
 * 换部署环境时应重新验证——`docs/guides/connectors.md` 里有一条命令。
 *
 * 这里只放**目录条目**（去哪、怎么带凭据），不放任何凭据本身。
 */
export interface CatalogEntry {
  id: string;
  name: string;
  /** 一句话说清它能回答什么问题，写给非技术用户看。 */
  what: string;
  baseUrl: string;
  authKind: AuthKind;
  authName?: string;
  /** 需要凭据的，告诉用户去哪儿申请。 */
  apply?: string;
  /** 厂商官方的凭据申请或管理入口。 */
  applyUrl?: string;
  /** 一条能直接跑的示例路径，接在 /connect/{slug} 后面。 */
  example: string;
  /**
   * 上面那条示例返回什么——**写给 agent 看的**。
   *
   * 没有这一条，模型写取值路径时只能猜：`data.current.temperature_2m` 猜成
   * `data.temperature` 就是一个白屏，而且是运行时才暴露的那种。所以给的不是
   * 散文描述，是一条真实的取值表达式加它的含义。
   */
  returns: string;
  tags: string[];
}

export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'open-meteo',
    name: '天气预报（Open-Meteo）',
    what: '任意经纬度的实况与未来天气，不要钥匙，全球可用',
    baseUrl: 'https://api.open-meteo.com/v1',
    authKind: 'none',
    example: '/forecast?latitude=39.9&longitude=116.4&current=temperature_2m',
    returns: 'data.current.temperature_2m → 摄氏度数字；data.current.time → ISO 时间',
    tags: ['天气', '免密钥'],
  },
  {
    id: 'frankfurter',
    name: '汇率（Frankfurter / 欧洲央行）',
    what: '各国货币兑换率，含历史数据，不要钥匙',
    baseUrl: 'https://api.frankfurter.dev/v1',
    authKind: 'none',
    example: '/latest?base=USD&symbols=CNY',
    returns: 'data.rates.CNY → 数字；data.base → 基准币种；data.date → 日期',
    tags: ['汇率', '免密钥'],
  },
  {
    id: 'er-api',
    name: '汇率（ExchangeRate-API 免费版）',
    what: '汇率的另一个来源，上面那个不通时用这个',
    baseUrl: 'https://open.er-api.com/v6',
    authKind: 'none',
    example: '/latest/USD',
    returns: 'data.rates.CNY → 数字；data.time_last_update_utc → 更新时间',
    tags: ['汇率', '免密钥'],
  },
  {
    id: 'timor-holiday',
    name: '中国法定节假日',
    what: '某一天是工作日、周末还是法定假日，含调休',
    baseUrl: 'https://timor.tech/api/holiday',
    authKind: 'none',
    example: '/info/2026-10-01',
    returns: 'data.type.name → 节日名；data.type.type → 0 工作日/1 周末/2 节日；data.holiday 可能为 null',
    tags: ['日历', '免密钥'],
  },
  {
    id: 'apihubs-holiday',
    name: '中国节假日（APIHubs）',
    what: '节假日的另一个来源，字段更细（周次、季度、工作日序号）',
    baseUrl: 'https://api.apihubs.cn/holiday',
    authKind: 'none',
    example: '/get?date=20261001',
    returns: 'data.list[0].workday → 1 工作日/2 休息日；data.list[0].holiday → 节日编号；data.code → 0 表示成功',
    tags: ['日历', '免密钥'],
  },
  {
    id: 'npm-registry',
    name: 'npm 包信息',
    what: '查某个前端包的最新版本、依赖、发布时间',
    baseUrl: 'https://registry.npmjs.org',
    authKind: 'none',
    example: '/react/latest',
    returns: 'data.version → 版本号字符串；data.description；data.dist.tarball → 下载地址',
    tags: ['研发', '免密钥'],
  },
  {
    id: 'github',
    name: 'GitHub API',
    what: '仓库、Issue、PR、发布。不带凭据也能读公开仓库，但限流很紧',
    baseUrl: 'https://api.github.com',
    authKind: 'bearer',
    apply: 'GitHub → Settings → Developer settings → Personal access tokens',
    applyUrl: 'https://github.com/settings/tokens',
    example: '/repos/nodejs/node',
    returns: 'data.stargazers_count → 数字；data.forks_count；data.description；data.full_name',
    tags: ['研发'],
  },
  {
    id: 'amap',
    name: '高德地图',
    what: '地理编码、POI 搜索、路径规划、天气。国内地图类的主流选择',
    baseUrl: 'https://restapi.amap.com/v3',
    authKind: 'query',
    authName: 'key',
    apply: 'https://lbs.amap.com → 控制台 → 应用管理 → 新建 Key（Web 服务）',
    applyUrl: 'https://console.amap.com/dev/key/app',
    example: '/weather/weatherInfo?city=110000',
    returns: 'data.status → "1" 成功；data.lives[0].temperature → 摄氏度字符串；data.lives[0].weather → 天气描述（按高德文档，未实测）',
    tags: ['地图', '天气'],
  },
  {
    id: 'qweather',
    name: '和风天气',
    what: '比 Open-Meteo 更细的国内天气：空气质量、生活指数、分钟级降水',
    baseUrl: 'https://devapi.qweather.com/v7',
    authKind: 'query',
    authName: 'key',
    apply: 'https://dev.qweather.com → 控制台 → 项目管理 → 创建 KEY',
    applyUrl: 'https://console.qweather.com/project',
    example: '/weather/now?location=101010100',
    returns: 'data.code → "200" 成功；data.now.temp → 摄氏度字符串；data.now.text → 天气描述（按和风文档，未实测）',
    tags: ['天气'],
  },
] as const;
