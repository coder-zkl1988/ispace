-- 在线人数（presence）与 install_count 自愈。
--
-- 两件事放在一个迁移里，因为它们是同一个问题的两面：卡片上的两个数字
--   「N 人复用」  —— marketplace_listings.install_count（引用数的物化）
--   「M 人正在用」—— presence 表按时间窗的实时计数
-- 前者此前只在市场安装/卸载三个端点里重算，分享接受/收回、离职清理、
-- 上下架等十余个写入口全部绕过，数字长期偏低或虚高且永不自愈。与其在
-- 每个写入口补一句 UPDATE——下一个新入口还会忘——不如把维护挂到
-- app_installs / backend_installs 自己身上。

-- ── presence：谁此刻正打开着这个页面/后端 ────────────────────────────
-- visitor_key 的三种取值：
--   u:{user_id}   —— 登录用户（shell.js 心跳带 Cookie / svc 代理识别会话）
--   a:{随机ID}    —— 未登录访客，浏览器 localStorage 里生成一次、终身携带
--                    （私密链接「知道链接的任何人」是第一等公民，访问算数）
--   a:ip:{地址}   —— localStorage 不可用（隐私模式）时按 IP 兜底
-- 「正在用」= last_seen_at 落在 90 秒窗口内；shell.js 每 30 秒一跳，
-- 后台标签页被浏览器限流到约 60 秒一跳，90 秒窗口两种都接得住。
-- 过期行不删也不影响计数，maintenance 每 6 小时清一次一天以前的。
CREATE TABLE IF NOT EXISTS ispace.app_presence (
  app_id       uuid NOT NULL REFERENCES ispace.apps(id) ON DELETE CASCADE,
  visitor_key  text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, visitor_key)
);

CREATE TABLE IF NOT EXISTS ispace.backend_presence (
  backend_id   uuid NOT NULL REFERENCES ispace.backends(id) ON DELETE CASCADE,
  visitor_key  text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (backend_id, visitor_key)
);

-- 离职回收要删「离职者装过别人页面」的引用（否则同事卡片的「N 人复用」
-- 永久虚高），但回收的教义是「只回收不销毁、可恢复」（见 offboard.ts
-- 头注释与 takedown/restore 的同款判断）——所以删之前把行快照存进
-- offboard_runs，restore 时原样放回。
ALTER TABLE ispace.offboard_runs
  ADD COLUMN IF NOT EXISTS removed_installs jsonb NOT NULL DEFAULT '{}';

-- ── install_count 增量触发器 ────────────────────────────────────────
-- 为什么是 ±1 增量而不是 count(*) 重算：READ COMMITTED 下，行级触发器里
-- 的相关子查询用的是本条语句的快照，等锁结束后也不会重取——两个并发
-- 安装各自数出旧值、后写覆盖先写，计数就永远少一（PG18 两会话实测复现
-- 过）。增量对「行当前值」做算术，第二个事务等锁后会拿到最新行版本再
-- 加自己的 1，天然串行正确。
--   INSERT（确实新增了一行）→ +1；DELETE（确实删掉了一行）→ -1；
--   ON CONFLICT DO NOTHING 不触发触发器——没有行变化就没有计数变化。
-- 计数若因历史数据漂移，由两处全量校正兜底：本迁移末尾的一次性回填、
-- 以及每次上架 SQL 里的初始化（marketplace.ts / visibility.ts）。
CREATE OR REPLACE FUNCTION ispace.sync_app_install_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE ispace.marketplace_listings
       SET install_count = install_count + 1
     WHERE app_id = NEW.app_id;
  ELSE
    UPDATE ispace.marketplace_listings
       SET install_count = install_count - 1
     WHERE app_id = OLD.app_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER app_installs_sync_count
AFTER INSERT OR DELETE ON ispace.app_installs
FOR EACH ROW EXECUTE FUNCTION ispace.sync_app_install_count();

CREATE OR REPLACE FUNCTION ispace.sync_backend_install_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE ispace.marketplace_listings
       SET install_count = install_count + 1
     WHERE backend_id = NEW.backend_id;
  ELSE
    UPDATE ispace.marketplace_listings
       SET install_count = install_count - 1
     WHERE backend_id = OLD.backend_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER backend_installs_sync_count
AFTER INSERT OR DELETE ON ispace.backend_installs
FOR EACH ROW EXECUTE FUNCTION ispace.sync_backend_install_count();

-- ── 存量漂移一次性校正 ──────────────────────────────────────────────
-- 触发器只管以后的写；上线前已经漂移的数字（1024 活动批量上架的 0 计数、
-- 分享收回后的虚高、离职者的残留）在这里按事实重放一遍。
UPDATE ispace.marketplace_listings m
   SET install_count = (SELECT count(*) FROM ispace.app_installs i
                         WHERE i.app_id = m.app_id)
 WHERE m.app_id IS NOT NULL;

UPDATE ispace.marketplace_listings m
   SET install_count = (SELECT count(*) FROM ispace.backend_installs i
                         WHERE i.backend_id = m.backend_id)
 WHERE m.backend_id IS NOT NULL;
