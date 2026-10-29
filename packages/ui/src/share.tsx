import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Avatar, Button, Dialog, Input, Select } from './index.js';
import { Icon, type IconName } from './icons.js';
import { qrPath } from './qr.js';
import { copyText } from './clipboard.js';

/**
 * 分享弹窗：上面邀请同事，中间是有访问权限的人，下面一档「常规访问权限」。
 *
 * 放在 ui 包而不是各端各写一份：控制台的「我的页面」与门户的应用卡片
 * 点的是同一件事，两处如果各写各的，可见范围的语义迟早会漂——
 * 一边把「全公司」理解成上架市场、另一边理解成人人可访问，
 * 而这两者的后果差别很大。
 */

/** 与 apps.visibility 一一对应。 */
export type ShareVisibility = 'private' | 'public' | 'shared' | 'link';

/**
 * 「常规访问权限」那一档。private 与 shared 在这里合成「用户」：
 * 有没有受邀的人由上面那份名单决定，不必让人再选一次。
 */
export type GeneralAccess = 'invited' | 'company' | 'link';

export const GENERAL_ACCESS: { value: GeneralAccess; label: string; note: string; icon: IconName }[] = [
  { value: 'invited', label: '用户', note: '只有你和上面邀请的用户能打开。', icon: 'lock' },
  { value: 'company', label: '市场', note: '上架到创意市场，公司同事登录后都能打开。', icon: 'building' },
  { value: 'link', label: '知道链接的任何人', note: '拿到私密链接的人不用登录就能查看，但无法编辑。', icon: 'globe' },
];

export function generalAccessOf(v: ShareVisibility): GeneralAccess {
  return v === 'public' ? 'company' : v === 'link' ? 'link' : 'invited';
}

/** 选回「用户」时落到哪一档：有人受邀就是 shared，否则 private。 */
export function visibilityOf(access: GeneralAccess, hasPeers: boolean): ShareVisibility {
  return access === 'company' ? 'public' : access === 'link' ? 'link' : hasPeers ? 'shared' : 'private';
}

export interface SharePeer {
  /** 空间标识，如 wangmengqi。分享接口按它认人。 */
  username: string;
  /** 展示名。取不到时用 username。 */
  displayName?: string;
  avatarUrl?: string | null;
  /** 待接受 / 已接受。 */
  status?: 'pending' | 'accepted';
}

export interface ShareDialogProps {
  open: boolean;
  appName: string;
  /** 作者本人，显示在名单第一行。 */
  owner?: { name: string; subtitle?: string; avatarUrl?: string | null };
  /** 页面原地址（需要登录才能看的那条）。 */
  shareUrl: string;
  /** visibility 为 link 时的私密链接（带令牌的完整地址）。 */
  linkUrl?: string | null;
  visibility: ShareVisibility;
  peers?: SharePeer[];
  onClose: () => void;
  onVisibilityChange: (v: ShareVisibility) => Promise<void> | void;
  onAddPeer: (username: string) => Promise<void> | void;
  onRemovePeer?: (username: string) => Promise<void> | void;
  /** 重置私密链接。不传就不显示那个按钮。 */
  onResetLink?: () => Promise<void> | void;
}

/**
 * 改动即刻生效，与常见的文档分享弹窗一致。
 *
 * 以前四档平铺成一排 Tabs，人会边点边读说明，中途路过的每一档都真的发生一次，
 * 所以那时要攒着点「确认分享」。现在是一个下拉框，选中就是想好了；
 * 邀请同事要点「邀请」才发出去，也不会因为回车手滑。
 */
export function ShareDialog({
  open, appName, owner, shareUrl, linkUrl, visibility, peers = [],
  onClose, onVisibilityChange, onAddPeer, onRemovePeer, onResetLink,
}: ShareDialogProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 关掉再开不该看到上次的残留
  useEffect(() => {
    if (open) return;
    setName(''); setErr(null); setCopied(false);
  }, [open]);

  const access = generalAccessOf(visibility);
  const current = GENERAL_ACCESS.find((a) => a.value === access)!;
  const copyUrl = access === 'link' && linkUrl ? linkUrl : shareUrl;

  const run = async (fn: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const invite = () => {
    const who = name.trim();
    if (!who) return;
    if (peers.some((p) => p.username === who)) { setErr(`${who} 已经在名单里了`); return; }
    void run(async () => { await onAddPeer(who); setName(''); });
  };

  const copy = () => {
    void copyText(copyUrl).then((ok) => {
      setCopied(ok);
      if (ok) setTimeout(() => setCopied(false), 1600);
      else setErr('复制不了，请手动选中下面的地址');
    });
  };

  const label = {
    fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', fontWeight: 'var(--weight-medium)',
  } as const;

  return (
    <Dialog
      open={open}
      title={appName}
      onClose={onClose}
      width={460}
      footer={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', width: '100%' }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            {access === 'link' ? '持链接的人免登录可看；转发出去的链接靠「重置链接」收回。'
              : access === 'company' ? '已上架市场，公司同事登录后可以打开这个地址。'
                : '只有有权限的人登录后才能打开这个地址。'}
          </span>
          <Button variant="primary" onClick={copy} disabled={access === 'link' && !linkUrl}>
            <Icon name={copied ? 'check' : 'link'} size={14} />
            {copied ? '已复制' : access === 'link' ? '复制私密链接' : '复制链接'}
          </Button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
        {/* ── 邀请同事 ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 'var(--space-5)' }}>
          <Input
            value={name}
            onChange={(e) => { setName(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); invite(); } }}
            placeholder="输入用户的空间标识邀请他"
            disabled={busy}
            style={{ flex: 1 }}
          />
          <Button onClick={invite} disabled={busy || !name.trim()}>邀请</Button>
        </div>

        {/* ── 有访问权限的人员 ─────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <span style={label}>有访问权限的人员</span>
          {owner && (
            <PersonRow name={`${owner.name}（你）`} subtitle={owner.subtitle} avatarUrl={owner.avatarUrl}
              right={<span style={{ color: 'var(--text-tertiary)' }}>所有者</span>} />
          )}
          {peers.map((p) => (
            <PersonRow
              key={p.username}
              name={p.displayName ?? p.username}
              subtitle={p.username}
              avatarUrl={p.avatarUrl}
              right={(
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
                  <span style={{ color: 'var(--text-tertiary)' }}>{p.status === 'pending' ? '待接受' : '可查看'}</span>
                  {onRemovePeer && (
                    <Button size="sm" variant="ghost" disabled={busy}
                      onClick={() => void run(() => onRemovePeer(p.username))}
                      aria-label={`移除 ${p.displayName ?? p.username}`}>
                      移除
                    </Button>
                  )}
                </span>
              )}
            />
          ))}
        </div>

        {/* ── 常规访问权限 ─────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <span style={label}>常规访问权限</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
            <span style={{
              width: 36, height: 36, flex: 'none', display: 'grid', placeItems: 'center',
              borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)', color: 'var(--text-secondary)',
            }}>
              <Icon name={current.icon} size={16} />
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <Select
                value={access}
                disabled={busy}
                aria-label="常规访问权限"
                items={GENERAL_ACCESS.map((a) => ({ value: a.value, label: a.label }))}
                onChange={(a) => void run(() => onVisibilityChange(visibilityOf(a, peers.length > 0)))}
                style={{ alignSelf: 'flex-start', fontWeight: 'var(--weight-medium)' }}
              />
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {current.note}
              </span>
            </div>
          </div>

          {access === 'link' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
              background: 'var(--surface-2)', borderRadius: 'var(--radius-12)',
              padding: 'var(--space-5) var(--space-6) var(--space-5) var(--space-8)',
            }}>
              <span className="mono" style={{
                flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {linkUrl ?? '正在生成链接…'}
              </span>
              {onResetLink && (
                <Button size="sm" variant="ghost" disabled={busy || !linkUrl}
                  onClick={() => void run(onResetLink)}>
                  <Icon name="rotate" size={14} />
                  重置链接
                </Button>
              )}
            </div>
          )}
          {access === 'link' && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              页面调用的后端要单独设为「知道链接的任何人」；你的个人数据和连接器不会随页面开放。
            </span>
          )}
        </div>

        {/* ── 手机上用 ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
          <QrCode text={copyUrl} size={64} />
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            手机扫码直接打开；同事也可以在自己的壳 App 里「添加到我的应用」。
          </p>
        </div>

        {/*
          报错留在弹窗里而不是丢给外面的 Toast：错误该贴着刚点的那个控件，
          而不是压在遮罩底下。
        */}
        {err && (
          <div role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--error)', lineHeight: 1.6 }}>
            {err}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function PersonRow({ name, subtitle, avatarUrl, right }: {
  name: string; subtitle?: string; avatarUrl?: string | null; right?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', fontSize: 'var(--text-base)' }}>
      <Avatar name={name} size={36} src={avatarUrl} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {subtitle && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{subtitle}</span>}
      </div>
      {right}
    </div>
  );
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
