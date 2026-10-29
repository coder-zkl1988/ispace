import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolveFeishuAccount } from '../services/feishu-account.js';
import { startLogin, consumeLogin } from '../services/oauth-state.js';
import { getAppLinkToken, resetAppLink, setAppVisibility } from '../services/visibility.js';
import { it, vi } from 'vitest';
import { pgliteSql } from './pglite-sql.js';
import type { IdentityClaims } from '@ispace/auth';

// Exercises actual PostgreSQL DDL, constraints and rollback in WASM. This does not
// replace the deployment's TCP PostgreSQL / PostgREST / ingress integration tests.
it('Feishu accounts, OAuth state and link visibility use transactional PostgreSQL semantics', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator;');
    const dir = new URL('../../../../packages/db/migrations/', import.meta.url);
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) await db.exec(await readFile(new URL(file, dir), 'utf8'));

    const sql=pgliteSql(db);
    const claims: IdentityClaims={ sub:'feishu|test-app|company|employee-a', name:'测试员工', preferredUsername:'alice', email:'alice@example.invalid', role:'employee', identity:'user', raw:{} };
    const a=await resolveFeishuAccount(sql, claims);
    assert.equal(a.role,'employee');
    assert.equal((await resolveFeishuAccount(sql, claims)).id,a.id);
    assert.equal((await db.query('SELECT count(*)::int n FROM ispace.users')).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::int n FROM information_schema.schemata WHERE schema_name=$1',['u_'+a.username.replaceAll('-','_')])).rows[0].n,1);
    await assert.rejects(resolveFeishuAccount(sql,{...claims, sub:'feishu|test-app|company|different'}), /已有账号/);
    await db.query("UPDATE ispace.users SET status='pending' WHERE id=$1",[a.id]);
    await assert.rejects(resolveFeishuAccount(sql,claims),/账号不可用/);
    await db.query("UPDATE ispace.users SET status='active' WHERE id=$1",[a.id]);

    const old=(await db.query("INSERT INTO ispace.users(sso_subject, username, display_name) VALUES('email|legacy','legacy','原用户') RETURNING *")).rows[0];
    const bound=await resolveFeishuAccount(sql,{...claims,sub:'feishu|test-app|company|legacy'},old.id);
    assert.equal(bound.id,old.id); assert.equal(bound.username,'legacy');
    await assert.rejects(resolveFeishuAccount(sql,claims,old.id),/已绑定其他账号/);

    const preprovisioned=(await db.query("INSERT INTO ispace.users(sso_subject, username, display_name) VALUES('manual|alice','alice','预开通员工') RETURNING *")).rows[0];
    const reused=await resolveFeishuAccount(sql,{...claims,sub:'feishu|test-app|company|alice',preferredUsername:'alice',email:undefined});
    assert.equal(reused.id,preprovisioned.id);
    assert.equal(reused.username,'alice');
    assert.equal((await db.query('SELECT sso_subject FROM ispace.users WHERE id=$1',[preprovisioned.id])).rows[0].sso_subject,'feishu|test-app|company|alice');
    assert.equal((await db.query("SELECT user_id FROM ispace.external_identities WHERE subject='feishu|test-app|company|alice'")).rows[0].user_id,preprovisioned.id);

    const before=(await db.query('SELECT count(*)::int n FROM ispace.users')).rows[0].n;
    await db.exec('ALTER ROLE anon RENAME TO anon_disabled');
    await assert.rejects(resolveFeishuAccount(sql,{...claims,sub:'feishu|test-app|company|fail',email:'fail@example.invalid'}));
    assert.equal((await db.query('SELECT count(*)::int n FROM ispace.users')).rows[0].n,before);
    await db.exec('ALTER ROLE anon_disabled RENAME TO anon');

    const attempt=await startLogin(sql,'feishu',{redirect:'/mine',bindUserId:a.id});
    await assert.rejects(consumeLogin(sql,'feishu',attempt.state,'z'.repeat(43)));
    assert.equal((await consumeLogin(sql,'feishu',attempt.state,attempt.browser)).bindUserId,a.id);
    await assert.rejects(consumeLogin(sql,'feishu',attempt.state,attempt.browser));

    const app=(await db.query("INSERT INTO ispace.apps(owner_id,slug,name,icon_letter,type) VALUES($1,'page','示例','示','static') RETURNING id",[a.id])).rows[0];
    await setAppVisibility(sql,{user:a,appId:app.id,visibility:'public',source:'console'});
    assert.equal((await db.query('SELECT count(*)::int n FROM ispace.marketplace_listings WHERE app_id=$1',[app.id])).rows[0].n,1);
    await db.query("INSERT INTO ispace.shares(app_id,from_user_id,to_user_id,status) VALUES($1,$2,$3,'accepted')",[app.id,a.id,old.id]);
    await db.query("INSERT INTO ispace.app_installs(app_id,user_id,source) VALUES($1,$2,'share')",[app.id,old.id]);
    // 「知道链接的任何人」叠加在邀请之上：下架市场，但受邀同事和他们的入口保留
    const result=await setAppVisibility(sql,{user:a,appId:app.id,visibility:'link',source:'mcp'});
    assert.equal(result.revoked,0);
    assert.match(result.linkToken ?? '',/^[0-9a-f]{48}$/);
    assert.equal((await db.query('SELECT count(*)::int n FROM ispace.marketplace_listings WHERE app_id=$1',[app.id])).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM ispace.app_installs WHERE app_id=$1',[app.id])).rows[0].n,1);
    const row=(await db.query('SELECT visibility, link_token FROM ispace.apps WHERE id=$1',[app.id])).rows[0];
    assert.equal(row.visibility,'link'); assert.equal(row.link_token,result.linkToken);
    // 保持 link 不换令牌；重置换一个新的
    assert.equal((await setAppVisibility(sql,{user:a,appId:app.id,visibility:'link',source:'console'})).linkToken,result.linkToken);
    const reset=await resetAppLink(sql,{user:a,appId:app.id,source:'console'});
    assert.notEqual(reset,result.linkToken);
    assert.equal(await getAppLinkToken(sql,a,app.id),reset);
    // 切走清空令牌并收回分享；再开启是一条全新的链接
    assert.equal((await setAppVisibility(sql,{user:a,appId:app.id,visibility:'private',source:'console'})).revoked,1);
    assert.equal((await db.query('SELECT link_token FROM ispace.apps WHERE id=$1',[app.id])).rows[0].link_token,null);
    await assert.rejects(resetAppLink(sql,{user:a,appId:app.id,source:'console'}),/没有开启/);
    const again=await setAppVisibility(sql,{user:a,appId:app.id,visibility:'link',source:'console'});
    assert.notEqual(again.linkToken,reset);
    await setAppVisibility(sql,{user:a,appId:app.id,visibility:'private',source:'console'});
  } finally { vi.unstubAllEnvs(); await db.close(); }
}, 30_000);
