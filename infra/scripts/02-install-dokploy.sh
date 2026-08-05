#!/usr/bin/env bash
# 安装 Dokploy。幂等：已安装则跳过安装、只做校验。
# 需要 REMOTE_SUDO_PW 环境变量（目标机 sudo 口令，不落盘）。
#
# 实测踩过的三个坑，改动前先读：
#
# 1. 不要配 registry-mirror。目标机原有 "registry-mirrors": ["https://docker.1ms.run"]，
#    实测该源约 43 KB/s，直连 docker.io 为 4-8 MB/s——加速器比直连慢两个数量级。
#    dokploy 镜像达 3.14 GB，经加速器 40 分钟拉不完，直连 391 秒完成。
#    本脚本会检测并提示移除 registry-mirrors。
#
# 2. 换网络后必须先退出旧 swarm。swarm init 把 advertise 地址固化为当时的主 IP，
#    机器换网卡（Wi-Fi → 有线）后该地址失效，表现为 docker pull 卡在 "Waiting" 不动。
#    `docker swarm leave --force` + 重启 dockerd 后恢复。
#
# 3. 重装前必须删除 dokploy-postgres 卷。安装脚本每次生成新的 DB 口令，但 postgres
#    复用既有数据目录里的旧口令，导致 dokploy 反复重启并报
#    `password authentication failed for user "dokploy"`。
#
# 另注：/etc/dokploy 可能在安装失败后残留且为空，不能用「目录存在」判断已安装，
# 必须判断目录非空。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REMOTE_SUDO_PW:?需要设置 REMOTE_SUDO_PW 环境变量}"

"$SCRIPT_DIR/remote.sh" "REMOTE_SUDO_PW='$REMOTE_SUDO_PW' bash -s" <<'REMOTE'
set -eu
# 注意：sudo -S 从 stdin 读口令，因此绝不能把文件内容管道进 sudo_run，
# 否则内容被 sudo 当作口令吃掉、而口令被写进目标文件。
# 需要以 root 写文件时：先以普通用户写 /tmp，再 sudo cp。
sudo_run() { echo "$REMOTE_SUDO_PW" | sudo -S -p "" "$@"; }

echo "== 前置检查 =="
if sudo_run grep -q "registry-mirrors" /etc/docker/daemon.json 2>/dev/null; then
  echo "  警告: 检测到 registry-mirrors。实测该配置显著拖慢拉取，建议移除后重启 dockerd:"
  echo "    printf '{}\\n' > /tmp/d.json && sudo cp /tmp/d.json /etc/docker/daemon.json && sudo systemctl restart docker"
else
  echo "  registry-mirrors: 未配置（正确）"
fi
echo "  Swarm 地址:   $(docker info 2>/dev/null | grep -i 'Node Address' | awk '{print $3}' || echo '未加入')"
echo "  主机默认 IP:  $(ip route | awk '/^default/{print $9; exit}')"

echo
if [ -n "$(sudo_run ls -A /etc/dokploy 2>/dev/null)" ]; then
  echo "== Dokploy 已安装，跳过安装步骤 =="
else
  echo "== 安装 Dokploy =="
  curl -sSL https://dokploy.com/install.sh -o /tmp/dokploy-install.sh
  sudo_run bash /tmp/dokploy-install.sh 2>&1 | tail -15
fi

echo
echo "== 校验 =="
echo "Swarm: $(docker info 2>/dev/null | grep -i '^ Swarm' | awk '{print $2}')"
docker service ls --format "  {{.Name}}|{{.Replicas}}|{{.Image}}" 2>/dev/null || echo "  (service ls 不可用)"
for p in 80 443 3000; do
  ss -tln | grep -qE "[:.]$p\b" && echo "  端口 $p 占用" || echo "  端口 $p 空闲（异常）"
done
REMOTE
