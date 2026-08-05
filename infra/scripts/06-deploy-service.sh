#!/usr/bin/env bash
# 构建并部署 deploy-service。幂等：重复执行即滚动更新。
#
# 源码经 rsync 送到目标机后在那边构建镜像——本机没装 Docker，且目标机
# 直连 docker.io 有 4-8 MB/s，构建比传镜像快。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOST="${TARGET_HOST:?需要设置 TARGET_HOST，形如 deploy@ispace.example.com}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/ispace_deploy}"
REMOTE_DIR="~/ispace-src"

echo "== 1. 同步源码 =="
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .turbo --exclude .git \
  --exclude '*.tsbuildinfo' \
  --exclude /apps/mobile-shell/ios --exclude /apps/mobile-shell/android \
  --exclude /apps/mobile-shell/composed \
  -e "/usr/bin/ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
  "$REPO_ROOT/" "$HOST:$REMOTE_DIR/"

echo "== 2. 构建镜像并启动 =="
"$SCRIPT_DIR/remote.sh" 'bash -s' <<'REMOTE'
set -eu
cd ~/ispace-src

docker build -f apps/deploy-service/Dockerfile -t ispace/deploy-service:latest . 2>&1 | tail -6

# 从 ~/.ispace 注入密钥；不落进 compose 文件，也不进仓库
set -a
. ~/.ispace/supabase.env
# Dokploy 凭据供编排器使用；缺失时服务会回落 Mock 编排器
[ -f ~/.ispace/env ] && . ~/.ispace/env
# Agent 模型通道
[ -f ~/.ispace/agent.env ] && . ~/.ispace/agent.env
# 语音转写（StepFun ASR）。缺失时该端点返回 NOT_IMPLEMENTED。
[ -f ~/.ispace/voice.env ] && . ~/.ispace/voice.env
# 公司 SSO（可选）。三个 OIDC_* 都在才会启用。
# 缺失时**不再**回落开发登录页——那曾是一个任何人都能选管理员进来的后门，
# 而平台改用邮箱密码后 OIDC 很可能永远不配，后门就一直开着。
# 本地要用开发登录，显式设 ISPACE_DEV_LOGIN=1。
# 见 docs/runbooks/sso-setup.md
[ -f ~/.ispace/auth.env ] && . ~/.ispace/auth.env
set +a
# 会话密钥首次生成后固化，重启不失效（否则所有人被登出）
if [ ! -f ~/.ispace/session.env ]; then
  printf 'SESSION_SECRET=%s\n' "$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)" > ~/.ispace/session.env
  chmod 600 ~/.ispace/session.env
fi
set -a; . ~/.ispace/session.env; set +a

mkdir -p ~/ispace-deploy
cp ~/ispace-src/infra/dokploy/deploy-service.compose.yml ~/ispace-deploy/
cd ~/ispace-deploy
POSTGRES_PASSWORD="$POSTGRES_PASSWORD" SESSION_SECRET="$SESSION_SECRET" \
  DOKPLOY_URL="${DOKPLOY_URL:-}" DOKPLOY_TOKEN="${DOKPLOY_TOKEN:-}" \
  AGENT_BASE_URL="${AGENT_BASE_URL:-}" AGENT_API_KEY="${AGENT_API_KEY:-}" AGENT_MODEL="${AGENT_MODEL:-gpt-5.6}" \
  docker compose -f deploy-service.compose.yml -p ispace-deploy up -d 2>&1 | tail -5

sleep 6
docker ps --filter name=ispace-deploy-service --format "  {{.Names}}|{{.Status}}"
REMOTE
