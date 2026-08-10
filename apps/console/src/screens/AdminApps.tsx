import { useEffect, useMemo, useState } from 'react';
import { MARKETPLACE_CATEGORIES } from '@ispace/contracts';
import {
  Badge, Button, Card, fmtBytes, fmtDate, Input, PageTitle, Tabs, Toast, useConfirm,
} from '@ispace/ui';
import { api, type AdminApp, type AdminBackend } from '../api';

type Kind = 'apps' | 'backends';

/**
 * 全部作品：合规巡查（设计稿「治理」组新增一屏）。
 *
 * 市场那份列表只看得到别人**主动上架**的东西，绝大多数页面/后端从来
 * 没上过市场，出了合规问题（内容违规、员工离职前的遗留内容）之前完全
 * 看不见，只能挨个去问。这一屏不按可见范围过滤，也不区分是不是市场
 * 里的——管理员本来就该能看到全平台的全部作品，这正是这一屏存在的理由。
 *
 * 分类可以直接改（跟作者自己改分类走的是同一个动作，只是不受 owner_id
 * 限制）；下架是真下架——把 status 改成 stopped，authz/svc-proxy 的
 * 404 网关立刻生效，跟市场里「下架」（只摘 listing）是两个不同力度的动作，
 * 所以按钮分开摆，文案也刻意写得不一样，别让人以为点错了。
 */
export function AdminApps() {
  const [confirmUI, ask] = useConfirm();
  const [kind, setKind] = useState<Kind>('apps');
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [backends, setBackends] = useState<AdminBackend[]>([]);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const notify = (text: string) => setMsg({ text, tone: 'info' });
  const fail = (e: unknown) => setMsg({ text: e instanceof Error ? e.message : String(e), tone: 'error' });

  const load = () => {
    void api.adminApps().then((r) => setApps(r.apps));
    void api.adminAllBackends().then((r) => setBackends(r.backends));
  };
  useEffect(load, []);

  const kw = q.trim().toLowerCase();
  const shownApps = useMemo(() => (kw
    ? apps.filter((a) => a.name.toLowerCase().includes(kw) || a.slug.toLowerCase().includes(kw)
        || a.owner_username.toLowerCase().includes(kw) || a.owner_name.toLowerCase().includes(kw))
    : apps), [apps, kw]);
  const shownBackends = useMemo(() => (kw
    ? backends.filter((b) => b.name.toLowerCase().includes(kw)
        || b.owner_username.toLowerCase().includes(kw) || b.owner_name.toLowerCase().includes(kw))
    : backends), [backends, kw]);

  const setAppCategory = async (a: AdminApp, category: string) => {
    if (!category || category === (a.category ?? '')) return;
    try { await api.adminSetAppCategory(a.id, category); load(); }
    catch (e) { fail(e); }
  };
  const setBackendCategory = async (b: AdminBackend, category: string) => {
    if (!category || category === (b.category ?? '')) return;
    try { await api.adminSetBackendCategory(b.id, category); load(); }
    catch (e) { fail(e); }
  };

  const takedownApp = async (a: AdminApp) => {
    const ok = await ask({
      title: `下架「${a.name}」？`,
      description:
        `作者：${a.owner_name}（${a.owner_username}）。这会立刻让所有访问者看到 404——`
        + '不管是通过市场、分享链接还是直接访问，跟市场里的"下架"（只摘市场列表）不是一回事。'
        + '不删除任何数据，作者随时能被恢复，产物仍在磁盘上。',
      confirmLabel: '确认下架',
      danger: true,
    });
    if (!ok) return;
    const reason = window.prompt('下架原因（可选，会记入审计日志）：') ?? undefined;
    try { await api.adminTakedownApp(a.id, reason || undefined); notify(`已下架「${a.name}」`); load(); }
    catch (e) { fail(e); }
  };
  const restoreApp = async (a: AdminApp) => {
    try { await api.adminRestoreApp(a.id); notify(`已恢复「${a.name}」`); load(); }
    catch (e) { fail(e); }
  };
  const takedownBackend = async (b: AdminBackend) => {
    const ok = await ask({
      title: `下架「${b.name}」？`,
      description:
        `作者：${b.owner_name}（${b.owner_username}）。请求会立刻被拒绝（404），容器不会被停止，`
        + '恢复时原样能起来。真要连容器一起收回资源，走「离职回收」那条重路径。',
      confirmLabel: '确认下架',
      danger: true,
    });
    if (!ok) return;
    const reason = window.prompt('下架原因（可选，会记入审计日志）：') ?? undefined;
    try { await api.adminTakedownBackend(b.id, reason || undefined); notify(`已下架「${b.name}」`); load(); }
    catch (e) { fail(e); }
  };
  const restoreBackend = async (b: AdminBackend) => {
    try { await api.adminRestoreBackend(b.id); notify(`已恢复「${b.name}」`); load(); }
    catch (e) { fail(e); }
  };

  return (
    <>
      <PageTitle title="全部作品" subtitle="平台所有页面与后端，不按可见范围过滤——合规巡查与下架在这里做" />

      <datalist id="admin-content-categories">
        {MARKETPLACE_CATEGORIES.map((c) => <option key={c} value={c} />)}
      </datalist>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-8)', marginBottom: 'var(--space-8)' }}>
        <Tabs
          value={kind} onChange={setKind}
          items={[
            { value: 'apps', label: `页面 (${apps.length})` },
            { value: 'backends', label: `后端 (${backends.length})` },
          ]}
        />
        <div style={{ width: 260 }}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名字、地址或作者" />
        </div>
      </div>

      {kind === 'apps' && (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  {['页面', '作者', '分类', '可见性', '状态', '市场', '占用', '更新', '操作'].map((h) => (
                    <th key={h} style={{
                      padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)',
                      fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                      letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownApps.map((a) => (
                  <tr key={a.id} style={{ borderTop: '1px solid var(--border-subtle)', opacity: a.status === 'stopped' ? 0.55 : 1 }}>
                    <td style={{ padding: 'var(--space-5) var(--space-8)' }}>
                      <div style={{ fontWeight: 'var(--weight-medium)' }}>{a.name}</div>
                      <div className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                        /{a.owner_username}/{a.slug}/
                      </div>
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                      {a.owner_name}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)' }}>
                      <input
                        defaultValue={a.category ?? ''}
                        list="admin-content-categories"
                        placeholder="未分类"
                        onFocus={(e) => { e.target.value = ''; }}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (!v) { e.target.value = a.category ?? ''; return; }
                          void setAppCategory(a, v);
                        }}
                        style={{
                          width: 104, height: 28, padding: '0 var(--space-5)',
                          border: '1px solid var(--border)', borderRadius: 'var(--radius-8)',
                          fontSize: 'var(--text-sm)', background: 'var(--surface-1)', color: 'var(--text-primary)',
                        }}
                      />
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      <VisibilityBadge v={a.visibility} />
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {a.status === 'stopped'
                        ? <Badge tone="danger">已下架</Badge>
                        : a.status === 'building' ? <Badge tone="warning">发布中</Badge> : <Badge tone="success">运行中</Badge>}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {a.listed ? <Badge tone="brand">已上架</Badge> : <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>—</span>}
                    </td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                      {fmtBytes(a.size_bytes)}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {fmtDate(a.updated_at)}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {a.status === 'stopped'
                        ? <Button size="sm" variant="ghost" onClick={() => void restoreApp(a)}>恢复</Button>
                        : <Button size="sm" variant="danger" onClick={() => void takedownApp(a)}>下架</Button>}
                    </td>
                  </tr>
                ))}
                {shownApps.length === 0 && (
                  <tr><td colSpan={9} style={{ padding: 'var(--space-16)', textAlign: 'center', color: 'var(--text-tertiary)' }}>没有匹配的页面</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {kind === 'backends' && (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  {['后端', '作者', '分类', '可见性', '状态', '市场', '创建', '操作'].map((h) => (
                    <th key={h} style={{
                      padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)',
                      fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                      letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownBackends.map((b) => (
                  <tr key={b.id} style={{ borderTop: '1px solid var(--border-subtle)', opacity: b.status === 'stopped' ? 0.55 : 1 }}>
                    <td style={{ padding: 'var(--space-5) var(--space-8)' }}>
                      <div style={{ fontWeight: 'var(--weight-medium)' }}>{b.name}</div>
                      <div className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                        /svc/{b.owner_username}/{b.name}/
                      </div>
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                      {b.owner_name}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)' }}>
                      <input
                        defaultValue={b.category ?? ''}
                        list="admin-content-categories"
                        placeholder="未分类"
                        onFocus={(e) => { e.target.value = ''; }}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (!v) { e.target.value = b.category ?? ''; return; }
                          void setBackendCategory(b, v);
                        }}
                        style={{
                          width: 104, height: 28, padding: '0 var(--space-5)',
                          border: '1px solid var(--border)', borderRadius: 'var(--radius-8)',
                          fontSize: 'var(--text-sm)', background: 'var(--surface-1)', color: 'var(--text-primary)',
                        }}
                      />
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      <VisibilityBadge v={b.visibility} />
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {b.status === 'stopped'
                        ? <Badge tone="danger">已下架</Badge>
                        : b.status === 'failed' ? <Badge tone="danger">异常</Badge>
                        : b.status === 'creating' ? <Badge tone="warning">创建中</Badge> : <Badge tone="success">运行中</Badge>}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {b.listed ? <Badge tone="brand">已上架</Badge> : <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>—</span>}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {fmtDate(b.created_at)}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {b.status === 'stopped'
                        ? <Button size="sm" variant="ghost" onClick={() => void restoreBackend(b)}>恢复</Button>
                        : <Button size="sm" variant="danger" onClick={() => void takedownBackend(b)}>下架</Button>}
                    </td>
                  </tr>
                ))}
                {shownBackends.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: 'var(--space-16)', textAlign: 'center', color: 'var(--text-tertiary)' }}>没有匹配的后端</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {msg && <Toast message={msg.text} tone={msg.tone} onClose={() => setMsg(null)} />}
      {confirmUI}
    </>
  );
}

function VisibilityBadge({ v }: { v: 'private' | 'shared' | 'public' }) {
  if (v === 'public') return <Badge tone="success">全公司</Badge>;
  if (v === 'shared') return <Badge tone="warning">指定同事</Badge>;
  return <Badge tone="neutral">仅自己</Badge>;
}
