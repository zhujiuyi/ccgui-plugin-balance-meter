/**
 * Claude Code 订阅（OAuth 登录）余量查询。
 *
 * 官方 CLI 没有稳定可脚本化的用量子命令，内部走的是
 * `GET /api/oauth/usage`（见本机 claude-code 2.1.272 二进制内的
 * `fetchUtilization` 实现），因此这里按同一口径直连该内部接口：
 *   - 凭证：`~/.claude/.credentials.json` 的 `claudeAiOauth.accessToken`
 *   - 请求头：Bearer 令牌 + `anthropic-beta: oauth-2025-04-20`
 *   - 响应：`five_hour` / `seven_day` 两个窗口（utilization 0–1、resets_at 秒级纪元）
 *
 * ⚠️ 属未公开接口，CLI 升级可能失效：界面标注「实验性」，失败按普通错误提示。
 * 令牌只进 curl 参数，不写日志、不写插件存储、不进错误文案。
 */

import type { PluginContext } from "./ccgui-plugin";
import { httpGet, readLocalFile } from "./exec";
import { joinPath } from "./routes";

export interface ClaudeOauthWindow {
  /** 固定时长窗口：five_hour = 300，seven_day = 10080。 */
  durationMins: number;
  /** 已用百分比（0–100，由 0–1 的 utilization 换算）。 */
  usedPercent: number;
  resetsAtMs: number | null;
}

/** 已知窗口 → 固定时长（分钟）。未知键忽略，避免把模型级窗口混进来。 */
const WINDOW_DURATIONS: Array<[key: string, durationMins: number]> = [
  ["five_hour", 300],
  ["seven_day", 10_080],
];

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseResetsAt(value: unknown): number | null {
  // 二进制里该字段按秒级纪元使用（resets_at*1000 > Date.now()）；防御式兼容
  // ISO-8601 字符串，接口迭代时不会整段解析失败。
  const seconds = finiteNumber(value);
  if (seconds !== null) return seconds * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export interface ClaudeOauthCredentials {
  accessToken: string;
  /** 毫秒级过期时间；文件缺该字段时为 null（不做本地过期判断）。 */
  expiresAtMs: number | null;
  subscriptionType: string | null;
}

/** 解析 `~/.claude/.credentials.json`（形状见官方 CLI 的 `claudeAiOauth` 段）。 */
export function parseClaudeCredentials(json: string): ClaudeOauthCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return null;
  const row = oauth as Record<string, unknown>;
  const accessToken = typeof row.accessToken === "string" ? row.accessToken.trim() : "";
  if (!accessToken) return null;
  const subscriptionType =
    typeof row.subscriptionType === "string" && row.subscriptionType.trim() !== ""
      ? row.subscriptionType.trim()
      : null;
  return { accessToken, expiresAtMs: finiteNumber(row.expiresAt), subscriptionType };
}

export function parseClaudeOauthUsage(body: string): ClaudeOauthWindow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;

  const windows: ClaudeOauthWindow[] = [];
  for (const [key, durationMins] of WINDOW_DURATIONS) {
    const row = root[key];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const utilization = finiteNumber((row as Record<string, unknown>).utilization);
    if (utilization === null) continue;
    windows.push({
      durationMins,
      usedPercent: Math.max(0, Math.min(100, utilization * 100)),
      resetsAtMs: parseResetsAt((row as Record<string, unknown>).resets_at),
    });
  }
  return windows.length > 0 ? windows : null;
}

export type ClaudeOauthErrorKind = "missing" | "expired" | "unauthorized" | "http" | "invalid";

export interface ClaudeOauthResult {
  windows: ClaudeOauthWindow[] | null;
  /** 订阅类型（pro / max / team / enterprise），界面据此显示计划名。 */
  planType: string | null;
  error: ClaudeOauthErrorKind | null;
  /** 诊断细节（只有状态码等非敏感信息；令牌绝不进入此处）。 */
  detail: string | null;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * 读 OAuth 凭证并查询订阅余量。
 * 令牌过期时**不发请求**：刷新令牌由 CLI 负责，插件代刷会轮换 refresh token、
 * 破坏 CLI 的登录状态，因此只提示用户重新登录。
 */
export async function readClaudeOauthUsage(
  ctx: PluginContext,
  home: string,
): Promise<ClaudeOauthResult> {
  // 路径是 `~/.claude/.credentials.json`（点开头；API key 模式下该文件不存在）。
  const credentialsJson = await readLocalFile(ctx, joinPath(home, ".claude", ".credentials.json"));
  const credentials = credentialsJson ? parseClaudeCredentials(credentialsJson) : null;
  if (!credentials) {
    return { windows: null, planType: null, error: "missing", detail: null };
  }
  const planType = credentials.subscriptionType;
  if (credentials.expiresAtMs !== null && credentials.expiresAtMs <= Date.now()) {
    return { windows: null, planType, error: "expired", detail: null };
  }

  const response = await httpGet(ctx, USAGE_URL, {
    Authorization: `Bearer ${credentials.accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
  });
  if (response.status === 401 || response.status === 403) {
    return { windows: null, planType, error: "unauthorized", detail: `HTTP ${response.status}` };
  }
  if (response.status !== 200) {
    return {
      windows: null,
      planType,
      error: "http",
      detail: `HTTP ${response.status || "?"}`,
    };
  }
  const windows = parseClaudeOauthUsage(response.body);
  if (!windows) {
    return { windows: null, planType, error: "invalid", detail: null };
  }
  return { windows, planType, error: null, detail: null };
}
