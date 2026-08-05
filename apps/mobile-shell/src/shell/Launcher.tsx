import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Easing, Pressable, RefreshControl,
  ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * 启动器：一个人的东西多起来之后，手机上怎么展示。
 *
 * 平台上「一个页面」有三种来源，用户不该关心它们的技术差别：
 *   1. 页面包里声明的屏（RN，装在本机，离线可用）
 *   2. 自己在电脑上做的静态页面（H5，壳内 WebView 打开）
 *   3. 从创意市场装的别人的页面
 * 三者在这里一视同仁地并排，只用一枚小角标说明它是不是要联网。
 *
 * 为什么不是把它们全塞进底部 tab：tab 最多 5 个（app.json 的硬约束，
 * 也是手指的约束），而一个人做上十几个页面是常态。tab 留给页面包
 * 自己声明的主结构，跨来源的总入口放这里。
 */

export type LaunchItem =
  | { kind: 'screen'; key: string; route: string; name: string; letter: string }
  | { kind: 'web'; key: string; path: string; name: string; letter: string; owner?: string }
  | { kind: 'market'; key: 'market'; name: string; letter: string };

export function Launcher({
  displayName,
  items,
  loading,
  onRefresh,
  onOpen,
  onEdit,
  homeKey,
  onSetHome,
}: {
  displayName: string;
  items: LaunchItem[];
  loading: boolean;
  onRefresh: () => void;
  onOpen: (it: LaunchItem) => void;
  /** 长按自己的页面 → 带着它进对话去改。别人的页面改不了，不给这个入口。 */
  onEdit?: (it: LaunchItem) => void;
  /** 当前被设为首页的那个。 */
  homeKey?: string | null;
  onSetHome?: (it: LaunchItem) => void;
}) {
  const insets = useSafeAreaInsets();
  const mine = items.filter((i) => i.kind !== 'market' && !('owner' in i && i.owner));
  const shared = items.filter((i) => i.kind === 'web' && 'owner' in i && i.owner);
  const market = items.find((i) => i.kind === 'market');
  /** 长按弹出的动作菜单。两个动作语义差得远，不该都塞进"长按"一个手势。 */
  const [acting, setActing] = useState<LaunchItem | null>(null);

  return (
    <View style={{ flex: 1 }}>
    <ScrollView
      style={{ flex: 1, backgroundColor: '#fcfcf8' }}
      contentContainerStyle={{
        paddingTop: insets.top + 52, paddingHorizontal: 18,
        paddingBottom: 28,
      }}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor="#fb923c" />
      }
    >
      <Text style={s.hello}>{displayName}的空间</Text>
      <Text style={s.helloSub}>
        {mine.length + shared.length} 个页面 · 下拉刷新
      </Text>

      {mine.length === 0 && shared.length === 0 && !loading && (
        <View style={s.empty}>
          <Text style={s.emptyTitle}>这里还空着</Text>
          <Text style={s.emptyBody}>
            在电脑上让 AI 帮你做一个页面，发布之后就会出现在这里。
            也可以去创意市场装一个别人做好的。
          </Text>
        </View>
      )}

      {mine.length > 0 && (
        <Grid
          items={mine} onOpen={onOpen} homeKey={homeKey}
          {...(onEdit || onSetHome ? { onLongPress: setActing } : {})}
        />
      )}

      {shared.length > 0 && (
        <>
          <Text style={s.groupTitle}>同事分享给我的</Text>
          {/* 分享来的也能设为首页——别人的页面照样可以是你天天要看的那个。
              只是改不了，所以下面的菜单里不给「改一改」。 */}
          <Grid
            items={shared} onOpen={onOpen} homeKey={homeKey}
            {...(onSetHome ? { onLongPress: setActing } : {})}
          />
        </>
      )}

      {market && (
        <Pressable style={s.marketRow} onPress={() => onOpen(market)}>
          <View style={s.marketIcon}><Text style={s.marketIconText}>市</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.marketName}>创意市场</Text>
            <Text style={s.marketSub}>看看同事都做了什么，一键装到自己这儿</Text>
          </View>
          <Text style={s.marketArrow}>›</Text>
        </Pressable>
      )}
    </ScrollView>

      {/* 必须在 ScrollView 之外：放在里面时 absoluteFill 是相对滚动内容
          定位的，菜单会被裁掉——实测「设为首页」那一行直接看不见 */}
      {acting && (
        <View style={s.sheetMask}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setActing(null)} />
          <View style={[s.sheet, { paddingBottom: insets.bottom + 14 }]}>
            <Text style={s.sheetTitle} numberOfLines={1}>{acting.name}</Text>
            {onSetHome && (
              <Pressable
                style={s.sheetRow}
                onPress={() => { onSetHome(acting); setActing(null); }}
              >
                <Text style={s.sheetRowText}>
                  {acting.key === homeKey ? '取消设为首页' : '设为首页'}
                </Text>
                <Text style={s.sheetRowHint}>
                  {acting.key === homeKey
                    ? '首页会变回这一屏'
                    : '以后打开 App 直接就是它'}
                </Text>
              </Pressable>
            )}
            {onEdit && !('owner' in acting && acting.owner) && (
              <Pressable
                style={s.sheetRow}
                onPress={() => { onEdit(acting); setActing(null); }}
              >
                <Text style={s.sheetRowText}>改一改</Text>
                <Text style={s.sheetRowHint}>带着它去跟 AI 说要改什么</Text>
              </Pressable>
            )}
            <Pressable style={s.sheetCancel} onPress={() => setActing(null)}>
              <Text style={s.sheetCancelText}>取消</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function Grid({ items, onOpen, onLongPress, homeKey }: {
  items: LaunchItem[]; onOpen: (it: LaunchItem) => void;
  onLongPress?: (it: LaunchItem) => void;
  homeKey?: string | null;
}) {
  return (
    <View style={s.grid}>
      {items.map((it, i) => (
        <Tile
          key={it.key} item={it} index={i}
          isHome={it.key === homeKey}
          onPress={() => onOpen(it)}
          {...(onLongPress && it.kind === 'web' ? { onLongPress: () => onLongPress(it) } : {})}
        />
      ))}
    </View>
  );
}

/**
 * 图标依次浮起。
 *
 * 逐个入场而不是整屏一起出现：一起出现时用户不知道该先看哪，
 * 错开 45ms 之后视线会自然地从第一个扫到最后一个。
 */
function Tile({ item, index, onPress, onLongPress, isHome }: {
  item: LaunchItem; index: number; onPress: () => void;
  onLongPress?: () => void; isHome?: boolean;
}) {
  const appear = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(appear, {
      toValue: 1, duration: 380, delay: Math.min(index, 11) * 45,
      easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, [appear, index]);

  const scale = Animated.multiply(
    appear.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] }),
    press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.94] }),
  );

  return (
    <Animated.View style={{
      opacity: appear,
      transform: [{ scale }, { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
    }}>
      <Pressable
        onPress={onPress}
        {...(onLongPress ? { onLongPress, delayLongPress: 380 } : {})}
        onPressIn={() => Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 40 }).start()}
        onPressOut={() => Animated.spring(press, { toValue: 0, useNativeDriver: true, speed: 24 }).start()}
        style={s.tile}
      >
        <View style={[s.tileIcon, item.kind === 'screen' && { backgroundColor: '#001217' }]}>
          <Text style={s.tileLetter}>{item.letter}</Text>
          {isHome && <View style={s.homeDot}><Text style={s.homeDotText}>首</Text></View>}
        </View>
        <Text style={s.tileName} numberOfLines={2}>{item.name}</Text>
        {item.kind === 'web' && (
          <Text style={s.tileBadge}>{isHome ? '首页' : onLongPress ? '长按更多' : '需联网'}</Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** 供 App.tsx 在切换应用时复用的加载态。 */
export function LauncherLoading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fcfcf8' }}>
      <ActivityIndicator color="#fb923c" />
    </View>
  );
}

const TILE = 78;

const s = StyleSheet.create({
  hello: { fontSize: 26, fontWeight: '800', color: '#001217', letterSpacing: 0.5 },
  helloSub: { fontSize: 12.5, color: '#909599', marginTop: 4, marginBottom: 20 },
  groupTitle: {
    fontSize: 13, fontWeight: '700', color: '#545659',
    marginTop: 26, marginBottom: 12, letterSpacing: 1,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tile: { width: TILE + 18, alignItems: 'center', paddingVertical: 10 },
  tileIcon: {
    width: TILE - 12, height: TILE - 12, borderRadius: 18,
    backgroundColor: '#fb923c', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  tileLetter: { color: '#fff', fontSize: 26, fontWeight: '700' },
  tileName: {
    marginTop: 8, fontSize: 12, color: '#001217',
    textAlign: 'center', lineHeight: 16,
  },
  tileBadge: { fontSize: 9.5, color: '#909599', marginTop: 2 },
  // 首页标记贴在图标右上角：一眼能看出"打开 App 落在哪儿"
  homeDot: {
    position: 'absolute', top: -4, right: -4,
    width: 20, height: 20, borderRadius: 10, backgroundColor: '#001217',
    borderWidth: 2, borderColor: '#fcfcf8',
    alignItems: 'center', justifyContent: 'center',
  },
  homeDotText: { color: '#fff', fontSize: 9, fontWeight: '700' },

  sheetMask: {
    ...StyleSheet.absoluteFillObject, zIndex: 40,
    backgroundColor: 'rgba(0,0,0,.42)', justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 18, paddingTop: 16,
  },
  sheetTitle: { fontSize: 13, color: '#909599', marginBottom: 6 },
  sheetRow: { paddingVertical: 13, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,.06)' },
  sheetRowText: { fontSize: 16, color: '#001217', fontWeight: '600' },
  sheetRowHint: { fontSize: 11.5, color: '#909599', marginTop: 2 },
  sheetCancel: { paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  sheetCancelText: { fontSize: 14, color: '#787c80' },

  empty: { paddingVertical: 40, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: '#001217' },
  emptyBody: {
    fontSize: 13, color: '#787c80', textAlign: 'center',
    lineHeight: 21, paddingHorizontal: 18,
  },

  marketRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 30,
    backgroundColor: '#fff', borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: 'rgba(0,0,0,.06)',
  },
  marketIcon: {
    width: 42, height: 42, borderRadius: 12, backgroundColor: '#f6f0e2',
    alignItems: 'center', justifyContent: 'center',
  },
  marketIconText: { fontSize: 18, fontWeight: '700', color: '#8f1f1f' },
  marketName: { fontSize: 15, fontWeight: '700', color: '#001217' },
  marketSub: { fontSize: 11.5, color: '#909599', marginTop: 2 },
  marketArrow: { fontSize: 22, color: '#c9cdd0' },
});
