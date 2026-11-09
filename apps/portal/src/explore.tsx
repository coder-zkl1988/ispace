import { useState } from 'react';
import { EXPLORE_ALL, EXPLORE_CATEGORIES, exploreBucket } from '@ispace/contracts';
import { Icon, Mark } from '@ispace/ui';
import type { BackendListing, Listing } from './api';
import { EventBanner } from './event/Banner';
import { BackendWallCard, Wall, WallCard, appHref, mergeWall, type RecItem } from './wall';

/**
 * 探索（改版稿 §探索）。
 *
 * 改版前这一屏叫「创意市场」，是一张左侧分类 + 右侧列表的后台表格；新稿把
 * 它改成一面错落的卡片墙，顶上一句话和一个输入框 —— 先让人想起自己要做
 * 什么，再给他看别人做了什么。分类从左侧栏挪到了墙顶上一排圆角标签。
 *
 * 数据还是 /marketplace 那一条：页面之外，2026-11 起也端上 **exposed 的
 * 后端**（全栈项目有真实可打开的页面，「点开看」成立；纯 API 服务不收，
 * 仍留在控制台）。分类标签按 exploreBucket 归桶，所以改版前攒下的
 * 「效率工具」「表单问卷」这些旧分类仍然点得到——详见 contracts/social.ts
 * 里那张映射表。
 */
export function Explore({
  listings, backendListings = [], q, onClearQ, onOpen, onPlay, onRemix, onAuthor, onPrompt,
}: {
  listings: Listing[];
  backendListings?: BackendListing[];
  q: string;
  onClearQ: () => void;
  onOpen: (l: Listing) => void;
  onPlay: (l: Listing) => void;
  onRemix: (l: Listing) => void;
  onAuthor: (username: string) => void;
  /** 顶上那句话。回车或点箭头后带着它进创建页。 */
  onPrompt: (text: string) => void;
}) {
  const [cat, setCat] = useState<string>(EXPLORE_ALL);
  const [draft, setDraft] = useState('');

  const kw = q.trim().toLowerCase();
  const visible = mergeWall(listings, backendListings).filter((r) => {
    if (kw) {
      const hay = r.kind === 'app'
        ? `${r.l.name} ${r.l.description ?? ''} ${r.l.owner_name} ${r.l.category ?? ''}`
        : `${r.b.name} ${r.b.owner_name} ${r.b.category ?? ''}`;
      return hay.toLowerCase().includes(kw);
    }
    return cat === EXPLORE_ALL || exploreBucket(r.kind === 'app' ? r.l.category : r.b.category) === cat;
  });

  return (
    <div style={{ maxWidth: 1360, margin: '0 auto', padding: '0 32px 96px', boxSizing: 'border-box' }}>
      <EventBanner />

      {/*
        标题与输入框。输入框是整屏唯一被点亮的控件（--prompt-* 那两个
        token），因为这一屏真正希望人做的事只有一件：说一句想做什么。
      */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30, padding: '52px 0 4px', textAlign: 'center' }}>
        <h1
          style={{
            margin: 0, fontFamily: 'var(--font-serif)', fontWeight: 500,
            fontSize: 'clamp(32px, 4.2vw, 54px)', lineHeight: 1.15, letterSpacing: '-.01em',
            color: 'var(--text-heading)', textWrap: 'balance',
          }}
        >
          把想法变成同事能打开的页面。
        </h1>
        <div
          style={{
            width: '100%', maxWidth: 720, boxSizing: 'border-box', display: 'flex',
            alignItems: 'center', gap: 14, height: 64, padding: '0 10px 0 20px',
            borderRadius: 18, background: 'var(--surface-1)',
            border: '1px solid var(--prompt-border)', boxShadow: 'var(--prompt-sh)',
          }}
        >
          <Mark size={22} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              /*
                中文输入法在选词时也会发 Enter。isComposing / keyCode 229 是
                那一下的标志——不挡的话，选个词就把半句话提交出去了。
              */
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              if (draft.trim()) onPrompt(draft.trim());
            }}
            placeholder="说一句你想做的页面，比如「组里的值班排班表」"
            style={{
              flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent',
              fontSize: 15, color: 'var(--text-primary)', fontFamily: 'inherit',
            }}
          />
          <button
            onClick={() => { if (draft.trim()) onPrompt(draft.trim()); }}
            title="开始做"
            style={{
              width: 44, height: 44, flex: 'none', border: 0, borderRadius: 12,
              background: draft.trim() ? 'var(--cta)' : 'var(--surface-2)',
              color: draft.trim() ? 'var(--cta-fg)' : 'var(--text-tertiary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="upRight" size={18} />
          </button>
        </div>
      </div>

      {/* 分类。搜索时整排置灰不可点——搜索结果是跨分类的，这时高亮任何一颗都是假的 */}
      <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 4, padding: '32px 0 36px' }}>
        {EXPLORE_CATEGORIES.map((c) => {
          const on = !kw && cat === c;
          return (
            <button
              key={c}
              onClick={() => { setCat(c); if (kw) onClearQ(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 16px',
                border: 0, borderRadius: 'var(--radius-pill)',
                background: on ? 'var(--sel)' : 'transparent',
                color: on ? 'var(--sel-fg)' : 'var(--text-secondary)',
                fontSize: 'var(--text-md)',
                fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                cursor: on ? 'default' : 'pointer', whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--seg-bg)'; }}
              onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}
            >
              {c}
              {/* 1024 那颗带一个点：活动期间它是会变的那一格 */}
              {c === '1024 作品' && !on && (
                <span style={{ width: 6, height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--tabby-orange)' }} />
              )}
            </button>
          );
        })}
      </div>

      {kw && (
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            margin: '-14px 0 30px', fontSize: 'var(--text-base)', color: 'var(--text-secondary)',
          }}
        >
          <span>搜索「{q}」</span>
          <button
            onClick={onClearQ}
            style={{
              height: 28, padding: '0 12px', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-pill)', background: 'var(--surface-1)',
              color: 'var(--text-primary)', fontSize: 'var(--text-base)',
              fontWeight: 'var(--weight-semibold)', cursor: 'pointer',
            }}
          >
            清除
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <div style={{ padding: '60px 0', textAlign: 'center', fontSize: 'var(--text-md)', color: 'var(--text-tertiary)' }}>
          {kw ? `没找到和「${q}」有关的作品。` : '这里还没有作品。'}
        </div>
      ) : (
        <Wall>
          {visible.map((r: RecItem) => r.kind === 'app' ? (
            <WallCard
              key={r.l.id}
              item={r.l}
              onOpen={() => onOpen(r.l)}
              onPlay={() => onPlay(r.l)}
              onRemix={r.l.source_prompt ? () => onRemix(r.l) : null}
              onAuthor={() => onAuthor(r.l.owner_username)}
            />
          ) : (
            <BackendWallCard
              key={r.b.id}
              item={r.b}
              onOpen={() => window.open(r.b.url_path, '_blank', 'noopener')}
              onAuthor={() => onAuthor(r.b.owner_username)}
            />
          ))}
        </Wall>
      )}

      {visible.length > 0 && (
        <div
          style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8,
            paddingTop: 28, fontSize: 'var(--text-base)', color: 'var(--text-tertiary)',
          }}
        >
          <span>
            {kw
              ? `找到 ${visible.length} 个和「${q}」有关的页面。`
              : cat === EXPLORE_ALL
                ? `就这些了，一共 ${visible.length} 个页面。`
                : `「${cat}」下就这些。`}
          </span>
          <a
            href="/create"
            style={{
              cursor: 'pointer', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)',
              textDecoration: 'underline', textUnderlineOffset: 3,
            }}
          >
            自己做一个
          </a>
        </div>
      )}
    </div>
  );
}

/** 「试玩」就是打开那个页面本身。新标签打开，别把人从墙上带走。 */
export function playInNewTab(l: Listing): void {
  window.open(appHref(l), '_blank', 'noopener');
}
