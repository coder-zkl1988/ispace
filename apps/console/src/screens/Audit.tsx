import { useEffect, useState } from 'react';
import { Badge, Card, PageTitle, StatCard, fmtDate, useCopy } from '@ispace/ui';
import { api, type AuditEntry } from '../api';

/** 设计稿「发布记录」屏。含被阻断计数——那是这一屏的价值所在。 */
export function AuditScreen() {
  const c = useCopy();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [blocked, setBlocked] = useState(0);

  useEffect(() => {
    void api.audit(100).then((r) => { setLogs(r.logs); setTotal(r.total); setBlocked(r.blockedCount); });
  }, []);

  return (
    <>
      <PageTitle title={c('audit.title')} subtitle={c('audit.subtitle')} />
      <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 'var(--space-8)' }}>
        <StatCard label={c('audit.title')} value={String(total)} />
        <StatCard label={c('audit.blocked')} value={String(blocked)} />
      </div>
      <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        {c('audit.retention')}
      </p>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                {['时间', '动作', '对象', '入口', '操作人', '结果'].map((h) => (
                  <th key={h} style={{
                    padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)',
                    fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                    letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                    {fmtDate(l.createdAt as unknown as string)}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>{l.action}</td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    {(l.metadata as { slug?: string; username?: string } | null)?.slug
                      ?? (l.metadata as { username?: string } | null)?.username ?? l.targetType}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                    {c(`source.${l.source}` as 'source.mcp')}
                  </td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>{l.actorUsername}</td>
                  <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                    {l.result === 'blocked' ? <Badge tone="danger">{c('audit.blocked')}</Badge>
                      : l.result === 'failed' ? <Badge tone="warning">失败</Badge>
                      : <Badge tone="success">成功</Badge>}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 'var(--space-16)', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                  还没有记录
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
