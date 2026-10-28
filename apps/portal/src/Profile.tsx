import { useEffect, useRef, useState } from 'react';
import type { User } from '@ispace/contracts';
import { Avatar, Button, Dialog, Input } from '@ispace/ui';
import { api } from './api';
import { squareAvatar } from './avatar';

/**
 * 个人资料。
 *
 * 做成弹层而不是 /settings 这样的页面：新开一个顶层路径要同步三处
 * （RESERVED_PATHS、Caddyfile、一致性测试），而门户本来就用弹层装这类
 * 小事（扫码登录、下载 App 都是）。
 *
 * 邮箱指路到控制台，因为那里确实有（AdminUsers 的「编辑」）。用户名没有，
 * 也不会有：它派生出数据库 schema、站点目录和所有对外链接，改名要把三样
 * 一起搬，不是一个按钮能干的事——所以那句话只说"联系管理员"，不指路。
 */
export function ProfileDialog({ user, onUser, onClose }: {
  user: User;
  onUser: (u: User) => void;
  onClose: () => void;
}) {
  const [feishu, setFeishu] = useState<{ enabled: boolean; bound: boolean } | null>(null);
  useEffect(() => { void api.feishuBinding().then(setFeishu).catch(() => setFeishu(null)); }, []);
  const [name, setName] = useState(user.displayName);
  /** 本地预览。选了图还没保存时顶掉服务端那张。 */
  const [preview, setPreview] = useState<string | null>(null);
  const [picked, setPicked] = useState<Blob | null>(null);
  /** 点了「移除头像」但还没保存。 */
  const [dropped, setDropped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* 预览用的 blob: URL 必须显式释放，否则每选一次图就漏一份 */
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const shown = dropped ? null : (preview ?? user.avatarUrl);
  const nameTrimmed = name.trim();
  const dirty = nameTrimmed !== user.displayName || !!picked || dropped;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    try {
      const blob = await squareAvatar(file);
      if (preview) URL.revokeObjectURL(preview);
      setPicked(blob);
      setPreview(URL.createObjectURL(blob));
      setDropped(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '这张图处理不了');
    }
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      let next = user;
      /*
        先图后名：三个请求里只有改名是一定成功的，先把容易失败的做掉，
        中途失败时至少状态是一致的（图没换成，名字也没改）。
      */
      if (picked) next = await api.uploadAvatar(picked);
      else if (dropped) next = (await api.removeAvatar()).user;
      if (nameTrimmed !== user.displayName) {
        next = (await api.updateProfile(nameTrimmed)).user;
      }
      onUser(next);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="个人资料"
      description="改完点保存。头像和显示名会出现在你分享给同事的地方。"
      onClose={onClose}
      width={420}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-8)' }}>
          <Avatar name={nameTrimmed || user.displayName} size={96} src={shown} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
              <Button size="sm" onClick={() => fileRef.current?.click()}>
                {shown ? '换一张' : '上传头像'}
              </Button>
              {shown && (
                <Button
                  size="sm"
                  onClick={() => {
                    if (preview) URL.revokeObjectURL(preview);
                    setPreview(null); setPicked(null); setDropped(true);
                  }}
                >
                  移除
                </Button>
              )}
            </div>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              PNG / JPG / WebP，会自动居中裁成方形
            </span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              /* 清空 value：不清的话"选同一个文件"不会再触发 change */
              e.target.value = '';
            }}
          />
        </div>

        <Row label="显示名">
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </Row>

        {/*
          用户名和邮箱摆出来但不给改，并说清去哪儿改——只是藏起来的话，
          想改的人会先在这儿翻一遍，再去问别人「在哪改」。
        */}
        <Row label="用户名">
          <Input value={user.username} disabled />
          <p style={{ margin: '4px 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            你的地址是 <span className="mono">{location.host}/{user.username}/</span>，
            改名会让已经发出去的链接全部失效，连数据库里你那片空间一起搬，
            所以平台不支持改——确实要换，联系管理员新开一个账号迁过去。
          </p>
        </Row>
        <Row label="邮箱">
          <Input value={user.email ?? '未设置'} disabled />
          <p style={{ margin: '4px 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            登录和找回密码认这个地址。要改找管理员，在控制台「员工与开通」里点你那行的「编辑」。
          </p>
        </Row>

        {feishu?.enabled && (
          <Row label="飞书登录">
            {feishu.bound ? <span>已绑定公司飞书</span> : (
              <a href={`/deploy/api/auth/login?bind=1&redirect=${encodeURIComponent(location.pathname)}`}>
                绑定公司飞书，保留当前空间和项目
              </a>
            )}
          </Row>
        )}

        {err && (
          <p style={{ margin: 0, color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{err}</p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-4)' }}>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button
            variant="primary"
            disabled={busy || !dirty || !nameTrimmed}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** 标签 + 控件。与 App.tsx 里登录表单那个同形，这里不跨文件共用一个九行组件。 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 'var(--space-8)' }}>
      <span style={{
        display: 'block', fontSize: 'var(--text-sm)',
        color: 'var(--text-secondary)', marginBottom: 4,
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}
