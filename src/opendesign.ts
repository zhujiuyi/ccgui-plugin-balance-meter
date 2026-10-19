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
import type { ParsedAmount } from "./providers";
import { joinPath } from "./routes";

export interface OpenDesignResult {
  amount: ParsedAmount | null;
  endpoint: string | null;
  error: PlanErrorKind | null;
  /** 诊断细节（状态码等非敏感信息；controlKey 绝不进入此处）。 */
  detail: string | null;
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

/**
 * `GET /api/v1/billing/summary`：余额优先取 `totalAvailableCreditsUsd`
 * （订阅额度 + 充值额度），缺失时退回 `balanceUsd`，再退回按 `creditsPerUsd` 换算。
 * `membershipTier` 作为计划名展示（go / plus / pro / max）。
 */
export function parseOpenDesignBilling(body: string): ParsedAmount | null {
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
    return { amount: null, endpoint: null, error: "missing", detail: null };
  }

  const endpoint = `${profile.apiUrl}/api/v1/billing/summary`;
  const response = await httpGet(ctx, endpoint, {
    Authorization: `Bearer ${profile.controlKey}`,
    Accept: "application/json",
  });
  if (response.status === 401 || response.status === 403) {
    return { amount: null, endpoint, error: "expired", detail: `HTTP ${response.status}` };
  }
  if (response.status !== 200) {
    return {
      amount: null,
      endpoint,
      error: "http",
      detail: `HTTP ${response.status || "?"}`,
    };
  }
  const amount = parseOpenDesignBilling(response.body);
  if (!amount) return { amount: null, endpoint, error: "invalid", detail: null };
  return { amount, endpoint, error: null, detail: null };
}
