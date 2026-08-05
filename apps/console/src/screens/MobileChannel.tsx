import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, PageTitle, StatCard, Switch, Tabs, fmtDate, useCopy,
} from '@ispace/ui';
import { api, type DeviceStats, type MobileChannelInfo, type MobileRelease } from '../api';

/**
 * 设计稿「更新通道」屏。
 *
 * 「发布即移动指针、回滚即指回旧版本，秒级生效」——指针就是
 * mobile_channels.current_release_id。放量三档（10/50/100）对应设计稿。
 *
 * 灰度按设备维度：未被放量的设备完全无感（服务端返回 204），
 * 不会看到更新提示。
 */
export function MobileChannel() {
  const c = useCopy();
  const [info, setInfo] = useState<MobileChannelInfo | null>(null);
  const [stats, setStats] = useState<DeviceStats | null>(null);
  const [autoFull, setAutoFull] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    void api.mobileChannel().then(setInfo).catch((e: Error) => setMsg(e.message));
    // 设备统计单独取：它是另一张表，且取不到不该让整屏打不开
    void api.deviceStats().then(setStats).catch(() => setStats(null));
  };
  useEffect(load, []);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(ok); load(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!info) return <PageTitle title={c('mobile.title')} subtitle={c('mobile.subtitle')} />;

  const current = info.channel;
  const releases = info.releases;

  return (
    <>
      <PageTitle title={c('mobile.title')} subtitle={c('mobile.subtitle')} />

      {msg && <Card style={{ marginBottom: 'var(--space-8)', fontSize: 'var(--text-base)' }}>{msg}</Card>}

      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-5)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>我的手机应用</strong>
          {current?.bundle_version
            ? <Badge tone="success">已到端</Badge>
            : <Badge tone="neutral">尚未发布</Badge>}
          <div style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            {info.channelName}
          </span>
        </div>
        <p style={{ margin: '0 0 var(--space-6)', color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
          同事装的是同一个 App，登录后加载到的是你这套页面。发新版本不用重装。
          预览通道 <span className="mono">{info.previewChannelName}</span> 只影响你自己的设备。
        </p>
        <div className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-2)' }}>
          channel {info.channelName} · runtimeVersion {current?.runtime_version ?? '—'}
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          登录后仅改写请求头切换通道，更新地址构建期固化
        </div>

        {/* ── 放量（设计稿：Tabs + 自动放量开关，都在这张卡里）───────── */}
        {current && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-8)',
            marginTop: 'var(--space-10)', paddingTop: 'var(--space-8)',
            borderTop: '1px solid var(--border-subtle)', flexWrap: 'wrap',
          }}>
            <span style={{
              fontSize: 'var(--text-2xs)', fontWeight: 'var(--weight-semibold)',
              letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
            }}>
              放量
            </span>
            <Tabs
              value={String(current.rollout_percent) as '10' | '50' | '100'}
              onChange={(v) => {
                const id = current.current_release_id;
                if (!id) return;
                void act(() => api.setRollout(id, Number(v)), `放量已调至 ${v}%`);
              }}
              items={[
                { value: '10' as const, label: '10%' },
                { value: '50' as const, label: '50%' },
                { value: '100' as const, label: '100%' },
              ]}
            />
            <div style={{ flex: 1 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              无异常自动放到 100%
              <Switch checked={autoFull} onChange={setAutoFull} />
            </label>
          </div>
        )}
        {/*
          自动放量目前只记住这个开关，还没有后台任务照着它自动提放量——
          那需要一个"什么算异常"的判定（加载失败率？崩溃率？观察多久？），
          而现在设备遥测才刚开始有数，定不出阈值。开关先给出来是因为
          设计稿有它，且状态本身有意义；不写清楚会让人以为已经在自动跑了。
        */}
        {current && autoFull && (
          <p style={{ margin: 'var(--space-5) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            目前自动放量还没启用：等设备遥测积累够，才定得出「无异常」的判定阈值。
            在那之前请手动点上面的 100%。
          </p>
        )}
      </Card>

      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 'var(--space-10)' }}>
        <StatCard label="当前到端版本" value={current?.bundle_version ? `v${current.bundle_version}` : '—'} />
        {/*
          三个数字都来自 mobile_devices（更新服务在每次检查更新时写心跳，
          壳在装好后回报版本）。取不到时显示 —，不显示 0：
          「0 台活跃设备」与「还没有人装」是两回事，后者才是新空间的实情。
        */}
        <StatCard label="活跃设备" value={stats ? String(stats.activeDevices) : '—'} />
        <StatCard
          label="发布到端耗时"
          value={stats?.deliverySeconds != null ? fmtDuration(stats.deliverySeconds) : '—'}
        />
        <StatCard label="加载失败设备" value={stats ? String(stats.failedDevices) : '—'} />
      </div>

      {/* ── 壳清单（设计稿：内容区由你声明）───────────────────────── */}
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-5)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>壳清单（内容区由你声明）</strong>
          <Badge tone="brand">用户可定</Badge>
        </div>
        <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
          首页形态与底部 bar 由页面包声明，壳原样渲染；改这些只是再发一次页面包，不用发壳。
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-5)', marginBottom: 'var(--space-8)' }}>
          {[
            ['home', 'nav'],
            ['tabBar', '× 4'],
            ['activeColor', '#1c1f23'],
            ['壳入口', '右侧贴边'],
          ].map(([k, v]) => (
            <span key={k} style={{
              display: 'inline-flex', alignItems: 'center', gap: 'var(--space-4)',
              padding: '4px var(--space-6)', background: 'var(--surface-2)',
              borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-sm)',
            }}>
              <span style={{ color: 'var(--text-tertiary)' }}>{k}</span>
              <span className="mono">{v}</span>
            </span>
          ))}
        </div>
        <pre className="mono" style={{
          margin: 0, background: 'var(--accent)', color: 'var(--accent-fg)',
          borderRadius: 'var(--radius-10)', padding: 'var(--space-8)',
          fontSize: 'var(--text-sm)', lineHeight: 1.8, overflowX: 'auto',
        }}>{`{ "home": "nav",
  "tabBar": { "visible": true, "items": [4] },
  "shellEntry": { "edge": "right" } }`}</pre>
        <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          这份清单写在页面包的 app.json 里，随包分发。壳只认这几个键，
          认不出来的键会被忽略——不会让壳崩，但也不会有效果。
        </p>
      </Card>

      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-5)' }}>
          页面包怎么发
        </strong>
        <p style={{ margin: '0 0 var(--space-6)', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
          不在控制台点：本地把产物导出来，然后让 AI 调 <strong className="mono">publish-app</strong> 工具发出去。
          页面包只有 JS bundle 加资源、通常几 MB，MCP 传得动。
        </p>
        <div className="mono" style={{
          background: 'var(--accent)', color: 'var(--accent-fg)',
          borderRadius: 'var(--radius-10)', padding: 'var(--space-8)',
          fontSize: 'var(--text-sm)', lineHeight: 1.9, overflowX: 'auto',
        }}>
          node tools/compose-bundle.mjs --user {'<你>'} --src ./ --out ./composed<br />
          cd composed && npx expo export --platform ios<br />
          {'→ 把 dist 打成 zip，跟 AI 说「用 publish-app 发出去，runtimeVersion 54.0.0」'}
        </div>
        <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          改动大时先让它带 preview: true 发到你自己的预览通道，或用 rolloutPercent 灰度。
          手上没有 AI 客户端时也可以自己传：
          <span className="mono" style={{ fontSize: 'var(--text-2xs)' }}>
            {' '}curl -F file=@dist.zip -F runtimeVersion=54.0.0 …/deploy/api/mobile/publish
          </span>
          ——两条路进的是同一个服务层，效果一样。
        </p>
        <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          壳里预置了相机、扫码、推送、安全存储等能力。项目从平台模板创建即可，
          不要自行引入新的原生依赖——否则 runtimeVersion 变化，新版本不会被壳接受。
          合成脚本会在构建期直接拒绝。
        </p>
      </Card>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 'var(--space-8) var(--space-10) var(--space-5)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>版本记录</strong>
          <span style={{ marginLeft: 'var(--space-6)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            回滚为服务端切指针，1 分钟内全部设备回到旧版本
          </span>
        </div>
        {releases.length === 0 ? (
          <p style={{ padding: 'var(--space-16)', textAlign: 'center', color: 'var(--text-tertiary)', margin: 0 }}>
            还没有发布过页面包
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  {['版本', '发布时间', '要求壳版本', '放量', '到端设备', '状态', '操作'].map((h) => (
                    <th key={h} style={{
                      padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)',
                      fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                      letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {releases.map((r: MobileRelease) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontWeight: 'var(--weight-medium)' }}>
                      v{r.bundle_version}
                    </td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {fmtDate(r.published_at)}
                    </td>
                    <td className="mono" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                      runtimeVersion {r.runtime_version}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {r.status === 'active' ? (
                        <div style={{ display: 'flex', gap: 4 }}>
                          {[10, 50, 100].map((p) => (
                            <Button key={p} size="sm"
                              variant={r.rollout_percent === p ? 'primary' : 'ghost'}
                              disabled={busy}
                              onClick={() => void act(() => api.setRollout(r.id, p), `放量已调至 ${p}%`)}>
                              {p}%
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                          {r.rollout_percent}%
                        </span>
                      )}
                    </td>
                    {/* 到端设备：这个版本现在实际跑在多少台设备上。
                        放量是意图，这一列是结果——两者对不上就说明有设备没更新成功。 */}
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                      {stats ? (stats.devicesByRelease[r.id] ?? 0) : '—'}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {r.status === 'active' ? <Badge tone="success" dot>当前</Badge>
                        : r.status === 'blocked' ? <Badge tone="danger" dot>已阻断</Badge>
                        : <Badge tone="neutral" dot>历史</Badge>}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {r.status === 'superseded' && (
                        <Button size="sm" variant="ghost" disabled={busy}
                          onClick={() => void act(() => api.mobileRollback(r.bundle_version), `已回滚到 v${r.bundle_version}`)}>
                          回滚
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * 「发布到端耗时」的显示。
 *
 * 设计稿写的是 48s。超过一分钟就不该再用秒——「183s」要人心算，
 * 而这个数字的用途是"快不快"，不是精确计时。
 */
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}
