-- 管理员治理面所需的字段与表（设计稿管理员 5 屏）。
--
-- 一期把这几屏做薄了：只呈现能从既有数据算出来的部分。设计稿上还有四块
-- 需要自己的数据源，本迁移把它们补齐：
--   1. 审计表的来源 IP —— 设计稿「审计与安全」有 IP 列
--   2. 待激活状态     —— 设计稿「员工与开通」有「待激活 / 冷冻期」计数
--   3. 提额申请       —— 设计稿「资源与配额」有「超限与提额申请」待办表
--   4. 备份运行记录   —— 设计稿「审计与安全」有「备份与恢复」页签

-- ── 1. 审计来源 IP ───────────────────────────────────────────────────
-- 可空：既有记录没有这个信息，回填不了；MCP/CLI 走反代时取 X-Forwarded-For。
ALTER TABLE ispace.audit_logs ADD COLUMN IF NOT EXISTS ip inet;

-- ── 2. 用户状态：补 pending（待激活）────────────────────────────────
-- 管理员开通后、员工首次登录前处于 pending。原先只有 active/archived，
-- 于是「开通了但人还没来过」和「已经在用」混在一起，管理员看不出差别。
ALTER TABLE ispace.users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE ispace.users ADD CONSTRAINT users_status_check
  CHECK (status IN ('pending', 'active', 'archived'));

-- 归档时间已有（archived_at），冷冻期由它算：归档后 30 天内算冷冻期，
-- 期间可一键恢复；超过则进入可清理状态。不另存字段，避免两处状态打架。

-- ── 3. 提额申请 ──────────────────────────────────────────────────────
-- 设计稿「配额与用量」有「申请提额」按钮，「资源与配额」有待处理清单。
-- 之前两边都只是静态文案，点了没有任何事发生。
CREATE TABLE IF NOT EXISTS ispace.quota_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  -- 申请哪种资源。与 quotas 表的列一一对应。
  resource     text NOT NULL CHECK (resource IN ('storage', 'backends', 'rows')),
  -- 提交当时的用量与上限，冻结下来：批准时的对比要看的是"当时",
  -- 而不是审批那一刻重新查出来的值。
  current_used  bigint NOT NULL,
  current_limit bigint NOT NULL,
  requested_limit bigint NOT NULL CHECK (requested_limit > 0),
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by   uuid REFERENCES ispace.users(id),
  decided_at   timestamptz,
  decision_note text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quota_requests_pending_idx
  ON ispace.quota_requests (created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS quota_requests_user_idx
  ON ispace.quota_requests (user_id, created_at DESC);

-- 一个人对同一种资源同时只能有一条待处理申请。否则连点几下按钮
-- 就会在管理员的待办里堆出一串重复项。
CREATE UNIQUE INDEX IF NOT EXISTS quota_requests_one_pending_idx
  ON ispace.quota_requests (user_id, resource) WHERE status = 'pending';

-- ── 4. 默认配额策略 ──────────────────────────────────────────────────
-- 设计稿「资源与配额」的四个数字（0.5 vCPU / 512 MB / 2 个 / 500 MB）
-- 原先硬编码在前端与后端两处。挪到库里，「编辑策略」才可能真的生效，
-- 也避免前端显示的和后端强制写入的对不上。
CREATE TABLE IF NOT EXISTS ispace.platform_policy (
  -- 单行表。用固定主键把它钉成单行，避免出现两份互相矛盾的策略。
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  backend_cpu_limit     text   NOT NULL DEFAULT '0.5',
  backend_memory_bytes  bigint NOT NULL DEFAULT 536870912,
  backend_count_limit   int    NOT NULL DEFAULT 2,
  storage_bytes_limit   bigint NOT NULL DEFAULT 524288000,
  updated_by            uuid REFERENCES ispace.users(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ispace.platform_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ── 5. 备份运行记录 ──────────────────────────────────────────────────
-- 设计稿「备份与恢复」页签要显示最近一次备份与恢复演练的结果。
-- 由 infra/scripts/09-backup.sh 与 10-restore-drill.sh 写入。
-- 没有这张表时，那个页签只能显示一句"请去服务器上看日志"。
CREATE TABLE IF NOT EXISTS ispace.backup_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('backup', 'restore_drill')),
  status      text NOT NULL CHECK (status IN ('success', 'failed')),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  size_bytes  bigint,
  -- 失败原因或演练结论。演练成功时记录比对到的行数，失败时记录报错。
  note        text
);

CREATE INDEX IF NOT EXISTS backup_runs_recent_idx
  ON ispace.backup_runs (kind, finished_at DESC);
