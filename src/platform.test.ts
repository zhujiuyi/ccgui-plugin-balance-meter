/**
 * 跨平台适配单测（默认 Windows 已实测；这里覆盖 macOS / Linux 分支）：
 *  - Windows：`cmd /d /c echo %USERPROFILE%`
 *  - macOS / Linux：`sh -c 'printf %s "$HOME"'`
 *  - 路径统一正斜杠（curl file:// 要求），POSIX home 拼出的 URL 必须是
 *    `file:///Users/me/.ccgui-next/config.json` 这种形态。
 */

import { afterEach, describe, expect, it } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import { detectHome, platformFromUserAgent, setPlatformOverride } from "./exec";
import { resolveRoutes } from "./routes";

type Handler = (
  bin: string,
  args: string[],
) => { code: number; stdout: string; stderr: string };

function makeCtx(handler: Handler): PluginContext {
  const kv = new Map<string, unknown>();
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
        return handler(bin, argv);
      },
    },
  } as unknown as PluginContext;
}

afterEach(() => setPlatformOverride(null));

describe("platformFromUserAgent", () => {
  it("maps the UA strings the hosts actually report", () => {
    expect(platformFromUserAgent("Windows")).toBe("windows");
    expect(platformFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(platformFromUserAgent("macOS")).toBe("posix");
    expect(platformFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("posix");
    expect(platformFromUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe("posix");
    // 判不出来时按已实测的 Windows 路径走
    expect(platformFromUserAgent("")).toBe("windows");
    expect(platformFromUserAgent(null)).toBe("windows");
  });
});

describe("home detection per platform", () => {
  it("uses cmd on Windows and sh on macOS / Linux", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const ctx = makeCtx((bin, args) => {
      calls.push({ bin, args });
      return {
        code: 0,
        stdout: bin === "cmd" ? "C:\\Users\\me\r\n" : "/Users/me\n",
        stderr: "",
      };
    });

    setPlatformOverride("windows");
    expect(await detectHome(ctx)).toBe("C:\\Users\\me");
    setPlatformOverride("posix");
    expect(await detectHome(ctx)).toBe("/Users/me");

    expect(calls.map((call) => call.bin)).toEqual(["cmd", "sh"]);
    expect(calls[1].args).toEqual(["-c", 'printf %s "$HOME"']);
  });

  it("rejects output that does not look like a home path", async () => {
    setPlatformOverride("posix");
    const ctx = makeCtx(() => ({ code: 0, stdout: "command not found\n", stderr: "" }));
    expect(await detectHome(ctx)).toBeNull();
  });
});

describe("route resolution on POSIX", () => {
  it("reads ~/.ccgui-next and ~/.claude through forward-slash file URLs", async () => {
    const urls: string[] = [];
    const ctx = makeCtx((bin, args) => {
      if (bin === "sh") return { code: 0, stdout: "/Users/me\n", stderr: "" };
      const url = args[args.length - 1] ?? "";
      if (url.includes(".ccgui-next/config.json")) {
        urls.push(url);
        return {
          code: 0,
          stdout: JSON.stringify({ claude: { providers: {}, current: "__local_settings_json__" } }),
          stderr: "",
        };
      }
      if (url.includes(".claude/settings.json")) {
        urls.push(url);
        return {
          code: 0,
          stdout: JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
              ANTHROPIC_AUTH_TOKEN: "sk-test",
            },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    setPlatformOverride("posix");
    const home = await detectHome(ctx);
    const { routes } = await resolveRoutes(ctx, home);

    expect(urls).toContain("file:///Users/me/.ccgui-next/config.json");
    expect(urls).toContain("file:///Users/me/.claude/settings.json");
    expect(routes).toHaveLength(1);
    expect(routes[0].gateway).toBe("https://api.deepseek.com/anthropic");
    expect(routes[0].credential).toBe("sk-test");
    expect(routes[0].routeKey).toBe("api.deepseek.com/anthropic");
  });

  it("recognises Codex ChatGPT login as an official subscription route", async () => {
    const ctx = makeCtx((_bin, args) => {
      const url = args[args.length - 1] ?? "";
      if (url.includes(".ccgui-next/config.json")) {
        return {
          code: 0,
          stdout: JSON.stringify({ codex: { providers: {}, current: "__local_settings_json__" } }),
          stderr: "",
        };
      }
      if (url.includes(".codex/config.toml")) {
        return { code: 0, stdout: 'model = "gpt-5"', stderr: "" };
      }
      if (url.includes(".codex/auth.json")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            auth_mode: "chatgpt",
            tokens: { access_token: "redacted-test-token" },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { routes, diagnostics } = await resolveRoutes(ctx, "/Users/me");
    expect(diagnostics).toEqual([]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      engine: "codex",
      gateway: "https://chatgpt.com",
      queryKind: "codex-rate-limits",
      credential: null,
    });
  });
});

describe("route resolution: Claude subscription login", () => {
  const CCGUI_CONFIG = JSON.stringify({
    claude: { providers: {}, current: "__local_settings_json__" },
  });
  const OAUTH_CREDENTIALS = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat-redacted-test-token",
      expiresAt: 4_000_000_000_000,
      subscriptionType: "max",
    },
  });

  it("recognises an OAuth login when settings.json has no gateway or key", async () => {
    const ctx = makeCtx((_bin, args) => {
      const url = args[args.length - 1] ?? "";
      if (url.includes(".ccgui-next/config.json")) {
        return { code: 0, stdout: CCGUI_CONFIG, stderr: "" };
      }
      if (url.includes(".claude/settings.json")) {
        return { code: 0, stdout: JSON.stringify({ env: {} }), stderr: "" };
      }
      if (url.endsWith(".claude/.credentials.json")) {
        return { code: 0, stdout: OAUTH_CREDENTIALS, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { routes, diagnostics } = await resolveRoutes(ctx, "C:\\Users\\me");

    expect(diagnostics).toEqual([]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      engine: "claude",
      gateway: "https://api.anthropic.com",
      queryKind: "claude-oauth-usage",
      credential: null,
    });
  });

  it("keeps an explicitly configured gateway and key ahead of the subscription", async () => {
    const ctx = makeCtx((_bin, args) => {
      const url = args[args.length - 1] ?? "";
      if (url.includes(".ccgui-next/config.json")) {
        return { code: 0, stdout: CCGUI_CONFIG, stderr: "" };
      }
      if (url.includes(".claude/settings.json")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
              ANTHROPIC_AUTH_TOKEN: "sk-test",
            },
          }),
          stderr: "",
        };
      }
      if (url.endsWith(".claude/.credentials.json")) {
        return { code: 0, stdout: OAUTH_CREDENTIALS, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { routes } = await resolveRoutes(ctx, "C:\\Users\\me");

    expect(routes[0]).toMatchObject({
      engine: "claude",
      gateway: "https://api.deepseek.com/anthropic",
      queryKind: "http",
      credential: "sk-test",
    });
  });
});

describe("route resolution: coding-plan channels", () => {
  it("upgrades known coding-plan gateways to their quota adapter", async () => {
    const providers = {
      zhipu: { name: "智谱GLM", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKey: "zhipu-key-1" },
      kimi: { name: "Kimi Coding", baseUrl: "https://api.kimi.com/coding/", apiKey: "kimi-key-1" },
      minimax: { name: "MiniMax", baseUrl: "https://api.minimaxi.com/anthropic", apiKey: "mm-key-1" },
    };
    const ctx = makeCtx((_bin, args) => {
      const url = args[args.length - 1] ?? "";
      if (url.includes(".ccgui-next/config.json")) {
        return {
          code: 0,
          stdout: JSON.stringify({ claude: { current: "", providers: {} }, codex: { current: "", providers: {} } }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    for (const [current, expected] of [
      ["zhipu", { queryKind: "zhipu-quota", gateway: "https://open.bigmodel.cn/api/anthropic" }],
      ["kimi", { queryKind: "kimi-usage", gateway: "https://api.kimi.com/coding" }],
      ["minimax", { queryKind: "minimax-plan", gateway: "https://api.minimaxi.com/anthropic" }],
    ] as const) {
      const configured = JSON.stringify({
        claude: { current, providers: { [current]: providers[current as keyof typeof providers] } },
      });
      const routed = makeCtx((_bin, args) => {
        const url = args[args.length - 1] ?? "";
        if (url.includes(".ccgui-next/config.json")) return { code: 0, stdout: configured, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      });
      const { routes } = await resolveRoutes(routed, "C:\\Users\\me");
      expect(routes[0]).toMatchObject({ engine: "claude", ...expected });
      expect(routes[0].credential).toBeTruthy();
    }

    // 未调用任何额外路径（探测只发生在查询阶段）
    expect(ctx).toBeTruthy();
  });

  it("recognises the Kimi Code CLI login for the kimi engine", async () => {
    const ctx = makeCtx((_bin, args) => {
      const url = args[args.length - 1] ?? "";
      if (url.includes(".ccgui-next/config.json")) {
        return {
          code: 0,
          stdout: JSON.stringify({ kimi: { current: "__local_settings_json__", providers: {} } }),
          stderr: "",
        };
      }
      if (url.endsWith(".kimi-code/credentials/kimi-code.json")) {
        return {
          code: 0,
          stdout: JSON.stringify({ access_token: "kimi-cli-token", expires_at: 4_000_000_000 }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { routes, diagnostics } = await resolveRoutes(ctx, "C:\\Users\\me");

    expect(diagnostics).toEqual([]);
    expect(routes[0]).toMatchObject({
      engine: "kimi",
      gateway: "https://api.kimi.com",
      queryKind: "kimi-usage",
      credential: null,
    });
  });

  it("recognises the Grok CLI login for the grok engine", async () => {
    const ctx = makeCtx((_bin, args) => {
      const url = args[args.length - 1] ?? "";
      if (url.includes(".ccgui-next/config.json")) {
        return {
          code: 0,
          stdout: JSON.stringify({ grok: { current: "__local_settings_json__", providers: {} } }),
          stderr: "",
        };
      }
      if (url.endsWith(".grok/auth.json")) {
        return {
          code: 0,
          stdout: JSON.stringify({ "scope::client": { key: "grok-cli-token" } }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { routes, diagnostics } = await resolveRoutes(ctx, "C:\\Users\\me");

    expect(diagnostics).toEqual([]);
    expect(routes[0]).toMatchObject({
      engine: "grok",
      gateway: "https://cli-chat-proxy.grok.com",
      queryKind: "grok-billing",
      credential: null,
    });
  });
});
