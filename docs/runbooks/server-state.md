# 部署拓扑与运维基线

一台机器跑完整平台时的样子。地址一律用 `$ISPACE_BASE_URL` 代指，
具体值见你自己的 `.env`。

## 访问入口

| 用途 | 地址 |
|---|---|
| 平台根（portal） | `$ISPACE_BASE_URL/` |
| 用户应用 | `$ISPACE_BASE_URL/{user}/{app}/` |
| 控制台 | `$ISPACE_BASE_URL/console` |
| 部署服务 REST / MCP | `$ISPACE_BASE_URL/deploy/api` · `/deploy/mcp` |
| Supabase API | `$ISPACE_BASE_URL/supabase/` |
| Dokploy 控制台 | `http://<服务器地址>:3000` |

### 请求链路

```
$ISPACE_DOMAIN
  → 服务器 :80/:443   Traefik（Dokploy 内置）
  → 按路由分发：
       兜底        → ispace-caddy:8080  → /srv/sites 或 portal
       /deploy     → ispace-deploy-service:3100
       /updates    → ispace-updates-service:3200
       /supabase   → supabase-kong:8000（经 stripPrefix 剥掉前缀）
```

Traefik 默认按规则长度排序，`Host(...) && PathPrefix(...)` 天然优先于
静态托管那条纯 `Host(...)` 的兜底，无需手工设 priority。

### 前面还有一层网关时

若平台前面还有公司网关 / CDN / 反代，ACME 的 HTTP-01 挑战需要那一层放行
`/.well-known/acme-challenge/`，否则签不出证书；也可以直接在那一层终止 TLS，
把 `ISPACE_TRAEFIK_ENTRYPOINT` 设回 `web`。

判断"域名到底有没有打到 Traefik"的实用方法：比对 404 响应体。Traefik 的是
`404 page not found\n`，逐字节固定；前置网关通常返回自己的错误页。

## 端口

| 端口 | 占用 |
|---|---|
| 80 / 443 | Traefik（Dokploy） |
| 3000 | Dokploy UI |
| 22 | sshd |

Supabase 全部服务与 ispace 的 Caddy / portal 均**不发布宿主端口**，
一律经 `dokploy-network` 由 Traefik 直连。这既避免与机器上别的服务撞端口，
也顺带把 Postgres 从公网上摘了下来——`5432` 一旦映射到宿主，就是一个
直接对外的数据库。

## 目录

```
/srv/sites/{user}/{app}/          当前版本（软链）
/srv/releases/{user}/{app}/{ts}/  历史版本
/srv/bundles/                     移动端页面包
/srv/workspaces/                  Agent 工作区，每用户一个
/srv/platform/shell.js            注入用户页面的平台 chrome
/srv/console  /srv/portal         前端产物
/srv/dist/                        安卓安装包（公开可下载）
```

属主必须与 compose 里 `deploy-service` 的 `user:` 一致（默认 `1000:1000`），
否则服务写不进去。`/etc/ispace/Caddyfile` 为静态托管路由配置。

## 部署产物位置

| 内容 | 路径 |
|---|---|
| ispace 各 compose | `~/ispace-deploy/*.compose.yml`（compose 项目名 `ispace`） |
| Supabase | `~/ispace-deploy/supabase/`（compose 项目名 `supabase`） |
| Supabase 上游源码检出 | `~/ispace-deploy/.supabase-src/`（稀疏检出，仅 `docker/`） |

## 凭据（均不入库）

| 内容 | 位置 | 权限 |
|---|---|---|
| Dokploy URL 与 API Token | `~/.ispace/env` | 600 |
| Supabase anon/service_role/DB 口令/Studio 账号 | `~/.ispace/supabase.env` | 600 |
| OIDC 凭据（接了 SSO 才有） | `~/.ispace/auth.env` | 600 |
| Supabase 完整 .env | `~/ispace-deploy/supabase/.env` | 600 |
| SSH 私钥 | 开发机 `~/.ssh/ispace_deploy`，**仓库外** | 600 |

**远程执行一律走 `infra/scripts/remote.sh`（密钥认证）。** 自动化脚本必然
高频连接，而多数 sshd 配置在短时间内多次密码认证后会开始拒绝，密码认证
不可用。

## 几个踩过的坑

**不要配 Docker registry-mirror。** 实测某加速器约 43 KB/s，直连 docker.io
为 4–8 MB/s——快两个数量级。3 GB 的镜像经加速器 40 分钟拉不完，直连
6 分钟完成。`/etc/docker/daemon.json` 保持 `{}` 即可。

**换网卡后必须退出旧 swarm。** `swarm init` 会固化 advertise 地址，换网后
失效，表现为 `docker pull` 卡在 `Waiting` 不动，没有任何报错。
修复：`docker swarm leave --force` + `systemctl restart docker`，
再重新安装 Dokploy。

**装 Dokploy 前先确认 80 / 443 / 3000 空闲。** Traefik 要接管 80/443，
Dokploy UI 用 3000；被占的话安装会中途失败，且已改的系统状态不会回滚。

**用户 schema 的开通顺序不可调换。** 建 schema → 校验存在 → 改
`pgrst.db_schemas` → `NOTIFY reload config` → `NOTIFY reload schema`。
反之 PostgREST 全局 503。回收顺序完全相反。详见
`infra/dokploy/supabase.notes.md`。

**`RESERVED_PATHS` 必须与 Caddyfile 的排除列表一致。** 前者在
`packages/contracts`，是唯一真相源；新增任何平台顶层路径都要同步两处。

## 完全回退

```bash
docker compose -p supabase down    # 保留卷；加 -v 才会删数据
docker compose -p ispace down
docker service rm $(docker service ls -q)
docker swarm leave --force
sudo rm -rf /etc/dokploy /etc/ispace
```

`/srv` 下的发布产物与 Docker 卷不受影响，需要一并清掉时手工删除。
