import { useEffect, useState } from 'react';
import { Card, PageTitle, StatCard, fmtBytes, useCopy } from '@ispace/ui';
import { api, type AdminOverview, type HostLoad } from '../api';

/** 设计稿管理员「平台总览」屏。 */
export function AdminOverviewScreen() {
  const c = useCopy();
  const [d, setD] = useState<AdminOverview | null>(null);
  useEffect(() => { void api.adminOverview().then(setD).catch(() => setD(null)); }, []);
  if (!d) return <PageTitle title={c('admin.title')} subtitle={c('admin.subtitle')} />;

  const maxCount = Math.max(1, ...d.deployTrend.map((t) => t.count));
  const maxBytes = Math.max(1, ...d.topSpaces.map((s) => s.bytes));

  return (
    <>
      <PageTitle title={c('admin.title')} subtitle={c('admin.subtitle')} />
      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 'var(--space-10)' }}>
        <StatCard label={c('admin.users')} value={String(d.userCount)} delta={d.userCountDelta ? `+${d.userCountDelta}` : undefined} />
        <StatCard label={c('admin.onlineApps')} value={String(d.appCount)} />
        <StatCard label={c('space.backends')} value={String(d.backendCount)} />
        <StatCard
          label={c('admin.weeklyDeploys')}
          value={String(d.weeklyDeployCount)}
          delta={d.weeklyDeployDeltaPercent ? `${d.weeklyDeployDeltaPercent > 0 ? '+' : ''}${d.weeklyDeployDeltaPercent}%` : undefined}
        />
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)' }}>
        <Card>
          <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-8)' }}>
            发布趋势（近 14 天）
          </strong>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 96 }}>
            {d.deployTrend.map((t) => (
              <div key={t.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }} title={`${t.date}: ${t.count}`}>
                <div style={{
                  width: '100%', height: `${(t.count / maxCount) * 76}px`, minHeight: t.count ? 3 : 1,
                  background: t.count ? 'var(--accent)' : 'var(--surface-3)',
                  borderRadius: 'var(--radius-4)',
                }} />
              </div>
            ))}
          </div>
          <div className="num" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-4)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            <span>{d.deployTrend[0]?.date}</span>
            <span>{d.deployTrend[d.deployTrend.length - 1]?.date}</span>
          </div>
        </Card>

        <Card>
          <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-8)' }}>
            占用最多的员工空间
          </strong>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {d.topSpaces.map((s) => (
              <div key={s.username}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-base)', marginBottom: 3 }}>
                  <span>{s.displayName}</span>
                  <span className="num" style={{ color: 'var(--text-secondary)' }}>{fmtBytes(s.bytes)}</span>
                </div>
                <div style={{ height: 4, background: 'var(--surface-3)', borderRadius: 'var(--radius-pill)' }}>
                  <div style={{ width: `${(s.bytes / maxBytes) * 100}%`, height: '100%', background: 'var(--tabby-orange)', borderRadius: 'var(--radius-pill)' }} />
                </div>
              </div>
            ))}
            {d.topSpaces.length === 0 && <span style={{ color: 'var(--text-tertiary)' }}>暂无数据</span>}
          </div>
        </Card>
      </div>

      <HostLoadCard />
    </>
  );
}

/**
 * 单机负载（设计稿「平台总览」右下）。
 *
 * 全平台跑在一台机器上，没有强隔离——所以这三条是"还能不能再收人"的
 * 唯一依据。设计稿在这里配了一句话：内存到 85% 前加第二台机器纳管。
 */
function HostLoadCard() {
  const [h, setH] = useState<HostLoad | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    const load = () => void api.adminHost().then(setH).catch(() => setErr(true));
    load();
    // 30 秒刷一次。这一屏是给管理员盯着看的，静态数字没有意义。
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Card style={{ marginTop: 'var(--space-8)' }}>
      <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-8)' }}>
        单机负载
      </strong>
      {err && <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>读不到宿主指标</span>}
      {!err && !h && <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>采样中…</span>}
      {h && (
        <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <LoadBar label={`CPU（${h.cpu.cores} 核）`} percent={h.cpu.percent} />
          <LoadBar label={`内存 ${fmtBytes(h.memory.used)} / ${fmtBytes(h.memory.total)}`} percent={h.memory.percent} />
          <LoadBar
            label={h.disk.total ? `磁盘 /srv ${fmtBytes(h.disk.used)} / ${fmtBytes(h.disk.total)}` : '磁盘 /srv'}
            percent={h.disk.percent}
            unavailable={h.disk.total === 0}
          />
        </div>
      )}
      <p style={{ margin: 'var(--space-8) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        内存到 85% 前加第二台机器纳管，架构不变。
      </p>
    </Card>
  );
}

function LoadBar({ label, percent, unavailable }: { label: string; percent: number; unavailable?: boolean }) {
  // 85% 是设计稿点名的加机器阈值，70% 起提前变黄，别等红了才发现
  const color = percent >= 85 ? 'var(--danger)' : percent >= 70 ? 'var(--warning)' : 'var(--success)';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{label}</span>
        <span className="num" style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>
          {unavailable ? '—' : `${percent}%`}
        </span>
      </div>
      <div style={{ height: 4, background: 'var(--surface-3)', borderRadius: 'var(--radius-pill)' }}>
        <div style={{
          width: unavailable ? 0 : `${Math.min(100, percent)}%`, height: '100%',
          background: color, borderRadius: 'var(--radius-pill)',
          transition: 'width var(--duration-fast) ease',
        }} />
      </div>
    </div>
  );
}
