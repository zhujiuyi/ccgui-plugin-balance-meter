/**
 * 状态机单测（全假 ctx，不发真请求）：
 * 覆盖"保存自定义查询地址 → 立即用该地址查询 → 清除后回到自动探测"。
 */

import { describe, expect, it } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import { copy } from "./i18n";
import { BalanceStore } from "./state";

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

  it("reads the host's persisted active tab when no engine was remembered yet", async () => {
    // 宿主启动恢复标签后不发 session://activated —— 插件读它写在 localStorage 的
    // 活动标签兜底（否则首帧只能退到第一条路由，曾把 claude 的余额显示给 codex 用户）。
    const store = new BalanceStore(makeCtx([]), copy("zh-CN"));
    const globalScope = globalThis as { window?: unknown };
    globalScope.window = {
      localStorage: {
        getItem: (key: string) =>
          key === "ccgui-next.activeSession:v1"
            ? JSON.stringify({ engine: "codex", sessionId: "s1", workspacePath: "w" })
            : null,
      },
    };
    try {
      await store.init();
    } finally {
      delete globalScope.window;
    }
    expect(store.getSnapshot().activeEngine).toBe("codex");
    expect(store.getSnapshot().engineConfirmed).toBe(true);
    expect(store.getSnapshot().currentRoute?.routeKey).toBe(CODEX_ROUTE_KEY);
  }, 30_000);
});

describe("BalanceStore inline edit", () => {
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
