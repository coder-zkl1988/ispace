import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EVENT_PATH,
  type App as AppEntity, type Interest,
} from '@ispace/contracts';
import { GlobalKeyframes, Icon, Toast, ToneProvider, copyText } from '@ispace/ui';
import { Activity } from './event/Activity';
import { Judge } from './event/Judge';
import { Screen } from './event/Screen';
import { Award } from './event/Award';
import {
  api, type InstalledApp, type Listing, type MeResponse, type PendingShare,
} from './api';
import { isSpaPath } from './nav';
import { Shell, type NavKey, type PinnedApp } from './shell';
import { Explore, playInNewTab } from './explore';
import { Detail } from './detail';
import { Author } from './author';
import { Mine } from './mine';
import type { ExposedBackend } from './api';
import { ForYou } from './foryou';
import { Create } from './create';
import { Login, ResetPassword } from './login';
import { appHref, initial } from './wall';

/**
 * 统一入口。
 *
 * ┌─ 改版后的地址表 ──────────────────────────────────────────────────┐
 * │ /                探索（未登录则登录页）                            │
 * │ /foryou          为你推荐                                          │
 * │ /create          创建                                              │
 * │ /mine            我的作品                                          │
 * │ /app/{u}/{slug}  应用详情                                          │
 * │ /{user}          作者主页（改版前这里是「我的页面」，见 author.tsx）│
 * │ /console         控制台（另一个 SPA，侧栏里那两条通往它）          │
 * │ /reset、/1024*   原样                                              │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 四条新顶层路径（app/create/foryou/mine）已经进了 RESERVED_PATHS 与
 * Caddyfile 的排除列表——少一条，网关就会拿 /app/lixiao/ 去 /srv/sites
 * 里找文件（contracts/reserved.ts 开头那段写了这三处为什么必须同步）。
 */
export function App() {
  const path = location.pathname.replace(/\/$/, '');

  /*
    重置密码页在最前面分流：它按定义就是「登不进去的人」才会走到，
    先去拉 /me 只会拿到 401 然后落到登录页，令牌就白发了。
  */
  if (path === '/reset') {
    return (
      <ToneProvider tone="business">
        <GlobalKeyframes />
        <ResetPassword />
      </ToneProvider>
    );
  }

  /*
    1024 程序员节。三条路径都在 Space 之前分流，理由各不相同：

      /1024         活动详情**不要求登录**。走 Space 的话会先拉 /me，
                    401 之后落到登录页——而这一页的全部意义就是
                    「没登录也能看」。
      /1024/screen  会议室大屏，同样免登录（投屏的那台机器不会有人登录）。
      /1024/judge   要登录且要是评委，但那层判断由它自己向服务端要。
  */
  if (path === EVENT_PATH) return <Activity />;
  if (path === `${EVENT_PATH}/judge`) return <Judge />;
  if (path === `${EVENT_PATH}/screen`) return <Screen />;
  if (path === `${EVENT_PATH}/award`) return <Award />;

  return <Space />;
}

// ── 路由 ────────────────────────────────────────────────────────────────
type Route =
  | { k: 'explore' }
  | { k: 'foryou' }
  | { k: 'create' }
  | { k: 'mine' }
  | { k: 'detail'; owner: string; slug: string }
  | { k: 'author'; username: string };

function parse(path: string): Route {
  const seg = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (seg.length === 0) return { k: 'explore' };
  if (seg[0] === 'foryou') return { k: 'foryou' };
  if (seg[0] === 'create') return { k: 'create' };
  if (seg[0] === 'mine') return { k: 'mine' };
  if (seg[0] === 'app' && seg[1] && seg[2]) return { k: 'detail', owner: seg[1], slug: seg[2] };
  return { k: 'author', username: seg[0]! };
}

const NAV_OF: Record<Route['k'], NavKey | null> = {
  explore: 'explore',
  /* 详情与作者页都算在「探索」下：它们是从那面墙点进来的 */
  detail: 'explore',
  author: 'explore',
  foryou: 'foryou',
  create: 'create',
  mine: 'mine',
};

function Space() {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname));
  const [me, setMe] = useState<MeResponse | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [apps, setApps] = useState<AppEntity[]>([]);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [shares, setShares] = useState<PendingShare[]>([]);
  const [backends, setBackends] = useState<ExposedBackend[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [interests, setInterests] = useState<Interest[]>([]);
  const [q, setQ] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  /** 创建屏进没进工作台。进了就把外层的顶栏与滚动容器让出来。 */
  const [workbench, setWorkbench] = useState(false);
  /** 「做同款」弹窗里那个页面。 */
  const [remix, setRemix] = useState<Listing | null>(null);
  /** 带进创建页的初稿与来源。 */
  const [draft, setDraft] = useState('');
  const [draftSeq, setDraftSeq] = useState(0);
  const [remixFrom, setRemixFrom] = useState<Listing | null>(null);
  /*
    创建屏去过一次就一直挂着，切到别的屏只是藏起来。

    原来点侧栏离开 iDo 就把整屏卸掉：回来时只能从本地存档"恢复"，对话里
    多一句「刷新前做到这里」，而模型正在跑的那一轮（还在往回流字、往工作区
    写文件）在屏幕上就此断了，预览会话也得重开。藏起来而不是卸掉，回来时
    一切照旧——连输入框里打了一半的字都在。
  */
  const createAlive = useRef(false);
  if (route.k === 'create') createAlive.current = true;

  /** 这一次换屏是不是前进后退来的——是的话把那一屏原来的滚动位置还回去。 */
  const [popped, setPopped] = useState(false);

  /* 前进后退。所有导航都走 pushState，返回键才有东西可回。 */
  const go = useCallback((to: string, r?: Route) => {
    const next = r ?? parse(to);
    /* 点的就是当前这一屏：不压一条重复的历史，也不闪一下 */
    if (to === location.pathname + location.search) return;
    history.pushState({}, '', to);
    setPopped(false);
    setRoute(next);
  }, []);

  useEffect(() => {
    const onPop = () => { setPopped(true); setRoute(parse(location.pathname)); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /*
    站内链接一律在页面里切，不整页刷新。

    侧栏、头像、「去创建」「回到探索」这些原来都是普通的 <a href>，每点一下
    就是一次整页加载：白屏、「载入中…」、/me 和整面墙的数据全部重拉一遍，
    看上去就是"闪"。在这里统一拦，比给每个链接各接一个 onClick 牢靠——以后
    新加的链接自动就对了。

    留给浏览器的：新标签页打开（⌘/Ctrl/Shift/中键）、target=_blank、
    download、别的源、以及不是这个应用的地址（见 isSpaPath）。
  */
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a');
      if (!a || !a.href || a.hasAttribute('download')) return;
      if (a.target && a.target !== '_self') return;
      const url = new URL(a.href);
      if (url.origin !== location.origin || url.hash || !isSpaPath(url.pathname)) return;
      e.preventDefault();
      goRef.current(url.pathname.replace(/(.)\/+$/, '$1') + url.search);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const reloadMine = useCallback(async () => {
    const [a, i, s, b] = await Promise.all([
      api.apps().catch(() => null),
      api.installed().catch(() => null),
      api.pendingShares().catch(() => null),
      // 后端项目的状态在这里顺带校准（服务端逐个问编排器）；失败静默，
      // 「后端」tab 拿到旧值也比空着强
      api.backends().catch(() => null),
    ]);
    if (a) setApps(a.apps);
    if (i) setInstalled(i.installed);
    if (s) setShares(s.shares);
    if (b) setBackends(b.backends);
  }, []);

  const reloadListings = useCallback(async () => {
    const r = await api.marketplace().catch(() => null);
    if (r) setListings(r.listings);
  }, []);

  /*
   * 卡片上的「M 人正在用」是个活数字：presence 窗口 90 秒，这里 45 秒
   * 静默拉一次，让上下线在一个窗口内反映到墙上。只在页面可见且已登录时
   * 拉——后台标签页不需要最新数字；未登录/会话过期时 /marketplace 只会
   * 401，登录页上也没有墙可刷，别白发请求。失败静默，墙保持旧值。
   */
  useEffect(() => {
    const t = setInterval(() => {
      if (me && document.visibilityState === 'visible') void reloadListings();
    }, 45_000);
    return () => clearInterval(t);
  }, [me, reloadListings]);

  useEffect(() => {
    void (async () => {
      const m = await api.me().catch(() => null);
      if (!m) { setSignedOut(true); return; }
      setMe(m);
      await Promise.all([
        reloadMine(),
        reloadListings(),
        api.interests().then((r) => setInterests(r.interests)).catch(() => undefined),
      ]);
    })();
  }, [reloadMine, reloadListings]);

  /*
    「常用」。必须在下面那几个 early return **之前**算——hooks 不能有条件地
    调用，React 会在"未登录 → 已登录"这一跳上数出两套不同的 hook 序列，
    整页白屏（实测踩过）。
  */
  const pinned: PinnedApp[] = useMemo(() => (
    /*
      设计稿里这是手工置顶的一栏，但平台没有置顶这件事。退而取自己最近更新
      的三个页面：它们是作者眼下正在弄的那几个，比按名字排更接近"常用"。
    */
    [...apps]
      .filter((a) => a.status !== 'stopped')
      .sort((x, y) => new Date(y.updatedAt).getTime() - new Date(x.updatedAt).getTime())
      .slice(0, 3)
      .map((a) => ({
        name: a.name,
        letter: a.iconLetter || initial(a.name),
        href: `/${me?.user.username ?? ''}/${a.slug}/`,
      }))
  ), [apps, me]);

  if (signedOut) {
    return (
      <ToneProvider tone="business">
        <GlobalKeyframes />
        <Login />
      </ToneProvider>
    );
  }
  if (!me) {
    return (
      <ToneProvider tone="business">
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)' }}>
          <span style={{ fontSize: 'var(--text-base)' }}>载入中…</span>
        </div>
      </ToneProvider>
    );
  }

  const user = me.user;

  /** 一张卡上的喜欢数在三屏之间共享，所以改动回写到 listings 上。 */
  const applyLike = (appId: string, liked: boolean, likeCount: number) => {
    setListings((prev) => prev.map((l) => (l.app_id === appId ? { ...l, liked, like_count: likeCount } : l)));
  };

  const openDetail = (l: Listing) => go(`/app/${l.owner_username}/${l.slug}`, {
    k: 'detail', owner: l.owner_username, slug: l.slug,
  });
  const openAuthor = (username: string) => go(`/${username}`, { k: 'author', username });
  const openRemix = (l: Listing) => setRemix(l);

  /** 带着一句话进创建页。探索页的输入框和「做同款」都走这条。 */
  const startCreate = (text: string, from: Listing | null) => {
    setDraft(text);
    setDraftSeq((n) => n + 1);
    setRemixFrom(from);
    go('/create', { k: 'create' });
  };

  const detailItem = route.k === 'detail'
    ? listings.find((l) => l.owner_username === route.owner && l.slug === route.slug) ?? null
    : null;

  const body = (() => {
    switch (route.k) {
      case 'explore':
        return (
          <Explore
            listings={listings}
            q={q}
            onClearQ={() => setQ('')}
            onOpen={openDetail}
            onPlay={playInNewTab}
            onRemix={openRemix}
            onAuthor={openAuthor}
            onPrompt={(text) => startCreate(text, null)}
          />
        );
      case 'author':
        return (
          <Author
            username={route.username}
            onOpen={openDetail}
            onPlay={playInNewTab}
            onRemix={openRemix}
            onAuthor={openAuthor}
            onToast={setToast}
          />
        );
      case 'mine':
        return (
          <Mine
            me={user}
            apps={apps}
            installed={installed}
            shares={shares}
            backends={backends}
            onReloadBackends={() => void reloadMine()}
            onOpen={(owner, slug) => { window.open(`/${owner}/${slug}/`, '_blank', 'noopener'); }}
            onManage={(slug) => { location.href = `/console#page=${encodeURIComponent(slug)}`; }}
            onShare={(a) => { location.href = `/console#page=${encodeURIComponent(a.slug)}`; }}
            onReload={() => void reloadMine()}
            onToast={setToast}
            onShareDone={() => void reloadMine()}
          />
        );
      case 'create':
        return null; // 一直挂着，见下面 createAlive 那一支
      case 'detail':
        if (!detailItem) {
          return (
            <div style={{ padding: '80px 32px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
              {listings.length === 0 ? '正在加载…' : (
                <>
                  这个页面不在探索里（可能没上架，或者已经下架）。
                  <br />
                  <a href={`/${route.owner}/${route.slug}/`} style={{ color: 'var(--text-primary)' }}>
                    直接打开 /{route.owner}/{route.slug}/ →
                  </a>
                </>
              )}
            </div>
          );
        }
        return (
          <Detail
            item={detailItem}
            me={user}
            siblings={listings}
            onSibling={openDetail}
            onAuthor={openAuthor}
            onRemix={openRemix}
            onManage={(l) => { location.href = `/console#page=${encodeURIComponent(l.slug)}`; }}
            onToast={setToast}
            onInstalled={() => { void reloadMine(); void reloadListings(); }}
            onLiked={applyLike}
          />
        );
      case 'foryou':
        return null; // 它自带顶栏，见下面 chrome=false 那一支
    }
  })();

  const shell = (
    <Shell
      me={user}
      nav={NAV_OF[route.k]}
      q={q}
      onQ={(v) => {
        setQ(v);
        /* 在别的屏上打字直接回探索——搜索框搜的是那面墙 */
        if (v && route.k !== 'explore') go('/', { k: 'explore' });
      }}
      pinned={pinned}
      shares={shares}
      onShareDone={() => void reloadMine()}
      /*
        工作台自己管顶栏和滚动：它是三栏两页的固定版面，外面再套一层
        会滚动的容器，右栏那三页就各自滚各自的，预览框还会被顶出视野。
        离开创建屏时 workbench 跟着归位（见 setWorkbench 那个 effect）。
      */
      chrome={route.k !== 'foryou' && !(route.k === 'create' && workbench)}
      scrollKey={location.pathname}
      restoreScroll={popped}
      {...(route.k === 'detail' || route.k === 'author' ? { back: () => history.back() } : {})}
    >
      {createAlive.current && (
        /*
          contents：在这一屏时它的根元素直接当外壳容器的孩子，工作台那个
          flex: 1 / height: 100% 的版面不受这层包装影响；不在时整个不显示。
        */
        <div style={{ display: route.k === 'create' ? 'contents' : 'none' }}>
          <Create
            me={user}
            initialDraft={draft}
            draftSeq={draftSeq}
            remix={remixFrom ? { name: remixFrom.name, author: remixFrom.owner_name } : null}
            onClearRemix={() => setRemixFrom(null)}
            onMine={() => { void reloadMine(); go('/mine', { k: 'mine' }); }}
            onWorkbench={setWorkbench}
            onToast={setToast}
          />
        </div>
      )}
      {route.k === 'foryou' ? (
        <ForYou
          listings={listings}
          interests={interests}
          onDetail={openDetail}
          onAuthor={openAuthor}
          onRemix={openRemix}
          onToast={setToast}
          onInstalled={() => { void reloadMine(); void reloadListings(); }}
          onLiked={applyLike}
        />
      ) : body}
    </Shell>
  );

  return (
    <ToneProvider tone="business">
      <GlobalKeyframes />
      {shell}
      {remix && (
        <RemixDialog
          item={remix}
          onClose={() => setRemix(null)}
          onHere={() => {
            const l = remix;
            setRemix(null);
            startCreate(l.source_prompt ?? `做一个和「${l.name}」类似的页面：`, l);
          }}
          onCopy={() => {
            const l = remix;
            setRemix(null);
            void copyText(l.source_prompt ?? '')
              .then((ok) => setToast(ok ? '提示词已复制，粘贴给你的 AI 就行' : '复制不了，去详情页里手动选中'));
          }}
        />
      )}
      {toast && <Toast message={toast} tone="info" onClose={() => setToast(null)} />}
    </ToneProvider>
  );
}

/**
 * 「做同款」（改版稿那个弹窗）。
 *
 * 两条路：在 iSpace 里做（带着提示词进创建页），或者把提示词交给自己的
 * AI。第二条不是退路——很多人本来就在 Claude / Codex 里写代码，装过
 * MCP 之后一句「发到我的空间」就上线了，比在网页里等更顺手。
 */
function RemixDialog({
  item, onClose, onHere, onCopy,
}: {
  item: Listing;
  onClose: () => void;
  onHere: () => void;
  onCopy: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 90, display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 24, boxSizing: 'border-box',
        background: 'rgba(24,23,21,.32)', backdropFilter: 'blur(6px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 460, boxSizing: 'border-box', padding: 24,
          borderRadius: 24, background: 'var(--surface-1)',
          boxShadow: '0 40px 80px -24px rgba(24,23,21,.35)',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)' }}>
            做同款
          </span>
          <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            「{item.name}」· {item.owner_name}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Choice
            icon="sparkles" tone="brand" title="在 iSpace 里做"
            desc="带着这句话进创建页，改几个字就能生成，发到你的空间。"
            onClick={onHere}
          />
          <Choice
            icon="copy" tone="plain" title="交给你自己的 AI"
            desc="复制提示词，粘贴到 Claude 或 Codex。装过 iSpace 连接的话，最后说一句「发到我的空间」就能上线。"
            onClick={onCopy}
          />
        </div>

        <span style={{ padding: '6px 2px 0', fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
          只带走做法，不带走数据：原页面里的数据不会被复制。
        </span>
      </div>
    </div>
  );
}

function Choice({
  icon, tone, title, desc, onClick,
}: {
  icon: 'sparkles' | 'copy';
  tone: 'brand' | 'plain';
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 14, width: '100%', padding: 16,
        border: '1px solid var(--border)', borderRadius: 14, background: 'var(--surface-1)',
        cursor: 'pointer', textAlign: 'left',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--text-tertiary)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
    >
      <span
        style={{
          width: 38, height: 38, flex: 'none', borderRadius: 11,
          background: tone === 'brand' ? 'var(--brand-wash)' : 'var(--surface-2)',
          color: tone === 'brand' ? 'var(--tabby-orange-hover)' : 'var(--text-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={19} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
          {title}
        </span>
        <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          {desc}
        </span>
      </span>
    </button>
  );
}

export { appHref };
