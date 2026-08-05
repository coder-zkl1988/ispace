#!/usr/bin/env bash
# 为一位用户开通 Supabase schema，不重启任何服务。
# 用法: ./infra/scripts/05-provision-user-schema.sh <username>
#
# 这是 packages/db 里 provisioning 实现的参考流程，顺序经实测确定，不可调换。
#
# ┌─ 为什么顺序不能换 ────────────────────────────────────────────────┐
# │ 若先把 schema 名写进 pgrst.db_schemas 而该 schema 尚不存在，       │
# │ PostgREST 加载 schema 缓存时报 3F000 "schema does not exist"，     │
# │ 随即进入「重连 → 重载 → 再失败」的循环，此期间 /rest/v1/* 对       │
# │ **全部用户** 返回 503。即一个新用户开通失败会打挂所有存量用户的     │
# │ 数据接口。实测已复现。                                             │
# │                                                                    │
# │ 因此必须：先建 schema 与授权，确认存在后，再改 db_schemas。         │
# └────────────────────────────────────────────────────────────────────┘
#
# 两个 NOTIFY 通道是分开的，缺一不可：
#   reload config —— 让 PostgREST 重读 pgrst.* 配置（决定暴露哪些 schema）
#   reload schema —— 让它重建 schema 缓存（决定认得哪些表）
# 只发前者，表查询会返回 PGRST205 "Could not find the table in the schema cache"。
#
# 用库内配置（ALTER ROLE ... SET pgrst.db_schemas）而非 PGRST_DB_SCHEMAS 环境变量：
# 后者要重启容器才生效，会打断所有存量用户的连接。库内配置 + NOTIFY 实测零重启
# （RestartCount 保持 0）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USERNAME="${1:?用法: $0 <username>}"

# 用户名必须与 packages/contracts 的校验规则一致，此处做最小防注入
if ! printf '%s' "$USERNAME" | grep -qE '^[a-z][a-z0-9-]{0,30}$'; then
  echo "错误: 非法用户名 '$USERNAME'（须匹配 ^[a-z][a-z0-9-]{0,30}$）" >&2
  exit 1
fi
SCHEMA="u_${USERNAME//-/_}"

"$SCRIPT_DIR/remote.sh" "SCHEMA='$SCHEMA' bash -s" <<'REMOTE'
set -eu

# 两个函数不可混用，各自解决一个 stdin 陷阱：
#
# psql_stdin —— 喂 heredoc SQL，必须带 -i，否则 stdin 不转发、SQL 静默丢失
#               而退出码仍为 0（即「执行成功」但什么都没做）。
#
# psql_q     —— 执行 -c/-tAc 形式的查询，**绝不能带 -i**。本脚本经 ssh 的
#               stdin 喂给 `bash -s`，带 -i 的 docker exec 会继承该 stdin，
#               把脚本尚未执行的剩余部分当作 psql 输入吞掉，表现为脚本从
#               该行起静默中止且退出码为 0。< /dev/null 是第二道保险。
psql_stdin() { docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 "$@"; }
psql_q()     { docker exec supabase-db psql -U postgres -v ON_ERROR_STOP=1 "$@" < /dev/null; }

echo "== 1. 建 schema 与授权（必须先于改 db_schemas）=="
psql_stdin -q <<SQL
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
GRANT USAGE ON SCHEMA ${SCHEMA} TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA ${SCHEMA} TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA}
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA}
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
SQL

echo "== 2. 确认 schema 确实存在（不确认就改配置会打挂全站）=="
exists=$(psql_q -tAc "SELECT count(*) FROM information_schema.schemata WHERE schema_name='${SCHEMA}';")
if [ "$exists" != "1" ]; then
  echo "错误: ${SCHEMA} 创建失败，中止——继续下去会导致 PostgREST 全局 503" >&2
  exit 1
fi
echo "   ${SCHEMA} 已存在"

echo "== 3. 追加进 db_schemas（幂等，保留既有值）=="
psql_stdin -q <<SQL
DO \$\$
DECLARE
  cur text;
  cleaned text;
BEGIN
  -- 全显式 JOIN。不可写成 "FROM a, unnest(..) s JOIN b ON .. = a.col" 那种
  -- 隐式逗号连接与显式 JOIN 混用的形式：a 不在 JOIN 的作用域内，会报
  -- "invalid reference to FROM-clause entry"。
  -- 另注：本段处于非引号 heredoc 内，注释里不可出现反引号，否则会被 bash
  -- 当作命令替换执行。
  SELECT COALESCE(
    (SELECT split_part(s, '=', 2)
       FROM pg_db_role_setting r
       JOIN pg_roles ro ON ro.oid = r.setrole
       CROSS JOIN LATERAL unnest(r.setconfig) AS s
      WHERE ro.rolname = 'authenticator' AND s LIKE 'pgrst.db_schemas=%'
      LIMIT 1),
    'public,graphql_public') INTO cur;

  IF position('${SCHEMA}' in cur) = 0 THEN
    cleaned := cur || ',${SCHEMA}';
    EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', cleaned);
    RAISE NOTICE 'db_schemas -> %', cleaned;
  ELSE
    RAISE NOTICE 'db_schemas 已含 ${SCHEMA}，跳过';
  END IF;
END \$\$;
SQL

echo "== 4. 双通道热加载（缺一不可）=="
psql_q -q -c "NOTIFY pgrst, 'reload config';"
psql_q -q -c "NOTIFY pgrst, 'reload schema';"

echo "== 5. 结果 =="
psql_q -tAc "SELECT s FROM pg_db_role_setting r JOIN pg_roles ro ON ro.oid = r.setrole CROSS JOIN LATERAL unnest(r.setconfig) AS s WHERE ro.rolname='authenticator' AND s LIKE 'pgrst.db_schemas=%';"
REMOTE

echo
echo "开通完成：$SCHEMA（客户端用 supabase-js 时指定 db: { schema: '$SCHEMA' }）"
