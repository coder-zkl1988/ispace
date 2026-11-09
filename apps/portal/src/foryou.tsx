import { useEffect, useState } from 'react';
import { exploreBucket, type Interest } from '@ispace/contracts';
import { Icon, MarkLoading, copyText } from '@ispace/ui';
import { api, type BackendListing, type Listing } from './api';
import { Segment } from './detail';
import { PHONE_RATIO, appHref, deviceOf, fmt, initial, recKey, usePlay, warmPlayUrl, washOf, type Device, type RecItem } from './wall';
import { Cover } from './wall';

/**
 * 为你推荐（改版稿 §为你推荐）。
 *
 * 一次只看一个页面、上下键翻——探索是「逛」，这一屏是「刷」。
 * 它是全站唯一一处自带顶栏的屏（外壳的 chrome=false）：计数和「手机 / 电脑」
 * 那一行就是它的顶栏，外壳那条再压上去就是两层。
 *
 * 底色和全站一样是浅色画布。原先整屏深色，是照改版稿那一张"沉浸式"的图；
 * 可是框里装的是真页面，大多数页面自己就是浅底，深底上摆一块亮框，眼睛
 * 在两种亮度之间来回跳，从侧栏点进来也像换了一个产品。框、按钮的画法和
 * 详情页那一屏取同一套。
 *
 * 预览同详情页：装的是真页面，sandbox 不给 allow-same-origin（理由见
 * detail.tsx 那段方框注释）。
 */
export function ForYou({
  listings, backendListings = [], interests, onDetail, onAuthor, onRemix, onToast, onInstalled, onLiked,
}: {
  listings: Listing[];
  backendListings?: BackendListing[];
  interests: Interest[];
  onDetail: (l: Listing) => void;
  onAuthor: (username: string) => void;
  onRemix: (l: Listing) => void;
  onToast: (t: string) => void;
  onInstalled: () => void;
  onLiked: (appId: string, liked: boolean, count: number) => void;
}) {
  const ordered = rankAll(listings, backendListings, interests);
  /*
   * 游标存稳定 key（app:xxx / backend:xxx）而不是下标：45 秒轮询会把整份
   * 数据换成重排后的新数组（同事点个喜欢热度就变），按下标定位会让正在
   * 看的那页被静默换成另一页——预览、地址栏、动作栏的目标全部漂移。按
   * key 找回自己的位置，重排只改变邻居，不偷换眼前这页。
   */
  const [curId, setCurId] = useState<string | null>(null);
  const [dev, setDev] = useState<Device | null>(null);
  const wide = useInfoWide();

  const n = ordered.length;
  const idx = n ? Math.max(0, ordered.findIndex((r) => recKey(r) === curId)) : 0;
  const cur = n ? ordered[((idx % n) + n) % n]! : null;
  const move = (d: number) => {
    const next = n ? ordered[(((idx + d) % n) + n) % n] : null;
    setCurId(next ? recKey(next) : null);
    setDev(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* 上下两个邻居的试玩地址提前换好，翻过去就不用等换令牌那一来回。
     后端没有试玩地址（打开就是 /svc 本页），邻居是它时直接跳过。 */
  useEffect(() => {
    if (!n) return;
    const nextApp = (o: typeof ordered[0] | undefined) => (o && o.kind === 'app' ? o.l : null);
    warmPlayUrl(nextApp(ordered[(idx + 1) % n]));
    warmPlayUrl(nextApp(ordered[(idx - 1 + n) % n]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, n]);

  if (!cur) {
    return (
      <div
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface-canvas)', color: 'var(--text-tertiary)', fontSize: 'var(--text-md)',
        }}
      >
        还没有可以推荐的作品。先去探索看看，或者自己做一个。
      </div>
    );
  }

  /* 后端项没有「手机/电脑」与真页面预览（iframe 嵌 /svc 受制于它自己的
     CSP，不可靠）——走海报版式：首字母底板 + 打开/添加/复制链接。 */
  if (cur.kind === 'backend') {
    return <BackendSlide
      b={cur.b} idx={idx} n={n} move={move}
      onAuthor={onAuthor} onToast={onToast} onInstalled={onInstalled}
    />;
  }

  const l = cur.l;
  const d = dev ?? deviceOf(l.type);
  const tint = washOf(l.app_id);

  const toggleLike = async () => {
    try {
      const r = l.liked ? await api.unlike(l.app_id) : await api.like(l.app_id);
      onLiked(l.app_id, r.liked, r.likeCount);
    } catch { onToast('没点上，重试一下'); }
  };
  const toggleAdd = async () => {
    try {
      if (l.mine) { onToast('这是你自己的页面'); return; }
      if (l.installed) {
        await api.uninstallFromMarket(l.app_id);
        onToast('已从「我的作品」移除');
      } else {
        await api.installFromMarket(l.app_id);
        onToast('已添加到「我的作品」');
      }
      onInstalled();
    } catch { onToast('没成功，重试一下'); }
  };
  const share = async () => {
    const url = `${location.origin}${appHref(l)}`;
    onToast(await copyText(url) ? '链接已复制，发给同事就能打开' : url);
  };

  const pad = (v: number) => (v < 10 ? `0${v}` : String(v));

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface-canvas)', color: 'var(--text-heading)' }}>
      <div
        style={{
          height: 64, flex: 'none', display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)',
          alignItems: 'center', gap: 16, padding: '0 24px',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)' }}>为你推荐</span>
          <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            {pad(idx + 1)} / {pad(n)}
          </span>
        </span>
        <Segment
          options={[
            { k: 'phone', label: '手机', icon: 'phone' },
            { k: 'pc', label: '电脑', icon: 'monitor' },
          ]}
          value={d}
          onPick={(k) => setDev(k as Device)}
        />
        <span style={{ justifySelf: 'end', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
          ↑ ↓ 键切换
        </span>
      </div>

      <div
        style={{
          flex: 1, minHeight: 0, display: 'grid',
          /*
            列定义按设备换（新版设计稿的 fy.cols）：

              手机  1fr / auto / 1fr    两侧等宽，窄窄的手机框落在正中，
                                        动作栏在第三列靠左，于是紧挨着框
              电脑  300 / 1fr / auto    框把中间那列吃满，作品信息固定 300，
                                        动作栏按需
              窄屏  0 / 1fr / auto      作品信息整列收掉（它本来也不显示），
                                        把宽度全让给框

            这一条是此前反复改不对的那处：框和动作栏的相对位置、以及框在
            屏幕里的位置，是两件事。都靠一套列定义去凑，必然顾此失彼——
            手机框窄时居中了动作栏就离得远，贴住动作栏了框又偏到一边。
            分设备给两套列，两件事就各自成立。
          */
          gridTemplateColumns: d === 'phone'
            ? 'minmax(0,1fr) auto minmax(0,1fr)'
            : (wide ? 'minmax(0,300px) minmax(0,1fr) auto' : '0px minmax(0,1fr) auto'),
          gridTemplateRows: 'minmax(0,1fr)', alignItems: 'center', gap: 40, padding: '0 40px 20px',
        }}
      >
        <div
          style={{
            alignSelf: 'end', justifySelf: 'end', width: '100%', maxWidth: 340,
            display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 8,
          }}
        >
          {wide && (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span
                  style={{
                    height: 26, padding: '0 11px', borderRadius: 'var(--radius-pill)',
                    background: 'var(--surface-2)', color: 'var(--text-secondary)',
                    fontSize: 'var(--text-base)', display: 'flex', alignItems: 'center',
                  }}
                >
                  {exploreBucket(l.category)}
                </span>
              </div>
              <h2
                style={{
                  margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500,
                  /* 稿上是定死的 42。那是一张定宽画布，真实窗口窄下来时
                     左栏会跟着窄，42 的作品名就断成两行 */
                  fontSize: 'clamp(28px, 2.4vw, 42px)',
                  lineHeight: 1.1, color: 'var(--text-heading)',
                }}
              >
                {l.name}
              </h2>
              {l.description && (
                <p style={{ margin: 0, fontSize: 'var(--text-md)', lineHeight: 1.7, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
                  {l.description}
                </p>
              )}
              <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
                {l.owner_name} · {fmt(l.install_count)} 人复用
                {l.live_count > 0 && ` · ${fmt(l.live_count)} 人正在用`}
              </span>
              <button
                onClick={() => onDetail(l)}
                style={{
                  alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, height: 40,
                  padding: '0 12px 0 16px', border: '1px solid var(--border-hover)', borderRadius: 12,
                  background: 'var(--surface-1)', color: 'var(--text-primary)', fontSize: 'var(--text-base)',
                  fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                }}
              >
                看详情<Icon name="chevRight" size={15} />
              </button>
            </>
          )}
        </div>

        <div style={{ height: '100%', minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {d === 'phone' ? (
            <div
              style={{
                /* 纵向占满；比例按真手机屏（PHONE_RATIO），34 的圆角取自新版设计稿 */
                height: '100%', aspectRatio: PHONE_RATIO, boxSizing: 'border-box',
                borderRadius: 34, overflow: 'hidden', background: 'var(--surface-1)',
                boxShadow: '0 30px 60px -36px rgba(24,23,21,.45), 0 0 0 1px var(--border-subtle)',
              }}
            >
              <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 34, overflow: 'hidden' }}>
                <Frame key={l.app_id} item={l} tint={tint} />
              </div>
            </div>
          ) : (
            <div
              style={{
                width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
                borderRadius: 14, overflow: 'hidden', background: 'var(--surface-1)',
                boxShadow: '0 30px 60px -36px rgba(24,23,21,.45), 0 0 0 1px var(--border-subtle)',
              }}
            >
              <div
                style={{
                  height: 38, display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px',
                  background: 'var(--surface-2)',
                }}
              >
                <div style={{ display: 'flex', gap: 6, width: 46 }}>
                  {[0, 1, 2].map((k) => (
                    <span key={k} style={{ width: 10, height: 10, borderRadius: 'var(--radius-pill)', background: 'var(--border-hover)' }} />
                  ))}
                </div>
                <span
                  className="mono"
                  style={{
                    flex: 1, textAlign: 'center', fontSize: 'var(--text-base)',
                    color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden',
                  }}
                >
                  {location.host}{appHref(l)}
                </span>
                <div style={{ width: 46 }} />
              </div>
              <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                <Frame key={l.app_id} item={l} tint={tint} />
              </div>
            </div>
          )}

        </div>

        <div
          style={{
            alignSelf: 'end', justifySelf: 'start', display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 18, paddingBottom: 8,
          }}
        >
          <Round title="上一个" icon="chevUp" onClick={() => move(-1)} />
          <Round title="下一个" icon="chevDown" onClick={() => move(1)} />
          <div style={{ height: 10 }} />
          <button
            onClick={() => onAuthor(l.owner_username)}
            title={l.owner_name}
            style={{
              width: 46, height: 46, border: 0,
              borderRadius: 'var(--radius-pill)', background: washOf(l.owner_username),
              color: 'var(--text-heading)', fontSize: 'var(--text-lg)',
              fontWeight: 'var(--weight-bold)', cursor: 'pointer',
            }}
          >
            {initial(l.owner_name)}
          </button>
          <Rail
            icon="heart" filled={l.liked} label={fmt(l.like_count)} title="喜欢"
            color={l.liked ? 'var(--tabby-orange)' : 'var(--text-primary)'} onClick={() => void toggleLike()}
          />
          <Rail
            icon={l.mine ? 'grid' : l.installed ? 'check' : 'plus'}
            label={l.mine ? '我的' : l.installed ? '已添加' : '添加'}
            title="添加到我的作品" color="var(--text-primary)" onClick={() => void toggleAdd()}
          />
          <Rail icon="link" label="分享" title="复制链接" color="var(--text-primary)" onClick={() => void share()} />
          {l.source_prompt && (
            <Rail icon="remix" label="做同款" title="做同款" color="var(--text-primary)" onClick={() => onRemix(l)} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 框里那个页面。
 *
 * 翻到下一个时原来是：上一个页面还挂着 → 换成封面 → 换到令牌后新建一个空
 * iframe（白的）→ 页面一点点画出来。四个画面接连换，看上去就是在几个页面
 * 之间闪。后来改成封面一直垫在底下、iframe 加载完才淡入——白屏没了，可封面
 * 是发布那一刻的截图，和真页面常常对不上（尺寸、内容、甚至已经改过版），
 * 淡入那一下还是像换了一张图。
 *
 * 现在底下垫的是一枚开关门的品牌标记：加载就是加载，不冒充页面。调用方按
 * app_id 给 key（换一个就是全新的，不会先露出上一个），iframe 加载完淡入。
 * 换不到试玩地址（没共享给你、已下线）才退回封面——那时页面本身打不开，
 * 截图是唯一能看的东西。
 */
function Frame({ item, tint }: { item: Listing; tint: string }) {
  /* 试玩走令牌地址，不是 /{owner}/{slug}/——见 wall.tsx 的 usePlayUrl */
  const { url: play, failed } = usePlay(item);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setLoaded(false); }, [play]);
  if (item.status === 'stopped') {
    return <Cover src={item.cover_path} label={`${item.name} · 已停用`} tint={tint} radius={0} />;
  }
  if (failed && !play) {
    return <Cover src={item.cover_path} label={item.name} tint={tint} radius={0} />;
  }
  return (
    <>
      {!loaded && (
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--surface-1)',
          }}
        >
          <MarkLoading size={56} />
        </div>
      )}
      {play && (
        <iframe
          key={play}
          src={play}
          title={item.name}
          sandbox="allow-scripts allow-forms allow-popups"
          onLoad={() => setLoaded(true)}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: tint,
            opacity: loaded ? 1 : 0, transition: 'opacity .2s ease-out',
          }}
        />
      )}
    </>
  );
}

function Round({ title, icon, onClick }: { title: string; icon: 'chevUp' | 'chevDown'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 44, height: 44, border: '1px solid var(--border-hover)',
        borderRadius: 'var(--radius-pill)', background: 'var(--surface-1)', color: 'var(--text-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={20} />
    </button>
  );
}

function Rail({
  icon, label, title, color, filled, onClick,
}: {
  icon: 'heart' | 'plus' | 'check' | 'grid' | 'link' | 'remix';
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
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
        padding: 0, border: 0, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 46, height: 46, borderRadius: 'var(--radius-pill)',
          background: 'var(--surface-1)', boxShadow: '0 0 0 1px var(--border-subtle)', color, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={20} filled={filled} />
      </span>
      <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>{label}</span>
    </button>
  );
}

function useInfoWide(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= 1180);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 1180);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return wide;
}

/**
 * 排序：先看方向对不对，再看别人用得多不多。
 *
 * 「选方向」里勾的分类排在前面——这是这一屏叫「为你推荐」而不是「热门」
 * 的全部含义。没勾过方向（跳过了、或还没进过手机端）就退化成按热度排，
 * 而不是空着。
 *
 * 热度 = 喜欢×3 + 在用×2 + 访问/50。喜欢权重最高是因为它最便宜也最直接
 * ——点一下心只表示"我觉得好"，而访问量里混着很多"点进去看一眼就走"。
 */
export function rank(list: Listing[], interests: Interest[]): Listing[] {
  const want = new Set<string>(interests);
  const heat = (l: Listing) =>
    Number(l.like_count) * 3 + Number(l.install_count) * 2 + Number(l.visit_count) / 50;
  return [...list].sort((a, b) => {
    const pa = want.has(exploreBucket(a.category)) ? 1 : 0;
    const pb = want.has(exploreBucket(b.category)) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return heat(b) - heat(a);
  });
}

/**
 * 推荐流的完整版：页面照 rank 排，后端按同款热度公式参加排序
 * （没有喜欢体系，去掉喜欢×3 那一项），两路合并成一条流。
 * 页面与后端同热度时页面在前——这一屏的主角仍是页面。
 */
export function rankAll(
  list: Listing[], backs: BackendListing[], interests: Interest[],
): RecItem[] {
  const apps: RecItem[] = rank(list, interests).map((l) => ({ kind: 'app', l }));
  const want = new Set<string>(interests);
  const heat = (b: BackendListing) =>
    Number(b.install_count) * 2 + Number(b.visit_count) / 50;
  const bes: RecItem[] = [...backs]
    .sort((x, y) => {
      const px = want.has(exploreBucket(x.category)) ? 1 : 0;
      const py = want.has(exploreBucket(y.category)) ? 1 : 0;
      if (px !== py) return py - px;
      return heat(y) - heat(x);
    })
    .map((b) => ({ kind: 'backend', b }));
  return [...apps, ...bes].sort((x, y) => {
    const px = x.kind === 'app' ? 1 : 0;
    const py = y.kind === 'app' ? 1 : 0;
    if (px !== py) return py - px;
    return 0;
  });
}

/**
 * 推荐流里的后端一页。
 *
 * 不做真页面预览（iframe 嵌 /svc 受制于服务自身的 CSP/框架头，不可靠），
 * 海报版式把「这是什么、谁做的、多少人复用」说清，动作只有三个：
 * 打开（新窗口直进 /svc）、添加/移除、复制链接。
 */
function BackendSlide({
  b, idx, n, move, onAuthor, onToast, onInstalled,
}: {
  b: BackendListing;
  idx: number;
  n: number;
  move: (d: number) => void;
  onAuthor: (username: string) => void;
  onToast: (t: string) => void;
  onInstalled: () => void;
}) {
  const pad = (v: number) => (v < 10 ? `0${v}` : String(v));
  const toggleAdd = async () => {
    try {
      if (b.mine) { onToast('这是你自己部署的后端'); return; }
      if (b.installed) {
        await api.uninstallBackendFromMarket(b.backend_id);
        onToast('已从「我的作品」移除');
      } else {
        await api.installBackendFromMarket(b.backend_id);
        onToast('已添加到「我的作品」');
      }
      onInstalled();
    } catch { onToast('没成功，重试一下'); }
  };
  const share = async () => {
    const url = `${location.origin}${b.url_path}`;
    onToast(await copyText(url) ? '链接已复制，发给同事就能打开' : url);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface-canvas)', color: 'var(--text-heading)' }}>
      <div
        style={{
          height: 64, flex: 'none', display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)',
          alignItems: 'center', gap: 16, padding: '0 24px',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)' }}>为你推荐</span>
          <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            {pad(idx + 1)} / {pad(n)}
          </span>
        </span>
        <span
          style={{
            height: 26, padding: '0 11px', borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-2)', color: 'var(--text-secondary)',
            fontSize: 'var(--text-base)', display: 'flex', alignItems: 'center', gap: 5,
          }}
        >
          <Icon name="db" size={12} />后端
        </span>
        <span style={{ justifySelf: 'end', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
          ↑ ↓ 键切换
        </span>
      </div>

      <div
        style={{
          flex: 1, minHeight: 0, display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr) auto',
          gridTemplateRows: 'minmax(0,1fr)', alignItems: 'center', gap: 40, padding: '0 40px 20px',
        }}
      >
        <div
          style={{
            alignSelf: 'end', justifySelf: 'end', width: '100%', maxWidth: 340,
            display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span
              style={{
                height: 26, padding: '0 11px', borderRadius: 'var(--radius-pill)',
                background: 'var(--surface-2)', color: 'var(--text-secondary)',
                fontSize: 'var(--text-base)', display: 'flex', alignItems: 'center',
              }}
            >
              {exploreBucket(b.category)}
            </span>
          </div>
          <h2
            style={{
              margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500,
              fontSize: 'clamp(28px, 2.4vw, 42px)', lineHeight: 1.1, color: 'var(--text-heading)',
            }}
          >
            {b.name}
          </h2>
          <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            {b.owner_name} · {fmt(b.install_count)} 人复用
            {b.live_count > 0 && ` · ${fmt(b.live_count)} 人正在用`}
          </span>
          <button
            onClick={() => window.open(b.url_path, '_blank', 'noopener')}
            style={{
              alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, height: 40,
              padding: '0 16px', border: 0, borderRadius: 12,
              background: 'var(--cta)', color: 'var(--cta-fg)', fontSize: 'var(--text-base)',
              fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            打开<Icon name="upRight" size={15} />
          </button>
        </div>

        <div style={{ height: '100%', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div
            style={{
              width: 'min(100%, 560px)', aspectRatio: '4 / 3', borderRadius: 20,
              background: washOf(b.backend_id), position: 'relative',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 14, boxShadow: '0 30px 60px -36px rgba(24,23,21,.45), 0 0 0 1px var(--border-subtle)',
            }}
          >
            <span
              style={{
                fontSize: 72, fontFamily: 'var(--font-serif)', fontWeight: 500,
                color: 'var(--text-heading)', opacity: 0.55, userSelect: 'none',
              }}
            >
              {initial(b.name)}
            </span>
            <span
              className="mono"
              style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}
            >
              {location.host}{b.url_path}
            </span>
          </div>
        </div>

        <div
          style={{
            alignSelf: 'end', justifySelf: 'start', display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 18, paddingBottom: 8,
          }}
        >
          <Round title="上一个" icon="chevUp" onClick={() => move(-1)} />
          <Round title="下一个" icon="chevDown" onClick={() => move(1)} />
          <div style={{ height: 10 }} />
          <button
            onClick={() => onAuthor(b.owner_username)}
            title={b.owner_name}
            style={{
              width: 46, height: 46, border: 0,
              borderRadius: 'var(--radius-pill)', background: washOf(b.owner_username),
              color: 'var(--text-heading)', fontSize: 'var(--text-lg)',
              fontWeight: 'var(--weight-bold)', cursor: 'pointer',
            }}
          >
            {initial(b.owner_name)}
          </button>
          <Rail
            icon={b.mine ? 'grid' : b.installed ? 'check' : 'plus'}
            label={b.mine ? '我的' : b.installed ? '已添加' : '添加'}
            title="添加到我的作品" color="var(--text-primary)" onClick={() => void toggleAdd()}
          />
          <Rail icon="link" label="分享" title="复制链接" color="var(--text-primary)" onClick={() => void share()} />
        </div>
      </div>
    </div>
  );
}
