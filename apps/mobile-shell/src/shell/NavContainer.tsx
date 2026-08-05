import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { appJsonSchema, type AppJson } from '@ispace/contracts';

/**
 * 声明式导航容器（技术方案 §5.4）。
 *
 * 每个页面包根部携带 app.json，声明内容区的一切：首页形态、底部 bar、
 * 顶栏样式。壳读该文件渲染骨架，用户页面组件填充内容——**壳不理解业务，
 * 只渲染声明**。
 *
 * 校验双保险：
 *   - 云端构建期做 JSON Schema 校验，非法配置直接构建失败并回给用户明确报错
 *   - 壳运行期二次校验兜底，异常配置回落到默认单页布局而非崩溃
 *
 * 第二条尤其重要：壳的版本比页面包老时，可能遇到不认识的字段；崩溃会让
 * 用户直接进不去应用，而回落只是少一个 tab。
 */

const FALLBACK: AppJson = {
  home: 'page',
  shellEntry: { edge: 'right', collapsed: true },
};

/** 运行期校验。失败不抛错，回落默认布局并把原因交给调用方记录。 */
export function parseAppJson(raw: unknown): { config: AppJson; error?: string } {
  const r = appJsonSchema.safeParse(raw);
  if (r.success) return { config: r.data };
  return {
    config: FALLBACK,
    error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

export interface TabScreen {
  route: string;
  render: () => ReactNode;
}

export function NavContainer({
  config,
  screens,
  title,
  forceRoute,
}: {
  config: AppJson;
  /** 页面包提供的路由到组件的映射。壳只按 route 取，不关心内容。 */
  screens: Record<string, () => ReactNode>;
  title?: string;
  /** 从启动器直接进某一屏时指定；此时不显示 tab（用户是奔着这一屏来的）。 */
  forceRoute?: string;
}) {
  const insets = useSafeAreaInsets();
  const tabBar = config.tabBar;
  const items = useMemo(() => tabBar?.items ?? [], [tabBar]);
  const [active, setActive] = useState(forceRoute ?? items[0]?.route ?? '/');

  // home: page —— 首页直接是某个功能页，不套导航（设计稿第 02 屏）
  const showTabs =
    !forceRoute && config.home === 'nav' && tabBar?.visible !== false && items.length > 0;

  // 路由约定是 '/'，但单屏包的键名叫什么的都有（main、home、index……）。
  // 对上不了就渲染第一屏——空白屏对用户毫无信息量，比"键名不合约定"严重得多。
  const current =
    screens[active] ?? screens['/'] ?? Object.values(screens)[0] ?? (() => null);

  return (
    <View style={styles.root}>
      {title && (
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          {/* 右侧留出壳保留位的宽度，避免标题被齿轮压住 */}
          <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
          <View style={{ width: 40 }} />
        </View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: 16,
          paddingTop: title ? 8 : insets.top + 48,
          paddingBottom: showTabs ? 12 : insets.bottom + 12,
        }}
      >
        {current()}
      </ScrollView>

      {showTabs && (
        <View style={[styles.tabBar, { paddingBottom: insets.bottom || 8 }]}>
          {items.map((it) => {
            const on = it.route === active;
            return (
              <Pressable
                key={it.route}
                onPress={() => setActive(it.route)}
                style={styles.tab}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.tabIcon, on && { color: tabBar!.activeColor }]}>
                  {glyph(it.icon)}
                </Text>
                <Text style={[styles.tabLabel, on && { color: tabBar!.activeColor, fontWeight: '600' }]}>
                  {it.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

/**
 * 图标名到字形的映射。
 *
 * 壳只认一组内置图标：页面包声明的 icon 是名称而非图片资源——若允许
 * 页面包自带图标资源，底部 bar 的视觉一致性就没法保证，且每次换图标
 * 都要重发包。认不出的名称回落到圆点，不留空白。
 */
function glyph(name: string): string {
  const map: Record<string, string> = {
    home: '⌂', list: '☰', calendar: '▤', chart: '▥', user: '☺',
    clock: '◷', star: '☆', box: '▢', bell: '◔', search: '⌕',
  };
  return map[name] ?? '•';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fcfcf8' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingBottom: 10,
  },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: '#001217' },
  tabBar: {
    flexDirection: 'row', backgroundColor: 'rgba(255,255,255,.94)',
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,.06)', paddingTop: 8,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  tabIcon: { fontSize: 18, color: '#909599' },
  tabLabel: { fontSize: 10, color: '#787c80' },
});
