import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE, ERROR_CODES, IspaceError, isReservedPath, usernameSchema, type User,
} from '@ispace/contracts';
import {
  createUser, getPlatformPolicy, provisionUserSchema, writeAudit, type Sql,
} from '@ispace/db';
import {
  PASSWORD_FLOOR, PASSWORD_MAX, checkPasswordStrength, hashPassword, verifyPassword,
} from '@ispace/auth';
import { z } from 'zod';

/**
 * 邮箱 + 密码的注册与登录。
 *
 * ┌─ 注册门槛 ─────────────────────────────────────────────────────────┐
 * │ 只放行指定的邮箱后缀（ISPACE_EMAIL_DOMAINS）。                       │
 * │ 注册即开通空间：建目录、建数据 schema、初始化配额——与管理员手工     │
 * │ 开通走同一条链路，不能有两套。                                       │
 * │                                                                     │
 * │ 为什么要限后缀：注册一个账号就等于拿到一个数据 schema 和一份配额。   │
 * │ 完全开放的话，平台一旦被外部访问到就会被开空间。                     │
 * └─────────────────────────────────────────────────────────────────────┘
 */

/**
 * 环境变量里的邮箱后缀，只作为**首次**初始化的种子。
 *
 * 真正生效的是 platform_policy.email_domains（管理员可在控制台改）。
 * 反过来以环境变量为准的话，界面上改完、服务一重启就被打回原样——
 * 那是最让人怀疑人生的一类"设置不生效"。
 *
 * 默认值有意留成 `example.com` 这种谁都匹配不上的占位：忘了配的后果是
 * **谁都注册不了**，而不是**谁都注册得了**。公网上跑着一个开放注册的实例，
 * 等于把数据 schema 和配额发给任何路过的人；而"注册不了"会立刻有人来报，
 * 十秒钟就能改好。两种失败方式的代价不对等，所以往关上的那边倒。
 */
function seedDomains(): string[] {
  return (process.env.ISPACE_EMAIL_DOMAINS ?? 'example.com')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/** 登录失败多少次后锁。 */
const MAX_FAILS = 8;
/** 锁多久。 */
const LOCK_MINUTES = 15;
/** 重置链接有效期。管理员线下转交需要一点时间，但不该长期有效。 */
const RESET_TTL_HOURS = 24;

const emailSchema = z.string().trim().toLowerCase().email('邮箱格式不对').max(160);

/*
  这里用绝对下限 PASSWORD_FLOOR 而不是默认下限。
  真正的门槛来自平台设置（platform_policy.password_min_length），由
  checkPasswordStrength 在处理器里判。

  ⚠️ 写死成 12 曾让「把下限调成 8」这个设置完全失效：zod 在处理器之前
  就把 10 位的密码拒了，报的还是一句 "String must contain at least 12
  character(s)" 的英文，与界面上写着的 8 位自相矛盾。
  凡是能在界面上调的阈值，都不能同时硬编码在请求体校验里。
*/
const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(PASSWORD_FLOOR).max(PASSWORD_MAX),
  displayName: z.string().trim().min(1, '填一下姓名').max(64),
  /** 空间标识。省略则从邮箱本地部分推导。 */
  username: z.string().trim().toLowerCase().optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX),
});

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * 从邮箱本地部分推导空间标识。
 *
 * lixiao@example.com → lixiao；li.xiao → li-xiao；Li_Xiao01 → li-xiao01。
 * 推不出合法标识时返回 null，让用户自己填——不自动加数字后缀：
 * 路径是长期对外的，机器生成的 lixiao2 很难改回来。
 */
export function usernameFromEmail(email: string): string | null {
  const local = email.split('@')[0] ?? '';
  const slug = local
    .toLowerCase()
    .replace(/[._+]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return usernameSchema.safeParse(slug).success ? slug : null;
}

export function registerAccountRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    requireAuth: (req: FastifyRequest) => Promise<User>;
    requireAdmin: (req: FastifyRequest) => Promise<User>;
    issueSession: (u: User) => Promise<string>;
    /**
     * 写会话 cookie。
     *
     * 声明成 Promise 且调用处必须 await：它内部要现读平台设置里的
     * 会话有效期（一次库查询）。如果这里写成同步的 void，调用方就不会
     * await，header 会在处理器 return 之后才设上——响应早已构建完毕，
     * cookie 根本不会下发，表现为"登录成功却还是未登录"。
     */
    setSessionCookie: (
      reply: { header: (k: string, v: string) => unknown },
      token: string,
    ) => Promise<void>;
    publicBase: string;
  },
): void {
  const { sql, requireAuth, requireAdmin, issueSession, setSessionCookie, publicBase } = deps;

  // ── 限流 ──────────────────────────────────────────────────────────
  /** 该主体是否被锁。锁定期内直接拒绝，不去比对密码。 */
  async function isLocked(subject: string): Promise<Date | null> {
    const [row] = await sql<{ locked_until: Date | null }[]>`
      SELECT locked_until FROM ispace.login_attempts WHERE subject = ${subject}
    `;
    if (row?.locked_until && row.locked_until > new Date()) return row.locked_until;
    return null;
  }

  async function recordFail(subject: string): Promise<void> {
    // 一条 UPSERT 完成计数与判锁：分两步的话并发登录会各自读到旧计数，
    // 谁都锁不上。
    await sql`
      INSERT INTO ispace.login_attempts (subject, fail_count, last_fail_at)
      VALUES (${subject}, 1, now())
      ON CONFLICT (subject) DO UPDATE SET
        fail_count = CASE
          -- 距上次失败超过锁定窗口就重新计数，否则一个人一天里零星输错
          -- 几次也会被慢慢累积到锁死
          WHEN ispace.login_attempts.last_fail_at < now() - ${`${LOCK_MINUTES} minutes`}::interval
            THEN 1
          ELSE ispace.login_attempts.fail_count + 1
        END,
        locked_until = CASE
          WHEN ispace.login_attempts.fail_count + 1 >= ${MAX_FAILS}
            THEN now() + ${`${LOCK_MINUTES} minutes`}::interval
          ELSE NULL
        END,
        last_fail_at = now()
    `;
  }

  async function clearFails(subject: string): Promise<void> {
    await sql`DELETE FROM ispace.login_attempts WHERE subject = ${subject}`;
  }

  // ── 注册 ──────────────────────────────────────────────────────────
  app.post(`${API_BASE}/auth/register`, async (req, reply) => {
    const input = registerSchema.parse(req.body ?? {});

    const policy = await getPlatformPolicy(sql);

    // 0. 自助注册开关
    if (!policy.selfRegisterEnabled) {
      throw new IspaceError(
        ERROR_CODES.FORBIDDEN,
        '平台已关闭自助注册，请联系管理员开通账号。',
      );
    }

    // 1. 邮箱域名。策略里留空表示不限后缀。
    const domains = policy.emailDomains.length ? policy.emailDomains : seedDomains();
    const domain = input.email.split('@')[1] ?? '';
    if (domains.length && !domains.includes(domain)) {
      throw new IspaceError(
        ERROR_CODES.FORBIDDEN,
        `只有 ${domains.map((d) => `@${d}`).join('、')} 的邮箱可以注册。用别的邮箱请联系管理员开通。`,
      );
    }

    // 2. 密码强度。下限由平台设置给出。
    const weak = checkPasswordStrength(input.password, policy.passwordMinLength);
    if (weak) throw new IspaceError(ERROR_CODES.INVALID_INPUT, weak);

    // 3. 空间标识
    const candidate = input.username || usernameFromEmail(input.email);
    if (!candidate) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        '没法从这个邮箱推出合法的空间标识，请自己填一个（小写字母、数字与连字符）。',
      );
    }
    const parsed = usernameSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        `空间标识不合法：${parsed.error.issues[0]?.message ?? candidate}`,
      );
    }
    if (isReservedPath(parsed.data)) {
      throw new IspaceError(
        ERROR_CODES.RESERVED_NAME,
        `${parsed.data} 是平台保留路径，换一个空间标识。`,
      );
    }

    // 4. 查重。邮箱与标识分开报，让用户知道该改哪个。
    const [dupEmail] = await sql`SELECT 1 FROM ispace.users WHERE lower(email) = ${input.email}`;
    if (dupEmail) {
      throw new IspaceError(ERROR_CODES.ALREADY_EXISTS, '这个邮箱已经注册过了，直接登录吧。');
    }
    const [dupName] = await sql`SELECT 1 FROM ispace.users WHERE username = ${parsed.data}`;
    if (dupName) {
      throw new IspaceError(
        ERROR_CODES.ALREADY_EXISTS,
        `空间标识 ${parsed.data} 已被占用，换一个。`,
      );
    }

    // 5. 建账号。sso_subject 用 email| 前缀占位——它是 NOT NULL UNIQUE，
    //    且将来这人改用 SSO 登录时，回调里那段「预开通账号绑定」的逻辑
    //    认的是 manual| 前缀，不会误绑到密码账号上。
    const user = await createUser(sql, {
      ssoSubject: `email|${input.email}`,
      username: parsed.data,
      displayName: input.displayName,
      email: input.email,
    });
    await sql`
      UPDATE ispace.users SET password_hash = ${await hashPassword(input.password)}
       WHERE id = ${user.id}
    `;

    /*
      6. 开通空间。

      需要审批时**先不开**：开 schema、建角色、改 PostgREST 的暴露列表
      都是有副作用的动作，给一个还没被批准的人做完，管理员一旦拒绝
      就要反向清理一遍（而那个顺序错了会让全平台的数据接口挂掉）。
      落在 pending，等管理员在「员工与开通」里通过时再走同一条链路。
    */
    if (policy.requireApproval) {
      await sql`UPDATE ispace.users SET status = 'pending' WHERE id = ${user.id}`;
      await writeAudit(sql, {
        actorId: user.id, action: 'user.provision', targetType: 'user', targetId: user.id,
        source: 'console', result: 'success',
        metadata: { username: user.username, selfRegistered: true, pendingApproval: true },
        ip: req.ip,
      });
      // 不签发会话：还没开通，登进来也没有空间可看
      return {
        user: { ...user, status: 'pending' as const },
        pendingApproval: true,
        message: '已提交，等管理员开通后就能登录。',
      };
    }

    await provisionUserSchema(sql, user.username);

    await writeAudit(sql, {
      actorId: user.id, action: 'user.provision', targetType: 'user', targetId: user.id,
      source: 'console', result: 'success',
      metadata: { username: user.username, selfRegistered: true },
      ip: req.ip,
    });

    const token = await issueSession(user);
    await setSessionCookie(reply, token);
    return { user, token, spaceUrl: `${publicBase}/${user.username}` };
  });

  // ── 登录 ──────────────────────────────────────────────────────────
  app.post(`${API_BASE}/auth/login`, async (req, reply) => {
    const input = loginSchema.parse(req.body ?? {});
    const byEmail = `email:${input.email}`;
    const byIp = `ip:${req.ip}`;

    for (const subject of [byEmail, byIp]) {
      const until = await isLocked(subject);
      if (until) {
        const mins = Math.ceil((until.getTime() - Date.now()) / 60_000);
        throw new IspaceError(
          ERROR_CODES.FORBIDDEN,
          `尝试次数过多，请 ${mins} 分钟后再试。`,
        );
      }
    }

    const [row] = await sql<{ id: string; password_hash: string | null; status: string }[]>`
      SELECT id, password_hash, status FROM ispace.users WHERE lower(email) = ${input.email}
    `;

    /**
     * 账号不存在时也要走一次哈希再返回失败。
     *
     * 否则「不存在」几毫秒返回、「密码错」要 100 多毫秒，攻击者据此就能
     * 枚举出哪些邮箱注册过——这在内部平台上等于泄露员工名册。
     */
    const ok = row?.password_hash
      ? await verifyPassword(input.password, row.password_hash)
      : await verifyPassword(input.password, DUMMY_HASH);

    if (!ok || !row) {
      await Promise.all([recordFail(byEmail), recordFail(byIp)]);
      throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '邮箱或密码不对');
    }
    if (row.status !== 'active') {
      throw new IspaceError(
        ERROR_CODES.UNAUTHENTICATED,
        row.status === 'pending' ? '账号还在等管理员开通' : '账号已归档，联系管理员',
      );
    }

    await Promise.all([clearFails(byEmail), clearFails(byIp)]);

    const full = await toUser(sql, row.id);
    const token = await issueSession(full);
    await setSessionCookie(reply, token);
    return { user: full, token };
  });

  // ── 改密码（本人）────────────────────────────────────────────────
  app.post(`${API_BASE}/auth/password`, async (req) => {
    const me = await requireAuth(req);
    const { current, next } = z.object({
      current: z.string().min(1),
      next: z.string().min(PASSWORD_FLOOR).max(PASSWORD_MAX),
    }).parse(req.body ?? {});

    const [row] = await sql<{ password_hash: string | null }[]>`
      SELECT password_hash FROM ispace.users WHERE id = ${me.id}
    `;
    if (!row?.password_hash) {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, '这个账号还没有设置密码');
    }
    if (!(await verifyPassword(current, row.password_hash))) {
      throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '当前密码不对');
    }
    const { passwordMinLength } = await getPlatformPolicy(sql);
    const weak = checkPasswordStrength(next, passwordMinLength);
    if (weak) throw new IspaceError(ERROR_CODES.INVALID_INPUT, weak);

    await sql`
      UPDATE ispace.users SET password_hash = ${await hashPassword(next)} WHERE id = ${me.id}
    `;
    await writeAudit(sql, {
      actorId: me.id, action: 'user.password_change', targetType: 'user', targetId: me.id,
      source: 'console', result: 'success', ip: req.ip,
    });
    return { ok: true };
  });

  // ── 管理员签发重置链接 ────────────────────────────────────────────
  /**
   * 平台没有可用的邮件服务，所以不做自助重置：管理员生成一次性链接，
   * 线下交给本人。链接只显示一次，服务端只存哈希。
   */
  app.post(`${API_BASE}/admin/users/:id/reset-password`, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };

    const [target] = await sql<{ username: string }[]>`
      SELECT username FROM ispace.users WHERE id = ${id}
    `;
    if (!target) throw new IspaceError(ERROR_CODES.NOT_FOUND, '用户不存在');

    const plain = randomBytes(32).toString('base64url');
    await sql`
      INSERT INTO ispace.password_resets (user_id, token_hash, issued_by, expires_at)
      VALUES (${id}, ${hashToken(plain)}, ${admin.id},
              now() + ${`${RESET_TTL_HOURS} hours`}::interval)
    `;
    await writeAudit(sql, {
      actorId: admin.id, action: 'user.password_reset', targetType: 'user', targetId: id,
      source: 'console', result: 'success',
      metadata: { username: target.username }, ip: req.ip,
    });
    return {
      url: `${publicBase}/reset?token=${plain}`,
      expiresInHours: RESET_TTL_HOURS,
      warning: '这个链接只显示这一次，请立刻复制并当面或经可信渠道交给本人。',
    };
  });

  // ── 用重置链接设新密码 ────────────────────────────────────────────
  app.post(`${API_BASE}/auth/reset`, async (req) => {
    const { token, password } = z.object({
      token: z.string().min(1),
      password: z.string().min(PASSWORD_FLOOR).max(PASSWORD_MAX),
    }).parse(req.body ?? {});

    const { passwordMinLength } = await getPlatformPolicy(sql);
    const weak = checkPasswordStrength(password, passwordMinLength);
    if (weak) throw new IspaceError(ERROR_CODES.INVALID_INPUT, weak);

    // 取走即标记已用，同一条 UPDATE 完成——分两步的话并发请求能用同一个
    // 令牌改两次密码。
    const [row] = await sql<{ user_id: string }[]>`
      UPDATE ispace.password_resets SET used_at = now()
       WHERE token_hash = ${hashToken(token)}
         AND used_at IS NULL AND expires_at > now()
      RETURNING user_id
    `;
    if (!row) {
      throw new IspaceError(
        ERROR_CODES.UNAUTHENTICATED,
        '重置链接无效、已用过或已过期。请联系管理员重新生成。',
      );
    }

    await sql`
      UPDATE ispace.users SET password_hash = ${await hashPassword(password)}
       WHERE id = ${row.user_id}
    `;
    // 重置成功即解锁：本人刚证明了自己的身份，没理由继续把他挡在门外
    await sql`DELETE FROM ispace.login_attempts
               WHERE subject = (SELECT 'email:' || lower(email) FROM ispace.users WHERE id = ${row.user_id})`;
    await writeAudit(sql, {
      actorId: row.user_id, action: 'user.password_reset', targetType: 'user',
      targetId: row.user_id, source: 'console', result: 'success',
      metadata: { viaResetLink: true }, ip: req.ip,
    });
    return { ok: true };
  });

  /** 注册页要用：告诉前端哪些邮箱后缀可注册、密码要多长。 */
  app.get(`${API_BASE}/auth/policy`, async () => {
    const p = await getPlatformPolicy(sql);
    return {
      emailDomains: p.emailDomains.length ? p.emailDomains : seedDomains(),
      passwordMin: p.passwordMinLength,
      selfRegisterEnabled: p.selfRegisterEnabled,
      requireApproval: p.requireApproval,
      ssoEnabled: Boolean(process.env.OIDC_ISSUER),
    };
  });
}

/**
 * 用于「账号不存在」时也走一次哈希的固定串。
 *
 * 内容无所谓，只要格式合法、参数与真实哈希一致，好让耗时对得上。
 */
const DUMMY_HASH =
  'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** 取完整用户行。登录成功后签发会话要用到 role/identity。 */
async function toUser(sql: Sql, id: string): Promise<User> {
  const [r] = await sql<Record<string, unknown>[]>`SELECT * FROM ispace.users WHERE id = ${id}`;
  return {
    id: r!.id as string,
    ssoSubject: r!.sso_subject as string,
    username: r!.username as string,
    displayName: r!.display_name as string,
    email: r!.email as string | null,
    role: r!.role as 'employee' | 'admin',
    identity: r!.identity as 'user' | 'developer',
    status: r!.status as 'pending' | 'active' | 'archived',
    createdAt: r!.created_at as Date,
    archivedAt: r!.archived_at as Date | null,
  };
}
