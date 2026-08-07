import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, copyText, Dialog, fmtDate, Input, PageTitle, StatusDot,
  useConfirm, useCopy,
} from '@ispace/ui';
import { api, type Backend, type Me } from '../api';

/**
 * 设计稿「后端应用」屏。
 *
 * 状态从编排器实时取而非直接读库：库里的 status 只是最后一次已知值，
 * 容器可能已经挂了——控制台显示"运行中"而实际不可用，比显示"失败"更糟。
 * 实时取的逻辑在服务端 /backends 里，前端拿到的就是校准过的值。
 */
export function Backends({ me }: { me: Me }) {
  const [confirmUI, ask] = useConfirm();
  const c = useCopy();
  const [list, setList] = useState<Backend[]>([]);
  const [limits, setLimits] = useState({ cpu: 0.5, memoryMb: 512, count: 2 });
  const [orchestrator, setOrchestrator] = useState('');
  // 端口存成字符串：数字类型会让人删空时立刻跳回 0，打不进去
  const [form, setForm] = useState({ name: '', sourceRepo: '', port: '3000' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** 展开中的那条的部署日志。失败的后端不看日志就只剩「失败」两个字。 */
  const [logOf, setLogOf] = useState<{ id: string; name: string; text: string } | null>(null);

  const load = () => void api.backends()
    .then((r) => { setList(r.backends); setLimits(r.limits); setOrchestrator(r.orchestrator); })
    .catch((e: Error) => setMsg(e.message));
  useEffect(load, []);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(ok); load(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  const atLimit = list.length >= limits.count;

  return (
    <>
      <PageTitle title={c('backend.title')} subtitle={c('backend.subtitle')} />

      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-5)' }}>
          <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-medium)' }}>
            你已使用 <span className="num">{list.length}</span> / <span className="num">{limits.count}</span> 个自定义后端
          </span>
          {orchestrator && <Badge tone="neutral">编排器 {orchestrator}</Badge>}
        </div>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
          {c('backend.note')}
        </p>
      </Card>

      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-8)' }}>
          新建后端应用
        </strong>
        <div style={{ display: 'grid', gap: 'var(--space-6)', gridTemplateColumns: '1fr 1.4fr 100px auto', alignItems: 'end' }}>
          <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            应用名
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="paiban-api" style={{ marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            Git 仓库或镜像
            <Input value={form.sourceRepo} onChange={(e) => setForm({ ...form, sourceRepo: e.target.value })}
              placeholder="lixiao/paiban-api" style={{ marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            端口
            <Input value={form.port} inputMode="numeric"
              onChange={(e) => setForm({ ...form, port: e.target.value.replace(/[^\d]/g, '') })}
              placeholder="3000" style={{ marginTop: 4 }} />
          </label>
          <Button variant="primary"
            disabled={busy || atLimit || !form.name.trim() || !form.sourceRepo.trim()}
            onClick={() => void act(
              async () => {
                const r = await api.createBackend(
                  form.name.trim(), form.sourceRepo.trim(), Number(form.port) || 3000,
                );
                setForm({ name: '', sourceRepo: '', port: '3000' });
                return r;
              },
              '已创建，正在拉镜像并启动，通常一两分钟',
            )}>
            {atLimit ? '已达上限' : '创建'}
          </Button>
        </div>
        <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          <b>一个后端可以给你所有页面用。</b>后端属于你、不属于某个页面：
          它的地址与你的页面同域名同源，任意页面里直接写
          <span className="mono"> fetch('/svc/{me.user.username}/后端名/接口') </span>
          就能调，不用配 CORS，也不必每个页面建一个——配额只有 2 个。
          <br />
          源填镜像（<span className="mono">nginx:alpine</span>）或可 clone 的 Git 地址
          （<span className="mono">https://github.com/组织/仓库.git</span>）——
          GitHub 网页上那种带 <span className="mono">/tree/分支/子目录</span> 的链接 clone 不下来。
          端口填容器内实际监听的那个：Node 常见 3000，nginx 是 80，Python 那套多是 8000。
          <br />
          访问地址为 <span className="mono">{location.host}/svc/{me.user.username}/&lt;应用名&gt;</span>。
          限额 <span className="num">{limits.cpu}</span> vCPU / <span className="num">{limits.memoryMb}</span> MB
          由平台在创建时强制写入，不可自行调整。
        </p>
        {msg && <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-base)' }}>{msg}</p>}
      </Card>

      {list.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 'var(--space-24)' }}>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>还没有后端应用。纯网页不需要后端。</p>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  {['应用', '访问地址', '来源', '限额', '状态', '露出', '创建时间', ''].map((h) => (
                    <th key={h} style={{
                      padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)',
                      fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                      letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', fontWeight: 'var(--weight-medium)' }}>{b.name}</td>
                    <td className="mono" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{b.urlPath}</td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{b.sourceRepo ?? '—'}</td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>{b.cpuLimit} vCPU / {b.memLimitMb} MB</td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      <StatusDot
                        status={b.status === 'running' ? 'running' : b.status === 'failed' ? 'blocked' : b.status === 'stopped' ? 'stopped' : 'building'}
                        label={b.status === 'running' ? c('status.running')
                          : b.status === 'creating' ? c('status.building')
                          : b.status === 'stopped' ? c('status.stopped') : '失败'}
                      />
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {b.exposed ? (
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <Badge tone={b.visibility === 'public' ? 'success' : 'brand'}>
                            {b.visibility === 'public' ? '全公司' : b.visibility === 'shared' ? '指定同事' : '仅自己'}
                          </Badge>
                          <Button size="sm" variant="ghost" disabled={busy}
                            onClick={() => void act(() => api.updateBackend(b.id, { exposed: false }), `已从空间收回「${b.name}」`)}>收回</Button>
                        </span>
                      ) : (
                        <Button size="sm" variant="ghost" disabled={busy}
                          onClick={() => void act(
                            () => api.updateBackend(b.id, { exposed: true, visibility: 'public' }),
                            `「${b.name}」已作为应用露出到「我的页面」，全公司可访问`,
                          )}>露出到空间</Button>
                      )}
                    </td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{fmtDate(b.createdAt)}</td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {/* 只在失败时给这个入口：正常运行时用户不需要看构建日志，
                          放在那儿只会让操作列更挤 */}
                      {b.status === 'failed' && (
                        <Button size="sm" variant="ghost" disabled={busy}
                          onClick={() => void (async () => {
                            setBusy(true); setMsg(null);
                            try {
                              const r = await api.backendLogs(b.id);
                              setLogOf({ id: b.id, name: b.name, text: r.log ?? r.reason ?? '没有日志' });
                            } catch (e) { setMsg((e as Error).message); }
                            finally { setBusy(false); }
                          })()}>为什么失败</Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => void act(
                          () => api.redeployBackend(b.id),
                          `${b.name} 正在重新拉取并启动`,
                        )}>重新部署</Button>
                      <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => void act(() => api.restartBackend(b.id), `${b.name} 已重启`)}>重启</Button>
                      <Button size="sm" variant="ghost" disabled={busy}
                        onClick={async () => {
                          const ok = await ask({
                            title: `删除后端「${b.name}」？`,
                            description: '容器与路由会一并移除，容器内的数据不保留。已经指向它的页面会开始报错。',
                            confirmLabel: '删除',
                            danger: true,
                          });
                          if (ok) void act(() => api.deleteBackend(b.id), `${b.name} 已删除`);
                        }}>删除</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {logOf && (
        <Dialog
          open
          title={`「${logOf.name}」为什么起不来`}
          description="下面是部署时的真实输出。最后几行通常就是原因。"
          width={720}
          onClose={() => setLogOf(null)}
          footer={
            <>
              <Button variant="ghost"
                onClick={() => void copyText(logOf.text).then((ok) =>
                  setMsg(ok ? '日志已复制' : '这个浏览器不让自动复制，请手动选中上面的文字'))}>
                复制日志
              </Button>
              <Button onClick={() => setLogOf(null)}>知道了</Button>
            </>
          }
        >
          <pre
            className="mono"
            style={{
              margin: 0, padding: 'var(--space-6)', borderRadius: 'var(--radius-md)',
              background: 'var(--surface-2)', color: 'var(--text-secondary)',
              fontSize: 'var(--text-sm)', lineHeight: 1.7,
              maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap',
            }}
          >
            {logOf.text}
          </pre>
        </Dialog>
      )}
      {confirmUI}
    </>
  );
}
