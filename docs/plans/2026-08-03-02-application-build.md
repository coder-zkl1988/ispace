# 计划 2：应用层实现 Implementation Plan

> 承接计划 1（服务器基础设施，已完成）。本计划覆盖规格 §11 中「填实」的全部内容。

**Goal:** 把 ispace 从"能服务静态文件的服务器"变成"员工能一句话部署、能在控制台管理、能分享给同事"的平台。

**Architecture:** pnpm workspaces + Turborepo 单仓。`packages/contracts` 为全仓唯一真相源（zod schema + 类型 + 保留字表 + 错误码），所有包从它导入。后端为单个 Fastify 进程（REST + MCP 同进程），前端两个 Vite SPA（portal、console）共享 `packages/ui` 与 `packages/copy`。

**Tech Stack:** TypeScript 5 / Node 22+ / Fastify / zod / Drizzle ORM / Postgres / React 19 / Vite / Tailwind 4 / Vitest

## Global Constraints

- 目标机由 `TARGET_HOST` 指定，远程执行一律走 `infra/scripts/remote.sh`（密钥认证）。
- 平台地址由 `ISPACE_BASE_URL` 指定，用户空间路径 `/{user}/{app}/`，无 `@` 前缀。
- **`RESERVED_PATHS` 只在 `packages/contracts` 定义一次**，`infra/caddy/Caddyfile` 的排除列表必须与之一致；新增平台顶层路径必须同步两处。
- **provisioning 顺序不可调换**：建 schema → 校验存在 → 改 `pgrst.db_schemas` → `NOTIFY reload config` → `NOTIFY reload schema`。反之 PostgREST 全局 503（计划 1 已实测复现，详见 `infra/dokploy/supabase.notes.md`）。回收顺序完全相反。
- **组件内不得内联中文字面量**，一律从 `packages/copy` 取，双口径（业务/技术）。
- 默认配额取自设计稿：静态空间 500 MB、后端应用 2 个、单后端 0.5 vCPU / 512 MB、数据行数 50,000。
- 审计日志保留 12 个月；90 天无访问的应用先通知后归档。
- 密钥不入库。服务端配置读 `~/.ispace/env` 与 `~/.ispace/supabase.env`。

## 构建顺序

| 阶段 | 内容 | 验收 |
|---|---|---|
| A | monorepo 骨架 + `packages/contracts` | `pnpm build` 通过，契约类型可被其他包导入 |
| B | `packages/db`（迁移 + provisioning） | 12 张表建好，开通/回收用户零重启 |
| C | `packages/auth`（OIDC 抽象 + mock） | mock 登录发 session，可切身份与角色 |
| D | `packages/storage` + `packages/scanner` | 解压→软链切换→回滚；密钥命中即阻断 |
| E | `apps/deploy-service` REST | 部署/回滚/版本/配额/开通 接口通 |
| F | `packages/cli` | `ai-deploy up ./dist /zhoubao` 端到端 |
| G | MCP server（与 E 同进程） | Claude 中一句话部署 |
| H | `packages/ui` + `packages/copy` | 组件库可预览，双口径切换 |
| I | `apps/shell-js` | 注入后 header 常驻于用户页面 |
| J | `apps/portal` | 登录落聚合页，分组卡片墙 |
| K | `apps/console` 员工 7 屏 + 更新通道空态 | 真实数据 |
| L | `apps/console` 管理员 5 屏 + `packages/orchestrator` | 建后端、限额强制写入 |
| M | 分享给个人 | 分享→待接受卡→接受 |

每阶段独立提交并可回归。阶段间的接口以 `packages/contracts` 为准，不口头约定。

## 阶段 A 详见下方；B–M 在各自阶段开工前补齐步骤（避免过早细化被实测推翻——计划 1 的经验是实测会改变实现方式）。

---

### 阶段 A：monorepo 骨架与契约层

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`、`.npmrc`
- Create: `packages/contracts/{package.json,tsconfig.json,src/*}`

**Interfaces:**
- Produces: `@ispace/contracts` 导出全部实体 schema、API 契约、`RESERVED_PATHS`、错误码、三四期类型

- [ ] A1 根配置与 workspace
- [ ] A2 `contracts/src/reserved.ts`：保留字表与用户名/应用名校验
- [ ] A3 `contracts/src/entities.ts`：12 张表的 zod schema
- [ ] A4 `contracts/src/api.ts`：deploy-service 端点契约
- [ ] A5 `contracts/src/mcp.ts`：7 个 MCP 工具入参
- [ ] A6 `contracts/src/mobile.ts`：`AppJsonSchema`、`UpdateManifest`（三期用）
- [ ] A7 `contracts/src/agent.ts`：`AgentSession`、`AgentEvent`（四期用）
- [ ] A8 `contracts/src/errors.ts`：错误码枚举
- [ ] A9 单测：保留字校验、schema 往返、Caddyfile 一致性断言
- [ ] A10 `pnpm build` + `pnpm test` 通过，提交
