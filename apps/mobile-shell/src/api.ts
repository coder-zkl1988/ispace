import type { AuthorProfile, Comment, Interest, Post } from '@ispace/contracts';
import { API_BASE } from './config';

/**
 * 壳里对平台接口的那一层。
 *
 * ┌─ 为什么现在才有这个文件 ──────────────────────────────────────────┐
 * │ 改版前，壳里每一屏自己拼 fetch：Market 一份、AgentChat 一份、      │
 * │ App.tsx 又一份。三份各自处理 token、错误和 JSON 解析，加一个接口   │
 * │ 要抄三遍。移动端 v2 一次加进来七八条新接口（喜欢、评论、动态、     │
 * │ 关注、兴趣），再抄就不像话了。                                     │
 * │                                                                    │
 * │ 旧的那几屏没有被改写——它们能用，而改写等于把一堆已经验证过的请求   │
 * │ 再冒一次险。新屏走这里，旧屏原样。                                 │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * token 每次调用由外部传进来，而不是模块里存一份：壳的会话在 App.tsx 的
 * state 里，退出登录时那一份会被清掉；模块级的副本不会，于是退出之后还能
 * 用旧 token 请求成功——最难发现的那种越权。
 */

export interface ApiError extends Error { code?: string }

async function call<T>(
  path: string,
  token: string | null,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${API_BASE}/deploy/api${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const e = new Error((data as { message?: string }).message ?? `请求失败（${res.status}）`) as ApiError;
    e.code = (data as { code?: string }).code;
    throw e;
  }
  return data as T;
}

/** 列表里那条 listing。字段名跟服务端返回的行一致（snake_case）。 */
export interface Listing {
  id: string; app_id: string; slug: string; name: string;
  description: string | null; icon_letter: string; type: string;
  owner_username: string; owner_name: string;
  install_count: number; installed: boolean; mine: boolean;
  /** 此刻正打开着这个页面的人数（presence 90 秒窗口，去重访客）。 */
  live_count: number;
  source_prompt: string | null;
  visit_count: number; like_count: number; comment_count: number; liked: boolean;
  category: string | null;
  cover_path: string | null;
}

export const api = {
  marketplace: (t: string | null) => call<{ listings: Listing[] }>('/marketplace', t),

  like: (t: string | null, appId: string) =>
    call<{ liked: boolean; likeCount: number }>(`/apps/${appId}/like`, t, { method: 'POST' }),
  unlike: (t: string | null, appId: string) =>
    call<{ liked: boolean; likeCount: number }>(`/apps/${appId}/like`, t, { method: 'DELETE' }),

  comments: (t: string | null, appId: string) =>
    call<{ comments: Comment[] }>(`/apps/${appId}/comments`, t),
  addComment: (t: string | null, appId: string, body: string) =>
    call<{ comment: Comment; commentCount: number }>(`/apps/${appId}/comments`, t, {
      method: 'POST', body: { body },
    }),

  posts: (t: string | null, feed: 'recommend' | 'following') =>
    call<{ posts: Post[] }>(`/posts?feed=${feed}`, t),
  createPost: (t: string | null, body: string, appId?: string) =>
    call<{ id: string }>('/posts', t, { method: 'POST', body: appId ? { body, appId } : { body } }),
  likePost: (t: string | null, id: string) =>
    call<{ liked: boolean; likeCount: number }>(`/posts/${id}/like`, t, { method: 'POST' }),
  unlikePost: (t: string | null, id: string) =>
    call<{ liked: boolean; likeCount: number }>(`/posts/${id}/like`, t, { method: 'DELETE' }),

  author: (t: string | null, username: string) =>
    call<{ profile: AuthorProfile; apps: Listing[] }>(`/authors/${encodeURIComponent(username)}`, t),

  interests: (t: string | null) => call<{ interests: Interest[] }>('/me/interests', t),
  setInterests: (t: string | null, interests: Interest[]) =>
    call<{ interests: Interest[] }>('/me/interests', t, { method: 'PUT', body: { interests } }),

  pendingShares: (t: string | null) =>
    call<{ shares: { id: string; app: { name: string }; fromUser: { displayName: string } }[] }>(
      '/shares/pending', t,
    ),
  respondShare: (t: string | null, id: string, accept: boolean) =>
    call<{ ok: boolean }>(`/shares/${id}/respond`, t, { method: 'POST', body: { accept } }),

  installFromMarket: (t: string | null, appId: string) =>
    call<{ ok: boolean }>(`/marketplace/${appId}/install`, t, { method: 'POST' }),
  uninstallFromMarket: (t: string | null, appId: string) =>
    call<{ ok: boolean }>(`/marketplace/${appId}/install`, t, { method: 'DELETE' }),

  /**
   * 换一张试玩令牌（和门户「为你推荐」同一条路）。探索页「自动播放」拿它
   * 把页面直接跑在卡片里。返回的 url 是站内路径，前面要补 API_BASE 的源。
   */
  playOpen: (t: string | null, owner: string, slug: string) =>
    call<{ token: string; url: string; expiresAt: number; idleMs: number }>('/play-session', t, {
      method: 'POST', body: { owner, slug },
    }),

  /** 助手左上角「历史」：我最近的会话（和电脑端工作台同一份）。 */
  agentSessions: (t: string | null) =>
    call<{ items: { id: string; title: string; slug: string | null; updatedAt: number }[] }>(
      '/agent/sessions', t,
    ),
  /**
   * 一条会话给人看的那份对话，点开历史时摆回来接着聊。busy：这一句还在跑
   * （老的服务端不带这个字段，调用方按 undefined 处理）。
   */
  agentSessionView: (t: string | null, id: string) =>
    call<{
      id: string; slug: string | null; title: string; busy?: boolean;
      says: { me: boolean; text: string }[];
    }>(`/agent/session/${encodeURIComponent(id)}`, t),
  /** 先开一条会话拿到 id，再发第一句——连接中途断了也知道去哪儿找结果。 */
  agentNewSession: (t: string | null) =>
    call<{ sessionId: string }>('/agent/session', t, { method: 'POST' }),

  /** 设置 ·「编辑资料」。和电脑端头像菜单里那个对话框同一条接口。 */
  updateProfile: (t: string | null, displayName: string) =>
    call<{ user: { displayName: string } }>('/auth/profile', t, { method: 'PATCH', body: { displayName } }),

  /** 设置 ·「接入 AI」那一行的状态：有没有发过个人令牌、用过没有。 */
  tokens: (t: string | null) =>
    call<{ tokens: { id: string; name: string; last_used_at: string | null }[] }>('/tokens', t),
};

/**
 * 封面存的是站内相对路径（/zongkelong/gugong/cover.png），靠浏览器同源补全。
 * 手机端的 Image 没有这个概念，相对路径等于加载不出来。
 */
export const absCover = (u: string | null): string | null =>
  !u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`;
