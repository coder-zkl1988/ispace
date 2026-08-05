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
