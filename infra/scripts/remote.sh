#!/usr/bin/env bash
# 统一的远程执行入口。走密钥认证，不用密码。
#
# 为什么不用密码：目标机在短时间内多次密码认证后会锁定（实测连续成功若干次
# 后开始返回 Permission denied，数分钟后自动解除）。自动化脚本必然高频连接，
# 密码认证不可用。公钥安装见 docs/runbooks/server-state.md。
#
# 用法:
#   ./infra/scripts/remote.sh 'docker ps'
#   ./infra/scripts/remote.sh < script.sh          # 从 stdin 送整段脚本
set -euo pipefail

HOST="${TARGET_HOST:?需要设置 TARGET_HOST，形如 deploy@ispace.example.com}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/ispace_deploy}"

if [ ! -f "$KEY" ]; then
  echo "错误: 找不到密钥 $KEY" >&2
  echo "生成: ssh-keygen -t ed25519 -f $KEY -N '' -C ispace-deploy" >&2
  exit 1
fi

exec /usr/bin/ssh -i "$KEY" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o PasswordAuthentication=no \
  -o BatchMode=yes \
  -o ConnectTimeout=20 \
  -o LogLevel=ERROR \
  "$HOST" "${@:-bash -s}"
