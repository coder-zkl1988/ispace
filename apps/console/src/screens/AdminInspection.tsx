import { useEffect, useState } from 'react';
import { Badge, Button, Card, PageTitle, fmtDate } from '@ispace/ui';
import { api, type JobHeartbeat, type ProbeResult } from '../api';

/**
 * 设计稿管理员「平台巡检」屏。
 *
 * 分两块：
 *   上半「路径路由」—— 真的发一次请求确认员工页面还能打开
 *   下半「待处理」  —— 能自动判定的异常项
 *
 * 自动判定的项只列能算出来的，不编造。后端资源告警、证书到期等需编排器
 * 与网关接入后才有真实数据源，届时再加——宁可列表短，也不放假条目。
 */
export function AdminInspection() {
  const [items, setItems] = useState<{ severity: 'warn' | 'info'; text: string; hint: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void api.adminInspection().then((r) => setItems(r.items)).finally(() => setLoaded(true));
  }, []);

  return (
    <>
      <PageTitle title="平台巡检" subtitle="路由、探活与重建后的必做项" />

      <RouteProbe />

      <JobHeartbeats />

      <strong style={{ display: 'block', fontSize: 'var(--text-md)', margin: 'var(--space-10) 0 var(--space-8)' }}>
        待处理
      </strong>
      {!loaded ? null : items.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 'var(--space-24)' }}>
          <Badge tone="success">一切正常</Badge>
          <p style={{ margin: 'var(--space-8) 0 0', color: 'var(--text-secondary)' }}>
            当前没有需要处理的事项。
          </p>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          {items.map((it, i) => (
            <Card key={i}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-8)' }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', marginTop: 6, flex: 'none',
                  background: it.severity === 'warn' ? 'var(--warning)' : 'var(--tabby-teal)',
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 'var(--weight-medium)' }}>{it.text}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>{it.hint}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <RebuildChecklist />

      <p style={{ marginTop: 'var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
        后端资源告警、证书到期等项需编排器与网关接入后才有数据源，届时会出现在这里。
      </p>
    </>
  );
}

/**
 * 路径路由探活。
 *
 * 静态托管应用重建后服务名会变，而路由规则里引用的是旧名——结果是**全部**
 * 员工页面 404，且平台自身的健康检查一切正常，因为挂的不是平台。
 * 这一条就是那次事故的直接探针：必须真发一次请求，不能只查配置写了什么。
 */
/**
 * 后台任务心跳。
 *
 * 资源采样跑在宿主的 crontab 里，服务端看不见它的进程。它挂掉时的表现是
 * 「配额与用量」页永远显示「暂无采样」——而管理员分不清那是"这个人没有
 * 后端"还是"采集任务死了"。这一块就是为了让这两种情况长得不一样。
 */
function JobHeartbeats() {
  const [jobs, setJobs] = useState<JobHeartbeat[]>([]);
  const [known, setKnown] = useState<{ name: string; label: string; every: string; install: string }[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api.adminJobs()
      .then((r) => { setJobs(r.jobs); setKnown(r.known); })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;

  return (
    <Card style={{ marginTop: 'var(--space-8)' }}>
      <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-8)' }}>
        后台任务
      </strong>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {known.map((k) => {
          const j = jobs.find((x) => x.name === k.name);
          return (
            <div key={k.name} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-medium)', width: 140, flex: 'none' }}>
                {k.label}
              </span>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', width: 64, flex: 'none' }}>
                {k.every}
              </span>
              {!j ? (
                <Badge tone="neutral" dot>从未运行</Badge>
              ) : j.state === 'alive' ? (
                <Badge tone="success" dot>正常</Badge>
              ) : j.state === 'stale' ? (
                <Badge tone="danger" dot>已停止</Badge>
              ) : (
                <Badge tone="warning" dot>有异常</Badge>
              )}
              {j && (
                <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                  {fmtDate(j.lastRunAt)}
                </span>
              )}
              {j?.note && (
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{j.note}</span>
              )}
              {/* 没跑起来时把安装命令直接给出来——这时候最需要的就是它 */}
              {(!j || j.state === 'stale') && (
                <code className="mono" style={{
                  fontSize: 'var(--text-xs)', background: 'var(--surface-2)',
                  padding: '2px var(--space-5)', borderRadius: 'var(--radius-6)',
                  color: 'var(--text-secondary)',
                }}>
                  {k.install}
                </code>
              )}
            </div>
          );
        })}
      </div>
      <p style={{ margin: 'var(--space-8) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
        采样跑在宿主的 crontab 上，不在服务容器里——deploy-service 故意没挂 docker.sock，
        不为读两个数字开一个容器逃逸的口子。所以它挂了服务端察觉不到，只能靠这条心跳。
      </p>
    </Card>
  );
}

function RouteProbe() {
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<Date | null>(null);

  const probe = async () => {
    setBusy(true);
    try {
      setResult(await api.adminProbe());
      setAt(new Date());
    } catch (e) {
      setResult({ probed: null, ok: false, note: (e as Error).message });
      setAt(new Date());
    } finally { setBusy(false); }
  };

  useEffect(() => { void probe(); }, []);

  const tone = result?.ok === true ? 'success' : result?.ok === false ? 'danger' : 'neutral';
  const label = result?.ok === true ? `正常 · ${result.status} OK`
    : result?.ok === false ? `异常 · ${result.status || '无响应'}`
    : '未探测';

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-8)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 4 }}>路径路由</strong>
          <p style={{ margin: '0 0 var(--space-6)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            静态托管重建后，路由规则里引用的服务名必须同步更新，否则全部员工页面 404。
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', flexWrap: 'wrap' }}>
            <Badge tone={tone}>{busy ? '探测中…' : label}</Badge>
            {result?.probed && (
              <span className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                {result.probed}
              </span>
            )}
            {result?.ms !== undefined && (
              <span className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                {result.ms} ms
              </span>
            )}
          </div>
          {result?.note && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 'var(--space-4)' }}>
              {result.note}
            </div>
          )}
          {at && (
            <div className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-4)' }}>
              探于 {fmtDate(at)}
            </div>
          )}
        </div>
        <Button size="sm" disabled={busy} onClick={() => void probe()}>立即探活</Button>
      </div>
    </Card>
  );
}

/**
 * 重建 checklist。
 *
 * 有意做成静态清单而非自动检查：这几步里有两步（写回服务名、reload 网关）
 * 平台自己做不了，必须有人上机操作。把它们写在这儿，是为了让"重建之后
 * 还要做什么"不依赖某个人记得。
 */
const CHECKLIST: { text: string; owner: string }[] = [
  { text: '记录静态托管应用重建后生成的服务名', owner: '运维' },
  { text: '把新服务名写回路径路由规则并 reload 网关', owner: '运维' },
  { text: '探活任一员工空间地址，确认 200', owner: '运维' },
  { text: '确认证书覆盖平台域名', owner: '运维' },
  { text: '在群里同步一次维护窗口结果', owner: '平台负责人' },
];

function RebuildChecklist() {
  // 勾选只存在本地：这是一次性操作的备忘，不该产生服务端状态，
  // 也不该让另一个管理员看到半勾的清单以为已经有人在做了。
  const [done, setDone] = useState<Set<number>>(new Set());

  return (
    <Card style={{ marginTop: 'var(--space-10)' }}>
      <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-4)' }}>
        重建 checklist
      </strong>
      <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        静态托管应用重建后按序执行。勾选只保存在本机，仅作备忘。
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {CHECKLIST.map((it, i) => (
          <label key={i} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
            fontSize: 'var(--text-base)', cursor: 'pointer',
            color: done.has(i) ? 'var(--text-tertiary)' : 'var(--text-primary)',
            textDecoration: done.has(i) ? 'line-through' : 'none',
          }}>
            <input
              type="checkbox"
              checked={done.has(i)}
              onChange={() => setDone((prev) => {
                const next = new Set(prev);
                if (next.has(i)) next.delete(i); else next.add(i);
                return next;
              })}
              style={{ accentColor: 'var(--accent)', width: 14, height: 14, flex: 'none' }}
            />
            <span style={{ flex: 1 }}>{it.text}</span>
            <Badge tone="neutral">{it.owner}</Badge>
          </label>
        ))}
      </div>
    </Card>
  );
}
