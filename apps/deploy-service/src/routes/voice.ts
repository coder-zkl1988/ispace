import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_BASE, ERROR_CODES, IspaceError, type User } from '@ispace/contracts';
import { z } from 'zod';

/**
 * 语音转写兜底（规格 §5.8）。
 *
 * ┌─ 为什么是"兜底"而不是默认 ────────────────────────────────────────┐
 * │ 默认走设备本地识别：零调用成本、离线可用，而且同事对着它说的业务    │
 * │ 内容（客户情况、成交数据）不出手机。                                │
 * │                                                                     │
 * │ 但本地识别依赖厂商预置的 ASR 服务。实测 Redmi 与 HONOR 都有，       │
 * │ 不代表全覆盖——真遇到没有的机器，本条兜底让语音输入仍然可用，       │
 * │ 而不是给用户一个永远灰着的按钮。                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 走服务端中转而不是让手机直连 StepFun：那样得把 API key 发到每台设备上，
 * 一旦壳被反编译，key 就是公开的，而它是按量计费的。
 *
 * 未配置 STEP_API_KEY 时本端点返回 NOT_IMPLEMENTED，手机端据此保持置灰——
 * 不静默失败。
 */

/**
 * 音频大小上限。
 *
 * 16k 单声道 m4a 约 2 KB/秒，4 MB 够录半小时——远超一句话需求，
 * 而上限存在的意义是挡住"把一段会议录音传上来"这种把按量计费打爆的用法。
 */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

const transcribeSchema = z.object({
  /** base64 编码的音频。 */
  audio: z.string().min(1),
  /** 容器格式。实测 wav / m4a 都准，mp3 有损会把「待办」听成「代办」。 */
  format: z.enum(['m4a', 'wav', 'pcm']).default('m4a'),
});

export function registerVoiceRoutes(
  app: FastifyInstance,
  deps: { requireAuth: (req: FastifyRequest) => Promise<User> },
): void {
  const { requireAuth } = deps;

  const apiKey = process.env.STEP_API_KEY;
  const asrUrl = process.env.STEP_ASR_URL ?? 'https://api.stepfun.com/step_plan/v1/audio/asr/sse';
  const asrModel = process.env.STEP_ASR_MODEL ?? 'stepaudio-2.5-asr';

  /** 手机端启动时查一次，决定没有本地识别时要不要给出兜底入口。 */
  app.get(`${API_BASE}/voice/capability`, async (req) => {
    await requireAuth(req);
    return { serverTranscription: Boolean(apiKey), model: apiKey ? asrModel : null };
  });

  app.post(`${API_BASE}/voice/transcribe`, {
    /**
     * 单独放宽正文上限。
     *
     * 全局是 1 MB（够所有 JSON 接口用），但 base64 会把音频撑大 1/3——
     * 一段几十秒的录音就超了，而 Fastify 的超限错误会被映射成
     * "服务内部错误"，用户完全看不出是自己说太久了。
     * 这里留到 MAX_AUDIO_BYTES 的 base64 尺寸再加一点余量，
     * 让下面那条自己的检查先命中，给出能看懂的话。
     */
    bodyLimit: Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 64 * 1024,
  }, async (req) => {
    const me = await requireAuth(req);
    if (!apiKey) {
      throw new IspaceError(
        ERROR_CODES.NOT_IMPLEMENTED,
        '服务端语音转写未配置。请在设备的系统设置里启用语音识别，或联系管理员配置 STEP_API_KEY。',
      );
    }

    const input = transcribeSchema.parse(req.body ?? {});
    // base64 每 4 字符解出 3 字节，先按长度粗筛，避免把几十 MB 解码进内存
    if (input.audio.length > (MAX_AUDIO_BYTES / 3) * 4) {
      throw new IspaceError(
        ERROR_CODES.INVALID_INPUT,
        `音频超过 ${MAX_AUDIO_BYTES / 1024 / 1024} MB 上限。语音输入是说一句话，不是传录音文件。`,
      );
    }

    const body = {
      audio: {
        data: input.audio,
        input: {
          transcription: {
            model: asrModel,
            language: 'zh',
            // 把「一百二十三」规整成「123」。用户说的是需求描述，
            // 里面的数字按数字写才好读。
            enable_itn: true,
          },
          format:
            input.format === 'pcm'
              ? { type: 'pcm', codec: 'pcm_s16le', rate: 16000, bits: 16, channel: 1 }
              : { type: input.format },
        },
      },
    };

    // 上游是 SSE。这里不做流式转发：一句话的转写就几百毫秒，
    // 前端拿一次最终结果就够，多一层流式只会让两端都复杂。
    let res: Response;
    try {
      res = await fetch(asrUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new IspaceError(
        ERROR_CODES.UPSTREAM_ERROR,
        '语音转写服务连不上，稍后再试',
        { reason: e instanceof Error ? e.message : String(e) },
      );
    }

    if (!res.ok) {
      // 不把上游的响应体原样透出：里面可能带账号或配额信息
      app.log.error(`ASR 上游 ${res.status}: ${(await res.text()).slice(0, 300)}`);
      throw new IspaceError(ERROR_CODES.UPSTREAM_ERROR, `语音转写失败（上游 ${res.status}）`);
    }

    const text = parseAsrSse(await res.text());
    if (text === null) {
      throw new IspaceError(ERROR_CODES.UPSTREAM_ERROR, '语音转写没有返回结果');
    }

    // 只记有没有用、用了多长，不记转写内容——那是用户说的话。
    app.log.info(
      { user: me.username, bytes: Math.floor((input.audio.length * 3) / 4), chars: text.length },
      '语音转写',
    );
    return { text };
  });
}

/**
 * 从 SSE 流里取最终文本。
 *
 * 上游会先推若干 transcript.text.delta，最后一条 transcript.text.done 带完整
 * text。优先取 done——delta 的切分点在词中间（实测「把首页」「的排班标签换成今日」），
 * 自己拼接容易在边界上出错。done 缺失时才回退到拼 delta。
 */
export function parseAsrSse(raw: string): string | null {
  const deltas: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let evt: { type?: string; text?: string; delta?: string };
    try {
      evt = JSON.parse(payload) as typeof evt;
    } catch {
      continue;
    }
    if (evt.type === 'transcript.text.done' && typeof evt.text === 'string') {
      return evt.text.trim();
    }
    if (evt.type === 'transcript.text.delta' && typeof evt.delta === 'string') {
      deltas.push(evt.delta);
    }
  }
  return deltas.length ? deltas.join('').trim() : null;
}
