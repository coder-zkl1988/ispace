import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Dimensions, Keyboard, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { pickImage, session } from '../runtime/bridge';
import { useVoiceInput } from '../runtime/voice';
import { VoicePanel } from './VoicePanel';
import { Icon } from './Icon';
import { API_BASE } from '../config';

/**
 * 开发者身份的首页：与 Coding Agent 的对话页（设计稿第 04–06 屏）。
 *
 * 「使用者身份：只看到自己的应用，看不到任何开发入口。在设置里可以切成
 * 开发者。」——切成开发者后，首页就变成这个页面。
 *
 * 三件设计稿要求、且都影响可用性的事：
 *   - 改动摘要而非 diff 原文：手机屏太小，贴 diff 没人看
 *   - 部署必须二次确认：Agent 只能拿到待确认令牌，点「部署上线」才生效
 *   - 截图随 prompt 传：门店走动时拍一张比打字快，这是要在手机上开发的主要理由
 */

interface Msg {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
}

interface PendingDeploy {
  confirmToken: string;
  site: string;
  summary: string;
}

/** 这次对话在改哪个页面。null 表示要做一个新的。 */
export interface EditTarget {
  slug: string;
  name: string;
  letter: string;
}

export function AgentChat({
  username, target, targets, onPickTarget, onKeyboard,
}: {
  username: string;
  target: EditTarget | null;
  /** 可供选择的页面（只含本人的，别人的改不了）。 */
  targets: EditTarget[];
  onPickTarget: (t: EditTarget | null) => void;
  /** 键盘起落。由外层决定要不要把底部 tab 收起来。 */
  onKeyboard?: (up: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const [picking, setPicking] = useState(false);

  /*
    自己盯键盘高度，不靠 KeyboardAvoidingView。

    Expo 54 起安卓默认 edge-to-edge，manifest 里的 adjustResize 不再真的
    缩窗口——窗口尺寸不变，输入框被键盘整个盖住，而 KeyboardAvoidingView
    在安卓上本来就是关着的（behavior undefined）。两边一叠，就是"打字时
    看不见自己在打什么"。

    拿到高度后自己把输入栏顶上去，顺带把底部 tab 收起来：键盘已经占了
    半屏，那四个 tab 这时候既点不到也没人想点。
  */
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, (e) => {
      /*
        用「屏幕高 − 键盘顶边」而不是 endCoordinates.height。

        edge-to-edge 下 height 报的是键盘自己那块，不含候选词条等另开的
        窗口，也不含导航栏——按它算会差个几十像素，输入框底边正好压在
        候选栏下面（实测荣耀 + 系统输入法就是这样）。screenY 是键盘顶边
        在屏幕坐标里的绝对位置，减出来就是"屏幕底部被挡了多少"，与是谁
        挡的无关。
      */
      const occluded = Dimensions.get('screen').height - e.endCoordinates.screenY;
      setKb(Math.max(0, occluded));
      onKeyboard?.(true);
    });
    const b = Keyboard.addListener(hideEvt, () => { setKb(0); onKeyboard?.(false); });
    return () => { a.remove(); b.remove(); };
  }, [onKeyboard]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<{ mimeType: string; dataBase64: string }[]>([]);

  // 语音识别结果**追加**而非覆盖：用户可能先打了一半字再改用说的，
  // 覆盖会把已经输入的内容吃掉。
  // 令牌用于服务端转写兜底（本地没有 ASR 时）。异步取，取到前语音入口按不可用处理。
  const [voiceToken, setVoiceToken] = useState<string | null>(null);
  useEffect(() => { void session.get().then(setVoiceToken).catch(() => setVoiceToken(null)); }, []);

  const voice = useVoiceInput(
    (text) => setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text)),
    { apiBase: API_BASE, token: voiceToken },
  );
  const [pending, setPending] = useState<PendingDeploy | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const scroller = useRef<ScrollView>(null);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    setMsgs((m) => [...m, { role: 'user', text }]);
    setInput('');
    setBusy(true);
    const imgs = images;
    setImages([]);

    const token = await session.get();
    if (!token) {
      setMsgs((m) => [...m, { role: 'assistant', text: '登录状态失效，请重新登录。' }]);
      setBusy(false);
      return;
    }

    // 先放一个空的助手气泡，流式片段往里追加
    setMsgs((m) => [...m, { role: 'assistant', text: '' }]);

    try {
      const res = await fetch(`${API_BASE}/deploy/api/agent/ask`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId.current, text, images: imgs,
          // 让模型不必从话里猜「改一改」指的是哪个页面。服务端会把它
          // 变成一条上下文：发布时覆盖这个 slug，而不是新建一个。
          ...(target ? { targetSlug: target.slug } : {}),
        }),
      });

      // React Native 的 fetch 不支持流式读取 body，只能整体拿到后再解析。
      // 代价是逐字输出变成"一次性出现"——在手机上这个差别可接受，
      // 换来的是不必引入第三方 SSE 库或改用 WebSocket。
      const raw = await res.text();
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(line.slice(5)) as Record<string, unknown>; } catch { continue; }

        if (e.type === 'session') sessionId.current = e.id as string;
        else if (e.type === 'text') {
          setMsgs((m) => {
            const last = m[m.length - 1];
            if (last?.role !== 'assistant') return m;
            return [...m.slice(0, -1), { ...last, text: last.text + (e.delta as string) }];
          });
        } else if (e.type === 'tool_start') {
          setMsgs((m) => [...m, { role: 'tool', text: '', toolName: e.name as string }]);
        } else if (e.type === 'error') {
          setMsgs((m) => [...m, { role: 'assistant', text: `出错了：${e.message as string}` }]);
        }
      }

      // 拉取待确认的发布请求
      const p = await fetch(`${API_BASE}/deploy/api/agent/pending`, {
        headers: { authorization: `Bearer ${token}` },
      }).then((r) => r.json() as Promise<{ items: PendingDeploy[] }>).catch(() => ({ items: [] }));
      setPending(p.items[0] ?? null);
    } catch (e) {
      setMsgs((m) => [...m, {
        role: 'assistant',
        text: `连接失败：${e instanceof Error ? e.message : String(e)}`,
      }]);
    } finally {
      setBusy(false);
      setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 60);
    }
  }, [input, busy, images]);

  const confirmDeploy = useCallback(async () => {
    if (!pending) return;
    const token = await session.get();
    if (!token) return;
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/deploy/api/agent/confirm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirmToken: pending.confirmToken }),
      }).then((x) => x.json() as Promise<{ ok?: boolean; next?: string; message?: string }>);
      setMsgs((m) => [...m, { role: 'assistant', text: r.ok ? (r.next ?? '已确认') : (r.message ?? '确认失败') }]);
      setPending(null);
    } finally { setBusy(false); }
  }, [pending]);

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top}
      onLayout={() => scroller.current?.scrollToEnd({ animated: false })}
    >
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>开发</Text>
          <Text style={s.sub}>u-{username}</Text>
        </View>
        {/* 右上角留出壳保留位的宽度 */}
        <View style={{ width: 40 }} />
      </View>

      {/*
        「在改哪个」。

        这条是整个对话的主语：不指明的话，用户说「把标题改大一点」，
        模型只能猜他指的是哪一个页面，猜错就发布成了另一个页面。
        选中之后 slug 随每条消息发给服务端，发布时覆盖同一个 slug ——
        这才是"编辑"，而不是"又做了一个"。
      */}
      <Pressable style={s.targetBar} onPress={() => setPicking(true)}>
        <View style={[s.targetIcon, !target && s.targetIconNew]}>
          <Text style={[s.targetLetter, !target && s.targetLetterNew]}>
            {target ? target.letter : '＋'}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.targetLabel}>{target ? '正在改' : '要做的是'}</Text>
          <Text style={s.targetName} numberOfLines={1}>
            {target ? target.name : '一个新页面'}
          </Text>
        </View>
        <Text style={s.targetSwitch}>切换</Text>
      </Pressable>

      {picking && (
        <View style={s.pickMask}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPicking(false)} />
          <View style={[s.pickSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={s.pickTitle}>这次要改哪个？</Text>
            <ScrollView style={{ maxHeight: 320 }}>
              <Pressable
                style={s.pickRow}
                onPress={() => { onPickTarget(null); setPicking(false); }}
              >
                <View style={[s.targetIcon, s.targetIconNew]}>
                  <Text style={[s.targetLetter, s.targetLetterNew]}>＋</Text>
                </View>
                <Text style={s.pickName}>做一个新页面</Text>
              </Pressable>
              {targets.map((t) => (
                <Pressable
                  key={t.slug}
                  style={s.pickRow}
                  onPress={() => { onPickTarget(t); setPicking(false); }}
                >
                  <View style={s.targetIcon}><Text style={s.targetLetter}>{t.letter}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.pickName} numberOfLines={1}>{t.name}</Text>
                    <Text style={s.pickSlug}>/{t.slug}/</Text>
                  </View>
                </Pressable>
              ))}
              {targets.length === 0 && (
                <Text style={s.pickEmpty}>
                  你还没有发布过页面。先说一句想做什么，做出来之后就能在这里选它继续改。
                </Text>
              )}
            </ScrollView>
          </View>
        </View>
      )}

      <ScrollView ref={scroller} style={{ flex: 1 }} contentContainerStyle={s.list}>
        {msgs.length === 0 && (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>说一句你想改什么</Text>
            <Text style={s.emptyBody}>
              比如「把首页的『排班』tab 换成『今日待办』，逾期的排最上面」。{'\n'}
              也可以附一张截图，说「照这个样式改一下卡片」。
            </Text>
          </View>
        )}
        {msgs.map((m, i) =>
          m.role === 'tool' ? (
            <Text key={i} style={s.toolLine}>· {toolLabel(m.toolName)}</Text>
          ) : (
            <View key={i} style={[s.bubble, m.role === 'user' ? s.bubbleUser : s.bubbleBot]}>
              <Text style={m.role === 'user' ? s.bubbleUserText : s.bubbleBotText}>
                {m.text || (busy && i === msgs.length - 1 ? '…' : '')}
              </Text>
            </View>
          ),
        )}
      </ScrollView>

      {/* 二次确认卡：Agent 无权直接发布，必须由人点这一下 */}
      {pending && (
        <View style={s.confirm}>
          <Text style={s.confirmTitle}>要把改动发布到 /{pending.site} 吗</Text>
          <Text style={s.confirmBody}>{pending.summary}</Text>
          <View style={s.confirmActions}>
            <Pressable style={[s.btn, s.btnGhost]} onPress={() => setPending(null)}>
              <Text style={s.btnGhostText}>继续改</Text>
            </Pressable>
            <Pressable style={[s.btn, s.btnPrimary]} disabled={busy} onPress={() => void confirmDeploy()}>
              <Text style={s.btnPrimaryText}>部署上线</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={[
        s.composer,
        // 键盘弹起时贴着键盘顶；收起时留安全区
        { paddingBottom: kb > 0 ? 8 : insets.bottom || 10, marginBottom: kb },
      ]}>
        {images.length > 0 && (
          <Text style={s.imgHint}>已附 {images.length} 张截图</Text>
        )}
        {/* 设备没有识别服务时给一句说明，别让灰按钮变成哑谜 */}
        {!voice.available && (
          <Text style={s.voiceHint}>这台设备没有可用的语音识别服务，语音输入不可用</Text>
        )}
        <View style={s.composerRow}>
          <Pressable
            style={s.plus}
            onPress={() => {
              void pickImage().then((r) => {
                if (r?.base64) setImages((x) => [...x, { mimeType: 'image/jpeg', dataBase64: r.base64! }]);
              }).catch(() => { /* 闸门关闭或用户取消，静默 */ });
            }}
          >
            <Icon name="plus" size={21} color={C.sub} />
          </Pressable>
          <TextInput
            style={s.input}
            value={input}
            onChangeText={setInput}
            placeholder="描述你想改什么"
            placeholderTextColor="#909599"
            multiline
            editable={!busy}
          />
          {/* 设备没有识别服务时置灰并说明，不静默失效——
              实测两家国产机型都有，但不保证全覆盖。 */}
          <Pressable
            style={[
              s.mic,
              voice.listening && s.micOn,
              (!voice.available || busy) && { opacity: 0.35 },
            ]}
            disabled={!voice.available || busy}
            onPress={() => {
              if (!voice.available) return;
              void voice.start();
            }}
          >
            <Icon
              name={voice.listening ? 'stop' : 'mic'}
              size={18}
              color={voice.listening ? '#fff' : C.sub}
            />
          </Pressable>
          <Pressable
            style={[s.send, (!input.trim() || busy) && { opacity: 0.4 }]}
            disabled={!input.trim() || busy}
            onPress={() => void send()}
          >
            {busy
              ? <ActivityIndicator color="#fff" size="small" />
              : <Icon name="send" size={18} color="#fff" />}
          </Pressable>
        </View>
      </View>

      <VoicePanel voice={voice} />
    </KeyboardAvoidingView>
  );
}

/** 工具名转成人话。设计稿要求的是"改动摘要"，不是把工具调用原样抛给用户。 */
function toolLabel(name?: string): string {
  switch (name) {
    case 'list_files': return '看了一眼项目结构';
    case 'read_file': return '读了文件';
    case 'write_file': return '改了文件';
    case 'delete_file': return '删了文件';
    case 'get_quota': return '查了配额';
    case 'list_apps': return '看了已部署的应用';
    case 'request_deploy': return '请求发布';
    default: return name ?? '处理中';
  }
}

const C = {
  canvas: '#fcfcf8', surface: '#fff', ink: '#1c1f23', sub: '#545659',
  tertiary: '#787c80', border: 'rgba(0,0,0,.08)', orange: '#fb923c',
  orangeSubtle: '#fff6ed',
};

const s = StyleSheet.create({
  targetBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 9,
    backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,.06)',
  },
  targetIcon: {
    width: 32, height: 32, borderRadius: 9, backgroundColor: '#fb923c',
    alignItems: 'center', justifyContent: 'center',
  },
  targetIconNew: {
    backgroundColor: '#f4f5f6',
    borderWidth: 1, borderColor: 'rgba(0,0,0,.08)', borderStyle: 'dashed',
  },
  targetLetter: { color: '#fff', fontSize: 15, fontWeight: '700' },
  targetLetterNew: { color: '#787c80' },
  targetLabel: { fontSize: 10, color: '#909599' },
  targetName: { fontSize: 14, fontWeight: '600', color: '#001217' },
  targetSwitch: { fontSize: 12.5, color: '#fb923c', fontWeight: '600' },

  pickMask: {
    ...StyleSheet.absoluteFillObject, zIndex: 50,
    backgroundColor: 'rgba(0,0,0,.42)', justifyContent: 'flex-end',
  },
  pickSheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 18, gap: 6,
  },
  pickTitle: { fontSize: 16, fontWeight: '800', color: '#001217', marginBottom: 6 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10 },
  pickName: { fontSize: 14.5, color: '#001217', fontWeight: '500' },
  pickSlug: { fontSize: 11, color: '#909599', marginTop: 1 },
  pickEmpty: { fontSize: 13, color: '#787c80', lineHeight: 21, paddingVertical: 14 },

  root: { flex: 1, backgroundColor: C.canvas },
  mic: {
    width: 36, height: 36, borderRadius: 18, marginRight: 6,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  micOn: { backgroundColor: C.orange, borderColor: C.orange },
  micText: { fontSize: 15, color: C.sub },
  voiceHint: { fontSize: 12, color: C.tertiary, marginBottom: 6 },
  voiceErr: { fontSize: 12, color: '#d1493f', marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10 },
  title: { fontSize: 20, fontWeight: '700', color: '#001217' },
  sub: { fontSize: 11, color: C.tertiary, marginTop: 1 },

  list: { padding: 16, gap: 10 },
  empty: { paddingTop: 60, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: C.ink },
  emptyBody: { fontSize: 13, color: C.sub, textAlign: 'center', lineHeight: 21 },

  bubble: { maxWidth: '86%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: C.ink },
  bubbleBot: { alignSelf: 'flex-start', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  bubbleUserText: { color: '#fff', fontSize: 14, lineHeight: 21 },
  bubbleBotText: { color: C.ink, fontSize: 14, lineHeight: 21 },
  toolLine: { fontSize: 12, color: C.tertiary, marginLeft: 4 },

  confirm: {
    margin: 12, padding: 14, borderRadius: 16,
    backgroundColor: C.orangeSubtle, borderWidth: 1, borderColor: C.orange, gap: 4,
  },
  confirmTitle: { fontSize: 15, fontWeight: '600', color: C.ink },
  confirmBody: { fontSize: 13, color: C.sub, lineHeight: 20 },
  confirmActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: { flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: 'rgba(255,255,255,.7)' },
  btnGhostText: { fontSize: 14, color: C.ink },
  btnPrimary: { backgroundColor: C.ink },
  btnPrimaryText: { fontSize: 14, color: '#fff', fontWeight: '500' },

  composer: {
    borderTopWidth: 1, borderTopColor: C.border,
    backgroundColor: 'rgba(255,255,255,.96)', paddingHorizontal: 12, paddingTop: 8,
  },
  imgHint: { fontSize: 12, color: C.orange, marginBottom: 6, marginLeft: 4 },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  plus: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: '#f5f5f3',
    alignItems: 'center', justifyContent: 'center',
  },
  plusText: { fontSize: 20, color: C.sub, lineHeight: 22 },
  input: {
    // 一行高度按 32 收窄：原先 36 配上下 9 的内边距，空了一圈。
    // textAlignVertical 是安卓 multiline 垂直居中的唯一开关，缺了就顶在上边。
    flex: 1, minHeight: 32, maxHeight: 108, borderRadius: 16,
    backgroundColor: '#f5f5f3', paddingHorizontal: 13, paddingVertical: 6,
    fontSize: 14, lineHeight: 19, color: C.ink, textAlignVertical: 'center',
  },
  send: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: C.ink,
    alignItems: 'center', justifyContent: 'center',
  },
  sendText: { color: '#fff', fontSize: 15 },
});
