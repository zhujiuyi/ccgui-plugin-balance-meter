/**
 * 状态机单测（全假 ctx，不发真请求）：
 * 覆盖"保存自定义查询地址 → 立即用该地址查询 → 清除后回到自动探测"。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import { copy } from "./i18n";
import {
  BalanceStore,
  primaryWindow,
  quotaMetric,
  quotaValue,
  type BalanceSnapshot,
} from "./state";

const ROUTE_KEY = "api.deepseek.com/anthropic";
const CODEX_ROUTE_KEY = "opencode.ai/zen/go/v1";
const CUSTOM_URL = "https://relay.example.com/api/user/self";

const CCGUI_CONFIG = JSON.stringify({
  claude: { providers: {}, current: "__local_settings_json__" },
  codex: { providers: {}, current: "__local_settings_json__" },
});
const CLAUDE_SETTINGS = JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: "sk-test-key",
  },
});
const CODEX_TOML = `model_provider = "custom"

[model_providers.custom]
base_url = "https://opencode.ai/zen/go/v1"
wire_api = "responses"`;

interface ExecCall {
  bin: string;
  args: string[];
}

function makeCtx(calls: ExecCall[], sharedKv = new Map<string, unknown>()): PluginContext {
  const kv = sharedKv;
  return {
    pluginId: "balance-meter",
    version: "0.1.0",
    host: { appVersion: "1.0.5", sdkVersion: "0.3.11", locale: "zh-CN", isWeb: false },
    storage: {
      async get<T>(key: string): Promise<T | null> {
        return (kv.get(key) as T) ?? null;
      },
      async set(key: string, value: unknown): Promise<void> {
        kv.set(key, value);
      },
      async delete(key: string): Promise<void> {
        kv.delete(key);
      },
    },
    bridge: {
      async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
        if (command !== "plugin_exec_run") throw new Error(`unexpected ${command}`);
        const bin = String(args?.bin ?? "");
        const argv = (args?.args as string[] | undefined) ?? [];
        calls.push({ bin, args: argv });
        if (bin === "cmd") return { code: 0, stdout: "C:\\Users\\tester\r\n", stderr: "" };
        if (argv.includes("--version")) return { code: 0, stdout: "curl 8", stderr: "" };
        const url = argv[argv.length - 1] ?? "";
        if (url.includes(".ccgui-next/config.json")) {
          return { code: 0, stdout: CCGUI_CONFIG, stderr: "" };
        }
        if (url.includes(".claude/settings.json")) {
          return { code: 0, stdout: CLAUDE_SETTINGS, stderr: "" };
        }
        if (url.includes(".codex/config.toml")) {
          return { code: 0, stdout: CODEX_TOML, stderr: "" };
        }
        if (url.startsWith("https://relay.example.com")) {
          return {
            code: 0,
            stdout: `{"data":{"balance":12.5,"used":2.5}}\n__HTTP_STATUS__200`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "not found\n__HTTP_STATUS__404", stderr: "" };
      },
    },
  } as unknown as PluginContext;
}

describe("BalanceStore endpoint override", () => {
  it("queries the saved custom endpoint immediately and can be reset", async () => {
    const calls: ExecCall[] = [];
    const store = new BalanceStore(makeCtx(calls), copy("zh-CN"));
    await store.init();

    expect(store.getSnapshot().currentRoute?.routeKey).toBe(ROUTE_KEY);
    // 自动探测阶段：DeepSeek 官方接口在这个假环境里返回 404 → 无法查询
    expect(store.getSnapshot().snapshot?.kind).toBe("unavailable");

    const before = calls.filter((call) => call.args.some((a) => a.startsWith("https://"))).length;
    await store.saveEndpointOverride(ROUTE_KEY, CUSTOM_URL);
    const after = calls.filter((call) => call.args.some((a) => a.startsWith("https://")));

    const snapshot = store.getSnapshot().snapshots[ROUTE_KEY];
    expect(snapshot.endpoint).toBe(CUSTOM_URL);
    expect(snapshot.endpointSource).toBe("override");
    expect(snapshot.amount).toBe(12.5);
    // 保存后确实立刻发起了新地址的查询
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((call) => call.args.includes(CUSTOM_URL))).toBe(true);

    // 清除覆盖 → 回到自动探测（自定义地址不再被使用）
    await store.saveEndpointOverride(ROUTE_KEY, "");
    expect(store.getSnapshot().endpointOverrides[ROUTE_KEY]).toBeUndefined();
    expect(store.getSnapshot().snapshots[ROUTE_KEY].endpointSource).toBe("auto");
  }, 30_000);
});

describe("BalanceStore active engine", () => {
  it("switches route when the engine is learned from a usage/session event", async () => {
    const calls: ExecCall[] = [];
    const kv = new Map<string, unknown>();
    const store = new BalanceStore(makeCtx(calls, kv), copy("zh-CN"));
    await store.init();

    // 首次启动没有事件：只能退到第一条路由，且标记为"未确认"
    expect(store.getSnapshot().currentRoute?.routeKey).toBe(ROUTE_KEY);
    expect(store.getSnapshot().engineConfirmed).toBe(false);

    // codex 引擎出现（session://activated 或 usage 事件）→ 必须切到 codex 的路由
    store.onEngineSeen("codex");
    expect(store.getSnapshot().activeEngine).toBe("codex");
    expect(store.getSnapshot().engineConfirmed).toBe(true);
    expect(store.getSnapshot().currentRoute?.routeKey).toBe(CODEX_ROUTE_KEY);

    // 重启（同一 KV）后无需任何事件就应对准 codex —— 这正是"显示成 claude 余额"的回归点
    const restarted = new BalanceStore(makeCtx([], kv), copy("zh-CN"));
    await restarted.init();
    expect(restarted.getSnapshot().activeEngine).toBe("codex");
    expect(restarted.getSnapshot().currentRoute?.routeKey).toBe(CODEX_ROUTE_KEY);
  }, 30_000);

  it("does not fall back to another engine's route when the engine has no config", async () => {
    const calls: ExecCall[] = [];
    const store = new BalanceStore(makeCtx(calls), copy("zh-CN"));
    await store.init();

    store.onEngineSeen("kimi");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const state = store.getSnapshot();
    expect(state.activeEngine).toBe("kimi");
    expect(state.currentRoute).toBeNull();
    expect(state.snapshot?.kind).toBe("unavailable");
    expect(state.snapshot?.error ?? "").toContain("kimi");
  }, 30_000);

  it("stays unconfirmed until the host reports an engine (no host-internal reads)", async () => {
    // 插件不读 localStorage 等宿主内部状态（市场黑名单硬错误）。引擎只能来自
    // 官方事件；在事件到达之前显示"未确认"，到达后立刻纠正。
    const store = new BalanceStore(makeCtx([]), copy("zh-CN"));
    await store.init();
    expect(store.getSnapshot().engineConfirmed).toBe(false);
    expect(store.getSnapshot().activeEngine).toBeNull();

    store.onEngineSeen("codex");
    expect(store.getSnapshot().engineConfirmed).toBe(true);
    expect(store.getSnapshot().currentRoute?.routeKey).toBe(CODEX_ROUTE_KEY);

    // 源码里不应再出现 localStorage 读取（市场 CI 会扫产物）
    const source = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
    expect(source.includes("localStorage")).toBe(false);
  }, 30_000);
});

describe("BalanceStore Claude subscription route", () => {
  const CLAUDE_ONLY_CONFIG = JSON.stringify({
    claude: { providers: {}, current: "__local_settings_json__" },
  });
  const EMPTY_CLAUDE_SETTINGS = JSON.stringify({ env: {} });
  const USAGE_BODY = JSON.stringify({
    five_hour: { utilization: 0.41, resets_at: 1_790_000_000 },
    seven_day: { utilization: 0.17, resets_at: 1_790_300_000 },
  });

  function oauthCredentials(expiresAt: number): string {
    return JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat-redacted-test-token",
        expiresAt,
        subscriptionType: "max",
      },
    });
  }

  function makeSubscriptionCtx(credentials: string): PluginContext {
    return {
      pluginId: "balance-meter",
      version: "0.2.0",
      host: { appVersion: "1.0.6", sdkVersion: "0.3.11", locale: "zh-CN", isWeb: false },
      storage: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      bridge: {
        async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
          if (command !== "plugin_exec_run") throw new Error(`unexpected ${command}`);
          const bin = String(args?.bin ?? "");
          const argv = (args?.args as string[] | undefined) ?? [];
          if (bin === "cmd") return { code: 0, stdout: "C:\\Users\\tester\r\n", stderr: "" };
          if (argv.includes("--version")) return { code: 0, stdout: "curl 8", stderr: "" };
          const url = argv[argv.length - 1] ?? "";
          if (url.includes(".ccgui-next/config.json")) {
            return { code: 0, stdout: CLAUDE_ONLY_CONFIG, stderr: "" };
          }
          if (url.includes(".claude/settings.json")) {
            return { code: 0, stdout: EMPTY_CLAUDE_SETTINGS, stderr: "" };
          }
          if (url.endsWith(".claude/.credentials.json")) {
            return { code: 0, stdout: credentials, stderr: "" };
          }
          if (url.startsWith("https://api.anthropic.com/api/oauth/usage")) {
            return { code: 0, stdout: `${USAGE_BODY}\n__HTTP_STATUS__200`, stderr: "" };
          }
          return { code: 0, stdout: "\n__HTTP_STATUS__404", stderr: "" };
        },
      },
    } as unknown as PluginContext;
  }

  it("shows the OAuth quota windows as structured rows", async () => {
    const store = new BalanceStore(
      makeSubscriptionCtx(oauthCredentials(Date.now() + 3_600_000)),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("subscription");
    expect(snapshot?.providerName).toContain("Claude");
    expect(snapshot?.planName).toBe("Claude Max");
    expect(snapshot?.quotaWindows).toEqual([
      { kind: "duration", durationMins: 300, used: 41, remaining: 59, resetAt: 1_790_000_000_000 },
      { kind: "duration", durationMins: 10_080, used: 17, remaining: 83, resetAt: 1_790_300_000_000 },
    ]);
    expect(snapshot?.error).toBeNull();
  }, 30_000);

  it("tells the user to re-login when the Claude OAuth token expired", async () => {
    const store = new BalanceStore(
      makeSubscriptionCtx(oauthCredentials(Date.now() - 60_000)),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("unavailable");
    expect(snapshot?.error ?? "").toContain("过期");
  }, 30_000);
});

describe("BalanceStore coding-plan routes", () => {
  function quotaCtx(
    config: unknown,
    files: Array<[suffix: string, content: string]>,
    http: Array<[prefix: string, body: string]>,
  ): PluginContext {
    return {
      pluginId: "balance-meter",
      version: "0.2.0",
      host: { appVersion: "1.0.6", sdkVersion: "0.3.11", locale: "zh-CN", isWeb: false },
      storage: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      bridge: {
        async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
          if (command !== "plugin_exec_run") throw new Error(`unexpected ${command}`);
          const bin = String(args?.bin ?? "");
          const argv = (args?.args as string[] | undefined) ?? [];
          if (bin === "cmd") return { code: 0, stdout: "C:\\Users\\tester\r\n", stderr: "" };
          if (argv.includes("--version")) return { code: 0, stdout: "curl 8", stderr: "" };
          const url = argv[argv.length - 1] ?? "";
          if (url.includes(".ccgui-next/config.json")) {
            return { code: 0, stdout: JSON.stringify(config), stderr: "" };
          }
          for (const [prefix, body] of http) {
            if (url.startsWith(prefix)) {
              return { code: 0, stdout: `${body}\n__HTTP_STATUS__200`, stderr: "" };
            }
          }
          for (const [suffix, content] of files) {
            if (url.endsWith(suffix)) return { code: 0, stdout: content, stderr: "" };
          }
          return { code: 0, stdout: "\n__HTTP_STATUS__404", stderr: "" };
        },
      },
    } as unknown as PluginContext;
  }

  it("shows the Zhipu GLM quota for an API-key route", async () => {
    const store = new BalanceStore(
      quotaCtx(
        {
          claude: {
            current: "zhipu",
            providers: {
              zhipu: {
                name: "智谱GLM",
                baseUrl: "https://open.bigmodel.cn/api/anthropic",
                apiKey: "zhipu-key-1",
              },
            },
          },
        },
        [],
        [
          [
            "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
            JSON.stringify({
              success: true,
              data: {
                level: "max",
                limits: [
                  {
                    type: "TOKENS_LIMIT",
                    unit: 3,
                    number: 5,
                    percentage: 12.5,
                    nextResetTime: 1_790_000_000_000,
                  },
                ],
              },
            }),
          ],
        ],
      ),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("subscription");
    expect(snapshot?.providerName).toBe("智谱 GLM（套餐）");
    expect(snapshot?.planName).toBe("Max");
    expect(snapshot?.quotaWindows).toEqual([
      {
        kind: "duration",
        durationMins: 300,
        used: 12.5,
        remaining: 87.5,
        resetAt: 1_790_000_000_000,
      },
    ]);
    expect(snapshot?.error).toBeNull();
  }, 30_000);

  const AMR_CONFIG = JSON.stringify({
    profiles: {
      prod: {
        controlKey: "ctl-prod",
        runtimeKey: "sk-amr-runtime",
        apiUrl: "https://amr-api.open-design.ai",
      },
    },
  });
  const OPEN_DESIGN_ROUTE = {
    claude: {
      current: "opendesign",
      providers: {
        opendesign: {
          name: "OpenDesign",
          baseUrl: "https://amr-link.open-design.ai",
          apiKey: "sk-amr-runtime",
        },
      },
    },
  };

  it("shows the subscription quota windows when the account has one", async () => {
    const store = new BalanceStore(
      quotaCtx(
        OPEN_DESIGN_ROUTE,
        [[".amr/config.json", AMR_CONFIG]],
        [
          [
            "https://amr-api.open-design.ai/api/v1/billing/summary",
            JSON.stringify({
              balanceUsd: "1.5000",
              totalAvailableCreditsUsd: "1.5000",
              membershipTier: "go",
              subscriptionStatus: "active",
              subscriptionCurrentPeriodEnd: "2026-11-19T10:14:11.000Z",
            }),
          ],
          [
            // 更长的前缀必须排在 `/api/v1/workspaces` 之前（fixture 按前缀顺序匹配）。
            "https://amr-api.open-design.ai/api/v1/workspaces/ws-personal-1/billing/funding-check",
            JSON.stringify({
              codingPlan: {
                eligible: true,
                tier: "go",
                windows: [
                  {
                    durationSeconds: 18000,
                    usedCredits: "243",
                    limitCredits: "50000",
                    remainingCredits: "49757",
                    resetsAt: "2026-10-19T20:14:11.000Z",
                  },
                  {
                    durationSeconds: 604800,
                    usedCredits: "8791",
                    limitCredits: "150000",
                    remainingCredits: "141209",
                    resetsAt: "2026-10-26T10:14:11.000Z",
                  },
                ],
              },
            }),
          ],
          [
            "https://amr-api.open-design.ai/api/v1/workspaces",
            JSON.stringify({
              items: [
                {
                  workspaceId: "ws-personal-1",
                  workspaceType: "personal",
                  workspaceMemberId: "wm-1",
                  memberStatus: "active",
                  lifecycleState: "active",
                },
              ],
            }),
          ],
        ],
      ),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("subscription");
    expect(snapshot?.providerName).toBe("Open Design");
    expect(snapshot?.planName).toBe("Open Design Go");
    expect(snapshot?.quotaWindows).toHaveLength(2);
    expect(snapshot?.quotaWindows?.[0]).toMatchObject({ kind: "duration", durationMins: 300 });
    expect(snapshot?.error).toBeNull();
  }, 30_000);

  it("shows the account balance when the account has no subscription", async () => {
    const store = new BalanceStore(
      quotaCtx(
        OPEN_DESIGN_ROUTE,
        [[".amr/config.json", AMR_CONFIG]],
        [
          [
            "https://amr-api.open-design.ai/api/v1/billing/summary",
            JSON.stringify({
              balanceUsd: "1.5000",
              creditsPerUsd: 10000,
              totalAvailableCreditsUsd: "1.5000",
              subscriptionCreditsUsd: "1.0000",
              rechargeCreditsUsd: "0.5000",
              membershipTier: "go",
              subscriptionStatus: "none",
            }),
          ],
        ],
      ),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("balance");
    expect(snapshot?.providerName).toBe("Open Design");
    expect(snapshot?.currency).toBe("USD");
    expect(snapshot?.amount).toBe(1.5);
    expect(snapshot?.detail).toBe("订阅 $1.00 + 充值 $0.50");
    expect(snapshot?.error).toBeNull();
  }, 30_000);

  it("tells the user to sign in to Open Design when the client config is missing", async () => {
    const store = new BalanceStore(
      quotaCtx(
        {
          claude: {
            current: "opendesign",
            providers: {
              opendesign: {
                name: "OpenDesign",
                baseUrl: "https://amr-link.open-design.ai",
                apiKey: "sk-amr-runtime",
              },
            },
          },
        },
        [],
        [],
      ),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("unavailable");
    expect(snapshot?.error ?? "").toContain("Open Design");
  }, 30_000);

  it("shows the Kimi For Coding windows for a CLI login", async () => {
    const store = new BalanceStore(
      quotaCtx(
        { kimi: { current: "__local_settings_json__", providers: {} } },
        [
          [
            ".kimi-code/credentials/kimi-code.json",
            JSON.stringify({ access_token: "kimi-cli-token", expires_at: 4_000_000_000 }),
          ],
        ],
        [
          [
            "https://api.kimi.com/coding/v1/usages",
            JSON.stringify({
              limits: [{ detail: { limit: 100, remaining: 63, resetTime: "2026-09-21T18:00:00Z" } }],
              usage: { limit: 1000, used: 250, resetTime: "2026-09-28T00:00:00Z" },
              subType: "kimi-for-coding",
            }),
          ],
        ],
      ),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("subscription");
    expect(snapshot?.providerName).toBe("Kimi（套餐）");
    expect(snapshot?.planName).toBe("Kimi-for-coding");
    expect(snapshot?.quotaWindows).toHaveLength(2);
    expect(snapshot?.quotaWindows?.[1].kind).toBe("weekly");
  }, 30_000);

  it("shows the MiniMax windows for an API-key route", async () => {
    const store = new BalanceStore(
      quotaCtx(
        {
          codex: {
            current: "mm",
            providers: {
              mm: { name: "MiniMax", baseUrl: "https://api.minimaxi.com/anthropic", apiKey: "mm-key-1" },
            },
          },
        },
        [],
        [
          [
            "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
            JSON.stringify({
              base_resp: { status_code: 0 },
              model_remains: [
                {
                  model_name: "general",
                  current_interval_remaining_percent: 72.5,
                  end_time: 1_790_000_000_000,
                  current_weekly_status: 3,
                },
              ],
            }),
          ],
        ],
      ),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("subscription");
    expect(snapshot?.providerName).toBe("MiniMax（套餐）");
    expect(snapshot?.quotaWindows?.[0]).toMatchObject({ kind: "duration", used: 27.5 });
  }, 30_000);

  it("shows the Grok credit window and reports an expired CLI login", async () => {
    const grokBody = JSON.stringify({
      config: {
        creditUsagePercent: 42,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-27T00:00:00Z" },
      },
    });
    const store = new BalanceStore(
      quotaCtx(
        { grok: { current: "__local_settings_json__", providers: {} } },
        [
          [
            ".grok/auth.json",
            JSON.stringify({ "scope::client": { key: "grok-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() } }),
          ],
        ],
        [["https://cli-chat-proxy.grok.com/v1/billing", grokBody]],
      ),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("subscription");
    expect(snapshot?.providerName).toBe("Grok（订阅）");
    expect(snapshot?.quotaWindows).toEqual([
      { kind: "weekly", used: 42, remaining: 58, resetAt: Date.parse("2026-09-27T00:00:00Z") },
    ]);
  }, 30_000);

  it("tells the user to re-login when a CLI credential expired", async () => {
    const store = new BalanceStore(
      quotaCtx(
        { grok: { current: "__local_settings_json__", providers: {} } },
        [
          [
            ".grok/auth.json",
            JSON.stringify({ "scope::client": { key: "grok-token", expires_at: new Date(Date.now() - 60_000).toISOString() } }),
          ],
        ],
        [],
      ),
      copy("zh-CN"),
    );
    await store.init();

    const snapshot = store.getSnapshot().snapshot;
    expect(snapshot?.kind).toBe("unavailable");
    expect(snapshot?.error ?? "").toContain("过期");
  }, 30_000);
});

describe("BalanceStore inline edit", () => {
  it("closes the status panel idempotently", () => {
    const store = new BalanceStore(makeCtx([]), copy("zh-CN"));
    expect(store.getSnapshot().panelOpen).toBe(false);

    store.togglePanel();
    expect(store.getSnapshot().panelOpen).toBe(true);

    store.closePanel();
    expect(store.getSnapshot().panelOpen).toBe(false);
    store.closePanel();
    expect(store.getSnapshot().panelOpen).toBe(false);
  });

  it("keeps the draft across store updates and rejects invalid addresses", async () => {
    const store = new BalanceStore(makeCtx([]), copy("zh-CN"));
    await store.init();

    store.beginEndpointEdit(ROUTE_KEY, "");
    store.updateEndpointDraft("ftp://nope");
    // 宿主的状态栏会 hover 等场景让插件重渲染；编辑态在 store 上，不该被清掉
    await store.refresh("auto");
    expect(store.getSnapshot().edit?.draft).toBe("ftp://nope");

    await store.commitEndpointEdit();
    expect(store.getSnapshot().edit?.error).toBeTruthy();
    expect(store.getSnapshot().edit?.draft).toBe("ftp://nope");

    store.cancelEndpointEdit();
    expect(store.getSnapshot().edit).toBeNull();
  }, 30_000);
});

describe("quota helpers and history samples", () => {
  function snapshot(kind: BalanceSnapshot["kind"], windows: BalanceSnapshot["quotaWindows"]): BalanceSnapshot {
    return {
      kind,
      providerId: "p",
      providerName: "P",
      billing: kind === "subscription" ? "subscription" : "api",
      currency: kind === "subscription" ? "%" : "USD",
      amount: kind === "subscription" ? (windows?.[0].remaining ?? null) : 12.5,
      total: kind === "subscription" ? 100 : null,
      used: null,
      planName: null,
      detail: null,
      quotaWindows: windows,
      endpoint: "https://example.test",
      endpointLabel: "e",
      checkedAt: 0,
      error: null,
    };
  }

  const WINDOWS = [
    { kind: "weekly" as const, used: 6, remaining: 94, resetAt: null },
    { kind: "duration" as const, durationMins: 300, used: 1, remaining: 99, resetAt: null },
  ];

  it("picks the shortest window as the headline metric", () => {
    const sub = snapshot("subscription", WINDOWS);
    expect(primaryWindow(sub)?.durationMins).toBe(300);
    expect(quotaValue(sub)).toBe(99);
    expect(quotaMetric(sub)).toBe("duration:300");
    // 余额渠道没有窗口，指标换成币种 + 金额
    expect(primaryWindow(snapshot("balance", null))).toBeNull();
    expect(quotaValue(snapshot("balance", null))).toBe(12.5);
    expect(quotaMetric(snapshot("balance", null))).toBe("amount:USD");
    expect(quotaValue({ ...sub, kind: "unavailable" })).toBeNull();
  });

  it("records a sample after a refresh and keeps only the same metric", async () => {
    const kv = new Map<string, unknown>();
    const store = new BalanceStore(makeCtx([], kv), copy("zh-CN"));
    await store.init();
    // 查询失败（unavailable）不记样本，避免把 0 画进趋势图
    expect(store.getSnapshot().history[ROUTE_KEY] ?? []).toHaveLength(0);

    await store.saveEndpointOverride(ROUTE_KEY, CUSTOM_URL);
    const samples = store.getSnapshot().history[ROUTE_KEY] ?? [];
    expect(samples.length).toBe(1);
    expect(samples[0].metric).toBe("amount:");
    expect(samples[0].value).toBe(12.5);

    // 同一取值且间隔不足 5 分钟：不重复记录
    await store.saveEndpointOverride(ROUTE_KEY, CUSTOM_URL);
    expect((store.getSnapshot().history[ROUTE_KEY] ?? []).length).toBe(1);
    expect(kv.get(`history.${ROUTE_KEY}`)).toHaveLength(1);
  }, 30_000);
});
