import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Input, PageTitle, Select } from '@ispace/ui';
import { api, type CatalogEntry, type ConnectorRow } from '../api';

/**
 * 管理员：平台连接器。
 *
 * ┌─ 为什么这一屏必须存在 ──────────────────────────────────────────────┐
 * │ 「发布全员共享的连接器」此前长在员工的连接器页里，只是多一个复选框。 │
 * │ 那个位置错得很具体：它是一件治理动作——决定全公司的人能调什么外部    │
 * │ 接口、用哪一份公司统一采购的 key——却混在"我自己要接个 API"的流程里。│
 * │                                                                      │
 * │ 后果有两层：普通员工看见一个自己无权用的开关（点了报错），管理员则   │
 * │ 找不到该去哪儿配——"在哪配公共连接器"于是成了一个要问人的问题，而这  │
 * │ 个平台的目的正是让人不必问人。                                       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 这一屏同时回答另一个只有管理员会问的问题：**谁开了一条通往哪里的口子**。
 * 出站代理带着平台的身份，全平台的连接器清单是安全审查的起点。
 */

type Row = ConnectorRow & { owner: string | null };

export function AdminConnectors() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    slug: '', name: '', baseUrl: '', authKind: 'none' as ConnectorRow['authKind'],
    authName: '', secret: '', catalogId: '',
  });

  const load = () => {
    api.adminConnectors().then((r) => {
      setRows(r.connectors);
      setAllowPrivate(r.allowPrivate);
    }).catch(() => setRows([]));
    api.connectorCatalog().then((r) => setCatalog(r.catalog)).catch(() => { /* 目录取不到不影响这一屏的主功能 */ });
  };
  useEffect(load, []);

  const pick = (c: CatalogEntry) => {
    setForm({
      slug: c.id, name: c.name, baseUrl: c.baseUrl, authKind: c.authKind,
      authName: c.authName ?? '', secret: '', catalogId: c.id,
    });
    setErr(null);
    setOpen(true);
  };

  const blank = () => {
    setForm({ slug: '', name: '', baseUrl: '', authKind: 'none', authName: '', secret: '', catalogId: '' });
    setErr(null);
    setOpen(true);
  };

  const submit = async () => {
    setSaving(true);
    setErr(null);
    try {
      // shared 恒为 true：这一屏就是发布共享连接器的地方，不给"顺手发成个人的"的机会
      await api.createConnector({
        slug: form.slug, name: form.name, baseUrl: form.baseUrl, authKind: form.authKind,
        ...(form.authName ? { authName: form.authName } : {}),
        ...(form.secret ? { secret: form.secret } : {}),
        ...(form.catalogId ? { catalogId: form.catalogId } : {}),
        shared: true,
      });
      setOpen(false);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: Row) => {
    const who = r.shared ? '全员共享的' : `${r.owner ?? '某人'} 的个人`;
    if (!confirm(`删除${who}连接器「${r.slug}」？用到它的页面会立刻开始报错。`)) return;
    await api.deleteConnector(r.id).catch(() => { /* 失败时下面的 load 会还原真实状态 */ });
    load();
  };

  const shared = rows?.filter((r) => r.shared) ?? [];
  const personal = rows?.filter((r) => !r.shared) ?? [];
  const publishedSlugs = new Set(shared.map((r) => r.slug));

  return (
    <div>
      <PageTitle
        title="平台连接器"
        subtitle="发布全员可用的外部接口。凭据由平台加密保管，员工能调用但看不到。"
      />

      {/* ── 全员共享 ───────────────────────────────────────────── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <b>全员共享</b>
          <Button variant="primary" onClick={blank}>发布一个</Button>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12.5, opacity: .7, lineHeight: 1.7 }}>
          发布后，每个人的「连接器」页里都会出现它，AI 写页面时也会知道它可用。
          公司统一采购的 key、内部系统的接口放这里——员工不必各自申请一份，key 也不会流传到很多人手上。
        </p>
        {rows === null && <div style={{ opacity: .6 }}>加载中…</div>}
        {rows !== null && shared.length === 0 && (
          <div style={{ opacity: .7, lineHeight: 1.8 }}>
            还没有。标「免密钥」的内置接口本来就不用登记、人人可用，
            这里放的是需要凭据的那些。
          </div>
        )}
        {shared.length > 0 && <ConnectorTable rows={shared} onDelete={remove} showOwner={false} />}
      </Card>

      {/* ── 目录 ───────────────────────────────────────────────── */}
      <div style={{ marginTop: 16 }} />
      <Card>
        <b>从目录发布</b>
        <p style={{ margin: '6px 0 14px', fontSize: 12.5, opacity: .7, lineHeight: 1.7 }}>
          下面这些都在这台服务器上实测过连得通。免密钥的不需要发布——它们已经人人可用。
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          {catalog.filter((c) => c.authKind !== 'none').map((c) => (
            <div key={c.id} style={{
              display: 'flex', gap: 12, alignItems: 'flex-start',
              padding: 12, border: '1px solid var(--border, rgba(0,0,0,.07))', borderRadius: 8,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b>{c.name}</b>
                  <Badge tone="warning">要自备 key</Badge>
                  {publishedSlugs.has(c.id) && <Badge tone="brand">已发布</Badge>}
                </div>
                <div style={{ fontSize: 13, opacity: .8, marginTop: 4, lineHeight: 1.6 }}>{c.what}</div>
                {c.apply && (
                  <div style={{ fontSize: 12, opacity: .65, marginTop: 4 }}>去哪儿申请：{c.apply}</div>
                )}
              </div>
              <Button onClick={() => pick(c)} disabled={publishedSlugs.has(c.id)}>
                {publishedSlugs.has(c.id) ? '已发布' : '发布'}
              </Button>
            </div>
          ))}
        </div>
      </Card>

      {/* ── 员工自建 ───────────────────────────────────────────── */}
      <div style={{ marginTop: 16 }} />
      <Card>
        <b>员工自建的</b>
        <p style={{ margin: '6px 0 14px', fontSize: 12.5, opacity: .7, lineHeight: 1.7 }}>
          出站代理带着平台的身份出去，所以这份清单是安全审查的起点——
          它回答的是「谁开了一条通往哪里的口子」。凭据在这里也看不到。
          {allowPrivate && (
            <><br /><b style={{ color: 'var(--warning, #b45309)' }}>
              这台机器开着 ISPACE_CONNECTOR_ALLOW_PRIVATE，允许连接器访问内网地址。
              清楚这个网段里还有什么再留着它。
            </b></>
          )}
        </p>
        {rows !== null && personal.length === 0 && (
          <div style={{ opacity: .7 }}>还没有人自建过。</div>
        )}
        {personal.length > 0 && <ConnectorTable rows={personal} onDelete={remove} showOwner />}
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        width={560}
        title="发布全员共享的连接器"
        description="所有人都能调用，但看不到凭据。发布后会出现在每个人的连接器页里。"
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" disabled={saving || !form.slug || !form.baseUrl} onClick={submit}>
              {saving ? '发布中…' : '发布'}
            </Button>
          </div>
        )}
      >
        <div style={{ display: 'grid', gap: 10 }}>
          {err && (
            <div style={{
              padding: 10, borderRadius: 6, fontSize: 13, lineHeight: 1.7,
              background: 'var(--danger-subtle, #fef2f2)', color: 'var(--danger, #b91c1c)',
            }}>{err}</div>
          )}
          <label>
            <div style={{ fontSize: 12.5, opacity: .7, marginBottom: 4 }}>短名（页面里用它拼地址）</div>
            <Input value={form.slug} placeholder="amap"
              onChange={(e) => setForm({ ...form, slug: e.target.value })} />
          </label>
          <label>
            <div style={{ fontSize: 12.5, opacity: .7, marginBottom: 4 }}>名字</div>
            <Input value={form.name} placeholder="高德地图"
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            <div style={{ fontSize: 12.5, opacity: .7, marginBottom: 4 }}>
              上游根地址——同时是白名单，代理只允许访问它下面的路径，填得越具体越安全
            </div>
            <Input value={form.baseUrl} placeholder="https://restapi.amap.com/v3"
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </label>
          <label>
            <div style={{ fontSize: 12.5, opacity: .7, marginBottom: 4 }}>凭据怎么带</div>
            <Select
              value={form.authKind}
              onChange={(v) => setForm({ ...form, authKind: v as ConnectorRow['authKind'] })}
              items={[
                { value: 'none', label: '不需要凭据' },
                { value: 'query', label: '拼在查询串里（高德、和风）' },
                { value: 'header', label: '放在自定义请求头' },
                { value: 'bearer', label: 'Authorization: Bearer' },
              ]}
            />
          </label>
          {(form.authKind === 'query' || form.authKind === 'header') && (
            <label>
              <div style={{ fontSize: 12.5, opacity: .7, marginBottom: 4 }}>参数名</div>
              <Input value={form.authName} placeholder={form.authKind === 'query' ? 'key' : 'X-API-Key'}
                onChange={(e) => setForm({ ...form, authName: e.target.value })} />
            </label>
          )}
          {form.authKind !== 'none' && (
            <label>
              <div style={{ fontSize: 12.5, opacity: .7, marginBottom: 4 }}>
                凭据。加密入库，**存进去就再也读不出来**——忘了填的是什么只能重发一个。
              </div>
              <Input type="password" value={form.secret} autoComplete="off"
                onChange={(e) => setForm({ ...form, secret: e.target.value })} />
            </label>
          )}
        </div>
      </Dialog>
    </div>
  );
}

function ConnectorTable({
  rows, onDelete, showOwner,
}: {
  rows: (ConnectorRow & { owner: string | null })[];
  onDelete: (r: ConnectorRow & { owner: string | null }) => void;
  showOwner: boolean;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 13.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', fontSize: 12.5, opacity: .6 }}>
            {showOwner && <th style={{ padding: '0 12px 8px 0', whiteSpace: 'nowrap' }}>属于谁</th>}
            <th style={{ padding: '0 12px 8px 0', whiteSpace: 'nowrap' }}>短名</th>
            <th style={{ padding: '0 12px 8px 0' }}>上游</th>
            <th style={{ padding: '0 12px 8px 0', whiteSpace: 'nowrap' }}>凭据</th>
            <th style={{ padding: '0 12px 8px 0', whiteSpace: 'nowrap' }}>调用</th>
            <th style={{ padding: '0 0 8px' }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--border, rgba(0,0,0,.07))' }}>
              {showOwner && (
                <td style={{ padding: '10px 12px 10px 0', whiteSpace: 'nowrap' }}>{r.owner ?? '—'}</td>
              )}
              <td style={{ padding: '10px 12px 10px 0', whiteSpace: 'nowrap' }}><code>{r.slug}</code></td>
              <td style={{ padding: '10px 12px 10px 0', wordBreak: 'break-all', opacity: .8 }}>{r.baseUrl}</td>
              <td style={{ padding: '10px 12px 10px 0', whiteSpace: 'nowrap', fontSize: 12.5, opacity: .75 }}>
                {r.hasSecret ? `已保管（${r.authKind}）` : '不需要'}
              </td>
              <td style={{ padding: '10px 12px 10px 0', whiteSpace: 'nowrap', fontSize: 12.5, opacity: .75 }}>
                {r.callCount > 0 ? `${r.callCount} 次` : '还没有'}
              </td>
              <td style={{ padding: '10px 0', whiteSpace: 'nowrap' }}>
                <Button onClick={() => onDelete(r)}>删除</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
