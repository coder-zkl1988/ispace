import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Input, Tabs } from './index.js';
import { Icon } from './icons.js';
import { qrPath } from './qr.js';
import { copyText } from './clipboard.js';

/**
 * 分享弹窗（设计稿 PC 端「{名字} · 分享」对话框）。
 *
 * 放在 ui 包而不是各端各写一份：控制台的「我的页面」与门户的应用卡片
 * 点的是同一件事，两处如果各写各的，可见范围的语义迟早会漂——
 * 一边把「全公司」理解成上架市场、另一边理解成人人可访问，
 * 而这两者的后果差别很大。
 */

/** 设计稿的四档可见范围，与 apps.visibility 一一对应。 */
export type ShareVisibility = 'private' | 'public' | 'shared' | 'link';

const VIS_TABS: { value: ShareVisibility; label: string }[] = [
  { value: 'private', label: '仅自己' },
  { value: 'public', label: '市场' },
  { value: 'shared', label: '用户' },
  { value: 'link', label: '公开链接' },
];

export interface SharePeer {
  /** 空间标识，如 wangmengqi。分享接口按它认人。 */
  username: string;
  /** 展示名。取不到时用 username。 */
  displayName?: string;
  /** 待接受 / 已接受。设计稿的 chip 不区分，但 hover 时要说得清。 */
  status?: 'pending' | 'accepted';
}

export interface ShareDialogProps {
  open: boolean;
  appName: string;
  /** 完整可访问地址，用于展示、复制与生成二维码。 */
  shareUrl: string;
  /**
   * 「公开链接」的私密链接（带令牌的完整地址）。只在服务端已经是 link 档时有值；
   * 刚切到这一档还没确认时为空，确认后由父组件换上。
   */
  linkUrl?: string | null;
  /** 重置私密链接。不传就不显示那个按钮。 */
  onResetLink?: () => Promise<void> | void;
  visibility: ShareVisibility;
  /** 已分享到的同事。visibility 为 shared 时展示为可删除的 chip。 */
  peers?: SharePeer[];
  onClose: () => void;
  /** 点「确认分享」时才调用；弹窗内切换档位只改本地草稿。 */
  onVisibilityChange: (v: ShareVisibility) => Promise<void> | void;
  onAddPeer: (username: string) => Promise<void> | void;
  onRemovePeer?: (username: string) => Promise<void> | void;
}

/**
 * 弹窗里的改动先攒在本地，点「确认分享」才发出去。
 *
 * 「改动即刻生效」对分享这件事太快了：选中「全公司」的那一瞬间页面就上了
 * 创意市场，而人恰恰是在三档之间来回点、边点边读下面那行说明才决定选哪档的——
 * 中途路过的每一档都会真的发生一次，还都各留一条审计记录。
 * 加人也一样，名字打错回车就已经推送给别人了，收回要对方重新接受。
 */
export function ShareDialog({
  open, appName, shareUrl, linkUrl, visibility, peers = [],
  onClose, onVisibilityChange, onAddPeer, onRemovePeer, onResetLink,
}: ShareDialogProps) {
  const [vis, setVis] = useState<ShareVisibility>(visibility);
  const [draft, setDraft] = useState<SharePeer[]>(peers);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 外部（父组件重新加载数据）改了可见范围时跟上，否则关掉再开还是旧值
  useEffect(() => { setVis(visibility); }, [visibility]);

  /*
    人名列表同上，但依赖不能直接写 peers：它有默认值 []，每次渲染都是新数组，
    直接依赖会把用户刚攒下的改动在下一次渲染就冲掉。
  */
  const peersKey = peers.map((p) => `${p.username}:${p.status ?? ''}`).join('|');
  useEffect(() => { setDraft(peers); }, [peersKey]);

  // 关掉即丢弃未提交的改动：下次打开该看到服务端的现状，不是上次的残留
  useEffect(() => {
    if (open) return;
    setVis(visibility); setDraft(peers); setName(''); setErr(null);
  }, [open]);

  /*
    只有停在「指定同事」时人名的增删才算数——切走之后那份名单不再由用户维护，
    服务端会按新档位自己收拾（切「仅自己」收回全部分享、切「全公司」改走市场）。
  */
  const editingPeers = vis === 'shared';
  const added = editingPeers
    ? draft.filter((p) => !peers.some((o) => o.username === p.username)).map((p) => p.username)
    : [];
  const removed = editingPeers
    ? peers.filter((o) => !draft.some((p) => p.username === o.username)).map((o) => o.username)
    : [];
  const visChanged = vis !== visibility;
  const dirty = visChanged || added.length > 0 || removed.length > 0;

  const submit = async () => {
    if (!dirty || busy) return;
    setBusy(true); setErr(null);
    try {
      /*
        可见范围先落地。反过来的话，先加的人会被紧接着的档位切换连带撤掉——
        服务端切「仅自己」会收回全部分享，那一次提交就成了自相矛盾的两步。
      */
      if (visChanged) await onVisibilityChange(vis);
      for (const u of removed) await onRemovePeer?.(u);
      for (const u of added) await onAddPeer(u);
      /*
        刚开启公开链接时不关弹窗：私密链接是确认之后才生成的，
        人点确认就是为了拿到它，关掉还得再打开一次才能复制。
      */
      if (!(visChanged && vis === 'link')) onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stagePeer = () => {
    const who = name.trim();
    if (!who) return;
    if (draft.some((p) => p.username === who)) { setErr(`${who} 已经在列表里了`); return; }
    setDraft((prev) => [...prev, { username: who }]);
    setName('');
    setErr(null);
  };

  return (
    <Dialog
      open={open}
      title={`${appName} · 分享`}
      description="同事打开即用，不用装任何东西；他们使用产生的数据仍存在你的数据空间。"
      onClose={onClose}
      width={440}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!dirty || busy}>
            {busy ? '提交中…' : '确认分享'}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
        {/* ── 谁能打开 ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
          <span style={{
            fontSize: 'var(--text-2xs)', fontWeight: 'var(--weight-semibold)',
            letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
          }}>
            谁能打开
          </span>
          <Tabs items={VIS_TABS} value={vis} onChange={setVis} wrap />
        </div>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.6, marginTop: 'calc(var(--space-8) * -1)' }}>
          选「市场」会同时上架到创意市场；选「用户」对方主页会收到接受 / 拒绝的入口卡。
          选「公开链接」生成一条私密链接，知道链接的任何人免登录可看，不上架市场。
        </span>

        {/* ── 指定同事 ─────────────────────────────────────────── */}
        {editingPeers && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            {draft.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
                {draft.map((p) => {
                  const staged = !peers.some((o) => o.username === p.username);
                  return (
                    <span
                      key={p.username}
                      title={staged ? '待提交，确认后才推送给对方'
                        : p.status === 'pending' ? '等对方接受' : '已接受'}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-4)',
                        padding: '4px var(--space-6)', borderRadius: 'var(--radius-pill)',
                        fontSize: 'var(--text-sm)',
                        // 虚线框区分"还没提交的"与"已经在服务端的"，否则两者看不出差别
                        background: staged ? 'var(--accent-subtle)' : 'var(--surface-2)',
                        border: staged ? '1px dashed var(--border-hover)' : '1px solid transparent',
                        // 待接受的浅一档：分享出去不等于对方看得到
                        opacity: !staged && p.status === 'pending' ? 0.65 : 1,
                      }}
                    >
                      {p.displayName ?? p.username}
                      {(onRemovePeer || staged) && (
                        <button
                          onClick={() => {
                            setDraft((prev) => prev.filter((x) => x.username !== p.username));
                            setErr(null);
                          }}
                          disabled={busy}
                          aria-label={`取消分享给 ${p.displayName ?? p.username}`}
                          style={{
                            border: 'none', background: 'transparent', cursor: 'pointer',
                            color: 'var(--text-tertiary)', padding: 0, lineHeight: 1,
                            fontSize: 'var(--text-sm)',
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || busy) return;
                e.preventDefault();
                stagePeer();
              }}
              placeholder="输入同事的空间标识，回车加入列表"
              disabled={busy}
            />
          </div>
        )}

        {vis === 'link' ? (
          <LinkAccess
            linkUrl={visibility === 'link' ? linkUrl ?? null : null}
            busy={busy}
            copied={copied}
            onCopy={(url) => {
              void copyText(url).then((ok) => {
                setCopied(ok);
                if (ok) setTimeout(() => setCopied(false), 1600);
                else setErr('复制不了，请手动选中上面的地址');
              });
            }}
            onReset={onResetLink && (async () => {
              setBusy(true); setErr(null);
              try { await onResetLink(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
              finally { setBusy(false); }
            })}
          />
        ) : (
          <>
          {/* ── 链接 ─────────────────────────────────────────────── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
            background: 'var(--surface-2)', borderRadius: 'var(--radius-12)',
            padding: 'var(--space-5) var(--space-6) var(--space-5) var(--space-8)',
          }}>
            <span className="mono" style={{
              flex: 1, minWidth: 0, fontSize: 'var(--text-sm)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {shareUrl}
            </span>
            <Button size="sm" variant="primary" onClick={() => {
              void copyText(shareUrl).then((ok) => {
                setCopied(ok);
                if (ok) setTimeout(() => setCopied(false), 1600);
                else setErr('复制不了，请手动选中上面的地址');
              });
            }}>
              {copied ? '已复制' : '复制链接'}
            </Button>
          </div>

          {/* ── 手机上用 ─────────────────────────────────────────── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-8)',
            background: 'var(--surface-2)', borderRadius: 'var(--radius-12)',
            padding: 'var(--space-8)',
          }}>
            <QrCode text={shareUrl} size={84} />
            <div>
              <div style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-medium)', marginBottom: 'var(--space-3)' }}>
                手机上用
              </div>
              <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                扫码直接打开网页；对方也可以在自己的壳 App 里点「添加到我的应用」，
                之后这个页面就常驻在他的首页。
              </p>
            </div>
          </div>
          </>
        )}

        {dirty && !err && (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {pendingSummary(visChanged ? vis : null, added.length, removed.length)}
          </div>
        )}

        {/*
          报错留在弹窗里而不是丢给外面的 Toast：提交失败时弹窗不关，
          错误就该贴着那个点不动的按钮，而不是压在遮罩底下。
        */}
        {err && (
          <div role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--error)', lineHeight: 1.6 }}>
            {err}
          </div>
        )}

        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
          分享设置会记录操作日志；公开链接的匿名访问不识别具体是谁，可随时改回「仅自己」。
        </p>
      </div>
    </Dialog>
  );
}

/**
 * 「公开链接」那一档的内容：私密链接、重置、二维码、复制。
 *
 * 只在选中这一档时出现，其余三档仍是原来的地址框和二维码。
 */
function LinkAccess({ linkUrl, busy, copied, onCopy, onReset }: {
  /** null = 还没确认开启，令牌尚未生成。 */
  linkUrl: string | null;
  busy: boolean;
  copied: boolean;
  onCopy: (url: string) => void;
  onReset?: () => void;
}) {
  const note = { margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.6 } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
        <span style={{
          width: 40, height: 40, flex: 'none', display: 'grid', placeItems: 'center',
          borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)', color: 'var(--text-secondary)',
        }}>
          <Icon name="globe" size={18} />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
            知道链接的任何人
          </span>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            拿到私密链接的人不用登录就能查看，但无法编辑。
          </span>
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
        background: 'var(--surface-2)', borderRadius: 'var(--radius-12)',
        padding: 'var(--space-5) var(--space-6) var(--space-5) var(--space-8)',
      }}>
        <span className="mono" style={{
          flex: 1, minWidth: 0, fontSize: 'var(--text-sm)',
          color: linkUrl ? 'var(--text-secondary)' : 'var(--text-tertiary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {linkUrl ?? '点「确认分享」后生成私密链接'}
        </span>
        {linkUrl && onReset && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onReset}>
            <Icon name="rotate" size={14} />
            重置链接
          </Button>
        )}
      </div>

      <p style={note}>页面调用的后端要单独设为「公开链接」；你的个人数据和连接器不会随页面开放。</p>

      {linkUrl && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
            <QrCode text={linkUrl} size={84} label="私密链接的二维码" />
            <p style={{ ...note, color: 'var(--text-secondary)' }}>
              手机扫码直接打开；同事也可以在自己的壳 App 里「添加到我的应用」。
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
            <p style={{ ...note, flex: 1 }}>持链接的人免登录可看；转发出去的链接靠「重置链接」收回。</p>
            <Button variant="primary" onClick={() => onCopy(linkUrl)}>
              <Icon name={copied ? 'check' : 'link'} size={14} />
              {copied ? '已复制' : '复制私密链接'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function labelOf(v: ShareVisibility): string {
  return VIS_TABS.find((t) => t.value === v)?.label ?? v;
}

/** 逐条说清"确认之后会发生什么"——按钮亮着但说不出改了啥，人不敢点。 */
function pendingSummary(vis: ShareVisibility | null, added: number, removed: number): string {
  const parts: string[] = [];
  if (vis) parts.push(`可见范围改为「${labelOf(vis)}」`);
  if (added) parts.push(`新增 ${added} 位同事`);
  if (removed) parts.push(`取消 ${removed} 位同事`);
  return `确认后将：${parts.join('；')}。`;
}

/**
 * 二维码。
 *
 * 渲染成一个 SVG 而不是 canvas：弹窗里的二维码会被截图、会被放大，
 * 矢量在这两种情况下都不糊。也不必等 ref 挂上再画。
 *
 * 用 qrcode-generator（零依赖）而不是自己实现：Reed-Solomon 纠错、
 * BCH 格式信息、掩码选择，每一块写错都只会表现为"某些手机扫不出来"，
 * 而那是最难被测出来的一类错。
 */
export function QrCode({
  text, size = 84, label = '页面地址的二维码',
}: {
  text: string;
  size?: number;
  /**
   * 读屏软件念出来的说明。
   *
   * 默认值是分享弹窗的场景。码里装的不是页面地址时必须传——
   * 读屏用户听到的只有这一句，"页面地址的二维码"会把安装包说成一个网页。
   */
  label?: string;
}) {
  const path = useMemo(() => qrPath(text), [text]);

  if (!path) {
    return (
      <span style={{
        width: size, height: size, flex: 'none', display: 'grid', placeItems: 'center',
        borderRadius: 'var(--radius-8)', background: '#fff', border: '1px solid var(--border)',
        fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)', textAlign: 'center',
      }}>
        链接过长<br />无法生成
      </span>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${path.modules} ${path.modules}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      style={{
        flex: 'none', borderRadius: 'var(--radius-8)', background: '#fff',
        border: '1px solid var(--border)', padding: 4, boxSizing: 'content-box',
      }}
    >
      <path d={path.d} fill="#001217" />
    </svg>
  );
}
