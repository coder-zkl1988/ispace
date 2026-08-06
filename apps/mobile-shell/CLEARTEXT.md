# 明文 HTTP 与安全上下文

壳连 `http://` 实例时，`app.config.js` 会自动打开两个原生开关：
`android.usesCleartextTraffic` 与 iOS 的 `NSAllowsArbitraryLoads`。
连 `https://` 时两者都关。判断依据只有一个——`EXPO_PUBLIC_ISPACE_BASE_URL`
的协议。

## 为什么需要这个开关

Android 9 (API 28) 起默认禁止应用发起明文 HTTP 请求，iOS 的 ATS 同理，
**但两个平台的浏览器都不受此限**。

于是内网 HTTP 部署会撞上一个极具迷惑性的故障：浏览器里一切正常（登录页
打得开、控制台能用），而壳自己的每一个 `fetch` 都被系统直接掐断——登录、
加载页面包、检查更新全部失效，且没有任何报错弹到界面上，表现只是"点了
没反应"。

实测发现的过程：登录点下去浏览器根本不开，因为第一个 fetch
（`/auth/native/pair`）就失败了。

## 最阴的一种：壳是 https，服务端却往 manifest 里写 http

上面说的是「整个实例是 http」。还有一种只坏一半的形态，实际发生过，
从现象到根因花了很久：

壳用 `https://` 构建（于是 `usesCleartextTraffic=false`，正确），但服务端的
`ISPACE_PUBLIC_BASE` 是 `http://`。登录、页面市场、H5 全都正常——那些地址由
壳自己拼，走的是 `EXPO_PUBLIC_ISPACE_BASE_URL`。**只有更新包的资源地址是
服务端给的**：manifest 里每个 asset 的 URL 在发布那一刻按 `ISPACE_PUBLIC_BASE`
写死。于是壳拿到一串 `http://` 地址，安卓在平台层逐个掐掉。

表现是点了更新之后**永远停在「正在下载」**：`fetchUpdateAsync` 既不返回也不
抛错，JS 侧的 try/catch 和超时都拦不住——请求根本没进到 JS 能观察到的层面。
服务端日志的样子是决定性的：`/updates/manifest` 有 200，`/updates/assets/*`
一条都没有。

三条防线：

1. `ISPACE_PUBLIC_BASE` 的 scheme 必须与 `EXPO_PUBLIC_ISPACE_BASE_URL` 一致
2. `updates-service` 在**下发时**按当前 `ISPACE_PUBLIC_BASE` 归一化 manifest
   里的资源地址（`src/manifest-origin.ts`），发布时刻的快照不再有约束力
3. 排查时先看有没有 `/updates/assets/*` 请求，那一眼就能分清是「没下发」
   还是「下发了但取不到」

## 为什么不无条件开着

开着它等于放弃传输层加密。内网 HTTP 实例上这是既成事实（本来就没有证书），
但公网 HTTPS 实例上它是实打实的降级：应用照样接受任何明文连接，中间人
可以把请求降级到 HTTP 再读走会话令牌。

所以跟着地址走。改地址必须重新出壳——这是原生配置，编译进 AndroidManifest
与 Info.plist，改 JS 不生效。

## 上 HTTPS 时还要一起改的

1. `packages/auth` 的 `sessionCookie(token, ttl, secure)`——目前传 `false`。
   HTTPS 下必须传 `true`，否则会话 cookie 仍会在明文链路上发出。
2. 重新构建壳（同上，原生配置）。

## 明文 HTTP 还悄悄关掉了哪些浏览器能力

上面几条是壳侧的。网页侧同样受影响，而且失效方式往往**不报错**：

- **剪贴板** —— `navigator.clipboard` 只在安全上下文（HTTPS / localhost）
  里存在。HTTP 实例上实测 `window.isSecureContext === false`、
  `navigator.clipboard === undefined`，于是 `navigator.clipboard.writeText(x)`
  在读属性那一步就同步抛 TypeError，整个点击处理函数挂掉——
  全站 7 处复制按钮既不复制也不报错。
  已改为走 `packages/ui/src/clipboard.ts` 的 `copyText()`，
  它在拿不到标准 API 时回落到 `document.execCommand('copy')`。
  **HTTPS 部署下这条回落自然不会被走到，代码不用改。**

- 其余需要安全上下文的能力（Service Worker、getUserMedia、
  Web Crypto 的 subtle、Notification 等）目前都没用到；将来要用，
  记得先确认这一条。
