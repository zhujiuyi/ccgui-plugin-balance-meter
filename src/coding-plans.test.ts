import { describe, expect, it } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import {
  parseGrokBilling,
  parseKimiUsage,
  parseMinimaxPlan,
  parseZhipuQuota,
  readGrokQuota,
  readKimiQuota,
  readMinimaxQuota,
  readZhipuQuota,
} from "./coding-plans";

describe("Kimi For Coding usage", () => {
  it("maps limits[].detail to the five-hour window and usage to the weekly window", () => {
    // 形状与窗口口径经两处独立实现交叉验证：
    //  - MoonshotAI/kimi-cli（官方 CLI）
    //  - farion1231/cc-switch（Kimi=5h 桶取 limits[].detail，周桶取 usage）
    const body = JSON.stringify({
      limits: [
        {
          window: { duration: 5, timeUnit: "HOUR" },
          detail: {
            limit: 100,
            remaining: 63,
            resetTime: "2026-09-21T18:00:00Z",
          },
        },
      ],
      usage: {
        limit: 1000,
        used: 250,
        remaining: 750,
        resetTime: "2026-09-28T00:00:00Z",
      },
      totalQuota: { limit: 5000, used: 1000, remaining: 4000 },
      subType: "kimi-for-coding",
      user: { membership: { level: "LEVEL_INTERMEDIATE" } },
    });

    const parsed = parseKimiUsage(body);

    expect(parsed?.planType).toBe("kimi-for-coding");
    expect(parsed?.windows).toEqual([
      {
        kind: "duration",
        durationMins: 300,
        used: 37,
        remaining: 63,
        resetAt: Date.parse("2026-09-21T18:00:00Z"),
      },
      {
        kind: "weekly",
        used: 25,
        remaining: 75,
        resetAt: Date.parse("2026-09-28T00:00:00Z"),
      },
    ]);
  });
});

describe("Zhipu GLM / Z.AI coding plan quota", () => {
  it("classifies TOKENS_LIMIT rows by unit (3 = 5h, 6 = weekly) and keeps the plan level", () => {
    // 口径见 farion1231/cc-switch 的 coding_plan.rs 注释：bigmodel 与 z.ai 共用后端，
    // unit=3 → 5 小时窗口；unit=6 → 每周（number 实测有 7 与 1 两种取值，故只锚 unit）。
    // percentage 已是「已用百分比」；TIME_LIMIT（工具次数）不属额度窗口，忽略。
    const body = JSON.stringify({
      code: 200,
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
          {
            type: "TOKENS_LIMIT",
            unit: 6,
            number: 7,
            percentage: 40,
            nextResetTime: 1_790_300_000_000,
          },
          {
            type: "TIME_LIMIT",
            unit: 5,
            number: 1,
            usage: 100,
            nextResetTime: 1_790_300_000_000,
          },
        ],
      },
    });

    const parsed = parseZhipuQuota(body);

    expect(parsed?.planType).toBe("max");
    expect(parsed?.windows).toEqual([
      {
        kind: "duration",
        durationMins: 300,
        used: 12.5,
        remaining: 87.5,
        resetAt: 1_790_000_000_000,
      },
      {
        kind: "weekly",
        used: 40,
        remaining: 60,
        resetAt: 1_790_300_000_000,
      },
    ]);
  });

  it("falls back to reset-time order when unit is missing", () => {
    const body = JSON.stringify({
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 80, nextResetTime: 1_790_300_000_000 },
          { type: "TOKENS_LIMIT", percentage: 10, nextResetTime: 1_790_000_000_000 },
        ],
      },
    });

    const parsed = parseZhipuQuota(body);

    expect(parsed?.windows).toEqual([
      {
        kind: "duration",
        durationMins: 300,
        used: 10,
        remaining: 90,
        resetAt: 1_790_000_000_000,
      },
      {
        kind: "weekly",
        used: 80,
        remaining: 20,
        resetAt: 1_790_300_000_000,
      },
    ]);
  });
});

describe("MiniMax coding plan", () => {
  it("flips the remaining percentages into used windows and gates the weekly bucket on its status", () => {
    // 口径见 farion1231/cc-switch 的 parse_minimax_tiers：只取 model_name=general；
    // 接口给的是「剩余百分比」，需反转为已用；周桶仅在 status=1 时存在。
    const body = JSON.stringify({
      base_resp: { status_code: 0, status_msg: "success" },
      model_remains: [
        {
          model_name: "video",
          current_interval_remaining_percent: 50,
        },
        {
          model_name: "general",
          current_interval_remaining_percent: 72.5,
          end_time: 1_790_000_000_000,
          current_weekly_status: 1,
          current_weekly_remaining_percent: 90,
          weekly_end_time: 1_790_300_000_000,
        },
      ],
    });

    const parsed = parseMinimaxPlan(body);

    expect(parsed?.windows).toEqual([
      {
        kind: "duration",
        durationMins: 300,
        used: 27.5,
        remaining: 72.5,
        resetAt: 1_790_000_000_000,
      },
      {
        kind: "weekly",
        used: 10,
        remaining: 90,
        resetAt: 1_790_300_000_000,
      },
    ]);
  });

  it("omits the weekly window when the plan has no weekly limit", () => {
    const body = JSON.stringify({
      base_resp: { status_code: 0 },
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 100,
          end_time: 1_790_000_000_000,
          current_weekly_status: 3,
        },
      ],
    });

    const parsed = parseMinimaxPlan(body);

    expect(parsed?.windows).toHaveLength(1);
    expect(parsed?.windows?.[0].kind).toBe("duration");
  });
});

describe("Grok billing", () => {
  it("reads the credit pool window from the monthly/weekly period fields", () => {
    // 口径见 tokentracker-cli 的 grok-limits.js（cli-chat-proxy /v1/billing?format=credits）。
    const body = JSON.stringify({
      config: {
        creditUsagePercent: 42,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-09-20T00:00:00Z",
          end: "2026-09-27T00:00:00Z",
        },
        monthlyLimit: 1000,
        used: 420,
      },
    });

    const parsed = parseGrokBilling(body);

    expect(parsed?.windows).toEqual([
      {
        kind: "weekly",
        used: 42,
        remaining: 58,
        resetAt: Date.parse("2026-09-27T00:00:00Z"),
      },
    ]);
  });

  it("infers the period from dates when the type is missing and falls back to legacy counters", () => {
    const body = JSON.stringify({
      config: {
        currentPeriod: { start: "2026-09-20T00:00:00Z", end: "2026-09-27T00:00:00Z" },
        monthlyLimit: 1000,
        used: 250,
      },
    });

    const parsed = parseGrokBilling(body);

    expect(parsed?.windows).toEqual([
      {
        kind: "weekly",
        used: 25,
        remaining: 75,
        resetAt: Date.parse("2026-09-27T00:00:00Z"),
      },
    ]);
  });

  it("returns null when the response carries no quota window", () => {
    expect(parseGrokBilling(JSON.stringify({ config: {} }))).toBeNull();
    expect(parseGrokBilling("not json")).toBeNull();
  });
});

/* ────────────────────────── 读函数（假 ctx） ────────────────────────── */

const HOME = "C:\\Users\\tester";

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

const KIMI_BODY = JSON.stringify({
  limits: [{ detail: { limit: 100, remaining: 63, resetTime: "2026-09-21T18:00:00Z" } }],
  usage: { limit: 1000, used: 250, resetTime: "2026-09-28T00:00:00Z" },
  subType: "kimi-for-coding",
});

describe("readKimiQuota", () => {
  it("uses the route API key when one is configured", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) =>
      url.startsWith("https://api.kimi.com/coding/v1/usages")
        ? { stdout: `${KIMI_BODY}\n__HTTP_STATUS__200` }
        : { stdout: "" },
    );

    const result = await readKimiQuota(ctx, HOME, "sk-kimi-key");

    expect(result.error).toBeNull();
    expect(result.windows).toHaveLength(2);
    const args = httpCalls(calls)[0]?.args.join(" ") ?? "";
    expect(args).toContain("Authorization: Bearer sk-kimi-key");
  });

  it("falls back to the Kimi Code CLI login when the route has no key", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) => {
      if (url.endsWith(".kimi-code/credentials/kimi-code.json")) {
        return {
          stdout: JSON.stringify({
            access_token: "cli-access-token",
            refresh_token: "cli-refresh-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        };
      }
      return { stdout: `${KIMI_BODY}\n__HTTP_STATUS__200` };
    });

    const result = await readKimiQuota(ctx, HOME, null);

    expect(result.error).toBeNull();
    const args = httpCalls(calls)[0]?.args.join(" ") ?? "";
    expect(args).toContain("Authorization: Bearer cli-access-token");
  });

  it("reports a missing login and never calls the endpoint without credentials", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, () => ({ stdout: "", code: 0 }));

    const result = await readKimiQuota(ctx, HOME, null);

    expect(result.error).toBe("missing");
    expect(httpCalls(calls)).toHaveLength(0);
  });

  it("maps 401 to unauthorized without echoing the key", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, () => ({ stdout: `{"error":"unauthorized"}\n__HTTP_STATUS__401` }));

    const result = await readKimiQuota(ctx, HOME, "sk-kimi-secret-key");

    expect(result.error).toBe("unauthorized");
    expect(JSON.stringify(result)).not.toContain("sk-kimi-secret-key");
  });
});

const ZHIPU_BODY = JSON.stringify({
  code: 200,
  success: true,
  data: {
    level: "max",
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12.5, nextResetTime: 1_790_000_000_000 },
    ],
  },
});

describe("readZhipuQuota", () => {
  it("posts to the monitor endpoint on the same origin with a raw Authorization header", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, () => ({ stdout: `${ZHIPU_BODY}\n__HTTP_STATUS__200` }));

    const result = await readZhipuQuota(ctx, "https://open.bigmodel.cn", "zhipu-key-123");

    expect(result.error).toBeNull();
    expect(result.planType).toBe("max");
    const call = httpCalls(calls)[0];
    const url = call?.args[call.args.length - 1] ?? "";
    expect(url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    const args = call?.args.join(" ") ?? "";
    // 智谱不加 Bearer 前缀
    expect(args).toContain("Authorization: zhipu-key-123");
    expect(args).not.toContain("Bearer zhipu-key-123");
  });

  it("reports unauthorized without a key configured", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, () => ({ stdout: `\n__HTTP_STATUS__401` }));

    const result = await readZhipuQuota(ctx, "https://api.z.ai", null);

    expect(result.error).toBe("missing");
    expect(httpCalls(calls)).toHaveLength(0);
  });
});

describe("readMinimaxQuota", () => {
  it("calls the coding_plan remains endpoint with a bearer key", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, () => ({
      stdout: `${JSON.stringify({
        base_resp: { status_code: 0 },
        model_remains: [
          { model_name: "general", current_interval_remaining_percent: 72.5, end_time: 1_790_000_000_000, current_weekly_status: 3 },
        ],
      })}\n__HTTP_STATUS__200`,
    }));

    const result = await readMinimaxQuota(ctx, "https://api.minimaxi.com", "mm-key-1");

    expect(result.error).toBeNull();
    expect(result.windows).toEqual([
      { kind: "duration", durationMins: 300, used: 27.5, remaining: 72.5, resetAt: 1_790_000_000_000 },
    ]);
    const call = httpCalls(calls)[0];
    expect(call?.args[call.args.length - 1]).toBe(
      "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
    );
    expect(call?.args.join(" ")).toContain("Authorization: Bearer mm-key-1");
  });
});

describe("readGrokQuota", () => {
  const GROK_BODY = JSON.stringify({
    config: {
      creditUsagePercent: 42,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-27T00:00:00Z" },
    },
  });

  it("reads the Grok CLI token and queries the credits billing endpoint", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) => {
      if (url.endsWith(".grok/auth.json")) {
        return {
          stdout: JSON.stringify({
            "https://accounts.x.ai/sign-in::client-1": {
              key: "grok-access-token",
              refresh_token: "grok-refresh-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            },
          }),
        };
      }
      return { stdout: `${GROK_BODY}\n__HTTP_STATUS__200` };
    });

    const result = await readGrokQuota(ctx, HOME);

    expect(result.error).toBeNull();
    expect(result.windows?.[0]).toMatchObject({ kind: "weekly", used: 42 });
    const call = httpCalls(calls)[0];
    expect(call?.args[call.args.length - 1]).toBe(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    );
    expect(call?.args.join(" ")).toContain("Authorization: Bearer grok-access-token");
  });

  it("reports an expired Grok login without calling the endpoint", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) =>
      url.endsWith(".grok/auth.json")
        ? {
            stdout: JSON.stringify({
              "scope::client-1": {
                key: "grok-access-token",
                refresh_token: "grok-refresh-token",
                expires_at: new Date(Date.now() - 60_000).toISOString(),
              },
            }),
          }
        : { stdout: "" },
    );

    const result = await readGrokQuota(ctx, HOME);

    expect(result.error).toBe("expired");
    expect(httpCalls(calls)).toHaveLength(0);
  });

  it("reports a missing Grok login", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, () => ({ stdout: "", code: 0 }));

    const result = await readGrokQuota(ctx, HOME);

    expect(result.error).toBe("missing");
    expect(httpCalls(calls)).toHaveLength(0);
  });
});
