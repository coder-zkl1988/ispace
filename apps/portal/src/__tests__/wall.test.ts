import { describe, expect, it } from 'vitest';
import { appHref, deviceOf, detailHref, fmt, initial, ratioOf, washOf } from '../wall';
import { rank } from '../foryou';
import { ago } from '../detail';
import type { Listing } from '../api';

/** 造一条够用的 listing。只填这几个函数真正看的字段。 */
const L = (over: Partial<Listing>): Listing => ({
  id: 'l1', app_id: 'a1', published_at: '2026-10-01T00:00:00Z', install_count: 0,
  slug: 'x', name: 'X', description: null, icon_letter: 'X', cover_path: null,
  type: 'static', status: 'running', owner_username: 'lixiao', owner_name: '李骁', owner_avatar: null,
  installed: false, mine: false, category: null, live_count: 0, visit_count: 0,
  like_count: 0, comment_count: 0, liked: false, source_prompt: null,
  ...over,
});

describe('卡片底色', () => {
  it('同一个 id 永远是同一个颜色', () => {
    expect(washOf('paiban')).toBe(washOf('paiban'));
  });

  it('不同 id 会分到不同颜色（不是所有卡一个色）', () => {
    const got = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(washOf));
    expect(got.size).toBeGreaterThan(3);
  });

  it('没有 id 时给一个中性色，而不是炸掉', () => {
    // 作者页那条接口曾经漏了 app_id，整屏白屏就是从这一下开始的
    expect(washOf(undefined)).toBe('var(--wash-c)');
    expect(washOf('')).toBe('var(--wash-c)');
  });
});

describe('头像里的那个字', () => {
  it('中文名取最后一个字', () => {
    expect(initial('李骁')).toBe('骁');
    expect(initial('赵一鸣')).toBe('鸣');
  });

  it('英文名取首字母并大写', () => {
    expect(initial('lixiao')).toBe('L');
  });

  it('空名字不至于渲染出一个空圆', () => {
    expect(initial('')).toBe('·');
    expect(initial('   ')).toBe('·');
  });
});

describe('手机页还是网页', () => {
  it('h5 是手机优先，其余都是电脑优先', () => {
    expect(deviceOf('h5')).toBe('phone');
    expect(deviceOf('static')).toBe('pc');
    expect(deviceOf('static_backend')).toBe('pc');
  });

  it('卡片比例跟着设备走——这正是那面墙错落的来源', () => {
    expect(ratioOf('h5')).toBe('390 / 844');
    expect(ratioOf('static')).toBe('4 / 3');
  });
});

describe('地址', () => {
  it('打开的是页面本身，看详情才是平台的路由', () => {
    const l = L({ owner_username: 'wangke', slug: 'huiyishi' });
    expect(appHref(l)).toBe('/wangke/huiyishi/');
    expect(detailHref(l)).toBe('/app/wangke/huiyishi');
  });
});

describe('数字', () => {
  it('四位数以上加千分位', () => {
    expect(fmt(15400)).toBe('15,400');
    expect(fmt('2410')).toBe('2,410');
    expect(fmt(0)).toBe('0');
  });
});

describe('为你推荐的排序', () => {
  const a = L({ app_id: 'a', category: '工作提效', like_count: 1 });
  const b = L({ app_id: 'b', category: '小游戏', like_count: 50 });
  const c = L({ app_id: 'c', category: '工作提效', like_count: 0 });

  it('勾过的方向排在前面，哪怕它没那么热', () => {
    const got = rank([a, b, c], ['工作提效']).map((x) => x.app_id);
    expect(got.slice(0, 2).sort()).toEqual(['a', 'c']);
    expect(got[2]).toBe('b');
  });

  it('没勾过方向就退化成按热度排，而不是空着', () => {
    expect(rank([a, b, c], []).map((x) => x.app_id)).toEqual(['b', 'a', 'c']);
  });

  it('喜欢比访问量更重要——点一下心是直接的，点进去看一眼不是', () => {
    const liked = L({ app_id: 'liked', like_count: 10, visit_count: 0 });
    const visited = L({ app_id: 'visited', like_count: 0, visit_count: 300 });
    expect(rank([visited, liked], []).map((x) => x.app_id)).toEqual(['liked', 'visited']);
  });

  it('不改原数组', () => {
    const list = [a, b, c];
    rank(list, []);
    expect(list.map((x) => x.app_id)).toEqual(['a', 'b', 'c']);
  });

  it('旧分类也能被「方向」选中（经同一张映射表）', () => {
    const legacy = L({ app_id: 'legacy', category: '效率工具', like_count: 0 });
    const hot = L({ app_id: 'hot', category: '小游戏', like_count: 99 });
    expect(rank([hot, legacy], ['工作提效'])[0]!.app_id).toBe('legacy');
  });
});

describe('相对时间', () => {
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('一分钟内就是刚刚', () => {
    expect(ago(at(5_000))).toBe('刚刚');
  });

  it('按分、时、天往上走', () => {
    expect(ago(at(5 * 60_000))).toBe('5 分钟前');
    expect(ago(at(3 * 3600_000))).toBe('3 小时前');
    expect(ago(at(25 * 3600_000))).toBe('昨天');
    expect(ago(at(5 * 24 * 3600_000))).toBe('5 天前');
  });

  it('超过 30 天改回日期——那时候「38 天前」没有日期好认', () => {
    expect(ago(at(40 * 24 * 3600_000))).toMatch(/\d/);
    expect(ago(at(40 * 24 * 3600_000))).not.toContain('天前');
  });
});
