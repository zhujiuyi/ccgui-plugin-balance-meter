/**
 * 插件状态机：路由解析 → 按缓存优先查余量 → 失败则重新探测 → 落 KV 并通知 UI。
 *
 * 需求对应：
 *  1. 命中的查询地址按「路由键」缓存（KV `route.<key>`）；缓存地址查询失败时
 *     自动重跑探测列表，找到新地址后覆盖缓存。
 *  2. 支持手动刷新（chip 面板 / 设置页 / 命令面板）与每轮对话结束自动刷新
 *     （`usage://done`，按最小间隔节流）。
 */

import type { PluginContext } from "./ccgui-plugin";
import { readClaudeOauthUsage, type ClaudeOauthResult } from "./claude-oauth";
import { readCodexRateLimits } from "./codex";
import {
  readGrokQuota,
  readKimiQuota,
  readMinimaxQuota,
  readZhipuQuota,
  type PlanQuota,
} from "./coding-plans";
import type { Copy } from "./i18n";
import { detectHome, detectPlatform, exec, httpGet } from "./exec";
import {
  resolveProvider,
  type BillingKind,
  type ParsedAmount,
  type Probe,
  type ProbeContext,
  type QuotaWindow,
} from "./providers";
import { originOf, resolveRoutes, type RouteInfo } from "./routes";

export interface BalanceSnapshot {
  kind: "balance" | "subscription" | "unavailable";
  providerId: string;
  providerName: string;
  billing: BillingKind;
  currency: string | null;
  amount: number | null;
  total: number | null;
  used: number | null;
  planName: string | null;
  detail: string | null;
  quotaWindows: QuotaWindow[] | null;
  endpoint: string | null;
  endpointLabel: string | null;
  /** 该结果来自哪种地址：用户为该路由自定义 / 全局自定义 / 自动探测。 */
  endpointSource?: "override" | "custom" | "auto" | null;
  checkedAt: number;
  error: string | null;
}

export interface MeterState {
  ready: boolean;
  home: string | null;
  routes: RouteInfo[];
  currentRoute: RouteInfo | null;
  activeEngine: string | null;
  /**
   * 当前引擎是否已确认：宿主只在"点标签 / 选会话 / 引擎事件"时告知引擎，
   * 应用启动恢复标签时并不补发，所以首帧可能是未确认状态（此时退到第一条路由）。
   */
  engineConfirmed: boolean;
  snapshot: BalanceSnapshot | null;
  /** 每条路由各自的最近结果（routeKey → snapshot），设置页列表用。 */
  snapshots: Record<string, BalanceSnapshot>;
  /** 用户为某条路由手工指定的查询地址（routeKey → 地址模板）。 */
  endpointOverrides: Record<string, string>;
  refreshing: boolean;
  diagnostics: string[];
  /** 出口可用性自检：shell（Windows 的 cmd / *nix 的 sh）与 curl。 */
  execOk: { shell: boolean; curl: boolean };
  autoRefresh: boolean;
  minIntervalSec: number;
  /**
   * 查询地址的内联编辑状态。**故意放在 store 而不是组件里**：宿主的状态栏
   * 会在 hover 等场景重渲染插件 UI，如果编辑态是组件局部 state，就会在用户
   * 打字/移动鼠标时被重置（输入框"自动消失"）。
   */
  edit: EndpointEdit | null;
  /** 面板是否展开。同样放 store：抗宿主重挂，避免 hover 时面板自己收起来。 */
  panelOpen: boolean;
}

export interface EndpointEdit {
  routeKey: string;
  draft: string;
  error: string | null;
  saving: boolean;
}

interface CachedEndpoint {
  endpointId: string;
  endpoint: string;
  providerId: string;
  billing: BillingKind;
  discoveredAt: number;
  lastOkAt: number;
  lastError?: string;
  /** 最近一次探测（含全部失败）的时间戳，用于失败冷却。 */
  lastAttemptAt?: number;
}

/** 全部探测失败后的冷却：自动刷新不再重复打接口，手动刷新可强制重探。 */
const PROBE_COOLDOWN_MS = 10 * 60 * 1000;

const CONFIG_KEYS = {
  autoRefresh: "config.autoRefresh",
  minIntervalSec: "config.minIntervalSec",
  homeDir: "config.homeDir",
  extraEndpoint: "config.extraEndpoint",
} as const;

/** 最近一次确认到的活动引擎（KV），用于下次启动时直接对准路由。 */
const ACTIVE_ENGINE_KEY = "activeEngine";

const INITIAL: MeterState = {
  ready: false,
  home: null,
  routes: [],
  currentRoute: null,
  activeEngine: null,
  engineConfirmed: false,
  snapshot: null,
  snapshots: {},
  endpointOverrides: {},
  refreshing: false,
  diagnostics: [],
  execOk: { shell: false, curl: false },
  autoRefresh: true,
  minIntervalSec: 30,
  edit: null,
  panelOpen: false,
};

export class BalanceStore {
  private listeners = new Set<() => void>();
  private state: MeterState = { ...INITIAL };
  private config = { homeDir: "", extraEndpoint: "" };
  private lastAutoRefreshAt = 0;
  private inFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly ctx: PluginContext,
    private readonly t: Copy,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): MeterState => this.state;

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<MeterState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[balance-meter] listener threw", error);
      }
    }
  }

  private async readConfig(): Promise<void> {
    const [autoRefresh, minIntervalSec, homeDir, extraEndpoint] = await Promise.all([
      this.ctx.storage.get<boolean>(CONFIG_KEYS.autoRefresh),
      this.ctx.storage.get<number>(CONFIG_KEYS.minIntervalSec),
      this.ctx.storage.get<string>(CONFIG_KEYS.homeDir),
      this.ctx.storage.get<string>(CONFIG_KEYS.extraEndpoint),
    ]);
    this.config = {
      homeDir: typeof homeDir === "string" ? homeDir.trim() : "",
      extraEndpoint: typeof extraEndpoint === "string" ? extraEndpoint.trim() : "",
    };
    this.set({
      autoRefresh: autoRefresh ?? true,
      minIntervalSec: typeof minIntervalSec === "number" && minIntervalSec >= 0 ? minIntervalSec : 30,
    });
  }

  async reloadConfig(): Promise<void> {
    await this.readConfig();
    if (this.config.extraEndpoint) await this.refresh("manual");
  }

  async init(): Promise<void> {
    await this.readConfig();
    const platform = detectPlatform();
    const [shellProbe, curlProbe] = await Promise.all([
      platform === "windows"
        ? exec(this.ctx, "cmd", ["/d", "/c", "echo ok"], 5000)
        : exec(this.ctx, "sh", ["-c", "echo ok"], 5000),
      exec(this.ctx, "curl", ["--version"], 5000),
    ]);
    const execOk = { shell: shellProbe.code === 0, curl: curlProbe.code === 0 };

    const home = this.config.homeDir || (await detectHome(this.ctx));
    const { routes, diagnostics } = await resolveRoutes(this.ctx, home);
    // 引擎来源只有两个：① 插件 KV 里记住的上次引擎；② 官方事件
    // （`session://activated` 与 usage 载荷里的 engine）。宿主 1.0.6 起该事件
    // 带粘性回放（上游 PR #1254），插件即便加载晚也能在订阅瞬间拿到当前会话；
    // 更早的宿主则退化为"未确认"，等用户切标签或发一条消息后自动纠正。
    const savedEngine = await this.ctx.storage.get<string>(ACTIVE_ENGINE_KEY);
    const remembered = typeof savedEngine === "string" ? savedEngine.trim() : "";
    const activeEngine = remembered || this.state.activeEngine;
    const currentRoute = this.pickRoute(routes, activeEngine);

    this.set({
      home,
      routes,
      currentRoute,
      activeEngine: activeEngine ?? null,
      engineConfirmed: Boolean(activeEngine),
      execOk,
      diagnostics,
      ready: true,
    });
    const cachedSnapshots: Record<string, BalanceSnapshot> = {};
    const overrides: Record<string, string> = {};
    for (const route of routes) {
      const cached = await this.ctx.storage.get<BalanceSnapshot>(`snapshot.${route.routeKey}`);
      if (cached) cachedSnapshots[route.routeKey] = cached;
      const override = await this.ctx.storage.get<string>(`endpointOverride.${route.routeKey}`);
      if (typeof override === "string" && override.trim()) overrides[route.routeKey] = override;
    }
    this.set({ endpointOverrides: overrides });
    if (Object.keys(cachedSnapshots).length > 0) {
      this.set({
        snapshots: cachedSnapshots,
        snapshot: currentRoute ? cachedSnapshots[currentRoute.routeKey] ?? null : null,
      });
    }
    await this.refresh("init");
  }

  /**
   * 保存某条路由的自定义查询地址（空字符串 = 清除，回到自动探测），
   * 并**立即用新地址查询一次**（需求：保存后即刻生效）。
   */
  async saveEndpointOverride(routeKey: string, value: string): Promise<void> {
    const trimmed = value.trim();
    const overrides = { ...this.state.endpointOverrides };
    if (trimmed) {
      await this.ctx.storage.set(`endpointOverride.${routeKey}`, trimmed);
      overrides[routeKey] = trimmed;
    } else {
      await this.ctx.storage.delete(`endpointOverride.${routeKey}`);
      delete overrides[routeKey];
    }
    this.set({ endpointOverrides: overrides, refreshing: true });
    try {
      const route = this.state.routes.find((candidate) => candidate.routeKey === routeKey);
      if (!route) return;
      const snapshot = await this.queryRoute(route, true);
      await this.ctx.storage.set(`snapshot.${routeKey}`, snapshot);
      this.set({
        snapshots: { ...this.state.snapshots, [routeKey]: snapshot },
        snapshot:
          this.state.currentRoute?.routeKey === routeKey ? snapshot : this.state.snapshot,
      });
    } finally {
      this.set({ refreshing: false });
    }
  }

  /* ── 查询地址的内联编辑（状态存 store，抗宿主重渲染，见 MeterState.edit） ── */

  togglePanel(): void {
    this.set({ panelOpen: !this.state.panelOpen });
  }

  beginEndpointEdit(routeKey: string, initial: string): void {
    this.set({ edit: { routeKey, draft: initial, error: null, saving: false } });
  }

  updateEndpointDraft(draft: string): void {
    const edit = this.state.edit;
    if (!edit) return;
    this.set({ edit: { ...edit, draft, error: null } });
  }

  cancelEndpointEdit(): void {
    if (this.state.edit) this.set({ edit: null });
  }

  /** 校验并保存；地址为空 = 清除自定义，回到自动探测。保存后立即查询一次。 */
  async commitEndpointEdit(): Promise<void> {
    const edit = this.state.edit;
    if (!edit || edit.saving) return;
    const value = edit.draft.trim();
    if (value && !/^(https?:\/\/|\{base\}|\{origin\})/i.test(value)) {
      this.set({ edit: { ...edit, error: this.t.invalidEndpoint } });
      return;
    }
    this.set({ edit: { ...edit, saving: true, error: null } });
    try {
      await this.saveEndpointOverride(edit.routeKey, value);
      this.set({ edit: null });
    } catch (error) {
      this.set({ edit: { ...edit, saving: false, error: String(error) } });
    }
  }

  private pickRoute(routes: RouteInfo[], engine: string | null): RouteInfo | null {
    // 引擎已确认时**只**看该引擎的路由：宁可显示"查不到"，也不能把别的引擎
    // 的余额当成当前引擎的（曾因回退到第一条路由而误显示 claude 的 DeepSeek 余额）。
    if (engine) {
      return routes.find((route) => route.engine === engine) ?? null;
    }
    return routes[0] ?? null;
  }

  onSessionActivated(data: { engine?: string | null }): void {
    this.onEngineSeen(data?.engine ?? null);
  }

  /**
   * 学习当前引擎。两个来源：`session://activated`（用户点标签/选会话，宿主在
   * 启动恢复标签时**不补发**）与 `usage://updated` / `usage://done` 载荷里的
   * `engine`（每轮对话都带）。null/空值忽略：关标签不等于换引擎，保留上次判定。
   */
  onEngineSeen(engine: string | null | undefined): void {
    if (typeof engine !== "string") return;
    const value = engine.trim();
    if (!value || value === this.state.activeEngine) return;
    const currentRoute = this.pickRoute(this.state.routes, value);
    this.set({ activeEngine: value, engineConfirmed: true, currentRoute });
    void this.ctx.storage.set(ACTIVE_ENGINE_KEY, value);
    void this.refresh("route");
  }

  async onTurnEnd(): Promise<void> {
    if (!this.state.autoRefresh) return;
    const interval = this.state.minIntervalSec * 1000;
    if (Date.now() - this.lastAutoRefreshAt < interval) return;
    this.lastAutoRefreshAt = Date.now();
    await this.refresh("auto");
  }

  /**
   * 刷新。手动/启动时重新解析路由并**查询所有路由**（"刷新全部"）；
   * 自动（每轮对话结束）只刷当前路由，避免无谓请求。
   */
  async refresh(reason: "init" | "manual" | "auto" | "route"): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const task = (async () => {
      try {
        if (reason === "manual" || reason === "init") {
          const { routes, diagnostics } = await resolveRoutes(this.ctx, this.state.home);
          const currentRoute = this.pickRoute(routes, this.state.activeEngine);
          this.set({ routes, currentRoute, diagnostics });
        }
        const route = this.state.currentRoute;
        if (!route) {
          this.set({
            snapshot: this.unavailable(
              null,
              null,
              null,
              this.state.activeEngine
                ? this.t.noRouteForEngine(this.state.activeEngine)
                : this.t.noRoute,
            ),
          });
          return;
        }
        this.set({ refreshing: true });
        const targets =
          reason === "auto" || reason === "route"
            ? [route]
            : [
                route,
                ...this.state.routes.filter((candidate) => candidate.routeKey !== route.routeKey),
              ];
        const snapshots = { ...this.state.snapshots };
        const force = reason === "manual";
        for (const target of targets) {
          const snapshot = await this.queryRoute(target, force);
          snapshots[target.routeKey] = snapshot;
          await this.ctx.storage.set(`snapshot.${target.routeKey}`, snapshot);
          if (target.routeKey === this.state.currentRoute?.routeKey) this.set({ snapshot });
        }
        this.set({ snapshots });
      } catch (error) {
        this.set({
          snapshot: this.unavailable(
            this.state.currentRoute?.providerHint ?? null,
            null,
            null,
            String(error),
          ),
        });
      } finally {
        this.set({ refreshing: false });
      }
    })();
    this.inFlight = task;
    try {
      await task;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * 订阅类通道（编程套餐）共用的快照构造：
   * 窗口已是结构化 QuotaWindow，直接透传；失败时映射成可操作提示。
   * CLI 登录类通道（传了 cliLogin* 文案）的过期/缺失/401 都归到「重新登录」。
   */
  private planSnapshot(options: {
    providerId: string;
    providerName: string;
    result: PlanQuota;
    endpoint: string;
    endpointLabel: string;
    unavailablePrefix: string;
    cliLoginExpired: string | null;
    cliLoginMissing: string | null;
  }): BalanceSnapshot {
    const { result } = options;
    if (!result.windows || result.windows.length === 0) {
      return this.unavailable(
        options.providerName,
        options.endpoint,
        "subscription",
        this.planErrorText(options, result),
      );
    }
    const windows = result.windows;
    const primary = windows[0];
    const planType = result.planType ?? null;
    return {
      kind: "subscription",
      providerId: options.providerId,
      providerName: options.providerName,
      billing: "subscription",
      currency: "%",
      amount: primary.remaining,
      total: 100,
      used: primary.used,
      planName: planType
        ? `${planType.charAt(0).toUpperCase()}${planType.slice(1)}`
        : null,
      detail: null,
      quotaWindows: windows,
      endpoint: options.endpoint,
      endpointLabel: options.endpointLabel,
      endpointSource: "auto",
      checkedAt: Date.now(),
      error: null,
    };
  }

  private planErrorText(
    options: { unavailablePrefix: string; cliLoginExpired: string | null; cliLoginMissing: string | null },
    result: PlanQuota,
  ): string {
    if (options.cliLoginExpired && (result.error === "expired" || result.error === "unauthorized")) {
      return options.cliLoginExpired;
    }
    if (options.cliLoginMissing && (result.error === "missing" || !result.error)) {
      return options.cliLoginMissing;
    }
    return `${options.unavailablePrefix}${result.detail ? `（${result.detail}）` : ""}`;
  }

  /** 把 Claude OAuth 查询的失败原因映射成用户可操作的中英文案。 */
  private claudeUsageError(result: ClaudeOauthResult): string {
    if (result.error === "expired" || result.error === "unauthorized") {
      return this.t.claudeLoginExpired;
    }
    if (result.error === "missing") return this.t.claudeLoginMissing;
    return `${this.t.claudeUsageUnavailable}${result.detail ? `（${result.detail}）` : ""}`;
  }

  private unavailable(
    providerName: string | null,
    endpoint: string | null,
    billing: BillingKind | null,
    error: string | null,
    endpointSource: "override" | "custom" | "auto" = "auto",
  ): BalanceSnapshot {
    return {
      kind: "unavailable",
      providerId: "unknown",
      providerName: providerName ?? this.t.billingUnknown,
      billing: billing ?? "unknown",
      currency: null,
      amount: null,
      total: null,
      used: null,
      planName: null,
      detail: null,
      quotaWindows: null,
      endpoint,
      endpointLabel: null,
      endpointSource,
      checkedAt: Date.now(),
      error,
    };
  }

  /** 查一个路由：缓存地址优先，失败则重跑探测列表（需求 1）。 */
  private async queryRoute(route: RouteInfo, force = false): Promise<BalanceSnapshot> {
    if (route.queryKind === "codex-rate-limits") {
      const { limits, error } = await readCodexRateLimits(this.ctx);
      if (!limits) {
        return this.unavailable(
          "OpenAI（ChatGPT）",
          "codex app-server · account/rateLimits/read",
          "subscription",
          `${this.t.codexRateLimitUnavailable}${error ? `：${error}` : ""}`,
        );
      }
      const remaining = Math.max(0, Math.min(100, 100 - limits.primary.usedPercent));
      const windows = [limits.primary, limits.secondary]
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map((item) => ({
          kind: "duration" as const,
          durationMins: item.windowDurationMins,
          used: item.usedPercent,
          remaining: Math.max(0, Math.min(100, 100 - item.usedPercent)),
          resetAt: item.resetsAt * 1000,
        }));
      return {
        kind: "subscription",
        providerId: "openai-chatgpt",
        providerName: "OpenAI（ChatGPT）",
        billing: "subscription",
        currency: "%",
        amount: remaining,
        total: 100,
        used: limits.primary.usedPercent,
        planName: this.t.chatgptPlanName(limits.planType),
        detail: null,
        quotaWindows: windows,
        endpoint: "codex app-server · account/rateLimits/read",
        endpointLabel: "Codex App Server",
        endpointSource: "auto",
        checkedAt: Date.now(),
        error: null,
      };
    }

    if (route.queryKind === "kimi-usage") {
      const result = await readKimiQuota(this.ctx, this.state.home ?? "", route.credential);
      return this.planSnapshot({
        providerId: "kimi-coding",
        providerName: this.t.kimiProviderName,
        result,
        endpoint: "api.kimi.com/coding/v1/usages",
        endpointLabel: this.t.kimiEndpointLabel,
        unavailablePrefix: this.t.kimiUsageUnavailable,
        cliLoginExpired: route.credential ? null : this.t.kimiLoginExpired,
        cliLoginMissing: route.credential ? null : this.t.kimiLoginMissing,
      });
    }

    if (route.queryKind === "zhipu-quota") {
      const result = await readZhipuQuota(this.ctx, route.origin, route.credential);
      return this.planSnapshot({
        providerId: "zhipu-coding-plan",
        providerName: this.t.zhipuProviderName,
        result,
        endpoint: `${route.origin}/api/monitor/usage/quota/limit`,
        endpointLabel: this.t.zhipuEndpointLabel,
        unavailablePrefix: this.t.zhipuUsageUnavailable,
        cliLoginExpired: null,
        cliLoginMissing: null,
      });
    }

    if (route.queryKind === "minimax-plan") {
      const result = await readMinimaxQuota(this.ctx, route.origin, route.credential);
      return this.planSnapshot({
        providerId: "minimax-coding-plan",
        providerName: this.t.minimaxProviderName,
        result,
        endpoint: `${route.origin}/v1/api/openplatform/coding_plan/remains`,
        endpointLabel: this.t.minimaxEndpointLabel,
        unavailablePrefix: this.t.minimaxUsageUnavailable,
        cliLoginExpired: null,
        cliLoginMissing: null,
      });
    }

    if (route.queryKind === "grok-billing") {
      const result = await readGrokQuota(this.ctx, this.state.home ?? "");
      return this.planSnapshot({
        providerId: "xai-grok",
        providerName: this.t.grokProviderName,
        result,
        endpoint: "cli-chat-proxy.grok.com/v1/billing",
        endpointLabel: this.t.grokEndpointLabel,
        unavailablePrefix: this.t.grokUsageUnavailable,
        cliLoginExpired: this.t.grokLoginExpired,
        cliLoginMissing: this.t.grokLoginMissing,
      });
    }

    if (route.queryKind === "claude-oauth-usage") {
      const result = await readClaudeOauthUsage(this.ctx, this.state.home ?? "");
      if (!result.windows) {
        return this.unavailable(
          this.t.claudeProviderName,
          "api/oauth/usage",
          "subscription",
          this.claudeUsageError(result),
        );
      }
      const windows = result.windows.map((window) => ({
        kind: "duration" as const,
        durationMins: window.durationMins,
        used: window.usedPercent,
        remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)),
        resetAt: window.resetsAtMs,
      }));
      const primary = windows[0];
      return {
        kind: "subscription",
        providerId: "claude-subscription",
        providerName: this.t.claudeProviderName,
        billing: "subscription",
        currency: "%",
        amount: primary.remaining,
        total: 100,
        used: primary.used,
        planName: this.t.claudePlanName(result.planType),
        detail: null,
        quotaWindows: windows,
        endpoint: "api/oauth/usage",
        endpointLabel: this.t.claudeEndpointLabel,
        endpointSource: "auto",
        checkedAt: Date.now(),
        error: null,
      };
    }

    const cacheKey = `route.${route.routeKey}`;
    const cached = await this.ctx.storage.get<CachedEndpoint>(cacheKey);
    const override = this.state.endpointOverrides[route.routeKey] ?? "";
    const globalCustom = this.config.extraEndpoint;
    const { provider, probes, reason } = resolveProvider(route.gateway, override || globalCustom);
    const endpointSource: "override" | "custom" | "auto" = override
      ? "override"
      : globalCustom
        ? "custom"
        : "auto";
    const now = Date.now();

    // 失败冷却：该路由已知查不到且刚试过 → 直接复用上次结论，别反复骚扰接口。
    if (
      !force &&
      cached &&
      !cached.endpoint &&
      cached.lastAttemptAt &&
      now - cached.lastAttemptAt < PROBE_COOLDOWN_MS
    ) {
      return this.unavailable(
        provider.name,
        null,
        provider.billing,
        cached.lastError ?? reason,
        endpointSource,
      );
    }

    const probeCtx: ProbeContext = {
      origin: originOf(route.gateway),
      base: route.gateway,
      host: new URL(route.gateway).hostname.toLowerCase(),
      key: route.credential ?? "",
    };

    const ordered = orderProbes(probes, cached?.endpointId ?? null);
    const errors: string[] = [];

    for (const probe of ordered) {
      const url = probe.build(probeCtx);
      if (!url) continue;
      if (!route.credential) {
        errors.push(`${probe.label}: 未找到可用凭证`);
        continue;
      }
      const { status, body } = await httpGet(this.ctx, url, probe.headers(probeCtx));
      if (status < 200 || status >= 300) {
        errors.push(`${probe.label}: HTTP ${status || "无响应"}`);
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        errors.push(`${probe.label}: 响应不是 JSON`);
        continue;
      }
      const parsed = probe.parse(json);
      if (!parsed) {
        errors.push(`${probe.label}: 响应结构未识别`);
        continue;
      }
      const hit: CachedEndpoint = {
        endpointId: probe.id,
        endpoint: url,
        providerId: provider.id,
        billing: probe.billing === "unknown" ? provider.billing : probe.billing,
        discoveredAt: cached?.endpointId === probe.id ? cached.discoveredAt : Date.now(),
        lastOkAt: Date.now(),
      };
      await this.ctx.storage.set(cacheKey, hit);
      return this.snapshotFrom(
        provider.id,
        provider.name,
        hit.billing,
        parsed,
        url,
        probe.label,
        null,
        endpointSource,
      );
    }

    await this.ctx.storage.set(cacheKey, {
      endpointId: cached?.endpointId ?? "",
      endpoint: cached?.endpoint ?? "",
      providerId: provider.id,
      billing: cached?.billing ?? provider.billing,
      discoveredAt: cached?.discoveredAt ?? Date.now(),
      lastOkAt: cached?.lastOkAt ?? 0,
      lastError: errors.slice(-3).join("; ") || "探测列表为空",
      lastAttemptAt: Date.now(),
    } satisfies CachedEndpoint);

    return this.unavailable(
      provider.name,
      cached?.endpoint ?? null,
      provider.billing,
      reason ?? (errors.slice(-2).join("; ") || this.t.unavailable),
      endpointSource,
    );
  }

  private snapshotFrom(
    providerId: string,
    providerName: string,
    billing: BillingKind,
    parsed: ParsedAmount,
    endpoint: string,
    endpointLabel: string,
    error: string | null,
    endpointSource: "override" | "custom" | "auto" = "auto",
  ): BalanceSnapshot {
    return {
      kind: parsed.kind,
      providerId,
      providerName,
      billing,
      currency: parsed.currency ?? null,
      amount: parsed.amount ?? null,
      total: parsed.total ?? null,
      used: parsed.used ?? null,
      planName: parsed.planName ?? null,
      detail: parsed.detail ?? null,
      quotaWindows: parsed.quotaWindows ?? null,
      endpoint,
      endpointLabel,
      endpointSource,
      checkedAt: Date.now(),
      error,
    };
  }
}

/** 缓存命中的接口排在最前；其余按目录顺序（含中转通用探测）。 */
function orderProbes(probes: Probe[], cachedId: string | null): Probe[] {
  if (!cachedId) return probes;
  const hit = probes.find((probe) => probe.id === cachedId);
  if (!hit) return probes;
  return [hit, ...probes.filter((probe) => probe.id !== cachedId)];
}

/** 金额展示：货币符号 + 两位小数（极小值保留 4 位）。 */
export function formatAmount(snapshot: BalanceSnapshot | null): string {
  if (!snapshot || snapshot.kind === "unavailable" || snapshot.amount === null) return "—";
  const symbol =
    snapshot.currency === "CNY" ? "¥" : snapshot.currency === "USD" ? "$" : "";
  if (snapshot.currency === "%") return `${Math.round(snapshot.amount)}%`;
  const value =
    Math.abs(snapshot.amount) > 0 && Math.abs(snapshot.amount) < 0.01
      ? snapshot.amount.toFixed(4)
      : snapshot.amount.toFixed(2);
  return `${symbol}${value}`;
}
