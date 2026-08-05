-- 把散落在各处的平台参数收进 platform_policy，让管理员能在界面上改。
--
-- 这些值此前分别写死在三个地方：
--   packages/contracts 的常量（闲置归档 90 天、审计保留 12 个月）
--   packages/auth 的常量（密码下限）
--   deploy-service 的环境变量（可注册的邮箱后缀、会话时长）
-- 改任何一个都要发版或重启服务。对一个内部平台来说，
-- 「把闲置归档从 90 天调成 120 天」不该是一次上线。

-- ── 1. 账号准入 ──────────────────────────────────────────────────────
-- 逗号分隔的邮箱后缀。为空表示不限——公网实例上别这么设，那等于对全互联网
-- 开放注册，而注册一次就发一个数据 schema 和一份配额。
-- 从 ISPACE_EMAIL_DOMAINS 环境变量搬过来：环境变量仍作为初始值，
-- 库里有值就以库为准——否则界面上改完重启一次就被环境变量打回去了。
-- 默认给一个匹配不上任何人的占位，忘了配就谁都注册不了（理由见 account.ts）。
ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS email_domains text NOT NULL DEFAULT 'example.com';

-- 自助注册开关。关掉之后只能由管理员在「员工与开通」里开通。
ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS self_register_enabled boolean NOT NULL DEFAULT true;

-- 注册后是否需要管理员批准。为真时新账号落在 pending，
-- 登录会被挡住并提示等待开通。pending 这个状态迁移 0003 就加了，
-- 一直没有东西用它——就是缺这个开关。
ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS require_approval boolean NOT NULL DEFAULT false;

ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS password_min_length int NOT NULL DEFAULT 12
  CHECK (password_min_length BETWEEN 8 AND 64);

-- 会话有效期（天）。改小之后已签发的会话不会立刻失效——
-- 它们的过期时间在签发时就写进令牌了，只影响之后的登录。
ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS session_days int NOT NULL DEFAULT 30
  CHECK (session_days BETWEEN 1 AND 365);

-- ── 2. 生命周期 ──────────────────────────────────────────────────────
ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS idle_archive_days int NOT NULL DEFAULT 90
  CHECK (idle_archive_days BETWEEN 7 AND 3650);

ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS audit_retention_months int NOT NULL DEFAULT 12
  CHECK (audit_retention_months BETWEEN 1 AND 120);

-- 访问令牌的有效期上限（天）。0 表示不限期（当前行为）。
-- 设了之后只影响**新建**的令牌：追改已发出去的令牌会让人在毫无预兆的
-- 情况下发布失败。
ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS token_max_days int NOT NULL DEFAULT 0
  CHECK (token_max_days BETWEEN 0 AND 3650);

-- ── 3. 分享范围 ──────────────────────────────────────────────────────
-- 关掉「全公司」之后，已经上架的不会被自动下架——那属于内容决定，
-- 该由管理员在市场里逐个处理，而不是改个开关就静默清空别人的东西。
ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS allow_public_share boolean NOT NULL DEFAULT true;
ALTER TABLE ispace.platform_policy
  ADD COLUMN IF NOT EXISTS allow_peer_share boolean NOT NULL DEFAULT true;

-- ── 4. 离职回收的执行记录 ────────────────────────────────────────────
-- 设计稿「离职回收」写了四步：页面归档 / 后端停止 / 数据空间导出后冻结 /
-- 空间路径进入冷冻期。此前那个按钮只把用户标成 archived，四步一步没做。
--
-- 单独建表而不是塞进 audit_logs：回收是**可能中途失败**的多步操作
-- （停容器失败、导出磁盘满），需要知道走到哪一步、能否重试。
-- 审计日志是只读的事实记录，不适合承载这种状态机。
CREATE TABLE IF NOT EXISTS ispace.offboard_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  started_by  uuid NOT NULL REFERENCES ispace.users(id),
  -- 每一步的结果：{ step: 'apps'|'backends'|'data'|'path', ok: bool, note: text }
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'done', 'partial', 'failed')),
  -- 路径冷冻到期时间。到期前这个 username 不可被重新分配。
  path_frozen_until timestamptz,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS offboard_runs_user_idx
  ON ispace.offboard_runs (user_id, started_at DESC);

-- ── 5. 采集任务心跳 ──────────────────────────────────────────────────
-- 宿主上的采样脚本（12-resource-sampler.sh）挂掉时的表现是
-- 「配额页永远显示暂无采样」，管理员无从判断是没后端还是任务死了。
-- 让它每轮报个到，巡检屏就能直接说"资源采样 3 分钟前还活着"。
CREATE TABLE IF NOT EXISTS ispace.job_heartbeats (
  name       text PRIMARY KEY,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  ok         boolean NOT NULL DEFAULT true,
  note       text
);
