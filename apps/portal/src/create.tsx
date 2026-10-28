import { useEffect, useRef, useState } from 'react';
import { appSlugSchema, type User } from '@ispace/contracts';
import { Icon, copyText, useConfirm } from '@ispace/ui';
import { api } from './api';
import { AiBubble, UserBubble, type ChatFile } from './chat';
import {
  AddButton, ImageChips, MAX_ATTACH, ModelPill, useModels,
  type AgentChoice, type AgentImage, type Effort,
} from './composer';
import { Segment, ago } from './detail';
import { PHONE_RATIO, usePlayUrl, type Device } from './wall';
import {
  AskCard, CodePane, DesignGallery, IconBtn, PlanCard, ProcessBlock, PublishMenu, RefineBar, TabBar,
  useFanout, variantAsk, type Ask, type AskOption, type FanDir, type VariantKind,
} from './workbench';
import { MoreMenu, SessionsMenu, VersionsMenu } from './workbench-menus';

/**
 * 创建（改版稿 §创建 / §创建 · 生成）。
 *
 * 两态一屏：没开始生成时是「今天想做个什么页面？」加一个输入框；一旦开始，
 * 左边变成对话 + 进度，右边是预览和发布。
 *
 * ┌─ 和设计稿的差别，以及为什么 ──────────────────────────────────────┐
 * │ 1. 稿上那四步（理解需求 / 设计数据表 / 写页面 / 发布前检查）照画， │
 * │    但它们是**真实事件的分组标签**，不是一条固定进度条：每一步的   │
 * │    状态和内容都来自工具调用，展开能看到这一步具体调了什么，小字   │
 * │    只数真实次数。没发生过的步不出现——稿里那种 `step > i` 就打勾  │
 * │    的写法，等于把"正在发生什么"换成一段动画。                     │
 * │    「设计数据表」今天不会亮：平台没有建表工具，页面是直接走       │
 * │    PostgREST 读写各自 schema 的。见 workbench.tsx 的 STAGES。     │
 * │ 2. 模型下拉和「思考」分段只在平台真的给了得选的东西时才画：模型  │
 * │    清单来自 AGENT_MODELS，思考档位要 AGENT_EFFORT 开着           │
 * │    （/agent/status 两样都返回）。只配了一条通道又没开思考时，    │
 * │    仍旧是一个灰色的名字——下拉里只有一行、点了还是它，不如不画。 │
 * │ 3. 「添加内容」五项按稿子都在，但只有第一项是通的：「上传文件」，│
 * │    图片、md、Word、Excel、PPT、PDF 都收（/agent/ask 的 files，   │
 * │    服务端存进 _uploads/ 并抽出文字给模型）。其余四项点了弹一句话 │
 * │    说明它是干什么的——设计稿里它们也只是弹提示。                │
 * └──────────────────────────────────────────────────────────────────┘
 */
export function Create({
  me, initialDraft, draftSeq, remix, onClearRemix, onMine, onWorkbench, onToast,
}: {
  me: User;
  /** 从探索页那句话或「做同款」带进来的初稿。 */
  initialDraft: string;
  /**
   * 每带进来一次初稿就 +1。这一屏切到别处时不卸载（见 App 的 createAlive），
   * 所以不能靠"挂载时读一次 initialDraft"——同一句话再带一次也得认得出来。
   */
  draftSeq: number;
  remix: { name: string; author: string } | null;
  onClearRemix: () => void;
  onMine: () => void;
  /** 进没进工作台。外壳据此让出顶栏与滚动容器。 */
  onWorkbench: (on: boolean) => void;
  onToast: (t: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  /* 刷新之前正在做的那一个，有就接着摆出来——见 loadGen 的说明 */
  const [gen, setGen] = useState<Gen | null>(() => (initialDraft ? null : loadGen(me.username)));

  /*
    换了一条会话就整个重挂工作台：预览会话、设计扇出、问答卡片这些都绑在
    「这一个页面」上，留着上一个的会把两个页面混在一起。不拿 sessionId 当
    key——新开的会话 id 是第一句话之后才到的，那一下重挂会让第一句话再发一遍。
  */
  const [genKey, setGenKey] = useState(0);

  /**
   * 切到一条已有的会话（「历史版本」里点的、「复制为新页面」刚建的）：对话流
   * 从服务端拿回来，文件本来就在它的工作区里。
   */
  const openSession = async (id: string, opts: { forkOf?: string } = {}) => {
    try {
      const v = await api.agentSessionView(id);
      const [first, ...rest] = v.says;
      setGen((cur) => ({
        text: first?.me ? first.text : '',
        images: [],
        title: opts.forkOf ? `${opts.forkOf}（副本）`.slice(0, 20) : v.title,
        /* 发布过的就沿用那个 slug，再发布是覆盖它而不是新建 */
        site: v.slug,
        confirmToken: null,
        sessionId: v.id,
        choice: cur?.choice ?? { model: '', effort: null },
        files: first?.me ? first.files : undefined,
        steps: [],
        says: (first?.me ? rest : v.says).map((m) => (m.me ? { ...m, ask: true as const } : m)),
        busy: false,
        /* 打开来是为了接着改：右边摆实时预览，不摆线上地址 */
        publishedUrl: null,
        /* 第一句话早就说过了，挂上去不要再发 */
        restored: true,
      }));
      setGenKey((k) => k + 1);
    } catch (e) {
      onToast(e instanceof Error ? e.message : '没能打开这个页面');
    }
  };

  /*
    又带进来一句话（探索页的输入框、「做同款」）：回到开场那一屏，把这句话
    摆进输入框——和原来整页进来时一样。正在做的那一个例外：模型还在跑，
    这时候换掉就是把它半路扔下，先留着它，说一声。
  */
  const seq = useRef(draftSeq);
  useEffect(() => {
    if (seq.current === draftSeq) return;
    seq.current = draftSeq;
    setDraft(initialDraft);
    if (!initialDraft || !gen) return;
    if (gen.busy) { onToast('这一个还在做，做完点「新对话」再开新的——那句话已经放进输入框了'); return; }
    setGen(null);
    setGenKey((k) => k + 1);
  }, [draftSeq, initialDraft, gen, onToast]);
  useEffect(() => { onWorkbench(gen !== null); }, [gen, onWorkbench]);

  /*
    改动就存，但攒半秒再写：流式回复每来一个字就是一次 setGen，每次都把整
    段对话 JSON 一遍写进 localStorage，长对话里是实打实的卡顿。
  */
  useEffect(() => {
    const t = setTimeout(() => saveGen(me.username, gen), 500);
    return () => clearTimeout(t);
  }, [gen, me.username]);
  /* 离开这一屏（去我的作品、点侧栏别处）要归位，否则外壳一直没有顶栏 */
  useEffect(() => () => onWorkbench(false), [onWorkbench]);

  return gen
    ? (
      <Generating
        key={genKey}
        me={me}
        gen={gen}
        /* 收窄成「拿着当前的 Gen 算一个新的」：Generating 里不存在 gen 为空的情形 */
        setGen={(fn) => setGen((g) => (g ? fn(g) : g))}
        onMine={onMine}
        onToast={onToast}
        onFresh={() => { saveGen(me.username, null); setGen(null); setGenKey((k) => k + 1); }}
        onOpen={(id, opts) => void openSession(id, opts)}
      />
    )
    : (
      <Idle
        draft={draft} setDraft={setDraft} remix={remix} onClearRemix={onClearRemix}
        onStart={(text, images, choice) => setGen(freshGen(text, images, choice))}
        onOpen={(id) => void openSession(id)}
        onToast={onToast}
      />
    );
}

// ── 没开始之前 ──────────────────────────────────────────────────────────
function Idle({
  draft, setDraft, remix, onClearRemix, onStart, onOpen, onToast,
}: {
  draft: string;
  setDraft: (v: string) => void;
  remix: { name: string; author: string } | null;
  onClearRemix: () => void;
  onStart: (text: string, images: AgentImage[], choice: AgentChoice) => void;
  /** 打开一个做过的页面，接着做（和工作台左上角「历史版本」同一条路）。 */
  onOpen: (sessionId: string) => void;
  onToast: (t: string) => void;
}) {
  const [sugTab, setSugTab] = useState(0);
  const [images, setImages] = useState<AgentImage[]>([]);
  const { models, effortOn } = useModels();
  const [modelId, setModelId] = useState('');
  const [effort, setEffort] = useState<Effort>('medium');

  const picked = models.find((m) => m.id === modelId) ?? models[0] ?? null;

  const go = () => {
    const t = draft.trim();
    if (!t) { onToast('先说一句想做什么'); return; }
    onStart(t, images, { model: picked?.id ?? '', effort: effortOn ? effort : null });
  };

  const mcp = `claude mcp add ai-deploy --transport http ${location.origin}/deploy/mcp`;
  const group = SUGS[sugTab]!;

  return (
    <div
      style={{
        maxWidth: 860, margin: '0 auto', padding: '9vh 32px 96px', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26,
      }}
    >
      <h1
        style={{
          margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500,
          fontSize: 'clamp(32px, 4vw, 50px)', lineHeight: 1.15,
          color: 'var(--text-heading)', textAlign: 'center',
        }}
      >
        今天想做个什么页面？
      </h1>

      <div
        style={{
          width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          gap: 8, padding: '16px 14px 12px 20px', borderRadius: 22,
          background: 'var(--surface-1)', border: '1px solid var(--prompt-border)',
          boxShadow: 'var(--prompt-sh)',
        }}
      >
        {remix && (
          <span
            style={{
              alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, height: 28,
              padding: '0 4px 0 10px', borderRadius: 'var(--radius-pill)',
              background: 'var(--brand-wash)', color: 'var(--text-heading)',
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
            }}
          >
            <Icon name="remix" size={13} />
            基于 {remix.author} 的「{remix.name}」
            <button
              onClick={onClearRemix}
              title="不基于它"
              style={{
                width: 22, height: 22, border: 0, borderRadius: 'var(--radius-pill)',
                background: 'transparent', color: 'var(--text-secondary)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}
            >
              <Icon name="close" size={13} />
            </button>
          </span>
        )}

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            go();
          }}
          rows={3}
          placeholder="说说它给谁用、要解决什么、数据从哪来。越具体，第一版越接近你要的。"
          style={{
            width: '100%', boxSizing: 'border-box', padding: 0, border: 0, outline: 'none',
            resize: 'none', background: 'transparent', fontSize: 15, lineHeight: 1.7,
            color: 'var(--text-primary)', fontFamily: 'inherit',
          }}
        />

        <ImageChips images={images} onRemove={(i) => setImages((prev) => prev.filter((_, k) => k !== i))} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AddButton
            onImages={(next) => setImages((prev) => [...prev, ...next].slice(0, MAX_ATTACH))}
            onToast={onToast}
          />
          <ModelPill
            models={models}
            effortOn={effortOn}
            modelId={picked?.id ?? ''}
            effort={effort}
            onModel={setModelId}
            onEffort={setEffort}
          />
          <div style={{ flex: 1 }} />
          <button
            onClick={go}
            title="开始生成"
            style={{
              width: 38, height: 38, border: 0, borderRadius: 'var(--radius-pill)',
              background: draft.trim() ? 'var(--cta)' : 'var(--surface-3)',
              color: draft.trim() ? 'var(--cta-fg)' : 'var(--text-tertiary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="up" size={18} />
          </button>
        </div>
      </div>

      <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
        <span style={{ marginRight: 8, fontWeight: 'var(--weight-bold)', color: 'var(--text-secondary)' }}>Tips</span>
        页面自带数据库和登录，不用自己配后端。
        <a
          href="/console#backend"
          style={{ marginLeft: 8, color: 'var(--text-secondary)', textDecoration: 'underline', textUnderlineOffset: 3 }}
        >
          详情
        </a>
      </div>

      <RecentPages onOpen={onOpen} />

      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          {SUGS.map((g, i) => {
            const on = i === sugTab;
            return (
              <button
                key={g.label}
                onClick={() => setSugTab(i)}
                style={{
                  height: 34, padding: '0 14px', border: 0, borderRadius: 'var(--radius-pill)',
                  background: on ? 'var(--surface-3)' : 'transparent',
                  color: on ? 'var(--text-heading)' : 'var(--text-tertiary)',
                  fontSize: 'var(--text-base)',
                  fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                  cursor: on ? 'default' : 'pointer',
                }}
              >
                {g.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '2px 24px' }}>
          {group.items.map((s) => (
            <button
              key={s.title}
              onClick={() => setDraft(`做一个${s.title}：${s.detail}`)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 12px',
                border: 0, borderRadius: 10, background: 'transparent', color: 'var(--text-secondary)',
                fontSize: 'var(--text-md)', cursor: 'pointer', textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--surface-2)';
                e.currentTarget.style.color = 'var(--text-heading)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--text-secondary)';
              }}
            >
              <Icon name="bulb" size={16} />{s.title}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          width: '100%', boxSizing: 'border-box', marginTop: 30, padding: 24, borderRadius: 22,
          background: 'var(--surface-sidebar)', display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 'var(--text-card-title)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
              已经在用 Claude 或 Codex？
            </span>
            <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
              装一次 iSpace 连接，之后在对话里说「发到我的空间」，页面就上线了。
            </span>
          </div>
          <a
            href="/console#guide"
            style={{
              fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)', whiteSpace: 'nowrap',
            }}
          >
            完整接入指引 →
          </a>
        </div>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 10px 10px 16px',
            borderRadius: 14, background: 'var(--dark-bg)',
          }}
        >
          <span
            className="mono"
            style={{
              flex: 1, minWidth: 0, overflow: 'auto', whiteSpace: 'nowrap',
              fontSize: 'var(--text-base)', color: 'rgba(255,255,255,.88)',
            }}
          >
            {mcp}
          </span>
          <button
            onClick={() => void copyText(mcp).then((ok) => onToast(ok ? '命令已复制，在终端运行一次就好' : '复制不了，手动选中吧'))}
            style={{
              flex: 'none', height: 32, padding: '0 12px', border: 0, borderRadius: 9,
              background: 'rgba(255,255,255,.1)', color: '#fff', fontSize: 'var(--text-base)',
              fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            复制
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 「接着做」：最近做过的页面。
 *
 * 「历史版本」原来只在工作台左上角——得先开始做一个新页面才看得见，开场这一屏
 * 回不到以前做过的。想改一个已经发布的页面（比如把它改成手机页面重发），就
 * 无从下手。这里列最近几个，点一下和在历史版本里点是同一回事。
 */
function RecentPages({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const [items, setItems] = useState<{ id: string; title: string; slug: string | null; updatedAt: number }[]>([]);
  useEffect(() => {
    let alive = true;
    void api.agentSessions()
      .then((r) => { if (alive) setItems(r.items.slice(0, 6)); })
      .catch(() => { /* 拉不到就不摆这一块，开场照常能用 */ });
    return () => { alive = false; };
  }, []);
  if (!items.length) return null;

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 6 }}>
      <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-secondary)' }}>
        接着做
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
        {items.map((s) => (
          <button
            key={s.id}
            onClick={() => onOpen(s.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, padding: '10px 12px',
              border: '1px solid var(--border-subtle)', borderRadius: 12, background: 'var(--surface-1)',
              cursor: 'pointer', textAlign: 'left',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
          >
            <Icon name="history" size={16} color="var(--text-tertiary)" />
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span
                style={{
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)',
                }}
              >
                {s.title}
              </span>
              <span
                style={{
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)',
                }}
              >
                {ago(new Date(s.updatedAt).toISOString())}{s.slug ? ` · 已发布 /${s.slug}/` : ''}
              </span>
            </span>
            <Icon name="chevRight" size={15} color="var(--text-tertiary)" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 生成中 / 生成完 ─────────────────────────────────────────────────────
interface Step { key: string; title: string; detail: string; done: boolean }

/**
 * 对话流里的一段。ask 标的是"这一句真的发给了模型、开了一轮"——撤回按它找
 * 退到哪儿。设计扇出的那几句（「基于它再出一版」）也是用户说的，但它们不开
 * 会话轮次、服务端也不为它们拍快照，撤回时不能把它们当成"上一步"。
 */
interface Say {
  me: boolean;
  text: string;
  files?: ChatFile[];
  ask?: true;
  /** 平台自己说的一句（目前只有压缩提示）。不是模型的话，样式也不一样。 */
  sys?: true;
}

/** 最近一句真正开了一轮的用户发言。-1 表示只剩开场那句。 */
const lastAsk = (says: Say[]) => {
  for (let i = says.length - 1; i >= 0; i--) if (says[i]!.me && says[i]!.ask) return i;
  return -1;
};

interface Gen {
  /** 第一句话。显示在左栏顶上那个气泡里。 */
  text: string;
  images: AgentImage[];
  title: string;
  /** Agent 发起发布请求时才知道要发到哪个 slug。 */
  site: string | null;
  confirmToken: string | null;
  sessionId: string | null;
  /** 模型和思考档位。开场选的那个；工作台输入框里能换，下一轮起生效。 */
  choice: AgentChoice;
  steps: Step[];
  /** 第一句话附的文件。存进工作区之后带上 path，刷新之后还点得开。 */
  files?: ChatFile[];
  /** 对话流，按轮次分段。me 是用户说的；files 是这一段附带的文件（附件、生成的图）。 */
  says: Say[];
  busy: boolean;
  publishedUrl: string | null;
  /** 刷新之后从本地恢复出来的。开头那两道题就不再问了，对话里补一句说明。 */
  restored?: boolean;
}

// ── 刷新之后接着做 ───────────────────────────────────────────────────────
/**
 * 工作台的状态存在本地，刷新之后接着摆出来。
 *
 * ┌─ 为什么要存，以及存的是什么 ────────────────────────────────────────┐
 * │ 原来这一屏的对话和进度只活在 React 的内存里：刷新一下就回到「今天想做 │
 * │ 个什么页面？」，用户的感受是"刚做的东西没了"。其实没有——模型写的文件 │
 * │ 一直在服务端这个人的工作区里，只是界面不认得它了。                    │
 * │                                                                      │
 * │ 存的是界面上那份东西：标题、对话、进度、发布到哪个 slug、会话 id。     │
 * │ 模型那边的记忆在服务端：会话已经落库（agent_sessions），带着同一个     │
 * │ 会话 id 回来，它记得之前聊过什么，文件也在这条会话自己的工作区里。    │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 按用户分 key：同一台电脑换个账号登录，不该看到上一个人做到一半的东西。
 * 12 小时过期：太老的工作台摆出来，人多半已经不记得在做什么了——想接着改
 * 发布过的页面，从「我的作品」进来更直接。发布成功就清掉。
 */
const SAVE_TTL_MS = 12 * 60 * 60 * 1000;
const saveKey = (username: string) => `ispace-workbench-v1:${username}`;

function saveGen(username: string, g: Gen | null): void {
  try {
    if (!g || g.publishedUrl) { localStorage.removeItem(saveKey(username)); return; }
    /*
      图片是 base64，一张就上百 KB，不存——恢复出来也不会再发给模型。附件里的
      本地预览地址（object URL）刷新就失效，也不存；存进工作区的 path 留着。
    */
    const slimFiles = (fs?: ChatFile[]) => fs?.map(({ localUrl: _u, ...f }) => f);
    const slim: Gen = {
      ...g, images: [], busy: false, files: slimFiles(g.files),
      says: g.says.map((m) => (m.files ? { ...m, files: slimFiles(m.files) } : m)),
    };
    localStorage.setItem(saveKey(username), JSON.stringify({ at: Date.now(), gen: slim }));
  } catch { /* 隐身窗口或配额满了：存不了就算了，不挡正事 */ }
}

const RESTORE_PREFIX = '（刷新前做到这里';
const RESTORE_NOTE = `${RESTORE_PREFIX}。文件和对话都还在，接着说要改哪里就行。）`;

function loadGen(username: string): Gen | null {
  try {
    const raw = localStorage.getItem(saveKey(username));
    if (!raw) return null;
    const { at, gen } = JSON.parse(raw) as { at: number; gen: Gen };
    if (!gen || Date.now() - at > SAVE_TTL_MS) {
      localStorage.removeItem(saveKey(username));
      return null;
    }
    return {
      ...gen,
      busy: false,
      restored: true,
      /* 模型那一轮已经断了，进度一律收尾，不然会一直转圈 */
      steps: (gen.steps ?? []).map((st) => ({ ...st, done: true })),
      says: [
        /*
          先把以前补的那句去掉再补一句。这句话会跟着对话一起存回去，不去掉
          的话每刷新一次就多一句，攒成一摞（实测见过三句叠在一起）。
        */
        ...(gen.says ?? []).filter((m) => m.me || !m.text.startsWith(RESTORE_PREFIX)),
        { me: false, text: RESTORE_NOTE },
      ],
    };
  } catch {
    return null;
  }
}

/** 刚选的附件 → 对话里的一张卡片。本地先给一个 object URL，存进工作区后再补上 path。 */
function toChatFile(a: AgentImage): ChatFile {
  const bin = atob(a.dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return {
    name: a.name, mimeType: a.mimeType, size: bytes.length,
    localUrl: URL.createObjectURL(new Blob([bytes], { type: a.mimeType })),
  };
}

const freshGen = (text: string, images: AgentImage[], choice: AgentChoice): Gen => ({
  text, images, title: titleOf(text), site: null, confirmToken: null, sessionId: null,
  files: images.map(toChatFile),
  /*
    busy 从 false 起。新稿里一上来不是"已经在做"，而是"先问你两句"
    （见 Generating 的 askStep）——写 true 会让进度区立刻出现「正在做…」，
    而那一刻一个模型请求都还没发出去。
  */
  choice, steps: [], says: [], busy: false, publishedUrl: null,
});

// ── 工作区实时预览 ─────────────────────────────────────────────────────
/** 预览页面回流上来的一条错误。 */
interface PreviewErr { level: string; text: string }

/** 一页最多留这么多条。页面里一个每帧抛异常的循环能在一秒里产出几十条。 */
const MAX_ERRS = 50;

/**
 * 工作区实时预览（docs/specs/2026-10-20-preview-runtime.md）。
 *
 * 做三件事：
 *   1. 开一个预览会话，拿到同源地址与取数令牌
 *   2. 和 iframe 里的 shim 握手把令牌递进去，并收它回流的报错
 *   3. 模型每写完一个文件就刷新一次（防抖）
 *
 * ┌─ 握手为什么用 event.source 比对，而不是 event.origin ───────────────┐
 * │ 预览 iframe 没有 allow-same-origin，它的 origin 是字符串 "null"。    │
 * │ 而**任何**网站开一个沙箱 iframe，发出的消息 origin 都是 "null"——    │
 * │ 按 origin 判等于谁都放进来。                                         │
 * │                                                                      │
 * │ event.source === frame.contentWindow 是对象同一性比较，这个骗不了：  │
 * │ 只有我们自己挂上去的那个 iframe 才是那个对象。令牌只递给它。         │
 * └──────────────────────────────────────────────────────────────────────┘
 */
interface PreviewKind {
  kind: 'static' | 'server' | 'build' | 'empty';
  why: string;
  signals: string[];
}

function usePreview(active: boolean, sessionId: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const [kind, setKind] = useState<PreviewKind | null>(null);
  const [errs, setErrs] = useState<PreviewErr[]>([]);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const token = useRef('');
  const id = useRef<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active || id.current) return;
    let alive = true;
    /* 带着会话 id 开：预览伺服的必须是这条会话的工作区，而不是这个人随便哪个 */
    void api.previewOpen(sessionId).then(async (r) => {
      if (!alive) return;
      id.current = r.previewId;
      token.current = r.token;
      setUrl(r.url);
      setKind(await api.previewKind(r.previewId).catch(() => null));
    }).catch(() => {
      /* 预览开不了不该拦住生成——右栏退回骨架屏，左边照常在做事 */
    });
    return () => { alive = false; };
  }, [active, sessionId]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;      // ← 见上方说明，这一行是关键
      const d = e.data as { type?: string; level?: string; text?: string } | null;
      if (d?.type === 'ispace:preview-ready') {
        win.postMessage({ type: 'ispace:preview-token', token: token.current }, '*');
      } else if (d?.type === 'ispace:preview-error' && typeof d.text === 'string') {
        const one = { level: d.level ?? 'error', text: d.text };
        setErrs((xs) => (xs.length >= MAX_ERRS ? xs : [...xs, one]));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  /**
   * 收掉预览。两处调：离开这一屏时，以及发布成功之后——发布之后右栏换成了
   * 正式地址，那块工作区预览已经没人看，留着只是白占一个会话名额
   * （每人同时只有一个）。
   *
   * 主动收只是加速，真正兜底的是服务端那两条超时：浏览器崩溃、断网时
   * 这一下发不出来。所以这里失败了也不重试。
   */
  const release = () => {
    if (pending.current) { clearTimeout(pending.current); pending.current = null; }
    const pid = id.current;
    if (!pid) return;
    id.current = null;          // 收过就不再收第二次
    token.current = '';
    const body = new Blob([JSON.stringify({ previewId: pid })], { type: 'application/json' });
    if (!navigator.sendBeacon?.('/deploy/api/preview-session/release', body)) {
      void fetch('/deploy/api/preview-session/release', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: pid }),
      }).catch(() => undefined);
    }
  };

  /* 卸载时收。用 ref 存一份，免得把 release 列进依赖让 effect 每次渲染都重挂 */
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => () => { releaseRef.current(); }, []);

  /**
   * 刷新。防抖 300ms——模型一轮里常连写五个文件，每次都刷会白闪五下。
   * 刷新同时清掉旧错误：那些是上一版页面报的，留着会让人去修已经不存在的问题。
   */
  const refresh = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      setErrs([]);
      /*
        重新判一次再刷。工作区一直在变——上一轮还是个能直接打开的单页面，
        这一轮模型加了个 server.js，右栏就该从页面换成那页说明。
      */
      const pid = id.current;
      if (pid) void api.previewKind(pid).then(setKind).catch(() => undefined);
      setRev((n) => n + 1);
    }, 300);
  };

  return { url, rev, kind, errs, frame, refresh, release, clear: () => setErrs([]) };
}

/** 视口宽度。右栏那三页的字只在放得下时显示。 */
function useViewportWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

function Generating({
  me, gen, setGen, onMine, onToast, onFresh, onOpen,
}: {
  me: User;
  gen: Gen;
  setGen: (fn: (g: Gen) => Gen) => void;
  onMine: () => void;
  onToast: (t: string) => void;
  /** 放下这一个，回到「今天想做个什么页面？」。工作区里的文件不动。 */
  onFresh: () => void;
  /** 切到另一条会话（历史版本、复制为新页面）。 */
  onOpen: (id: string, opts?: { forkOf?: string }) => void;
}) {
  const [dev, setDev] = useState<Device>('phone');
  const [vis, setVis] = useState<'private' | 'shared' | 'public' | 'link'>('private');
  const [follow, setFollow] = useState('');
  const [followImgs, setFollowImgs] = useState<AgentImage[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [tab, setTab] = useState<'preview' | 'code' | 'design'>('preview');
  const [pubOpen, setPubOpen] = useState(false);
  /*
    页面自己的确认框（覆盖已有页面、放下这一个）。不用浏览器原生 confirm()：
    那个框顶着域名、长得像系统报错，也没法把后果说清楚。
  */
  const [confirmUI, ask] = useConfirm();
  const [showErrs, setShowErrs] = useState(false);
  /* 左栏收起来，右栏独占整屏（新稿右上角第一颗） */
  const [chatShown, setChatShown] = useState(true);
  const vw = useViewportWidth();
  /* 文件树的版本号。一轮做完就 +1，让「代码」页重新拉一遍 */
  const [fsRev, setFsRev] = useState(0);
  /*
    发到哪个地址。模型调 request_deploy 时提过的、或者这段对话以前发过的，
    先填上；人改过之后就以人的为准，模型再提也不覆盖。
  */
  const [siteDraft, setSiteDraft] = useState(gen.site ?? '');
  /*
    主要在哪儿看。没挑过就跟着预览的「手机 / 电脑」走——人一直在手机框里看的
    页面，多半就是手机页面。挑过就以挑的为准。
  */
  const [pubDevice, setPubDevice] = useState<Device | null>(null);
  const siteTouched = useRef(false);
  useEffect(() => {
    if (!siteTouched.current && gen.site) setSiteDraft(gen.site);
  }, [gen.site]);
  /*
    工作区里有没有东西可发。只看"有没有文件"（下划线开头的草稿目录不算）：
    首页在不在根上、是不是 dist/ 里的构建产物，交给服务端那道自检去认——
    它和发布链路是同一套认法，前端再学一遍只会和它对不上。
  */
  const [hasPage, setHasPage] = useState(false);
  useEffect(() => {
    if (!gen.sessionId) { setHasPage(false); return; }
    let alive = true;
    void api.workspaceTree(gen.sessionId)
      .then((r) => { if (alive) setHasPage(r.entries.some((e) => !e.dir && !e.path.startsWith('_'))); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [gen.sessionId, fsRev]);
  const log = useRef<HTMLDivElement | null>(null);
  /*
    一进来先要一条会话、一个工作区（docs/specs/2026-10-21-agent-harness.md §1）。

    预览、设计扇出都在第一句对话之前，它们得知道看哪个、写哪个工作区——所以
    会话 id 不能等第一句话回来才有。要不到（服务端还是老版本）就退回老办法：
    不带 id，由第一句话建会话。
  */
  const [noSession, setNoSession] = useState(false);
  /*
    守卫用 ref、结果照收：严格模式会把 effect 跑两遍，用"卸载就丢弃结果"的
    写法会发两次请求、建两个工作区，还把第一个的结果扔掉（本机实测踩过）。
  */
  const askedSession = useRef(false);
  useEffect(() => {
    if (gen.sessionId || askedSession.current) return;
    askedSession.current = true;
    void api.agentSession()
      .then((r) => setGen((g) => ({ ...g, sessionId: g.sessionId ?? r.sessionId })))
      .catch(() => setNoSession(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ready = gen.sessionId !== null || noSession;

  /* 发布之后右栏换成正式地址，预览就不用再开着了 */
  const preview = usePreview(gen.publishedUrl === null && ready, gen.sessionId);
  const { models, effortOn } = useModels();

  /*
    开场不再摆平台的固定三选项（出六版设计 / 直接做 / 先聊清楚）。

    那三项每次都问，等于让每个人先回答一道和他的需求无关的题——「做个打字
    速度挑战」这种一句话就说清楚的，也得先点一下才开始。现在第一句话直接交
    给模型：该问它自己用 ask_user 问（问什么由提示词决定），不该问就直接做。
    设计扇出改成「设计」页里按需点的，见 DesignGallery 的 onStart。
  */
  /** 模型自己用 ask_user 问的那种。回答之后清掉。 */
  const [modelAsk, setModelAsk] = useState<Ask | null>(null);
  /**
   * 计划模式（改版稿「先出计划，你确认后再动手」）。
   *
   * planOn 是用户的开关；plan 是模型提上来、正等着他点头的那一份。
   * 点头之后 approved 置真，这一会话后面几轮就不再拦——不然每说一句都
   * 要重新出一次计划，那不是「先出计划」，是每句话都卡一下。
   */
  const [planOn, setPlanOn] = useState(false);
  const [plan, setPlan] = useState<{ steps: string[]; note?: string } | null>(null);
  const [planOk, setPlanOk] = useState(false);
  const fan = useFanout();
  const [pick, setPick] = useState<FanDir | null>(null);
  /* 收藏只记在这一屏里：它是"挑方向时先标一下"，不是一个要留档的东西 */
  const [favs, setFavs] = useState<Set<string>>(() => new Set());

  /**
   * 跑一轮。first 为真表示这是开场那句话——附件存好之后要回填到顶上那个气泡
   * （gen.files），而不是对话里最后一条。
   */
  const run = async (text: string, images: AgentImage[], first = false) => {
    /*
      发布过之后又说了一句要改的：这就是在做下一版了。右栏换回实时预览，
      「发布」按钮回来——再发是更新同一个地址（这段对话记着它）。原来发布
      过一次之后，按钮就一直是「已发布」，改完的东西再也发不出去。
    */
    setGen((g) => ({ ...g, busy: true, publishedUrl: null }));
    setModelAsk(null);
    /*
      这一轮有没有真的发生什么。模型可能一个字都不说、一个工具都不调就结束
      ——线上实测出现过两次，屏幕上什么都不变，人看到的是"没反应"。
      所以这里盯着，空手而归时在对话里明说一句。
    */
    let did = false;
    try {
      await streamAsk({
        text,
        images,
        choice: gen.choice,
        /* 开着计划模式、而且这一会话还没点过头：这一轮要先出计划，并真的拦住写文件 */
        plan: planOn ? (planOk ? 'go' : 'await') : 'off',
        sessionId: gen.sessionId,
        onSession: (id) => setGen((g) => ({ ...g, sessionId: id })),
        /* 附件存进工作区了：把 path 补到气泡里的那几张卡片上，刷新之后还点得开 */
        onAttachments: (saved) => setGen((g) => {
          const merge = (old?: ChatFile[]) => saved.map((f, i) => ({ ...(old?.[i] ?? {}), ...f }));
          if (first) return { ...g, files: merge(g.files) };
          const says = [...g.says];
          const at = lastAsk(says);
          if (at >= 0) says[at] = { ...says[at]!, files: merge(says[at]!.files) };
          return { ...g, says };
        }),
        onText: (delta) => setGen((g) => {
          did = true;
          const says = [...g.says];
          const last = says[says.length - 1];
          if (last && !last.me) says[says.length - 1] = { me: false, text: last.text + delta };
          else says.push({ me: false, text: delta });
          return { ...g, says };
        }),
        onTool: (name, args) => {
          /*
            ask_user 不进「处理中」那一摞：它不是一步工作，是一个在等人的
            问题。摆进去会显得"它还在做"，而实际上它已经停下了。
          */
          did = true;
          if (name === 'ask_user') {
            const a = parseAskArgs(args);
            if (a) setModelAsk(a);
            return;
          }
          /*
            和 ask_user 同一个道理：计划不是一步工作，是一份等人看的东西。
            摆进「处理中」那一摞会显得它还在做，而它已经停下了。
          */
          if (name === 'propose_plan') {
            const steps = (Array.isArray(args.steps) ? args.steps : [])
              .map((x) => (typeof x === 'string' ? x.trim() : ''))
              .filter(Boolean)
              .slice(0, 8);
            const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;
            if (steps.length) setPlan(note === undefined ? { steps } : { steps, note });
            return;
          }
          setGen((g) => ({
            ...g,
            /* 前一步到此为止——工具是顺序调的，新的一步开始就说明上一步做完了 */
            steps: [...g.steps.map((s) => ({ ...s, done: true })), toStep(name, args)],
            site: name === 'request_deploy' && typeof args.site === 'string' ? args.site : g.site,
          }));
        },
        /*
          压缩发生了就在对话里说一句。
          不弹 toast：它会自己消失，而这件事影响的是"它还记得多少"——
          人回头翻对话时应该还能看见这一行。
        */
        onCompacted: (before, after) => {
          const pct = before > 0 ? Math.max(1, Math.round((after / before) * 100)) : 0;
          setGen((g) => ({
            ...g,
            says: [...g.says, {
              me: false,
              sys: true,
              text: `已压缩以上对话内容 · 上下文 100% → ${pct}%`,
            }],
          }));
        },
        /* 文件落盘了，右栏跟着换一版 */
        onToolDone: (name, result) => {
          if (CHANGES_FILES.has(name)) {
            preview.refresh();
            setFsRev((n) => n + 1);
          }
          /* 生成的图直接摆进对话里，不用切到「代码」页去找 */
          const drawn = name === 'generate_image' ? /已生成并写入 (\S+?)（/.exec(result)?.[1] : undefined;
          if (drawn) {
            const f: ChatFile = { name: drawn.split('/').pop() ?? drawn, mimeType: 'image/png', size: 0, path: drawn };
            setGen((g) => {
              const says = [...g.says];
              const last = says[says.length - 1];
              if (last && !last.me) says[says.length - 1] = { ...last, files: [...(last.files ?? []), f] };
              else says.push({ me: false, text: '', files: [f] });
              return { ...g, says };
            });
          }
        },
        onDone: (stopReason, turns) => {
          if (did) return;
          /*
            一轮下来什么都没发生。把"为什么"说清楚，而不是让人盯着一个
            不动的屏幕猜——而且给一句可操作的下一步。
          */
          const why = stopReason === 'max_turns'
            ? `它绕了 ${turns} 轮也没收敛，这一轮先停下了。把需求说得更具体些再试。`
            : stopReason === 'error'
              ? '模型通道出错了，这一轮没做成。'
              : '这一轮模型什么都没返回（既没说话也没动文件）。再说一次试试，或者换个模型。';
          setGen((g) => ({ ...g, says: [...g.says, { me: false, text: why }] }));
        },
        onError: (m) => {
          did = true;
          /*
            错误要留在对话里，不能只弹一个会自己消失的 toast：这一屏的左栏
            此刻只有用户自己那句话，toast 一淡出，他看到的就是"我说了一句，
            然后什么都没发生"。最常见的那条错误（平台没配模型通道）尤其
            需要留着——那不是重试能解决的，得去找管理员。
          */
          setGen((g) => ({ ...g, says: [...g.says, { me: false, text: `出错了：${m}` }] }));
          onToast(`出错了：${m}`);
        },
      });
    } finally {
      /* 发布请求的 token 在流结束后问服务端要——它是 Agent 调工具时生成的 */
      const pend = await api.agentPending().catch(() => ({ items: [] }));
      setGen((g) => {
        /*
          认准**这一次**要发的那个 slug。

          待确认列表是整个人的，不是这一屏的：十分钟内做了两个页面，里面就
          有两条。服务端已经按新到旧排了，但只认"第一条"仍然可能拿到另一个
          页面的令牌——那条先过期，点发布报「令牌无效或已过期」，而他刚做好
          的这个明明还新鲜。所以先按 site 对，对不上再退回最新的那条。
        */
        const mine = g.site ? pend.items.find((x) => x.site === g.site) : undefined;
        const pk = mine ?? pend.items[0];
        return {
          ...g,
          busy: false,
          steps: g.steps.map((s) => ({ ...s, done: true })),
          confirmToken: pk?.confirmToken ?? g.confirmToken,
          site: pk?.site ?? g.site,
        };
      });
      setFsRev((n) => n + 1);
    }
  };

  /*
    第一句话在挂载时直接发给模型，只发一次。

    守卫用 ref 而不是 state：严格模式会把 effect 跑两遍，而 setGen 是异步的，
    第二遍读到的还是旧值，于是发两次，对话里出现两条一模一样的回答（实测
    踩过）。刷新恢复出来的那一个不发——它早就发过了，再发一遍等于把同一个
    需求又做一次。
  */
  const sent = useRef(false);
  useEffect(() => {
    /* 等会话 id 到了再发：第一句话必须落在预览正看着的那个工作区里 */
    if (sent.current || gen.restored || gen.says.length > 0 || !ready) return;
    sent.current = true;
    void run(gen.text, gen.images, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /** 模型问的那种，回答就是下一轮的输入。 */
  const answerModel = (o: AskOption) => {
    setModelAsk(null);
    setGen((g) => ({ ...g, says: [...g.says, { me: true, text: o.label, ask: true }] }));
    void run(o.label, []);
  };

  /** 挑中一个方向：让模型照它做真正的页面。 */
  const usePick = (d: FanDir) => {
    if (pick?.id === d.id) { setTab('preview'); return; }
    if (gen.busy) { onToast('等这一轮做完再换'); return; }
    setPick(d);
    setTab('preview');
    setGen((g) => ({ ...g, says: [...g.says, { me: true, text: `用「${d.name}」这一版`, ask: true }] }));
    void run(
      `就按「${d.name}」这一版的视觉来做。那一版在 ${d.path}，`
      + `先 read_file 看它的配色、字体和排版，再把真正的页面写成 index.html。`
      + `原始需求是：${gen.text}`,
      [],
    );
  };

  /** 基于某一版再出设计（卡片上的 ✦、微调条、更多类似）。出来的进「设计」页的下一批。 */
  const variant = (base: FanDir, kind: VariantKind) => {
    if (fan.running) { onToast('上一批还没出完'); return; }
    setTab('design');
    setGen((g) => ({
      ...g,
      says: [
        ...g.says,
        { me: true, text: variantAsk(kind, base.name) },
        { me: false, text: '在做了，新版本会出现在右边「设计」里，好了点 + 就能换过去。' },
      ],
    }));
    void fan.start({
      text: gen.text, device: 'both', model: gen.choice.model, effort: gen.choice.effort,
      variant: { kind, base }, sessionId: gen.sessionId,
    });
  };

  /** 下载设计稿：就是那一版写出来的那个 HTML，原样存下来。 */
  const download = async (d: FanDir) => {
    try {
      const f = await api.workspaceFile(d.path, gen.sessionId);
      if (f.binary || f.tooBig) { onToast('这一版的文件太大，没法直接下载'); return; }
      const href = URL.createObjectURL(new Blob([f.text], { type: 'text/html;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = href;
      a.download = `${d.name}.html`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      onToast(`「${d.name}」设计稿已下载`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : '下载失败');
    }
  };

  const toggleFav = (d: FanDir) => setFavs((s) => {
    const n = new Set(s);
    if (n.has(d.id)) n.delete(d.id); else n.add(d.id);
    return n;
  });

  const startFan = () => {
    void fan.start({
      text: gen.text, device: 'both', model: gen.choice.model, effort: gen.choice.effort, sessionId: gen.sessionId,
    });
  };

  const sendFollow = async () => {
    const t = follow.trim();
    if (!t || gen.busy) return;
    const imgs = followImgs;
    setFollow('');
    setFollowImgs([]);
    setGen((g) => ({ ...g, says: [...g.says, { me: true, text: t, files: imgs.map(toChatFile), ask: true }] }));
    await run(t, imgs);
  };

  /* 输入框里换模型，下一轮起生效（服务端会给这个会话换上新引擎） */
  const modelId = gen.choice.model || models[0]?.id || '';
  const setModel = (id: string) => setGen((g) => ({ ...g, choice: { ...g.choice, model: id } }));
  const setEffort = (e: Effort) => setGen((g) => ({ ...g, choice: { ...g.choice, effort: e } }));

  const siteOk = appSlugSchema.safeParse(siteDraft).success;
  /* 现在还发不了的原因。能发时为空 */
  const notReady = !gen.sessionId || !hasPage ? '第一版还没做好'
    : gen.busy ? '这一轮还在做'
      : !siteOk ? '先填一个地址'
        : null;

  /**
   * 发布：发这段对话的工作区，不要令牌——人在这里点这一下就是确认
   * （为什么不要，见 routes/agent.ts 的 /agent/publish-session）。
   */
  const publish = async (overwrite = false) => {
    if (!gen.sessionId || publishing || notReady) return;
    setPublishing(true);
    let taken: string | null = null;
    try {
      const r = await api.agentPublishSession({
        sessionId: gen.sessionId, site: siteDraft, name: gen.title, device: pubDevice ?? dev,
        ...(overwrite ? { overwrite: true } : {}),
      });
      /*
        可见范围是发布之后的一次独立改动：发布链路本身只管"把东西放上去"，
        谁能看是 apps.visibility 那一列的事（和控制台里改它走同一条接口）。
      */
      let sharingError: string | null = null;
      try { await api.setVisibility(r.app.id, vis); }
      catch (e) { sharingError = e instanceof Error ? e.message : '分享设置失败'; }
      if (sharingError) {
        setGen((g) => ({ ...g, says: [...g.says, { me: false,
          text: `页面已发布，但分享设置未生效：${sharingError}。请在「我的页面」中重新设置分享。` }] }));
      }
      setGen((g) => ({ ...g, publishedUrl: r.url, confirmToken: null, site: r.app.slug }));
      /* 右栏这就换成正式地址，工作区预览没人看了，收掉它 */
      preview.release();
      setPubOpen(false);
      onToast(sharingError ? `页面已发布，分享设置失败：${sharingError}` : `已发布到 ${r.url}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '发布失败';
      /* 地址上已经有自己另一个页面：问一句，确认了再覆盖（问在 finally 之后，按钮先恢复） */
      /*
        ⚠️ 这里不能 return：catch 里 return 会连 finally 后面那段一起跳过，
        确认框就永远弹不出来（实测踩过——409 回来了，屏幕上什么都没有）。
      */
      if ((e as { code?: string }).code === 'ALREADY_EXISTS' && !overwrite) {
        taken = msg;
      } else {
        /*
          发布失败的话留在对话里，不只弹一个会淡出的 toast。

          最常见的那种失败是发布链路把产物拦了（扫到密钥或 XSS 规则），而那句
          话里带着**规则名和行号**——它正是下一步要照着改的东西。toast 一淡出，
          人看到的就是"点了发布，按钮还在那儿"，根本不知道发生过什么。
        */
        setGen((g) => ({ ...g, says: [...g.says, { me: false, text: `没能发布：${msg}` }] }));
        onToast(msg);
      }
    } finally {
      setPublishing(false);
    }
    if (taken && await ask({
      title: '这个地址已经有页面了',
      description: `${taken}覆盖之后，那个地址上换成这一版；原来那个页面的旧版本还在控制台的版本记录里，可以回滚。`,
      confirmLabel: '用这一版覆盖',
      danger: true,
    })) {
      void publish(true);
    }
  };

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [gen.says, gen.steps, modelAsk, fan.dirs]);

  const url = gen.publishedUrl
    ?? (gen.site ? `${location.origin}/${me.username}/${gen.site}/` : '');
  const shown = url.replace(/^https?:\/\//, '');

  /*
    iframe 真正装的东西：发布前是工作区实时预览，发布后换成正式地址。

    `?_r=` 是刷新用的——改 src 才会让 iframe 重新加载，而路径本身不能变。
    预览响应带 no-store，所以这个参数只是为了让 React 认出 src 变了。
  */
  /* 带服务端 / 要构建的项目不渲染——伺服出去是半截页面或白屏，见 preview-kind.ts */
  const renderable = preview.kind === null || preview.kind.kind === 'static'
    || preview.kind.kind === 'empty';
  /*
    发布之后右栏装的是正式页面，但**不能直接装 publishedUrl**。

    预览框是沙箱 iframe（不给 allow-same-origin），里面的页面是 opaque origin：
    它自己去取 style.css、app.js 时带不上登录态，"仅自己可见"的页面就把这些
    请求全挡了——框里剩一页裸 HTML；平台还会往页面顶上注入那条带「登录」的
    顶栏。线上年会抽奖发布完就是这个样子。

    详情页和为你推荐早就不这么装了：换一个短时效的试玩地址
    （/deploy/api/play/{token}/），凭证在路径里、不靠 cookie，也不注入顶栏。
    这里照做。令牌还没换到时先摆骨架屏。
  */
  const play = usePlayUrl(gen.publishedUrl && gen.site
    ? { owner_username: me.username, slug: gen.site, status: 'running' }
    : null);
  const frameUrl = gen.publishedUrl
    ? play
    : (preview.url && renderable ? `${preview.url}?_r=${preview.rev}` : null);

  /** 把预览里的报错作为一次追问发出去，让模型自己改。 */
  const fixErrors = () => {
    if (!preview.errs.length || gen.busy) return;
    const list = preview.errs.slice(0, 12).map((e) => `- ${e.text}`).join('\n');
    const text = `预览里页面报了这些错，帮我看一下并修掉：\n${list}`;
    preview.clear();
    setShowErrs(false);
    setGen((g) => ({ ...g, says: [...g.says, { me: true, text, ask: true }] }));
    void run(text, []);
  };

  /**
   * 撤回这一步：工作区退回这一轮开始前，对话也截回那一刻（服务端两样一起退）。
   *
   * 被撤掉的那句话放回输入框——人撤回多半是"我刚才说得不对"，改两个字重发
   * 比从头打一遍省事。连点就一步步往前退，退到头服务端会说"没有可以撤回的"。
   */
  const [undoing, setUndoing] = useState(false);
  const undo = async () => {
    if (gen.busy || undoing || !gen.sessionId) return;
    setUndoing(true);
    try {
      const r = await api.agentUndo(gen.sessionId);
      /*
        放回输入框的那句话从**当前渲染的** gen 里取，不在 setGen 的回调里取：
        React 可能推迟到下一次渲染才执行那个回调，那时 setFollow 早跑完了。
      */
      const at0 = lastAsk(gen.says);
      const back = at0 >= 0 ? gen.says[at0]!.text : gen.text;
      setGen((g) => {
        const at = lastAsk(g.says);
        return {
          ...g,
          says: at >= 0 ? g.says.slice(0, at) : [],
          steps: [],
          /* 令牌是照撤回前的样子签的，作废，要发布让它再请求一次 */
          confirmToken: null,
        };
      });
      setModelAsk(null);
      setFollow((cur) => cur || back);
      preview.refresh();
      setFsRev((n) => n + 1);
      const short = r.label.length > 16 ? `${r.label.slice(0, 16)}…` : r.label;
      onToast(r.left ? `撤回了「${short}」，还能再撤 ${r.left} 步` : `撤回了「${short}」`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : '撤回失败');
    } finally { setUndoing(false); }
  };
  const canUndo = !gen.busy && !undoing && gen.sessionId !== null && !gen.publishedUrl
    && (gen.says.length > 0 || gen.steps.length > 0);

  /*
    有了刷新恢复之后，「新对话」就是必需品：不给出口的话，人会一直被困在上
    一个页面里，只有发布了才出得来。
  */
  const newChat = async () => {
    if (gen.busy) return;
    if (!gen.publishedUrl && !(await ask({
      title: '放下这一个、做个新的？',
      description: '工作区里的文件会留着，在「历史版本」里还能打开；只是这一屏换成新的开场。',
      confirmLabel: '做个新的',
    }))) return;
    onFresh();
  };

  /*
    分享的是正式地址。没发布之前没有别人打得开的地址——不复制一个会 404 的出去，
    而是直接把发布菜单打开：想分享，下一步就是发布。
  */
  const share = () => {
    if (!gen.publishedUrl) { setPubOpen(true); onToast('还没发布：发布之后这里一点就复制地址'); return; }
    void copyText(gen.publishedUrl).then((ok) => onToast(ok ? '地址已复制，发给同事就能打开' : gen.publishedUrl!));
  };

  /*
    新窗口打开只开正式地址。

    工作区预览和门户是同源的，它能安全地放在 iframe 里，靠的正是沙箱不给
    allow-same-origin。拿到顶层窗口去开就没有这层沙箱了——一段还没过发布前
    扫描的、模型刚写的脚本，会以门户的身份跑起来。
  */
  const stage = useRef<HTMLDivElement | null>(null);
  const openFull = () => {
    if (gen.publishedUrl) { window.open(gen.publishedUrl, '_blank', 'noopener'); return; }
    /*
      没发布之前全屏这一栏：预览还在原来那个沙箱 iframe 里，只是占满屏幕，Esc
      退出。不开新窗口的理由见上面那段——顶层窗口里没有这层沙箱。
    */
    const el = stage.current;
    if (!el?.requestFullscreen) { onToast('这个浏览器不支持全屏'); return; }
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => onToast('没能进入全屏'));
  };

  const waiting = modelAsk !== null;
  const working = gen.busy || fan.running;
  const status = gen.publishedUrl ? '已上线'
    : waiting ? '在等你回答'
      : fan.running ? '正在出设计方向'
        : gen.busy ? '正在做，写一个文件右边刷一次'
          : '预览 · 还没发布';
  const placeholder = waiting ? '或者直接输入你的想法…'
    : gen.busy ? '等这一轮做完再改'
      : fan.dirs.length > 0 && !pick ? '先在右边挑一个方向'
        : '说说哪里要改，比如「换班加一个备注栏」';
  const canSend = follow.trim().length > 0 && !gen.busy;

  return (
    <div style={{ height: '100%', minHeight: 560, display: 'flex', background: 'var(--surface-canvas)' }}>
      {confirmUI}
      {/* ── 左：对话、问答与进度 ─────────────────────────────────── */}
      {chatShown && (
        <div
          style={{
            width: 'clamp(320px, 32%, 560px)', flex: 'none', minHeight: 0, display: 'flex',
            flexDirection: 'column', borderRight: '1px solid var(--border-tabby)',
          }}
        >
          <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 16px' }}>
            <span
              title={gen.title}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, height: 34, minWidth: 0, maxWidth: '70%',
                padding: '0 14px', borderRadius: 12, background: 'var(--surface-1)',
                boxShadow: '0 0 0 1px var(--border-subtle)', fontSize: 'var(--text-md)',
                fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', whiteSpace: 'nowrap',
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{gen.title}</span>
              {working && (
                <Icon
                  name="rotate"
                  size={14}
                  color="var(--tabby-orange)"
                  style={{ animation: 'ispace-spin 1s linear infinite' }}
                />
              )}
            </span>
            <IconBtn icon="plus" title={gen.busy ? '等这一轮做完' : '新对话'} onClick={newChat} disabled={gen.busy} />
            <div style={{ flex: 1 }} />
            <SessionsMenu currentId={gen.sessionId} busy={gen.busy} onOpen={(id) => onOpen(id)} />
            <IconBtn icon="forward" title="分享" onClick={share} />
          </div>

          <div
            ref={log}
            style={{
              flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 28px 20px',
              display: 'flex', flexDirection: 'column', gap: 20,
            }}
          >
            <UserBubble text={gen.text} files={gen.files} sessionId={gen.sessionId} />

            {gen.says.map((m, i) => (
              m.sys
                /* 平台自己说的一句（压缩提示）：一条细线加一行小字，不占气泡 */
                ? (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0' }}>
                    <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
                    <span style={{ flex: 'none', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                      {m.text}
                    </span>
                    <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
                  </div>
                )
                : m.me
                  ? <UserBubble key={i} text={m.text} files={m.files} sessionId={gen.sessionId} />
                  : <AiBubble key={i} text={m.text} files={m.files} sessionId={gen.sessionId} />
            ))}

            {canUndo && (
              <button
                type="button"
                onClick={() => void undo()}
                title="文件退回这一轮开始前，对话也截回那一刻"
                style={{
                  alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, marginLeft: 36,
                  padding: 0, border: 0, background: 'none', cursor: 'pointer',
                  fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)',
                }}
              >
                <Icon name="history" size={13} />撤回这一步
              </button>
            )}

            <ProcessBlock
              steps={gen.steps}
              agents={fan.dirs}
              busy={working}
              skill={fan.dirs.length ? 'design-fanout' : null}
              /* 模型问了一句在等人答：那一步该显示「在等你」，不是转圈 */
              waiting={waiting}
            />

            {fan.err && (
              <div style={{ fontSize: 'var(--text-md)', lineHeight: 1.75, color: 'var(--error)' }}>
                设计方向没能跑起来：{fan.err}
              </div>
            )}

            {fan.dirs.length > 0 && !pick && !fan.running && (
              <div style={{ fontSize: 'var(--text-md)', lineHeight: 1.75, color: 'var(--text-primary)' }}>
                右边是 {fan.dirs.length} 个方案，挑一个「用这一版」，我就照它把页面做出来。
              </div>
            )}

            {gen.busy && !waiting && (
              <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)' }}>正在做…</span>
            )}
          </div>

          {/* 底部：问题卡片、微调条、输入框——都是"接下来你说什么" */}
          <div style={{ flex: 'none', padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {modelAsk && <AskCard ask={modelAsk} onPick={answerModel} disabled={gen.busy} />}

            {plan && !gen.busy && (
              <PlanCard
                plan={plan}
                onGo={() => {
                  /*
                    点头：闸门撤掉，并且这一会话之后几轮都不再拦。
                    不然每说一句都要重新出一份计划，那不是「先出计划」，
                    是每句话都卡一下。
                  */
                  setPlanOk(true);
                  setPlan(null);
                  setGen((g) => ({ ...g, says: [...g.says, { me: true, text: '按这份计划开始做' }] }));
                  void run('按这份计划开始做', []);
                }}
                onEdit={() => {
                  /* 只收起卡片，把话筒交回输入框——改意见是一句话的事 */
                  setPlan(null);
                  onToast('说说计划哪里要改，我让它改完再给你看一眼');
                }}
              />
            )}

            {pick && !modelAsk && (
              <RefineBar pick={pick} busy={fan.running} onVariant={(k) => variant(pick, k)} />
            )}

            <div
              style={{
                display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 12px 10px 16px',
                borderRadius: 22, background: 'var(--surface-1)',
                boxShadow: '0 1px 3px rgba(24,23,21,.04), 0 0 0 1px var(--border-subtle)',
              }}
            >
              <input
                value={follow}
                onChange={(e) => setFollow(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  void sendFollow();
                }}
                placeholder={placeholder}
                disabled={gen.busy}
                style={{
                  width: '100%', boxSizing: 'border-box', height: 30, padding: 0, border: 0, outline: 'none',
                  background: 'transparent', fontSize: 'var(--text-md)', color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                }}
              />
              <ImageChips
                images={followImgs}
                onRemove={(i) => setFollowImgs((prev) => prev.filter((_, k) => k !== i))}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <AddButton
                  up
                  size={34}
                  onImages={(next) => setFollowImgs((prev) => [...prev, ...next].slice(0, MAX_ATTACH))}
                  onToast={onToast}
                />
                <ModelPill
                  up
                  size={34}
                  models={models}
                  effortOn={effortOn}
                  modelId={modelId}
                  effort={gen.choice.effort ?? 'medium'}
                  onModel={setModel}
                  onEffort={setEffort}
                />
                {/*
                  计划模式开关（改版稿「先出计划，你确认后再动手」）。

                  点亮之后，服务端会真的拦住写、改、删、发布那几个工具，直到
                  这一会话里有一份计划被点过头——不是只在提示词里说一句。
                */}
                <button
                  onClick={() => {
                    setPlanOn((v) => {
                      const on = !v;
                      /* 关掉再打开，就是想重新过一遍计划：之前点过的头不再算数 */
                      if (on) { setPlanOk(false); setPlan(null); }
                      onToast(on ? '计划模式：它会先列几步给你看，确认后才动手' : '已关掉计划模式');
                      return on;
                    });
                  }}
                  title={planOn ? '退出计划模式' : '进入计划模式：先出计划，你确认后再动手'}
                  style={{
                    height: 34, padding: '0 10px', flex: 'none', borderRadius: 'var(--radius-pill)',
                    border: planOn ? 0 : '1px solid var(--border)',
                    background: planOn ? 'var(--brand-wash)' : 'transparent',
                    color: planOn ? 'var(--tabby-orange)' : 'var(--text-tertiary)',
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontSize: 'var(--text-base)', cursor: 'pointer',
                  }}
                >
                  <Icon name="scroll" size={15} />
                  {planOn ? '先出计划' : '计划'}
                </button>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => void sendFollow()}
                  title={gen.busy ? '等这一轮做完' : '发送'}
                  disabled={!canSend}
                  style={{
                    width: 34, height: 34, flex: 'none', border: 0, borderRadius: 'var(--radius-pill)',
                    background: canSend ? 'var(--cta)' : 'var(--surface-3)',
                    color: canSend ? 'var(--cta-fg)' : 'var(--text-tertiary)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: canSend ? 'pointer' : 'default',
                  }}
                >
                  <Icon name="up" size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 右：预览 / 代码 / 设计 ───────────────────────────────── */}
      <div ref={stage} style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface-1)' }}>
        <div
          style={{
            height: 56, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px',
            borderBottom: '1px solid var(--border-tabby)',
          }}
        >
          <IconBtn
            icon="panel"
            title={chatShown ? '收起对话' : '显示对话'}
            onClick={() => setChatShown((v) => !v)}
          />
          <IconBtn icon="expand" title={gen.publishedUrl ? '新窗口打开' : '全屏预览（Esc 退出）'} onClick={openFull} />
          <span style={{ width: 1, height: 18, margin: '0 6px', flex: 'none', background: 'var(--border-tabby)' }} />
          <TabBar cur={tab} onPick={setTab} labels={vw >= 1180 || !chatShown} />
          <div style={{ flex: 1, minWidth: 0 }} />
          <VersionsMenu
            sessionId={gen.sessionId}
            busy={gen.busy}
            onToast={onToast}
            onRestored={(r) => {
              const short = r.label.length > 16 ? `${r.label.slice(0, 16)}…` : r.label;
              onToast(`退回到「${short}」之前了${r.left ? `，前面还有 ${r.left} 步` : ''}`);
              /* 对话截回了服务端那一刻，照服务端重新摆一遍，免得和文件对不上 */
              if (gen.sessionId) onOpen(gen.sessionId);
            }}
          />
          <MoreMenu
            sessionId={gen.sessionId}
            title={gen.title}
            busy={gen.busy}
            onToast={onToast}
            onFork={(id) => { onToast('复制好了，这是新的一份'); onOpen(id, { forkOf: gen.title }); }}
            onImported={() => { setFsRev((n) => n + 1); preview.refresh(); }}
            log={() => ({
              app: 'iDo',
              exportedAt: new Date().toISOString(),
              title: gen.title,
              prompt: gen.text,
              model: gen.choice.model,
              effort: gen.choice.effort,
              sessionId: gen.sessionId,
              publishedUrl: gen.publishedUrl,
              messages: gen.says.map((m) => ({
                role: m.sys ? ('system' as const) : m.me ? ('user' as const) : ('assistant' as const),
                text: m.text,
              })),
              steps: gen.steps.map((st) => ({ tool: st.key, detail: st.detail })),
            })}
          />

          <div style={{ position: 'relative', flex: 'none' }}>
            {pubOpen && (
              <div onClick={() => setPubOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
            )}
            <button
              onClick={() => setPubOpen((v) => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 10px 0 14px',
                border: 0, borderRadius: 11,
                background: gen.publishedUrl ? 'var(--success-subtle)' : 'var(--cta)',
                color: gen.publishedUrl ? 'var(--success)' : 'var(--cta-fg)',
                fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)',
                whiteSpace: 'nowrap', cursor: 'pointer',
              }}
            >
              <Icon name={gen.publishedUrl ? 'check' : 'globe'} size={16} />
              {gen.publishedUrl ? '已发布' : '发布'}
              <Icon name="chevDown" size={15} style={{ opacity: 0.8 }} />
            </button>
            {pubOpen && (
              <PublishMenu
                published={gen.publishedUrl !== null}
                url={url}
                device={pubDevice ?? dev}
                onDevice={setPubDevice}
                vis={vis}
                setVis={setVis}
                username={me.username}
                site={siteDraft}
                onSite={(v) => { siteTouched.current = true; setSiteDraft(v); }}
                siteOk={siteOk}
                canPublish={notReady === null}
                notReady={notReady}
                publishing={publishing}
                onPublish={() => void publish()}
                onMine={onMine}
                onToast={onToast}
                onClose={() => setPubOpen(false)}
              />
            )}
          </div>
        </div>

        {tab === 'design' && (
          <DesignGallery
            batches={fan.batches}
            previewUrl={preview.url}
            pickedId={pick?.id ?? null}
            favs={favs}
            dev={dev}
            onDev={setDev}
            onPick={usePick}
            onVary={(d) => variant(d, 'vary')}
            onFav={toggleFav}
            onDownload={(d) => void download(d)}
            onStart={startFan}
            genBusy={gen.busy}
            fanBusy={fan.running}
          />
        )}

        {tab === 'code' && <CodePane rev={fsRev} sessionId={gen.sessionId} />}

        {tab === 'preview' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface-sidebar)' }}>
            <div
              style={{
                height: 52, flex: 'none', display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', gap: 12, padding: '0 20px',
              }}
            >
              <span
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 'var(--text-base)',
                  color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden',
                }}
              >
                <Icon
                  name={gen.publishedUrl ? 'check' : working ? 'rotate' : 'info'}
                  size={15}
                  color={gen.publishedUrl ? 'var(--success)' : 'var(--tabby-orange)'}
                  style={working && !gen.publishedUrl ? { animation: 'ispace-spin 1s linear infinite' } : undefined}
                />
                {status}
              </span>
              <Segment
                options={[
                  { k: 'phone', label: '手机', icon: 'phone' },
                  { k: 'pc', label: '电脑', icon: 'monitor' },
                ]}
                value={dev}
                onPick={(k) => setDev(k as Device)}
                pad={11}
              />
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '4px 24px 24px' }}>
              {dev === 'phone' ? (
                <div
                  style={{
                    /*
                      与详情、为你推荐一致：手机版纵向吃满。比例给屏幕不给黑边
                      （content-box），所以高度先让出上下两圈 padding。
                    */
                    height: 'calc(100% - 18px)', aspectRatio: PHONE_RATIO, boxSizing: 'content-box',
                    padding: 9, borderRadius: 44, background: '#0d0d10',
                    boxShadow: '0 40px 80px -30px rgba(0,0,0,.35)',
                  }}
                >
                  <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 36, overflow: 'hidden', background: 'var(--surface-1)' }}>
                    <PreviewBody url={frameUrl} phone frameRef={preview.frame}
                      notice={renderable ? null : preview.kind} />
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    /* 与详情、为你推荐一致：电脑版横向吃满 */
                    width: '100%', borderRadius: 16, overflow: 'hidden',
                    background: 'var(--surface-1)',
                    boxShadow: '0 40px 80px -30px rgba(0,0,0,.3), 0 0 0 1px rgba(0,0,0,.06)',
                  }}
                >
                  <div
                    style={{
                      height: 38, display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px',
                      background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6, width: 46 }}>
                      {[0, 1, 2].map((k) => (
                        <span key={k} style={{ width: 10, height: 10, borderRadius: 'var(--radius-pill)', background: 'var(--surface-3)' }} />
                      ))}
                    </div>
                    <div
                      className="mono"
                      style={{
                        flex: 1, maxWidth: 440, height: 24, margin: '0 auto', borderRadius: 8,
                        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
                        whiteSpace: 'nowrap', overflow: 'hidden',
                      }}
                    >
                      {shown || '还没有地址'}
                    </div>
                    <div style={{ width: 46 }} />
                  </div>
                  <div style={{ position: 'relative', aspectRatio: '16 / 10', background: 'var(--surface-1)' }}>
                    <PreviewBody url={frameUrl} phone={false} frameRef={preview.frame}
                      notice={renderable ? null : preview.kind} />
                  </div>
                </div>
              )}
            </div>

            {/*
              预览里页面报的错。

              不自动塞进对话：一个 favicon 404 不值得触发一轮模型调用，而且
              自动发出去会把用户正要说的话冲掉。这里只摆一条，点「让它修」
              才真的发——人决定要不要修，模型拿到的是完整的错误文本。
            */}
            {!gen.publishedUrl && preview.errs.length > 0 && (
              <div
                style={{
                  flex: 'none', padding: '10px 20px', borderTop: '1px solid var(--border-tabby)',
                  background: 'var(--surface-1)', display: 'flex', flexDirection: 'column', gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* 用 --error 而不是 --danger：深色模式只重定义了前者 */}
                  <Icon name="info" size={14} color="var(--error)" />
                  <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-heading)', fontWeight: 'var(--weight-semibold)' }}>
                    页面报了 {preview.errs.length} 个错
                  </span>
                  <button
                    onClick={() => setShowErrs((v) => !v)}
                    style={{
                      border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
                      fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
                    }}
                  >
                    {showErrs ? '收起' : '看看'}
                  </button>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={preview.clear}
                    style={{
                      height: 30, padding: '0 10px', border: '1px solid var(--border)',
                      borderRadius: 9, background: 'var(--surface-1)', color: 'var(--text-secondary)',
                      fontSize: 'var(--text-base)', cursor: 'pointer',
                    }}
                  >
                    先不管
                  </button>
                  <button
                    onClick={fixErrors}
                    disabled={gen.busy}
                    style={{
                      height: 30, padding: '0 12px', border: 0, borderRadius: 9,
                      background: gen.busy ? 'var(--surface-3)' : 'var(--accent)',
                      color: gen.busy ? 'var(--text-tertiary)' : 'var(--accent-fg)',
                      fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
                      cursor: gen.busy ? 'default' : 'pointer',
                    }}
                  >
                    让它修
                  </button>
                </div>
                {showErrs && (
                  <div
                    className="mono"
                    style={{
                      maxHeight: 108, overflow: 'auto', display: 'flex', flexDirection: 'column',
                      gap: 4, fontSize: 'var(--text-base)', lineHeight: 1.6,
                      color: 'var(--text-tertiary)', wordBreak: 'break-all',
                    }}
                  >
                    {preview.errs.map((e, i) => <span key={i}>{e.text}</span>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ask_user 的参数 → 一张卡片。
 *
 * 和服务端 parseAsk 同一条判据（要有问题、至少两个选项）。两边各写一份是
 * 有意的：服务端那份决定"这一轮停不停"，这一份决定"画不画"。模型给了半成品
 * 参数时，两边都是"当没问过"。
 */
function parseAskArgs(args: Record<string, unknown>): Ask | null {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  const raw = Array.isArray(args.options) ? args.options : [];
  const options = raw.slice(0, 4).flatMap((o) => {
    const r = o as Record<string, unknown>;
    const label = typeof r?.label === 'string' ? r.label.trim() : '';
    if (!label) return [];
    return [{
      label,
      ...(typeof r.hint === 'string' && r.hint.trim() ? { hint: r.hint.trim() } : {}),
      ...(r.recommended === true ? { recommended: true } : {}),
    }];
  });
  if (!question || options.length < 2) return null;
  return { from: 'model', question, options };
}

/**
 * 发布前没有预览可看。
 *
 * 真实链路里，页面在"发布"之前只是用户工作区里的几个文件，没有任何地址能
 * 渲染它——设计稿那块骨架屏画的就是这个状态，这里照着摆。发布之后换成真
 * 页面的 iframe。
 */
function PreviewBody({ url, phone, frameRef, notice }: {
  url: string | null;
  phone: boolean;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  /** 不为空就说明这个项目不走预览，摆一块说明而不是骨架屏。 */
  notice: PreviewKind | null;
}) {
  /*
    不渲染的时候**说清楚为什么**，不要摆一屏骨架。

    骨架屏的意思是"正在加载"，而这里不是加载中——是平台决定不渲染它。
    摆骨架等于让人一直等一个永远不会来的东西；而白屏更糟，人会以为预览
    坏了或者模型写的东西有问题，两个方向都是错的。

    signals 也列出来，让人能自己核对判定对不对，而不是只能信结论。
  */
  if (notice) {
    return (
      <div
        style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 12,
          padding: phone ? '32px 22px' : '32px 15%', textAlign: 'center',
        }}
      >
        <span
          style={{
            width: 36, height: 36, borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-3)', color: 'var(--text-tertiary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon name="info" size={18} />
        </span>
        <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
          {notice.kind === 'server' ? '这是个带服务端的项目' : '这个项目要先构建'}
        </span>
        <span style={{ fontSize: 'var(--text-base)', lineHeight: 1.75, color: 'var(--text-secondary)' }}>
          {notice.why}
        </span>
        {notice.signals.length > 0 && (
          <span className="mono" style={{ fontSize: 'var(--text-base)', color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>
            看到了：{notice.signals.join('、')}
          </span>
        )}
      </div>
    );
  }
  if (url) {
    return (
      <iframe
        ref={frameRef}
        src={url}
        title="预览"
        /*
          沙箱与详情页、为你推荐一字不差：给脚本和表单，**不给**
          allow-same-origin——两者同时给等于没有沙箱，被预览的页面就能
          借平台的 origin 读写平台接口。预览里跑的是模型刚写出来、
          没人审过的代码，这条更要守。

          代价是页面拿不到会话 cookie，所以取数走的是服务端注入的 shim
          加一次性只读令牌（见 usePreview 与 services/preview-shim.ts）。
        */
        sandbox="allow-scripts allow-forms allow-popups"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
      />
    );
  }
  const bar = (w: string, h: number, r: number, bg: string) => (
    <div style={{ width: w, height: h, borderRadius: r, background: bg }} />
  );
  return phone ? (
    <div style={{ position: 'absolute', inset: 0, padding: '52px 18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {bar('55%', 22, 6, 'var(--surface-3)')}
      {bar('80%', 11, 4, 'var(--surface-2)')}
      {bar('100%', 128, 16, 'var(--surface-2)')}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {bar('100%', 72, 12, 'var(--surface-2)')}
        {bar('100%', 72, 12, 'var(--surface-2)')}
      </div>
      {bar('70%', 11, 4, 'var(--surface-2)')}
      {bar('46%', 11, 4, 'var(--surface-2)')}
    </div>
  ) : (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', gap: 18, padding: 24 }}>
      <div style={{ width: '22%', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {bar('100%', 18, 5, 'var(--surface-3)')}
        {bar('100%', 11, 4, 'var(--surface-2)')}
        {bar('100%', 11, 4, 'var(--surface-2)')}
        {bar('70%', 11, 4, 'var(--surface-2)')}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {bar('40%', 24, 6, 'var(--surface-3)')}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {bar('100%', 80, 12, 'var(--surface-2)')}
          {bar('100%', 80, 12, 'var(--surface-2)')}
          {bar('100%', 80, 12, 'var(--surface-2)')}
        </div>
        <div style={{ flex: 1, borderRadius: 14, background: 'var(--surface-2)' }} />
      </div>
    </div>
  );
}

// ── 与 Agent 的那条流 ───────────────────────────────────────────────────
/**
 * 逐字读 /agent/ask 的 SSE。
 *
 * 浏览器这边能真流式读（fetch + ReadableStream），所以不像手机壳那样要等
 * 整段回来再切——那边 React Native 的 fetch 不支持流式 body。
 */
async function streamAsk(opts: {
  text: string;
  images: AgentImage[];
  choice: AgentChoice;
  sessionId: string | null;
  onSession: (id: string) => void;
  onText: (delta: string) => void;
  onTool: (name: string, args: Record<string, unknown>) => void;
  /**
   * 一次工具调用**做完了**。预览靠它决定什么时候刷新。
   *
   * 必须用 tool_result 而不是 tool_start：start 时文件还没落盘，那一刻
   * 刷新看到的仍是上一版，人会以为"改了没生效"。
   */
  onToolDone: (name: string, result: string) => void;
  /**
   * 上下文压过一次（compact.ts 的三档）。
   *
   * 服务端一直在发这个事件，前端却没接——于是长会话里悄悄发生的压缩，
   * 用户完全看不见：他只会觉得"它好像忘了前面说过的话"。稿上那行
   * 「已压缩以上对话内容」就是说这件事的。
   */
  onCompacted: (before: number, after: number) => void;
  /** 计划模式这一轮处在哪一档。见服务端 askSchema 的 plan。 */
  plan: 'off' | 'await' | 'go';
  /** 附件存进工作区了，给出各自的路径（与发出去的顺序一致）。 */
  onAttachments: (files: ChatFile[]) => void;
  /**
   * 这一轮为什么结束。
   *
   * 必须接：模型可能一个字都不说、一个工具都不调就结束（实测线上出现过
   * 两次）。不接的话屏幕上什么都不会变，用户看到的是"没反应"——而实际上
   * 请求早就回来了。
   */
  onDone: (stopReason: string, turns: number) => void;
  onError: (message: string) => void;
}): Promise<void> {
  const res = await fetch('/deploy/api/agent/ask', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: opts.text,
      /* 附件一律走 files：服务端存进工作区、抽出文字；图片照样作为图发给模型 */
      ...(opts.images.length ? { files: opts.images } : {}),
      /* 空的就别传：服务端按它自己的默认来，比传一个空串让它去校验干净 */
      ...(opts.choice.model ? { model: opts.choice.model } : {}),
      ...(opts.choice.effort ? { effort: opts.choice.effort } : {}),
      ...(opts.plan === 'off' ? {} : { plan: opts.plan }),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    /*
      服务端的错误是 {code, message} 的 JSON。整段打出来，用户看到的是
      一行带引号和花括号的东西——而 message 本身恰恰是写给他看的那句话
      （「Agent 未配置模型通道，请联系平台管理员」）。
    */
    const raw = await res.text().catch(() => '');
    let msg = raw.slice(0, 200);
    try {
      const body = JSON.parse(raw) as { message?: string };
      if (body.message) msg = body.message;
    } catch { /* 不是 JSON 就用原文 */ }
    opts.onError(msg || `接口返回 ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    /*
      SSE 的一帧以空行结束。按 \n\n 切，剩下的半帧留在 buf 里等下一个
      chunk——不留的话，一条正好被 TCP 切成两半的 JSON 会被丢掉。
    */
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(line.slice(5)) as Record<string, unknown>; } catch { continue; }
        if (e.type === 'session') opts.onSession(e.id as string);
        else if (e.type === 'text') opts.onText(e.delta as string);
        else if (e.type === 'tool_start') opts.onTool(e.name as string, (e.args ?? {}) as Record<string, unknown>);
        else if (e.type === 'tool_result') opts.onToolDone(e.name as string, String(e.result ?? ''));
        else if (e.type === 'attachments') {
          opts.onAttachments((e.files as { name: string; mimeType: string; size: number; path: string }[])
            .map((f) => ({ name: f.name, mimeType: f.mimeType, size: f.size, path: f.path })));
        }
        else if (e.type === 'compacted') {
          opts.onCompacted(Number(e.before ?? 0), Number(e.after ?? 0));
        }
        else if (e.type === 'done') opts.onDone(String(e.stopReason), Number(e.turns ?? 0));
        else if (e.type === 'error') opts.onError(String(e.message));
      }
    }
  }
}

/** 这些工具做完，工作区就变了——预览和「代码」页要跟着刷新。 */
const CHANGES_FILES = new Set(['write_file', 'edit_file', 'delete_file', 'copy_file', 'generate_image']);

/** 工具名 → 人话。看不懂的工具名原样显示，总比吞掉好。 */
function toStep(name: string, args: Record<string, unknown>): Step {
  const path = typeof args.path === 'string' ? args.path : '';
  const map: Record<string, [string, string]> = {
    list_files: ['看看空间里有什么', ''],
    read_file: ['读文件', path],
    write_file: ['写文件', path],
    edit_file: ['改文件', path],
    search_files: ['搜一下', typeof args.pattern === 'string' ? args.pattern : ''],
    copy_file: ['拷文件', typeof args.to === 'string' ? args.to : ''],
    delete_file: ['删文件', path],
    check_publishable: ['发布前自检', ''],
    screenshot_preview: ['截图看看效果', path || 'index.html'],
    get_quota: ['查一下配额', ''],
    list_apps: ['看已有的页面', ''],
    request_deploy: ['准备发布', typeof args.site === 'string' ? `/${args.site}/` : ''],
    ask_user: ['问你一句', typeof args.question === 'string' ? args.question : ''],
    generate_image: ['画一张图', typeof args.path === 'string' ? args.path : ''],
  };
  const [title, detail] = map[name] ?? [name, ''];
  return { key: name, title, detail, done: false };
}

/** 从第一句话里取个标题。和设计稿同一套削法：去掉「做一个」，截到第一个标点。 */
function titleOf(text: string): string {
  const m = text.replace(/^(请|帮我)?(做|写|搭)(一个|个)?/, '').split(/[：:，,。；;\s]/)[0];
  return (m || '新页面').slice(0, 14);
}

// ── 建议清单 ────────────────────────────────────────────────────────────
/** 文案照设计稿 SUGS 原样搬。它是产品文案，不是演示数据。 */
const SUGS: { label: string; items: { title: string; detail: string }[] }[] = [
  {
    label: '团队协作',
    items: [
      { title: '组里的值班排班表', detail: '每周轮一次，每个人能看到自己哪天值班；临时换班要对方确认，节假日自动跳过。' },
      { title: '周会议题收集', detail: '大家随时提议题、投票排序，周会开始前自动生成议程。' },
      { title: '新人入职清单', detail: '按天列出第一周要做的事，导师能看到进度。' },
      { title: '团建去哪投票', detail: '列出三到五个备选，每人投两票，截止后公布结果。' },
      { title: '共享设备借还', detail: '登记投影仪、相机这类公用设备，谁借走了、什么时候还一目了然。' },
      { title: '会议纪要归档', detail: '按会议归档纪要和待办，待办到期提醒负责人。' },
    ],
  },
  {
    label: '数据看板',
    items: [
      { title: '每日销售简报', detail: '每天早上汇总昨天的成交、回款和新增线索，和上周同期对比。' },
      { title: '客服工单趋势', detail: '按类型统计每天的工单量和平均处理时长，异常的日子标出来。' },
      { title: '招聘进度漏斗', detail: '从投递、筛选、面试到录用，每个岗位一条漏斗。' },
      { title: '预算执行情况', detail: '按部门展示预算和实际花费，超过 80% 的标黄。' },
      { title: '项目延期预警', detail: '列出所有项目的里程碑，快到期还没完成的提前一周提醒。' },
      { title: '活动报名统计', detail: '实时显示报名人数、部门分布和签到率。' },
    ],
  },
  {
    label: '工作提效',
    items: [
      { title: '周报自动汇总', detail: '读这周的日程和工单，生成「做了什么、卡在哪、下周计划」三段草稿。' },
      { title: '差旅报销计算', detail: '选城市、天数和职级，按差标算出能报多少。' },
      { title: '合同到期提醒', detail: '导入合同台账，到期前 30 天和 7 天各提醒一次。' },
      { title: '会议纪要整理', detail: '粘贴会议记录，整理成结论和待办，标出负责人。' },
      { title: '发票信息识别', detail: '上传发票照片，识别抬头、金额和税号，导出表格。' },
      { title: '审批进度追踪', detail: '列出我发起的审批卡在谁那里、卡了几天。' },
    ],
  },
  {
    label: '生活',
    items: [
      { title: '午饭吃什么', detail: '收录园区周边的店，按距离和人均筛，摇一下随机选一家。' },
      { title: '拼车上下班', detail: '按住的小区匹配同路同事，约好时间和上车点。' },
      { title: '闲置物品交换', detail: '同事之间发布闲置，标价或免费送，约好在公司交接。' },
      { title: '同事生日提醒', detail: '每月初列出本月过生日的同事，当天提醒大家送祝福。' },
      { title: '健身组队打卡', detail: '三到五人组队，每天传一张运动照片打卡。' },
      { title: '园区班车时刻', detail: '显示每条班车线路下一班几点、在哪上车。' },
    ],
  },
  {
    label: '小游戏',
    items: [
      { title: '打字速度挑战', detail: '60 秒内敲一段真实代码，按速度和准确率算分，出排行榜。' },
      { title: '代码评审转盘', detail: '从组里随机抽一位同事做评审，最近抽过的人跳过。' },
      { title: '年会抽奖', detail: '导入名单，分轮抽奖，抽中的人不重复。' },
      { title: '咖啡续命榜', detail: '每天点一下记一杯，周五出全组排行。' },
      { title: '团队知识竞答', detail: '出十道和业务有关的题，限时作答，实时排名。' },
      { title: '程序员节寻宝', detail: '在内网页面里藏线索，解出来的人进排行榜。' },
    ],
  },
];
