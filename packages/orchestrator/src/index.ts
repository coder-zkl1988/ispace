import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { DEFAULT_QUOTAS, ERROR_CODES, IspaceError } from '@ispace/contracts';

/**
 * Dokploy 写部署日志的目录，以只读方式挂进 deploy-service
 * （见 infra/dokploy/deploy-service.compose.yml）。
 */
const DOKPLOY_LOG_ROOT = '/etc/dokploy/logs';

/**
 * 容器编排抽象（规格 §5.3）。
 *
 * 两个实现都是真实需要的，不是为抽象而抽象：
 *   DokployOrchestrator —— 生产
 *   MockOrchestrator    —— 本地开发与单测。开发机没装 Docker，Mock 是
 *                          唯一能在本地跑通后端开通逻辑的路径。
 *
 * 资源限额由 setLimits 在建应用时**强制写入**，不依赖用户自觉
 * （技术方案 §4.4：单机 Dokploy 无强多租户隔离，限额是资源兜底的唯一手段）。
 */

export interface BackendAppSpec {
  /** 归属用户，用于命名与路径。 */
  username: string;
  /** 应用名，同一用户下唯一。 */
  name: string;
  /** Git 仓库地址或镜像名。 */
  sourceRepo?: string;
  /** 容器内监听端口。 */
  port?: number;
}

export interface BackendAppRef {
  /** 编排器侧标识。Dokploy 为 applicationId。 */
  id: string;
  /** 对外访问路径，形如 /svc/{user}/{app}。 */
  urlPath: string;
  /**
   * 容器名前缀。宿主上的资源采样任务靠它把 docker stats 的行认回某个后端
   * （Swarm 的实际容器名是 {前缀}.1.{taskId}，只能按前缀匹配）。
   * 仅 createBackendApp 会带上——后续调用只需要 id。
   */
  containerName?: string;
}

export interface ResourceLimits {
  cpu: number;
  memoryMb: number;
}

export type BackendStatus = 'creating' | 'running' | 'stopped' | 'failed';

export interface Orchestrator {
  readonly name: string;
  createBackendApp(spec: BackendAppSpec): Promise<BackendAppRef>;
  /**
   * 配置源并触发一次部署。
   *
   * 这一步此前完全没有——平台只是在 Dokploy 里建了个应用记录、绑了域名、
   * 写了限额，**从没告诉它要跑什么，也从没触发过部署**。于是应用永远停在
   * idle，界面上显示"已停止"（那其实是准的），而提示写着"容器正在拉起"。
   */
  deploySource(ref: BackendAppRef, sourceRepo: string): Promise<void>;
  bindPath(ref: BackendAppRef, host: string, path: string, port: number): Promise<void>;
  setLimits(ref: BackendAppRef, limits: ResourceLimits): Promise<void>;
  getStatus(ref: BackendAppRef): Promise<BackendStatus>;
  restart(ref: BackendAppRef): Promise<void>;
  remove(ref: BackendAppRef): Promise<void>;
  /**
   * 最近一次部署的日志尾巴。
   *
   * 「启动失败」四个字对用户毫无用处——真正的原因（镜像拉不到、构建
   * 报错、端口不对）全在这里面。拿不到就返回 null，界面退回到通用提示。
   */
  deployLog(ref: BackendAppRef, lines?: number): Promise<string | null>;
}

/**
 * 用户填的「Git 仓库或镜像」到底是哪一种。
 *
 * 两者在 Dokploy 里走完全不同的配置接口，猜错的后果是应用建出来但永远
 * 起不来——而且不报错，只是一直 idle。所以判定要保守：
 * 明确长得像 git 的才当 git，其余一律当镜像。
 *
 * 镜像名的形态比 git URL 宽松得多（nginx、nginx:alpine、
 * ghcr.io/org/app:tag、registry.cn-hangzhou.aliyuncs.com/x/y），
 * 反过来枚举镜像会漏，枚举 git 则很准。
 */
export function detectSourceKind(src: string): 'git' | 'image' {
  const t = src.trim();
  if (/^https?:\/\//i.test(t)) return 'git';
  if (/^(git|ssh):\/\//i.test(t)) return 'git';
  if (/^git@/i.test(t)) return 'git';
  if (/\.git$/i.test(t)) return 'git';
  return 'image';
}

/**
 * 建之前先看这个来源能不能用。
 *
 * 起因是一次真实的失败：用户填了 `zongkelong/myapp`，平台判成 Docker 镜像
 * 照单全收，Dokploy 拉取时 `pull access denied … repository does not exist`，
 * 界面上只剩一个「启动失败」。用户没有任何线索——他以为自己填的是 GitHub
 * 仓库，而 `owner/repo` 和 Docker Hub 的 `user/image` 长得一模一样。
 *
 * 这个歧义靠猜是解不掉的，只能去问 registry。问不到（内网限制、registry
 * 抽风）时**不阻断创建**：预检是为了给出好的报错，不是给平台加一个新的
 * 单点故障。真失败了还有部署日志兜底。
 */
export interface SourceCheck {
  ok: boolean;
  /** 面向用户的中文说明，ok 为 false 时必有，且必须给出下一步怎么办。 */
  message?: string;
}

export async function verifySource(src: string, fetchImpl = fetch): Promise<SourceCheck> {
  const t = src.trim();

  if (detectSourceKind(t) === 'git') {
    // GitHub 的网页地址不是可克隆地址。这个坑同事已经踩过一次
    // （coolcoolcool 的 /tree/ 链接），克隆时才报错太晚了。
    const tree = t.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/(tree|blob)\//i);
    if (tree) {
      return {
        ok: false,
        message:
          `这是 GitHub 的网页地址，克隆不了。改填仓库地址：${tree[1]}.git\n`
          + '（如果代码在子目录或非默认分支，先跟我说，那需要另外配置。）',
      };
    }
    return { ok: true };
  }

  // ── 镜像：去 registry 求证 ────────────────────────────────────────
  const ref = t.replace(/^docker\.io\//, '');
  const [nameWithHost] = ref.split(':');
  const parts = (nameWithHost ?? '').split('/');
  // 带点或端口的首段是私有 registry 主机名，那超出「只支持公开镜像」的范围
  if (parts.length > 1 && /[.:]/.test(parts[0] ?? '')) return { ok: true };

  const path = parts.length === 1 ? `library/${parts[0]}` : parts.join('/');
  try {
    const res = await fetchImpl(`https://hub.docker.com/v2/repositories/${path}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 404) {
      const looksLikeRepo = parts.length === 2;
      return {
        ok: false,
        message:
          `Docker Hub 上没有 ${ref} 这个公开镜像。\n`
          + (looksLikeRepo
            ? `如果你想部署的是 GitHub 仓库，请填完整地址，例如 https://github.com/${nameWithHost}.git —— `
              + `只写 ${nameWithHost} 会被当成 Docker 镜像名。\n`
            : '')
          + '如果确实是镜像，检查拼写与标签；私有镜像暂不支持。',
      };
    }
    return { ok: true };
  } catch {
    // 网络不通就不拦。宁可让它去失败一次，也不要因为查不到而不让人建
    return { ok: true };
  }
}

/** 后端应用的对外路径。集中在这里，避免服务层与网关配置各写一份。 */
export function backendUrlPath(username: string, name: string): string {
  return `/svc/${username}/${name}`;
}

// ── Dokploy ───────────────────────────────────────────────────────────

/**
 * Dokploy 走 tRPC 风格的 HTTP 接口：所有写操作都是 POST /api/{procedure}，
 * 参数放在 JSON body 里。以下端点与字段均经真实调用验证：
 *
 *   POST /api/project.create      { name, description }
 *                                 → { project:{projectId}, environment:{environmentId} }
 *   POST /api/application.create  { name, appName, environmentId } → { applicationId }
 *   POST /api/domain.create       { applicationId, host, path, port, https, domainType }
 *   POST /api/application.update  { applicationId, cpuLimit, memoryLimit } → true
 *   POST /api/application.delete  { applicationId }
 *
 * 两个单位坑，传错都不报错、只让限额变成荒谬的值：
 *   - cpuLimit：v0.29.14 起是**裸 NanoCPU**（1 核 = 1e9），不是核数。见 setLimits。
 *   - memoryLimit：**字节数的字符串**，不是 MB 数字。
 */
export class DokployOrchestrator implements Orchestrator {
  readonly name = 'dokploy';

  private environmentId?: string;

  constructor(
    private readonly cfg: {
      baseUrl: string;
      token: string;
      /** 所有用户后端归入同一个 Dokploy 项目，便于统一查看与清理。 */
      projectName?: string;
    },
  ) {}

  private async call<T>(procedure: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}/api/${procedure}`, {
      method: 'POST',
      headers: { 'x-api-key': this.cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const upstream = text;
      let reason = '上游编排器拒绝了请求';
      try {
        const parsed = JSON.parse(text) as {
          message?: string;
          data?: { zodError?: { fieldErrors?: Record<string, string[]> } };
        };
        const fields = parsed.data?.zodError?.fieldErrors;
        const fieldText = fields
          ? Object.entries(fields).flatMap(([field, messages]) =>
              messages.map((message) => `${field}: ${message}`)).join('；')
          : '';
        reason = fieldText || parsed.message || reason;
      } catch {
        reason = text.trim().slice(0, 500) || reason;
      }
      throw new IspaceError(
        ERROR_CODES.ORCHESTRATOR_FAILED,
        `Dokploy ${procedure} 失败（HTTP ${res.status}）：${reason}`,
        { procedure, httpStatus: res.status, upstream },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // 部分 procedure 返回裸 true/false 而非 JSON 对象
      return text as unknown as T;
    }
  }

  private async get<T>(procedure: string, params?: Record<string, string>): Promise<T> {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
    const res = await fetch(`${this.cfg.baseUrl}/api/${procedure}${qs}`, {
      headers: { 'x-api-key': this.cfg.token },
    });
    if (!res.ok) {
      throw new IspaceError(
        ERROR_CODES.ORCHESTRATOR_FAILED,
        `Dokploy ${procedure} 失败（HTTP ${res.status}）`,
      );
    }
    return (await res.json()) as T;
  }

  /** 找到（或创建）承载所有用户后端的项目，返回其 environmentId。 */
  private async ensureEnvironment(): Promise<string> {
    if (this.environmentId) return this.environmentId;
    const projectName = this.cfg.projectName ?? 'ispace-backends';

    interface Proj {
      name: string;
      environments?: { environmentId: string }[];
    }
    const projects = await this.get<Proj[]>('project.all');
    const found = projects.find((p) => p.name === projectName);
    const envId = found?.environments?.[0]?.environmentId;
    if (envId) {
      this.environmentId = envId;
      return envId;
    }

    const created = await this.call<{ environment: { environmentId: string } }>(
      'project.create',
      { name: projectName, description: 'ispace 用户自定义后端' },
    );
    this.environmentId = created.environment.environmentId;
    return this.environmentId;
  }

  async createBackendApp(spec: BackendAppSpec): Promise<BackendAppRef> {
    const environmentId = await this.ensureEnvironment();
    // appName 是 Dokploy 内部的容器名前缀，必须全局唯一且只含安全字符
    const appName = `ispace-${spec.username}-${spec.name}`.replace(/[^a-z0-9-]/g, '-');

    const r = await this.call<{ applicationId: string }>('application.create', {
      name: `${spec.username}/${spec.name}`,
      appName,
      environmentId,
      ...(spec.sourceRepo ? { description: spec.sourceRepo } : {}),
    });

    const ref: BackendAppRef = {
      id: r.applicationId,
      urlPath: backendUrlPath(spec.username, spec.name),
      containerName: appName,
    };

    // 建完立刻写限额。放在 createBackendApp 内部而非交给调用方——
    // 一旦漏调，该后端就没有任何资源上限，能拖垮同机其他服务。
    await this.setLimits(ref, {
      cpu: DEFAULT_QUOTAS.backendCpuLimit,
      memoryMb: DEFAULT_QUOTAS.backendMemLimitMb,
    });

    return ref;
  }

  /**
   * 配置源并部署。字段名与必填项都是对着真实 API 的报错试出来的：
   *
   *   application.saveDockerProvider { applicationId, dockerImage,
   *                                    username, password, registryUrl }
   *   application.saveGitProvider    { applicationId, customGitUrl,
   *                                    customGitBranch, customGitBuildPath, watchPaths }
   *   application.saveBuildType      { applicationId, buildType, dockerfile,
   *                                    dockerContextPath, dockerBuildStage, ... }
   *   application.deploy             { applicationId }
   *
   * 这几项即使不用也**必须传**（哪怕是 null）——zod 那边是必填校验，
   * 少一个就整条 400，而报错只说"Input validation failed"。
   */
  async deploySource(ref: BackendAppRef, sourceRepo: string): Promise<void> {
    if (detectSourceKind(sourceRepo) === 'image') {
      await this.call('application.saveDockerProvider', {
        applicationId: ref.id,
        dockerImage: sourceRepo.trim(),
        // 只支持公开镜像。私有仓库要凭据，而把用户的 registry 密码收进
        // 平台是另一件需要单独设计的事（存哪、谁能看、怎么轮换）。
        username: null,
        password: null,
        registryUrl: null,
      });
    } else {
      await this.call('application.saveGitProvider', {
        applicationId: ref.id,
        customGitUrl: sourceRepo.trim(),
        // 不写死 main：越来越多仓库仍用 master，写死会让一半仓库拉不到。
        // 留空让 Dokploy 用远端默认分支。
        customGitBranch: null,
        customGitBuildPath: '/',
        watchPaths: null,
      });
      /*
        git 源要显式说怎么构建。nixpacks 能自动识别绝大多数技术栈
        （Node / Python / Go / Java …），比要求用户自己写 Dockerfile
        更符合"同事随手做个小工具"这个场景。
        仓库里有 Dockerfile 时 nixpacks 也会优先用它。
      */
      await this.call('application.saveBuildType', {
        applicationId: ref.id,
        buildType: 'nixpacks',
        dockerfile: null,
        dockerContextPath: null,
        dockerBuildStage: null,
        herokuVersion: null,
        railpackVersion: null,
      });
    }

    // 真正让它跑起来。少了这一步，前面配的东西全是摆设——
    // 应用会一直停在 idle，而界面显示"已停止"。
    await this.call('application.deploy', { applicationId: ref.id });
  }

  async bindPath(ref: BackendAppRef, host: string, path: string, port: number): Promise<void> {
    await this.call('domain.create', {
      applicationId: ref.id,
      host,
      path,
      port,
      https: false,
      domainType: 'application',
      /*
        ⚠️ stripPath 必须为 true，且这一项**不传就是 false**。

        不剥前缀时，Traefik 把完整的 /svc/{user}/{app}/... 原样转给容器，
        而容器里的应用监听的是自己的 /。表现是：容器起来了、平台显示
        "运行中"、Traefik 路由也命中了，访问却 404——而且那个 404 是
        应用自己给的，看起来完全不像路由问题。查这个花了不少时间。

        internalPath 显式给 /：容器侧的挂载点就是根。
      */
      stripPath: true,
      internalPath: '/',
    });
  }

  async setLimits(ref: BackendAppRef, limits: ResourceLimits): Promise<void> {
    await this.call('application.update', {
      applicationId: ref.id,
      // Dokploy v0.29.14 起，cpuLimit 是**裸 NanoCPU**（1 核 = 1e9），不再是核数
      // 字符串。传 "0.5" 会被当成 0.5 纳核 ≈ 0，容器被饿死却不报错——它照常起来、
      // 平台显示"运行中"，只是慢得像死了。核数 × 1e9 转过去；实测一个 2 核应用
      // 在库里正是存成 "2000000000"。
      // ResourceLimits.cpu 仍保持核数（人类单位，UI 显示「0.5 vCPU」），只在这条
      // 出线处换算，别的地方不受影响。
      cpuLimit: String(Math.round(limits.cpu * 1e9)),
      // memoryLimit 一直是字节数的字符串，这个改动没动它。传 MB 数字会让限额
      // 变成荒谬的小值。
      memoryLimit: String(limits.memoryMb * 1024 * 1024),
    });
  }

  async getStatus(ref: BackendAppRef): Promise<BackendStatus> {
    try {
      const a = await this.get<{ applicationStatus?: string }>('application.one', {
        applicationId: ref.id,
      });
      /*
        Dokploy 的状态语义：
          running  正在部署中   → 我们的 creating
          done     部署完成      → running
          error    部署失败      → failed
          idle     没在跑

        idle 是有歧义的：既可能是"从没部署过"，也可能是"停了"。
        我们在创建时一定会触发部署，所以创建之后短暂的 idle 会很快变成
        running；持续 idle 才是真的停了。这里如实返回 stopped，
        由服务层用自己的 status 决定要不要覆盖（见 services/backend.ts）。
      */
      switch (a.applicationStatus) {
        case 'done': return 'running';
        case 'running': return 'creating';
        case 'error': return 'failed';
        case 'idle': return 'stopped';
        default: return 'creating';
      }
    } catch {
      return 'failed';
    }
  }

  /**
   * 读最近一次部署的日志。
   *
   * Dokploy 没有取日志内容的 HTTP 接口（它的界面走 websocket），但
   * deployment.all 会给出 logPath，而那个目录以只读方式挂进了本容器。
   * 直接读文件比复刻它的 websocket 协议稳当得多。
   *
   * 路径来自 Dokploy 自己的数据，仍然要卡在约定目录内：万一那边的数据
   * 被污染，这里就成了一个任意文件读取。
   */
  async deployLog(ref: BackendAppRef, lines = 40): Promise<string | null> {
    try {
      const deployments = await this.get<{ logPath?: string | null }[]>(
        'deployment.all', { applicationId: ref.id },
      );
      const logPath = deployments?.[0]?.logPath;
      if (!logPath) return null;
      const resolved = resolvePath(logPath);
      if (!resolved.startsWith(`${DOKPLOY_LOG_ROOT}/`)) return null;
      const text = await readFile(resolved, 'utf8');
      const tail = text.trimEnd().split('\n').slice(-lines).join('\n');
      return tail || null;
    } catch {
      // 日志读不到不该让「查看原因」这个动作报错——界面退回通用提示
      return null;
    }
  }

  async restart(ref: BackendAppRef): Promise<void> {
    await this.call('application.reload', { applicationId: ref.id, appName: '' });
  }

  async remove(ref: BackendAppRef): Promise<void> {
    await this.call('application.delete', { applicationId: ref.id });
  }
}

// ── Mock ──────────────────────────────────────────────────────────────

/**
 * 本地开发与单测用。
 *
 * 不是占位：开发机没装 Docker，这是唯一能在本地跑通"建后端 → 绑路径 →
 * 写限额 → 查状态"整条逻辑的路径。它也用于断言"限额一定被写入"这类不变量。
 */
export class MockOrchestrator implements Orchestrator {
  readonly name = 'mock';

  readonly apps = new Map<
    string,
    {
      spec: BackendAppSpec; limits?: ResourceLimits; bindings: string[];
      status: BackendStatus;
      /** 断言"源真的被配置了"——这正是线上漏掉的那一步。 */
      source?: { kind: 'git' | 'image'; value: string };
    }
  >();

  private seq = 0;

  async createBackendApp(spec: BackendAppSpec): Promise<BackendAppRef> {
    const id = `mock-${++this.seq}`;
    this.apps.set(id, { spec, bindings: [], status: 'creating' });
    const ref: BackendAppRef = {
      id,
      urlPath: backendUrlPath(spec.username, spec.name),
      containerName: `mock-${spec.username}-${spec.name}`,
    };
    // 与 Dokploy 实现保持一致：建完即写限额
    await this.setLimits(ref, {
      cpu: DEFAULT_QUOTAS.backendCpuLimit,
      memoryMb: DEFAULT_QUOTAS.backendMemLimitMb,
    });
    return ref;
  }

  async deploySource(ref: BackendAppRef, sourceRepo: string): Promise<void> {
    const a = this.apps.get(ref.id);
    if (!a) throw new IspaceError(ERROR_CODES.NOT_FOUND, `mock 应用不存在：${ref.id}`);
    a.source = { kind: detectSourceKind(sourceRepo), value: sourceRepo };
    // 与真实编排器一致：部署触发后进入"构建中"，而不是立刻 running
    a.status = 'creating';
  }

  async bindPath(ref: BackendAppRef, host: string, path: string): Promise<void> {
    const a = this.apps.get(ref.id);
    if (!a) throw new IspaceError(ERROR_CODES.NOT_FOUND, `mock 应用不存在：${ref.id}`);
    a.bindings.push(`${host}${path}`);
  }

  async setLimits(ref: BackendAppRef, limits: ResourceLimits): Promise<void> {
    const a = this.apps.get(ref.id);
    if (!a) throw new IspaceError(ERROR_CODES.NOT_FOUND, `mock 应用不存在：${ref.id}`);
    a.limits = limits;
  }

  async getStatus(ref: BackendAppRef): Promise<BackendStatus> {
    return this.apps.get(ref.id)?.status ?? 'failed';
  }

  async deployLog(ref: BackendAppRef): Promise<string | null> {
    return this.apps.get(ref.id) ? '（mock 编排器没有部署日志）' : null;
  }

  async restart(ref: BackendAppRef): Promise<void> {
    const a = this.apps.get(ref.id);
    if (a) a.status = 'running';
  }

  async remove(ref: BackendAppRef): Promise<void> {
    this.apps.delete(ref.id);
  }
}

/** 按环境变量选实现。缺 Dokploy 配置时回落 Mock，本地开发无需额外设置。 */
export function createOrchestrator(env: NodeJS.ProcessEnv = process.env): Orchestrator {
  if (env.DOKPLOY_URL && env.DOKPLOY_TOKEN) {
    return new DokployOrchestrator({
      baseUrl: env.DOKPLOY_URL,
      token: env.DOKPLOY_TOKEN,
      ...(env.DOKPLOY_PROJECT ? { projectName: env.DOKPLOY_PROJECT } : {}),
    });
  }
  return new MockOrchestrator();
}
