/**
 * Open Design（AMR / Vela）渠道：
 * 网关 `amr-link.open-design.ai` 只是模型入口，余额属于 Open Design 账户，
 * 凭证是桌面客户端登录后写在 `~/.amr/config.json` 的 controlKey
 * （路由里发给网关的 `sk-amr-...` runtime key 查不了账单，实测 401）。
 */

import { describe, expect, it } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import {
  parseOpenDesignBilling,
  parseOpenDesignConfig,
  readOpenDesignBalance,
} from "./opendesign";

const HOME = "C:\\Users\\tester";

const BILLING_BODY = JSON.stringify({
  balanceUsd: "1.5000",
  creditsPerUsd: 10000,
  balances: {
    subscriptionCredits: "10000",
    rechargeCredits: "5000",
    totalAvailableCredits: "15000",
  },
  subscriptionCreditsUsd: "1.0000",
  rechargeCreditsUsd: "0.5000",
  totalAvailableCreditsUsd: "1.5000",
  membershipTier: "go",
  billingInterval: "monthly",
  subscriptionStatus: "active",
  subscriptionCurrentPeriodEnd: "2026-11-19T10:14:11.000Z",
  totalConsumedUsd: "0.0000",
});

describe("parseOpenDesignConfig", () => {
  const CONFIG = JSON.stringify({
    profiles: {
      prod: { controlKey: "ctl-prod", runtimeKey: "sk-amr-runtime", apiUrl: "https://amr-api.open-design.ai" },
      test: {
        controlKey: "ctl-test",
        runtimeKey: "sk-amr-test",
        apiUrl: "https://amr-api.powerformer.net",
      },
      "feature-test": {
        controlKey: "ctl-feature",
        runtimeKey: "sk-amr-feature",
        apiUrl: "https://amr-feature-api.powerformer.net",
      },
    },
  });

  it("picks the profile that matches the gateway host", () => {
    expect(parseOpenDesignConfig(CONFIG, "amr-link.open-design.ai")).toMatchObject({
      profile: "prod",
      controlKey: "ctl-prod",
      apiUrl: "https://amr-api.open-design.ai",
    });
    expect(parseOpenDesignConfig(CONFIG, "amr-link.powerformer.net")).toMatchObject({
      profile: "test",
      controlKey: "ctl-test",
    });
    expect(parseOpenDesignConfig(CONFIG, "amr-feature-link.powerformer.net")).toMatchObject({
      profile: "feature-test",
      controlKey: "ctl-feature",
    });
  });

  it("falls back to another signed-in profile when the matching one is absent", () => {
    const config = JSON.stringify({
      profiles: { test: { controlKey: "ctl-test", apiUrl: "https://amr-api.example" } },
    });
    expect(parseOpenDesignConfig(config, "amr-link.open-design.ai")).toMatchObject({
      profile: "test",
      controlKey: "ctl-test",
    });
  });

  it("returns null when no profile carries a control key", () => {
    expect(parseOpenDesignConfig(JSON.stringify({ profiles: {} }), "amr-link.open-design.ai")).toBeNull();
    expect(parseOpenDesignConfig("not json", "amr-link.open-design.ai")).toBeNull();
  });
});

describe("parseOpenDesignBilling", () => {
  it("shows the total available credits as a USD balance plus the membership tier", () => {
    expect(parseOpenDesignBilling(BILLING_BODY)).toEqual({
      kind: "balance",
      currency: "USD",
      amount: 1.5,
      planName: "Open Design Go",
      detail: "订阅 $1.00 + 充值 $0.50",
    });
  });

  it("falls back to balanceUsd when the total field is missing", () => {
    const parsed = parseOpenDesignBilling(JSON.stringify({ balanceUsd: "2.25", membershipTier: "plus" }));
    expect(parsed?.amount).toBe(2.25);
    expect(parsed?.planName).toBe("Open Design Plus");
  });

  it("derives the amount from credits when no USD total is present", () => {
    const parsed = parseOpenDesignBilling(
      JSON.stringify({
        creditsPerUsd: 10000,
        balances: { totalAvailableCredits: "15000" },
      }),
    );
    expect(parsed?.amount).toBe(1.5);
    expect(parsed?.planName).toBeNull();
  });

  it("returns null for responses without any balance", () => {
    expect(parseOpenDesignBilling(JSON.stringify({ membershipTier: "go" }))).toBeNull();
    expect(parseOpenDesignBilling("not json")).toBeNull();
  });
});

/* ────────────────────────── 读函数（假 ctx） ────────────────────────── */

interface ExecCall {
  bin: string;
  args: string[];
}

function makeCtx(
  calls: ExecCall[],
  respond: (url: string) => { stdout: string; code?: number; stderr?: string },
): PluginContext {
  return {
    pluginId: "balance-meter",
    version: "0.3.0",
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
        calls.push({ bin, args: argv });
        const result = respond(argv[argv.length - 1] ?? "");
        return { code: result.code ?? 0, stdout: result.stdout, stderr: result.stderr ?? "" };
      },
    },
  } as unknown as PluginContext;
}

function httpCalls(calls: ExecCall[]): ExecCall[] {
  return calls.filter((call) => call.args.some((arg) => arg.startsWith("https://")));
}

const AMR_CONFIG = JSON.stringify({
  profiles: {
    prod: {
      controlKey: "ctl-prod",
      runtimeKey: "sk-amr-runtime",
      apiUrl: "https://amr-api.open-design.ai",
    },
  },
});

describe("readOpenDesignBalance", () => {
  it("reads the control key from ~/.amr/config.json and calls the billing summary", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) => {
      if (url.endsWith(".amr/config.json")) return { stdout: AMR_CONFIG };
      return { stdout: `${BILLING_BODY}\n__HTTP_STATUS__200` };
    });

    const result = await readOpenDesignBalance(ctx, HOME, "amr-link.open-design.ai");

    expect(result.error).toBeNull();
    expect(result.amount?.amount).toBe(1.5);
    expect(result.endpoint).toBe("https://amr-api.open-design.ai/api/v1/billing/summary");
    const http = httpCalls(calls)[0]?.args.join(" ") ?? "";
    expect(http).toContain("https://amr-api.open-design.ai/api/v1/billing/summary");
    expect(http).toContain("Authorization: Bearer ctl-prod");
    // 网关用的 runtime key 查不了账单，绝不能拿它当 controlKey
    expect(http).not.toContain("sk-amr-runtime");
  });

  it("reports a missing login without making a request", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, () => ({ stdout: "" }));

    const result = await readOpenDesignBalance(ctx, HOME, "amr-link.open-design.ai");

    expect(result.error).toBe("missing");
    expect(httpCalls(calls)).toHaveLength(0);
  });

  it("maps 401/403 to an expired login without echoing the control key", async () => {
    const ctx = makeCtx([], (url) =>
      url.endsWith(".amr/config.json")
        ? { stdout: AMR_CONFIG }
        : { stdout: '{"error":"unauthenticated"}\n__HTTP_STATUS__403' },
    );

    const result = await readOpenDesignBalance(ctx, HOME, "amr-link.open-design.ai");

    expect(result.error).toBe("expired");
    expect(JSON.stringify(result)).not.toContain("ctl-prod");
  });
});
