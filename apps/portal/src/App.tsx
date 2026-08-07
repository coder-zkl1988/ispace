import { useCallback, useEffect, useMemo, useState } from 'react';
import { MARKETPLACE_CATEGORIES, type App as AppEntity, type AppGroup } from '@ispace/contracts';
import {
  AppIcon, Avatar, AvatarMenu, Badge, Button, Card, CoverBanner, Dialog, fmtBytes, fmtDate,
  GlobalKeyframes, Greeting, Icon, Input, SectionLabel, ShareDialog, StatusDot,
  QrCode, Tabs, Toast, ToneProvider, copyText, useCopy, type ShareVisibility,
} from '@ispace/ui';
import {
  api, ownerFromPath,
  type ApkRelease, type InstalledApp, type Listing, type MeResponse,
  type PendingShare, type AuthPolicy, type SharePeerInfo, type ExposedBackend,
} from './api';

/**
 * 统一入口（规格 D8）。
 *
 * `/`            未登录引导；已登录 302 到 /{me}/
 * `/{user}/`     该用户的「我的页面」聚合卡片墙
 *
 * 方案 v1.2 原本写的是「登录后 302 直达本人页面」，但设计稿的场景是一个人
 * 有 8 个页面——302 到哪一个？聚合页是设计稿给出的修正，本实现以设计稿为准。
 */

type TabKey = 'pages' | 'market';

/**
 * 读 ?redirect= 并**只放行站内路径**。
 *
 * 这是个开放重定向的口子：参数由调用方构造，原样信任的话，别人能构造
 * 一条"登录后跳到外站"的链接，而用户看到的域名一直是自己公司的。
 * 与服务端 decideRedirect 同一套判断：
 *   必须 / 开头，且不能是 //（协议相对 URL，会跑到外站）
 */
function safeRedirect(): string | null {
  const r = new URLSearchParams(location.search).get('redirect');
  if (!r || !r.startsWith('/') || r.startsWith('//')) return null;
  return r;
}

export function App() {
  /*
    重置密码页在最前面分流：它按定义就是「登不进去的人」才会走到，
    先去拉 /me 只会拿到 401 然后落到未登录引导页，令牌就白发了。
  */
  if (location.pathname.replace(/\/$/, '') === '/reset') {
    return (
      <ToneProvider tone="business">
        <GlobalKeyframes />
        <ResetPassword />
      </ToneProvider>
    );
  }
  return <Space />;
}

function Space() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [apps, setApps] = useState<AppEntity[]>([]);
  const [groups, setGroups] = useState<AppGroup[]>([]);
  const [shares, setShares] = useState<PendingShare[]>([]);
  /*
    别人的页面：同事分享给我的、我从创意市场装的。
    与 apps 分开存——它们不属于我，不能改不能分享，只能打开和移除。
  */
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [backends, setBackends] = useState<ExposedBackend[]>([]);
  const [tab, setTab] = useState<TabKey>('pages');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const owner = ownerFromPath();

  const reloadApps = useCallback(async () => {
    const [a, i, be] = await Promise.all([
      api.apps().catch(() => null),
      api.installed().catch(() => null),
      api.backends().catch(() => null),
    ]);
    if (i) setInstalled(i.installed);
    if (be) setBackends(be.backends.filter((b) => b.exposed));
    if (!a) return;
    setApps(a.apps);
    setGroups(a.groups);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const m = await api.me();
        setMe(m);
        /*
          根路径且已登录 → 先看有没有 ?redirect=。
          那是网关鉴权把未登录访客送过来时带上的原地址（见
          routes/authz.ts）：他本来想看某个页面，登完就该回到那儿，
          而不是被丢到自己的空间里再自己找回去。
        */
        if (!owner) {
          location.replace(safeRedirect() ?? `/${m.user.username}/`);
          return;
        }
        /*
          路径上是别人的名字。

          此前这里什么都不做，结果是：标题写着「张三 的页面」，底下列的却是
          **你自己**的应用——因为 api.apps() 压根没有用户名参数，它返回的永远
          是当前会话这个人的东西。同时 isOwner 为 false 又把「同事分享给我的」
          整段藏掉，看起来像卡片凭空消失了。

          界面撒谎比缺功能糟糕得多：它让人怀疑数据出了问题，而实际上数据好好的。

          「逛别人的空间」目前不是这个产品里的概念——看别人做了什么走创意市场，
          单个页面走分享，两条路都有真实的访问控制。所以这里不假装，直接把人
          送回自己的空间。真要做这个功能，需要一个"按访问者可见性过滤某人页面"
          的服务端端点，那是另一件事。
        */
        if (owner !== m.user.username) {
          location.replace(`/${m.user.username}/`);
          return;
        }
        const [a, s, i, be] = await Promise.all([
          api.apps(),
          api.pendingShares().catch(() => ({ shares: [] })),
          api.installed().catch(() => ({ installed: [] })),
          api.backends().catch(() => ({ backends: [] as ExposedBackend[] })),
        ]);
        setApps(a.apps);
        setGroups(a.groups);
        setShares(s.shares);
        setInstalled(i.installed);
        setBackends(be.backends.filter((b) => b.exposed));
      } catch {
        setMe(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [owner]);

  if (loading) return <Splash />;
  if (!me) return <LoggedOut />;

  return (
    <ToneProvider tone="business">
      <GlobalKeyframes />
      <Shell
        me={me}
        tab={tab}
        onTab={setTab}
        q={q}
        onQ={setQ}
      >
        {tab === 'pages' ? (
          <MyPages
            me={me}
            owner={owner ?? me.user.username}
            apps={apps}
            groups={groups}
            installed={installed}
            backends={backends}
            shares={shares}
            q={q}
            onShareResponded={(id) => setShares((prev) => prev.filter((s) => s.id !== id))}
            reloadApps={reloadApps}
          />
        ) : (
          <Market isAdmin={me.user.role === 'admin'} />
        )}
      </Shell>
    </ToneProvider>
  );
}

// ── 骨架 ──────────────────────────────────────────────────────────────
function Shell({
  me, tab, onTab, q, onQ, children,
}: {
  me: MeResponse; tab: TabKey; onTab: (t: TabKey) => void;
  q: string; onQ: (v: string) => void; children: React.ReactNode;
}) {
  const c = useCopy();
  const [qrOpen, setQrOpen] = useState(false);
  const [apkOpen, setApkOpen] = useState(false);
  const compact = useCompactHeader();
  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-canvas)' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', gap: 'var(--space-8)',
        height: 57, padding: '0 var(--space-12)',
        background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        {/*
          产品标识回「我的空间」。用 a 而不是给 div 挂 onClick：这一块是人
          从创意市场、从别人的空间里下意识要点回去的地方，而键盘用户和
          「新标签页打开」都只认真正的链接。
          负外边距抵消掉 hover 底色需要的内边距，视觉位置与原来一致。
        */}
        <a
          href={`/${me.user.username}/`}
          aria-label="回到我的空间"
          onClick={(e) => {
            // 已经在自己的空间里，切回「我的页面」就够了，不必整页重载
            if (ownerFromPath() !== me.user.username) return;
            e.preventDefault();
            onTab('pages');
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--space-5)',
            padding: 'var(--space-3) var(--space-5)', margin: '0 calc(var(--space-5) * -1)',
            borderRadius: 'var(--radius-8)', textDecoration: 'none', cursor: 'pointer',
            color: 'inherit', transition: 'var(--transition-colors)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <img src="/favicon.svg" alt="" aria-hidden="true" style={{ width: 26, height: 26, flex: 'none', display: 'block' }} />
          <strong style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)' }}>
            {c('app.name')}
          </strong>
        </a>
        <span className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          {location.host}/{me.user.username}
        </span>

        <div style={{ marginLeft: 'var(--space-8)' }}>
          <Tabs
            value={tab}
            onChange={onTab}
            items={[
              { value: 'pages' as const, label: c('nav.myPages') },
              { value: 'market' as const, label: c('nav.market') },
            ]}
          />
        </div>

        <div style={{ flex: 1 }} />

        {/* 设计稿顶栏：搜索框内嵌 15px 放大镜，控制台按钮带 12px 滑块图标 */}
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <Icon
            name="search"
            size={15}
            color="var(--text-tertiary)"
            style={{ position: 'absolute', left: 10, pointerEvents: 'none' }}
          />
          <input
            value={q}
            onChange={(e) => onQ(e.target.value)}
            placeholder="搜索我的页面"
            style={{
              width: 240, height: 32, padding: '0 var(--space-8) 0 32px',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-8)',
              background: 'var(--surface-1)', fontSize: 'var(--text-sm)', outline: 'none',
              font: 'var(--weight-regular) var(--text-sm)/1 var(--font-sans)',
            }}
          />
        </div>
        {/*
          装 App 是"还没装的人"才做的事，而没装的人恰恰不会想到去翻头像菜单。
          放在顶栏才有被撞见的机会。ghost 而不是描边按钮：它常驻可见，
          但左边的「我的页面/创意市场」才是这个界面的主干。
        */}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setApkOpen(true)}
          aria-label="下载手机 App"
          title="下载手机 App（安卓）"
        >
          <Icon name="mobile" size={12} />
          {!compact && '下载 App'}
        </Button>
        <a href="/console" style={{ textDecoration: 'none' }}>
          <Button size="sm">
            <Icon name="sliders" size={12} />
            {c('nav.console')}
          </Button>
        </a>
        <AvatarMenu
          name={me.user.displayName}
          subtitle={`${location.host}/${me.user.username}`}
          items={[
            { label: '我的空间', href: `/${me.user.username}/` },
            { label: '控制台', href: '/console' },
            { label: '手机扫码登录', onClick: () => setQrOpen(true) },
            {
              label: '退出登录',
              danger: true,
              /*
                无论服务端那一步成不成都要离开当前页。
                写成 .then(...) 的话请求一失败就什么都不发生，
                用户看到的是"点了没反应"，连条错误都没有。
                会话 cookie 是 HttpOnly，前端清不掉，所以真失败时也得
                走到 / 让人看见自己还登着，而不是停在原地猜。

                回根路径而不是留在原地：留在 /{user}/ 会立刻被未登录
                引导页接管，看起来像"退出失败又弹回来了"。
              */
              onClick: () => {
                void api.logout().catch(() => undefined).finally(() => location.replace('/'));
              },
            },
          ]}
        />
      </header>

      {/* 1120 在宽屏上两侧留白太多、卡片墙只排得下三列。提到 1400 挤走留白，
          能排四列，卡片更充实——「我的页面」与「创意市场」两个 tab 都走这个 main。 */}
      <main style={{ maxWidth: 1400, margin: '0 auto', padding: 'var(--space-16) var(--space-12) var(--space-24)' }}>
        {children}
      </main>
      {qrOpen && <QrLoginDialog onClose={() => setQrOpen(false)} />}
      {apkOpen && <AppDownloadDialog onClose={() => setApkOpen(false)} />}
    </div>
  );
}

const COMPACT_HEADER = '(max-width: 900px)';

/**
 * 顶栏窄到放不下文字时的信号。
 *
 * 这条顶栏里几乎每样东西都是定宽的——240px 的搜索框、两个标签页、
 * 控制台按钮——横向没有让位的余地，多一段文字就把右侧顶出视口。
 * 图标本身能撑住"这里能下载 App"的意思，文字是锦上添花的那部分，
 * 所以窄屏先舍它。
 *
 * 用 matchMedia 而不是媒体查询：这套界面的样式全写在行内，
 * 没有一张可以挂断点的样式表。
 */
function useCompactHeader(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_HEADER).matches);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_HEADER);
    const sync = () => setCompact(mq.matches);
    // 初值是首次渲染时算的，订阅之前这中间窗口可能已经变过
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return compact;
}

/**
 * 手机扫码登录（设计稿第 10 屏「扫码登录」的桌面侧）。
 *
 * 流向：**已登录的桌面**生成二维码，**未登录的手机**扫它换会话。
 * 手机有摄像头、桌面有会话，各出各的——不用在手机上敲一遍密码。
 *
 * 码 60 秒过期、用一次即毁。倒计时要显式画出来：二维码长得都一样，
 * 不标剩余时间的话，用户扫一个已过期的码只会得到一句"无效"，
 * 然后以为功能坏了。
 */
function QrLoginDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const mint = useCallback(() => {
    setErr(null); setCode(null);
    void api.mintQrCode()
      .then((r) => { setCode(r.code); setLeft(r.expiresIn); })
      .catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(mint, [mint]);

  // 每秒走一格。到 0 不自动续——桌面挂着这个弹窗没人看时，
  // 自动续等于持续不断地铸有效登录码，白白扩大被拍屏的窗口。
  useEffect(() => {
    if (!code || left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [code, left]);

  const expired = code !== null && left <= 0;

  return (
    <Dialog
      open
      title="手机扫码登录"
      description="打开 iSpace 手机 App，在登录页点「扫码登录」，对准这个码。"
      onClose={onClose}
      width={360}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-8)' }}>
        {err ? (
          <p style={{ margin: 0, color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</p>
        ) : !code ? (
          <p style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>生成中…</p>
        ) : (
          <div style={{ position: 'relative' }}>
            <QrCode text={`ispace-login:${code}`} size={180} />
            {expired && (
              <div style={{
                position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                background: 'rgba(252,252,248,.92)', borderRadius: 'var(--radius-8)',
              }}>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>已过期</span>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
          {code && !expired && (
            <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              {left} 秒内有效，扫一次即失效
            </span>
          )}
          {expired && <Button size="sm" variant="primary" onClick={mint}>重新生成</Button>}
        </div>

        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.6 }}>
          扫码即以你的身份登录那台手机。生成记录会进审计日志。
        </p>
      </div>
    </Dialog>
  );
}

/**
 * 下载手机 App（安卓）。
 *
 * 与「扫码登录」正好相反：那边是桌面出码、手机换会话；这边是桌面出码、
 * 手机拿安装包。二维码里放的是 apk 的**完整地址**——手机不在这个页面上，
 * 相对路径它补不出 origin。
 *
 * 这条下载路径刻意不需要登录（Caddyfile 的 handle /dist/*，落在带
 * forward_auth 的 @userapp 之前）。要求先登录的话，人得先在手机浏览器里
 * 敲一遍公司邮箱密码才能装 App，而装 App 本来就是为了不用再敲密码。
 *
 * 版本号、体积、更新时间都显式列出：装机包这种东西，用户唯一能自查的
 * 就是"我下的是不是最新的那一个"，不给版本号就只能靠猜。
 */
function AppDownloadDialog({ onClose }: { onClose: () => void }) {
  const [rel, setRel] = useState<ApkRelease | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void api.apkRelease()
      .then(setRel)
      .catch((e: Error) => setErr(e.message));
  }, []);

  // origin 而不是写死域名：平台 http/https 都能进，写死一个会让另一边扫出来
  // 的码指向错误的协议——http 页面上扫出 https 链接，手机上大概率连不上。
  const url = rel ? `${location.origin}${rel.url}` : '';

  return (
    <Dialog
      open
      title="下载手机 App"
      description="用手机扫码，或复制链接在手机浏览器里打开。装完在登录页点「扫码登录」即可。"
      onClose={onClose}
      width={380}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-8)' }}>
        {err ? (
          <p style={{ margin: 0, color: 'var(--danger)', fontSize: 'var(--text-sm)', textAlign: 'center', lineHeight: 1.6 }}>
            {err}
            <br />
            安装包可能还没发布，找管理员跑一次 14-publish-apk.sh。
          </p>
        ) : !rel ? (
          <p style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>读取版本信息…</p>
        ) : (
          <>
            <QrCode text={url} size={180} label="安卓安装包下载地址的二维码" />

            {/* 版本 / 体积 / 更新时间。三项都是用户下载前会想确认的。 */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexWrap: 'wrap', gap: 'var(--space-6)',
              fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
            }}>
              <span className="num">v{rel.version}（{rel.versionCode}）</span>
              <span style={{ color: 'var(--text-tertiary)' }}>·</span>
              <span className="num">{fmtBytes(rel.sizeBytes)}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>·</span>
              <span className="num">{fmtLocalTime(rel.builtAt)}</span>
            </div>

            {/* 链接明文摆出来：扫不了码的人（比如手机没相机权限）得能照着敲。 */}
            <div style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
              background: 'var(--surface-2)', borderRadius: 'var(--radius-8)',
              padding: 'var(--space-6) var(--space-8)',
            }}>
              <span className="mono" style={{
                flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{url}</span>
              {/*
                走 copyText 而不是 navigator.clipboard：平台跑在明文 HTTP 上时
                后者根本不存在，读属性那一步就抛，表现为按钮点了没反应。
                两条路都失败时明确让用户手动选中，不装作复制成功。
              */}
              <Button size="sm" onClick={() => {
                void copyText(url).then((ok) => {
                  setCopied(ok);
                  if (ok) setTimeout(() => setCopied(false), 1600);
                  else setMsg('复制不了，请手动选中上面的地址');
                });
              }}>
                {copied ? '已复制' : '复制链接'}
              </Button>
            </div>

            <a href={rel.url} download={rel.file} style={{ width: '100%', textDecoration: 'none' }}>
              <Button variant="primary" style={{ width: '100%' }}>
                <Icon name="mobile" size={13} />
                在这台电脑上下载
              </Button>
            </a>

            {msg && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{msg}</div>
            )}

            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.6 }}>
              仅安卓。安装时若提示「未知来源」，在系统设置里允许当前浏览器安装即可。
              <br />
              <span className="mono" style={{ fontSize: 'var(--text-2xs)' }}>
                sha256 {rel.sha256.slice(0, 16)}…
              </span>
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * 按本地时区显示一个 UTC 时刻。
 *
 * 不用 fmtDate：它是直接切 ISO 字符串的，而 version.json 里的时间带 Z，
 * 切出来是 UTC。北京时间的同事会看到一个早 8 小时的"更新时间"，
 * 刚发完版就显示成昨晚发的。
 */
function fmtLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 我的页面 ──────────────────────────────────────────────────────────
function MyPages({
  me, owner, apps, groups, installed, backends, shares, q, onShareResponded, reloadApps,
}: {
  me: MeResponse; owner: string; apps: AppEntity[]; groups: AppGroup[];
  installed: InstalledApp[];
  backends: ExposedBackend[];
  shares: PendingShare[]; q: string; onShareResponded: (id: string) => void;
  reloadApps: () => Promise<void>;
}) {
  // 分享对话框由这一层持有：卡片是纯展示，弹窗不该在每张卡里各开一个
  const [sharing, setSharing] = useState<AppEntity | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const c = useCopy();
  const isOwner = me.user.username === owner;

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return apps;
    return apps.filter(
      (a) => a.name.toLowerCase().includes(kw) || a.slug.toLowerCase().includes(kw),
    );
  }, [apps, q]);

  const running = apps.filter((a) => a.status === 'running').length;
  const ungrouped = filtered.filter((a) => !a.groupId);

  const filteredInstalled = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return installed;
    return installed.filter(
      (a) => a.name.toLowerCase().includes(kw) || a.slug.toLowerCase().includes(kw),
    );
  }, [installed, q]);

  return (
    <>
      {shares.map((s) => (
        <ShareCard key={s.id} share={s} onDone={() => onShareResponded(s.id)} />
      ))}

      <div style={{ margin: 'var(--space-16) 0 var(--space-12)' }}>
        <Greeting>Happy Working</Greeting>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-8)', marginTop: 'var(--space-2)' }}>
          <h1 style={{ margin: 0, font: 'var(--weight-bold) var(--text-2xl)/1.2 var(--font-sans)', color: 'var(--text-heading)' }}>
            {isOwner ? `${me.user.displayName}的页面` : `${owner} 的页面`}
          </h1>
          <StatusDot
            status="running"
            label={`${apps.length} 个页面 · ${running} 个运行中`}
          />
        </div>
      </div>

      {apps.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {ungrouped.length > 0 && (
            <Section title={groups.length ? '未分组' : '全部'} apps={ungrouped} owner={owner} onShare={setSharing} />
          )}
          {groups.map((g) => {
            const inGroup = filtered.filter((a) => a.groupId === g.id);
            if (!inGroup.length) return null;
            return <Section key={g.id} title={g.name} apps={inGroup} owner={owner} onShare={setSharing} />;
          })}
          {filtered.length === 0 && (
            <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-base)' }}>
              没有匹配「{q}」的页面
            </p>
          )}
        </>
      )}

      {isOwner && backends.length > 0 && (
        <BackendSection items={backends} owner={owner} />
      )}
      {isOwner && filteredInstalled.length > 0 && (
        <InstalledSection items={filteredInstalled} onRemoved={reloadApps} />
      )}
      <p style={{ marginTop: 'var(--space-20)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
        {c('oneline.scanNote')}
      </p>

      {shareMsg && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)',
          background: 'var(--accent)', color: 'var(--accent-fg)',
          padding: 'var(--space-6) var(--space-10)', borderRadius: 'var(--radius-pill)',
          fontSize: 'var(--text-sm)', boxShadow: 'var(--shadow-dropdown)', zIndex: 60,
        }}>{shareMsg}</div>
      )}
      {sharing && (
        <AppShareDialog
          app={sharing}
          owner={owner}
          onClose={() => setSharing(null)}
          onChanged={() => void reloadApps()}
        />
      )}
    </>
  );
}

function Section({
  title, apps, owner, onShare,
}: {
  title: string; apps: AppEntity[]; owner: string; onShare: (a: AppEntity) => void;
}) {
  return (
    <section style={{ marginBottom: 'var(--space-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', marginBottom: 'var(--space-8)' }}>
        <SectionLabel>{title}</SectionLabel>
        <span className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: -8 }}>
          {apps.length}
        </span>
      </div>
      <div style={{
        display: 'grid', gap: 'var(--space-8)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
      }}>
        {apps.map((a) => <AppCard key={a.id} app={a} owner={owner} onShare={onShare} />)}
      </div>
    </section>
  );
}

/**
 * 别人的页面：同事分享给我的、我从创意市场装的。
 *
 * 单独一区而不是混进上面的宫格：这些页面不属于我——改不了、分享不了、
 * 删不掉（只能从自己这儿移除）。混在一起会让人以为「删除」会删掉别人
 * 的东西。归属写在卡片上，点开去的也是对方空间下的地址。
 */
/**
 * 露出的后端应用（全栈项目）。
 *
 * 与静态页面同处一屏但单列一节：它们是活着的容器、不是文件，能开能停，
 * 访问地址是 /svc/{user}/{name}/ 而非 /{user}/{app}/。混进上面的卡片墙会
 * 让人以为能像页面那样回滚、看版本——那些对后端不成立。
 */
function BackendSection({ items, owner }: { items: ExposedBackend[]; owner: string }) {
  const c = useCopy();
  return (
    <section style={{ marginBottom: 'var(--space-16)' }}>
      <div style={{ marginBottom: 'var(--space-8)' }}>
        <SectionLabel>应用（后端）</SectionLabel>
      </div>
      <div style={{
        display: 'grid', gap: 'var(--space-8)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
      }}>
        {items.map((b) => {
          const url = `/svc/${owner}/${b.name}/`;
          const running = b.status === 'running';
          return (
            <Card key={b.id} hoverable style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {b.hasCover && <CoverBanner src={`/deploy/api/backends/${b.id}/cover`} alt={b.name} />}
              <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'flex-start' }}>
                {!b.hasCover && <AppIcon letter={b.name.slice(0, 1)} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <a href={url} style={{
                    display: 'block', textDecoration: 'none', color: 'var(--text-heading)',
                    font: 'var(--weight-semibold) var(--text-card-title)/1.3 var(--font-sans)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{b.name}</a>
                  <div className="mono" style={{
                    fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{location.host}{url}</div>
                </div>
                <Badge tone={b.visibility === 'public' ? 'success' : 'brand'}>
                  {b.visibility === 'public' ? '全公司' : b.visibility === 'shared' ? '指定同事' : '仅自己'}
                </Badge>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginTop: 'auto' }}>
                <StatusDot status={running ? 'running' : 'stopped'}
                  label={running ? c('status.running') : c('status.stopped')} />
                <div style={{ flex: 1 }} />
                {/* 分享=复制链接。谁能打开由可见性决定（在控制台后端屏改），
                    公开的发给谁都能开；private/shared 的对方得有权限。 */}
                <button
                  onClick={(e) => { e.stopPropagation(); void copyText(`${location.origin}${url}`); }}
                  style={{
                    border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                    fontSize: 'var(--text-sm)', color: 'var(--link)',
                  }}
                >复制链接</button>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function InstalledSection({
  items, onRemoved,
}: { items: InstalledApp[]; onRemoved: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const remove = async (a: InstalledApp) => {
    setBusy(a.id); setErr(null);
    try {
      await api.removeInstalled(a.id);
      await onRemoved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  return (
    <section style={{ marginBottom: 'var(--space-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', marginBottom: 'var(--space-8)' }}>
        <SectionLabel>同事的页面</SectionLabel>
        <span className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: -8 }}>
          {items.length}
        </span>
      </div>
      {err && (
        <p role="alert" style={{ margin: '0 0 var(--space-6)', color: 'var(--error)', fontSize: 'var(--text-base)' }}>
          {err}
        </p>
      )}
      <div style={{
        display: 'grid', gap: 'var(--space-8)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
      }}>
        {items.map((a) => {
          const url = `/${a.owner_username}/${a.slug}/`;
          return (
            <Card key={a.id} hoverable style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              {a.cover_path && <CoverBanner src={a.cover_path} alt={a.name} />}
              <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'flex-start' }}>
                {!a.cover_path && <AppIcon letter={a.icon_letter} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <a href={url} style={{
                    display: 'block', textDecoration: 'none', color: 'var(--text-heading)',
                    font: 'var(--weight-semibold) var(--text-card-title)/1.3 var(--font-sans)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{a.name}</a>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {a.owner_name} 的页面 · {a.source === 'marketplace' ? '来自创意市场' : '同事分享'}
                  </div>
                </div>
              </div>

              {a.description && (
                <p style={{
                  margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-secondary)',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>{a.description}</p>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginTop: 'auto' }}>
                <StatusDot
                  status={a.status === 'running' ? 'running' : a.status === 'building' ? 'building' : 'stopped'}
                  label={a.status === 'running' ? '运行中' : a.status === 'building' ? '构建中' : '已停止'}
                />
                <div style={{ flex: 1 }} />
                <Button size="sm" variant="ghost" disabled={busy === a.id}
                  onClick={() => void remove(a)}>
                  {busy === a.id ? '移除中…' : '从我这儿移除'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { location.href = url; }}>打开</Button>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function AppCard({
  app, owner, onShare,
}: { app: AppEntity; owner: string; onShare: (a: AppEntity) => void }) {
  const c = useCopy();
  const url = `/${owner}/${app.slug}/`;
  const statusLabel = c(
    app.status === 'running' ? 'status.running'
    : app.status === 'building' ? 'status.building'
    : 'status.stopped',
  );
  return (
    <Card
      hoverable
      onClick={() => { location.href = url; }}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
    >
      {app.coverUrl && <CoverBanner src={app.coverUrl} alt={app.name} />}
      <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'flex-start' }}>
        {/* 有封面 banner 时字母块是重复的视觉标识，撤掉；没封面才靠它认页面 */}
        {!app.coverUrl && <AppIcon letter={app.iconLetter} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <a href={url} onClick={(e) => e.stopPropagation()} style={{
            display: 'block', textDecoration: 'none', color: 'var(--text-heading)',
            font: 'var(--weight-semibold) var(--text-card-title)/1.3 var(--font-sans)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{app.name}</a>
          {/* 副标题用页面简介，不再显示那串地址——地址点标题就到，念它没意义。
              没简介就留空，不硬塞一行占位。 */}
          {app.description && (
            <div style={{
              fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 2,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{app.description}</div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginTop: 'auto' }}>
        <StatusDot status={app.status} label={statusLabel} />
        <div style={{ flex: 1 }} />
        <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          {fmtDate(app.updatedAt).slice(5, 10)}
        </span>
        {/* 分享是这一屏的主要动作之一，之前只能到控制台深处去做 */}
        <button
          onClick={(e) => { e.stopPropagation(); onShare(app); }}
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
            fontSize: 'var(--text-sm)', color: 'var(--link)',
          }}
        >{c('action.share')}</button>
        {/* 去控制台的「我的页面」tab。原先指 #/apps/{slug}，那不是合法的
            screen key，控制台会落到默认屏——点「管理」却到了别处。 */}
        <a href="/console#/pages" onClick={(e) => e.stopPropagation()} style={{
          fontSize: 'var(--text-sm)', color: 'var(--link)', textDecoration: 'none',
        }}>{c('action.manage')}</a>
      </div>
    </Card>
  );
}

/**
 * 分享弹窗的数据接线。
 *
 * 弹窗本体在 @ispace/ui（控制台也用同一个）。这里只负责把它接到 portal 的
 * API 上：打开时拉一次「已分享给谁」，操作后回调上层刷新卡片——
 * 可见范围变了，卡片右上角的徽标也得跟着变，不刷新会让人以为没生效。
 */
function AppShareDialog({
  app, owner, onClose, onChanged,
}: { app: AppEntity; owner: string; onClose: () => void; onChanged: () => void }) {
  const [peers, setPeers] = useState<SharePeerInfo[]>([]);

  const loadPeers = useCallback(() => {
    void api.appShares(app.id).then((r) => setPeers(r.peers)).catch(() => setPeers([]));
  }, [app.id]);
  useEffect(loadPeers, [loadPeers]);

  return (
    <ShareDialog
      open
      appName={app.name}
      shareUrl={`${location.origin}/${owner}/${app.slug}/`}
      visibility={app.visibility as ShareVisibility}
      peers={peers}
      onClose={onClose}
      onVisibilityChange={async (v) => {
        await api.setVisibility(app.id, v);
        loadPeers();
        onChanged();
      }}
      onAddPeer={async (username) => {
        await api.share(app.id, username);
        loadPeers();
        onChanged();
      }}
      onRemovePeer={async (username) => {
        await api.revokeShareTo(app.id, username);
        loadPeers();
        onChanged();
      }}
    />
  );
}

function ShareCard({ share, onDone }: { share: PendingShare; onDone: () => void }) {
  const c = useCopy();
  const [busy, setBusy] = useState(false);
  const respond = async (accept: boolean) => {
    setBusy(true);
    try { await api.respondShare(share.id, accept); onDone(); }
    finally { setBusy(false); }
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-10)',
      background: 'var(--tabby-orange-subtle)', border: '1px solid var(--tabby-orange)',
      borderRadius: 'var(--radius-16)', padding: 'var(--space-10) var(--space-12)',
      marginBottom: 'var(--space-8)',
    }}>
      <Avatar name={share.fromUser.displayName} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-md)' }}>
          {share.fromUser.displayName} {c('share.pendingTitle')}「{share.app.name}」
        </div>
        <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', marginTop: 2 }}>
          {c('share.pendingNote')}
        </div>
      </div>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => void respond(true)}>
        {c('action.accept')}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond(false)}>
        {c('action.reject')}
      </Button>
    </div>
  );
}

function EmptyState() {
  const c = useCopy();
  const phrase = '把这个项目部署到我的空间，路径 /zhoubao';
  // 三态：null 未点 / 'ok' 成功 / 'fail' 复制不了（HTTP 下浏览器可能不给用）
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  return (
    <Card style={{ textAlign: 'center', padding: 'var(--space-24) var(--space-12)' }}>
      <div style={{ font: 'var(--weight-semibold) var(--text-lg)/1.4 var(--font-sans)', color: 'var(--text-heading)' }}>
        {c('pages.empty.title')}
      </div>
      <p style={{ margin: 'var(--space-6) auto var(--space-10)', maxWidth: 460, color: 'var(--text-secondary)' }}>
        {c('pages.empty.hint')}
      </p>
      <div className="mono" style={{
        display: 'inline-block', background: 'var(--accent)', color: 'var(--accent-fg)',
        padding: 'var(--space-6) var(--space-10)', borderRadius: 'var(--radius-10)',
        fontSize: 'var(--text-sm)',
      }}>{phrase}</div>
      <div style={{ marginTop: 'var(--space-8)' }}>
        <Button size="sm" onClick={() => {
          /*
            失败也要有反馈，但**不能用 alert**——它会阻塞 JS 线程，
            而这条路径恰恰是在浏览器不给用剪贴板时才走到的，
            一个堵死页面的弹窗只会让情况更糟。用按钮自身的文案说。
          */
          void copyText(phrase).then((done) => {
            setCopied(done ? 'ok' : 'fail');
            setTimeout(() => setCopied(null), done ? 1600 : 2600);
          });
        }}>
          {copied === 'ok' ? '已复制'
            : copied === 'fail' ? '复制不了，请手动选中'
            : c('pages.empty.copyPhrase')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * 创意市场（设计稿顶部第二个 tab）。
 *
 * 与「分享给个人」的区别：那个是定向推送、要对方接受；这个是主动上架、
 * 谁都能自助添加。添加只建立引用不复制内容——原作者更新，使用者下次
 * 打开就是新版；原作者下架，引用随之失效。
 */
function Market({ isAdmin }: { isAdmin: boolean }) {
  const [listings, setListings] = useState<Listing[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** 正在看提示词的那条 listing。null 表示弹窗关着。 */
  const [remix, setRemix] = useState<Listing | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  /** 选中的分类，null=全部。本地搜索词。数据量是一个公司的共享页面，客户端过滤足够。 */
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = () => void api.marketplace()
    .then((r) => setListings(r.listings))
    .catch(() => setListings([]))
    .finally(() => setLoaded(true));
  useEffect(load, []);

  /**
   * 管理员下架别人上架的内容。
   *
   * 市场自带的下架只认「published_by = 自己」，管理员管不了别人的东西。
   * 内部平台上这条一定会用到：有人上架了不该全公司可见的内容，
   * 而作者可能正在休假。
   *
   * 只下架、不删应用——内容仍归作者，管理员该做的是收窄可见范围。
   */
  const unlist = async (l: Listing) => {
    if (!confirm(
      `把「${l.name}」从创意市场下架？\n\n`
      + `作者是 ${l.owner_name}。页面本身和数据都保留，只是不再对全公司可见；`
      + '已添加过的同事会失去入口。作者可以自己重新上架。',
    )) return;
    setBusy(l.app_id);
    try { await api.adminUnlist(l.app_id); load(); }
    finally { setBusy(null); }
  };

  const toggle = async (l: Listing) => {
    setBusy(l.app_id);
    try {
      if (l.installed) await api.uninstallFromMarket(l.app_id);
      else await api.installFromMarket(l.app_id);
      load();
    } finally { setBusy(null); }
  };

  if (!loaded) return null;

  if (listings.length === 0) {
    return (
      <Card style={{ textAlign: 'center', padding: 'var(--space-24) var(--space-12)' }}>
        <div style={{ font: 'var(--weight-semibold) var(--text-lg)/1.4 var(--font-sans)' }}>
          市场里还没有页面
        </div>
        <p style={{ margin: 'var(--space-6) auto 0', maxWidth: 460, color: 'var(--text-secondary)' }}>
          在控制台「我的页面」里点某个页面的「版本」，就能把它分享到全公司。
          上架后同事在这里添加即用，不需要你逐个发给他们。
        </p>
      </Card>
    );
  }

  // 分类：AI 决定、可自造，未分类归「其他」。侧边栏按实际出现的分类聚合——
  // 不再限定在固定清单里，AI 造的新分类也会自动成为一档。
  const catOf = (l: Listing) => l.category?.trim() || '其他';
  const counts = new Map<string, number>();
  for (const l of listings) counts.set(catOf(l), (counts.get(catOf(l)) ?? 0) + 1);
  // 排序：建议清单里的按清单顺序在前，AI 自造的按名称跟其后，「其他」永远垫底。
  const cats = [...counts.keys()].sort((a, b) => {
    if (a === '其他') return 1; if (b === '其他') return -1;
    const ia = (MARKETPLACE_CATEGORIES as readonly string[]).indexOf(a);
    const ib = (MARKETPLACE_CATEGORIES as readonly string[]).indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1; if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  const kw = q.trim().toLowerCase();
  const visible = listings.filter((l) =>
    (cat === null || catOf(l) === cat)
    && (!kw || `${l.name} ${l.description ?? ''} ${l.owner_name}`.toLowerCase().includes(kw)),
  );

  return (
    <>
      <div style={{ marginBottom: 'var(--space-12)' }}>
        <Greeting>Made by colleagues</Greeting>
        <h1 style={{ margin: 'var(--space-2) 0 var(--space-3)', font: 'var(--weight-bold) var(--text-2xl)/1.2 var(--font-sans)', color: 'var(--text-heading)' }}>
          创意市场
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
          同事选择「分享到全公司」的页面都在这里，添加即用
        </p>
      </div>

      {/* 作者卡片上分类输入框的建议：建议清单 + 已有分类，去重 */}
      <datalist id="ispace-market-cats">
        {[...new Set([...MARKETPLACE_CATEGORIES, ...cats])].map((cName) => (
          <option key={cName} value={cName} />
        ))}
      </datalist>

      <div style={{ display: 'flex', gap: 'var(--space-16)', alignItems: 'flex-start' }}>
        {/* 侧边栏：分类。sticky 让它在长列表滚动时留在视野里 */}
        <aside style={{ width: 168, flex: 'none', position: 'sticky', top: 72 }}>
          <SectionLabel>分类</SectionLabel>
          <div style={{ display: 'grid', gap: 2, marginTop: 'var(--space-6)' }}>
            <CatItem label="全部" count={listings.length} on={cat === null} onClick={() => setCat(null)} />
            {cats.map((cName) => (
              <CatItem key={cName} label={cName} count={counts.get(cName) ?? 0}
                on={cat === cName} onClick={() => setCat(cName)} />
            ))}
          </div>
        </aside>

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 搜索：本地过滤，按名称/简介/作者。市场不大，不必走服务端 */}
          <div style={{ position: 'relative', marginBottom: 'var(--space-10)', maxWidth: 360 }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="搜索页面、简介或作者" />
          </div>

          {visible.length === 0 ? (
            <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-base)' }}>
              {kw ? `没有匹配「${q}」的页面` : '这个分类下还没有页面'}
            </p>
          ) : (
          <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {visible.map((l) => (
          <Card key={l.id} hoverable style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {l.cover_path && <CoverBanner src={l.cover_path} alt={l.name} />}
            <div style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'flex-start' }}>
              {!l.cover_path && <AppIcon letter={l.icon_letter} />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <a href={`/${l.owner_username}/${l.slug}/`} style={{
                  display: 'block', textDecoration: 'none', color: 'var(--text-heading)',
                  font: 'var(--weight-semibold) var(--text-card-title)/1.3 var(--font-sans)',
                }}>{l.name}</a>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {l.owner_name} · <span className="num">{l.install_count}</span> 人在用
                </div>
              </div>
            </div>
            {l.description && (
              <p style={{
                margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-secondary)',
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>{l.description}</p>
            )}
            <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
              {l.mine ? (
                <>
                  <Badge tone="brand">你发布的</Badge>
                  {/* 作者就地改分类。可输入的组合框（不是固定下拉）——分类现在由 AI
                      决定、可自造，作者也该能填清单外的词；datalist 给建议 + 已有分类。 */}
                  <input
                    defaultValue={l.category ?? ''}
                    list="ispace-market-cats"
                    placeholder="分类"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== (l.category ?? '')) void api.setListingCategory(l.app_id, v).then(load);
                    }}
                    style={{
                      width: 96, height: 28, padding: '0 var(--space-5)',
                      border: '1px solid var(--border)', borderRadius: 'var(--radius-8)',
                      fontSize: 'var(--text-sm)', background: 'var(--surface-1)', color: 'var(--text-primary)',
                    }}
                  />
                </>
              ) : (
                <Button size="sm" variant={l.installed ? 'ghost' : 'primary'}
                  disabled={busy === l.app_id} onClick={() => void toggle(l)}>
                  {l.installed ? '已添加，点此移除' : '添加到我的'}
                </Button>
              )}
              {/*
                「做同款」只在真有提示词时才出现。
                没有的页面**不显示灰按钮**——一个点不动的入口只会引出
                "为什么我这个不行"，而答案（作者当初没经 AI 发布）
                跟看的人一点关系都没有。
              */}
              {l.source_prompt && (
                <Button size="sm" variant="ghost" onClick={() => setRemix(l)}>
                  做同款
                </Button>
              )}
              {/* 管理员才看得到。别人上架的才需要——自己的走上面那条正常路径 */}
              {isAdmin && !l.mine && (
                <Button size="sm" variant="ghost" disabled={busy === l.app_id}
                  onClick={() => void unlist(l)}>
                  下架
                </Button>
              )}
            </div>
          </Card>
        ))}
          </div>
          )}
        </div>
      </div>

      {remix && (
        <RemixDialog
          listing={remix}
          onClose={() => setRemix(null)}
          onNotify={(text, tone) => setMsg({ text, tone })}
        />
      )}
      {msg && <Toast message={msg.text} tone={msg.tone} onClose={() => setMsg(null)} />}
    </>
  );
}

/** 侧边栏的一个分类项：名字 + 条数，选中高亮。 */
function CatItem({ label, count, on, onClick }: {
  label: string; count: number; on: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      width: '100%', padding: 'var(--space-3) var(--space-6)', border: 'none',
      borderRadius: 'var(--radius-8)', cursor: 'pointer', textAlign: 'left',
      background: on ? 'var(--accent-subtle)' : 'transparent',
      color: on ? 'var(--text-heading)' : 'var(--text-secondary)',
      fontSize: 'var(--text-base)', fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-regular)',
      transition: 'var(--transition-colors)',
    }}
      onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--surface-2)'; }}
      onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}
    >
      <span>{label}</span>
      <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{count}</span>
    </button>
  );
}

/**
 * 「做同款」：把做出这个页面的那段话原样交出去。
 *
 * 这是市场从"装别人做的东西"变成"照着做自己的"的那一步——添加只是拿到
 * 一份引用，改不动；而提示词拿在手里，改几个字就是另一个页面。
 *
 * 提示词整段可滚动、可选中：复制在明文 HTTP 下不是每次都成（见 copyText），
 * 手动选中必须始终是条退路，所以不做 user-select: none 之类的限制。
 */
function RemixDialog({ listing, onClose, onNotify }: {
  listing: Listing;
  onClose: () => void;
  onNotify: (text: string, tone: 'info' | 'error') => void;
}) {
  const prompt = listing.source_prompt ?? '';
  const [err, setErr] = useState<string | null>(null);

  const copy = () => {
    /*
      必须走 copyText，不能用 navigator.clipboard：平台线上跑在明文 HTTP 上，
      那里 navigator.clipboard 是 undefined，读属性那一步就同步抛，
      表现为按钮点了完全没反应。copyText 里有 execCommand 的回落。
    */
    void copyText(prompt).then((ok) => {
      if (ok) {
        /*
          成功就把弹窗关掉，反馈交给 Toast。

          不能"留着弹窗弹 Toast"：Toast 的 z-index 是 80，而 Dialog 遮罩是
          1000——那条提示会压在遮罩底下，隔着一层半透明加模糊，等于没提。
          而且复制完弹窗也没事可做了，关掉正好让 Toast 露出来。
        */
        onClose();
        onNotify('提示词已复制，粘给你的 AI 就行', 'info');
      } else {
        /*
          失败反而**不能**关：文本就在上面，用户接下来要做的正是手动选中它。
          这时提示得贴着那个点了没反应的按钮，所以走弹窗内联而不是 Toast。
        */
        setErr('这个浏览器不让自动复制，请手动选中上面的文字，按 Ctrl/⌘ + C');
      }
    });
  };

  return (
    <Dialog
      open
      title={`做一个同款「${listing.name}」`}
      description="把下面这段话发给你的 AI，让它照着做一个属于你的版本——改几个字，就是另一个页面。"
      onClose={onClose}
      width={560}
      footer={(
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button variant="primary" onClick={copy}>复制提示词</Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {/*
          pre 而不是 p：提示词里的换行与缩进是作者写下的结构（分点、示例代码），
          折进一段连排文字里会读不出层次。whiteSpace: pre-wrap 保留换行又允许折行。
        */}
        <pre style={{
          margin: 0, maxHeight: 320, overflowY: 'auto',
          background: 'var(--surface-2)', borderRadius: 'var(--radius-12)',
          padding: 'var(--space-8)',
          font: 'var(--weight-regular) var(--text-sm)/1.7 var(--font-sans)',
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          userSelect: 'text',
        }}>{prompt}</pre>

        {err && (
          <div role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--error)', lineHeight: 1.6 }}>
            {err}
          </div>
        )}

        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
          这是 {listing.owner_name} 当初发布这个页面时用的原话。做出来的是你自己的页面，
          存在你自己的空间里，跟这一个互不影响。
        </p>
      </div>
    </Dialog>
  );
}

// ── 未登录 / 加载中 ───────────────────────────────────────────────────
/**
 * 未登录：邮箱密码登录 / 注册。
 *
 * 两个 tab 而不是两个页面：注册与登录之间来回切是很常见的动作
 * （"我是不是注册过？"），跳页会把已填的邮箱丢掉。
 *
 * 注册策略从服务端取，不写死在前端——允许的邮箱后缀是可配置的，
 * 前端写死会在改配置后骗人。
 */
/**
 * 用一次性链接设新密码（管理员在「员工与开通」里发出来的那个 /reset?token=…）。
 *
 * 平台没有可用的邮件服务，所以没有「忘记密码」自助入口——链接由管理员生成、
 * 当面或经可信渠道交给本人。这一页就是那条链接的落点；在它存在之前，
 * 管理员发出去的链接会 404，整条重置路径是断的。
 *
 * 令牌只从地址栏读，不做任何存储：它是一次性的，用完即失效，
 * 留在 localStorage 里没有用处，只多一份可能泄露的副本。
 */
function ResetPassword() {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [policy, setPolicy] = useState<AuthPolicy | null>(null);

  useEffect(() => { void api.authPolicy().then(setPolicy).catch(() => setPolicy(null)); }, []);

  const min = policy?.passwordMin ?? 12;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const ready = pw.length >= min && pw === pw2 && !busy;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.resetPassword(token, pw);
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Centered>
      <Greeting>Happy Working</Greeting>
      <h1 style={{ margin: 'var(--space-4) 0 var(--space-8)', font: 'var(--weight-bold) var(--text-xl)/1.3 var(--font-sans)', color: 'var(--text-heading)' }}>
        设置新密码
      </h1>

      {!token ? (
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
          这个地址里没有重置令牌。请用管理员发给你的完整链接打开。
        </p>
      ) : done ? (
        <>
          <p style={{ margin: '0 0 var(--space-8)', color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
            密码已设好，这条链接同时作废。现在可以用邮箱和新密码登录了——
            手机上的 App 也是同一个账号。
          </p>
          <a href="/" style={{ textDecoration: 'none' }}>
            <Button variant="primary">去登录</Button>
          </a>
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 var(--space-8)', color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
            至少 {min} 位。长比复杂更管用——一句只有你会说的话就很好。
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', width: '100%' }}>
            <Input
              type="password" value={pw} onChange={(e) => setPw(e.target.value)}
              placeholder="新密码" autoComplete="new-password" autoFocus disabled={busy}
            />
            <Input
              type="password" value={pw2} onChange={(e) => setPw2(e.target.value)}
              placeholder="再输一次" autoComplete="new-password" disabled={busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) void submit(); }}
            />
            {mismatch && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--error)' }}>两次输入不一致</span>
            )}
            {err && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--error)' }}>{err}</span>
            )}
            <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
              {busy ? '设置中…' : '设置密码'}
            </Button>
          </div>
        </>
      )}
    </Centered>
  );
}

/** 登录、注册、重置三页共用的居中卡片容器。 */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: 'var(--surface-canvas)', padding: 'var(--space-12)',
    }}>
      <Card style={{ width: 380, maxWidth: '100%', padding: 'var(--space-16)' }}>
        {children}
      </Card>
    </div>
  );
}

function LoggedOut() {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [policy, setPolicy] = useState<AuthPolicy | null>(null);
  const [apkOpen, setApkOpen] = useState(false);

  useEffect(() => { void api.authPolicy().then(setPolicy).catch(() => setPolicy(null)); }, []);

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: 'var(--surface-canvas)', padding: 'var(--space-12)',
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-12)' }}>
          <img src="/favicon.svg" alt="iSpace" style={{ width: 44, height: 44, margin: '0 auto var(--space-10)', display: 'block' }} />
          <div style={{ font: 'var(--weight-regular) var(--text-3xl)/1.2 var(--font-script)', marginBottom: 'var(--space-4)' }}>
            Happy Working
          </div>
          <h1 style={{ margin: 0, font: 'var(--weight-bold) var(--text-xl)/1.3 var(--font-sans)' }}>
            你的专属空间
          </h1>
        </div>

        <Card>
          <div style={{ marginBottom: 'var(--space-10)' }}>
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'login' as const, label: '登录' },
                { value: 'register' as const, label: '注册' },
              ]}
            />
          </div>
          {tab === 'login' ? <LoginForm /> : <RegisterForm policy={policy} />}
        </Card>

        {policy?.ssoEnabled && (
          <div style={{ textAlign: 'center', marginTop: 'var(--space-10)' }}>
            <a href={api.loginUrl(location.pathname)} style={{
              fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
            }}>用公司账号（SSO）登录</a>
          </div>
        )}

        {/*
          未登录也给下载入口。装 App 这件事按定义发生在有会话之前——
          只把入口挂在头像菜单里，等于要求人先在电脑上登录才能知道有 App 可装。
          下载路径本身也是免登录的，两边一致。
        */}
        <div style={{ textAlign: 'center', marginTop: 'var(--space-10)' }}>
          <button
            type="button"
            onClick={() => setApkOpen(true)}
            style={{
              border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
              font: 'var(--weight-regular) var(--text-sm)/1.6 var(--font-sans)',
              color: 'var(--text-secondary)',
            }}
          >
            下载手机 App（安卓）
          </button>
        </div>
      </div>
      {apkOpen && <AppDownloadDialog onClose={() => setApkOpen(false)} />}
    </div>
  );
}

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.login(email.trim(), password);
      // 整页重载而不是改 state：登录后几乎每份数据都要重取，
      // 重载最简单也最不容易漏
      location.reload();
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Field label="公司邮箱">
        <Input type="email" value={email} autoComplete="username" autoFocus
          onChange={(e) => setEmail(e.target.value)} placeholder="lixiao@example.com" />
      </Field>
      <Field label="密码">
        <Input type="password" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {err && <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>{err}</p>}
      <Button variant="primary" type="submit" disabled={busy || !email.trim() || !password}
        style={{ width: '100%' }}>
        {busy ? '登录中…' : '登录'}
      </Button>
      <p style={{ margin: 'var(--space-8) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
        忘记密码请找管理员重置——平台还没接邮件服务，做不了自助重置。
      </p>
    </form>
  );
}

function RegisterForm({ policy }: { policy: AuthPolicy | null }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 从邮箱现推一个空间标识给用户看——地址是长期对外的，
  // 注册时就该让他知道自己将来是哪个路径，而不是注册完才发现
  const suggested = guessUsername(email);
  const effective = username.trim() || suggested;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.register({
        email: email.trim(),
        password,
        displayName: displayName.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
      });
      location.reload();
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Field label="公司邮箱">
        <Input type="email" value={email} autoComplete="username" autoFocus
          onChange={(e) => setEmail(e.target.value)}
          placeholder={policy ? `name@${policy.emailDomains[0]}` : 'name@example.com'} />
      </Field>
      <Field label="姓名">
        <Input value={displayName} autoComplete="name"
          onChange={(e) => setDisplayName(e.target.value)} placeholder="李骁" />
      </Field>
      <Field label={`密码（至少 ${policy?.passwordMin ?? 12} 位）`}>
        <Input type="password" value={password} autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="空间标识">
        <Input value={username} onChange={(e) => setUsername(e.target.value)}
          placeholder={suggested || '自己填一个'} />
        <p style={{ margin: '4px 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
          {effective
            ? <>你的地址会是 <span className="mono">{location.host}/{effective}/</span>。注册后很难改，想清楚。</>
            : '从这个邮箱推不出标识，请自己填（小写字母开头，可含数字与连字符）。'}
        </p>
      </Field>
      {err && <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>{err}</p>}
      <Button variant="primary" type="submit"
        disabled={busy || !email.trim() || !displayName.trim() || !password || !effective}
        style={{ width: '100%' }}>
        {busy ? '注册中…' : '注册并开通空间'}
      </Button>
      {policy && (
        <p style={{ margin: 'var(--space-8) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
          仅限 {policy.emailDomains.map((d) => `@${d}`).join('、')} 邮箱。注册即开通你的空间与数据库。
        </p>
      )}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 'var(--space-8)' }}>
      <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 4 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * 前端侧的空间标识推导。
 *
 * 与服务端 usernameFromEmail 同一套规则——这里只是为了让用户在提交前
 * 就看到自己将来的地址。真正的判定仍在服务端，前端算错了顶多是提示不准，
 * 不会放进一个非法标识。
 */
function guessUsername(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local
    .toLowerCase()
    .replace(/[._+]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function Splash() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)' }}>
      <span style={{ fontSize: 'var(--text-base)' }}>载入中…</span>
    </div>
  );
}
