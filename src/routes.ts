/**
 * 路由解析：算出"当前每个引擎实际在用的网关地址 + 凭证"。
 *
 * 数据来源（按 ccgui 的存储口径）：
 *  - `~/.ccgui-next/config.json`：`<engine>.providers`（自定义渠道，含 baseUrl/apiKey）
 *    与 `<engine>.current`。`current === "__local_settings_json__"` 表示当前用的是
 *    该引擎自己的本地配置，需要进一步读 CLI 配置文件。
 *  - claude → `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
 *  - codex  → `~/.codex/config.toml` 的 `base_url`，密钥取 `~/.codex/auth.json`
 */

import type { PluginContext } from "./ccgui-plugin";
import { readLocalFile } from "./exec";

export interface RouteInfo {
  engine: string;
  /** 完整网关地址（可能带路径，如 https://api.deepseek.com/anthropic） */
  gateway: string;
  /** scheme://host */
  origin: string;
  /** 路由键：host + 路径前缀（去尾斜杠），用于缓存"该路由可用的查询地址" */
  routeKey: string;
  /** ccgui 里该渠道的显示名（本地配置路由为 null） */
  providerHint: string | null;
  credential: string | null;
  credentialSource: string;
  source: string;
  /**
   * 查询通道：
   *  - http：供应商余额接口（含中转探测）
   *  - codex-rate-limits：Codex 官方 app-server 的 ChatGPT 订阅额度
   *  - claude-oauth-usage：Claude 订阅 OAuth 的内部用量接口（实验性）
   *  - kimi-usage / zhipu-quota / minimax-plan / grok-billing：编程套餐额度
   */
  queryKind:
    | "http"
    | "codex-rate-limits"
    | "claude-oauth-usage"
    | "kimi-usage"
    | "zhipu-quota"
    | "minimax-plan"
    | "grok-billing";
}

export const LOCAL_SETTINGS_SENTINEL = "__local_settings_json__";

export function originOf(gateway: string): string {
  try {
    const url = new URL(gateway);
    return `${url.protocol}//${url.host}`;
  } catch {
    return gateway.replace(/\/+$/, "");
  }
}

export function routeKeyOf(gateway: string): string {
  try {
    const url = new URL(gateway);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.hostname.toLowerCase()}${path}`;
  } catch {
    return gateway.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * 拼配置路径：**跟随 home 自身的分隔符风格**——Windows 家目录是
 * `C:\Users\x` 就继续用 `\`（curl 侧由 readLocalFile 换成 `/` 再进 file:// URL），
 * macOS/Linux 的 `/Users/x`、`/home/x` 自然用 `/`。
 * 早先无条件用 `\`，在 macOS/Linux 上会拼出 `\\.claude\\settings.json` 这种废路径。
 */
export function joinPath(home: string, ...parts: string[]): string {
  const base = home.replace(/[\\/]+$/, "");
  return [base, ...parts].join(base.includes("\\") ? "\\" : "/");
}

async function readJson(
  ctx: PluginContext,
  path: string,
): Promise<Record<string, unknown> | null> {
  const text = await readLocalFile(ctx, path);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readText(ctx: PluginContext, path: string): Promise<string | null> {
  return readLocalFile(ctx, path);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface LocalRoute {
  gateway: string | null;
  credential: string | null;
  credentialSource: string;
  source: string;
  queryKind?: RouteInfo["queryKind"];
}

async function readClaudeLocal(ctx: PluginContext, home: string): Promise<LocalRoute> {
  const path = joinPath(home, ".claude", "settings.json");
  const json = await readJson(ctx, path);
  const env = record(json?.env) ?? {};
  const gateway = str(env.ANTHROPIC_BASE_URL);
  const credential = str(env.ANTHROPIC_AUTH_TOKEN) ?? str(env.ANTHROPIC_API_KEY);

  // 既没有自定义网关也没有 API key 时，Claude Code 走的是订阅 OAuth 登录
  // （凭证在 ~/.claude/.credentials.json）。余量由内部 OAuth 用量接口提供，
  // 与供应商余额接口是两条通道，故单独标记 queryKind。
  if (!gateway && !credential) {
    const credentialsPath = joinPath(home, ".claude", ".credentials.json");
    const credentials = await readJson(ctx, credentialsPath);
    if (str(record(credentials?.claudeAiOauth)?.accessToken)) {
      return {
        gateway: "https://api.anthropic.com",
        credential: null,
        credentialSource: `${credentialsPath} → claudeAiOauth`,
        source: credentialsPath,
        queryKind: "claude-oauth-usage",
      };
    }
  }

  return {
    gateway,
    credential,
    credentialSource: `${path} → env.ANTHROPIC_AUTH_TOKEN`,
    source: path,
  };
}

async function readCodexLocal(ctx: PluginContext, home: string): Promise<LocalRoute> {
  const tomlPath = joinPath(home, ".codex", "config.toml");
  const toml = (await readText(ctx, tomlPath)) ?? "";
  const match = /base_url\s*=\s*"([^"]+)"/.exec(toml);
  const authPath = joinPath(home, ".codex", "auth.json");
  const auth = await readJson(ctx, authPath);
  const authMode = str(auth?.auth_mode)?.toLowerCase() ?? null;
  const tokens = record(auth?.tokens);
  const accessToken = str(tokens?.access_token);
  const apiKey = str(auth?.OPENAI_API_KEY) ?? str(auth?.openai_api_key);
  const credential =
    apiKey ?? accessToken;

  // 官方 ChatGPT 登录不会在 config.toml 写 base_url。此时路由不是缺失，
  // 而是由 Codex 自己管理的订阅通道；余量通过官方 app-server 查询。
  if (!match && authMode === "chatgpt" && accessToken) {
    return {
      gateway: "https://chatgpt.com",
      credential: null,
      credentialSource: `${authPath} → ChatGPT 登录缓存`,
      source: authPath,
      queryKind: "codex-rate-limits",
    };
  }

  return {
    gateway: match ? match[1] : apiKey ? "https://api.openai.com/v1" : null,
    credential,
    credentialSource: apiKey
      ? `${authPath} → OPENAI_API_KEY`
      : credential
        ? `${authPath} → ChatGPT access token`
        : `${authPath}（未找到凭证）`,
    source: tomlPath,
  };
}

/** Kimi Code CLI 登录：凭证在 `~/.kimi-code/credentials/kimi-code.json`（旧版 `~/.kimi`）。 */
async function readKimiLocal(ctx: PluginContext, home: string): Promise<LocalRoute> {
  for (const dir of [".kimi-code", ".kimi"]) {
    const path = joinPath(home, dir, "credentials", "kimi-code.json");
    const json = await readJson(ctx, path);
    if (str(json?.access_token)) {
      return {
        gateway: "https://api.kimi.com",
        credential: null,
        credentialSource: `${path} → access_token`,
        source: path,
        queryKind: "kimi-usage",
      };
    }
  }
  return {
    gateway: null,
    credential: null,
    credentialSource: "",
    source: joinPath(home, ".kimi-code", "credentials", "kimi-code.json"),
  };
}

/** Grok CLI 登录：凭证在 `~/.grok/auth.json`（取第一条带 key 的条目）。 */
async function readGrokLocal(ctx: PluginContext, home: string): Promise<LocalRoute> {
  const path = joinPath(home, ".grok", "auth.json");
  const json = await readJson(ctx, path);
  const hasToken = json
    ? Object.values(json).some((value) => str(record(value)?.key))
    : false;
  if (hasToken) {
    return {
      gateway: "https://cli-chat-proxy.grok.com",
      credential: null,
      credentialSource: `${path} → auth.json`,
      source: path,
      queryKind: "grok-billing",
    };
  }
  return { gateway: null, credential: null, credentialSource: "", source: path };
}

const LOCAL_READERS: Record<string, (ctx: PluginContext, home: string) => Promise<LocalRoute>> = {
  claude: readClaudeLocal,
  codex: readCodexLocal,
  kimi: readKimiLocal,
  grok: readGrokLocal,
};

/**
 * 网关命中已知编程套餐渠道时，把默认的 http 探测换成对应额度适配器。
 * 路径/主机名依据各家官方或上游实现（见 coding-plans.ts 文件头）。
 */
function codingPlanQueryKindFor(gateway: string): RouteInfo["queryKind"] | null {
  try {
    const url = new URL(gateway);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (host === "api.kimi.com" && path.startsWith("/coding")) return "kimi-usage";
    if (host === "open.bigmodel.cn" || host === "bigmodel.cn" || host === "api.z.ai" || host === "z.ai") {
      return "zhipu-quota";
    }
    if (host === "api.minimaxi.com" || host === "api.minimax.io") return "minimax-plan";
    return null;
  } catch {
    return null;
  }
}

function toRoute(
  engine: string,
  gateway: string,
  credential: string | null,
  credentialSource: string,
  source: string,
  providerHint: string | null,
  queryKind: RouteInfo["queryKind"] = "http",
): RouteInfo {
  return {
    engine,
    gateway: gateway.replace(/\/+$/, ""),
    origin: originOf(gateway),
    routeKey: routeKeyOf(gateway),
    providerHint,
    credential,
    credentialSource,
    source,
    queryKind: queryKind === "http" ? (codingPlanQueryKindFor(gateway) ?? queryKind) : queryKind,
  };
}

export interface RouteResolution {
  routes: RouteInfo[];
  diagnostics: string[];
}

/**
 * 解析所有引擎的在用路由。ccgui 配置读不到时，退回只读 CLI 本地配置
 * （claude / codex），保证插件在最小环境下也能工作。
 */
export async function resolveRoutes(
  ctx: PluginContext,
  home: string | null,
): Promise<RouteResolution> {
  const diagnostics: string[] = [];
  const routes: RouteInfo[] = [];
  if (!home) {
    diagnostics.push("未探测到用户目录，无法读取配置");
    return { routes, diagnostics };
  }

  const ccguiPath = joinPath(home, ".ccgui-next", "config.json");
  const ccgui = await readJson(ctx, ccguiPath);
  if (!ccgui) diagnostics.push(`读取失败或不存在：${ccguiPath}`);

  const engines = ccgui
    ? Object.keys(ccgui)
    : Object.keys(LOCAL_READERS);

  for (const engine of engines) {
    const engineCfg = record(ccgui?.[engine]);
    const current = str(engineCfg?.current);
    const providers = record(engineCfg?.providers);

    // 1) ccgui 自定义渠道
    if (current && current !== LOCAL_SETTINGS_SENTINEL && providers) {
      const provider = record(providers[current]);
      const gateway = str(provider?.baseUrl);
      if (gateway) {
        routes.push(
          toRoute(
            engine,
            gateway,
            str(provider?.apiKey),
            `${ccguiPath} → providers.${current}.apiKey`,
            `${ccguiPath}（渠道 ${str(provider?.name) ?? current}）`,
            str(provider?.name),
          ),
        );
        continue;
      }
      diagnostics.push(`${engine}: 渠道 ${current} 缺少 baseUrl`);
    }

    // 2) 引擎本地配置
    const reader = LOCAL_READERS[engine];
    if (!reader) {
      if (current === LOCAL_SETTINGS_SENTINEL) {
        diagnostics.push(`${engine}: 使用本地配置，但本插件暂不支持读取该引擎的配置文件`);
      }
      continue;
    }
    const local = await reader(ctx, home);
    if (local.gateway) {
      routes.push(
        toRoute(
          engine,
          local.gateway,
          local.credential,
          local.credentialSource,
          local.source,
          null,
          local.queryKind,
        ),
      );
    } else {
      diagnostics.push(`${engine}: 未从 ${local.source} 读到网关地址`);
    }
  }

  return { routes, diagnostics };
}
