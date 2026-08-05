import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView,
  Share, StyleSheet, Text, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { API_BASE } from '../config';

/**
 * 手机上的创意市场。
 *
 * 与电脑端同一份数据（/deploy/api/marketplace），但手机上做的事更少：
 * 浏览、装到自己的启动器、看「做同款」的提示词。上架与下架仍只在电脑端
 * ——那是需要斟酌措辞的动作，不适合在通勤路上点。
 */

export interface Listing {
  id: string; app_id: string; slug: string; name: string;
  description: string | null; icon_letter: string; type: string;
  owner_username: string; owner_name: string;
  install_count: number; installed: boolean; mine: boolean;
  source_prompt: string | null;
}

export function Market({ token, onChanged }: {
  token: string | null;
  onChanged: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openPrompt, setOpenPrompt] = useState<Listing | null>(null);

  const auth = token ? { authorization: `Bearer ${token}` } : undefined;

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`${API_BASE}/deploy/api/marketplace`, { headers: auth });
      if (!res.ok) throw new Error('市场加载失败');
      setListings(((await res.json()) as { listings: Listing[] }).listings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '网络不可用');
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const toggleInstall = async (l: Listing) => {
    setBusy(l.app_id); setErr(null);
    try {
      /*
        移除走 /installed/:appId 而不是市场那个卸载端点：后者带
        source='marketplace' 过滤，删不掉同事分享来的。对用户而言
        两者都是「我这儿不要它了」，没必要分。
      */
      const res = l.installed
        ? await fetch(`${API_BASE}/deploy/api/installed/${l.app_id}`, {
            method: 'DELETE', headers: auth,
          })
        : await fetch(`${API_BASE}/deploy/api/marketplace/${l.app_id}/install`, {
            method: 'POST', headers: auth,
          });
      if (!res.ok) throw new Error(l.installed ? '移除失败' : '安装失败');
      setListings((xs) => xs.map((x) =>
        x.app_id === l.app_id ? { ...x, installed: !x.installed } : x));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败');
    } finally { setBusy(null); }
  };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* 市场是底部栏里的一个 tab，回首页点「首页」就行，不必再画返回键 */}
      <View style={s.bar}>
        <Text style={s.barTitle}>创意市场</Text>
      </View>

      {err && <Text style={s.err}>{err}</Text>}

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 12 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#fb923c" />}
      >
        {!loading && listings.length === 0 && (
          <Text style={s.empty}>还没有人上架页面。第一个来的人会被所有人看到。</Text>
        )}

        {listings.map((l) => (
          <View key={l.id} style={s.card}>
            <View style={s.cardHead}>
              <View style={s.icon}><Text style={s.iconText}>{l.icon_letter}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.name} numberOfLines={1}>{l.name}</Text>
                <Text style={s.meta} numberOfLines={1}>
                  {l.owner_name} · {l.install_count} 人在用{l.mine ? ' · 我做的' : ''}
                </Text>
              </View>
            </View>

            {l.description && <Text style={s.desc} numberOfLines={3}>{l.description}</Text>}

            <View style={s.actions}>
              {!l.mine && (
                <Pressable
                  style={[s.btn, l.installed ? s.btnGhost : s.btnPrimary]}
                  onPress={() => void toggleInstall(l)}
                  disabled={busy === l.app_id}
                >
                  <Text style={[s.btnText, l.installed ? s.btnGhostText : s.btnPrimaryText]}>
                    {busy === l.app_id ? '…' : l.installed ? '已装 · 移除' : '装到我这儿'}
                  </Text>
                </Pressable>
              )}
              {l.source_prompt && (
                <Pressable style={[s.btn, s.btnGhost]} onPress={() => setOpenPrompt(l)}>
                  <Text style={[s.btnText, s.btnGhostText]}>做同款</Text>
                </Pressable>
              )}
            </View>
          </View>
        ))}
      </ScrollView>

      {openPrompt && (
        <PromptSheet listing={openPrompt} onClose={() => setOpenPrompt(null)} />
      )}
    </View>
  );
}

/**
 * 「做同款」：把做出这个页面的那段话原样交出去。
 *
 * 手机上没有可靠的剪贴板 API（壳没装 expo-clipboard，加它会改
 * runtimeVersion），所以用系统分享面板——用户可以直接发到自己和
 * AI 的对话里，比复制粘贴还少一步。
 */
function PromptSheet({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const prompt = listing.source_prompt ?? '';
  return (
    <View style={s.sheetMask}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 18 }]}>
        <Text style={s.sheetTitle}>做一个同款「{listing.name}」</Text>
        <Text style={s.sheetHint}>
          把下面这段话发给你的 AI，让它照着做一个属于你的版本——改几个字，
          就是另一个页面。
        </Text>
        <ScrollView style={s.promptBox} contentContainerStyle={{ padding: 14 }}>
          <Text style={s.promptText} selectable>{prompt}</Text>
        </ScrollView>
        <Pressable
          style={[s.btn, s.btnPrimary, { alignSelf: 'stretch', alignItems: 'center' }]}
          onPress={() => void Share.share({ message: prompt })}
        >
          <Text style={[s.btnText, s.btnPrimaryText]}>发给我的 AI</Text>
        </Pressable>
        <Pressable onPress={onClose} style={{ paddingVertical: 12, alignItems: 'center' }}>
          <Text style={s.sheetClose}>关闭</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function MarketLoading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color="#fb923c" />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fcfcf8' },
  bar: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 4 },
  barTitle: { fontSize: 22, fontWeight: '800', color: '#001217' },
  err: {
    marginHorizontal: 16, marginBottom: 6, color: '#b42318', fontSize: 12.5,
    backgroundColor: '#fef3f2', padding: 10, borderRadius: 8,
  },
  empty: { color: '#909599', fontSize: 13, textAlign: 'center', paddingVertical: 50, lineHeight: 21 },

  card: {
    backgroundColor: '#fff', borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: 'rgba(0,0,0,.06)', gap: 10,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  icon: {
    width: 44, height: 44, borderRadius: 12, backgroundColor: '#fb923c',
    alignItems: 'center', justifyContent: 'center',
  },
  iconText: { color: '#fff', fontSize: 19, fontWeight: '700' },
  name: { fontSize: 15.5, fontWeight: '700', color: '#001217' },
  meta: { fontSize: 11.5, color: '#909599', marginTop: 2 },
  desc: { fontSize: 13, color: '#545659', lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 8 },
  btn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 9 },
  btnPrimary: { backgroundColor: '#001217' },
  btnGhost: { backgroundColor: '#f4f5f6' },
  btnText: { fontSize: 13, fontWeight: '600' },
  btnPrimaryText: { color: '#fff' },
  btnGhostText: { color: '#001217' },

  sheetMask: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,.42)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, gap: 10, maxHeight: '82%',
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: '#001217' },
  sheetHint: { fontSize: 12.5, color: '#787c80', lineHeight: 19 },
  promptBox: {
    backgroundColor: '#f8f9fa', borderRadius: 12, maxHeight: 280,
    borderWidth: 1, borderColor: 'rgba(0,0,0,.06)',
  },
  promptText: { fontSize: 13.5, color: '#2b2320', lineHeight: 22 },
  sheetClose: { fontSize: 14, color: '#787c80' },
});
