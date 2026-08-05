# updates-service 镜像。在仓库根目录构建：
#   docker build -f apps/updates-service/Dockerfile -t ispace/updates-service .
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
COPY apps/updates-service/package.json apps/updates-service/
RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/updates-service/ apps/updates-service/
RUN pnpm --filter @ispace/updates-service... build

# 剪成仅生产依赖。
# pnpm 10+ 默认只允许从 inject-workspace-packages=true 的 workspace 部署；
# 本仓库用普通的 workspace 链接，故用 --legacy。改成 injected 会让每个包在
# 每个消费者下各存一份实体，本地开发时改 contracts 需要重装才生效，代价更大。
RUN pnpm --filter @ispace/updates-service --prod --legacy deploy /out

FROM node:22-alpine AS runtime

# 解压与软链操作需要；alpine 默认没有 tini，用它做 PID 1 以正确转发信号，
# 否则 docker stop 会等满超时才强杀，发布中途被杀可能留下半成品目录
RUN apk add --no-cache tini

WORKDIR /app
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/dist ./dist
COPY --from=builder /out/package.json ./package.json
# 迁移文件在运行期由 runMigrations 读取，必须随镜像带上
COPY --from=builder /repo/packages/db/migrations ./packages/db/migrations

ENV NODE_ENV=production
ENV PORT=3200
EXPOSE 3200

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
