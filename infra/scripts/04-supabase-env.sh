#!/usr/bin/env bash
# 生成 Supabase 的 .env。密钥在目标机上就地生成，不经过本仓库、不进 git。
# 幂等：.env 已存在则跳过（避免重生成密钥导致既有数据无法解密）。
#
# 关键配置说明：
#
# 1. 子路径部署。Kong 自身不感知 /supabase 前缀，由 Traefik 的 stripPrefix 中间件
#    在转发前剥掉（见 supabase.compose.override.yml）。因此对外 URL 带 /supabase，
#    而 Kong 内部仍按 /rest/v1、/auth/v1 匹配。
#
# 2. PGRST_DB_SCHEMAS 只作为初始值。多租户按需追加 schema 时不改这个环境变量
#    （改了要重启，会打断存量用户），而是改数据库内配置：
#      ALTER ROLE authenticator SET pgrst.db_schemas = 'public,graphql_public,u_a,u_b';
#      NOTIFY pgrst, 'reload config';
#    该路径是否可行由 05-verify-supabase.sh 实测确认。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${ISPACE_BASE_URL:?需要设置 ISPACE_BASE_URL，形如 https://ispace.example.com}"
PUBLIC_URL="${PUBLIC_URL:-$BASE_URL/supabase}"
# GoTrue 发确认信与找回密码信时的发件人，同时用作 certbot 的注册邮箱。
ADMIN_EMAIL="${ISPACE_ADMIN_EMAIL:?需要设置 ISPACE_ADMIN_EMAIL，形如 admin@example.com}"

"$SCRIPT_DIR/remote.sh" \
  "PUBLIC_URL='$PUBLIC_URL' SITE_URL='$BASE_URL' ADMIN_EMAIL='$ADMIN_EMAIL' bash -s" <<'REMOTE'
set -eu
cd ~/ispace-deploy/supabase

if [ -f .env ]; then
  echo "== .env 已存在，跳过生成 =="
  echo "   如需重建：先 docker compose down -v 清空数据，再删除 .env"
  exit 0
fi

echo "== 生成密钥与 JWT =="
node > .env <<'NODE'
const crypto = require('crypto');

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const rand = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);

// HS256 JWT，Supabase 的 anon / service_role 密钥即为此形式
const signJwt = (payload, secret) => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
};

const jwtSecret = rand(48);
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 60 * 60 * 24 * 365 * 10; // 10 年

const anonKey = signJwt({ role: 'anon', iss: 'supabase', iat, exp }, jwtSecret);
const serviceKey = signJwt({ role: 'service_role', iss: 'supabase', iat, exp }, jwtSecret);

const publicUrl = process.env.PUBLIC_URL;
const siteUrl = process.env.SITE_URL;
const adminEmail = process.env.ADMIN_EMAIL;
// PROXY_DOMAIN 要的是裸主机名（不带协议、不带端口以外的东西）
const proxyDomain = new URL(siteUrl).host;

const env = {
  POSTGRES_PASSWORD: rand(32),
  JWT_SECRET: jwtSecret,
  ANON_KEY: anonKey,
  SERVICE_ROLE_KEY: serviceKey,
  SUPABASE_PUBLISHABLE_KEY: '',
  SUPABASE_SECRET_KEY: '',
  JWT_KEYS: '',
  JWT_JWKS: '',

  DASHBOARD_USERNAME: 'ispace',
  DASHBOARD_PASSWORD: rand(24),

  SECRET_KEY_BASE: rand(64),
  REALTIME_DB_ENC_KEY: rand(16),
  VAULT_ENC_KEY: rand(32),
  PG_META_CRYPTO_KEY: rand(32),

  LOGFLARE_PUBLIC_ACCESS_TOKEN: rand(32),
  LOGFLARE_PRIVATE_ACCESS_TOKEN: rand(32),
  S3_PROTOCOL_ACCESS_KEY_ID: rand(32),
  S3_PROTOCOL_ACCESS_KEY_SECRET: rand(64),

  // 对外均带 /supabase 前缀；Kong 内部由 Traefik stripPrefix 后按原路由匹配
  SUPABASE_PUBLIC_URL: publicUrl,
  API_EXTERNAL_URL: `${publicUrl}/auth/v1`,
  SITE_URL: siteUrl,
  ADDITIONAL_REDIRECT_URLS: '',

  POSTGRES_HOST: 'db',
  POSTGRES_DB: 'postgres',
  POSTGRES_PORT: '5432',

  POOLER_PROXY_PORT_TRANSACTION: '6543',
  POOLER_DEFAULT_POOL_SIZE: '20',
  POOLER_MAX_CLIENT_CONN: '100',
  POOLER_TENANT_ID: 'ispace',
  POOLER_DB_POOL_SIZE: '5',

  STUDIO_DEFAULT_ORGANIZATION: 'ispace',
  STUDIO_DEFAULT_PROJECT: 'ispace',
  OPENAI_API_KEY: '',

  JWT_EXPIRY: '3600',
  DISABLE_SIGNUP: 'false',
  MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify',
  MAILER_URLPATHS_INVITE: '/auth/v1/verify',
  MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
  MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify',
  ENABLE_EMAIL_SIGNUP: 'true',
  ENABLE_EMAIL_AUTOCONFIRM: 'true',
  SMTP_ADMIN_EMAIL: adminEmail,
  SMTP_HOST: 'supabase-mail',
  SMTP_PORT: '2500',
  SMTP_USER: 'fake_mail_user',
  SMTP_PASS: 'fake_mail_password',
  SMTP_SENDER_NAME: 'ispace',
  ENABLE_ANONYMOUS_USERS: 'false',
  ENABLE_PHONE_SIGNUP: 'false',
  ENABLE_PHONE_AUTOCONFIRM: 'false',

  GLOBAL_S3_BUCKET: 'stub',
  REGION: 'stub',
  MINIO_ROOT_USER: 'supa-storage',
  MINIO_ROOT_PASSWORD: rand(24),
  STORAGE_TENANT_ID: 'stub',
  FUNCTIONS_VERIFY_JWT: 'false',

  // 初始值；新增用户 schema 走数据库内配置 + NOTIFY，不动此变量
  PGRST_DB_SCHEMAS: 'public,graphql_public',
  PGRST_DB_MAX_ROWS: '1000',
  PGRST_DB_EXTRA_SEARCH_PATH: 'public',

  DOCKER_SOCKET_LOCATION: '/var/run/docker.sock',
  GOOGLE_PROJECT_ID: '',
  GOOGLE_PROJECT_NUMBER: '',

  KONG_HTTP_PORT: '8000',
  KONG_HTTPS_PORT: '8443',
  ANON_KEY_ASYMMETRIC: '',
  SERVICE_ROLE_KEY_ASYMMETRIC: '',
  IMGPROXY_AUTO_WEBP: 'true',
  PROXY_DOMAIN: proxyDomain,
  CERTBOT_EMAIL: adminEmail,
};

console.log(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'));
NODE

chmod 600 .env
echo "   已生成 $(wc -l < .env) 行"

# 关键值另存一份便于后续脚本读取，同样 600
{
  grep '^ANON_KEY=' .env
  grep '^SERVICE_ROLE_KEY=' .env
  grep '^POSTGRES_PASSWORD=' .env
  grep '^DASHBOARD_USERNAME=' .env
  grep '^DASHBOARD_PASSWORD=' .env
} > ~/.ispace/supabase.env
chmod 600 ~/.ispace/supabase.env

echo "== 校验 =="
echo "   .env 权限: $(stat -c '%a' .env)"
echo "   ANON_KEY 段数: $(grep '^ANON_KEY=' .env | cut -d= -f2 | tr '.' '\n' | wc -l)  (JWT 应为 3)"
echo "   凭据副本: ~/.ispace/supabase.env ($(stat -c '%a' ~/.ispace/supabase.env))"
REMOTE
