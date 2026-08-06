#!/usr/bin/env bash
# 部署前端静态资源：控制台、门户、以及注入到用户页面里的 shell.js。
#
# 这三份产物由 Caddy 直接 file_server，不经过任何应用进程：
#   apps/console/dist  → /srv/console   （Caddy: handle /console*）
#   apps/portal/dist   → /srv/portal    （Caddy: reverse_proxy 兜底外的静态资源）
#   apps/shell-js/dist/shell.js → /srv/platform/shell.js
#
# 之所以单独成一个脚本而不并进 07-deploy-caddy.sh：改 Caddyfile 会重启
# Caddy（有几百毫秒的连接中断），而发前端不需要。日常改前端跑这个就够了。
#
# 幂等：重复执行即覆盖。用 rsync --delete 保证远端不残留上一版的 hash 资源文件。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOST="${TARGET_HOST:?需要设置 TARGET_HOST，形如 deploy@ispace.example.com}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/ispace_deploy}"
BASE_URL="${ISPACE_BASE_URL:?需要设置 ISPACE_BASE_URL，形如 https://ispace.example.com}"
# 冒烟走目标机内部 + Host 头，所以只要域名，不要协议
DOMAIN="${ISPACE_DOMAIN:-${BASE_URL#*://}}"

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
RSH="/usr/bin/ssh ${SSH_OPTS[*]}"

echo "== 1. 构建 =="
cd "$REPO_ROOT"
pnpm --filter @ispace/console --filter @ispace/portal --filter @ispace/shell-js build

# 构建产物必须存在才继续。空目录配上 --delete 会把远端清空，
# 那等于把控制台和门户一起下线。
for d in apps/console/dist apps/portal/dist; do
  if [ ! -f "$REPO_ROOT/$d/index.html" ]; then
    echo "构建产物缺失：$d/index.html —— 中止，避免 rsync --delete 清空线上目录" >&2
    exit 1
  fi
done
if [ ! -s "$REPO_ROOT/apps/shell-js/dist/shell.js" ]; then
  echo "构建产物缺失：apps/shell-js/dist/shell.js —— 中止" >&2
  exit 1
fi

echo "== 2. 同步 =="
rsync -az --delete -e "$RSH" "$REPO_ROOT/apps/console/dist/" "$HOST:/srv/console/"
rsync -az --delete -e "$RSH" "$REPO_ROOT/apps/portal/dist/"  "$HOST:/srv/portal/"
# shell.js 单文件，不用 --delete（/srv/platform 下还可能有别的东西）
rsync -az -e "$RSH" "$REPO_ROOT/apps/shell-js/dist/shell.js" "$HOST:/srv/platform/shell.js"

echo "== 3. 冒烟 =="
# 从**目标机内部**打，不从跑脚本这台机器打。
#
# 原先直接 curl $BASE_URL：那要求运维的笔记本此刻能解析并访问平台公网地址。
# 通过 VPN 部署、或者 TLS 由上游网关终结而本机不在网关内侧时，这里稳定返回
# 000——一个永远失败的检查比没有检查更糟，它训练人忽略输出，真出问题那次
# 也就跟着被忽略了。走 remote.sh + Host 头，验的是"服务器上这个站点是好的"，
# 这本来就是部署脚本该负责的范围；公网链路是网关的事，不该混进来。
smoke() {
  "$SCRIPT_DIR/remote.sh" "bash -s" <<SMOKE
set -eu
fail=0
for p in / /console/ /platform/shell.js; do
  code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Host: $DOMAIN' "http://127.0.0.1\$p" || echo 000)
  printf '   %-22s %s\\n' "\$p" "\$code"
  [ "\$code" = "200" ] || fail=1
done

# 控制台是 SPA，index.html 必须真的引到本次构建的 JS，
# 而不是 rsync 半途失败后留下的旧壳。
# 打印**实际请求的那个路径**而不是 grep 出来的片段：控制台资源在
# /console/assets/ 下，而 /assets/ 会被 portal 的 SPA 兜底成 200+HTML。
# 两者只差一个前缀，日志里印错一个就足以让人拿着 200 去查一个不存在的问题。
asset=\$(curl -s --max-time 20 -H 'Host: $DOMAIN' "http://127.0.0.1/console/" | grep -oE '/assets/[^"]+\\.js' | head -1)
if [ -n "\$asset" ]; then
  code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Host: $DOMAIN' "http://127.0.0.1/console\$asset" || echo 000)
  printf '   %-22s %s\\n' "/console\$asset" "\$code"
  [ "\$code" = "200" ] || fail=1
else
  echo "   控制台 index.html 里找不到 JS 引用" >&2
  fail=1
fi
exit \$fail
SMOKE
}
fail=0
smoke || fail=1

[ "$fail" = "0" ] || { echo "冒烟未通过" >&2; exit 1; }
echo "部署完成"
