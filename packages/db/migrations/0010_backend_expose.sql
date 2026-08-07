-- 后端露出到「我的空间」+ /svc 鉴权代理所需的三列。
--
-- 背景：后端一直有对外地址 /svc/{user}/{name}，但门户不展示、无法分享，
-- 且 /svc 由 Dokploy 经 Traefik 直连容器、绕过页面那套 forward_auth——
-- 「知道 URL 就能访问」，没有可见性控制。
--
-- 方案：iSpace 接管 /svc，deploy-service 做鉴权代理（按页面同一套三档可见性
-- 鉴权，再按 container_name 代到容器）。这三列是它的数据基础。

ALTER TABLE ispace.backends
  -- 是否在「我的空间」露出。
  --   false（默认，纯 API 服务）：只在控制台与 AI 可见，不进空间、不可分享
  --   true （全栈项目，带前台）：作为卡片出现在「我的页面」，可分享
  ADD COLUMN IF NOT EXISTS exposed boolean NOT NULL DEFAULT false,

  -- 露出后的访问范围，与 apps.visibility 三档同义。exposed=false 时无意义。
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared', 'public')),

  -- 容器内监听端口。鉴权代理要按 http://{container_name}:{port} 连过去。
  -- 之前建后端时 port 只进了编排器、没落库，默认值也不一定对（实测有的
  -- 后端是 8080 不是 3000）。默认 3000 沿用 Node 惯例，建后端时以实际值覆盖。
  ADD COLUMN IF NOT EXISTS port integer NOT NULL DEFAULT 3000;
