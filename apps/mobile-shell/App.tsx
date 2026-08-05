import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { channelNameFor, type AppJson } from '@ispace/contracts';
import { ShellChrome, UpdateCard, IncompatibleScreen } from './src/shell/ShellChrome';
import { NavContainer, parseAppJson } from './src/shell/NavContainer';
import { Settings, type SettingKey } from './src/shell/Settings';
import { AgentChat, type EditTarget } from './src/shell/AgentChat';
import { Launcher, type LaunchItem } from './src/shell/Launcher';
import { WebPage, type WebPageTarget } from './src/shell/WebPage';
import { Market } from './src/shell/Market';

import { ShellTabs, type ShellTab } from './src/shell/ShellTabs';
import { API_BASE, DISPLAY_HOST } from './src/config';
import {
  applyUpdate, checkQuietly, rollbackToPrevious,
  switchToUserChannel, versionInfo, type LoadPhase,
} from './src/runtime/channel';
import {
  deviceId, getDefaultHome, session, setDefaultHome, unlockWithBiometrics,
} from './src/runtime/bridge';

/**
 * 壳的入口。
 *
 * ┌─ 这个文件属于「JS 壳运行时」，随每个页面包分发 ────────────────────┐
 * │ 构建流水线在 expo export 前把它与用户页面代码合成为一个更新包。      │
 * │ 用户源码中不存在本文件，由流水线注入，用户既改不掉也删不掉——         │
 * │ 这保证了每个用户包都自带完整壳功能，且壳运行时版本永远由平台控制。   │
 * │ 见 tools/compose-bundle.mjs。                                       │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 流程（对应设计稿第 10 → 01 屏）：
 *   未登录 → 内嵌包离线可开的登录页
 *   登录后 → 切到 u-{username} 通道 → 就地显示加载进度 → 重载
 *   重载后 → 渲染用户页面包声明的内容区
 *
 * 通道等实现细节不对使用者外露：进度文案只说"正在加载你的应用"。
 */

/**
 * 壳自身的版本，取自 app.json 的 version。
 *
 * 与 runtimeVersion 是两回事：runtimeVersion 决定「哪些页面包能装进来」，
 * 壳版本回答「你手上这个 App 是哪一版」。登录页把两个都显示出来，
 * 排查「同事的能用我的不能用」时第一眼就能看出差在哪。
 * 之前两处都打印 runtimeVersion，等于白占一行。
 */
const SHELL_VERSION = '1.0.0';

interface Me {
  user: { username: string; displayName: string; identity: 'user' | 'developer' };
  spaceUrl: string;
}

/**
 * 用户页面包的入口约定。
 *
 * 合成时流水线把用户的入口挂到 globalThis.__ispacePage 上。
 * 壳只认这个约定，不理解页面内部结构。
 */
interface PageBundle {
  appJson: unknown;
  screens: Record<string, () => React.ReactNode>;
  title?: string;
}

function getPageBundle(): PageBundle | null {
  const g = globalThis as unknown as { __ispacePage?: PageBundle };
  return g.__ispacePage ?? null;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

/**
 * 壳内的一屏。栈只有两层深（首页 + 一个详情），够用且没有回退迷路的风险。
 */
type ShellView =
  | { kind: 'home' }
  | { kind: 'screen'; route: string; name: string }
  | { kind: 'web'; target: WebPageTarget }
  | { kind: 'works' }
  | { kind: 'market' }
  | { kind: 'chat' }
  | { kind: 'me' };

function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [phase, setPhase] = useState<LoadPhase>({ kind: 'idle' });
  const [updateReady, setUpdateReady] = useState(false);
  const [view, setView] = useState<ShellView>({ kind: 'home' });
  const [webApps, setWebApps] = useState<LaunchItem[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [kbUp, setKbUp] = useState(false);
  /*
    首页默认打开哪个页面。

    大多数人做页面是为了天天用其中某一个（今天排班、本周待办），
    每次都要先看一屏宫格再点进去，等于每天多点一下。首页直接就是它，
    宫格挪到「我的作品」——那才是"管理我做的东西"的地方。
  */
  const [homeKey, setHomeKey] = useState<string | null>(null);
  useEffect(() => { void getDefaultHome().then(setHomeKey); }, []);
  /*
    对话的主语：这次要改哪个页面。跨 tab 保留——用户从首页长按选了一个
    页面进对话，切去创意逛一圈再回来，不该又变回「新页面」。
  */
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  /** 只有自己的页面能改，别人分享来的不列进去。 */
  const [myTargets, setMyTargets] = useState<EditTarget[]>([]);
  const [prefs, setPrefs] = useState({
    autoUpdate: true, wifiOnly: true, voiceTextOnly: true,
    clearDraftOnLogout: false, biometricLock: false,
  });

  // ── 启动：读会话 ────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const t = await session.get();
        if (!t) return;
        setToken(t);
        const res = await fetch(`${API_BASE}/deploy/api/me`, {
          headers: { authorization: `Bearer ${t}` },
        });
        if (res.ok) setMe((await res.json()) as Me);
      } catch {
        // 离线时保持未登录态。内嵌包保证应用仍能打开（expo-updates 默认行为），
        // 这正是设计稿第 10 屏「壳自带的内嵌包离线也能打开」的含义。
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  /**
   * 拉这个人在电脑上做的页面，以及从市场装的别人的页面。
   *
   * 手机端不重新实现一套"我有哪些页面"的判断——服务端已经知道了，
   * 两端各判一次迟早会不一致。
   */
  const loadWebApps = useCallback(async () => {
    if (!token) return;
    setLoadingApps(true);
    const auth = { authorization: `Bearer ${token}` };
    try {
      const [mineRes, instRes] = await Promise.all([
        fetch(`${API_BASE}/deploy/api/apps`, { headers: auth }),
        fetch(`${API_BASE}/deploy/api/installed`, { headers: auth }),
      ]);
      const items: LaunchItem[] = [];
      if (mineRes.ok) {
        const { apps } = (await mineRes.json()) as {
          apps: { id: string; slug: string; name: string; iconLetter: string; status: string }[];
        };
        const mine: EditTarget[] = [];
        for (const a of apps) {
          if (a.status === 'stopped') continue;
          items.push({
            kind: 'web', key: `mine:${a.id}`, name: a.name, letter: a.iconLetter,
            path: `/${me?.user.username ?? ''}/${a.slug}/`,
          });
          mine.push({ slug: a.slug, name: a.name, letter: a.iconLetter });
        }
        setMyTargets(mine);
      }
      if (instRes.ok) {
        const { installed } = (await instRes.json()) as {
          installed: { id: string; slug: string; name: string; icon_letter: string;
                       owner_username: string; owner_name: string }[];
        };
        for (const a of installed) {
          items.push({
            kind: 'web', key: `inst:${a.id}`, name: a.name, letter: a.icon_letter,
            path: `/${a.owner_username}/${a.slug}/`, owner: a.owner_name,
          });
        }
      }
      setWebApps(items);
    } catch {
      // 离线时启动器仍要能开：本机页面包那部分不依赖网络
    } finally { setLoadingApps(false); }
  }, [token, me?.user.username]);

  useEffect(() => { void loadWebApps(); }, [loadWebApps]);

  /**
   * 更新检查：回到前台时补一次。
   *
   * 只在登录那一刻查过一次是不够的——同事在电脑上发了新版，用户这边
   * 什么都不会发生，直到他想起来杀掉 App 重开。而"回到前台"恰好是
   * 用户下一次要用它的时刻，此时提示最有意义。
   */
  const check = useCallback(() => {
    void checkQuietly().then((r) => setUpdateReady(r.available));
  }, []);

  useEffect(() => {
    if (!me) return;
    check();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') check(); });
    return () => sub.remove();
  }, [me, check]);

  const loadMyApp = useCallback(async (user: Me) => {
    const id = await deviceId();
    await switchToUserChannel({
      username: user.user.username,
      deviceId: id,
      onPhase: setPhase,
    });
  }, []);

  if (booting) return <Splash />;

  if (!me) {
    return <LoginScreen onLoggedIn={(m) => { setMe(m); void loadMyApp(m); }} />;
  }

  if (phase.kind === 'incompatible') {
    return (
      <IncompatibleScreen
        requiredRuntime={phase.requiredRuntime}
        currentRuntime={phase.currentRuntime}
        onRetry={() => void loadMyApp(me)}
        onFallback={() => void rollbackToPrevious(me.user.username)}
      />
    );
  }

  if (phase.kind !== 'idle' && phase.kind !== 'up-to-date' && phase.kind !== 'failed') {
    return <LoadingScreen phase={phase} />;
  }

  const bundle = getPageBundle();
  const parsed = parseAppJson(bundle?.appJson ?? {});
  const config: AppJson = parsed.config;
  const v = versionInfo();

  /*
    页面包声明的屏。除首屏外的每一屏都进启动器——用户的第二个、
    第三个页面得有地方去，不能只有 app.json 里声明的那 5 个 tab 位。
  */
  const screenItems: LaunchItem[] = Object.keys(bundle?.screens ?? {}).map((route, i) => ({
    kind: 'screen', key: `screen:${route}`, route,
    name: i === 0 ? (bundle?.title ?? '我的应用') : route.replace(/^\//, '') || '主页',
    letter: (bundle?.title ?? '应').slice(0, 1),
  }));
  // 市场已是底部栏的常驻 tab，启动器里不必再放一行入口
  const launchItems: LaunchItem[] = [...screenItems, ...webApps];
  /*
    单页应用（home:'page' 且只有一屏、也没有别的页面）直接进那一屏——
    为一个东西画一屏宫格是没话找话。多于一个才需要启动器。
  */
  const soloPage = config.home === 'page' && screenItems.length === 1 && webApps.length === 0;

  /*
    首页要渲染的那个页面。选过但已经不在了（删了 / 改名）就当没选过——
    停在一个打不开的东西上比空着更糟。
  */
  const homeItem = homeKey ? launchItems.find((i) => i.key === homeKey) : undefined;

  const openItem = (it: LaunchItem) => {
    if (it.kind === 'market') setView({ kind: 'market' });
    else if (it.kind === 'web') setView({ kind: 'web', target: { path: it.path, title: it.name } });
    else setView({ kind: 'screen', route: it.route, name: it.name });
  };

  if (view.kind === 'web') {
    return <WebPage target={view.target} token={token} onBack={() => setView({ kind: 'home' })} />;
  }
  /* 底部四个 tab 都是壳自己的屏，切换只是换 view，不入栈 */
  const goTab = (t: ShellTab) => setView({ kind: t });

  if (view.kind === 'works') {
    return (
      <View style={{ flex: 1 }}>
        <Launcher
          items={launchItems}
          loading={loadingApps}
          homeKey={homeKey}
          onRefresh={() => void loadWebApps()}
          onOpen={openItem}
          onNew={() => { setEditTarget(null); setView({ kind: 'chat' }); }}
          onSetHome={(it) => {
            const next = homeKey === it.key ? null : it.key;
            setHomeKey(next);
            void setDefaultHome(next);
          }}
          onEdit={(it) => {
            const slug = it.kind === 'web' ? it.path.split('/').filter(Boolean)[1] : undefined;
            const t = slug ? myTargets.find((m) => m.slug === slug) : undefined;
            if (t) { setEditTarget(t); setView({ kind: 'chat' }); }
          }}
        />
        <ShellTabs active="works" onChange={goTab} />
      </View>
    );
  }

  if (view.kind === 'market') {
    return (
      <View style={{ flex: 1 }}>
        <Market token={token} onChanged={() => void loadWebApps()} />
        <ShellTabs active="market" onChange={goTab} />
      </View>
    );
  }

  /*
    对话是从「我的作品」进来的一层，不是一个 tab。
    它有返回、没有底栏——进来时已经带着主语（改哪个页面，或做个新的），
    做完就退回作品列表，不是一个要常驻的去处。
  */
  if (view.kind === 'chat') {
    return (
      <AgentChat
        username={me.user.username}
        target={editTarget}
        targets={myTargets}
        onPickTarget={setEditTarget}
        onKeyboard={setKbUp}
        onBack={() => setView({ kind: 'works' })}
      />
    );
  }

  if (view.kind === 'me') {
    return (
      <View style={{ flex: 1 }}>
        <Settings
          user={me.user}
          spaceUrl={me.spaceUrl}
          bundleVersion={v.updateId ? v.updateId.slice(0, 8) : '内嵌包'}
          updateChannel={channelNameFor(me.user.username)}
          autoUpdate={prefs.autoUpdate}
          wifiOnly={prefs.wifiOnly}
          voiceTextOnly={prefs.voiceTextOnly}
          clearDraftOnLogout={prefs.clearDraftOnLogout}
          biometricLock={prefs.biometricLock}
          onToggle={(k: SettingKey, val) => {
            setPrefs((p) => ({ ...p, [k]: val }));
            if (k === 'biometricLock' && val) void unlockWithBiometrics('开启后回到应用需要验证');
          }}
          onCheckUpdate={() => void checkQuietly().then((r) => setUpdateReady(r.available))}
          onRollback={() => void rollbackToPrevious(me.user.username)}
          onLogout={() => { setMe(null); setView({ kind: 'home' }); }}
          onClose={() => goTab('home')}
        />
        <ShellTabs active="me" onChange={goTab} />
      </View>
    );
  }

  if (view.kind === 'home' && homeItem?.kind === 'web') {
    return (
      <View style={{ flex: 1 }}>
        {/* 首页是根：不给返回键，出口是底下那条 tab */}
        <WebPage target={{ path: homeItem.path, title: homeItem.name }} token={token} />
        <ShellTabs active="home" onChange={goTab} />
      </View>
    );
  }

  const bundleContent = bundle ? (
    <NavContainer
      config={config}
      screens={bundle.screens}
      title={bundle.title}
      {...(view.kind === 'screen' ? { forceRoute: view.route } : {})}
    />
  ) : (
    <NoBundleScreen
      username={me.user.username}
      onLoad={() => void loadMyApp(me)}
      error={phase.kind === 'failed' ? phase.message : parsed.error}
    />
  );

  return (
    <ShellChrome
      appJson={config}
      // 首页有底部栏，设置走「我」；进到页面内容里没有 tab，才需要齿轮
      {...(view.kind === 'screen' || soloPage ? { onOpenSettings: () => goTab('me') } : {})}
      hasUpdate={updateReady}
      onApplyUpdate={() => void applyUpdate(setPhase)}
      {...(view.kind === 'screen' ? { onBack: () => setView({ kind: 'home' }) } : {})}
    >
      {/*
        首页就是首页。
        原先由身份决定首页形态（使用者看应用、开发者看对话页）——那是在
        只有一屏可用时的折中：想跟 Agent 说话就得把整个首页换掉。现在
        对话是底部栏里的一个 tab，两者可以同时存在，身份不必再管导航。
        它仍然决定服务端放不放行 Agent，那是权限，不是布局。
      */}
      {view.kind === 'screen' || soloPage || bundle ? (
        bundleContent
      ) : (
        <HomeUnset onPick={() => setView({ kind: 'works' })} />
      )}

      {/*
        壳的底部导航只在首页出现。
        进到具体页面（view.kind === 'screen'）就交出整块屏幕——页面可能
        自带底部操作条，两条叠在一起谁都点不准。开发者的对话页同理，
        输入框本来就在最下面。

        单页应用（soloPage）也保留这条：它没有启动器，市场就成了到不了的
        地方，而那正是他去看别人做了什么的唯一入口。
      */}
      {view.kind === 'home' && <ShellTabs active="home" onChange={goTab} />}

      {updateReady && (
        <UpdateCard
          bundleVersion={0}
          runtimeVersion={v.runtimeVersion}
          rolloutPercent={100}
          notes={['你的应用有新版本']}
          onLater={() => setUpdateReady(false)}
          onReload={() => void applyUpdate(setPhase)}
        />
      )}
    </ShellChrome>
  );
}

/**
 * 品牌标记。
 *
 * 画出来而不是 require 一张图——因为 assets/icon.png 同时是 app.json 里的
 * 应用图标。那个文件在构建期被 prebuild 拿去生成启动器图标，**不会**再进
 * JS 的资源登记表，于是运行时 require 到的是空的：ImageView 照常占位，
 * 就是不显示任何东西，也不报错。查了半天才发现。
 *
 * 而这个标记本身只是一个圆角方块加两个字母，画出来还省掉了把 1024px
 * 位图缩到 48pt 的开销，任意尺寸都清晰。
 */
function BrandMark({ size = 48 }: { size?: number }) {
  return (
    <View
      accessible={false}
      style={{
        width: size, height: size,
        // 圆角取边长的 27%，与 packages/brand/mark.svg 一致
        borderRadius: size * 0.27,
        backgroundColor: '#fb923c',
        alignItems: 'center', justifyContent: 'center',
        marginBottom: 10,
      }}
    >
      <Text style={{
        color: '#fff', fontWeight: '700', fontSize: size * 0.42,
        letterSpacing: size * 0.01,
      }}>
        AI
      </Text>
    </View>
  );
}

// ── 登录（设计稿第 10 屏）──────────────────────────────────────────
/**
 * 登录 / 注册（设计稿第 10 屏）。
 *
 * 改为邮箱 + 密码，与桌面端同一套账号。原先的 SSO 深链方案保留在
 * openSsoAndAwait 里——配了 OIDC_* 时会多出一个入口，没配就只有密码。
 *
 * 手机上不做注册时的「空间标识」自定义：那一栏在小屏上很难解释清楚，
 * 而且注册这件事一辈子做一次，在电脑上做更合适。手机端只留登录，
 * 注册引导到桌面端——除非用户坚持，那就用邮箱推导出的默认标识。
 */
function LoginScreen({ onLoggedIn }: { onLoggedIn: (m: Me) => void }) {
  const insets = useSafeAreaInsets();
  const v = versionInfo();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    void fetch(`${API_BASE}/deploy/api/auth/policy`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ssoEnabled?: boolean } | null) => setSsoEnabled(Boolean(d?.ssoEnabled)))
      .catch(() => setSsoEnabled(false));
  }, []);

  const login = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${API_BASE}/deploy/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = (await r.json()) as { token?: string; message?: string };
      if (!r.ok || !body.token) throw new Error(body.message ?? '登录失败');

      await session.set(body.token);
      const meRes = await fetch(`${API_BASE}/deploy/api/me`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      if (!meRes.ok) throw new Error('登录成功但取不到账号信息');
      onLoggedIn((await meRes.json()) as Me);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (scanning) {
    return (
      <QrScanScreen
        onDone={(m) => { setScanning(false); if (m) onLoggedIn(m); }}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[s.center, { paddingTop: insets.top }]}>
        <BrandMark />
        <Text style={s.greeting}>Happy Working</Text>
        <Text style={s.title}>你的专属应用</Text>

        <View style={s.form}>
          <TextInput
            style={s.input}
            value={email}
            onChangeText={setEmail}
            placeholder="公司邮箱"
            placeholderTextColor="#909599"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            editable={!busy}
          />
          <TextInput
            style={s.input}
            value={password}
            onChangeText={setPassword}
            placeholder="密码"
            placeholderTextColor="#909599"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="password"
            editable={!busy}
            onSubmitEditing={() => { if (email.trim() && password) void login(); }}
          />
          {err && <Text style={s.formErr}>{err}</Text>}
          <Pressable
            style={[s.btn, s.btnPrimary, (busy || !email.trim() || !password) && { opacity: 0.4 }]}
            disabled={busy || !email.trim() || !password}
            onPress={() => void login()}
          >
            <Text style={s.btnPrimaryText}>{busy ? '登录中…' : '登录'}</Text>
          </Pressable>

          {ssoEnabled && (
            <Pressable
              style={s.linkBtn}
              onPress={() => { void openSsoAndAwait().then((m) => m && onLoggedIn(m)); }}
            >
              <Text style={s.linkText}>用公司账号（SSO）登录</Text>
            </Pressable>
          )}
        </View>

        {/* 扫码登录（设计稿第 10 屏的次要入口）：电脑上已登录的话，
            头像菜单里生成二维码，扫一下就不用在手机上敲密码。 */}
        <Pressable style={s.linkBtn} onPress={() => setScanning(true)} disabled={busy}>
          <Text style={s.linkText}>扫码登录</Text>
        </Pressable>

        {/* 注册引导到桌面端：空间标识那一栏在小屏上很难解释清楚，
            而它是长期对外的地址，值得在电脑前想清楚再定。 */}
        <Text style={s.hintText}>
          还没有账号？在电脑上打开 {'\n'}{DISPLAY_HOST} 注册
        </Text>

        <Text style={s.footnote}>
          壳 {SHELL_VERSION} · runtimeVersion {v.runtimeVersion}
          {'\n'}{DISPLAY_HOST}/updates
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * 扫码登录的取景屏。
 *
 * 桌面端（已登录）在头像菜单里生成一个 60 秒的一次性码显示成二维码，
 * 这里扫到后用它换会话——手机有摄像头、桌面有会话，各出各的，
 * 不用在手机上敲一遍密码。
 *
 * 码的格式是 `ispace-login:{uuid}`。故意不用 URL：普通相机 App 扫到
 * 也只是一串认不出的文本，不会跳去任何地方，码也不会落进浏览器历史。
 */
function QrScanScreen({ onDone }: { onDone: (m: Me | null) => void }) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 相机每秒能回调几十次同一个码，必须锁住首个，否则同一个码会被
  // exchange 两次——第二次必然失败（用一次即毁），反而把成功盖成报错
  const locked = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  const onScanned = async (data: string) => {
    if (locked.current || busy) return;
    if (!data.startsWith('ispace-login:')) return;   // 别人的二维码，静默忽略
    locked.current = true;
    setBusy(true); setErr(null);
    try {
      const code = data.slice('ispace-login:'.length);
      const r = await fetch(`${API_BASE}/deploy/api/auth/native/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = (await r.json()) as { token?: string; message?: string };
      if (!r.ok || !body.token) throw new Error(body.message ?? '这个码不对或已过期');

      await session.set(body.token);
      const meRes = await fetch(`${API_BASE}/deploy/api/me`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      if (!meRes.ok) throw new Error('登录成功但取不到账号信息');
      onDone((await meRes.json()) as Me);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
      // 出错后放开锁：码过期是常态（60 秒），让人在电脑上点「重新生成」再扫
      locked.current = false;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {permission?.granted ? (
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => void onScanned(data)}
        />
      ) : (
        <View style={[s.center, { backgroundColor: '#000' }]}>
          <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center', lineHeight: 24 }}>
            需要相机权限才能扫码。{'\n'}
            {permission?.canAskAgain === false
              ? '请到系统设置里给 iSpace 打开相机权限。'
              : '正在请求权限…'}
          </Text>
        </View>
      )}

      {/* 顶部说明与取消，压在取景之上 */}
      <View style={{
        position: 'absolute', left: 0, right: 0, top: insets.top,
        alignItems: 'center', paddingTop: 16, gap: 10,
      }}>
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
          扫电脑上的登录二维码
        </Text>
        <Text style={{ color: 'rgba(255,255,255,.75)', fontSize: 12, textAlign: 'center', paddingHorizontal: 40, lineHeight: 18 }}>
          电脑上打开 {API_BASE.replace('http://', '')}，点右上角头像 → 手机扫码登录
        </Text>
        {err && (
          <Text style={{ color: '#ffb4a1', fontSize: 13, paddingHorizontal: 32, textAlign: 'center' }}>
            {err}
          </Text>
        )}
        {busy && <Text style={{ color: '#fff', fontSize: 13 }}>登录中…</Text>}
      </View>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 24, alignItems: 'center' }}>
        <Pressable
          onPress={() => onDone(null)}
          style={{ paddingVertical: 12, paddingHorizontal: 36, borderRadius: 24, backgroundColor: 'rgba(255,255,255,.18)' }}
        >
          <Text style={{ color: '#fff', fontSize: 15 }}>取消</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * SSO 登录。
 *
 * 走系统浏览器而非内嵌 WebView：企业 IdP 通常拒绝在 WebView 里完成登录
 * （出于防钓鱼考虑），且系统浏览器能复用已有的公司登录态。
 * 回跳经 scheme ispace:// 深链，token 由壳存入 SecureStore。
 */
async function openSsoAndAwait(): Promise<Me | null> {
  const WebBrowser = await import('expo-web-browser');

  /**
   * 先向服务端登记一个配对 id，再开浏览器，然后轮询把令牌取回来。
   *
   * 为什么不靠深链回跳兑现 Promise：实测荣耀机上 Chrome 送来的 intent 带
   * FLAG_ACTIVITY_CLEAR_TOP，配 singleTask 会重建 Activity，
   * openAuthSessionAsync 的 Promise 就此消失——用户看到的是"登录完又回到
   * 登录页"，而且没有任何报错。各家 ROM 行为不一致，这条路不可靠。
   *
   * 轮询则与深链是否送达无关：Activity 重建也好、用户手动切回来也好，
   * 令牌都在服务端等着被取走。深链仍保留为快路径——它先到就先关浏览器。
   */
  const pairRes = await fetch(`${API_BASE}/deploy/api/auth/native/pair`, { method: 'POST' });
  if (!pairRes.ok) return null;
  const { pairingId } = (await pairRes.json()) as { pairingId: string };

  const url =
    `${API_BASE}/deploy/api/auth/login?pairing=${encodeURIComponent(pairingId)}`;

  /**
   * 用 openBrowserAsync 而不是 openAuthSessionAsync。
   *
   * 后者为了截获深链回跳会挂一套 Linking 监听，并在部分 ROM 上把浏览器
   * 拉进独立 task——实测荣耀机上关掉浏览器后回到的是**另一个** App 实例，
   * 正在轮询的那个还在后台，于是屏幕上仍是登录页。
   *
   * 既然改成轮询，就完全不需要深链，也就不需要那套机制。
   * 普通浏览器窗口回来的是同一个实例。
   */
  void WebBrowser.openBrowserAsync(url).catch(() => undefined);

  const token = await pollForToken(pairingId);
  // 拿到了就把浏览器收掉，用户不用自己按返回
  WebBrowser.dismissBrowser?.();
  if (!token) return null;

  await session.set(token);
  const res = await fetch(`${API_BASE}/deploy/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok ? ((await res.json()) as Me) : null;
}

/**
 * 轮询直到拿到令牌。
 *
 * 5 分钟上限与服务端的配对有效期一致——超了服务端也已经把它删了，
 * 再问下去只会一直拿到 expired。间隔 1.5 秒：人在浏览器里操作要几十秒，
 * 更密只是白耗电，更疏则登录完还要干等。
 */
async function pollForToken(pairingId: string): Promise<string | null> {
  const deadline = Date.now() + 5 * 60_000;

  const once = async (): Promise<string | null | 'pending'> => {
    try {
      const r = await fetch(
        `${API_BASE}/deploy/api/auth/native/poll?id=${encodeURIComponent(pairingId)}`,
      );
      if (!r.ok) return 'pending';
      const body = (await r.json()) as { status: string; token?: string };
      if (body.status === 'ok' && body.token) return body.token;
      if (body.status === 'expired') return null;
      return 'pending';
    } catch {
      // 网络抖动不该中断整个登录，当作还没好，继续等
      return 'pending';
    }
  };

  /**
   * 除了定时轮询，还要在 App 回到前台时立刻补一次。
   *
   * 实测荣耀机（HyperHold 后台冻结）在切去浏览器后会把 JS 定时器冻住，
   * 于是整个登录期间只发出了一次轮询——回到前台后循环也醒不过来，
   * 表现为"登录完了但 App 还停在登录页"。各家国产 ROM 的省电策略都类似，
   * 所以不能只依赖 setTimeout。AppState 变 active 是最可靠的唤醒点：
   * 用户从浏览器回到 App 的那一刻，正是令牌已经就绪的时刻。
   */
  let wake: (() => void) | null = null;
  const sub = AppState.addEventListener('change', (st) => {
    if (st === 'active') wake?.();
  });

  try {
    while (Date.now() < deadline) {
      const r = await once();
      if (r !== 'pending') return r;
      await new Promise<void>((resolve) => {
        wake = resolve;
        const t = setTimeout(resolve, 1500);
        // 谁先到算谁的；重复 resolve 是无害的
        void t;
      });
      wake = null;
    }
  } finally {
    sub.remove();
  }
  return null;
}

// ── 加载中（设计稿：就地显示加载进度，不外露通道细节）──────────────
function LoadingScreen({ phase }: { phase: LoadPhase }) {
  const text =
    phase.kind === 'switching' ? '正在准备你的应用'
    : phase.kind === 'checking' ? '正在检查更新'
    : phase.kind === 'downloading' ? '正在下载'
    : '即将就绪';
  return (
    <View style={s.center}>
      <ActivityIndicator color="#fb923c" />
      <Text style={[s.body, { marginTop: 14 }]}>{text}</Text>
    </View>
  );
}

function NoBundleScreen({
  username, onLoad, error,
}: { username: string; onLoad: () => void; error?: string }) {
  return (
    <View style={s.center}>
      <Text style={s.title}>还没有加载你的应用</Text>
      <Text style={s.body}>
        你的空间 /{username} 下还没有发布过手机页面包，或尚未下载到本机。
      </Text>
      {/* 既可能是页面声明不合法，也可能是刚才那次加载抛了错。
          必须展示出来：这块屏静默吞错时，"加载失败"和"确实没发过版"
          看起来一模一样，排查只能靠服务端日志倒推。 */}
      {error && <Text style={s.errText}>没能加载：{error}</Text>}
      <Pressable style={[s.btn, s.btnPrimary]} onPress={onLoad}>
        <Text style={s.btnPrimaryText}>重新加载</Text>
      </Pressable>
    </View>
  );
}

/**
 * 首页还没定下来时的落点。
 *
 * 不自作主张挑一个：用户有好几个页面时，替他选错了比空着更让人困惑
 * ——他会以为 App 坏了或者页面被换了。这里只说清怎么定。
 */
function HomeUnset({ onPick }: { onPick: () => void }) {
  return (
    <View style={s.center}>
      <Text style={s.title}>把常用的那个放到首页</Text>
      <Text style={s.body}>
        每天都要看的那个页面，设成首页之后打开 App 直接就是它，不用再点一次。
        去「我的作品」里长按任意一个页面就能设。
      </Text>
      <Pressable style={[s.btn, s.btnPrimary]} onPress={onPick}>
        <Text style={s.btnPrimaryText}>去我的作品</Text>
      </Pressable>
    </View>
  );
}

function Splash() {
  return <View style={s.center}><ActivityIndicator color="#fb923c" /></View>;
}

const s = StyleSheet.create({
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: 32, gap: 8, backgroundColor: '#fcfcf8',
  },
  /**
   * 与桌面端登录页一致：Caveat 手写体、26px、常规字重。
   *
   * 设计稿在这两处本身不一致（手机端写的是 Happy tabby），按产品要求统一。
   * 字体由 expo-font 在构建期嵌入，fontFamily 用的是 TTF 里的家族名，
   * 不是文件名——写错了安卓会静默回落到系统字体，看着"像没生效"。
   */
  greeting: { fontFamily: 'Caveat-Regular', fontSize: 26, lineHeight: 31, color: '#1c1f23' },
  title: { fontSize: 18, fontWeight: '700', color: '#001217', marginTop: 4 },
  body: { fontSize: 14, color: '#545659', textAlign: 'center', lineHeight: 21 },
  errText: { fontSize: 12, color: '#f8672f', textAlign: 'center' },
  footnote: { fontSize: 11, color: '#909599', textAlign: 'center', marginTop: 20, lineHeight: 17 },
  btn: {
    height: 46, borderRadius: 12, paddingHorizontal: 28,
    alignItems: 'center', justifyContent: 'center', marginTop: 18,
  },
  btnPrimary: { backgroundColor: '#1c1f23' },
  btnPrimaryText: { color: '#fff', fontSize: 15, fontWeight: '500' },

  // ── 登录表单 ───────────────────────────────────────────────────────
  form: { width: '100%', maxWidth: 320, marginTop: 20, gap: 10 },
  input: {
    height: 46, borderRadius: 12, borderWidth: 1, borderColor: '#e8e8e0',
    backgroundColor: '#fff', paddingHorizontal: 14, fontSize: 15, color: '#001217',
  },
  formErr: { fontSize: 12, color: '#f8672f', lineHeight: 18 },
  linkBtn: { alignItems: 'center', paddingVertical: 10 },
  linkText: { fontSize: 13, color: '#545659', textDecorationLine: 'underline' },
  hintText: {
    fontSize: 12, color: '#909599', textAlign: 'center', lineHeight: 19, marginTop: 14,
  },
});

export { Updates };
