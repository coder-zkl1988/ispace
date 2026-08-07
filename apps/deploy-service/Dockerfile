# deploy-service 镜像。在仓库根目录构建：
#   docker build -f apps/deploy-service/Dockerfile -t ispace/deploy-service .
#
# 多阶段：构建阶段装全量依赖并编译，运行阶段只带生产依赖与产物。
# 基础镜像用 node:22-alpine——目标机上已有该镜像（计划 1 测速时拉的），不必再拉。
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
WORKDIR /repo

# 先只拷贝清单，让依赖层能被缓存——源码改动不会导致重装依赖
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json turbo.json ./
COPY packages/contracts/package.json  packages/contracts/
COPY packages/db/package.json         packages/db/
COPY packages/auth/package.json       packages/auth/
COPY packages/storage/package.json    packages/storage/
COPY packages/scanner/package.json    packages/scanner/
COPY apps/deploy-service/package.json apps/deploy-service/
RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/deploy-service/ apps/deploy-service/
RUN pnpm --filter @ispace/deploy-service... build

# 剪成仅生产依赖。
# pnpm 10+ 默认只允许从 inject-workspace-packages=true 的 workspace 部署；
# 本仓库用普通的 workspace 链接，故用 --legacy。改成 injected 会让每个包在
# 每个消费者下各存一份实体，本地开发时改 contracts 需要重装才生效，代价更大。
RUN pnpm --filter @ispace/deploy-service --prod --legacy deploy /out

FROM node:22-alpine AS runtime

# 可选国内 alpine 镜像源。镜像里要 apk add chromium，而官方 CDN
# dl-cdn.alpinelinux.org 在国内极慢甚至超时。构建时传
# --build-arg ALPINE_MIRROR=mirrors.aliyun.com 改用国内源；不传则用官方 CDN，
# 仓库保持中性。sed 只换 host、保留 /alpine/vX.Y/main 那段，故与 alpine 版本无关。
ARG ALPINE_MIRROR=""
RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s#dl-cdn.alpinelinux.org#${ALPINE_MIRROR}#g" /etc/apk/repositories; \
    fi

# tini 做 PID 1 以正确转发信号，否则 docker stop 会等满超时才强杀，
# 发布中途被杀可能留下半成品目录。
# gitleaks 作为第二道深度扫描（规格 §9），打进镜像而非起容器——
# 后者要挂 docker socket，为扫密钥开一个容器逃逸的口子不划算。
# 可选 github 代理。gitleaks 的二进制在 github release 上，而国内直连 github
# 常超时。构建时传 --build-arg GITHUB_PROXY=https://ghfast.top/ 走代理下载。
# 默认空=直连，仓库保持中性。
ARG GITHUB_PROXY=""
RUN apk add --no-cache tini curl \
 && ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/') \
 && curl -sSL --retry 3 --retry-delay 2 \
    "${GITHUB_PROXY}https://github.com/gitleaks/gitleaks/releases/download/v8.28.0/gitleaks_8.28.0_linux_${ARCH}.tar.gz" \
    | tar xz -C /usr/local/bin gitleaks \
 && chmod +x /usr/local/bin/gitleaks \
 && gitleaks version

# chromium：给没声明封面的页面自动截一张封面（services/cover-shot.ts）。
# 只装系统 chromium + 它的运行时依赖，不走 puppeteer 那套下载。
# font-wqy-zenhei：中文字体。页面几乎全是中文，不装就截出一屏豆腐块方框。
# 这是本镜像里最重的一块，仅为「封面兜底」而在——A 的声明式封面不需要它。
RUN apk add --no-cache chromium font-wqy-zenhei \
 && chromium-browser --version
ENV ISPACE_CHROMIUM_PATH=/usr/bin/chromium-browser

WORKDIR /app
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/dist ./dist
COPY --from=builder /out/package.json ./package.json
# 迁移文件在运行期由 runMigrations 读取，必须随镜像带上
COPY --from=builder /repo/packages/db/migrations ./packages/db/migrations

ENV NODE_ENV=production
ENV PORT=3100
EXPOSE 3100

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
