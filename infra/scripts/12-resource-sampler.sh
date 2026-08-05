#!/usr/bin/env bash
# 后端容器的 CPU / 内存采样。
#
# 为什么采样在宿主上而不是在 deploy-service 里：
# 那个容器故意没挂 docker.sock（见 apps/deploy-service/Dockerfile 的注释）。
# 挂上就等于给一个对外的 HTTP 服务开了容器逃逸的口子，而这里要的只是
# 两个数字。宿主上跑一条 docker stats 写进库，服务端只读，风险为零。
#
# 装成定时任务（走用户 crontab，不需要 root）：
#   ./infra/scripts/remote.sh 'cat > ~/.ispace/sampler-install.sh' < infra/scripts/12-resource-sampler.sh
#   ./infra/scripts/remote.sh 'bash ~/.ispace/sampler-install.sh --install'
# 手工跑一次：
#   ./infra/scripts/remote.sh 'bash -s' < infra/scripts/12-resource-sampler.sh
set -euo pipefail


# ── 安装成定时任务 ────────────────────────────────────────────────────
# 走用户 crontab 而不是 systemd timer：目标机上的运维账号没有免密 sudo，
# 而写 /etc/systemd/system 需要 root。crontab 的最小粒度正好是 1 分钟，
# 与这里要的采样间隔一致，没必要为了秒级精度去要 root。
if [ "${1:-}" = "--install" ]; then
  SELF="$HOME/.local/bin/ispace-resource-sampler"
  mkdir -p "$(dirname "$SELF")"
  cp "$0" "$SELF"
  chmod +x "$SELF"

  # 幂等：先摘掉旧行再加，重复执行不会装出两条
  TMP=$(mktemp)
  crontab -l 2>/dev/null | grep -v 'ispace-resource-sampler' > "$TMP" || true
  echo "* * * * * $SELF >> \$HOME/.ispace/sampler.log 2>&1" >> "$TMP"
  crontab "$TMP"
  rm -f "$TMP"

  echo "已装进 crontab（每分钟一次）：$SELF"
  echo "日志：~/.ispace/sampler.log"
  exit 0
fi

# ── 采样 ──────────────────────────────────────────────────────────────
# shellcheck disable=SC1090
. "$HOME/.ispace/supabase.env"

psql() {
  # 关键：不能用 `docker exec -i`，也必须显式把 stdin 接到 /dev/null。
  #
  # 这个脚本常经 `remote.sh 'bash -s' < 脚本` 执行，也就是脚本自己就在 stdin 上。
  # `-i` 会让 docker exec 把**剩下的脚本正文**当作容器的输入吃掉，
  # 于是脚本在第一次查询后就静悄悄地结束了，退出码还是 0——
  # 查了半天才发现不是 SQL 的问题。SQL 走 -c 传参，本来也不需要 stdin。
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -q "$@" </dev/null
}

# 先取出平台知道的后端：container_name → backend_id。
# 没有登记过容器名的后端跳过——那说明它是迁移 0005 之前建的，
# 采不到数比采错数好。
mapfile -t PAIRS < <(psql -At -c \
  "SELECT container_name || '|' || id FROM ispace.backends
    WHERE container_name IS NOT NULL AND status <> 'failed'")

# 每轮都报个到。脚本挂掉时的表现是「配额页永远显示暂无采样」，
# 管理员分不清是没有后端还是任务死了——巡检屏靠这条心跳区分两者。
beat() {
  psql -c "INSERT INTO ispace.job_heartbeats (name, last_run_at, ok, note)
           VALUES ('resource-sampler', now(), ${1}, \$\$${2}\$\$)
           ON CONFLICT (name) DO UPDATE
             SET last_run_at = EXCLUDED.last_run_at,
                 ok = EXCLUDED.ok, note = EXCLUDED.note" >/dev/null 2>&1 || true
}

# 无声退出。这个脚本每分钟跑一次，"没有后端"是新空间的常态——
# 每次都打一行，一年就是 50 万行日志，真出问题时反而翻不到。
if [ ${#PAIRS[@]} -eq 0 ]; then
  beat true "没有已登记容器名的后端"
  exit 0
fi

# docker stats 一次取全部，再在本地匹配。逐个容器调用会让这条命令
# 随后端数量线性变慢，而 stats 本身每次就要等一个采样周期。
STATS=$(docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}')

VALUES=""
for pair in "${PAIRS[@]}"; do
  cname="${pair%%|*}"
  bid="${pair##*|}"

  # Swarm 的实际容器名是 {前缀}.1.{taskId}，只能按前缀匹配。
  # 多副本时把各副本相加——配额算的是这个后端一共占了多少。
  line=$(awk -F'\t' -v p="$cname" '
    index($1, p) == 1 {
      cpu = $2; sub(/%$/, "", cpu); c += cpu
      split($3, m, " / "); v = m[1]
      unit = v; gsub(/[0-9.]/, "", unit)
      num = v; gsub(/[^0-9.]/, "", num)
      if (unit == "GiB") num *= 1024
      else if (unit == "KiB") num /= 1024
      else if (unit == "B")   num /= 1048576
      mem += num
      n++
    }
    END { if (n > 0) printf "%.3f\t%d", c / 100, mem }
  ' <<<"$STATS")

  [ -z "$line" ] && continue
  cpu="${line%%$'\t'*}"
  mem="${line##*$'\t'}"
  VALUES="${VALUES}${VALUES:+,}('${bid}'::uuid, ${cpu}, ${mem}, now())"
done

# 这一条留着：后端登记了却一个容器都没跑起来，是值得看见的异常
if [ -z "$VALUES" ]; then
  echo "$(date '+%F %T') 后端已登记但容器都不在运行，本轮无采样"
  beat false "后端已登记但容器都不在运行"
  exit 0
fi

# 每个后端只留最新一条，所以是 upsert 而不是 insert。
psql -c "INSERT INTO ispace.backend_usage (backend_id, cpu_cores, mem_mb, sampled_at)
         VALUES ${VALUES}
         ON CONFLICT (backend_id) DO UPDATE
           SET cpu_cores = EXCLUDED.cpu_cores,
               mem_mb    = EXCLUDED.mem_mb,
               sampled_at = EXCLUDED.sampled_at"

beat true "已采样 $(($(tr -cd ',' <<<"$VALUES" | wc -c) + 1)) 个后端"

# 成功也不打日志，同上。要确认它在跑就看巡检屏的任务心跳。
