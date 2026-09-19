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
function joinPath(home: string, ...parts: string[]): string {
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
}

async function readClaudeLocal(ctx: PluginContext, home: string): Promise<LocalRoute> {
  const path = joinPath(home, ".claude", "settings.json");
  const json = await readJson(ctx, path);
  const env = record(json?.env) ?? {};
  return {
    gateway: str(env.ANTHROPIC_BASE_URL),
    credential: str(env.ANTHROPIC_AUTH_TOKEN) ?? str(env.ANTHROPIC_API_KEY),
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
  const credential =
    str(auth?.OPENAI_API_KEY) ??
    str(auth?.openai_api_key) ??
    str(record(auth?.tokens)?.access_token);
  return {
    gateway: match ? match[1] : null,
    credential,
    credentialSource: credential ? `${authPath} → OPENAI_API_KEY` : `${authPath}（未找到密钥）`,
    source: tomlPath,
  };
}

const LOCAL_READERS: Record<string, (ctx: PluginContext, home: string) => Promise<LocalRoute>> = {
  claude: readClaudeLocal,
  codex: readCodexLocal,
};

function toRoute(
  engine: string,
  gateway: string,
  credential: string | null,
  credentialSource: string,
  source: string,
  providerHint: string | null,
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
        toRoute(engine, local.gateway, local.credential, local.credentialSource, local.source, null),
      );
    } else {
      diagnostics.push(`${engine}: 未从 ${local.source} 读到网关地址`);
    }
  }

  return { routes, diagnostics };
}
