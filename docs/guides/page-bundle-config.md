# 手机页面包怎么配（app.json）

手机 App 的**底部 tab bar、首页形态、齿轮位置**，都写在页面包项目根目录的
`app.json` 里。改这些只是再发一次页面包，不用重新装 App、也不用发新的壳。

> 如果你在让 AI（Claude / Codex 之类）帮你做页面，把这份文档的链接或内容
> 丢给它，它就知道该往哪写、能写什么。

权威定义在 `packages/contracts/src/mobile.ts` 的 `appJsonSchema`，本文所有字段、
默认值、约束都以它为准。壳怎么渲染这份声明见
`apps/mobile-shell/src/shell/NavContainer.tsx`。

---

## 1. 一个页面包长什么样

最小项目结构（你自己写的部分）：

```
my-app/
├─ app.json              ← 页面声明：底部导航、首页形态、齿轮位置。本文主角
├─ package.json          ← 只用于依赖校验，合成时会被平台的版本替换掉
├─ assets/               ← 图片等资源，用 require('../../assets/x.jpg') 引用
└─ src/
   └─ pages/
      └─ index.js        ← 唯一入口。默认导出 { screens, title }
```

| 文件 | 干什么 | 少了会怎样 |
|---|---|---|
| `app.json` | 声明底部 bar、首页形态、齿轮在哪边 | 构建直接失败：`用户项目缺少 app.json（页面包声明）` |
| `package.json` | 构建期做依赖白名单校验 | 构建直接失败：`用户项目缺少 package.json` |
| `src/pages/index.js` | 页面代码入口，把路由映射到组件 | 构建能过，但打开 App 是白屏 |
| `assets/` | 图片、字体等 | 按需 |

**`src/pages/index` 的导出约定**（合成脚本按这个名字 import，改不得）：

```js
function Main() { /* 你的页面 */ }
function Ribao() { /* 另一个页面 */ }

export default {
  // 键就是 app.json 里 tabBar.items[].route 写的那个字符串
  screens: {
    '/': Main,
    '/ribao': Ribao,
  },
  title: '我的工作台',   // 可选。写了就在顶部渲染一条标题栏
};
```

`title` 在这里，不在 `app.json` 里——找了半天没找到标题字段的话，是这个原因。

**不要建这三个目录**：`src/shell/`、`src/runtime/`、`src/screens/`。合成时平台的壳运行时
会覆盖同名文件，你写在里面的东西会被静默盖掉。

**`app.json` 不是 Expo 的 `app.json`**。文件名撞了，语义完全不同：你写的是「页面声明」，
合成后它会被移到 `ispace.app.json` 由壳读取，根目录那个 `app.json` 换成平台的 Expo 配置。
不要往里写 `expo`、`ios`、`android` 这些键——写了也会被丢掉。

---

## 2. app.json 全部字段

只有三个顶层键：`home`、`tabBar`、`shellEntry`。**其他键会被静默忽略**——不会报错，
但也不会有任何效果，别指望写个 `"theme": "dark"` 就能改主题。

| 字段 | 类型 | 默认值 | 约束 | 什么时候用 |
|---|---|---|---|---|
| `home` | `"nav"` \| `"page"` | `"nav"` | 只能是这两个值 | 有多个页面要切 → `nav`；进 App 就是一个干活界面 → `page` |
| `tabBar` | 对象 | 无（不写就没有底部 bar） | 见下 | 要底部导航就写它 |
| `tabBar.visible` | 布尔 | `true` | — | 想临时藏起底部 bar 又不删配置时填 `false` |
| `tabBar.activeColor` | 字符串 | **无默认，写了 tabBar 就必填** | 必须是 `#RRGGBB`（6 位十六进制，大小写都行） | 选中那个 tab 的图标与文字颜色 |
| `tabBar.items` | 数组 | **必填** | 最少 1 项，最多 **5** 项 | 底部有几个 tab 就写几项 |
| `tabBar.items[].label` | 字符串 | **必填** | 1–**6** 个字符（中文一个字算一个） | tab 底下那行小字 |
| `tabBar.items[].icon` | 字符串 | **必填** | 非空。**只认下面那 10 个名字** | tab 上面那个图标 |
| `tabBar.items[].route` | 字符串 | **必填** | 非空。**必须与 `screens` 的键完全一致** | 点这个 tab 显示哪一屏 |
| `shellEntry.edge` | `"right"` \| `"left"` | `"right"` | 只能是这两个值 | 壳的设置齿轮贴哪边。你的页面要给那个角落留空 |
| `shellEntry.collapsed` | 布尔 | `true` | — | 目前壳没有读这个字段，写了不起作用 |

### home：先决定这个

- **`"page"`** —— 打开 App 直接就是一个功能页，没有底部 bar。单页应用选它。
  这时候就算你写了 `tabBar`，底部 bar 也**不会显示**（壳只在 `home === "nav"` 时渲染 bar）。
- **`"nav"`** —— 首页是导航页，底部有 tab 可以切。多页应用选它。
  但 `home: "nav"` 只是允许显示 bar，真正要有 bar 还得写 `tabBar`。

一句话：**想要底部导航，`home` 必须是 `"nav"`，并且必须写 `tabBar`，两个条件缺一不可。**

### tabBar 细则

底部 bar 出现的条件，三个同时成立（`NavContainer.tsx`）：

1. `home === "nav"`
2. `tabBar.visible` 不是 `false`（不写就是 `true`）
3. `tabBar.items` 至少有 1 项

其他行为：

- **默认选中第一项**：App 打开后停在 `items[0].route` 那一屏。想让哪个页面当首页，就把它放第一个。
- **`route` 必须对得上 `screens` 的键**。对不上时壳不会报错也不会白屏，而是回落去渲染
  `screens['/']`，再不行就渲染第一个 screen——表现为「点了这个 tab 没反应 / 一直是同一屏」。
  这是最常见的一类「配了但不生效」。
- **`activeColor` 只影响选中态**。未选中的图标是 `#909599`、文字是 `#787c80`，这两个颜色由壳定，改不了。
- **`label` 超过 6 个字会让构建失败**，不是截断。中文按字符数算，「数据统计中心」是 6 个字（刚好），
  「我的工作台面板」是 7 个字（超了）。
- **最多 5 个 tab**。第 6 个会让构建失败。

### 可用图标名（完整清单）

`icon` 填的是**名字**，不是图片路径——页面包不能自带图标图片，底部 bar 的视觉一致性由壳保证。
壳内置的就这 10 个（`NavContainer.tsx` 的 `glyph()`）：

| icon 名 | 长这样 | 一般用来表示 |
|---|---|---|
| `home` | ⌂ | 首页 |
| `list` | ☰ | 列表、清单、菜单 |
| `calendar` | ▤ | 日程、排班、日历 |
| `chart` | ▥ | 报表、数据、统计 |
| `user` | ☺ | 我的、个人中心 |
| `clock` | ◷ | 记录、历史、待办 |
| `star` | ☆ | 收藏、常用 |
| `box` | ▢ | 库存、物料、归档 |
| `bell` | ◔ | 通知、提醒 |
| `search` | ⌕ | 搜索、查询 |

**写了清单以外的名字不会报错**（schema 只要求非空字符串），但壳认不出来，会回落成一个圆点 `•`。
配好之后发现某个 tab 是个圆点，就是这个名字打错了或不在清单里。

### shellEntry

壳在标题栏右上角常驻一个设置齿轮，画在你的页面之上。`shellEntry.edge` 决定它贴左还是贴右
（默认右）。**你的页面要给那个角落留出空间**，否则会被齿轮压住。
`collapsed` 目前壳没有读取，填不填都一样。

---

## 3. 两个可以直接抄的例子

### 例一：单页应用（进去就是一个界面）

`app.json`：

```json
{
  "home": "page"
}
```

就这一行有用——`shellEntry` 不写就是默认的右上角。对应的 `src/pages/index.js`：

```js
import { Text, View } from 'react-native';

function Main() {
  return (
    <View>
      <Text>今天的工作</Text>
    </View>
  );
}

export default { screens: { '/': Main } };
```

### 例二：底部 4 个 tab 的多页应用

`app.json`：

```json
{
  "home": "nav",
  "tabBar": {
    "visible": true,
    "activeColor": "#1c1f23",
    "items": [
      { "label": "首页", "icon": "home",     "route": "/" },
      { "label": "排班", "icon": "calendar", "route": "/paiban" },
      { "label": "日报", "icon": "chart",    "route": "/ribao" },
      { "label": "我的", "icon": "user",     "route": "/me" }
    ]
  },
  "shellEntry": { "edge": "right" }
}
```

对应的 `src/pages/index.js`——**四个 route 一个都不能少，键要一模一样**：

```js
import { Text, View } from 'react-native';

const Screen = (t) => () => (
  <View><Text>{t}</Text></View>
);

export default {
  title: '门店助手',
  screens: {
    '/':       Screen('首页'),
    '/paiban': Screen('排班'),
    '/ribao':  Screen('日报'),
    '/me':     Screen('我的'),
  },
};
```

---

## 4. 你的代码能用哪些依赖

**白名单之外的原生依赖，构建期直接拒绝，没有例外。** 白名单（`tools/compose-bundle.mjs`
的 `NATIVE_ALLOWLIST`，与壳的 `package.json` 由 CI 用例锁死一致）：

| 包 | 给你什么 |
|---|---|
| `react`、`react-native` | 组件、样式、`Animated`、`Dimensions` 等 |
| `expo` | Expo 基础 API |
| `expo-updates` | 更新（壳在用，你一般不用直接碰） |
| `expo-secure-store` | 安全存储 |
| `expo-local-authentication` | 指纹 / 面容解锁 |
| `expo-camera` | 相机、扫码 |
| `expo-notifications` | 推送通知 |
| `expo-image-picker` | 选图片 |
| `expo-av` | 录音、音视频播放 |
| `expo-web-browser` | 打开网页 |
| `expo-file-system` | 读写文件 |
| `expo-font` | 字体 |
| `expo-build-properties` | 构建配置（壳在用） |
| `react-native-safe-area-context` | 安全区（刘海、home 条）内边距 |
| `react-native-svg` | 画矢量图 |
| `react-native-webview` | 内嵌网页 |
| `@ispace/contracts` | 平台的类型定义 |

**为什么不能引新的原生依赖**：手机上装的那个 App（壳）是一个已经编译好、已经发到大家
手机上的二进制。它里面有哪些原生模块，在编译那一刻就定死了。页面包走的是 OTA——
只换 JS，不换二进制。你引入一个新的原生依赖，`runtimeVersion` 就变了，而服务端只会把
`runtimeVersion` 与设备上的壳完全一致的包下发下去。结果是：**你发布成功了，但谁的手机上
都收不到。** 这种「发了没生效」最难查，所以合成脚本在构建期就直接拒绝，不让它走到线上。

确实需要新能力（比如蓝牙、地图 SDK），联系平台在壳里预置——那需要重新发一个 App 二进制。

纯 JS 的第三方库（`dayjs`、`lodash` 之类）虽然不会被这条规则拦下，但合成时你的
`package.json` 会被替换成壳的、依赖解析指向壳已装好的那些包——**实际能用的就是上表这些**。
需要格式化日期之类的小事，自己写几行比引一个库稳。

---

## 5. 报错对照表

构建期的 app.json 校验在 `tools/compose-bundle.mjs`，报错格式是
`构建失败：app.json 不合法：\n  <字段>: <原因>`。

| 你写了什么 | 报错 | 怎么改 |
|---|---|---|
| `"activeColor": "#fff"` | `tabBar.activeColor: activeColor 需为 #RRGGBB` | 必须 6 位：`#ffffff`。3 位缩写、8 位带透明度、不带 `#` 都不行 |
| `"activeColor": "orange"` | 同上 | 颜色名不认，只认十六进制 |
| 漏了 `activeColor` | `tabBar.activeColor: Required` | 写了 `tabBar` 就必须给 `activeColor`，它没有默认值 |
| `"label": "我的工作台面板"`（7 字） | `tabBar.items.0.label: String must contain at most 6 character(s)` | 改成 6 个字以内。`items.0` 里的 `0` 是第几项（从 0 数） |
| `"label": ""` | `tabBar.items.0.label: String must contain at least 1 character(s)` | label 不能为空 |
| 写了 6 个 tab | `tabBar.items: Array must contain at most 5 element(s)` | 最多 5 个，砍掉一个或合并 |
| `"items": []` | `tabBar.items: Array must contain at least 1 element(s)` | 要么给至少一项，要么整个 `tabBar` 别写 |
| `"home": "tabs"` | `home: Invalid enum value. Expected 'nav' \| 'page', received 'tabs'` | 只有 `nav` 和 `page` |
| `"route": ""` | `tabBar.items.0.route: String must contain at least 1 character(s)` | route 不能为空 |
| 项目根目录没有 app.json | `构建失败：用户项目缺少 app.json（页面包声明）` | 建一个，内容至少是 `{}` |
| 依赖里有 `react-native-maps` | `构建失败：检测到未经允许的原生依赖：react-native-maps` | 见上一节，删掉它 |

**下面这些不报错，但结果不对**——校验只管格式，不管你写得对不对：

| 现象 | 原因 |
|---|---|
| 某个 tab 图标是个圆点 `•` | `icon` 名不在那 10 个里，或拼错了 |
| 点 tab 没反应，一直是同一屏 | `route` 与 `screens` 的键对不上，回落渲染了第一屏 |
| 配了 `tabBar` 但底部没有 bar | `home` 是 `"page"`，或 `visible: false`，或 `items` 是空的 |
| 加了 `"theme"`、`"title"` 这类键，毫无反应 | 三个顶层键之外的都被静默忽略；标题在 `src/pages/index` 的 `title` |
| 页面右上角内容被齿轮压住 | 壳保留位。给 `shellEntry.edge` 那一侧的顶角留空 |
| 发布成功了但手机上收不到 | `runtimeVersion` 与壳不一致，服务端不下发。用 `mobile-channel` 查当前壳的版本 |

---

## 6. 改完怎么发

让 AI 调 MCP 的 `publish-app` 就行。想自己跑一遍的话：

```bash
node tools/compose-bundle.mjs --user <你的用户名> --src ./my-app --out ./composed
cd composed && npx expo export --platform ios
# 把 dist/ 打成 zip，交给 publish-app 或 REST /deploy/api/mobile/publish
```

第一步就会做 app.json 校验与依赖校验——**只想确认配置写对了，跑第一步就够了**，
不用等到发布才发现写错。

发布前后用 MCP 的 `mobile-channel` 看一眼：当前到端版本、`runtimeVersion`、放量比例、
活跃设备数。改动大就先 `preview: true` 只发到自己的预览通道，或用 `rolloutPercent` 灰度。
发现问题用 `mobile-rollback`，服务端切指针，1 分钟内全部设备生效。
