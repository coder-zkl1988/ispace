import { useCallback, useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';

/**
 * 语音转文字（规格 §5.8）。走服务端转写，不用设备自带的识别服务。
 *
 * ┌─ 为什么不用设备本地识别 ───────────────────────────────────────────┐
 * │ 试过，实测不可靠：识别服务由厂商决定，各家行为完全不同。            │
 * │   HONOR  → 默认是 Google 的服务，中文走**在线**识别，请求打到       │
 * │            Google 服务器，公司网络里连不上，每次都是 network 错误。 │
 * │   Redmi  → 小米自己的服务，行为又是另一套。                         │
 * │ 而 isRecognitionAvailable() 返回 true 只说明**装了**，不代表能用——  │
 * │ 这种「装着但用不了」根本探测不出来，只能等它报错。                  │
 * │                                                                     │
 * │ 服务端转写（StepFun stepaudio-2.5-asr）在所有机器上行为一致，       │
 * │ 一条路走到底，不必为每家 ROM 的差异写分支。                          │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 代价与取舍：
 *   - 没有实时字幕：要录完上传才有结果。所以面板上不假装有实时反馈，
 *     只显示计时与波形，说完点「说完了」。
 *   - 音频要离开设备。这一点在面板上明说，不藏着。
 *   - 走服务端中转而不是让手机直连 StepFun：否则 API key 要发到每台设备，
 *     壳一被反编译就等于公开，而它是按量计费的。
 */

export interface VoiceInput {
  /** 已录秒数。设计稿面板上有 0:07 这样的计时。 */
  seconds: number;
  /** 当前音量，0–1。驱动波形，让用户看得出它在收音。 */
  level: number;
  /** 服务端是否配了转写。为假时调用方应禁用入口并说明原因。 */
  available: boolean;
  /** 正在录音。 */
  listening: boolean;
  /** 正在上传转写。这一段没有实时结果，界面要如实表达"在等"。 */
  transcribing: boolean;
  /** 转写出的文本，等用户确认。 */
  partial: string;
  error: string | null;
  start: () => Promise<void>;
  /** 停止录音并上传转写。 */
  stop: () => void;
  /** 采纳文本并关闭。 */
  accept: () => void;
  /** 丢弃并关闭。 */
  cancel: () => void;
}

/**
 * 电平（dB）→ 0–1。
 *
 * 安卓与 iOS 都以 -160 表示静音、0 表示最大。人声正常说话大致落在
 * -40 ~ -10，所以把这一段拉满整个显示范围——用 -160~0 线性映射的话，
 * 说话时波形只会在最底下抖两下，看着像没在收音。
 */
function dbToLevel(db: number): number {
  if (!Number.isFinite(db) || db <= -50) return 0;
  return Math.max(0, Math.min(1, (db + 50) / 45));
}

export function useVoiceInput(
  onText: (text: string) => void,
  opts?: { apiBase?: string; token?: string | null },
): VoiceInput {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);

  const recording = useRef<Audio.Recording | null>(null);
  // 事件回调注册一次即可，不必因调用方每次渲染传进新函数就重新订阅
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  // accept 的闭包里拿不到最新 partial，用 ref 兜住
  const partialRef = useRef('');

  const apiBase = opts?.apiBase;
  const token = opts?.token;

  // ── 能力探测 ────────────────────────────────────────────────────
  useEffect(() => {
    if (!apiBase || !token) { setAvailable(false); return; }
    let alive = true;
    void fetch(`${apiBase}/deploy/api/voice/capability`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { serverTranscription?: boolean } | null) => {
        if (alive) setAvailable(Boolean(d?.serverTranscription));
      })
      .catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, [apiBase, token]);

  // 计时。只在录音时跑，停下即清。
  useEffect(() => {
    if (!listening) return;
    const t = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [listening]);

  // ── 录音 ────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setError(null);
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) {
      setError('需要麦克风权限才能语音输入。可在系统设置里开启。');
      return;
    }
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      /**
       * 开电平计，波形才有真实数据。
       * 安卓侧由 getMaxAmplitude 换算成 dB——文档把 metering 标成
       * @platform ios 是不准的，AVManager.java 里是实现了的。
       *
       * 逐字段取而不是整个展开：tsconfig 开了 exactOptionalPropertyTypes，
       * 展开会把预设里必填的 android/ios 变成「可为 undefined」，类型对不上。
       */
      const recOpts: Audio.RecordingOptions = {
        ...(Audio.RecordingOptionsPresets.HIGH_QUALITY as Audio.RecordingOptions),
        isMeteringEnabled: true,
      } as Audio.RecordingOptions;
      const { recording: rec } = await Audio.Recording.createAsync(
        recOpts,
        (status) => {
          if (typeof status.metering === 'number') setLevel(dbToLevel(status.metering));
        },
        // 100ms 一次。再密对波形的观感没有帮助，只是多耗电。
        100,
      );
      recording.current = rec;
      setListening(true);
      setPartial('');
      partialRef.current = '';
      setSeconds(0);
    } catch (e) {
      setError(`录音启动失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const stop = useCallback(() => {
    const rec = recording.current;
    recording.current = null;
    if (!rec) return;
    setListening(false);
    setLevel(0);
    setTranscribing(true);

    void (async () => {
      try {
        await rec.stopAndUnloadAsync();
        const uri = rec.getURI();
        if (!uri || !apiBase || !token) throw new Error('录音文件不可用');

        // 用 FileSystem 读成 base64。RN 的 fetch 读 file:// 在安卓上不稳。
        const FileSystem = await import('expo-file-system/legacy');
        const audio = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });

        const r = await fetch(`${apiBase}/deploy/api/voice/transcribe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ audio, format: 'm4a' }),
        });
        const body = (await r.json()) as { text?: string; message?: string };
        if (!r.ok) throw new Error(body.message ?? `转写失败（${r.status}）`);
        if (!body.text?.trim()) throw new Error('没听清，再说一遍');
        setPartial(body.text);
        partialRef.current = body.text;
      } catch (e) {
        setPartial('');
        partialRef.current = '';
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setTranscribing(false);
      }
    })();
  }, [apiBase, token]);

  /** 停掉并丢弃录音，不上传。取消与出错都走这里。 */
  const discard = useCallback(() => {
    const rec = recording.current;
    recording.current = null;
    void rec?.stopAndUnloadAsync().catch(() => undefined);
    setListening(false);
    setTranscribing(false);
    setLevel(0);
    setPartial('');
    partialRef.current = '';
    setSeconds(0);
  }, []);

  const accept = useCallback(() => {
    const t = partialRef.current.trim();
    if (t) onTextRef.current(t);
    discard();
    setError(null);
  }, [discard]);

  const cancel = useCallback(() => {
    discard();
    setError(null);
  }, [discard]);

  return {
    available, listening, transcribing, partial, error, seconds, level,
    start, stop, accept, cancel,
  };
}

// 纯状态判断放在 voice-state.ts —— 那里不 import 原生模块，才测得到
export { isPanelOpen, type VoicePanelState } from './voice-state';
