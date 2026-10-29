import { useEffect, useState, type ReactNode } from 'react';
import { Icon, copyText, type IconName } from '@ispace/ui';
import { api } from './api';
import { Markdown, rawUrl } from './chat';
import { CodeView, FileBadge, isImage, langOf } from './code-view';
import { Segment } from './detail';
import { PHONE_RATIO } from './wall';

/**
 * 创建 · 工作台（新稿 §创建 · 工作台）的零件。
 *
 * 新稿把「说一句就开做」改成了三段：**问 → 扇出 → 做**。这个文件装的是
 * 这三段各自的那块 UI，以及右栏那三页（预览 / 代码 / 设计）。编排在
 * create.tsx 里——那边握着会话、预览和发布。
 *
 * ┌─ 哪些是真的，哪些是脚本 ────────────────────────────────────────────┐
 * │ 开场**不再有平台的固定问答**。原来每次都先摆三个选项（出六版设计 / │
 * │ 直接做 / 先聊清楚），一句话就说清楚的需求也得先点一下才开始。现在   │
 * │ 第一句话直接交给模型：要问它自己用 ask_user 问，问什么由提示词定；  │
 * │ 不必问就直接做。这里把它的问题画成可点的卡片。                      │
 * │                                                                      │
 * │ 设计扇出也不再是开场的一道题，而是「设计」页里按需点的一颗按钮。    │
 * │                                                                      │
 * │ 扇出那六个 Agent 是**真的六个模型会话**（/agent/fanout），卡片里装   │
 * │ 的是它们各自写出来的那份 HTML，不是示意图。                          │
 * └──────────────────────────────────────────────────────────────────────┘
 */

// ── 问 ─────────────────────────────────────────────────────────────────
export interface AskOption {
  /** 平台那两道题用它来路由；模型问的那种没有。 */
  key?: string;
  label: string;
  hint?: string;
  recommended?: boolean;
}

export interface Ask {
  from: 'platform' | 'model';
  /** 问题前面那句话。 */
  lead?: string;
  question: string;
  options: AskOption[];
}

/**
 * 问题卡片。贴在左栏底部、输入框上面（新稿的位置）——它是"在等你回答"，
 * 和输入框是同一件事的两种答法：点一项，或者直接打字。
 *
 * 悬停的那一项编号变成主色块，提示"点它就是选它"；数字键不接，避免和输入
 * 框里打的字抢。
 */
export function AskCard({ ask, step, onPick, disabled }: {
  ask: Ask;
  step?: string;
  onPick: (o: AskOption, index: number) => void;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(0);
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', padding: 8, borderRadius: 18,
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
        boxShadow: '0 12px 32px -18px rgba(24,23,21,.28)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 10px 10px' }}>
        <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)' }}>
          {ask.question}
        </span>
        {step && (
          <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            {step}
          </span>
        )}
      </div>

      {ask.options.map((o, i) => {
        const on = hover === i && !disabled;
        return (
          <button
            key={o.key ?? o.label}
            onClick={() => !disabled && onPick(o, i)}
            onMouseEnter={() => setHover(i)}
            disabled={disabled}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '11px 10px',
              border: 0, borderRadius: 12, background: on ? 'var(--surface-2)' : 'transparent',
              cursor: disabled ? 'default' : 'pointer', textAlign: 'left', opacity: disabled ? 0.6 : 1,
            }}
          >
            <span
              className="mono"
              style={{
                width: 26, height: 26, flex: 'none', borderRadius: 8,
                background: on ? 'var(--cta)' : 'var(--surface-2)',
                color: on ? 'var(--cta-fg)' : 'var(--text-secondary)',
                fontSize: 'var(--text-base)', fontWeight: 'var(--weight-bold)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {i + 1}
            </span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-md)',
                  fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)',
                }}
              >
                {o.label}
                {o.recommended && (
                  <span
                    style={{
                      height: 20, padding: '0 7px', borderRadius: 'var(--radius-pill)',
                      background: 'var(--brand-wash)', color: 'var(--brand-ink)',
                      fontSize: 'var(--text-base)', fontWeight: 'var(--weight-bold)',
                      display: 'flex', alignItems: 'center',
                    }}
                  >
                    推荐
                  </span>
                )}
              </span>
              {o.hint && (
                <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
                  {o.hint}
                </span>
              )}
            </span>
            <Icon name="chevRight" size={16} color="var(--text-tertiary)" />
          </button>
        );
      })}

      <span style={{ padding: '8px 10px 4px', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
        都不合适？直接在下面输入你的想法
      </span>
    </div>
  );
}

// ── 扇出 ───────────────────────────────────────────────────────────────
export interface FanDir {
  /** `${runId}:${key}`。不同批次里的 key 可能一样，挑中、收藏都认它。 */
  id: string;
  runId: string;
  index: number;
  key: string;
  name: string;
  bg: string;
  dot: string;
  /** 相对工作区的路径。配上预览会话的地址就能直接看。 */
  path: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  turns?: number;
  ms?: number;
  message?: string;
}

/** 「基于这一版再出」的几种。纲领在服务端（fanout.ts 的 VARIANT_KINDS），这里只要名字。 */
export type VariantKind = 'vary' | 'like' | 'bold' | 'warm' | 'simple' | 'night';

/** 一次扇出出来的那一批。头一批是六个方向，后面的是基于某一版再出的。 */
export interface FanBatch {
  runId: string;
  kind: VariantKind | null;
  /** 基于哪一版出的。头一批为空。 */
  base: string | null;
  dirs: FanDir[];
}

/**
 * 跑设计扇出。
 *
 * 和 streamAsk 同一套读法（fetch + ReadableStream 读 SSE），但这条流不进对话
 * 历史——它是 N 个一次性任务的进度，不是一轮会话。
 *
 * 每跑一次**往后加一批**，不覆盖前面的：新稿里「基于它再出一版」「更多类似」
 * 出来的是"第二批"，摆在头一批下面——人要的是对比，不是替换。
 */
export function useFanout() {
  const [batches, setBatches] = useState<FanBatch[]>([]);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async (opts: {
    text: string;
    device: 'phone' | 'pc' | 'both';
    model: string;
    effort: string | null;
    variant?: { kind: VariantKind; base: FanDir };
    /** 往哪条会话的工作区里出草案——预览、「代码」页看的都是它。 */
    sessionId?: string | null;
  }) => {
    setRunning(true);
    setErr(null);
    const v = opts.variant;
    /* 这一次的 runId。事件是按顺序到的，'run' 一定在别的前面 */
    let cur = '';
    const patch = (index: number, fn: (d: FanDir) => FanDir) => setBatches((bs) => bs.map((b) => (
      b.runId === cur ? { ...b, dirs: b.dirs.map((d) => (d.index === index ? fn(d) : d)) } : b
    )));
    try {
      const res = await fetch('/deploy/api/agent/fanout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
          text: opts.text,
          device: opts.device,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(v ? {
            variant: {
              kind: v.kind,
              base: { path: v.base.path, key: v.base.key, name: v.base.name, bg: v.base.bg, dot: v.base.dot },
            },
          } : {}),
        }),
      });
      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => '');
        let msg = raw.slice(0, 200);
        try {
          const body = JSON.parse(raw) as { message?: string };
          if (body.message) msg = body.message;
        } catch { /* 不是 JSON 就用原文 */ }
        setErr(msg || `接口返回 ${res.status}`);
        return;
      }
      await readSse(res.body, (e) => {
        if (e.type === 'run') {
          cur = String(e.runId);
          const dirs = (e.dirs as Omit<FanDir, 'state' | 'id' | 'runId'>[]).map((d) => ({
            ...d, id: `${cur}:${d.key}`, runId: cur, state: 'queued' as const,
          }));
          setBatches((bs) => [...bs, { runId: cur, kind: v?.kind ?? null, base: v?.base.name ?? null, dirs }]);
        } else if (e.type === 'dir_start') {
          patch(e.index as number, (d) => ({ ...d, state: 'running' }));
        } else if (e.type === 'dir_done') {
          patch(e.index as number, (d) => ({ ...d, state: 'done', turns: e.turns as number, ms: e.ms as number }));
        } else if (e.type === 'dir_error') {
          if (e.index === -1) setErr(String(e.message ?? '扇出失败'));
          else patch(e.index as number, (d) => ({ ...d, state: 'failed', message: String(e.message ?? '') }));
        }
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '扇出失败');
    } finally {
      setRunning(false);
    }
  };

  return { batches, dirs: batches.flatMap((b) => b.dirs), running, err, start };
}

/** 逐条读 SSE。两条流（对话与扇出）共用。 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  on: (e: Record<string, unknown> & { type: string }) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        on(JSON.parse(line.slice(6)) as Record<string, unknown> & { type: string });
      } catch { /* 半条就丢掉，下一条照常 */ }
    }
  }
}

/** 第几批。头一批叫「首批」，后面「第二批」「第三批」…… */
const batchSub = (i: number) => (i === 0 ? '首批' : `第${'一二三四五六七八九十'[i] ?? i + 1}批`);

/**
 * 设计画廊（右栏「设计」页）。
 *
 * 每张卡片里是那一版**真的页面**，用预览地址装进 iframe。没有 iframe 就
 * 只能摆一块色块当示意——而人要挑的恰恰是"它到底长什么样"，色块挑不出来。
 *
 * iframe 一律 `pointer-events: none`：这是一张给人看的缩略图，不是能点的
 * 页面。真要点，挑中它、做出来再点。
 *
 * 卡片底下那排四颗（新稿）：
 *   +   用这一版——让模型照它做真正的页面
 *   ✦   基于它再出一版——跑一次只有一个方向的扇出，出来的摆在下一批
 *   ♡   收藏——只在这一屏里记着，配合顶上的「收藏」筛选；不进服务端
 *   ↓   下载设计稿——就是那一版写出来的那个 HTML 文件，原样存下来
 */
export function DesignGallery({
  batches, previewUrl, pickedId, favs, dev, onDev, onPick, onVary, onFav, onDownload, onStart,
  genBusy, fanBusy,
}: {
  batches: FanBatch[];
  /** 预览会话的根地址（末尾带斜杠）。为空时卡片只画底色。 */
  previewUrl: string | null;
  pickedId: string | null;
  favs: Set<string>;
  dev: 'phone' | 'pc';
  onDev: (d: 'phone' | 'pc') => void;
  onPick: (d: FanDir) => void;
  onVary: (d: FanDir) => void;
  onFav: (d: FanDir) => void;
  onDownload: (d: FanDir) => void;
  /** 还一版都没有时，点一下出几版。 */
  onStart: () => void;
  /** 模型正在改页面：这时不能再「用这一版」，不然两轮叠在一起。 */
  genBusy: boolean;
  /** 一次扇出还没跑完：这时不再起新的一批。 */
  fanBusy: boolean;
}) {
  const [filter, setFilter] = useState<'all' | 'fav'>('all');
  const pc = dev === 'pc';
  const total = batches.reduce((n, b) => n + b.dirs.length, 0);
  const shown = batches
    .map((b, i) => ({ b, i, dirs: filter === 'fav' ? b.dirs.filter((d) => favs.has(d.id)) : b.dirs }))
    .filter((x) => x.dirs.length > 0);

  const empty = !batches.length
    ? {
      t: '这次没有出多个方向',
      d: '按你那句话并排出几版视觉草案，挑一版再照着做。每一版都是一次单独的模型调用，比直接做要慢、也更费。',
    }
    : !shown.length ? { t: '还没有收藏的方案', d: '在方案下面点 ♡，收藏的会出现在这里。' } : null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface-canvas)' }}>
      <div
        style={{
          height: 60, flex: 'none', display: 'grid', gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center', gap: 12, padding: '0 20px',
        }}
      >
        <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>{total} 个方案</span>
        <Segment
          options={[{ k: 'all', label: '风格', icon: 'palette' }, { k: 'fav', label: '收藏', icon: 'heart' }]}
          value={filter}
          onPick={(k) => setFilter(k as 'all' | 'fav')}
          pad={14}
        />
        <Segment
          options={[{ k: 'phone', label: '手机', icon: 'phone' }, { k: 'pc', label: '电脑', icon: 'monitor' }]}
          value={dev}
          onPick={(k) => onDev(k as 'phone' | 'pc')}
          pad={11}
          style={{ justifySelf: 'end' }}
        />
      </div>

      <div
        style={{
          flex: 1, minHeight: 0, overflow: 'auto', padding: '0 20px 32px',
          display: 'flex', flexDirection: 'column', gap: 28,
        }}
      >
        {empty && (
          <div
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', gap: 12, padding: '60px 24px', textAlign: 'center',
            }}
          >
            <span
              style={{
                width: 52, height: 52, borderRadius: 16, background: 'var(--surface-1)',
                border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="sparkles" size={24} color="var(--tabby-orange)" />
            </span>
            <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
              {empty.t}
            </span>
            <span style={{ maxWidth: 340, fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
              {empty.d}
            </span>
            {!batches.length && (
              <button
                onClick={onStart}
                disabled={fanBusy}
                style={{
                  marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, height: 36,
                  padding: '0 14px', border: 0, borderRadius: 'var(--radius-pill)',
                  background: fanBusy ? 'var(--surface-3)' : 'var(--cta)',
                  color: fanBusy ? 'var(--text-tertiary)' : 'var(--cta-fg)',
                  fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
                  cursor: fanBusy ? 'default' : 'pointer',
                }}
              >
                <Icon name="sparkles" size={14} />出几版设计看看
              </button>
            )}
          </div>
        )}

        {shown.map(({ b, i, dirs }) => {
          const done = b.dirs.filter((d) => d.state === 'done' || d.state === 'failed').length;
          const hint = done < b.dirs.length
            ? `生成中 · ${done}/${b.dirs.length}`
            : i === 0
              ? (pickedId ? '点 + 换成这一版，✦ 基于它再出一版' : `点一${pc ? '张方案' : '台手机'}，或点 + 用这一版`)
              : b.base ? `基于「${b.base.split(' · ')[0]}」` : '';
          return (
            <div key={b.runId} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 14px',
                  borderRadius: 12, background: 'var(--surface-2)', fontSize: 'var(--text-base)',
                }}
              >
                <Icon name="sparkles" size={15} color="var(--tabby-orange)" />
                <span style={{ fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)' }}>
                  {b.kind ? `${b.dirs.length} 个新版本` : `${b.dirs.length} 个方向`}
                </span>
                <span style={{ color: 'var(--text-tertiary)' }}>· {batchSub(i)}</span>
                <div style={{ flex: 1 }} />
                <span style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {hint}
                </span>
              </div>

              <div
                style={{
                  display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${pc ? 300 : 200}px, 1fr))`,
                  gap: '30px 22px',
                }}
              >
                {dirs.map((d) => (
                  <DirCard
                    key={d.id}
                    d={d}
                    pc={pc}
                    on={pickedId === d.id}
                    fav={favs.has(d.id)}
                    previewUrl={previewUrl}
                    genBusy={genBusy}
                    fanBusy={fanBusy}
                    onPick={onPick}
                    onVary={onVary}
                    onFav={onFav}
                    onDownload={onDownload}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DirCard({ d, pc, on, fav, previewUrl, genBusy, fanBusy, onPick, onVary, onFav, onDownload }: {
  d: FanDir;
  pc: boolean;
  on: boolean;
  fav: boolean;
  previewUrl: string | null;
  genBusy: boolean;
  fanBusy: boolean;
  onPick: (d: FanDir) => void;
  onVary: (d: FanDir) => void;
  onFav: (d: FanDir) => void;
  onDownload: (d: FanDir) => void;
}) {
  const ready = d.state === 'done';
  const busy = d.state === 'queued' || d.state === 'running';
  /*
    缩略图的视口宽度：手机版按 ~400px 排，电脑版按 ~1200px 排，再缩回卡片大小。
    直接按卡片宽度渲染的话，手机卡片 200px 宽，页面会以为自己在一块手表上。
  */
  const zoom = pc ? 0.25 : 0.5;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <div
        onClick={() => ready && !genBusy && onPick(d)}
        style={{
          /* 手机：比例给屏幕不给黑边（content-box），见 PHONE_RATIO */
          position: 'relative', width: pc ? '100%' : 'calc(100% - 14px)',
          aspectRatio: pc ? '16 / 10' : PHONE_RATIO,
          boxSizing: 'content-box', padding: pc ? 0 : 7, borderRadius: pc ? 14 : 30,
          background: pc ? 'var(--surface-1)' : '#0d0d10',
          boxShadow: on
            ? '0 0 0 3px var(--tabby-orange), 0 24px 48px -28px rgba(24,23,21,.45)'
            : ready ? '0 24px 48px -28px rgba(24,23,21,.45)' : '0 0 0 1px var(--border-subtle)',
          cursor: ready && !genBusy ? 'pointer' : 'default',
        }}
      >
        {on && (
          <span
            style={{
              position: 'absolute', top: -10, right: -6, zIndex: 2, height: 26, padding: '0 10px',
              borderRadius: 'var(--radius-pill)', background: 'var(--cta)', color: 'var(--cta-fg)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-bold)', display: 'flex',
              alignItems: 'center', gap: 4, boxShadow: '0 6px 14px -6px rgba(238,92,42,.8)',
            }}
          >
            <Icon name="check" size={13} />已选
          </span>
        )}
        <div
          style={{
            position: 'relative', width: '100%', height: '100%', borderRadius: pc ? 14 : 24,
            overflow: 'hidden', background: d.bg,
          }}
        >
          {ready && previewUrl && (
            <iframe
              src={`${previewUrl}${d.path}`}
              title={d.name}
              sandbox="allow-scripts"
              style={{
                position: 'absolute', top: 0, left: 0, width: `${100 / zoom}%`, height: `${100 / zoom}%`,
                transform: `scale(${zoom})`, transformOrigin: 'top left',
                border: 0, pointerEvents: 'none', background: d.bg,
              }}
            />
          )}
          {busy && (
            <div
              style={{
                position: 'absolute', inset: 0, padding: '36px 14px 16px', display: 'flex',
                flexDirection: 'column', gap: 10, background: 'var(--surface-1)',
              }}
            >
              <div style={{ width: '50%', height: 16, borderRadius: 5, background: 'var(--surface-3)' }} />
              <div style={{ height: '38%', borderRadius: 14, background: 'var(--surface-2)' }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ height: 44, borderRadius: 10, background: 'var(--surface-2)' }} />
                <div style={{ height: 44, borderRadius: 10, background: 'var(--surface-2)' }} />
              </div>
              <div style={{ flex: 1 }} />
              <div
                style={{
                  height: 3, borderRadius: 3,
                  background: `linear-gradient(90deg, var(--tabby-orange) ${d.state === 'running' ? 40 : 8}%, var(--surface-2) 0)`,
                }}
              />
            </div>
          )}
          {d.state === 'failed' && (
            <div
              style={{
                position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 16,
                textAlign: 'center', fontSize: 'var(--text-base)', color: 'rgba(24,23,21,.6)',
              }}
            >
              这一版没出来
            </div>
          )}
        </div>
      </div>

      <span
        style={{
          display: 'flex', alignItems: 'center', gap: 8, maxWidth: '100%', fontSize: 'var(--text-card-title)',
          fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)',
        }}
      >
        <span style={{ width: 10, height: 10, flex: 'none', borderRadius: 'var(--radius-pill)', background: d.dot }} />
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
      </span>

      {ready && (
        <div
          style={{
            display: 'flex', alignItems: 'center', padding: 3, borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-1)',
            boxShadow: '0 0 0 1px var(--border-subtle), 0 4px 10px -6px rgba(24,23,21,.2)',
          }}
        >
          <PillBtn
            icon="plus"
            title={genBusy ? '等这一轮做完再换' : on ? '正在用这一版' : '用这一版'}
            disabled={genBusy}
            onClick={() => onPick(d)}
          />
          <PillSep />
          <PillBtn
            icon="sparkles"
            title={fanBusy ? '上一批还没出完' : '基于它再出一版'}
            disabled={fanBusy}
            onClick={() => onVary(d)}
          />
          <PillSep />
          <PillBtn icon="heart" title={fav ? '取消收藏' : '收藏'} filled={fav} onClick={() => onFav(d)} />
          <PillSep />
          <PillBtn icon="download" title="下载设计稿" onClick={() => onDownload(d)} />
        </div>
      )}
      {busy && (
        <span style={{ height: 36, display: 'flex', alignItems: 'center', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
          {d.state === 'running' ? '生成中…' : '排队中…'}
        </span>
      )}
      {d.state === 'failed' && (
        <span
          title={d.message}
          style={{ height: 36, display: 'flex', alignItems: 'center', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}
        >
          没出来，换一个看看
        </span>
      )}
    </div>
  );
}

function PillBtn({ icon, title, onClick, disabled, filled }: {
  icon: IconName;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  filled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onClick()}
      title={title}
      aria-label={title}
      disabled={disabled}
      style={{
        width: 36, height: 30, border: 0, borderRadius: 'var(--radius-pill)', background: 'transparent',
        color: filled ? 'var(--tabby-orange)' : disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <Icon name={icon} size={16} filled={filled} />
    </button>
  );
}

const PillSep = () => <span style={{ width: 1, height: 14, flex: 'none', background: 'var(--border-tabby)' }} />;

/**
 * 稿上那四步：理解需求 / 设计数据表 / 写页面 / 发布前检查。
 *
 * ┌─ 它们在这里是**分组标签**，不是一条固定进度条 ────────────────────┐
 * │ 稿里这四步是写死的 todo：`step > i` 就打勾，`step === i` 就转圈，   │
 * │ 跟模型实际在做什么没有关系。照搬等于把"正在发生什么"换成一段动画， │
 * │ 这正是上一版刻意不做它的理由。                                     │
 * │                                                                    │
 * │ 现在的做法是取中间那条路：**四步照画，但每一步的状态和内容都来自   │
 * │ 真实的工具调用**。模型读了三个文件，「理解需求」下面就是那三行；    │
 * │ 它一次都没读，这一步根本不出现——而不是摆一个永远不会亮的灰点。    │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * 「设计数据表」今天不会出现：平台没有建表的工具，页面是直接走 PostgREST
 * 读写每个人自己的 schema 的。将来真有了那样的工具，把它的名字加进 tools
 * 这一行，这一步自己就会亮起来——不需要改别的地方。
 */
export const STAGES: { key: string; label: string; tools: string[] }[] = [
  {
    key: 'understand',
    label: '理解需求',
    tools: ['ask_user', 'list_files', 'read_file', 'search_files', 'list_apps', 'get_quota'],
  },
  { key: 'data', label: '设计数据表', tools: [] },
  {
    key: 'write',
    label: '写页面',
    tools: ['write_file', 'edit_file', 'copy_file', 'delete_file', 'generate_image'],
  },
  {
    key: 'check',
    label: '发布前检查',
    tools: ['check_publishable', 'screenshot_preview', 'request_deploy'],
  },
];

/** 工具归到哪一步。认不出来的归「写页面」——那是干活的那一档。 */
export function stageOf(tool: string): string {
  return STAGES.find((st) => st.tools.includes(tool))?.key ?? 'write';
}

/**
 * 每一步底下那行小字，由**真实调用次数**拼出来。
 *
 * 稿上这行写的是「拆成 3 个视图、2 张表」「6 个文件 · 手机和电脑都能用」
 * 这类话——那是设计稿的示例文案，平台并不知道页面拆成了几个视图。能数得
 * 准的只有工具调了几次，就只说这个。
 */
export function stageDetail(steps: Step[]): string {
  const n = (...keys: string[]) => steps.filter((x) => keys.includes(x.key)).length;
  const parts: string[] = [];
  const push = (count: number, word: string) => { if (count) parts.push(`${word} ${count}`); };
  push(n('read_file'), '读文件');
  push(n('search_files'), '搜索');
  push(n('ask_user'), '问你');
  push(n('write_file'), '新文件');
  push(n('edit_file'), '改动');
  push(n('generate_image'), '配图');
  push(n('check_publishable'), '自检');
  push(n('screenshot_preview'), '截图');
  return parts.join(' · ');
}

export interface Step { key: string; title: string; detail: string; done: boolean }

/**
 * 「处理中… · 已完成 N 步」那一块。
 *
 * 新稿把工具调用摞进一个可收起的块里，默认展开。收起来之后只剩一行标题
 * ——这一步是对的：一次生成会调十几次工具，全摊开会把模型说的话挤没。
 */
export function ProcessBlock({ steps, agents, busy, skill, waiting }: {
  steps: Step[];
  /** 扇出那几个 Agent。没扇出就是空的，那一段整段不画。 */
  agents: FanDir[];
  busy: boolean;
  /** 用到的技能名。眼下只有扇出会用。 */
  skill: string | null;
  /**
   * 正卡在一个问题上等用户回答。
   *
   * 稿上每一步有三态：打勾、转圈、警示。前两个我们有，第三个原本没有对应
   * 物——而 ask_user 正好就是它：模型问了一句，在等人。这时候转圈是误导，
   * 它并没有在算，是在等你。
   */
  waiting?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [shut, setShut] = useState<Record<string, true>>({});
  const n = steps.filter((s) => s.done).length + (agents.filter((a) => a.state === 'done').length ? 1 : 0);
  if (!steps.length && !agents.length) return null;

  /*
    按四步归组。只保留真有事件的那几步——没发生的事不画一个灰点占位，
    那样又变回一条和模型无关的进度条了。
  */
  const groups = STAGES
    .map((st) => ({ ...st, items: steps.filter((x) => stageOf(x.key) === st.key) }))
    .filter((g) => g.items.length > 0);
  const liveAt = groups.findIndex((g) => g.items.some((x) => !x.done));
  /* 全做完但还在跑 = 模型在想下一步，算在最后一组头上，不要四步全打勾 */
  const cur = liveAt >= 0 ? liveAt : (busy ? groups.length - 1 : -1);
  const doneCount = groups.filter((_, i) => cur < 0 || i < cur).length;

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', padding: '12px 14px', borderRadius: 16,
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: 0, border: 0,
          background: 'transparent', color: 'var(--text-secondary)',
          fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
        }}
      >
        {busy && <Icon name="rotate" size={14} color="var(--tabby-orange)" />}
        <span style={{ flex: 1, textAlign: 'left' }}>
          {busy ? `处理中… · 已完成 ${n} 步` : `已完成 ${n} 步`}
        </span>
        <Icon name={open ? 'chevUp' : 'chevDown'} size={15} color="var(--text-tertiary)" />
      </button>

      {/* 稿上那行计数。分母是**真发生过的**几步，不是写死的 4 */}
      {groups.length > 0 && (
        <span style={{ paddingTop: 4, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          {doneCount} 已完成 · {cur >= 0 ? 1 : 0} 进行中 · {Math.max(0, groups.length - doneCount - (cur >= 0 ? 1 : 0))} 待处理
        </span>
      )}

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 10 }}>
          {skill && (
            <>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 'var(--text-base)', color: 'var(--text-heading)' }}>
                <Icon name="book" size={15} color="var(--text-tertiary)" />
                调用技能 {skill}
              </span>
              <button
                onClick={() => setAgentsOpen((v) => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', border: 0,
                  background: 'transparent', color: 'var(--text-secondary)',
                  fontSize: 'var(--text-base)', cursor: 'pointer',
                }}
              >
                <Icon
                  name={agents.every((a) => a.state === 'done' || a.state === 'failed') ? 'check' : 'rotate'}
                  size={14}
                  color={agents.every((a) => a.state === 'done' || a.state === 'failed')
                    ? 'var(--success)' : 'var(--tabby-orange)'}
                />
                <span style={{ flex: 1, textAlign: 'left' }}>
                  {agents.every((a) => a.state !== 'queued' && a.state !== 'running')
                    ? `运行了 ${agents.length} 个 Design Agent`
                    : `正在运行 ${agents.length} 个 Design Agent · ${agents.filter((a) => a.state === 'done').length}/${agents.length}`}
                </span>
                <Icon name={agentsOpen ? 'chevUp' : 'chevDown'} size={15} color="var(--text-tertiary)" />
              </button>
              {agentsOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 6 }}>
                  {agents.map((a) => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 30, paddingLeft: 24 }}>
                      <Icon
                        name={a.state === 'done' ? 'check' : a.state === 'running' ? 'rotate' : a.state === 'failed' ? 'close' : 'info'}
                        size={13}
                        color={a.state === 'done' ? 'var(--success)'
                          : a.state === 'running' ? 'var(--tabby-orange)'
                            : a.state === 'failed' ? 'var(--error)' : 'var(--text-tertiary)'}
                      />
                      {/* 左栏窄（新稿 32% 宽）：名字一长就折行、和下一行叠在一起，所以一律单行截断 */}
                      <span
                        className="mono"
                        title={`isp-design · ${a.name}`}
                        style={{
                          flex: 1, minWidth: 0, fontSize: 'var(--text-base)', color: 'var(--text-secondary)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                      >
                        isp-design · {a.name}
                      </span>
                      <span className="mono" style={{ flex: 'none', whiteSpace: 'nowrap', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                        {a.state === 'done' ? `${a.turns} 轮 · ${fmtMs(a.ms ?? 0)}`
                          : a.state === 'running' ? '运行中'
                            : a.state === 'failed' ? '没出来' : '排队'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {groups.map((g, gi) => {
            const live = gi === cur;
            const ok = cur < 0 || gi < cur;
            const hold = live && !!waiting;
            const sum = stageDetail(g.items);
            const openHere = !shut[g.key];
            return (
              <div key={g.key} style={{ display: 'flex', flexDirection: 'column' }}>
                <button
                  onClick={() => setShut((m) => {
                    const next = { ...m };
                    if (next[g.key]) delete next[g.key]; else next[g.key] = true;
                    return next;
                  })}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0',
                    border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <Icon
                    name={ok ? 'check' : hold ? 'info' : 'rotate'}
                    size={14}
                    color={ok ? 'var(--success)' : hold ? 'var(--warning)' : 'var(--tabby-orange)'}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span
                      style={{
                        fontSize: 'var(--text-base)', color: 'var(--text-heading)',
                        fontWeight: live ? 'var(--weight-semibold)' : 'var(--weight-regular)',
                      }}
                    >
                      {g.label}
                      {hold && <span style={{ color: 'var(--text-tertiary)' }}> · 在等你</span>}
                    </span>
                    {sum && (
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{sum}</span>
                    )}
                  </span>
                  <Icon name={openHere ? 'chevUp' : 'chevDown'} size={14} color="var(--text-tertiary)" />
                </button>

                {/* 展开才是真正发生的那几行——这一步下面具体调了什么 */}
                {openHere && g.items.map((x, i) => (
                  <div
                    key={`${x.key}-${i}`}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '3px 0 3px 24px' }}
                  >
                    <Icon
                      name={x.done ? 'check' : 'rotate'}
                      size={12}
                      color={x.done ? 'var(--success)' : 'var(--tabby-orange)'}
                      style={{ marginTop: 3 }}
                    />
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{x.title}</span>
                      {x.detail && (
                        <span
                          className="mono"
                          style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', wordBreak: 'break-all' }}
                        >
                          {x.detail}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const fmtMs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * 挑中一版之后，输入框上面那一排（新稿）。
 *
 * 「新版本」那四颗和「更多类似」都是**基于挑中的那一版再出设计**——出来的
 * 进「设计」页的下一批，挑中了再换过去。它们不直接改正在做的页面：改页面
 * 是输入框的事，说一句「哪里要改」就行。
 */
export const REFINES: { kind: VariantKind; label: string; icon: IconName }[] = [
  { kind: 'bold', label: '更大胆', icon: 'bold' },
  { kind: 'warm', label: '更温暖', icon: 'sun' },
  { kind: 'simple', label: '简化', icon: 'minus' },
  { kind: 'night', label: '夜间版', icon: 'moon' },
];

/** 发给左栏对话里的那句"我说的话"。和按钮上的字对得上。 */
export function variantAsk(kind: VariantKind, baseName: string): string {
  const short = baseName.split(' · ')[0] ?? baseName;
  if (kind === 'like') return `再来两个和「${short}」类似的设计`;
  if (kind === 'vary') return `基于「${baseName}」再出一版`;
  const r = REFINES.find((x) => x.kind === kind);
  return `对「${short}」出一个新版本：${r?.label ?? kind}`;
}

export function RefineBar({ pick, onVariant, busy }: {
  pick: FanDir;
  onVariant: (kind: VariantKind) => void;
  /** 上一批还没出完。 */
  busy: boolean;
}) {
  const pill: React.CSSProperties = {
    flex: 'none', display: 'flex', alignItems: 'center', gap: 5, height: 32, padding: '0 12px',
    border: 0, borderRadius: 'var(--radius-pill)', background: 'var(--surface-1)',
    boxShadow: '0 0 0 1px var(--border-subtle)',
    color: busy ? 'var(--text-tertiary)' : 'var(--text-primary)',
    fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
    cursor: busy ? 'default' : 'pointer',
  };
  const tip = busy ? '上一批还没出完' : undefined;

  return (
    /* 左栏放不下一整排时横着划；滚动条不画——它会在输入框上面压一道灰杠 */
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto', padding: '1px 1px 2px',
        whiteSpace: 'nowrap', scrollbarWidth: 'none',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
        <span style={{ width: 7, height: 7, borderRadius: 'var(--radius-pill)', background: pick.dot }} />
        对「{pick.name.split(' · ')[0]}」
      </span>
      <span style={{ flex: 'none', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>新版本</span>
      {REFINES.map((r) => (
        <button key={r.kind} onClick={() => !busy && onVariant(r.kind)} disabled={busy} title={tip} style={pill}>
          <Icon name={r.icon} size={14} color="var(--tabby-orange)" />
          {r.label}
        </button>
      ))}
      <span style={{ flex: 'none', width: 1, height: 16, margin: '0 4px', background: 'var(--border-tabby)' }} />
      <span style={{ flex: 'none', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>新设计</span>
      <button onClick={() => !busy && onVariant('like')} disabled={busy} title={tip} style={pill}>
        <Icon name="rotate" size={14} color="var(--tabby-orange)" />
        更多类似
        <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--brand-ink)' }}>+2</span>
      </button>
    </div>
  );
}

// ── 右栏：代码页 ────────────────────────────────────────────────────────
/**
 * 文件浏览器。
 *
 * 只读。改文件是模型的事——摆一个能编辑的编辑器，等于让人和模型同时改同
 * 一份东西，而谁都不知道对方改了什么。想改哪里，在左边说一句。
 *
 * 读码体验（code-view.tsx）：左边按目录摞成树、每个文件带类型角标；右边语法
 * 高亮加行号，长行可以切换换不换行；图片直接显示，md 能切到排版后的样子。
 * 原来是一列一样的图标加一整块等宽字，模型写的几百行 HTML 读起来全是一个颜色。
 */
type Entry = { path: string; dir: boolean; size: number };

/** 扁平路径表 → 按目录摞好的显示顺序（目录在前、各层按名字排），收起的目录跳过它的子孙。 */
export function treeRows(entries: Entry[], closed: Set<string>): (Entry & { depth: number; name: string })[] {
  const kids = new Map<string, Entry[]>();
  for (const e of entries) {
    const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
    kids.set(parent, [...(kids.get(parent) ?? []), e]);
  }
  const out: (Entry & { depth: number; name: string })[] = [];
  const walk = (dir: string, depth: number) => {
    const list = (kids.get(dir) ?? []).slice().sort((a, b) => (
      a.dir === b.dir ? a.path.localeCompare(b.path) : a.dir ? -1 : 1
    ));
    for (const e of list) {
      out.push({ ...e, depth, name: e.path.slice(e.path.lastIndexOf('/') + 1) });
      if (e.dir && !closed.has(e.path)) walk(e.path, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

export function CodePane({ rev, sessionId }: { rev: number; sessionId: string | null }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<{ text: string; binary?: boolean; tooBig?: boolean; size: number } | null>(null);
  const [q, setQ] = useState('');
  /* 收起的目录。平台草稿（_fanout、_uploads）默认收起——它们不是页面本身 */
  const [closed, setClosed] = useState<Set<string>>(() => new Set(['_fanout', '_uploads']));
  const [wrap, setWrap] = useState(true);
  const [mdView, setMdView] = useState(true);

  useEffect(() => {
    void api.workspaceTree(sessionId)
      .then((r) => {
        setEntries(r.entries);
        setSel((s) => s ?? r.entries.find((e) => e.path === 'index.html')?.path
          ?? r.entries.find((e) => !e.dir)?.path ?? null);
      })
      .catch(() => setEntries([]));
  }, [rev, sessionId]);

  useEffect(() => {
    if (!sel) { setFile(null); return; }
    let alive = true;
    void api.workspaceFile(sel, sessionId)
      .then((r) => { if (alive) setFile(r); })
      .catch(() => { if (alive) setFile(null); });
    return () => { alive = false; };
  }, [sel, rev, sessionId]);

  const query = q.trim().toLowerCase();
  /* 筛选时不摞树：直接列出路径里带这几个字的文件，完整路径一眼看全 */
  const rows = query
    ? entries.filter((e) => !e.dir && e.path.toLowerCase().includes(query))
      .map((e) => ({ ...e, depth: 0, name: e.path }))
    : treeRows(entries, closed);
  const fileCount = entries.filter((e) => !e.dir).length;
  const toggle = (path: string) => setClosed((c) => {
    const n = new Set(c);
    if (n.has(path)) n.delete(path); else n.add(path);
    return n;
  });

  const showText = file && !file.binary && !file.tooBig;
  const lineCount = showText ? file.text.split('\n').length : 0;
  const isMd = sel !== null && langOf(sel) === 'md';

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div
        style={{
          width: 240, flex: 'none', display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--border-tabby)', background: 'var(--surface-1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42, padding: '0 12px' }}>
          <span style={{ flex: 1, fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
            文件
          </span>
          <span className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            {fileCount}
          </span>
        </div>
        <div style={{ padding: '0 10px 8px' }}>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 9px',
              borderRadius: 9, background: 'var(--surface-2)',
            }}
          >
            <Icon name="search" size={13} color="var(--text-tertiary)" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="筛文件"
              style={{
                flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent',
                fontSize: 'var(--text-base)', color: 'var(--text-primary)', fontFamily: 'inherit',
              }}
            />
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 8px 10px' }}>
          {fileCount === 0 && (
            <span style={{ display: 'block', padding: '8px 10px', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              工作区还是空的
            </span>
          )}
          {rows.map((e) => {
            const on = e.path === sel;
            const open = e.dir && !closed.has(e.path);
            return (
              <button
                key={e.path}
                onClick={() => (e.dir ? toggle(e.path) : setSel(e.path))}
                title={e.path}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, width: '100%', height: 28,
                  padding: `0 8px 0 ${6 + e.depth * 14}px`, border: 0, borderRadius: 8,
                  background: on ? 'var(--surface-3)' : 'transparent',
                  color: on ? 'var(--text-heading)' : e.dir ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontSize: 'var(--text-base)', cursor: 'pointer', textAlign: 'left',
                  fontWeight: on ? 'var(--weight-semibold)' : 'normal',
                }}
              >
                {e.dir ? (
                  <>
                    <Icon name={open ? 'chevDown' : 'chevRight'} size={12} color="var(--text-tertiary)" />
                    <FolderGlyph open={open} />
                  </>
                ) : (
                  <>
                    <span style={{ width: 12, flex: 'none' }} />
                    <FileBadge path={e.path} />
                  </>
                )}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.name}
                </span>
                {e.dir && e.name.startsWith('_') && (
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)' }}>草稿</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface-canvas)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 14px', borderBottom: '1px solid var(--border-tabby)' }}>
          {sel && <FileBadge path={sel} size={20} />}
          <span className="mono" style={{ minWidth: 0, fontSize: 'var(--text-base)', color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sel ?? '没有选中文件'}
          </span>
          {file && (
            <span className="mono" style={{ flex: 'none', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              {showText ? `${lineCount} 行 · ` : ''}{fmtBytes(file.size)}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {showText && isMd && (
            <ToolChip on={mdView} onClick={() => setMdView((v) => !v)}>{mdView ? '看源码' : '看排版'}</ToolChip>
          )}
          {showText && !(isMd && mdView) && (
            <ToolChip on={wrap} onClick={() => setWrap((v) => !v)}>{wrap ? '自动换行：开' : '自动换行：关'}</ToolChip>
          )}
          {showText && (
            <ToolChip onClick={() => void copyText(file.text)}>复制</ToolChip>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px 24px 6px' }}>
          {!file && !sel && (
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              左边挑一个文件。
            </span>
          )}
          {file?.binary && sel && isImage(sel) && sessionId && (
            <div style={{ padding: 16, display: 'flex', justifyContent: 'center' }}>
              <img
                src={rawUrl(sessionId, sel)}
                alt={sel}
                style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 10, boxShadow: '0 0 0 1px var(--border-subtle)', background: 'repeating-conic-gradient(var(--surface-2) 0% 25%, transparent 0% 50%) 50% / 16px 16px' }}
              />
            </div>
          )}
          {file?.binary && !(sel && isImage(sel) && sessionId) && (
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              这是个二进制文件（{fmtBytes(file.size)}），在「预览」里看它的效果。
            </span>
          )}
          {file?.tooBig && (
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
              文件太大（{fmtBytes(file.size)}），这里不展开。
            </span>
          )}
          {showText && sel && (isMd && mdView
            ? <div style={{ maxWidth: 760, padding: '4px 12px', fontSize: 'var(--text-md)', lineHeight: 1.75 }}><Markdown text={file.text} /></div>
            : <CodeView text={file.text} path={sel} wrap={wrap} />)}
        </div>
      </div>
    </div>
  );
}

function ToolChip({ on, onClick, children }: { on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 'none', height: 26, padding: '0 9px', border: '1px solid var(--border-subtle)', borderRadius: 8,
        background: on ? 'var(--surface-2)' : 'var(--surface-1)', color: 'var(--text-secondary)',
        fontSize: 'var(--text-sm)', cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

/** 文件夹的小图形。图标集里没有文件夹，画一个——比借一个意思不对的图标好认。 */
function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden style={{ flex: 'none' }}>
      <path
        d={open ? 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h8A1.5 1.5 0 0 1 20 9.5V10H7.2a1.5 1.5 0 0 0-1.4 1L3 18.5Z M5.8 11h16l-2.6 7.6a1 1 0 0 1-.9.7H3.4Z' : 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z'}
        fill="#e5b75e"
      />
    </svg>
  );
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ── 右栏：发布下拉 ──────────────────────────────────────────────────────
/**
 * 发布面板（新稿右上角那个下拉）。
 *
 * 和原来那条底栏是同一套动作，位置换了：底栏在"预览 / 代码 / 设计"三页之
 * 间来回切时会跟着内容挪，而发布是与当前看哪一页无关的事。
 */
export function PublishMenu({
  published, url, username, site, onSite, siteOk, device, onDevice, vis, setVis, canPublish, notReady,
  publishing, onPublish, onMine, onToast, onClose,
}: {
  published: boolean;
  url: string;
  username: string;
  /** 发到哪个地址。模型提过的、或这段对话发过的，先填上；人可以改。 */
  site: string;
  onSite: (s: string) => void;
  siteOk: boolean;
  /**
   * 主要在哪儿看。手机 → 封面按手机截、卡片按手机摆、在电脑上打开套手机框。
   * 原来没有这一项，工作台发出去的一律当电脑页面——H5 也是。
   */
  device: 'phone' | 'pc';
  onDevice: (d: 'phone' | 'pc') => void;
  vis: 'private' | 'shared' | 'public' | 'link';
  setVis: (v: 'private' | 'shared' | 'public' | 'link') => void;
  canPublish: boolean;
  /** 现在还发不了的原因，写在按钮上。能发时为空。 */
  notReady: string | null;
  publishing: boolean;
  onPublish: () => void;
  onMine: () => void;
  onToast: (t: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 31, width: 340,
        boxSizing: 'border-box', padding: 18, borderRadius: 20,
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
        boxShadow: '0 24px 48px -16px rgba(24,23,21,.22)',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}
    >
      <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)' }}>
        {published ? '已发布到你的空间' : '发布到你的空间'}
      </span>
      {published ? (
        <span
          className="mono"
          style={{
            padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)',
            fontSize: 'var(--text-base)', color: 'var(--text-secondary)', wordBreak: 'break-all',
          }}
        >
          {url}
        </span>
      ) : (
        /*
          地址原来是模型调 request_deploy 时自己定的，人改不了，模型没提就发不了。
          现在摆在这里：模型提过就先填上它提的，人随时能改。
        */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label
            className="mono"
            style={{
              display: 'flex', alignItems: 'center', height: 40, padding: '0 12px', borderRadius: 12,
              background: 'var(--surface-2)', fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
              boxShadow: site && !siteOk ? 'inset 0 0 0 1.5px var(--error)' : 'none',
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>/{username}/</span>
            <input
              value={site}
              onChange={(e) => onSite(e.target.value.trim().toLowerCase())}
              placeholder="起个地址，比如 paiban"
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, padding: 0, border: 0, outline: 'none', background: 'transparent',
                font: 'inherit', color: 'var(--text-heading)',
              }}
            />
            <span>/</span>
          </label>
          {site && !siteOk && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--error)' }}>
              只能用小写字母、数字和单个连字符，字母开头，2 到 31 个字。
            </span>
          )}
        </div>
      )}

      {published ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => void copyText(url).then((ok) => onToast(ok ? '地址已复制' : url))}
            style={{
              flex: 1, height: 40, border: '1px solid var(--border-hover)', borderRadius: 12,
              background: 'var(--surface-1)', color: 'var(--text-heading)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            复制地址
          </button>
          <button
            onClick={() => { onClose(); onMine(); }}
            style={{
              flex: 1, height: 40, border: 0, borderRadius: 12, background: 'var(--accent)',
              color: 'var(--accent-fg)', fontSize: 'var(--text-base)',
              fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            去我的作品
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>主要在哪儿看</span>
            <Segment
              options={[
                { k: 'phone', label: '手机', icon: 'phone' },
                { k: 'pc', label: '电脑', icon: 'monitor' },
              ]}
              value={device}
              onPick={(k) => onDevice(k as 'phone' | 'pc')}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>谁能看</span>
            <Segment
              /*
                「指定同事」不在这里：发布前还没有名单可指定，邀请人在发布后的分享弹窗里做。
                知道链接的人 = 发布后给一条带私密令牌的链接，持链接免登录可看。
              */
              options={[
                { k: 'private', label: '仅自己' },
                { k: 'public', label: '全公司' },
                { k: 'link', label: '知道链接的人' },
              ]}
              value={vis}
              onPick={(k) => setVis(k as 'private')}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}
            />
          </div>
          <button
            onClick={onPublish}
            disabled={!canPublish || publishing}
            style={{
              height: 42, border: 0, borderRadius: 12,
              background: canPublish && !publishing ? 'var(--cta)' : 'var(--surface-3)',
              color: canPublish && !publishing ? 'var(--cta-fg)' : 'var(--text-tertiary)',
              fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)',
              cursor: canPublish && !publishing ? 'pointer' : 'default',
            }}
          >
            {publishing ? '正在发布…' : canPublish ? '发布' : notReady ?? '还没准备好发布'}
          </button>
          <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>
            发布前会自动扫一遍密钥和 XSS 规则。
          </span>
        </>
      )}
    </div>
  );
}

/** 右栏那三页。顺序照新稿：预览在前，代码其次，设计最后。 */
export const TABS: { k: 'preview' | 'code' | 'design'; label: string; icon: IconName }[] = [
  { k: 'preview', label: '预览', icon: 'globe' },
  { k: 'code', label: '代码', icon: 'code' },
  { k: 'design', label: '设计', icon: 'layers' },
];

/**
 * 三页的切换。
 *
 * 字只在放得下时显示（新稿：视口 ≥ 1180，或者左栏收起来了）——窄的时候只剩
 * 图标，title 里留着名字。
 */
export function TabBar({ cur, onPick, labels }: {
  cur: 'preview' | 'code' | 'design';
  onPick: (k: 'preview' | 'code' | 'design') => void;
  labels: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 2, flex: 'none' }}>
      {TABS.map((t) => {
        const on = t.k === cur;
        return (
          <button
            key={t.k}
            onClick={() => onPick(t.k)}
            title={t.label}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, height: 34,
              padding: `0 ${labels ? 14 : 10}px`, border: 0, borderRadius: 10, whiteSpace: 'nowrap',
              flex: 'none', background: on ? 'var(--surface-1)' : 'transparent',
              boxShadow: on ? '0 1px 2px rgba(24,23,21,.08), 0 0 0 1px var(--border-subtle)' : 'none',
              color: on ? 'var(--text-heading)' : 'var(--text-tertiary)',
              fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            <Icon name={t.icon} size={16} />
            {labels && t.label}
          </button>
        );
      })}
    </div>
  );
}

/** 两栏顶上那一排 34×34 的图标按钮。 */
export function IconBtn({ icon, title, onClick, disabled }: {
  icon: IconName;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onClick()}
      title={title}
      aria-label={title}
      disabled={disabled}
      style={{
        width: 34, height: 34, flex: 'none', border: 0, borderRadius: 10, background: 'transparent',
        color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--surface-2)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

/**
 * 模型提上来、等人点头的那份计划（改版稿「先出计划，你确认后再动手」）。
 *
 * ┌─ 这张卡为什么是真的 ────────────────────────────────────────────────┐
 * │ 它不只是把模型说的话排了个版。计划模式下，服务端**真的拦住**了写、  │
 * │ 改、删、发布那几个工具（packages/agent 的 planGate）——所以你看到   │
 * │ 这张卡的时候，工作区里一个字节都还没动。点「开始做」闸门才撤掉。     │
 * │                                                                      │
 * │ 只靠提示词约定的话，模型兴致一来照样先写两个文件再说，而人点「确认」 │
 * │ 的时候东西已经改完了——那这句承诺就是假的。                          │
 * └──────────────────────────────────────────────────────────────────────┘
 */
export function PlanCard({ plan, onGo, onEdit }: {
  plan: { steps: string[]; note?: string };
  onGo: () => void;
  onEdit: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px',
        borderRadius: 16, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
        <Icon name="scroll" size={15} color="var(--tabby-orange)" />
        实施计划 · 还没动手
      </span>

      <ol style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' }}>
        {plan.steps.map((t, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <span
              className="num"
              style={{
                width: 20, height: 20, flex: 'none', borderRadius: 'var(--radius-pill)',
                background: 'var(--brand-wash)', color: 'var(--tabby-orange)',
                fontSize: 'var(--text-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {i + 1}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-base)', lineHeight: 1.7, color: 'var(--text-primary)' }}>
              {t}
            </span>
          </li>
        ))}
      </ol>

      {plan.note && (
        <span style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7, color: 'var(--text-tertiary)' }}>
          {plan.note}
        </span>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onGo}
          style={{
            height: 34, padding: '0 14px', border: 0, borderRadius: 10,
            background: 'var(--cta)', color: 'var(--cta-fg)',
            fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
          }}
        >
          按这个做
        </button>
        <button
          onClick={onEdit}
          style={{
            height: 34, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 10,
            background: 'var(--surface-1)', color: 'var(--text-secondary)',
            fontSize: 'var(--text-base)', cursor: 'pointer',
          }}
        >
          哪里要改
        </button>
      </div>
    </div>
  );
}
