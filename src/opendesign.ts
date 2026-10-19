/**
 * Open Design（AMR / Vela）账户余额。
 *
 * 渠道网关 `amr-link.open-design.ai` 只是模型入口，账户余额属于 Open Design，
 * 不能向网关查。桌面客户端登录后把凭证写在 `~/.amr/config.json`：
 *
 *   profiles.<profile>.controlKey  → 账单接口的 Bearer
 *   profiles.<profile>.apiUrl      → 账单接口 origin（prod 为 amr-api.open-design.ai）
 *
 * 注意：渠道里配置的 `sk-amr-...` runtime key 只用于网关推理，账单接口实测 401，
 * 因此这里只认 controlKey；profile 按网关主机名挑选（prod / feature-test 等）。
 *
 * 接口：`GET {apiUrl}/api/v1/billing/summary`（Authorization: Bearer <controlKey>），
 * 口径与 Open Design 客户端「Vela billing summary」一致。
 */

import type { PluginContext } from "./ccgui-plugin";
import { httpGet, readLocalFile } from "./exec";
import type { PlanErrorKind } from "./coding-plans";
import type { ParsedAmount, QuotaWindow } from "./providers";
import { joinPath } from "./routes";

/** 订阅额度窗口（来自 coding plan 的 credit 桶）。 */
export interface OpenDesignPlan {
  windows: QuotaWindow[];
  planType: string | null;
  /** 实际扣费来源（coding_plan / wallet / gateway），不参与主显示。 */
  funding: string | null;
}

export interface OpenDesignResult {
  /** 有订阅时优先展示的套餐窗口；无订阅为 null。 */
  plan: OpenDesignPlan | null;
  /** 订阅窗口的实际查询地址（含工作区 id），用于面板展示。 */
  planEndpoint: string | null;
  /** 账户可用余额；无订阅时的主显示，也是订阅场景的附带信息。 */
  balance: ParsedAmount | null;
  endpoint: string | null;
  error: PlanErrorKind | null;
  /** 诊断细节（状态码等非敏感信息；controlKey 绝不进入此处）。 */
  detail: string | null;
}

export interface OpenDesignBilling extends ParsedAmount {
  /** 当前生效的订阅（tier + status）；无订阅为 null。 */
  subscription: { tier: string | null; status: string } | null;
}

interface OpenDesignProfile {
  /** 配置里的 profile 名（prod / test / feature-test / local）。 */
  profile: string;
  controlKey: string;
  apiUrl: string;
}

/* ────────────────────────── 解析工具 ────────────────────────── */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resetAtMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* ────────────────────────── 客户端配置 ────────────────────────── */

/**
 * 从 `~/.amr/config.json` 里挑出与当前网关匹配的 profile。
 *
 * 主机名映射依据客户端安装包里的 profile 表：
 * `amr-link.open-design.ai` → prod，`amr-feature-link.powerformer.net` → feature-test，
 * `amr-link.powerformer.net`（test）同样包含 `amr-link`。无法判断时按
 * prod → 第一个带 controlKey 的 profile 回退。
 */
export function parseOpenDesignConfig(json: string, gatewayHost: string): OpenDesignProfile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const profiles = record(record(parsed)?.profiles);
  if (!profiles) return null;

  const host = gatewayHost.toLowerCase();
  // 生产网关是 amr-link.open-design.ai；test（powerformer.net）与 feature-test 必须
  // 先于 prod 参与匹配，否则页面拿到的会是生产账号的余额。
  const preferred = host.includes("open-design.ai")
    ? ["prod", "test", "feature-test"]
    : host.includes("feature")
      ? ["feature-test", "test", "prod"]
      : ["test", "prod", "feature-test"];
  const ordered = [
    ...preferred.filter((name) => name in profiles),
    ...Object.keys(profiles).filter((name) => !preferred.includes(name)),
  ];

  for (const name of ordered) {
    const row = record(profiles[name]);
    const controlKey = str(row?.controlKey);
    if (!controlKey) continue;
    return {
      profile: name,
      controlKey,
      apiUrl: (str(row?.apiUrl) ?? "https://amr-api.open-design.ai").replace(/\/+$/, ""),
    };
  }
  return null;
}

/* ────────────────────────── 账单响应 ────────────────────────── */

/** 订阅是否在生效：`subscriptionStatus` 为 active 且没有标记即将取消。 */
function activeSubscription(root: Record<string, unknown>): { tier: string | null; status: string } | null {
  const status = str(root.subscriptionStatus)?.toLowerCase() ?? "";
  const entitlement = str(root.subscriptionEntitlementStatus)?.toLowerCase() ?? "";
  // 只有 active / trialing 才算有订阅；none / canceled / past_due 一律按无订阅展示余额。
  if (status !== "active" && status !== "trialing") return null;
  if (entitlement && entitlement !== "active" && entitlement !== "trialing") return null;
  const tier = str(root.membershipTier);
  return { tier, status };
}

/**
 * `GET /api/v1/billing/summary`：余额优先取 `totalAvailableCreditsUsd`
 * （订阅额度 + 充值额度），缺失时退回 `balanceUsd`，再退回按 `creditsPerUsd` 换算。
 * `membershipTier` 作为计划名展示（go / plus / pro / max）。
 * `subscription` 供调用方决定主显示走订阅窗口还是余额。
 */
export function parseOpenDesignBilling(body: string): OpenDesignBilling | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root) return null;

  const balances = record(root.balances);
  const perUsd = num(root.creditsPerUsd);
  let amount =
    num(root.totalAvailableCreditsUsd) ??
    num(root.balanceUsd) ??
    num(root.totalAvailableCredits) ??
    num(balances?.totalAvailableCredits);
  // 只有 credits 时按站点声明的兑换比率换算（默认 10000）。
  if (amount !== null && num(root.totalAvailableCreditsUsd) === null && num(root.balanceUsd) === null) {
    amount = amount / (perUsd !== null && perUsd > 0 ? perUsd : 10_000);
  }
  if (amount === null) return null;

  const subscriptionUsd = num(root.subscriptionCreditsUsd);
  const rechargeUsd = num(root.rechargeCreditsUsd);
  const detail =
    subscriptionUsd !== null || rechargeUsd !== null
      ? [
          subscriptionUsd !== null ? `订阅 $${subscriptionUsd.toFixed(2)}` : null,
          rechargeUsd !== null ? `充值 $${rechargeUsd.toFixed(2)}` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" + ")
      : null;

  const tier = str(root.membershipTier);
  return {
    kind: "balance",
    currency: "USD",
    amount,
    // 品牌名与语言无关，直接在解析层拼好（与 OpenCode Go 的口径一致）。
    planName: tier ? `Open Design ${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : null,
    detail,
    subscription: activeSubscription(root),
  };
}

/* ────────────────────────── 订阅额度窗口 ────────────────────────── */

/**
 * 窗口时长 → 界面窗口类型（5 小时 / 日 / 周 / 月）。
 * 只有约 7 天与约 30 天归并成 weekly / monthly，其余保留精确时长：
 * 曾把 7 天判成 weekly、5 小时判成 duration，但界面对 duration 会显示
 * 「5 小时额度」，而 Open Design 的窗口口径与其它套餐一致。
 */
function windowKind(durationSeconds: number): { kind: QuotaWindow["kind"]; durationMins?: number } | null {
  if (!(durationSeconds > 0)) return null;
  const mins = durationSeconds / 60;
  if (mins >= 25 * 1440 && mins <= 35 * 1440) return { kind: "monthly" };
  if (mins >= 6 * 1440 && mins <= 8 * 1440) return { kind: "weekly" };
  return { kind: "duration", durationMins: Math.round(mins) };
}

/**
 * `GET /api/v1/workspaces/{id}/billing/funding-check` 的 `codingPlan`：
 * 每个窗口给 `usedCredits` / `limitCredits` / `remainingCredits`（字符串整数）
 * 与 `durationSeconds`；界面契约只渲染百分比，这里换算成已用 %。
 * 无订阅（eligible=false 或 windows 为空）返回 null。
 */
export function parseOpenDesignCodingPlan(body: string): OpenDesignPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = record(parsed);
  const plan = record(root?.codingPlan);
  if (!root || !plan) return null;
  if (plan.eligible === false) return null;
  const rows = Array.isArray(plan.windows) ? plan.windows : [];

  const windows: QuotaWindow[] = [];
  for (const entry of rows) {
    const row = record(entry);
    if (!row) continue;
    const limit = num(row.limitCredits);
    const remaining = num(row.remainingCredits);
    if (limit === null || limit <= 0 || remaining === null) continue;
    const used = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
    const shape = windowKind(num(row.durationSeconds) ?? 0);
    if (!shape) continue;
    const resetAt = resetAtMs(row.resetsAt);
    windows.push({
      kind: shape.kind,
      ...(shape.durationMins !== undefined ? { durationMins: shape.durationMins } : {}),
      used,
      remaining: Math.max(0, 100 - used),
      resetAt,
    });
  }
  if (windows.length === 0) return null;

  return {
    windows,
    planType: str(plan.tier),
    funding: str(root.funding),
  };
}

/* ────────────────────────── 查询 ────────────────────────── */

/**
 * 查询 Open Design 账户余额：读客户端登录的 controlKey，调账单汇总接口。
 * 只读；登录过期不代刷新（客户端会轮换凭证）。返回的 `endpoint` 里不含密钥。
 */
export async function readOpenDesignBalance(
  ctx: PluginContext,
  home: string,
  gatewayHost: string,
): Promise<OpenDesignResult> {
  const configPath = joinPath(home, ".amr", "config.json");
  const configText = await readLocalFile(ctx, configPath);
  const profile = configText ? parseOpenDesignConfig(configText, gatewayHost) : null;
  if (!profile) {
    return {
      plan: null,
      planEndpoint: null,
      balance: null,
      endpoint: null,
      error: "missing",
      detail: null,
    };
  }

  const auth = { Authorization: `Bearer ${profile.controlKey}`, Accept: "application/json" };
  const endpoint = `${profile.apiUrl}/api/v1/billing/summary`;
  const response = await httpGet(ctx, endpoint, auth);
  if (response.status === 401 || response.status === 403) {
    return {
      plan: null,
      planEndpoint: null,
      balance: null,
      endpoint,
      error: "expired",
      detail: `HTTP ${response.status}`,
    };
  }
  if (response.status !== 200) {
    return {
      plan: null,
      planEndpoint: null,
      balance: null,
      endpoint,
      error: "http",
      detail: `HTTP ${response.status || "?"}`,
    };
  }
  const billing = parseOpenDesignBilling(response.body);
  if (!billing) {
    return { plan: null, planEndpoint: null, balance: null, endpoint, error: "invalid", detail: null };
  }

  // 有订阅 → 主显示订阅额度窗口（先取默认工作区，再读 coding plan）；
  // 任何一步失败都退回余额，不能让"查不到订阅"把已有余额也弄丢。
  const planResult = billing.subscription
    ? await readCodingPlan(ctx, profile, auth).catch(() => null)
    : null;
  return {
    plan: planResult?.plan ?? null,
    planEndpoint: planResult?.endpoint ?? null,
    balance: billing,
    endpoint,
    error: null,
    detail: null,
  };
}

/**
 * 默认工作区（与客户端一致）：active 的个人工作区优先，否则取第一个
 * active 成员 / active 生命周期的条目。目录接口失败返回 null。
 */
async function findWorkspaceId(
  ctx: PluginContext,
  profile: OpenDesignProfile,
  auth: Record<string, string>,
): Promise<string | null> {
  const response = await httpGet(ctx, `${profile.apiUrl}/api/v1/workspaces`, auth);
  if (response.status !== 200) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return null;
  }
  const items = Array.isArray(record(parsed)?.items) ? (record(parsed)?.items as unknown[]) : [];
  const usable = items
    .map(record)
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null &&
        item.memberStatus === "active" &&
        item.lifecycleState !== "deleted" &&
        typeof item.workspaceId === "string" &&
        item.workspaceId.trim() !== "",
    );
  const chosen = usable.find((item) => item.workspaceType === "personal") ?? usable[0];
  return chosen ? String(chosen.workspaceId) : null;
}

async function readCodingPlan(
  ctx: PluginContext,
  profile: OpenDesignProfile,
  auth: Record<string, string>,
): Promise<{ plan: OpenDesignPlan; endpoint: string } | null> {
  const workspaceId = await findWorkspaceId(ctx, profile, auth);
  if (!workspaceId) return null;
  const endpoint = `${profile.apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/funding-check`;
  const response = await httpGet(ctx, endpoint, auth);
  if (response.status !== 200) return null;
  const plan = parseOpenDesignCodingPlan(response.body);
  return plan ? { plan, endpoint } : null;
}
