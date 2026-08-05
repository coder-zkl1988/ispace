/**
 * 图标集。
 *
 * 全部取自设计稿渲染出的 SVG——Lucide 风格：24×24 viewBox、stroke-width 2、
 * fill none、圆头圆角。不是照着画的，是把设计稿里的 path 直接搬过来。
 *
 * 不引 lucide-react：那会为了十几个图标拉进整个图标库，而且 Lucide 各版本
 * 之间同名图标的 path 会变——设计稿定死的形状会跟着漂。写死更可控。
 */

export type IconName =
  // 员工侧导航（设计稿实测 16px）
  | 'home' | 'pages' | 'backend' | 'data' | 'mobile' | 'sliders' | 'book' | 'compass'
  // 管理员侧导航
  | 'userPlus' | 'zap' | 'key' | 'settings'
  // 通用
  | 'plus' | 'arrowLeft' | 'search' | 'sparkles' | 'close';

type Shape =
  | { d: string }
  | { circle: [number, number, number] }
  | { rect: [number, number, number, number, number] };

const SHAPES: Record<IconName, Shape[]> = {
  home:     [{ d: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5' }],
  pages:    [{ d: 'M10 3v3a1 1 0 0 1-1 1H6a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-3a1 1 0 0 1 1-1h3a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-3a1 1 0 0 1-1-1V3' }],
  backend:  [{ d: 'M4 9V5a2 2 0 0 1 4 0v10a2 2 0 0 0 4 0V9a2 2 0 0 1 4 0v10M6 3v2M6 9v-1M16 3v2M16 9v-1' }],
  data:     [{ rect: [3, 4, 18, 16, 2] }, { d: 'M9 4v16' }],
  mobile:   [{ rect: [6, 3, 12, 18, 2.5] }, { d: 'M11 18h2' }],
  sliders:  [{ d: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M14 4v4M6 10v4M12 16v4' }],
  book:     [{ d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z' }],
  compass:  [{ circle: [12, 12, 9] }, { d: 'm15.5 8.5-2 5-5 2 2-5z' }],
  userPlus: [{ circle: [12, 12, 9] }, { d: 'M12 8v8M8 12h8' }],
  zap:      [{ d: 'M13 2 3 14h7l-1 8 10-12h-7z' }],
  // 访问令牌：Lucide 的 key-round，圆环加齿柄
  key:      [{ circle: [7.5, 15.5, 5.5] }, { d: 'm21 2-9.6 9.6M15.5 7.5l3 3' }],
  // 平台设置：Lucide 的 settings-2，两条带滑块的横轨
  settings: [{ d: 'M20 7h-9M14 17H5' }, { circle: [17, 17, 3] }, { circle: [7, 7, 3] }],
  plus:     [{ d: 'M12 5v14M5 12h14' }],
  arrowLeft:[{ d: 'M19 12H5M12 19l-7-7 7-7' }],
  search:   [{ circle: [11, 11, 8] }, { d: 'm21 21-4.3-4.3' }],
  sparkles: [{ d: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.9 2.3 2.3.9-2.3.9L19 21.4l-.9-2.3-2.3-.9 2.3-.9z' }],
  close:    [{ d: 'M18 6 6 18M6 6l12 12' }],
};

/**
 * 尺寸默认 16——设计稿侧栏导航的实测值。顶栏那几个是 12。
 * color 默认 currentColor，让图标跟着所在文字的颜色走（选中态自动变深）。
 */
export function Icon({
  name, size = 16, color = 'currentColor', strokeWidth = 2, style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      style={{ flex: 'none', ...style }}
      aria-hidden="true"
    >
      {SHAPES[name].map((s, i) =>
        'circle' in s ? <circle key={i} cx={s.circle[0]} cy={s.circle[1]} r={s.circle[2]} />
        : 'rect' in s ? <rect key={i} x={s.rect[0]} y={s.rect[1]} width={s.rect[2]} height={s.rect[3]} rx={s.rect[4]} />
        : <path key={i} d={s.d} />,
      )}
    </svg>
  );
}
