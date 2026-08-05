import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, Dialog, Input, PageTitle, StatCard, fmtBytes, fmtDate,
} from '@ispace/ui';
import { api, toSettings, type AdminUser, type PlatformPolicy, type QuotaRequest } from '../api';

/** 设计稿管理员「资源与配额」屏。 */
export function AdminResources() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [policy, setPolicy] = useState<PlatformPolicy | null>(null);
  const [requests, setRequests] = useState<QuotaRequest[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = () => {
    setLoadErr(null);
    void api.adminUsers().then((r) => setUsers(r.users.filter((u) => u.status === 'active')))
      .catch((e: Error) => setLoadErr(e.message));
    void api.adminPolicy().then((r) => setPolicy(r.policy))
      .catch((e: Error) => setLoadErr(e.message));
    // requests 为 null 表示"还没加载上"，空数组才是"确实没有"。
    // 混为一谈的话，接口挂了会显示成"还没有人提过申请"——把故障说成了正常。
    void api.adminQuotaRequests().then((r) => setRequests(r.requests))
      .catch((e: Error) => { setRequests([]); setLoadErr(e.message); });
  };
  useEffect(load, []);

  const pending = (requests ?? []).filter((r) => r.status === 'pending');

  const totalUsed = users.reduce((s, u) => s + u.storageUsed, 0);
  const totalLimit = users.reduce((s, u) => s + u.storageLimit, 0);
  const nearLimit = users.filter((u) => u.storageLimit > 0 && u.storageUsed / u.storageLimit > 0.85);

  return (
    <>
      <PageTitle title="资源与配额" subtitle="全平台用量分布与默认限额" />

      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 'var(--space-10)' }}>
        <StatCard label="已分配空间" value={fmtBytes(totalLimit)} />
        <StatCard label="实际占用" value={fmtBytes(totalUsed)} />
        <StatCard label="接近上限的员工" value={String(nearLimit.length)} />
        <StatCard label="待处理申请" value={String(pending.length)} />
      </div>

      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-8)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>默认配额策略</strong>
          <Button size="sm" disabled={!policy} onClick={() => setEditing(true)}>编辑策略</Button>
        </div>
        <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {[
            [`${policy?.backend_cpu_limit ?? '—'} vCPU`, '单个后端 CPU 上限'],
            [policy ? fmtBytes(Number(policy.backend_memory_bytes)) : '—', '单个后端内存上限'],
            [`${policy?.backend_count_limit ?? '—'} 个`, '每人后端数量上限'],
            [policy ? fmtBytes(Number(policy.storage_bytes_limit)) : '—', '每人静态空间上限'],
          ].map(([v, k]) => (
            <div key={k}>
              <div className="num" style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-bold)' }}>{v}</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{k}</div>
            </div>
          ))}
        </div>
        <p style={{ margin: 'var(--space-8) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          限额由部署服务在创建应用时强制写入，员工无法自行修改；单机没有强隔离，限额是唯一的资源兜底。
        </p>
      </Card>

      <QuotaRequests requests={requests} loadErr={loadErr} onChanged={load} />

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                {['员工', '占用', '配额', '使用率'].map((h) => (
                  <th key={h} style={{
                    padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)',
                    fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                    letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const pct = u.storageLimit > 0 ? (u.storageUsed / u.storageLimit) * 100 : 0;
                return (
                  <tr key={u.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>{u.displayName}</td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>{fmtBytes(u.storageUsed)}</td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{fmtBytes(u.storageLimit)}</td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', width: 220 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
                        <div style={{ flex: 1, height: 4, background: 'var(--surface-3)', borderRadius: 'var(--radius-pill)' }}>
                          <div style={{
                            width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: 'var(--radius-pill)',
                            background: pct > 85 ? 'var(--error)' : 'var(--accent)',
                          }} />
                        </div>
                        <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', width: 38, textAlign: 'right' }}>
                          {pct.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {policy && (
        <PolicyEditor
          open={editing}
          policy={policy}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
        />
      )}
    </>
  );
}

/** 资源名 → 人话。三处地方要用，抽出来避免各写各的。 */
const RESOURCE_LABEL: Record<QuotaRequest['resource'], string> = {
  storage: '静态空间',
  backends: '后端应用',
  rows: '数据行数',
};

/** 按资源类型格式化数值。字节要人话，个数与行数不该被格式化成 "2 B"。 */
function fmtByResource(resource: QuotaRequest['resource'], v: number): string {
  return resource === 'storage' ? fmtBytes(v)
    : resource === 'backends' ? `${v} 个`
    : v.toLocaleString();
}

/**
 * 超限与提额申请（设计稿「资源与配额」下半）。
 *
 * 批准即写回该员工的配额——审批完还要管理员再去别处改一次数字的话，
 * 这个流程等于没做，而"批了但没生效"是最糟的状态。
 */
function QuotaRequests({
  requests, loadErr, onChanged,
}: { requests: QuotaRequest[] | null; loadErr: string | null; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // requests 为 null 表示"还没加载上"，空数组才是"确实没有"
  const list = requests ?? [];
  const pending = list.filter((r) => r.status === 'pending');
  const decided = list.filter((r) => r.status !== 'pending').slice(0, 8);

  const decide = async (id: string, approve: boolean) => {
    setBusy(id); setErr(null);
    try { await api.decideQuotaRequest(id, approve); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <Card style={{ marginBottom: 'var(--space-8)', padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', padding: 'var(--space-10) var(--space-10) var(--space-8)' }}>
        <strong style={{ fontSize: 'var(--text-md)' }}>超限与提额申请</strong>
        {pending.length > 0 && <Badge tone="warning">{pending.length} 条待处理</Badge>}
      </div>

      {err && (
        <p style={{ margin: '0 var(--space-10) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>{err}</p>
      )}

      {requests === null ? (
        <p style={{ margin: '0 var(--space-10) var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          载入中…
        </p>
      ) : loadErr ? (
        <p style={{ margin: '0 var(--space-10) var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
          没能取到申请列表：{loadErr}
        </p>
      ) : list.length === 0 ? (
        <p style={{ margin: '0 var(--space-10) var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          还没有人提过申请。员工在「配额与用量」里点「申请提额」即可提交。
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                {['员工', '项目', '当前', '申请', '理由', '提交时间', '操作'].map((h) => (
                  <th key={h} style={{
                    padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-2xs)',
                    fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                    letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...pending, ...decided].map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border-subtle)', opacity: r.status === 'pending' ? 1 : 0.55 }}>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>{r.display_name ?? r.username}</td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>{RESOURCE_LABEL[r.resource]}</td>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                    {fmtByResource(r.resource, Number(r.current_used))}
                    <span style={{ color: 'var(--text-tertiary)' }}> / {fmtByResource(r.resource, Number(r.current_limit))}</span>
                  </td>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', whiteSpace: 'nowrap' }}>
                    {fmtByResource(r.resource, Number(r.requested_limit))}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', maxWidth: 240 }}>
                    {r.reason}
                  </td>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                    {fmtDate(r.created_at)}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                    {r.status === 'pending' ? (
                      <>
                        <Button size="sm" variant="primary" disabled={busy === r.id}
                          onClick={() => void decide(r.id, true)}>通过</Button>
                        <Button size="sm" variant="ghost" disabled={busy === r.id}
                          onClick={() => void decide(r.id, false)}>驳回</Button>
                      </>
                    ) : (
                      <Badge tone={r.status === 'approved' ? 'success' : 'neutral'}>
                        {r.status === 'approved' ? '已通过' : '已驳回'}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * 编辑默认策略。
 *
 * 只影响之后新建的后端——已经跑着的容器不会被追改，那需要逐个重建，
 * 风险远大于收益。对话框里明说这一点，免得管理员以为改完全网就生效了。
 */
function PolicyEditor({
  open, policy, onClose, onSaved,
}: { open: boolean; policy: PlatformPolicy; onClose: () => void; onSaved: () => void }) {
  const [cpu, setCpu] = useState(policy.backend_cpu_limit);
  const [memMb, setMemMb] = useState(String(Math.round(Number(policy.backend_memory_bytes) / 1024 / 1024)));
  const [count, setCount] = useState(String(policy.backend_count_limit));
  const [storageMb, setStorageMb] = useState(String(Math.round(Number(policy.storage_bytes_limit) / 1024 / 1024)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      // 先读全量再改这四项：PUT 是整体替换，只提交自己这几个字段
      // 会把「平台设置」里配的注册策略一起冲掉
      await api.saveAdminPolicy({
        ...toSettings(policy),
        backendCpuLimit: cpu.trim(),
        backendMemoryBytes: Number(memMb) * 1024 * 1024,
        backendCountLimit: Number(count),
        storageBytesLimit: Number(storageMb) * 1024 * 1024,
      });
      onSaved();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const field = (label: string, value: string, set: (v: string) => void, hint: string) => (
    <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', display: 'block' }}>
      {label}
      <Input value={value} onChange={(e) => set(e.target.value)} style={{ marginTop: 4 }} />
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{hint}</span>
    </label>
  );

  return (
    <Dialog
      open={open}
      title="编辑默认配额策略"
      description="改的是新建时写入的默认值，已运行的后端容器不受影响。"
      onClose={busy ? undefined : onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--space-8)' }}>
        {field('单个后端 CPU 上限', cpu, setCpu, '形如 0.5 或 1，单位 vCPU')}
        {field('单个后端内存上限（MB）', memMb, setMemMb, '64 – 8192')}
        {field('每人后端数量上限', count, setCount, '0 表示不允许自建后端')}
        {field('每人静态空间上限（MB）', storageMb, setStorageMb, '10 – 51200')}
      </div>
      {err && <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>{err}</p>}
    </Dialog>
  );
}
