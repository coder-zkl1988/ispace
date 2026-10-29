/**
 * 平台 chrome（技术方案 §4.7、规格 §5.1）。
 *
 * 由部署服务在发布期注入用户产物的 index.html：
 *   <script data-ispace-shell src="/platform/shell.js" defer></script>
 *
 * 三重不污染保障：
 *   1. Shadow DOM 封装 —— 样式与用户应用双向隔离，用户的 `* { margin: 0 }`
 *      进不来，本组件的样式也出不去
 *   2. 固定定位 + body 顶部偏移 —— 把用户页面整体下移而非遮挡内容
 *   3. 独立命名空间 —— 全部逻辑在 IIFE 内，只在 window 上留一个只读标记，
 *      与接管 document 的 SPA 不冲突
 *
 * 访问语义全局统一：任何人访问任何 /{user}/{app}/ 页面均可见 header，
 * 右侧显示**访问者本人**的登录态与控制台入口——保证分享出去的页面上，
 * 访问者始终有回到自己空间的路径。
 */

interface Me {
  user: { username: string; displayName: string; role: string };
  spaceUrl: string;
}

const TAG = 'ispace-chrome';
const HEIGHT = 44;
/*
 * 默认收起，只记「人主动展开过」。
 *
 * 旧键 ispace.chrome.collapsed 不能沿用：以前每次挂载都会把当前状态写回去，
 * 几乎每个浏览器里都存着 '0'（展开），按它读就等于默认改不过来。
 */
const STORAGE_KEY = 'ispace.chrome.expanded';
const API_ME = '/deploy/api/me';
const LOGIN_URL = '/deploy/api/auth/login';
const BRAND_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="276" fill="#fb923c"/><path d="M216 304Q216 280 239 272L464 208Q488 201 488 226V766Q488 787 468 794L239 858Q216 865 216 840Z" fill="#fff"/><path d="M280 350L424 309V711L280 752Z" fill="#fb923c"/><path d="M536 226Q536 201 560 208L785 272Q808 280 808 304V840Q808 865 785 858L556 794Q536 787 536 766Z" fill="#fff"/><path d="M600 309L744 350V752L600 711Z" fill="#fb923c"/></svg>';

// 设计稿 Tabby 设计系统的 token 子集。这里内联而非引用 packages/ui，
// 因为 shell.js 必须是零依赖单文件——它要注入到任意用户页面，
// 多一个网络请求就多一次可能失败的加载。
const STYLES = `
:host { all: initial; }
.bar {
  position: fixed; top: 0; left: 0; right: 0; height: ${HEIGHT}px;
  display: flex; align-items: center; gap: 12px; padding: 0 14px;
  box-sizing: border-box;
  background: rgba(255,255,255,.82);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 1px solid rgba(0,0,0,.06);
  font: 400 13px/1.4 "Manrope", -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  color: #1c1f23;
  z-index: 2147483000;
}
.logo {
  width: 22px; height: 22px; border-radius: 6px; flex: none;
  overflow: hidden;
}
.logo img { width: 100%; height: 100%; display: block; }
.path { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; color: #545659; }
.path b { color: #1c1f23; font-weight: 500; }
.spacer { flex: 1 1 auto; }
.btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border: 1px solid rgba(0,0,0,.08); border-radius: 8px; background: #fff;
  color: #1c1f23; text-decoration: none; font-size: 12px; cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.btn:hover { background: #f5f5f3; border-color: rgba(0,0,0,.12); }
.btn.primary { background: #1c1f23; color: #fff; border-color: #1c1f23; }
.btn.primary:hover { background: #222b39; }
.avatar {
  width: 24px; height: 24px; border-radius: 50%; flex: none;
  background: #fff6ed; color: #fb923c; display: grid; place-items: center;
  font-size: 11px; font-weight: 600;
}
.who { color: #545659; font-size: 12px; }
.fold {
  width: 24px; height: 24px; border: none; background: transparent; cursor: pointer;
  color: #787c80; border-radius: 6px; display: grid; place-items: center; font-size: 14px;
}
.fold:hover { background: rgba(0,0,0,.05); color: #1c1f23; }

/* 折叠态：收成角落小胶囊，满足投屏等全屏场景（技术方案 §4.7） */
.pill {
  position: fixed; top: 8px; right: 8px; height: 28px; padding: 0 10px;
  display: inline-flex; align-items: center; gap: 6px;
  background: rgba(255,255,255,.9);
  -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
  border: 1px solid rgba(0,0,0,.08); border-radius: 100px;
  box-shadow: 0 2px 8px rgba(0,0,0,.04);
  font: 400 12px/1 "Manrope", system-ui, sans-serif; color: #1c1f23;
  cursor: pointer; z-index: 2147483000;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #fb923c; }
.hidden { display: none !important; }
@media (max-width: 640px) { .path, .who { display: none; } }
`;

// ── 手机页面在电脑上打开：套手机框 ──────────────────────────────────
/**
 * 手机页面（发布时标成 h5 的）在电脑上打开，按手机尺寸套一个框显示。
 *
 * 原来在电脑上打开就是撑满整个窗口的"电脑版"——手机页面在这个宽度下要么
 * 被拉成一条大横幅，要么一条窄栏两边大片空白，作者想给人看的那个手机上的
 * 样子反而看不到。线上年会抽奖就是这样。
 *
 * 只在真电脑上套（够宽 + 有鼠标）；手机、平板、App 壳里原样显示。已经在
 * 框里（这个手机框里、平台的预览框里）就不再套。地址后加 ?ispace_full=1
 * 可以看电脑宽度的样子，框下面那颗按钮就是它。
 */
const FULL_PARAM = 'ispace_full';
/** 框里那份页面的地址标记。浏览器不许 iframe 装和祖先一模一样的地址（防无限嵌套）。 */
const IN_PHONE_PARAM = 'ispace_in_phone';

function shouldFramePhone(): boolean {
  if (window.self !== window.top) return false;
  if (/ iSpaceApp\//.test(navigator.userAgent)) return false;
  const q = new URLSearchParams(location.search);
  if (q.has(FULL_PARAM) || q.has(IN_PHONE_PARAM)) return false;
  return matchMedia('(min-width: 768px) and (hover: hover) and (pointer: fine)').matches;
}

const PHONE_STYLES = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483646;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  background: #ecebe6; color: #545659;
  font: 400 13px/1.4 -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif; }
.phone { height: min(844px, calc(100vh - 88px)); aspect-ratio: 390 / 844; box-sizing: border-box;
  padding: 10px; border-radius: 46px; background: #111;
  box-shadow: 0 40px 80px -30px rgba(0,0,0,.45), 0 0 0 1px rgba(0,0,0,.2); }
.screen { display: block; width: 100%; height: 100%; border: 0; border-radius: 36px; background: #fff; }
.cap { display: flex; align-items: center; gap: 10px; }
.cap a { color: #1c1f23; text-decoration: none; border: 1px solid rgba(0,0,0,.12);
  border-radius: 8px; padding: 4px 10px; background: #fff; }
.cap a:hover { border-color: rgba(0,0,0,.24); }
`;

function framePhone(app: string): void {
  /*
    先把外面这份页面自己的脚本拦下：shell.js 对手机页面是放在 <head> 最前面
    同步加载的，此刻页面的脚本一个都还没跑。不拦的话外面藏着的这份和框里
    那份会各跑一遍——音效、计时器、存储写两次。拦不住的浏览器（不认脚本插入
    的 CSP meta）也只是多跑一遍、看不见，不影响框里那份。
  */
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "script-src 'none'";
  const hide = document.createElement('style');
  hide.textContent = 'html{overflow:hidden!important}body{display:none!important}';
  (document.head ?? document.documentElement).prepend(csp, hide);

  const host = document.createElement('ispace-phone');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = PHONE_STYLES;

  const phone = document.createElement('div');
  phone.className = 'phone';
  const screen = document.createElement('iframe');
  screen.className = 'screen';
  const inner = new URL(location.href);
  inner.searchParams.set(IN_PHONE_PARAM, '1');
  screen.src = inner.href;
  screen.title = document.title || app;
  screen.allow = 'autoplay; clipboard-write; fullscreen; microphone; camera; geolocation';
  phone.append(screen);

  const cap = document.createElement('div');
  cap.className = 'cap';
  const full = new URL(location.href);
  full.searchParams.set(FULL_PARAM, '1');
  const wide = document.createElement('a');
  wide.href = full.href;
  wide.textContent = '按电脑宽度打开';
  cap.append(document.createTextNode('这是手机页面，按手机尺寸显示'), wide);

  shadow.append(style, phone, cap);
  document.documentElement.append(host);
}

(function ispaceChrome() {
  /* 只有同步执行的这一刻拿得到。手机页面靠它上面的 data-device 认出来 */
  const thisScript = document.currentScript as HTMLScriptElement | null;

  // 幂等：SPA 反复注入或用户手工引了两次也只渲染一个
  if ((window as unknown as Record<string, unknown>).__ispaceChrome) return;
  Object.defineProperty(window, '__ispaceChrome', { value: true, writable: false });

  // 只在用户空间路径下渲染。平台自身页面（portal/console）有自己的 header，
  // 再套一层会出现两条栏。
  const seg = location.pathname.split('/').filter(Boolean);
  if (seg.length < 2) return;
  const [owner, app] = seg as [string, string];

  /* 手机页面在电脑上：外面这层只负责套框，访问量与 header 都交给框里那份 */
  if (thisScript?.dataset.device === 'phone' && shouldFramePhone()) {
    framePhone(app);
    return;
  }

  /*
    访问量：一次页面加载打一下，不分是不是在原生壳的 WebView 里——
    手机上打开也是一次真实的访问，不该只因为跳过了下面的 header 渲染就
    漏计。fire-and-forget：这一下失败或变慢绝不能影响页面本身，
    因此不 await、错误静默吞掉，也不重试。
  */
  void fetch('/deploy/api/visits/app', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner, slug: app }),
  }).catch(() => { /* 掉一次不影响任何人，不重试 */ });

  const host = document.createElement(TAG);
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.append(style);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const pill = document.createElement('div');
  pill.className = 'pill hidden';
  const dot = document.createElement('span');
  dot.className = 'dot';
  pill.append(dot, document.createTextNode('ispace'));
  shadow.append(bar, pill);

  const setCollapsed = (v: boolean, remember = true) => {
    bar.classList.toggle('hidden', v);
    pill.classList.toggle('hidden', !v);
    // 只有展开态才占位；折叠时把页面还原，避免顶部留白
    document.documentElement.style.setProperty(
      'padding-top',
      v ? '' : `${HEIGHT}px`,
      'important',
    );
    if (remember) {
      try { localStorage.setItem(STORAGE_KEY, v ? '0' : '1'); } catch { /* 隐私模式下会抛，忽略 */ }
    }
  };

  pill.addEventListener('click', () => setCollapsed(false));

  const render = (me: Me | null) => {
    bar.textContent = '';

    const logo = document.createElement('div');
    logo.className = 'logo';
    const logoImage = document.createElement('img');
    logoImage.alt = '';
    logoImage.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(BRAND_MARK_SVG)}`;
    logo.append(logoImage);

    // owner/app 解析自 location.pathname，是 URL 可控内容，一律走
    // textContent 构造，绝不拼进 innerHTML——本仓库的扫描器有一条
    // innerHTML-from-variable 规则专门拦这个模式。
    const path = document.createElement('span');
    path.className = 'path';
    const ownerEl = document.createElement('b');
    ownerEl.textContent = owner;
    path.append(
      document.createTextNode(`${location.host}/`),
      ownerEl,
      document.createTextNode(`/${app}`),
    );

    const spacer = document.createElement('div');
    spacer.className = 'spacer';

    bar.append(logo, path, spacer);

    if (me) {
      // 访问者是本人还是串门，用文案区分——这是同源共享架构下
      // 让人知道"我在谁的空间里"的唯一提示
      if (me.user.username !== owner) {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = `你正在访问 ${owner} 的页面`;
        bar.append(who);
      }

      const console_ = document.createElement('a');
      console_.className = 'btn';
      console_.href = '/console';
      console_.textContent = '控制台';

      const mine = document.createElement('a');
      mine.className = 'btn primary';
      mine.href = `/${me.user.username}/`;
      mine.textContent = '我的空间';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.title = `${me.user.displayName}（${me.user.username}）`;
      avatar.textContent = me.user.displayName.slice(0, 1);

      bar.append(console_, mine, avatar);
    } else {
      const login = document.createElement('a');
      login.className = 'btn primary';
      login.href = `${LOGIN_URL}?redirect=${encodeURIComponent(location.pathname)}`;
      login.textContent = '登录';
      bar.append(login);
    }

    const fold = document.createElement('button');
    fold.className = 'fold';
    fold.title = '收起';
    fold.textContent = '×';
    fold.addEventListener('click', () => setCollapsed(true));
    bar.append(fold);
  };

  const mount = () => {
    document.documentElement.append(host);
    /*
      默认收起：页面打开时整屏都是作者的内容，顶部只留一颗小标记，
      点开才是那条 header。人主动展开过，下次就照他的习惯展开。
    */
    let expanded = false;
    try { expanded = localStorage.getItem(STORAGE_KEY) === '1'; } catch { /* 忽略 */ }
    setCollapsed(!expanded, false);
  };

  /**
   * 在手机 App 的壳里就不要再画一条 header 了。
   *
   * 这条 bar 的全部价值是「让访问者随时能回到自己的空间」。在 App 里，
   * 那件事由原生壳负责——它有返回、有设置、有启动器。两层 chrome 叠在
   * 一起既重复又占掉整整一屏的顶部，页面反而看不成页面。
   *
   * 认 UA 而不是 URL 参数：WebView 里的页面可能自己跳转到子页面，
   * 参数会丢，UA 不会。原生壳用 applicationNameForUserAgent 追加这一段。
   */
  const inNativeShell = / iSpaceApp\//.test(navigator.userAgent);

  if (inNativeShell) {
    // 什么都不挂。留下标记，页面若想自行适配（比如让出状态栏）能读到。
    try {
      Object.defineProperty(window, '__ispaceNativeShell', { value: true, writable: false });
    } catch { /* 页面已定义过就算了 */ }
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  // 先以未登录态渲染再异步补登录信息：header 不能等接口返回才出现，
  // 否则页面会在加载后跳一下高度。
  // App 内整条 bar 都不存在，这一次 /me 请求也就没有意义。
  if (!inNativeShell) {
    render(null);
    fetch(API_ME, { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
      .then(render)
      .catch(() => { /* 接口不可用时保持未登录态，不影响用户页面 */ });
  }
})();
