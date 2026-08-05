-- ispace 平台元数据库
--
-- 落在与 Supabase 同一个 Postgres 实例的独立 schema `ispace` 中。
-- 用户的业务数据不在这里——那些在各自的 u_{username} schema，两者互不相干
-- （规格 §6、技术方案 §4.3 的「两层认证」）。
--
-- 约定：
--   - 时间戳一律 timestamptz，应用层不做时区转换
--   - 枚举用 text + CHECK 而非 pg enum：加值不需要 ALTER TYPE，迁移更轻
--   - 软删除用 status/archived_at，不物理删除——离职回收需要留痕

CREATE SCHEMA IF NOT EXISTS ispace;
SET search_path TO ispace;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── users ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sso_subject   text NOT NULL UNIQUE,
  -- 与 RESERVED_PATHS 的冲突由应用层校验（packages/contracts）。
  -- 这里只保证唯一与字符形态，保留字表放在代码里便于随平台演进。
  username      text NOT NULL UNIQUE
                CHECK (username ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(username) BETWEEN 2 AND 31),
  display_name  text NOT NULL,
  email         text,
  role          text NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
  -- identity 与 role 正交：管理员可以是使用者，普通员工可以是开发者
  identity      text NOT NULL DEFAULT 'user'     CHECK (identity IN ('user','developer')),
  status        text NOT NULL DEFAULT 'active'   CHECK (status IN ('active','archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

-- ── app_groups ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.app_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 24),
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

-- ── apps ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.apps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  slug                text NOT NULL
                      CHECK (slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 31),
  name                text NOT NULL,
  description         text,
  icon_letter         text NOT NULL DEFAULT '·',
  type                text NOT NULL DEFAULT 'static'
                      CHECK (type IN ('static','static_backend','h5')),
  -- building 是异步发布的中间态，设计稿「我的页面」屏有此状态
  status              text NOT NULL DEFAULT 'building'
                      CHECK (status IN ('running','building','stopped')),
  current_release_id  uuid,
  group_id            uuid REFERENCES ispace.app_groups(id) ON DELETE SET NULL,
  sort_order          integer NOT NULL DEFAULT 0,
  visibility          text NOT NULL DEFAULT 'private'
                      CHECK (visibility IN ('private','shared','public')),
  size_bytes          bigint NOT NULL DEFAULT 0,
  -- 90 天无访问先通知后归档（规格 §6）需要这个字段
  last_accessed_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- 同一用户下路径唯一。这决定了 /{user}/{app}/ 的唯一性
  UNIQUE (owner_id, slug)
);

-- ── releases ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.releases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         uuid NOT NULL REFERENCES ispace.apps(id) ON DELETE CASCADE,
  version        integer NOT NULL CHECK (version > 0),
  source         text NOT NULL CHECK (source IN ('mcp','cli','agent','console')),
  status         text NOT NULL CHECK (status IN ('building','active','superseded','blocked')),
  size_bytes     bigint NOT NULL DEFAULT 0,
  -- releases 目录下的时间戳目录名，回滚即切软链到它
  path           text NOT NULL,
  published_by   uuid NOT NULL REFERENCES ispace.users(id),
  published_at   timestamptz NOT NULL DEFAULT now(),
  -- 仅 status='blocked' 时有值，记录命中的扫描规则
  blocked_reason text,
  UNIQUE (app_id, version)
);

-- 每个应用至多一个 active 版本。用部分唯一索引在数据库层强制，
-- 避免并发发布产生两个 active 而软链只能指向一个，导致库与磁盘不一致。
CREATE UNIQUE INDEX IF NOT EXISTS releases_one_active_per_app
  ON ispace.releases (app_id) WHERE status = 'active';

ALTER TABLE ispace.apps
  DROP CONSTRAINT IF EXISTS apps_current_release_fk;
ALTER TABLE ispace.apps
  ADD CONSTRAINT apps_current_release_fk
  FOREIGN KEY (current_release_id) REFERENCES ispace.releases(id) ON DELETE SET NULL;

-- ── shares ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid NOT NULL REFERENCES ispace.apps(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  to_user_id   uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','accepted','rejected','revoked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (from_user_id <> to_user_id)
);

-- 同一应用对同一人只保留一条未终结的分享，避免重复发卡刷屏
CREATE UNIQUE INDEX IF NOT EXISTS shares_one_pending
  ON ispace.shares (app_id, to_user_id) WHERE status = 'pending';

-- ── app_installs ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.app_installs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id     uuid NOT NULL REFERENCES ispace.apps(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  source     text NOT NULL CHECK (source IN ('share','marketplace')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, user_id)
);

-- ── marketplace_listings ─────────────────────────────────────────────
-- 一期建表、契约完整，UI 二期实现（规格 D10）
CREATE TABLE IF NOT EXISTS ispace.marketplace_listings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        uuid NOT NULL UNIQUE REFERENCES ispace.apps(id) ON DELETE CASCADE,
  published_by  uuid NOT NULL REFERENCES ispace.users(id),
  published_at  timestamptz NOT NULL DEFAULT now(),
  -- 由 app_installs 计数物化，避免列表页 N+1
  install_count integer NOT NULL DEFAULT 0
);

-- ── backends ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.backends (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  app_id           uuid REFERENCES ispace.apps(id) ON DELETE SET NULL,
  name             text NOT NULL,
  source_repo      text,
  -- 限额由平台在建应用时强制写入，不依赖用户自觉（技术方案 §4.4）
  cpu_limit        numeric(4,2) NOT NULL DEFAULT 0.5 CHECK (cpu_limit > 0),
  mem_limit_mb     integer NOT NULL DEFAULT 512 CHECK (mem_limit_mb > 0),
  status           text NOT NULL DEFAULT 'creating'
                   CHECK (status IN ('creating','running','stopped','failed')),
  url_path         text NOT NULL,
  -- 编排器侧标识（Dokploy applicationId）
  orchestrator_ref text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

-- ── quotas ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.quotas (
  user_id              uuid PRIMARY KEY REFERENCES ispace.users(id) ON DELETE CASCADE,
  storage_bytes_used   bigint  NOT NULL DEFAULT 0,
  storage_bytes_limit  bigint  NOT NULL DEFAULT 524288000,  -- 500 MB
  backend_count_used   integer NOT NULL DEFAULT 0,
  backend_count_limit  integer NOT NULL DEFAULT 2,
  db_rows_used         bigint  NOT NULL DEFAULT 0,
  db_rows_limit        bigint  NOT NULL DEFAULT 50000,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── audit_logs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ispace.audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid NOT NULL REFERENCES ispace.users(id),
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text,
  source      text NOT NULL CHECK (source IN ('mcp','cli','agent','console')),
  result      text NOT NULL CHECK (result IN ('success','blocked','failed')),
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON ispace.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx      ON ispace.audit_logs (actor_id, created_at DESC);
-- 设计稿「发布记录」屏有「被阻断」计数，需要按 result 过滤
CREATE INDEX IF NOT EXISTS audit_logs_result_idx     ON ispace.audit_logs (result) WHERE result <> 'success';

-- ── mobile_channels / mobile_releases ────────────────────────────────
-- 三期实现，一期建表（规格 D1）
CREATE TABLE IF NOT EXISTS ispace.mobile_channels (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL UNIQUE REFERENCES ispace.users(id) ON DELETE CASCADE,
  channel_name       text NOT NULL UNIQUE,
  current_release_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ispace.mobile_releases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  bundle_version  integer NOT NULL CHECK (bundle_version > 0),
  -- 与壳的 runtimeVersion 协议级匹配，不符则服务端不下发
  runtime_version text NOT NULL,
  manifest        jsonb NOT NULL,
  rollout_percent integer NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  status          text NOT NULL DEFAULT 'building'
                  CHECK (status IN ('building','active','superseded','blocked')),
  published_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, bundle_version)
);

ALTER TABLE ispace.mobile_channels
  DROP CONSTRAINT IF EXISTS mobile_channels_current_release_fk;
ALTER TABLE ispace.mobile_channels
  ADD CONSTRAINT mobile_channels_current_release_fk
  FOREIGN KEY (current_release_id) REFERENCES ispace.mobile_releases(id) ON DELETE SET NULL;

-- ── 索引 ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS apps_owner_idx     ON ispace.apps (owner_id, sort_order);
CREATE INDEX IF NOT EXISTS apps_visibility_idx ON ispace.apps (visibility) WHERE visibility = 'public';
CREATE INDEX IF NOT EXISTS releases_app_idx   ON ispace.releases (app_id, version DESC);
CREATE INDEX IF NOT EXISTS shares_to_user_idx ON ispace.shares (to_user_id, status);
