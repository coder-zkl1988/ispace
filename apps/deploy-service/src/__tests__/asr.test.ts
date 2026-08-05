import { describe, expect, it } from 'vitest';
import { parseAsrSse } from '../routes/voice.js';

/**
 * ASR 的 SSE 解析。
 *
 * 上游先推若干 delta，最后一条 done 带完整文本。实测的 delta 切分点在词
 * 中间——「把首页」「的排班标签换成今日」「待办，逾期的排」「最上面。」——
 * 所以必须优先用 done。自己拼 delta 在边界上很容易多字或少字，
 * 而这段文字是要直接交给模型当需求描述的，错一个字意思就变了。
 */

const sse = (events: object[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n`).join('\n');

describe('取最终文本', () => {
  it('优先用 done 的完整文本，不拼 delta', () => {
    const raw = sse([
      { type: 'transcript.text.delta', delta: '把首页' },
      { type: 'transcript.text.delta', delta: '的排班标签换成今日' },
      { type: 'transcript.text.delta', delta: '待办，逾期的排' },
      { type: 'transcript.text.delta', delta: '最上面。' },
      { type: 'transcript.text.done', text: '把首页的排班标签换成今日待办，逾期的排最上面。' },
    ]);
    expect(parseAsrSse(raw)).toBe('把首页的排班标签换成今日待办，逾期的排最上面。');
  });

  it('done 与 delta 拼接结果不一致时以 done 为准', () => {
    // 上游修正过 delta 的情况。信 done，不信自己拼的。
    const raw = sse([
      { type: 'transcript.text.delta', delta: '代办' },
      { type: 'transcript.text.done', text: '待办' },
    ]);
    expect(parseAsrSse(raw)).toBe('待办');
  });

  it('没有 done 时才回退到拼 delta', () => {
    // 连接中途断掉，但已经收到的部分仍然可用——总比让用户白说一遍强
    const raw = sse([
      { type: 'transcript.text.delta', delta: '把首页' },
      { type: 'transcript.text.delta', delta: '改一下' },
    ]);
    expect(parseAsrSse(raw)).toBe('把首页改一下');
  });
});

describe('畸形输入', () => {
  it('空流返回 null，而不是空串', () => {
    // 空串会被当成"用户什么都没说"塞进输入框；null 才能触发"转写失败"的提示
    expect(parseAsrSse('')).toBeNull();
    expect(parseAsrSse('\n\n')).toBeNull();
  });

  it('夹杂非 JSON 的行不影响解析', () => {
    const raw =
      ': keep-alive\n\n' +
      'data: 这不是 JSON\n\n' +
      'data: [DONE]\n\n' +
      `data: ${JSON.stringify({ type: 'transcript.text.done', text: '好的' })}\n`;
    expect(parseAsrSse(raw)).toBe('好的');
  });

  it('只有心跳与 [DONE] 时返回 null', () => {
    expect(parseAsrSse(': ping\n\ndata: [DONE]\n')).toBeNull();
  });

  it('done 的 text 不是字符串时不当成结果', () => {
    const raw = sse([
      { type: 'transcript.text.delta', delta: '兜底文本' },
      { type: 'transcript.text.done', text: null },
    ]);
    expect(parseAsrSse(raw)).toBe('兜底文本');
  });

  it('首尾空白被去掉', () => {
    expect(parseAsrSse(sse([{ type: 'transcript.text.done', text: '  两边有空格  ' }])))
      .toBe('两边有空格');
  });
});
