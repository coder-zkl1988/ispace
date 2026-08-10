-- 创意市场接入后端应用。
--
-- 此前「分享全公司」对后端只改了 backends.visibility 这一列——鉴权代理认它，
-- 但 marketplace_listings.app_id 建表时是 NOT NULL UNIQUE REFERENCES apps(id)，
-- 结构上就不可能指向一个后端，于是后端设成全公司也不会出现在创意市场，
-- 分享弹窗却仍然说"选全公司会同时上架"（ui 包 share.tsx 两种卡片共用同一句
-- 文案）。这里让 marketplace_listings 能二选一指向 apps 或 backends：
-- app_id 松绑为可空，backend_id 新增且同样可空，CHECK 保证有且只有一个非空。
-- 不新建一张 backend_marketplace_listings 表——市场列表要按发布时间/安装数
-- 把两种内容混排，分两张表还得在查询里 UNION 再排序，不如一张表两个可空外键。

-- 与 apps.category（迁移 0013）同一个理由：分类是"这东西是什么"，
-- 是后端自己的属性，不是"在市场里怎么摆"，所以放 backends 不放 listings。
ALTER TABLE ispace.backends ADD COLUMN IF NOT EXISTS category text;

ALTER TABLE ispace.marketplace_listings
  ALTER COLUMN app_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS backend_id uuid UNIQUE REFERENCES ispace.backends(id) ON DELETE CASCADE;

ALTER TABLE ispace.marketplace_listings
  DROP CONSTRAINT IF EXISTS marketplace_listings_one_target,
  ADD CONSTRAINT marketplace_listings_one_target
    CHECK ((app_id IS NOT NULL) <> (backend_id IS NOT NULL));

-- 后端的"添加到我的"引用记录，与 app_installs 同构，但没有 source 列：
-- 后端目前只有市场这一条能落引用的路径——"指定同事"走 backend_shares 直接
-- 授权访问，不建引用（分享弹窗那条注释："不需要对方接受、不进对方空间"），
-- 所以不像 app_installs 那样需要区分 share/marketplace 两种来源。
CREATE TABLE IF NOT EXISTS ispace.backend_installs (
  backend_id  uuid NOT NULL REFERENCES ispace.backends(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES ispace.users(id)    ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (backend_id, user_id)
);
