/**
 * 供应商目录 + 余量接口探测列表。
 *
 * 设计要点：
 *  - 命中已知供应商 → 用它自己的余额接口（计费方式已知）。
 *  - 未命中（多为 New-API / One-API 系中转）→ 依次探测社区常见余量接口，
 *    命中即缓存；全部失败则展示"暂时无法提供余额显示"。
 *  - 解析函数一律防御式：形状不符返回 null（视为该地址不可用，继续探测）。
 */

export type BillingKind = "api" | "subscription" | "unknown";
export type QuotaWindowKind = "rolling" | "weekly" | "monthly" | "duration";

export interface QuotaWindow {
  kind: QuotaWindowKind;
  /** 固定时长窗口（例如 Codex 的 5 小时 / 7 天）；命名由界面语言决定。 */
  durationMins?: number | null;
  used: number;
  remaining: number;
  resetAt: number | null;
}

export interface ParsedAmount {
  kind: "balance" | "subscription";
  currency?: string | null;
  amount?: number | null;
  total?: number | null;
  used?: number | null;
  planName?: string | null;
  detail?: string | null;
  /**
   * 多窗口额度必须保留结构化数据，禁止提前拼接展示文本。
   * 由 UI 逐项渲染，才能正确本地化并保证窄面板下不串行。
   */
  quotaWindows?: QuotaWindow[] | null;
}

export interface ProbeContext {
  /** 网关的 origin，如 https://api.deepseek.com */
  origin: string;
  /** 完整网关地址（可能含路径，如 .../anthropic） */
  base: string;
  host: string;
  key: string;
}

/** 探针的前置请求（例如 New-API 的 /api/status：站点记账单位只有它知道）。 */
export interface ProbeMeta {
  build: (c: ProbeContext) => string | null;
  headers: (c: ProbeContext) => Record<string, string>;
}

export interface Probe {
  id: string;
  label: string;
  billing: BillingKind;
  build: (c: ProbeContext) => string | null;
  headers: (c: ProbeContext) => Record<string, string>;
  /**
   * 可选前置 GET：按序执行，结果数组作为 parse 的第二参数（失败项为 null）。
   * 只在主请求成功后才执行——失败路径不该多打无谓请求。
   */
  meta?: ProbeMeta[];
  /** ctx 供少数需要按域名区分口径的解析（如 Moonshot 国内 / 国际币种不同）。 */
  parse: (json: unknown, meta?: unknown[], ctx?: ProbeContext) => ParsedAmount | null;
}

export interface ProviderDef {
  id: string;
  name: string;
  billing: BillingKind;
  /** 该供应商是否公开余额接口（false = 直接提示无法查询） */
  queryable: boolean;
  /** queryable=false 时给用户的明确原因 */
  reason?: string;
  match: (host: string, path: string) => boolean;
  probes: Probe[];
}

/* ────────────────────────── 解析工具 ────────────────────────── */

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function at(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, Accept: "application/json" };
}

/** 从任意 JSON 里挑出像"余量/余额"的数字（防御式，供中转站兜底）。 */
function sniffQuota(json: unknown): ParsedAmount | null {
  const candidates: Array<[string, "balance" | "subscription", string | null]> = [
    ["data.total_balance", "balance", "CNY"],
    ["data.available_balance", "balance", "CNY"],
    ["data.balance", "balance", null],
    ["total_balance", "balance", null],
    ["available_balance", "balance", null],
    ["balance", "balance", null],
    ["data.remain", "balance", null],
    ["remain", "balance", null],
    ["data.remaining", "balance", null],
    ["remaining", "balance", null],
    ["data.quota_remaining", "subscription", null],
    ["quota_remaining", "subscription", null],
    ["data.credits", "balance", null],
    ["credits", "balance", null],
  ];
  for (const [path, kind, currency] of candidates) {
    const value = num(at(json, path));
    if (value !== null) {
      const used = num(at(json, "data.used")) ?? num(at(json, "used"));
      return { kind, currency, amount: value, used, detail: `字段 ${path}` };
    }
  }
  return null;
}

/* ──────────────────── 额度窗口 / 记账单位工具 ──────────────────── */

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

function quotaWindow(
  kind: QuotaWindowKind,
  used: number,
  remaining: number,
  resetAt: number | null,
  durationMins?: number,
): QuotaWindow {
  return durationMins === undefined
    ? { kind, used, remaining, resetAt }
    : { kind, durationMins, used, remaining, resetAt };
}

/** 把「已用 / 上限」换算成界面契约要求的百分比（quotaWindows 只渲染 %）。 */
function percentWindow(
  limit: unknown,
  used: unknown,
  remaining: unknown,
  resetAt: number | null,
  kind: QuotaWindowKind,
  durationMins?: number,
): QuotaWindow | null {
  const cap = num(limit);
  if (cap === null || cap <= 0) return null;
  const usedValue = num(used) ?? (num(remaining) === null ? null : cap - (num(remaining) as number));
  if (usedValue === null) return null;
  const usedPercent = clampPercent((usedValue / cap) * 100);
  return quotaWindow(kind, usedPercent, 100 - usedPercent, resetAt, durationMins);
}

function resetAtOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const NEWAPI_DEFAULT_QUOTA_UNIT = 500_000;

interface QuotaUnit {
  /** 原始 quota 除以它得金额；站点可在 /api/status 改写。 */
  perUnit: number;
  currency: string | null;
  /** false = 站点按 token / 自定义单位计量，金额类换算（如美分减法）不再成立。 */
  monetary: boolean;
}

/**
 * New-API / One-API 系的记账口径来自站点自身的 `/api/status`：
 * `quota_per_unit` 默认 500000 但站主可改，`quota_display_type` 还会把
 * `*_usd` 字段整体改写成 CNY / token 计量——硬编码必然出现数量级错误。
 */
function newApiUnit(status: unknown): QuotaUnit {
  const display = at(status, "data.quota_display_type");
  const type = typeof display === "string" ? display.toUpperCase() : "";
  if (type === "TOKENS" || type === "CUSTOM") {
    return { perUnit: 1, currency: null, monetary: false };
  }
  const perUnit = num(at(status, "data.quota_per_unit"));
  return {
    perUnit: perUnit !== null && perUnit > 0 ? perUnit : NEWAPI_DEFAULT_QUOTA_UNIT,
    currency: type === "CNY" ? "CNY" : "USD",
    monetary: true,
  };
}

/* ────────────────────────── 已知供应商 ────────────────────────── */

const deepseek: ProviderDef = {
  id: "deepseek",
  name: "DeepSeek",
  billing: "api",
  queryable: true,
  match: (host) => host === "api.deepseek.com",
  probes: [
    {
      id: "deepseek.user-balance",
      label: "DeepSeek 余额",
      billing: "api",
      build: (c) => `${c.origin}/user/balance`,
      headers: (c) => bearer(c.key),
      parse: (json) => {
        const info = at(json, "balance_infos.0") as Record<string, unknown> | undefined;
        if (!info) return null;
        const amount = num(info.total_balance);
        if (amount === null) return null;
        return {
          kind: "balance",
          currency: typeof info.currency === "string" ? info.currency : "CNY",
          amount,
          detail: `充值 ${info.topped_up_balance ?? "?"} / 赠金 ${info.granted_balance ?? "?"}`,
        };
      },
    },
  ],
};

const openrouter: ProviderDef = {
  id: "openrouter",
  name: "OpenRouter",
  billing: "api",
  queryable: true,
  match: (host) => host.endsWith("openrouter.ai"),
  probes: [
    {
      // 普通推理 key 可读（官方规范里 /credits 要求 Management key，普通 key 必 403）。
      id: "openrouter.key-limit",
      label: "OpenRouter Key 额度",
      billing: "api",
      build: (c) => `${c.origin}/api/v1/key`,
      headers: (c) => bearer(c.key),
      parse: (json) => {
        const limit = num(at(json, "data.limit"));
        const remaining = num(at(json, "data.limit_remaining"));
        // 未设上限的 key：limit / limit_remaining 都是 null，不能当成 0。
        if (limit === null || remaining === null) return null;
        const used = num(at(json, "data.usage"));
        return {
          kind: "balance",
          currency: "USD",
          amount: remaining,
          total: limit,
          used,
          detail: "按本 Key 的额度上限计",
        };
      },
    },
    {
      id: "openrouter.credits",
      label: "OpenRouter 账户额度",
      billing: "api",
      build: (c) => `${c.origin}/api/v1/credits`,
      headers: (c) => bearer(c.key),
      parse: (json) => {
        const total = num(at(json, "data.total_credits"));
        const used = num(at(json, "data.total_usage"));
        if (total === null) return null;
        return {
          kind: "balance",
          currency: "USD",
          amount: used === null ? total : total - used,
          total,
          used,
          detail: used === null ? null : `已用 ${used} / 总额 ${total}`,
        };
      },
    },
  ],
};

const moonshot: ProviderDef = {
  id: "moonshot",
  name: "Moonshot / Kimi",
  billing: "api",
  queryable: true,
  match: (host) => host === "api.moonshot.cn" || host === "api.moonshot.ai",
  probes: [
    {
      id: "moonshot.balance",
      label: "Moonshot 余额",
      billing: "api",
      build: (c) => `${c.origin}/v1/users/me/balance`,
      headers: (c) => bearer(c.key),
      parse: (json, _meta, ctx) => {
        // 国内站与 Moonshot 平台回人民币元，国际站回 USD——币种随域名而定。
        const currency = ctx?.host.endsWith(".ai") ? "USD" : "CNY";
        const code = num(at(json, "code"));
        if (code !== null && code !== 0) return null;
        if (at(json, "status") === false) return null;
        const available = num(at(json, "data.available_balance"));
        if (available === null) return null;
        return {
          kind: "balance",
          currency,
          amount: available,
          detail: `代金券 ${at(json, "data.voucher_balance") ?? "?"} / 现金 ${at(json, "data.cash_balance") ?? "?"}`,
        };
      },
    },
  ],
};

const siliconflow: ProviderDef = {
  id: "siliconflow",
  name: "SiliconFlow",
  billing: "api",
  queryable: true,
  match: (host) => host.endsWith("siliconflow.cn") || host.endsWith("siliconflow.com"),
  probes: [
    {
      id: "siliconflow.user-info",
      label: "SiliconFlow 余额",
      billing: "api",
      build: (c) => `${c.origin}/v1/user/info`,
      headers: (c) => bearer(c.key),
      parse: (json) => {
        // totalBalance = balance + chargeBalance 是总额；先取它会得到最小的赠金字段。
        const balance =
          num(at(json, "data.totalBalance")) ??
          num(at(json, "data.balance")) ??
          num(at(json, "data.chargeBalance"));
        if (balance === null) return null;
        return { kind: "balance", currency: "CNY", amount: balance };
      },
    },
  ],
};

const officialOpenai: ProviderDef = {
  id: "openai-api",
  name: "OpenAI",
  billing: "api",
  queryable: true,
  match: (host) => host === "api.openai.com",
  probes: [
    {
      id: "openai.billing-subscription",
      label: "OpenAI 账单额度",
      billing: "api",
      build: (c) => `${c.origin}/v1/dashboard/billing/subscription`,
      headers: (c) => bearer(c.key),
      parse: (json) => {
        const hard = num(at(json, "hard_limit_usd")) ?? num(at(json, "system_hard_limit_usd"));
        const used = num(at(json, "total_usage"));
        if (hard === null) return null;
        const usedUsd = used === null ? null : used / 100;
        return {
          kind: "balance",
          currency: "USD",
          amount: usedUsd === null ? hard : hard - usedUsd,
          total: hard,
          used: usedUsd,
        };
      },
    },
  ],
};

const opencodeGo: ProviderDef = {
  id: "opencode",
  name: "OpenCode Go",
  billing: "subscription",
  queryable: true,
  match: (host, path) => host === "opencode.ai" && /^\/zen\/go(?:\/|$)/.test(path),
  probes: [
    {
      id: "opencode.go-usage",
      label: "OpenCode Go 订阅余量",
      billing: "subscription",
      build: (c) => `${c.origin}/zen/go/v1/usage`,
      headers: (c) => bearer(c.key),
      parse: (json) => {
        const windows = [
          ["rolling", "usage.rolling"],
          ["weekly", "usage.weekly"],
          ["monthly", "usage.monthly"],
        ] as const;
        const parsed = windows.flatMap(([kind, path]) => {
          const percent = num(at(json, `${path}.percent`));
          if (percent === null) return [];
          const used = Math.max(0, Math.min(100, percent));
          const reset = at(json, `${path}.resetsAt`);
          const resetAt = typeof reset === "string" ? Date.parse(reset) : Number.NaN;
          return [{ kind, used, remaining: 100 - used, resetAt: Number.isFinite(resetAt) ? resetAt : null }];
        });
        const primary = parsed[0];
        if (!primary) return null;
        return {
          kind: "subscription",
          currency: "%",
          amount: primary.remaining,
          total: 100,
          used: primary.used,
          planName: "OpenCode Go",
          quotaWindows: parsed,
        };
      },
    },
  ],
};

/** 官方订阅类 / 无余额接口的供应商：命中即明确"查不到"。 */
function matchHosts(...hosts: string[]): (host: string, path: string) => boolean {
  return (host) => hosts.some((candidate) => host === candidate || host.endsWith(candidate));
}

/** 收录了但**没有公开余额接口**的供应商（命中即给出明确原因，不再瞎试）。 */
function noApiProvider(
  id: string,
  name: string,
  billing: BillingKind,
  hosts: string[],
  reason: string,
): ProviderDef {
  return {
    id,
    name,
    billing,
    queryable: false,
    match: matchHosts(...hosts),
    probes: [],
    reason,
  };
}

/**
 * 清单与 ccgui「添加自定义渠道」的预设表对齐（src/features/settings/providerPresets.ts，
 * 2026-09-19 于 v1.0.5 核对）：claude 12 项 / kimi 2 项 / grok 1 项 / codex 10 项，
 * 去重后覆盖下列域名。**没有公开余额接口的也一律收录**——这样插件能报出
 * "XX 未提供公开的余额/余量查询接口"而不是含糊的"未知供应商"。
 *
 * 注：智谱 GLM / Z.AI、Kimi Coding、MiniMax、Grok 订阅等**编程套餐**渠道
 * 已由 routes.ts 的主机分流 + coding-plans.ts 的专用适配器接管，此处的
 * `noApiProvider` 条目只作兜底（网关不是标准 URL 形态时才会走到）。
 */
const noBalanceProviders: ProviderDef[] = [
  // OpenCode Zen（按量付费）——Go 订阅由上方 opencodeGo 先匹配（含 /zen/go 路径）。
  noApiProvider("opencode-zen", "OpenCode Zen", "api", ["opencode.ai"], "Zen 按量余额未提供公开接口（余额只在网页控制台可见）"),
  // 官方直连（claude / codex）
  noApiProvider("anthropic", "Anthropic 官方直连", "api", ["api.anthropic.com"], "官方未提供 API 余额接口（订阅额度见 Claude 订阅通道）"),
  noApiProvider("openai-subscription", "OpenAI 订阅（ChatGPT）", "subscription", ["chatgpt.com", "chat.openai.com"], "订阅额度见 Codex 订阅通道，无独立的余额接口"),
  // 智谱 GLM（coding 套餐用 api.z.ai / open.bigmodel.cn）
  noApiProvider("zhipu", "智谱 GLM", "api", ["open.bigmodel.cn"], "官方未提供 API 余额接口（编码套餐余量见智谱套餐通道）"),
  noApiProvider("zai", "Z.AI 编码套餐", "subscription", ["api.z.ai"], "编码套餐余量见 Z.AI 套餐通道，无独立的余额接口"),
  // Kimi 系（Moonshot 有余额接口，见下方 moonshot；Kimi Coding 是订阅）
  noApiProvider("kimi-coding", "Kimi Coding", "subscription", ["api.kimi.com"], "编码套餐余量见 Kimi 套餐通道，无独立的余额接口"),
  // MiniMax / 小米 MiMo / 百炼 / 龙猫 / xAI / Groq / Mistral / Together / Google
  noApiProvider("minimax", "MiniMax", "api", ["api.minimaxi.com", "api.minimax.chat"], "官方未提供 API 余额接口（编程套餐余量见 MiniMax 套餐通道）"),
  noApiProvider("xiaomi", "Xiaomi MiMo", "api", ["api.xiaomimimo.com"], "余额仅控制台网页会话可见，API key 不可用"),
  noApiProvider("xiaomi-plan", "Xiaomi MiMo Token Plan", "subscription", [
    "token-plan-cn.xiaomimimo.com",
    "token-plan-ams.xiaomimimo.com",
    "token-plan-sgp.xiaomimimo.com",
  ], "Token 套餐余量仅控制台网页会话可见"),
  noApiProvider("bailian", "阿里云百炼 Bailian", "api", [
    "dashscope.aliyuncs.com",
    "coding.dashscope.aliyuncs.com",
  ], "余额仅控制台可见（账户余额接口需 AccessKey 签名，非 API key 可调）"),
  noApiProvider("longcat", "LongCat", "api", ["api.longcat.chat"], "官方只提供推理接口，没有用量或余额接口"),
  noApiProvider("xai", "xAI Grok", "api", ["api.x.ai"], "推理 API 无余额接口（团队余额在 Management API，需另配 management key 与 team id）"),
  noApiProvider("groq", "Groq", "api", ["api.groq.com"], "官方未提供余额或用量接口（控制台用量需网页会话）"),
  noApiProvider("mistral", "Mistral", "api", ["api.mistral.ai"], "官方未提供余额接口（Admin API 只有用量与限额，且需企业账号）"),
  noApiProvider("together", "Together AI", "api", ["api.together.xyz", "api.together.ai"], "没有余额接口（只有需开通的月度消耗接口）"),
  noApiProvider("google", "Google Gemini", "api", ["generativelanguage.googleapis.com"], "官方未提供余额接口（用量查询需 Google 账号 OAuth）"),
];

const jsonOnly: (c: ProbeContext) => Record<string, string> = () => ({
  Accept: "application/json",
});

/** `/api/status` 是免认证的，先问站点自己的记账单位，再谈金额。 */
const newApiStatusMeta: ProbeMeta = {
  build: (c) => `${c.origin}/api/status`,
  headers: jsonOnly,
};

/** Sub2API 的窗口标签 → 结构化窗口（界面契约只渲染百分比）。 */
function sub2apiWindowKind(label: unknown): { kind: QuotaWindowKind; durationMins?: number } | null {
  if (typeof label !== "string") return null;
  switch (label.trim().toLowerCase()) {
    case "5h":
      return { kind: "duration", durationMins: 300 };
    case "1d":
    case "24h":
      return { kind: "duration", durationMins: 1440 };
    case "7d":
    case "1w":
      return { kind: "weekly" };
    case "30d":
    case "1mo":
    case "1m":
      return { kind: "monthly" };
    default:
      return null;
  }
}

/**
 * New-API / One-API 系中转的通用探测（计费方式由返回值推断）。
 *
 * 顺序按「一次请求就能拿到、且 API key 真的打得通」排列；历史上把
 * `/api/user/self` 放在首位是错的——那条走 users 表的 access_token，
 * 中转站发给用户的 `sk-` 令牌属于 tokens 表，必然 401。
 */
const relayProbes: Probe[] = [
  {
    // New-API ≥ v0.9.0：一次请求直出剩余额度，是最好的一条。
    id: "relay.newapi-token-usage",
    label: "中转站令牌额度（/api/usage/token/）",
    billing: "unknown",
    meta: [newApiStatusMeta],
    build: (c) => `${c.origin}/api/usage/token/`,
    headers: (c) => bearer(c.key),
    parse: (json, meta) => {
      if (at(json, "success") === false) return null;
      const available = num(at(json, "data.total_available"));
      if (at(json, "data.unlimited_quota") === true) {
        return {
          kind: "balance",
          currency: newApiUnit(meta?.[0]).currency,
          amount: null,
          detail: "该令牌未设额度上限（无限额度）",
        };
      }
      if (available === null) return null;
      const unit = newApiUnit(meta?.[0]);
      const used = num(at(json, "data.total_used"));
      return {
        kind: "balance",
        currency: unit.currency,
        amount: available / unit.perUnit,
        used: used === null ? null : used / unit.perUnit,
        detail: `按站点记账单位 1:${unit.perUnit} 换算`,
      };
    },
  },
  {
    // OpenAI 兼容 billing：hard_limit_usd 是**总额度上限**，必须再减 /usage 的美分数。
    id: "relay.newapi-billing",
    label: "中转站额度（OpenAI 兼容 billing）",
    billing: "api",
    meta: [
      newApiStatusMeta,
      {
        build: (c) => `${c.origin}/v1/dashboard/billing/usage`,
        headers: (c) => bearer(c.key),
      },
    ],
    build: (c) => `${c.origin}/v1/dashboard/billing/subscription`,
    headers: (c) => bearer(c.key),
    parse: (json, meta) => {
      if (at(json, "error")) return null;
      const unit = newApiUnit(meta?.[0]);
      // TOKENS / CUSTOM 模式下这两个字段已被站点改写，美分减法会算出无意义的数。
      if (!unit.monetary) return null;
      const hard = num(at(json, "hard_limit_usd")) ?? num(at(json, "system_hard_limit_usd"));
      if (hard === null) return null;
      // 无限额度令牌的哨兵值，当真会显示成一个天文数字。
      if (hard >= 1_000_000) return null;
      const cents = num(at(meta?.[1], "total_usage"));
      // 拿不到已用额度时**不能**退回把总额当余额，那会高估。
      if (cents === null) return null;
      const used = cents / 100;
      return {
        kind: "balance",
        currency: unit.currency,
        amount: hard - used,
        total: hard,
        used,
      };
    },
  },
  {
    // Sub2API 系（含部分 Claude Code 包月站）：额度 + 5h/日/周窗口。
    id: "relay.sub2api-usage",
    label: "中转站额度（Sub2API /v1/usage）",
    billing: "unknown",
    build: (c) => `${c.origin}/v1/usage`,
    headers: (c) => bearer(c.key),
    parse: (json) => {
      const root = record(at(json, "data")) ?? record(json);
      if (!root) return null;
      const quota = record(root.quota);
      const remaining = num(quota?.remaining) ?? num(root.remaining) ?? num(root.balance);
      if (remaining === null) return null;
      const rawWindows = Array.isArray(root.rate_limits) ? root.rate_limits : [];
      const windows = rawWindows.flatMap((entry) => {
        const row = record(entry);
        const shape = sub2apiWindowKind(row?.window);
        if (!row || !shape) return [];
        const parsed = percentWindow(
          row.limit,
          row.used,
          row.remaining,
          resetAtOf(row.reset_at),
          shape.kind,
          shape.durationMins,
        );
        return parsed ? [parsed] : [];
      });
      const total = num(quota?.limit);
      const used = num(quota?.used);
      return {
        // 头部数字是钱包余额，窗口只是附带的百分比（界面按 quotaWindows 渲染）。
        // 币种在顶层 `unit`（钱包模式无 quota 对象），缺省按 USD。
        kind: "balance",
        currency: (quota?.unit ?? root.unit) === "CNY" ? "CNY" : "USD",
        amount: remaining,
        total,
        used,
        planName: typeof root.planName === "string" ? root.planName : null,
        quotaWindows: windows.length > 0 ? windows : null,
      };
    },
  },
  {
    // claude-code-hub：读层用任意有效用户 key + X-Api-Key 头。
    id: "relay.cchub-quota",
    label: "中转站额度（claude-code-hub /api/v1/me/quota）",
    billing: "subscription",
    build: (c) => `${c.origin}/api/v1/me/quota`,
    headers: (c) => ({ "X-Api-Key": c.key, Accept: "application/json" }),
    parse: (json) => {
      const totalLimit = num(at(json, "keyLimitTotalUsd"));
      const totalUsed = num(at(json, "keyCurrentTotalUsd"));
      const windows = [
        percentWindow(at(json, "keyLimit5hUsd"), at(json, "keyCurrent5hUsd"), null, null, "duration", 300),
        percentWindow(at(json, "keyLimitDailyUsd"), at(json, "keyCurrentDailyUsd"), null, null, "duration", 1440),
        percentWindow(at(json, "keyLimitWeeklyUsd"), at(json, "keyCurrentWeeklyUsd"), null, null, "weekly"),
        percentWindow(at(json, "keyLimitMonthlyUsd"), at(json, "keyCurrentMonthlyUsd"), null, null, "monthly"),
      ].filter((entry): entry is QuotaWindow => entry !== null);
      if (windows.length === 0 && totalLimit === null) return null;
      return {
        kind: "balance",
        currency: "USD",
        amount: totalLimit === null ? null : totalLimit - (totalUsed ?? 0),
        total: totalLimit,
        used: totalUsed,
        quotaWindows: windows.length > 0 ? windows : null,
      };
    },
  },
  {
    // CloseAI：自研网关，余额字段为 total_available。
    id: "relay.closeai-credits",
    label: "中转站额度（/dashboard/billing/credit_grants）",
    billing: "api",
    build: (c) => `${c.origin}/dashboard/billing/credit_grants`,
    headers: (c) => bearer(c.key),
    parse: (json) => {
      const available = num(at(json, "total_available"));
      if (available === null) return sniffQuota(json);
      const granted = num(at(json, "total_granted"));
      const used = num(at(json, "total_used"));
      return {
        kind: "balance",
        currency: "USD",
        amount: available,
        total: granted !== null && used !== null ? granted : null,
        used,
      };
    },
  },
  {
    id: "relay.credits",
    label: "中转站额度（/api/v1/credits）",
    billing: "unknown",
    build: (c) => `${c.origin}/api/v1/credits`,
    headers: (c) => bearer(c.key),
    parse: (json) => {
      const total = num(at(json, "data.total_credits"));
      const used = num(at(json, "data.total_usage"));
      if (total === null) return sniffQuota(json);
      return {
        kind: "balance",
        currency: "USD",
        amount: used === null ? total : total - used,
        total,
        used,
      };
    },
  },
  {
    // 兜底：正版 New-API 的 sk- 打不通这条（需面板 access token + New-Api-User 头），
    // 但个别变体（Rix-API / VoAPI 系）在这里给 USD 字段，留作最后一试。
    id: "relay.newapi-user-self",
    label: "中转站用户额度（/api/user/self）",
    billing: "unknown",
    meta: [newApiStatusMeta],
    build: (c) => `${c.origin}/api/user/self`,
    headers: (c) => bearer(c.key),
    parse: (json, meta) => {
      if (at(json, "success") === false) return null;
      const quota = num(at(json, "data.quota"));
      if (quota === null) return sniffQuota(json);
      const unit = newApiUnit(meta?.[0]);
      const usedQuota = num(at(json, "data.used_quota"));
      return {
        kind: "balance",
        currency: unit.currency,
        amount: quota / unit.perUnit,
        used: usedQuota === null ? null : usedQuota / unit.perUnit,
        detail: `按站点记账单位 1:${unit.perUnit} 换算`,
      };
    },
  },
];

const KNOWN_PROVIDERS: ProviderDef[] = [
  deepseek,
  openrouter,
  moonshot,
  siliconflow,
  officialOpenai,
  opencodeGo,
  ...noBalanceProviders,
];

export interface ResolvedProvider {
  provider: ProviderDef;
  /** 有序探测列表：自定义接口 → 供应商专有接口（未识别时才用中转通用列表） */
  probes: Probe[];
  /** 无法查询时给用户的原因 */
  reason: string | null;
}

export function resolveProvider(
  gateway: string,
  customEndpoint: string,
): ResolvedProvider {
  const url = safeUrl(gateway);
  const host = url?.hostname.toLowerCase() ?? "";
  const path = url?.pathname ?? "";

  const matched = KNOWN_PROVIDERS.find((provider) => provider.match(host, path));
  const probes: Probe[] = [];

  if (customEndpoint.trim()) {
    const template = customEndpoint.trim();
    probes.push({
      id: "custom.endpoint",
      label: "自定义余量接口",
      billing: matched?.billing ?? "unknown",
      build: (c) => template.replace(/\{base\}/g, c.base).replace(/\{origin\}/g, c.origin),
      headers: (c) => bearer(c.key),
      parse: (json) => sniffQuota(json),
    });
  }

  if (matched) {
    probes.push(...matched.probes);
  } else {
    // 域名没识别出来 = 大概率是 New-API / One-API 系中转，逐个试常见余量接口。
    probes.push(...relayProbes);
  }

  const reason = matched
    ? (matched.reason ??
      (matched.queryable ? null : `${matched.name} 未提供公开的余额/余量查询接口`))
    : null;

  return {
    provider: matched ?? {
      id: "relay",
      name: host || "未知中转站",
      billing: "unknown",
      queryable: true,
      match: () => false,
      probes: [],
    },
    probes,
    reason,
  };
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export const relayProbeIds = relayProbes.map((probe) => probe.id);
