# 飞书登录与内网链接分享：研发评审交接

复核日期：2026-10-28。基于上游 `a6bbca9`，供研发评估迭代；不是生产验收或直接上线结论。

## 需求与实现

1. 企业自建飞书应用授权登录：公司租户校验、首次自动建号与开通空间，已有账号由登录后的用户主动绑定。
2. 新增 `link` 分享：公司网络内持应用 URL 可免登录访问，不进入创意市场。静态页面、全栈项目、显式开放的纯 API 后端支持。
3. 认证和权限边界：一次性浏览器绑定 OAuth state、可信代理链和网段校验、权限撤销、会话世代校验及应用规范 URL 跳转。
4. HTTP/MCP 使用同一分享事务；接受分享、添加引用与审计同事务提交，与作者收回分享采用相同的资源锁顺序。

## 本次推送前复核

- 上游 `main` 已重新 fetch；检查时没有新增上游提交或合并冲突。
- 新发现并修复“接受分享与收回分享并发”时可能留下安装入口的问题。
- 新增真实 PostgreSQL 回归：安装引用失败时接受动作整体回滚；使用数据库触发器建立确定性的并发时序，检查收回到 private/link 后均无残留授权与安装记录。
- **最终回归：85 个测试文件、975 项测试通过，0 失败、0 跳过。**
- 后端及依赖类型检查通过；补丁空白检查通过。

上一轮还完成了：全仓类型检查、门户/控制台/服务构建、36 个数据库迁移、真实 Caddy 转发及浏览器登录/匿名访问/撤销分享测试。飞书侧使用测试响应，不是真实公司应用联调。

既有赛事测试的过时断言已对齐上游 `e196c0bf` 在 2026-10-22 确认的票数展示规则；未修改赛事生产逻辑。

## 研发需要确认的事项

| 事项 | 当前方案/边界 |
|---|---|
| 公司登录接法 | 当前按企业自建飞书应用直连实现。如公司要求统一 SSO 网关，需调整 provider 接入方式 |
| 应用配置 | 需要真实 App ID、App Secret、tenant_key、应用权限/可用范围和生产回调 URL；凭据只在服务端配置 |
| 存量账号 | 不按同名或同邮箱自动合并。需确定员工清单、原账号恢复/绑定流程；邮箱权限缺失时先完成存量绑定 |
| 公司网络 | 需确认办公/VPN/出口 CIDR、真实代理链和防止直连容器的入口限制。默认不配置白名单就拒绝 link |
| 动态页面依赖 | 个人连接器、数据管理和其他管理接口仍需要登录。依赖这些接口的页面需要应用级授权适配，不能只开放 HTML 后就视为完整可用 |
| 数据权限 | 页面可见性不能代替业务表 RLS，也不能把所有者凭据交给游客 |
| 生产验收 | 必须以真实员工、真实内外网、静态页面和带接口项目分别验收。本地测试不能替代该步骤 |

## 主要评审入口

- [飞书 provider](../../packages/auth/src/feishu.ts)
- [账号绑定与开通](../../apps/deploy-service/src/services/feishu-account.ts)
- [OAuth state](../../apps/deploy-service/src/services/oauth-state.ts)
- [统一分享事务](../../apps/deploy-service/src/services/visibility.ts)
- [分享接受与撤销](../../apps/deploy-service/src/routes/shares.ts)
- [公司网络与代理来源](../../apps/deploy-service/src/services/intranet.ts)
- [页面访问判定](../../apps/deploy-service/src/services/app-access.ts)
- [后端访问代理](../../apps/deploy-service/src/routes/svc-proxy.ts)
- [数据库增量迁移](../../packages/db/migrations/0036_feishu_link_access.sql)
- [部署与回滚说明](../runbooks/feishu-link-sharing.md)

## 复现验证

使用可清空的一次性 PostgreSQL；测试会删除并重建 `ispace` schema，不能指向生产数据库。

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run typecheck
ISPACE_TEST_PG='<一次性测试数据库连接串>' \
ISPACE_TEST_CADDY='<Caddy 可执行文件绝对路径>' \
node node_modules/vitest/vitest.mjs run --configLoader runner --no-file-parallelism
```

缺少这两个环境变量时，原生数据库或 Caddy 集成测试会按条件跳过；本次两项均提供，所以是零跳过。

## 合并及发布注意

新增迁移 `0036_feishu_link_access.sql`。先准备后端配置和迁移，再配置网关、发布前端；更新容器环境变量需要重建容器。回滚到旧应用代码前，先把 link 资源恢复为 private，避免旧版枚举和界面不识别新档位。没有执行生产部署。
