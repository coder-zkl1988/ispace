import { useEffect, useRef } from 'react';
import {
  ActivityIndicator, Animated, Modal, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { isPanelOpen, type VoiceInput } from '../runtime/voice';

/**
 * 语音输入面板（设计稿手机壳第 05 屏「语音说需求」）。
 *
 * 尺寸与配色取自设计稿实测：
 *   面板   402 宽 × 330 高，白底，圆角 24/24/0/0（底部抽屉），内边距 22/22/28
 *   「正在听」12px #545659
 *   计时器  12px #787c80
 *   实时文字 15px #1c1f23，行高 25.5
 *   取消    白底 #1c1f23 字，146×48，圆角 12
 *   发送这段 #1c1f23 底白字 600 字重，202×46，圆角 12
 *   波形    4px 宽橙色竖条 #fb923c，静默时 10% 透明度
 *
 * 交互按设计稿注解：「松手即转文字，可先改字再发」——所以「发送这段」
 * 是把文本落进输入框，不是直接发出去。中间留一步给人改字。
 */

const WAVE_BARS = 9;

export function VoicePanel({ voice }: { voice: VoiceInput }) {
  /**
   * 出错时也要留住面板。
   *
   * 之前只看 listening || partial，而错误处理会把这两者一起清空——
   * 面板连同刚写进去的错误信息一起消失，用户看到的只是"它自己收起来了"，
   * 完全不知道发生了什么。实测荣耀机上就是这个：设备的识别服务走
   * Google 在线识别、在公司网络里连不上，每次都无声无息地关掉。
   */
  const open = isPanelOpen(voice);

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={voice.cancel}>
      {/* 点遮罩即取消。语音面板挡住了整个对话，必须有条明显的退路。 */}
      <Pressable style={s.scrim} onPress={voice.cancel}>
        <Pressable style={s.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={s.head}>
            <Text style={s.listening}>{headlineFor(voice)}</Text>
            <Text style={s.timer}>{fmtDuration(voice.seconds)}</Text>
          </View>

          <Wave level={voice.level} active={voice.listening} />

          <View style={s.textArea}>
            <Text style={[s.live, !voice.partial && s.livePlaceholder]}>
              {voice.partial || placeholderFor(voice)}
            </Text>
          </View>

          {voice.error && <Text style={s.err}>{voice.error}</Text>}

          <View style={s.actions}>
            <Pressable style={s.cancel} onPress={voice.cancel}>
              <Text style={s.cancelText}>{voice.error ? '知道了' : '取消'}</Text>
            </Pressable>
            <PrimaryAction voice={voice} />
          </View>

          <Text style={s.hint}>
            {voice.error ? '换个安静点的地方，或直接打字也行'
              : voice.partial ? '可以先改字再发'
              : '识别在公司服务器上完成，音频不会留存'}
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * 主按钮。它在三种状态间切换，缺一不可：
 *
 *   出错     → 再说一遍（此时没有文本可发，用户下一步想做的就是重试）
 *   收音中   → 说完了（**这一条之前漏了**）
 *   有文本   → 发送这段
 *
 * 漏掉「说完了」的后果：云端识别没有静音自动停（设备识别有），而停止操作
 * 只挂在输入区的麦克风按钮上——那个按钮被这个面板盖住。于是录音一直跑，
 * 永远没有文本，「发送这段」永远置灰。实测就是这个死局。
 */
function PrimaryAction({ voice }: { voice: VoiceInput }) {
  if (voice.transcribing) {
    // 转写期间不给任何主操作：此时既没有文本可发，重新开始也只会
    // 丢掉刚录的那段。让它明确地"忙"着。
    return (
      <View style={[s.send, { opacity: 0.5 }]}>
        <ActivityIndicator color="#fff" size="small" />
      </View>
    );
  }
  if (voice.error) {
    return (
      <Pressable style={s.send} onPress={() => { voice.cancel(); void voice.start(); }}>
        <Text style={s.sendText}>再说一遍</Text>
      </Pressable>
    );
  }
  if (voice.listening) {
    return (
      <Pressable style={s.send} onPress={voice.stop}>
        <Text style={s.sendText}>说完了</Text>
      </Pressable>
    );
  }
  const empty = !voice.partial.trim();
  return (
    <Pressable
      style={[s.send, empty && { opacity: 0.35 }]}
      disabled={empty}
      onPress={voice.accept}
    >
      <Text style={s.sendText}>发送这段</Text>
    </Pressable>
  );
}

/** 标题。三个阶段各不相同，别让用户对着同一句话猜进度。 */
function headlineFor(voice: VoiceInput): string {
  if (voice.error) return '没听成';
  if (voice.transcribing) return '正在识别';
  if (voice.listening) return '正在听';
  return '听完了';
}

/** 正文区的占位文案。 */
function placeholderFor(voice: VoiceInput): string {
  if (voice.transcribing) {
    // 这段没有任何中间结果，必须明说在等什么，否则看着像卡住了
    return '录音已上传，正在转成文字…';
  }
  if (voice.listening) {
    // 转写在服务端做，说的时候不出字是正常的——不写清楚用户会以为坏了
    return '在听。说完点「说完了」，录音会上传到公司的转写服务转成文字。';
  }
  return '点麦克风开始说，比如「把首页的排班 tab 换成今日待办」';
}

/**
 * 音量波形。
 *
 * 每根条的高度 = 基础高度 × 当前音量，再按位置错开一点，看起来像在起伏。
 * 用 Animated 而非每帧 setState：音量事件来得很密，走 state 会让整个面板
 * 每秒重渲染几十次，实时文字跟着闪。
 */
function Wave({ level, active }: { level: number; active: boolean }) {
  const anims = useRef(
    Array.from({ length: WAVE_BARS }, () => new Animated.Value(0.15)),
  ).current;

  useEffect(() => {
    // 中间高两边低，形成一个自然的包络
    anims.forEach((a, i) => {
      const shape = 1 - Math.abs(i - (WAVE_BARS - 1) / 2) / WAVE_BARS;
      const target = active ? Math.max(0.15, level * shape * 1.6) : 0.15;
      Animated.timing(a, { toValue: target, duration: 120, useNativeDriver: false }).start();
    });
  }, [level, active, anims]);

  return (
    <View style={s.wave}>
      {anims.map((a, i) => (
        <Animated.View
          key={i}
          style={[
            s.bar,
            {
              height: a.interpolate({ inputRange: [0, 1], outputRange: [8, 48] }),
              backgroundColor: active ? C.orange : C.orangeIdle,
            },
          ]}
        />
      ))}
    </View>
  );
}

/** 0:07 这种。超过一分钟按 m:ss 显示。 */
function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s2 = sec % 60;
  return `${m}:${String(s2).padStart(2, '0')}`;
}

const C = {
  surface: '#fff', ink: '#1c1f23', sub: '#545659', tertiary: '#787c80',
  border: 'rgba(0,0,0,.08)', orange: '#fb923c', orangeIdle: 'rgba(251,146,60,.1)',
  danger: '#d1493f',
};

const s = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(4,32,40,.32)' },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 22, paddingHorizontal: 22, paddingBottom: 28,
    minHeight: 330,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  listening: { fontSize: 12, color: C.sub },
  timer: { fontSize: 12, color: C.tertiary, fontVariant: ['tabular-nums'] },
  wave: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, height: 56, marginTop: 14,
  },
  bar: { width: 4, borderRadius: 2 },
  textArea: { flex: 1, minHeight: 96, marginTop: 14 },
  live: { fontSize: 15, lineHeight: 25.5, color: C.ink },
  livePlaceholder: { color: C.tertiary },
  err: { fontSize: 12, color: C.danger, marginTop: 8 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancel: {
    height: 48, flex: 1, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  cancelText: { fontSize: 15, color: C.ink },
  send: {
    height: 46, flex: 1.4, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', backgroundColor: C.ink,
  },
  sendText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  hint: { fontSize: 12, color: C.tertiary, textAlign: 'center', marginTop: 12 },
});
