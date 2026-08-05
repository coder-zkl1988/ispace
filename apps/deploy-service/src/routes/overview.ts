import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, schemaNameFor, type User } from '@ispace/contracts';
import type { Sql } from '@ispace/db';

/**
 * 几张屏要的聚合数字。
 *
 * 单独一个文件而不是散在 server.ts 里：这些查询彼此无关，唯一的共同点
 * 是"某一屏要展示但单表查不出来"。放一起便于一眼看出每个数字的来源——
 * 界面上的数字最怕的就是没人说得清它是怎么算的。
 */

/** 「活跃设备」的口径：多久没来要过更新就不算活跃。 */
const ACTIVE_DEVICE_DAYS = 7;

export function registerOverviewRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    requireAuth: (req: FastifyRequest) => Promise<User>;
  },
): void {
  const { sql, requireAuth } = deps;

  /**
   * 空间总览的四张卡（设计稿：已发布页面 / 本月发布 / 自定义后端 / 空间占用）。
   *
   * 「本月发布」按自然月算，不是滚动 30 天——用户看到"本月"想的就是
   * 这个月 1 号到现在。环比给的是上月同期而非上月全月：月初时跟上月全月
   * 比永远是大幅下降，那个数字没有意义。
   */
  app.get(`${API_BASE}/overview`, async (req) => {
    const me = await requireAuth(req);

    const rows = await sql<{ this_month: string; last_month_to_date: string }[]>`
      WITH bounds AS (
        SELECT date_trunc('month', now())                        AS m0,
               date_trunc('month', now()) - interval '1 month'   AS m1,
               -- 上月的"同期"：把当前时刻整体往前推一个月
               now() - interval '1 month'                        AS m1_now
      )
      SELECT
        count(*) FILTER (WHERE r.published_at >= b.m0)::text                     AS this_month,
        count(*) FILTER (WHERE r.published_at >= b.m1
                           AND r.published_at <  b.m1_now)::text                 AS last_month_to_date
        FROM ispace.releases r
        JOIN ispace.apps a ON a.id = r.app_id
        CROSS JOIN bounds b
       WHERE a.owner_id = ${me.id}
         AND r.status <> 'blocked'
    `;

    const thisMonth = Number(rows[0]?.this_month ?? 0);
    const lastMonthToDate = Number(rows[0]?.last_month_to_date ?? 0);

    return {
      publishedThisMonth: thisMonth,
      /** 与上月同期之差。为 0 时前端不显示——"+0" 是噪声。 */
      deltaVsLastMonth: thisMonth - lastMonthToDate,
    };
  });

  /**
   * 更新通道的四张卡与每个版本的到端设备数。
   *
   * 设备数据来自 mobile_devices（更新服务在每次 manifest 请求时写入）。
   * 表是空的时候返回 0 而不是编一个数——设计稿里的 12 台是示意数据。
   */
  app.get(`${API_BASE}/mobile/devices/stats`, async (req) => {
    const me = await requireAuth(req);

    const [agg] = await sql<{ active: string; failed: string; total: string }[]>`
      SELECT count(*) FILTER (
               WHERE last_seen_at > now() - ${`${ACTIVE_DEVICE_DAYS} days`}::interval
             )::text AS active,
             -- 「加载失败」只算最近一次仍是失败态的设备：成功加载会清空 last_error
             count(*) FILTER (WHERE last_error IS NOT NULL)::text AS failed,
             count(*)::text AS total
        FROM ispace.mobile_devices
       WHERE user_id = ${me.id}
    `;

    const perRelease = await sql<{ release_id: string; devices: string }[]>`
      SELECT current_release_id::text AS release_id, count(*)::text AS devices
        FROM ispace.mobile_devices
       WHERE user_id = ${me.id} AND current_release_id IS NOT NULL
       GROUP BY current_release_id
    `;

    /**
     * 「发布到端耗时」取当前版本的 first_delivered_at 减 published_at。
     * 还没有任何设备装上时为 null——前端显示"等待中"，而不是 0s
     * （0s 会被读成"秒到"，与事实正好相反）。
     */
    const [cur] = await sql<{ seconds: number | null }[]>`
      SELECT EXTRACT(EPOCH FROM (r.first_delivered_at - r.published_at))::int AS seconds
        FROM ispace.mobile_channels c
        JOIN ispace.mobile_releases r ON r.id = c.current_release_id
       WHERE c.user_id = ${me.id}
    `;

    return {
      activeDevices: Number(agg?.active ?? 0),
      failedDevices: Number(agg?.failed ?? 0),
      totalDevices: Number(agg?.total ?? 0),
      deliverySeconds: cur?.seconds ?? null,
      devicesByRelease: Object.fromEntries(
        perRelease.map((r) => [r.release_id, Number(r.devices)]),
      ) as Record<string, number>,
    };
  });

  /**
   * 数据空间：这个空间里注册了多少终端用户。
   *
   * 设计稿把它放在「两层登录，别混了」那张卡里，正是为了让人一眼看出
   * 「你登录平台」和「同事登录你的应用」是两回事——右边这个数字是后者。
   *
   * 表名不固定：用户的应用自己建表，可能叫 app_user、users、members……
   * 所以按常见命名找，找不到就返回 null 让前端不显示，而不是显示 0
   * （0 会被读成"没人用"，而实际可能只是表不叫这个名）。
   */
  app.get(`${API_BASE}/data/end-users`, async (req) => {
    const me = await requireAuth(req);
    const schema = schemaNameFor(me.username);

    const candidates = await sql<{ relname: string }[]>`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${schema}
         AND c.relkind = 'r'
         AND c.relname IN ('app_user', 'app_users', 'users', 'members', 'end_users')
       ORDER BY array_position(
                  ARRAY['app_user','app_users','users','members','end_users'], c.relname)
       LIMIT 1
    `;

    const table = candidates[0]?.relname;
    if (!table) return { table: null, count: null };

    // 这里用精确 count 而不是 reltuples：终端用户表通常只有几十到几千行，
    // 而"42 人在用"这种数字给个估算值会显得很不可信。
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.${sql(table)}
    `;
    return { table, count: Number(row?.n ?? 0) };
  });
}
