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
});
