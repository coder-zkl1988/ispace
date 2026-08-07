-- 后端应用「指定同事」可见档的授权记录。
--
-- 页面的 shares 表带接受流程（pending → accepted，接受后进对方空间）；后端不同：
-- 它是一个活服务，「分享」= 直接授予访问，不需要对方点接受，也不进对方的
-- 卡片墙——对方拿到地址就能用。所以这里是一张纯粹的授权表，比 shares 简单。
CREATE TABLE IF NOT EXISTS ispace.backend_shares (
  backend_id  uuid NOT NULL REFERENCES ispace.backends(id) ON DELETE CASCADE,
  to_user_id  uuid NOT NULL REFERENCES ispace.users(id)    ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (backend_id, to_user_id)
);

CREATE INDEX IF NOT EXISTS backend_shares_to_user_idx
  ON ispace.backend_shares (to_user_id);
