#!/usr/bin/env bash
# 构建并部署 updates-service。幂等。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOST="${TARGET_HOST:?需要设置 TARGET_HOST，形如 deploy@ispace.example.com}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/ispace_deploy}"

echo "== 1. 同步源码 =="
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .turbo --exclude .git --exclude '*.tsbuildinfo' \
  --exclude /apps/mobile-shell/ios --exclude /apps/mobile-shell/android \
  --exclude /apps/mobile-shell/composed \
  -e "/usr/bin/ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
  "$REPO_ROOT/" "$HOST:~/ispace-src/"

echo "== 2. 构建并启动 =="
"$SCRIPT_DIR/remote.sh" 'bash -s' <<'REMOTE'
set -eu
cd ~/ispace-src
docker build -f apps/updates-service/Dockerfile -t ispace/updates-service:latest . 2>&1 | tail -4

echo '1234' | sudo -S -p '' mkdir -p /srv/bundles
echo '1234' | sudo -S -p '' chown 1000:1000 /srv/bundles

set -a
. ~/.ispace/supabase.env
# ISPACE_PUBLIC_BASE / ISPACE_DOMAIN 在这里——compose 用 :? 声明为必填，
# 不 source 就会 "required variable ... is missing a value" 而整个部署失败。
[ -f ~/.ispace/env ] && . ~/.ispace/env
set +a
mkdir -p ~/ispace-deploy
cp ~/ispace-src/infra/dokploy/updates-service.compose.yml ~/ispace-deploy/
cd ~/ispace-deploy
POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  docker compose -f updates-service.compose.yml -p ispace-updates up -d 2>&1 | tail -3
sleep 6
docker ps --filter name=ispace-updates-service --format "  {{.Names}}|{{.Status}}"
REMOTE
