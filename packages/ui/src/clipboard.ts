/**
 * 复制到剪贴板。
 *
 * ⚠️ 不能直接用 navigator.clipboard —— 平台以 HTTP 部署时（内网无证书的
 * 常见形态）剪贴板 API 根本不存在：它只在**安全上下文**（HTTPS 或
 * localhost）里可用。实测一个 HTTP 实例上：
 *   location.protocol = "http:"
 *   window.isSecureContext = false
 *   navigator.clipboard = undefined
 *
 * 于是 `navigator.clipboard.writeText(x)` 在读属性那一步就同步抛
 * TypeError，整个点击处理函数直接挂掉——按钮既不复制也不报错，
 * 表现为"所有复制按钮都没反应"。全站 7 处复制无一幸免。
 *
 * 这与之前安卓壳那个 usesCleartextTraffic 是同一类问题的两端：
 * 跑在 HTTP 上会静默地关掉一批浏览器能力，而失效方式往往不是报错。
 *
 * 所以这里给两条路：
 *   1. 有安全上下文就走标准 API
 *   2. 否则回落到 execCommand('copy')——它虽然被标记为废弃，
 *      但正是为这种场景准备的，且在所有目标浏览器上都还能用
 *
 * 两条都失败时返回 false，让调用方**明确告诉用户去手动复制**，
 * 而不是假装成功或什么都不说。
 */
export async function copyText(text: string): Promise<boolean> {
  // 路径 1：标准 API。仅在 HTTPS / localhost 下存在。
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒、或页面不在前台。继续走回落，不直接判失败。
    }
  }

  // 路径 2：老办法。选中一个临时 textarea 再执行复制命令。
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  /*
    必须真的在文档里、且可聚焦，否则选区建立不起来。
    但不能让它影响布局或滚动位置：
      position:fixed + top:0 —— 不参与文档流，也不会把页面滚到别处
      opacity:0             —— 用它而不是 display:none / visibility:hidden，
                               后两者会让元素不可聚焦，选不中就复制不了
      readOnly              —— 防止 iOS 弹出软键盘
  */
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.opacity = '0';
  document.body.appendChild(ta);

  // 记住原来的选区，复制完还回去——用户可能正选着别的东西
  const prev = document.getSelection()?.rangeCount
    ? document.getSelection()!.getRangeAt(0)
    : null;

  try {
    ta.focus();
    ta.select();
    // iOS Safari 上 select() 不够，要显式给范围
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    if (prev) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(prev);
    }
  }
}

/**
 * 当前环境能不能自动复制。
 *
 * 用来决定是显示「复制」还是提示用户手动选中——在两条路都走不通的
 * 环境里，一个点了没用的按钮比没有按钮更让人恼火。
 */
export function canCopy(): boolean {
  // document 存在就至少有 execCommand 这条回落路（TS 认为它一定有定义，
  // 所以不再多此一举地判类型）。真正会失败的是运行时被浏览器拒掉，
  // 那种情况只能等 copyText 返回 false 再说。
  return typeof document !== 'undefined';
}
