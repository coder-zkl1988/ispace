import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AppJson } from '@ispace/contracts';

/**
 * JS 壳运行时的可视部分（技术方案 §5.1）。
 *
 * ┌─ 为什么壳要拆成两层 ────────────────────────────────────────────────┐
 * │ expo-updates 是**整包替换**：加载用户页面包时替换的是整个 JS 层。    │
 * │ 若壳功能以 JS 实现却不做处理，会被用户包一起替换掉——胶囊、设置页、  │
 * │ 更新卡片就都没了。                                                   │
 * │                                                                      │
 * │ 因此壳拆为：                                                         │
 * │   原生壳（二进制）—— 原生模块、expo-updates、系统权限申请            │
 * │   JS 壳运行时（本目录）—— 随每个页面包分发                           │
 * │                                                                      │
 * │ 关键机制是**构建期强制合成**：云端流水线在 expo export 前把本目录    │
 * │ 与用户页面代码合成为一个更新包。用户源码中不存在壳运行时，由流水线    │
 * │ 注入，用户既改不掉也删不掉。见 tools/compose-bundle.ts。             │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 设计稿第 07 屏原本在标题栏角落画一枚常驻齿轮当壳入口。四 tab 的底栏
 * 立起来、设置收进「我」之后那枚齿轮被撤掉了（理由见下面 render 里的注释），
 * app.json 的 shellEntry 于是只剩一个作用：声明页面愿意让出哪一角，
 * 壳把返回键放到它的对边。
 */

export function ShellChrome({
  appJson,
  title,
  visitingOwner,
  onExitVisiting,
  onBack,
  children,
}: {
  appJson: AppJson;
  /** 页面自己的标题。壳不理解业务，只负责在标题栏右上角留位。 */
  title?: string;
  /** 串门中：正在使用他人的应用（设计稿第 13 屏顶部来源条）。 */
  visitingOwner?: { username: string; displayName: string } | null;
  onExitVisiting?: () => void;
  /** 从启动器进到某一屏时给的返回。首页不传，不画返回键。 */
  onBack?: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      {/* 顶部来源条由壳绘制，页面盖不住——这是串门时让人知道
          "我在谁的空间里"的唯一提示（设计稿第 13 屏） */}
      {visitingOwner && (
        <View style={[styles.visitingBar, { paddingTop: insets.top + 6 }]}>
          <View style={styles.visitingAvatar}>
            <Text style={styles.visitingAvatarText}>
              {visitingOwner.displayName.slice(0, 1)}
            </Text>
          </View>
          <Text style={styles.visitingText} numberOfLines={1}>
            正在使用 {visitingOwner.displayName} 的应用
          </Text>
          <Pressable onPress={onExitVisiting} hitSlop={8}>
            <Text style={styles.visitingExit}>退出</Text>
          </Pressable>
        </View>
      )}

      <View style={{ flex: 1 }}>
        {children}

        {/*
          返回键。落在 shellEntry 声明的对边——那一角是页面被要求让出来的，
          壳自己反倒不该占；返回键按惯例走前缘（默认 edge=right，即左上）。
        */}
        {onBack && (
          <Pressable
            onPress={onBack}
            hitSlop={10}
            style={[
              styles.entry,
              {
                top: (visitingOwner ? 0 : insets.top) + 6,
                [appJson.shellEntry.edge === 'left' ? 'right' : 'left']: 10,
              },
            ]}
            accessibilityLabel="返回"
          >
            <Icon name="chevronLeft" size={18} color="#545659" />
          </Pressable>
        )}

        {/*
          这里曾经常驻一枚齿轮（设计稿第 07 屏的壳保留位）。撤了。

          它当初的理由是"进到页面里就没有 tab 了，齿轮是唯一的出口"。
          底栏改成四个 tab、设置收进「我」之后这条不再成立：页面左上角有
          返回键，退出去就看得见「我」。于是齿轮既不是唯一出口，也不再是
          最短路径，只是白占着用户页面的一个角——而那一角往往正是页面自己
          想放东西的地方。

          更新提示同理，已统一收到底栏那条横幅：四个 tab 都看得到，
          不必在页面右上角再挤一枚药丸。
        */}
      </View>
    </View>
  );
}

/**
 * 更新提示卡（设计稿第 09 屏）。
 *
 * 后台静默检查，新版本以底部卡片提示「稍后 / 立即重载」。
 * 灰度期未放量设备不会走到这里——服务端返回 204，客户端认为无更新。
 */
export function UpdateCard({
  bundleVersion,
  runtimeVersion,
  rolloutPercent,
  notes,
  onLater,
  onReload,
}: {
  bundleVersion: number;
  runtimeVersion: string;
  rolloutPercent: number;
  notes: string[];
  onLater: () => void;
  onReload: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.updateCard, { paddingBottom: insets.bottom + 14 }]}>
      <View style={styles.updateHead}>
        <Text style={styles.updateVersion}>bundle v{bundleVersion}</Text>
        <Text style={styles.updateMeta}>
          runtimeVersion {runtimeVersion}
          {rolloutPercent < 100 ? ` · 灰度 ${rolloutPercent}%` : ''}
        </Text>
      </View>
      <Text style={styles.updateTitle}>你的应用有更新，重载一下就好</Text>
      {notes.map((n, i) => (
        <Text key={i} style={styles.updateNote}>· {n}</Text>
      ))}
      <View style={styles.updateActions}>
        <Pressable onPress={onLater} style={[styles.btn, styles.btnGhost]}>
          <Text style={styles.btnGhostText}>稍后</Text>
        </Pressable>
        <Pressable onPress={onReload} style={[styles.btn, styles.btnPrimary]}>
          <Text style={styles.btnPrimaryText}>立即重载</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * 失败兜底（设计稿第 11 屏）。
 *
 * runtimeVersion 不匹配的包服务端直接不下发；加载失败时展示重试/回退，
 * 设备始终停留在最后一个可用版本，不会变砖。
 *
 * 这个界面能成立的前提是**没有禁用 expo-updates 的防变砖机制**——
 * 即没有开 disableAntiBrickingMeasures，见 runtime/channel.ts 的禁令。
 */
export function IncompatibleScreen({
  requiredRuntime,
  currentRuntime,
  onRetry,
  onFallback,
  adminName,
}: {
  requiredRuntime: string;
  currentRuntime: string;
  onRetry: () => void;
  onFallback: () => void;
  adminName?: string;
}) {
  return (
    <View style={styles.center}>
      <View style={styles.warnBadge}>
        <Text style={styles.warnBadgeText}>!</Text>
      </View>
      <Text style={styles.errTitle}>这个版本装不上</Text>
      <Text style={styles.errBody}>
        这套页面包要求 runtimeVersion {requiredRuntime}，当前壳为 {currentRuntime}，
        更新不会被接受。请到内部分发页更新壳 App。
      </Text>
      <Text style={styles.errHint}>壳会自动留在上一个能跑的版本，你的工作不会丢。</Text>
      <View style={styles.updateActions}>
        <Pressable onPress={onRetry} style={[styles.btn, styles.btnGhost]}>
          <Text style={styles.btnGhostText}>重试</Text>
        </Pressable>
        <Pressable onPress={onFallback} style={[styles.btn, styles.btnPrimary]}>
          <Text style={styles.btnPrimaryText}>回到上一个可用版本</Text>
        </Pressable>
      </View>
      {adminName && (
        <Text style={styles.errHint}>仍不行请联系平台管理员（{adminName}）</Text>
      )}
    </View>
  );
}

const C = {
  canvas: '#fcfcf8',
  surface: '#ffffff',
  ink: '#1c1f23',
  sub: '#545659',
  tertiary: '#787c80',
  border: 'rgba(0,0,0,.08)',
  orange: '#fb923c',
  orangeSubtle: '#fff6ed',
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.canvas },

  entry: {
    position: 'absolute',
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,.9)',
    borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center',
    zIndex: 9999,
  },

  visitingBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingBottom: 8,
    backgroundColor: C.orangeSubtle,
    borderBottomWidth: 1, borderBottomColor: C.orange,
  },
  visitingAvatar: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: C.orange,
    alignItems: 'center', justifyContent: 'center',
  },
  visitingAvatarText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  visitingText: { flex: 1, fontSize: 13, color: C.ink },
  visitingExit: { fontSize: 13, color: C.orange, fontWeight: '500' },

  updateCard: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: C.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderColor: C.border,
    padding: 18, gap: 6,
  },
  updateHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  updateVersion: { fontSize: 13, fontWeight: '600', color: C.ink },
  updateMeta: { fontSize: 11, color: C.tertiary },
  updateTitle: { fontSize: 15, fontWeight: '600', color: C.ink, marginTop: 2 },
  updateNote: { fontSize: 13, color: C.sub },
  updateActions: { flexDirection: 'row', gap: 10, marginTop: 12 },

  btn: { flex: 1, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: '#f5f5f3' },
  btnGhostText: { fontSize: 14, color: C.ink },
  btnPrimary: { backgroundColor: C.ink },
  btnPrimaryText: { fontSize: 14, color: '#fff', fontWeight: '500' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 8, backgroundColor: C.canvas },
  warnBadge: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: '#fff1eb',
    alignItems: 'center', justifyContent: 'center', marginBottom: 8,
  },
  warnBadgeText: { fontSize: 22, color: '#f8672f', fontWeight: '700' },
  errTitle: { fontSize: 17, fontWeight: '700', color: C.ink },
  errBody: { fontSize: 14, color: C.sub, textAlign: 'center', lineHeight: 21 },
  errHint: { fontSize: 12, color: C.tertiary, textAlign: 'center', marginTop: 4 },
});
