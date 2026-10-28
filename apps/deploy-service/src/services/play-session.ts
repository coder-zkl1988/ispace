import { randomBytes } from 'node:crypto';

/**
 * 试玩令牌：详情页与为你推荐里那个 iframe 用的凭据。
 *
 * ┌─ 为什么不能让 iframe 直接装 /{owner}/{slug}/ ──────────────────────┐
 * │ 预览 iframe 不给 allow-same-origin（给了等于没有沙箱），里面的文档  │
 * │ 因此是 opaque origin。浏览器把 opaque origin 文档自己发出的子资源   │
 * │ 请求当作**跨站**，而会话 cookie 是 SameSite=Lax —— 跨站不带。       │
 * │                                                                      │
 * │ 而 /{owner}/{slug}/ 下连 CSS 和图片都要过 Caddy 的 forward_auth。   │
 * │ 于是：HTML 进得来（那一跳由父页面发起），它引用的每个 CSS、字体、   │
 * │ 图片都被 302 到登录页。线上实测就是一页裸 HTML——蓝色下划线链接、   │
 * │ 裂掉的图片。所有样式写在独立文件里的页面都这样，也就是绝大多数。    │
 * │                                                                      │
 * │ 把凭据挪进路径就没这个问题：相对路径的子资源天然继承前缀。          │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 与工作区预览的 previewId 是同一套思路，但生命周期更短：试玩是"看一眼"，
 * 不是"做一下午"。
 */

/** 硬上限。 */
export const PLAY_MAX_MS = 30 * 60 * 1000;
/** 空闲上限。 */
export const PLAY_IDLE_MS = 10 * 60 * 1000;
/**
 * 每人同时能有多少张。
 *
 * 不是 1：为你推荐是一屏一个作品翻着看，详情页也可能同时开几个标签。
 * 超了就淘汰最旧的——那张多半已经不在眼前了。
 */
export const PLAY_PER_USER = 16;

export interface PlaySession {
  token: string;
  /** 换令牌的那个人。令牌只对他有效期内的那几分钟负责。 */
  viewerId: string;
  /** Password/session revocation generation when the token was issued. */
  epoch: number;
  owner: string;
  slug: string;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * NOTE(多实例)：和 Agent 会话、工作区预览一样存在内存里。横向扩容时
 * 三者要一起外置，否则下一个请求打到另一个实例就找不到令牌了。
 */
export class PlaySessions {
  private readonly byToken = new Map<string, PlaySession>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 换一张令牌。调用方**必须先判完可见性**（services/app-access.ts）——
   * 这个类只管生命周期，不碰权限。
   */
  open(viewerId: string, owner: string, slug: string, epoch = 0): PlaySession {
    this.prune();

    /* 同一个人、同一个作品已有一张就续用：翻回上一个作品不该再换钥匙 */
    for (const s of this.byToken.values()) {
      if (s.viewerId === viewerId && s.owner === owner && s.slug === slug && s.epoch === epoch) {
        s.lastSeenAt = this.now();
        return s;
      }
    }

    const mine = [...this.byToken.values()]
      .filter((s) => s.viewerId === viewerId)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    while (mine.length >= PLAY_PER_USER) {
      const oldest = mine.shift();
      if (oldest) this.byToken.delete(oldest.token);
    }

    const s: PlaySession = {
      /* 24 字节 = 192 位熵。它就是凭据，要像会话令牌一样猜不出来。 */
      token: randomBytes(24).toString('base64url'),
      viewerId,
      epoch,
      owner,
      slug,
      createdAt: this.now(),
      lastSeenAt: this.now(),
    };
    this.byToken.set(s.token, s);
    return s;
  }

  get(token: string): PlaySession | null {
    const s = this.byToken.get(token);
    if (!s) return null;
    if (this.expired(s)) { this.byToken.delete(token); return null; }
    return s;
  }

  touch(s: PlaySession): void {
    s.lastSeenAt = this.now();
  }

  prune(): number {
    let n = 0;
    for (const [t, s] of this.byToken) {
      if (this.expired(s)) { this.byToken.delete(t); n += 1; }
    }
    return n;
  }

  get size(): number {
    return this.byToken.size;
  }

  expiresAt(s: PlaySession): number {
    return s.createdAt + PLAY_MAX_MS;
  }

  private expired(s: PlaySession): boolean {
    const t = this.now();
    return t - s.createdAt > PLAY_MAX_MS || t - s.lastSeenAt > PLAY_IDLE_MS;
  }
}
