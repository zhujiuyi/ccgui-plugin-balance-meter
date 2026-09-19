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
  /** 使用说明 */
  helpTitle: string;
  helpIntro: string;
  helpUpdateTitle: string;
  helpUpdateItems: string[];
  helpCacheTitle: string;
  helpCacheItems: string[];
  helpDataTitle: string;
  helpDataItems: string[];
  helpPlatformTitle: string;
  helpPlatformItems: string[];
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
}

const ZH: Copy = {
  chipAria: "点击查看当前路由的余额与余量",
  chipUnknown: "—",
  chipUnavailable: "无法查询",
  panelTitle: "余额与余量",
  rowProvider: "供应商",
  rowBilling: "计费方式",
  rowAmount: "当前余量",
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
  helpTitle: "使用说明",
  helpIntro:
    "插件按「当前引擎实际在用的网关地址」判断供应商与计费方式：API 计费查余额，订阅计划查余量；供应商没有公开接口时，明确显示「暂时无法提供余额显示」。",
  helpUpdateTitle: "什么时候会更新",
  helpUpdateItems: [
    "打开 CC GUI：按上次使用的引擎（或宿主回放的当前会话）对准路由，立即查询一次。",
    "切换标签 / 选择会话（换了引擎）：立刻切到该引擎的路由重新查询。",
    "每轮对话结束：自动刷新一次（默认两次刷新之间至少间隔 30 秒）。",
    "手动：状态栏图标点开后的「立即刷新」、本页「刷新全部路由」、命令面板的「刷新余额与余量」。",
  ],
  helpCacheTitle: "查询地址与缓存",
  helpCacheItems: [
    "查询成功的接口按路由（域名 + 路径）缓存，下次直接命中。",
    "缓存地址失效会自动重新探测；全部失败后 10 分钟内不再重复请求，手动刷新可强制重探。",
    "想自己指定接口：在上方「查询地址」点「修改」，填 http(s) 地址或含 {base} / {origin} 的模板，保存后立刻按新地址查一次。",
  ],
  helpDataTitle: "数据与权限",
  helpDataItems: [
    "读取 ~/.ccgui-next/config.json 与各引擎本地配置（claude → ~/.claude/settings.json，codex → ~/.codex/config.toml 等）。",
    "密钥只用于向该路由自己的供应商发起只读查询，不外发第三方、不写日志。",
    "因宿主的网络出口要求预先声明域名，本插件改用 exec:curl 读配置/发请求，并用 exec:cmd（Windows）或 exec:sh（macOS / Linux）定位用户目录。",
    "不读取宿主内部状态（浏览器本地存储 / 内部 store）：当前引擎只来自官方事件。",
  ],
  helpPlatformTitle: "适用平台",
  helpPlatformItems: [
    "Windows：已实测（2026-09，cmd + 反斜杠环境）。",
    "macOS / Linux：已做跨平台适配（sh 取 $HOME、路径统一正斜杠、curl 通用参数），但尚未在真机验证；如在其它系统遇到问题请反馈。",
    "宿主版本：启动瞬间就认对引擎依赖 `session://activated` 的粘性回放（上游 PR #1254）。更早的宿主会在首帧显示「未确认」，切一次标签或发一条消息即自动纠正。",
  ],
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
  settingsKeySource: "凭证来源",
  refreshAll: "刷新全部路由",
  ok: "是",
  missing: "否",
  cmdRefreshTitle: "刷新余额与余量",
  neverChecked: "尚未查询",
};

const EN: Copy = {
  chipAria: "Click to inspect the balance / quota of the active route",
  chipUnknown: "—",
  chipUnavailable: "n/a",
  panelTitle: "Balance & quota",
  rowProvider: "Provider",
  rowBilling: "Billing",
  rowAmount: "Remaining",
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
  helpTitle: "How it works",
  helpIntro:
    "The plugin resolves the gateway actually used by the active engine, then queries that provider: balance for API billing, remaining quota for subscription plans. When the provider exposes nothing public it says so explicitly.",
  helpUpdateTitle: "When the display updates",
  helpUpdateItems: [
    "On app start: the route follows the engine you used last (or the session the host replays) and is queried once immediately.",
    "When you switch tabs or sessions (i.e. engines): the route switches and re-queries right away.",
    "After every turn: one automatic refresh (default minimum interval 30s between refreshes).",
    "Manually: the chip panel's Refresh now, Refresh all routes here, or the command palette entry.",
  ],
  helpCacheTitle: "Endpoints and caching",
  helpCacheItems: [
    "A working endpoint is cached per route (host + path) and reused next time.",
    "If the cached endpoint stops working the plugin re-probes; after a full failure it stays quiet for 10 minutes (a manual refresh forces a re-probe).",
    "To pin one yourself: use Edit above the endpoint, enter an http(s) URL or a template with {base} / {origin}, save — it queries immediately.",
  ],
  helpDataTitle: "Data and permissions",
  helpDataItems: [
    "Reads ~/.ccgui-next/config.json and each engine's own config (claude → ~/.claude/settings.json, codex → ~/.codex/config.toml, …).",
    "Your key is only used for read-only queries against that route's own provider; it never leaves for a third party and is never logged.",
    "The host's network egress requires pre-declared domains, so this plugin uses exec:curl for config reads and requests, plus exec:cmd (Windows) or exec:sh (macOS / Linux) to locate the home directory.",
    "No host internals are read (no browser local storage / internal stores): the active engine comes from official events only.",
  ],
  helpPlatformTitle: "Platforms",
  helpPlatformItems: [
    "Windows: verified (2026-09, cmd + backslash environment).",
    "macOS / Linux: ported (sh for $HOME, forward-slash paths, portable curl flags) but not yet verified on real machines; please report issues.",
    "Host version: knowing the engine right at startup relies on the replay of `session://activated` (upstream PR #1254). On older hosts the first frame shows unconfirmed and self-corrects on the next tab switch or message.",
  ],
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
  settingsKeySource: "Credential source",
  refreshAll: "Refresh all routes",
  ok: "yes",
  missing: "no",
  cmdRefreshTitle: "Refresh balance and quota",
  neverChecked: "not checked yet",
};

export function copy(locale: string): Copy {
  return locale?.toLowerCase().startsWith("zh") ? ZH : EN;
}
