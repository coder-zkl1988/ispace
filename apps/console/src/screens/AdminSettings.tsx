import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, Input, PageTitle, SectionLabel, Switch, fmtBytes, fmtDate,
} from '@ispace/ui';
import { api, toSettings, type PlatformPolicy, type PlatformSettings } from '../api';

/**
 * 平台设置。
 *
 * 这一屏收的是原本写死在代码里的参数：邮箱后缀在环境变量、密码下限在
 * packages/auth 的常量、闲置归档天数在 packages/contracts 的常量。
 * 改任何一个都要发版或重启服务——对一个内部平台来说，
 * 「把闲置归档从 90 天调成 120 天」不该是一次上线。
 *
 * 设计稿没有这一屏（它只画了资源配额那半张）。加它是因为上面那些参数
 * 确实需要有人调，而"改代码"不是一种管理手段。
 */
export function AdminSettings() {
  const [form, setForm] = useState<PlatformSettings | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    void api.adminPolicy()
      .then((r: { policy: PlatformPolicy | null }) => {
        if (!r.policy) { setErr('读不到平台策略，迁移可能还没跑完'); return; }
        setForm(toSettings(r.policy));
        setUpdatedAt(r.policy.updated_at);
      })
      .catch((e: Error) => setErr(e.message));
  };
  useEffect(load, []);

  if (err) return (<><PageTitle title="平台设置" /><Card style={{ color: 'var(--error)' }}>{err}</Card></>);
  if (!form) return <PageTitle title="平台设置" subtitle="载入中…" />;

  const set = <K extends keyof PlatformSettings>(k: K, v: PlatformSettings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    setBusy(true); setMsg(null); setNotes([]);
    try {
      const r = await api.saveAdminPolicy(form);
      setMsg('已保存');
      setNotes(r.notes ?? []);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <PageTitle
        title="平台设置"
        subtitle="这些值原本写死在代码里，改一次要发一次版。现在改完立刻生效。"
      />

      {/* ── 账号准入 ─────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <SectionLabel>账号准入</SectionLabel>
        <div style={{ marginTop: 'var(--space-8)', display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
          <Row
            label="允许自助注册"
            hint="关掉之后只能由管理员在「员工与开通」里逐个开通。"
          >
            <Switch
              checked={form.selfRegisterEnabled}
              onChange={(v) => {
                set('selfRegisterEnabled', v);
                // 关掉自助注册时「需审批」就没有意义了，顺手关掉——
                // 否则保存时会被服务端以自相矛盾为由挡回来
                if (!v) set('requireApproval', false);
              }}
            />
          </Row>

          <Row
            label="注册需管理员批准"
            hint="打开后新注册的人落在「待开通」，空间要等你通过才创建。"
          >
            <Switch
              checked={form.requireApproval}
              onChange={(v) => set('requireApproval', v)}
              disabled={!form.selfRegisterEnabled}
            />
          </Row>

          <Row
            label="可注册的邮箱后缀"
            hint="逗号分隔。留空表示不限后缀——内网平台仍需要有人给链接才进得来，但别人一旦访问到就能开空间。"
          >
            <Input
              value={form.emailDomains}
              onChange={(e) => set('emailDomains', e.target.value)}
              placeholder="example.com, corp.example.com"
              style={{ width: 280 }}
            />
          </Row>

          <Row label="密码最少几位" hint="长度比大小写数字混搭更管用，所以只限长度。">
            <NumInput value={form.passwordMinLength} min={8} max={64}
              onChange={(n) => set('passwordMinLength', n)} unit="位" />
          </Row>

          <Row label="登录有效期" hint="已经登录的人不受影响——过期时间在登录那一刻就定死了。">
            <NumInput value={form.sessionDays} min={1} max={365}
              onChange={(n) => set('sessionDays', n)} unit="天" />
          </Row>
        </div>
      </Card>

      {/* ── 生命周期 ─────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <SectionLabel>生命周期</SectionLabel>
        <div style={{ marginTop: 'var(--space-8)', display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
          <Row label="闲置多久后归档页面" hint="到期前还有 7 天缓冲，归档只是停用，产物保留可恢复。">
            <NumInput value={form.idleArchiveDays} min={7} max={3650}
              onChange={(n) => set('idleArchiveDays', n)} unit="天" />
          </Row>
          <Row label="审计日志保留" hint="超期的记录会被定时任务删掉，删了就找不回来了。">
            <NumInput value={form.auditRetentionMonths} min={1} max={120}
              onChange={(n) => set('auditRetentionMonths', n)} unit="个月" />
          </Row>
          <Row
            label="访问令牌有效期上限"
            hint="填 0 表示不限期（当前行为）。设了之后只影响新建的令牌，已发出去的不会被追改。"
          >
            <NumInput value={form.tokenMaxDays} min={0} max={3650}
              onChange={(n) => set('tokenMaxDays', n)} unit="天" />
          </Row>
        </div>
      </Card>

      {/* ── 共享范围 ─────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <SectionLabel>共享范围</SectionLabel>
        <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          关掉之后不会自动下架已有内容——那属于内容决定，该在创意市场里逐个处理，
          而不是改个开关就静默清空别人的东西。
        </p>
        <div style={{ marginTop: 'var(--space-8)', display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
          <Row label="允许「全公司」" hint="页面会出现在创意市场，同事自助添加即用。">
            <Switch checked={form.allowPublicShare} onChange={(v) => set('allowPublicShare', v)} />
          </Row>
          <Row label="允许分享给指定同事" hint="对方主页会收到接受 / 拒绝的入口卡。">
            <Switch checked={form.allowPeerShare} onChange={(v) => set('allowPeerShare', v)} />
          </Row>
        </div>
      </Card>

      {/* ── 资源默认值（只读，在「资源与配额」里改）───────────────── */}
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <SectionLabel>新空间的默认配额</SectionLabel>
        <p style={{ margin: 'var(--space-6) 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          在「资源与配额」屏编辑。放在这里只是让你一眼看全平台的默认值。
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
          {[
            ['后端 CPU', `${form.backendCpuLimit} vCPU`],
            ['后端内存', fmtBytes(form.backendMemoryBytes)],
            ['后端个数', `${form.backendCountLimit} 个`],
            ['静态空间', fmtBytes(form.storageBytesLimit)],
          ].map(([k, v]) => (
            <span key={k} style={{
              display: 'inline-flex', alignItems: 'center', gap: 'var(--space-4)',
              padding: '4px var(--space-6)', background: 'var(--surface-2)',
              borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-sm)',
            }}>
              <span style={{ color: 'var(--text-tertiary)' }}>{k}</span>
              <span className="num">{v}</span>
            </span>
          ))}
        </div>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)', flexWrap: 'wrap' }}>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存设置'}
        </Button>
        {msg && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{msg}</span>}
        {updatedAt && (
          <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            上次修改 {fmtDate(updatedAt)}
          </span>
        )}
      </div>

      {/* 生效时机各项不同，保存后逐条说清——不说的话管理员会以为
          改完全平台立刻就变了 */}
      {notes.length > 0 && (
        <Card style={{ marginTop: 'var(--space-8)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', marginBottom: 'var(--space-6)' }}>
            <strong style={{ fontSize: 'var(--text-base)' }}>什么时候生效</strong>
            <Badge tone="neutral">读一下</Badge>
          </div>
          <ul style={{ margin: 0, paddingLeft: 'var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.9 }}>
            {notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </Card>
      )}
    </>
  );
}

function Row({
  label, hint, children,
}: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-10)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-medium)' }}>{label}</div>
        <p style={{ margin: 'var(--space-3) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
          {hint}
        </p>
      </div>
      <div style={{ flex: 'none', paddingTop: 2 }}>{children}</div>
    </div>
  );
}

/**
 * 数字输入。
 *
 * 不在每次按键时就把值夹到范围内——那会让人删掉内容重打时，
 * 输入框自动跳成最小值（想输 100 先删成空，立刻变成 8，再打就成了 8100）。
 * 只在失焦时归位。
 */
function NumInput({
  value, min, max, unit, onChange,
}: { value: number; min: number; max: number; unit: string; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-5)' }}>
      <Input
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={() => {
          const n = Math.max(min, Math.min(max, Number(text) || min));
          setText(String(n));
          onChange(n);
        }}
        style={{ width: 96, textAlign: 'right' }}
      />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{unit}</span>
    </span>
  );
}
