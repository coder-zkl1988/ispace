/**
 * 双口径文案（规格 D9）。
 *
 * 设计稿在 PC 控制台与手机壳两处都有「业务口径 / 技术口径」全局开关：
 * 同一个界面，给非技术员工看业务说法，给开发者看技术说法。
 *
 * 为什么一期就做而不是后补：文案若散落在各组件里，事后要改遍所有组件；
 * 集中在这里，加口径只是给每个 key 多写一个值。
 *
 * 组件内不得内联中文字面量，一律 useCopy() 取。
 */

export type Tone = 'business' | 'technical';

/** 每条文案两个口径。只有一种说法时两边写一样，不要省略——省略会让"哪些还没写技术口径"变得不可查。 */
type Entry = { business: string; technical: string };

const DICT = {
  // ── 通用 ──────────────────────────────────────────────────────────
  'app.name':            { business: 'iSpace',       technical: 'iSpace' },
  'nav.myPages':         { business: '我的页面',     technical: '我的页面' },
  'nav.market':          { business: '创意市场',     technical: '创意市场' },
  'nav.console':         { business: '控制台',       technical: '控制台' },
  'action.share':        { business: '分享',         technical: '分享' },
  'action.manage':       { business: '管理',         technical: '管理' },
  'action.accept':       { business: '接受',         technical: '接受' },
  'action.reject':       { business: '拒绝',         technical: '拒绝' },
  'action.copyAddress':  { business: '复制地址',     technical: '复制地址' },
  'action.visit':        { business: '访问空间',     technical: '访问空间' },
  'action.rollback':     { business: '回滚',         technical: '回滚' },
  'action.retry':        { business: '重试',         technical: '重试' },

  // ── 状态 ──────────────────────────────────────────────────────────
  'status.running':      { business: '运行中',       technical: 'active' },
  'status.building':     { business: '构建中',       technical: 'building' },
  'status.stopped':      { business: '已停止',       technical: 'stopped' },
  'status.blocked':      { business: '已阻断',       technical: 'blocked' },

  // ── 应用类型 ──────────────────────────────────────────────────────
  'type.static':         { business: '静态页',       technical: 'static' },
  'type.staticBackend':  { business: '静态页 + 后端', technical: 'static + backend' },
  'type.h5':             { business: 'H5',           technical: 'h5 (webview)' },

  // ── 发布入口 ──────────────────────────────────────────────────────
  'source.mcp':          { business: 'AI 助手',      technical: 'MCP' },
  'source.cli':          { business: '命令行',       technical: 'CLI' },
  'source.agent':        { business: '手机 Agent',   technical: 'agent' },
  'source.console':      { business: '控制台',       technical: 'console' },

  // ── 空间总览 ──────────────────────────────────────────────────────
  'space.title':         { business: '我的空间',     technical: '我的空间' },
  'space.subtitle': {
    business: '你的地址、配额与最近发布，一屏看完',
    technical: '空间地址、资源配额与发布记录',
  },
  'space.provisioned':   { business: '已开通',       technical: 'provisioned' },
  'space.hint': {
    business: '你的页面都挂在这个地址下，按路径区分',
    technical: '所有应用挂载于该路径前缀下，以第二段路径区分',
  },
  'space.publishedPages': { business: '已发布页面',  technical: '在线应用数' },
  'space.monthlyDeploys': { business: '本月发布',    technical: '本月发布次数' },
  'space.backends':      { business: '自定义后端',   technical: '后端应用' },
  'space.usage':         { business: '空间占用',     technical: '静态存储占用' },

  // ── 一句话发布 ────────────────────────────────────────────────────
  'oneline.title':       { business: '一句话发布',   technical: 'MCP 发布' },
  'oneline.hint':        { business: '在 AI 里说一句话', technical: '经 MCP 工具调用' },
  'oneline.scanNote': {
    business: '发布前自动扫密钥，命中即阻断',
    technical: '发布前执行 gitleaks 规则集与 XSS 静态检查，命中即中断并留痕',
  },

  // ── 我的页面 ──────────────────────────────────────────────────────
  'pages.title':         { business: '我的页面',     technical: '应用列表' },
  'pages.subtitle':      { business: '你的空间地址下的全部页面', technical: '当前用户名下的全部应用' },
  'pages.empty.title':   { business: '加个新页面',   technical: '尚无应用' },
  'pages.empty.hint': {
    business: '在 AI 里说一句「把这个项目部署到我的空间」就行，发布完自动出现在这里',
    technical: '经 MCP 的 deploy 工具或 ai-deploy up 发布后，应用会出现在此列表',
  },
  'pages.empty.copyPhrase': { business: '复制话术',  technical: '复制命令' },

  // ── 数据空间 ──────────────────────────────────────────────────────
  'data.title':          { business: '数据空间',     technical: '数据 schema' },
  'data.subtitle': {
    business: '你的应用数据与终端用户，和同事完全隔离',
    technical: '独立 Postgres schema，配合 RLS 行级隔离',
  },
  'data.isolated':       { business: '隔离已生效',   technical: 'RLS enabled' },
  'data.isolationNote': {
    business: '你的应用写入的数据只在你的空间里，同事看不到，也不会互相覆盖',
    technical: '数据写入 u_{username} schema，跨 schema 访问被 RLS 策略拒绝',
  },
  'data.twoLayerAuth':   { business: '两层登录，别混了', technical: '两级认证边界' },
  'data.platformLogin':  { business: '你登录平台',   technical: '平台身份（SSO）' },
  'data.platformLoginNote': {
    business: '公司 SSO。管的是控制台、命令行、手机应用的身份',
    technical: 'OIDC。作用域为控制台、CLI 与移动壳',
  },
  'data.appLogin':       { business: '同事登录你的应用', technical: '应用终端用户（Supabase Auth）' },
  'data.appLoginNote': {
    business: '应用自己的登录（邮箱/手机号），账号与数据都落在你的数据空间里',
    technical: 'GoTrue 签发，用户表位于该用户自己的 schema 内',
  },

  // ── 配额 ──────────────────────────────────────────────────────────
  'quota.title':         { business: '配额与用量',   technical: '资源配额' },
  'quota.subtitle':      { business: '空间、后端、数据行数的用量与提额', technical: '存储、计算与数据行配额' },
  'quota.exceedNote': {
    business: '超限会限速或拒绝发布，需要更多资源请提申请',
    technical: '超限触发限速或拒绝写入；提额需管理员审批',
  },
  'quota.staticSpace':   { business: '静态空间',     technical: '静态存储' },
  'quota.backendCount':  { business: '后端应用数',   technical: '后端实例数' },
  'quota.dbRows':        { business: '数据行数',     technical: '数据行数（估算）' },
  'quota.webFree':       { business: '网页不占后端配额', technical: '静态应用不计入计算配额' },
  'quota.webFreeNote':   { business: '发多少个页面都可以，只算空间占用', technical: '仅计入存储占用' },
  'quota.idleArchive':   { business: '闲置页面会归档', technical: '闲置回收' },
  'quota.idleArchiveNote': {
    business: '90 天无访问先通知、后归档，可自助恢复',
    technical: '90 天无访问触发通知，逾期归档，可自助恢复',
  },

  // ── 发布记录 ──────────────────────────────────────────────────────
  'audit.title':         { business: '发布记录',     technical: '审计日志' },
  'audit.subtitle':      { business: '发布留痕与被阻断的发布', technical: '操作留痕与阻断记录' },
  'audit.blocked':       { business: '被阻断',       technical: 'blocked' },
  'audit.retention': {
    business: '每次发布都记录「谁、何时、发布了什么」，保留 12 个月',
    technical: '记录 actor / timestamp / target / result，保留 12 个月',
  },

  // ── 后端应用 ──────────────────────────────────────────────────────
  'backend.title':       { business: '后端应用',     technical: '后端实例' },
  'backend.subtitle':    { business: '需要服务端能力时才用，每人默认 2 个', technical: '容器化后端，默认上限 2 个' },
  'backend.note': {
    business: '纯网页不需要后端。需要长连接、定时任务、Python 服务时才申请；每个后端默认 0.5 vCPU / 512 MB，超限需申请',
    technical: '适用于 WebSocket、定时任务或非 JS 运行时。默认限额 0.5 vCPU / 512 MB，由平台强制写入',
  },

  // ── 更新通道（三期，一期空态）────────────────────────────────────
  'mobile.title':        { business: '更新通道',     technical: '移动端更新通道' },
  'mobile.subtitle':     { business: '你的手机应用发布、放量与回滚', technical: 'expo-updates 通道管理' },
  'mobile.empty': {
    business: '手机应用尚未开通。这项功能会随手机壳 App 一起上线。',
    technical: '更新服务尚未部署（三期）。通道与版本记录的数据结构已就绪。',
  },

  // ── 接入指引 ──────────────────────────────────────────────────────
  'guide.title':         { business: '接入指引',     technical: '接入指引' },
  'guide.subtitle':      { business: '一句话部署怎么装、怎么说、怎么回滚', technical: 'MCP 与 CLI 接入方式' },
  'guide.step1':         { business: '装一次',       technical: '注册 MCP server' },
  'guide.step1Note':     { business: '首次会跳公司 SSO', technical: '首次调用触发 OIDC 授权' },
  'guide.step2':         { business: '发布就说一句话', technical: '调用 deploy 工具' },
  'guide.step2Note':     { business: 'AI 自己构建、扫描、发布', technical: '客户端打包后经 MCP 传输，服务端扫描并发布' },
  'guide.step3':         { business: '发错了也一句话', technical: '回滚' },
  'guide.step3Note':     { business: '也可以在页面详情里点回滚', technical: '亦可经 REST 或控制台触发' },
  'guide.cliTitle':      { business: '命令行（习惯终端的话）', technical: 'CLI' },
  'guide.toolsTitle':    { business: 'AI 里能用的动作', technical: 'MCP 工具' },
  'guide.toolsNote': {
    business: '这些动作用的是你自己的身份，只能操作你的空间；每次调用都会进审计日志',
    technical: '工具复用调用者 SSO 身份，作用域限于本人命名空间，全量记入审计',
  },

  // ── 管理员 ────────────────────────────────────────────────────────
  'admin.title':         { business: '平台总览',     technical: '平台总览' },
  'admin.subtitle':      { business: '容量、发布量与需要处理的风险', technical: '容量、吞吐与告警' },
  'admin.users':         { business: '已开通员工',   technical: '已开通账号' },
  'admin.onlineApps':    { business: '在线页面',     technical: '在线应用' },
  'admin.weeklyDeploys': { business: '本周发布',     technical: '本周发布次数' },

  // ── 分享 ──────────────────────────────────────────────────────────
  'share.pendingTitle':  { business: '分享给你',     technical: '待接受的分享' },
  'share.pendingNote': {
    business: '接受后就出现在你的主页，用起来和自己的页面一样；拒绝后这张卡消失',
    technical: '接受后在你的列表中建立引用；拒绝则丢弃该分享记录',
  },
  'share.toWhom':        { business: '分享给同事',   technical: '按用户标识分享' },
} as const satisfies Record<string, Entry>;

export type CopyKey = keyof typeof DICT;

export function t(key: CopyKey, tone: Tone): string {
  return DICT[key][tone];
}

/** 供测试与开发期检查：列出所有 key。 */
export const COPY_KEYS = Object.keys(DICT) as CopyKey[];

/** 两种口径完全相同的条目——多数是专有名词，属正常。 */
export function identicalKeys(): CopyKey[] {
  return COPY_KEYS.filter((k) => DICT[k].business === DICT[k].technical);
}
