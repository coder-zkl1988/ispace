import { useCallback, useEffect, useState } from 'react';
import type { Release } from '@ispace/contracts';
import {
  Button, Card, GENERAL_ACCESS, Icon, Input, ShareDialog, Toast, fmtBytes, fmtDate, generalAccessOf, useConfirm,
  useCopy, type ConfirmRequest, type ShareVisibility,
} from '@ispace/ui';
import { api, type AppRow, type Me, type SharePeerInfo } from '../api';

/**
 * 控制台 · 页面与版本（改版稿 §控制台 · 页面与版本）。
 *
 * 改版前这一屏是一张九列的表格加一个版本抽屉：一眼能看到所有页面的所有
 * 字段，但要对某一个页面做点什么，得先在行里找到它、再开抽屉。新稿把它
 * 翻过来——左边一列页面，右边是选中那个的全部：封面、地址、谁能看、版本
 * 历史、下架。一次只看一个，但看得全。
 *
 * 表格里原有的筛选（状态/类型/搜索）没有照搬：一个人的页面是个位数，筛选
 * 是为几十行准备的。真多到找不着时，左边那列自己会滚。
 */
type Vis = 'private' | 'shared' | 'public' | 'link';

const VIS_NOTE: Record<Vis, string> = {
  public: '全公司可见，已上架到探索。别人点「做同款」能看到做它的那句话。',
  shared: '只有你和邀请的同事能打开。',
  link: '知道私密链接的任何人都能查看，无需登录，不上架探索。',
  private: '只有你自己能打开。',
};

export function MyPages({ me }: { me: Me }) {
  const c = useCopy();
  const [confirmUI, ask] = useConfirm();
  const [apps, setApps] = useState<AppRow[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [sharing, setSharing] = useState<AppRow | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.apps().then((r) => setApps(r.apps)).catch((e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);

  /*
    门户「我的作品」里点「管理」会带着 #page=<slug> 过来。认一下这个 hash，
    否则那条链接只能把人送到这一屏的第一个页面——而他要管的是另一个。
  */
  useEffect(() => {
    const m = /^#\/?page=(.+)$/.exec(location.hash);
    if (m?.[1]) setPick(decodeURIComponent(m[1]));
  }, []);

  const cur = apps.find((a) => a.slug === pick) ?? apps[0] ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h1 style={{
          margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500, fontSize: 40,
          lineHeight: 1.15, color: 'var(--text-heading)',
        }}>
          页面与版本
        </h1>
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)' }}>
          每次发布都留一个版本。回滚是秒级的，旧版本一直在。
        </span>
      </div>

      {apps.length === 0 ? (
        <div style={{ padding: '56px 0', textAlign: 'center', fontSize: 'var(--text-md)', color: 'var(--text-tertiary)' }}>
          {c('pages.empty.hint')}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 240px', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {apps.map((a) => {
              const on = cur?.id === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => setPick(a.slug)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: 10,
                    border: 0, borderRadius: 14,
                    background: on ? 'var(--surface-1)' : 'transparent',
                    boxShadow: on ? '0 1px 3px rgba(24,23,21,.06), 0 0 0 1px var(--border-subtle)' : 'none',
                    cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <span style={{
                    width: 40, height: 40, flex: 'none', borderRadius: 11,
                    background: 'var(--wash-c)', color: 'var(--text-heading)',
                    fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-bold)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {a.iconLetter}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{
                      fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)',
                      color: 'var(--text-heading)', overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {a.name}
                    </span>
                    <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
                      /{a.slug}/
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {cur && (
            <PagePanel
              key={cur.id}
              app={cur}
              owner={me.user.username}
              onShare={(visibility) => setSharing({ ...cur, visibility })}
              onMsg={setMsg}
              onChanged={load}
              ask={ask}
            />
          )}
        </div>
      )}

      {msg && <Toast message={msg} onClose={() => setMsg(null)} />}
      {confirmUI}
      {sharing && (
        <AppShareDialog
          app={sharing}
          me={me}
          onClose={() => setSharing(null)}
          onChanged={load}
        />
      )}
      <GroupManager onChanged={load} />
    </div>
  );
}

/** 选中那个页面的全部：封面、地址、谁能看、版本、下架。 */
function PagePanel({
  app, owner, onShare, onMsg, onChanged, ask,
}: {
  app: AppRow;
  owner: string;
  onShare: (visibility: Vis) => void;
  onMsg: (m: string) => void;
  onChanged: () => void;
  ask: (req: ConfirmRequest) => Promise<boolean>;
}) {
  const c = useCopy();
  const [releases, setReleases] = useState<Release[]>([]);
  const [busy, setBusy] = useState(false);
  const [vis, setVis] = useState<Vis>(app.visibility as Vis);
  useEffect(() => { setVis(app.visibility as Vis); }, [app.visibility]);
  const [status, setStatus] = useState(app.status);

  const loadReleases = useCallback(() => {
    void api.releases(app.slug).then((r) => setReleases(r.releases)).catch(() => setReleases([]));
  }, [app.slug]);
  useEffect(loadReleases, [loadReleases]);

  const rollback = async (v: number) => {
    setBusy(true);
    try {
      const r = await api.rollback(app.slug, v);
      onMsg(`已切到 v${r.release.version}，秒级生效，其他版本都还在`);
      loadReleases();
      onChanged();
    } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); }
  };

  const toggleStatus = async () => {
    const stopping = status !== 'stopped';
    if (stopping) {
      const ok = await ask({
        title: `下架「${app.name}」？`,
        description:
          `下架后 ${location.host}/${owner}/${app.slug}/ 会返回 404，已经添加过它的同事也会失去入口。`
          + '版本和数据都保留，随时可以重新上线。',
        confirmLabel: '下架',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.setAppStatus(app.slug, stopping ? 'stopped' : 'running');
      setStatus(stopping ? 'stopped' : 'running');
      onMsg(stopping ? '已下架，地址现在返回 404' : '已重新上线');
      onChanged();
    } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); }
  };

  const cover = app.coverUrl;
  const dot = status === 'running' ? 'var(--tabby-teal)' : status === 'building' ? 'var(--warning)' : 'var(--text-tertiary)';

  return (
    <div style={{ flex: '3 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{
        display: 'flex', gap: 24, flexWrap: 'wrap', padding: 20, borderRadius: 22,
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
      }}>
        <div style={{
          position: 'relative', width: 200, aspectRatio: '4 / 3', flex: 'none',
          borderRadius: 14, overflow: 'hidden', background: 'var(--wash-c)',
          color: 'var(--cover-ink)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 'var(--text-base)', textAlign: 'center',
        }}>
          {cover
            ? <img src={cover} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ padding: 12, lineHeight: 1.6 }}>发布时从产物里取封面<br />（og:image 或 cover.png）</span>}
        </div>
        <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 30, fontWeight: 500, lineHeight: 1.2, color: 'var(--text-heading)' }}>
              {app.name}
            </span>
            <span style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 24, padding: '0 10px',
              borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: 'var(--radius-pill)', background: dot }} />
              {c(`status.${status}` as 'status.running')}
            </span>
          </div>
          <a
            href={`/${owner}/${app.slug}/`}
            className="mono"
            style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}
          >
            {location.host}/{owner}/{app.slug}/
          </a>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 4 }}>
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>谁能看</span>
            {/*
              可见范围统一在分享弹窗里改（邀请同事、常规访问权限、私密链接都在那儿），
              这里只说现状。以前这里平铺四档，与弹窗是两套入口，改一处另一处不跟。
            */}
            <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
              {vis === 'private' ? '仅自己' : GENERAL_ACCESS.find((a) => a.value === generalAccessOf(vis))!.label}
            </span>
            <Button size="sm" onClick={() => onShare(vis)} disabled={busy}>
              <Icon name="share2" size={14} />
              分享
            </Button>
          </div>
          <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
            {VIS_NOTE[vis]}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{
          paddingBottom: 12, fontSize: 'var(--text-card-title)',
          fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)',
        }}>
          版本
        </span>
        {releases.length === 0 ? (
          <span style={{ padding: '14px 4px', borderTop: '1px solid var(--border-tabby)', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            还没有发布记录。
          </span>
        ) : releases.map((r) => (
          <div
            key={r.id}
            style={{
              display: 'grid', gridTemplateColumns: '56px minmax(0,1fr) auto', alignItems: 'center',
              gap: 14, padding: '14px 4px', borderTop: '1px solid var(--border-tabby)',
            }}
          >
            <span className="mono" style={{ fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text-heading)' }}>
              v{r.version}
            </span>
            <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
                {r.blockedReason ?? `${fmtBytes(r.sizeBytes)} 的产物`}
              </span>
              <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
                {c(`source.${r.source}` as 'source.mcp')} · {fmtDate(r.publishedAt)}
              </span>
            </span>
            {r.status === 'active' ? (
              <span style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 12px',
                borderRadius: 'var(--radius-pill)', background: 'var(--tabby-teal-subtle)',
                color: 'var(--text-heading)', fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--tabby-teal)' }} />
                线上
              </span>
            ) : r.status === 'blocked' ? (
              <span style={{
                height: 28, padding: '0 12px', borderRadius: 'var(--radius-pill)',
                background: 'var(--danger-subtle)', color: 'var(--danger)',
                fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
                display: 'flex', alignItems: 'center',
              }}>
                {c('status.blocked')}
              </span>
            ) : (
              <button
                disabled={busy}
                onClick={() => void rollback(r.version)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px',
                  border: '1px solid var(--border)', borderRadius: 9, background: 'var(--surface-1)',
                  color: 'var(--text-primary)', fontSize: 'var(--text-base)',
                  fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
                }}
              >
                <Icon name="rotate" size={13} />切到这版
              </button>
            )}
          </div>
        ))}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        flexWrap: 'wrap', paddingTop: 20, borderTop: '1px solid var(--border-tabby)',
      }}>
        <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
          下架后地址返回 404，版本都保留，随时可以重新上线。
        </span>
        <button
          disabled={busy}
          onClick={() => void toggleStatus()}
          style={{
            height: 34, padding: '0 14px', border: '1px solid var(--border)', borderRadius: 10,
            background: 'var(--surface-1)',
            color: status === 'stopped' ? 'var(--text-heading)' : 'var(--danger)',
            fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
          }}
        >
          {status === 'stopped' ? '重新上线' : '下架这个页面'}
        </button>
      </div>
    </div>
  );
}

/**
 * 分享弹窗的数据接线。弹窗本体在 @ispace/ui，门户用的是同一个。
 */
function AppShareDialog({
  app, me, onClose, onChanged,
}: { app: AppRow; me: Me; onClose: () => void; onChanged: () => void }) {
  const owner = me.user.username;
  const [peers, setPeers] = useState<SharePeerInfo[]>([]);
  const [vis, setVis] = useState<ShareVisibility>(app.visibility as ShareVisibility);
  const [linkPath, setLinkPath] = useState<string | null>(null);
  const loadPeers = useCallback(() => {
    void api.appShares(app.id).then((r) => setPeers(r.peers)).catch(() => setPeers([]));
  }, [app.id]);
  useEffect(loadPeers, [loadPeers]);
  // 私密链接只给作者本人；不是 link 档时服务端回 null
  useEffect(() => {
    if (vis !== 'link') { setLinkPath(null); return; }
    void api.appLink(app.id).then((r) => setLinkPath(r.linkPath)).catch(() => setLinkPath(null));
  }, [app.id, vis]);

  return (
    <ShareDialog
      open
      appName={app.name}
      owner={{ name: me.user.displayName || owner, subtitle: owner }}
      shareUrl={`${location.origin}/${owner}/${app.slug}/`}
      linkUrl={linkPath ? location.origin + linkPath : null}
      visibility={vis}
      peers={peers}
      onClose={onClose}
      onVisibilityChange={async (v) => {
        const r = await api.setVisibility(app.id, v);
        setVis(v); setLinkPath(r.linkPath); loadPeers(); onChanged();
      }}
      onAddPeer={async (u) => {
        await api.share(app.id, u);
        // 从「仅自己」邀请人，服务端会收紧成「指定同事」；link / 全公司不变
        if (vis === 'private') setVis('shared');
        loadPeers(); onChanged();
      }}
      onRemovePeer={async (u) => { await api.revokeShareTo(app.id, u); loadPeers(); onChanged(); }}
      onResetLink={async () => { const r = await api.resetAppLink(app.id); setLinkPath(r.linkPath); }}
    />
  );
}


/**
 * 分组管理（设计稿聚合页的 常用 / 日常 / 客户跟进 / 小工具）。
 *
 * 删除分组不影响其中应用的可访问性——应用只是回到未分组。这由
 * app_groups 外键的 ON DELETE SET NULL 在数据库层保证，不靠应用层记得清理。
 */
function GroupManager({ onChanged }: { onChanged: () => void }) {
  const [confirmUI, ask] = useConfirm();
  const [groups, setGroups] = useState<{ id: string; name: string; app_count: string }[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => void api.groups().then((r) => setGroups(r.groups)).catch(() => setGroups([]));
  useEffect(load, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg(null);
    try { await fn(); load(); onChanged(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Card style={{ marginBottom: 'var(--space-8)' }}>
      <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-6)' }}>
        分组
      </strong>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-5)', marginBottom: 'var(--space-8)' }}>
        {groups.map((g) => (
          <span key={g.id} style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--space-4)',
            padding: '4px var(--space-6)', background: 'var(--surface-2)',
            borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-sm)',
          }}>
            {g.name}
            <span className="num" style={{ color: 'var(--text-tertiary)' }}>{g.app_count}</span>
            <button
              onClick={async () => {
                if (await ask({
                  title: `删除分组「${g.name}」？`,
                  description: '只删分组本身。组内应用会回到未分组，页面与数据都不受影响。',
                  confirmLabel: '删除分组',
                  danger: true,
                })) {
                  void act(() => api.deleteGroup(g.id));
                }
              }}
              disabled={busy}
              aria-label="删除分组"
              style={{
                border: 'none', background: 'transparent', cursor: 'pointer',
                color: 'var(--text-tertiary)', lineHeight: 0, padding: 0,
                display: 'inline-flex', alignItems: 'center',
              }}
            >
              {/* × 是乘号，不是关闭图标。设计稿的关闭用的是这条描边 path。 */}
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        {groups.length === 0 && (
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            还没有分组。分组只影响聚合页的展示归类。
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-5)', maxWidth: 380 }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="新分组名，如 客户跟进" />
        <Button size="sm" disabled={busy || !name.trim()}
          onClick={() => void act(async () => { await api.createGroup(name.trim()); setName(''); })}>
          新建
        </Button>
      </div>
      {msg && <p style={{ margin: 'var(--space-5) 0 0', fontSize: 'var(--text-sm)', color: 'var(--error)' }}>{msg}</p>}
      {confirmUI}
    </Card>
  );
}
