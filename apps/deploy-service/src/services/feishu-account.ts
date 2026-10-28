import { createHash } from 'node:crypto';
import { createUser, findUserForAuth, findUserBySso, findUserByUsername, provisionUserSchema, writeAudit, type Sql } from '@ispace/db';
import { ERROR_CODES, IspaceError, isReservedPath, usernameSchema } from '@ispace/contracts';
import type { IdentityClaims } from '@ispace/auth';

export function feishuUsername(claims: IdentityClaims): string {
  const base = claims.preferredUsername?.toLowerCase() ?? '';
  const safe = usernameSchema.safeParse(base).success && !isReservedPath(base) ? base : 'employee';
  return `${safe.slice(0, 17).replace(/-+$/, '')}-${createHash('sha256').update(claims.sub).digest('hex').slice(0, 12)}`;
}

/** Serialize account + schema creation, so a failed provisioning rolls back with the user. */
export async function resolveFeishuAccount(sql: Sql, claims: IdentityClaims, bindUserId?: string) {
  return sql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    // Provisioning changes a shared PostgREST schema list; serialize Feishu signups.
    await tx`SELECT pg_advisory_xact_lock(724391036)`;
    const [identity] = await tx<{ user_id: string }[]>`
      SELECT user_id FROM ispace.external_identities WHERE provider = 'feishu' AND subject = ${claims.sub}`;
    if (identity && bindUserId && identity.user_id !== bindUserId) {
      throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, '这个飞书身份已绑定其他账号');
    }
    let user = identity ? (await findUserForAuth(tx, identity.user_id))?.user : undefined;
    if (identity && !user) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '账号不可用');
    if (!user && bindUserId) {
      user = (await findUserForAuth(tx, bindUserId))?.user;
      if (!user || user.status !== 'active') throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录要绑定的有效账号');
      const [bound] = await tx`SELECT 1 FROM ispace.external_identities WHERE provider = 'feishu' AND user_id = ${user.id}`;
      if (bound) throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, '这个账号已绑定其他飞书身份');
    }
    if (!user) user = (await findUserBySso(tx, claims.sub)) ?? undefined;
    if (!user && !bindUserId && claims.preferredUsername) {
      const manual = await findUserByUsername(tx, claims.preferredUsername);
      if (manual?.status === 'active' && manual.ssoSubject === `manual|${manual.username}`) {
        user = manual;
        await tx`
          UPDATE ispace.users SET sso_subject = ${claims.sub} WHERE id = ${manual.id}
        `;
      }
    }
    if (!user) {
      // Password registration does not verify mailbox ownership. Never merge by email alone.
      if (claims.email) {
        const [old] = await tx`SELECT 1 FROM ispace.users WHERE lower(email) = ${claims.email.toLowerCase()}`;
        if (old) throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, '该邮箱已有账号，请先用原账号登录，再在个人资料中绑定飞书');
      }
      const username = feishuUsername(claims);
      if (await findUserByUsername(tx, username)) throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, '空间标识冲突，请联系管理员');
      user = await createUser(tx, { ssoSubject: claims.sub, username, displayName: claims.name,
        email: claims.email ?? null, role: 'employee', identity: 'user' });
      await provisionUserSchema(tx, username);
      await writeAudit(tx, { actorId: user.id, action: 'user.provision', targetType: 'user', targetId: user.id,
        source: 'console', result: 'success', metadata: { provider: 'feishu', username } });
    }
    if (user.status !== 'active') throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '账号不可用，请联系管理员');
    if (!identity) {
      await tx`INSERT INTO ispace.external_identities (provider, subject, user_id) VALUES ('feishu', ${claims.sub}, ${user.id})`;
    }
    return user;
  });
}
