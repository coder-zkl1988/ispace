import { useState } from 'react';
import type { App, User } from '@ispace/contracts';
import { Icon } from '@ispace/ui';
import { api, type InstalledApp, type PendingShare } from './api';
import { Cover, PHONE_RATIO, initial, washOf } from './wall';

/**
 * 我的作品（改版稿 §我的作品）。
 *
 * 三个 tab 对应三种归属，这是改版前「我的页面」那一屏最含糊的地方——
 * 自己做的、同事分享的、从探索添加的混在一面墙上，而三者能做的事完全
 * 不同：自己的能改能分享，别人的只能打开和移除。分开之后，卡片下面那排
 * 按钮不用再逐个判断。
 */
type Tab = 'made' | 'shared' | 'added';

export function Mine({
  me, apps, installed, shares, onOpen, onManage, onShare, onReload, onToast, onShareDone,
}: {
  me: User;
  apps: App[];
  installed: InstalledApp[];
  shares: PendingShare[];
  onOpen: (owner: string, slug: string) => void;
  onManage: (slug: string) => void;
  onShare: (app: App) => void;
  onReload: () => void;
  onToast: (t: string) => void;
  onShareDone: () => void;
}) {
  const [tab, setTab] = useState<Tab>('made');
  const [busy, setBusy] = useState<string | null>(null);

  const fromShare = installed.filter((i) => i.source === 'share');
  const fromMarket = installed.filter((i) => i.source === 'marketplace');
  const running = apps.filter((a) => a.status === 'running').length;

  const tabs: { k: Tab; label: string; n: number }[] = [
    { k: 'made', label: '我做的', n: apps.length },
    { k: 'shared', label: '同事分享', n: fromShare.length },
    { k: 'added', label: '从探索添加', n: fromMarket.length },
  ];

  const remove = async (appId: string, name: string) => {
    if (!confirm(`把「${name}」从我的空间移除？\n\n页面还在作者那里，以后想用可以再添加。`)) return;
    setBusy(appId);
    try {
      await api.removeInstalled(appId);
      onToast(`已移除「${name}」`);
      onReload();
    } finally { setBusy(null); }
  };

  const respond = async (s: PendingShare, accept: boolean) => {
    setBusy(s.id);
    try {
      await api.respondShare(s.id, accept);
      onToast(accept ? `「${s.app.name}」已加到同事分享` : '已拒绝，这张卡片不会再出现');
      if (accept) setTab('shared');
      onShareDone();
    } finally { setBusy(null); }
  };

  return (
    <div
      style={{
        maxWidth: 1360, margin: '0 auto', padding: '12px 32px 96px', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', gap: 28,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h1
            style={{
              margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500, fontSize: 46,
              lineHeight: 1.1, color: 'var(--text-heading)',
            }}
          >
            我的作品
          </h1>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
            }}
          >
            <span className="mono" style={{ color: 'var(--text-secondary)' }}>
              {location.host}/{me.username}
            </span>
            <span>·</span>
            <span>{apps.length} 个页面 · {running} 个运行中</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <a
            href={`/${me.username}`}
            style={{
              display: 'flex', alignItems: 'center', height: 42, padding: '0 16px',
              border: '1px solid var(--border-hover)', borderRadius: 12,
              background: 'var(--surface-1)', color: 'var(--text-heading)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
              textDecoration: 'none',
            }}
          >
            同事看到的我
          </a>
          <a
            href="/create"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 42, padding: '0 16px 0 14px',
              borderRadius: 12, background: 'var(--cta)', color: 'var(--cta-fg)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', textDecoration: 'none',
            }}
          >
            <Icon name="plus" size={16} />新建页面
          </a>
        </div>
      </div>

      {/* 待接受的分享。顶栏那颗铃铛里也有，这里再摆一次是因为「我的作品」
          正是接受之后它会出现的地方——在目的地旁边决定，比在铃铛里决定清楚 */}
      {shares.map((s) => (
        <div
          key={s.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
            padding: '16px 18px', borderRadius: 18, background: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <span
            style={{
              width: 40, height: 40, flex: 'none', borderRadius: 'var(--radius-pill)',
              background: s.fromUser.avatarUrl ? 'transparent' : washOf(s.fromUser.username),
              color: 'var(--text-heading)', fontSize: 'var(--text-card-title)',
              fontWeight: 'var(--weight-bold)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', overflow: 'hidden',
            }}
          >
            {s.fromUser.avatarUrl
              ? <img src={s.fromUser.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : initial(s.fromUser.displayName)}
          </span>
          <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
              {s.fromUser.displayName} 分享给你「{s.app.name}」
            </span>
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              接受后它会出现在「同事分享」里，用起来和你自己的页面一样。
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              disabled={busy === s.id}
              onClick={() => void respond(s, true)}
              style={{
                height: 36, padding: '0 16px', border: 0, borderRadius: 10,
                background: 'var(--accent)', color: 'var(--accent-fg)',
                fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
              }}
            >
              接受
            </button>
            <button
              disabled={busy === s.id}
              onClick={() => void respond(s, false)}
              style={{
                height: 36, padding: '0 14px', border: 0, borderRadius: 10, background: 'transparent',
                color: 'var(--text-secondary)', fontSize: 'var(--text-base)',
                fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
              }}
            >
              拒绝
            </button>
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-tabby)' }}>
        {tabs.map((t) => {
          const on = tab === t.k;
          return (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              style={{
                position: 'relative', display: 'flex', alignItems: 'center', gap: 6, height: 46,
                padding: '0 14px', border: 0, background: 'transparent',
                color: on ? 'var(--text-heading)' : 'var(--text-tertiary)',
                fontSize: 'var(--text-md)',
                fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                cursor: 'pointer',
              }}
            >
              {t.label}
              <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>{t.n}</span>
              <span
                style={{
                  position: 'absolute', left: 14, right: 14, bottom: -1, height: 2, borderRadius: 2,
                  background: on ? 'var(--text-heading)' : 'transparent',
                }}
              />
            </button>
          );
        })}
      </div>

      {tab === 'made' && (
        apps.length === 0
          ? <Empty text="还没有页面，去创建一个。" />
          : (
            <Grid>
              {apps.map((a) => (
                <MineCard
                  key={a.id}
                  cover={a.coverUrl}
                  letter={a.iconLetter}
                  tintKey={a.id}
                  name={a.name}
                  type={a.type}
                  version={a.currentVersion}
                  status={a.status}
                  meta={`${VIS[a.visibility]} · ${new Date(a.updatedAt).toLocaleDateString('zh-CN')}更新`}
                  onOpen={() => onOpen(me.username, a.slug)}
                  actions={[
                    { label: '管理', run: () => onManage(a.slug) },
                    { label: '分享', run: () => onShare(a) },
                  ]}
                />
              ))}
            </Grid>
          )
      )}

      {tab === 'shared' && (
        fromShare.length === 0
          ? <Empty text="还没有同事分享给你的页面。" />
          : <Grid>{fromShare.map((i) => <InstalledCard key={i.id} item={i} busy={busy} onOpen={onOpen} onRemove={remove} />)}</Grid>
      )}

      {tab === 'added' && (
        fromMarket.length === 0
          ? <Empty text="在探索里点「添加到我的」，常用的页面会出现在这里。" />
          : <Grid>{fromMarket.map((i) => <InstalledCard key={i.id} item={i} busy={busy} onOpen={onOpen} onRemove={remove} />)}</Grid>
      )}
    </div>
  );
}

const VIS: Record<string, string> = { private: '仅自己', shared: '指定同事', public: '全公司', link: '知道链接的任何人' };

const Grid = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '32px 24px' }}>
    {children}
  </div>
);

const Empty = ({ text }: { text: string }) => (
  <div style={{ padding: '56px 0', textAlign: 'center', fontSize: 'var(--text-md)', color: 'var(--text-tertiary)' }}>
    {text}
  </div>
);

function InstalledCard({
  item, busy, onOpen, onRemove,
}: {
  item: InstalledApp;
  busy: string | null;
  onOpen: (owner: string, slug: string) => void;
  onRemove: (appId: string, name: string) => Promise<void>;
}) {
  return (
    <MineCard
      cover={item.cover_path}
      letter={item.icon_letter}
      tintKey={item.id}
      name={item.name}
      type={item.type}
      version={null}
      status={item.status}
      meta={`来自 ${item.owner_name}`}
      onOpen={() => onOpen(item.owner_username, item.slug)}
      actions={[{ label: '移除', run: () => void onRemove(item.id, item.name), disabled: busy === item.id }]}
    />
  );
}

function MineCard({
  cover, letter, tintKey, name, type, version, status, meta, onOpen, actions,
}: {
  cover: string | null;
  letter: string;
  tintKey: string;
  name: string;
  type: string;
  version: number | null;
  status: string;
  meta: string;
  onOpen: () => void;
  actions: { label: string; run: () => void; disabled?: boolean }[];
}) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        onClick={onOpen}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'relative', aspectRatio: '4 / 3', borderRadius: 18, cursor: 'pointer',
          transform: hover ? 'translateY(-2px)' : 'none',
          boxShadow: hover ? '0 20px 40px -22px rgba(0,0,0,.3)' : 'none',
          transition: 'transform .25s var(--ease-out-expo), box-shadow .25s',
        }}
      >
        <Cover
          /* 手机页面的封面是竖的（390×844），塞进 4:3 会被裁成中间一截——装进下面那台小手机 */
          src={type === 'h5' ? null : cover}
          label={type === 'h5' && cover ? '' : `${name} · ${type === 'h5' ? '手机截图' : '网页截图'}`}
          tint={washOf(tintKey)}
          radius={18}
        >
          {type === 'h5' && cover && (
            <span
              style={{
                position: 'absolute', top: '7%', bottom: '7%', left: '50%', transform: 'translateX(-50%)',
                aspectRatio: PHONE_RATIO, boxSizing: 'content-box', padding: 4, borderRadius: 18,
                background: '#111', boxShadow: '0 16px 32px -18px rgba(0,0,0,.5)', pointerEvents: 'none',
              }}
            >
              <img
                src={cover}
                alt=""
                style={{
                  display: 'block', width: '100%', height: '100%', objectFit: 'cover',
                  objectPosition: 'top', borderRadius: 14,
                }}
              />
            </span>
          )}
          {type === 'h5' && (
            <span
              style={{
                position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center',
                gap: 5, height: 24, padding: '0 10px 0 8px', borderRadius: 'var(--radius-pill)',
                background: 'var(--surface-1)', color: 'var(--text-heading)',
                fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
                pointerEvents: 'none',
              }}
            >
              <Icon name="phone" size={13} />手机页
            </span>
          )}
          {!cover && (
            <span
              style={{
                position: 'absolute', top: 12, right: 12, width: 28, height: 28,
                borderRadius: 8, background: 'var(--surface-1)', color: 'var(--text-heading)',
                fontSize: 'var(--text-base)', fontWeight: 'var(--weight-bold)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              {letter || initial(name)}
            </span>
          )}
        </Cover>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 2px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span
            onClick={onOpen}
            style={{
              fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-heading)', cursor: 'pointer',
            }}
          >
            {name}
          </span>
          {version !== null && (
            <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              v{version}
            </span>
          )}
        </div>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
            <span
              style={{
                width: 6, height: 6, borderRadius: 'var(--radius-pill)',
                background: status === 'running' ? 'var(--tabby-teal)' : status === 'building' ? 'var(--warning)' : 'var(--text-tertiary)',
              }}
            />
            {STATUS[status] ?? status}
          </span>
          <span>·</span>
          <span>{meta}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, paddingTop: 6, flexWrap: 'wrap' }}>
          <CardBtn label="打开" run={onOpen} />
          {actions.map((a) => <CardBtn key={a.label} {...a} />)}
        </div>
      </div>
    </div>
  );
}

const STATUS: Record<string, string> = { running: '运行中', building: '构建中', stopped: '已停用' };

function CardBtn({ label, run, disabled }: { label: string; run: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={run}
      disabled={disabled}
      style={{
        height: 30, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 9,
        background: 'var(--surface-1)', color: 'var(--text-primary)',
        fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
