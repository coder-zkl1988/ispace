# 接入公司 SSO（可选）

平台现在的登录方式是**邮箱 + 密码**（见 `apps/deploy-service/src/routes/account.ts`），
SSO 是可选的第二条路。不接也能正常用——这份文档只在你确实要接公司 IdP 时才需要。

> **2026-08-04 变更**：开发登录页（`/deploy/api/auth/mock`）此前在「没配 OIDC」时
> 自动启用，也就是说它在生产上一直开着，任何能打开那个地址的人都能选任意身份
> （包括管理员）进来。当时的假设是「上线前一定会接真 SSO，接上就自动关」，
> 但平台改用邮箱密码之后，OIDC 很可能永远不会被配置，那个后门也就永远不会关。
>
> 现在改为**必须显式开启**：`ISPACE_DEV_LOGIN=1`。生产环境不要设它。

---

## 现在怎么登

（历史行为，现已关闭）点「使用公司账号登录」会跳到一个开发登录页，上面列着库里的账号，
点任意一个即以该身份登入。

这不是 bug，是 `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`
三个变量都没配时的回落行为（`packages/auth/src/provider.ts` 的
`createAuthProvider`）。

**它的安全性等于零**：任何能打开这个地址的人都可以选任意身份进来，
包括管理员。内网试用阶段可以，对外开放前必须换掉。
管理员控制台的「平台巡检」屏会一直显示这一条，直到配上为止。

---

## 接真 SSO 需要什么

向 IT / 身份平台的同事要三样东西：

| 要什么 | 说明 | 例子 |
|---|---|---|
| Issuer 地址 | OIDC 发现文档的根，平台会去读 `{issuer}/.well-known/openid-configuration` | `https://sso.example.com` |
| Client ID | 给这个应用分配的客户端标识 | `ispace-workspace` |
| Client Secret | 对应的密钥 | （不要贴进任何文档或聊天） |

同时告诉对方**回调地址**，要登记进白名单：

```
$ISPACE_BASE_URL/deploy/api/auth/callback
```

这里要填**展开后的完整地址**，且必须与 `ISPACE_PUBLIC_BASE` 逐字符一致
（含协议）。日后换域名或从 http 切到 https，IdP 白名单与该环境变量两处
都要同步——只改一边的表现是回调时 `redirect_uri_mismatch`。

### 对 scope 与 claims 的要求

平台从 ID Token 里取这几项（`packages/auth/src/provider.ts` 的
`identityClaimsSchema`）：

- `sub` — 稳定的用户唯一标识，**必须**
- `preferred_username` — 用来推导空间路径（`/lixiao/`），**强烈建议**
- `name` — 显示名
- `email` — 可选

`preferred_username` 若缺失，平台会退而用 `sub` 推导路径；`sub` 通常是
一串 UUID，那会让员工的空间地址变成 `/8f3a2b1c.../`，长期对外且很难改回来。
所以请对方务必在 scope 里带上 `profile`，并确认 `preferred_username`
返回的是工号或英文名这类可读标识。

---

## 拿到之后怎么配

凭据不进仓库——写到目标机的 `~/.ispace/auth.env`，600 权限：

```bash
ssh "$TARGET_HOST" 'umask 077; cat > ~/.ispace/auth.env' <<'EOF'
OIDC_ISSUER=https://sso.example.com
OIDC_CLIENT_ID=ispace-workspace
OIDC_CLIENT_SECRET=从 IT 拿到的密钥
OIDC_SCOPE=openid profile email
EOF
```

然后重新部署（脚本会自动加载这个文件）：

```bash
bash infra/scripts/06-deploy-service.sh
```

配上之后走真实 IdP；`/deploy/api/auth/mock` 只有在显式设了 `ISPACE_DEV_LOGIN=1`
时才存在，否则一律 404——
不需要另外做开关。

---

## 已有账号怎么衔接

平台在 SSO 首次登录时会按这个顺序找人：

1. 按 `sub` 找已绑定的账号
2. 找不到，就按 `preferred_username` 找**预开通**的账号
   （即 `sso_subject` 仍是 `manual|` 前缀、从没登录过的），找到就把真实
   `sub` 绑上去
3. 还找不到，按 `preferred_username` 自动开通一个新账号

第 2 条意味着：管理员可以先在「员工与开通」把人建好、把空间路径定下来，
员工第一次用公司账号登录时自动认领。**已绑定过的账号不会被二次改写**——
否则同名冲突就成了账号劫持。

---

## 换 SSO 会不会把人踢下线

会。会话是 12 小时的 JWT，换 provider 不影响已签发的令牌，但那些令牌对应的
`sub` 是 mock 生成的；下次登录会走新 provider，按上面第 2 条重新绑定。

若想立即失效所有会话，删掉 `~/.ispace/session.env` 再部署一次即可
（`SESSION_SECRET` 会重新生成，旧令牌全部验不过）。
