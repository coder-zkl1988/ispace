/**
 * 语音面板的纯状态判断。
 *
 * 单独成文件是为了能被测到：voice.ts 会 import expo-av，那是原生模块，
 * 在 Node 测试环境里连解析都过不去。把不依赖原生的判断挪出来，
 * 逻辑就能被钉住。
 */

export interface VoicePanelState {
  listening: boolean;
  /** 录完了、正在上传转写。这段时间面板必须留着，否则用户以为白说了。 */
  transcribing: boolean;
  partial: string;
  error: string | null;
}

/**
 * 面板该不该显示。
 *
 * 这条判断错过一次，而且是最难发现的那种错法：原先只看 listening || partial，
 * 而错误处理会把两者一起清空——面板连同刚写进去的错误信息一起消失，
 * 用户只看到「它自己收起来了」，没有任何线索。
 * 错误必须能留住面板，否则那句解释永远看不到。
 */
export function isPanelOpen(v: VoicePanelState): boolean {
  return v.listening || v.transcribing || v.partial.length > 0 || v.error !== null;
}
