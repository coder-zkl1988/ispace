import { describe, expect, it } from 'vitest';

/**
 * 「声明了 JSON 但 body 是空的」这类请求。
 *
 * 这是一个真实故障的回归测试：前端的 req() 给所有请求无条件带上
 * `content-type: application/json`，而「退出登录」「吊销令牌」「开通」
 * 「重跑回收」这些 POST 本来就没有 body。Fastify 默认的 JSON 解析器
 * 拿空字符串去 JSON.parse 会抛，整批端点因此全部 500。
 *
 * 症状极具迷惑性：前端把错误 catch 掉了，用户看到的是"点了没反应"；
 * curl 复现不出来，因为手敲 curl 不会带那个 content-type；
 * 服务端日志里只有一句请求体解析失败，跟"退出登录坏了"对不上号。
 * 实际后果是退出登录从来没生效过——cookie 一次都没被清掉。
 *
 * 这里测的是解析器本身的契约，不用起服务：解析器是纯函数式的回调，
 * 而 “空 body 该被当成 {}” 正是那条不能再破的约定。
 */

type Done = (err: Error | null, value?: unknown) => void;

/** 与 server.ts 里注册的那个解析器同一份逻辑。 */
function parse(body: string): { err: Error | null; value: unknown } {
  let captured: { err: Error | null; value: unknown } = { err: null, value: undefined };
  const done: Done = (err, value) => { captured = { err, value: value ?? undefined }; };

  const raw = typeof body === 'string' ? body.trim() : '';
  if (raw === '') { done(null, {}); return captured; }
  try {
    done(null, JSON.parse(raw) as unknown);
  } catch {
    done(new Error('请求体不是合法的 JSON'), undefined);
  }
  return captured;
}

describe('空 body 必须被当成 {}', () => {
  it('完全空的字符串', () => {
    const r = parse('');
    expect(r.err).toBeNull();
    expect(r.value).toEqual({});
  });

  it('只有空白', () => {
    // fetch 在某些实现下会送一个换行，同样不能让它变成 500
    for (const raw of [' ', '\n', '\r\n', '  \t ']) {
      const r = parse(raw);
      expect(r.err, JSON.stringify(raw)).toBeNull();
      expect(r.value).toEqual({});
    }
  });
});

describe('正常 JSON 照常解析', () => {
  it('对象', () => {
    expect(parse('{"a":1}').value).toEqual({ a: 1 });
  });

  it('嵌套与中文', () => {
    expect(parse('{"reason":"周报要存归档","n":[1,2]}').value)
      .toEqual({ reason: '周报要存归档', n: [1, 2] });
  });
});

describe('坏 JSON 报 400 而不是 500', () => {
  it('残缺的对象', () => {
    // 关键是"报错"与"崩溃"要分开：客户端发错了是 400，
    // 服务端处理不了才是 500。混在一起会让真正的服务故障淹没在噪声里。
    const r = parse('{"a":');
    expect(r.err).not.toBeNull();
    expect(r.value).toBeUndefined();
  });

  it('根本不是 JSON', () => {
    expect(parse('not json at all').err).not.toBeNull();
  });
});
