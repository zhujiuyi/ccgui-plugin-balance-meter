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

export interface ParsedAmount {
  kind: "balance" | "subscription";
  currency?: string | null;
  amount?: number | null;
  total?: number | null;
  used?: number | null;
  planName?: string | null;
  detail?: string | null;
}

export interface ProbeContext {
  /** 网关的 origin，如 https://api.deepseek.com */
  origin: string;
  /** 完整网关地址（可能含路径，如 .../anthropic） */
  base: string;
  host: string;
  key: string;
}

export interface Probe {
  id: string;
  label: string;
  billing: BillingKind;
  build: (c: ProbeContext) => string | null;
  headers: (c: ProbeContext) => Record<string, string>;
  parse: (json: unknown) => ParsedAmount | null;
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
      id: "openrouter.credits",
      label: "OpenRouter 额度",
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
      parse: (json) => {
        const available = num(at(json, "data.available_balance"));
        if (available === null) return null;
        return {
          kind: "balance",
          currency: "CNY",
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
        const balance =
          num(at(json, "data.balance")) ??
          num(at(json, "data.totalBalance")) ??
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
 */
const noBalanceProviders: ProviderDef[] = [
  // 官方直连（claude / codex）
  noApiProvider("anthropic", "Anthropic 官方直连", "api", ["api.anthropic.com"], "官方未提供 API 余额查询（订阅额度只能在网页端查看）"),
  noApiProvider("openai-subscription", "OpenAI 订阅（ChatGPT）", "subscription", ["chatgpt.com", "chat.openai.com"], "订阅额度无公开接口"),
  // 智谱 GLM（coding 套餐用 api.z.ai / open.bigmodel.cn）
  noApiProvider("zhipu", "智谱 GLM", "api", ["open.bigmodel.cn"], "未找到公开的余额/余量接口"),
  noApiProvider("zai", "Z.AI 编码套餐", "subscription", ["api.z.ai"], "编码套餐无公开余量接口"),
  // Kimi 系（Moonshot 有余额接口，见下方 moonshot；Kimi Coding 是订阅）
  noApiProvider("kimi-coding", "Kimi Coding", "subscription", ["api.kimi.com"], "编码套餐无公开余量接口"),
  // MiniMax / 小米 MiMo / 百炼 / 龙猫 / OpenCode / xAI / Groq / Mistral / Together / Google
  noApiProvider("minimax", "MiniMax", "api", ["api.minimaxi.com", "api.minimax.chat"], "未找到公开的余额接口"),
  noApiProvider("xiaomi", "Xiaomi MiMo", "api", ["api.xiaomimimo.com"], "未找到公开的余额接口"),
  noApiProvider("xiaomi-plan", "Xiaomi MiMo Token Plan", "subscription", [
    "token-plan-cn.xiaomimimo.com",
    "token-plan-ams.xiaomimimo.com",
    "token-plan-sgp.xiaomimimo.com",
  ], "Token 套餐无公开余量接口"),
  noApiProvider("bailian", "阿里云百炼 Bailian", "api", [
    "dashscope.aliyuncs.com",
    "coding.dashscope.aliyuncs.com",
  ], "余额/用量只在控制台可见，无公开接口"),
  noApiProvider("longcat", "LongCat", "api", ["api.longcat.chat"], "未找到公开的余额接口"),
  noApiProvider("opencode", "OpenCode Zen / Go", "subscription", ["opencode.ai"], "订阅额度无公开接口"),
  noApiProvider("xai", "xAI Grok", "api", ["api.x.ai"], "未找到公开的余额接口"),
  noApiProvider("groq", "Groq", "api", ["api.groq.com"], "未找到公开的余额接口"),
  noApiProvider("mistral", "Mistral", "api", ["api.mistral.ai"], "未找到公开的余额接口"),
  noApiProvider("together", "Together AI", "api", ["api.together.xyz", "api.together.ai"], "未找到公开的余额接口"),
  noApiProvider("google", "Google Gemini", "api", ["generativelanguage.googleapis.com"], "未找到公开的余额接口"),
];

/** New-API / One-API 系中转的通用探测（计费方式由返回值推断）。 */
const relayProbes: Probe[] = [
  {
    id: "relay.newapi-user-self",
    label: "中转站用户额度（New-API /api/user/self）",
    billing: "unknown",
    build: (c) => `${c.origin}/api/user/self`,
    headers: (c) => bearer(c.key),
    parse: (json) => {
      if (at(json, "success") === false) return null;
      const quota = num(at(json, "data.quota"));
      if (quota === null) return sniffQuota(json);
      const usedQuota = num(at(json, "data.used_quota"));
      // New-API 以 500000 quota = 1 USD 记账。
      const amount = quota / 500000;
      const used = usedQuota === null ? null : usedQuota / 500000;
      return {
        kind: "balance",
        currency: "USD",
        amount,
        used,
        detail: used === null ? "按 New-API 记账口径换算" : `已用 ${used.toFixed(4)} USD`,
      };
    },
  },
  {
    id: "relay.openai-compat-subscription",
    label: "中转站额度（OpenAI 兼容 billing）",
    billing: "api",
    build: (c) => `${c.origin}/v1/dashboard/billing/subscription`,
    headers: (c) => bearer(c.key),
    parse: (json) => {
      const hard = num(at(json, "hard_limit_usd")) ?? num(at(json, "system_hard_limit_usd"));
      if (hard === null) return null;
      const used = num(at(json, "total_usage"));
      return {
        kind: "balance",
        currency: "USD",
        amount: used === null ? hard : hard - used / 100,
        total: hard,
        used: used === null ? null : used / 100,
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
    id: "relay.subscription-plan",
    label: "中转站订阅余量（/api/user/subscription）",
    billing: "subscription",
    build: (c) => `${c.origin}/api/user/subscription`,
    headers: (c) => bearer(c.key),
    parse: (json) => {
      const parsed = sniffQuota(json);
      if (!parsed) return null;
      const plan =
        (typeof at(json, "data.plan_name") === "string" && (at(json, "data.plan_name") as string)) ||
        (typeof at(json, "data.plan") === "string" && (at(json, "data.plan") as string)) ||
        null;
      return { ...parsed, kind: "subscription", planName: plan };
    },
  },
  {
    id: "relay.generic-quota",
    label: "中转站通用额度探测（/api/usage）",
    billing: "unknown",
    build: (c) => `${c.origin}/api/usage`,
    headers: (c) => bearer(c.key),
    parse: (json) => sniffQuota(json),
  },
];

const KNOWN_PROVIDERS: ProviderDef[] = [
  deepseek,
  openrouter,
  moonshot,
  siliconflow,
  officialOpenai,
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
