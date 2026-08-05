import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, Dialog, Input, PageTitle, fmtBytes, fmtDate, useCopy,
} from '@ispace/ui';
import type { Quota } from '@ispace/contracts';
import { api, type QuotaRequest } from '../api';

type Resource = QuotaRequest['resource'];

/** 设计稿「配额与用量」屏。 */
export function QuotaScreen() {
  const c = useCopy();
  const [q, setQ] = useState<Quota | null>(null);
  const [limits, setLimits] = useState({ cpu: 0.5, mem: 512 });
  /** 后端实测用量。null = 宿主上的采样任务没在跑，或数据已过期。 */
  const [used, setUsed] = useState<{ cpu: number | null; mem: number | null }>(
    { cpu: null, mem: null },
  );
  const [requests, setRequests] = useState<QuotaRequest[]>([]);
  const [asking, setAsking] = useState<Resource | null>(null);

  const load = () => {
    void api.quota().then((r) => {
      setQ(r.quota);
      setLimits({ cpu: r.backendCpuLimit, mem: r.backendMemLimitMb });
      setUsed({ cpu: r.backendCpuUsed, mem: r.backendMemUsedMb });
    });
    void api.quotaRequests().then((r) => setRequests(r.requests)).catch(() => setRequests([]));
  };
  useEffect(load, []);

  if (!q) return <PageTitle title={c('quota.title')} subtitle={c('quota.subtitle')} />;

  /**
   * 设计稿「配额与用量」屏的五条，顺序一致。
   *
   * CPU 与内存的 used 可能是 null——那不是 0，是"还没采到数"。
   * 两者必须区分：显示 0 会让人以为后端没在跑，而实际可能只是
   * 宿主上的采样任务没装（见 infra/scripts/12-resource-sampler.sh）。
   *
   * 这两条也不给「申请提额」：单个后端的 CPU / 内存上限由平台强制写入
   * （规格 §5.3），要更多资源是加后端个数或整体调策略，不是调这一条。
   */
  const bars: {
    label: string; used: number | null; limit: number;
    fmt: (n: number) => string; resource: Resource | null;
  }[] = [
    { label: c('quota.staticSpace'), used: q.storageBytesUsed, limit: q.storageBytesLimit, fmt: fmtBytes, resource: 'storage' },
    { label: c('quota.backendCount'), used: q.backendCountUsed, limit: q.backendCountLimit, fmt: (n: number) => `${n} 个`, resource: 'backends' },
    { label: '后端 CPU', used: used.cpu, limit: limits.cpu, fmt: (n: number) => `${n.toFixed(2)} vCPU`, resource: null },
    { label: '后端内存', used: used.mem, limit: limits.mem, fmt: (n: number) => `${Math.round(n)} MB`, resource: null },
    /*
      数据行数保留。设计稿有这一条，而且它是共享 Postgres 的唯一护栏——
      静态空间限的是磁盘、后端限的是容器，谁都拦不住一张表写进几千万行
      把整库的查询拖慢。这是全平台共用的那一个库。
    */
    { label: c('quota.dbRows'), used: q.dbRowsUsed, limit: q.dbRowsLimit, fmt: (n: number) => n.toLocaleString(), resource: 'rows' },
  ];

  /** 某项资源是否已有待处理申请。有的话按钮要变成状态，不能让人重复点。 */
  const pendingFor = (r: Resource) => requests.find((x) => x.resource === r && x.status === 'pending');

  return (
    <>
      <PageTitle title={c('quota.title')} subtitle={c('quota.subtitle')} />
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-8)', marginBottom: 'var(--space-10)' }}>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
            {c('quota.exceedNote')}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
          {bars.map((b) => {
            const value = b.used;
            const pct = value !== null && b.limit > 0 ? Math.min(100, (value / b.limit) * 100) : 0;
            const pending = b.resource ? pendingFor(b.resource) : null;
            return (
              <div key={b.label}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)', gap: 'var(--space-6)' }}>
                  <span style={{ fontSize: 'var(--text-base)' }}>{b.label}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
                    <span className="num" style={{
                      fontSize: 'var(--text-sm)',
                      color: value === null ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                    }}>
                      {value === null ? '暂无采样' : b.fmt(value)} / {b.fmt(b.limit)}
                    </span>
                    {b.resource && (pending
                      ? <Badge tone="warning">申请审批中</Badge>
                      : <Button size="sm" variant="ghost" onClick={() => setAsking(b.resource)}>申请提额</Button>)}
                  </span>
                </div>
                <div style={{ height: 6, background: 'var(--surface-3)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
                  <div style={{
                    width: `${pct}%`, height: '100%', borderRadius: 'var(--radius-pill)',
                    background: pct > 85 ? 'var(--error)' : 'var(--accent)',
                    transition: 'width var(--duration-fast) ease',
                  }} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <Card>
          <strong style={{ fontSize: 'var(--text-base)' }}>{c('quota.webFree')}</strong>
          <p style={{ margin: 'var(--space-4) 0 0', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
            {c('quota.webFreeNote')}
          </p>
        </Card>
        <Card>
          <strong style={{ fontSize: 'var(--text-base)' }}>后端默认 {c('quota.backendCount')}</strong>
          <p style={{ margin: 'var(--space-4) 0 0', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
            单个 <span className="num">{limits.cpu}</span> vCPU / <span className="num">{limits.mem}</span> MB，由平台强制写入。
          </p>
        </Card>
        <Card>
          <strong style={{ fontSize: 'var(--text-base)' }}>{c('quota.idleArchive')}</strong>
          <p style={{ margin: 'var(--space-4) 0 0', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
            {c('quota.idleArchiveNote')}
          </p>
        </Card>
      </div>

      {requests.length > 0 && <MyRequests requests={requests} />}

      {asking && (
        <RequestDialog
          resource={asking}
          current={bars.find((b) => b.resource === asking)!}
          onClose={() => setAsking(null)}
          onDone={() => { setAsking(null); load(); }}
        />
      )}
    </>
  );
}

const RESOURCE_LABEL: Record<Resource, string> = {
  storage: '静态空间', backends: '后端应用', rows: '数据行数',
};

/** 我提过的申请。提交完看不到状态的话，人只会去问管理员"批了没"。 */
function MyRequests({ requests }: { requests: QuotaRequest[] }) {
  return (
    <Card style={{ marginTop: 'var(--space-8)' }}>
      <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-8)' }}>
        我的提额申请
      </strong>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {requests.map((r) => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', fontSize: 'var(--text-base)' }}>
            <Badge tone={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'neutral'}>
              {r.status === 'pending' ? '审批中' : r.status === 'approved' ? '已通过' : '已驳回'}
            </Badge>
            <span>{RESOURCE_LABEL[r.resource]}</span>
            <span className="num" style={{ color: 'var(--text-secondary)' }}>
              → {r.resource === 'storage' ? fmtBytes(Number(r.requested_limit)) : Number(r.requested_limit).toLocaleString()}
            </span>
            <span className="num" style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              {fmtDate(r.created_at)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RequestDialog({
  resource, current, onClose, onDone,
}: {
  resource: Resource;
  current: { limit: number; fmt: (n: number) => string };
  onClose: () => void;
  onDone: () => void;
}) {
  // 默认申请当前上限的两倍——大多数人想的就是"再给我一些"，
  // 给个合理起点比让他对着空框想数字要好。
  const [value, setValue] = useState(String(
    resource === 'storage' ? Math.round(current.limit * 2 / 1024 / 1024) : current.limit * 2,
  ));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const unit = resource === 'storage' ? 'MB' : resource === 'backends' ? '个' : '行';

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.requestQuota({
        resource,
        requestedLimit: resource === 'storage' ? Number(value) * 1024 * 1024 : Number(value),
        reason: reason.trim(),
      });
      onDone();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Dialog
      open
      title={`申请提高${RESOURCE_LABEL[resource]}上限`}
      description={`当前上限 ${current.fmt(current.limit)}。管理员会看到你的用途说明，据此判断。`}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" disabled={busy || !reason.trim() || !Number(value)}
            onClick={() => void submit()}>
            {busy ? '提交中…' : '提交申请'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--space-8)' }}>
        <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          希望提到（{unit}）
          <Input value={value} onChange={(e) => setValue(e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          用途说明
          <Input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="例如：周报助手要存历年归档，现有空间放不下" style={{ marginTop: 4 }} />
        </label>
      </div>
      {err && <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>{err}</p>}
    </Dialog>
  );
}
