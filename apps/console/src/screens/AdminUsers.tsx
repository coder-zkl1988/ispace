import { useEffect, useState } from 'react';
import {
  Avatar, Badge, Button, Card, copyText, fmtBytes, fmtDate, Input, PageTitle,
  StatCard, Toast, useConfirm,
} from '@ispace/ui';
import { api, type AdminUser, type OffboardRun } from '../api';

type Summary = { active: number; pending: number; cooling: number; nearLimit: number };

/** 设计稿管理员「员工与开通」屏。 */
export function AdminUsers() {
  const [confirmUI, ask] = useConfirm();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  /**
   * 操作结果。
   *
   * 原先渲染在「开通新员工」那张卡里，而多数按钮在下面的表格里——
   * 报错出现在你早已滚过去的地方，看起来就是"点了没反应"。
   * 现在走 fixed 定位的浮层，与滚动位置无关。
   */
  const [msg, setMsg] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const notify = (text: string) => setMsg({ text, tone: 'info' });
  const fail = (e: unknown) => setMsg({
    text: e instanceof Error ? e.message : String(e), tone: 'error',
  });
  const [resetLink, setResetLink] = useState<
    { user: string; url: string; expiresInHours: number; warning: string } | null
  >(null);
  const [steps, setSteps] = useState<
    { user: string; runId: string; steps: OffboardRun['steps']; status: string } | null
  >(null);
  const [form, setForm] = useState({ username: '', displayName: '', email: '' });
  const [busy, setBusy] = useState(false);

  const load = () => void api.adminUsers().then((r) => { setUsers(r.users); setSummary(r.summary); });
  useEffect(load, []);

  const provision = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.provision({
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
      });
      notify(`已开通 ${r.user.displayName}，数据 schema ${r.schemaName}`);
      setForm({ username: '', displayName: '', email: '' });
      load();
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  };

  const archive = async (u: AdminUser) => {
    // 归档不可逆地改变该员工的可用性，值得一次确认
    const ok = await ask({
      title: `离职回收 ${u.displayName}？`,
      description:
        '会依次执行四步：页面停用、后端停止、数据空间从接口摘除、空间路径冷冻 90 天。'
        + '四步都不删任何东西——产物、数据表、审计记录全部保留，随时可恢复。'
        + '冷冻期内这个空间标识不会被分配给新人，避免老链接指向别人的页面。',
      confirmLabel: '开始回收',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.adminArchive(u.id);
      // 逐步回报，而不是只说"成功了"——四步里任何一步都可能单独失败
      setSteps({ user: u.displayName, ...r });
      load();
    } catch (e) { fail(e); }
  };

  /** 生成一次性设密码链接。只显示一次，服务端只存哈希。 */
  const resetPw = async (u: AdminUser) => {
    const ok = await ask({
      title: `给 ${u.displayName} 发设密码链接？`,
      description:
        '生成一条 24 小时内有效、只能用一次的链接。平台没有邮件服务，'
        + '需要你当面或经可信渠道转交给本人。链接只显示这一次。',
      confirmLabel: '生成链接',
    });
    if (!ok) return;
    try { setResetLink({ user: u.displayName, ...(await api.resetPassword(u.id)) }); }
    catch (e) { fail(e); }
  };

  const changeRole = async (u: AdminUser) => {
    const toAdmin = u.role !== 'admin';
    const ok = await ask({
      title: toAdmin ? `设 ${u.displayName} 为管理员？` : `取消 ${u.displayName} 的管理员？`,
      description: toAdmin
        ? '管理员能看到全平台的用量、审计与令牌，能开通与回收账号、改平台设置。'
        : '之后他只能管理自己的空间。平台至少要保留一位管理员。',
      confirmLabel: toAdmin ? '设为管理员' : '取消管理员',
      danger: !toAdmin,
    });
    if (!ok) return;
    try {
      await api.setRole(u.id, toAdmin ? 'admin' : 'employee');
      notify(toAdmin ? `${u.displayName} 已设为管理员` : `已取消 ${u.displayName} 的管理员`);
      load();
    } catch (e) { fail(e); }
  };

  /** 撤销回收，把人放回来。冷冻期内最常用。 */
  const restore = async (u: AdminUser) => {
    const ok = await ask({
      title: `恢复 ${u.displayName}？`,
      description:
        '账号可再次登录、数据空间重新接入、已停用的页面恢复运行。'
        + '后端不自动重建——重建会立刻开始占资源，且人回来了未必还需要它，'
        + '由本人在控制台自己点。',
      confirmLabel: '恢复',
    });
    if (!ok) return;
    try {
      const r = await api.restoreUser(u.id);
      setSteps({ user: u.displayName, runId: '', ...r });
      load();
    } catch (e) { fail(e); }
  };

  /** 上次回收可能只走通一半（编排器抽风、磁盘满）。重跑是幂等的。 */
  const retry = async (u: AdminUser) => {
    try {
      const r = await api.offboardRetry(u.id);
      setSteps({ user: u.displayName, ...r });
      load();
    } catch (e) { fail(e); }
  };

  const approve = async (u: AdminUser) => {
    try { await api.approveUser(u.id); notify(`已开通 ${u.displayName}`); load(); }
    catch (e) { fail(e); }
  };

  return (
    <>
      <PageTitle title="员工与开通" subtitle="开通、角色、密码与离职回收" />

      {/* 一次性链接必须显眼且不自动消失：错过就得重新生成 */}
      {resetLink && (
        <Card style={{
          marginBottom: 'var(--space-8)',
          background: 'var(--warning-subtle)', border: '1px solid var(--warning)',
        }}>
          <strong style={{ fontSize: 'var(--text-base)', display: 'block', marginBottom: 'var(--space-5)' }}>
            给 {resetLink.user} 的设密码链接 —— 只显示这一次
          </strong>
          <div style={{ display: 'flex', gap: 'var(--space-5)', alignItems: 'center', marginBottom: 'var(--space-5)' }}>
            <code className="mono" style={{
              flex: 1, minWidth: 0, background: 'var(--surface-1)',
              padding: 'var(--space-5) var(--space-6)', borderRadius: 'var(--radius-8)',
              fontSize: 'var(--text-sm)', overflowX: 'auto', whiteSpace: 'nowrap',
            }}>{resetLink.url}</code>
            <Button size="sm" variant="primary" onClick={() => {
              // 这条链接只显示一次，复制失败必须让人知道，否则就丢了
              void copyText(resetLink.url).then((done) => {
                notify(done ? '链接已复制' : '复制不了，请手动选中上面的链接——它只显示这一次');
              });
            }}>复制</Button>
            <Button size="sm" variant="ghost" onClick={() => setResetLink(null)}>我已转交</Button>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            {resetLink.warning} {resetLink.expiresInHours} 小时后失效，用过一次即作废。
          </p>
        </Card>
      )}

      {/* 回收是多步操作，任何一步都可能单独失败——逐步回报，别只说"成功了" */}
      {steps && (
        <Card style={{ marginBottom: 'var(--space-8)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
            <strong style={{ fontSize: 'var(--text-base)' }}>{steps.user} 的回收结果</strong>
            <Badge tone={steps.status === 'done' ? 'success' : steps.status === 'partial' ? 'warning' : 'danger'} dot>
              {steps.status === 'done' ? '四步全部完成' : steps.status === 'partial' ? '部分完成' : '失败'}
            </Badge>
            <div style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" onClick={() => setSteps(null)}>知道了</Button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            {steps.steps.map((st) => (
              <div key={st.step} style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-6)' }}>
                <span style={{ width: 96, flex: 'none', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)' }}>
                  {STEP_LABEL[st.step]}
                </span>
                <Badge tone={st.ok ? 'success' : 'danger'} dot>{st.ok ? '完成' : '失败'}</Badge>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{st.note}</span>
              </div>
            ))}
          </div>
          {steps.status !== 'done' && (
            <p style={{ margin: 'var(--space-8) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              失败的步骤可以重跑——每一步都是「确保处于停用/冻结状态」，重复执行没有副作用。
            </p>
          )}
        </Card>
      )}

      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 'var(--space-8)' }}>
        <StatCard label="已开通" value={String(summary?.active ?? 0)} />
        <StatCard label="待激活" value={String(summary?.pending ?? 0)} />
        <StatCard label="冷冻期" value={String(summary?.cooling ?? 0)} />
        <StatCard label="接近配额上限" value={String(summary?.nearLimit ?? 0)} />
      </div>

      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-8)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>开通新员工</strong>
          {/* 导出走浏览器下载：响应是 CSV 附件，不能 fetch 后再解析 */}
          <Button size="sm" onClick={() => { location.href = api.exportUsersUrl(); }}>导出名单</Button>
        </div>
        <div style={{ display: 'grid', gap: 'var(--space-6)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr)) auto', alignItems: 'end' }}>
          <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            空间标识
            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="lixiao" style={{ marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            姓名
            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              placeholder="李骁" style={{ marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            邮箱（可选）
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="lixiao@example.com" style={{ marginTop: 4 }} />
          </label>
          <Button variant="primary" disabled={busy || !form.username.trim() || !form.displayName.trim()}
            onClick={() => void provision()}>开通</Button>
        </div>
        <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          空间标识会成为对外地址的一部分（{location.host}/<b>标识</b>/），且不能与平台保留路径冲突。开通后建目录、建数据 schema、初始化配额一次完成。
        </p>
      </Card>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                {['员工', '空间地址', '角色', '身份', '页面', '后端', '占用', '状态', '操作'].map((h) => (
                  <th key={h} style={{
                    padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)',
                    fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                    letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--border-subtle)', opacity: u.status === 'active' ? 1 : 0.5 }}>
                  {/* 这一行里除了地址，其余都是两三个字的短标签。九列挤在一起时
                      不锁住它们，中文会被压成一列一个字——「使用者」竖排成三行。
                      挤不下由外层横向滚动解决，不靠压扁单元格。 */}
                  <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
                      <Avatar name={u.displayName} size={24} />{u.displayName}
                    </div>
                  </td>
                  <td className="mono" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                    {location.host}/{u.username}/
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                    {u.role === 'admin' ? <Badge tone="brand">管理员</Badge> : <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>员工</span>}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                    {u.identity === 'developer' ? '开发者' : '使用者'}
                  </td>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)' }}>{u.appCount}</td>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)' }}>
                    {u.backendCount ?? 0}
                  </td>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}
                      title={`开通于 ${fmtDate(u.createdAt)}`}>
                    {fmtBytes(u.storageUsed)}
                    {u.storageLimit > 0 && (
                      <span style={{ color: 'var(--text-tertiary)' }}> / {fmtBytes(u.storageLimit)}</span>
                    )}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}><StatusBadge u={u} /></td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                    {u.status === 'pending' && (
                      <Button size="sm" variant="primary" onClick={() => void approve(u)}>开通</Button>
                    )}
                    {u.status === 'active' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => void resetPw(u)}>发设密码链接</Button>
                        <Button size="sm" variant="ghost" onClick={() => void changeRole(u)}>
                          {u.role === 'admin' ? '取消管理员' : '设为管理员'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void archive(u)}>离职回收</Button>
                      </>
                    )}
                    {u.status === 'archived' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => void restore(u)}>恢复</Button>
                        <Button size="sm" variant="ghost" onClick={() => void retry(u)}>重跑回收</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {msg && <Toast message={msg.text} tone={msg.tone} onClose={() => setMsg(null)} />}
      {confirmUI}
    </>
  );
}

/**
 * 状态标签。冷冻期与已归档要分开——冷冻期内可一键恢复，
 * 过了才进入可清理状态，两者对管理员意味着完全不同的动作。
 */
function StatusBadge({ u }: { u: AdminUser }) {
  if (u.status === 'pending') return <Badge tone="warning">待激活</Badge>;
  if (u.status === 'active') return <Badge tone="success">正常</Badge>;

  const archivedAt = u.archivedAt ? new Date(u.archivedAt).getTime() : 0;
  const days = archivedAt ? Math.floor((Date.now() - archivedAt) / 86400_000) : 999;
  return days < 30
    ? <Badge tone="neutral">冷冻期 · 剩 {30 - days} 天</Badge>
    : <Badge tone="neutral">已归档</Badge>;
}

/** 四步的中文名。与 services/offboard.ts 的 OffboardStep 一一对应。 */
const STEP_LABEL: Record<OffboardRun['steps'][number]['step'], string> = {
  apps: '页面停用',
  backends: '后端停止',
  data: '数据空间冻结',
  path: '路径冷冻',
};
