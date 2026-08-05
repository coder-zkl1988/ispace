# ispace 内部 AI 应用部署平台 · 设计规格

- **日期**：2026-08-03
- **状态**：待用户评审
- **上游输入**：技术方案 v1.2（2026-07-31）、设计稿两份（`AI 应用部署平台 Tabby.dc.html`、`手机壳 App.dc.html`）
- **本文档范围**：全仓骨架的结构与契约 + 一期（核心闭环）的实现边界

---

## 1. 本文档解决什么

技术方案 v1.2 是一份四期 24 周的路线图，覆盖至少六个可独立开发的子系统。设计稿则给出了远比方案具体的产品形态，并在若干处与方案冲突。本文档做三件事：

1. 记录所有已拍板的决策及其理由，作为实现期的唯一裁决依据；
2. 定义全仓骨架的包边界与契约层——包括三、四期才实现的类型，使后续各期只填实现、不改契约；
3. 划清一期的实现边界与验收标准。

本文档不复述技术方案 v1.2 中未被修改的内容。凡本文档未提及处，以 v1.2 为准；凡冲突处，以本文档为准。

---

## 2. 决策清单

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 首轮交付形态 | 全仓骨架 + 一期填实 | 后续各期不必重构包边界 |
| D2 | 后端语言 | TypeScript / Node | MCP SDK、Codex SDK、Expo 同属 JS 生态，可共享 `contracts` 类型与鉴权中间件；跨语言收益为零 |
| D3 | Monorepo 工具 | pnpm workspaces + Turborepo | 与 D2 一致，增量构建缓存 |
| D4 | 前端栈 | React + Vite + Tailwind | 与三期 Expo（React Native）共享心智模型 |
| D5 | SSO | OIDC 抽象层 + dev mock provider | 公司 IdP 未定；接真实 IdP 时只改环境变量，零改代码 |
| D6 | 用户空间路径 | `/{user}/{app}/`（无 `@`） | 依设计稿。代价是命名空间共享，以保留字表强校验对冲（见 §5.2） |
| D7 | 域名策略 | 单域名 + 路径 | 依方案第 3 章：一条 A 记录、HTTP-01 自动签发、无需泛解析与 DNS API 凭据。设计稿中的 `deploy.*`/`updates.*` 子域名仅为文案，改为路径不影响任何视觉 |
| D8 | 根路径行为 | `/{user}/` 渲染「我的页面」聚合页 | 依设计稿。方案第 3 章「302 直达本人页面」隐含"一人一个页面"假设，被设计稿的 8 页面场景推翻 |
| D9 | 双口径文案 | 一期即做，集中于 `packages/copy` | 后补需改遍所有组件 |
| D10 | 分享/市场/串门 | 契约全定义；一期实现到「分享给个人 + 接受/拒绝」 | 避免二期改库；创意市场 UI 二期，移动端串门三期 |
| D11 | 容器编排 | Dokploy（一期即用） | 用户决策。服务器将清空后专用于本平台 |
| D12 | 目标机形态 | 专用单机，不与其他服务混跑 | Dokploy 要接管 80/443 并 `swarm init`，与机器上既有的容器编排相互干扰 |

---

## 3. 与技术方案 v1.2 的偏离

以下条目是本文档对 v1.2 的实质修改，实现时以本文档为准。

### 3.1 路径格式（改）

v1.2 为 `/@{user}/`，本方案为 `/{user}/`（D6）。

代价：用户名与平台保留路径落入同一命名空间。对冲手段——保留字表定义为 `packages/contracts` 中的单一常量 `RESERVED_PATHS`，用户注册与改名时强校验，且平台新增任何顶层路径必须先加入该常量。该常量是唯一真相源，不得在别处复制。

### 3.2 根路径与目录层级（改）

v1.2 中 `/srv/sites/{user}/` 存放该用户的单份站点产物。本方案下每位用户可有多个应用，故目录多一层：

```
/srv/sites/{user}/{app}/              当前版本（软链）
/srv/releases/{user}/{app}/{ts}/      历史版本
```

`/{user}/` 不再是静态目录，而由 portal 渲染聚合页。

### 3.3 方案未覆盖、设计稿要求的功能（增）

| 功能 | 设计稿依据 | 本方案处理 |
|---|---|---|
| 创意市场 | PC 顶部第二个 tab；「分享到全公司」「添加到我的」「23 人在用」 | 契约与建表一期完成，UI 二期 |
| 分享给个人 / 接受拒绝 | PC 顶部分享卡；手机 14 屏待接受卡 | 一期实现 |
| 串门（临时切换到他人通道） | 手机 12/13 屏：切通道约 3 秒、顶部来源条、退出回自己 | 契约一期定义，实现三期 |
| 页面分组 | 常用 / 日常 / 客户跟进 / 小工具 | 一期实现 |
| 业务口径 / 技术口径 | 全局开关，同一界面两套文案 | 一期实现 |
| 员工视角 / 管理员视角 | 管理员独立 5 屏控制台 | 一期实现 |
| 应用三分类 | 静态页 / 静态页+后端 / H5 | 一期实现；H5 在壳内 webview 打开、可嵌为 tab、**不切通道** |
| `publish-app` MCP 工具 | 接入指引列出 7 个工具 | 契约一期定义，实现三期 |
| 构建态 | 页面状态含「构建中」 | 一期实现：发布为异步任务，有中间态 |

### 3.4 壳入口位置（改）

v1.2 §5.5 为「贴边可折叠悬浮胶囊」。设计稿第 07 屏明确为「标题栏右上角常驻齿轮，壳保留位，由壳绘制、永远在页面之上，页面布局需避让该角落」。以设计稿为准。

`app.json` 中 `shellEntry: { edge, collapsed }` 保留为可声明字段，但默认与语义按设计稿：右上角保留位。

---

## 4. 系统架构

```
                      Traefik（Dokploy 内置，80/443）
                                  │
        ┌─────────────────┬───────┴────────┬──────────────────┐
        │                 │                │                  │
   静态托管+portal    deploy-service    updates-service    Supabase
   (Caddy + portal)   REST + MCP        expo-updates 协议   (Dokploy 模板)
   Dokploy Compose 应用     │                                  │
        │                   │                                  │
   /srv/sites          Dokploy REST API                  每用户一 schema
   /srv/releases       （建后端应用、绑路径、写限额）           + RLS
```

关键点：静态站点是**单个多租户 Caddy 容器**按路径映射用户目录，不是"一人一个 Dokploy 应用"——后者无法规模化。只有确需自定义后端的场景才经 Dokploy API 创建独立应用。

---

## 5. 仓库结构与包边界

### 5.1 结构

```
ispace/
├── apps/
│   ├── portal/            统一入口：/ 登录引导、/{user}/ 聚合页、创意市场
│   ├── console/           控制台：员工 8 屏 + 管理员 5 屏
│   ├── deploy-service/    部署服务 REST + MCP server（同进程，Fastify）
│   ├── shell-js/          平台 chrome，构建为 /platform/shell.js 单文件
│   ├── updates-service/   expo-updates 自托管更新服务器（三期填实）
│   └── mobile-shell/      Expo 双层壳（三期填实）
├── packages/
│   ├── contracts/         zod schema + TS 类型 + OpenAPI + 错误码
│   ├── ui/                Tabby 设计系统：tokens + React 组件
│   ├── copy/              业务口径 / 技术口径 双语文案字典
│   ├── auth/              OIDC 抽象层 + mock provider + session
│   ├── orchestrator/      编排抽象：Dokploy（生产）/ Mock（本地与单测）
│   ├── storage/           releases 解压 + 软链原子切换 + 回滚
│   ├── scanner/           gitleaks + XSS 规则 + base path 校验
│   ├── db/                平台元数据库迁移 + 用户 schema provisioning
│   └── cli/               ai-deploy
├── infra/
│   ├── dokploy/           应用定义与域名绑定脚本
│   ├── caddy/             Caddyfile
│   └── scripts/           服务器部署与清理脚本（幂等）
└── docs/specs/
```

### 5.2 `packages/contracts`——骨架的核心资产

全仓唯一真相源，导出：

- **实体类型与 zod schema**：§6 全部 12 张表的读写模型
- **API 契约**：deploy-service 全部端点的 request/response schema，并据此生成 OpenAPI
- **MCP 工具定义**：7 个工具的入参 schema
- **`RESERVED_PATHS`**：保留字表唯一定义处
- **`AppJsonSchema`**：移动端页面包声明（三期用，一期定义）
- **`UpdateManifest`**：expo-updates manifest 结构（三期用，一期定义）
- **`AgentSession` / `AgentEvent`**：Coding Agent 会话与事件（四期用，一期定义）
- **错误码枚举**：跨包统一

三、四期的类型在一期即全部定义，是 D1 的核心兑现方式。

### 5.3 `packages/orchestrator`

```ts
interface Orchestrator {
  createBackendApp(spec: BackendAppSpec): Promise<BackendAppRef>
  bindPath(ref: BackendAppRef, path: string): Promise<void>
  setLimits(ref: BackendAppRef, limits: ResourceLimits): Promise<void>
  getStatus(ref: BackendAppRef): Promise<BackendStatus>
  restart(ref: BackendAppRef): Promise<void>
  getLogs(ref: BackendAppRef, opts: LogOptions): Promise<LogChunk[]>
}
```

两个实现：`DokployOrchestrator`（走 Dokploy REST API）与 `MockOrchestrator`。后者不是占位——开发机未安装 Docker，Mock 是本地开发与单测的唯一路径。资源限额由 `setLimits` 在建应用时强制写入，不依赖用户自觉。

---

## 6. 数据模型

平台元数据库（独立 Postgres schema，与用户数据 schema 分离）：

| 表 | 关键字段 | 一期 |
|---|---|---|
| `users` | sso_subject, username, display_name, role(employee\|admin), identity(user\|developer), status, archived_at | 实现 |
| `app_groups` | owner_id, name, sort_order | 实现 |
| `apps` | owner_id, slug, name, description, icon_letter, type(static\|static_backend\|h5), status(running\|building\|stopped), current_release_id, group_id, sort_order, visibility(private\|shared\|public) | 实现 |
| `releases` | app_id, version, source(mcp\|cli\|agent\|console), size_bytes, path, status, published_at, published_by, blocked_reason | 实现 |
| `shares` | app_id, from_user_id, to_user_id, status(pending\|accepted\|rejected\|revoked) | 实现 |
| `app_installs` | app_id, user_id, source(share\|marketplace) | 实现 |
| `marketplace_listings` | app_id, published_by, published_at, install_count | 建表 |
| `backends` | owner_id, app_id, name, source_repo, cpu_limit, mem_limit, status, url_path | 实现 |
| `quotas` | user_id, static_bytes_used/limit, backend_count_used/limit, db_rows_used/limit | 实现 |
| `audit_logs` | actor_id, action, target_type, target_id, source, result, metadata | 实现 |
| `mobile_channels` | user_id, channel_name, current_release_id, rollout_percent | 建表 |
| `mobile_releases` | user_id, bundle_version, runtime_version, manifest, rollout_percent, status | 建表 |

默认配额（取自设计稿「配额与用量」屏）：静态空间 500 MB、后端应用 2 个、单后端 0.5 vCPU / 512 MB、数据行数 50,000。审计日志保留 12 个月。90 天无访问的应用先通知后归档。

用户业务数据不落此库：每位用户一个 `u_{username}` schema，配合 RLS，按方案 §4.3。

---

## 7. 路由与命名空间

```
/                      portal：未登录引导；已登录 302 → /{me}/
/{user}/               portal：我的页面聚合（分组卡片墙、分享待接受卡）
/{user}/{app}/*        Caddy：/srv/sites/{user}/{app}/ 静态产物
/console               console SPA（员工与管理员同一入口，按角色渲染）
/deploy/api/*          部署服务 REST
/deploy/mcp            MCP server
/updates/*             更新服务
/platform/shell.js     平台 chrome
/supabase/*            Supabase Kong
/svc/{user}/{app}      用户自定义后端
```

注：v1.2 将自定义后端排在二期，前提是一期没有 Dokploy。D11 使 Dokploy 在一期即可用，`DokployOrchestrator` 又是一期必写的（否则 console「后端应用」屏无真实数据），故自定义后端随之进入一期。这是 D11 的连带结果，非范围蔓延。

`RESERVED_PATHS` 至少含：`console` `deploy` `updates` `platform` `supabase` `svc` `api` `assets` `static` `_` `admin` `login` `logout` `health`。新增顶层路径必须同步该常量。

---

## 8. 认证与身份

**两层认证必须分清**（方案 §4.3 原则保留）：

- **平台身份**：员工登录控制台、CLI、手机壳，走公司 SSO（OIDC）。一期用 mock provider，可切换身份与开发者角色以便本地验证。
- **应用终端用户**：每个用户应用自己的登录（邮箱/手机号），走 Supabase Auth，数据落在该用户 schema 内。

**身份维度**：`identity ∈ {user, developer}` 取自 SSO 档案，决定移动端首页形态与 Agent 功能可见性。**角色维度**：`role ∈ {employee, admin}` 决定控制台视角。两者正交。

同源治理：脚手架模板强制为每个应用配置独立 `storageKey`（`sb-{user}-{app}`），避免共享 localStorage 下认证 token 互相覆盖或越权读取。

---

## 9. 发布流水线

```
接收产物 → 密钥扫描(gitleaks) → XSS 基础规则 → base path 校验
        → 注入 shell.js → 解压至 releases/{ts} → 原子切换软链
        → 写 releases 表与 audit_logs → 更新配额用量
```

任一扫描命中即阻断，`releases.status = blocked`，`blocked_reason` 记录原因，审计留痕（设计稿「发布记录」屏有「被阻断 3」计数与「已阻断」状态）。

发布为异步任务，`apps.status` 经 `building` 中间态，与设计稿一致。

平台 chrome 采用**发布期注入**（方案 §4.7）：向 `index.html` 注入 `<script src="/platform/shell.js">`。不选网关运行期改写，因其需给 Caddy 引入响应体重写插件，且干扰流式响应与缓存。

MCP 工具共 7 个（设计稿「接入指引」屏列出）：`deploy` `rollback` `releases` `provision` `create-backend` `quota` `publish-app`。前 6 个一期实现；`publish-app` 发布的是移动端页面包，依赖三期的 updates-service，一期仅定义契约、实现体返回 `NotImplemented`。

全部工具复用调用者 SSO 身份，仅能操作本人空间，每次调用进审计日志。

---

## 10. 设计系统与文案

`packages/ui` 移植设计稿的 Tabby 设计系统：暖奶油画布 `#fcfcf8`、近黑主操作色 `#1c1f23`、橙点缀 `#fb923c`（约 10% 法则）、青色 `#3db9ce` 承担链接与焦点环。字体 Manrope（正文 13px）、Caveat（仅 hero 问候）、JetBrains Mono（代码与全部数字）。卡片 16px 圆角 + 1px 发丝描边。状态用 6px 圆点 + 胶囊，不用大面积彩色横幅。

组件：Avatar / Badge / Button / Card / Dialog / IconButton / Input / NavItem / StatusDot / Switch / Tabs。

`packages/copy` 导出双口径文案字典，组件经 context 取值，不得内联中文字面量。

---

## 11. 一期交付边界

**填实**：

- portal 全部（登录引导、`/{user}/` 聚合页、分组、分享待接受卡）
- console 员工 7 屏：空间总览、我的页面、后端应用、数据空间、配额与用量、发布记录、接入指引
- console 管理员 5 屏：平台总览、员工与开通、资源与配额、审计与安全、平台巡检
- deploy-service REST + 6 个 MCP 工具（除 `publish-app`）
- CLI、shell.js、扫描链路、provisioning、分享给个人
- `DokployOrchestrator` 与自定义后端开通

**空状态渲染**：console「更新通道」屏一期完成 UI，但 `mobile_channels` / `mobile_releases` 在三期前无数据，渲染为「手机应用尚未开通」空态。不得以假数据充数。

**留骨架**（可编译、类型完整、接口签名齐全、实现体返回 `NotImplemented`）：updates-service、mobile-shell、agent 子系统、创意市场 UI、移动端串门、`publish-app`。

---

## 12. 服务器环境

**最低配置**：Linux（Ubuntu 22.04+ 或同等）、Docker 24+、4 vCPU / 8 GB / 100 GB 磁盘。
参考部署跑在 12C / 30G / 1.9T 的单机上，承载全部组件。

**前置条件**：

1. 80 / 443 / 3000 空闲——Traefik 要接管 80/443，Dokploy UI 用 3000；
2. 一个解析到该机器的域名（`ISPACE_DOMAIN`）；
3. 一个可 sudo 的部署用户，且已装好 SSH 公钥。自动化脚本必然高频连接，
   多数 sshd 在连续密码认证后会开始拒绝，密码认证不可用。

**部署**：装 Dokploy（需 sudo），它自带的 Traefik 接管 80/443。公网部署走
`websecure` 入口 + Let's Encrypt 自动签发；内网无证书场景把
`ISPACE_TRAEFIK_ENTRYPOINT` 设为 `web` 以 HTTP 运行——代价见
`apps/mobile-shell/CLEARTEXT.md`：明文 HTTP 会静默关掉一批浏览器能力，
安卓与 iOS 还需要额外放行明文流量。

步骤见 `docs/runbooks/deployment.md`，拓扑与踩坑见 `docs/runbooks/server-state.md`。

---

## 13. 一期验收标准

1. `docker compose` 起全栈后，mock SSO 登录 → 落在 `/{user}/` 聚合页，顶部 header 常驻；
2. CLI 推送 dist 产物 → 浏览器访问 `/{user}/{app}/` 正常渲染，页面顶部有平台 header；
3. Claude 中经 MCP 一句话完成部署；
4. 控制台可见该次发布记录、配额用量变化；
5. 回滚至上一版本，秒级生效；
6. 含硬编码密钥的产物被阻断，审计中可见「已阻断」记录；
7. 新用户 provisioning 全自动：建目录 + 建 Supabase schema + 登记路径；
8. 分享给同事 → 对方聚合页出现待接受卡 → 接受后成为常驻入口。

---

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| 无 `@` 前缀导致用户名与平台路径冲突 | `RESERVED_PATHS` 单一常量 + 注册强校验；新增平台路径必须同步该常量 |
| Supabase Kong 子路径出口异常 | 一期逐服务验证 base path / stripPrefix；不可行则退化为独立端口 + 入口页跳转 |
| PostgREST schema 动态开通需平滑重载 | 一期专项验证；不可行则退化为按批次定时开通 |
| 单域名同源，应用间 XSS 可波及 | 模板强制 `storageKey` 命名空间；发布链路 XSS 扫描；高敏应用升级独立子域名 |
| 与目标机上既有服务冲突 | 用专用机（D12）；装 Dokploy 前确认 80/443/3000 空闲、Swarm 未启用 |
| Dokploy `swarm init` 影响既有容器 | 清理后再装，机器上不再有其他容器 |
| 骨架中三四期类型定义偏离实际 | 契约以官方规范为准（expo-updates 协议、Codex SDK），非自创；偏离时改契约而非绕过 |

---

## 15. 后续

本文档批准后进入实施计划编写。三期、四期各自需要独立的设计规格，不在本文档范围内。
