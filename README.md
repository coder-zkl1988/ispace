# iSpace

自托管的内部 AI 应用平台。让不写代码的人也能把一个页面发布到公司域名下、
分享给同事、并在手机上打开——用一句话完成，而不是提一张运维工单。

```
你：把这个周报页面发到我的空间，叫「周报」

Claude 调用 MCP → 密钥扫描 → 原子切换软链 → 发布完成
        https://ispace.example.com/lixiao/zhoubao/
```

发布链路带密钥扫描与 XSS 检查，每个人有独立的数据 schema 与配额，
所有动作进审计日志。同一套东西有网页控制台、命令行和手机壳三个入口。

> **状态**：核心闭环已跑通并在生产使用。这是一个真实内部平台的开源版本，
> 不是演示项目。文档与注释为中文。

---

## 它解决什么

公司里会用 AI 写点小工具的人越来越多，卡住他们的从来不是写代码，
而是写完之后：放哪、怎么给别人看、数据存哪、要不要找运维开机器。

iSpace 把这一段变成基础设施：

| 需求 | 平台给的 |
|---|---|
| 我的页面放哪 | `/{你}/{应用}/`，公司域名下的固定地址，发布秒级生效、可回滚 |
| 怎么发 | Claude 里一句话（MCP）、`ai-deploy` 命令行、或控制台上传 |
| 要存数据 | 每人一个 Postgres schema + RLS，连接信息 MCP 直接给模型 |
| 要个后端 | 控制台点一下开一个容器，CPU / 内存限额强制写入 |
| 给同事用 | 分享给个人，或上架内部「创意市场」 |
| 手机上看 | Expo 壳，页面可作为 tab 嵌入，支持自托管热更新 |
| 别把密钥发出去 | 发布链路 gitleaks 扫描，命中即阻断并留痕 |

---

## 架构

```
                   Traefik（Dokploy 内置，80/443）
                               │
     ┌─────────────────┬───────┴────────┬──────────────────┐
     │                 │                │                  │
静态托管 + portal   deploy-service   updates-service    Supabase
 (Caddy 多租户)     REST + MCP 同进程  expo-updates 协议   每用户一 schema
     │                 │                                  + RLS
/srv/sites         Dokploy REST API
/srv/releases      （建后端、绑路径、写限额）
```

几个有意为之的选择：

- **静态站点是单个多租户 Caddy 容器**按路径映射用户目录，不是「一人一个
  Dokploy 应用」——后者到几十人就撑不住了。只有确需自定义后端时才经
  Dokploy API 建独立应用。
- **单域名 + 路径**（`/{user}/{app}/`），不用泛域名。一条 A 记录、
  HTTP-01 自动签发，不需要 DNS API 凭据。代价是用户名与平台路径共享命名空间，
  用 `RESERVED_PATHS` 强校验对冲。
- **平台 chrome 在发布期注入**（往 `index.html` 塞 `<script src="/platform/shell.js">`），
  不在网关运行期改写响应体——后者要给 Caddy 引入重写插件，且干扰流式响应与缓存。
- **用户页面访问要过鉴权**。Caddy 的 `forward_auth` 先问服务端能不能看再出文件；
  `visibility` 那三档是真的访问控制，不只是展示过滤。

设计决策与其理由的完整记录见
[docs/specs/2026-08-03-ispace-platform-design.md](docs/specs/2026-08-03-ispace-platform-design.md)。

---

## 仓库结构

pnpm workspaces + Turborepo，TypeScript 全栈。

```
apps/
  portal/            统一入口：登录引导、/{user}/ 聚合页、创意市场
  console/           控制台：员工 7 屏 + 管理员 5 屏
  deploy-service/    部署服务 REST + MCP server（同进程，Fastify）
  shell-js/          平台 chrome，构建为 /platform/shell.js 单文件
  updates-service/   自托管 expo-updates 更新服务器
  mobile-shell/      Expo 手机壳
packages/
  contracts/         zod schema + 类型 + 保留字表 + 错误码 —— 全仓唯一真相源
  ui/                设计系统：tokens + React 组件
  copy/              业务口径 / 技术口径 双语文案字典
  auth/              OIDC 抽象层 + 邮箱密码 + session
  orchestrator/      编排抽象：Dokploy（生产）/ Mock（本地与单测）
  storage/           releases 解压 + 软链原子切换 + 回滚
  scanner/           gitleaks + XSS 规则 + base path 校验
  db/                平台元数据库迁移 + 用户 schema provisioning
  agent/             Coding Agent 引擎抽象与工具集
  cli/               ai-deploy
infra/
  dokploy/           compose 定义与路由绑定
  caddy/             Caddyfile
  scripts/           部署脚本（幂等，编号即执行顺序）
docs/                规格、计划、运维手册
```

`packages/contracts` 是骨架的核心资产：实体 schema、API 契约、MCP 工具入参、
`RESERVED_PATHS`、错误码全部在这里定义一次，其余包一律从它导入。
新增平台顶层路径必须同步 `RESERVED_PATHS` 与 `infra/caddy/Caddyfile` 的排除列表。

---

## 快速开始

需要 Node 22+ 与 pnpm 11+。

```bash
pnpm install
pnpm build
pnpm test
```

跑起本机开发环境（需要一个 Postgres）：

```bash
# 1. 起库并跑迁移
export PGHOST=localhost PGPORT=5432 PGDATABASE=postgres PGUSER=postgres
export POSTGRES_PASSWORD=...
export SESSION_SECRET=$(openssl rand -hex 32)

# 2. 开发登录页（生产绝对不要设）
export ISPACE_DEV_LOGIN=1

# 3. 起全部 dev 进程
pnpm dev
```

deploy-service 在 `:3100`（自带 `/deploy/api` 前缀，本机无需网关），
updates-service 在 `:3200`，portal 与 console 由 Vite 起。
没配 `DOKPLOY_URL` 时编排器自动回落 `MockOrchestrator`，本机不需要 Docker。

命令行：

```bash
pnpm --filter @ispace/cli build
ISPACE_BASE_URL=http://localhost:3100 node packages/cli/dist/index.js login
```

---

## 部署到自己的服务器

一台干净的 Linux 机器（4 vCPU / 8 GB / 100 GB 起），80、443、3000 空闲，
一个解析过去的域名。

```bash
cp .env.example .env      # 按注释填写
```

必填的五项：`ISPACE_BASE_URL`、`ISPACE_PUBLIC_BASE`、`ISPACE_DOMAIN`、
`TARGET_HOST`、`ISPACE_ADMIN_EMAIL`。

完整步骤见 **[docs/runbooks/deployment.md](docs/runbooks/deployment.md)**，
部署拓扑与踩过的坑见 [docs/runbooks/server-state.md](docs/runbooks/server-state.md)。

> ⚠️ **公网部署前务必确认 `ISPACE_EMAIL_DOMAINS`。** 它是自助注册的邮箱后缀
> 白名单，留空表示不限——而注册一次就发一个数据 schema 和一份配额。
> 默认值 `example.com` 谁都匹配不上，也就谁都注册不了；这是有意的，
> 宁可失败在关着的那一边。

---

## 配置

全部环境变量及其含义见 **[.env.example](.env.example)**，按用途分成三组：
部署机（跑脚本时读）、服务端（服务运行时读）、手机壳（构建期读，会编译进二进制）。

密钥不走这个文件——它们放在目标机的 `~/.ispace/*.env`（600），由部署脚本注入
compose。理由很简单：`.env` 在开发机上，而密钥不该离开服务器。

HTTP 与 HTTPS 的差别不只是协议：明文 HTTP 会静默关掉一批浏览器能力
（剪贴板首当其冲），安卓与 iOS 还需要额外放行明文流量。
壳会按 `EXPO_PUBLIC_ISPACE_BASE_URL` 的协议自动决定，详见
[apps/mobile-shell/CLEARTEXT.md](apps/mobile-shell/CLEARTEXT.md)。

---

## 接入方式

**MCP**（19 个工具）——`/deploy/mcp`，复用调用者身份，只能操作本人空间，
每次调用进审计日志：

| 类别 | 工具 |
|---|---|
| 看现状 | `list-apps` `list-backends` `app-status` |
| 前端 | `deploy` `rollback` `releases` `delete-app` |
| 后端 | `create-backend` `redeploy-backend` `delete-backend` |
| 数据 | `data-connection` `list-tables` |
| 分享 | `set-visibility` `share-with` |
| 手机端 | `publish-app` `mobile-channel` `mobile-rollback` `set-rollout` |
| 其他 | `quota` `provision` |

**CLI**：

```bash
ai-deploy up ./dist /zhoubao      # 发布产物
ai-deploy releases /zhoubao       # 历史版本
ai-deploy rollback /zhoubao v11   # 回滚
ai-deploy backend create          # 申请后端
ai-deploy quota                   # 用量与配额
```

**REST**：`/deploy/api/*`，契约由 `packages/contracts` 生成 OpenAPI。

---

## 登录

默认**邮箱 + 密码**，开箱可用。公司 SSO（OIDC）是可选的第二条路，
配齐 `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` 即启用，
接法见 [docs/runbooks/sso-setup.md](docs/runbooks/sso-setup.md)。

平台身份与应用终端用户是两层，不要混：员工登录控制台走 SSO 或邮箱密码；
每个用户应用自己的登录走 Supabase Auth，数据落在该用户的 schema 内。

---

## 文档

| 文档 | 内容 |
|---|---|
| [平台设计规格](docs/specs/2026-08-03-ispace-platform-design.md) | 全部决策及其理由、数据模型、路由、验收标准 |
| [应用层实现计划](docs/plans/2026-08-03-02-application-build.md) | 分阶段构建顺序与接口边界 |
| [部署手册](docs/runbooks/deployment.md) | 从空机器到跑起来 |
| [部署拓扑与运维基线](docs/runbooks/server-state.md) | 请求链路、目录、端口、踩过的坑 |
| [SSO 接入](docs/runbooks/sso-setup.md) | OIDC 配置与账号衔接 |
| [iOS 构建](docs/runbooks/ios-build.md) | 手机壳的 iOS 出包 |
| [页面包配置](docs/guides/page-bundle-config.md) | `app.json` 声明格式 |
| [明文 HTTP 的代价](apps/mobile-shell/CLEARTEXT.md) | 安全上下文与原生开关 |

---

## 技术栈

TypeScript 5 · Node 22 · Fastify · zod · Postgres（Supabase）· React 19 ·
Vite · Expo / React Native · Caddy · Traefik · Dokploy · pnpm · Turborepo · Vitest

后端选 TypeScript 是因为 MCP SDK、Expo 同属 JS 生态，可与前端共享
`contracts` 的类型与鉴权中间件；这里跨语言的收益为零。

---

## License

[MIT](LICENSE)
