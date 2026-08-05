import { useCallback, useEffect, useState } from 'react';
import type { Release } from '@ispace/contracts';
import {
  AppIcon, Badge, Button, Card, fmtBytes, fmtDate, Icon, Input,
  PageTitle, Select, ShareDialog, Tabs, Toast, useConfirm, useCopy,
  type ShareVisibility,
} from '@ispace/ui';
import { api, type AppRow, type Me, type SharePeerInfo } from '../api';

type StatusFilter = 'all' | 'running' | 'building' | 'stopped';
type TypeFilter = 'all' | 'static' | 'static_backend' | 'h5';

/**
 * 设计稿「我的页面」屏：筛选 + 表格 + 版本抽屉。
 *
 * 状态与类型是两个独立维度，不合成一组——「运行中的静态页」是常见诉求，
 * 合成一组就表达不了。但两个都用 Tabs（设计稿的做法）会占掉两整行，
 * 压着一个通常只有几行的表格，所以类型改用下拉，见筛选区的注释。
 */
export function MyPages({ me }: { me: Me }) {
  const c = useCopy();
  const [confirmUI, ask] = useConfirm();
  const [apps, setApps] = useState<AppRow[]>([]);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [type, setType] = useState<TypeFilter>('all');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<AppRow | null>(null);
  const [sharing, setSharing] = useState<AppRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.apps().then((r) => setApps(r.apps)).catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  const kw = q.trim().toLowerCase();
  const shown = apps.filter((a) =>
    (status === 'all' || a.status === status)
    && (type === 'all' || a.type === type)
    && (!kw || a.name.toLowerCase().includes(kw) || a.slug.toLowerCase().includes(kw)));
  const building = apps.filter((a) => a.status === 'building').length;

  const countOf = (t: AppRow['type']) => apps.filter((a) => a.type === t).length;
  /**
   * 删除页面。
   *
   * 此前完全没有这个入口：页面建了就删不掉，试错过的、名字起错的
   * 全堆在列表里占着配额，还得找管理员上服务器清。
   *
   * 确认文案要把**代价**说全：产物、历史版本、已发出去的地址一起消失。
   * 「离职回收」有意做成只停用不删，正因为那类操作事后常要还原；
   * 而这个语义就是"不要了"，所以必须让人看清再点。
   */
  const remove = async (a: AppRow) => {
    const ok = await ask({
      title: `删除「${a.name}」？`,
      description:
        `会连同全部历史版本一起删掉，产物从磁盘移除，占用的空间释放回配额。`
        + `已经发出去的地址 ${location.host}/${me.user.username}/${a.slug}/ 会立刻失效。`
        + '这个操作不可恢复——只是暂时不想让人看到的话，用「分享」改成「仅自己」就够了。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.deleteApp(a.slug);
      setMsg(
        `已删除 ${r.name}，连同 ${r.releases} 个版本，释放 ${fmtBytes(r.freedBytes)}`
        + (r.filesRemoved ? '' : '（磁盘产物未清干净，已记录告警）'),
      );
      load();
    } catch (e) { setErr((e as Error).message); }
  };

  const reset = () => { setStatus('all'); setType('all'); setQ(''); };
  const dirty = status !== 'all' || type !== 'all' || q !== '';

  return (
    <>
      <PageTitle title={c('pages.title')} subtitle={c('pages.subtitle')} />

      {/*
        筛选一行放完。
        设计稿这里状态与类型都是 Tabs，各占一行；实际用起来两行筛选压着一个
        通常只有几行的表格，太重了。状态留 Tabs——它是主筛选轴，「全部 N」的
        计数一眼能看出有没有在构建中，收进下拉就看不见了。类型换成下拉：
        切换频率低，而且「静态页 + 后端」这个标签会把 Tabs 撑得很宽。
      */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
        marginBottom: 'var(--space-8)', flexWrap: 'wrap',
      }}>
        <div style={{ width: 240 }}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索页面名或路径" />
        </div>
        <Tabs
          value={status}
          onChange={setStatus}
          items={[
            { value: 'all' as const, label: `全部 ${apps.length}` },
            { value: 'running' as const, label: c('status.running') },
            { value: 'building' as const, label: c('status.building') },
            { value: 'stopped' as const, label: c('status.stopped') },
          ]}
        />
        {/*
          选项带上各类型的条数。下拉的代价是"看不见还有哪些选项"，
          带上计数能把这个代价补回来一点：展开时就知道点进去有没有东西。
        */}
        <Select
          value={type}
          onChange={setType}
          aria-label="按类型筛选"
          items={[
            { value: 'all' as const, label: '所有类型' },
            { value: 'static' as const, label: `${c('type.static')} ${countOf('static')}` },
            { value: 'static_backend' as const, label: `${c('type.staticBackend')} ${countOf('static_backend')}` },
            { value: 'h5' as const, label: `${c('type.h5')} ${countOf('h5')}` },
          ]}
        />
        {dirty && <Button size="sm" variant="ghost" onClick={reset}>清空</Button>}
      </div>

      {err && <Card style={{ marginBottom: 'var(--space-8)', color: 'var(--error)' }}>{err}</Card>}
      {msg && <Toast message={msg} onClose={() => setMsg(null)} />}

      <GroupManager onChanged={load} />

      {shown.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 'var(--space-24)' }}>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
            {apps.length === 0 ? c('pages.empty.hint') : '没有符合筛选条件的页面'}
          </p>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
            padding: 'var(--space-8) var(--space-10)',
          }}>
            <strong style={{ fontSize: 'var(--text-md)' }}>页面列表</strong>
            <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              {shown.length} 个{building ? ` · ${building} 个${c('status.building')}` : ''}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  {['页面', '访问地址', '类型', '版本', '入口', '最近发布', '大小', '状态', '操作'].map((h) => (
                    <th key={h} style={{
                      padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)',
                      fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                      letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <Row
                    key={a.id}
                    app={a}
                    owner={me.user.username}
                    onDetail={() => setDetail(a)}
                    onShare={() => setSharing(a)}
                    onDelete={() => void remove(a)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {detail && <VersionDrawer app={detail} onClose={() => { setDetail(null); load(); }} />}
      {confirmUI}
      {sharing && (
        <AppShareDialog
          app={sharing}
          owner={me.user.username}
          onClose={() => setSharing(null)}
          onChanged={load}
        />
      )}
    </>
  );
}

/**
 * 分享弹窗的数据接线。弹窗本体在 @ispace/ui，门户用的是同一个。
 */
function AppShareDialog({
  app, owner, onClose, onChanged,
}: { app: AppRow; owner: string; onClose: () => void; onChanged: () => void }) {
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
      onVisibilityChange={async (v) => { await api.setVisibility(app.id, v); loadPeers(); onChanged(); }}
      onAddPeer={async (u) => { await api.share(app.id, u); loadPeers(); onChanged(); }}
      onRemovePeer={async (u) => { await api.revokeShareTo(app.id, u); loadPeers(); onChanged(); }}
    />
  );
}

/**
 * 一行页面。
 *
 * 状态用 Badge 带圆点而不是 StatusDot：设计稿这一列是徽标，
 * 三档配色也在设计稿里写死了——运行中 success、构建中 warning、
 * 已停止 neutral。已停止用中性而不是红色，是因为停用是主动操作，不是故障。
 */
function Row({
  app, owner, onDetail, onShare, onDelete,
}: {
  app: AppRow; owner: string;
  onDetail: () => void; onShare: () => void; onDelete: () => void;
}) {
  const c = useCopy();
  const typeKey = app.type === 'static' ? 'type.static'
    : app.type === 'h5' ? 'type.h5' : 'type.staticBackend';
  const statusKey = app.status === 'running' ? 'status.running'
    : app.status === 'building' ? 'status.building' : 'status.stopped';
  const tone = app.status === 'running' ? 'success'
    : app.status === 'building' ? 'warning' : 'neutral';
  const url = `/${owner}/${app.slug}/`;
  const cell = { padding: 'var(--space-6) var(--space-8)' } as const;

  return (
    <tr style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <td style={cell}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
          <AppIcon letter={app.iconLetter} size={26} />
          <span style={{ fontWeight: 'var(--weight-medium)' }}>{app.name}</span>
        </div>
      </td>
      <td className="mono" style={{ ...cell, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        {location.host}{url}
      </td>
      <td style={{ ...cell, fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
        {c(typeKey as 'type.static')}
        {/*
          仅当作者填了"主要服务于"才显示，是个备注不是约束——
          后端属于用户不属于页面，别的页面照样能调它。
        */}
        {app.backendName && (
          <span title={`作者标注：主要由后端「${app.backendName}」提供接口`}
                style={{ marginLeft: 'var(--space-4)' }}>
            <Badge tone="neutral">配后端</Badge>
          </span>
        )}
      </td>
      <td className="num" style={{ ...cell, whiteSpace: 'nowrap' }}>
        {app.currentVersion ? `v${app.currentVersion}` : '—'}
      </td>
      <td style={{ ...cell, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
        {app.currentSource ? c(`source.${app.currentSource}` as 'source.mcp') : '—'}
      </td>
      <td className="num" style={{ ...cell, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
        {fmtDate(app.updatedAt)}
      </td>
      <td className="num" style={{ ...cell, fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
        {fmtBytes(app.sizeBytes)}
      </td>
      <td style={{ ...cell, whiteSpace: 'nowrap' }}>
        <Badge tone={tone} dot>{c(statusKey as 'status.running')}</Badge>
      </td>
      <td style={{ ...cell, whiteSpace: 'nowrap' }}>
        <Button size="sm" variant="ghost" onClick={onDetail}>版本</Button>
        <Button size="sm" variant="ghost" onClick={onShare}>分享</Button>
        {/*
          「访问」开新标签，不在控制台里内嵌——用户的页面是独立应用，
          套在控制台框架里会让返回、刷新、地址栏全都行为不一致。
          停用中的页面点了会看到 404，所以直接置灰。
        */}
        {app.status === 'stopped' ? (
          <Button size="sm" variant="ghost" disabled>访问</Button>
        ) : (
          <a href={url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
            <Button size="sm" variant="ghost">访问</Button>
          </a>
        )}
        {/* 放在最后且用 danger 色：它是这一行里唯一不可恢复的操作，
            不能和「版本」「访问」长得一样、挨着放。 */}
        <Button size="sm" variant="ghost" onClick={onDelete}
          style={{ color: 'var(--error)' }}>删除</Button>
      </td>
    </tr>
  );
}

/** 版本抽屉：列历史版本并可回滚。设计稿「版本」按钮的落点。 */
function VersionDrawer({ app, onClose }: { app: AppRow; onClose: () => void }) {
  const c = useCopy();
  const [releases, setReleases] = useState<Release[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);

  const load = () => void api.releases(app.slug).then((r) => setReleases(r.releases)).catch(() => setReleases([]));
  useEffect(load, [app.slug]);
  useEffect(() => { void api.groups().then((r) => setGroups(r.groups)).catch(() => setGroups([])); }, []);

  const rollback = async (v: number) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.rollback(app.slug, v);
      setMsg(`已回滚到 v${r.release.version}`);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.2)', zIndex: 50,
        display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520, maxWidth: '92vw', height: '100%', overflowY: 'auto',
          background: 'var(--surface-canvas)', boxShadow: 'var(--shadow-dropdown)',
          padding: 'var(--space-12)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-10)' }}>
          <AppIcon letter={app.iconLetter} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-lg)' }}>{app.name}</div>
            <div className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>/{app.slug}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
        </div>

        {msg && (
          <Card style={{ marginBottom: 'var(--space-8)', fontSize: 'var(--text-base)' }}>{msg}</Card>
        )}

        <Card style={{ marginBottom: 'var(--space-8)' }}>
          <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-6)' }}>
            分组
          </strong>
          <Select
            value={app.groupId ?? ''}
            onChange={(id) => {
              const v = id || null;
              setBusy(true);
              void api.assignGroup(app.slug, v)
                .then(() => setMsg(v ? '已移入分组' : '已移出分组'))
                .catch((x: Error) => setMsg(x.message))
                .finally(() => setBusy(false));
            }}
            disabled={busy}
            style={{ width: '100%' }}
            items={[
              { value: '', label: '未分组' },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
        </Card>

        <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-6)' }}>
          历史版本
        </strong>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {releases.map((r) => (
            <Card key={r.id} style={{ padding: 'var(--space-6) var(--space-8)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}>
                <span className="num" style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--tabby-orange-hover)', width: 44 }}>
                  v{r.version}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="num" style={{ fontSize: 'var(--text-sm)' }}>{fmtDate(r.publishedAt)}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                    {c(`source.${r.source}` as 'source.mcp')} · {fmtBytes(r.sizeBytes)}
                  </div>
                </div>
                {r.status === 'active' && <Badge tone="success">当前</Badge>}
                {r.status === 'blocked' && <Badge tone="danger">{c('status.blocked')}</Badge>}
                {r.status === 'superseded' && (
                  <Button size="sm" disabled={busy} onClick={() => void rollback(r.version)}>
                    {c('action.rollback')}
                  </Button>
                )}
              </div>
              {r.blockedReason && (
                <div style={{ marginTop: 'var(--space-4)', fontSize: 'var(--text-sm)', color: 'var(--error)' }}>
                  {r.blockedReason}
                </div>
              )}
            </Card>
          ))}
          {releases.length === 0 && (
            <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-base)' }}>还没有发布记录</p>
          )}
        </div>
      </div>
    </div>
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
