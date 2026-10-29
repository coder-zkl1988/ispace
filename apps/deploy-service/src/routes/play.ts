import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, appSlugSchema, ERROR_CODES, IspaceError, usernameSchema, type User } from '@ispace/contracts';
import { findUserForAuth, type Sql } from '@ispace/db';
import { z } from 'zod';
import { resolveAppAccess } from '../services/app-access.js';
import { PLAY_IDLE_MS, type PlaySessions } from '../services/play-session.js';
import { injectStorageShim } from '../services/sandbox-storage-shim.js';
import { dropSelfBase, escapeHtml, noticePage, serveFile } from '../services/static-serve.js';

/**
 * 已发布页面的试玩（详情页与为你推荐里那个 iframe）。
 *
 * 原先那两处直接把 `/{owner}/{slug}/` 装进 iframe，结果是**一页裸 HTML**：
 * 沙箱 iframe 是 opaque origin，它自己发出的子资源请求被当作跨站，
 * SameSite=Lax 的会话 cookie 不带，而用户空间连 CSS 都要过 forward_auth。
 * 详见 services/play-session.ts 的说明。
 *
 * 这里把凭据挪进路径：换一次令牌，之后 `./assets/x.css` 这样的相对路径天然
 * 带着它，一个 cookie 都不需要。
 *
 * **可见性判定不在这里重写**，用的是 services/app-access.ts —— 和 Caddy
 * forward_auth 那条路同一个函数。
 */

export function registerPlayRoutes(
  app: FastifyInstance,
  deps: {
    sql: Sql;
    requireAuth: (req: FastifyRequest) => Promise<User>;
    /** 已发布站点的根，线上是 /srv/sites。 */
    sitesRoot: string;
    sessions: PlaySessions;
  },
): void {
  const { sql, requireAuth, sitesRoot, sessions } = deps;

  const timer = setInterval(() => { sessions.prune(); }, 5 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });

  // ── 换令牌（要登录，并且要真能看这个页面）──────────────────────
  app.post(`${API_BASE}/play-session`, async (req, reply) => {
    const me = await requireAuth(req);
    const { owner, slug } = z.object({
      /* 用和注册、发布同一套校验：别让一个怪字符串进到路径拼接里 */
      owner: usernameSchema,
      slug: appSlugSchema,
    }).parse(req.body);

    const access = await resolveAppAccess(sql, owner, slug, { uid: me.id, role: me.role });
    if (access.kind === 'notfound') {
      return reply.status(404).send({ code: ERROR_CODES.NOT_FOUND, message: '没有这个页面。' });
    }
    if (access.kind !== 'ok') {
      /*
        login 这一支在这儿到不了（上面 requireAuth 过了），留着是为了穷尽
        联合类型——哪天 app-access 多一档，这里会编译失败而不是静默放行。
      */
      throw new IspaceError(ERROR_CODES.FORBIDDEN, '这个页面没有共享给你。');
    }

    const current = await findUserForAuth(sql, me.id);
    if (!current || current.user.status !== 'active') throw new IspaceError(ERROR_CODES.UNAUTHENTICATED, '账号不可用');
    const s = sessions.open(me.id, owner, slug, current.tokenEpoch);
    return {
      token: s.token,
      url: `${API_BASE}/play/${s.token}/`,
      expiresAt: sessions.expiresAt(s),
      idleMs: PLAY_IDLE_MS,
    };
  });

  // ── 文件 ──────────────────────────────────────────────────────────
  app.get(`${API_BASE}/play/:token`, async (req, reply) =>
    reply.redirect(`${API_BASE}/play/${encodeURIComponent((req.params as { token: string }).token)}/`, 302));

  app.get(`${API_BASE}/play/:token/*`, async (req, reply) => {
    /*
      **刻意不 requireAuth**：子资源带不上 cookie（见文件头）。令牌自己
      就是凭据，它是在换的时候按可见性发出去的。
    */
    const { token } = req.params as { token: string };
    const s = sessions.get(token);
    if (!s) {
      return reply
        .status(404).type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .send(gonePage());
    }
    const current = await findUserForAuth(sql, s.viewerId);
    const viewer = current?.user;
    const access = await resolveAppAccess(sql, s.owner, s.slug,
      viewer?.status === 'active' ? { uid: viewer.id, role: viewer.role } : null);
    if (!viewer || viewer.status !== 'active' || current?.tokenEpoch !== s.epoch || access.kind !== 'ok') {
      return reply.status(403).header('cache-control', 'no-store').send('访问权限已失效。');
    }
    sessions.touch(s);

    /*
      站点根是 /srv/sites/{owner}/{slug}，它**本身是指向 releases 的软链**
      （发布时原子切换的那一条）。safeResolve 的第二道拿 root 的 realpath
      去比，正是为了这种情况——拿原样 root 比会让每个请求都 403。
    */
    const root = join(sitesRoot, s.owner, s.slug);
    const rel = (req.params as Record<string, string>)['*'] ?? '';

    const r = await serveFile(reply, {
      root,
      rel,
      transformHtml: (html) => injectStorageShim(dropSelfBase(stripPlatformChrome(html), s.owner, s.slug)),
    });
    if (!r.ok) {
      return reply
        .status(404).type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .send(missingPage(rel, r.wantedIndex));
    }
    return reply;
  });
}

/**
 * 摘掉发布时注进去的平台 chrome（shell.js）。
 *
 * 那条 chrome 是给**真正打开页面的人**用的：顶上一行地址、一个登录/返回
 * 入口。嵌在详情页那张小预览框里它只会碍事——而且更糟的是，它在沙箱里
 * 调不到接口（opaque origin 发不出带凭据的请求），于是永远显示一颗
 * 「登录」按钮，看的人以为自己掉线了。线上截图里就是这个样子。
 *
 * 只在试玩这条路上摘，发布产物一个字节不改。
 */
function stripPlatformChrome(html: string): string {
  return html.replace(
    /<script[^>]+src=["'][^"']*\/platform\/shell\.js["'][^>]*>\s*<\/script>/gi,
    '',
  );
}

const gonePage = () => noticePage(`
  <h1>预览已经过期</h1>
  <p>刷新这一屏就会重新加载。</p>`);

const missingPage = (rel: string, wantedIndex: boolean) => noticePage(
  wantedIndex
    ? `<h1>这个页面没有首页文件</h1>
       <p>发布产物里没有 index.html。</p>`
    : `<h1>没有这个文件</h1>
       <p><code>${escapeHtml(rel)}</code> 不在这个页面的产物里。</p>`,
);
