import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, PageTitle, StatusDot, copyText, fmtBytes, fmtDate, useCopy,
} from '@ispace/ui';
import { api, type DataConnection, type DataTable, type Me } from '../api';

/**
 * 设计稿「数据空间」屏。
 *
 * 这一屏要回答的是两个很具体的问题，缺了就看不出它有什么用：
 *   我的数据在哪、怎么连上去？ → 连接信息（复制即可粘进代码）
 *   我用了多少、都有哪些表？   → 表清单与行数
 * 加上设计稿强调的「两层登录，别混了」——那是这个平台最容易被搞混的一点。
 */
export function DataSpace({ me }: { me: Me }) {
  const c = useCopy();
  const schema = `u_${me.user.username.replace(/-/g, '_')}`;

  const [tables, setTables] = useState<DataTable[] | null>(null);
  const [conn, setConn] = useState<DataConnection | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [endUsers, setEndUsers] = useState<{ table: string | null; count: number | null }>(
    { table: null, count: null },
  );

  useEffect(() => {
    void api.dataTables().then((r) => setTables(r.tables)).catch((e: Error) => {
      // 区分"没有表"与"没取到"——前者是正常的新空间，后者是故障
      setTables([]); setErr(e.message);
    });
    void api.dataConnection().then(setConn).catch(() => setConn(null));
    void api.endUsers().then(setEndUsers).catch(() => setEndUsers({ table: null, count: null }));
  }, []);

  const copy = (label: string, text: string) => {
    void copyText(text).then((done) => {
      // 失败也走同一个状态，只是标签不同——不用 alert，它会阻塞线程
      setCopied(done ? label : `${label}:fail`);
      setTimeout(() => setCopied(null), done ? 1600 : 2600);
    });
  };

  const totalRows = (tables ?? []).reduce((n, t) => n + t.rows, 0);

  /**
   * 给 AI 的一段话。
   *
   * 与「复制连接信息」那段代码是两个东西：那段是给会写代码的人直接粘进项目，
   * 这段是给不写代码的人粘进 AI 对话，由 AI 自己接。后者才是这个平台的主路径——
   * 会自己写 createClient 的人本来也不需要这一屏。
   */
  const aiPrompt = conn
    ? [
        '我的应用要存数据。平台已经给我开好了一个独立的数据空间，请用它来读写。',
        '',
        `  REST 地址：${conn.restUrl}`,
        `  匿名公钥：${conn.anonKey ?? '<在控制台「数据空间」页复制>'}`,
        `  schema：${schema}`,
        '',
        '接入要点：',
        `  1. 用 @supabase/supabase-js，创建客户端时必须带 { db: { schema: '${schema}' } }，`,
        '     漏了会去查 public，那里什么都没有',
        '  2. 这个公钥本来就是要发到前端的，可以写进代码；平台不会下发数据库密码',
        '  3. 建表时给每张表开 RLS，并按登录用户加策略——同一张表里不同终端用户的数据',
        '     不该互相看见',
        '  4. 建完表告诉我表名和字段，我要能在控制台里对上',
      ].join('\n')
    : '';
  const snippet = conn
    ? `import { createClient } from '@supabase/supabase-js'\n\n` +
      `export const db = createClient(\n` +
      `  '${conn.restUrl.replace(/\/rest\/v1$/, '')}',\n` +
      `  '${conn.anonKey ?? '<ANON_KEY>'}',\n` +
      `  { db: { schema: '${schema}' } },\n` +
      `)`
    : `createClient(url, anonKey, { db: { schema: '${schema}' } })`;

  return (
    <>
      <PageTitle title={c('data.title')} subtitle={c('data.subtitle')} />

      {/*
        这一屏此前被反馈"不知道有什么用"——因为它上来就讲隔离，
        而"隔离"是用户看不见也不会主动想要的东西。真正的用处是下面这三句：
        它是你的应用**存数据的地方**，这里给你连上去要的信息。
      */}
      <Card style={{ marginBottom: 'var(--space-8)', background: 'var(--surface-2)' }}>
        <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-5)' }}>
          这一屏用来干什么
        </strong>
        <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {[
            ['应用要存数据时', '把下面「给 AI 的一段话」复制给 AI，它就会把读写代码接好'],
            ['想看存了些什么', '下面的表清单，或点「打开数据后台」直接查改'],
            ['担心撞车', '你的表和同事的表在不同 schema 里，名字重了也互不影响'],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontWeight: 'var(--weight-medium)', marginBottom: 'var(--space-3)' }}>{k}</div>
              <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{v}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* ── 连接信息 ─────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-5)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>我的数据空间</strong>
          <Badge tone="success">{c('data.isolated')}</Badge>
          <div style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{schema}</span>
        </div>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
          {c('data.isolationNote')}
        </p>

        <div className="mono" style={{
          marginTop: 'var(--space-8)', background: 'var(--surface-2)',
          borderRadius: 'var(--radius-10)', padding: 'var(--space-8)',
          fontSize: 'var(--text-sm)', lineHeight: 1.8, overflowX: 'auto',
          whiteSpace: 'pre',
        }}>
          {snippet}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-5)', marginTop: 'var(--space-8)', flexWrap: 'wrap' }}>
          {/* 主按钮是给 AI 那段，不是代码片段——不写代码的人才是这一屏的主要用户 */}
          <Button size="sm" variant="primary" disabled={!conn} onClick={() => copy('ai', aiPrompt)}>
            {copied === 'ai' ? '已复制'
              : copied === 'ai:fail' ? '复制不了，手动选中'
              : '复制「给 AI 的一段话」'}
          </Button>
          <Button size="sm" onClick={() => copy('conn', snippet)}>
            {copied === 'conn' ? '已复制'
              : copied === 'conn:fail' ? '复制不了，手动选中'
              : '复制连接信息'}
          </Button>
          {/* Supabase Studio 挂在 /supabase 下，由 Traefik stripPrefix 转发 */}
          <a href="/supabase" target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
            <Button size="sm" variant="ghost">打开数据后台</Button>
          </a>
        </div>
        <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          只给 REST 地址与匿名公钥——那本就是要发到前端的。库密码不下发：
          按 schema 的隔离靠这一层守着。
        </p>
      </Card>

      {/* ── 表清单 ───────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--space-8)', padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', padding: 'var(--space-10) var(--space-10) var(--space-8)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>数据表</strong>
          <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            {tables === null ? '载入中…'
              : `${tables.length} 张 · ${totalRows.toLocaleString()} / ${me.quota.dbRowsLimit.toLocaleString()} 行`}
          </span>
        </div>

        {err ? (
          <p style={{ margin: '0 var(--space-10) var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
            没能取到表清单：{err}
          </p>
        ) : tables !== null && tables.length === 0 ? (
          <p style={{ margin: '0 var(--space-10) var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            还没有表。你的应用第一次写数据时会自动建，或到「打开数据后台」里手工建。
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                  {['表', '行数', '占用', '行级隔离', '最近统计'].map((h) => (
                    <th key={h} style={{
                      padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-2xs)',
                      fontWeight: 'var(--weight-semibold)', color: 'var(--text-tertiary)',
                      letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(tables ?? []).map((t) => (
                  <tr key={t.name} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="mono" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)' }}>
                      {t.name}
                    </td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)' }}>
                      {t.rows.toLocaleString()}
                    </td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {fmtBytes(t.bytes)}
                    </td>
                    <td style={{ padding: 'var(--space-5) var(--space-8)', whiteSpace: 'nowrap' }}>
                      {/* 行级隔离没开时要显眼：那意味着同一张表里不同终端用户
                          的数据互相看得见，而这正是这一屏在承诺的事 */}
                      <StatusDot
                        status={t.rowLevelSecurity ? 'running' : 'blocked'}
                        label={t.rowLevelSecurity ? '已开启' : '未开启'}
                      />
                    </td>
                    <td className="num" style={{ padding: 'var(--space-5) var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {t.lastChangedAt ? fmtDate(t.lastChangedAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ margin: 'var(--space-8) var(--space-10) var(--space-10)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          行数是数据库的统计估算值，不是精确计数——精确计数要全表扫描，
          表一多这一屏就会卡住。配额判定走的是精确路径。
        </p>
      </Card>

      {/* ── 两层登录 ─────────────────────────────────────────────── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-8)', marginBottom: 'var(--space-8)' }}>
          <strong style={{ fontSize: 'var(--text-md)' }}>{c('data.twoLayerAuth')}</strong>
          <div style={{ flex: 1 }} />
          {/*
            设计稿把「已注册终端用户」放在这张卡里，正是为了让人一眼看出
            「你登录平台」和「同事登录你的应用」是两回事——这个数字是后者。
            认不出用户表时整块不显示：显示 0 会被读成"没人用"，
            而实际可能只是表名不在我们认识的那几个里。
          */}
          {endUsers.count !== null && (
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-5)' }}>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                已注册终端用户
              </span>
              <span className="num" style={{
                fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-bold)',
                color: 'var(--text-heading)',
              }}>
                {endUsers.count}
              </span>
              <span className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)' }}>
                {endUsers.table}
              </span>
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gap: 'var(--space-8)', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <div>
            <div style={{ fontWeight: 'var(--weight-medium)', marginBottom: 'var(--space-3)' }}>{c('data.platformLogin')}</div>
            <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>{c('data.platformLoginNote')}</p>
          </div>
          <div>
            <div style={{ fontWeight: 'var(--weight-medium)', marginBottom: 'var(--space-3)' }}>{c('data.appLogin')}</div>
            <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>{c('data.appLoginNote')}</p>
          </div>
        </div>
      </Card>
    </>
  );
}
