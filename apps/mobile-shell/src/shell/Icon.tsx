import { Path, Rect, Svg } from 'react-native-svg';

/**
 * 图标集。
 *
 * 设计稿用的是 Lucide 风格的描边图标：24×24 viewBox、stroke-width 2、
 * fill none、圆头圆角。下面这些 path 直接取自设计稿渲染出的 SVG，
 * 不是我照着画的。
 *
 * 之前这些位置用的是字符与 emoji（＋ ➤ × ■ 🎤）。emoji 尤其不行：
 * 它由系统字体渲染，各家 ROM 长得都不一样，且是彩色的——扔进一套
 * 黑白描边的界面里非常突兀，还没法跟随文字颜色变化。
 */

export type IconName =
  | 'plus' | 'mic' | 'send' | 'stop' | 'close' | 'settings' | 'chevronLeft';

/** 每个图标的绘制指令。数值均为 24×24 坐标系。 */
const PATHS: Record<IconName, { d?: string; rect?: [number, number, number, number, number] }[]> = {
  // 设计稿「录入」按钮用的就是它
  plus: [{ d: 'M12 5v14M5 12h14' }],
  // Lucide mic：话筒 + 支架
  mic: [
    { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z' },
    { d: 'M19 10v2a7 7 0 0 1-14 0v-2' },
    { d: 'M12 19v3' },
  ],
  // Lucide send（纸飞机）
  send: [{ d: 'm22 2-7 20-4-9-9-4Z' }, { d: 'M22 2 11 13' }],
  // 方块 stop，与 mic 同一视觉重量
  stop: [{ rect: [7, 7, 10, 10, 2] }],
  // 设计稿 Dialog 关闭键用的就是这条
  close: [{ d: 'M18 6 6 18M6 6l12 12' }],
  // 设计稿壳入口的齿轮，实测 18px、#545659
  settings: [
    { d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
    {
      d:
        'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    },
  ],
  chevronLeft: [{ d: 'M15 18l-6-6 6-6' }],
};

export function Icon({
  name, size = 21, color = '#545659', strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {PATHS[name].map((p, i) =>
        p.rect ? (
          <Rect
            key={i}
            x={p.rect[0]} y={p.rect[1]} width={p.rect[2]} height={p.rect[3]} rx={p.rect[4]}
            // stop 是实心的：它表示「正在进行、点此停止」，描边版在小尺寸下
            // 看着像个空盒子，读不出「停」的意思
            fill={color}
          />
        ) : (
          <Path
            key={i}
            d={p.d}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
    </Svg>
  );
}
