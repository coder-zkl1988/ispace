import { z } from 'zod';

/**
 * 平台保留的顶层路径，用户名不得与之冲突。
 *
 * 规格 D6 决定用户空间路径为 `/{user}/{app}/`（无 `@` 前缀，依设计稿），
 * 代价是用户名与平台路径落入同一命名空间。这份表是唯一的对冲手段。
 *
 * ⚠️ 三处必须同步，改动其一必须同步其余：
 *   1. 本常量（注册与改名时强校验）
 *   2. `infra/caddy/Caddyfile` 的 `not path_regexp` 排除列表
 *   3. `packages/contracts/src/__tests__/reserved.test.ts` 的一致性断言
 *
 * 新增任何平台顶层路径，必须先加入本表——否则若已有同名用户，该路径永远
 * 无法启用，且用户目录会被网关静默当作平台路由处理。
 */
export const RESERVED_PATHS = [
  '_',
  'admin',
  'api',
  'assets',
  'console',
  'deploy',
  'dist',
  'health',
  'login',
  'logout',
  'platform',
  'reset',
  'static',
  'supabase',
  'svc',
  'updates',
] as const;

export type ReservedPath = (typeof RESERVED_PATHS)[number];

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_PATHS);

export function isReservedPath(segment: string): boolean {
  return RESERVED_SET.has(segment.toLowerCase());
}

/**
 * 用户名与应用名的字符规则。
 *
 * 与两处保持一致：`infra/caddy/Caddyfile` 的路径正则
 * `^/([a-z0-9][a-z0-9-]{0,30})/([a-z0-9][a-z0-9-]{0,30})(/.*)?$`，
 * 以及 `infra/scripts/05-provision-user-schema.sh` 的用户名校验。
 *
 * 首字符限定字母：schema 名由 `u_{username}` 派生，Postgres 标识符不宜以数字开头。
 * 不允许尾部连字符与连续连字符：避免 `a--b` 这类在 URL 中易混淆的形式。
 */
const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SLUG_MAX = 31;

export const usernameSchema = z
  .string()
  .min(2, '用户标识至少 2 个字符')
  .max(SLUG_MAX, `用户标识最多 ${SLUG_MAX} 个字符`)
  .regex(SLUG_RE, '只能用小写字母、数字与单个连字符，且以字母开头、不以连字符结尾')
  .refine((v) => !isReservedPath(v), {
    message: '该标识为平台保留路径，请换一个',
  });

export const appSlugSchema = z
  .string()
  .min(2, '应用路径至少 2 个字符')
  .max(SLUG_MAX, `应用路径最多 ${SLUG_MAX} 个字符`)
  .regex(SLUG_RE, '只能用小写字母、数字与单个连字符，且以字母开头、不以连字符结尾');

/** 由用户名推导其 Postgres schema 名。连字符转下划线——标识符中连字符需加引号，徒增复杂度。 */
export function schemaNameFor(username: string): string {
  return `u_${username.replace(/-/g, '_')}`;
}

/** 用户空间的公开访问路径。 */
export function userSpacePath(username: string): string {
  return `/${username}/`;
}

/** 单个应用的公开访问路径。 */
export function appPath(username: string, slug: string): string {
  return `/${username}/${slug}/`;
}
