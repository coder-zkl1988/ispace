#!/usr/bin/env bash
# 恢复演练（规格 §14 要求「备份可演练恢复」）。
#
# 把最新备份灌进一个临时库，比对与现网的数据量，然后清理。**不触碰现网**。
#
# 这个脚本存在的理由：备份文件存在 ≠ 能恢复。首次演练就发现原先用
# pg_dumpall 的备份根本无法恢复到指定库——它的输出含 `\connect <库名>`，
# 管进 `psql -d 目标库` 会把会话切回原库，目标库一片空白而报错全是
# "already exists"（因为实际写回了现网）。改为 pg_dump -Fc 后才真正可恢复。
set -euo pipefail
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
REPORT_KIND=restore_drill
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 分两组比对，原因是 audit_logs 一直在长。
#
# 起初把 audit 也放进"必须完全相等"里，结果演练几乎必然失败：备份是某一刻的
# 快照，而现网每来一个 API 调用就多一条审计——连演练脚本自己的回写都算。
# 那是假阴性，比不做演练更糟：它会让人习惯性忽略"演练失败"。
#
# 稳定组（users/apps/releases/mobile）要求完全相等：这些表只在有人操作时变，
# 演练那几十秒里不该变；真变了就说明备份漏了东西。
cat > /tmp/ispace-counts.sql <<'SQL'
SELECT 'users='||(SELECT count(*) FROM ispace.users)
     ||' apps='||(SELECT count(*) FROM ispace.apps)
     ||' releases='||(SELECT count(*) FROM ispace.releases)
     ||' mobile='||(SELECT count(*) FROM ispace.mobile_releases) AS c;
SQL
# 增长组：只取审计条数，单独按 0 < 演练 <= 现网 判定
cat > /tmp/ispace-audit-count.sql <<'SQL'
SELECT count(*) FROM ispace.audit_logs;
SQL
/usr/bin/scp -i "${DEPLOY_KEY:-$HOME/.ssh/ispace_deploy}" -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  /tmp/ispace-counts.sql /tmp/ispace-audit-count.sql \
  "${TARGET_HOST:?需要设置 TARGET_HOST，形如 deploy@ispace.example.com}:/tmp/"

# 整段远程执行的输出先收进日志：既要原样打给人看，又要摘几行回写平台。
# 用 { } 包住而不是直接 tee，是为了让下面能拿到远端的退出码。
{
"$SCRIPT_DIR/remote.sh" 'bash -s' <<'REMOTE'
set -eu
docker cp /tmp/ispace-counts.sql supabase-db:/tmp/ >/dev/null
docker cp /tmp/ispace-audit-count.sql supabase-db:/tmp/ >/dev/null
DUMP=$(ls -t /srv/backups/pg-*.dump.gz 2>/dev/null | head -1)
[ -n "$DUMP" ] || { echo "找不到备份文件，先跑 ~/ispace-backup.sh" >&2; exit 1; }
echo "使用备份：$(basename "$DUMP")"

docker exec supabase-db psql -U postgres -q -c "DROP DATABASE IF EXISTS restore_drill;" </dev/null 2>/dev/null || true
docker exec supabase-db psql -U postgres -q -c "CREATE DATABASE restore_drill;" </dev/null
gunzip -c "$DUMP" > /tmp/drill.dump && docker cp /tmp/drill.dump supabase-db:/tmp/ >/dev/null

# Supabase 自带的 realtime 函数需要超级用户参数，恢复时必然报几条 permission
# denied——那是 Supabase 内部对象，与平台数据无关，不影响 ispace schema。
docker exec supabase-db pg_restore -U postgres -d restore_drill \
  --no-owner --no-privileges /tmp/drill.dump </dev/null 2>&1 | grep -c "error" \
  | xargs -I{} echo "pg_restore 报错 {} 条（Supabase 内部对象，见脚本注释）"

DRILL=$(docker exec supabase-db psql -U postgres -d restore_drill -t -A -f /tmp/ispace-counts.sql </dev/null 2>/dev/null)
LIVE=$(docker exec supabase-db psql -U postgres -t -A -f /tmp/ispace-counts.sql </dev/null 2>/dev/null)
DRILL_AUDIT=$(docker exec supabase-db psql -U postgres -d restore_drill -t -A -f /tmp/ispace-audit-count.sql </dev/null 2>/dev/null | tr -d ' ')
LIVE_AUDIT=$(docker exec supabase-db psql -U postgres -t -A -f /tmp/ispace-audit-count.sql </dev/null 2>/dev/null | tr -d ' ')
echo "演练库：$DRILL audit=$DRILL_AUDIT"
echo "现网：  $LIVE audit=$LIVE_AUDIT"

docker exec supabase-db psql -U postgres -q -c "DROP DATABASE restore_drill;" </dev/null
rm -f /tmp/drill.dump

fail=0
[ "$DRILL" = "$LIVE" ] || { echo "演练失败：稳定表数量不一致" >&2; fail=1; }
# 审计只要求"恢复出来了、且不多于现网"。多于现网说明比对搞反了，
# 为 0 说明整张表没恢复——两种都是真问题。
[ "$DRILL_AUDIT" -gt 0 ] 2>/dev/null || { echo "演练失败：审计表为空，未恢复" >&2; fail=1; }
[ "$DRILL_AUDIT" -le "$LIVE_AUDIT" ] 2>/dev/null || { echo "演练失败：演练库审计多于现网" >&2; fail=1; }
[ "$fail" = 0 ] && echo "演练通过：稳定表一致，审计已恢复 $DRILL_AUDIT 条（现网 $LIVE_AUDIT，差值为演练期间新增）" || exit 1
REMOTE
} > /tmp/ispace-drill.log 2>&1 && DRILL_OK=1 || DRILL_OK=0
cat /tmp/ispace-drill.log

# ── 回写平台 ──────────────────────────────────────────────────────────
# 让「审计与安全 → 备份与恢复」页签能看到演练结果。
#
# 成败都回写：只记成功的话，页面上"上次演练通过"会一直停在几个月前那次，
# 而中间每次失败都无声无息——那正是最需要被看见的信号。
if [ -n "${ISPACE_API_TOKEN:-}" ]; then
  note=$(tail -4 /tmp/ispace-drill.log | tr '\n' ' ')
  payload=$(ISPACE_NOTE="$note" python3 - "$STARTED_AT" "$REPORT_KIND" "$DRILL_OK" <<'PY'
import json, os, sys
started, kind, ok = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
print(json.dumps({
    'kind': kind,
    'status': 'success' if ok else 'failed',
    'startedAt': started,
    'note': os.environ.get('ISPACE_NOTE', '')[:1000],
}, ensure_ascii=False))
PY
)
  curl -s -o /dev/null -w '回写平台：%{http_code}\n' --max-time 15 \
    -X POST "${ISPACE_BASE_URL:?需要设置 ISPACE_BASE_URL，形如 https://ispace.example.com}/deploy/api/admin/backups" \
    -H "authorization: Bearer $ISPACE_API_TOKEN" \
    -H 'content-type: application/json' \
    -d "$payload" || echo "回写平台失败（不影响演练结论）"
else
  echo "未设置 ISPACE_API_TOKEN，跳过回写平台（控制台将看不到本次演练结果）"
fi

exit $(( DRILL_OK == 1 ? 0 : 1 ))
