import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * 壳自己的底部导航。
 *
 * 与页面包 app.json 里的 tabBar 是两回事，别混：
 *   app.json 的 tabBar —— 页面**内部**的分区，由做页面的人决定，最多 5 个
 *   这里的 ShellTabs   —— 平台**固定**的四个去处，任何人任何页面都一样
 *
 * 跟 AI 对话曾经也是一个 tab，撤了：它不是一个「地方」，是一个动作。
 * 人不会想「我去对话」，人想的是「我要改排班表」或「我要做个新的」——
 * 两者都从「我的作品」进去，对话于是天然带着主语，页面列表也不必
 * 在宫格和选择器里各画一遍。
 *
 * 只在壳自己的四屏（首页、我的作品、创意集市、我）出现。进到具体页面后就交出整块屏幕
 * ——页面可能自带底部操作条，两条叠在一起谁都点不准；而且沉浸式那一屏
 * 刚把上下两条 chrome 去掉，这里再加回来一条就前功尽弃了。
 *
 * 固定四项而不是做成可配置：这是壳的骨架不是内容。
 * 能配置的东西迟早会被配置成没人认得的样子。
 */

export type ShellTab = 'home' | 'works' | 'market' | 'me';

export function ShellTabs({
  active, onChange,
}: { active: ShellTab; onChange: (t: ShellTab) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.bar, { paddingBottom: insets.bottom || 8 }]}>
      <Item label="首页" active={active === 'home'} onPress={() => onChange('home')}>
        <HomeGlyph on={active === 'home'} />
      </Item>
      <Item label="我的作品" active={active === 'works'} onPress={() => onChange('works')}>
        <GridGlyph on={active === 'works'} />
      </Item>
      <Item label="创意集市" active={active === 'market'} onPress={() => onChange('market')}>
        <SparkGlyph on={active === 'market'} />
      </Item>
      <Item label="我" active={active === 'me'} onPress={() => onChange('me')}>
        <MeGlyph on={active === 'me'} />
      </Item>
    </View>
  );
}

function Item({
  label, active, onPress, children,
}: {
  label: string; active: boolean; onPress: () => void; children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={s.item}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
    >
      {children}
      <Text style={[s.label, active && s.labelOn]}>{label}</Text>
    </Pressable>
  );
}

const ON = '#fb923c';
const OFF = '#909599';

function HomeGlyph({ on }: { on: boolean }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"
        stroke={on ? ON : OFF} strokeWidth={1.8} strokeLinejoin="round"
        fill={on ? ON : 'none'} fillOpacity={on ? 0.14 : 0}
      />
    </Svg>
  );
}

function SparkGlyph({ on }: { on: boolean }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6L4.5 10.9 10.1 9z"
        stroke={on ? ON : OFF} strokeWidth={1.8} strokeLinejoin="round"
        fill={on ? ON : 'none'} fillOpacity={on ? 0.14 : 0}
      />
      <Circle cx={18.6} cy={5.4} r={1.4} fill={on ? ON : OFF} />
    </Svg>
  );
}

function GridGlyph({ on }: { on: boolean }) {
  const c = on ? ON : OFF;
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      {[[4, 4], [13.5, 4], [4, 13.5], [13.5, 13.5]].map(([x, y]) => (
        <Rect
          key={`${x}-${y}`} x={x} y={y} width={6.5} height={6.5} rx={2}
          stroke={c} strokeWidth={1.8} fill={on ? ON : 'none'} fillOpacity={on ? 0.14 : 0}
        />
      ))}
    </Svg>
  );
}

function MeGlyph({ on }: { on: boolean }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={8} r={3.6} stroke={on ? ON : OFF} strokeWidth={1.8}
        fill={on ? ON : 'none'} fillOpacity={on ? 0.14 : 0} />
      <Path d="M4.5 20.2c.6-3.7 3.8-5.6 7.5-5.6s6.9 1.9 7.5 5.6"
        stroke={on ? ON : OFF} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,.07)',
    backgroundColor: '#fff', paddingTop: 8,
  },
  item: { flex: 1, alignItems: 'center', gap: 3 },
  // 「我的作品」「创意集市」都是四个字，10.5 在窄屏上会换行
  label: { fontSize: 10, color: OFF },
  labelOn: { color: ON, fontWeight: '600' },
});
