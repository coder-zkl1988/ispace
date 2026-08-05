-- 两块「有屏但没数」的遥测：手机端设备状态、后端容器资源用量。
--
-- 设计稿「更新通道」屏有四张卡（当前到端版本 / 活跃设备 / 发布到端耗时 /
-- 加载失败设备），「配额与用量」屏有五条（含后端 CPU、后端内存）。
-- 前者三张、后者两条此前都无数可取，只能显示占位——这次把采集补上。

-- ── 1. 手机端设备 ────────────────────────────────────────────────────
-- 一台设备一行，不是一次请求一行。
--
-- 按请求追加会在几天内长成百万行，而这一屏要的只是"现在有几台在用、
-- 分别停在哪个版本"——那是设备的当前状态，不是历史。真要看历史，
-- mobile_releases 的发布时间加这里的 first_seen 已经够还原了。
--
-- device_id 由壳生成并存在 SecureStore（见 bridge.deviceId），
-- 卸载重装会变——那本来就该算一台新设备。
CREATE TABLE IF NOT EXISTS ispace.mobile_devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  device_id        text NOT NULL,
  -- 这台设备当前实际跑着的页面包。为空表示还没成功加载过任何版本。
  current_release_id uuid REFERENCES ispace.mobile_releases(id) ON DELETE SET NULL,
  -- 最近一次向更新服务要 manifest 的时间。"活跃设备"按它算。
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  -- 最近一次加载失败的原因与时间。成功加载后清空——
  -- 不清的话"加载失败设备"会把已经修好的设备一直算进去。
  last_error       text,
  last_error_at    timestamptz,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS mobile_devices_user_seen_idx
  ON ispace.mobile_devices (user_id, last_seen_at DESC);
-- 「到端设备」按版本聚合，这条让它不用全表扫
CREATE INDEX IF NOT EXISTS mobile_devices_release_idx
  ON ispace.mobile_devices (current_release_id)
  WHERE current_release_id IS NOT NULL;

-- 每个版本第一次被设备装上的时间。设计稿「发布到端耗时」= 它减去 published_at。
-- 放在 releases 上而不是从 devices 里 min()：设备表会被清理（卸载、换机），
-- 清完之后这个时间就永远算不回来了。
ALTER TABLE ispace.mobile_releases
  ADD COLUMN IF NOT EXISTS first_delivered_at timestamptz;

-- ── 2. 后端容器资源采样 ──────────────────────────────────────────────
-- deploy-service 不挂 docker.sock（有意为之，见 apps/deploy-service/Dockerfile
-- 的注释：为了读几个数字开一个容器逃逸的口子不划算）。所以采集放在宿主上，
-- 由定时任务写库，服务端只读——见 infra/scripts/12-resource-sampler.sh。
--
-- 只留每个后端的最新一条：这一屏问的是"现在用了多少"。留历史要另设保留策略，
-- 而没有人会在这个平台上看后端的 CPU 曲线——真要看，Dokploy 自己有。
CREATE TABLE IF NOT EXISTS ispace.backend_usage (
  backend_id   uuid PRIMARY KEY REFERENCES ispace.backends(id) ON DELETE CASCADE,
  cpu_cores    numeric(6,3) NOT NULL CHECK (cpu_cores >= 0),
  mem_mb       integer      NOT NULL CHECK (mem_mb >= 0),
  sampled_at   timestamptz  NOT NULL DEFAULT now()
);

-- 采样任务用它按容器名回填 backend_id。容器名由编排器决定，
-- 与 orchestrator_ref 不是一回事，得单独记。
ALTER TABLE ispace.backends
  ADD COLUMN IF NOT EXISTS container_name text;

CREATE INDEX IF NOT EXISTS backends_container_idx
  ON ispace.backends (container_name) WHERE container_name IS NOT NULL;
