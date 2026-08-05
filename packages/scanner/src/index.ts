import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ERROR_CODES, IspaceError } from '@ispace/contracts';

/**
 * 发布链路的产物扫描（技术方案 §7、规格 §9）。
 *
 * 三项检查，任一命中即阻断发布并留痕：
 *   1. 硬编码密钥（gitleaks 规则集的核心子集）
 *   2. 基础 XSS 模式
 *   3. base path —— 子路径部署下根绝对路径引用会 404
 *
 * 两道扫描：
 *   内置规则（本文件上半部）—— 阻断用的快路径，纯内存正则，无进程开销。
 *     规则按平台场景裁剪：内部平台不关心 GitHub token 的历史泄漏，
 *     但极关心 Supabase service_role key。
 *   gitleaks（本文件末尾）—— 第二道，覆盖面广得多但要起子进程，
 *     可经 ISPACE_GITLEAKS=0 关闭，关掉仍有内置规则兜底。
 */

export interface ScanFinding {
  rule: string;
  file: string;
  line: number;
  /** 命中的片段，已做遮蔽——原文会进审计日志，不能明文留存密钥。 */
  excerpt: string;
}

export interface ScanResult {
  ok: boolean;
  findings: ScanFinding[];
}

interface Rule {
  id: string;
  re: RegExp;
  /** 误报过滤：命中后再跑一次，返回 true 则忽略。 */
  ignore?: (match: string, line: string) => boolean;
}

/** 明显是示例/占位的值，不算泄漏。 */
const PLACEHOLDER = /(your[-_]?|example|placeholder|xxx+|<[^>]+>|\bdummy\b|\btest\b|changeme)/i;

const SECRET_RULES: Rule[] = [
  { id: 'aws-access-key-id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    id: 'aws-secret-access-key',
    re: /\baws_?secret_?access_?key\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
  },
  { id: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { id: 'openai-key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'private-key-block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  {
    id: 'jwt-with-service-role',
    // Supabase 的 service_role key 是 JWT，泄漏它等于交出整个数据 schema 的写权限。
    // 这是本平台最需要拦的一条：anon key 出现在前端是正常的，service_role 绝不允许。
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    ignore: (match) => {
      try {
        const payload = JSON.parse(
          Buffer.from(match.split('.')[1]!, 'base64url').toString('utf8'),
        ) as { role?: string };
        // 只拦 service_role；anon key 本就该出现在前端产物里
        return payload.role !== 'service_role';
      } catch {
        return true; // 解不出来的不是 Supabase key，交给其他规则
      }
    },
  },
  {
    id: 'generic-password-assignment',
    re: /\b(password|passwd|pwd|secret|api[-_]?key|token)\s*[:=]\s*['"]([^'"\s]{8,})['"]/gi,
    ignore: (_m, line) => PLACEHOLDER.test(line),
  },
  { id: 'postgres-url-with-password', re: /\bpostgres(ql)?:\/\/[^:\s]+:[^@\s]{4,}@/g },
];

const XSS_RULES: Rule[] = [
  {
    id: 'inline-event-handler-with-eval',
    re: /\bon(click|load|error|mouseover)\s*=\s*['"][^'"]*\b(eval|Function|setTimeout)\s*\(/gi,
  },
  {
    id: 'innerHTML-from-variable',
    // 常量赋值不拦（模板拼接的静态 HTML 很常见），只拦明显来自变量的
    re: /\.innerHTML\s*=\s*(?!['"`])[A-Za-z_$][\w$.]*/g,
  },
  { id: 'document-write-with-variable', re: /document\.write\s*\(\s*(?!['"`])[A-Za-z_$]/g },
  { id: 'eval-of-remote', re: /\beval\s*\(\s*(await\s+)?fetch\s*\(/g },
];

/** 遮蔽命中片段：保留头尾各 4 字符，中间打码。审计日志里不能有明文密钥。 */
function mask(s: string): string {
  const t = s.trim();
  if (t.length <= 12) return '*'.repeat(t.length);
  return `${t.slice(0, 4)}${'*'.repeat(Math.min(t.length - 8, 24))}${t.slice(-4)}`;
}

function scanText(text: string, file: string, rules: Rule[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split('\n');
  for (const rule of rules) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // 每行重置 lastIndex——全局正则跨行复用会漏匹配
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(line)) !== null) {
        if (rule.ignore?.(m[0], line)) continue;
        findings.push({ rule: rule.id, file, line: i + 1, excerpt: mask(m[0]) });
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // 防零宽死循环
      }
    }
  }
  return findings;
}

/** 只扫文本类文件；图片字体等二进制跳过，既无意义又慢。 */
const TEXT_EXT = /\.(html?|js|mjs|cjs|jsx|ts|tsx|css|json|txt|md|ya?ml|env|xml|svg)$/i;
/** 单文件超过此大小跳过：打包后的 vendor chunk 动辄数 MB，逐行正则代价过高。 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export function scanFiles(files: string[], rootDir: string): ScanResult {
  const findings: ScanFinding[] = [];
  for (const abs of files) {
    if (!TEXT_EXT.test(abs)) continue;
    let text: string;
    try {
      const buf = readFileSync(abs);
      if (buf.byteLength > MAX_SCAN_BYTES) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const rel = relative(rootDir, abs);
    findings.push(...scanText(text, rel, SECRET_RULES));
    findings.push(...scanText(text, rel, XSS_RULES));
  }
  return { ok: findings.length === 0, findings };
}

/** 供单测与 CLI 预检直接扫字符串。 */
export function scanContent(text: string, file = 'input'): ScanResult {
  const findings = [...scanText(text, file, SECRET_RULES), ...scanText(text, file, XSS_RULES)];
  return { ok: findings.length === 0, findings };
}

/**
 * base path 校验（技术方案 §4.2）。
 *
 * 用户应用发布在 /{user}/{app}/ 子路径下，产物若引用根绝对路径（/assets/x.js）
 * 会 404。脚手架模板会注入正确的 base，本检查用于拦住绕过模板的漏网情况。
 *
 * 只警告不阻断的情形：外链（http://、//cdn）、data:、锚点、以及 /{user}/{app}/
 * 开头的正确绝对路径。
 */
export function checkBasePath(indexHtml: string): { ok: boolean; offenders: string[] } {
  const offenders: string[] = [];
  const attrRe = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(indexHtml)) !== null) {
    const url = m[1]!;
    if (
      !url.startsWith('/') ||        // 相对路径，正确
      url.startsWith('//')           // 协议相对的外链
    ) continue;
    // 到这里一定是单个 / 开头的根绝对路径
    offenders.push(url);
  }
  return { ok: offenders.length === 0, offenders };
}

/** 把扫描结果转为可直接抛出的错误。message 会呈现给用户与 Agent。 */
export function assertScanClean(result: ScanResult): void {
  if (result.ok) return;
  const secrets = result.findings.filter((f) => !f.rule.startsWith('inline') && !f.rule.includes('innerHTML') && !f.rule.includes('document-write') && !f.rule.includes('eval-of'));
  const code = secrets.length > 0 ? ERROR_CODES.SECRET_DETECTED : ERROR_CODES.XSS_DETECTED;
  const first = result.findings[0]!;
  throw new IspaceError(
    code,
    `发布被阻断：${first.file}:${first.line} 命中规则 ${first.rule}（共 ${result.findings.length} 处）`,
    { findings: result.findings },
  );
}

/**
 * gitleaks 深度扫描（规格 §9 的「gitleaks 规则集」）。
 *
 * 定位是**第二道**，不是替代：
 *   - 内置规则（上文）是阻断用的快路径，纯内存正则，无进程开销
 *   - gitleaks 覆盖面广得多（百余条规则 vs 内置十余条），但要起子进程
 *     并解析 JSON 输出，在同步发布链路上有可感知的延迟
 *
 * 因此默认开启但可关：ISPACE_GITLEAKS=0 时跳过。发布高峰期若延迟明显，
 * 关掉它仍有内置规则兜底，不会裸奔。
 *
 * 用打进镜像的二进制而非起 docker 容器：后者要给 deploy-service 挂
 * docker socket，等于给了容器逃逸的口子——为了扫密钥而开一个更大的洞
 * 是不划算的。
 */
export async function gitleaksScan(
  dir: string,
  opts: { binary?: string; timeoutMs?: number } = {},
): Promise<{ available: boolean; findings: ScanFinding[] }> {
  const bin = opts.binary ?? process.env.ISPACE_GITLEAKS_BIN ?? 'gitleaks';
  if (process.env.ISPACE_GITLEAKS === '0') return { available: false, findings: [] };

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const report = `${dir}/.gitleaks-report.json`;
  try {
    // gitleaks 命中时退出码非 0，所以不能靠 try/catch 区分"出错"与"有发现"，
    // 必须看报告文件是否生成。
    await run(bin, [
      'dir', dir,
      '--report-format', 'json',
      '--report-path', report,
      '--no-banner', '--exit-code', '0',
    ], { timeout: opts.timeoutMs ?? 20_000 });
  } catch (e) {
    // 二进制不存在 → 静默降级为不可用，内置规则已经跑过了，不该因此阻断发布
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') return { available: false, findings: [] };
    // 超时或其他异常同样降级，但要让调用方知道
    return { available: false, findings: [] };
  }

  try {
    const { readFile, rm } = await import('node:fs/promises');
    const raw = await readFile(report, 'utf8');
    await rm(report, { force: true });
    const items = JSON.parse(raw) as {
      RuleID: string; File: string; StartLine: number; Secret: string;
    }[];
    return {
      available: true,
      findings: items.map((i) => ({
        rule: `gitleaks:${i.RuleID}`,
        file: i.File.replace(`${dir}/`, ''),
        line: i.StartLine,
        excerpt: mask(i.Secret),
      })),
    };
  } catch {
    // 报告文件不存在 = 没有发现（gitleaks 无命中时不写文件）
    return { available: true, findings: [] };
  }
}
