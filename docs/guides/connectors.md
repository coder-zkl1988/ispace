# 连接器

页面调用外部 API 的统一入口。

## 为什么有它

平台的发布链路会扫描产物，命中硬编码密钥就阻断（`packages/scanner`）。这是对的：
AI 生成的代码里带着公司的 API key 发到公司域名下，是实打实的事故。

但只拦不给路的后果是——**凡是需要凭据的接口，整类做不了**。用户唯一的出路是
开一个后端应用自己写转发，而那要占配额、要写服务端代码，正好把这个平台想服务的
非技术用户挡在门外。

连接器把凭据挪到服务端。用户登记一次「这个 API 在哪、凭据是什么」，页面此后只调
相对路径，凭据由服务端注入。顺带解决跨域：对页面来说这是同源请求，而国内很多
公开接口根本不发 CORS 头。

## 用起来

### 页面里

```js
// 不需要任何 key，也不需要处理跨域
const r = await fetch('/deploy/api/connect/open-meteo/forecast'
                    + '?latitude=39.9&longitude=116.4&current=temperature_2m');
const data = await r.json();
```

路径规则：`/deploy/api/connect/{slug}/{上游路径}`，查询串原样带过去。

### 登记

三条路，效果一样：

1. **控制台 →「连接器」** —— 目录里挑一个点「登记」，需要 key 的填一次 key
2. **让 AI 做** —— 它会先 `list-connectors` 看有没有现成的，再 `create-connector`
3. **REST** —— `POST /deploy/api/connectors`

### 归属两级

| | 谁能登记 | 谁能调用 | 用在哪 |
|---|---|---|---|
| 个人 | 任何人 | 只有本人 | 自己用的页面、自己申请的 key |
| 全员共享 | 管理员 | 所有人（看不到凭据） | 公司统一采购的 key、内部系统 |

⚠️ **个人连接器只在作者自己打开页面时有效。** 同事打开一个用了个人连接器的
分享页面会收到一条说明这件事的报错，而不是一个费解的 404。要给同事用的页面，
请管理员发布共享连接器。

（为什么不按页面所有者解析：那要先回答「这次请求是从谁的哪个页面发起的」，
Referer 可伪造，把 owner 写进路径同样可伪造，真做对需要给每个页面签发作用域令牌。
那是另一件事，现在这条规矩至少简单且能讲清楚。）

## 维护内置目录

目录在 `packages/contracts/src/connectors.ts` 的 `CONNECTOR_CATALOG`。

**加条目之前必须在目标部署环境实测**。国内网络下大量境外 API 不可达，
抄一份网上的「公开 API 大全」进来，用户点开发现一半是死的，比没有目录更糟。

```bash
TARGET_HOST=deploy@ispace.example.com ./infra/scripts/remote.sh "bash -s" <<'EOF'
for u in "https://api.example.com/v1/ping" ; do
  printf '%-6s %s\n' "$(curl -sS -m 12 -o /dev/null -w '%{http_code}' -A 'iSpace/1.0' "$u")" "$u"
done
EOF
```

`200` 或「凭据无效」级别的 `4xx` 都算通；`000`/超时表示这台机器到不了它，别放进目录。

换部署环境（换机房、换出口）后应重新跑一遍——目录的价值全在「点开就能用」。

## 安全边界

出站代理带着平台的身份，能访问平台能访问的一切。不加限制它就是一台内网扫描器：
任何登录用户都能登记一个指向 `http://127.0.0.1:3000` 的连接器去打 Dokploy 控制台，
或者打 `169.254.169.254` 拿云厂商的实例凭据。

`apps/deploy-service/src/services/outbound-guard.ts` 四道防线：

1. **只允许 http/https** —— 挡掉 `file://`、`gopher://`
2. **解析后判地址** —— 拒绝私有段、回环、链路本地、CGNAT、组播，含 IPv6 与
   `::ffff:127.0.0.1` 这类 IPv4 映射写法。多地址主机只要有一个落在内网就整体拒绝
3. **判定在 socket 层的 lookup 钩子里** —— 见下
4. **不跟随重定向** —— 否则一个合法公网主机 302 到 127.0.0.1 就绕过前三道

另外：目标路径必须留在 `base_url` 前缀之内（登记 `/v3` 的人打不到同主机的 `/admin`），
`..` 在拼接前就被拒绝，请求头走白名单而非黑名单，上游的 `Set-Cookie` 与 CORS 头
不回吐给页面。

### 为什么判定必须在 lookup 钩子里

「请求前查一次 DNS，通过了再发请求」看着够用，实则留着一个 TOCTOU 窗口：
校验用的那次解析和 HTTP 客户端自己发起的那次是**两次独立查询**。控制着权威 DNS
的人可以让第一次返回公网地址、第二次返回 `127.0.0.1`。这就是 DNS 重绑定，
它专门吃这种"先检查后使用"的写法。

所以判定挪进了 `net.connect` 的 `lookup` 钩子（`guardedLookup`）：钩子返回哪个
地址，内核就连哪个地址，中间没有第二次解析。**判过的地址就是连过去的那一个**，
窗口不是被缩小了，是不存在了。

代价是不能用 `fetch`——它不给传 `lookup`。改用 `node:http`/`node:https` 自己发
（`guardedRequest`），顺带补上了 8 MB 的响应体上限：`fetch` 那版会老老实实把
几个 G 缓进内存。

登记时的 `assertOutboundAllowed` 保留着，但它只负责**填表当场给人一句人话**，
安全上说了算的是钩子。验证方式：绕过登记、直接往 `ispace.connectors` 塞一条指向
`localhost` 的记录，调用时仍会在连接那一刻被拦下并记一条 `result=blocked` 的审计。

### 内网目标

`ISPACE_CONNECTOR_ALLOW_PRIVATE=1` 放行内网。公司 ERP 长在 192.168 段里是常态，
所以这个口子有真实需求；但它一旦打开，上面整段描述的攻击全部成立。默认关闭，
只能由管理员在服务器上显式开，开之前先清楚这台机器所在网段里还有什么。

### 凭据

AES-256-GCM 加密入库，密钥来自 `ISPACE_CONNECTOR_KEY`（`~/.ispace/env`，600）：

```bash
printf 'ISPACE_CONNECTOR_KEY=%s\n' "$(openssl rand -hex 32)" >> ~/.ispace/env
```

没配置时**拒绝登记带凭据的连接器**，不回落明文——那种错误功能上完全正常，
只有库里躺着一堆裸密钥，没人会发现。免密钥的连接器不受影响。

**凭据永不回传**，包括登记者本人。能读回来的保管等于没保管；忘了填什么只能重填，
这个代价换的是一次越权读取不会把所有人的第三方 key 整批带走。

换密钥会让已存的凭据全部解不开，只能让用户重填。

## 审计

`connector.create` / `connector.delete` / 被拦下的 `connector.call` 都进审计日志，
记地址不记凭据——出了事要能回答「谁开了一条通往哪里的口子」。

管理员在 `GET /deploy/api/admin/connectors` 看全量，按调用次数排序。
