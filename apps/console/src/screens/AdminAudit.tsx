import { useEffect, useState } from 'react';
import {
  Avatar, Badge, Button, Card, PageTitle, StatCard, Tabs, fmtBytes, fmtDate, useCopy,
} from '@ispace/ui';
import { api, type AuditEntry, type BackupRun, type BlockedItem } from '../api';

/**
 * 设计稿管理员「审计与安全」屏。
 *
 * 三个页签对应三个不同的问题：
 *   审计日志   —— 谁在什么时候从哪儿做了什么
 *   密钥拦截   —— 有没有人差点把密钥发上线
 *   备份与恢复 —— 出事了能不能恢复回来
 *
 * 后端已按角色区分：管理员看全平台，员工只看自己的（/audit 端点按 role
 * 决定是否加 actorId 过滤），所以这里直接用同一个接口。
 */
type Tab = 'logs' | 'blocked' | 'backup';

export function AdminAudit() {
  const [tab, setTab] = useState<Tab>('logs');

  return (
    <>
      <PageTitle title="审计与安全" subtitle="审计日志、密钥拦截与备份恢复" />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-8)' }}>
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'logs' as const, label: '审计日志' },
            { value: 'blocked' as const, label: '密钥拦截' },
            { value: 'backup' as const, label: '备份与恢复' },
          ]}
        />
        {tab !== 'backup' && (
          // CSV 附件不能 fetch 后再解析，交给浏览器直接下载
          <Button size="sm" onClick={() => { location.href = api.exportAuditUrl(); }}>导出记录</Button>
        )}
      </div>

      {tab === 'logs' && <AuditTable filter="all" />}
      {tab === 'blocked' && <BlockedPanel />}
      {tab === 'backup' && <BackupPanel />}
    </>
  );
}

/**
 * 密钥拦截复核。
 *
 * 原先这一页是把最近 200 条审计在前端按 result === 'blocked' 过一遍。
 * 平台一忙，200 条里可能一条 blocked 都没有——于是这一页长期空着，
 * 看起来像"从没拦下过东西"，而实际只是被正常发布挤出了窗口。
 * 现在走专门的端点，只查 blocked，与平台有多忙无关。
 *
 * 顺带把命中的规则摊开：管理员要判断的是"真泄露还是误报"，
 * 而这个判断只看时间和人名做不出来。
 */
function BlockedPanel() {
  const [items, setItems] = useState<BlockedItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api.adminBlocked()
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;

  return (
    <>
      <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
        发布前扫描命中硬编码密钥即阻断，产物不落盘。多为把 key 写进了前端代码。
        <br />
        <strong>真泄露</strong>要通知本人立刻换掉那个密钥——产物虽然没落盘，
        但它已经在本人的机器和 git 历史里了。<strong>误报</strong>则要调扫描规则，
        否则这个人会一直发不出去。
      </p>

      {items.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 'var(--space-24)' }}>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>还没有被拦下的发布</p>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          {items.map((it) => {
            const findings = Array.isArray(it.metadata?.findings)
              ? (it.metadata.findings as { rule?: string; file?: string; line?: number }[])
              : [];
            return (
              <Card key={it.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
                  <Avatar name={it.display_name} size={24} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 'var(--weight-medium)' }}>{it.display_name}</div>
                    <div className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                      {it.username}
                    </div>
                  </div>
                  <Badge tone="danger" dot>已阻断</Badge>
                  <div style={{ flex: 1 }} />
                  <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                    {fmtDate(it.created_at)}
                  </span>
                </div>

                {findings.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                    这条记录没有留下命中详情（早于扫描器记录规则名的版本）。
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                    {findings.slice(0, 8).map((f, i) => (
                      <div key={`${f.file}-${f.line}-${i}`} style={{
                        display: 'flex', alignItems: 'baseline', gap: 'var(--space-6)',
                        fontSize: 'var(--text-sm)',
                      }}>
                        <Badge tone="warning">{f.rule ?? '未知规则'}</Badge>
                        <code className="mono" style={{ color: 'var(--text-secondary)' }}>
                          {f.file ?? '?'}{f.line ? `:${f.line}` : ''}
                        </code>
                      </div>
                    ))}
                    {findings.length > 8 && (
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                        还有 {findings.length - 8} 处
                      </span>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function AuditTable({ filter }: { filter: 'all' | 'blocked' }) {
  const c = useCopy();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [blocked, setBlocked] = useState(0);

  useEffect(() => {
    void api.audit(200).then((r) => { setLogs(r.logs); setTotal(r.total); setBlocked(r.blockedCount); });
  }, []);

  const rows = filter === 'blocked' ? logs.filter((l) => l.result === 'blocked') : logs;

  return (
    <>
      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 'var(--space-8)' }}>
        <StatCard label="全量记录" value={String(total)} />
        <StatCard label={c('audit.blocked')} value={String(blocked)} />
      </div>

      <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        {filter === 'blocked'
          ? '发布前扫描命中硬编码密钥即阻断，产物不落盘。这里是全部被拦下的尝试——多为把 key 写进了前端代码。'
          : '全量记录发布、开通、回收、配额变更；Supabase 侧敏感操作由 pgAudit 记录。'}
      </p>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                {['时间', '操作人', '动作', '对象', '入口', 'IP', '结果'].map((h) => (
                  <th key={h} style={{
                    padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-2xs)',
                    fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                    letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                    {fmtDate(l.createdAt as unknown as string)}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>{l.actorUsername}</td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>{l.action}</td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    {(l.metadata as { slug?: string; username?: string } | null)?.slug
                      ?? (l.metadata as { username?: string } | null)?.username ?? l.targetType}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                    {c(`source.${l.source}` as 'source.mcp')}
                  </td>
                  <td className="mono" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                    {l.ip ?? '—'}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                    {l.result === 'blocked' ? <Badge tone="danger">{c('audit.blocked')}</Badge>
                      : l.result === 'failed' ? <Badge tone="warning">失败</Badge>
                      : <Badge tone="success">成功</Badge>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 'var(--space-16)', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                  {filter === 'blocked' ? '还没有发布被拦下过' : '还没有记录'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/**
 * 备份与恢复。
 *
 * 只显示脚本回写的真实结果，不做任何推断——"上次备份成功"这句话如果是
 * 猜出来的，那它比没有更危险。没有记录时明说没有记录。
 */
function BackupPanel() {
  const [runs, setRuns] = useState<BackupRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // 取不到时要说"取不到"，不能显示成"还没有备份记录"——
    // 那会让管理员以为备份没跑，实际是这个页面没拿到数据。
    void api.adminBackups().then((r) => setRuns(r.runs))
      .catch((e: Error) => { setRuns([]); setErr(e.message); });
  }, []);

  const latest = (kind: BackupRun['kind']) => runs?.find((r) => r.kind === kind) ?? null;
  const backup = latest('backup');
  const drill = latest('restore_drill');

  if (err) {
    return (
      <Card style={{ padding: 'var(--space-16)' }}>
        <Badge tone="danger">没能取到备份记录</Badge>
        <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          {err}
        </p>
      </Card>
    );
  }

  return (
    <>
      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginBottom: 'var(--space-8)' }}>
        <RunCard title="最近一次备份" run={backup} empty="还没有备份记录。服务器上跑 infra/scripts/09-backup.sh 后会回写。" />
        <RunCard title="最近一次恢复演练" run={drill} empty="还没有演练记录。备份没验证过就等于没有备份——跑 10-restore-drill.sh。" />
      </div>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                {['类型', '结果', '完成时间', '大小', '说明'].map((h) => (
                  <th key={h} style={{
                    padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-2xs)',
                    fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                    letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(runs ?? []).map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                    {r.kind === 'backup' ? '备份' : '恢复演练'}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                    <Badge tone={r.status === 'success' ? 'success' : 'danger'}>
                      {r.status === 'success' ? '成功' : '失败'}
                    </Badge>
                  </td>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                    {fmtDate(r.finished_at)}
                  </td>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                    {r.size_bytes ? fmtBytes(Number(r.size_bytes)) : '—'}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                    {r.note ?? '—'}
                  </td>
                </tr>
              ))}
              {runs?.length === 0 && (
                <tr><td colSpan={5} style={{ padding: 'var(--space-16)', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                  还没有备份或演练记录
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function RunCard({ title, run, empty }: { title: string; run: BackupRun | null; empty: string }) {
  // 超过 48 小时没备份就该被看见。这个判断放在前端是因为"多久算旧"
  // 取决于看的人，后端不该替他决定。
  const stale = run ? Date.now() - new Date(run.finished_at).getTime() > 48 * 3600_000 : false;
  return (
    <Card>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-4)' }}>{title}</div>
      {!run ? (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{empty}</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)', marginBottom: 4 }}>
            <Badge tone={run.status === 'success' ? 'success' : 'danger'}>
              {run.status === 'success' ? '成功' : '失败'}
            </Badge>
            {stale && <Badge tone="warning">已超过 48 小时</Badge>}
          </div>
          <div className="num" style={{ fontSize: 'var(--text-base)' }}>{fmtDate(run.finished_at)}</div>
          {run.note && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 4 }}>{run.note}</div>
          )}
        </>
      )}
    </Card>
  );
}
