import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, Greeting, PageTitle, StatCard,
  copyText, fmtBytes, fmtDate, useCopy,
} from '@ispace/ui';
import type { Release } from '@ispace/contracts';
import { api, type Me } from '../api';

/** 设计稿「空间总览」屏。 */
export function SpaceOverview({ me }: { me: Me }) {
  const c = useCopy();
  const [apps, setApps] = useState(0);
  const [recent, setRecent] = useState<(Release & { appName: string })[]>([]);
  const [monthly, setMonthly] = useState<{ count: number; delta: number } | null>(null);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const spacePath = `${location.host}/${me.user.username}`;

  useEffect(() => {
    void api.overview()
      .then((r) => setMonthly({ count: r.publishedThisMonth, delta: r.deltaVsLastMonth }))
      .catch(() => setMonthly(null));
  }, []);

  useEffect(() => {
    void (async () => {
      const a = await api.apps();
      setApps(a.apps.length);
      // 最近发布：取每个应用的最新版本再按时间排。应用数不多，
      // 逐个查比加一个聚合端点更简单，且这一屏本就不是热路径。
      const lists = await Promise.all(
        a.apps.slice(0, 8).map(async (app) => {
          const r = await api.releases(app.slug).catch(() => ({ releases: [] as Release[] }));
          return r.releases.slice(0, 2).map((x) => ({ ...x, appName: app.name }));
        }),
      );
      setRecent(
        lists.flat()
          .sort((x, y) => (x.publishedAt > y.publishedAt ? -1 : 1))
          .slice(0, 6),
      );
    })();
  }, []);

  const q = me.quota;

  return (
    <>
      <PageTitle title={c('space.title')} subtitle={c('space.subtitle')} />

      <Card style={{ marginBottom: 'var(--space-10)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-10)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Greeting>Happy Working</Greeting>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', margin: 'var(--space-2) 0 var(--space-4)' }}>
              <span className="mono" style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)' }}>
                {spacePath}
              </span>
              <Badge tone="success">{c('space.provisioned')}</Badge>
            </div>
            <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
              {c('space.hint')}：
              <span className="mono" style={{ marginLeft: 4 }}>{spacePath}/zhoubao</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-5)', flex: 'none' }}>
            <Button size="sm" onClick={() => {
              // 不用 alert：它会阻塞线程，而这条路径正是浏览器不给用
              // 剪贴板时才走到的，堵死页面只会更糟
              void copyText(`http://${spacePath}`).then((done) => {
                setCopied(done ? 'ok' : 'fail');
                setTimeout(() => setCopied(null), done ? 1600 : 2600);
              });
            }}>
              {copied === 'ok' ? '已复制'
                : copied === 'fail' ? '复制不了，手动选中'
                : c('action.copyAddress')}
            </Button>
            <a href={`/${me.user.username}/`} style={{ textDecoration: 'none' }}>
              <Button size="sm">{c('action.visit')}</Button>
            </a>
          </div>
        </div>
      </Card>

      <div style={{
        display: 'grid', gap: 'var(--space-8)', marginBottom: 'var(--space-10)',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      }}>
        <StatCard label={c('space.publishedPages')} value={String(apps)} />
        {/*
          本月发布的环比是「与上月同期」之差，不是与上月全月之差——
          月初跟上月全月比永远是大跌，那个数字没有意义。差为 0 时不显示：
          「+0」是噪声。数据没取到时显示 —，不显示 0（会被读成"一个都没发"）。
        */}
        <StatCard
          label="本月发布"
          value={monthly ? String(monthly.count) : '—'}
          {...(monthly && monthly.delta !== 0
            ? { delta: monthly.delta > 0 ? `+${monthly.delta}` : String(monthly.delta) }
            : {})}
        />
        <StatCard label={c('space.backends')} value={`${q.backendCountUsed}`} unit={`/ ${q.backendCountLimit}`} />
        <StatCard label={c('space.usage')} value={fmtBytes(q.storageBytesUsed)} unit={`/ ${fmtBytes(q.storageBytesLimit)}`} />
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)' }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 'var(--space-8)' }}>
            <strong style={{ fontSize: 'var(--text-md)' }}>{c('oneline.title')}</strong>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{c('oneline.hint')}</span>
          </div>
          <div className="mono" style={{
            background: 'var(--accent)', color: 'var(--accent-fg)',
            borderRadius: 'var(--radius-12)', padding: 'var(--space-8) var(--space-10)',
            fontSize: 'var(--text-sm)', lineHeight: 1.8,
          }}>
            <div style={{ color: 'rgba(255,255,255,.5)' }}>你 →</div>
            <div>把这个项目部署到我的空间，路径 /zhoubao</div>
            <div style={{ color: 'rgba(255,255,255,.5)', marginTop: 8 }}>Codex →</div>
            <div style={{ color: 'var(--tabby-orange)' }}>
              ai-deploy.deploy <span style={{ color: '#fff' }}>{'{ site: "zhoubao", zip: "dist.zip" }'}</span>
            </div>
          </div>
          <p style={{ margin: 'var(--space-8) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            {c('oneline.scanNote')}
          </p>
        </Card>

        <Card>
          <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-8)' }}>
            最近发布
          </strong>
          {recent.length === 0 ? (
            <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-base)', margin: 0 }}>
              还没有发布记录
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              {recent.map((r) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', fontSize: 'var(--text-base)' }}>
                  <span className="num" style={{ color: 'var(--tabby-orange-hover)', fontWeight: 'var(--weight-medium)', width: 40 }}>
                    v{r.version}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.appName}
                  </span>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                    {c(`source.${r.source}` as 'source.mcp')}
                  </span>
                  <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                    {fmtDate(r.publishedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
