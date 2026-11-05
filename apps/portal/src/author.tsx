import { useEffect, useState } from 'react';
import type { AuthorProfile } from '@ispace/contracts';
import { api, type Listing } from './api';
import { Wall, WallCard, fmt, initial, washOf } from './wall';

/**
 * 作者主页（改版稿 §作者主页）。
 *
 * 改版前 `/{user}/` 是「我的页面」——一个人自己的后台。新稿把这个地址改成
 * 了对外的一面：只列设为「全公司」的作品，谁都能打开。自己的后台挪到了
 * 「我的作品」。
 *
 * 所以同一个地址在两版里的含义变了。看自己的主页时顶上会写明这件事，
 * 并给一条去「我的作品」的路——否则作者会以为自己的页面丢了。
 */
type AuthorData = { profile: AuthorProfile; apps: Listing[] };

/** 这次打开门户以来看过的作者。只活在内存里，刷新就清。 */
const seen = new Map<string, AuthorData>();

export function Author({
  username, onOpen, onPlay, onRemix, onAuthor, onToast,
}: {
  username: string;
  onOpen: (l: Listing) => void;
  onPlay: (l: Listing) => void;
  onRemix: (l: Listing) => void;
  onAuthor: (username: string) => void;
  onToast: (t: string) => void;
}) {
  const [data, setData] = useState<AuthorData | null>(() => seen.get(username) ?? null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    /* 来过的人先用上次的画出来，再在后面刷新——不先闪一下「正在加载…」 */
    setData(seen.get(username) ?? null);
    setMissing(false);
    let alive = true;
    void api.author(username)
      .then((r) => {
        seen.set(username, r);
        if (alive) setData(r);
      })
      .catch(() => { if (alive) setMissing(true); });
    /*
     * 卡片上的「M 人正在用」是活数字，作者页不能只取一次快照挂在墙上
     * 装实时——与 App.tsx 的探索墙同窗口（45 秒、仅页面可见时）静默
     * 重拉。失败保持旧值，不置 missing（人还在，只是这一次没拉到）。
     */
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void api.author(username)
        .then((r) => { seen.set(username, r); if (alive) setData(r); })
        .catch(() => undefined);
    }, 45_000);
    return () => { alive = false; clearInterval(t); };
  }, [username]);

  if (missing) {
    return (
      <Center>
        <h1 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500, fontSize: 36, color: 'var(--text-heading)' }}>
          没有 /{username} 这个人
        </h1>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          地址可能拼错了，或者这位同事已经离开。
        </p>
        <a href="/" style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>回到探索 →</a>
      </Center>
    );
  }
  if (!data) return <Center><span style={{ color: 'var(--text-tertiary)' }}>正在加载…</span></Center>;

  const { profile, apps } = data;

  const toggleFollow = async () => {
    setBusy(true);
    try {
      const r = profile.following ? await api.unfollow(username) : await api.follow(username);
      setData((prev) => (prev ? {
        ...prev,
        profile: {
          ...prev.profile,
          following: r.following,
          stats: {
            ...prev.profile.stats,
            followers: prev.profile.stats.followers + (r.following ? 1 : -1),
          },
        },
      } : prev));
      onToast(r.following ? `已关注 ${profile.displayName}` : '已取消关注');
    } finally { setBusy(false); }
  };

  const stats: { v: string; k: string }[] = [
    { v: String(profile.stats.publicApps), k: '个公开作品' },
    { v: fmt(profile.stats.users), k: '人复用' },
    { v: fmt(profile.stats.visits), k: '次访问' },
    { v: fmt(profile.stats.followers), k: '关注者' },
  ];

  return (
    <div style={{ maxWidth: 1360, margin: '0 auto', padding: '0 32px 96px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, padding: '16px 0 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28, flexWrap: 'wrap' }}>
          <span
            style={{
              width: 104, height: 104, flex: 'none', borderRadius: 'var(--radius-pill)',
              background: profile.avatarUrl ? 'transparent' : washOf(profile.username),
              color: 'var(--text-heading)', fontFamily: 'var(--font-serif)', fontSize: 44,
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            }}
          >
            {profile.avatarUrl
              ? <img src={profile.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : initial(profile.displayName)}
          </span>
          <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h1
              style={{
                margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500, fontSize: 48,
                lineHeight: 1.1, color: 'var(--text-heading)',
              }}
            >
              {profile.displayName}
            </h1>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                fontSize: 'var(--text-md)', color: 'var(--text-tertiary)',
              }}
            >
              {/* 库里没有部门字段，有就显示、没有就不占一行（见 social.ts 的说明） */}
              {profile.department && <><span style={{ color: 'var(--text-secondary)' }}>{profile.department}</span><span>·</span></>}
              <span className="mono" style={{ fontSize: 'var(--text-base)' }}>
                {location.host}/{profile.username}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
            {stats.map((s) => (
              <div key={s.k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span
                  className="mono"
                  style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-.02em', color: 'var(--text-heading)' }}
                >
                  {s.v}
                </span>
                <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>{s.k}</span>
              </div>
            ))}
          </div>
          {!profile.self && (
            <button
              onClick={() => void toggleFollow()}
              disabled={busy}
              style={{
                height: 42, padding: '0 20px', borderRadius: 12,
                border: profile.following ? '1px solid var(--border-hover)' : 0,
                background: profile.following ? 'var(--surface-1)' : 'var(--accent)',
                color: profile.following ? 'var(--text-heading)' : 'var(--accent-fg)',
                fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
              }}
            >
              {profile.following ? '已关注' : '关注'}
            </button>
          )}
        </div>

        {profile.self && (
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              flexWrap: 'wrap', padding: '14px 18px', borderRadius: 16,
              background: 'var(--surface-sidebar)', fontSize: 'var(--text-base)',
              color: 'var(--text-secondary)',
            }}
          >
            <span>这是同事看到的你：只显示设为「全公司」的页面。</span>
            <a href="/mine" style={{ cursor: 'pointer', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
              管理我的作品 →
            </a>
          </div>
        )}

        <span
          style={{
            paddingTop: 24, borderTop: '1px solid var(--border-tabby)',
            fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-heading)',
          }}
        >
          公开的作品 · {apps.length}
        </span>
      </div>

      {apps.length === 0 ? (
        <div style={{ padding: '60px 0', textAlign: 'center', fontSize: 'var(--text-md)', color: 'var(--text-tertiary)' }}>
          还没有公开的作品。
        </div>
      ) : (
        <Wall>
          {apps.map((l) => (
            <WallCard
              key={l.id}
              item={l}
              onOpen={() => onOpen(l)}
              onPlay={() => onPlay(l)}
              onRemix={l.source_prompt ? () => onRemix(l) : null}
              onAuthor={() => onAuthor(l.owner_username)}
            />
          ))}
        </Wall>
      )}
    </div>
  );
}

const Center = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      minHeight: 360, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 14, padding: 32, textAlign: 'center',
    }}
  >
    {children}
  </div>
);
