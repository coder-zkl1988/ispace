#!/usr/bin/env bash
# 给某个账号发一条一次性设密码链接。
#
# 用途有两个：
#   1. 引导。平台从 SSO 切到邮箱密码之后，已有账号的 password_hash 是空的，
#      谁都登不进去，也就没人能以管理员身份去用控制台里的重置功能。
#      这个鸡生蛋的口子只能从服务器上打开一次。
#   2. 应急。管理员自己也把密码忘了的时候。
#
# 日常给同事重置密码**不要用这个脚本**——控制台「员工与开通」里有按钮，
# 走那条路会记审计日志（谁在什么时候给谁发了链接），这里不会。
#
# 用法：
#   ./infra/scripts/remote.sh 'bash -s' < infra/scripts/13-issue-reset-link.sh lixiao
#
# 链接只打印这一次：库里只存哈希，丢了就重发一条。
set -euo pipefail

USERNAME="${1:-}"
if [ -z "$USERNAME" ]; then
  echo "用法：$0 <空间标识>   例如：$0 lixiao" >&2
  exit 2
fi

TTL_HOURS=24
BASE="${ISPACE_BASE_URL:?需要设置 ISPACE_BASE_URL，形如 https://ispace.example.com}"

# shellcheck disable=SC1090
. "$HOME/.ispace/supabase.env"

psql() {
  # 不加 -i：脚本自身经 stdin 送进来时，docker exec -i 会把剩下的正文吃掉
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -At -q "$@" </dev/null
}

UID_=$(psql -c "SELECT id FROM ispace.users WHERE username = '${USERNAME}' AND status <> 'archived'")
if [ -z "$UID_" ]; then
  echo "没有这个账号（或已归档）：${USERNAME}" >&2
  echo "现有账号：$(psql -c "SELECT string_agg(username, ', ') FROM ispace.users")" >&2
  exit 1
fi

# 令牌与哈希都在这台机器上算，不经过任何中间环节。
# 与服务端一致：base64url 的 32 字节随机数，库里存 sha256 十六进制。
TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
HASH=$(printf '%s' "$TOKEN" | openssl dgst -sha256 | awk '{print $NF}')

# 先把该用户尚未使用的旧链接作废：同时有多条有效链接，等于多个还没关上的门
psql -c "UPDATE ispace.password_resets SET used_at = now()
          WHERE user_id = '${UID_}' AND used_at IS NULL"

psql -c "INSERT INTO ispace.password_resets (user_id, token_hash, issued_by, expires_at)
         VALUES ('${UID_}', '${HASH}', '${UID_}', now() + interval '${TTL_HOURS} hours')"

cat <<EOF

给 ${USERNAME} 的设密码链接（${TTL_HOURS} 小时内有效，用一次即失效）：

  ${BASE}/reset?token=${TOKEN}

这条链接只打印这一次——库里只存哈希，翻不出来。丢了就再跑一次这个脚本。
设好之后网页和手机 App 用同一个账号登录。
EOF
