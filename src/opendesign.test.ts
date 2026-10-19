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
  parseOpenDesignCodingPlan,
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
  subscriptionStatus: "none",
  subscriptionCurrentPeriodEnd: null,
  totalConsumedUsd: "0.0000",
});

/** 有订阅时 summary 的状态字段（订阅中）。 */
const SUBSCRIBED_BILLING_BODY = JSON.stringify({
  ...JSON.parse(BILLING_BODY),
  membershipTier: "go",
  subscriptionStatus: "active",
  subscriptionEntitlementStatus: "active",
  subscriptionCurrentPeriodEnd: "2026-11-19T10:14:11.000Z",
});

const WORKSPACES_BODY = JSON.stringify({
  items: [
    {
      workspaceId: "ws-personal-1",
      workspaceName: "me",
      workspaceType: "personal",
      workspaceMemberId: "wm-1",
      role: "owner",
      memberStatus: "active",
      lifecycleState: "active",
    },
  ],
});

/** `/api/v1/workspaces/{id}/billing/funding-check`：订阅额度窗口。 */
const CODING_PLAN_BODY = JSON.stringify({
  schemaVersion: 1,
  workspaceId: "ws-personal-1",
  workspaceMemberId: "wm-1",
  balanceUsd: "1.5000",
  codingPlan: {
    workspaceId: "ws-personal-1",
    eligible: true,
    tier: "go",
    windows: [
      {
        policyId: "policy-5h",
        durationSeconds: 18000,
        resetMode: "anchored_recurring",
        usedCredits: "243",
        limitCredits: "50000",
        remainingCredits: "49757",
        windowStart: "2026-10-19T15:14:11.000Z",
        resetsAt: "2026-10-19T20:14:11.000Z",
      },
      {
        policyId: "policy-week",
        durationSeconds: 604800,
        resetMode: "anchored_recurring",
        usedCredits: "8791",
        limitCredits: "150000",
        remainingCredits: "141209",
        windowStart: "2026-10-19T10:14:11.000Z",
        resetsAt: "2026-10-26T10:14:11.000Z",
      },
    ],
  },
  funding: "wallet",
  fundingCheck: "available",
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
  it("reports whether the account currently has an active subscription", () => {
    expect(parseOpenDesignBilling(SUBSCRIBED_BILLING_BODY)?.subscription).toEqual({
      tier: "go",
      status: "active",
    });
    expect(parseOpenDesignBilling(BILLING_BODY)?.subscription).toBeNull();
    expect(
      parseOpenDesignBilling(
        JSON.stringify({ balanceUsd: "1.00", subscriptionStatus: "canceled", membershipTier: "go" }),
      )?.subscription,
    ).toBeNull();
  });

  it("shows the total available credits as a USD balance plus the membership tier", () => {
    expect(parseOpenDesignBilling(BILLING_BODY)).toMatchObject({
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

describe("parseOpenDesignCodingPlan", () => {
  it("turns the plan's credit windows into used percentages", () => {
    expect(parseOpenDesignCodingPlan(CODING_PLAN_BODY)).toEqual({
      windows: [
        {
          kind: "duration",
          durationMins: 300,
          used: 0.486, // 243 / 50000
          remaining: 99.514,
          resetAt: Date.parse("2026-10-19T20:14:11.000Z"),
        },
        {
          kind: "weekly",
          used: 5.8606666666666665, // 8791 / 150000
          remaining: 94.13933333333333,
          resetAt: Date.parse("2026-10-26T10:14:11.000Z"),
        },
      ],
      planType: "go",
      funding: "wallet",
    });
  });

  it("returns null when the account has no eligible coding plan", () => {
    expect(
      parseOpenDesignCodingPlan(
        JSON.stringify({ codingPlan: { eligible: false, tier: null, windows: [] } }),
      ),
    ).toBeNull();
    expect(parseOpenDesignCodingPlan(JSON.stringify({ codingPlan: null }))).toBeNull();
    expect(parseOpenDesignCodingPlan("not json")).toBeNull();
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
    expect(result.balance?.amount).toBe(1.5);
    expect(result.plan).toBeNull();
    expect(result.endpoint).toBe("https://amr-api.open-design.ai/api/v1/billing/summary");
    const http = httpCalls(calls)[0]?.args.join(" ") ?? "";
    expect(http).toContain("https://amr-api.open-design.ai/api/v1/billing/summary");
    expect(http).toContain("Authorization: Bearer ctl-prod");
    // 网关用的 runtime key 查不了账单，绝不能拿它当 controlKey
    expect(http).not.toContain("sk-amr-runtime");
  });

  it("prefers the subscription's quota windows when the account has one", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) => {
      if (url.endsWith(".amr/config.json")) return { stdout: AMR_CONFIG };
      if (url.endsWith("/api/v1/billing/summary")) {
        return { stdout: `${SUBSCRIBED_BILLING_BODY}\n__HTTP_STATUS__200` };
      }
      if (url.endsWith("/api/v1/workspaces")) return { stdout: `${WORKSPACES_BODY}\n__HTTP_STATUS__200` };
      if (url.includes("/billing/funding-check")) {
        return { stdout: `${CODING_PLAN_BODY}\n__HTTP_STATUS__200` };
      }
      return { stdout: "\n__HTTP_STATUS__404" };
    });

    const result = await readOpenDesignBalance(ctx, HOME, "amr-link.open-design.ai");

    expect(result.error).toBeNull();
    expect(result.plan?.planType).toBe("go");
    expect(result.plan?.windows).toHaveLength(2);
    // 订阅优先：余额只作为附带信息，不再作为主显示
    expect(result.balance?.amount).toBe(1.5);
    const urls = httpCalls(calls).map((call) => call.args[call.args.length - 1]);
    expect(urls.some((url) => url.endsWith("/api/v1/workspaces"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/v1/workspaces/ws-personal-1/billing/funding-check"))).toBe(
      true,
    );
  });

  it("shows the balance when the account has no subscription", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) => {
      if (url.endsWith(".amr/config.json")) return { stdout: AMR_CONFIG };
      return { stdout: `${BILLING_BODY}\n__HTTP_STATUS__200` };
    });

    const result = await readOpenDesignBalance(ctx, HOME, "amr-link.open-design.ai");

    expect(result.plan).toBeNull();
    expect(result.balance?.amount).toBe(1.5);
    // 没有订阅就不该去探测工作区 / 套餐窗口
    expect(httpCalls(calls).some((call) => call.args.join(" ").includes("/workspaces"))).toBe(false);
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
    expect(result.balance).toBeNull();
    expect(JSON.stringify(result)).not.toContain("ctl-prod");
  });
});
