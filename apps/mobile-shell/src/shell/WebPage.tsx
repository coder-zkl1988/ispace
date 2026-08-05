import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, BackHandler, Pressable, StatusBar, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Icon } from './Icon';
import { API_BASE } from '../config';

/**
 * 在壳内打开用户在电脑上做的静态页面（H5），并让它尽量不像浏览器。
 *
 * 「类原生」在这里是具体的几件事，不是形容词：
 *   - 沉浸式：页面铺到状态栏后面，没有地址栏、没有标题栏，只留一枚悬浮返回
 *   - 平台注入的网页版 iSpace header 在 App 内自我隐藏（靠 UA 识别），
 *     否则两层 chrome 叠起来能吃掉整整一屏顶部
 *   - 进页面前先换到浏览器会话，用户不用在 WebView 里再登一次
 *   - 首屏给进度条而不是白屏；失败给可点的重试，而不是浏览器的报错页
 *   - 安卓实体返回键先在网页内回退，退无可退才退出这一屏
 *
 * 剩下的差距是诚实的：H5 就是 H5，滚动惯性与字体渲染仍与原生有别。
 * 要完全原生的观感，页面得做成页面包（RN）而不是静态站点。
 */

export interface WebPageTarget {
  /** 站内路径，形如 /zongkelong/gugong-yiri/ */
  path: string;
  title: string;
}

export function WebPage({
  target,
  token,
  onBack,
}: {
  target: WebPageTarget;
  /** App 当前会话令牌，用来换取 WebView 的浏览器 cookie。 */
  token: string | null;
  /**
   * 不传就不画返回键。
   * H5 页面被设为首页时就该不传——首页是根，没有"返回"可去，
   * 导航是底下那条 tab。
   */
  onBack?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const ref = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  /*
    状态栏那条占位的颜色，取自页面自己的背景。

    写死米色时它就是一条突兀的白边：页面顶部是深蓝的宫墙照，白条压在
    上面，中间还夹着进度条的灰轨道。让位给状态栏是必要的（网页的吸顶栏
    不知道状态栏在哪），但这一条应该看起来像页面的一部分，而不是像壳
    在页面上面又加了一层。
  */
  const [topColor, setTopColor] = useState('#fcfcf8');
  /*
    页面自己那条吸顶栏的底边（CSS px，0 表示没有）。

    返回键要放在顶部——那是人找返回的地方——但页面往往在同一位置有自己的
    品牌栏，压上去谁都看不清。注入脚本本来就要找这些贴顶元素做让位，
    顺手把它的底边报回来，按钮排在它下面即可，不必猜一个固定偏移。
  */
  const [topBarBottom, setTopBarBottom] = useState(0);

  /*
    底色深的话状态栏图标要反白，否则黑图标压在深色宫墙上根本看不见。
    只认 rgb()/rgba() 与 #rrggbb——网页背景色 getComputedStyle 出来的
    就是这两种形态。
  */
  const darkTop = isDark(topColor);

  /**
   * 每次进入都重新铸码：码 60 秒过期且用一次即毁，缓存下来只会拿到废码。
   * 没有令牌（理论上进不来这一屏）也照常打开——页面若是公开的仍能看，
   * 需要登录的会走服务端的提示页，好过我们自己先斩后奏说"你没登录"。
   */
  const open = useCallback(async () => {
    setError(null); setLoading(true); setProgress(0);
    const to = encodeURIComponent(target.path);
    if (!token) { setUri(`${API_BASE}${target.path}`); return; }
    try {
      const res = await fetch(`${API_BASE}/deploy/api/auth/native/code`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const { code } = (await res.json()) as { code: string };
      setUri(`${API_BASE}/deploy/api/auth/native/handoff?code=${code}&to=${to}`);
    } catch {
      // 换不到 cookie 不代表页面打不开——直接去目标页，让服务端决定给不给看
      setUri(`${API_BASE}${target.path}`);
    }
  }, [target.path, token]);

  useEffect(() => { void open(); }, [open]);

  // 安卓实体返回键：先在网页内回退。不接管的话一按就退出整个页面，
  // 用户在多级页面里点了半天会一下子全丢。
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current) { ref.current?.goBack(); return true; }
      // 没有上一层时不拦截，交还给系统（首页按返回就是退出 App）
      if (!onBack) return false;
      onBack(); return true;
    });
    return () => sub.remove();
  }, [onBack]);

  /*
    沉浸式：壳不画任何标题栏，页面一直铺到状态栏后面。

    先前的做法是给状态栏留一条纯色占位。但那条占位取不到"视觉上的顶部
    颜色"——页面顶部往往是一张照片，CSS 背景色读出来是 body 的米色，
    于是照片上方顶着一条突兀的白边。

    改成真全出血，代价（网页自己的吸顶栏会撞上系统图标）用注入脚本解决：
    找出贴顶的 fixed/sticky 元素，给它加一段 padding-top，让它的底色向上
    延伸到状态栏后面而内容落在图标下方——原生 App 就是这么做的。

    壳自己的返回键仍然自己让开状态栏（绝对定位不吃父级 padding）。
  */
  return (
    <View style={[s.root, { backgroundColor: topColor }]}>
      <StatusBar
        barStyle={darkTop ? 'light-content' : 'dark-content'}
        backgroundColor="transparent"
        translucent
      />
      {/* 只画那道橙线，不画轨道——轨道是一条横贯全屏的灰边，
          在状态栏占位的正下方，看起来就像页面上面莫名多了一条分割线 */}
      {loading && (
        <View
          style={[s.progressFill, { top: insets.top, width: `${Math.max(6, progress * 100)}%` }]}
        />
      )}

      {error ? (
        <View style={s.center}>
          <Text style={s.errTitle}>没能打开这个页面</Text>
          <Text style={s.errBody}>{error}</Text>
          <Pressable style={s.retry} onPress={() => void open()}>
            <Text style={s.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : uri ? (
        <WebView
          ref={ref}
          source={{ uri }}
          style={{ flex: 1, backgroundColor: topColor }}
          onNavigationStateChange={(st) => { canGoBack.current = st.canGoBack; }}
          onLoadProgress={({ nativeEvent }) => setProgress(nativeEvent.progress)}
          onLoadEnd={() => setLoading(false)}
          /*
            页面加载完就把它顶部的实际背景色报回来，用作状态栏占位的颜色。
            取 body 与 html 两级：很多页面把底色写在 html 上，body 是透明的，
            只读 body 会拿到 rgba(0,0,0,0)。
          */
          /*
            页面铺到状态栏底下（照片、主视觉全出血才好看），但页面自己的
            吸顶栏并不知道状态栏在哪，直接盖上去就会跟时间、信号图标叠在
            一起。所以逐个找出 fixed/sticky 且贴着顶的元素，把它整体下移
            一个状态栏的高度。

            ⚠️ 用 margin-top，不要用 padding-top。padding 会撑大这个元素的
            padding box，而它往往是内部绝对定位元素的包含块——实测某个页面
            的移动端菜单是 `.site-header` 里的 `position:absolute; top:64px;
            transform:translateY(-130%)`，收起时停在屏幕外；padding 一加，
            它的基准跟着下移，下沿就探回屏幕，在顶部露出一条它自己的底色。
            那条「白带」查了很久，根因就在这里。margin 只移位置、不改尺寸，
            子元素的相对几何原样保留。

            顺带把顶部实际颜色报回来，用来决定状态栏图标是黑是白。
          */
          injectedJavaScript={`
            (function () {
              try {
                var T = ${Math.round(insets.top)};
                if (!document.getElementById('ispace-safe-top')) {
                  var st = document.createElement('style');
                  st.id = 'ispace-safe-top';
                  st.textContent = '.ispace-safe-top{padding-top:' + T + 'px !important;box-sizing:content-box}';
                  document.head.appendChild(st);
                }
                var barBottom = 0;
                var all = document.querySelectorAll('body *');
                for (var i = 0; i < all.length; i++) {
                  var el = all[i];
                  var cs = getComputedStyle(el);
                  if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
                  var r = el.getBoundingClientRect();
                  // 只管真正贴着顶的那些；底部操作条、侧边浮标不动
                  if (r.top > 2 || r.height > window.innerHeight * 0.5) continue;
                  el.classList.add('ispace-safe-top');
                  /*
                    让位会把这个条的盒子整体下移，而它内部**绝对定位**的子元素
                    是以它为包含块的——跟着一起下移 T 像素。收起的移动端菜单
                    正是这样：position:absolute; top:64px; translateY(-130%)，
                    本来停在屏幕外，基准下移之后下沿探回屏幕，在顶部露出一条
                    它自己的底色和半行导航文字。所以把它们补回去。
                  */
                  var subs = el.children;
                  for (var j = 0; j < subs.length; j++) {
                    var sub = subs[j];
                    var scs = getComputedStyle(sub);
                    if (scs.position === 'absolute' && scs.top !== 'auto') {
                      sub.style.marginTop = (-T) + 'px';
                    }
                  }
                  var after = el.getBoundingClientRect();
                  if (after.bottom > barBottom) barBottom = after.bottom;
                }
                var pick = function (el) {
                  var c = el ? getComputedStyle(el).backgroundColor : '';
                  if (!c || c === 'transparent' || c.indexOf(', 0)') >= 0) return null;
                  return c;
                };
                window.ReactNativeWebView.postMessage(JSON.stringify({ topBarBottom: barBottom }));


                var topEl = document.elementFromPoint(window.innerWidth / 2, T + 2);
                var c = pick(topEl) || pick(document.body) || pick(document.documentElement);
                if (c) window.ReactNativeWebView.postMessage(JSON.stringify({ topColor: c }));
              } catch (e) {}
            })();
            true;
          `}
          onMessage={(e) => {
            try {
              const d = JSON.parse(e.nativeEvent.data) as {
                topColor?: string; topBarBottom?: number;
              };
              if (typeof d.topBarBottom === 'number') setTopBarBottom(d.topBarBottom);
              if (d.topColor) setTopColor(d.topColor);
            } catch { /* 页面自己也可能 postMessage，不认得就忽略 */ }
          }}
          onError={({ nativeEvent }) =>
            setError(nativeEvent.description || '网络不可用，或页面已被删除')}
          /*
            这几个属性都对着 RNCWebViewNativeComponent.d.ts 的 codegen 规格核过。
            ⚠️ 不要凭旧文档加属性：新架构下 Fabric 按规格严格转型，类型对不上
            不是"忽略这个属性"，而是挂载时抛 ClassCastException，整个 React
            宿主被销毁 —— 表现为白屏加闪退，且 JS 层收不到任何错误。
            这里踩过一次：decelerationRate 规格是 Double，老文档里却写着可以传
            "normal" / "fast"，传字符串直接把 App 打死。
          */
          allowsBackForwardNavigationGestures
          setSupportMultipleWindows={false}
          pullToRefreshEnabled={false}
          startInLoadingState={false}
          /*
            让页面知道自己在 App 里：平台注入的 iSpace header 靠这段 UA
            自我隐藏（见 apps/shell-js/src/shell.ts）。两层 chrome 叠在一起
            会占掉整整一屏顶部。用 applicationNameForUserAgent 而不是整个
            覆盖 userAgent——保留浏览器真实标识，页面的兼容性判断不受影响。
          */
          applicationNameForUserAgent="iSpaceApp/1.0"
        />
      ) : (
        <View style={s.center}><ActivityIndicator color="#fb923c" /></View>
      )}

      {/*
        悬浮返回放**左下角**，不放左上角。

        页面全出血之后，顶部那一条归页面自己（很多页面有吸顶的品牌栏），
        壳的按钮压上去就是两层东西叠在一起——实测正好盖住了「午门之外」
        那个 logo。左下角是页面几乎不会用的角落，拇指也更容易够到。
      */}
      {onBack && (
        <Pressable
          onPress={onBack}
          hitSlop={12}
          style={[s.floatBack, {
            // 页面有吸顶栏就排到它下面；没有就贴着状态栏下方
            top: topBarBottom > 0 ? topBarBottom + 8 : insets.top + 8,
          }]}
          accessibilityLabel={`返回，离开${target.title}`}
        >
          <Icon name="chevronLeft" size={19} color="#001217" />
        </Pressable>
      )}
    </View>
  );
}

/** 这个颜色是不是暗到需要把状态栏图标反白。 */
function isDark(c: string): boolean {
  let r = 0, g = 0, b = 0;
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    r = Number(m[1]); g = Number(m[2]); b = Number(m[3]);
  } else if (/^#[0-9a-f]{6}$/i.test(c)) {
    r = parseInt(c.slice(1, 3), 16);
    g = parseInt(c.slice(3, 5), 16);
    b = parseInt(c.slice(5, 7), 16);
  } else {
    return false;
  }
  // 感知亮度（ITU-R BT.601），比简单平均更贴近肉眼
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fcfcf8' },
  // 进度条压在页面之上，不占布局高度——沉浸式下任何一条占位的东西
  // 都会在加载完成时让内容跳一下
  progressFill: {
    position: 'absolute', left: 0, zIndex: 10,
    height: 2, backgroundColor: '#fb923c',
  },
  floatBack: {
    position: 'absolute', left: 14, zIndex: 20,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,.94)',
    borderWidth: 1, borderColor: 'rgba(0,0,0,.08)',
    alignItems: 'center', justifyContent: 'center',
    // 悬在内容之上，需要一点投影才分得清层次
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  errTitle: { fontSize: 17, fontWeight: '700', color: '#001217' },
  errBody: { fontSize: 13, color: '#545659', textAlign: 'center', lineHeight: 20 },
  retry: {
    marginTop: 10, backgroundColor: '#001217',
    paddingHorizontal: 22, paddingVertical: 11, borderRadius: 10,
  },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
