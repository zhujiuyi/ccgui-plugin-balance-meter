/** 文案插件自带（不进宿主 i18n），按 ctx.host.locale 切换 zh/en。 */

export interface Copy {
  chipAria: string;
  chipUnknown: string;
  /** 状态栏用的短标签（无法查询时）；完整句见 unavailable。 */
  chipUnavailable: string;
  panelTitle: string;
  rowProvider: string;
  rowBilling: string;
  rowAmount: string;
  rowPlan: string;
  rowDetails: string;
  /** API 余额场景里明细行的标签（如「充值 x / 赠金 y」），与配额窗口行区分开。 */
  rowBalanceDetail: string;
  rowEndpoint: string;
  rowCheckedAt: string;
  refresh: string;
  refreshing: string;
  close: string;
  billingApi: string;
  billingSubscription: string;
  billingUnknown: string;
  unavailable: string;
  /** 查询地址区块 */
  endpointTitle: string;
  edit: string;
  save: string;
  cancel: string;
  resetAuto: string;
  autoDetect: string;
  overridden: string;
  endpointPlaceholder: string;
  invalidEndpoint: string;
  saving: string;
  /** 路由/引擎状态 */
  noRoute: string;
  noRouteForEngine: (engine: string) => string;
  engineUnconfirmed: string;
  /** 设置项 */
  settingsTitle: string;
  settingsIntro: string;
  settingsRoutes: string;
  settingsEmpty: string;
  settingsDiagnostics: string;
  settingsHome: string;
  settingsExecShell: string;
  settingsExecCurl: string;
  settingsEngine: string;
  settingsGateway: string;
  settingsKeySource: string;
  refreshAll: string;
  ok: string;
  missing: string;
  cmdRefreshTitle: string;
  neverChecked: string;
  codexRateLimitUnavailable: string;
  chatgptPlanName: (planType: string | null) => string;
  /** Claude 订阅（OAuth 登录，内部用量接口，实验性） */
  claudeProviderName: string;
  claudeEndpointLabel: string;
  claudeUsageUnavailable: string;
  claudeLoginExpired: string;
  claudeLoginMissing: string;
  claudePlanName: (planType: string | null) => string;
  /** 编程套餐渠道（Kimi / 智谱 / MiniMax / Grok） */
  kimiProviderName: string;
  kimiEndpointLabel: string;
  kimiUsageUnavailable: string;
  kimiLoginExpired: string;
  kimiLoginMissing: string;
  zhipuProviderName: string;
  zhipuEndpointLabel: string;
  zhipuUsageUnavailable: string;
  minimaxProviderName: string;
  minimaxEndpointLabel: string;
  minimaxUsageUnavailable: string;
  grokProviderName: string;
  grokEndpointLabel: string;
  grokUsageUnavailable: string;
  grokLoginExpired: string;
  grokLoginMissing: string;
  quotaRolling: string;
  quotaWeekly: string;
  quotaMonthly: string;
  quotaDuration: (durationMins: number) => string;
  quotaResetAt: (resetsAtMs: number) => string;
}

const ZH: Copy = {
  chipAria: "点击查看当前路由的余额与余量",
  chipUnknown: "—",
  chipUnavailable: "无法查询",
  panelTitle: "余额与余量",
  rowProvider: "供应商",
  rowBilling: "计费方式",
  rowAmount: "当前余量",
  rowPlan: "订阅计划",
  rowDetails: "额度窗口",
  rowBalanceDetail: "余额构成",
  rowEndpoint: "查询地址",
  rowCheckedAt: "最近查询",
  refresh: "立即刷新",
  refreshing: "刷新中…",
  close: "关闭",
  billingApi: "API 按量计费",
  billingSubscription: "订阅计划",
  billingUnknown: "未知",
  unavailable: "暂时无法提供余额显示",
  endpointTitle: "查询地址",
  edit: "修改",
  save: "保存",
  cancel: "取消",
  resetAuto: "恢复自动",
  autoDetect: "自动探测",
  overridden: "已自定义",
  endpointPlaceholder: "https://… 或 {base}/api/user/self",
  invalidEndpoint: "地址需以 http(s):// 开头，或包含 {base}/{origin} 占位符",
  saving: "保存中…",
  noRoute: "未识别到可用路由",
  noRouteForEngine: (engine) => `未识别到「${engine}」的路由配置（该引擎可能不在本插件支持范围）`,
  engineUnconfirmed: "未确认",
  settingsTitle: "余额与余量",
  settingsIntro:
    "按当前引擎实际在用的网关地址识别供应商与计费方式，查询 API 余额或订阅余量。工作原理、更新时机与权限说明见页面底部的「使用说明」。",
  settingsRoutes: "路由与查询结果",
  settingsEmpty: "尚未识别到路由：请确认 ccgui 配置或引擎本地配置可读。",
  settingsDiagnostics: "诊断",
  settingsHome: "用户目录",
  settingsExecShell: "shell 可用（cmd / sh）",
  settingsExecCurl: "curl 可用",
  settingsEngine: "引擎",
  settingsGateway: "网关",
  settingsKeySource: "凭证",
  refreshAll: "刷新全部路由",
  ok: "是",
  missing: "否",
  cmdRefreshTitle: "刷新余额与余量",
  neverChecked: "尚未查询",
  codexRateLimitUnavailable: "无法通过 Codex App Server 读取 ChatGPT 余量",
  chatgptPlanName: (planType) =>
    planType ? `ChatGPT ${planType.charAt(0).toUpperCase()}${planType.slice(1)}` : "ChatGPT",
  claudeProviderName: "Claude（订阅）",
  claudeEndpointLabel: "Claude OAuth 用量接口（实验性）",
  claudeUsageUnavailable: "无法通过 Claude 订阅接口读取余量",
  claudeLoginExpired: "Claude 登录凭证已过期或失效，请运行一次 claude 重新登录",
  claudeLoginMissing: "未找到 Claude 登录凭证（~/.claude/.credentials.json）",
  claudePlanName: (planType) =>
    planType ? `Claude ${planType.charAt(0).toUpperCase()}${planType.slice(1)}` : "Claude",
  kimiProviderName: "Kimi（套餐）",
  kimiEndpointLabel: "Kimi For Coding /coding/v1/usages",
  kimiUsageUnavailable: "无法读取 Kimi 套餐余量",
  kimiLoginExpired: "Kimi 登录已过期，请运行一次 kimi 重新登录",
  kimiLoginMissing: "未找到 Kimi 登录凭证（请先运行 kimi 登录，或为该渠道配置 API key）",
  zhipuProviderName: "智谱 GLM（套餐）",
  zhipuEndpointLabel: "智谱开放平台 /api/monitor/usage/quota/limit",
  zhipuUsageUnavailable: "无法读取智谱套餐额度",
  minimaxProviderName: "MiniMax（套餐）",
  minimaxEndpointLabel: "MiniMax /coding_plan/remains",
  minimaxUsageUnavailable: "无法读取 MiniMax 套餐余量",
  grokProviderName: "Grok（订阅）",
  grokEndpointLabel: "Grok CLI 计费接口 /v1/billing",
  grokUsageUnavailable: "无法读取 Grok 订阅余量",
  grokLoginExpired: "Grok 登录已过期，请运行一次 grok login 重新登录",
  grokLoginMissing: "未找到 Grok 登录凭证（请先运行 grok login）",
  quotaRolling: "滚动窗口",
  quotaWeekly: "每周额度",
  quotaMonthly: "每月额度",
  quotaDuration: (durationMins) =>
    durationMins % 1440 === 0
      ? `${durationMins / 1440} 天额度`
      : durationMins % 60 === 0
        ? `${durationMins / 60} 小时额度`
        : `${durationMins} 分钟额度`,
  quotaResetAt: (resetsAtMs) =>
    `${new Date(resetsAtMs).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })} 重置`,
};

const EN: Copy = {
  chipAria: "Click to inspect the balance / quota of the active route",
  chipUnknown: "—",
  chipUnavailable: "n/a",
  panelTitle: "Balance & quota",
  rowProvider: "Provider",
  rowBilling: "Billing",
  rowAmount: "Remaining",
  rowPlan: "Plan",
  rowDetails: "Quota windows",
  rowBalanceDetail: "Balance detail",
  rowEndpoint: "Endpoint",
  rowCheckedAt: "Checked",
  refresh: "Refresh now",
  refreshing: "Refreshing…",
  close: "Close",
  billingApi: "API usage-based",
  billingSubscription: "Subscription plan",
  billingUnknown: "Unknown",
  unavailable: "Balance temporarily unavailable",
  endpointTitle: "Endpoint",
  edit: "Edit",
  save: "Save",
  cancel: "Cancel",
  resetAuto: "Reset to auto",
  autoDetect: "auto-detect",
  overridden: "custom",
  endpointPlaceholder: "https://… or {base}/api/user/self",
  invalidEndpoint: "Use an http(s):// URL, or include {base}/{origin}",
  saving: "Saving…",
  noRoute: "No usable route detected",
  noRouteForEngine: (engine) => `No route config found for "${engine}" (engine may be unsupported)`,
  engineUnconfirmed: "unconfirmed",
  settingsTitle: "Balance & quota",
  settingsIntro:
    "Identifies the provider and billing model from the gateway your active engine actually uses, then queries the API balance or subscription quota. See “How it works” at the bottom for timing, caching and permissions.",
  settingsRoutes: "Routes and results",
  settingsEmpty: "No route detected yet: check that ccgui / engine config files are readable.",
  settingsDiagnostics: "Diagnostics",
  settingsHome: "Home directory",
  settingsExecShell: "shell available (cmd / sh)",
  settingsExecCurl: "curl available",
  settingsEngine: "Engine",
  settingsGateway: "Gateway",
  settingsKeySource: "Credential",
  refreshAll: "Refresh all routes",
  ok: "yes",
  missing: "no",
  cmdRefreshTitle: "Refresh balance and quota",
  neverChecked: "not checked yet",
  codexRateLimitUnavailable: "Could not read ChatGPT limits through Codex App Server",
  chatgptPlanName: (planType) =>
    planType ? `ChatGPT ${planType.charAt(0).toUpperCase()}${planType.slice(1)}` : "ChatGPT",
  claudeProviderName: "Claude (subscription)",
  claudeEndpointLabel: "Claude OAuth usage (experimental)",
  claudeUsageUnavailable: "Could not read Claude subscription usage",
  claudeLoginExpired: "Claude login expired — run claude once to sign in again",
  claudeLoginMissing: "No Claude login credentials found (~/.claude/.credentials.json)",
  claudePlanName: (planType) =>
    planType ? `Claude ${planType.charAt(0).toUpperCase()}${planType.slice(1)}` : "Claude",
  kimiProviderName: "Kimi (plan)",
  kimiEndpointLabel: "Kimi For Coding /coding/v1/usages",
  kimiUsageUnavailable: "Could not read Kimi plan usage",
  kimiLoginExpired: "Kimi login expired — run kimi once to sign in again",
  kimiLoginMissing: "No Kimi credentials found (run kimi to sign in, or set an API key for this channel)",
  zhipuProviderName: "Zhipu GLM (plan)",
  zhipuEndpointLabel: "Zhipu open platform /api/monitor/usage/quota/limit",
  zhipuUsageUnavailable: "Could not read Zhipu plan quota",
  minimaxProviderName: "MiniMax (plan)",
  minimaxEndpointLabel: "MiniMax /coding_plan/remains",
  minimaxUsageUnavailable: "Could not read MiniMax plan usage",
  grokProviderName: "Grok (subscription)",
  grokEndpointLabel: "Grok CLI billing /v1/billing",
  grokUsageUnavailable: "Could not read Grok subscription usage",
  grokLoginExpired: "Grok login expired — run grok login once to sign in again",
  grokLoginMissing: "No Grok credentials found (run grok login first)",
  quotaRolling: "Rolling",
  quotaWeekly: "Weekly",
  quotaMonthly: "Monthly",
  quotaDuration: (durationMins) =>
    durationMins % 1440 === 0
      ? `${durationMins / 1440}d window`
      : durationMins % 60 === 0
        ? `${durationMins / 60}h window`
        : `${durationMins}m window`,
  quotaResetAt: (resetsAtMs) =>
    `Resets ${new Date(resetsAtMs).toLocaleString("en", { dateStyle: "short", timeStyle: "short" })}`,
};

export function copy(locale: string): Copy {
  return locale?.toLowerCase().startsWith("zh") ? ZH : EN;
}
