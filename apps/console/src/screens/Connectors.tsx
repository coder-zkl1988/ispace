import { useEffect, useState } from 'react';
import { Badge, Button, Card, Input, PageTitle, Select, copyText } from '@ispace/ui';
import { api, type CatalogEntry, type ConnectorRow, type Me } from '../api';

/**
 * 连接器屏。
 *
 * 这一屏存在的理由，是平台自己造出来的一个死结：发布链路会拦下前端代码里的
 * api_key（拦得对），但此前没有替代路径，于是「需要凭据的 API」整类做不了。
 *
 * 所以这一屏要回答的问题很具体：
 *   我想调某个外部接口，怎么做才不会被拦？ → 登记一个连接器，页面里调相对路径
 *   有哪些现成的可以直接用？               → 目录（都实测过连得通）
 *   我登记的那个 key 还在不在、有人用吗？   → 清单里的调用次数与最后使用时间
 *
 * 有意不提供「查看凭据」：能读回来的保管等于没保管。忘了填什么就重填，
 * 这个代价换的是一次越权读取不会把所有人的第三方 key 整批带走。
 */
export function Connectors({ me }: { me: Me }) {
  const [rows, setRows] = useState<ConnectorRow[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [keyReady, setKeyReady] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // 新建表单。挑目录条目会把它预填好——非技术用户不该去猜 base URL 怎么写。
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    slug: '', name: '', baseUrl: '', authKind: 'none' as ConnectorRow['authKind'],
    authName: '', secret: '', catalogId: '', shared: false,
  });
  const [saving, setSaving] = useState(false);

  const load = () => {
    void api.connectors().then((r) => setRows(r.connectors))
      .catch((e: Error) => { setRows([]); setErr(e.message); });
    void api.connectorCatalog().then((r) => {
      setCatalog(r.catalog); setKeyReady(r.secretStorageReady);
    }).catch(() => { /* 目录取不到不影响已登记的那些能用 */ });
  };
  useEffect(load, []);

  const pick = (c: CatalogEntry) => {
    setForm({
      slug: c.id, name: c.name, baseUrl: c.baseUrl, authKind: c.authKind,
      authName: c.authName ?? '', secret: '', catalogId: c.id, shared: false,
    });
    setOpen(true);
  };

  const submit = () => {
    setSaving(true); setErr(null);
    void api.createConnector({
      slug: form.slug, name: form.name, baseUrl: form.baseUrl,
      authKind: form.authKind,
      ...(form.authName ? { authName: form.authName } : {}),
      ...(form.secret ? { secret: form.secret } : {}),
      ...(form.catalogId ? { catalogId: form.catalogId } : {}),
      shared: form.shared,
    })
      .then(() => {
        setOpen(false);
        // 凭据不留在内存里，表单一并清掉
        setForm({ slug: '', name: '', baseUrl: '', authKind: 'none', authName: '', secret: '', catalogId: '', shared: false });
        load();
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setSaving(false));
  };

  const remove = (r: ConnectorRow) => {
    if (!confirm(`删掉「${r.name}」？用到它的页面会立刻开始报错。`)) return;
    void api.deleteConnector(r.id).then(load).catch((e: Error) => setErr(e.message));
  };

  const copy = (text: string, label: string) => {
    void copyText(text).then((ok) => {
      setCopied(ok ? label : null);
      setTimeout(() => setCopied(null), 1600);
    });
  };

  const installed = new Set((rows ?? []).map((r) => r.catalogId).filter(Boolean));

  return (
    <div>
      <PageTitle
        title="连接器"
        subtitle="页面要调外部接口时走这里。凭据交给平台保管，页面代码里不出现密钥——直接写进代码会被发布链路拦下来。"
      />

      {err && <Card><div style={{ color: 'var(--danger, #c0392b)' }}>{err}</div></Card>}

      {!keyReady && (
        <Card>
          <b>平台还不能保管凭据。</b>
          <p style={{ margin: '8px 0 0', lineHeight: 1.7 }}>
            管理员需要在服务器上生成一次加密密钥，之后需要 key 的连接器才能登记。
            不影响下面标着「免密钥」的那些。
          </p>
          <pre style={{ marginTop: 10, padding: 10, background: 'var(--surface-sunken, #f6f6f2)', borderRadius: 6, overflowX: 'auto' }}>
{`printf 'ISPACE_CONNECTOR_KEY=%s\\n' "$(openssl rand -hex 32)" >> ~/.ispace/env`}
          </pre>
        </Card>
      )}

      {/* ── 已登记 ─────────────────────────────────────────────── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <b>已登记</b>
          <Button onClick={() => setOpen((v) => !v)}>{open ? '收起' : '手动登记一个'}</Button>
        </div>

        {rows === null && <div style={{ opacity: .6 }}>加载中…</div>}
        {rows?.length === 0 && (
          <div style={{ opacity: .7, lineHeight: 1.8 }}>
            还没有。从下面的目录里挑一个，或者手动登记你们内部系统的接口。
          </div>
        )}

        {rows && rows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: .6, fontSize: 13 }}>
                  <th style={{ padding: '6px 12px 6px 0' }}>名字</th>
                  <th style={{ padding: '6px 12px 6px 0', whiteSpace: 'nowrap' }}>页面里这样调</th>
                  <th style={{ padding: '6px 12px 6px 0' }}>上游</th>
                  <th style={{ padding: '6px 12px 6px 0', whiteSpace: 'nowrap' }}>凭据</th>
                  <th style={{ padding: '6px 12px 6px 0', whiteSpace: 'nowrap' }}>用过</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const path = `/deploy/api/connect/${r.slug}/`;
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border, rgba(0,0,0,.07))' }}>
                      <td style={{ padding: '10px 12px 10px 0' }}>
                        {r.name}{' '}
                        {r.shared && <Badge tone="brand">全员共享</Badge>}
                      </td>
                      <td style={{ padding: '10px 12px 10px 0', whiteSpace: 'nowrap' }}>
                        <code style={{ fontSize: 12.5 }}>{path}</code>{' '}
                        <Button onClick={() => copy(path, r.id)}>
                          {copied === r.id ? '已复制' : '复制'}
                        </Button>
                      </td>
                      <td style={{ padding: '10px 12px 10px 0', fontSize: 12.5, opacity: .75 }}>
                        {r.baseUrl}
                      </td>
                      <td style={{ padding: '10px 12px 10px 0', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                        {r.hasSecret ? `已保管（${r.authKind}）` : '不需要'}
                      </td>
                      <td style={{ padding: '10px 12px 10px 0', whiteSpace: 'nowrap', fontSize: 12.5, opacity: .75 }}>
                        {r.callCount > 0 ? `${r.callCount} 次` : '还没有'}
                      </td>
                      <td style={{ padding: '10px 0', whiteSpace: 'nowrap' }}>
                        {(!r.shared || me.user.role === 'admin') && (
                          <Button onClick={() => remove(r)}>删除</Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {rows && rows.some((r) => !r.shared) && (
          <p style={{ marginTop: 12, fontSize: 12.5, opacity: .7, lineHeight: 1.7 }}>
            个人连接器只在你自己打开页面时有效。页面要分享给同事的话，
            请管理员发布一个「全员共享」的。
          </p>
        )}
      </Card>

      {/* ── 新建表单 ───────────────────────────────────────────── */}
      {open && (
        <Card>
          <b>登记一个连接器</b>
          <div style={{ display: 'grid', gap: 10, marginTop: 12, maxWidth: 560 }}>
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
                onChange={(v) => setForm({ ...form, authKind: v })}
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
                  凭据——存进去就读不回来了，自己另存一份
                </div>
                <Input type="password" value={form.secret} autoComplete="off"
                  onChange={(e) => setForm({ ...form, secret: e.target.value })} />
              </label>
            )}
            {me.user.role === 'admin' && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={form.shared}
                  onChange={(e) => setForm({ ...form, shared: e.target.checked })} />
                <span style={{ fontSize: 13 }}>
                  发布为全员共享——所有人都能调用，但看不到凭据。公司统一采购的 key 用这个。
                </span>
              </label>
            )}
            <div>
              <Button variant="primary" disabled={saving || !form.slug || !form.baseUrl} onClick={submit}>
                {saving ? '登记中…' : '登记'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* ── 目录 ───────────────────────────────────────────────── */}
      <Card>
        <b>可以直接用的</b>
        <p style={{ margin: '6px 0 14px', fontSize: 12.5, opacity: .7, lineHeight: 1.7 }}>
          下面每一条都在这台服务器上实测过连得通——国内环境下很多境外接口是不可达的，
          所以这份清单是实测结果而不是抄来的。
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          {catalog.map((c) => (
            <div key={c.id} style={{
              display: 'flex', gap: 12, alignItems: 'flex-start',
              padding: 12, border: '1px solid var(--border, rgba(0,0,0,.07))', borderRadius: 8,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b>{c.name}</b>
                  {c.authKind === 'none'
                    ? <Badge tone="success">免密钥</Badge>
                    : <Badge tone="warning">要自备 key</Badge>}
                  {installed.has(c.id) && <Badge tone="brand">已登记</Badge>}
                </div>
                <div style={{ fontSize: 13, opacity: .8, marginTop: 4, lineHeight: 1.6 }}>{c.what}</div>
                {c.apply && (
                  <div style={{ fontSize: 12, opacity: .65, marginTop: 4 }}>去哪儿申请：{c.apply}</div>
                )}
                <div style={{ fontSize: 12, opacity: .6, marginTop: 4, wordBreak: 'break-all' }}>
                  <code>{c.baseUrl}{c.example}</code>
                </div>
              </div>
              <Button onClick={() => pick(c)} disabled={installed.has(c.id)}>
                {installed.has(c.id) ? '已登记' : '登记'}
              </Button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
