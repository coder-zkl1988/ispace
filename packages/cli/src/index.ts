#!/usr/bin/env node
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import archiver from 'archiver';

/**
 * ai-deploy —— 供习惯终端的用户使用（技术方案 §4.5）。
 *
 * 命令取自设计稿「接入指引」屏的实际列表：
 *   ai-deploy up ./dist /zhoubao        发布产物到你的路径
 *   ai-deploy releases /zhoubao         看历史版本
 *   ai-deploy rollback /zhoubao v11     回滚到指定版本
 *   ai-deploy backend create            申请一个后端应用
 *   ai-deploy quota                     看自己的用量与配额
 *
 * 有意不引入命令行框架：参数形态简单，手写解析比引入 commander 更轻，
 * 且能完全控制中文错误提示的措辞。
 */

const CONFIG_DIR = join(homedir(), '.ispace');
const CONFIG_FILE = join(CONFIG_DIR, 'cli.json');

/**
 * 平台地址的来源，优先级从高到低：`ISPACE_BASE_URL` 环境变量 → `~/.ispace/cli.json`
 * （`ai-deploy login` 写入）→ 本机开发默认值。
 *
 * 环境变量压过配置文件，是为了让同一台机器能在多个实例间切换（本机、
 * 团队测试环境、生产），不必反复 login。默认值指向本机 dev 起的
 * deploy-service，对着真实实例用时必须显式指定。
 */
const DEFAULT_BASE = 'http://localhost:3100';

interface Config {
  base: string;
  token?: string;
}

function loadConfig(): Config {
  const fromEnv = process.env.ISPACE_BASE_URL;
  if (existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
      return { ...saved, base: fromEnv ?? saved.base ?? DEFAULT_BASE };
    } catch {
      // 配置损坏不该让整个 CLI 不可用，退回默认值并在 login 时覆盖
    }
  }
  return { base: fromEnv ?? DEFAULT_BASE };
}

function saveConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/**
 * 必须是函数声明而非 const 箭头函数：TS 只对函数声明做 never 的控制流收窄，
 * 写成 const 会让调用点之后的代码被判定为"变量可能未赋值"。
 */
function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

/** 去掉路径参数的前导斜杠。设计稿里的写法是 /zhoubao，但 API 用的是裸 slug。 */
const normSlug = (s: string): string => s.replace(/^\/+/, '').replace(/\/+$/, '');

async function api(
  cfg: Config,
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  if (!cfg.token) {
    die('尚未登录。先运行：ai-deploy login');
  }
  const res = await fetch(`${cfg.base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      ...(init.headers as Record<string, string>),
    },
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    die(`服务返回了非 JSON 响应（HTTP ${res.status}）：\n${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const code = body.code as string | undefined;
    // 把服务端的业务 message 原样呈现——它是为终端用户写的，比 HTTP 状态码有用
    die(`${body.message ?? '请求失败'}${code ? `  [${code}]` : ''}`);
  }
  return body;
}

/** 把目录打包成 zip。存到临时文件而非内存，避免大产物撑爆堆。 */
async function zipDir(dir: string): Promise<string> {
  const out = join(tmpdir(), `ispace-${Date.now()}.zip`);
  await new Promise<void>((res, rej) => {
    const stream = createWriteStream(out);
    const archive = archiver('zip', { zlib: { level: 9 } });
    stream.on('close', () => res());
    archive.on('error', rej);
    archive.pipe(stream);
    archive.directory(dir, false);
    void archive.finalize();
  });
  return out;
}

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// ── 命令 ──────────────────────────────────────────────────────────────

async function cmdLogin(cfg: Config, args: string[]): Promise<void> {
  const base = args[0] ?? cfg.base;
  process.stdout.write(
    `请在浏览器打开下面地址完成登录，然后把 ispace_session cookie 的值粘贴回来：\n` +
      `  ${base}/deploy/api/auth/login\n\n` +
      `（Chrome：F12 → Application → Cookies → 复制 ispace_session 的值）\n\n`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const token = (await rl.question('token: ')).trim();
  rl.close();
  if (!token) die('没有输入 token');

  const probe = await fetch(`${base}/deploy/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!probe.ok) die(`token 无效（HTTP ${probe.status}）`);
  const me = (await probe.json()) as { user: { displayName: string; username: string } };

  saveConfig({ base, token });
  process.stdout.write(`已登录：${me.user.displayName} (${me.user.username})\n配置存于 ${CONFIG_FILE}\n`);
}

async function cmdUp(cfg: Config, args: string[]): Promise<void> {
  const [dirArg, slugArg] = args;
  if (!dirArg || !slugArg) {
    die('用法：ai-deploy up ./dist /zhoubao');
  }
  const dir = resolve(dirArg);
  if (!existsSync(dir)) die(`目录不存在：${dir}`);
  if (!existsSync(join(dir, 'index.html'))) {
    die(`${dir} 下没有 index.html。请指向构建输出目录（通常是 dist）。`);
  }
  const slug = normSlug(slugArg);

  process.stdout.write(`打包 ${dir} …\n`);
  const zip = await zipDir(dir);

  const form = new FormData();
  form.append('file', new Blob([readFileSync(zip)]), 'artifact.zip');
  form.append('source', 'cli');

  process.stdout.write(`发布到 /${slug} …\n`);
  const r = (await api(cfg, `/deploy/api/apps/${slug}/deploy`, {
    method: 'POST',
    body: form,
  })) as unknown as { release: { version: number; sizeBytes: number }; url: string };

  process.stdout.write(`\n已发布 v${r.release.version}  ${fmtBytes(r.release.sizeBytes)}\n${r.url}\n`);
}

async function cmdReleases(cfg: Config, args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) die('用法：ai-deploy releases /zhoubao');
  const slug = normSlug(arg);
  const r = (await api(cfg, `/deploy/api/apps/${slug}/releases`)) as unknown as {
    releases: {
      version: number; status: string; source: string;
      sizeBytes: number; publishedAt: string; blockedReason: string | null;
    }[];
  };
  if (!r.releases.length) {
    process.stdout.write(`/${slug} 还没有发布记录\n`);
    return;
  }
  for (const x of r.releases) {
    const when = x.publishedAt.slice(0, 16).replace('T', ' ');
    const mark =
      x.status === 'active' ? ' ← 当前'
      : x.status === 'blocked' ? `  已阻断：${x.blockedReason ?? ''}`
      : '';
    process.stdout.write(
      `v${String(x.version).padEnd(4)} ${when}  ${x.source.padEnd(8)} ${fmtBytes(x.sizeBytes).padStart(8)}${mark}\n`,
    );
  }
}

async function cmdRollback(cfg: Config, args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) die('用法：ai-deploy rollback /zhoubao [v11]');
  const slug = normSlug(arg);
  const vArg = args[1];
  const body = vArg ? { toVersion: Number(vArg.replace(/^v/i, '')) } : {};
  const r = (await api(cfg, `/deploy/api/apps/${slug}/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })) as unknown as { release: { version: number }; url: string };
  process.stdout.write(`已回滚到 v${r.release.version}\n${r.url}\n`);
}

async function cmdQuota(cfg: Config): Promise<void> {
  const r = (await api(cfg, '/deploy/api/quota')) as unknown as {
    quota: {
      storageBytesUsed: number; storageBytesLimit: number;
      backendCountUsed: number; backendCountLimit: number;
      dbRowsUsed: number; dbRowsLimit: number;
    };
    backendCpuLimit: number; backendMemLimitMb: number;
  };
  const q = r.quota;
  process.stdout.write(
    `静态空间  ${fmtBytes(q.storageBytesUsed)} / ${fmtBytes(q.storageBytesLimit)}\n` +
      `后端应用  ${q.backendCountUsed} / ${q.backendCountLimit} 个` +
      `（单个 ${r.backendCpuLimit} vCPU / ${r.backendMemLimitMb} MB）\n` +
      `数据行数  ${q.dbRowsUsed.toLocaleString()} / ${q.dbRowsLimit.toLocaleString()} 行\n`,
  );
}

const HELP = `ai-deploy —— ispace 命令行

  ai-deploy login [地址]              登录（默认 ${DEFAULT_BASE}）
  ai-deploy up ./dist /zhoubao        发布产物到你的路径
  ai-deploy releases /zhoubao         看历史版本
  ai-deploy rollback /zhoubao [v11]   回滚，省略版本号则回到上一个
  ai-deploy quota                     看自己的用量与配额

也可以在 Claude 里直接说一句话，效果相同：
  「把这个项目部署到我的空间，路径 /zhoubao」
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();

  switch (cmd) {
    case 'login':    return cmdLogin(cfg, args);
    case 'up':       return cmdUp(cfg, args);
    case 'releases': return cmdReleases(cfg, args);
    case 'rollback': return cmdRollback(cfg, args);
    case 'quota':    return cmdQuota(cfg);
    case 'backend':
      die('后端应用开通将在编排器接入后可用。当前请用控制台提交申请。');
      return;
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      return;
    default:
      die(`未知命令：${cmd}\n\n${HELP}`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

export { createReadStream, dirname };
