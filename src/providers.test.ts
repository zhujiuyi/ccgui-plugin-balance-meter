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

  it("falls back to the relay probe chain for unknown gateways, best endpoint first", () => {
    const { provider, probes } = resolveProvider("https://relay.example.com/v1", "");
    expect(provider.id).toBe("relay");
    expect(probes.map((probe) => probe.id)).toEqual([
      "relay.newapi-token-usage",
      "relay.newapi-billing",
      "relay.sub2api-usage",
      "relay.cchub-quota",
      "relay.closeai-credits",
      "relay.credits",
      "relay.newapi-user-self",
    ]);
  });

  it("asks the relay's own quota unit instead of hardcoding 500000", () => {
    const { probes } = resolveProvider("https://relay.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.newapi-token-usage");
    expect(probe?.meta?.[0].build(ctxOf("https://relay.example.com"))).toBe(
      "https://relay.example.com/api/status",
    );
    const parsed = probe?.parse(
      {
        data: {
          object: "token_usage",
          total_granted: 1_250_000,
          total_used: 250_000,
          total_available: 1_000_000,
        },
      },
      [{ data: { quota_per_unit: 1_000_000, quota_display_type: "USD" } }],
    );
    expect(parsed?.amount).toBe(1);
    expect(parsed?.used).toBe(0.25);
    expect(parsed?.currency).toBe("USD");
  });

  it("keeps the New-API default unit when the site status is unavailable", () => {
    const { probes } = resolveProvider("https://relay.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.newapi-token-usage");
    const parsed = probe?.parse(
      { data: { object: "token_usage", total_available: 500_000, total_used: 250_000 } },
      [null],
    );
    expect(parsed?.amount).toBe(1);
    expect(parsed?.used).toBe(0.5);
  });

  it("marks an unlimited relay token instead of showing its sentinel number", () => {
    const { probes } = resolveProvider("https://relay.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.newapi-token-usage");
    const parsed = probe?.parse(
      {
        data: {
          object: "token_usage",
          unlimited_quota: true,
          total_available: 100_000_000,
          total_used: 123,
        },
      },
      [{ data: { quota_per_unit: 500_000 } }],
    );
    expect(parsed?.amount).toBeNull();
    expect(parsed?.detail).toContain("无限");
  });

  it("does not treat the relay's total limit as the remaining balance", () => {
    const { probes } = resolveProvider("https://relay.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.newapi-billing");
    const parsed = probe?.parse(
      { object: "billing_subscription", hard_limit_usd: 20, system_hard_limit_usd: 20 },
      [{ data: { quota_per_unit: 500_000 } }, { object: "list", total_usage: 350 }],
    );
    // 20 − 350 美分 = 16.5，而不是把 20 当余额
    expect(parsed?.total).toBe(20);
    expect(parsed?.used).toBe(3.5);
    expect(parsed?.amount).toBe(16.5);
  });

  it("refuses the billing math when the site counts tokens instead of money", () => {
    // TOKENS / CUSTOM 显示模式下，*_usd 字段已被站点改写（装的是 token 数或自定义币种），
    // 再按「总额 − 美分/100」算就会得出一个没有意义的金额。
    const { probes } = resolveProvider("https://relay.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.newapi-billing");
    const parsed = probe?.parse(
      { object: "billing_subscription", hard_limit_usd: 900_000 },
      [{ data: { quota_per_unit: 500_000, quota_display_type: "TOKENS" } }, { total_usage: 350 }],
    );
    expect(parsed).toBeNull();
  });

  it("rejects New-API business errors that arrive with HTTP 200", () => {
    const { probes } = resolveProvider("https://relay.example.com", "");
    const token = probes.find((entry) => entry.id === "relay.newapi-token-usage");
    const billing = probes.find((entry) => entry.id === "relay.newapi-billing");
    expect(token?.parse({ success: false, message: "无效的令牌" }, [null])).toBeNull();
    expect(billing?.parse({ error: { message: "unauthorized" } }, [null, null])).toBeNull();
  });

  it("reads Sub2API windows and wallet balance", () => {
    const { probes } = resolveProvider("https://fusecode.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.sub2api-usage");
    expect(probe?.build(ctxOf("https://fusecode.example.com"))).toBe(
      "https://fusecode.example.com/v1/usage",
    );
    const parsed = probe?.parse({
      mode: "quota_limited",
      planName: "Pro",
      quota: { limit: 20, used: 5, remaining: 15, unit: "USD" },
      rate_limits: [
        { window: "5h", limit: 5, used: 1, remaining: 4, reset_at: "2026-10-06T05:00:00Z" },
        { window: "1d", limit: 8, used: 2, remaining: 6, reset_at: "2026-10-07T00:00:00Z" },
        { window: "7d", limit: 20, used: 5, remaining: 15, reset_at: "2026-10-13T00:00:00Z" },
      ],
    });
    expect(parsed).toMatchObject({
      kind: "balance",
      currency: "USD",
      amount: 15,
      total: 20,
      used: 5,
      planName: "Pro",
    });
    expect(parsed?.quotaWindows).toEqual([
      { kind: "duration", durationMins: 300, used: 20, remaining: 80, resetAt: Date.parse("2026-10-06T05:00:00Z") },
      { kind: "duration", durationMins: 1440, used: 25, remaining: 75, resetAt: Date.parse("2026-10-07T00:00:00Z") },
      { kind: "weekly", used: 25, remaining: 75, resetAt: Date.parse("2026-10-13T00:00:00Z") },
    ]);
  });

  it("reads the real Sub2API wallet shape (no windows, unit at the top level)", () => {
    // 本机 fusecode.ai 实测响应（钱包模式，余额可为负 = 已超支）
    const wallet = {
      balance: -0.41589515,
      isValid: true,
      mode: "unrestricted",
      planName: "钱包余额",
      remaining: -0.41589515,
      unit: "USD",
      usage: { total: { cost: 10.40406315 } },
    };
    const { probes } = resolveProvider("https://fusecode.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.sub2api-usage");

    const usd = probe?.parse(wallet);
    expect(usd?.kind).toBe("balance");
    expect(usd?.amount).toBeCloseTo(-0.41589515);
    expect(usd?.currency).toBe("USD");
    expect(usd?.quotaWindows).toBeNull();

    // unit 在顶层（不在 quota 里），人民币钱包不能标成 USD
    expect(probe?.parse({ ...wallet, unit: "CNY" })?.currency).toBe("CNY");
  });

  it("reads claude-code-hub key quotas", () => {
    const { probes } = resolveProvider("https://cchub.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.cchub-quota");
    expect(probe?.headers(ctxOf("https://cchub.example.com", "ck-1"))).toMatchObject({
      "X-Api-Key": "ck-1",
    });
    const parsed = probe?.parse({
      keyLimit5hUsd: 5,
      keyCurrent5hUsd: 1,
      keyLimitDailyUsd: 8,
      keyCurrentDailyUsd: 2,
      keyLimitWeeklyUsd: 20,
      keyCurrentWeeklyUsd: 5,
      keyLimitTotalUsd: 40,
      keyCurrentTotalUsd: 10,
    });
    expect(parsed?.currency).toBe("USD");
    expect(parsed?.amount).toBe(30);
    expect(parsed?.quotaWindows).toEqual([
      { kind: "duration", durationMins: 300, used: 20, remaining: 80, resetAt: null },
      { kind: "duration", durationMins: 1440, used: 25, remaining: 75, resetAt: null },
      { kind: "weekly", used: 25, remaining: 75, resetAt: null },
    ]);
  });

  it("reads CloseAI credit grants", () => {
    const { probes } = resolveProvider("https://proxy.example.com", "");
    const probe = probes.find((entry) => entry.id === "relay.closeai-credits");
    const parsed = probe?.parse({
      object: "credit_summary",
      total_granted: 100,
      total_used: 12.5,
      total_available: 87.5,
    });
    expect(parsed).toMatchObject({ kind: "balance", currency: "USD", amount: 87.5 });
  });

  it("prefers the OpenRouter key limit and keeps credits as a fallback", () => {
    const { probes } = resolveProvider("https://openrouter.ai/api/v1", "");
    const key = probes.find((entry) => entry.id === "openrouter.key-limit");
    const credits = probes.find((entry) => entry.id === "openrouter.credits");
    expect(key?.build(ctxOf("https://openrouter.ai/api/v1"))).toBe(
      "https://openrouter.ai/api/v1/key",
    );
    expect(probes[0].id).toBe("openrouter.key-limit");
    expect(
      key?.parse({ data: { limit: 10, limit_remaining: 7.5, usage: 2.5, usage_monthly: 1.2 } }),
    ).toMatchObject({ kind: "balance", currency: "USD", amount: 7.5, total: 10 });
    // 未设上限的 key：limit / limit_remaining 为 null，不能当成 0
    expect(key?.parse({ data: { limit: null, limit_remaining: null, usage: 30 } })).toBeNull();
    expect(
      credits?.parse({ data: { total_credits: 50, total_usage: 20 } }),
    ).toMatchObject({ kind: "balance", currency: "USD", amount: 30 });
  });

  it("prefers SiliconFlow totalBalance over the smaller grant field", () => {
    const { probes } = resolveProvider("https://api.siliconflow.cn/v1", "");
    const probe = probes.find((entry) => entry.id === "siliconflow.user-info");
    const parsed = probe?.parse({
      data: { balance: 0.5, chargeBalance: 0.5, totalBalance: 12.75 },
    });
    expect(parsed?.amount).toBe(12.75);
  });

  it("labels Moonshot currency by host (mainland CNY, international USD)", () => {
    const cn = resolveProvider("https://api.moonshot.cn/v1", "");
    const intl = resolveProvider("https://api.moonshot.ai/v1", "");
    const payload = { data: { available_balance: 12.5, voucher_balance: 2.5, cash_balance: 10 } };
    expect(cn.probes[0].parse(payload, undefined, ctxOf("https://api.moonshot.cn/v1"))?.currency).toBe("CNY");
    expect(intl.probes[0].parse(payload, undefined, ctxOf("https://api.moonshot.ai/v1"))?.currency).toBe("USD");
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

  it("never claims subscription quota is web-only where an adapter exists", () => {
    // anthropic 的 reason 曾写"订阅额度只能在网页端查看"，而 claude-oauth 通道
    // 早就能显示订阅额度；这类自相矛盾的文案会误导用户。
    const hosts = [
      "https://api.anthropic.com",
      "https://open.bigmodel.cn",
      "https://api.z.ai",
      "https://api.kimi.com",
      "https://api.minimaxi.com",
      "https://api.xiaomimimo.com",
      "https://api.longcat.chat",
      "https://api.x.ai",
      "https://api.groq.com",
      "https://api.mistral.ai",
      "https://api.together.xyz",
      "https://generativelanguage.googleapis.com",
    ];
    for (const host of hosts) {
      const { reason } = resolveProvider(host, "");
      expect(reason ?? "", host).not.toContain("只能在网页端查看");
      // "未找到" 是当初没查到时的措辞；复核后每条都应有确定结论。
      expect(reason ?? "", host).not.toContain("未找到");
    }
  });

  it("queries and parses all OpenCode Go subscription windows", () => {
    const { provider, probes } = resolveProvider("https://opencode.ai/zen/go/v1", "");
    expect(provider.id).toBe("opencode");
    const usage = probes.find((probe) => probe.id === "opencode.go-usage");
    expect(usage?.build(ctxOf("https://opencode.ai/zen/go/v1"))).toBe(
      "https://opencode.ai/zen/go/v1/usage",
    );
    const parsed = usage?.parse({
      usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "2026-09-21T13:55:00.112Z" },
        weekly: { status: "ok", percent: 34, resetsAt: "2026-09-28T00:00:00.112Z" },
        monthly: { status: "ok", percent: 56, resetsAt: "2026-10-19T09:08:42.112Z" },
      },
    });
    expect(parsed).toMatchObject({
      kind: "subscription",
      currency: "%",
      amount: 88,
      used: 12,
      total: 100,
      planName: "OpenCode Go",
    });
    expect(parsed?.quotaWindows).toEqual([
      { kind: "rolling", used: 12, remaining: 88, resetAt: Date.parse("2026-09-21T13:55:00.112Z") },
      { kind: "weekly", used: 34, remaining: 66, resetAt: Date.parse("2026-09-28T00:00:00.112Z") },
      { kind: "monthly", used: 56, remaining: 44, resetAt: Date.parse("2026-10-19T09:08:42.112Z") },
    ]);
  });

  it("gives OpenCode Zen an explicit reason instead of probing it blindly", () => {
    const zen = resolveProvider("https://opencode.ai/zen/v1", "");
    expect(zen.provider.id).toBe("opencode-zen");
    expect(zen.provider.queryable).toBe(false);
    expect(zen.reason).toContain("Zen");
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
