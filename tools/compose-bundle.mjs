#!/usr/bin/env node
/**
 * 构建期强制合成（技术方案 §5.1）。
 *
 * ┌─ 为什么必须在构建期强制注入 ────────────────────────────────────────┐
 * │ expo-updates 是整包替换：加载用户页面包时替换整个 JS 层。若壳功能    │
 * │ 以 JS 实现却任由用户包决定是否包含，用户删掉它，胶囊、设置页、更新   │
 * │ 卡片就全没了——而这些是平台必须替所有人兜住的东西。                  │
 * │                                                                      │
 * │ 因此：用户源码中不存在壳运行时，由本脚本在 expo export 前注入。      │
 * │ 用户既改不掉也删不掉，壳运行时版本永远由平台控制。                    │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 流水线顺序（技术方案 §5.7）：
 *   依赖校验（拒绝新原生依赖）→ app.json Schema 校验 → 注入壳运行时
 *   → expo export → 发布至个人通道
 *
 * 用法：
 *   node tools/compose-bundle.mjs --user <username> --src <用户项目目录> --out <合成目录>
 */

import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(REPO, 'apps/mobile-shell');

/**
 * 原生依赖白名单。
 *
 * 用户代码禁止引入任何新原生依赖——否则 runtimeVersion 变化，其更新不被
 * 壳接受（技术方案 §5.7）。这是机制层面的硬约束，不是建议。
 *
 * 白名单来自壳的 package.json，只允许用壳已预置的那些。
 */
const NATIVE_ALLOWLIST = new Set([
  'expo', 'expo-updates', 'expo-secure-store', 'expo-local-authentication',
  'expo-camera', 'expo-notifications', 'expo-image-picker', 'expo-av',
  'expo-web-browser', 'expo-build-properties', 'expo-application',
  'expo-file-system', 'expo-font',
  'react', 'react-native',
  'react-native-safe-area-context', 'react-native-svg', 'react-native-webview',
  '@ispace/contracts',
]);

function fail(msg) {
  process.stderr.write(`\n构建失败：${msg}\n`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const user = arg('user') ?? fail('缺少 --user');
  const src = arg('src') ?? fail('缺少 --src');
  const out = arg('out') ?? fail('缺少 --out');

  if (!existsSync(src)) fail(`用户项目目录不存在：${src}`);

  // ── 1. 依赖校验 ──────────────────────────────────────────────────
  const pkgPath = join(src, 'package.json');
  if (!existsSync(pkgPath)) fail('用户项目缺少 package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const illegal = deps.filter((d) => !NATIVE_ALLOWLIST.has(d) && isLikelyNative(d));
  if (illegal.length) {
    fail(
      `检测到未经允许的原生依赖：${illegal.join('、')}\n` +
      `原生能力全部由壳预置，引入新的原生依赖会改变 runtimeVersion，\n` +
      `导致你的更新不被壳接受、新版本无法到端。\n` +
      `如确需新能力，请联系平台在壳中预置（需发新的壳二进制）。`,
    );
  }

  // ── 2. app.json Schema 校验 ──────────────────────────────────────
  const appJsonPath = join(src, 'app.json');
  if (!existsSync(appJsonPath)) fail('用户项目缺少 app.json（页面包声明）');
  const appJson = JSON.parse(await readFile(appJsonPath, 'utf8'));

  // tools/ 不是 workspace 包，按显式路径加载 contracts 的构建产物。
  // 用 pathToFileURL 而非裸路径：Windows 上裸路径的动态 import 会失败。
  const contractsUrl = pathToFileURL(join(REPO, 'packages/contracts/dist/index.js')).href;
  if (!existsSync(join(REPO, 'packages/contracts/dist/index.js'))) {
    fail('packages/contracts 尚未构建。先运行 pnpm build。');
  }
  const { appJsonSchema } = await import(contractsUrl);
  const parsed = appJsonSchema.safeParse(appJson);
  if (!parsed.success) {
    fail(
      'app.json 不合法：\n' +
      parsed.error.issues.map((i) => `  ${i.path.join('.') || '(根)'}: ${i.message}`).join('\n'),
    );
  }

  // ── 3. 注入壳运行时 ──────────────────────────────────────────────
  await mkdir(out, { recursive: true });
  await cp(src, out, { recursive: true });

  // 壳运行时覆盖同名文件：即使用户建了 src/shell/，也会被平台版本覆盖
  await cp(join(SHELL, 'src'), join(out, 'src'), { recursive: true, force: true });
  await cp(join(SHELL, 'App.tsx'), join(out, 'App.tsx'), { force: true });
  await cp(join(SHELL, 'app.json'), join(out, 'app.json'), { force: true });

  /*
    平台地址必须显式给。

    壳把它读自 EXPO_PUBLIC_ISPACE_BASE_URL（见 src/config.ts），Expo 在打包时
    内联成字面量。不设的话代码里的默认值是 http://localhost:8080 —— 导出照常
    成功、体积正常、类型也过，只有装到真机上才发现连不上服务器，表现是
    「App 掉回登录页」。这个组合已经把线上的包毁过一次。

    所以在这里拦：宁可让合成失败，也不要产出一个指向 localhost 的包。
    值写进产物的 .env，expo export 会自动读，不必每次记得带环境变量。
  */
  const baseUrl = process.env.EXPO_PUBLIC_ISPACE_BASE_URL;
  if (!baseUrl) {
    fail(
      '缺少 EXPO_PUBLIC_ISPACE_BASE_URL —— 页面包里的平台地址靠它内联。\n'
      + '不设会打出一个指向 http://localhost:3100 的包，装到真机上连不上服务器。\n'
      + '例：EXPO_PUBLIC_ISPACE_BASE_URL=https://ispace.example.com node tools/compose-bundle.mjs …',
    );
  }
  await writeFile(join(out, '.env'), `EXPO_PUBLIC_ISPACE_BASE_URL=${baseUrl}\n`);

  /*
    app.json 里的 config plugin 是相对路径（"./plugins/xxx"），@expo/config
    从**产物目录**解析它。不一起复制过来，export 会直接失败：
      PluginError: Failed to resolve plugin for module "./plugins/..."
    这些插件只在 prebuild 时改原生工程，对 JS 包没有作用，但少了它们
    连配置都读不出来。
  */
  if (existsSync(join(SHELL, 'plugins'))) {
    await cp(join(SHELL, 'plugins'), join(out, 'plugins'), { recursive: true, force: true });
  }

  // package.json 也必须用壳的：JS 包要在**已发出去的壳二进制**里跑，
  // 依赖版本跟二进制对不上会在运行时炸（比如 RN 内部 API 变了）。
  // 用户的 package.json 只在上面的白名单校验里有用，合成后不再需要。
  await cp(join(SHELL, 'package.json'), join(out, 'package.json'), { force: true });

  // Metro 默认只在产物目录自己的 node_modules 与仓库根找依赖（pnpm 不提升，
  // 根上没有 expo）。生成一个 metro.config.js 把解析指回壳的依赖——绝对路径
  // 没关系，产物本来就是本机的中间物，不进 git。
  await writeFile(
    join(out, 'metro.config.js'),
    `// 由 compose-bundle 生成：让 Metro 用壳工程已装好的依赖
const { getDefaultConfig } = require('${join(SHELL, 'node_modules/expo/metro-config')}');
const config = getDefaultConfig(__dirname);
config.watchFolders = [${JSON.stringify(REPO)}];
config.resolver.nodeModulesPaths = [
  ${JSON.stringify(join(SHELL, 'node_modules'))},
  ${JSON.stringify(join(REPO, 'node_modules'))},
];
module.exports = config;
`,
  );

  // 用户的 app.json 是**页面包声明**，与 Expo 的 app.json 同名但语义不同。
  // 合成后前者移到 ispace.app.json，由壳运行时读取。
  await writeFile(join(out, 'ispace.app.json'), JSON.stringify(parsed.data, null, 2));

  // 入口约定：把用户的页面挂到 globalThis.__ispacePage
  await writeFile(
    join(out, 'index.js'),
    `import { registerRootComponent } from 'expo';
import App from './App';
import userPage from './src/pages/index';
import appJson from './ispace.app.json';

// 壳只认这个约定，不理解页面内部结构（见 App.tsx 的 getPageBundle）
globalThis.__ispacePage = {
  appJson,
  screens: userPage.screens,
  title: userPage.title,
};

registerRootComponent(App);
`,
  );

  // ── 4. 冒烟检测 ──────────────────────────────────────────────────
  // 防止流水线缺陷导致壳功能缺失（技术方案 §5.1 的「合成产物自动化冒烟检测」）
  await smokeTest(out);

  process.stdout.write(`合成完成：${user} → ${out}\n`);
}

/** 粗略判断一个包是否可能含原生代码。宁可误报——误报只是让用户来问一句。 */
function isLikelyNative(name) {
  return (
    name.startsWith('expo-') ||
    name.startsWith('react-native-') ||
    name.startsWith('@react-native') ||
    name.startsWith('@expo/')
  );
}

/**
 * 合成产物冒烟检测。
 *
 * 检查壳的关键组件确实存在于产物中。流水线出 bug 导致壳组件缺失时，
 * 用户会拿到一个没有设置入口、无法切换账号、无法接收更新的应用——
 * 而且不会报错。宁可在这里让构建失败。
 */
async function smokeTest(dir) {
  const required = [
    ['App.tsx', ['ShellChrome', 'getPageBundle', '__ispacePage']],
    ['src/shell/ShellChrome.tsx', ['ShellChrome', 'UpdateCard', 'IncompatibleScreen']],
    ['src/shell/NavContainer.tsx', ['NavContainer', 'parseAppJson']],
    ['src/shell/Settings.tsx', ['Settings']],
    ['src/runtime/channel.ts', ['setUpdateRequestHeadersOverride']],
    ['src/runtime/bridge.ts', ['isCapabilityEnabled']],
    ['index.js', ['registerRootComponent', '__ispacePage']],
  ];
  for (const [file, symbols] of required) {
    const p = join(dir, file);
    if (!existsSync(p)) fail(`冒烟检测未通过：合成产物缺少 ${file}`);
    const text = await readFile(p, 'utf8');
    for (const sym of symbols) {
      if (!text.includes(sym)) {
        fail(`冒烟检测未通过：${file} 中找不到 ${sym}，壳功能可能缺失`);
      }
    }
  }

  // 禁令检查：生产壳绝不能出现可改写更新 URL 的 API（技术方案 §5.2）
  const all = await collect(dir);
  for (const f of all) {
    if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue;
    const text = stripComments(await readFile(f, 'utf8'));
    if (/\bsetUpdateURLAndRequestHeadersOverride\s*\(/.test(text)) {
      fail(
        `禁令违反：${f} 调用了 setUpdateURLAndRequestHeadersOverride。\n` +
        `该 API 要求开启 disableAntiBrickingMeasures，会禁用回滚保护，\n` +
        `一旦加载的更新崩溃将无法自动恢复，用户只能卸载重装。\n` +
        `生产壳一律禁止使用。`,
      );
    }
  }
}

/**
 * 剥掉注释后再做禁令检查。
 *
 * 不剥的话，channel.ts 里那段解释"为什么禁用该 API"的注释本身会命中规则，
 * 导致每次合法构建都失败——守卫把自己的说明文档判成了违规。
 * 这个误报在首次实测就出现了。
 *
 * 简单的状态机足够：只需区分注释与字符串，不需要完整 JS 解析。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | single | double | tick
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'tick';
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
      i++; continue;
    }
    // 字符串内：处理转义，避免 \' 提前结束
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'tick' && c === '`')) {
      state = 'code';
    }
    out += c; i++;
  }
  return out;
}

async function collect(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await collect(p, acc);
    else acc.push(p);
  }
  return acc;
}

await main();
