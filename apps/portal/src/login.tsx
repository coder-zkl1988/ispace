import { useEffect, useState } from 'react';
import { Button, Card, Greeting, Icon, Input, Mark, Wordmark } from '@ispace/ui';
import { api, type AuthPolicy } from './api';
import { AppDownloadDialog } from './UserMenu';

/**
 * 登录（改版稿 §登录）。
 *
 * 一张卡：品牌、一句欢迎、SSO、分隔线、邮箱密码、忘记密码。改版前这一屏是
 * 「登录 / 注册」两个 tab 顶在卡上方；新稿把注册降成了一行小字——内部平台
 * 上注册只发生一次，而登录每天都发生，两件事不该平分这张卡。
 *
 * 校验与请求一字未改（api.login / register / forgotPassword），只换了版式：
 * 密码策略、邮箱域名白名单、空间标识推导这些判断仍在服务端。
 */
export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [policy, setPolicy] = useState<AuthPolicy | null>(null);
  const [apk, setApk] = useState(false);

  useEffect(() => { void api.authPolicy().then(setPolicy).catch(() => setPolicy(null)); }, []);

  return (
    <div
      style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, boxSizing: 'border-box', background: 'var(--surface-canvas)',
      }}
    >
      <div
        style={{
          position: 'relative', width: '100%', maxWidth: 420, boxSizing: 'border-box',
          padding: '40px 36px 28px', borderRadius: 28, background: 'var(--surface-1)',
          boxShadow: '0 40px 80px -24px rgba(24,23,21,.35)',
          display: 'flex', flexDirection: 'column', gap: 22,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Mark size={32} />
            <Wordmark size={28} />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 22, fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)' }}>
              {mode === 'login' ? '欢迎回来' : '开通你的空间'}
            </span>
            <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-tertiary)' }}>
              {mode === 'login'
                ? '登录后继续，做的页面都会发到你自己的空间'
                : '用公司邮箱注册，注册即开通你的空间与数据库'}
            </span>
          </span>
        </div>

        {mode === 'login' ? <LoginForm policy={policy} onRegister={() => setMode('register')} />
          : <RegisterForm policy={policy} onLogin={() => setMode('login')} />}

        {/*
          未登录也给下载入口。装 App 这件事按定义发生在有会话之前——只把入口
          挂在头像菜单里，等于要求人先在电脑上登录才能知道有 App 可装。
        */}
        <button
          type="button"
          onClick={() => setApk(true)}
          style={{
            border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
            fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
          }}
        >
          下载手机 App（安卓）
        </button>
      </div>
      {apk && <AppDownloadDialog onClose={() => setApk(false)} />}
    </div>
  );
}

function LoginForm({ policy, onRegister }: { policy: AuthPolicy | null; onRegister: () => void }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 「忘记密码」提交后服务端那句话。非 null 就把入口换成它。 */
  const [forgot, setForgot] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !pw) { setErr('邮箱和密码都要填'); return; }
    setBusy(true); setErr(null);
    try {
      await api.login(email.trim(), pw);
      /* 整页重载而不是改 state：登录后几乎每份数据都要重取，重载最不容易漏 */
      location.reload();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  /*
    复用上面已经填好的邮箱，不再单开一个输入框：走到这一步的人刚把邮箱
    敲进去过，再要一遍只是多一次出错的机会。
  */
  const askReset = async () => {
    const addr = email.trim();
    if (!addr) { setErr('先填上公司邮箱，再点忘记密码'); return; }
    setBusy(true); setErr(null);
    try {
      setForgot((await api.forgotPassword(addr)).message);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <>
      {policy?.ssoEnabled && (
        <>
          <a
            href={api.loginUrl(new URLSearchParams(location.search).get('redirect') ?? location.pathname)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, height: 50,
              border: '1px solid var(--border-hover)', borderRadius: 14, background: 'var(--surface-1)',
              color: 'var(--text-heading)', fontSize: 15, fontWeight: 'var(--weight-semibold)',
              cursor: 'pointer', textDecoration: 'none',
            }}
          >
            <Icon name="building" size={18} />{policy.ssoProvider === 'feishu' ? '使用公司飞书登录' : '用公司账号登录（SSO）'}
          </a>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            <span style={{ flex: 1, height: 1, background: 'var(--border-tabby)' }} />或
            <span style={{ flex: 1, height: 1, background: 'var(--border-tabby)' }} />
          </div>
        </>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <PillField icon="mail">
          <input
            type="email" value={email} autoComplete="username" autoFocus
            onChange={(e) => setEmail(e.target.value)}
            placeholder={policy ? `name@${policy.emailDomains[0]}` : '公司邮箱'}
            style={pillInput}
          />
        </PillField>
        <PillField icon="lock">
          <input
            type="password" value={pw} autoComplete="current-password"
            onChange={(e) => setPw(e.target.value)} placeholder="密码" style={pillInput}
          />
        </PillField>
        {err && <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--danger)' }}>{err}</p>}
        <button type="submit" disabled={busy} style={ctaBtn}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>

      {forgot ? (
        <p
          role="status"
          style={{
            margin: 0, padding: 12, borderRadius: 12, background: 'var(--surface-2)',
            fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-secondary)',
          }}
        >
          {forgot}
        </p>
      ) : (
        <div
          style={{
            display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
            fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
          }}
        >
          {/*
            button 而不是 a：它不导航，只发一个请求。写成链接的话键盘用户按
            空格不会触发，右键「新标签打开」还会开出一个空页面。
          */}
          <button
            type="button" onClick={() => void askReset()} disabled={busy}
            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--text-secondary)' }}
          >
            忘记密码？
          </button>
          <span>
            第一次用？
            <button
              type="button" onClick={onRegister}
              style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--text-secondary)', textDecoration: 'underline', textUnderlineOffset: 3 }}
            >
              用公司邮箱直接注册
            </button>
          </span>
        </div>
      )}
    </>
  );
}

function RegisterForm({ policy, onLogin }: { policy: AuthPolicy | null; onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const suggested = guessUsername(email);
  const effective = username.trim() || suggested;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.register({
        email: email.trim(),
        password: pw,
        displayName: name.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
      });
      location.reload();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <PillField icon="mail">
        <input
          type="email" value={email} autoComplete="username" autoFocus
          onChange={(e) => setEmail(e.target.value)}
          placeholder={policy ? `name@${policy.emailDomains[0]}` : 'name@example.com'}
          style={pillInput}
        />
      </PillField>
      <PillField icon="user">
        <input
          value={name} autoComplete="name" onChange={(e) => setName(e.target.value)}
          placeholder="姓名" style={pillInput}
        />
      </PillField>
      <PillField icon="lock">
        <input
          type="password" value={pw} autoComplete="new-password"
          onChange={(e) => setPw(e.target.value)}
          placeholder={`密码（至少 ${policy?.passwordMin ?? 12} 位）`} style={pillInput}
        />
      </PillField>
      <PillField icon="link">
        <input
          value={username} onChange={(e) => setUsername(e.target.value)}
          placeholder={suggested ? `空间标识（默认 ${suggested}）` : '空间标识'} style={pillInput}
        />
      </PillField>
      <p style={{ margin: '0 4px', fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
        {effective
          ? <>你的地址会是 <span className="mono">{location.host}/{effective}/</span>。注册后很难改，想清楚。</>
          : '从这个邮箱推不出标识，请自己填（小写字母开头，可含数字与连字符）。'}
      </p>
      {err && <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--danger)' }}>{err}</p>}
      <button
        type="submit"
        disabled={busy || !email.trim() || !name.trim() || !pw || !effective}
        style={ctaBtn}
      >
        {busy ? '注册中…' : '注册并开通空间'}
      </button>
      {policy && (
        <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
          仅限 {policy.emailDomains.map((d) => `@${d}`).join('、')} 邮箱。
        </p>
      )}
      <button
        type="button" onClick={onLogin}
        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}
      >
        已经有账号了，去登录
      </button>
    </form>
  );
}

const pillInput: React.CSSProperties = {
  flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent',
  fontSize: 15, color: 'var(--text-primary)', fontFamily: 'inherit',
};

const ctaBtn: React.CSSProperties = {
  height: 50, border: 0, borderRadius: 14, background: 'var(--cta)', color: 'var(--cta-fg)',
  fontSize: 15, fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
};

function PillField({ icon, children }: { icon: 'mail' | 'lock' | 'user' | 'link'; children: React.ReactNode }) {
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 50, padding: '0 16px',
        borderRadius: 14, background: 'var(--surface-2)', color: 'var(--text-tertiary)',
      }}
    >
      <Icon name={icon} size={17} />
      {children}
    </label>
  );
}

/**
 * 前端侧的空间标识推导。
 *
 * 与服务端 usernameFromEmail 同一套规则——这里只是为了让用户在提交前就看到
 * 自己将来的地址。真正的判定仍在服务端，前端算错了顶多是提示不准。
 */
function guessUsername(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local
    .toLowerCase()
    .replace(/[._+]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── 重置密码 ────────────────────────────────────────────────────────────
/*
  这一页从 App.tsx 原样搬过来：它是登录链路的一部分（走到这里的人按定义
  就是登不进去的那个），改版稿没有重画它，所以版式也不动。
*/
export function ResetPassword() {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [policy, setPolicy] = useState<AuthPolicy | null>(null);

  useEffect(() => { void api.authPolicy().then(setPolicy).catch(() => setPolicy(null)); }, []);

  const min = policy?.passwordMin ?? 12;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const ready = pw.length >= min && pw === pw2 && !busy;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.resetPassword(token, pw);
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Centered>
      <Greeting>Happy Working</Greeting>
      <h1 style={{ margin: 'var(--space-4) 0 var(--space-8)', font: 'var(--weight-bold) var(--text-xl)/1.3 var(--font-sans)', color: 'var(--text-heading)' }}>
        设置新密码
      </h1>

      {!token ? (
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
          这个地址里没有重置令牌。请用管理员发给你的完整链接打开。
        </p>
      ) : done ? (
        <>
          <p style={{ margin: '0 0 var(--space-8)', color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
            密码已设好，这条链接同时作废。现在可以用邮箱和新密码登录了——
            手机上的 App 也是同一个账号。
          </p>
          <a href="/" style={{ textDecoration: 'none' }}>
            <Button variant="primary">去登录</Button>
          </a>
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 var(--space-8)', color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
            至少 {min} 位。长比复杂更管用——一句只有你会说的话就很好。
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', width: '100%' }}>
            <Input
              type="password" value={pw} onChange={(e) => setPw(e.target.value)}
              placeholder="新密码" autoComplete="new-password" autoFocus disabled={busy}
            />
            <Input
              type="password" value={pw2} onChange={(e) => setPw2(e.target.value)}
              placeholder="再输一次" autoComplete="new-password" disabled={busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) void submit(); }}
            />
            {mismatch && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--error)' }}>两次输入不一致</span>
            )}
            {err && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--error)' }}>{err}</span>
            )}
            <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
              {busy ? '设置中…' : '设置密码'}
            </Button>
          </div>
        </>
      )}
    </Centered>
  );
}

/** 登录、注册、重置三页共用的居中卡片容器。 */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: 'var(--surface-canvas)', padding: 'var(--space-12)',
    }}>
      <Card style={{ width: 380, maxWidth: '100%', padding: 'var(--space-16)' }}>
        {children}
      </Card>
    </div>
  );
}
