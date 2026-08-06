import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { checkShellUpdate, type ShellRelease } from '../runtime/shell-update';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  openSystemSettings, permissionStates, setCapabilityEnabled,
  session, type Capability, type PermissionState,
} from '../runtime/bridge';
import { versionInfo } from '../runtime/channel';
import { DISPLAY_HOST } from '../config';

/**
 * 壳设置（设计稿第 08 与 08b 屏）。
 *
 * 设置由壳统一提供，所有人长一样，页面包不参与——这是"内容区全交给用户"
 * 之后，壳必须替所有人兜住的那部分。
 *
 * 切换账号则相反，留在壳菜单里，因为共用手机时需要快速切换。
 */

export interface SettingsProps {
  user: { username: string; displayName: string; identity: 'user' | 'developer' };
  spaceUrl: string;
  bundleVersion: string;
  updateChannel: string;
  autoUpdate: boolean;
  wifiOnly: boolean;
  voiceTextOnly: boolean;
  clearDraftOnLogout: boolean;
  biometricLock: boolean;
  onToggle: (key: SettingKey, v: boolean) => void;
  onCheckUpdate: () => void;
  onRollback: () => void;
  onLogout: () => void;
  onClose: () => void;
}

export type SettingKey =
  | 'autoUpdate' | 'wifiOnly' | 'voiceTextOnly' | 'clearDraftOnLogout' | 'biometricLock';

const CAP_LABEL: Record<Capability, { name: string; why: string }> = {
  camera: { name: '相机', why: '扫码、拍摄' },
  microphone: { name: '麦克风', why: '「开发」里的语音输入' },
  photos: { name: '相册', why: '给 Agent 发截图' },
  notifications: { name: '通知', why: '发布完成、更新到端提醒' },
};

export function Settings(p: SettingsProps) {
  const insets = useSafeAreaInsets();
  const [perms, setPerms] = useState<PermissionState[]>([]);
  /** 壳的新版本。查不到（老壳没有那个原生模块、或没网）就一直是 null。 */
  const [shellUp, setShellUp] = useState<ShellRelease | null>(null);
  useEffect(() => { void checkShellUpdate().then(setShellUp); }, []);
  const v = versionInfo();

  const loadPerms = () => void permissionStates().then(setPerms);
  useEffect(loadPerms, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.head}>
        <Text style={styles.headTitle}>设置</Text>
        <Pressable onPress={p.onClose} hitSlop={10}>
          <Text style={styles.headClose}>完成</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        {/* ── 账号 ─────────────────────────────────────────────── */}
        <View style={styles.profile}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{p.user.displayName.slice(0, 1)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>{p.user.displayName}</Text>
            <Text style={styles.profileUrl}>{p.spaceUrl}</Text>
          </View>
        </View>

        {/*
          原先这里有个「使用者 / 开发者」切换。它存在的唯一理由是当时首页
          只有一屏：想跟 Agent 说话就得靠它把整个首页换掉。现在对话是底部栏
          里的一个 tab，两者并存，这个开关对用户已经没有任何可观察的效果——
          留着只会让人问"我该选哪个"。
        */}

        {/*
          壳自身的新版本。做成一行卡片而不是一段说明：用户在这儿只需要
          决定"装不装"，构建号、装完丢不丢东西这些是他不问就不必知道的。
          版式与启动器里那条「创意市场」一致——同一套语言，不另起炉灶。
        */}
        {shellUp && (
          <Pressable style={styles.shellCard} onPress={() => void Linking.openURL(shellUp.url)}>
            <View style={styles.shellIcon}><Text style={styles.shellIconText}>↓</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.shellTitle}>有新版本 App</Text>
              <Text style={styles.shellBody}>
                {(shellUp.sizeBytes / 1048576).toFixed(0)} MB · 构建 {shellUp.versionCode}
              </Text>
            </View>
            <View style={styles.shellBtn}><Text style={styles.shellBtnText}>更新</Text></View>
          </Pressable>
        )}

        {/* ── 更新 ─────────────────────────────────────────────── */}
        <Section title="更新">
          <Row label="自动接收更新" note="关掉后每次都会先问你">
            <Switch value={p.autoUpdate} onValueChange={(x) => p.onToggle('autoUpdate', x)} />
          </Row>
          <Row label="仅 Wi-Fi 下载" note="页面包一般 1–3 MB">
            <Switch value={p.wifiOnly} onValueChange={(x) => p.onToggle('wifiOnly', x)} />
          </Row>
          <Tap label="检查更新" value={p.bundleVersion} onPress={p.onCheckUpdate} />
          <Tap label="回到上一个版本" note="新版本不好用时自己退回" onPress={p.onRollback} />
        </Section>

        {/* ── 权限 ─────────────────────────────────────────────── */}
        <Section title="权限">
          {perms.map((s) => (
            <Row
              key={s.capability}
              label={CAP_LABEL[s.capability].name}
              note={CAP_LABEL[s.capability].why}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.permState}>
                  {!s.granted ? '未授权' : s.limited ? '仅选中' : '已允许'}
                </Text>
                <Switch
                  value={s.gateOpen}
                  onValueChange={(x) => {
                    void setCapabilityEnabled(s.capability, x).then(loadPerms);
                  }}
                />
              </View>
            </Row>
          ))}
          <Text style={styles.note}>
            这里的开关是壳的闸门：关掉后页面调用会被直接拒绝，即使系统权限仍开着。
            系统权限本身只能到系统设置里改。
          </Text>
          <Tap label="打开系统设置" onPress={() => void openSystemSettings()} />
        </Section>

        {/* ── 隐私与数据 ───────────────────────────────────────── */}
        <Section title="隐私与数据">
          <Row label="语音只留文字" note="转写完即删音频">
            <Switch value={p.voiceTextOnly} onValueChange={(x) => p.onToggle('voiceTextOnly', x)} />
          </Row>
          <Row label="退出时清除本地草稿" note="共用手机时建议开">
            <Switch
              value={p.clearDraftOnLogout}
              onValueChange={(x) => p.onToggle('clearDraftOnLogout', x)}
            />
          </Row>
          <Text style={styles.note}>
            客户手机号、病历、影像属于受管数据，不要放进个人应用。
          </Text>
        </Section>

        {/* ── 安全 ─────────────────────────────────────────────── */}
        <Section title="安全">
          <Row label="Face ID / 指纹解锁" note="回到应用时验证">
            <Switch value={p.biometricLock} onValueChange={(x) => p.onToggle('biometricLock', x)} />
          </Row>
        </Section>

        {/* ── 关于 ─────────────────────────────────────────────── */}
        <Section title="关于">
          <Info label="壳版本" value={`${v.runtimeVersion}${v.isEmbedded ? '（内嵌包）' : ''}`} />
          <Info label="页面包版本" value={p.bundleVersion} />
          <Info label="更新通道" value={p.updateChannel} />
          <Info label="更新地址" value={`${DISPLAY_HOST}/updates`} />
        </Section>

        <Pressable
          onPress={() => { void session.clear().then(p.onLogout); }}
          style={styles.logout}
        >
          <Text style={styles.logoutText}>退出登录</Text>
        </Pressable>
        <Text style={[styles.note, { textAlign: 'center', marginTop: 8 }]}>
          共用手机换人用时，退出后由对方重新登录。
        </Text>
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  label, note, children,
}: { label: string; note?: string; children?: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {note && <Text style={styles.rowNote}>{note}</Text>}
      </View>
      {children}
    </View>
  );
}

function Tap({
  label, note, value, onPress,
}: { label: string; note?: string; value?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {note && <Text style={styles.rowNote}>{note}</Text>}
      </View>
      {value && <Text style={styles.rowValue}>{value}</Text>}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { flex: 1 }]}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const C = {
  canvas: '#fcfcf8', surface: '#ffffff', ink: '#1c1f23',
  sub: '#545659', tertiary: '#787c80', border: 'rgba(0,0,0,.06)',
  orange: '#fb923c', orangeSubtle: '#fff6ed', danger: '#f93920',
};

const styles = StyleSheet.create({
  shellCard: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    backgroundColor: '#fff', borderRadius: 14, padding: 12, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(0,0,0,.07)',
  },
  shellIcon: {
    width: 34, height: 34, borderRadius: 11, backgroundColor: '#fb923c',
    alignItems: 'center', justifyContent: 'center',
  },
  shellIconText: { color: '#fff', fontSize: 17, fontWeight: '700', marginTop: -1 },
  shellTitle: { fontSize: 14.5, fontWeight: '600', color: '#001217' },
  shellBody: { fontSize: 11.5, color: '#909599', marginTop: 2 },
  shellBtn: {
    backgroundColor: '#001217', borderRadius: 9,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  shellBtnText: { color: '#fff', fontSize: 12.5, fontWeight: '600' },
  root: { flex: 1, backgroundColor: C.canvas },
  head: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  headTitle: { flex: 1, fontSize: 20, fontWeight: '700', color: '#001217' },
  headClose: { fontSize: 15, color: C.ink },

  profile: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 16, padding: 14,
    backgroundColor: C.surface, borderRadius: 16,
    borderWidth: 1, borderColor: C.border,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: C.orangeSubtle,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 16, fontWeight: '600', color: C.orange },
  profileName: { fontSize: 15, fontWeight: '600', color: C.ink },
  profileUrl: { fontSize: 12, color: C.tertiary, marginTop: 1 },
  badge: {
    fontSize: 11, color: C.orange, backgroundColor: C.orangeSubtle,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100, overflow: 'hidden',
  },

  section: { marginTop: 22 },
  sectionTitle: {
    fontSize: 11, fontWeight: '600', color: C.tertiary,
    letterSpacing: 1, marginLeft: 24, marginBottom: 6,
  },
  card: {
    marginHorizontal: 16, backgroundColor: C.surface,
    borderRadius: 16, borderWidth: 1, borderColor: C.border, overflow: 'hidden',
  },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  rowLabel: { fontSize: 14, color: C.ink },
  rowNote: { fontSize: 12, color: C.tertiary, marginTop: 1 },
  rowValue: { fontSize: 13, color: C.sub, maxWidth: 190 },
  chevron: { fontSize: 18, color: '#c8ccd0' },
  permState: { fontSize: 12, color: C.tertiary },

  segment: { flexDirection: 'row', padding: 4, gap: 4 },
  segmentItem: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center' },
  segmentItemOn: { backgroundColor: C.ink },
  segmentText: { fontSize: 14, color: C.sub },
  segmentTextOn: { color: '#fff', fontWeight: '600' },

  note: {
    fontSize: 12, color: C.tertiary, lineHeight: 18,
    marginHorizontal: 24, marginTop: 6,
  },

  logout: {
    marginHorizontal: 16, marginTop: 26, height: 46,
    borderRadius: 12, backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center',
  },
  logoutText: { fontSize: 15, color: C.danger },
});
