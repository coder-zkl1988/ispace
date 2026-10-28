import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '@ispace/db';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';

export const OAUTH_COOKIE = 'ispace_oauth';
export const OAUTH_TTL = 600;
export const OAUTH_PATH = '/deploy/api/auth';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface LoginContext { redirect: string; pairing?: string; bindUserId?: string }

export async function startLogin(sql: Sql, provider: string, context: LoginContext) {
  const state = randomBytes(32).toString('base64url');
  const browser = randomBytes(32).toString('base64url');
  await sql`DELETE FROM ispace.oauth_states WHERE expires_at < now()`;
  await sql`INSERT INTO ispace.oauth_states (state_hash, browser_hash, provider, context, expires_at)
    VALUES (${hash(state)}, ${hash(browser)}, ${provider}, ${sql.json(context as unknown as Record<string, string>)}, now() + interval '10 minutes')`;
  return { state, browser };
}

export async function consumeLogin(sql: Sql, provider: string, state?: string, browser?: string): Promise<LoginContext> {
  if (!state || !browser || !/^[\w-]{43}$/.test(state) || !/^[\w-]{43}$/.test(browser)) {
    throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '登录请求无效或已过期，请重新发起登录');
  }
  const [row] = await sql<{ context: LoginContext }[]>`
    DELETE FROM ispace.oauth_states WHERE state_hash = ${hash(state)} AND browser_hash = ${hash(browser)}
      AND provider = ${provider} AND expires_at > now() RETURNING context`;
  if (!row) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '登录请求无效或已过期，请重新发起登录');
  return row.context;
}
