-- 个人访问令牌。
--
-- 存在的理由：MCP 客户端（Claude Code 等）通过 HTTP 头携带凭据，没有
-- 浏览器会话。原先只能让用户从 cookie 里抠 session token——那既难操作，
-- 又因为会话 12 小时过期而需要反复重做。同事根本用不起来。
--
-- 令牌只存哈希，不存明文：库被读走时无法据此冒充用户。明文只在创建时
-- 返回一次，之后再也拿不到——这也是为什么创建响应必须提示用户当场保存。
CREATE TABLE IF NOT EXISTS ispace.access_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- sha256(明文)，hex。查询时对传入令牌做同样哈希再比对。
  token_hash  text NOT NULL UNIQUE,
  -- 前 8 位明文前缀，仅用于在列表里辨认是哪一个，不足以还原令牌
  token_prefix text NOT NULL,
  last_used_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS access_tokens_user_idx ON ispace.access_tokens (user_id)
  WHERE revoked_at IS NULL;
