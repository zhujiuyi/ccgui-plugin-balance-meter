/**
 * 编程套餐（订阅制渠道）额度查询。
 *
 * 覆盖四家：Kimi For Coding、智谱 GLM / Z.AI、MiniMax、xAI Grok。
 * 与 codex / claude 两条通道的差别：这几家都是普通 HTTP 接口，凭证来自
 * 路由配置（API key）或各自 CLI 的本地登录文件，因此统一放在一个模块里，
 * 共用同一份结果契约：
 *
 *   { windows: QuotaWindow[] | null, planType, error, detail }
 *
 * 口径与既有渠道一致：只读查询、不代刷新令牌、令牌不进日志与错误文案；
 * 窗口一律结构化（禁止拼字符串），由界面逐项本地化渲染。
 *
 * 实现依据（逐条对照过上游实现，非猜测）：
 *  - Kimi：MoonshotAI/kimi-cli 与 farion1231/cc-switch 的 /coding/v1/usages
 *  - 智谱：cc-switch 的 /api/monitor/usage/quota/limit（unit=3 → 5h，unit=6 → 周）
 *  - MiniMax：cc-switch 的 /v1/api/openplatform/coding_plan/remains
 *  - Grok：tokentracker-cli 的 cli-chat-proxy /v1/billing?format=credits
 */

import type { PluginContext } from "./ccgui-plugin";
import { httpGet, readLocalFile } from "./exec";
import type { QuotaWindow } from "./providers";
import { joinPath } from "./routes";

export type PlanErrorKind =
  | "missing"
  | "expired"
  | "unauthorized"
  | "http"
  | "invalid"
  | "business";

export interface PlanQuota {
  windows: QuotaWindow[] | null;
  planType: string | null;
  error: PlanErrorKind | null;
  /** 诊断细节（状态码等非敏感信息；令牌绝不进入此处）。 */
  detail: string | null;
}

/* ────────────────────────── 通用解析工具 ────────────────────────── */

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** 重置时间：兼容秒级/毫秒级纪元与 ISO 字符串（三家口径不完全一致）。 */
function resetAtMs(value: unknown): number | null {
  const raw = finiteNumber(value);
  if (raw !== null) {
    if (raw <= 0) return null;
    return raw < 1_000_000_000_000 ? raw * 1000 : raw;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function window(
  kind: QuotaWindow["kind"],
  usedPercent: number,
  resetAt: number | null,
  durationMins?: number | null,
): QuotaWindow {
  const used = clampPercent(usedPercent);
  return {
    kind,
    ...(kind === "duration" ? { durationMins: durationMins ?? null } : {}),
    used,
    remaining: clampPercent(100 - used),
    resetAt,
  };
}

/** 由 限额/已用/剩余 三个字段算出已用百分比（缺谁补谁）。 */
function usedPercentFrom(limit: number | null, used: number | null, remaining: number | null): number | null {
  if (limit !== null && limit > 0) {
    if (used !== null) return (used / limit) * 100;
    if (remaining !== null) return ((limit - remaining) / limit) * 100;
    return null;
  }
  return null;
}

/* ────────────────────────── Kimi For Coding ────────────────────────── */

/**
 * `GET https://api.kimi.com/coding/v1/usages`
 * 凭证：路由 API key（Bearer）或 Kimi Code CLI 登录令牌。
 * 窗口：`limits[].detail` = 5 小时窗口；`usage` = 周窗口。
 */
export function parseKimiUsage(body: string): Pick<PlanQuota, "windows" | "planType"> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root) return null;

  const windows: QuotaWindow[] = [];

  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const item of limits) {
    const row = record(item);
    const detail = record(row?.detail) ?? row;
    if (!detail) continue;
    const usedPercent = usedPercentFrom(
      finiteNumber(detail.limit),
      finiteNumber(detail.used),
      finiteNumber(detail.remaining),
    );
    if (usedPercent === null) continue;
    const reset = resetAtMs(detail.resetTime ?? detail.reset_at ?? detail.resetAt);
    windows.push(window("duration", usedPercent, reset, 300));
    break; // 只取第一条（官方口径：5 小时窗口只有一条）
  }

  const usage = record(root.usage);
  if (usage) {
    const usedPercent = usedPercentFrom(
      finiteNumber(usage.limit),
      finiteNumber(usage.used),
      finiteNumber(usage.remaining),
    );
    if (usedPercent !== null) {
      windows.push(window("weekly", usedPercent, resetAtMs(usage.resetTime ?? usage.reset_at ?? usage.resetAt)));
    }
  }

  if (windows.length === 0) return null;
  const subType = typeof root.subType === "string" && root.subType.trim() !== "" ? root.subType.trim() : null;
  return { windows, planType: subType };
}

/* ────────────────────────── 智谱 GLM / Z.AI ────────────────────────── */

/**
 * `GET {origin}/api/monitor/usage/quota/limit`（Authorization 为裸 key，无 Bearer）。
 * 窗口：TOKENS_LIMIT/CREDIT_LIMIT 且 unit=3 → 5 小时；unit=6 → 每周；
 * unit 缺失时按重置时间升序补空位（老套餐形态）。percentage 即已用百分比。
 */
export function parseZhipuQuota(body: string): Pick<PlanQuota, "windows" | "planType"> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root) return null;
  if (root.success === false) return null;
  const data = record(root.data);
  if (!data) return null;

  interface Entry {
    resetAt: number | null;
    usedPercent: number;
  }
  let fiveHour: Entry | null = null;
  let weekly: Entry | null = null;
  const unclassified: Entry[] = [];

  const limits = Array.isArray(data.limits) ? data.limits : [];
  for (const item of limits) {
    const row = record(item);
    if (!row) continue;
    const type = typeof row.type === "string" ? row.type.toUpperCase() : "";
    if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue;
    const usedPercent = finiteNumber(row.percentage);
    if (usedPercent === null) continue;
    const entry: Entry = {
      resetAt: resetAtMs(row.nextResetTime ?? row.next_reset_time),
      usedPercent,
    };
    const unit = finiteNumber(row.unit);
    if (unit === 3 && fiveHour === null) fiveHour = entry;
    else if (unit === 6 && weekly === null) weekly = entry;
    else unclassified.push(entry);
  }

  unclassified.sort((a, b) => (a.resetAt ?? Number.MAX_SAFE_INTEGER) - (b.resetAt ?? Number.MAX_SAFE_INTEGER));
  for (const entry of unclassified) {
    if (fiveHour === null) fiveHour = entry;
    else if (weekly === null) weekly = entry;
  }

  const windows: QuotaWindow[] = [];
  if (fiveHour) windows.push(window("duration", fiveHour.usedPercent, fiveHour.resetAt, 300));
  if (weekly) windows.push(window("weekly", weekly.usedPercent, weekly.resetAt));
  if (windows.length === 0) return null;

  const level = typeof data.level === "string" && data.level.trim() !== "" ? data.level.trim() : null;
  return { windows, planType: level };
}

/* ────────────────────────── MiniMax ────────────────────────── */

/**
 * `GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`
 * （国际版 api.minimax.io，Bearer key）。
 * 响应给的是**剩余**百分比：5 小时桶 `current_interval_remaining_percent`，
 * 周桶 `current_weekly_remaining_percent`（仅 current_weekly_status=1 时有效）。
 */
export function parseMinimaxPlan(body: string): Pick<PlanQuota, "windows" | "planType"> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root) return null;
  const baseResp = record(root.base_resp);
  const statusCode = finiteNumber(baseResp?.status_code);
  if (statusCode !== null && statusCode !== 0) return null;

  const rows = Array.isArray(root.model_remains) ? root.model_remains : [];
  const general = rows.map(record).find((row) => row?.model_name === "general");
  if (!general) return null;

  const windows: QuotaWindow[] = [];
  const intervalRemaining = finiteNumber(general.current_interval_remaining_percent);
  if (intervalRemaining !== null) {
    windows.push(window("duration", 100 - intervalRemaining, resetAtMs(general.end_time), 300));
  }
  if (finiteNumber(general.current_weekly_status) === 1) {
    const weeklyRemaining = finiteNumber(general.current_weekly_remaining_percent);
    if (weeklyRemaining !== null) {
      windows.push(window("weekly", 100 - weeklyRemaining, resetAtMs(general.weekly_end_time)));
    }
  }
  if (windows.length === 0) return null;
  return { windows, planType: null };
}

/* ────────────────────────── xAI Grok（Grok CLI 登录） ────────────────────────── */

function grokKindFromType(value: unknown): QuotaWindow["kind"] | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const upper = value.toUpperCase();
  if (upper.includes("WEEK")) return "weekly";
  if (upper.includes("MONTH")) return "monthly";
  if (upper.includes("DAILY") || /(^|_)DAY($|_)/.test(upper)) return "duration";
  return null;
}

/** 类型缺失时按周期长度推断（1 天 / 7 天 / 自然月三档，与上游一致）。 */
function grokKindFromDates(startMs: number | null, endMs: number | null): QuotaWindow["kind"] | null {
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  const days = (endMs - startMs) / 86_400_000;
  if (days > 0.5 && days <= 1.5) return "duration";
  if (days > 1.5 && days <= 8) return "weekly";
  if (days >= 25 && days <= 35) return "monthly";
  return null;
}

/**
 * `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`（Bearer）。
 * 取 `config.creditUsagePercent` 为信用池已用百分比；缺失时依次尝试
 * `productUsage` 求和、旧版 `monthlyLimit/used`；窗口类型按
 * currentPeriod.type 判定，缺失时按起止日期推断。
 */
export function parseGrokBilling(body: string): Pick<PlanQuota, "windows" | "planType"> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = record(parsed);
  const config = record(root?.config);
  if (!config) return null;

  const period = record(config.currentPeriod);
  const startMs = resetAtMs(period?.start ?? config.billingPeriodStart);
  const endMs = resetAtMs(period?.end ?? config.billingPeriodEnd);

  let kind = grokKindFromType(period?.type) ?? grokKindFromDates(startMs, endMs);
  let usedPercent = finiteNumber(config.creditUsagePercent);

  if (usedPercent === null && Array.isArray(config.productUsage)) {
    let sum = 0;
    let sawAny = false;
    for (const entry of config.productUsage) {
      const pct = finiteNumber(record(entry)?.usagePercent);
      if (pct !== null) {
        sum += pct;
        sawAny = true;
      }
    }
    if (sawAny) usedPercent = sum;
  }

  if (usedPercent === null) {
    const limit = finiteNumber(config.monthlyLimit);
    const used = finiteNumber(config.used);
    if (limit !== null && limit > 0 && used !== null) {
      usedPercent = (used / limit) * 100;
      kind = kind ?? "monthly";
    }
  }

  // 统一计费口径下「本期未使用」会把用量字段整个省略；有周期但无字段 = 0%，不是解析失败。
  if (
    usedPercent === null &&
    period &&
    (startMs !== null || endMs !== null) &&
    config.creditUsagePercent === undefined &&
    config.productUsage === undefined
  ) {
    usedPercent = 0;
  }
  if (usedPercent === null) return null;

  const finalKind = kind ?? "rolling";
  const duration = finalKind === "duration" ? window("duration", usedPercent, endMs, 1440) : null;
  const primary: QuotaWindow = duration ?? window(finalKind, usedPercent, endMs);
  return { windows: [primary], planType: null };
}

/* ────────────────────────── 读函数 ────────────────────────── */

function missing(): PlanQuota {
  return { windows: null, planType: null, error: "missing", detail: null };
}

function fromParse(
  parsed: Pick<PlanQuota, "windows" | "planType"> | null,
): PlanQuota {
  if (!parsed || !parsed.windows) {
    return { windows: null, planType: null, error: "invalid", detail: null };
  }
  return { windows: parsed.windows, planType: parsed.planType, error: null, detail: null };
}

function fromStatus(status: number, ...parsers: Array<() => Pick<PlanQuota, "windows" | "planType"> | null>): PlanQuota {
  if (status === 401 || status === 403) {
    return { windows: null, planType: null, error: "unauthorized", detail: `HTTP ${status}` };
  }
  if (status !== 200) {
    return { windows: null, planType: null, error: "http", detail: `HTTP ${status || "?"}` };
  }
  for (const parse of parsers) {
    const parsed = parse();
    if (parsed?.windows?.length) return fromParse(parsed);
  }
  return { windows: null, planType: null, error: "invalid", detail: null };
}

/** Kimi Code CLI 凭证：`~/.kimi-code/credentials/kimi-code.json`（旧版 `~/.kimi`）。 */
function parseKimiCliCredentials(json: string): { accessToken: string; expired: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const row = record(parsed);
  const accessToken = typeof row?.access_token === "string" ? row.access_token.trim() : "";
  if (!accessToken) return null;
  // expires_at 为秒级纪元；无该字段时不做本地过期判断，交给服务端 401。
  const expiresAt = finiteNumber(row?.expires_at);
  const expired = expiresAt !== null && expiresAt > 0 && expiresAt * 1000 <= Date.now() + 30_000;
  return { accessToken, expired };
}

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

/**
 * 查询 Kimi For Coding 余量：优先用路由 API key（ccgui 渠道配置的密钥），
 * 没有 key 时退回 Kimi Code CLI 的登录令牌。令牌过期不代刷新，只提示重新登录。
 */
export async function readKimiQuota(
  ctx: PluginContext,
  home: string,
  apiKey: string | null,
): Promise<PlanQuota> {
  let token = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!token) {
    const credentialsJson =
      (await readLocalFile(ctx, joinPath(home, ".kimi-code", "credentials", "kimi-code.json"))) ??
      (await readLocalFile(ctx, joinPath(home, ".kimi", "credentials", "kimi-code.json")));
    const credentials = credentialsJson ? parseKimiCliCredentials(credentialsJson) : null;
    if (!credentials) return missing();
    if (credentials.expired) {
      return { windows: null, planType: null, error: "expired", detail: null };
    }
    token = credentials.accessToken;
  }

  const response = await httpGet(ctx, KIMI_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  });
  return fromStatus(response.status, () => parseKimiUsage(response.body));
}

const ZHIPU_QUOTA_PATH = "/api/monitor/usage/quota/limit";

/** 查询智谱 GLM / Z.AI 编码套餐额度（Authorization 为裸 key）。 */
export async function readZhipuQuota(
  ctx: PluginContext,
  origin: string,
  apiKey: string | null,
): Promise<PlanQuota> {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return missing();
  const base = origin.replace(/\/+$/, "");
  const response = await httpGet(ctx, `${base}${ZHIPU_QUOTA_PATH}`, {
    Authorization: key,
    "Content-Type": "application/json",
    "Accept-Language": "en-US,en",
  });
  return fromStatus(response.status, () => parseZhipuQuota(response.body));
}

const MINIMAX_PLAN_PATH = "/v1/api/openplatform/coding_plan/remains";

/** 查询 MiniMax 编程套餐余量（国内 api.minimaxi.com / 国际 api.minimax.io）。 */
export async function readMinimaxQuota(
  ctx: PluginContext,
  origin: string,
  apiKey: string | null,
): Promise<PlanQuota> {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return missing();
  const base = origin.replace(/\/+$/, "");
  const response = await httpGet(ctx, `${base}${MINIMAX_PLAN_PATH}`, {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  });
  return fromStatus(response.status, () => parseMinimaxPlan(response.body));
}

const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

/** Grok CLI 登录凭证：`~/.grok/auth.json`，取第一条带 `key` 的条目。 */
function parseGrokAuth(json: string): { accessToken: string; expired: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root) return null;
  for (const value of Object.values(root)) {
    const entry = record(value);
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    if (!key) continue;
    const expiresAt = typeof entry?.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
    const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
    return { accessToken: key, expired };
  }
  return null;
}

/** 查询 Grok（Grok CLI 登录）订阅信用池。令牌过期不代刷新，只提示重新登录。 */
export async function readGrokQuota(ctx: PluginContext, home: string): Promise<PlanQuota> {
  const authJson = await readLocalFile(ctx, joinPath(home, ".grok", "auth.json"));
  const auth = authJson ? parseGrokAuth(authJson) : null;
  if (!auth) return missing();
  if (auth.expired) {
    return { windows: null, planType: null, error: "expired", detail: null };
  }
  const response = await httpGet(ctx, GROK_BILLING_URL, {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
  });
  return fromStatus(response.status, () => parseGrokBilling(response.body));
}
