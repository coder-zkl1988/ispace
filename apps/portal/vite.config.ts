import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * dev server 代理的目标，见下方 server.proxy 处的说明。
 * 默认打本机 dev 起的 deploy-service（3100）；设 ISPACE_BASE_URL 可指向真实实例。
 */
const DEV_PROXY_TARGET = process.env.ISPACE_BASE_URL ?? 'http://localhost:3100';

export default defineConfig({
  plugins: [react()],
  /**
   * 必须是绝对路径 '/'，不能用 './'。
   *
   * portal 同时服务 / 与 /{user}/ 两种路径。相对路径恰恰**受**挂载位置影响：
   * 在 /lixiao/ 下 ./assets/x.js 会解析成 /lixiao/assets/x.js，404——
   * HTML 照样返回 200，但页面一片空白，只有打开控制台才看得出来。
   * 实测就是这个状态。
   *
   * 绝对路径则恒为 /assets/x.js。Caddy 的 @userapp 匹配器把 assets 列在
   * 排除项里，所以它会落到 portal 兜底，任何挂载深度都取得到。
   */
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      /*
        dev server 把这两条路径转给一个真实实例。默认指向本机 compose 起的
        网关；要对着别的实例调前端，设 ISPACE_BASE_URL 即可，不必改这个文件。

        /dist 是安卓安装包与它的 version.json（由 14-publish-apk.sh 发布）。
        不代理的话「下载手机 App」弹窗只能看到读取失败——那份 JSON 是部署
        产物，本机 dev server 里没有对应物。
      */
      '/deploy': { target: DEV_PROXY_TARGET, changeOrigin: true },
      '/dist': { target: DEV_PROXY_TARGET, changeOrigin: true },
    },
  },
});
