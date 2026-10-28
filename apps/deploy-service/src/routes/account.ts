import { createAuthProvider } from '@ispace/auth';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE, ERROR_CODES, IspaceError, adminSetPasswordRequestSchema, isReservedPath,
  updateProfileRequestSchema, usernameSchema, type User,
} from '@ispace/contracts';
import {
  createUser, findUserById, getPlatformPolicy, provisionUserSchema, writeAudit, type Sql,
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

/**
 * 头像上限。界面会先把图缩到 256 见方再传（几十 KB），这个数是给绕过界面
 * 直接 POST 的情况兜底的——头像进的是数据库，不设上限就等于让人往库里塞
 * 任意大小的二进制。
 */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * 头像类型白名单。
 *
 * 和 1024 附件同一条理由：这些字节会被浏览器直接渲染，收了 svg 就等于让人
 * 在平台域名下挂一段任意脚本。gif 也不收——头像不需要会动的。
 */
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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

    /*
      用 db 层的 findUserById 而不是本文件再写一遍行映射：它 join 了头像，
      少一处要跟着 users 表一起改的地方。登录这一步刚查过这一行，多一次
      主键查询换掉一份重复代码是划算的。
    */
    const full = (await findUserById(sql, row.id))!;
    const token = await issueSession(full);
    await setSessionCookie(reply, token);
    return { user: full, token };
  });

  // ── 改密码（本人）────────────────────────────────────────────────
  app.post(`${API_BASE}/auth/password`, async (req, reply) => {
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

    /*
      世代号 +1，把这个人之前登录过的所有设备踢下线。

      自己改密码也踢，而不是只在管理员重置时踢：改密码最常见的动机就是
      「怕是被别人看到了」，那时还留着别处的登录，等于改了个寂寞。
    */
    await sql`
      UPDATE ispace.users
         SET password_hash = ${await hashPassword(next)}, token_epoch = token_epoch + 1
       WHERE id = ${me.id}
    `;
    /*
      ……但不包括他正在用的这一台：上面那一句刚把他自己的 cookie 也作废了，
      不补一张新的，他改完密码点任何东西都是 401，看起来像"改密码把账号
      弄坏了"。

      issueSession 内部现读 token_epoch，而递增已经在上一句落库，所以这里
      自然拿到新世代号——别处那些仍然是废的。顺序反过来就不成立了。
    */
    await setSessionCookie(reply, await issueSession(me));

    await writeAudit(sql, {
      actorId: me.id, action: 'user.password_change', targetType: 'user', targetId: me.id,
      source: 'console', result: 'success', ip: req.ip,
    });
    return { ok: true };
  });

  // ── 忘记密码：本人发起申请 ────────────────────────────────────────
  /**
   * 登录页「忘记密码」打到这里。
   *
   * ┌─ 为什么响应与邮箱存不存在无关 ────────────────────────────────┐
   * │ 这是个**不需要登录**的接口。如果邮箱没注册时回「查无此人」，任何 │
   * │ 人都能拿它当探测器，一个个试出公司里谁开了账号——而账号名就是    │
   * │ 邮箱，等于把员工名册漏出去。所以不管有没有这个人，一律同一句话、 │
   * │ 同一个状态码。                                                  │
   * │                                                                │
   * │ 代价是邮箱打错了也只会得到同样的提示，自己察觉不到。这比名册泄露 │
   * │ 划算：打错了顶多等不到管理员联系，再试一次。                    │
   * └────────────────────────────────────────────────────────────────┘
   *
   * 只给 active 的账号建申请：pending 的还没被批准、archived 的已经回收，
   * 给这两种人重置密码没有意义，而且会让管理员那一屏冒出本不该处理的条目。
   */
  app.post(`${API_BASE}/auth/forgot`, async (req) => {
    const { email } = z.object({
      email: z.string().email().max(254),
    }).parse(req.body ?? {});

    const [user] = await sql<{ id: string; username: string }[]>`
      SELECT id, username FROM ispace.users
       WHERE lower(email) = ${email.toLowerCase()} AND status = 'active'
    `;

    if (user) {
      /*
        ON CONFLICT DO NOTHING 配合那条部分唯一索引：人在登不进去的时候
        会反复点，重复点不该在管理员那边堆出一排一模一样的条目。
      */
      await sql`
        INSERT INTO ispace.password_reset_requests (user_id)
        VALUES (${user.id})
        ON CONFLICT (user_id) WHERE handled_at IS NULL DO NOTHING
      `;
      await writeAudit(sql, {
        actorId: user.id, action: 'user.password_reset_request',
        targetType: 'user', targetId: user.id,
        /* source 的枚举里没有 portal；登录页其他动作（改密码）也记 console */
        source: 'console', result: 'success',
        metadata: { username: user.username }, ip: req.ip,
      });
    }

    return {
      ok: true,
      message: '已经记下了。管理员会生成一条设密码链接给你——平台没有邮件服务，'
        + '链接需要他当面或经可信渠道转交，所以请直接联系他。',
    };
  });

  // ── 待处理的重置申请（管理员）────────────────────────────────────
  app.get(`${API_BASE}/admin/password-requests`, async (req) => {
    await requireAdmin(req);
    const rows = await sql<{
      id: string; user_id: string; username: string;
      display_name: string; email: string | null; created_at: Date;
    }[]>`
      SELECT r.id, r.user_id, u.username, u.display_name, u.email, r.created_at
        FROM ispace.password_reset_requests r
        JOIN ispace.users u ON u.id = r.user_id
       WHERE r.handled_at IS NULL
       ORDER BY r.created_at DESC
    `;
    return {
      requests: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        email: r.email,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  // ── 管理员签发重置链接 ────────────────────────────────────────────
  /**
   * 平台没有可用的邮件服务，链接没法自动送到本人手上，所以管理员这一环
   * 去不掉：生成一次性链接，线下交给本人。链接只显示一次，服务端只存哈希。
   *
   * 本人可以从登录页发起申请（POST /auth/forgot），管理员在控制台看到待
   * 处理的那条，点一下就走到这里——省掉的是「找到管理员并把事情说一遍」。
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
    /*
      顺手结掉这个人的待处理申请。

      放在签发这里而不是单给一个「标记已处理」的接口：管理员的动作只有
      一个——发链接。要是结单是另一次点击，就一定会出现「链接发了、申请
      还挂着」，下一个管理员看到会重复发一条，而每发一条都会让前一条失效，
      本人手上那条就莫名其妙地用不了了。

      两条入口（本人申请、管理员主动发）都落到这一句，所以主动发链接也会
      把恰好存在的申请一并结掉，不会留下孤儿。
    */
    await sql`
      UPDATE ispace.password_reset_requests
         SET handled_at = now(), handled_by = ${admin.id}
       WHERE user_id = ${id} AND handled_at IS NULL
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
  /**
   * 管理员直接给别人设一个新密码。
   *
   * ┌─ 和上面「发重置链接」的区别 ──────────────────────────────────────┐
   * │ 发链接：密码只有本人知道，此后这个账号做的事就是这个人做的。      │
   * │ 直接设：管理员也知道，出了事没法说清是谁。                        │
   * │                                                                    │
   * │ 所以这条是应急用的（人就在跟前、马上要用、链接转交太绕），不是    │
   * │ 默认路径。界面上把发链接摆在前面。                                │
   * └────────────────────────────────────────────────────────────────────┘
   *
   * 密码强度按平台设置走同一套校验——管理员设的密码不该比本人自己设的宽松，
   * 否则「平台最低 12 位」这条规则就有了一个官方的绕过口。
   */
  app.post(`${API_BASE}/admin/users/:id/password`, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = req.params as { id: string };
    const { password } = adminSetPasswordRequestSchema.parse(req.body);

    const [target] = await sql<{ username: string; display_name: string }[]>`
      SELECT username, display_name FROM ispace.users
       WHERE id = ${id} AND status <> 'archived'
    `;
    if (!target) throw new IspaceError(ERROR_CODES.NOT_FOUND, '用户不存在或已归档');

    const policy = await getPlatformPolicy(sql);
    const bad = checkPasswordStrength(password, policy.passwordMinLength);
    if (bad) throw new IspaceError(ERROR_CODES.INVALID_INPUT, bad);

    /*
      +1，把这个人所有设备踢下线，不补签。

      管理员走这条路多半就是因为这个账号出了问题，"把当前还连着的都断掉"
      正是要的结果——哪怕其中一台是本人正在用的。
    */
    await sql`
      UPDATE ispace.users
         SET password_hash = ${await hashPassword(password)}, token_epoch = token_epoch + 1
       WHERE id = ${id}
    `;
    /*
      作废这个人手上所有还没用的重置链接。

      不作废的话会出现这样一幕：管理员先发了链接、又改用直接设密码告诉本人，
      本人回头翻到那条链接点开，把密码又改成了别的——然后他用管理员刚给的
      那个登不进去，而管理员确信自己设对了。
    */
    await sql`
      UPDATE ispace.password_resets SET used_at = now()
       WHERE user_id = ${id} AND used_at IS NULL AND expires_at > now()
    `;
    /* 待处理的申请一并结掉，理由同上面发链接那段 */
    await sql`
      UPDATE ispace.password_reset_requests
         SET handled_at = now(), handled_by = ${admin.id}
       WHERE user_id = ${id} AND handled_at IS NULL
    `;

    await writeAudit(sql, {
      actorId: admin.id, action: 'user.password.admin-set', targetType: 'user', targetId: id,
      source: 'console', result: 'success',
      metadata: { username: target.username },
      ip: req.ip,
    });

    return {
      ok: true,
      displayName: target.display_name,
      warning: '新密码只有你和本人知道。请当面告诉他，并让他登录后自己改一次。',
    };
  });

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

    /*
      同样 +1。这条路是在未登录状态下走的（手里只有一条链接），所以不补签：
      改完跳登录页重新登录，而且这正是「账号可能被盗、管理员发链接让我重设」
      的那条路，更要把别处的登录一起断掉。
    */
    await sql`
      UPDATE ispace.users
         SET password_hash = ${await hashPassword(password)}, token_epoch = token_epoch + 1
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
  // ── 个人资料 ────────────────────────────────────────────────────
  /**
   * 改自己的显示名。
   *
   * 能改的只有这一项，为什么见 updateProfileRequestSchema 上那段。
   */
  app.patch(`${API_BASE}/auth/profile`, async (req) => {
    const me = await requireAuth(req);
    const { displayName } = updateProfileRequestSchema.parse(req.body);

    if (displayName === me.displayName) return { user: me };

    await sql`
      UPDATE ispace.users SET display_name = ${displayName} WHERE id = ${me.id}
    `;
    await writeAudit(sql, {
      actorId: me.id, action: 'user.profile.update', targetType: 'user', targetId: me.id,
      source: 'console', result: 'success',
      metadata: { from: me.displayName, to: displayName },
      ip: req.ip,
    });
    return { user: (await findUserById(sql, me.id))! };
  });

  /**
   * 传头像。
   *
   * 字节直接进库（见 0025 迁移里那段），所以这里 toBuffer 而不是落盘。
   * 2 MB 的上限是给「绕过界面直接 POST」兜底的：界面会先在 canvas 里把图
   * 缩到 256 见方再传，正常走下来是几十 KB。
   */
  app.post(`${API_BASE}/auth/avatar`, async (req) => {
    const me = await requireAuth(req);

    const part = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES } });
    if (!part) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '没有收到图片');
    if (!AVATAR_TYPES.has(part.mimetype)) {
      throw new IspaceError(ERROR_CODES.INVALID_INPUT, '头像只能是 PNG、JPG 或 WebP');
    }

    const bytes = await part.toBuffer();
    /*
      multipart 的 fileSize 是「截断」不是「报错」：超限时前面的字节照样
      读得到，truncated 置位。不显式检查的话，用户会得到一张只有上半截的
      头像，而且界面显示上传成功。和 1024 附件那条是同一个坑。
    */
    if (part.file.truncated) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        `图片超过 ${MAX_AVATAR_BYTES / 1024 / 1024} MB 上限`,
      );
    }
    if (bytes.length === 0) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '图片是空的');

    await sql`
      INSERT INTO ispace.user_avatars (user_id, mime, bytes, updated_at)
      VALUES (${me.id}, ${part.mimetype}, ${bytes}, now())
      ON CONFLICT (user_id) DO UPDATE
        SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, updated_at = now()
    `;
    await writeAudit(sql, {
      actorId: me.id, action: 'user.avatar.update', targetType: 'user', targetId: me.id,
      source: 'console', result: 'success',
      metadata: { size: bytes.length, mime: part.mimetype },
      ip: req.ip,
    });
    return { user: (await findUserById(sql, me.id))! };
  });

  /** 撤掉头像，回落到首字母底板。 */
  app.delete(`${API_BASE}/auth/avatar`, async (req) => {
    const me = await requireAuth(req);
    await sql`DELETE FROM ispace.user_avatars WHERE user_id = ${me.id}`;
    await writeAudit(sql, {
      actorId: me.id, action: 'user.avatar.remove', targetType: 'user', targetId: me.id,
      source: 'console', result: 'success', ip: req.ip,
    });
    return { user: (await findUserById(sql, me.id))! };
  });

  /**
   * 读头像。
   *
   * 要登录：头像是同事的脸，不该靠「地址猜不到」保护——平台刚补过一个正是
   * 这样想出来的越权（见 routes/authz.ts）。登录之后彼此可见，因为头像本来
   * 就显示在分享、协作者这些地方。
   *
   * 地址里带内容指纹（?v=md5），所以同一个地址的内容永不改变，可以让浏览器
   * 长期缓存；换了头像就是另一个地址。private 是因为它要登录才拿得到，不能
   * 进共享缓存。
   */
  app.get(`${API_BASE}/users/:username/avatar`, async (req, reply) => {
    await requireAuth(req);
    const { username } = req.params as { username: string };

    const rows = await sql<{ mime: string; bytes: Buffer; etag: string }[]>`
      SELECT a.mime, a.bytes, a.etag
        FROM ispace.user_avatars a JOIN ispace.users u ON u.id = a.user_id
       WHERE u.username = ${username}
    `;
    const row = rows[0];
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这位同事还没传头像');

    const tag = `"${row.etag}"`;
    reply
      .header('etag', tag)
      .header('cache-control', 'private, max-age=31536000, immutable')
      /* 用户上传的字节，不让浏览器自己猜该怎么渲染 */
      .header('x-content-type-options', 'nosniff');
    if (req.headers['if-none-match'] === tag) return reply.code(304).send();
    return reply.type(row.mime).send(row.bytes);
  });

  app.get(`${API_BASE}/auth/feishu-binding`, async (req) => {
    const me = await requireAuth(req);
    const [identity] = await sql`SELECT 1 FROM ispace.external_identities WHERE provider = 'feishu' AND user_id = ${me.id}`;
    return { enabled: createAuthProvider()?.name === 'feishu', bound: Boolean(identity) };
  });

  app.get(`${API_BASE}/auth/policy`, async () => {
    const p = await getPlatformPolicy(sql);
    return {
      emailDomains: p.emailDomains.length ? p.emailDomains : seedDomains(),
      passwordMin: p.passwordMinLength,
      selfRegisterEnabled: p.selfRegisterEnabled,
      requireApproval: p.requireApproval,
      ssoEnabled: Boolean(createAuthProvider()),
      ssoProvider: createAuthProvider()?.name ?? null,
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

