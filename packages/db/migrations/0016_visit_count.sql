-- 创意市场卡片的访问量。
--
-- 与 install_count（装的人数，去重、有上限）不同，这是原始的到访计数——
-- 同一个人看十次算十次，不去重、不区分身份，就是个朴素的计数器，与
-- apps.last_accessed_at（至今没有任何代码写过、纯粹的死字段）不是一回事，
-- 这里不顺手把那个也接上：它牵着空闲归档判断（idle-archive 用它决定
-- 多久没人碰就该提醒/回收），接错了会悄悄改掉归档节奏，值得单独一次改动。
--
-- 用 bigint 而不是 int：install_count 有意义的上限是"公司总人数"，
-- visit_count 没有这个天花板，同一个页面被同一批人反复打开是常态。
ALTER TABLE ispace.apps     ADD COLUMN IF NOT EXISTS visit_count bigint NOT NULL DEFAULT 0;
ALTER TABLE ispace.backends ADD COLUMN IF NOT EXISTS visit_count bigint NOT NULL DEFAULT 0;
