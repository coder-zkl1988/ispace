-- 邮箱 + 密码登录。
--
-- 原设计是 OIDC/SSO（规格 D4），沿用至今一直跑在开发登录上。改为邮箱密码
-- 自助注册后，SSO 抽象层保留——两者并存，配了 OIDC_* 就多一个登录入口，
-- 没配就只有密码。不删 sso_subject：已有账号靠它绑定，删了这些人就登不进来。

-- ── 1. 密码与邮箱 ────────────────────────────────────────────────────
-- 存 scrypt 哈希，格式 scrypt$N$r$p$salt$hash（见 packages/auth/src/password.ts）。
-- 可空：SSO 登录的账号没有密码，管理员预开通但还没注册的账号也没有。
ALTER TABLE ispace.users ADD COLUMN IF NOT EXISTS password_hash text;

-- 邮箱原先可空且不唯一（SSO 下它只是展示信息）。改为登录凭据后必须唯一。
-- 用函数索引做大小写不敏感的唯一：Foo@x.com 与 foo@x.com 是同一个人，
-- 不加这条会让同一个人注册出两个空间，而且后注册的那个永远登不进先注册的。
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON ispace.users (lower(email)) WHERE email IS NOT NULL;

-- ── 2. 密码重置 ──────────────────────────────────────────────────────
-- 平台没有可用的邮件服务，所以不做自助重置：由管理员生成一次性链接，
-- 线下交给本人。这张表存那些一次性令牌。
--
-- 只存哈希不存明文，与访问令牌同一个理由：库被读走时无法据此改别人的密码。
CREATE TABLE IF NOT EXISTS ispace.password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES ispace.users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  -- 谁签发的。管理员给别人重置属于敏感操作，要能追溯。
  issued_by   uuid NOT NULL REFERENCES ispace.users(id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx
  ON ispace.password_resets (user_id, created_at DESC);

-- ── 3. 登录失败限流 ──────────────────────────────────────────────────
-- 密码登录必须限流，否则一个脚本就能把弱口令跑穿。放在库里而不是内存里：
-- 内存版重启即清零，攻击者只要让服务重启（或等一次部署）就能重来。
--
-- 按「邮箱 + 来源 IP」两个维度分别记：只按 IP 会让同一出口 NAT 后的整层楼
-- 互相拖累；只按邮箱则换个邮箱就能继续撞库。
CREATE TABLE IF NOT EXISTS ispace.login_attempts (
  -- 被限流的主体：'email:foo@x.com' 或 'ip:10.1.2.3'
  subject      text PRIMARY KEY,
  fail_count   int NOT NULL DEFAULT 0,
  -- 锁到什么时候。为空表示没锁。
  locked_until timestamptz,
  last_fail_at timestamptz NOT NULL DEFAULT now()
);

-- ── 4. 待激活状态复用 ────────────────────────────────────────────────
-- 0003 已把 'pending' 加进 users_status_check。注册策略若设为
-- 「需管理员批准」，新账号即落在 pending，由管理员在「员工与开通」通过。
-- 当前策略是「限公司邮箱后缀」，注册即 active，pending 留给后续切换。
