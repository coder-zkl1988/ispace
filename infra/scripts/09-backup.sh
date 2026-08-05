#!/usr/bin/env bash
# 备份（规格 §9）：Postgres 全量 + /srv 静态资产，落到本机并可选异机同步。
#
# 目标机的 crontab 每日调用本脚本。保留 14 天。
#
# 为什么不用 Dokploy 自带的数据库备份：Supabase 的 Postgres 不是 Dokploy
# 管理的服务（它来自官方 compose），Dokploy 的备份界面看不到它。
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M)
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
REPORT_KIND=backup
DEST="${BACKUP_DIR:-/srv/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DEST"

# ── 回写平台 ──────────────────────────────────────────────────────────
# 让「审计与安全 → 备份与恢复」页签能看到真实结果。
#
# 没有这一步的话，那个页签只能显示"请上服务器看日志"——而备份状态恰恰是
# 最不该需要登服务器才能确认的东西。
#
# 失败也要回写（trap 里调用）：只记成功等于把失败藏起来，
# 那时页面上显示的"上次备份成功"是三天前的，没人会注意到。
report_to_platform() {
  local status="$1" note="$2" size="${3:-}"
  [ -n "${ISPACE_API_TOKEN:-}" ] || {
    echo "   未设置 ISPACE_API_TOKEN，跳过回写平台（控制台将看不到本次结果）"
    return 0
  }
  local base="${ISPACE_BASE_URL:?需要设置 ISPACE_BASE_URL，形如 https://ispace.example.com}"
  local payload
  payload=$(printf '{"kind":"%s","status":"%s","startedAt":"%s","note":%s%s}' \
    "$REPORT_KIND" "$status" "$STARTED_AT" \
    "$(printf '%s' "$note" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "${size:+,\"sizeBytes\":$size}")
  curl -s -o /dev/null -w '   回写平台：%{http_code}\n' --max-time 15 \
    -X POST "$base/deploy/api/admin/backups" \
    -H "authorization: Bearer $ISPACE_API_TOKEN" \
    -H 'content-type: application/json' \
    -d "$payload" || echo "   回写平台失败（不影响备份本身）"
}

# 任何一步失败都回写 failed。set -e 会在这里触发 ERR。
trap 'report_to_platform failed "备份中断，见服务器日志"' ERR

echo "== Postgres =="
#
# 分两份，不是一份 pg_dumpall。
#
# pg_dumpall 的输出里含 `\connect <库名>` 指令，管进 `psql -d 目标库` 时会把
# 会话切回原库——后续语句全打在原库上，目标库一片空白。恢复演练时实测到
# 这一点：演练库为空，而 760 行报错全是"已存在"（因为实际写回了现网库）。
# 也就是说那种备份根本没法恢复到指定库。
#
#   globals  —— 角色与权限，用 pg_dumpall --globals-only（不含 \connect）
#   main     —— 主库，用 pg_dump -Fc 自定义格式，可 pg_restore 进任意目标库
docker exec supabase-db pg_dumpall -U postgres --globals-only \
  | gzip > "$DEST/globals-$STAMP.sql.gz"
docker exec supabase-db pg_dump -U postgres -Fc -d postgres \
  > "$DEST/pg-$STAMP.dump"
gzip -f "$DEST/pg-$STAMP.dump"
echo "   $(du -h "$DEST/globals-$STAMP.sql.gz" | cut -f1)  globals-$STAMP.sql.gz"
echo "   $(du -h "$DEST/pg-$STAMP.dump.gz" | cut -f1)  pg-$STAMP.dump.gz"

echo "== 静态资产 =="
# releases 是发布历史，sites 只是软链，bundles 是移动端页面包。
# 三者都要——只备 sites 会得到一堆指向不存在目标的死链。
tar czf "$DEST/srv-$STAMP.tar.gz" \
  -C /srv --exclude='./backups' sites releases bundles platform console 2>/dev/null || true
echo "   $(du -h "$DEST/srv-$STAMP.tar.gz" | cut -f1)  srv-$STAMP.tar.gz"

echo "== 清理超过 ${KEEP_DAYS} 天的备份 =="
find "$DEST" -name '*.gz' -mtime +"$KEEP_DAYS" -print -delete | sed 's|^|   删除 |' || true

# 异机同步。规格 §9 要求异机备份——同机备份挡不住磁盘损坏。
if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "== 异机同步至 $BACKUP_REMOTE =="
  rsync -az --delete "$DEST/" "$BACKUP_REMOTE/"
else
  echo "== 未配置 BACKUP_REMOTE，仅本机备份 =="
  echo "   注意：同机备份挡不住磁盘损坏。规格 §9 要求异机备份，"
  echo "   请设置 BACKUP_REMOTE=user@host:/path 后重跑。"
fi

echo
echo "== 恢复方法 =="
echo "   角色: gunzip -c globals-*.sql.gz | psql -U postgres"
echo "   数据: gunzip -c pg-*.dump.gz > /tmp/d && pg_restore -U postgres -d <目标库> --clean --if-exists /tmp/d"
trap - ERR
total=$(du -sb "$DEST" 2>/dev/null | cut -f1 || echo 0)
report_to_platform success "保留 ${KEEP_DAYS} 天；${BACKUP_REMOTE:+已同步至异机}${BACKUP_REMOTE:-仅本机}" "$total"

echo
echo "备份完成：$DEST"
