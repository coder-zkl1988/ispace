/**
 * manifest 里的资源地址，按下发时刻的对外地址归一化。
 *
 * 地址是**发布那一刻**拍下的快照，设备却可能几周后才来取。中间只要平台的
 * 对外地址变过一次——换域名、或者从 http 换到 https——快照就指向一个取不到
 * 的地方。最坏的是它不报错：壳带 usesCleartextTraffic=false 时，安卓对明文
 * 请求的拦截发生在平台层，JS 侧既没有异常也没有超时，用户看到的是「正在
 * 下载」一直转。这个 bug 真的发生过，从现象到根因花了很久。
 *
 * 所以下发时重写一遍：manifest 只回答"现在去哪儿取"，不做历史存档。
 */

/** 资源地址的 origin 部分，且后面紧跟着我们自己的 /updates/assets 前缀。 */
const ASSET_ORIGIN = /https?:\/\/[^"/]+(?=\/updates\/assets\/)/g;

/**
 * 把 manifest 里指向本平台资源的地址换成 `base` 的 origin。
 * 不是本平台的地址原样放行——别人的 CDN 不该被我们改写。
 */
export function withCurrentOrigin(manifest: unknown, base: string): unknown {
  if (manifest == null) return manifest;
  const origin = base.replace(/\/+$/, '');
  const raw = JSON.stringify(manifest);
  // 用替换函数而不是替换字符串：base 里的 $ 会被当成分组引用
  const fixed = raw.replace(ASSET_ORIGIN, () => origin);
  return fixed === raw ? manifest : JSON.parse(fixed);
}
