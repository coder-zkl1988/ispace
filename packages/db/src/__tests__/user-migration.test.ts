import { describe, expect, it } from 'vitest';
import { IspaceError } from '@ispace/contracts';
import { validateUserMigration } from '../provisioning.js';

describe('用户数据迁移 SQL 限权', () => {
  it('允许建表、索引与按 auth.uid() 隔离的 RLS 策略', () => {
    const statements = validateUserMigration(`
      CREATE TABLE IF NOT EXISTS tasks (
        id bigint generated always as identity primary key,
        owner_id uuid NOT NULL DEFAULT auth.uid(),
        title text NOT NULL,
        project_id bigint REFERENCES projects(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
      CREATE INDEX tasks_owner_idx ON tasks (owner_id, created_at);
      CREATE POLICY tasks_owner ON tasks
        FOR ALL TO authenticated
        USING (owner_id = auth.uid())
        WITH CHECK (owner_id = auth.uid());
      COMMENT ON TABLE tasks IS '当前用户的任务';
    `);

    expect(statements).toHaveLength(5);
  });

  it.each([
    ['跨 schema', 'CREATE TABLE public.tasks (id bigint)'],
    ['读取其他数据', 'CREATE TABLE copied AS SELECT * FROM secrets'],
    ['创建函数', 'CREATE FUNCTION steal() RETURNS void LANGUAGE sql AS \'SELECT 1\''],
    ['切换 schema', 'ALTER TABLE tasks SET SCHEMA public'],
    ['改所有者', 'ALTER TABLE tasks OWNER TO postgres'],
    ['关闭 RLS', 'ALTER TABLE tasks DISABLE ROW LEVEL SECURITY'],
    ['删除字段', 'ALTER TABLE tasks DROP COLUMN owner_id'],
    ['调用服务端函数', "CREATE TABLE tasks (id text DEFAULT pg_read_file('/etc/passwd'))"],
    ['用 regclass 访问外部对象', "CREATE TABLE tasks (seq oid DEFAULT 'ispace.users'::regclass)"],
    ['用注释藏语句', 'CREATE TABLE tasks (id bigint); -- DROP SCHEMA public'],
  ])('拒绝%s', (_label, migration) => {
    expect(() => validateUserMigration(migration)).toThrow(IspaceError);
  });

  it('允许字符串说明里出现受限关键字', () => {
    expect(validateUserMigration(
      "COMMENT ON TABLE tasks IS 'SELECT、DELETE 只是说明文字'",
    )).toEqual(["COMMENT ON TABLE tasks IS 'SELECT、DELETE 只是说明文字'"]);
  });
});
