/**
 * pi 引擎本地路由单测（全假 ctx，不读真实文件）：
 *  - auth.json 的唯一供应商直接解析出网关与凭证
 *  - models.json 的 baseUrl 覆盖内置网关（代理场景）
 *  - 多个已登录供应商且没有 defaultProvider 时不猜账户
 *  - defaultProvider 明确时按它选供应商
 *  - 显式但不可读的 apiKey 不会回退到另一个凭证或供应商
 *  - 不可读路由不会发起 HTTP 请求、执行凭证命令或持久化凭证
 *  - 过期的 OAuth 登录只提示重新登录
 */

import { describe, expect, it } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import { copy } from "./i18n";
import { resolveRoutes } from "./routes";
import { BalanceStore } from "./state";

const HOME = "C:\\Users\\me";

const CCGUI = JSON.stringify({
  pi: { providers: {}, current: "__local_settings_json__" },
});

function fileUrl(relativePath: string): string {
  return `file:///${HOME.replace(/\\/g, "/")}/${relativePath}`;
}

interface ExecCall {
  bin: string;
  args: string[];
}

function makeCtx(
  files: Record<string, string>,
  calls: ExecCall[] = [],
  kv = new Map<string, unknown>(),
): PluginContext {
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
        if (bin !== "curl") return { code: 0, stdout: "", stderr: "" };
        if (argv.includes("--version")) return { code: 0, stdout: "curl 8", stderr: "" };
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
    expect(diagnostics.join("\n")).toMatch(/多个.*供应商/);
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

  it.each([
    { name: "environment reference", apiKey: "$PROXY_KEY" },
    { name: "command reference", apiKey: "!get-proxy-key --account test" },
    { name: "padded environment reference", apiKey: "  $PROXY_KEY  " },
    { name: "padded command reference", apiKey: "  !get-proxy-key --account test  " },
    { name: "empty string", apiKey: "" },
    { name: "whitespace", apiKey: " \t " },
    { name: "null", apiKey: null },
    { name: "number", apiKey: 123 },
    { name: "boolean", apiKey: false },
    { name: "object", apiKey: { env: "PROXY_KEY" } },
    { name: "array", apiKey: ["PROXY_KEY"] },
  ])("does not send an auth key to a proxy when its model key is an unreadable $name", async ({ apiKey }) => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          deepseek: { type: "api_key", key: "sk-upstream-secret" },
        }),
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { deepseek: { baseUrl: "https://relay.example.com/v1", apiKey } },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);
    const diagnostic = diagnostics.join("\n");

    expect(routes).toHaveLength(0);
    expect(diagnostic).toContain("deepseek");
    expect(diagnostic).toContain("models.json");
    expect(diagnostic).toMatch(/apiKey|凭证/);
    expect(diagnostic).toMatch(/无法.*读取|不可读|读不到/);
    expect(diagnostic).not.toContain("sk-upstream-secret");
    expect(diagnostic).not.toContain("PROXY_KEY");
    expect(diagnostic).not.toContain("get-proxy-key");
  });

  it.each([
    { provider: "deepseek", apiKey: "$DEFAULT_KEY" },
    { provider: "deepseek", apiKey: "!get-default-key" },
    { provider: "custom-relay", apiKey: "$DEFAULT_KEY" },
    { provider: "custom-relay", apiKey: "!get-default-key" },
  ])("keeps the configured $provider identity when its $apiKey key is unreadable", async ({ provider, apiKey }) => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/settings.json")]: JSON.stringify({ defaultProvider: provider }),
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          openai: { type: "api_key", key: "sk-unrelated-account" },
        }),
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { [provider]: { baseUrl: "https://relay.example.com/v1", apiKey } },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(0);
    expect(diagnostics.join("\n")).toContain(provider);
    expect(diagnostics.join("\n")).toContain("models.json");
    expect(diagnostics.join("\n")).toMatch(/无法.*读取|不可读|读不到/);
    expect(diagnostics.join("\n")).not.toContain("sk-unrelated-account");
  });

  it.each(["deepseek", "custom-relay"])("does not replace a credential-less default %s with another account", async (provider) => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/settings.json")]: JSON.stringify({ defaultProvider: provider }),
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          openai: { type: "api_key", key: "sk-unrelated-account" },
        }),
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { [provider]: { baseUrl: "https://relay.example.com/v1" } },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(0);
    expect(diagnostics.join("\n")).toContain(provider);
    expect(diagnostics.join("\n")).toMatch(/未找到.*凭证/);
    expect(diagnostics.join("\n")).not.toContain("sk-unrelated-account");
  });

  it("does not replace a default provider absent from both credential files", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/settings.json")]: JSON.stringify({ defaultProvider: "deepseek" }),
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          openai: { type: "api_key", key: "sk-unrelated-account" },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(0);
    expect(diagnostics.join("\n")).toContain("deepseek");
    expect(diagnostics.join("\n")).toMatch(/未找到.*凭证/);
  });

  it.each(["sk-custom-account", "$CUSTOM_KEY", "!get-custom-key"])("does not guess between an auth provider and a models provider with %s", async (apiKey) => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          deepseek: { type: "api_key", key: "sk-upstream-account" },
        }),
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { "custom-relay": { baseUrl: "https://relay.example.com/v1", apiKey } },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(0);
    expect(diagnostics.join("\n")).toContain("deepseek");
    expect(diagnostics.join("\n")).toContain("custom-relay");
    expect(diagnostics.join("\n")).toMatch(/多个.*供应商/);
    expect(diagnostics.join("\n")).toContain("defaultProvider");
  });

  it.each(["$CUSTOM_KEY", "!get-custom-key"])("identifies the only models provider even when %s is unreadable", async (apiKey) => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { "custom-relay": { baseUrl: "https://relay.example.com/v1", apiKey } },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(0);
    expect(diagnostics.join("\n")).toContain("custom-relay");
    expect(diagnostics.join("\n")).toContain("models.json");
    expect(diagnostics.join("\n")).toMatch(/无法.*读取|不可读|读不到/);
  });

  it("uses the literal model key and deduplicates its matching auth provider", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          deepseek: { type: "api_key", key: "sk-upstream-secret" },
        }),
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { deepseek: { baseUrl: "https://relay.example.com/v1", apiKey: " sk-proxy-key " } },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(1);
    expect(routes[0].gateway).toBe("https://relay.example.com/v1");
    expect(routes[0].credential).toBe("sk-proxy-key");
    expect(routes[0].credentialSource).toContain("models.json");
    expect(routes[0].source).toContain("models.json");
    expect(diagnostics).toHaveLength(0);
  });

  it("resolves a custom provider configured only through a literal model key", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { "custom-relay": { baseUrl: "https://relay.example.com/v1", apiKey: "sk-proxy-key" } },
        }),
      }),
    );

    const { routes } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ gateway: "https://relay.example.com/v1", credential: "sk-proxy-key" });
  });

  it("lets a literal model key override an expired OAuth login", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          deepseek: { type: "oauth", access: "expired-token", refresh: "refresh-secret", expires: 1 },
        }),
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { deepseek: { apiKey: "sk-model-key" } },
        }),
      }),
    );

    const { routes, diagnostics } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(1);
    expect(routes[0].credential).toBe("sk-model-key");
    expect(diagnostics).toHaveLength(0);
  });

  it("accepts an unexpired OAuth login when no model key is configured", async () => {
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          anthropic: { type: "oauth", access: "access-test", expires: Date.now() + 60_000 },
        }),
      }),
    );

    const { routes } = await resolveRoutes(ctx, HOME);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ gateway: "https://api.anthropic.com", credential: "access-test" });
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

describe("pi credential isolation through BalanceStore", () => {
  it.each([
    { name: "proxy model key with same-provider auth", apiKey: "$PROXY_KEY", authProvider: "deepseek" },
    { name: "default provider command key with unrelated auth", apiKey: "!get-proxy-key --account private", authProvider: "openai" },
  ])("blocks network requests and secret persistence for $name", async ({ apiKey, authProvider }) => {
    const calls: ExecCall[] = [];
    const kv = new Map<string, unknown>([
      ["config.homeDir", HOME],
      ["activeEngine", "pi"],
    ]);
    const ctx = makeCtx(
      configFiles({
        [fileUrl(".pi/agent/settings.json")]: JSON.stringify({ defaultProvider: "deepseek" }),
        [fileUrl(".pi/agent/auth.json")]: JSON.stringify({
          [authProvider]: { type: "api_key", key: "sk-never-send-or-persist" },
        }),
        [fileUrl(".pi/agent/models.json")]: JSON.stringify({
          providers: { deepseek: { baseUrl: "https://relay.example.com/v1", apiKey } },
        }),
      }),
      calls,
      kv,
    );
    const store = new BalanceStore(ctx, copy("zh-CN"));
    try {
      await store.init();
      await store.refresh("manual");

      expect(calls.filter((call) => call.args.some((arg) => /^https?:\/\//.test(arg)))).toHaveLength(0);
      expect(store.getSnapshot().routes).toHaveLength(0);
      expect(store.getSnapshot().currentRoute).toBeNull();
      expect(store.getSnapshot().diagnostics.join("\n")).toContain("deepseek");
      // 初始化仅探测 shell 可用性；models.json 的命令绝不能进入执行参数。
      expect(calls.filter((call) => call.bin !== "curl").every((call) => call.args.at(-1) === "echo ok")).toBe(true);
      for (const output of [JSON.stringify(calls), JSON.stringify([...kv]), JSON.stringify(store.getSnapshot())]) {
        expect(output).not.toContain("sk-never-send-or-persist");
        expect(output).not.toContain(apiKey);
      }
    } finally {
      store.dispose();
    }
  });
});
