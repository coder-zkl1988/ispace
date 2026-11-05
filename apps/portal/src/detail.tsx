import { useEffect, useRef, useState } from 'react';
import type { Comment, CommentSort, User } from '@ispace/contracts';
import { Icon, copyText, type IconName } from '@ispace/ui';
import { api, type Listing } from './api';
import { AuthorChip, Cover, PHONE_RATIO, appHref, deviceOf, fmt, initial, usePlayUrl, washOf, type Device } from './wall';

/**
 * 应用详情（改版稿 §应用详情）。
 *
 * 一屏三块：中间是页面本体的预览，右边一条评论流，预览右侧贴着一列动作
 * （上一个/下一个、作者、喜欢、评论、分享、做同款）。改版前这些信息散在
 * 市场卡片上，新稿把它们收进一屏——看一个页面和决定要不要照着做，是同
 * 一件事的两步。
 *
 * ┌─ 预览是真页面，不是截图 ──────────────────────────────────────────┐
 * │ 设计稿里这块是 image-slot（设计文档跑不起真页面）。实现时用 iframe  │
 * │ 直接把 /{owner}/{slug}/ 装进手机/电脑框里——我们手上有真东西，没必  │
 * │ 要退回到截图。                                                     │
 * │                                                                    │
 * │ sandbox 给了脚本和表单，**没给** allow-same-origin：两者同时给      │
 * │ 等于没有沙箱，被预览的页面（同事写的 HTML）就能借着平台的 origin    │
 * │ 读写平台接口。代价是页面在预览里拿不到会话，要取数的那部分会显示自  │
 * │ 己的空态——所以旁边始终留着「打开页面」。                          │
 * └──────────────────────────────────────────────────────────────────┘
 */
export function Detail({
  item, me, siblings, onSibling, onAuthor, onRemix, onManage, onToast, onInstalled, onLiked,
}: {
  item: Listing;
  me: User;
  /** 上一个/下一个在同一面墙里翻。给空数组就只隐藏那两颗按钮。 */
  siblings: Listing[];
  onSibling: (l: Listing) => void;
  onAuthor: (username: string) => void;
  onRemix: (l: Listing) => void;
  onManage: (l: Listing) => void;
  onToast: (text: string) => void;
  onInstalled: () => void;
  onLiked: (appId: string, liked: boolean, count: number) => void;
}) {
  const [dev, setDev] = useState<Device>(deviceOf(item.type));
  const [info, setInfo] = useState(false);
  const [busy, setBusy] = useState(false);
  const wide = useWideEnoughForPanel();

  /* 换一个页面看，设备选择与「关于」面板都回到默认——它们属于上一个页面。 */
  useEffect(() => { setDev(deviceOf(item.type)); setInfo(false); }, [item.app_id, item.type]);

  const idx = siblings.findIndex((s) => s.app_id === item.app_id);
  const step = (d: number) => {
    if (siblings.length < 2) return;
    const n = siblings.length;
    onSibling(siblings[((idx < 0 ? 0 : idx) + d + n) % n]!);
  };

  const toggleLike = async () => {
    const next = !item.liked;
    try {
      const r = next ? await api.like(item.app_id) : await api.unlike(item.app_id);
      onLiked(item.app_id, r.liked, r.likeCount);
    } catch { onToast('没点上，重试一下'); }
  };

  const toggleInstall = async () => {
    setBusy(true);
    try {
      if (item.installed) {
        await api.uninstallFromMarket(item.app_id);
        onToast('已从「我的作品」移除');
      } else {
        await api.installFromMarket(item.app_id);
        onToast('已添加到「我的作品」');
      }
      onInstalled();
    } finally { setBusy(false); }
  };

  const share = async () => {
    const url = `${location.origin}${appHref(item)}`;
    onToast(await copyText(url) ? '链接已复制，发给同事就能打开' : url);
  };

  const tint = washOf(item.app_id);

  return (
    <div
      style={{
        height: '100%', minHeight: 600, boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', padding: '0 24px 20px',
      }}
    >
      {/* ── 顶上一行：图标、名字、关于、手机/电脑 ─────────────────── */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 14 }}>
        <span
          style={{
            width: 32, height: 32, flex: 'none', borderRadius: 9, background: tint,
            color: 'var(--text-heading)', fontSize: 'var(--text-md)',
            fontWeight: 'var(--weight-bold)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {item.icon_letter || initial(item.name)}
        </span>
        <span
          style={{
            fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-bold)',
            color: 'var(--text-heading)', whiteSpace: 'nowrap',
          }}
        >
          {item.name}
        </span>
        <button
          onClick={() => setInfo((v) => !v)}
          title="关于这个页面"
          style={{
            width: 30, height: 30, border: 0, borderRadius: 'var(--radius-pill)',
            background: info ? 'var(--surface-2)' : 'transparent', color: 'var(--text-tertiary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}
        >
          <Icon name="info" size={17} />
        </button>
        <Segment
          style={{ marginLeft: 6 }}
          options={[
            { k: 'phone', label: '手机', icon: 'phone' as const },
            { k: 'pc', label: '电脑', icon: 'monitor' as const },
          ]}
          value={dev}
          onPick={(k) => setDev(k as Device)}
        />
        <div style={{ flex: 1 }} />
        <a
          href={appHref(item)}
          target="_blank"
          rel="noopener"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 14px',
            borderRadius: 10, background: 'var(--accent)', color: 'var(--accent-fg)',
            fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
            textDecoration: 'none', whiteSpace: 'nowrap',
          }}
        >
          <Icon name="external" size={15} />打开页面
        </a>

        {info && (
          <>
            <div onClick={() => setInfo(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
            <AboutCard
              item={item}
              onAuthor={() => onAuthor(item.owner_username)}
              onRemix={() => onRemix(item)}
              onManage={() => onManage(item)}
              onInstall={() => void toggleInstall()}
              busy={busy}
              onToast={onToast}
            />
          </>
        )}
      </div>

      {/* ── 预览 + 动作列 + 评论 ──────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 24 }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22 }}>
          {dev === 'phone' ? (
            <div
              style={{
                /* 不封高：手机版纵向占满这一区，宽度按真手机屏的比例自己算 */
                position: 'relative', height: '100%', aspectRatio: PHONE_RATIO,
                borderRadius: 34, overflow: 'hidden',
                boxShadow: '0 30px 60px -36px rgba(24,23,21,.45)',
              }}
            >
              <LivePreview item={item} tint={tint} radius={34} />
            </div>
          ) : (
            <div
              style={{
                /* 不封宽：电脑版横向吃满预览区（右边还有动作栏和评论栏各自占位） */
                flex: 1, minWidth: 0, borderRadius: 18, overflow: 'hidden',
                background: 'var(--surface-1)',
                boxShadow: '0 30px 60px -36px rgba(24,23,21,.45), 0 0 0 1px var(--border-subtle)',
              }}
            >
              <div
                className="mono"
                style={{
                  height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 14px', background: 'var(--surface-2)', fontSize: 'var(--text-base)',
                  color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden',
                }}
              >
                {location.host}{appHref(item)}
              </div>
              <div style={{ position: 'relative', aspectRatio: '16 / 10' }}>
                <LivePreview item={item} tint={tint} radius={0} />
              </div>
            </div>
          )}

          <div
            style={{
              alignSelf: 'flex-end', flex: 'none', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 14, paddingBottom: 6,
            }}
          >
            {siblings.length > 1 && (
              <>
                <RoundBtn title="上一个" icon="chevUp" onClick={() => step(-1)} />
                <RoundBtn title="下一个" icon="chevDown" onClick={() => step(1)} />
                <div style={{ height: 28 }} />
              </>
            )}
            <button
              onClick={() => onAuthor(item.owner_username)}
              title={item.owner_name}
              style={{
                width: 46, height: 46, border: 0, borderRadius: 'var(--radius-pill)',
                background: washOf(item.owner_username), color: 'var(--text-heading)',
                fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-bold)', cursor: 'pointer',
                boxShadow: '0 0 0 2px var(--surface-1)',
              }}
            >
              {initial(item.owner_name)}
            </button>
            <RailBtn
              icon="heart" filled={item.liked} label={fmt(item.like_count)} title="喜欢"
              color={item.liked ? 'var(--tabby-orange)' : 'var(--text-primary)'}
              onClick={() => void toggleLike()}
            />
            <RailBtn
              icon="msg" label={fmt(item.comment_count)} title="评论"
              color="var(--text-primary)"
              onClick={() => onToast(wide ? '在右边写下你的评论' : '评论在更宽的窗口里展开')}
            />
            <RailBtn
              icon="share2" label="分享" title="复制链接"
              color="var(--text-primary)" onClick={() => void share()}
            />
            {item.source_prompt && (
              <RailBtn
                icon="remix" label="做同款" title="做同款"
                color="var(--tabby-orange)" onClick={() => onRemix(item)}
              />
            )}
          </div>
        </div>

        {/* 面板在窄窗口里收掉：380px 的评论栏挤在 1180 以下会把预览压成一条 */}
        {wide && <Comments item={item} me={me} onToast={onToast} />}
      </div>
    </div>
  );
}

/** 评论面板要 380px，加上预览至少 800——1180 是这两者的和。 */
function useWideEnoughForPanel(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= 1180);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 1180);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return wide;
}

function LivePreview({ item, tint, radius }: { item: Listing; tint: string; radius: number }) {
  /* 试玩走令牌地址，不是 /{owner}/{slug}/——见 wall.tsx 的 usePlayUrl */
  const play = usePlayUrl(item);
  /*
    停用的页面不嵌：iframe 会去取一个 404，用户看到的是浏览器的报错页，
    而真相是"这个页面被作者停了"。
  */
  if (item.status === 'stopped') {
    return <Cover src={item.cover_path} label={`${item.name} · 已停用`} tint={tint} radius={radius} />;
  }
  /* 令牌还没换到：先摆封面，别让 iframe 去撞一个会过期的地址 */
  if (!play) {
    return <Cover src={item.cover_path} label={item.name} tint={tint} radius={radius} />;
  }
  return (
    <iframe
      src={play}
      title={item.name}
      sandbox="allow-scripts allow-forms allow-popups"
      loading="lazy"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: tint }}
    />
  );
}

function RoundBtn({ title, icon, onClick }: { title: string; icon: 'chevUp' | 'chevDown'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 46, height: 46, borderRadius: 'var(--radius-pill)',
        border: '1px solid var(--border-hover)', background: 'var(--surface-1)',
        color: 'var(--text-primary)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={19} />
    </button>
  );
}

function RailBtn({
  icon, label, title, color, filled, onClick,
}: {
  icon: 'heart' | 'msg' | 'share2' | 'remix';
  label: string;
  title: string;
  color: string;
  filled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        padding: 0, border: 0, background: 'transparent', cursor: 'pointer', color,
      }}
    >
      <span style={{ width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={21} filled={filled} />
      </span>
      <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>{label}</span>
    </button>
  );
}

/** 「关于这个页面」：作者、简介、做它的那句话、几条事实、两颗动作。 */
function AboutCard({
  item, onAuthor, onRemix, onManage, onInstall, busy, onToast,
}: {
  item: Listing;
  onAuthor: () => void;
  onRemix: () => void;
  onManage: () => void;
  onInstall: () => void;
  busy: boolean;
  onToast: (t: string) => void;
}) {
  /*
    事实表只列真的知道的东西。

    设计稿这里还有「数据」和「外部接口」两行（"作者空间 · 2 张表"、
    "高德地图（全员共享）"）——库里没有"这个页面用了哪几张表、连了哪个
    上游"这件事，它在发布链路里从未被记录过。编一行出来会被当成真的，
    所以这两行先不摆；真要有，得先在发布时把依赖记下来。
  */
  const facts: { k: string; v: string; mono?: boolean }[] = [
    { k: '地址', v: `${location.host}${appHref(item)}`, mono: true },
    { k: '适配', v: deviceOf(item.type) === 'phone' ? '手机优先 · 电脑也能用' : '电脑优先 · 手机也能用' },
    { k: '分类', v: item.category?.trim() || '未分类' },
    { k: '上架', v: new Date(item.published_at).toLocaleDateString('zh-CN') },
    { k: '访问', v: `${fmt(item.visit_count)} 次` },
    // 没人在线时不摆这一行——「0 人正在用」是噪音，不是信息。
    ...(item.live_count > 0 ? [{ k: '正在用', v: `${fmt(item.live_count)} 人` }] : []),
  ];

  return (
    <div
      style={{
        position: 'absolute', top: 46, left: 0, zIndex: 31, width: 420,
        maxWidth: 'calc(100vw - 48px)', boxSizing: 'border-box', padding: 22,
        borderRadius: 22, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
        boxShadow: '0 24px 56px -20px rgba(24,23,21,.3)',
        display: 'flex', flexDirection: 'column', gap: 18,
      }}
    >
      <AuthorChip
        name={item.owner_name} username={item.owner_username} avatarUrl={item.owner_avatar}
        onClick={onAuthor} size={34}
      />
      {item.description && (
        <span style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
          {item.description}
        </span>
      )}

      {item.source_prompt && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)' }}>
              做它的那句话
            </span>
            <button
              onClick={() => void copyText(item.source_prompt!).then((ok) => onToast(ok ? '提示词已复制' : '复制不了，手动选中吧'))}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, height: 28, padding: '0 10px',
                border: 0, borderRadius: 8, background: 'transparent', color: 'var(--text-secondary)',
                fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
              }}
            >
              <Icon name="copy" size={14} />复制
            </button>
          </div>
          {/* 整段可滚动、可选中：明文 http 下复制不一定成，手选必须是条退路 */}
          <div
            style={{
              padding: '14px 16px', borderRadius: 14, background: 'var(--surface-2)',
              fontSize: 'var(--text-md)', lineHeight: 1.7, color: 'var(--text-primary)',
              maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap',
            }}
          >
            {item.source_prompt}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {facts.map((f) => (
          <div
            key={f.k}
            style={{
              display: 'flex', justifyContent: 'space-between', gap: 16, padding: '9px 0',
              borderTop: '1px solid var(--border-tabby)', fontSize: 'var(--text-base)',
            }}
          >
            <span style={{ flex: 'none', color: 'var(--text-tertiary)' }}>{f.k}</span>
            <span
              className={f.mono ? 'mono' : undefined}
              style={{ minWidth: 0, textAlign: 'right', color: 'var(--text-primary)', wordBreak: 'break-all' }}
            >
              {f.v}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        {item.source_prompt && (
          <button
            onClick={onRemix}
            style={{
              flex: 1, height: 44, border: 0, borderRadius: 12, background: 'var(--cta)',
              color: 'var(--cta-fg)', fontSize: 'var(--text-md)',
              fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            做同款
          </button>
        )}
        <button
          onClick={item.mine ? onManage : onInstall}
          disabled={busy}
          style={{
            flex: 1, height: 44, border: '1px solid var(--border-hover)', borderRadius: 12,
            background: 'var(--surface-1)', color: 'var(--text-heading)',
            fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
          }}
        >
          {item.mine ? '管理' : item.installed ? '已添加' : '添加到我的'}
        </button>
      </div>
    </div>
  );
}

// ── 评论 ────────────────────────────────────────────────────────────────
function Comments({ item, me, onToast }: { item: Listing; me: User; onToast: (t: string) => void }) {
  const [sort, setSort] = useState<CommentSort>('new');
  const [list, setList] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setList(null);
    let alive = true;
    void api.comments(item.app_id, sort)
      .then((r) => { if (alive) setList(r.comments); })
      .catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [item.app_id, sort]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await api.addComment(item.app_id, body);
      /* 新评论插到最前，并把排序拨回「最新」——否则刚写的那句看不见 */
      setSort('new');
      setList((prev) => [r.comment, ...(prev ?? [])]);
      setDraft('');
      box.current?.scrollTo({ top: 0 });
    } catch { onToast('没发出去，重试一下'); } finally { setSending(false); }
  };

  const toggleLike = async (c: Comment) => {
    try {
      const r = c.liked ? await api.unlikeComment(c.id) : await api.likeComment(c.id);
      setList((prev) => (prev ?? []).map((x) => (
        x.id === c.id ? { ...x, liked: r.liked, likeCount: r.likeCount } : x
      )));
    } catch { onToast('没点上，重试一下'); }
  };

  const remove = async (c: Comment) => {
    if (!confirm('删掉这条评论？')) return;
    try {
      await api.deleteComment(c.id);
      setList((prev) => (prev ?? []).filter((x) => x.id !== c.id));
    } catch { onToast('删不掉，重试一下'); }
  };

  return (
    <div
      style={{
        width: 380, flex: 'none', minHeight: 0, display: 'flex', flexDirection: 'column',
        borderRadius: 20, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px' }}>
        <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)' }}>
          评论
          <span style={{ fontWeight: 'var(--weight-regular)', color: 'var(--text-tertiary)' }}>
            {' · '}{list ? list.length : item.comment_count}
          </span>
        </span>
        <Segment
          options={[{ k: 'new', label: '最新' }, { k: 'hot', label: '热门' }]}
          value={sort}
          onPick={(k) => setSort(k as CommentSort)}
          compact
        />
      </div>

      <div
        ref={box}
        style={{
          flex: 1, minHeight: 0, overflow: 'auto', padding: '0 18px',
          display: 'flex', flexDirection: 'column', gap: 18,
        }}
      >
        {list === null ? (
          <span style={{ padding: '56px 0', textAlign: 'center', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            正在加载…
          </span>
        ) : list.length === 0 ? (
          <span style={{ padding: '56px 0', textAlign: 'center', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            还没有评论，来说说你的用法吧。
          </span>
        ) : list.map((c) => (
          <div key={c.id} style={{ display: 'flex', gap: 10 }}>
            <span
              style={{
                width: 32, height: 32, flex: 'none', borderRadius: 'var(--radius-pill)',
                background: c.author.avatarUrl ? 'transparent' : washOf(c.author.username),
                color: 'var(--text-heading)', fontSize: 'var(--text-base)',
                fontWeight: 'var(--weight-bold)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', overflow: 'hidden',
              }}
            >
              {c.author.avatarUrl
                ? <img src={c.author.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : initial(c.author.displayName)}
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
                <b style={{ color: 'var(--text-heading)' }}>{c.author.displayName}</b>
                {' · '}{ago(c.createdAt)}
              </span>
              <span style={{ fontSize: 'var(--text-md)', lineHeight: 1.6, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                {c.body}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
                <button
                  onClick={() => void toggleLike(c)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, border: 0, padding: 0,
                    background: 'transparent', cursor: 'pointer',
                    color: c.liked ? 'var(--tabby-orange)' : 'var(--text-tertiary)',
                    fontSize: 'var(--text-base)',
                  }}
                >
                  <Icon name="heart" size={14} filled={c.liked} />{c.likeCount || ''}
                </button>
                {/* 自己写的、以及自己页面下的，才有这颗 */}
                {(c.mine || item.mine) && (
                  <button
                    onClick={() => void remove(c)}
                    style={{
                      border: 0, padding: 0, background: 'transparent', cursor: 'pointer',
                      color: 'var(--text-tertiary)', fontSize: 'var(--text-base)',
                    }}
                  >
                    删除
                  </button>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ padding: 14, borderTop: '1px solid var(--border-tabby)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, height: 46, padding: '0 6px 0 14px',
            borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)',
          }}
        >
          <input
            value={draft}
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              void send();
            }}
            placeholder="写下评论…"
            style={{
              flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent',
              fontSize: 'var(--text-md)', color: 'var(--text-primary)', fontFamily: 'inherit',
            }}
          />
          <button
            onClick={() => void send()}
            title="发送"
            style={{
              width: 34, height: 34, flex: 'none', border: 0, borderRadius: 'var(--radius-pill)',
              background: draft.trim() ? 'var(--cta)' : 'var(--surface-3)', color: '#ffffff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="send" size={16} />
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 6px', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
          <span>以 {me.displayName} 的身份评论</span>
          <span className="mono">{draft.length}/500</span>
        </div>
      </div>
    </div>
  );
}

// ── 小件 ────────────────────────────────────────────────────────────────
/** 分段控件：手机/电脑、最新/热门都用它。 */
export function Segment({
  options, value, onPick, compact = false, dark = false, pad, style,
}: {
  options: { k: string; label: string; icon?: IconName }[];
  value: string;
  onPick: (k: string) => void;
  compact?: boolean;
  dark?: boolean;
  /** 每一格左右留白。默认 12（compact 时 10）；工作台的「风格 / 收藏」是 14。 */
  pad?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        display: 'flex', gap: 2, padding: 3, borderRadius: compact ? 10 : 12,
        background: dark ? 'rgba(255,255,255,.08)' : 'var(--seg-bg)', ...style,
      }}
    >
      {options.map((o) => {
        const on = o.k === value;
        return (
          <button
            key={o.k}
            onClick={() => onPick(o.k)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              height: compact ? 28 : 30,
              padding: `0 ${pad ?? (compact ? 10 : 12)}px`, border: 0, borderRadius: compact ? 8 : 9,
              background: on ? (dark ? 'rgba(255,255,255,.16)' : 'var(--surface-1)') : 'transparent',
              boxShadow: on && !dark ? '0 1px 2px rgba(24,23,21,.08)' : 'none',
              color: on
                ? (dark ? '#fff' : 'var(--text-heading)')
                : (dark ? 'rgba(255,255,255,.55)' : 'var(--text-tertiary)'),
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            {o.icon && <Icon name={o.icon} size={o.icon === 'phone' || o.icon === 'monitor' ? 15 : 14} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 「3 小时前」。
 *
 * 评论流上写绝对时间（10-20 14:02）会让人去算差值，而这里真正要表达的是
 * "新不新"。超过 30 天就改回日期——那时候"38 天前"反而不如一个日期好认。
 */
export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}
