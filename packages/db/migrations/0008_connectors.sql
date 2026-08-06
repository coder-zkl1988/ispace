-- 连接器：让页面能安全地调用外部 API。
--
-- 补的是一个平台自己造出来的死结：发布链路会拦下前端代码里的 api_key
-- （scanner 的 generic-password-assignment 规则），这拦得对——AI 生成的代码里
-- 带着公司的 key 发出去就是事故。但平台此前没给替代路径，结果是**凡是需要
-- 凭据的 API 一律做不了**，除非用户自己开一个后端应用写转发，而那正好把
-- 非技术用户挡在门外。
--
-- 连接器把凭据挪到服务端：用户登记一次"这个 API 在哪、凭据是什么"，页面此后
-- 只调 /deploy/api/connect/{slug}/...，凭据由服务端注入。页面代码里没有任何
-- 密钥，顺带也解决了 CORS——对页面来说这是同源请求。
--
-- 与 data-connection 是一对：那条给数据库，这条给外部 API。

CREATE TABLE IF NOT EXISTS ispace.connectors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL = 平台共享连接器（管理员发布，全员可调用）
  -- 非 NULL = 个人连接器
  --
  -- 两级而不是只做个人：公司统一采购的 key（地图、天气）让每个人各填一遍，
  -- 既是重复劳动，也等于把那把 key 散到所有人手上。管理员发布一次，
  -- 普通用户只能调用、看不到凭据本身。
  user_id      uuid REFERENCES ispace.users(id) ON DELETE CASCADE,

  -- 页面里用的名字：/deploy/api/connect/{slug}/...
  -- 取名规则与应用路径一致，避免用户要记两套。
  slug         text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  name         text NOT NULL,

  -- 出站白名单。代理**只**允许打这个前缀下的地址——这是整个功能唯一的真风险
  -- 所在：不限制的话它就是一台内网扫描器，用户可以拿它去打 Dokploy 控制台
  -- 或数据库。校验在写入时和每次请求时各做一遍，见 outbound-guard.ts。
  base_url     text NOT NULL,

  -- 凭据怎么带：none | header | query | bearer
  auth_kind    text NOT NULL DEFAULT 'none'
               CHECK (auth_kind IN ('none', 'header', 'query', 'bearer')),
  -- header 名或 query 参数名。bearer / none 时为 NULL。
  auth_name    text,
  -- AES-256-GCM 密文。**永不回传给任何客户端**，包括创建者本人。
  -- 密钥在服务器 ~/.ispace/env 的 ISPACE_CONNECTOR_KEY，不进库、不进仓库。
  secret_enc   bytea,

  -- 来自内置目录的哪一条。自建为 NULL。留着是为了目录条目升级时能找到用它的人。
  catalog_id   text,

  created_by   uuid REFERENCES ispace.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- 用量：这一条被调用过多少次、最后一次什么时候。
  -- 不做成单独的计数表——这是"看一眼还有没有人在用"的精度，够了。
  call_count   bigint NOT NULL DEFAULT 0,
  last_used_at timestamptz
);

-- slug 唯一性分两种：个人的在人内唯一，共享的在全局唯一。
-- 用两个部分索引而不是一个复合唯一键：NULL 在唯一索引里互不冲突，
-- 那样两个管理员能发布出同名的共享连接器。
CREATE UNIQUE INDEX IF NOT EXISTS connectors_personal_slug_uk
  ON ispace.connectors (user_id, slug) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS connectors_shared_slug_uk
  ON ispace.connectors (slug) WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS connectors_user_idx ON ispace.connectors (user_id);

COMMENT ON TABLE ispace.connectors IS
  '外部 API 连接器：服务端保管凭据并代理出站请求，页面代码里不出现密钥';
COMMENT ON COLUMN ispace.connectors.user_id IS
  'NULL 表示平台共享连接器（管理员发布）；非 NULL 为个人连接器';
COMMENT ON COLUMN ispace.connectors.base_url IS
  '出站白名单前缀。代理拒绝一切超出此前缀的目标，这是 SSRF 的主要防线';
COMMENT ON COLUMN ispace.connectors.secret_enc IS
  'AES-256-GCM 密文，永不回传客户端；密钥见 ISPACE_CONNECTOR_KEY';
