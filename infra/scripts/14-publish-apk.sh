#!/usr/bin/env bash
# 发布安卓 App 的安装包到公开下载路径。幂等：重复执行即覆盖同一份文件。
#
#   本机 apps/mobile-shell/android/.../app-release.apk
#     → 服务器 /srv/dist/ispace.apk
#     → 网关 $ISPACE_BASE_URL/dist/ispace.apk
#
# 这条路径**不需要登录**，这是刻意的：同事装 App 的那一刻手上还没有会话，
# 要求先登录等于让人先在手机浏览器里敲一遍公司邮箱密码，扫码就白扫了。
# 免登录靠的是 Caddyfile 里 `handle /dist/*` 落在 @userapp（带 forward_auth）
# 之前，而不是靠 deploy-service 网开一面——见 infra/caddy/Caddyfile。
#
# 同时写一份 /srv/dist/version.json 供 portal 展示版本号、体积、更新时间。
# 顺序是先传 apk 再传 version.json：反过来的话，version.json 会有几十秒
# 在描述一个还没传完的文件，前端拿到的 sha256 与实际下到的对不上。
#
# 前置：
#   - APK 已构建（cd apps/mobile-shell/android && ./gradlew assembleRelease）
#   - Caddyfile 里有 /dist 段且已部署（infra/scripts/07-deploy-caddy.sh）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOST="${TARGET_HOST:?需要设置 TARGET_HOST，形如 deploy@ispace.example.com}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/ispace_deploy}"
BASE_URL="${ISPACE_BASE_URL:?需要设置 ISPACE_BASE_URL，形如 https://ispace.example.com}"
SUDO_PW="${REMOTE_SUDO_PW:-1234}"

APK="${ISPACE_APK:-$REPO_ROOT/apps/mobile-shell/android/app/build/outputs/apk/release/app-release.apk}"
REMOTE_DIR=/srv/dist
# 对外文件名固定。用 app-release.apk 的话，用户下载目录里躺着的东西
# 看不出是哪个应用；带版本号的话，二维码里的链接每发一版就变，
# 已经贴在工位上的那张就废了。
REMOTE_NAME=ispace.apk

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
RSH="/usr/bin/ssh ${SSH_OPTS[*]}"

# ── 1. 校验本机产物 ───────────────────────────────────────────────────
echo "== 1. 校验本机产物 =="
if [ ! -f "$APK" ]; then
  echo "找不到 APK：$APK" >&2
  echo "先构建：cd apps/mobile-shell/android && ./gradlew assembleRelease" >&2
  exit 1
fi

# wc -c 而不是 stat：stat 的取大小参数在 macOS 与 Linux 上不同名，
# 而这个脚本在开发机（macOS）跑、将来也可能进 CI（Linux）。
SIZE=$(wc -c < "$APK" | tr -d ' ')
if [ "$SIZE" -lt 1000000 ]; then
  echo "APK 只有 $SIZE 字节，不像是完整产物——中止，避免用坏包覆盖线上。" >&2
  exit 1
fi

# 校验和用来让人能确认「手机上下到的这一份」与「服务器上这一份」是同一个文件。
if command -v shasum >/dev/null 2>&1; then
  SHA=$(shasum -a 256 "$APK" | awk '{print $1}')
else
  SHA=$(sha256sum "$APK" | awk '{print $1}')
fi

MTIME=$(stat -f %m "$APK" 2>/dev/null || stat -c %Y "$APK")
BUILT_AT=$(date -u -r "$MTIME" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$MTIME" +%Y-%m-%dT%H:%M:%SZ)
PUBLISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 版本号有两处来源，都要带上：
#   expo.version  给人看（"1.0.0"）
#   versionCode   给系统看（安卓靠它判断能不能覆盖安装）
VERSION=$(node -p "require('$REPO_ROOT/apps/mobile-shell/app.json').expo.version")
VERSION_CODE=$(awk '/versionCode/ {print $2; exit}' \
  "$REPO_ROOT/apps/mobile-shell/android/app/build.gradle")
: "${VERSION:?读不到 app.json 的 expo.version}"
: "${VERSION_CODE:?读不到 build.gradle 的 versionCode}"

printf '   版本 %s (%s)  %s 字节  sha256 %s…\n' \
  "$VERSION" "$VERSION_CODE" "$SIZE" "${SHA:0:12}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cat > "$STAGE/version.json" <<JSON
{
  "version": "$VERSION",
  "versionCode": $VERSION_CODE,
  "platform": "android",
  "file": "$REMOTE_NAME",
  "url": "/dist/$REMOTE_NAME",
  "sizeBytes": $SIZE,
  "sha256": "$SHA",
  "builtAt": "$BUILT_AT",
  "publishedAt": "$PUBLISHED_AT"
}
JSON

# ── 2. 准备远端目录 ───────────────────────────────────────────────────
echo "== 2. 准备远端目录 =="
"$SCRIPT_DIR/remote.sh" \
  "SUDO_PW='$SUDO_PW' DEPLOY_USER='${ISPACE_DEPLOY_USER:-${TARGET_HOST%%@*}}' bash -s" <<'REMOTE'
set -eu
sudo_run() { echo "$SUDO_PW" | sudo -S -p "" "$@"; }
sudo_run mkdir -p /srv/dist
sudo_run chown "$DEPLOY_USER:$DEPLOY_USER" /srv/dist
# 755：Caddy 容器以只读方式挂进去读，其他人只需要能进目录。
sudo_run chmod 755 /srv/dist
ls -ld /srv/dist | sed 's/^/   /'
REMOTE

# ── 3. 上传 ───────────────────────────────────────────────────────────
echo "== 3. 上传（约 $((SIZE / 1048576)) MB）=="
# 不加 -z：APK 本身就是 zip，再压一遍只是白烧两头的 CPU。
# 也不加 --inplace：rsync 默认先写临时文件再原子改名，中途断线时线上要么
# 是旧包要么没变，绝不会是半个包——而半个 apk 装到一半失败最难查。
# 也不用 --chmod：macOS 自带的是 openrsync（对外自称 2.6.9），没有这个参数，
# 传进去只会得到一句 "invalid argument"。权限统一在远端 chmod。
rsync -a -e "$RSH" "$APK" "$HOST:$REMOTE_DIR/$REMOTE_NAME"
rsync -a -e "$RSH" "$STAGE/version.json" "$HOST:$REMOTE_DIR/version.json"

# Caddy 在容器里以别的 uid 读这两个文件，属主对不上时只有 o+r 救得了它。
"$SCRIPT_DIR/remote.sh" \
  "chmod 644 $REMOTE_DIR/$REMOTE_NAME $REMOTE_DIR/version.json && ls -l $REMOTE_DIR | sed 's/^/   /'"

# ── 4. 确认网关看得见这个目录 ─────────────────────────────────────────
echo "== 4. 确认 Caddy 挂载 =="
# /srv/dist 是新加的挂载。docker compose restart 不会带上新卷——卷在建容器
# 时就定死了，restart 只是同一个容器再跑一遍。所以这里检测到缺失就 up -d 重建。
if ! "$SCRIPT_DIR/remote.sh" \
  "docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' ispace-caddy" \
  | grep -q '/srv/dist'; then
  echo "   缺 /srv/dist 挂载，重建 caddy 容器"
  /usr/bin/scp "${SSH_OPTS[@]}" \
    "$REPO_ROOT/infra/dokploy/static-hosting.compose.yml" "$HOST:~/ispace-deploy/"
  "$SCRIPT_DIR/remote.sh" \
    'cd ~/ispace-deploy && docker compose -f static-hosting.compose.yml -p ispace up -d caddy 2>&1 | tail -3'
  sleep 5
else
  echo "   已挂载"
fi

# ── 5. 冒烟 ───────────────────────────────────────────────────────────
echo "== 5. 冒烟 =="
fail=0

# curl 默认不带任何 cookie，这一发就是「未登录的同事」看到的结果。
# 200/206 才算过：302（被赶去登录）与 403 都意味着这条路径被鉴权吃了。
#
# 只取头 1 MiB 而不是整包：整包 90 MB，普通网络下要几十秒，配上 --max-time
# 就成了一个会随网速随机失败的断言。而「有没有被鉴权拦」头一个字节就见分晓。
#
# ⚠️ 这里不能写 `|| echo 000`：-w 的状态码在 curl 超时前就已经打印过了，
# 再 echo 一次会拼成 "200000"，判等永远不成立。踩过。
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-1048575' \
  --max-time 30 "$BASE_URL/dist/$REMOTE_NAME" || true)
printf '   %-24s %s（未带 cookie）\n' "/dist/$REMOTE_NAME" "$code"
case "$code" in 200|206) ;; *) fail=1 ;; esac

hdr=$(curl -sI --max-time 30 "$BASE_URL/dist/$REMOTE_NAME" || true)
ctype=$(printf '%s' "$hdr" | tr -d '\r' | awk 'tolower($1)=="content-type:"{print $2}')
clen=$(printf '%s' "$hdr" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')
printf '   %-24s %s\n' "content-type" "${ctype:-（无）}"
printf '   %-24s %s（本地 %s）\n' "content-length" "${clen:-（无）}" "$SIZE"

# 这一条不是形式主义：类型不对时部分安卓浏览器不会唤起安装器，
# 而是把 95MB 当文本渲染或存成 .zip，用户以为「下载坏了」。
if [ "$ctype" != "application/vnd.android.package-archive" ]; then
  echo "   content-type 不对，浏览器可能不会进安装器" >&2
  fail=1
fi
if [ "$clen" != "$SIZE" ]; then
  echo "   content-length 与本地文件不一致，传输可能被截断或被中间层改写" >&2
  fail=1
fi

vcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE_URL/dist/version.json" || true)
printf '   %-24s %s\n' "/dist/version.json" "$vcode"
[ "$vcode" = "200" ] || fail=1

[ "$fail" = "0" ] || { echo "冒烟未通过" >&2; exit 1; }

echo
echo "发布完成"
echo "  下载地址：$BASE_URL/dist/$REMOTE_NAME"
echo "  版本信息：$BASE_URL/dist/version.json"
