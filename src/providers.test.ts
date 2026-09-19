import { describe, expect, it } from "vitest";

import { resolveProvider } from "./providers";

const ctxOf = (gateway: string, key = "sk-test") => ({
  origin: new URL(gateway).origin,
  base: gateway.replace(/\/+$/, ""),
  host: new URL(gateway).hostname.toLowerCase(),
  key,
});

describe("resolveProvider", () => {
  it("matches DeepSeek and asks the root /user/balance regardless of path", () => {
    const { provider, probes } = resolveProvider("https://api.deepseek.com/anthropic", "");
    expect(provider.id).toBe("deepseek");
    const balance = probes.find((probe) => probe.id === "deepseek.user-balance");
    expect(balance?.build(ctxOf("https://api.deepseek.com/anthropic"))).toBe(
      "https://api.deepseek.com/user/balance",
    );
  });

  it("parses a DeepSeek balance payload", () => {
    const { probes } = resolveProvider("https://api.deepseek.com", "");
    const probe = probes.find((entry) => entry.id === "deepseek.user-balance");
    const parsed = probe?.parse({
      is_available: true,
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "98.71",
          granted_balance: "0.00",
          topped_up_balance: "98.71",
        },
      ],
    });
    expect(parsed?.kind).toBe("balance");
    expect(parsed?.amount).toBe(98.71);
    expect(parsed?.currency).toBe("CNY");
  });

  it("falls back to relay probes for unknown gateways", () => {
    const { provider, probes } = resolveProvider("https://relay.example.com/v1", "");
    expect(provider.id).toBe("relay");
    expect(probes.some((probe) => probe.id === "relay.newapi-user-self")).toBe(true);
  });

  it("converts New-API quota units (500000 = 1 USD)", () => {
    const { probes } = resolveProvider("https://relay.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.newapi-user-self");
    const parsed = probe?.parse({ success: true, data: { quota: 500000, used_quota: 250000 } });
    expect(parsed?.amount).toBe(1);
    expect(parsed?.used).toBe(0.5);
    expect(parsed?.currency).toBe("USD");
  });

  it("puts a custom endpoint first when configured", () => {
    const { probes } = resolveProvider(
      "https://relay.example.com/v1",
      "{origin}/api/user/self",
    );
    expect(probes[0].id).toBe("custom.endpoint");
    expect(probes[0].build(ctxOf("https://relay.example.com/v1"))).toBe(
      "https://relay.example.com/api/user/self",
    );
  });

  it("reports a reason for providers without a balance API", () => {
    const { provider, reason } = resolveProvider("https://api.anthropic.com", "");
    expect(provider.id).toBe("anthropic");
    expect(reason).toBeTruthy();
  });

  it("recognises every gateway in the ccgui custom-channel presets", () => {
    // 取自 desktop-cc-gui src/features/settings/providerPresets.ts（v1.0.5）
    const presets: Array<[string, string]> = [
      // claude 预设
      ["https://open.bigmodel.cn/api/anthropic", "zhipu"],
      ["https://api.moonshot.cn/anthropic", "moonshot"],
      ["https://api.kimi.com/coding/", "kimi-coding"],
      ["https://api.deepseek.com/anthropic", "deepseek"],
      ["https://api.minimaxi.com/anthropic", "minimax"],
      ["https://api.xiaomimimo.com/anthropic", "xiaomi"],
      ["https://token-plan-cn.xiaomimimo.com/anthropic", "xiaomi-plan"],
      ["https://dashscope.aliyuncs.com/apps/anthropic", "bailian"],
      ["https://coding.dashscope.aliyuncs.com/apps/anthropic", "bailian"],
      ["https://api.longcat.chat/anthropic", "longcat"],
      ["https://opencode.ai/zen/go", "opencode"],
      ["https://openrouter.ai/api", "openrouter"],
      ["https://api.anthropic.com", "anthropic"],
      // kimi 预设
      ["https://api.kimi.com/coding/v1", "kimi-coding"],
      ["https://api.moonshot.cn/v1", "moonshot"],
      // grok 预设
      ["https://api.x.ai/v1", "xai"],
      // codex 预设
      ["https://open.bigmodel.cn/api/coding/paas/v4", "zhipu"],
      ["https://api.deepseek.com", "deepseek"],
      ["https://api.minimaxi.com/v1", "minimax"],
      ["https://api.xiaomimimo.com/v1", "xiaomi"],
      ["https://coding.dashscope.aliyuncs.com/v1", "bailian"],
      ["https://api.longcat.chat/openai/v1", "longcat"],
      ["https://opencode.ai/zen/go/v1", "opencode"],
      ["https://openrouter.ai/api/v1", "openrouter"],
      ["https://api.openai.com/v1", "openai-api"],
    ];
    for (const [gateway, expected] of presets) {
      const { provider } = resolveProvider(gateway, "");
      expect(provider.id, gateway).toBe(expected);
    }
  });
});
