import { useEffect, useState } from 'react';
import {
  Avatar, AvatarMenu, Button, GlobalKeyframes, Icon, NavItem, SectionLabel, Tabs,
  ToneProvider, useCopy, type IconName,
} from '@ispace/ui';
import type { Tone } from '@ispace/copy';
import { api, type Me } from './api';
import { SpaceOverview } from './screens/SpaceOverview';
import { MyPages } from './screens/MyPages';
import { Backends } from './screens/Backends';
import { DataSpace } from './screens/DataSpace';
import { MobileChannel } from './screens/MobileChannel';
import { QuotaScreen } from './screens/Quota';
import { AuditScreen } from './screens/Audit';
import { Guide } from './screens/Guide';
import { AdminOverviewScreen } from './screens/AdminOverview';
import { AdminUsers } from './screens/AdminUsers';
import { AdminTokens } from './screens/AdminTokens';
import { AdminSettings } from './screens/AdminSettings';
import { AdminResources } from './screens/AdminResources';
import { AdminAudit } from './screens/AdminAudit';
import { AdminInspection } from './screens/AdminInspection';

/**
 * 控制台（设计稿：员工 8 屏 + 管理员 5 屏）。
 *
 * 员工与管理员共用同一个入口 /console，由角色决定渲染哪套导航——
 * 设计稿的「员工视角 / 管理员」开关。非管理员看不到该开关。
 *
 * 路由用 hash 而非 History API：控制台是挂在 /console 下的 SPA，
 * hash 路由不需要服务端为每条子路径做兜底，也不会与平台的路径寻址
 * （/{user}/{app}/）产生歧义。
 */

/** 每屏配一个图标。图标名与 path 取自设计稿实测，见 packages/ui/src/icons.tsx。 */
type EmployeeScreen =
  | 'overview' | 'pages' | 'backends' | 'data'
  | 'mobile' | 'quota' | 'audit' | 'guide';
type AdminScreen =
  | 'a-overview' | 'a-users' | 'a-tokens'
  | 'a-resources' | 'a-settings' | 'a-audit' | 'a-inspection';
type Screen = EmployeeScreen | AdminScreen;

const EMPLOYEE_NAV: { group: string; items: { key: EmployeeScreen; label: string; icon: IconName }[] }[] = [
  {
    group: '我的空间',
    items: [
      { key: 'overview', label: '空间总览', icon: 'home' },
      { key: 'pages', label: '我的页面', icon: 'pages' },
      { key: 'backends', label: '后端应用', icon: 'backend' },
      { key: 'data', label: '数据空间', icon: 'data' },
    ],
  },
  { group: '手机应用', items: [{ key: 'mobile', label: '更新通道', icon: 'mobile' }] },
  {
    group: '治理',
    items: [
      { key: 'quota', label: '配额与用量', icon: 'sliders' },
      { key: 'audit', label: '发布记录', icon: 'book' },
      { key: 'guide', label: '接入指引', icon: 'compass' },
    ],
  },
];

const ADMIN_NAV: { group: string; items: { key: AdminScreen; label: string; icon: IconName }[] }[] = [
  {
    group: '平台',
    items: [
      { key: 'a-overview', label: '平台总览', icon: 'home' },
      { key: 'a-users', label: '员工与开通', icon: 'userPlus' },
      { key: 'a-tokens', label: '访问令牌', icon: 'key' },
    ],
  },
  {
    group: '治理',
    items: [
      { key: 'a-resources', label: '资源与配额', icon: 'sliders' },
      { key: 'a-settings', label: '平台设置', icon: 'settings' },
      { key: 'a-audit', label: '审计与安全', icon: 'book' },
      { key: 'a-inspection', label: '平台巡检', icon: 'zap' },
    ],
  },
];

/**
 * 文案系统（规格 D9 的双口径）保留，但不再给用户切换开关——
 * 同一个界面两套说法，对使用者是多余的选择。需要技术口径时
 * 改下面 ToneProvider 的常量即可整体切换。
 */
export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const [adminView, setAdminView] = useState(false);
  const [screen, setScreen] = useState<Screen>(
    (location.hash.slice(2) as Screen) || 'overview',
  );

  useEffect(() => {
    void api.me().then(setMe).catch(() => setMe(null)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    location.hash = `#/${screen}`;
  }, [screen]);

  if (loading) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)' }}>载入中…</div>;
  }
  if (!me) {
    location.replace(`/deploy/api/auth/login?redirect=${encodeURIComponent('/console')}`);
    return null;
  }

  const isAdmin = me.user.role === 'admin';
  const nav = adminView && isAdmin ? ADMIN_NAV : EMPLOYEE_NAV;

  return (
    <ToneProvider tone="business">
      <GlobalKeyframes />
      <div style={{ display: 'flex', minHeight: '100vh' }}>
        <Sidebar
          me={me}
          nav={nav}
          screen={screen}
          onScreen={(s) => setScreen(s as Screen)}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TopBar
            me={me}
            isAdmin={isAdmin}
            adminView={adminView}
            onAdminView={(v) => {
              setAdminView(v);
              setScreen(v ? 'a-overview' : 'overview');
            }}
          />
          {/*
            maxWidth 有了但一直没配 margin: 0 auto，宽屏上内容全靠在侧栏那侧，
            右边留一大片空。minWidth: 0 是给里面的横向滚动表格用的——
            flex 子项默认 min-width:auto，不归零的话表格会把整条主区撑宽，
            滚动条永远出不来（见各屏表格外层的 overflowX）。
          */}
          <main style={{
            flex: 1, minWidth: 0, margin: '0 auto',
            padding: 'var(--space-16) var(--space-16) var(--space-24)',
            maxWidth: 1180, width: '100%',
          }}>
            <Screens screen={screen} me={me} />
          </main>
        </div>
      </div>
    </ToneProvider>
  );
}

function Screens({ screen, me }: { screen: Screen; me: Me }) {
  switch (screen) {
    case 'overview':     return <SpaceOverview me={me} />;
    case 'pages':        return <MyPages me={me} />;
    case 'backends':     return <Backends me={me} />;
    case 'data':         return <DataSpace me={me} />;
    case 'mobile':       return <MobileChannel />;
    case 'quota':        return <QuotaScreen />;
    case 'audit':        return <AuditScreen />;
    case 'guide':        return <Guide me={me} />;
    case 'a-overview':   return <AdminOverviewScreen />;
    case 'a-users':      return <AdminUsers />;
    case 'a-tokens':     return <AdminTokens />;
    case 'a-resources':  return <AdminResources />;
    case 'a-settings':   return <AdminSettings />;
    case 'a-audit':      return <AdminAudit />;
    case 'a-inspection': return <AdminInspection />;
    default:             return <SpaceOverview me={me} />;
  }
}

/**
 * 退出登录。
 *
 * 无论服务端那一步成不成，都要离开当前页——
 * 原先写成 `api.logout().then(() => location.replace('/'))`，
 * 请求一失败 then 就不跑，页面纹丝不动，用户看到的就是"点了没反应"，
 * 而且控制台里连条错误都没有。会话 cookie 是 HttpOnly，前端清不掉，
 * 所以真失败时也得走到 / 让人看见自己还登着，而不是停在原地猜。
 */
function logout(): void {
  void api.logout()
    .catch(() => undefined)
    .finally(() => location.replace('/'));
}

function Sidebar({
  me, nav, screen, onScreen,
}: {
  me: Me;
  nav: { group: string; items: { key: string; label: string; icon: IconName }[] }[];
  screen: string;
  onScreen: (s: string) => void;
}) {
  const c = useCopy();
  return (
    <aside style={{
      width: 'var(--sidebar-width)', flex: 'none',
      background: 'var(--surface-sidebar)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column',
      padding: 'var(--space-8) var(--space-6)',
      position: 'sticky', top: 0, height: '100vh',
    }}>
      {/*
        产品标识回「我的空间」，而不是控制台自己的总览屏。控制台是干活的
        地方，标识是人下意识用来"回家"的东西——而家在 /{user}/，不在这里。
        总览屏本来就在导航第一条上，不必再占一个入口。
        用 a 而不是 button：这是真的离开控制台，键盘用户和"新标签页打开"
        都只认得真正的链接。
      */}
      <div style={{ padding: 'var(--space-4) var(--space-6) var(--space-12)' }}>
        <a
          href={`/${me.user.username}/`}
          aria-label="回到我的空间"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--space-5)',
            padding: 'var(--space-3) var(--space-4)',
            // 负外边距抵消掉 hover 底色所需的内边距，标识的视觉位置与原来一致
            margin: 'calc(var(--space-3) * -1) 0 calc(var(--space-3) * -1) calc(var(--space-4) * -1)',
            borderRadius: 'var(--radius-8)', textDecoration: 'none',
            color: 'inherit', cursor: 'pointer', textAlign: 'left',
            transition: 'var(--transition-colors)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-sidebar-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <img src="/favicon.svg" alt="" aria-hidden="true" style={{ width: 24, height: 24, flex: 'none', display: 'block' }} />
          <strong style={{ fontSize: 'var(--text-md)' }}>{c('app.name')}</strong>
        </a>
      </div>

      <nav style={{ flex: 1, overflowY: 'auto' }}>
        {nav.map((g) => (
          <div key={g.group} style={{ marginBottom: 'var(--space-8)' }}>
            <div style={{ padding: '0 var(--space-6)' }}>
              <SectionLabel>{g.group}</SectionLabel>
            </div>
            {g.items.map((it) => (
              <NavItem
                key={it.key}
                label={it.label}
                icon={<Icon name={it.icon} size={16} />}
                active={screen === it.key}
                onClick={() => onScreen(it.key)}
              />
            ))}
          </div>
        ))}
      </nav>

      {/*
        侧栏底部这块就是账户菜单。
        原先它只是「头像 + 姓名 + 角色」的纯展示，退出登录挂在右上角另一个
        小头像上——而带着名字和「平台管理员」的这一块才是人下意识会点的地方。
        点了没反应，看起来就是"退出登录坏了"。
      */}
      <div style={{
        padding: 'var(--space-8) var(--space-6) var(--space-4)',
        borderTop: '1px solid var(--border-subtle)',
      }}>
        <AvatarMenu
          name={me.user.displayName}
          subtitle={`${location.host}/${me.user.username}`}
          // 挂在侧栏底部：必须往上弹，且必须靠左对齐——
          // 侧栏只有 213px 宽又贴着屏幕左缘，靠右对齐会让菜单往左溢出到视口外
          placement="top"
          align="left"
          trigger={(
            <span style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-5)',
              flex: 1, minWidth: 0,
            }}>
              <Avatar name={me.user.displayName} />
              <span style={{ minWidth: 0, textAlign: 'left' }}>
                <span style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 'var(--weight-medium)' }}>
                  {me.user.displayName}
                </span>
                <span className="mono" style={{
                  display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {/* 管理员显示角色而非身份。设计稿这一行是"这个人是谁"，
                      对管理员来说「平台管理员」比「开发者」信息量大得多。 */}
                  {me.user.role === 'admin'
                    ? '平台管理员'
                    : me.user.identity === 'developer' ? '开发者' : '使用者'} · {me.user.username}
                </span>
              </span>
            </span>
          )}
          items={[
            { label: '我的空间', href: `/${me.user.username}/` },
            { label: '退出登录', danger: true, onClick: logout },
          ]}
        />
      </div>
    </aside>
  );
}

function TopBar({
  me, isAdmin, adminView, onAdminView,
}: {
  me: Me; isAdmin: boolean; adminView: boolean; onAdminView: (v: boolean) => void;
}) {
  const c = useCopy();
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-8)',
      height: 57, padding: '0 var(--space-16)', flex: 'none',
      borderBottom: '1px solid var(--border-subtle)',
      background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      position: 'sticky', top: 0, zIndex: 5,
    }}>
      <a href={`/${me.user.username}/`} style={{ textDecoration: 'none', color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
        <Icon name="arrowLeft" size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
        我的主页
      </a>
      <span className="mono" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
        {location.host}/{me.user.username}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
        平台运行中
      </span>

      <div style={{ flex: 1 }} />

      {/* 管理员才看得到视角切换。普通员工不该知道有这个开关。 */}
      {isAdmin && (
        <Tabs
          value={adminView ? 'admin' : 'employee'}
          onChange={(v) => onAdminView(v === 'admin')}
          items={[
            { value: 'employee' as const, label: '员工视角' },
            { value: 'admin' as const, label: '管理员' },
          ]}
        />
      )}

      <span style={{ display: 'none' }}>{c('nav.console')}</span>
    </header>
  );
}
