import type { FastifyRequest } from 'fastify';
import { COOKIE_NAME, type SessionClaims } from '@ispace/auth';
import type { Sql } from '@ispace/db';

/** Resource routes must not use account state embedded in an older JWT. */
export async function readResourceSession(
  req: FastifyRequest,
  sql: Sql,
  verifySession: (token: string) => Promise<SessionClaims | null>,
): Promise<SessionClaims | null> {
  const auth = req.headers.authorization;
  const token = req.cookies?.[COOKIE_NAME]
    ?? (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
  if (!token) return null;
  const claims = await verifySession(token).catch(() => null);
  if (!claims) return null;
  const [user] = await sql<{
    id: string; username: string; role: SessionClaims['role'];
    identity: SessionClaims['identity']; status: string; token_epoch: number;
  }[]>`
    SELECT id, username, role, identity, status, token_epoch FROM ispace.users WHERE id = ${claims.uid}
  `;
  if (!user || user.status !== 'active' || Number(user.token_epoch ?? 0) !== (claims.epoch ?? 0)) return null;
  return { ...claims, uid: user.id, username: user.username, role: user.role, identity: user.identity };
}
