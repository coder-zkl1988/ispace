import { useEffect, useState } from 'react';
import {
  Badge, Button, Card, copyText, fmtDate, Input, PageTitle, SectionLabel,
  useConfirm, useCopy,
} from '@ispace/ui';
import { MCP_TOOL_NAMES, MCP_DEFERRED_TOOLS } from '@ispace/contracts';
import { api, type AccessToken, type Me } from '../api';

/**
 * 设计稿「接入指引」屏。
 *
 * 这一屏是同事上手的唯一入口，因此必须做到"复制粘贴即可用"：
 * 创建令牌 → 直接给出带令牌的完整 claude mcp add 命令。
 * 让人自己去拼 header 或从 cookie 抠 token，实际上没人会用。
 */
export function Guide({ me }: { me: Me }) {
  const [confirmUI, ask] = useConfirm();
  const c = useCopy();
  const base = `${location.protocol}//${location.host}`;
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [name, setName] = useState('MCP');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => void api.tokens().then((r) => setTokens(r.tokens)).catch(() => setTokens([]));
  useEffect(load, []);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.createToken(name.trim() || 'MCP');
      setPlaintext(r.plaintext);
      load();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const mcpCmd = plaintext
    ? `claude mcp add --transport http ai-deploy ${base}/deploy/mcp --header "Authorization: Bearer ${plaintext}"`
    : `claude mcp add --transport http ai-deploy ${base}/deploy/mcp --header "Authorization: Bearer <你的令牌>"`;

  return (
    <>
      <PageTitle title={c('guide.title')} subtitle={c('guide.subtitle')} />

      {/* ── 第一步：令牌 ─────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
          <Step n={1} />
          <strong style={{ fontSize: 'var(--text-md)' }}>创建访问令牌</strong>
        </div>
        <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
          MCP 与命令行用它认身份。长期有效，可随时撤销。令牌只代表你自己，
          只能操作你的空间，每次调用都会进审计日志。
        </p>

        <div style={{ display: 'flex', gap: 'var(--space-5)', maxWidth: 420, marginBottom: 'var(--space-8)' }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="用途标记，如 我的笔记本" />
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void create()}>
            创建
          </Button>
        </div>
        {err && <p style={{ margin: 0, color: 'var(--error)', fontSize: 'var(--text-sm)' }}>{err}</p>}

        {plaintext && (
          <div style={{
            background: 'var(--warning-subtle)', border: '1px solid var(--warning)',
            borderRadius: 'var(--radius-10)', padding: 'var(--space-8)', marginBottom: 'var(--space-8)',
          }}>
            <strong style={{ fontSize: 'var(--text-base)' }}>令牌只显示这一次，请立即复制</strong>
            <div style={{ marginTop: 'var(--space-5)' }}>
              <Copyable text={plaintext} />
            </div>
          </div>
        )}

        {tokens.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: 'var(--space-5) 0' }}>{t.name}</td>
                    <td className="mono" style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{t.token_prefix}…</td>
                    <td className="num" style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {t.last_used_at ? `最近使用 ${fmtDate(t.last_used_at)}` : '未使用过'}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Button size="sm" variant="ghost" onClick={async () => {
                        const ok = await ask({
                          title: `撤销「${t.name}」？`,
                          description: '用它配置的 MCP 与命令行会立即失效，需要重新生成令牌并重配一次。已发布的页面不受影响。',
                          confirmLabel: '撤销',
                          danger: true,
                        });
                        if (ok) void api.revokeToken(t.id).then(load);
                      }}>撤销</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── 第二步：让 AI 自己接 ─────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
        <Step n={2} />
        <strong style={{ fontSize: 'var(--text-md)' }}>{c('guide.step1')}</strong>
      </div>
      <OneClickSetup mcpUrl={`${base}/deploy/mcp`} token={plaintext} cliCommand={mcpCmd} />

      {/* ── 第三步：一句话发布 ───────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
          <Step n={3} />
          <strong style={{ fontSize: 'var(--text-md)' }}>{c('guide.step2')}</strong>
        </div>
        <Copyable text="把这个项目部署到我的空间，路径 /zhoubao" />
        <div style={{ height: 'var(--space-6)' }} />
        <Copyable text="把 /zhoubao 回滚到上一个版本" />
        <p style={{ margin: 'var(--space-6) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          {c('guide.step2Note')}
        </p>
      </Card>

      {/* ── 手机页面包怎么配 ─────────────────────────────────── */}
      <MobileConfigHelp />

      <Card style={{ marginBottom: 'var(--space-8)' }}>
        <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-8)' }}>
          {c('guide.cliTitle')}
        </strong>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {[
            ['ai-deploy up ./dist /zhoubao', '发布产物到你的路径'],
            ['ai-deploy releases /zhoubao', '看历史版本'],
            ['ai-deploy rollback /zhoubao v11', '回滚到指定版本'],
            ['ai-deploy quota', '看自己的用量与配额'],
          ].map(([cmd, desc]) => (
            <div key={cmd} style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center' }}>
              <code className="mono" style={{
                background: 'var(--surface-2)', padding: '2px var(--space-5)',
                borderRadius: 'var(--radius-6)', fontSize: 'var(--text-sm)', flex: 'none',
              }}>{cmd}</code>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{desc}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <strong style={{ fontSize: 'var(--text-md)', display: 'block', marginBottom: 'var(--space-8)' }}>
          {c('guide.toolsTitle')}
        </strong>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-5)', marginBottom: 'var(--space-8)' }}>
          {MCP_TOOL_NAMES.map((n) => {
            const deferred = (MCP_DEFERRED_TOOLS as readonly string[]).includes(n);
            return (
              <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <code className="mono" style={{
                  background: deferred ? 'transparent' : 'var(--surface-2)',
                  border: deferred ? '1px dashed var(--border)' : 'none',
                  color: deferred ? 'var(--text-tertiary)' : 'var(--text-primary)',
                  padding: '2px var(--space-5)', borderRadius: 'var(--radius-6)', fontSize: 'var(--text-sm)',
                }}>{n}</code>
                {deferred && <Badge tone="neutral">走流水线</Badge>}
              </span>
            );
          })}
        </div>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          {c('guide.toolsNote')}
        </p>
        <p style={{ margin: 'var(--space-4) 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          你的空间：<span className="mono">{base}/{me.user.username}/</span>
        </p>
      </Card>
      {confirmUI}
    </>
  );
}

function Step({ n }: { n: number }) {
  return (
    <div className="num" style={{
      width: 24, height: 24, borderRadius: '50%', flex: 'none',
      background: 'var(--accent)', color: 'var(--accent-fg)',
      display: 'grid', placeItems: 'center', fontSize: 'var(--text-sm)',
    }}>{n}</div>
  );
}

function Copyable({ text }: { text: string }) {
  const [ok, setOk] = useState<'ok' | 'fail' | null>(null);
  return (
    <div style={{ display: 'flex', gap: 'var(--space-5)', alignItems: 'center' }}>
      <code className="mono" style={{
        flex: 1, minWidth: 0, background: 'var(--accent)', color: 'var(--accent-fg)',
        padding: 'var(--space-5) var(--space-8)', borderRadius: 'var(--radius-8)',
        fontSize: 'var(--text-sm)', overflowX: 'auto', whiteSpace: 'nowrap',
      }}>{text}</code>
      <Button size="sm" onClick={() => {
        // 不用 alert：会阻塞线程，而这正是浏览器不给用剪贴板时的路径
        void copyText(text).then((done) => {
          setOk(done ? 'ok' : 'fail');
          setTimeout(() => setOk(null), done ? 1500 : 2600);
        });
      }}>{ok === 'ok' ? '已复制' : ok === 'fail' ? '手动选中' : '复制'}</Button>
    </div>
  );
}

/**
 * 手机页面包的配置说明。
 *
 * 「底部 tab bar 在哪配」是同事问得最多的问题之一，而在此之前答案只存在于
 * 代码里的 zod schema。这一段给两样东西：
 *   - 人看的：文档在哪、约束是什么（不用打开仓库也能知道最关键的几条）
 *   - AI 看的：一段可复制的配置要点，粘给 AI 它就能直接写对 app.json
 *
 * 要点直接内联而不是只给个文档路径：非技术同事不会去翻仓库，而 AI 拿到
 * 一句"见 docs/…"通常也不会真的去读——它会照着自己的印象编一份字段，
 * 编出来的那份恰好通不过构建期校验。
 */
function MobileConfigHelp() {
  const [copied, setCopied] = useState<string | null>(null);

  const prompt = [
    '我在给公司「AI 应用部署平台」写手机页面包。底部导航等外观由页面包根目录的 app.json 声明，',
    '不是写在代码里。请严格按下面的契约配置，写错的会在构建期被拒绝。',
    '',
    '项目结构：',
    '  app.json            页面声明（下面详述）',
    '  package.json        只用于依赖白名单校验',
    '  src/pages/index.js  唯一入口，默认导出 { screens, title }',
    '    screens 是 { 路由字符串: 组件 }，title 可选（写了就渲染顶部标题栏）',
    '  不要建 src/shell/、src/runtime/、src/screens/，合成时会被平台的壳覆盖',
    '',
    'app.json 只有三个顶层键，其它键被静默忽略：',
    '  home: "nav" | "page"，默认 "nav"。"page" = 进 App 就是一个功能页，没有底部 bar',
    '  tabBar: 不写就没有底部 bar。底部 bar 出现要同时满足：home 为 "nav"、',
    '          tabBar.visible 不为 false、items 至少 1 项',
    '    visible: 布尔，默认 true',
    '    activeColor: 必填，必须 #RRGGBB 六位十六进制（#fff、orange、8 位带透明度都会被拒）',
    '    items: 1–5 项，每项 { label, icon, route }',
    '      label: 1–6 个字符，中文一个字算一个，超了构建失败（不会截断）',
    '      icon: 只认壳内置的这 10 个名字，别的会回落成圆点：',
    '            home list calendar chart user clock star box bell search',
    '      route: 必须与 src/pages/index 的 screens 键完全一致，',
    '             对不上时点 tab 没反应（壳会回落渲染第一屏，不报错）',
    '  shellEntry: { edge: "right" | "left" }，默认 right。壳的设置齿轮常驻那一侧顶角，',
    '              页面要给那个角落留空。collapsed 字段壳目前没读，写了不起作用',
    '',
    '底部 4 个 tab 的完整示例：',
    '{',
    '  "home": "nav",',
    '  "tabBar": {',
    '    "visible": true,',
    '    "activeColor": "#1c1f23",',
    '    "items": [',
    '      { "label": "首页", "icon": "home",     "route": "/" },',
    '      { "label": "排班", "icon": "calendar", "route": "/paiban" },',
    '      { "label": "日报", "icon": "chart",    "route": "/ribao" },',
    '      { "label": "我的", "icon": "user",     "route": "/me" }',
    '    ]',
    '  },',
    '  "shellEntry": { "edge": "right" }',
    '}',
    '',
    '单页应用就一行：{ "home": "page" }',
    '',
    '依赖：不要引入任何新的原生依赖（expo-*、react-native-*、@react-native/*、@expo/*）。',
    '壳是已经发到大家手机上的二进制，加原生依赖会改变 runtimeVersion，服务端就不再把',
    '你的包下发给设备——表现为「发布成功但谁都收不到」。可用的只有壳已预置的那些：',
    'react react-native expo expo-updates expo-secure-store expo-local-authentication',
    'expo-camera expo-notifications expo-image-picker expo-av expo-web-browser',
    'expo-file-system expo-font react-native-safe-area-context react-native-svg',
    'react-native-webview @ispace/contracts',
    '',
    '配好之后用 MCP 的 publish-app 发布，发布前后用 mobile-channel 看到端情况。',
    '更完整的说明（含全部报错信息对照）在仓库 docs/guides/page-bundle-config.md。',
  ].join('\n');

  const copy = (key: string, text: string) => {
    void copyText(text).then((done) => {
      setCopied(done ? key : `${key}:fail`);
      setTimeout(() => setCopied(null), done ? 1600 : 2600);
    });
  };

  return (
    <Card style={{ marginBottom: 'var(--space-8)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
        <strong style={{ fontSize: 'var(--text-md)' }}>手机页面怎么配底部导航</strong>
        <Badge tone="neutral">手机应用</Badge>
      </div>
      <p style={{ margin: '0 0 var(--space-6)', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
        底部 tab bar、首页是导航页还是功能页、壳的齿轮贴哪边，都写在页面包根目录的{' '}
        <code className="mono">app.json</code> 里，不在代码里。改这些只是再发一次页面包，
        不用重新装 App。
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-5)', marginBottom: 'var(--space-8)' }}>
        {[
          ['底部 bar', 'home: "nav" + tabBar'],
          ['最多', '5 个 tab'],
          ['label', '不超过 6 个字'],
          ['activeColor', '#RRGGBB'],
          ['图标', '10 个内置名'],
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

      <pre style={{
        margin: 0, background: 'var(--surface-2)', borderRadius: 'var(--radius-10)',
        padding: 'var(--space-8)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        maxHeight: 220, overflowY: 'auto',
        font: 'var(--weight-regular) var(--text-sm)/1.75 var(--font-sans)',
        color: 'var(--text-primary)',
      }}>{prompt}</pre>

      <div style={{ display: 'flex', gap: 'var(--space-5)', marginTop: 'var(--space-8)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" onClick={() => copy('mobile', prompt)}>
          {copied === 'mobile' ? '已复制'
            : copied === 'mobile:fail' ? '复制不了，手动选中'
            : '复制给 AI'}
        </Button>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          完整说明（含报错对照表）：<span className="mono">docs/guides/page-bundle-config.md</span>
        </span>
      </div>
    </Card>
  );
}

/**
 * 一键接入。
 *
 * 原先这里给的是一段 mcpServers JSON，让用户自己找到客户端的配置文件、
 * 打开、粘进去、重启。那三步里每一步都会卡住不写代码的同事——
 * "配置文件在哪"本身就是个需要问人的问题。
 *
 * 改成给一段**说给 AI 听的话**：用户把它粘进正在用的 AI 对话，
 * 由 AI 自己完成注册 MCP、验证连通、跑一次工具。用户全程不碰配置文件。
 *
 * 指令里写清楚"验证成功前不要报告完成"，是因为 AI 很容易在写完配置后
 * 就宣布接好了，而实际要重启客户端才生效——那时用户以为能用了，
 * 一发布才发现工具根本没加载。
 */
function OneClickSetup({
  mcpUrl, token, cliCommand,
}: { mcpUrl: string; token: string | null; cliCommand: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const hasToken = token !== null;
  const t = token ?? '<在上面创建令牌后这里会自动填好>';

  const prompt = [
    '请帮我接入公司的「AI 应用部署平台」，接好之后我就能让你直接把项目发布到我的空间。',
    '',
    '这是一个 MCP 服务（Streamable HTTP 传输）：',
    `  地址：${mcpUrl}`,
    `  认证：请求头 Authorization: Bearer ${t}`,
    '',
    '请按你所在客户端的方式完成注册，例如：',
    `  Claude Code / Codex CLI：claude mcp add --transport http ai-deploy ${mcpUrl} --header "Authorization: Bearer ${t}"`,
    '  其他客户端：写入它的 MCP 配置，服务名用 ai-deploy',
    '',
    '完成后请做这三件事，再告诉我结果：',
    '  1. 确认 ai-deploy 的工具已经加载出来，列出工具名给我看',
    '  2. 调用一次只读工具（如查配额 / 列页面）验证认证通过',
    '  3. 如果需要我重启客户端才能生效，明确告诉我要重启——不要在没验证成功前说已经接好了',
    '',
    '这个令牌只代表我个人、只能操作我自己的空间，不要写进任何会提交到 git 的文件。',
  ].join('\n');

  const json = JSON.stringify(
    { mcpServers: { 'ai-deploy': { url: mcpUrl, headers: { Authorization: `Bearer ${t}` } } } },
    null, 2,
  );

  const copy = (key: string, text: string) => {
    void copyText(text).then((done) => {
      setCopied(done ? key : `${key}:fail`);
      setTimeout(() => setCopied(null), done ? 1600 : 2600);
    });
  };

  return (
    <Card style={{ marginBottom: 'var(--space-8)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
        <strong style={{ fontSize: 'var(--text-md)' }}>一键接入：把这段话丢给 AI</strong>
        <Badge tone="brand">推荐</Badge>
      </div>
      <p style={{ margin: '0 0 var(--space-8)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        不用自己找配置文件、也不用开终端。复制下面这段，粘进你正在用的 AI 对话里，
        让它自己接——接完它会跑一次验证再回你。
      </p>

      <pre style={{
        margin: 0, background: 'var(--surface-2)', borderRadius: 'var(--radius-10)',
        padding: 'var(--space-8)', fontSize: 'var(--text-sm)', lineHeight: 1.75,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        maxHeight: 260, overflowY: 'auto',
        font: 'var(--weight-regular) var(--text-sm)/1.75 var(--font-sans)',
        color: 'var(--text-primary)',
      }}>{prompt}</pre>

      <div style={{ display: 'flex', gap: 'var(--space-5)', marginTop: 'var(--space-8)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" disabled={!hasToken} onClick={() => copy('prompt', prompt)}>
          {copied === 'prompt' ? '已复制'
            : copied === 'prompt:fail' ? '复制不了，手动选中'
            : '复制这段话'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowJson((v) => !v)}>
          {showJson ? '收起手动配置' : '我想自己改配置文件'}
        </Button>
        {!hasToken && (
          <span style={{ fontSize: 'var(--text-sm)', color: '#8a6d00' }}>
            先在上面创建访问令牌，这段话才会带上真实令牌
          </span>
        )}
      </div>

      {/* 手动配置留着但收起来：会自己配的人不需要被这段 JSON 挡在前面，
          而它对不会配的人只是噪声。 */}
      {showJson && (
        <div style={{ marginTop: 'var(--space-10)' }}>
          <SectionLabel>手动配置</SectionLabel>
          <p style={{ margin: 'var(--space-6) 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            命令行客户端跑这一条：
          </p>
          <Copyable text={cliCommand} />
          <p style={{ margin: 'var(--space-8) 0 var(--space-6)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            图形客户端把这段写进它的 MCP 配置：
          </p>
          <pre className="mono" style={{
            margin: 0, background: 'var(--surface-2)',
            borderRadius: 'var(--radius-10)', padding: 'var(--space-8)',
            fontSize: 'var(--text-sm)', lineHeight: 1.7, overflowX: 'auto',
          }}>{json}</pre>
          <div style={{ display: 'flex', gap: 'var(--space-5)', marginTop: 'var(--space-6)' }}>
            <Button size="sm" disabled={!hasToken} onClick={() => copy('json', json)}>
              {copied === 'json' ? '已复制'
                : copied === 'json:fail' ? '复制不了，手动选中'
                : '复制配置'}
            </Button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', marginTop: 'var(--space-8)' }}>
            {[
              ['Claude Code / Codex CLI', '在项目里跑一次上面第 2 步那条命令'],
              ['Claude Desktop', '设置 → 开发者 → 编辑配置，粘进 mcpServers'],
              ['Cursor / VS Code', '工作区的 .cursor/mcp.json 或 .vscode/mcp.json'],
            ].map(([client, where]) => (
              <div key={client} style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'baseline' }}>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', flex: 'none', width: 168 }}>
                  {client}
                </span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{where}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
