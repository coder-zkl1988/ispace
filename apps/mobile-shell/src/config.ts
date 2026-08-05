/**
 * 壳要连的那个 iSpace 实例。
 *
 * 这里是壳里**唯一**写平台地址的地方。此前 App.tsx、channel.ts、AgentChat.tsx、
 * Market.tsx、WebPage.tsx 各写一份同样的常量，换实例要改五处，漏一处的表现是
 * 「大部分功能正常、某个 tab 打不开」——最难查的那种。
 *
 * 取值来自构建期的 `EXPO_PUBLIC_ISPACE_BASE_URL`。Expo 会把 `EXPO_PUBLIC_` 前缀
 * 的环境变量在打包时**内联成字面量**，所以运行期没有读取开销，也不需要
 * expo-constants。代价是它固化在二进制里：改地址必须重新出壳，改 JS 不生效。
 * 这与 `app.config.js` 里那几项原生配置（明文 HTTP 开关、updates.url）的性质
 * 一致，本来就得一起重新构建。
 *
 * 默认值指向本机 dev 起的 deploy-service，只对模拟器 + 本机后端的组合有意义。
 * 真机连本机需要把它设成开发机在局域网里的地址（模拟器的 localhost 是它自己）。
 */
declare const process: { env: Record<string, string | undefined> };

const RAW = process.env.EXPO_PUBLIC_ISPACE_BASE_URL ?? 'http://localhost:3100';

/** 平台根地址，末尾无斜杠——所有拼接处都假设自己要写开头那个 `/`。 */
export const API_BASE = RAW.replace(/\/+$/, '');

/**
 * 更新服务的根地址。与 `app.config.js` 里 `updates.url` 同源，必须一致。
 *
 * 直接从 API_BASE 派生，前提是两个服务在同一个网关后面按路径分流——
 * 这是任何真实部署的形态。只有本机开发时它们才是两个端口
 * （deploy-service 3100 / updates-service 3200），那种情况下要连本机的
 * 更新服务，得把 EXPO_PUBLIC_ISPACE_BASE_URL 指到一个网关上，
 * 而不是直连某一个服务。
 */
export const UPDATES_BASE = `${API_BASE}/updates`;

/**
 * 给人看的地址，去掉协议。用在登录页的注册引导与设置页的「更新地址」那两栏——
 * 那些位置念出来是要在电脑上手敲的，`https://` 是噪音。
 */
export const DISPLAY_HOST = API_BASE.replace(/^https?:\/\//, '');
