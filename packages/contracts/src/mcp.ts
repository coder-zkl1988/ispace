import { z } from 'zod';
import { appSlugSchema, usernameSchema } from './reserved.js';
import { authKindSchema, connectorSlugSchema } from './connectors.js';

/**
 * MCP 工具契约。7 个工具取自设计稿「接入指引」屏的实际列表。
 *
 * 全部复用调用者的 SSO 身份，只能操作本人空间；每次调用进审计日志。
 * MCP server 与 deploy-service 同进程发布，鉴权共用（规格 §9）。
 *
 * 一期实现前 6 个；publish-app 发布移动端页面包，依赖三期的 updates-service，
 * 一期实现体返回 NOT_IMPLEMENTED——不静默成功，避免用户以为发布了其实没有。
 */

export const MCP_TOOL_NAMES = [
  // ── 看现状 ──
  // 没有这几个，模型就是瞎的：不知道用户已有什么，会重名、会重复建，
  // 也答不了"我有哪些页面"。非技术用户恰恰最爱问这种问题。
  'list-apps',
  'list-backends',
  'app-status',

  // ── 前端 ──
  'deploy',
  'rollback',
  'releases',
  'delete-app',

  // ── 后端 ──
  'create-backend',
  'redeploy-backend',
  'delete-backend',

  // ── 数据 ──
  // 全栈应用的核心一环。没有它，模型写不出读写数据的代码，
  // 只能让用户自己去控制台复制连接信息——那一步就把非技术用户挡住了。
  'data-connection',
  'list-tables',

  // ── 外部 API ──
  // 与 data-connection 是一对：那条给数据库，这条给外部 API。
  // 没有它，模型面对"要 key 的接口"只能把 key 写进前端——而那会被发布链路
  // 阻断，于是整类需求做不了。
  'list-connectors',
  'create-connector',

  // ── 分享 ──
  'set-visibility',
  'share-with',

  // ── 手机端页面包 ──
  'publish-app',
  'mobile-channel',
  'mobile-rollback',
  'set-rollout',

  // ── 其他 ──
  'quota',
  'provision',
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * 仍返回 NOT_IMPLEMENTED 的工具。
 *
 * 现在是空的：publish-app 曾在这里，理由是"页面包数十 MB，JSON-RPC 传不动"，
 * 而那个前提是错的——数十 MB 是 APK/IPA 的体积，OTA 页面包只有 JS bundle
 * 加资源，通常几 MB。真正的障碍是服务端 bodyLimit 只有 1 MB，那是配置问题。
 * 放开之后这条路完全走得通（见 mcp/server.ts 的 MCP_BODY_LIMIT）。
 */
export const MCP_DEFERRED_TOOLS: readonly McpToolName[] = [];

export const mcpDeployInput = z.object({
  /** 部署到本人空间的哪个路径，如 zhoubao → /lixiao/zhoubao/ */
  site: appSlugSchema.describe('应用路径，如 zhoubao'),
  /** 构建产物 zip 的本地路径。由 MCP 客户端读取后以 base64 传输。 */
  zip: z.string().describe('构建产物 zip 的路径，通常是 dist.zip'),
  name: z.string().max(32).optional().describe('应用显示名，首次部署时建议提供'),
  description: z.string().max(200).optional().describe('一句话说明这个页面做什么'),
  /**
   * 「做同款」的原料。上架到创意市场后，别人点「做同款」拿走的就是这段话。
   * 交给模型自己填写：真正让这个页面长成现在这样的需求描述，只有它清楚。
   */
  prompt: z
    .string()
    .max(4000)
    .optional()
    .describe(
      '做出这个页面的需求描述（用户原话或你整理后的版本）。上架到创意市场后所有人可见，'
      + '别人点「做同款」会拿走它——请勿包含内部信息、密钥或客户数据。',
    ),
});

export const mcpRollbackInput = z.object({
  site: appSlugSchema.describe('要回滚的应用路径'),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('回滚到的版本号，省略则回到上一个版本'),
});

export const mcpReleasesInput = z.object({
  site: appSlugSchema.describe('要查看历史版本的应用路径'),
});

export const mcpProvisionInput = z.object({
  username: usernameSchema.describe('要开通的员工标识'),
  displayName: z.string().min(1).max(64).describe('员工姓名'),
});

export const mcpCreateBackendInput = z.object({
  name: z.string().min(1).max(32).describe('后端应用名'),
  sourceRepo: z.string().min(1).describe('Git 仓库地址或镜像名'),
  port: z.number().int().min(1).max(65535).default(3000)
    .describe('容器内监听的端口。Node 一般 3000，nginx 是 80，Python 常见 8000。填错的表现是访问地址 502'),
  site: appSlugSchema.optional().describe(
    '可选备注：主要给哪个页面用。**不填是常态**——后端属于用户不属于页面，'
    + '该用户的所有页面都能调它（同域名同源，不用配 CORS）',
  ),
  exposed: z.boolean().default(false).describe(
    '这个后端本身带前台页面、要作为一个应用露出到用户空间（能在「我的页面」'
    + '看到、可分享）吗？true=全栈项目；false（默认）=纯 API 服务，只给这个人'
    + '自己的页面提供数据，不在空间露出。拿不准就 false——纯 API 是常态。',
  ),
});

export const mcpQuotaInput = z.object({});

export const mcpPublishAppInput = z.object({
  /**
   * 页面包 zip 的内容（base64）。与 deploy 工具同一种传法。
   *
   * 原先这里是 bundlePath——一个服务端根本读不到的**客户端**路径，
   * 而工具本身又抛 NOT_IMPLEMENTED，等于两头都不成立。
   */
  bundle: z.string().describe('expo export 产物打成 zip 后的 base64 内容'),
  runtimeVersion: z.string().min(1)
    .describe('必须与壳的 runtimeVersion 完全一致，否则服务端不会把这个包下发给设备'),
  rolloutPercent: z.number().int().min(0).max(100).default(100)
    .describe('放量比例。先发 10 或 50 观察，无异常再放到 100'),
  preview: z.boolean().default(false)
    .describe('true = 只发到自己的预览通道，不影响其他设备。改动大时建议先 preview'),
  notes: z.string().max(500).optional().describe('这一版改了什么'),
});

export const mcpMobileChannelInput = z.object({});

export const mcpMobileRollbackInput = z.object({
  version: z.number().int().positive().optional()
    .describe('回滚到哪个版本号，省略则回到上一个'),
});

export const mcpSetRolloutInput = z.object({
  version: z.number().int().positive().describe('要调整放量的版本号'),
  rolloutPercent: z.number().int().min(0).max(100).describe('放量比例'),
});

const empty = z.object({});

export const mcpAppStatusInput = z.object({
  site: appSlugSchema.describe('要查看的应用路径'),
});

export const mcpDeleteAppInput = z.object({
  site: appSlugSchema.describe('要删除的应用路径'),
  /** 删除不可逆，要模型显式确认过，避免"帮我清理一下"被理解成全删。 */
  confirm: z.literal(true).describe('必须为 true。删除会移除页面与全部历史版本，不可恢复'),
});

export const mcpBackendRefInput = z.object({
  name: z.string().min(1).max(32).describe('后端应用名'),
});

export const mcpDeleteBackendInput = z.object({
  name: z.string().min(1).max(32).describe('要删除的后端应用名'),
  confirm: z.literal(true).describe('必须为 true。容器与路由会一并移除，容器内数据不保留'),
});

export const mcpSetVisibilityInput = z.object({
  site: appSlugSchema.describe('应用路径'),
  visibility: z.enum(['private', 'public', 'shared']).describe(
    'private 仅自己 / public 全公司（会上架创意市场）/ shared 指定同事。'
    + '改成 private 会连带收回已有的分享',
  ),
});

export const mcpShareWithInput = z.object({
  site: appSlugSchema.describe('应用路径'),
  toUsername: usernameSchema.describe('同事的空间标识（地址里那一段，如 lixiao）'),
});

/**
 * 登记连接器。字段与 REST 的 createConnectorSchema 一致，但描述是写给**模型**看的
 * ——模型看不到控制台的表单说明，全靠这里把"该填什么"讲清楚。
 */
export const mcpCreateConnectorInput = z.object({
  slug: connectorSlugSchema.describe('页面里用的短名，调用地址是 /deploy/api/connect/{slug}/...'),
  name: z.string().min(1).max(60).describe('给人看的名字，如「高德地图」'),
  baseUrl: z.string().url().describe(
    '上游 API 的根地址，**同时是出站白名单**：代理只允许访问它的前缀之下。'
    + '填得越具体越安全，如 https://restapi.amap.com/v3 而不是 https://restapi.amap.com',
  ),
  authKind: authKindSchema.default('none').describe(
    'none=不要凭据；query=拼在查询串里（高德、和风都是这种）；'
    + 'header=放在自定义请求头；bearer=标准 Authorization: Bearer',
  ),
  authName: z.string().min(1).max(64).optional()
    .describe('query 或 header 方式下的参数名，如 key 或 X-API-Key'),
  secret: z.string().min(1).max(4096).optional().describe(
    '凭据明文。落库即加密，**任何接口都不会再把它读回来**，所以别指望之后能查看。'
    + '让用户自己提供，不要编造。',
  ),
  catalogId: z.string().max(64).optional().describe('若来自 list-connectors 返回的目录，填那一条的 id'),
});

export const MCP_TOOL_INPUTS = {
  'list-apps': empty,
  'list-backends': empty,
  'app-status': mcpAppStatusInput,

  deploy: mcpDeployInput,
  rollback: mcpRollbackInput,
  releases: mcpReleasesInput,
  'delete-app': mcpDeleteAppInput,

  'create-backend': mcpCreateBackendInput,
  'redeploy-backend': mcpBackendRefInput,
  'delete-backend': mcpDeleteBackendInput,

  'data-connection': empty,
  'list-tables': empty,

  'list-connectors': empty,
  'create-connector': mcpCreateConnectorInput,

  'set-visibility': mcpSetVisibilityInput,
  'share-with': mcpShareWithInput,

  quota: mcpQuotaInput,
  provision: mcpProvisionInput,
  'publish-app': mcpPublishAppInput,
  'mobile-channel': mcpMobileChannelInput,
  'mobile-rollback': mcpMobileRollbackInput,
  'set-rollout': mcpSetRolloutInput,
} as const satisfies Record<McpToolName, z.ZodTypeAny>;

/** 工具描述。会直接呈现给模型，措辞影响调用准确性。 */
export const MCP_TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  'list-apps':
    '列出当前用户已发布的所有页面：路径、访问地址、类型、状态、可见范围、当前版本。'
    + '**动手之前先调它**——用来回答"我有哪些页面"，也用来避免部署时撞上已有路径。',
  'list-backends':
    '列出当前用户的后端应用：名字、访问地址、源（镜像或 Git）、端口、运行状态。'
    + '创建新后端前先看一眼——已有的那个通常就够用：后端属于用户不属于页面，'
    + '该用户所有页面都能调同一个后端（同域名同源，不用配 CORS）。配额只有 2 个。',
  'app-status':
    '查看某个页面的详细状态：当前版本、大小、最近发布时间与入口、可见范围、已分享给谁。'
    + '用户说"我那个页面怎么打不开"时先查它。',

  deploy:
    '把前端构建产物部署到当前用户的空间。发布前自动扫描硬编码密钥，命中即阻断。部署成功后返回可访问的 URL。'
    + '想让页面在卡片上有封面图：在 index.html 里加 '
    + '<meta property="og:image" content="./cover.png">，或在产物根目录放一张 '
    + 'cover.png/.jpg/.webp。没有则卡片显示首字母。',
  rollback: '把某个已部署的应用回滚到历史版本。回滚是软链切换，秒级生效。',
  releases: '列出某个应用的历史版本，含版本号、发布时间、发布入口与大小。',
  provision: '开通一位新员工：建静态目录、建独立数据 schema、登记用户路径与配额。仅管理员可用。',
  'create-backend':
    '为需要服务端能力的场景创建后端应用（长连接、定时任务、Python 服务等）。'
    + '每人默认上限 2 个，单个 0.5 vCPU / 512 MB。'
    + '**先看 list-backends**：后端属于用户不属于页面，已有的那个就能给新页面用——'
    + '它的地址与用户所有页面同域名同源，直接 fetch 即可，不用配 CORS，也不用再建一个。'
    + '另外，只是要存数据的话不需要后端，用 data-connection 那条路，不占这个配额。'
    + '带前台页面、要作为应用露出到用户空间的全栈项目，建时置 exposed=true；'
    + '纯给自己页面供 API 的服务保持默认（不露出）。',
  'delete-app':
    '删除一个页面及其全部历史版本，不可恢复。只有用户明确要求删除时才调用；'
    + '"清理一下"这类模糊说法要先问清楚删哪个。',

  'redeploy-backend':
    '让后端重新拉取源并启动。用在：改了镜像 tag、推了新代码、'
    + '或后端状态是"已停止"需要救活。比删了重建好——访问地址不变。',
  'delete-backend': '删除后端应用，容器与路由一并移除，容器内数据不保留。不可恢复。',

  'data-connection':
    '取当前用户数据空间的连接信息（REST 地址、匿名公钥、schema 名）与接入要点。'
    + '**应用需要存数据时必须先调它**——每个人的 schema 是独立的，不调就写不出正确的代码。'
    + '返回的公钥本就设计为发到前端，可以写进代码；数据库密码平台不下发。',
  'list-tables':
    '列出当前用户数据空间里已有的表、行数与行级隔离是否开启。'
    + '建表前先看，避免重名；也用来回答"我的数据存了多少"。',

  'list-connectors':
    '列出当前用户能用的外部 API 连接器，以及平台内置的可选目录。'
    + '**页面要调用任何外部接口之前先调它**：能直接用现成的就别新建；'
    + '也用来拿到调用地址，形如 /deploy/api/connect/{slug}/{上游路径}。',
  'create-connector':
    '登记一个外部 API 连接器。凭据交给平台加密保管，页面此后调 '
    + '/deploy/api/connect/{slug}/... 即可，**代码里不出现任何密钥**。'
    + '这是需要 key 的接口的唯一正确接法——把 key 写进前端代码会被发布链路阻断。'
    + '顺带也解决跨域：对页面来说这是同源请求。'
    + 'baseUrl 是出站白名单，代理只允许访问它的前缀之下。',

  'set-visibility':
    '设置页面的可见范围。做完一个页面想给同事用时调它——'
    + '改成 public 会同时上架创意市场，改成 private 会连带收回已有分享。',
  'share-with': '把页面分享给指定同事。对方主页会出现待接受卡，接受后即可访问。',

  quota: '查询当前用户的用量与配额：静态空间、后端应用数、数据行数。',
  'publish-app':
    '把 expo export 的产物发布到当前用户的手机更新通道，装了 App 的设备下次打开即可拿到。'
    + 'runtimeVersion 必须与壳一致，否则服务端不下发（表现为设备一直收不到更新）。'
    + '改动大时先 preview: true 发到自己的预览通道，或用 rolloutPercent 灰度。'
    + '**底部 tab bar、首页形态、齿轮位置都不在这里配**，而在页面包根目录的 app.json：'
    + 'home 为 nav 时才渲染底部 bar，tabBar.items 最多 5 项，label 最多 6 字，'
    + 'activeColor 必须是 #RRGGBB，icon 只认壳内置的 home/list/calendar/chart/user/'
    + 'clock/star/box/bell/search 十个名字（认不出回落成圆点），'
    + 'route 要与 src/pages/index 导出的 screens 键一一对应。'
    + '完整说明见仓库 docs/guides/page-bundle-config.md。',
  'mobile-channel':
    '查看当前用户的手机更新通道：当前到端版本、放量比例、活跃设备数、历史版本。'
    + '发布前后都该看一眼。',
  'mobile-rollback':
    '把手机通道指回上一个（或指定的）版本。回滚是服务端切指针，1 分钟内全部设备生效。'
    + '发现新版本有问题时第一时间调它，比重新发一版快得多。',
  'set-rollout': '调整某个版本的放量比例。先 10 或 50 观察，无异常再放到 100。',
};
