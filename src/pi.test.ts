/**
 * pi 引擎本地路由单测（全假 ctx，不读真实文件）：
 *  - auth.json 的唯一供应商直接解析出网关与凭证
 *  - models.json 的 baseUrl 覆盖内置网关（代理场景）
 *  - 多个已登录供应商且没有 defaultProvider 时不猜账户
 *  - defaultProvider 明确时按它选供应商
 *  - $ENV 插值的 apiKey 不会被当成字面量凭证
 *  - 过期的 OAuth 登录只提示重新登录
 */

import { describe, expect, it } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import { resolveRoutes } from "./routes";

const HOME = "C:\\Users\\me";

const CCGUI = JSON.stringify({
  pi: { providers: {}, current: "__local_settings_json__" },
});

function fileUrl(relativePath: string): string {
  return `file:///${HOME.replace(/\\/g, "/")}/${relativePath}`;
}

function makeCtx(files: Record<string, string>): PluginContext {
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
        if (bin !== "curl") return { code: 0, stdout: "", stderr: "" };
        const url = argv[argv.length - 1] ?? "";
        return { code: 0, stdout: files[url] ?? "", stderr: "" };
      },
    },
  } as unknown as PluginContext;
}

function configFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [fileUrl(".ccgui-next/config.json")]: CCGUI,
    ...overrides,
  };
}

describe("pi local routes", () => {
  it("resolves the only signed-in provider from auth.json", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          deepseek: { type: "api_key", key: "sk-pi-test" },
        }),
      }),
    );

    const { routes } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      engine: "pi",
      gateway: "https://api.deepseek.com",
      routeKey: "api.deepseek.com",
      credential: "sk-pi-test",
      queryKind: "http",
    });
    expect(routes[0].credentialSource).toContain("auth.json");
  });

  it("lets models.json reroute a built-in provider through a proxy", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          deepseek: { type: "api_key", key: "sk-pi-test" },
        }),
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { deepseek: { baseUrl: "https://relay.example.com/v1" } },
        }),
      }),
    );

    const { routes } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(1);
    expect(routes[0].gateway).toBe("https://relay.example.com/v1");
    expect(routes[0].credential).toBe("sk-pi-test");
  });

  it("does not guess when several providers are signed in", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          deepseek: { type: "api_key", key: "sk-deepseek" },
          openai: { type: "api_key", key: "sk-openai" },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(0);
    expect(diagnostics.join("\n")).toContain("多个已登录供应商");
    expect(diagnostics.join("\n")).toContain("defaultProvider");
  });

  it("follows pi's defaultProvider when several providers are signed in", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/settings.json")]: JSON.stringify({ defaultProvider: "openai" }),
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          deepseek: { type: "api_key", key: "sk-deepseek" },
          openai: { type: "api_key", key: "sk-openai" },
        }),
      }),
    );

    const { routes } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(1);
    expect(routes[0].gateway).toBe("https://api.openai.com/v1");
    expect(routes[0].credential).toBe("sk-openai");
  });

  it("treats an interpolated models.json apiKey as unusable and falls back to auth.json", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          deepseek: { type: "api_key", key: "sk-pi-test" },
        }),
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { deepseek: { apiKey: "$DEEPSEEK_API_KEY" } },
        }),
      }),
    );

    const { routes } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(1);
    expect(routes[0].credential).toBe("sk-pi-test");
    expect(routes[0].credentialSource).toContain("auth.json");
  });

  it("asks for a new login instead of using an expired oauth token", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          anthropic: { type: "oauth", access: "expired-token", refresh: "r", expires: 1 },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(0);
    expect(diagnostics.join("\n")).toContain("登录已过期");
  });
});
