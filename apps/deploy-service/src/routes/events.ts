import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE, ERROR_CODES, IspaceError, avatarUrlFor,
  eventAdminSchema, ideaInputSchema, scoreInputSchema, workInputSchema,
  derivePhase, phaseAtLeast,
  type EventAdminIdea, type EventAward, type EventConfig, type EventFile, type EventFinalist, type EventOpenWork,
  type EventIdeasResponse, type EventJudgeItem, type EventJudgeResponse, type EventPhase,
  type EventScreeningRankRow, type EventScreeningResponse, type EventScreeningTallyRow,
  type EventRankRow, type EventResponse, type EventSummary, type User,
} from '@ispace/contracts';
import { getPlatformPolicy, writeAudit, type Sql } from '@ispace/db';

/**
 * 1024 程序员节的赛事接口。
 *
 * ┌─ 这里的权限分界是产品要求，不是实现细节 ────────────────────────────┐
 * │ 活动详情页**不要求登录**：横幅会转发到群里，点进来的人可能还没登录，   │
 * │ 让他先看见活动是什么、怎么参加，比先看见登录框对。只有「报名」这一下   │
 * │ 才需要身份——因为那一刻要往库里写「谁交的」。                        │
 * │                                                                      │
 * │ 所以 GET /events/:slug 走 optionalAuth（有会话就带上「我」那一块，    │
 * │ 没有就整块为 null），而所有写接口走 requireAuth。                     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 另外两条贯穿全文件的规则：
 *
 *   **时间判断一律在服务端。** 截止时间是比赛的一部分，交给浏览器本地时钟
 *   等于没有截止——把系统时间往前拨一天就能在 10.19 之后继续改创意。前端
 *   拿到的 `now` 只用来显示倒数。
 *
 *   **初筛结束前创意只有评委能看到。** 这是写在参赛须知里的，所以
 *   finalists 在 signup/screening 阶段返回空数组，评委的那条路另开
 *   （GET /events/:slug/judge，进门先查 event_judges）。
 */

/*
  ⚠️ 写 jsonb 一律用 `sql.json(值)`，**不要** `${JSON.stringify(值)}::jsonb`。

  后者看着对，实际是双重编码：postgres.js 把 JS 字符串参数按 json 再序列化
  一次，于是存进去的是一个 jsonb **字符串标量**而不是数组/对象——
  `jsonb_typeof` 返回 'string'，读回来也是字符串。

  这个坑不会报错，只会悄悄坏掉：
    - 评委打分页拿到 dims 是 "[30,20,17,16]" 而不是数组，前端一索引就得到字符
    - 以后任何 `files->0`、`@>` 之类的 jsonb 查询全都匹配不上
  实测发现（见 __tests__/events-integration.test.ts 里那条「jsonb 回程」），
  在真库上跑之前假 sql 完全看不出来。
*/

/** 附件上限。效果图、照片、短视频够用；真要传大视频该走页面发布那条路。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * 允许的附件类型。白名单而不是黑名单：这些文件会被浏览器直接打开，
 * 放进一个 .html 或 .svg 就等于在平台域名下挂了一段任意脚本。
 */
const ALLOWED_FILE_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
};

export interface EventRow {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  edition: string | null;
  venue: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  phase: EventPhase | null;
  config: EventConfig;
}

/**
 * 当前阶段：人工覆盖优先，否则按 config.deadlines 推导。
 *
 * 为什么默认是推导而不是让人点按钮：活动横跨八天，阶段切换都在半夜或
 * 中午十二点整——指望有人准点去点一下，等于指望报名在 10.19 12:00 之后
 * 还开着。而活动当天主持人确实需要手动推进（路演延时是常态），所以保留
 * 覆盖：events.phase 非空就钉死，直到被设回 null。
 *
 * ┌─ 但覆盖盖不住下线 ────────────────────────────────────────────────┐
 * │ `deadlines.end` 的契约写的是「活动整体结束，页面与横幅下线」，所以   │
 * │ 过了这个时刻一律 'ended'，钉死也不例外。                            │
 * │                                                                    │
 * │ 理由是「解钉」这件事没有任何机制提醒：当天主持人为了等路演把阶段钉   │
 * │ 住，活动一散场没人会再打开控制台，于是首页横幅和 App 启动页上的      │
 * │ 1024 会一直挂着——而那时候它已经没有任何意义了。下线必须是到点自己   │
 * │ 发生的事，不能依赖有人记得。                                        │
 * │                                                                    │
 * │ 想提前下线仍然可以：把 phase 钉成 'ended'（end 之前覆盖照常生效）。 │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function resolvePhase(ev: Pick<EventRow, 'phase' | 'config'>, now: Date): EventPhase {
  /* 推导本身在 @ispace/contracts：控制台的赛事管理屏要用同一套规则回答
     「交还给时钟会落回哪一阶段」，两处各写一遍迟早会对不上。 */
  const derived = derivePhase(ev.config?.deadlines, now);
  if (derived === 'ended') return 'ended';
  if (ev.phase) return ev.phase;
  return derived;
}

function summary(ev: EventRow, now: Date): EventSummary {
  return {
    slug: ev.slug,
    title: ev.title,
    subtitle: ev.subtitle,
    edition: ev.edition,
    venue: ev.venue,
    startsAt: ev.starts_at ? ev.starts_at.toISOString() : null,
    endsAt: ev.ends_at ? ev.ends_at.toISOString() : null,
    phase: resolvePhase(ev, now),
    phasePinned: ev.phase != null,
    votingOpen: voteWindowOpen(ev, now),
    judgingLocked: isLocked(ev, now),
    config: ev.config,
    now: now.toISOString(),
  };
}

/**
 * 评委打分是否已锁定。11:55 一到就不能再改，名次按那一刻的分数排。
 *
 * 用 judgeLock 而不是 vote：本届两者不是同一时刻（投票 12:00 截止，打分
 * 11:55 锁）。缺 judgeLock 时回落到 vote——老配置里只有那一个字段。
 */
/**
 * 这个人现在能不能提前拿到获奖名单。
 *
 * 对外公布是 deadlines.award（结果公布阶段）。在那之前，config.awardPreview
 * 里列的人和管理员，只要「所有结果都已经定了」就能拿到——给组织者挂颁奖
 * 大屏、从背景墙走一遍用的。
 *
 * 「定了」= 打分锁定（judgeLock）和人气投票截止（vote）都已经过了。只看
 * 锁定不够：本届人气票比锁分晚 5 分钟才截止，那 5 分钟里人气奖还会变。
 * 两个时间都没配的话不放——宁可等到正式公布，也不在结果还会变的时候放出去。
 */
export function canPreviewAwards(
  ev: Pick<EventRow, 'config'>,
  user: Pick<User, 'username' | 'role'> | null,
  now: Date,
): boolean {
  if (!user) return false;
  const allowed = user.role === 'admin'
    || (ev.config?.awardPreview ?? []).includes(user.username);
  if (!allowed) return false;
  const d = ev.config?.deadlines;
  const marks = [d?.judgeLock, d?.vote].filter((x): x is string => !!x).map(Date.parse);
  if (marks.length === 0 || marks.some(Number.isNaN)) return false;
  return now.getTime() >= Math.max(...marks);
}

function isLocked(ev: EventRow, now: Date): boolean {
  const phase = resolvePhase(ev, now);
  if (phaseAtLeast(phase, 'result')) return true;
  const d = ev.config?.deadlines;
  const at = d?.judgeLock ?? d?.vote;
  return at ? now.getTime() >= Date.parse(at) : false;
}

/**
 * 打分窗口：什么时候能打分，不能打时为什么。
 *
 * ┌─ 和 isLocked 不是一回事 ──────────────────────────────────────────┐
 * │ isLocked 只回答「是不是已经锁了」——11:55 之后、或者已经出结果。    │
 * │ 它不管**还没开始**：入围制作期（10.19–10.22）它是 false，于是评委   │
 * │ 在路演前四天就能把分打完，而那时作品还没交完、人也还没上台讲。      │
 * │ 赛制写的是「现场打分」，那就该到现场那一刻才开。                    │
 * │                                                                    │
 * │ 所以窗口两头都要有：demo 阶段开始才开，judgeLock 一到就关。         │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * judgingLocked（活动页用来决定显不显示评委入口）仍然走 isLocked：路演前
 * 评委就该能打开这一页看名单、读创意，只是还不能打分。
 */
/** 10.19 12:00。只用在给评委看的那几句提示里。 */
function mdhm(iso: string | undefined): string {
  if (!iso) return '时间未定';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${g('month')}.${g('day')} ${g('hour')}:${g('minute')}`;
}

/** 第 8 名同票时最多扩出几个名额。本届是 1：8 个扩到 9 个为止。 */
export const SCREENING_TIE_EXTRA = 1;

/**
 * 把得票数排成榜，并标出谁入围。
 *
 * 入参要求已经按「票数降序、同票时按提交先后」排好——名次和切线都只看顺序
 * 和票数，排序规则留在 SQL 里，这里不再排一遍。
 *
 * ┌─ 第 8 名同票：扩一个名额，不切 ─────────────────────────────────────┐
 * │ 本届规则：前 8 入围；第 8 名同票时，**同票的全部入围**，名额最多扩到 │
 * │ 9 个。扩而不切，是因为任何一种切法（按 id、按提交时间、按名字）都  │
 * │ 等于让一个 ORDER BY 替人决定谁能进决赛。                            │
 * │                                                                    │
 * │ 扩到 9 个还装不下（三个人卡在第 8 名、或者到点时全员零票）才标成    │
 * │ 'tie'，交给人在控制台定。不能无限扩：评委一票没投就到点，十几个     │
 * │ 零票创意全部并列，扩下去就是全员入围。                              │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 名次用「竞赛排名」：同票同名次，下一个跳号（1,2,2,4）。票数一样却显示成
 * 不同名次，看榜的人第一反应是数据错了。
 */
export function rankScreening(
  rows: { id: string; name: string; who: string; votes: number }[],
  slots: number,
): EventScreeningRankRow[] {
  if (slots <= 0 || rows.length === 0) return [];

  /* 最后一个名额上的票数。创意数不足名额时谁都不出局，cut 落在最低一档 */
  const cut = rows[Math.min(slots, rows.length) - 1]!.votes;
  const above = rows.filter((r) => r.votes > cut).length;
  const atCut = rows.filter((r) => r.votes === cut).length;
  /* 卡线那一档连扩出来的那一个名额也塞不下，才叫同票待定 */
  const tie = above + atCut > slots + SCREENING_TIE_EXTRA;

  let rank = 0;
  let prevVotes = Number.NaN;
  return rows.map((r, i) => {
    if (r.votes !== prevVotes) { rank = i + 1; prevVotes = r.votes; }
    const status: EventScreeningRankRow['status'] =
      r.votes > cut ? 'in' : r.votes === cut ? (tie ? 'tie' : 'in') : 'out';
    return { ideaId: r.id, name: r.name, who: r.who, votes: r.votes, status, rank };
  });
}

export function scoringWindow(ev: EventRow, now: Date): { open: boolean; reason: string | null } {
  if (isLocked(ev, now)) {
    return { open: false, reason: '打分已锁定，分数不能再改。系统正在按评委的平均分排名。' };
  }
  const phase = resolvePhase(ev, now);
  if (!phaseAtLeast(phase, 'demo')) {
    const at = ev.config?.deadlines?.work;
    return {
      open: false,
      reason: at
        /*
          at 是作品截止（demo 阶段从那一刻开始），不是路演开场——写成
          「路演 10.23 00:00 开始」评委会以为半夜要打分。
        */
        ? `打分在路演阶段开放（作品 ${mdhm(at)} 截止后）。现在可以先看入围作品，提交按钮到时候亮起来。`
        : '打分在路演阶段开放。现在可以先看入围作品，提交按钮到时候亮起来。',
    };
  }
  return { open: true, reason: null };
}

/**
 * 人气奖投票窗口是否开着。
 *
 * **只看时刻，不看阶段**：本届投票 10.22 18:00 开放，而作品 10.23 00:00
 * 才截止，窗口横跨 building 与 demo 两个阶段。原先那句
 * `phase !== 'demo'` 会把前一晚的投票全部挡掉。
 *
 * 缺 voteOpen 的老配置回落到「demo 阶段才开」，与改版前行为一致。
 */
/**
 * 投票开放过没有（开放中，或者已经截止）。
 *
 * 和 voteWindowOpen 分开：那个管「现在还能不能投」，这个管「票数该不该
 * 给人看」。截止之后不能再投，但票数要继续显示到颁奖——用前者判显示，
 * 12:00 一到票数就会从页面上消失。
 */
export function voteStarted(ev: EventRow, now: Date): boolean {
  const at = ev.config?.deadlines?.voteOpen;
  if (at) return now.getTime() >= Date.parse(at);
  return phaseAtLeast(resolvePhase(ev, now), 'demo');
}

function voteWindowOpen(ev: EventRow, now: Date): boolean {
  const d = ev.config?.deadlines;
  const t = now.getTime();
  if (d?.vote && t >= Date.parse(d.vote)) return false;
  if (d?.voteOpen) return t >= Date.parse(d.voteOpen);
  return resolvePhase(ev, now) === 'demo';
}

/** 作品公开地址。硬件作品没有地址，只有照片。 */
/**
 * 作品页面在创意市场里的分类。
 *
 * 必须和 contracts/social.ts 里 BUCKETS 表上那个键一模一样——探索页
 * 「1024 作品」那一格、以及卡片右上角的 1024 徽章都认这个字符串。
 */
const EVENT_APP_CATEGORY = '1024 作品';

function workUrl(kind: string | null, owner: string | null, slug: string | null): string | null {
  return kind === 'page' && owner && slug ? `/${owner}/${slug}/` : null;
}

export function registerEventRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    requireAuth: (req: FastifyRequest) => Promise<User>;
    /** 有会话返回用户，没有或无效返回 null——不抛。活动详情页靠它免登录。 */
    optionalAuth: (req: FastifyRequest) => Promise<User | null>;
    requireAdmin: (req: FastifyRequest) => Promise<User>;
    filesRoot: string;
  },
): void {
  const { sql, requireAuth, optionalAuth, requireAdmin, filesRoot } = deps;

  const loadEvent = async (slug: string): Promise<EventRow> => {
    const rows = await sql<EventRow[]>`
      SELECT id, slug, title, subtitle, edition, venue, starts_at, ends_at, phase, config
        FROM ispace.events WHERE slug = ${slug}
    `;
    const ev = rows[0];
    if (!ev) throw new IspaceError(ERROR_CODES.NOT_FOUND, '活动不存在');
    return ev;
  };

  const isJudge = async (eventId: string, userId: string): Promise<boolean> => {
    const r = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM ispace.event_judges
       WHERE event_id = ${eventId} AND user_id = ${userId}
    `;
    return r.length > 0;
  };

  /** 评委专属接口的门。普通员工打到这里是 403，不是空列表——空列表会让人以为没作品。 */
  const requireJudge = async (req: FastifyRequest, eventId: string): Promise<User> => {
    const me = await requireAuth(req);
    if (me.role === 'admin') return me;
    if (!(await isJudge(eventId, me.id))) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '这个页面只有本届评委能打开');
    }
    return me;
  };

  // ── 活动详情（公开）────────────────────────────────────────────────
  app.get(`${API_BASE}/events/:slug`, async (req): Promise<EventResponse> => {
    const { slug } = req.params as { slug: string };
    const now = new Date();
    const ev = await loadEvent(slug);
    const phase = resolvePhase(ev, now);
    const me = await optionalAuth(req);

    const [judges, counts] = await Promise.all([
      sql<{ username: string; display_name: string }[]>`
        SELECT u.username, u.display_name
          FROM ispace.event_judges j JOIN ispace.users u ON u.id = j.user_id
         WHERE j.event_id = ${ev.id}
         ORDER BY j.sort_order, u.display_name
      `,
      sql<{ ideas: number; finalists: number; works: number; votes: number }[]>`
        SELECT
          (SELECT count(*) FROM ispace.event_ideas WHERE event_id = ${ev.id})                  AS ideas,
          (SELECT count(*) FROM ispace.event_ideas WHERE event_id = ${ev.id} AND finalist)     AS finalists,
          (SELECT count(*) FROM ispace.event_works w JOIN ispace.event_ideas i ON i.id = w.idea_id
            WHERE w.event_id = ${ev.id} AND i.finalist)                                         AS works,
          (SELECT count(*) FROM ispace.event_votes WHERE event_id = ${ev.id})                  AS votes
      `,
    ]);
    const c = counts[0]!;

    /*
      入围名单。初筛结束前一律不返回——参赛须知写着「初筛结束前，创意只有
      评委能看到」，而这个接口是免登录的，一旦在 signup 阶段带上创意，等于
      把所有人的想法挂在公网上。
    */
    const showFinalists = phaseAtLeast(phase, 'building');
    /*
      投票一开放就给票数，投票进行中也给。

      ⚠️ 这是组织者 10.22 晚上定的，是个有代价的选择：实时票数会让靠前的
      更容易被跟投，人气奖因此偏向先领先的那一个。原先的做法是藏到结果
      公布（代码里曾写着「会把投票变成跟票，人气奖的意义就没了」），换成
      现在这样是用那份公正换热闹和拉票的动力。要改回去，把这里换成
      phaseAtLeast(phase, 'result') 就行。

      用 voteStarted 而不是 voteWindowOpen：后者在 12:00 截止那一刻变 false，
      票数会从页面上凭空消失，而那正是大家最想看结果的时候。
    */
    const showVotes = voteStarted(ev, now);

    /*
      一条查询取两份：入围的（不管交没交作品），和没入围但交了作品的——
      后者参与最佳人气奖投票，和入围作品一起摆在活动页上。没入围、也没交
      作品的创意依旧不公开。
    */
    const listed = showFinalists
      ? (await sql<{
          idea_id: string; no: string | null; finalist: boolean; idea_name: string; plan: string;
          who: string; owner_username: string;
          kind: string | null; work_name: string | null; pitch: string | null;
          work_files: EventFile[] | null;
          app_slug: string | null; app_owner: string | null;
          submitted: boolean; votes: number;
        }[]>`
          SELECT i.id AS idea_id, i.finalist_no AS no, i.finalist, i.name AS idea_name, i.plan,
                 u.display_name AS who, u.username AS owner_username,
                 w.kind, w.name AS work_name, w.pitch, w.files AS work_files,
                 a.slug AS app_slug, au.username AS app_owner,
                 (w.id IS NOT NULL) AS submitted,
                 (SELECT count(*) FROM ispace.event_votes v
                   WHERE v.event_id = ${ev.id} AND v.idea_id = i.id) AS votes
            FROM ispace.event_ideas i
            JOIN ispace.users u ON u.id = i.user_id
            LEFT JOIN ispace.event_works w ON w.idea_id = i.id
            LEFT JOIN ispace.apps a ON a.id = w.app_id
            LEFT JOIN ispace.users au ON au.id = a.owner_id
           WHERE i.event_id = ${ev.id} AND (i.finalist OR w.id IS NOT NULL)
           ORDER BY i.finalist DESC, i.finalist_no, w.created_at
        `).map((r) => ({
          finalist: r.finalist,
          ideaId: r.idea_id,
          no: r.no ?? '',
          /* 作品的一句话介绍优先；还没交作品就先用创意里「打算怎么做」。 */
          name: r.work_name ?? r.idea_name,
          desc: r.pitch ?? r.plan,
          who: r.who,
          ownerUsername: r.owner_username,
          kind: (r.kind as 'page' | 'other' | null) ?? null,
          url: workUrl(r.kind, r.app_owner, r.app_slug),
          /* 硬件作品只有照片，没有它页面上就是一片空白 */
          files: r.work_files ?? [],
          submitted: r.submitted,
          votes: showVotes ? Number(r.votes) : null,
        }))
      : [];
    const finalists: EventFinalist[] = listed
      .filter((r) => r.finalist)
      .map(({ finalist: _f, ...r }) => r);
    const openWorks: EventOpenWork[] = listed
      .filter((r) => !r.finalist)
      .map(({ finalist: _f, no: _n, submitted: _s, ...r }) => r);

    /*
      对外 15:10 结果公布才给；组织者（awardPreview 里的人和管理员）在所有
      结果定下之后就能提前拿到，好把颁奖大屏挂上。名单按请求下发、接口不带
      缓存，所以只到她自己这一次请求里，不会顺带给到别人。
    */
    const awards = phaseAtLeast(phase, 'result') || canPreviewAwards(ev, me, now)
      ? await computeAwards(sql, ev)
      : null;

    let meBlock: EventResponse['me'] = null;
    if (me) {
      const [ideaRows, voteRows, judgeFlag] = await Promise.all([
        sql<{
          id: string; name: string; problem: string; plan: string; form: string;
          files: EventFile[]; finalist: boolean; no: string | null;
          work_id: string | null; work_kind: string | null; work_name: string | null;
          pitch: string | null; work_files: EventFile[] | null;
          app_slug: string | null; app_version: number | null;
        }[]>`
          SELECT i.id, i.name, i.problem, i.plan, i.form, i.files,
                 i.finalist, i.finalist_no AS no,
                 w.id AS work_id, w.kind AS work_kind, w.name AS work_name,
                 w.pitch, w.files AS work_files, w.app_version,
                 a.slug AS app_slug
            FROM ispace.event_ideas i
            LEFT JOIN ispace.event_works w ON w.idea_id = i.id
            LEFT JOIN ispace.apps a ON a.id = w.app_id
           WHERE i.event_id = ${ev.id} AND i.user_id = ${me.id}
        `,
        sql<{ idea_id: string }[]>`
          SELECT idea_id FROM ispace.event_votes
           WHERE event_id = ${ev.id} AND user_id = ${me.id}
        `,
        isJudge(ev.id, me.id),
      ]);
      const r = ideaRows[0];
      meBlock = {
        username: me.username,
        displayName: me.displayName,
        idea: r
          ? {
              id: r.id, name: r.name, problem: r.problem, plan: r.plan,
              form: r.form, files: r.files ?? [], finalist: r.finalist, no: r.no,
            }
          : null,
        work: r?.work_id
          ? {
              id: r.work_id,
              kind: r.work_kind as 'page' | 'other',
              name: r.work_name!,
              pitch: r.pitch,
              appSlug: r.app_slug,
              appVersion: r.app_version,
              files: r.work_files ?? [],
            }
          : null,
        votes: voteRows.map((v) => v.idea_id),
        isJudge: judgeFlag,
        isAdmin: me.role === 'admin',
      };
    }

    return {
      event: summary(ev, now),
      judges: judges.map((j) => ({ username: j.username, displayName: j.display_name })),
      stats: {
        ideaCount: Number(c.ideas),
        finalistCount: Number(c.finalists),
        workCount: Number(c.works),
        voteTotal: showVotes ? Number(c.votes) : 0,
        judgeCount: judges.length,
      },
      finalists,
      openWorks,
      awards,
      me: meBlock,
    };
  });

  // ── 交创意 = 报名（需要登录）──────────────────────────────────────
  //
  // PUT 而不是 POST：规则是「每人 1 个创意，截止前可以改」，所以这一下的
  // 语义是「把我的创意设成这样」，重复调用结果相同。
  app.put(`${API_BASE}/events/:slug/idea`, async (req) => {
    const { slug } = req.params as { slug: string };
    const me = await requireAuth(req);
    const ev = await loadEvent(slug);
    const now = new Date();
    const input = ideaInputSchema.parse(req.body);

    const phase = resolvePhase(ev, now);
    const deadline = ev.config?.deadlines?.idea;
    if (phase !== 'signup' || (deadline && now.getTime() >= Date.parse(deadline))) {
      throw new IspaceError(
        ERROR_CODES.FORBIDDEN,
        '交创意已经截止了。想参加下一届可以先把想法记下来。',
      );
    }

    /*
      评委不参赛。

      评委要给所有创意投票排名次，自己也交一个就成了既当选手又当裁判——
      哪怕他回避自己那一票，剩下七票投给谁仍然由他定。赛制上评委压根不该
      有作品，所以在入口就拦住，而不是在投票那头特判"不能投自己"。
    */
    if (await isJudge(ev.id, me.id)) {
      throw new IspaceError(
        ERROR_CODES.FORBIDDEN,
        '评委不参赛。你要给所有创意投票定入围名单，自己交一个就既是选手又是裁判了。',
      );
    }

    const rows = await sql<{ id: string }[]>`
      INSERT INTO ispace.event_ideas
             (event_id, user_id, name, problem, plan, form, files)
      VALUES (${ev.id}, ${me.id}, ${input.name}, ${input.problem}, ${input.plan},
              ${input.form}, ${sql.json(input.files)})
      ON CONFLICT (event_id, user_id) DO UPDATE
         SET name = excluded.name, problem = excluded.problem, plan = excluded.plan,
             form = excluded.form, files = excluded.files, updated_at = now()
      RETURNING id
    `;
    return { ok: true, ideaId: rows[0]!.id };
  });

  // ── 交作品（需要登录 + 交过创意）──────────────────────────────────
  //
  // 没入围的也能交：不路演、评委不打分，只参与最佳人气奖投票。
  app.put(`${API_BASE}/events/:slug/work`, async (req) => {
    const { slug } = req.params as { slug: string };
    const me = await requireAuth(req);
    const ev = await loadEvent(slug);
    const now = new Date();
    const input = workInputSchema.parse(req.body);

    const phase = resolvePhase(ev, now);
    const deadline = ev.config?.deadlines?.work;
    if (!phaseAtLeast(phase, 'building') || (deadline && now.getTime() >= Date.parse(deadline))) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '交作品已经截止了');
    }

    const ideaRows = await sql<{ id: string }[]>`
      SELECT id FROM ispace.event_ideas
       WHERE event_id = ${ev.id} AND user_id = ${me.id}
    `;
    const idea = ideaRows[0];
    if (!idea) throw new IspaceError(ERROR_CODES.NOT_FOUND, '你这届没有交创意');

    /* 换作品时要把上一个页面的 1024 标记摘掉，所以得在覆盖之前记下来 */
    const [prevWork] = await sql<{ app_id: string | null }[]>`
      SELECT app_id FROM ispace.event_works WHERE idea_id = ${idea.id}
    `;
    const prevAppId = prevWork?.app_id ?? null;

    let appId: string | null = null;
    let appVersion: number | null = null;
    let name: string;
    if (input.kind === 'page') {
      /*
        只能选自己的页面，且必须有 active 版本。
        版本号在这里定格：「参评的是提交那一刻的版本」——作者之后继续发布
        不影响评委看到的东西，否则路演前一晚改崩了就会连带把评分毁掉。
      */
      const appRows = await sql<{ id: string; name: string; version: number | null }[]>`
        SELECT a.id, a.name, r.version
          FROM ispace.apps a
          LEFT JOIN ispace.releases r ON r.id = a.current_release_id
         WHERE a.owner_id = ${me.id} AND a.slug = ${input.appSlug} AND a.status <> 'stopped'
      `;
      const found = appRows[0];
      if (!found) throw new IspaceError(ERROR_CODES.NOT_FOUND, '找不到这个页面，或它已停用');
      if (found.version == null) {
        throw new IspaceError(ERROR_CODES.INVALID_INPUT, '这个页面还没有发布成功的版本');
      }
      appId = found.id;
      appVersion = found.version;
      name = found.name;
    } else {
      name = input.name;
    }

    const files = input.kind === 'other' ? input.files : [];
    const rows = await sql<{ id: string }[]>`
      INSERT INTO ispace.event_works
             (event_id, idea_id, kind, app_id, app_version, name, pitch, files)
      VALUES (${ev.id}, ${idea.id}, ${input.kind}, ${appId}, ${appVersion},
              ${name}, ${input.pitch ?? null}, ${sql.json(files)})
      ON CONFLICT (idea_id) DO UPDATE
         SET kind = excluded.kind, app_id = excluded.app_id,
             app_version = excluded.app_version, name = excluded.name,
             pitch = excluded.pitch, files = excluded.files, updated_at = now()
      RETURNING id
    `;

    /*
      作品是页面的话，顺手把它摆到大家看得见的地方。

      ┌─ 两件事都是「交作品」这个动作的应有之义 ──────────────────────────┐
      │ 可见范围 —— 可见性是网关强制的（见 routes/authz.ts 补的那个越权）。 │
      │   拿「仅自己」的页面交作品，活动页上那个「打开作品」别人点进去会被 │
      │   挡住，而投票和评委打分都要先打得开。交上来参赛本身就是同意给全   │
      │   公司看，所以这里直接改，并在返回里告诉他改了。                   │
      │                                                                    │
      │ 上架 + 分类 —— 首页探索那一格「1024 作品」是按 apps.category 归桶  │
      │   的（contracts/social.ts 的 exploreBucket），卡片右上角那个 1024  │
      │   徽章认同一个值。不在这里设，那一格永远是空的——这套机制一直都在， │
      │   只是从来没有哪一步去填它。                                       │
      └────────────────────────────────────────────────────────────────────┘

      会覆盖作者原来选的分类。换作品时把上一个页面的标记摘掉（下面那段），
      免得 1024 那一格里留着他换掉的那一版。
    */
    let shared: { madePublic: boolean; listed: boolean } | null = null;
    if (input.kind === 'page' && appId) {
      const [before] = await sql<{ visibility: string }[]>`
        SELECT visibility FROM ispace.apps WHERE id = ${appId}
      `;
      const madePublic = before?.visibility !== 'public';

      /*
        平台关掉「全公司」共享时不硬来：那是管理员的决定，参赛不该成为
        绕过它的口子。这时作品仍然交得上，只是别人暂时打不开——由组织者
        去把开关打开，而不是让一个活动接口替平台改策略。
      */
      const { allowPublicShare } = await getPlatformPolicy(sql);
      if (allowPublicShare) {
        await sql`
          UPDATE ispace.apps SET visibility = 'public', category = ${EVENT_APP_CATEGORY}
           WHERE id = ${appId}
        `;
        await sql`
          INSERT INTO ispace.marketplace_listings (app_id, published_by, install_count)
          VALUES (${appId}, ${me.id},
                  (SELECT count(*) FROM ispace.app_installs i WHERE i.app_id = ${appId}))
          ON CONFLICT (app_id) DO UPDATE SET published_at = now(),
            install_count = (SELECT count(*) FROM ispace.app_installs i WHERE i.app_id = ${appId})
        `;
        shared = { madePublic, listed: true };
        await writeAudit(sql, {
          actorId: me.id, action: 'app.share', targetType: 'app', targetId: appId,
          source: 'console', result: 'success',
          metadata: { marketplace: true, viaEvent: ev.slug, madePublic },
          ip: req.ip,
        }).catch(() => undefined);
      } else {
        shared = { madePublic: false, listed: false };
      }
    }

    /*
      换了页面的话，把上一个页面的 1024 标记摘掉。
      只在它确实还挂着这个分类时才动，免得清掉作者后来自己改的值。
      上架不撤：下架是比打标记重得多的动作，而且他可能本来就想挂在市场里。
    */
    if (prevAppId && prevAppId !== appId) {
      await sql`
        UPDATE ispace.apps SET category = NULL
         WHERE id = ${prevAppId} AND category = ${EVENT_APP_CATEGORY}
      `;
    }

    return { ok: true, workId: rows[0]!.id, appVersion, shared };
  });

  // ── 投票（需要登录）──────────────────────────────────────────────
  //
  // 一下 POST 是开关：投过就撤回。设计稿上那颗按钮本来就是这个行为
  // （「已投」再点变回「投一票」），分成两个端点只会让前端自己记状态。
  app.post(`${API_BASE}/events/:slug/votes/:ideaId`, async (req) => {
    const { slug, ideaId } = req.params as { slug: string; ideaId: string };
    const me = await requireAuth(req);
    const ev = await loadEvent(slug);
    const now = new Date();

    if (!voteWindowOpen(ev, now)) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '投票还没开始，或者已经截止了');
    }

    /* 能投的：入围作品，和没入围但交了作品的（它们一起竞逐最佳人气奖） */
    const ideaRows = await sql<{ id: string; user_id: string }[]>`
      SELECT i.id, i.user_id FROM ispace.event_ideas i
       WHERE i.id = ${ideaId} AND i.event_id = ${ev.id}
         AND (i.finalist OR EXISTS (SELECT 1 FROM ispace.event_works w WHERE w.idea_id = i.id))
    `;
    const idea = ideaRows[0];
    if (!idea) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这个作品不在投票名单里');
    if (idea.user_id === me.id) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '不能投给自己');
    }

    const existing = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM ispace.event_votes
       WHERE event_id = ${ev.id} AND idea_id = ${ideaId} AND user_id = ${me.id}
    `;
    if (existing.length > 0) {
      await sql`
        DELETE FROM ispace.event_votes
         WHERE event_id = ${ev.id} AND idea_id = ${ideaId} AND user_id = ${me.id}
      `;
      const left = await remainingVotes(sql, ev, me.id);
      return { ok: true, voted: false, remaining: left };
    }

    /*
      票数上限只能在这里数——它是跨行的约束，库层面钉不住。
      并发点两下有可能双双通过检查而超投一票；换成 serializable 事务或
      行级锁能堵上，但代价是给一个「手快点了两下」的场景上锁。这里选择
      先这样，并在 remaining 返回真实剩余票数，前端据此纠正显示。
    */
    const limit = ev.config?.voteLimit ?? 3;
    const used = await sql<{ n: number }[]>`
      SELECT count(*) AS n FROM ispace.event_votes
       WHERE event_id = ${ev.id} AND user_id = ${me.id}
    `;
    if (Number(used[0]!.n) >= limit) {
      throw new IspaceError(
        ERROR_CODES.FORBIDDEN,
        `${limit} 票都投完了，想换就先撤回一票`,
      );
    }

    await sql`
      INSERT INTO ispace.event_votes (event_id, idea_id, user_id)
      VALUES (${ev.id}, ${ideaId}, ${me.id})
      ON CONFLICT DO NOTHING
    `;
    return { ok: true, voted: true, remaining: await remainingVotes(sql, ev, me.id) };
  });

  // ── 评委打分页数据（需要登录 + 评委）─────────────────────────────
  app.get(`${API_BASE}/events/:slug/judge`, async (req): Promise<EventJudgeResponse> => {
    const { slug } = req.params as { slug: string };
    const ev = await loadEvent(slug);
    const me = await requireJudge(req, ev.id);
    const now = new Date();

    const [rows, judgeCount] = await Promise.all([
      sql<{
        idea_id: string; no: string; idea_name: string; plan: string;
        who: string; kind: string | null; work_name: string | null; pitch: string | null;
        work_files: EventFile[] | null;
        app_slug: string | null; app_owner: string | null;
        dims: (number | null)[] | null; total: number | null;
        note: string | null; submitted: boolean;
        others: number;
      }[]>`
        SELECT i.id AS idea_id, i.finalist_no AS no, i.name AS idea_name, i.plan,
               u.display_name AS who,
               w.kind, w.name AS work_name, w.pitch, w.files AS work_files,
               a.slug AS app_slug, au.username AS app_owner,
               s.dims, s.total, s.note, (s.submitted_at IS NOT NULL) AS submitted,
               (SELECT count(*) FROM ispace.event_scores o
                 WHERE o.event_id = ${ev.id} AND o.idea_id = i.id
                   AND o.judge_id <> ${me.id} AND o.submitted_at IS NOT NULL) AS others
          FROM ispace.event_ideas i
          JOIN ispace.users u ON u.id = i.user_id
          LEFT JOIN ispace.event_works w ON w.idea_id = i.id
          LEFT JOIN ispace.apps a ON a.id = w.app_id
          LEFT JOIN ispace.users au ON au.id = a.owner_id
          LEFT JOIN ispace.event_scores s
                 ON s.idea_id = i.id AND s.judge_id = ${me.id} AND s.event_id = ${ev.id}
         WHERE i.event_id = ${ev.id} AND i.finalist
         ORDER BY i.finalist_no
      `,
      sql<{ n: number }[]>`
        SELECT count(*) AS n FROM ispace.event_judges WHERE event_id = ${ev.id}
      `,
    ]);

    const criteria = ev.config?.criteria ?? [];
    const items: EventJudgeItem[] = rows.map((r) => ({
      ideaId: r.idea_id,
      no: r.no,
      name: r.work_name ?? r.idea_name,
      who: r.who,
      desc: r.pitch ?? r.plan,
      kind: (r.kind as 'page' | 'other' | null) ?? null,
      url: workUrl(r.kind, r.app_owner, r.app_slug),
      /* 硬件作品只有照片。不给的话评委是对着一个名字打分。 */
      files: r.work_files ?? [],
      mine: r.dims
        ? {
            dims: r.dims,
            total: r.total ?? 0,
            note: r.note ?? '',
            submitted: r.submitted,
          }
        : null,
      othersSubmitted: Number(r.others),
    }));

    return {
      event: summary(ev, now),
      criteria,
      otherJudges: Math.max(0, Number(judgeCount[0]!.n) - 1),
      locked: !scoringWindow(ev, now).open,
      lockReason: scoringWindow(ev, now).reason,
      items,
    };
  });

  // ── 打分（需要登录 + 评委）───────────────────────────────────────
  app.put(`${API_BASE}/events/:slug/scores/:ideaId`, async (req) => {
    const { slug, ideaId } = req.params as { slug: string; ideaId: string };
    const ev = await loadEvent(slug);
    const me = await requireJudge(req, ev.id);
    const now = new Date();
    const input = scoreInputSchema.parse(req.body);

    const win = scoringWindow(ev, now);
    if (!win.open) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, win.reason ?? '现在不能打分');
    }

    const criteria = ev.config?.criteria ?? [];
    if (input.dims.length !== criteria.length) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        `要给 ${criteria.length} 个维度打分，收到 ${input.dims.length} 个`,
      );
    }
    /*
      每一项都不能超过自己的上限。不校验的话前端传个 {dims:[999,0,0,0]}
      就能把总分推到天上去，而名次是按总分排的。
    */
    for (let i = 0; i < criteria.length; i += 1) {
      const max = criteria[i]!.max;
      if (input.dims[i]! > max) {
        throw new IspaceError(
          ERROR_CODES.INVALID_INPUT,
          `「${criteria[i]!.key}」最多 ${max} 分`,
        );
      }
    }
    const total = input.dims.reduce((n, x) => n + x, 0);

    const exists = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM ispace.event_ideas
       WHERE id = ${ideaId} AND event_id = ${ev.id} AND finalist
    `;
    if (exists.length === 0) {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, '这个作品不在入围名单里');
    }

    /*
      AS s 这个别名是必须的：ON CONFLICT DO UPDATE 里要读「已存在的那一行」，
      而 INSERT INTO 写的是 schema 限定名。给个别名，SET 里的 s.submitted_at
      就毫无歧义地指向旧值。
    */
    await sql`
      INSERT INTO ispace.event_scores AS s
             (event_id, idea_id, judge_id, dims, total, note, submitted_at)
      VALUES (${ev.id}, ${ideaId}, ${me.id},
              ${sql.json(input.dims)}, ${total},
              ${input.note ?? null}, ${input.submit ? now : null})
      ON CONFLICT (event_id, idea_id, judge_id) DO UPDATE
         SET dims = excluded.dims, total = excluded.total, note = excluded.note,
             /* 提交过就不因为存草稿而退回未提交——只会往前，不会往后 */
             submitted_at = COALESCE(excluded.submitted_at, s.submitted_at),
             updated_at = now()
    `;
    return { ok: true, total, submitted: input.submit };
  });

  // ── 本届全部创意（管理员）────────────────────────────────────────
  //
  // 为什么要单开一条：公开接口在初筛结束前一个创意都不返回（见文件头那条
  // 规则），而定入围名单的人恰恰要在那之前把全部创意摊开看。给公开接口加个
  // 「我是管理员所以多给我一点」的开关，等于把免登录接口的返回形状做成
  // 随身份变化的——那是越权最容易藏身的地方。
  // ── 初筛投票（评委）──────────────────────────────────────────────
  /**
   * 评委从全部创意里挑出他认为该入围的。
   *
   * 窗口是 screening 阶段：创意已截止、名单还没公布。之前创意还在改，
   * 对着半成品投没意义；之后名单已经对外了，再改票也晚了。
   *
   * 窗口之外仍然让评委**看**得到创意——提前读一遍是本来就该做的事，
   * 只是投不了。所以这里不拦读取，只在 open 上说明能不能投。
   */
  const screeningState = (ev: EventRow, now: Date) => {
    const phase = resolvePhase(ev, now);
    const limit = ev.config?.screeningVoteLimit ?? 0;
    const slots = ev.config?.screeningSlots ?? 0;
    const shut = { limit, slots, open: false };
    if (limit <= 0) return { ...shut, limit: 0, reason: '本届不走初筛投票' };
    if (phase === 'signup') {
      return {
        ...shut,
        reason: `创意 ${mdhm(ev.config?.deadlines?.idea)} 截止，截止后才开始投票`,
      };
    }
    if (phase !== 'screening') {
      return { ...shut, reason: '入围名单已经公布，初筛投票已结束' };
    }
    /*
      投票比阶段早结束半小时。

      阶段还是 screening（名单没公布），但票已经封存。20:00 一到入围名单就
      自动定下来（jobs/event-finalists.ts），那半小时留给组织者在控制台核对、
      调整路演顺序，以及处理扩到 9 个都装不下的那种同票。退回用 screening 是为了往届：它们的配置
      里没有 screeningVote，那时投票本来就开到公布为止。
    */
    const shutAt = ev.config?.deadlines?.screeningVote;
    if (shutAt && now.getTime() >= Date.parse(shutAt)) {
      return {
        ...shut,
        reason: `投票 ${mdhm(shutAt)} 已截止，票数封存。`
          + `${mdhm(ev.config?.deadlines?.screening)} 公布入围名单。`,
      };
    }
    return { limit, slots, open: true, reason: null as string | null };
  };

  /** 名单公布了没有。公布之后才让人看见票数。 */
  const screeningResultsOpen = (ev: EventRow, now: Date) =>
    phaseAtLeast(resolvePhase(ev, now), 'building');

  /**
   * 初筛得票榜。同票怎么处理见 rankScreening 上的说明（第 8 名同票扩到
   * 9 个；扩到 9 个还装不下才交给人定）。
   */
  const screeningRanking = async (ev: EventRow): Promise<EventScreeningRankRow[]> => {
    const rows = await sql<{ id: string; name: string; who: string; votes: number }[]>`
      SELECT i.id, i.name, u.display_name AS who,
             count(v.judge_id)::int AS votes
        FROM ispace.event_ideas i
        JOIN ispace.users u ON u.id = i.user_id
        LEFT JOIN ispace.event_screening_votes v
               ON v.event_id = i.event_id AND v.idea_id = i.id
       WHERE i.event_id = ${ev.id}
       GROUP BY i.id, i.name, u.display_name, i.created_at
       ORDER BY count(v.judge_id) DESC, i.created_at
    `;
    return rankScreening(rows, ev.config?.screeningSlots ?? 0);
  };

  app.get(`${API_BASE}/events/:slug/judge/screening`, async (req): Promise<EventScreeningResponse> => {
    const { slug } = req.params as { slug: string };
    const ev = await loadEvent(slug);
    const me = await requireJudge(req, ev.id);
    const now = new Date();
    const st = screeningState(ev, now);

    const rows = await sql<{
      id: string; name: string; problem: string; plan: string; form: string;
      files: EventFile[] | null; who: string; owner_id: string; voted: boolean;
    }[]>`
      SELECT i.id, i.name, i.problem, i.plan, i.form, i.files,
             u.display_name AS who, i.user_id AS owner_id,
             (v.judge_id IS NOT NULL) AS voted
        FROM ispace.event_ideas i
        JOIN ispace.users u ON u.id = i.user_id
        LEFT JOIN ispace.event_screening_votes v
               ON v.event_id = i.event_id AND v.idea_id = i.id AND v.judge_id = ${me.id}
       WHERE i.event_id = ${ev.id}
       ORDER BY i.created_at
    `;

    /* 交卷进度：数到几个人交了，不碰谁投了什么 */
    const [subs] = await sql<{ mine: boolean; total: number; judges: number }[]>`
      SELECT bool_or(s.judge_id = ${me.id}) AS mine,
             count(s.judge_id)::int        AS total,
             (SELECT count(*)::int FROM ispace.event_judges WHERE event_id = ${ev.id}) AS judges
        FROM ispace.event_screening_submits s
       WHERE s.event_id = ${ev.id}
    `;

    const resultsOpen = screeningResultsOpen(ev, now);
    return {
      event: summary(ev, now),
      limit: st.limit,
      slots: st.slots,
      used: rows.filter((r) => r.voted).length,
      submitted: subs?.mine ?? false,
      submittedCount: subs?.total ?? 0,
      judgeCount: subs?.judges ?? 0,
      open: st.open,
      closedReason: st.reason,
      resultsOpen,
      ranking: resultsOpen ? await screeningRanking(ev) : null,
      items: rows.map((r) => ({
        ideaId: r.id,
        name: r.name,
        problem: r.problem,
        plan: r.plan,
        form: r.form,
        files: r.files ?? [],
        who: r.who,
        mine: r.owner_id === me.id,
        voted: r.voted,
      })),
    };
  });

  /**
   * 交卷 / 撤回交卷。
   *
   * 必须投满。投到一半就走开，等于这个人的票权被稀释——而得票是拿来排名次
   * 的，少投的人实际上降低了所有人的区分度。所以差一票也不收。
   *
   * 交卷只管两件事：把票锁住，以及让组织者看到谁投完了。**它不决定票算不
   * 算**——screeningRanking、控制台的 screening-tally、20:00 的自动入围都
   * 数库里全部的票，不看交卷表。组织者定的：到点没交卷的评委，票照样有效。
   */
  app.post(`${API_BASE}/events/:slug/judge/screening/submit`, async (req) => {
    const { slug } = req.params as { slug: string };
    const ev = await loadEvent(slug);
    const me = await requireJudge(req, ev.id);
    const st = screeningState(ev, new Date());
    if (!st.open) throw new IspaceError(ERROR_CODES.FORBIDDEN, st.reason ?? '现在不能投票');

    const [c] = await sql<{ n: number }[]>`
      SELECT count(*) AS n FROM ispace.event_screening_votes
       WHERE event_id = ${ev.id} AND judge_id = ${me.id}
    `;
    const used = Number(c!.n);
    if (used < st.limit) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        `还剩 ${st.limit - used} 票没投，投满 ${st.limit} 票才能提交`,
      );
    }

    await sql`
      INSERT INTO ispace.event_screening_submits (event_id, judge_id)
      VALUES (${ev.id}, ${me.id})
      ON CONFLICT (event_id, judge_id) DO NOTHING
    `;
    return { ok: true, submitted: true };
  });

  /** 撤回交卷，票重新可改。截止前随时可以。 */
  app.delete(`${API_BASE}/events/:slug/judge/screening/submit`, async (req) => {
    const { slug } = req.params as { slug: string };
    const ev = await loadEvent(slug);
    const me = await requireJudge(req, ev.id);
    const st = screeningState(ev, new Date());
    if (!st.open) throw new IspaceError(ERROR_CODES.FORBIDDEN, st.reason ?? '投票已截止，改不了了');

    await sql`
      DELETE FROM ispace.event_screening_submits
       WHERE event_id = ${ev.id} AND judge_id = ${me.id}
    `;
    return { ok: true, submitted: false };
  });

  /** 投/撤一票。和人气奖那颗按钮一样是开关：投过再点就是撤回。 */
  app.post(`${API_BASE}/events/:slug/judge/screening/:ideaId`, async (req) => {
    const { slug, ideaId } = req.params as { slug: string; ideaId: string };
    const ev = await loadEvent(slug);
    const me = await requireJudge(req, ev.id);
    const st = screeningState(ev, new Date());

    if (!st.open) throw new IspaceError(ERROR_CODES.FORBIDDEN, st.reason ?? '现在不能投票');

    /*
      交过卷就锁住。不锁的话「已提交」只是个标签——交完还能随手改一票，
      而别的评委那边显示的是「他已经交了」。
    */
    const [done] = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM ispace.event_screening_submits
       WHERE event_id = ${ev.id} AND judge_id = ${me.id}
    `;
    if (done) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '已经提交了。要改先点「修改投票」。');
    }

    const [idea] = await sql<{ user_id: string }[]>`
      SELECT user_id FROM ispace.event_ideas
       WHERE id = ${ideaId} AND event_id = ${ev.id}
    `;
    if (!idea) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这条创意');
    if (idea.user_id === me.id) {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '不能投给自己的创意');
    }

    const countMine = async () => {
      const [r] = await sql<{ n: number }[]>`
        SELECT count(*) AS n FROM ispace.event_screening_votes
         WHERE event_id = ${ev.id} AND judge_id = ${me.id}
      `;
      return Number(r!.n);
    };

    const [existing] = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM ispace.event_screening_votes
       WHERE event_id = ${ev.id} AND idea_id = ${ideaId} AND judge_id = ${me.id}
    `;
    if (existing) {
      await sql`
        DELETE FROM ispace.event_screening_votes
         WHERE event_id = ${ev.id} AND idea_id = ${ideaId} AND judge_id = ${me.id}
      `;
      return { ok: true, voted: false, remaining: st.limit - (await countMine()) };
    }

    /*
      上限是跨行约束，库层面钉不住，只能在这里数——与人气奖那条同样的
      取舍（见 /votes/:ideaId）：连点两下有可能双双通过检查而超投一票，
      所以返回真实剩余票数，前端据此纠正显示。
    */
    if ((await countMine()) >= st.limit) {
      throw new IspaceError(
        ERROR_CODES.FORBIDDEN,
        `${st.limit} 票已经投完了，想换就先撤回一票`,
      );
    }
    await sql`
      INSERT INTO ispace.event_screening_votes (event_id, idea_id, judge_id)
      VALUES (${ev.id}, ${ideaId}, ${me.id})
      ON CONFLICT DO NOTHING
    `;
    return { ok: true, voted: true, remaining: st.limit - (await countMine()) };
  });

  /**
   * 初筛得票汇总（管理员）。定名单的依据，不是名单本身——平票、临时弃赛、
   * 一个人占两个名额这类情况都要人来判断，所以最终仍由控制台提交。
   */
  app.get(`${API_BASE}/events/:slug/screening-tally`, async (req): Promise<{
    rows: EventScreeningTallyRow[]; judgesVoted: number; judgeCount: number;
  }> => {
    const { slug } = req.params as { slug: string };
    await requireAdmin(req);
    const ev = await loadEvent(slug);

    const [rows, voted, judges] = await Promise.all([
      sql<{ id: string; name: string; who: string; votes: number; finalist: boolean }[]>`
        SELECT i.id, i.name, u.display_name AS who, i.finalist,
               (SELECT count(*) FROM ispace.event_screening_votes v
                 WHERE v.event_id = ${ev.id} AND v.idea_id = i.id) AS votes
          FROM ispace.event_ideas i
          JOIN ispace.users u ON u.id = i.user_id
         WHERE i.event_id = ${ev.id}
         ORDER BY votes DESC, i.created_at
      `,
      sql<{ n: number }[]>`
        SELECT count(DISTINCT judge_id) AS n FROM ispace.event_screening_votes
         WHERE event_id = ${ev.id}
      `,
      sql<{ n: number }[]>`
        SELECT count(*) AS n FROM ispace.event_judges WHERE event_id = ${ev.id}
      `,
    ]);

    return {
      rows: rows.map((r) => ({
        ideaId: r.id, name: r.name, who: r.who,
        votes: Number(r.votes), finalist: r.finalist,
      })),
      judgesVoted: Number(voted[0]!.n),
      judgeCount: Number(judges[0]!.n),
    };
  });

  app.get(`${API_BASE}/events/:slug/ideas`, async (req): Promise<EventIdeasResponse> => {
    const { slug } = req.params as { slug: string };
    await requireAdmin(req);
    const ev = await loadEvent(slug);

    const rows = await sql<{
      id: string; name: string; problem: string; plan: string; form: string;
      files: EventFile[] | null; who: string; username: string;
      finalist: boolean; no: string | null; submitted: boolean; created_at: Date;
    }[]>`
      SELECT i.id, i.name, i.problem, i.plan, i.form, i.files,
             u.display_name AS who, u.username,
             i.finalist, i.finalist_no AS no,
             (w.id IS NOT NULL) AS submitted,
             i.created_at
        FROM ispace.event_ideas i
        JOIN ispace.users u ON u.id = i.user_id
        LEFT JOIN ispace.event_works w ON w.idea_id = i.id
       WHERE i.event_id = ${ev.id}
       ORDER BY i.created_at
    `;

    return {
      ideas: rows.map((r): EventAdminIdea => ({
        id: r.id,
        name: r.name,
        problem: r.problem,
        plan: r.plan,
        form: r.form,
        files: r.files ?? [],
        who: r.who,
        username: r.username,
        finalist: r.finalist,
        no: r.no,
        submitted: r.submitted,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  // ── 汇总排名（管理员）────────────────────────────────────────────
  //
  // 这就是「评委评分汇总到项目上」的出口：按八位评委已提交分数的平均分
  // 排名次，一、二、三等奖照它定。只给管理员——结果公布前它等于提前泄露
  // 名次，公布后普通人看 awards 那块就够了。
  app.get(`${API_BASE}/events/:slug/ranking`, async (req) => {
    const { slug } = req.params as { slug: string };
    await requireAdmin(req);
    const ev = await loadEvent(slug);
    return { ranking: await computeRanking(sql, ev) };
  });

  // ── 管理：阶段、入围名单、评委 ───────────────────────────────────
  app.patch(`${API_BASE}/events/:slug`, async (req) => {
    const { slug } = req.params as { slug: string };
    await requireAdmin(req);
    const ev = await loadEvent(slug);
    const input = eventAdminSchema.parse(req.body);

    if (input.phase !== undefined) {
      await sql`
        UPDATE ispace.events SET phase = ${input.phase}, updated_at = now()
         WHERE id = ${ev.id}
      `;
    }

    if (input.config !== undefined) {
      // 整块替换而不是合并：config 是一份人工维护的文案，半自动合并出来的
      // 中间状态没人能看懂。调用方传完整的那一份。
      await sql`
        UPDATE ispace.events
           SET config = ${sql.json(input.config as never)}, updated_at = now()
         WHERE id = ${ev.id}
      `;
    }

    if (input.finalists) {
      /*
        入围名单整批设定：先全部清掉再按给定顺序编号。
        编号就是路演顺序，所以顺序是入参的一部分，不是按创意提交时间排。

        用事务：清空与重编号之间若有读，会看到「一个入围的都没有」。
        活动页在那一瞬间刷新就会显示空名单。
      */
      await sql.begin(async (tx) => {
        await tx`
          UPDATE ispace.event_ideas SET finalist = false, finalist_no = NULL, updated_at = now()
           WHERE event_id = ${ev.id} AND finalist
        `;
        for (let i = 0; i < input.finalists!.length; i += 1) {
          const no = String(i + 1).padStart(2, '0');
          const r = await tx<{ id: string }[]>`
            UPDATE ispace.event_ideas
               SET finalist = true, finalist_no = ${no}, updated_at = now()
             WHERE id = ${input.finalists![i]!} AND event_id = ${ev.id}
            RETURNING id
          `;
          if (!r[0]) {
            throw new IspaceError(
              ERROR_CODES.NOT_FOUND,
              `创意 ${input.finalists![i]} 不属于本届活动`,
            );
          }
        }
      });
    }

    if (input.judges) {
      const found = await sql<{ id: string; username: string }[]>`
        SELECT id, username FROM ispace.users
         WHERE username = ANY(${input.judges}) AND status = 'active'
      `;
      const missing = input.judges.filter((u) => !found.some((f) => f.username === u));
      if (missing.length > 0) {
        throw new IspaceError(
          ERROR_CODES.NOT_FOUND,
          `找不到这些账号：${missing.join('、')}`,
        );
      }
      await sql.begin(async (tx) => {
        await tx`DELETE FROM ispace.event_judges WHERE event_id = ${ev.id}`;
        for (let i = 0; i < input.judges!.length; i += 1) {
          const u = found.find((f) => f.username === input.judges![i])!;
          await tx`
            INSERT INTO ispace.event_judges (event_id, user_id, sort_order)
            VALUES (${ev.id}, ${u.id}, ${i})
          `;
        }
      });
    }

    const after = await loadEvent(slug);
    return { event: summary(after, new Date()) };
  });

  // ── 附件上传与读取 ──────────────────────────────────────────────
  //
  // 为什么自己存而不是走页面发布那条路：那条路的产物是一个网站（解压 zip、
  // 切软链、注入 shell.js），而这里只是几张图。
  //
  // 为什么读取也经过本服务、不直接丢给 Caddy：初筛结束前创意只有评委能看到，
  // 附件是创意的一部分。靠 uuid 文件名「猜不到」不是访问控制——平台刚补过
  // 一个正是这样想出来的越权（见 routes/authz.ts）。
  app.post(`${API_BASE}/events/:slug/files`, async (req) => {
    const { slug } = req.params as { slug: string };
    const me = await requireAuth(req);
    const ev = await loadEvent(slug);

    const part = await req.file({ limits: { fileSize: MAX_FILE_BYTES } });
    if (!part) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '没有收到文件');

    const ext = ALLOWED_FILE_TYPES[part.mimetype];
    if (!ext) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        '只能传图片（PNG/JPG/WebP/GIF）、视频（MP4/MOV）或 PDF',
      );
    }

    const id = `${randomUUID()}${ext}`;
    const dir = join(filesRoot, ev.slug);
    await mkdir(dir, { recursive: true });
    const dest = join(dir, id);
    await pipeline(part.file, createWriteStream(dest));
    /*
      multipart 的 fileSize 限制是「截断」而不是「报错」：超限时 part.file
      上的 truncated 会被置位，但前面的字节已经写进去了。必须显式检查，
      否则用户以为传上去了，拿到的是一张只有上半截的图。
    */
    if (part.file.truncated) {
      // 已经落地的半截文件没有任何引用，留着只会攒垃圾
      await rm(dest, { force: true });
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        `文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限`,
      );
    }
    const s = await stat(dest);

    await sql`
      INSERT INTO ispace.audit_logs
             (actor_id, action, target_type, target_id, source, result, metadata)
      VALUES (${me.id}, 'event.file.upload', 'event_file', ${`${ev.slug}/${id}`},
              'console', 'success',
              ${sql.json({ size: s.size, mime: part.mimetype })})
    `.catch(() => undefined);

    return {
      file: {
        name: part.filename,
        size: s.size,
        url: `${API_BASE}/events/${ev.slug}/files/${id}`,
      } satisfies EventFile,
    };
  });

  app.get(`${API_BASE}/events/:slug/files/:id`, async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string };
    const ev = await loadEvent(slug);

    /*
      文件名由服务端生成（uuid + 白名单后缀），但进来的这一下是用户给的字符串。
      不校验形态的话 ../../ 能把这个端点变成任意文件读取。
    */
    if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(id)) {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, '附件不存在');
    }

    const refs = await sql<{ owner_id: string; finalist: boolean; is_work: boolean }[]>`
      SELECT i.user_id AS owner_id, i.finalist, false AS is_work
        FROM ispace.event_ideas i
       WHERE i.event_id = ${ev.id} AND i.files::text LIKE ${`%${id}%`}
      UNION ALL
      SELECT i.user_id AS owner_id, i.finalist, true AS is_work
        FROM ispace.event_works w JOIN ispace.event_ideas i ON i.id = w.idea_id
       WHERE w.event_id = ${ev.id} AND w.files::text LIKE ${`%${id}%`}
    `;
    const ref = refs[0];
    if (!ref) throw new IspaceError(ERROR_CODES.NOT_FOUND, '附件不存在');

    /*
      谁能看：
        作品附件 —— 入围名单公开之后就是公开的（它要显示在活动页上）。
                    没入围交上来的作品也摆在活动页上参与投票，一样公开
        创意附件 —— 只有本人、评委、管理员。「初筛结束前创意只有评委能看到」
    */
    const phase = resolvePhase(ev, new Date());
    let allowed = ref.is_work && phaseAtLeast(phase, 'building');
    if (!allowed) {
      const me = await optionalAuth(req);
      allowed = !!me && (
        me.id === ref.owner_id || me.role === 'admin' || await isJudge(ev.id, me.id)
      );
    }
    if (!allowed) throw new IspaceError(ERROR_CODES.FORBIDDEN, '这个附件现在还不能看');

    const path = join(filesRoot, ev.slug, id);
    const mime = Object.entries(ALLOWED_FILE_TYPES)
      .find(([, e]) => e === extname(id))?.[0] ?? 'application/octet-stream';
    try {
      await stat(path);
    } catch {
      throw new IspaceError(ERROR_CODES.NOT_FOUND, '附件不存在');
    }
    return reply
      .type(mime)
      /*
        附件由用户上传，哪怕后缀在白名单里也不该让浏览器**决定**怎么渲染它。
        nosniff 把 Content-Type 钉死；inline 让图片能直接显示在页面上。
      */
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .send(createReadStream(path));
  });
}

/** 我还剩几票。撤回与投出都返回它，让前端不必自己算。 */
async function remainingVotes(sql: Sql, ev: EventRow, userId: string): Promise<number> {
  const limit = ev.config?.voteLimit ?? 3;
  const r = await sql<{ n: number }[]>`
    SELECT count(*) AS n FROM ispace.event_votes
     WHERE event_id = ${ev.id} AND user_id = ${userId}
  `;
  return Math.max(0, limit - Number(r[0]!.n));
}

/**
 * 按评委平均分排名次。
 *
 * 只计**已提交**的分数（submitted_at 非空）：草稿是评委还在拖滑块的中间
 * 状态，拿它参与排名会让名次在打分过程中乱跳。
 *
 * 平均而不是求和：评委可能有人没打完，求和会让「少一个人打分」直接等于
 * 低一档名次。平均保留了可比性，同时 judged 把「这个名次由几个人给出」
 * 一并交出去，让调用方知道它够不够硬。
 *
 * 没入围但交了作品的也在列表里（no 为 null）：评委不给它们打分，所以永远
 * 没有名次、拿不到一二三等奖，只在按票数排的人气奖里有份。
 */
export async function computeRanking(sql: Sql, ev: EventRow): Promise<EventRankRow[]> {
  const rows = await sql<{
    idea_id: string; no: string | null; idea_name: string; work_name: string | null;
    who: string; avg_total: string | null; judged: number; votes: number;
  }[]>`
    SELECT i.id AS idea_id, i.finalist_no AS no, i.name AS idea_name,
           w.name AS work_name, u.display_name AS who,
           avg(s.total) FILTER (WHERE s.submitted_at IS NOT NULL) AS avg_total,
           count(s.judge_id) FILTER (WHERE s.submitted_at IS NOT NULL) AS judged,
           (SELECT count(*) FROM ispace.event_votes v
             WHERE v.event_id = ${ev.id} AND v.idea_id = i.id) AS votes
      FROM ispace.event_ideas i
      JOIN ispace.users u ON u.id = i.user_id
      LEFT JOIN ispace.event_works w ON w.idea_id = i.id
      LEFT JOIN ispace.event_scores s ON s.idea_id = i.id AND s.event_id = ${ev.id}
     WHERE i.event_id = ${ev.id} AND (i.finalist OR w.id IS NOT NULL)
     GROUP BY i.id, i.finalist_no, i.name, w.name, w.created_at, u.display_name
     ORDER BY avg_total DESC NULLS LAST, votes DESC, i.finalist_no NULLS LAST, w.created_at
  `;

  let rank = 0;
  return rows.map((r) => {
    const score = r.avg_total == null ? null : Math.round(Number(r.avg_total) * 10) / 10;
    if (score != null) rank += 1;
    return {
      ideaId: r.idea_id,
      no: r.no,
      name: r.work_name ?? r.idea_name,
      who: r.who,
      judgeScore: score,
      judged: Number(r.judged),
      votes: Number(r.votes),
      rank: score == null ? null : rank,
    };
  });
}

/**
 * 获奖名单：把排名按 config.awardRules 映射成奖项。
 *
 * 一、二、三等奖看评委平均分名次，最佳人气奖看票数名次——设计稿上写得
 * 很清楚：「路演作品全靠评委打分排名次……现场扫码投票只用来选最佳人气奖」。
 */
export async function computeAwards(sql: Sql, ev: EventRow): Promise<EventAward[]> {
  const ranking = await computeRanking(sql, ev);
  if (ranking.length === 0) return [];

  const byVotes = [...ranking].sort((a, b) => b.votes - a.votes);
  const rules = ev.config?.awardRules ?? [];

  const meta = await sql<{
    idea_id: string; kind: string | null; app_slug: string | null;
    app_owner: string | null; note: string | null; plan: string; pitch: string | null;
    author: string; avatar: string | null;
  }[]>`
    SELECT i.id AS idea_id, w.kind, a.slug AS app_slug, au.username AS app_owner,
           i.plan, w.pitch, iu.username AS author, ua.etag AS avatar,
           (SELECT s.note FROM ispace.event_scores s
             WHERE s.idea_id = i.id AND s.submitted_at IS NOT NULL
               AND s.note IS NOT NULL AND length(trim(s.note)) > 0
             ORDER BY s.submitted_at LIMIT 1) AS note
      FROM ispace.event_ideas i
      JOIN ispace.users iu ON iu.id = i.user_id
      LEFT JOIN ispace.user_avatars ua ON ua.user_id = i.user_id
      LEFT JOIN ispace.event_works w ON w.idea_id = i.id
      LEFT JOIN ispace.apps a ON a.id = w.app_id
      LEFT JOIN ispace.users au ON au.id = a.owner_id
     WHERE i.event_id = ${ev.id} AND (i.finalist OR w.id IS NOT NULL)
  `;
  const metaById = new Map(meta.map((m) => [m.idea_id, m]));

  /*
    各维度的评委平均分，颁奖大屏那四条分项柱要用。

    在 JS 里按下标平均而不是写 SQL：维度个数由 config.criteria 决定
    （本届 4 个，明年可能不是），SQL 里拆 jsonb 数组要按固定下标展开，
    改维度数就得改这条查询。
  */
  const dimRows = await sql<{ idea_id: string; dims: number[] }[]>`
    SELECT idea_id, dims FROM ispace.event_scores
     WHERE event_id = ${ev.id} AND submitted_at IS NOT NULL
  `;
  const dimsById = new Map<string, number[]>();
  const dimCount = new Map<string, number>();
  for (const r of dimRows) {
    if (!Array.isArray(r.dims)) continue;
    const acc = dimsById.get(r.idea_id) ?? r.dims.map(() => 0);
    r.dims.forEach((v, i) => { acc[i] = (acc[i] ?? 0) + (Number(v) || 0); });
    dimsById.set(r.idea_id, acc);
    dimCount.set(r.idea_id, (dimCount.get(r.idea_id) ?? 0) + 1);
  }
  const avgDims = (ideaId: string): number[] | null => {
    const acc = dimsById.get(ideaId);
    const n = dimCount.get(ideaId) ?? 0;
    if (!acc || n === 0) return null;
    return acc.map((v) => Math.round((v / n) * 10) / 10);
  };

  const out: EventAward[] = [];
  /*
    已经拿过奖的作品。`exclusive` 的奖项要跳过它们——本届规则写明
    「最佳人气奖与一二三等奖互斥」，不然票王同时是评委第一名时会一个人
    抱走两个奖。按 awardRules 的声明顺序结算，所以互斥的奖排在后面。
  */
  const taken = new Set<string>();
  for (const rule of rules) {
    // 入围奖人人有份，不是一个名次，不进获奖名单那块（它在奖项列表里说明）
    if (rule.by === 'finalist') continue;
    const pool = rule.by === 'votes' ? byVotes : ranking;
    const eligible = rule.exclusive ? pool.filter((r) => !taken.has(r.ideaId)) : pool;
    const row = eligible[rule.rank - 1];
    if (!row) continue;
    // 评委一个分都没打时没有名次可言，不编一个出来
    if (rule.by === 'judge' && row.judgeScore == null) continue;
    taken.add(row.ideaId);
    const m = metaById.get(row.ideaId);
    out.push({
      ideaId: row.ideaId,
      key: rule.key,
      name: rule.name,
      money: rule.money,
      no: row.no,
      ideaName: row.name,
      who: row.who,
      avatarUrl: m ? avatarUrlFor(m.author, m.avatar) : null,
      url: workUrl(m?.kind ?? null, m?.app_owner ?? null, m?.app_slug ?? null),
      judgeScore: rule.by === 'judge' ? row.judgeScore : null,
      votes: row.votes,
      comment: m?.note ?? null,
      desc: m?.pitch ?? m?.plan ?? '',
      dims: avgDims(row.ideaId),
    });
  }
  return out;
}
