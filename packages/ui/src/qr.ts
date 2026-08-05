import qrcode from 'qrcode-generator';

/**
 * 把一段文本编成二维码的 SVG path。
 *
 * 单独抽出来是为了能测：它在分享弹窗里，而弹窗的其余部分要跑 DOM 才验得了，
 * 但"编出来的码对不对"是纯计算，值得单独盯住——二维码错了的表现是
 * "有些手机扫不出来"，那是最难在开发阶段被发现的一类问题。
 *
 * 编码本身用 qrcode-generator（零依赖），不自己实现：Reed-Solomon 纠错、
 * BCH 格式信息、掩码选择，每一块写错都只表现为扫码失败。
 */
export interface QrPath {
  /** SVG path 的 d 属性，坐标系是 0..modules 的模块网格。 */
  d: string;
  /** 边长上的模块数（21 / 25 / 29 …）。用作 viewBox 尺寸。 */
  modules: number;
}

/**
 * 返回 null 表示编不出来——内容超过了最大版本的容量。
 * 调用方要显示替代内容，而不是让整个弹窗炸掉。
 */
export function qrPath(text: string): QrPath | null {
  if (!text) return null;
  try {
    // 0 = 自动挑最小够用的版本；M 级纠错，屏幕上扫的场景足够
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      }
    }
    return { d, modules: n };
  } catch {
    return null;
  }
}
