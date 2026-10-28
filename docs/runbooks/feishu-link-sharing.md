# 飞书登录与公司内网链接分享

## 功能与边界

- 飞书企业自建应用授权后，指定租户员工首次登录自动创建普通员工账号和数据空间。与邮箱自助注册审批分别运行，可信公司身份无需再填写注册表单。
- 新增 `visibility=link`：公司网络内持应用原 URL 可免登录访问；不进入创意市场，切换时删除市场安装引用、收回已有同事分享。普通 URL 不是秘密令牌。
- 静态页面、全栈项目和显式启用 link 的纯 API 后端均支持。private/shared/public 原有登录要求保留。发起指定同事分享会把 private/link 收紧为 shared；HTTP、MCP 与后端同事分享均关闭此前的匿名链接访问。
- 分享不自动开放用户的全部资源。连接器管理/运行时 `/deploy/api/connect/*`、个人数据管理、编辑、发布、删除等继续要求登录。依赖这些用户接口的页面需要改用经过应用授权的后端；不要给匿名访客签发所有者会话或 service-role token。
- 业务表的 Supabase 直连访问由实际 RLS 管理；页面 visibility 不代替数据表授权。公司入口应同时限制 /supabase 等路由。

## 1. 配置飞书

在服务端部署环境（现有脚本读取 `~/.ispace/auth.env`）配置：

```dotenv
FEISHU_APP_ID=<企业自建应用 App ID>
FEISHU_APP_SECRET=<服务端密钥>
FEISHU_TENANT_KEY=<允许登录的公司 tenant_key>
```

在飞书应用中登记唯一可信回调 `${ISPACE_PUBLIC_BASE}/deploy/api/auth/callback`，配置员工可用范围及获取用户基本信息的权限，发布应用。生产使用 HTTPS。

服务端通过授权码获取用户访问令牌，并从用户信息接口校验 tenant_key。仅使用稳定的 app_id + tenant_key + open_id 绑定身份；enterprise_email 用于公司邮箱资料及旧账号冲突提示，字段缺失仍可注册，不采信个人邮箱自动合并。

飞书配置优先于 OIDC；仅填写部分飞书配置会导致服务启动失败，防止误回落其他登录方式。全未配置时保留原登录行为。App Secret 不返回前端、不写日志。

参考：
- https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code
- https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token
- https://open.feishu.cn/document/authentication-management/login-state-management/get
- https://github.com/larksuite/node-sdk/blob/main/code-gen/projects/authen.ts

实际申请权限、授权域名可达性、租户及邮箱字段以公司应用配置联调为准。

## 2. 已有账号绑定

用原邮箱密码或原 SSO 登录 → 用户菜单 → 个人资料 → “绑定公司飞书”。回调同时验证最初绑定账号、浏览器 state 和当前会话。项目、用户 ID、原路径及密码均保留。

不按同名或同邮箱自动认领。若首次飞书登录发现同企业邮箱已存在，会提示先登录旧账号绑定；飞书邮箱字段不可用时，应先完成存量员工绑定，避免形成两个空间。已绑定其他用户的飞书身份及同账号的重复身份绑定会拒绝。无旧登录能力时由管理员协助恢复旧账号，再绑定。

新账号空间标识由合法邮箱前缀（缺失则 employee）及外部身份摘要后缀生成；首次建号及 schema 开通在同一事务中完成，失败回滚。飞书新注册、手工开通和空间回收使用同一事务锁更新共享 schema 列表，避免并发覆盖。

## 3. 配置公司网络及代理

必须按实际链路分别填写，禁止把下列说明当成生产网段：

| 配置 | 内容 | 分隔方式 |
|---|---|---|
| ISPACE_INTRANET_CIDRS | 实际办公/VPN 客户端网段，或可见的公司固定公网出口 | 逗号 |
| ISPACE_TRUSTED_PROXY_CIDRS | deploy-service 链路上可信的 Caddy、Traefik、公司入口代理地址 | 逗号 |
| ISPACE_CADDY_TRUSTED_PROXIES | Caddy 上游可信的 Traefik/公司入口代理地址 | 空格 |

来源解析从实际 socket 对端开始，仅当对端属于可信代理时读取 X-Forwarded-For，逐跳从右往左寻找第一个非代理地址。直接客户端伪造转发头不影响判定。缺失、格式错误、全是代理的链路拒绝访问。

公司白名单留空时，HTTP/MCP 设置 link 会被拒绝，已有 link 资源也不能匿名打开。空的分隔列表、0.0.0.0/0 和 ::/0 会被配置校验拒绝；不要把全部私网或所有办公客户端作为“可信代理”。

入口网关应清洗/追加真实来源地址，配置自身可信上游，限制全部公司业务入口；关闭公网直连 deploy-service、Caddy、Supabase 和用户容器的端口。此代码不会替你修改公司边界防火墙。

Caddy 会保留可信上游的转发链；其默认仅信任 loopback，需要明确配置实际入口。静态 forward_auth 和 /svc 路径均执行内网判定；已有试玩令牌的文件请求也重新检查当前资源权限、网络条件和会话世代；改密码后旧会话和旧试玩令牌失效。

## 4. 部署顺序

1. 备份数据库，确认现有账号和网络配置，安排测试环境。
2. 发布包含 `0036_feishu_link_access.sql` 的后端。迁移扩展两个 visibility CHECK，新增 external_identities 和 oauth_states 表，保留旧数据。
3. 给 deploy-service 注入飞书和 CIDR 配置；给 Caddy 注入空格分隔的可信代理配置。现有部署脚本会读取 auth.env；Caddy 容器配置由 static-hosting compose 的运行环境/.env 传入。
4. 使用更新后的 compose 重建相关容器以加载新环境变量，校验并发布 Caddyfile；只 restart 不会加载新的容器环境变量。原 `07-deploy-caddy.sh` 的 validate 用默认环境，生产还应使用实际代理变量再次 validate。
5. 发布 portal、console。无需改变既有用户应用 URL，分享设置需明确保存。
6. 用两个员工账号、一个无痕访客、一个静态页面和一个带 API 的项目完成验收。

## 5. 验收

- 首次注册、重复登录、无邮箱、姓名重名、旧账号绑定、外国/其他租户、取消授权、state 过期/重放和并发回调。
- 内网无 Cookie 打开 HTML/CSS/JS、深链接及显式开放的后端 API；外网持链接、伪造 XFF、直连入口均拒绝。
- 从 public/shared 切到 link 后，市场、安装和原分享入口消失；切回 private 后后续请求拒绝，旧试玩令牌不能继续绕过。
- 本人/管理员/指定同事的原权限回归，停用页面及非 active 所有者不再对外提供应用。
- 个人连接器、未授权后端、管理 API 保持需要身份；检查实际业务表的 RLS。

静态页面及 link 后端使用 no-store；已下载内容、旧客户端缓存或应用自身 service worker 缓存无法远程收回。匿名访问只能记录来源与资源，不能识别具体员工。

## 6. 验证与回滚

常规验证：`pnpm typecheck`、`pnpm test`、相关应用构建。若本机 esbuild 原生配置文件读取阻塞，可使用 Vite/Vitest 的 `--configLoader runner` 运行相同配置。

回滚应用之前，先把 link 资源改回 private，避免旧版本 UI/枚举无法识别；关停飞书入口前确认原登录方式可用。数据库迁移为增量，不删除身份绑定或用户数据；保留新表即可，不应通过删用户撤销本次上线。移除 CIDR 配置会关闭 link 访问。


### 本地完整回归

完整数据库回归必须把 `ISPACE_TEST_PG` 指向一次性测试库（测试会清空 `ispace` schema），不要指向生产库：

```bash
ISPACE_TEST_PG='<一次性测试库连接串>' ISPACE_TEST_CADDY='<Caddy 可执行文件绝对路径>' pnpm exec vitest run --configLoader runner --no-file-parallelism
```

`feishu-login-routes.test.ts` 使用完整服务路由、数据库和模拟飞书响应验证授权入口、回调、Cookie、首次开通、旧账号绑定、租户拒绝、异常状态和手机授权兼容。`feishu-link-native.test.ts` 使用真实 PostgreSQL 连接验证并发开通、共享 schema 列表、HTTP/MCP 分享与后端权限切换。`caddy-link-integration.test.ts` 使用实际 Caddy 验证鉴权前后顺序、无尾斜杠规范跳转、查询参数和相对资源；不配置 ISPACE_TEST_CADDY 时该项跳过。这些验证不代替公司应用权限、生产回调域名或生产网络联调。
