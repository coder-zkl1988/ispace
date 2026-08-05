#!/usr/bin/env bash
# 创建静态托管目录。幂等。
# 需要 REMOTE_SUDO_PW 环境变量（目标机 sudo 口令，不落盘）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REMOTE_SUDO_PW:?需要设置 REMOTE_SUDO_PW 环境变量}"
# 目录属主。必须与 compose 里 deploy-service 的 user: 一致，否则服务写不进去。
# 默认取 TARGET_HOST 里 @ 前面那段，也就是你 ssh 上去的那个用户。
DEPLOY_USER="${ISPACE_DEPLOY_USER:-${TARGET_HOST%%@*}}"

"$SCRIPT_DIR/remote.sh" \
  "REMOTE_SUDO_PW='$REMOTE_SUDO_PW' DEPLOY_USER='$DEPLOY_USER' bash -s" <<'REMOTE'
set -eu
sudo_run() { echo "$REMOTE_SUDO_PW" | sudo -S -p "" "$@"; }

sudo_run mkdir -p /srv/sites /srv/releases
sudo_run chown -R "$DEPLOY_USER:$DEPLOY_USER" /srv/sites /srv/releases
sudo_run chmod 755 /srv/sites /srv/releases
ls -ld /srv/sites /srv/releases
REMOTE
