import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Sql } from '@ispace/db';
import { ERROR_CODES, IspaceError, type EventAdminIdea, type User } from '@ispace/contracts';
import { registerEventRoutes } from '../routes/events.js';

/**
 * 赛事接口的集成测试：**对着真的 Postgres 跑**。
 *
 * 为什么非要一个真库：这条链路上几乎所有容易出错的东西都在 SQL 里——
 * 六张表的 DDL、两处 ON CONFLICT DO UPDATE、带 FILTER 的聚合、
 * ON DELETE SET NULL 与 CHECK 约束的相互作用。这些在假 sql 下
 * 一个都验证不到：假 sql 只会把你写错的语句原样咽下去。
 *
 * 没配库时整个文件跳过，`pnpm test` 照常绿。要跑它：
 *
 *   docker run -d --name pg -e POSTGRES_PASSWORD=pgtest -p 55432:5432 postgres:16-alpine
 *   ISPACE_TEST_PG='postgres://postgres:pgtest@127.0.0.1:55432/postgres' pnpm --filter @ispace/deploy-service test
 *
 * ⚠️ 它会 DROP SCHEMA ispace CASCADE。只指向一次性的测试库，别指生产。
 */

const DSN = process.env.ISPACE_TEST_PG;
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, '../../../../packages/db/migrations');

/** `postgres://user:pass@host:port/db` → createDb 的入参。 */
function parseDsn(dsn: string) {
  const u = new URL(dsn);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    max: 4,
  };
}

const SLUG = '1024-2026';

/** 把测试里的「我是谁」塞进请求头，省掉整套会话。鉴权本身另有测试覆盖。 */
const AS = (username: string) => ({ 'x-test-user': username });

describe.skipIf(!DSN)('赛事接口（真实 Postgres）', () => {
  let sql: Sql;
  let app: ReturnType<typeof Fastify>;
  const users = new Map<string, User>();

  const findUser = (req: FastifyRequest): User | null => {
    const name = req.headers['x-test-user'] as string | undefined;
    return name ? users.get(name) ?? null : null;
  };

  beforeAll(async () => {
    // 用服务自己的 createDb，而不是直接 new 一个 postgres——连接参数
    // （search_path 等）要和生产跑的是同一套，否则验的不是同一个东西
    sql = createDb(parseDsn(DSN!));

    // 每次从零开始：迁移是单向的，复用上一轮的残留会让失败变得难解释
    await sql.unsafe('DROP SCHEMA IF EXISTS ispace CASCADE');
    const ran = await runMigrations(sql, MIGRATIONS);
    // 迁移跑过了才有意义往下走
    expect(ran).toContain('0017_event_1024.sql');
    expect(ran).toContain('0018_event_1024_seed.sql');

    // 造人：一个管理员、三个参赛者、两个评委
    for (const [username, role] of [
      ['admin', 'admin'], ['lixiao', 'employee'], ['wutong', 'employee'],
      ['zhoumu', 'employee'], ['huangke', 'employee'],
      ['judge-a', 'employee'], ['judge-b', 'employee'],
    ] as const) {
      const rows = await sql<User[]>`
        INSERT INTO ispace.users (sso_subject, username, display_name, role)
        VALUES (${username}, ${username}, ${username}, ${role})
        RETURNING id, username, display_name AS "displayName", role, status
      `;
      users.set(username, rows[0]!);
    }

    app = Fastify();
    /*
      和 server.ts 同一套错误映射。少了它，IspaceError 会被 Fastify 当成
      未捕获异常一律返回 500，于是「没登录」「没权限」「超上限」在测试里
      长得一模一样——那样测出来的「拒绝了」毫无意义，它可能只是崩了。
    */
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof IspaceError) {
        return reply.status(err.httpStatus).send(err.toJSON());
      }
      const maybe = err as { validation?: unknown; issues?: unknown; message?: string };
      if (maybe.validation || maybe.issues) {
        return reply.status(422).send({
          code: ERROR_CODES.INVALID_INPUT, message: maybe.message ?? '入参不合法',
        });
      }
      return reply.status(500).send({ code: ERROR_CODES.INTERNAL, message: String(err) });
    });
    registerEventRoutes(app, {
      sql,
      requireAuth: async (req) => {
        const u = findUser(req);
        if (!u) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        return u;
      },
      optionalAuth: async (req) => findUser(req),
      /*
        和 server.ts 一样：先认身份，再查角色。两步分开才能把「没登录」
        （401，去登录）和「登录了但不是管理员」（403，别再试了）区分开——
        合成一个 403 会让没登录的人以为自己权限不够。
      */
      requireAdmin: async (req) => {
        const u = findUser(req);
        if (!u) throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '请先登录');
        if (u.role !== 'admin') throw new IspaceError(ERROR_CODES.FORBIDDEN, '需要管理员权限');
        return u;
      },
      filesRoot: '/tmp/ispace-test-event-files',
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 5 });
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/deploy/api${url}`, headers });
  const send = (method: 'PUT' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/deploy/api${url}`, headers, ...(payload === undefined ? {} : { payload }) });

  /** 直接把阶段钉死，省去等时钟。管理员接口本来就支持。 */
  const setPhase = async (phase: string | null) => {
    const r = await send('PATCH', `/events/${SLUG}`, { phase }, AS('admin'));
    expect(r.statusCode, r.body).toBe(200);
  };

  /**
   * 把整套日历平移到「现在之后」：创意截止落在一天以后，其余截止时间保持
   * 和种子里一样的间隔。
   *
   * 交创意、交作品、打分锁定这些接口除了看阶段，还直接拿当前时间和截止时间
   * 比——setPhase 钉住阶段也绕不过去。种子写的是本届的真实日期，所以这个
   * 文件原先是个定时炸弹：只要晚于 10.19 18:00 跑，交创意就一律被拒，后面
   * 二十条全跟着塌（入围、作品、打分都建立在「有人交了创意」上）。平移之后
   * 测试不再依赖今天是几号。
   */
  const rebaseCalendar = async () => {
    const cur = (await get(`/events/${SLUG}`)).json() as { event: { config: Record<string, unknown> } };
    const d = cur.event.config.deadlines as Record<string, string>;
    const shift = Date.now() + 24 * 3600_000 - Date.parse(d.idea!);
    const deadlines = Object.fromEntries(
      Object.entries(d).map(([k, v]) => [k, new Date(Date.parse(v) + shift).toISOString()]),
    );
    const r = await send('PATCH', `/events/${SLUG}`, { config: { ...cur.event.config, deadlines } }, AS('admin'));
    expect(r.statusCode, r.body).toBe(200);
  };

  /**
   * 把投票窗口挪到「现在」。
   *
   * 本届真实窗口是 2026-10-22 18:00 – 10-23 12:00，而测试跑在那之前，
   * 按真实配置投票一律被拒。改时钟会牵动整条阶段推导，所以改配置——
   * 走的是管理员那条 PATCH，顺带把它也验了。
   *
   * `config` 是整块替换，所以先取回完整那份再改这两个键。
   */
  const moveVoteWindow = async (opensMinAgo: number, closesMinAhead: number) => {
    const cur = (await get(`/events/${SLUG}`)).json() as { event: { config: Record<string, unknown> } };
    const d = cur.event.config.deadlines as Record<string, string>;
    const now = Date.now();
    const config = {
      ...cur.event.config,
      deadlines: {
        ...d,
        voteOpen: new Date(now - opensMinAgo * 60_000).toISOString(),
        vote: new Date(now + closesMinAhead * 60_000).toISOString(),
      },
    };
    const r = await send('PATCH', `/events/${SLUG}`, { config }, AS('admin'));
    expect(r.statusCode, r.body).toBe(200);
  };

  // ── 迁移与种子 ──────────────────────────────────────────────────
  it('迁移建出八张表，种子写入本届配置', async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'ispace' AND table_name LIKE 'event%'
       ORDER BY table_name
    `;
    // 0023 / 0027 加了初筛投票和交卷两张表
    expect(tables.map((t) => t.table_name)).toEqual([
      'event_ideas', 'event_judges', 'event_scores', 'event_screening_submits',
      'event_screening_votes', 'event_votes', 'event_works', 'events',
    ]);

    const ev = await sql<{ slug: string; phase: string | null; config: Record<string, unknown> }[]>`
      SELECT slug, phase, config FROM ispace.events WHERE slug = ${SLUG}
    `;
    expect(ev[0]!.phase).toBeNull();                 // 空 = 交给时钟推导
    expect(ev[0]!.config.voteLimit).toBe(2);
    expect((ev[0]!.config.criteria as { max: number }[]).reduce((n, c) => n + c.max, 0)).toBe(100);

    /*
      0019 把投票截止与评委打分锁定拆成了两个时刻（12:00 / 11:55）。
      合用一个键的话，把投票推到 12:00 会连带把打分也放宽五分钟。
    */
    const d = ev[0]!.config.deadlines as Record<string, string>;
    expect(d.voteOpen, '缺 voteOpen：投票窗口跨阶段靠它').toBeTruthy();
    expect(Date.parse(d.judgeLock!)).toBeLessThan(Date.parse(d.vote!));
    // 投票 10.22 18:00 就开，而作品 10.23 00:00 才截止——窗口确实跨阶段
    expect(Date.parse(d.voteOpen!)).toBeLessThan(Date.parse(d.work!));
  });

  it('种子里的截止时间带时区，不被服务器本地时区改写', async () => {
    const r = await sql<{ at: Date }[]>`
      SELECT (config->'deadlines'->>'idea')::timestamptz AS at
        FROM ispace.events WHERE slug = ${SLUG}
    `;
    // 10.19 18:00 +08 = 10:00 UTC（f0af732 从 12:00 顺延到 18:00）
    expect(r[0]!.at.toISOString()).toBe('2026-10-19T10:00:00.000Z');
  });

  // ── 日历 ────────────────────────────────────────────────────────
  /*
    上面两条读的是种子原样；从这里起整套截止时间平移到「现在之后」，
    后面的测试才不受今天日期的影响（理由见 rebaseCalendar）。
  */
  it('日历平移到现在之后，时钟推导出来是报名中', async () => {
    await rebaseCalendar();
    const r = (await get(`/events/${SLUG}`)).json();
    expect(r.event.phasePinned).toBe(false);
    expect(r.event.phase).toBe('signup');
  });

  // ── 免登录可读 ──────────────────────────────────────────────────
  it('活动详情不要求登录，且匿名时 me 为 null', async () => {
    await setPhase('signup');
    const r = await get(`/events/${SLUG}`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.me).toBeNull();
    expect(body.event.phase).toBe('signup');
    expect(body.event.config.rules.length).toBeGreaterThan(0);
  });

  // ── 报名 ────────────────────────────────────────────────────────
  it('交创意要登录', async () => {
    const r = await send('PUT', `/events/${SLUG}/idea`, {
      name: 'x', problem: 'y', plan: 'z',
    });
    expect(r.statusCode).toBe(401);
  });

  it('交创意后能在自己的 me 块里看到，别人看不到', async () => {
    for (const [who, name] of [
      ['lixiao', '周报助手'], ['wutong', '会议纪要智能体'], ['zhoumu', '门店客流问答'],
      ['huangke', '访客签到一体机'],
    ] as const) {
      const r = await send('PUT', `/events/${SLUG}/idea`, {
        name, problem: `${name}要解决的问题`, plan: `${name}的做法`,
      }, AS(who));
      expect(r.statusCode, r.body).toBe(200);
    }

    const mine = (await get(`/events/${SLUG}`, AS('lixiao'))).json();
    expect(mine.me.idea.name).toBe('周报助手');
    expect(mine.stats.ideaCount).toBe(4);
    // 初筛前谁都看不到创意列表，哪怕登录了
    expect(mine.finalists).toEqual([]);
  });

  it('每人只有一个创意——再交一次是改，不是新增', async () => {
    const r = await send('PUT', `/events/${SLUG}/idea`, {
      name: '周报助手 · 全员版', problem: '每周五凑周报', plan: '接日程和工单',
    }, AS('lixiao'));
    expect(r.statusCode).toBe(200);

    const n = await sql<{ n: number }[]>`SELECT count(*) AS n FROM ispace.event_ideas`;
    expect(Number(n[0]!.n)).toBe(4);
    const me = (await get(`/events/${SLUG}`, AS('lixiao'))).json();
    expect(me.me.idea.name).toBe('周报助手 · 全员版');
  });

  it('过了报名阶段就不能再交', async () => {
    await setPhase('building');
    const r = await send('PUT', `/events/${SLUG}/idea`, {
      name: '迟到的创意', problem: 'a', plan: 'b',
    }, AS('zhoumu'));
    expect(r.statusCode).toBe(403);
    await setPhase('signup');
  });

  // ── 初筛与评委 ──────────────────────────────────────────────────
  it('管理员定入围名单，编号按给定顺序生成', async () => {
    const ideas = await sql<{ id: string; name: string }[]>`
      SELECT i.id, i.name FROM ispace.event_ideas i
        JOIN ispace.users u ON u.id = i.user_id
       ORDER BY u.username
    `;
    const byName = (n: string) => ideas.find((i) => i.name.startsWith(n))!.id;

    const r = await send('PATCH', `/events/${SLUG}`, {
      finalists: [byName('会议纪要'), byName('周报助手'), byName('门店客流'), byName('访客签到')],
      judges: ['judge-a', 'judge-b'],
    }, AS('admin'));
    expect(r.statusCode, r.body).toBe(200);

    const nos = await sql<{ finalist_no: string; name: string }[]>`
      SELECT finalist_no, name FROM ispace.event_ideas
       WHERE finalist ORDER BY finalist_no
    `;
    expect(nos.map((x) => [x.finalist_no, x.name.slice(0, 2)]))
      .toEqual([['01', '会议'], ['02', '周报'], ['03', '门店'], ['04', '访客']]);
  });

  it('管理员能把本届全部创意拉出来，别人不能', async () => {
    /*
      这条接口是为初筛那一刻开的：公开接口此时一个创意都不返回，而定名单的
      八个人要把全部创意摊开看。所以它既要给齐公开视图里没有的字段
      （想解决什么问题、附件、谁交的），也必须把非管理员挡在门外。
    */
    const r = await get(`/events/${SLUG}/ideas`, AS('admin'));
    expect(r.statusCode, r.body).toBe(200);
    const { ideas } = r.json() as { ideas: EventAdminIdea[] };

    expect(ideas).toHaveLength(4);
    expect(ideas.every((i) => i.problem.length > 0 && i.plan.length > 0)).toBe(true);
    expect(ideas.every((i) => i.username.length > 0 && i.who.length > 0)).toBe(true);
    // 已定的名单与编号一并带回——控制台靠它还原「已存的路演顺序」
    expect(ideas.filter((i) => i.finalist).map((i) => i.no).sort()).toEqual(['01', '02', '03', '04']);

    expect((await get(`/events/${SLUG}/ideas`, AS('lixiao'))).statusCode).toBe(403);
    // 没登录是 401 而不是 403：两者该把人引向不同的下一步
    expect((await get(`/events/${SLUG}/ideas`)).statusCode).toBe(401);
  });

  it('普通人改不了名单', async () => {
    const r = await send('PATCH', `/events/${SLUG}`, { phase: 'result' }, AS('lixiao'));
    expect(r.statusCode).toBe(403);
  });

  it('重设名单是整批替换，不会留下旧编号', async () => {
    const ideas = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM ispace.event_ideas ORDER BY name
    `;
    const all = ideas.map((i) => i.id);
    // 换个顺序重设
    await send('PATCH', `/events/${SLUG}`, { finalists: [all[2]!, all[0]!, all[1]!, all[3]!] }, AS('admin'));
    const nos = await sql<{ n: number }[]>`
      SELECT count(DISTINCT finalist_no) AS n FROM ispace.event_ideas WHERE finalist
    `;
    expect(Number(nos[0]!.n)).toBe(4);
    // 还原成「会议纪要=01」的顺序，后面的断言依赖它
    const byName = (n: string) => ideas.find((i) => i.name.startsWith(n))!.id;
    await send('PATCH', `/events/${SLUG}`, {
      finalists: [byName('会议纪要'), byName('周报助手'), byName('门店客流'), byName('访客签到')],
    }, AS('admin'));
  });

  it('入围名单在入围制作阶段才对外可见', async () => {
    await setPhase('building');
    const pub = (await get(`/events/${SLUG}`)).json();
    expect(pub.finalists).toHaveLength(4);
    expect(pub.finalists[0].no).toBe('01');
    // 投票期间不放票数
    expect(pub.finalists[0].votes).toBeNull();
    expect(pub.judges.map((j: { username: string }) => j.username)).toEqual(['judge-a', 'judge-b']);
  });

  // ── 交作品 ──────────────────────────────────────────────────────
  it('硬件作品要有附件，页面作品要有发布过的页面', async () => {
    const noFiles = await send('PUT', `/events/${SLUG}/work`, {
      kind: 'other', name: '签到机', files: [],
    }, AS('wutong'));
    expect(noFiles.statusCode).toBe(422);

    const ok = await send('PUT', `/events/${SLUG}/work`, {
      kind: 'other', name: '访客签到一体机',
      files: [{ name: 'p.jpg', size: 100, url: '/x' }],
    }, AS('wutong'));
    expect(ok.statusCode, ok.body).toBe(200);

    const noSuchApp = await send('PUT', `/events/${SLUG}/work`, {
      kind: 'page', appSlug: 'buzaide',
    }, AS('lixiao'));
    expect(noSuchApp.statusCode).toBe(404);
  });

  it('页面作品定格提交那一刻的版本号', async () => {
    const lixiao = users.get('lixiao')!;
    const app1 = await sql<{ id: string }[]>`
      INSERT INTO ispace.apps (owner_id, slug, name, status)
      VALUES (${lixiao.id}, 'zhoubao', '周报助手', 'running') RETURNING id
    `;
    const rel = await sql<{ id: string }[]>`
      INSERT INTO ispace.releases (app_id, version, source, status, path, published_by)
      VALUES (${app1[0]!.id}, 12, 'mcp', 'active', '/x', ${lixiao.id}) RETURNING id
    `;
    await sql`UPDATE ispace.apps SET current_release_id = ${rel[0]!.id} WHERE id = ${app1[0]!.id}`;

    const r = await send('PUT', `/events/${SLUG}/work`, { kind: 'page', appSlug: 'zhoubao' }, AS('lixiao'));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().appVersion).toBe(12);

    // 之后再发新版，参评版本不变
    await sql`
      UPDATE ispace.releases SET status = 'superseded' WHERE id = ${rel[0]!.id}
    `;
    const rel2 = await sql<{ id: string }[]>`
      INSERT INTO ispace.releases (app_id, version, source, status, path, published_by)
      VALUES (${app1[0]!.id}, 13, 'mcp', 'active', '/y', ${lixiao.id}) RETURNING id
    `;
    await sql`UPDATE ispace.apps SET current_release_id = ${rel2[0]!.id} WHERE id = ${app1[0]!.id}`;

    const w = await sql<{ app_version: number }[]>`
      SELECT app_version FROM ispace.event_works w
        JOIN ispace.event_ideas i ON i.id = w.idea_id
       WHERE i.user_id = ${lixiao.id}
    `;
    expect(w[0]!.app_version).toBe(12);
  });

  /**
   * 这条是冲着一个真实存在过的约束冲突来的：页面是硬删除的
   * （services/app-delete.ts），event_works.app_id 上挂着 ON DELETE SET NULL。
   * 若 CHECK 同时要求「kind='page' 就必须有 app_id」，这次级联更新会失败，
   * 连带把**删除页面**整个动作挡掉——参赛过的页面从此删不掉。
   */
  it('删掉参赛用的页面不会被约束挡住，作品记录留下来', async () => {
    const appRow = await sql<{ id: string }[]>`SELECT id FROM ispace.apps WHERE slug = 'zhoubao'`;
    await expect(sql`DELETE FROM ispace.apps WHERE id = ${appRow[0]!.id}`).resolves.toBeDefined();

    const w = await sql<{ kind: string; app_id: string | null }[]>`
      SELECT kind, app_id FROM ispace.event_works WHERE kind = 'page'
    `;
    expect(w[0]!.kind).toBe('page');
    expect(w[0]!.app_id).toBeNull();      // 页面没了，作品还在

    // 对外表现为「没有可打开的地址」，不是报错
    await setPhase('building');
    const pub = (await get(`/events/${SLUG}`)).json();
    const mine = pub.finalists.find((f: { no: string }) => f.no === '02');
    expect(mine.url).toBeNull();
  });

  // ── 评委打分 ────────────────────────────────────────────────────
  it('非评委打不开打分页', async () => {
    const r = await get(`/events/${SLUG}/judge`, AS('lixiao'));
    expect(r.statusCode).toBe(403);
  });

  it('评委只看得到自己的分，和别人的提交计数', async () => {
    await setPhase('demo');
    const ideas = await sql<{ id: string; finalist_no: string }[]>`
      SELECT id, finalist_no FROM ispace.event_ideas WHERE finalist ORDER BY finalist_no
    `;
    const idOf = (no: string) => ideas.find((i) => i.finalist_no === no)!.id;

    // judge-a 给三件都打了分并提交
    for (const [no, dims] of [['01', [33, 24, 19, 18]], ['02', [30, 22, 18, 16]], ['03', [28, 20, 17, 15]]] as const) {
      const r = await send('PUT', `/events/${SLUG}/scores/${idOf(no)}`, {
        dims, note: `对 ${no} 的评语`, submit: true,
      }, AS('judge-a'));
      expect(r.statusCode, r.body).toBe(200);
    }
    // judge-b 只打了 01，而且只存草稿
    await send('PUT', `/events/${SLUG}/scores/${idOf('01')}`, {
      dims: [35, 25, 20, 20], submit: false,
    }, AS('judge-b'));

    const board = (await get(`/events/${SLUG}/judge`, AS('judge-b'))).json();
    const first = board.items.find((i: { no: string }) => i.no === '01');
    expect(first.mine.total).toBe(100);
    expect(first.mine.submitted).toBe(false);
    expect(first.othersSubmitted).toBe(1);     // judge-a 提交了，但看不到是多少分

    /*
      judge-b 没给 02、03 打过分，所以这两项的 mine 必须是 null——
      judge-a 对它们的分一个字节都不该出现在 judge-b 的响应里。
      （别用「整段 JSON 里不含 33」这种断言：uuid 和时间戳里全是数字。）
    */
    for (const no of ['02', '03']) {
      const it = board.items.find((x: { no: string }) => x.no === no);
      expect(it.mine, `judge-b 不该看到 ${no} 的任何分数`).toBeNull();
      expect(it.othersSubmitted).toBe(1);
    }
  });

  it('维度分超上限会被拒', async () => {
    const idea = await sql<{ id: string }[]>`
      SELECT id FROM ispace.event_ideas WHERE finalist_no = '01'
    `;
    const r = await send('PUT', `/events/${SLUG}/scores/${idea[0]!.id}`, {
      dims: [999, 0, 0, 0], submit: true,
    }, AS('judge-a'));
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toContain('创意创新性');
  });

  /**
   * 存草稿不能把已经提交过的分退回未提交状态——那条
   * `COALESCE(excluded.submitted_at, s.submitted_at)` 就是为这个写的，
   * 而 `AS s` 这个别名是它能解析的前提。
   */
  it('提交过之后再存草稿，仍然算已提交', async () => {
    const idea = await sql<{ id: string }[]>`
      SELECT id FROM ispace.event_ideas WHERE finalist_no = '01'
    `;
    const r = await send('PUT', `/events/${SLUG}/scores/${idea[0]!.id}`, {
      dims: [30, 20, 15, 15], submit: false,
    }, AS('judge-a'));
    expect(r.statusCode, r.body).toBe(200);

    const row = await sql<{ total: number; submitted_at: Date | null }[]>`
      SELECT total, submitted_at FROM ispace.event_scores
       WHERE idea_id = ${idea[0]!.id} AND judge_id = ${users.get('judge-a')!.id}
    `;
    expect(row[0]!.total).toBe(80);               // 分数改了
    expect(row[0]!.submitted_at).not.toBeNull();  // 但没退回未提交
  });

  // ── 投票 ────────────────────────────────────────────────────────
  //
  // 本届投票改成了全员线上：10.22 18:00 开放、10.23 12:00 截止、每人 2 票，
  // 窗口横跨 building 与 demo 两个阶段。下面几条都靠 moveVoteWindow 把窗口
  // 挪到「现在」来验——真实窗口在未来，按原配置一律被拒。

  it('窗口没开时投不了，和已经截止是同一种拒绝', async () => {
    const ideas = await sql<{ id: string; finalist_no: string }[]>`
      SELECT id, finalist_no FROM ispace.event_ideas WHERE finalist ORDER BY finalist_no
    `;
    const idOf = (no: string) => ideas.find((i) => i.finalist_no === no)!.id;

    // 窗口整段在未来
    await moveVoteWindow(-60, 120);
    const early = await send('POST', `/events/${SLUG}/votes/${idOf('01')}`, undefined, AS('lixiao'));
    expect(early.statusCode).toBe(403);
    const notStarted = (await get(`/events/${SLUG}`)).json();
    expect(notStarted.finalists.every((f: { votes: null }) => f.votes === null)).toBe(true);
    expect(notStarted.stats.voteTotal).toBe(0);

    // 窗口整段在过去
    await moveVoteWindow(120, -60);
    const late = await send('POST', `/events/${SLUG}/votes/${idOf('01')}`, undefined, AS('lixiao'));
    expect(late.statusCode).toBe(403);
  });

  /**
   * 投票窗口**只看时刻，不看阶段**。
   *
   * 这条是改版的要害：窗口 10.22 18:00 就开，而作品 10.23 00:00 才截止，
   * 所以开头那半程活动还处在 building。原先那句 `phase !== 'demo'`
   * 会把前一晚的投票整段挡掉，而规则写明那时就能投。
   */
  it('building 阶段只要窗口开着就能投', async () => {
    await setPhase('building');
    await moveVoteWindow(30, 30);
    const ideas = await sql<{ id: string; finalist_no: string }[]>`
      SELECT id, finalist_no FROM ispace.event_ideas WHERE finalist ORDER BY finalist_no
    `;
    const idOf = (no: string) => ideas.find((i) => i.finalist_no === no)!.id;

    const r = await send('POST', `/events/${SLUG}/votes/${idOf('01')}`, undefined, AS('zhoumu'));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().voted).toBe(true);
    // 撤回，把计数还原，后面的断言从干净状态开始
    await send('POST', `/events/${SLUG}/votes/${idOf('01')}`, undefined, AS('zhoumu'));

    // 对外也要说窗口是开着的，前端据此显示投票按钮
    expect((await get(`/events/${SLUG}`)).json().event.votingOpen).toBe(true);
  });

  it('投票是开关，不能投自己，上限 2 票', async () => {
    await setPhase('demo');
    await moveVoteWindow(30, 30);
    const ideas = await sql<{ id: string; finalist_no: string }[]>`
      SELECT id, finalist_no FROM ispace.event_ideas WHERE finalist ORDER BY finalist_no
    `;
    const idOf = (no: string) => ideas.find((i) => i.finalist_no === no)!.id;

    // 周报助手(02) 是 lixiao 的
    const own = await send('POST', `/events/${SLUG}/votes/${idOf('02')}`, undefined, AS('lixiao'));
    expect(own.statusCode).toBe(403);
    expect(own.json().message).toContain('自己');

    const v1 = await send('POST', `/events/${SLUG}/votes/${idOf('01')}`, undefined, AS('lixiao'));
    expect(v1.json()).toMatchObject({ voted: true, remaining: 1 });

    // 再点一次 = 撤回
    const v2 = await send('POST', `/events/${SLUG}/votes/${idOf('01')}`, undefined, AS('lixiao'));
    expect(v2.json()).toMatchObject({ voted: false, remaining: 2 });

    // 投满 2 票（只有 01、03 不是自己的）
    for (const no of ['01', '03']) {
      await send('POST', `/events/${SLUG}/votes/${idOf(no)}`, undefined, AS('lixiao'));
    }
    const full = (await get(`/events/${SLUG}`, AS('lixiao'))).json();
    expect(full.me.votes).toHaveLength(2);

    /*
      票数故意这样铺：03 票最多，但它同时会拿到评委奖；04 票第二多且
      没有评委奖。于是「人气奖与一二三等奖互斥」这条规则必须跳过 03、
      落到 04——不互斥的话会落到 03，而规则禁止一个人抱两个奖。
    */
    for (const who of ['wutong', 'zhoumu', 'judge-a', 'judge-b']) {
      await send('POST', `/events/${SLUG}/votes/${idOf('03')}`, undefined, AS(who));
    }
    for (const who of ['wutong', 'judge-a', 'judge-b']) {
      await send('POST', `/events/${SLUG}/votes/${idOf('04')}`, undefined, AS(who));
    }
  });

  it('打分锁定与投票截止是两回事：锁了分还能投票', async () => {
    // 打分锁在 1 分钟前，投票还开着
    const cur = (await get(`/events/${SLUG}`)).json() as { event: { config: Record<string, unknown> } };
    const d = cur.event.config.deadlines as Record<string, string>;
    const now = Date.now();
    await send('PATCH', `/events/${SLUG}`, {
      config: {
        ...cur.event.config,
        deadlines: {
          ...d,
          judgeLock: new Date(now - 60_000).toISOString(),
          voteOpen: new Date(now - 60_000).toISOString(),
          vote: new Date(now + 60 * 60_000).toISOString(),
        },
      },
    }, AS('admin'));

    const after = (await get(`/events/${SLUG}`)).json();
    expect(after.event.judgingLocked).toBe(true);
    expect(after.event.votingOpen).toBe(true);

    const idea = await sql<{ id: string }[]>`
      SELECT id FROM ispace.event_ideas WHERE finalist_no = '01'
    `;
    const score = await send('PUT', `/events/${SLUG}/scores/${idea[0]!.id}`, {
      dims: [1, 1, 1, 1], submit: true,
    }, AS('judge-a'));
    expect(score.statusCode, '打分该被锁住').toBe(403);
  });

  it('投票开放后公开真实票数，截止后仍保留显示', async () => {
    // 2026-10-22 决策（e196c0bf）已改为开始后显示。旧断言仍要求隐藏，
    // 与 voteStarted 及 event-phase.test.ts 的规则冲突；这里校验数据库实际值。
    const votes = await sql<{ idea_id: string; votes: number }[]>`
      SELECT v.idea_id, count(*)::int AS votes FROM ispace.event_votes v
      JOIN ispace.events e ON e.id = v.event_id WHERE e.slug = ${SLUG} GROUP BY v.idea_id`;
    const expected = new Map(votes.map(v => [v.idea_id, v.votes]));
    const check = async () => {
      const pub = (await get(`/events/${SLUG}`)).json();
      for (const f of pub.finalists) expect(f.votes).toBe(expected.get(f.ideaId) ?? 0);
      expect(pub.stats.voteTotal).toBe(votes.reduce((sum, v) => sum + v.votes, 0));
    };
    await check();
    const config = (await get(`/events/${SLUG}`)).json().event.config;
    try { await moveVoteWindow(120, -60); await check(); }
    finally { await send('PATCH', `/events/${SLUG}`, { config }, AS('admin')); }
  });

  // ── 汇总排名与获奖名单 ──────────────────────────────────────────
  it('名次按已提交分数的平均分排，草稿不算', async () => {
    const r = await get(`/events/${SLUG}/ranking`, AS('admin'));
    expect(r.statusCode, r.body).toBe(200);
    const { ranking } = r.json();

    // judge-a: 01=80（改过）, 02=86, 03=80；judge-b 的 01 是草稿，不计
    const byNo = Object.fromEntries(ranking.map((x: { no: string }) => [x.no, x]));
    expect(byNo['02'].judgeScore).toBe(86);
    expect(byNo['02'].judged).toBe(1);
    expect(byNo['02'].rank).toBe(1);
    expect(byNo['01'].judged).toBe(1);       // judge-b 的草稿没算进来
    /*
      04 一个评委都没打过分，所以它没有名次（null），而不是排在第 4。
      编一个名次出来会让颁奖时把零分作品当成第四名。
    */
    expect(ranking.map((x: { rank: number | null }) => x.rank)).toEqual([1, 2, 3, null]);
  });

  it('排名只有管理员能看', async () => {
    expect((await get(`/events/${SLUG}/ranking`, AS('judge-a'))).statusCode).toBe(403);
    expect((await get(`/events/${SLUG}/ranking`)).statusCode).toBe(401);
  });

  it('结果公布后给出获奖名单，票数这时才可见', async () => {
    await setPhase('result');
    const pub = (await get(`/events/${SLUG}`)).json();

    expect(pub.stats.voteTotal).toBeGreaterThan(0);
    expect(pub.finalists[0].votes).not.toBeNull();

    const awards = pub.awards as {
      key: string; no: string; judgeScore: number | null; votes: number;
      comment: string | null; desc: string; dims: number[] | null;
    }[];
    const first = awards.find((a) => a.key === 'first')!;
    expect(first.no).toBe('02');                  // 评委平均分最高
    expect(first.judgeScore).toBe(86);
    expect(first.comment).toContain('评语');       // 取了一条已提交的评语

    // 颁奖大屏要用的两项：一句话介绍与各维度均分
    expect(first.desc.length).toBeGreaterThan(0);
    expect(first.dims).toHaveLength(4);
    expect(first.dims!.reduce((n, v) => n + v, 0)).toBeCloseTo(first.judgeScore!, 1);

    /*
      互斥：03 票数最多（4 票），但它拿了评委奖，所以人气奖跳过它，
      落到票数第二的 04。这条就是本届新加的「与一二三等奖互斥」。
    */
    const byVotes = [...pub.finalists].sort((a: { votes: number }, b: { votes: number }) => b.votes - a.votes);
    expect(byVotes[0]!.no, '票王应是 03').toBe('03');
    const judgeWinners = awards.filter((a) => a.judgeScore != null).map((a) => a.no);
    expect(judgeWinners).toContain('03');

    const popular = awards.find((a) => a.key === 'popular')!;
    expect(popular.no, '人气奖该跳过已拿评委奖的 03').toBe('04');
    expect(judgeWinners).not.toContain(popular.no);
    expect(popular.judgeScore).toBeNull();

    // 入围奖人人有份，不是一个名次，不进获奖名单
    expect(awards.some((a) => a.key === 'finalist')).toBe(false);
  });

  it('锁定后不能再改分', async () => {
    const idea = await sql<{ id: string }[]>`
      SELECT id FROM ispace.event_ideas WHERE finalist_no = '01'
    `;
    const r = await send('PUT', `/events/${SLUG}/scores/${idea[0]!.id}`, {
      dims: [10, 10, 10, 10], submit: true,
    }, AS('judge-a'));
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toContain('锁定');
  });

  /**
   * 附件的可见性判定。
   *
   * 这条查询（在 ideas.files 和 works.files 的 jsonb 里按 id 反查归属）
   * 是整个文件里唯一一条「判断谁能看」的 SQL，值得单独钉住：creative
   * 附件在初筛前只有作者、评委、管理员能看，而**不是**靠 uuid 猜不到。
   *
   * 不走 multipart 上传：那只是把字节落盘，而鉴权发生在读取那一侧。
   * 这里直接把一条附件记录写进 ideas.files，再去 GET 它——文件在磁盘上
   * 不存在，所以放行的那几个人拿到的是 404（走到了 stat 那一步），
   * 被挡住的人拿到 403。两者的区别正是这条 SQL 判出来的。
   */
  it('创意附件：作者、评委、管理员能看，其他人看不到', async () => {
    await setPhase('signup');
    const fileId = '11111111-2222-3333-4444-555555555555.png';
    // 用 sql.json 而不是 JSON.stringify(...)::jsonb——后者会双重编码，
    // 存成 jsonb 字符串标量。这里要和接口里的写法一致才测得出真实行为。
    await sql`
      UPDATE ispace.event_ideas
         SET files = ${sql.json([{ name: 'a.png', size: 1, url: `/x/${fileId}` }])}
       WHERE user_id = ${users.get('lixiao')!.id}
    `;

    const url = `/events/${SLUG}/files/${fileId}`;
    // 挡住：匿名、以及不相干的同事
    expect((await get(url)).statusCode).toBe(403);
    expect((await get(url, AS('zhoumu'))).statusCode).toBe(403);
    // 放行（文件不在磁盘上，所以是 404 而不是 403）
    for (const who of ['lixiao', 'judge-a', 'admin']) {
      expect((await get(url, AS(who))).statusCode, who).toBe(404);
    }
  });

  it('附件 id 形态不合法直接 404，不去碰文件系统', async () => {
    for (const bad of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', 'abc.png']) {
      const r = await get(`/events/${SLUG}/files/${encodeURIComponent(bad)}`);
      expect([403, 404]).toContain(r.statusCode);
    }
  });

  /**
   * 补 `/ideas` 的两个分支。
   *
   * 上面那条「管理员能把本届全部创意拉出来」跑在交作品和写附件之前，
   * 那时每一行的 submitted 都是 false、files 都是空数组——也就是说
   * `(w.id IS NOT NULL) AS submitted` 的 true 分支和 files 的 jsonb
   * 回程，两条都没被真正执行过。放到链路末尾再查一次才覆盖得到。
   */
  it('创意列表带回已交作品标记与附件（jsonb 回程）', async () => {
    const { ideas } = (await get(`/events/${SLUG}/ideas`, AS('admin'))).json() as
      { ideas: EventAdminIdea[] };

    const byUser = Object.fromEntries(ideas.map((i) => [i.username, i]));

    // wutong 交了硬件作品、lixiao 交了页面作品，zhoumu 没交
    expect(byUser.wutong!.submitted).toBe(true);
    expect(byUser.lixiao!.submitted).toBe(true);
    expect(byUser.zhoumu!.submitted).toBe(false);

    // 附件那条测试把一条记录写进了 lixiao 的 files，这里验它原样回来
    expect(Array.isArray(byUser.lixiao!.files)).toBe(true);
    expect(byUser.lixiao!.files[0]).toMatchObject({ name: 'a.png', size: 1 });
    expect(byUser.zhoumu!.files).toEqual([]);

    // created_at 是 Date 才有 toISOString；是字符串的话这个接口早就 500 了
    expect(byUser.lixiao!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /**
   * 直接盯住库里存的是什么类型。
   *
   * 这条是上一条的兜底：接口层万一哪天加了 JSON.parse 兜底，上面那条
   * 还是会绿，而库里存的仍然是错的（jsonb 字符串标量），
   * 任何 `files->0`、`dims @> ...` 的查询都会失效。
   * 用 `${JSON.stringify(x)}::jsonb` 写 jsonb 就会掉进这个坑。
   */
  it('jsonb 列存的是数组本身，不是 JSON 字符串', async () => {
    const kinds = await sql<{ k: string }[]>`
      SELECT jsonb_typeof(files) AS k FROM ispace.event_ideas
      UNION ALL SELECT jsonb_typeof(files) FROM ispace.event_works
      UNION ALL SELECT jsonb_typeof(dims) FROM ispace.event_scores
    `;
    expect(kinds.every((x) => x.k === 'array'), '有列存成了 jsonb 字符串标量').toBe(true);

    const cfg = await sql<{ k: string }[]>`
      SELECT jsonb_typeof(config) AS k FROM ispace.events
    `;
    expect(cfg[0]!.k).toBe('object');
  });

  it('把 phase 设回 null 就交还给时钟', async () => {
    await setPhase(null);
    const r = (await get(`/events/${SLUG}`)).json();
    expect(r.event.phasePinned).toBe(false);
    // 日历已平移到现在之后，交还给时钟就回到报名中（不再依赖今天是几号）
    expect(r.event.phase).toBe('signup');
  });
});
