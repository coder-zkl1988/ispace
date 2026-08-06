#!/usr/bin/env bash
# 部署 Caddyfile。**先校验后部署**，校验不过绝不落地。
#
# 这个顺序是被事故换来的：曾经先 cp 到 /etc/ispace 再重启，配置里有个
# `handle /a* /b* { }` 的语法错误（handle 只接受单个 matcher），Caddy
# 起不来，整站 404 数分钟。校验其实同时也跑了，但输出淹没在日志里没被看见。
#
# 现在：validate 不通过直接 exit，根本走不到 cp。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
KEY="${DEPLOY_KEY:-$HOME/.ssh/ispace_deploy}"
HOST="${TARGET_HOST:?需要设置 TARGET_HOST，形如 deploy@ispace.example.com}"

FILE="${1:-$REPO_ROOT/infra/caddy/Caddyfile}"
DEST="${2:-/etc/ispace/Caddyfile}"
SVC="${3:-caddy}"

echo "== 1. 上传到临时位置 =="
/usr/bin/scp -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR "$FILE" "$HOST:/tmp/Caddyfile.staged"

echo "== 2. 校验（不通过即中止）=="
out=$("$SCRIPT_DIR/remote.sh" 'docker run --rm -v /tmp/Caddyfile.staged:/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1' || true)
if ! grep -q "Valid configuration" <<<"$out"; then
  echo "$out" | grep -E "Error|error" | head -5
  echo "校验未通过，已中止。现网配置未被改动。" >&2
  exit 1
fi
echo "   Valid configuration"

echo "== 3. 落地并重启 =="
"$SCRIPT_DIR/remote.sh" "echo '${REMOTE_SUDO_PW:?需要设置 REMOTE_SUDO_PW 环境变量}' | sudo -S -p '' cp /tmp/Caddyfile.staged '$DEST'
cd ~/ispace-deploy && docker compose -f static-hosting.compose.yml -p ispace restart $SVC 2>&1 | tail -2"

echo "== 4. 冒烟 =="
sleep 4
D="${ISPACE_BASE_URL:?需要设置 ISPACE_BASE_URL，形如 https://ispace.example.com}"
fail=0
for p in / /console/ /platform/shell.js; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$D$p")
  printf "   %-22s %s\n" "$p" "$code"
  [ "$code" = "200" ] || fail=1
done
if [ "$fail" = "1" ]; then
  echo "冒烟未通过：有路径不可访问，请检查。" >&2
  exit 1
fi
echo "部署完成"
