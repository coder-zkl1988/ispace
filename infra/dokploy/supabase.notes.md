# Supabase 部署实测记录

日期：2026-08-03　版本：官方 docker compose（master, md5 `036e2b464e41`）

本文档回答规格 §14 中两个「只能实做才能退掉」的风险，结论直接指导 `packages/db` 的 provisioning 实现。

---

## 一、Kong 子路径出口：可行

**结论：不需要改 Kong 任何配置，用 Traefik 的 stripPrefix 中间件即可。**

绑定方式（见 `supabase.compose.override.yml`）：

```
traefik.http.routers.ispace-supabase.rule=Host(`ispace.example.com`) && PathPrefix(`/supabase`)
traefik.http.routers.ispace-supabase.middlewares=ispace-supabase-strip
traefik.http.middlewares.ispace-supabase-strip.stripprefix.prefixes=/supabase
traefik.http.services.ispace-supabase.loadbalancer.server.port=8000
```

实测（均经正式域名 `ispace.example.com`）：

| 端点 | 结果 |
|---|---|
| `/supabase/auth/v1/health` | 200，返回 GoTrue 版本信息 |
| `/supabase/auth/v1/settings` | 200 |
| `/supabase/rest/v1/{table}` | 200，正常返回数据 |
| `/supabase/rest/v1/`（根） | 403 —— **设计如此，非故障** |

最后一行需要说明：`volumes/api/kong.yml` 里有两条 PostgREST 路由。`rest-v1-openapi` 精确匹配 `/rest/v1/`（OpenAPI 根），ACL 只允许 `admin` 组；真正的表查询走 `rest-v1` 的 `/rest/v1/*`。用 anon key 访问根路径返回 403 是预期行为，容器内直连 Kong 同样是 403，与子路径无关。**排查时不要把它当成 stripPrefix 失败。**

客户端配置：`supabase-js` 的 `url` 设为 `http://ispace.example.com/supabase`。

### 端口冲突

官方 compose 把 Kong 映射到宿主 `8000`（本机被 vLLM 占用）、db 映射 `5432`、supavisor 映射 `6543`。override 用 `!reset []` 全部清空——Traefik 经 `dokploy-network` 直连容器，无需任何宿主端口。

**不可用「改 `POSTGRES_PORT` 换个端口」来避让**：该变量同时用于容器间连接串（`PGRST_DB_URI: postgres://…@db:${POSTGRES_PORT}`），改了内部连接全断。只能清映射。

同理，覆盖 Kong 的 `networks:` 时必须显式保留 `default` 网络上的 `api-gw` 别名，Supabase 内部若干服务按此别名互访，覆盖时漏掉会静默断连。

---

## 二、PostgREST schema 热加载：可行，零重启

**结论：走库内配置 + 双通道 NOTIFY，不改环境变量、不重启容器。全程 `RestartCount: 0`。**

不能用 `PGRST_DB_SCHEMAS` 环境变量——改它要重启容器，会打断所有存量用户的连接。

### 开通流程（顺序不可调换）

```sql
-- 1. 先建 schema 与授权
CREATE SCHEMA IF NOT EXISTS u_alice;
GRANT USAGE ON SCHEMA u_alice TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA u_alice TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA u_alice
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- 2. 确认存在（这一步是保险，见下方风险说明）

-- 3. 追加进库内配置（保留既有值，不可覆盖）
ALTER ROLE authenticator SET pgrst.db_schemas = 'public,graphql_public,u_alice';

-- 4. 双通道热加载，缺一不可
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
```

**两个 NOTIFY 通道职责不同**：`reload config` 让 PostgREST 重读 `pgrst.*` 配置（决定暴露哪些 schema）；`reload schema` 让它重建 schema 缓存（决定认得哪些表）。只发前者，表查询返回 `PGRST205 "Could not find the table in the schema cache"`——实测复现过。

### 高危：顺序反了会打挂全站

若把尚不存在的 schema 名写进 `pgrst.db_schemas`，PostgREST 加载 schema 缓存时报 `3F000 schema does not exist`，随即进入「重连 → 重载 → 再失败」循环，此期间 `/rest/v1/*` 对**全部用户**返回 503。

**一个新用户开通失败会打挂所有存量用户的数据接口。** 已实测复现。因此 `packages/db` 的 provisioning 必须：建 schema → 校验存在 → 才改 `db_schemas`，且校验失败即中止。

### 回收流程（顺序与开通相反）

先从 `db_schemas` 移除并 `reload config`，再 `DROP SCHEMA`，最后 `reload schema`。若先删 schema，同样触发上述全局 503。实测按此顺序 `RestartCount` 保持 0。

### 参考实现

`infra/scripts/05-provision-user-schema.sh` 是可直接运行的参考实现，幂等（重复执行显示「已含，跳过」），已验证连续开通两个用户为追加而非覆盖。

---

## 三、实测中踩到的 shell 陷阱（写进脚本注释，避免重犯）

这三个都表现为「退出码 0 但什么都没发生」，极难排查：

1. **`docker exec` 不带 `-i` 时不转发 stdin。** heredoc 里的 SQL 会静默丢失，psql 正常退出，脚本以为执行成功。实测导致 schema 从未被创建，而后续步骤照常进行。

2. **`docker exec -i` 在经 stdin 喂入的脚本里会吞掉脚本自身。** 本仓库的远程脚本经 ssh stdin 送给 `bash -s`；此时若某行 `docker exec -i` 没有自己的 heredoc，它会继承该 stdin，把脚本尚未执行的剩余部分当作输入读走，表现为脚本从该行起静默中止、退出码 0。解法：需要喂 SQL 的用 `-i` + heredoc，只做查询的不带 `-i` 并显式 `< /dev/null`。

3. **`sudo -S` 从 stdin 读口令。** 因此绝不能把文件内容管道进 `sudo tee`——内容会被 sudo 当作口令吃掉，而口令被写进目标文件。实测把 `/etc/docker/daemon.json` 写成了口令字符串，dockerd 因无效 JSON 无法启动。解法：先以普通用户写 `/tmp`，再 `sudo cp`。

另有一个非 stdin 类的：**非引号 heredoc 内的反引号会被 bash 当作命令替换执行**，SQL 注释里用反引号引用列名会报语法错误。

---

## 四、部署完成后的样子

- 11 个容器全部 healthy，镜像合计约 6.4 GB
- 凭据位于目标机 `~/.ispace/supabase.env`（600），`.env` 位于
  `~/ispace-deploy/supabase/.env`（600），均不入库
- Studio 未绑定对外路径：`/supabase` 只出 Kong 的 API。
  需要用 Studio 时经 SSH 端口转发访问，不要把它挂到公网路径上——
  它没有独立鉴权，挂出去等于把整个数据库的管理界面公开
