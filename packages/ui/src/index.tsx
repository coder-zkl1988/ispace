import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { t, type CopyKey, type Tone } from '@ispace/copy';

/**
 * Tabby 设计系统的 React 实现。
 *
 * 组件集取自设计稿 _ds_manifest 的 core 组件：
 * Avatar / Badge / Button / Card / Dialog / Input / NavItem /
 * StatusDot / Switch / Tabs。
 *
 * 唯一没实现的是 IconButton：它虽在组件库里，但设计稿那 27 屏一次都没用到，
 * 注入的样式表里也查不到 .tby-iconbtn 的任何规则——照着实现等于自己编一套
 * 视觉。等真有图标按钮的需求，再回设计稿取值。
 *
 * 用内联 style 而非 CSS-in-JS 或 Tailwind：组件数量少、样式基本静态，
 * 内联能让每个组件自包含（读一个文件就能看懂它长什么样），也避免了
 * 类名与 token 之间再加一层间接。token 统一走 CSS 变量，主题可整体替换。
 */

// ── 口径上下文 ────────────────────────────────────────────────────────
const ToneCtx = createContext<Tone>('business');

export function ToneProvider({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <ToneCtx.Provider value={tone}>{children}</ToneCtx.Provider>;
}

/** 组件内不得内联中文字面量，一律经此取（规格 D9）。 */
export function useCopy(): (key: CopyKey) => string {
  const tone = useContext(ToneCtx);
  return useMemo(() => (key: CopyKey) => t(key, tone), [tone]);
}

export function useTone(): Tone {
  return useContext(ToneCtx);
}

// ── Button ────────────────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  children,
  style,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const palette: Record<ButtonVariant, CSSProperties> = {
    primary:   { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--accent)' },
    secondary: { background: 'var(--surface-1)', color: 'var(--text-primary)', borderColor: 'var(--border)' },
    ghost:     { background: 'transparent', color: 'var(--text-secondary)', borderColor: 'transparent' },
    danger:    { background: 'var(--surface-1)', color: 'var(--danger)', borderColor: 'var(--border)' },
  };
  return (
    <button
      {...rest}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-3)',
        height: size === 'sm' ? 'var(--control-height-sm)' : 'var(--control-height)',
        padding: `0 ${size === 'sm' ? 'var(--space-6)' : 'var(--space-8)'}`,
        border: '1px solid', borderRadius: 'var(--radius-8)',
        font: `var(--weight-medium) var(--text-sm)/1 var(--font-sans)`,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        opacity: rest.disabled ? 0.5 : 1,
        transition: 'var(--transition-colors)',
        whiteSpace: 'nowrap',
        ...palette[variant],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ── Card ──────────────────────────────────────────────────────────────
/** 白色置于奶油底上，1px 发丝描边，16px 圆角——设计稿的标志性形态。 */
export function Card({
  children, style, onClick, hoverable,
}: { children: ReactNode; style?: CSSProperties; onClick?: () => void; hoverable?: boolean }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-16)',
        padding: 'var(--space-10)',
        boxShadow: 'var(--shadow-rest)',
        cursor: onClick ? 'pointer' : undefined,
        transition: 'box-shadow var(--duration-fast) ease, border-color var(--duration-fast) ease',
        ...(hoverable ? {} : {}),
        ...style,
      }}
      onMouseEnter={hoverable ? (e) => {
        e.currentTarget.style.boxShadow = 'var(--shadow-card)';
        e.currentTarget.style.borderColor = 'var(--border-hover)';
      } : undefined}
      onMouseLeave={hoverable ? (e) => {
        e.currentTarget.style.boxShadow = 'var(--shadow-rest)';
        e.currentTarget.style.borderColor = 'var(--border-subtle)';
      } : undefined}
    >
      {children}
    </div>
  );
}

// ── StatusDot ─────────────────────────────────────────────────────────
/** 6px 小圆点 + 文字。设计稿明确：状态绝不用大面积彩色横幅。 */
export function StatusDot({ status, label }: { status: 'running' | 'building' | 'stopped' | 'blocked'; label?: string }) {
  const color = {
    running: 'var(--success)',
    building: 'var(--warning)',
    stopped: 'var(--text-tertiary)',
    blocked: 'var(--danger)',
  }[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
      <span
        style={{
          width: 6, height: 6, borderRadius: '50%', background: color, flex: 'none',
          // 构建中用呼吸动画表达"进行中"，与设计稿的"平静的青色脉动"呼应
          animation: status === 'building' ? 'ispace-pulse 1.6s ease-in-out infinite' : undefined,
        }}
      />
      {label}
    </span>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────
export function Badge({
  children, tone = 'neutral', dot = false,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'brand';
  /**
   * 设计稿在表示**状态**的徽标上都带一个前置圆点（`dot="{{ true }}"`），
   * 表示**分类**的则不带。区别不是装饰：圆点在扫读一列时把"这是活的/停的"
   * 提前到文字之前，而分类没有活不活之说。
   */
  dot?: boolean;
}) {
  const map = {
    neutral: { bg: 'var(--surface-2)', fg: 'var(--text-secondary)' },
    success: { bg: 'var(--success-subtle)', fg: 'var(--success)' },
    warning: { bg: 'var(--warning-subtle)', fg: '#8a6d00' },
    danger:  { bg: 'var(--error-subtle)', fg: 'var(--error)' },
    brand:   { bg: 'var(--tabby-orange-subtle)', fg: 'var(--tabby-orange-hover)' },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: dot ? 'var(--space-4)' : 0,
      height: 20, padding: '0 var(--space-5)',
      background: map.bg, color: map.fg, borderRadius: 'var(--radius-pill)',
      fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)', whiteSpace: 'nowrap',
    }}>
      {dot && (
        <span aria-hidden="true" style={{
          width: 5, height: 5, borderRadius: '50%', background: 'currentColor', flex: 'none',
        }} />
      )}
      {children}
    </span>
  );
}

// ── Avatar ────────────────────────────────────────────────────────────
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      title={name}
      style={{
        width: size, height: size, borderRadius: '50%', flex: 'none',
        background: 'var(--tabby-orange-subtle)', color: 'var(--tabby-orange-hover)',
        display: 'grid', placeItems: 'center',
        fontSize: size < 26 ? 'var(--text-xs)' : 'var(--text-sm)',
        fontWeight: 'var(--weight-semibold)',
      }}
    >
      {name.slice(0, 1)}
    </span>
  );
}

/** 应用卡片左上角的单字图标底板。设计稿里每个应用都有。 */
export function AppIcon({ letter, size = 40 }: { letter: string; size?: number }) {
  // 尺寸/圆角/字号字重均取自设计稿实测：40×40、r12、16px/700
  return (
    <span style={{
      width: size, height: size, borderRadius: 'var(--radius-12)', flex: 'none',
      background: 'var(--tabby-orange-subtle)', color: 'var(--tabby-orange-hover)',
      display: 'grid', placeItems: 'center',
      fontSize: size >= 36 ? 'var(--text-lg)' : 'var(--text-base)',
      fontWeight: 'var(--weight-bold)',
    }}>
      {letter}
    </span>
  );
}

// ── AvatarMenu ────────────────────────────────────────────────────────
/**
 * 头像 + 下拉菜单。
 *
 * 头像原本是纯装饰，退出登录藏在控制台顶栏一个文字按钮里，门户则**根本没有
 * 退出入口**——换个人用同一台电脑就只能去清 cookie。头像是所有人下意识
 * 会点的地方，账户相关的动作就该挂在这里。
 *
 * 点外面关、Esc 关：菜单浮在页面之上，没有这两条就会挡住底下的内容而关不掉。
 */
export function AvatarMenu({
  name, subtitle, items, size = 28, placement = 'bottom', align = 'right', trigger,
}: {
  name: string;
  /** 头像下方的小字，通常是空间地址或角色。 */
  subtitle?: string;
  items: {
    label: string;
    onClick?: () => void;
    href?: string;
    /** 退出这类动作用红色，与"去某处"区分开。 */
    danger?: boolean;
  }[];
  size?: number;
  /**
   * 菜单往哪边弹。挂在侧栏底部时必须往上，否则整个菜单落在视口外——
   * 表现为"点了没反应"，而不是"菜单被挡住了"，很难联想到是方向问题。
   */
  placement?: 'bottom' | 'top';
  /**
   * 菜单靠哪边对齐。
   *
   * 默认靠右，适合顶栏右上角。**侧栏底部必须用 left**：侧栏只有 213px 宽
   * 且贴着屏幕左缘，靠右对齐会让比它宽的菜单整个往左溢出到视口外，
   * 只剩右边一条能看见——用户点到的是自己以为点中的那一项旁边那个。
   */
  align?: 'left' | 'right';
  /**
   * 自定义触发区。侧栏那块是「头像 + 姓名 + 角色」一整块，
   * 用户点的是整块而不是那个小圆圈——只让圆圈可点，点名字就没反应。
   */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={box} style={{ position: 'relative', flex: 'none' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name} 的账户菜单`}
        style={{
          border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 'var(--space-4)',
          borderRadius: 'var(--radius-pill)', width: trigger ? '100%' : undefined,
          textAlign: 'left', font: 'inherit', color: 'inherit',
        }}
      >
        {trigger ?? <Avatar name={name} size={size} />}
        {/* 小三角，明确"这里可以点开"——只有头像的话没人知道它是个菜单 */}
        <span aria-hidden="true" style={{
          width: 0, height: 0, marginRight: 2, flex: 'none',
          borderLeft: '3.5px solid transparent', borderRight: '3.5px solid transparent',
          borderTop: '4px solid var(--text-tertiary)',
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform var(--duration-fast) ease',
        }} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', zIndex: 40,
            ...(align === 'left' ? { left: 0 } : { right: 0 }),
            ...(placement === 'top'
              ? { bottom: 'calc(100% + 8px)' }
              : { top: 'calc(100% + 8px)' }),
            // 卡宽度自己撑开，但给个上限：副标题是完整空间地址，
            // 不封顶的话它能把菜单撑到比容器宽得多
            minWidth: 200, maxWidth: 280, padding: 'var(--space-4)',
            background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-12)', boxShadow: 'var(--shadow-dropdown)',
          }}
        >
          <div style={{
            padding: 'var(--space-5) var(--space-6)',
            borderBottom: '1px solid var(--border-subtle)', marginBottom: 'var(--space-4)',
          }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-medium)' }}>{name}</div>
            {subtitle && (
              <div className="mono" title={subtitle} style={{
                fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {subtitle}
              </div>
            )}
          </div>

          {items.map((it) => {
            const style: CSSProperties = {
              display: 'block', width: '100%', textAlign: 'left',
              padding: 'var(--space-5) var(--space-6)', border: 'none',
              background: 'transparent', cursor: 'pointer', borderRadius: 'var(--radius-8)',
              color: it.danger ? 'var(--error)' : 'var(--text-primary)',
              font: 'var(--weight-regular) var(--text-base)/1.4 var(--font-sans)',
              textDecoration: 'none',
            };
            const hover = (on: boolean) => (e: { currentTarget: HTMLElement }) => {
              e.currentTarget.style.background = on ? 'var(--surface-2)' : 'transparent';
            };
            return it.href ? (
              <a key={it.label} role="menuitem" href={it.href} style={style}
                 onMouseEnter={hover(true)} onMouseLeave={hover(false)}>
                {it.label}
              </a>
            ) : (
              <button key={it.label} role="menuitem" style={style}
                      onMouseEnter={hover(true)} onMouseLeave={hover(false)}
                      onClick={() => { setOpen(false); it.onClick?.(); }}>
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Input ─────────────────────────────────────────────────────────────
export function Input({ style, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      style={{
        height: 'var(--control-height)', padding: '0 var(--space-8)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-8)',
        background: 'var(--surface-1)', color: 'var(--text-primary)',
        font: 'var(--weight-regular) var(--text-base)/1 var(--font-sans)',
        outline: 'none', width: '100%',
        ...style,
      }}
      onFocus={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-focus)'; rest.onFocus?.(e); }}
      onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; rest.onBlur?.(e); }}
    />
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────
export function Tabs<T extends string>({
  items, value, onChange,
}: { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div style={{
      display: 'inline-flex', gap: 'var(--space-1)', padding: 'var(--space-1)',
      background: 'var(--surface-2)', borderRadius: 'var(--radius-10)',
    }}>
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            onClick={() => onChange(it.value)}
            style={{
              height: 28, padding: '0 var(--space-8)', border: 'none', cursor: 'pointer',
              borderRadius: 'var(--radius-8)',
              background: active ? 'var(--surface-1)' : 'transparent',
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              boxShadow: active ? 'var(--shadow-rest)' : 'none',
              font: `${active ? 'var(--weight-semibold)' : 'var(--weight-regular)'} var(--text-sm)/1 var(--font-sans)`,
              transition: 'var(--transition-colors)',
              whiteSpace: 'nowrap',
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Select ────────────────────────────────────────────────────────────
/**
 * 下拉选择。
 *
 * 设计系统里没有这个组件——设计稿的筛选一律用 Tabs。但 Tabs 有两条硬伤：
 * 选项一多就占满一行，标签一长（「静态页 + 后端」）就撑得很宽。
 * 主筛选轴用 Tabs（选项都摆在眼前、带计数、一次点击），次要筛选用这个。
 *
 * 视觉沿用 Input 的边框与圆角，只是换了个原生 select——
 * 自绘下拉要自己处理键盘、滚动、移动端弹层，为了一个筛选器不值得。
 * 右侧的箭头用 background-image 画，原生箭头各浏览器长得不一样。
 */
export function Select<T extends string>({
  value, onChange, items, style, ...rest
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string }[];
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  const arrow =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' "
    + "viewBox='0 0 24 24' fill='none' stroke='%23545659' stroke-width='2' stroke-linecap='round' "
    + "stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";
  return (
    <select
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      style={{
        height: 'var(--control-height)', padding: '0 30px 0 var(--space-8)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-8)',
        background: `var(--surface-1) ${arrow} no-repeat right 10px center`,
        color: 'var(--text-primary)',
        font: 'var(--weight-regular) var(--text-base)/1 var(--font-sans)',
        outline: 'none', cursor: 'pointer',
        appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
        ...style,
      }}
      onFocus={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-focus)'; rest.onFocus?.(e); }}
      onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; rest.onBlur?.(e); }}
    >
      {items.map((it) => (
        <option key={it.value} value={it.value}>{it.label}</option>
      ))}
    </select>
  );
}

// ── NavItem ───────────────────────────────────────────────────────────
export function NavItem({
  label, active, onClick, icon,
}: { label: string; active?: boolean; onClick?: () => void; icon?: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-5)', width: '100%',
        height: 'var(--nav-item-height)', padding: '0 var(--space-6)',
        border: 'none', borderRadius: 'var(--radius-6)', cursor: 'pointer', textAlign: 'left',
        background: active ? 'var(--surface-sidebar-active)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        // 选中态字重 600（设计稿实测），不是 500——500 在 13px 下几乎看不出区别
        font: `${active ? 'var(--weight-semibold)' : 'var(--weight-regular)'} var(--text-base)/1 var(--font-sans)`,
        transition: 'var(--transition-colors)',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-sidebar-hover)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Switch（macOS 风格）────────────────────────────────────────────────
export function Switch({
  checked, onChange, disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** 依赖别的开关时用得到，比如「需审批」依赖「允许自助注册」。 */
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 40, height: 24, borderRadius: 'var(--radius-pill)', border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        background: checked ? '#007aff' : 'var(--surface-3)',
        position: 'relative', transition: 'background var(--duration-fast) ease', flex: 'none',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 20, height: 20, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,.2)',
        transition: 'left var(--duration-fast) var(--ease-standard)',
      }} />
    </button>
  );
}

// ── 版式辅助 ──────────────────────────────────────────────────────────
/** 区块小标签：10–11px 全大写加字距。设计稿里 CONVERSATIONS / CHANNELS 那种。 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      // 10px 是设计稿实测值（CONVERSATIONS / CHANNELS 那种区块小标签）
      fontSize: 'var(--text-2xs)', fontWeight: 'var(--weight-semibold)',
      letterSpacing: 'var(--tracking-label)', color: 'var(--text-tertiary)',
      textTransform: 'uppercase', marginBottom: 'var(--space-6)',
    }}>
      {children}
    </div>
  );
}

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 'var(--space-12)' }}>
      <h1 style={{
        margin: 0, font: 'var(--weight-bold) var(--text-2xl)/var(--leading-tight) var(--font-sans)',
        color: 'var(--text-heading)',
      }}>{title}</h1>
      {subtitle && (
        <p style={{ margin: 'var(--space-3) 0 0', color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

/** 手写体问候。设计稿称之为"品牌唯一放飞的地方，其余一律克制"。 */
export function Greeting({ children }: { children: ReactNode }) {
  return (
    <div style={{
      font: 'var(--weight-regular) var(--text-3xl)/var(--leading-tight) var(--font-script)',
      color: 'var(--text-primary)',
    }}>
      {children}
    </div>
  );
}

/** 统计数字卡。数字走等宽，保证列对齐。 */
export function StatCard({ label, value, unit, delta }: { label: string; value: string; unit?: string; delta?: string }) {
  return (
    <Card style={{ padding: 'var(--space-10) var(--space-12)' }}>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-4)' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
        <span className="num" style={{ fontSize: 'var(--text-2xl)', fontWeight: 'var(--weight-bold)', color: 'var(--text-heading)' }}>
          {value}
        </span>
        {unit && <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{unit}</span>}
        {delta && <span className="num" style={{ fontSize: 'var(--text-sm)', color: 'var(--success)' }}>{delta}</span>}
      </div>
    </Card>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────
/**
 * 浮层提示。
 *
 * 存在的理由很具体：管理端好几处把操作结果写进一个渲染在页面**上方**的
 * `<p>{msg}</p>`，而按钮在下面的表格里。点「取消管理员」被服务端以
 * 「不能改自己的角色」拒掉时，那句话出现在你早已滚过去的地方——
 * 用户看到的是"点了没反应"，然后合理地怀疑功能坏了。
 *
 * 所以提示必须 fixed 定位、与滚动位置无关。
 *
 * 报错停留久一些且要手动关：成功了扫一眼就够，失败了得读完那句话
 * 才知道下一步该怎么办。
 */
export function Toast({
  message, tone = 'info', onClose,
}: {
  message: string;
  tone?: 'info' | 'error';
  onClose: () => void;
}) {
  useEffect(() => {
    if (tone === 'error') return;          // 报错不自动消失
    const t = setTimeout(onClose, 3200);
    return () => clearTimeout(t);
  }, [message, tone, onClose]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)',
        zIndex: 80, maxWidth: 'min(560px, calc(100vw - 32px))',
        display: 'flex', alignItems: 'flex-start', gap: 'var(--space-6)',
        padding: 'var(--space-6) var(--space-8)', borderRadius: 'var(--radius-12)',
        boxShadow: 'var(--shadow-dropdown)',
        background: tone === 'error' ? 'var(--error-subtle)' : 'var(--accent)',
        color: tone === 'error' ? 'var(--error)' : 'var(--accent-fg)',
        border: tone === 'error' ? '1px solid var(--error)' : 'none',
        font: 'var(--weight-regular) var(--text-base)/1.6 var(--font-sans)',
      }}
    >
      <span>{message}</span>
      <button
        onClick={onClose}
        aria-label="关闭提示"
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
          color: 'currentColor', opacity: 0.7, lineHeight: 1.6, flex: 'none',
          font: 'inherit',
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ── Dialog ────────────────────────────────────────────────────────────
/**
 * 模态对话框。尺寸、间距、投影、动画均按设计系统 .tby-dialog 的实测值。
 *
 * 点遮罩关闭、Esc 关闭、打开时锁滚动、焦点落到对话框内——这几条是模态的
 * 基本盘，缺一条键盘用户就会被困在背景页面里。
 */
export function Dialog({
  open, title, description, onClose, footer, children, width = 440,
}: {
  open: boolean;
  title?: string;
  description?: string;
  onClose?: () => void;
  footer?: ReactNode;
  children?: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-16)',
        background: 'rgba(4, 32, 40, 0.32)', backdropFilter: 'blur(2px)',
        animation: 'ispace-dialog-fade .18s ease',
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative', width: '100%', maxWidth: width,
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-16)',
          boxShadow: 'var(--shadow-elevated)',
          animation: 'ispace-dialog-scale .25s var(--ease-out-expo)',
          overflow: 'hidden', outline: 'none',
        }}
      >
        {(title || onClose) && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-6)', padding: 'var(--space-12) var(--space-12) 0' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && (
                <h2 style={{
                  font: 'var(--weight-bold) var(--text-lg)/1.3 var(--font-sans)',
                  color: 'var(--text-heading)', margin: 0,
                }}>{title}</h2>
              )}
              {description && (
                <p style={{
                  fontSize: 'var(--text-base)', color: 'var(--text-secondary)',
                  lineHeight: 'var(--leading-normal)', margin: '4px 0 0',
                }}>{description}</p>
              )}
            </div>
            {onClose && (
              <button
                type="button"
                aria-label="关闭"
                onClick={onClose}
                style={{
                  flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, border: 'none', background: 'transparent',
                  borderRadius: 'var(--radius-6)', color: 'var(--text-tertiary)',
                  cursor: 'pointer', transition: 'var(--transition-colors)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--surface-2)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--text-tertiary)';
                }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}
        {children != null && <div style={{ padding: 'var(--space-8) var(--space-12) var(--space-12)' }}>{children}</div>}
        {footer && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-5)', padding: '0 var(--space-12) var(--space-12)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 确认对话框。破坏性操作一律走这里，不用浏览器原生 confirm()——
 * 原生弹窗没法说明后果，而"删掉会怎样"恰恰是用户点确认前唯一想知道的事。
 */
export function ConfirmDialog({
  open, title, description, confirmLabel = '确认', danger, onConfirm, onCancel, busy,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>取消</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </>
      }
    />
  );
}

export interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
}

/**
 * 把确认对话框包成一个 await 得到布尔值的调用，形状与原生 confirm() 一样，
 * 于是调用点仍是一行 `if (await ask({...}))`，不必在每屏手写一套弹窗 state。
 *
 * 用法：
 *   const [confirmUI, ask] = useConfirm();
 *   ... if (await ask({ title, description, danger: true })) doIt();
 *   ... 渲染树里放一次 {confirmUI}
 */
export function useConfirm(): [ReactNode, (req: ConfirmRequest) => Promise<boolean>] {
  const [pending, setPending] = useState<
    { req: ConfirmRequest; resolve: (v: boolean) => void } | null
  >(null);

  const ask = useCallback(
    (req: ConfirmRequest) =>
      new Promise<boolean>((resolve) => setPending({ req, resolve })),
    [],
  );

  const settle = (value: boolean) => {
    // 先清 state 再 resolve：resolve 会同步触发调用方的后续渲染，
    // 顺序反了的话对话框会在那次渲染里残留一帧。
    setPending(null);
    pending?.resolve(value);
  };

  const node = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.req.title ?? ''}
      description={pending?.req.description ?? ''}
      confirmLabel={pending?.req.confirmLabel}
      danger={pending?.req.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return [node, ask];
}

/** 全局关键帧。挂一次即可，放在应用根部。 */
export function GlobalKeyframes() {
  return (
    <style>{`
      @keyframes ispace-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
      @keyframes ispace-dialog-fade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes ispace-dialog-scale {
        from { opacity: 0; transform: scale(.96) translateY(6px) }
        to   { opacity: 1; transform: none }
      }
    `}</style>
  );
}

export const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB`
  : `${(n / 1048576).toFixed(1)} MB`;

export const fmtDate = (d: string | Date): string => {
  const s = typeof d === 'string' ? d : d.toISOString();
  return s.slice(0, 16).replace('T', ' ');
};
export * from './icons.js';
export * from './share.js';
export * from './clipboard.js';
