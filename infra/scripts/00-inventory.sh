#!/usr/bin/env bash
# 目标机现状快照：容器、卷、镜像、端口占用、宿主进程。只读，可重复执行。
#
# 装 Dokploy 之前先跑一次——它要接管 80/443 并 swarm init，
# 事先知道机器上还跑着什么，比事后从报错倒推便宜得多。
#
# 用法: ./infra/scripts/00-inventory.sh > /tmp/inventory-$(date +%F).txt
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/remote.sh" '
echo "# 快照时间: $(date -Iseconds)"
echo
echo "## 容器 (名称|镜像|状态)"
docker ps -a --format "{{.Names}}|{{.Image}}|{{.Status}}"
echo
echo "## 卷"
docker volume ls --format "{{.Name}}"
echo
echo "## compose 项目 (项目名|工作目录)"
docker ps -a --format "{{.Label \"com.docker.compose.project\"}}|{{.Label \"com.docker.compose.project.working_dir\"}}" | sort -u | grep -v "^|$"
echo
echo "## 端口占用"
ss -tln | tail -n +2
echo
echo "## 宿主进程 (PID|名称|内存%)"
# 清理只删容器，但依赖容器的宿主进程可能连带退出。
# 必须全量记录 PID，事后才能逐个对照存活情况。
ps -eo pid,comm,pmem --no-headers --sort=-pmem 2>/dev/null | awk "{printf \"%s|%s|%s\n\", \$1, \$2, \$3}"
echo
echo "## systemd 单元 (system, 运行中)"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk "{print \$1}"
echo
echo "## systemd 单元 (user, 全部已启用)"
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user list-unit-files --state=enabled --no-pager --no-legend 2>/dev/null | awk "{print \$1}"
echo
echo "## 磁盘"
docker system df
'
