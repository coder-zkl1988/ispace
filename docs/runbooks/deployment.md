# 部署手册

从一台空机器到平台跑起来。

脚本编号即执行顺序，全部幂等——中途失败修好后重跑同一条即可，
不需要先回滚。所有远程执行都经 `infra/scripts/remote.sh`。

## 0. 前置

**目标机**：Linux（Ubuntu 22.04+ 或同等）、Docker 24+、4 vCPU / 8 GB / 100 GB 起。
80、443、3000 必须空闲——Traefik 要接管 80/443，Dokploy UI 用 3000。
机器上最好不跑别的容器编排：Dokploy 会 `swarm init`，与既有编排相互干扰。

**域名**：一条 A 记录指向该机器。公网部署到这里就够了，Let's Encrypt 走
HTTP-01，不需要 DNS API 凭据。

**SSH 密钥**：自动化脚本必然高频连接，而多数 sshd 在连续密码认证后会开始
拒绝，密码认证不可用。

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ispace_deploy -N '' -C ispace-deploy
ssh-copy-id -i ~/.ssh/ispace_deploy.pub deploy@ispace.example.com
```

**本机配置**：

```bash
cp .env.example .env
```

至少填 `ISPACE_BASE_URL`、`ISPACE_PUBLIC_BASE`、`ISPACE_DOMAIN`、
`TARGET_HOST`、`ISPACE_ADMIN_EMAIL`，然后 `set -a; . ./.env; set +a` 导出。

先看一眼机器上现在有什么：

```bash
./infra/scripts/00-inventory.sh > /tmp/inventory-$(date +%F).txt
```

## 1. 装 Dokploy

需要目标机的 sudo 口令，经环境变量传入，不落盘。

```bash
export REMOTE_SUDO_PW='...'
./infra/scripts/02-install-dokploy.sh
```

装完打开 `http://<服务器地址>:3000`，按引导创建首个管理员账号，
然后在 Settings 里生成一个 API Token。凭据写到目标机（600，不进仓库）：

```bash
./infra/scripts/remote.sh 'umask 077; mkdir -p ~/.ispace; cat > ~/.ispace/env' <<'EOF'
DOKPLOY_URL=http://127.0.0.1:3000
DOKPLOY_TOKEN=刚才生成的 token
EOF
```

会话密钥同理，随机生成一次即可：

```bash
./infra/scripts/remote.sh "umask 077; echo SESSION_SECRET=$(openssl rand -hex 32) >> ~/.ispace/env"
```

> 换掉 `SESSION_SECRET` 会让所有已签发的会话立即失效——这也是"把所有人踢下线"
> 的正规做法。

## 2. 建目录

```bash
./infra/scripts/03-provision-dirs.sh
```

建 `/srv/sites` 与 `/srv/releases`，属主设为部署用户。
属主必须与 compose 里 `deploy-service` 的 `user:`（默认 `1000:1000`）一致，
否则服务写不进去；属主不是 1000 时用 `ISPACE_UID` / `ISPACE_GID` 覆盖。

## 3. 装 Supabase

拉官方 compose（稀疏检出，只要 `docker/` 那一层）：

```bash
./infra/scripts/remote.sh 'bash -s' <<'EOF'
set -eu
mkdir -p ~/ispace-deploy && cd ~/ispace-deploy
if [ ! -d .supabase-src ]; then
  git clone --filter=blob:none --no-checkout https://github.com/supabase/supabase .supabase-src
  cd .supabase-src && git sparse-checkout set --cone docker && git checkout master
else
  cd .supabase-src && git pull
fi
cd ~/ispace-deploy
[ -d supabase ] || cp -r .supabase-src/docker supabase
EOF
```

生成 `.env`（密钥在目标机就地生成，不经过本仓库）：

```bash
./infra/scripts/04-supabase-env.sh
```

叠上本仓库的覆盖层再启动。覆盖层做三件事：清掉全部宿主端口映射、
把 Kong 挂到 Traefik 上并剥掉 `/supabase` 前缀、保留 Kong 的 `api-gw` 别名。
理由与实测记录见 [`infra/dokploy/supabase.notes.md`](../../infra/dokploy/supabase.notes.md)。

```bash
scp -i ~/.ssh/ispace_deploy infra/dokploy/supabase.compose.override.yml \
  "$TARGET_HOST:~/ispace-deploy/supabase/"

./infra/scripts/remote.sh 'bash -s' <<'EOF'
set -eu
cd ~/ispace-deploy/supabase
docker compose -p supabase \
  -f docker-compose.yml -f supabase.compose.override.yml up -d
EOF
```

把 anon key 等回写到 `~/.ispace/supabase.env` 供后续脚本注入：

```bash
./infra/scripts/remote.sh 'umask 077; cd ~/ispace-deploy/supabase; \
  grep -E "^(POSTGRES_PASSWORD|ANON_KEY|SERVICE_ROLE_KEY)=" .env > ~/.ispace/supabase.env'
```

## 4. 部署平台服务

```bash
./infra/scripts/06-deploy-service.sh    # deploy-service（REST + MCP），跑迁移
./infra/scripts/07-deploy-caddy.sh      # 静态托管 Caddy + portal 容器
./infra/scripts/11-deploy-web.sh        # console / portal / shell.js 产物
./infra/scripts/08-deploy-updates.sh    # updates-service（要手机端才需要）
```

源码经 rsync 送到目标机后在那边构建镜像——比在本机构建再传镜像快得多。

`07` 先校验 Caddyfile 再落地，校验不过绝不部署：一个语法错误会让
Caddy 起不来，而它是所有用户页面的出口。

## 5. 验收

```bash
curl -sI "$ISPACE_BASE_URL/"                        # portal，200
curl -s  "$ISPACE_BASE_URL/deploy/api/health"       # deploy-service
curl -sI "$ISPACE_BASE_URL/console"                 # 控制台
curl -s -o /dev/null -w '%{http_code}\n' \
     -H "apikey: $ANON_KEY" "$ISPACE_BASE_URL/supabase/rest/v1/"
```

最后一条返回 **403 是正常的**，不是故障：Kong 的 `rest-v1-openapi` 路由精确
匹配 `/rest/v1/`，ACL 只允许 `admin` 组。排查时别把它当成 stripPrefix 失败。

端到端走一遍：

1. 打开 `$ISPACE_BASE_URL/`，注册一个账号（邮箱后缀要在
   `ISPACE_EMAIL_DOMAINS` 里）
2. 用 CLI 发一份产物，确认 `/{user}/{app}/` 能打开且页面顶部有平台 header
3. 控制台能看到这次发布记录与配额变化
4. 回滚到上一版本，秒级生效
5. 发一份含硬编码密钥的产物，确认被阻断且审计里有「已阻断」

## 6. 上线前必须确认

- [ ] `ISPACE_EMAIL_DOMAINS` 已设为你自己的域名。留空 = 对全互联网开放注册，
      而注册一次就发一个数据 schema 和一份配额
- [ ] `ISPACE_DEV_LOGIN` **没有**设置。它是可选任意身份的开发登录页，
      安全性等于零
- [ ] 证书已签发（`curl -I https://...` 不报 TLS 错）
- [ ] Postgres 没有宿主端口映射（`docker ps` 里 db 那行不该有 `0.0.0.0:5432`）
- [ ] Dokploy UI 的 3000 端口不对公网开放，或已加防火墙规则
- [ ] `~/.ispace/*.env` 权限是 600
- [ ] 备份跑得通：`./infra/scripts/09-backup.sh`，并演练一次
      `./infra/scripts/10-restore-drill.sh`

## 日常运维

| 场景 | 命令 |
|---|---|
| 开通一个用户的数据 schema | `./infra/scripts/05-provision-user-schema.sh <username>` |
| 只改了前端 | `./infra/scripts/11-deploy-web.sh` |
| 改了后端代码 | `./infra/scripts/06-deploy-service.sh` |
| 改了 Caddyfile | `./infra/scripts/07-deploy-caddy.sh` |
| 备份 | `./infra/scripts/09-backup.sh` |
| 恢复演练 | `./infra/scripts/10-restore-drill.sh` |
| 给人补一条设密码链接 | `./infra/scripts/13-issue-reset-link.sh <email>` |
| 发安卓安装包 | `./infra/scripts/14-publish-apk.sh` |
| 后端容器资源采样 | `./infra/scripts/12-resource-sampler.sh` |

拓扑、目录、端口与踩过的坑见 [server-state.md](server-state.md)。
