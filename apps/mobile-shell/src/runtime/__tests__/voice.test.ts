import { describe, expect, it } from 'vitest';
import { isPanelOpen } from '../voice-state';

/**
 * 语音面板的显示条件。
 *
 * 这条判断错过一次，而且是最难发现的那种错法：出错时 listening 与 partial
 * 被一起清空，面板连同刚写进去的错误信息一起消失——用户看到的只是
 * 「它自己收起来了」，没有任何线索。实测荣耀机上就是这样：设备的识别服务
 * 走 Google 在线识别、在公司网络里连不上，每次都无声无息地关掉。
 */

const st = (o: Partial<Parameters<typeof isPanelOpen>[0]>) =>
  ({ listening: false, transcribing: false, partial: '', error: null, ...o });

describe('面板显示条件', () => {
  it('收音中显示', () => {
    expect(isPanelOpen(st({ listening: true }))).toBe(true);
  });

  it('有识别文本时显示——停下后要留住结果等用户确认', () => {
    expect(isPanelOpen(st({ partial: '把首页改一下' }))).toBe(true);
  });

  it('有错误时必须显示，这是回归用例', () => {
    // 三项里只有 error 有值：正是出错那一刻的状态。
    // 这里若为 false，用户就永远看不到失败原因。
    expect(isPanelOpen(st({ error: '设备自带的识别服务连不上' }))).toBe(true);
  });

  it('上传转写期间必须显示——那段没有任何结果，关掉等于让用户以为白说了', () => {
    expect(isPanelOpen(st({ transcribing: true }))).toBe(true);
  });

  it('四者皆空才关闭', () => {
    expect(isPanelOpen(st({}))).toBe(false);
  });

  it('空字符串的错误也算有错', () => {
    // 上游给个空 message 时不该把面板关掉——那和没报错是两回事
    expect(isPanelOpen(st({ error: '' }))).toBe(true);
  });
});
