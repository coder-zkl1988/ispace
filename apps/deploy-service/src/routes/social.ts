import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_BASE, ERROR_CODES, IspaceError, avatarUrlFor,
  commentInputSchema, commentSortSchema, interestsInputSchema, postFeedSchema, postInputSchema,
  type User,
} from '@ispace/contracts';
import type { Sql } from '@ispace/db';
import { z } from 'zod';

/**
 * 社交面的接口：喜欢、评论、关注、动态、兴趣（改版稿 + 移动端 v2）。
 *
 * 字段一律 camelCase，与 /marketplace 那边返回原始 snake_case 行不一致——
 * 这是有意的：那些是「把一行数据端出去」的列表接口，前端 Listing 类型就是
 * 库里那一行；这里返回的是契约里定义好的 Comment / Post / AuthorProfile，
 * 由 packages/contracts/src/social.ts 的 zod 说了算，库里的列名不该漏出去。
 *
 * ┌─ 为什么这些动作不写审计 ───────────────────────────────────────────────┐
 * │ writeAudit 那张表是「发布记录」那一屏的数据源，也是合规要回溯的东西：  │
 * │ 谁把什么发到了哪、谁把页面开给了全公司、谁被密钥扫描挡下。点一次喜欢  │
 * │ 混进去，那一屏就被几千条「某人喜欢了某页面」冲掉，真正要查的改动反而  │
 * │ 翻不到。删评论、删帖这类有争议的动作同理：内容本身在库里，谁写的、什么│
 * │ 时候写的都记着，不需要再多一条审计。                                  │
 * └───────────────────────────────────────────────────────────────────────┘
 */

/** 评论/喜欢的前提：这个页面我本来就看得见。与 authz.ts 的放行条件逐条对齐。 */
async function visibleApp(
  sql: Sql,
  me: User,
  appId: string,
): Promise<{ id: string; owner_id: string; name: string }> {
  const [row] = await sql<{ id: string; owner_id: string; name: string; visibility: string }[]>`
    SELECT a.id, a.owner_id, a.name, a.visibility
      FROM ispace.apps a
      JOIN ispace.users u ON u.id = a.owner_id
     WHERE a.id = ${appId} AND a.status <> 'stopped' AND u.status <> 'archived'
  `;
  /*
    看不见的页面一律 404，不用 403——403 等于回答了「这个 id 存在」。
    评论和喜欢是能被人拿着 id 遍历的接口，不该变成探测器。
  */
  if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这个页面不存在，或者已经下架');
  if (row.owner_id === me.id || me.role === 'admin' || row.visibility === 'public') return row;

  const [shared] = await sql`
    SELECT 1 FROM ispace.shares
     WHERE app_id = ${appId} AND to_user_id = ${me.id} AND status = 'accepted'
  `;
  if (!shared) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这个页面不存在，或者已经下架');
  return row;
}

/**
 * 重算一个页面的喜欢数与评论数。
 *
 * 重算而不是 +1/-1：重复点赞、并发、以及日后在库里手工删一条评论，都不会
 * 让计数器和事实分叉。两张表都不大（按 app 有索引），这一下很便宜。
 */
async function recountApp(sql: Sql, appId: string): Promise<{ likes: number; comments: number }> {
  const [row] = await sql<{ like_count: number; comment_count: number }[]>`
    UPDATE ispace.apps
       SET like_count    = (SELECT count(*) FROM ispace.app_likes    WHERE app_id = ${appId}),
           comment_count = (SELECT count(*) FROM ispace.app_comments WHERE app_id = ${appId})
     WHERE id = ${appId}
    RETURNING like_count, comment_count
  `;
  return { likes: Number(row?.like_count ?? 0), comments: Number(row?.comment_count ?? 0) };
}

interface AuthorRow {
  username: string;
  display_name: string;
  avatar_etag: string | null;
}

const author = (r: AuthorRow) => ({
  username: r.username,
  displayName: r.display_name,
  avatarUrl: avatarUrlFor(r.username, r.avatar_etag),
});

export function registerSocialRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; requireAuth: (req: FastifyRequest) => Promise<User> },
): void {
  const { sql, requireAuth } = deps;

  /** 能看见这条评论所在的页面，才能给它点赞。 */
  const commentVisible = async (me: User, commentId: string) => {
    const [row] = await sql<{ app_id: string }[]>`
      SELECT app_id FROM ispace.app_comments WHERE id = ${commentId}
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这条评论已经不在了');
    await visibleApp(sql, me, row.app_id);
  };

  const recountComment = async (commentId: string): Promise<number> => {
    const [row] = await sql<{ like_count: number }[]>`
      UPDATE ispace.app_comments
         SET like_count = (
               SELECT count(*) FROM ispace.app_comment_likes WHERE comment_id = ${commentId}
             )
       WHERE id = ${commentId}
      RETURNING like_count
    `;
    return Number(row?.like_count ?? 0);
  };

  // ── 喜欢 ────────────────────────────────────────────────────────────
  //
  // POST / DELETE 两个动词，而不是一个 toggle：设计稿里心形是个状态开关，
  // 点快了会连发两次请求。toggle 的话两次就互相抵消，用户看到的是「点了
  // 没反应」；分成两个动词再配合 ON CONFLICT DO NOTHING，重复请求是幂等的。
  app.post(`${API_BASE}/apps/:appId/like`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    await visibleApp(sql, me, appId);
    await sql`
      INSERT INTO ispace.app_likes (app_id, user_id) VALUES (${appId}, ${me.id})
      ON CONFLICT (app_id, user_id) DO NOTHING
    `;
    const { likes } = await recountApp(sql, appId);
    return { liked: true, likeCount: likes };
  });

  app.delete(`${API_BASE}/apps/:appId/like`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    await visibleApp(sql, me, appId);
    await sql`DELETE FROM ispace.app_likes WHERE app_id = ${appId} AND user_id = ${me.id}`;
    const { likes } = await recountApp(sql, appId);
    return { liked: false, likeCount: likes };
  });

  // ── 评论 ────────────────────────────────────────────────────────────
  app.get(`${API_BASE}/apps/:appId/comments`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    const { sort } = z.object({ sort: commentSortSchema.default('new') }).parse(req.query ?? {});
    await visibleApp(sql, me, appId);
    /*
      排序在服务端做，不是前端拿到后再 sort：面板有 LIMIT，热门与最新取到
      的本来就该是不同的两百条——前端排只会把"最新的两百条里最热的几条"
      当成热门。
    */
    const rows = await sql<
      (AuthorRow & {
        id: string; body: string; created_at: Date; user_id: string;
        like_count: number; liked: boolean;
      })[]
    >`
      SELECT c.id, c.body, c.created_at, c.user_id, c.like_count,
             u.username, u.display_name, a.etag AS avatar_etag,
             EXISTS (
               SELECT 1 FROM ispace.app_comment_likes l
                WHERE l.comment_id = c.id AND l.user_id = ${me.id}
             ) AS liked
        FROM ispace.app_comments c
        JOIN ispace.users u ON u.id = c.user_id
        LEFT JOIN ispace.user_avatars a ON a.user_id = u.id
       WHERE c.app_id = ${appId}
       -- 热门里再按时间兜一层：全是 0 赞的新页面上，热门不该是随机顺序
       ORDER BY ${sort === 'hot' ? sql`c.like_count DESC,` : sql``} c.created_at DESC
       LIMIT 200
    `;
    return {
      comments: rows.map((r) => ({
        id: r.id,
        body: r.body,
        createdAt: r.created_at.toISOString(),
        author: author(r),
        mine: r.user_id === me.id,
        likeCount: Number(r.like_count),
        liked: r.liked,
      })),
    };
  });

  // 评论点赞。两个动词、ON CONFLICT 幂等、计数重算，和页面的喜欢同一套。
  app.post(`${API_BASE}/comments/:id/like`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    await commentVisible(me, id);
    await sql`
      INSERT INTO ispace.app_comment_likes (comment_id, user_id) VALUES (${id}, ${me.id})
      ON CONFLICT (comment_id, user_id) DO NOTHING
    `;
    return { liked: true, likeCount: await recountComment(id) };
  });

  app.delete(`${API_BASE}/comments/:id/like`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    await commentVisible(me, id);
    await sql`
      DELETE FROM ispace.app_comment_likes WHERE comment_id = ${id} AND user_id = ${me.id}
    `;
    return { liked: false, likeCount: await recountComment(id) };
  });

  app.post(`${API_BASE}/apps/:appId/comments`, async (req) => {
    const me = await requireAuth(req);
    const { appId } = req.params as { appId: string };
    const { body } = commentInputSchema.parse(req.body);
    await visibleApp(sql, me, appId);
    const [row] = await sql<{ id: string; created_at: Date }[]>`
      INSERT INTO ispace.app_comments (app_id, user_id, body)
      VALUES (${appId}, ${me.id}, ${body})
      RETURNING id, created_at
    `;
    const { comments } = await recountApp(sql, appId);
    const [u] = await sql<AuthorRow[]>`
      SELECT u.username, u.display_name, a.etag AS avatar_etag
        FROM ispace.users u
        LEFT JOIN ispace.user_avatars a ON a.user_id = u.id
       WHERE u.id = ${me.id}
    `;
    return {
      comment: {
        id: row!.id,
        body,
        createdAt: row!.created_at.toISOString(),
        author: author(u!),
        mine: true,
        likeCount: 0,
        liked: false,
      },
      commentCount: comments,
    };
  });

  /**
   * 删一条评论。
   *
   * 两种人能删：写的人，和这个页面的作者。作者能删是因为评论挂在他的页面
   * 上、是他要对同事负责的那块地方；但他**只能删**，不能改——改了之后那句
   * 话还署着别人的名。
   */
  app.delete(`${API_BASE}/comments/:id`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const [row] = await sql<{ app_id: string; user_id: string; owner_id: string }[]>`
      SELECT c.app_id, c.user_id, a.owner_id
        FROM ispace.app_comments c JOIN ispace.apps a ON a.id = c.app_id
       WHERE c.id = ${id}
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这条评论已经不在了');
    if (row.user_id !== me.id && row.owner_id !== me.id && me.role !== 'admin') {
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '只能删自己的评论，或自己页面下的评论');
    }
    await sql`DELETE FROM ispace.app_comments WHERE id = ${id}`;
    const { comments } = await recountApp(sql, row.app_id);
    return { ok: true, commentCount: comments };
  });

  // ── 作者主页 ────────────────────────────────────────────────────────
  //
  // 一次请求把这一屏要的东西都给齐（资料 + 他公开的页面）：设计稿的作者页
  // 是「头像 + 三个数字 + 一墙作品」，拆成两个接口只会让这一屏分两次闪。
  app.get(`${API_BASE}/authors/:username`, async (req) => {
    const me = await requireAuth(req);
    const { username } = req.params as { username: string };
    const [u] = await sql<(AuthorRow & { id: string })[]>`
      SELECT u.id, u.username, u.display_name, av.etag AS avatar_etag
        FROM ispace.users u
        LEFT JOIN ispace.user_avatars av ON av.user_id = u.id
       WHERE u.username = ${username} AND u.status <> 'archived'
    `;
    if (!u) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个人');

    /*
      列名与 /marketplace 那条**逐字对齐**：作者页用的是同一张卡片组件，
      少一个 app_id，组件里按 id 取底色那一下就会炸（实测白屏）。
    */
    const apps = await sql`
      SELECT m.id, a.id AS app_id, m.published_at, m.install_count,
             a.slug, a.name, a.description, a.icon_letter, a.cover_path,
             a.type, a.status, a.category, a.visit_count, a.like_count, a.comment_count,
             a.source_prompt,
             u.username AS owner_username, u.display_name AS owner_name,
             EXISTS (
               SELECT 1 FROM ispace.app_installs i
                WHERE i.app_id = a.id AND i.user_id = ${me.id}
             ) AS installed,
             EXISTS (
               SELECT 1 FROM ispace.app_likes l
                WHERE l.app_id = a.id AND l.user_id = ${me.id}
             ) AS liked,
             -- 与 /marketplace 同款在线窗口，作者页卡片与探索墙同一组件
             (SELECT count(*) FROM ispace.app_presence p
               WHERE p.app_id = a.id
                 AND p.last_seen_at > now() - interval '90 seconds') AS live_count,
             (a.owner_id = ${me.id}) AS mine
        FROM ispace.marketplace_listings m
        JOIN ispace.apps  a ON a.id = m.app_id
        JOIN ispace.users u ON u.id = a.owner_id
       WHERE a.owner_id = ${u.id} AND a.status <> 'stopped'
       ORDER BY m.install_count DESC, m.published_at DESC
    `;

    const [counts] = await sql<
      { followers: string; followees: string; posts: string }[]
    >`
      SELECT (SELECT count(*) FROM ispace.user_follows WHERE followee_id = ${u.id}) AS followers,
             (SELECT count(*) FROM ispace.user_follows WHERE follower_id = ${u.id}) AS followees,
             (SELECT count(*) FROM ispace.posts        WHERE author_id  = ${u.id}) AS posts
    `;
    const [follow] = await sql`
      SELECT 1 FROM ispace.user_follows
       WHERE follower_id = ${me.id} AND followee_id = ${u.id}
    `;

    const sum = (k: 'install_count' | 'visit_count') =>
      apps.reduce((s, a) => s + Number((a as Record<string, unknown>)[k] ?? 0), 0);

    /*
     * 「N 人复用」按人去重，不把各页 install_count 加总：同一个同事用
     * 了作者两个页面，加总会说 2 人——那是「人次」，不是「人」。访问量
     * 那边写的是「次访问」，加总才是对的口径。
     */
    const [distinctUsers] = await sql<{ n: string }[]>`
      SELECT count(DISTINCT i.user_id)::text AS n
        FROM ispace.app_installs i
        JOIN ispace.apps a ON a.id = i.app_id
       WHERE a.owner_id = ${u.id}
    `;

    return {
      profile: {
        ...author(u),
        // 库里没有部门字段。设计稿那一行先留空，前端不显示——
        // 编一个「技术部」出来比留空更糟，它会被当成真的。
        department: null,
        self: u.id === me.id,
        following: !!follow,
        stats: {
          publicApps: apps.length,
          users: Number(distinctUsers?.n ?? 0),
          visits: sum('visit_count'),
          followers: Number(counts?.followers ?? 0),
          followees: Number(counts?.followees ?? 0),
          posts: Number(counts?.posts ?? 0),
        },
      },
      // 和 /marketplace 的卡片对齐：作者页上每张卡都是他本人，头像同一个
      apps: apps.map((a) => ({ ...a, owner_avatar: avatarUrlFor(u.username, u.avatar_etag) })),
    };
  });

  app.post(`${API_BASE}/authors/:username/follow`, async (req) => {
    const me = await requireAuth(req);
    const { username } = req.params as { username: string };
    const [u] = await sql<{ id: string }[]>`
      SELECT id FROM ispace.users WHERE username = ${username} AND status <> 'archived'
    `;
    if (!u) throw new IspaceError(ERROR_CODES.NOT_FOUND, '没有这个人');
    if (u.id === me.id) throw new IspaceError(ERROR_CODES.INVALID_INPUT, '不用关注自己');
    await sql`
      INSERT INTO ispace.user_follows (follower_id, followee_id) VALUES (${me.id}, ${u.id})
      ON CONFLICT (follower_id, followee_id) DO NOTHING
    `;
    return { following: true };
  });

  app.delete(`${API_BASE}/authors/:username/follow`, async (req) => {
    const me = await requireAuth(req);
    const { username } = req.params as { username: string };
    await sql`
      DELETE FROM ispace.user_follows
       WHERE follower_id = ${me.id}
         AND followee_id = (SELECT id FROM ispace.users WHERE username = ${username})
    `;
    return { following: false };
  });

  // ── 动态（移动端社区）───────────────────────────────────────────────
  app.get(`${API_BASE}/posts`, async (req) => {
    const me = await requireAuth(req);
    const { feed } = z
      .object({ feed: postFeedSchema.default('recommend') })
      .parse(req.query ?? {});

    /*
      「关注」tab 里不含自己：设计稿这一栏是「我关注的人在做什么」。
      自己发的帖在「我」页有一整个 tab，混进来只会把别人的挤下去。
    */
    const rows = await sql<
      (AuthorRow & {
        id: string; body: string; created_at: Date; like_count: number; comment_count: number;
        liked: boolean; author_id: string;
        app_id: string | null; app_slug: string | null; app_name: string | null;
        app_desc: string | null; app_icon: string | null; app_cover: string | null;
        app_owner: string | null;
      })[]
    >`
      SELECT p.id, p.body, p.created_at, p.like_count, p.comment_count, p.author_id,
             u.username, u.display_name, av.etag AS avatar_etag,
             EXISTS (
               SELECT 1 FROM ispace.post_likes l
                WHERE l.post_id = p.id AND l.user_id = ${me.id}
             ) AS liked,
             a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
             a.description AS app_desc, a.icon_letter AS app_icon, a.cover_path AS app_cover,
             ao.username AS app_owner
        FROM ispace.posts p
        JOIN ispace.users u ON u.id = p.author_id
        LEFT JOIN ispace.user_avatars av ON av.user_id = u.id
        LEFT JOIN ispace.apps  a  ON a.id = p.app_id AND a.status <> 'stopped'
        LEFT JOIN ispace.users ao ON ao.id = a.owner_id
       WHERE u.status <> 'archived'
         -- ::text 不是摆设：不加的话 Postgres 对这个参数无从推断类型
         -- （两边都是参数/字面量），直接报 could not determine data type。
         AND (${feed}::text = 'recommend' OR p.author_id IN (
               SELECT followee_id FROM ispace.user_follows WHERE follower_id = ${me.id}
             ))
       ORDER BY p.created_at DESC
       LIMIT 100
    `;

    return {
      posts: rows.map((r) => ({
        id: r.id,
        body: r.body,
        createdAt: r.created_at.toISOString(),
        likeCount: Number(r.like_count),
        commentCount: Number(r.comment_count),
        liked: r.liked,
        mine: r.author_id === me.id,
        author: author(r),
        app: r.app_id
          ? {
            id: r.app_id,
            slug: r.app_slug!,
            name: r.app_name!,
            description: r.app_desc,
            iconLetter: r.app_icon!,
            coverUrl: r.app_cover,
            owner: r.app_owner!,
          }
          : null,
      })),
    };
  });

  app.post(`${API_BASE}/posts`, async (req) => {
    const me = await requireAuth(req);
    const { body, appId } = postInputSchema.parse(req.body);
    /*
      只能附自己的页面。附别人的等于替他宣传，而他可能正好不想让这个页面
      出现在社区里——「分享别人的页面」该走转发，不是发一条自己的帖。
    */
    if (appId) {
      const [own] = await sql`
        SELECT 1 FROM ispace.apps WHERE id = ${appId} AND owner_id = ${me.id}
      `;
      if (!own) throw new IspaceError(ERROR_CODES.NOT_OWNER, '只能附上自己的页面');
    }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO ispace.posts (author_id, body, app_id)
      VALUES (${me.id}, ${body}, ${appId ?? null})
      RETURNING id
    `;
    return { id: row!.id };
  });

  app.delete(`${API_BASE}/posts/:id`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    // 管理员的豁免放在 JS 里判断，不塞进 SQL：布尔参数在 WHERE 里要带
    // 类型标注才不会被 Postgres 当成未知类型，不如这里一句话说清。
    const rows = me.role === 'admin'
      ? await sql`DELETE FROM ispace.posts WHERE id = ${id} RETURNING id`
      : await sql`DELETE FROM ispace.posts WHERE id = ${id} AND author_id = ${me.id} RETURNING id`;
    if (!rows[0]) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这条动态已经不在了');
    return { ok: true };
  });

  const recountPost = async (postId: string) => {
    const [row] = await sql<{ like_count: number; comment_count: number }[]>`
      UPDATE ispace.posts
         SET like_count    = (SELECT count(*) FROM ispace.post_likes    WHERE post_id = ${postId}),
             comment_count = (SELECT count(*) FROM ispace.post_comments WHERE post_id = ${postId})
       WHERE id = ${postId}
      RETURNING like_count, comment_count
    `;
    if (!row) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这条动态已经不在了');
    return { likes: Number(row.like_count), comments: Number(row.comment_count) };
  };

  app.post(`${API_BASE}/posts/:id/like`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const [post] = await sql`SELECT 1 FROM ispace.posts WHERE id = ${id}`;
    if (!post) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这条动态已经不在了');
    await sql`
      INSERT INTO ispace.post_likes (post_id, user_id) VALUES (${id}, ${me.id})
      ON CONFLICT (post_id, user_id) DO NOTHING
    `;
    const { likes } = await recountPost(id);
    return { liked: true, likeCount: likes };
  });

  app.delete(`${API_BASE}/posts/:id/like`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    await sql`DELETE FROM ispace.post_likes WHERE post_id = ${id} AND user_id = ${me.id}`;
    const { likes } = await recountPost(id);
    return { liked: false, likeCount: likes };
  });

  app.get(`${API_BASE}/posts/:id/comments`, async (req) => {
    await requireAuth(req);
    const { id } = req.params as { id: string };
    const rows = await sql<(AuthorRow & { id: string; body: string; created_at: Date })[]>`
      SELECT c.id, c.body, c.created_at, u.username, u.display_name, av.etag AS avatar_etag
        FROM ispace.post_comments c
        JOIN ispace.users u ON u.id = c.user_id
        LEFT JOIN ispace.user_avatars av ON av.user_id = u.id
       WHERE c.post_id = ${id}
       ORDER BY c.created_at DESC
       LIMIT 200
    `;
    return {
      comments: rows.map((r) => ({
        id: r.id, body: r.body, createdAt: r.created_at.toISOString(), author: author(r),
      })),
    };
  });

  app.post(`${API_BASE}/posts/:id/comments`, async (req) => {
    const me = await requireAuth(req);
    const { id } = req.params as { id: string };
    const { body } = commentInputSchema.parse(req.body);
    const [post] = await sql`SELECT 1 FROM ispace.posts WHERE id = ${id}`;
    if (!post) throw new IspaceError(ERROR_CODES.NOT_FOUND, '这条动态已经不在了');
    await sql`
      INSERT INTO ispace.post_comments (post_id, user_id, body) VALUES (${id}, ${me.id}, ${body})
    `;
    const { comments } = await recountPost(id);
    return { ok: true, commentCount: comments };
  });

  // ── 兴趣 ────────────────────────────────────────────────────────────
  //
  // 单独一条 GET，而不是塞进 /me：/me 是每个页面都要拉的那一下，
  // 而兴趣只有「选方向」和「为你推荐」两处用。
  app.get(`${API_BASE}/me/interests`, async (req) => {
    const me = await requireAuth(req);
    const [row] = await sql<{ interests: string[] }[]>`
      SELECT interests FROM ispace.users WHERE id = ${me.id}
    `;
    return { interests: row?.interests ?? [] };
  });

  // PUT 而不是 POST：这是「把我的方向设成这几个」，重复提交结果一样。
  // 移动端那一屏可以反复进、反复改，幂等省掉了「先删再插」的来回。
  app.put(`${API_BASE}/me/interests`, async (req) => {
    const me = await requireAuth(req);
    const { interests } = interestsInputSchema.parse(req.body);
    await sql`UPDATE ispace.users SET interests = ${interests} WHERE id = ${me.id}`;
    return { interests };
  });
}
