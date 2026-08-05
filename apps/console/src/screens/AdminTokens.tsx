import { useEffect, useState } from 'react';
import {
  Avatar, Badge, Button, Card, Input, PageTitle, StatCard, fmtDate, useConfirm,
} from '@ispace/ui';
import { api, type AdminToken } from '../api';

/**
 * 访问令牌治理。
 *
 * 此前完全没有这一屏：管理员看不到任何人的 MCP / CLI 令牌，也无法吊销。
 * 人离职时只能把账号归档——归档确实会让鉴权失败（requireAuth 会查用户状态），
 * 但「我们收回了他的访问权」这件事没有任何地方能证实，
 * 也处理不了「某个令牌泄露了但人还在职」。
 *
 * 只显示前缀不显示哈希：前缀足够让人对上自己那条记录，而哈希哪怕泄露
 * 也无法反推令牌，列出来只是徒增暴露面。
 */
export function AdminTokens() {
  const [confirmUI, ask] = useConfirm();
  const [tokens, setTokens] = useState<AdminToken[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => void api.adminTokens().then((r) => setTokens(r.tokens)).catch((e: Error) => setMsg(e.message));
  useEffect(load, []);

  const kw = q.trim().toLowerCase();
  const shown = kw
    ? tokens.filter((t) =>
        t.username.toLowerCase().includes(kw)
        || t.display_name.toLowerCase().includes(kw)
        || t.name.toLowerCase().includes(kw))
    : tokens;

  const now = Date.now();
  const idle90 = tokens.filter(
    (t) => !t.last_used_at || now - new Date(t.last_used_at).getTime() > 90 * 86400_000,
  ).length;
  /* 归档的人名下还有活令牌，是最该先处理的一类——账号状态挡得住鉴权，
     但这条记录本身说明回收流程没走干净。 */
  const orphan = tokens.filter((t) => t.user_status !== 'active').length;

  const revoke = async (t: AdminToken) => {
    const ok = await ask({
      title: `吊销「${t.name}」？`,
      description:
        `这是 ${t.display_name}（${t.username}）的令牌。吊销后用它配置的 MCP 与命令行会立即失效，`
        + '本人需要重新生成令牌并重配一次。已发布的页面不受影响。',
      confirmLabel: '吊销',
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setMsg(null);
    try { await api.adminRevokeToken(t.id); setMsg(`已吊销 ${t.username} 的「${t.name}」`); load(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageTitle
        title="访问令牌"
        subtitle="MCP 与命令行用的长期凭据。人离职、令牌泄露时在这里收回。"
      />

      <div style={{
        display: 'grid', gap: 'var(--space-8)', marginBottom: 'var(--space-10)',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      }}>
        <StatCard label="有效令牌" value={String(tokens.length)} />
        <StatCard label="90 天未使用" value={String(idle90)} />
        <StatCard label="已归档账号名下" value={String(orphan)} />
      </div>

      {orphan > 0 && (
        <Card style={{
          marginBottom: 'var(--space-8)',
          background: 'var(--warning-subtle)', border: '1px solid var(--warning)',
        }}>
          <strong style={{ fontSize: 'var(--text-base)' }}>
            有 {orphan} 个令牌属于已归档或待开通的账号
          </strong>
          <p style={{ margin: 'var(--space-4) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            账号状态已经挡得住鉴权，但这些记录说明离职回收没走干净。建议一并吊销，
            让"访问权已收回"这件事在记录上也成立。
          </p>
        </Card>
      )}

      {msg && <Card style={{ marginBottom: 'var(--space-8)', fontSize: 'var(--text-base)' }}>{msg}</Card>}

      <div style={{ width: 260, marginBottom: 'var(--space-8)' }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索人名或令牌名" />
      </div>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {shown.length === 0 ? (
          <p style={{ padding: 'var(--space-16)', textAlign: 'center', color: 'var(--text-tertiary)', margin: 0 }}>
            {tokens.length === 0 ? '还没有人创建过访问令牌' : '没有匹配的令牌'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  {['归属', '令牌名', '前缀', '创建于', '最近使用', '有效期', '操作'].map((h) => (
                    <th key={h} style={{
                      padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-xs)',
                      fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                      letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const stale = !t.last_used_at
                    || now - new Date(t.last_used_at).getTime() > 90 * 86400_000;
                  const expired = t.expires_at ? new Date(t.expires_at).getTime() < now : false;
                  return (
                    <tr key={t.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: 'var(--space-6) var(--space-8)', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
                          <Avatar name={t.display_name} size={24} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 'var(--weight-medium)' }}>{t.display_name}</div>
                            <div className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                              {t.username}
                            </div>
                          </div>
                          {t.user_status !== 'active' && (
                            <Badge tone="warning" dot>
                              {t.user_status === 'archived' ? '已归档' : '待开通'}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: 'var(--space-6) var(--space-8)' }}>{t.name}</td>
                      <td className="mono" style={{ padding: 'var(--space-6) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                        {t.token_prefix}…
                      </td>
                      <td className="num" style={{ padding: 'var(--space-6) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                        {fmtDate(t.created_at)}
                      </td>
                      <td className="num" style={{
                        padding: 'var(--space-6) var(--space-8)', fontSize: 'var(--text-sm)',
                        color: stale ? 'var(--text-tertiary)' : 'var(--text-secondary)', whiteSpace: 'nowrap',
                      }}>
                        {t.last_used_at ? fmtDate(t.last_used_at) : '从未使用'}
                      </td>
                      <td style={{ padding: 'var(--space-6) var(--space-8)', whiteSpace: 'nowrap' }}>
                        {!t.expires_at
                          ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>长期</span>
                          : expired
                            ? <Badge tone="danger" dot>已过期</Badge>
                            : <span className="num" style={{ fontSize: 'var(--text-sm)' }}>{fmtDate(t.expires_at)}</span>}
                      </td>
                      <td style={{ padding: 'var(--space-6) var(--space-8)', whiteSpace: 'nowrap' }}>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(t)}>
                          吊销
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p style={{ margin: 'var(--space-8) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 1.8 }}>
        令牌只在创建那一刻显示过一次，服务端只存哈希——这里看得到前缀，看不到令牌本身，
        也无法帮人找回。丢了就让本人在「接入指引」里重新建一个。
        <br />
        想让新令牌自动过期，在「平台设置」里设「访问令牌有效期上限」。
      </p>
      {confirmUI}
    </>
  );
}
